/**
 * 范围放宽后对存量消息做 **bulk 重打标**（v4 Critical #1）。
 *
 * ## ★★★ 为什么必须有它（不能靠下一轮渠道重采）
 *
 * `persist()` 落库时算一次 `learning_eligible`。监听先入库、学习后放宽时，
 * 那些行停在 `0`，直到被渠道再拉一次走 upsert。
 *
 * 而 `onScopeChanged` 在保存范围后会**立刻** `feed.export()`（± rebuild）。
 * 若此时还没重打标，四件套按 `CORPUS_MESSAGE_PREDICATE`（`IS NOT 0`）
 * 排除它们 → 用户看到「重建完成」，图谱却缺新范围历史。
 * **成功 + 数据缺**，且不报错。
 *
 * 文档写过「全量打标 75–80 ms」—— 所以这里直接跑，不需要队列/分片。
 *
 * ## 只升不降
 *
 * 与 upsert 的 `LEARNING_ELIGIBLE_MERGE` 同一不变式：只处理
 * `learning_eligible = 0` → `1`。`NULL` 读侧已视为合格，不碰；
 * 已是 `1` 的不写 changelog（避免刷 seq）。
 */
import { createHash } from "node:crypto"
import { withTransaction } from "./tx.js"
import type { SqliteDatabase } from "./database.js"
import {
  collectsNothing,
  isOccurredAtInScope,
  isPartitionInScope,
  readDomainScope,
} from "./domain-scope.js"
import { ChangelogRepository } from "./repositories/changelog.js"
import { ELIGIBILITY_BITS } from "./repositories/types.js"

export interface RetagReport {
  /** 从 0 升到 1 的消息条数 */
  promoted: number
  /** 写入 changelog 的条数（应等于 promoted） */
  changelogEntries: number
}

interface CandidateRow {
  id: string
  channel_id: string
  external_id: string
  sent_at: number
  content_text: string | null
}

function digestOf(content: string | null): string {
  return createHash("sha256")
    .update(content ?? "")
    .digest("hex")
}

/**
 * 按**当前学习范围**把该合格却仍标 0 的消息升为 1，并写 changelog。
 *
 * @param channelId 渠道 id（与 `messages.channel_id` 对齐）
 * @param options.now changelog 的 `emittedAt`；缺省用 `Date.now()`
 */
export function retagLearningEligible(
  db: SqliteDatabase,
  channelId: string,
  options: { now?: number } = {},
): RetagReport {
  const learning = readDomainScope(db, "chat")
  /**
   * 学习侧一条都不该要时，没有「晋升」语义 —— 升上去会被语料谓词立刻用上，
   * 那是超范围。保持 0。
   */
  if (collectsNothing(learning)) {
    return { promoted: 0, changelogEntries: 0 }
  }

  const candidates = db
    .prepare<[string], CandidateRow>(
      `SELECT m.id, m.channel_id, c.external_id, m.sent_at, m.content_text
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.channel_id = ?
          AND m.learning_eligible = 0`,
    )
    .all(channelId)

  const promote: CandidateRow[] = []
  for (const row of candidates) {
    if (!isPartitionInScope(learning, row.external_id)) continue
    if (!isOccurredAtInScope(learning, row.sent_at)) continue
    promote.push(row)
  }

  if (promote.length === 0) {
    return { promoted: 0, changelogEntries: 0 }
  }

  const now = options.now ?? Date.now()
  return withTransaction(db, () => {
    const update = db.prepare(
      `UPDATE messages SET learning_eligible = 1 WHERE id = ? AND learning_eligible = 0`,
    )
    const log = new ChangelogRepository(db)
    const entries = []
    for (const row of promote) {
      const info = update.run(row.id)
      // ★ 并发/重入：WHERE 没打到就不要写 changelog（否则假唤醒）
      if (info.changes === 0) continue
      entries.push({
        op: "upsert" as const,
        entityType: "message" as const,
        entityId: row.id,
        channelId: row.channel_id,
        domain: "chat" as const,
        eligibility: ELIGIBILITY_BITS.learning,
        occurredAt: row.sent_at,
        emittedAt: now,
        payloadRef: null,
        digest: digestOf(row.content_text),
      })
    }
    if (entries.length > 0) {
      log.append(entries)
    }
    return { promoted: entries.length, changelogEntries: entries.length }
  })
}
