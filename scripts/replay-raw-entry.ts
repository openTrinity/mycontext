/**
 * 重放 `raw_records` 的实际逻辑（TS，与应用共享同一份包源码）。
 *
 * 入口壳在 `replay-raw.mjs`（用仓库已有的 esbuild 打包后运行，
 * 不额外引入 tsx / vite-node 这类运行时依赖 —— 与 smoke-entry.ts 同一套做法）。
 *
 * ## 为什么这个脚本是必需的
 *
 * 留存原生记录（`raw_records.payload`）的**全部意义**就是"解析 bug 修好后
 * 能把已采的数据重新过一遍"。没有这个入口，那些 payload 只是在占磁盘。
 *
 * 本轮正好用得上：信封 bug 让 277 页真实响应（1688 条消息）落库 0 条。
 * 原始 JSON 都在库里，所以**不用重新调 CLI** 就能验证修复 ——
 * 既快（几秒 vs 几百次子进程调用）又不消耗对方的接口配额。
 *
 * ## 与真实回溯的分工
 *
 * · **重放**：验证"解析器现在能不能正确处理已有数据"。零网络、可反复跑。
 * · **reset-watermark + 应用跑一轮**：拿回**还没采到**的历史（水位已推过头）。
 *
 * 先重放、后回溯：重放失败说明解析还有问题，那时跑真实回溯只是白烧调用。
 *
 * ## 幂等
 *
 * 走的是与生产完全相同的 `normalize` + `persistBatch`，所以幂等键
 * （messages 的 `(channel_id, external_id)`、media 的 `(message_id, resource_id)`）
 * 全部生效：重复跑不产生重复行，也不产生新的 Outbox seq。
 */
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseMessageListPage } from "@mycontext/channels"
import {
  createFtsHandler,
  FTS_CONSUMER_ID,
  normalize,
  OutboxConsumer,
  persistBatch,
} from "@mycontext/ingest"
import {
  FtsIndexRepository,
  openStore,
  SelfIdentityRepository,
  VAULT_MIGRATIONS,
  type SqliteDatabase,
} from "@mycontext/store"

export interface ReplayOptions {
  dryRun: boolean
  dbPath?: string | undefined
}

export interface ReplayReport {
  dbPath: string
  selfConfirmed: boolean
  selfNames: string[]
  pages: number
  parsedConversations: number
  parsedMessages: number
  parsedMedia: number
  changed: number
  unchanged: number
  counts: Record<string, number>
  conversationsByType: Record<string, number>
  selfMentions: number
  /** 本次重放后建好索引的条数（搜索能不能搜到就看它） */
  ftsIndexed: number
}

/**
 * 找 vault。一个账号一个目录（分库隔离，见 store/vault.ts）。
 *
 * 多个候选时取 **raw_records 最多**的那个而不是第一个：多账号时第一个可能是
 * 刚建的空库，那会让"重放了 0 条"看起来像解析还有问题。
 */
function findVaults(explicit?: string): string[] {
  if (explicit !== undefined && explicit !== "") return [explicit]
  const appSupport = join(homedir(), "Library", "Application Support")
  const out: string[] = []
  for (const appName of [
    "MyContextDevelop",
    "MyContextDev",
    "MyContext",
    "InklingsDevelop",
    "InklingsDev",
    "Inklings",
  ]) {
    const vaultsDir = join(appSupport, appName, "vaults")
    if (!existsSync(vaultsDir)) continue
    for (const entry of readdirSync(vaultsDir)) {
      const candidate = join(vaultsDir, entry, "core.sqlite")
      if (existsSync(candidate)) out.push(candidate)
    }
  }
  return out
}

function pickVault(candidates: readonly string[]): string {
  let best = -1
  let picked = candidates[0] as string
  for (const candidate of candidates) {
    let handle: { db: SqliteDatabase; close: () => void } | null = null
    try {
      // 只读探测用不着迁移，但 openStore 是唯一的开库入口 —— 走它更省事
      // 且顺带把 schema 带到最新（下面写入需要 v8 的 media 列）。
      handle = openStore({ path: candidate, migrations: VAULT_MIGRATIONS })
      const row = handle.db
        .prepare<[], { c: number }>("SELECT count(*) AS c FROM raw_records")
        .get()
      const count = row?.c ?? 0
      if (count > best) {
        best = count
        picked = candidate
      }
    } catch {
      // 老 schema / 打不开的库 —— 跳过
    } finally {
      handle?.close()
    }
  }
  return picked
}

export async function runReplay(options: ReplayOptions): Promise<ReplayReport> {
  const candidates = findVaults(options.dbPath)
  if (candidates.length === 0) {
    throw new Error("未找到任何 vault。先登录一次应用，或用 --db <path> 指定。")
  }
  const dbPath = pickVault(candidates)
  // ★ 走 openStore 而不是裸连接：它会应用 VAULT_MIGRATIONS。
  // 重放需要 v8 的 media_assets.resource_id 列，而已存在的 vault 可能停在 v7
  // （迁移平时由应用启动时跑）。不带迁移会以
  // 「table media_assets has no column named resource_id」失败。
  const handle = openStore({ path: dbPath, migrations: VAULT_MIGRATIONS })
  const db = handle.db

  try {
    const rows = db
      .prepare<[], { id: string; channel_id: string; payload: string; fetched_at: number }>(
        `SELECT id, channel_id, payload, fetched_at FROM raw_records
          WHERE resource = 'chat.message' AND payload IS NOT NULL
          ORDER BY fetched_at`,
      )
      .all()

    const channelId = rows[0]?.channel_id ?? "dingtalk"
    // 身份决定 is_self 与「@我」能否判定。未确认时全部留 null（未判定）——
    // 猜错会永久污染画像，所以这里不猜。
    const identity = new SelfIdentityRepository(db).get(channelId)
    const selfConfirmed = identity?.confirmedAt !== null && identity?.confirmedAt !== undefined
    const selfNames = identity?.displayNames ?? []

    const clock = { now: () => Date.now() }
    const report: ReplayReport = {
      dbPath,
      selfConfirmed,
      selfNames: [...selfNames],
      pages: 0,
      parsedConversations: 0,
      parsedMessages: 0,
      parsedMedia: 0,
      changed: 0,
      unchanged: 0,
      counts: {},
      conversationsByType: {},
      selfMentions: 0,
      ftsIndexed: 0,
    }

    for (const row of rows) {
      let payload: unknown
      try {
        payload = JSON.parse(row.payload)
      } catch {
        continue // payload 不是合法 JSON：跳过而不是中断整次重放
      }

      // ★ 直接喂**带信封**的整页 —— 这正是 raw_records 里存的形态。
      const page = parseMessageListPage(payload)
      report.pages += 1
      report.parsedConversations += page.conversations.length
      report.parsedMessages += page.messages.length
      for (const message of page.messages) report.parsedMedia += message.media.length

      if (options.dryRun) continue

      const result = persistBatch(
        { db, clock },
        normalize({
          channelId: row.channel_id,
          conversations: page.conversations,
          messages: page.messages,
          rawPayload: row.payload,
          rawResource: "chat.message",
          selfExternalIds: new Set((identity?.openIds ?? []).map((entry) => entry.value)),
          selfDisplayNames: new Set(selfConfirmed ? selfNames : []),
          selfConfirmed,
          fetchedAt: row.fetched_at,
        }),
      )
      report.changed += result.changed.length
      report.unchanged += result.unchanged
    }

    /**
     * ★ 顺手把 FTS 索引建掉 —— 否则重放完"数据在库里但搜不到"。
     *
     * 建索引是 Outbox 消费者干的活，而消费者只在应用里跑。重放完不建索引的话
     * `messages_fts` 仍是 0，搜索照旧返回「命中 0 条」——
     * 那正是我们要修的那个症状，只是原因换了一个。
     * 「数据落库」与「能搜到」是两件事，这个脚本要把两件都做完。
     */
    if (!options.dryRun) {
      const clockForConsumer = { now: () => Date.now() }
      const consumer = new OutboxConsumer({
        db,
        clock: clockForConsumer,
        consumerId: FTS_CONSUMER_ID,
        owner: `replay-${process.pid}`,
        handler: createFtsHandler(db, clockForConsumer),
        batchSize: 2000,
      })
      // 循环到抽干：单次 runOnce 只处理一个批次。
      for (let round = 0; round < 100; round += 1) {
        const consumed = await consumer.runOnce()
        if (consumed.processed === 0 && consumed.skipped === 0) break
      }
      report.ftsIndexed = new FtsIndexRepository(db).count()
    }

    // 结果核对：这几个数字就是"数据到底进来了没有"的答案。
    for (const table of [
      "messages",
      "conversations",
      "actors",
      "message_mentions",
      "media_assets",
      "knowledge_changelog",
      "minutes",
    ]) {
      const row = db.prepare<[], { c: number }>(`SELECT count(*) AS c FROM ${table}`).get()
      report.counts[table] = row?.c ?? 0
    }
    for (const row of db
      .prepare<
        [],
        { type: string; c: number }
      >("SELECT type, count(*) AS c FROM conversations GROUP BY type")
      .all()) {
      report.conversationsByType[row.type] = row.c
    }
    report.selfMentions =
      db
        .prepare<[], { c: number }>("SELECT count(*) AS c FROM message_mentions WHERE is_self = 1")
        .get()?.c ?? 0

    return report
  } finally {
    handle.close()
  }
}
