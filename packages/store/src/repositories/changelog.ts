/**
 * Outbox 仓储：变更日志 + 消费者游标。
 *
 * 清理水位**不是**朴素的 `MIN(acked_seq)` —— 那有两个对称的失败模式：
 * · 未注册的消费者：MIN 只在已注册者上取值 → 历史被裁剪 → 它后来注册时
 *   `acked_seq=0`，于是**静默缺数据**；
 * · 长期离线的消费者：MIN 永远卡在旧值 → Outbox **无限增长**直到撑爆库。
 *
 * 修正后的规则见 `retainableSeq()` 的注释。
 */
import { AppError, type Clock } from "@mycontext/kernel"
import type { SqliteDatabase } from "../database.js"
import { CHANGELOG_DOMAINS } from "./types.js"
import type { ChangelogEntryInput, ChangelogRow, ConsumerCursorRow } from "./types.js"

interface ChangelogDbRow {
  seq: number
  op: "upsert" | "delete"
  entity_type: string
  entity_id: string
  channel_id: string
  domain: string
  occurred_at: number
  emitted_at: number
  payload_ref: string | null
  digest: string
  /** v30 资格位图；`NULL` = 打标之前写的（存量行）。见 `ELIGIBILITY_BITS`。 */
  eligibility: number | null
}

function toChangelog(row: ChangelogDbRow): ChangelogRow {
  return {
    seq: row.seq,
    op: row.op,
    entityType: row.entity_type as ChangelogRow["entityType"],
    entityId: row.entity_id,
    channelId: row.channel_id,
    domain: row.domain as ChangelogRow["domain"],
    occurredAt: row.occurred_at,
    emittedAt: row.emitted_at,
    payloadRef: row.payload_ref,
    digest: row.digest,
    /**
     * ★ `NULL` 原样透出成 `undefined`（不折成 0）：那两者含义相反 ——
     * `undefined` = "打标之前写的，按更严的旧闸判过"（learning 侧视为合格），
     * `0` = "明确不在学习范围内"。折在一起会让存量库的图谱下一轮变空。
     */
    ...(row.eligibility === null ? {} : { eligibility: row.eligibility }),
  }
}

export class ChangelogRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 追加变更条目。
   *
   * **必须与规范表写入在同一个事务里调用**（见 `withTransaction`）。
   * 这个函数自己不开事务是刻意的：开了就意味着它可以被单独调用，
   * 而「单独调用 appendChangelog」正是我们要防的那个 bug。
   */
  append(entries: readonly ChangelogEntryInput[]): number[] {
    const statement = this.db.prepare(
      `INSERT INTO knowledge_changelog
         (op, entity_type, entity_id, channel_id, domain, occurred_at, emitted_at,
          payload_ref, digest, eligibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const seqs: number[] = []
    for (const entry of entries) {
      const info = statement.run(
        entry.op,
        entry.entityType,
        entry.entityId,
        entry.channelId,
        entry.domain,
        entry.occurredAt,
        entry.emittedAt,
        entry.payloadRef ?? null,
        entry.digest,
        /**
         * ★ 资格位图。`undefined` → NULL（"这一条没打标"）——
         * 那只该出现在**存量行**上；新写入的都该带值。
         *
         * ★★ 不给默认 `ELIGIBILITY_BITS.learning`（"默认合格"）：
         * 那会让一个忘了传 eligibility 的新生产者静默把越界数据
         * 喂给学习侧，而它不报错。宁可 NULL（存量语义）—— 至少
         * "为什么这一条没标"能问出来。
         */
        entry.eligibility ?? null,
      )
      seqs.push(Number(info.lastInsertRowid))
    }
    return seqs
  }

  /** 当前水位。`/v1/head` 只读这一行，所以消费者可以把轮询间隔调到 10s 而几乎无负载。 */
  head(): number {
    return (
      this.db
        .prepare<[], { seq: number | null }>("SELECT MAX(seq) AS seq FROM knowledge_changelog")
        .get()?.seq ?? 0
    )
  }

  /**
   * 每个 domain 的水位。
   *
   * ## ★ 为什么不用 `GROUP BY domain`
   *
   * 那条 SQL 实测走 `SCAN USING COVERING INDEX idx_changelog_domain` ——
   * **全索引扫描**，代价随行数线性增长：50 万行 15ms、100 万行 32.7ms。
   * `/v1/head` 是消费者高频调的接口（3 个消费者 @10s），而它的整个设计
   * 卖点就是"轻到可以随便调"（见 server.ts 的文件头）。一个随库增长的
   * 全扫描把那个前提抽掉了 —— 而且是悄悄抽掉：接口照常返回，只是越来越慢。
   *
   * domain 的基数是**固定的 4**（`CHANGELOG_DOMAINS`），所以改成对每个
   * domain 做一次 `MAX(seq) WHERE domain = ?`。有了 `(domain, seq)` 索引，
   * 每条都是一次索引末端 seek（`SEARCH ... USING COVERING INDEX`），
   * 与表行数无关。4 次 O(log n) 换掉 1 次 O(n)。
   *
   * 只返回**确实有数据**的 domain（与 GROUP BY 的语义一致：
   * 没有条目的 domain 不出现在结果里，而不是给一个 0）。
   */
  headByDomain(): Record<string, number> {
    const statement = this.db.prepare<[string], { seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM knowledge_changelog WHERE domain = ?",
    )

    const result: Record<string, number> = {}
    for (const domain of CHANGELOG_DOMAINS) {
      const seq = statement.get(domain)?.seq
      if (seq !== null && seq !== undefined) result[domain] = seq
    }
    return result
  }

  /** 增量拉取：`since` 之后的条目，按 seq 升序。 */
  changesSince(
    since: number,
    limit: number,
    domain?: string,
    /**
     * 只要带这个**资格位**的变更（`ELIGIBILITY_BITS.learning` 之类）。
     *
     * ## ★★★ `NULL` 必须算**合格** —— 这是 v30 最容易写错的一处
     *
     * 判据是 `(eligibility & ? ) != 0 OR eligibility IS NULL`，
     * 而**不是** `(eligibility & ?) != 0`。后者会把存量行（NULL）排除掉，
     * 于是存量库的 fts / 图谱 / 画像下一轮**全部拿不到历史** ——
     * 而它不报错，只是产出变空。
     *
     * 理由：存量行能进库，说明它当时通过了**更严**的旧闸
     * （那道闸是"越界就丢"，所以库里的行必然合格）。
     *
     * ★ 不传 = 不按资格过滤（`persona-inbox` 走这条 —— 它的判据是
     * `AttentionRouter` 每条现判，见 v30 迁移的文件头）。
     */
    requiresBit?: number,
  ): ChangelogRow[] {
    /**
     * ★ 动态拼 WHERE 而不是四个写死的 SQL：那样"NULL 算合格"这条判据
     * 会有四份拷贝，而它正是最容易漏的那一条。
     *
     * ★★ 只拼**结构**（哪几个条件在），值全走参数绑定 ——
     * `domain` 与 `requiresBit` 都不进 SQL 文本。
     */
    const clauses = ["seq > ?"]
    const params: (number | string)[] = [since]
    if (domain !== undefined) {
      clauses.push("domain = ?")
      params.push(domain)
    }
    if (requiresBit !== undefined) {
      // 见上面那段 ★★★：NULL（存量行）算合格
      clauses.push("((eligibility & ?) != 0 OR eligibility IS NULL)")
      params.push(requiresBit)
    }
    params.push(limit)
    return this.db
      .prepare<(number | string)[], ChangelogDbRow>(
        `SELECT * FROM knowledge_changelog WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`,
      )
      .all(...params)
      .map(toChangelog)
  }

  count(): number {
    return (
      this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM knowledge_changelog").get()
        ?.c ?? 0
    )
  }

  /** 裁剪：删除 seq <= 水位的条目。返回删除条数。 */
  pruneUpTo(seq: number): number {
    return this.db.prepare("DELETE FROM knowledge_changelog WHERE seq <= ?").run(seq).changes
  }
}

interface ConsumerDbRow {
  consumer_id: string
  acked_seq: number
  required: number
  registered_at: number
  heartbeat_at: number | null
  stale_after_ms: number
  needs_full_rebuild: number
  lease_owner: string | null
  lease_expires_at: number | null
  last_error: string | null
  last_success_at: number | null
  updated_at: number
}

function toConsumer(row: ConsumerDbRow): ConsumerCursorRow {
  return {
    consumerId: row.consumer_id,
    ackedSeq: row.acked_seq,
    required: row.required === 1,
    registeredAt: row.registered_at,
    heartbeatAt: row.heartbeat_at,
    staleAfterMs: row.stale_after_ms,
    needsFullRebuild: row.needs_full_rebuild === 1,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    lastSuccessAt: row.last_success_at,
    updatedAt: row.updated_at,
  }
}

/** 租约 TTL 与续租间隔。抢占必须从 acked_seq 重放，所以消费侧写入必须幂等。 */
export const LEASE_TTL_MS = 60_000
export const LEASE_RENEW_MS = 20_000

export class ConsumerCursorRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  /**
   * 注册消费者（幂等）。
   *
   * 若注册时刻已晚于当前最小保留 seq，标 `needs_full_rebuild=1` ——
   * 这个消费者错过的历史已经被裁掉了，让它走全量快照而不是从 0 增量
   * （后者会得到一份**静默缺数据**的索引）。
   */
  register(
    consumerId: string,
    options: { required?: boolean; staleAfterMs?: number; minRetainedSeq?: number } = {},
  ): ConsumerCursorRow {
    const now = this.clock.now()
    const existing = this.get(consumerId)
    if (existing !== null) return existing

    const needsRebuild = (options.minRetainedSeq ?? 0) > 0
    this.db
      .prepare(
        `INSERT INTO consumer_cursors
           (consumer_id, acked_seq, required, registered_at, stale_after_ms,
            needs_full_rebuild, updated_at)
         VALUES (?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        consumerId,
        (options.required ?? true) ? 1 : 0,
        now,
        options.staleAfterMs ?? 7 * 24 * 60 * 60 * 1000,
        needsRebuild ? 1 : 0,
        now,
      )
    const created = this.get(consumerId)
    if (created === null) throw new AppError("DB_UNAVAILABLE", "注册消费者后读不回该行")
    return created
  }

  get(consumerId: string): ConsumerCursorRow | null {
    const row = this.db
      .prepare<[string], ConsumerDbRow>("SELECT * FROM consumer_cursors WHERE consumer_id = ?")
      .get(consumerId)
    return row === undefined ? null : toConsumer(row)
  }

  list(): ConsumerCursorRow[] {
    return this.db
      .prepare<[], ConsumerDbRow>("SELECT * FROM consumer_cursors ORDER BY consumer_id")
      .all()
      .map(toConsumer)
  }

  /** 确认消费到 seq，并顺带续心跳（消费本身就是活着的最强证据）。 */
  ack(consumerId: string, seq: number): void {
    const now = this.clock.now()
    this.db
      .prepare(
        `UPDATE consumer_cursors
            SET acked_seq = MAX(acked_seq, ?), heartbeat_at = ?,
                last_success_at = ?, last_error = NULL, updated_at = ?
          WHERE consumer_id = ?`,
      )
      .run(seq, now, now, now, consumerId)
  }

  /**
   * **强制**把游标改成 seq —— 允许倒退。运维/清库专用。
   *
   * ## ★ 为什么不能用 `ack()` 做这件事
   *
   * `ack()` 是 `MAX(acked_seq, ?)`，那个 MAX 是刻意的（并发/重试下水位倒退
   * 会导致重复消费，见 `ack` 与 `DistillSourceRepository.advance` 的注释）。
   * 于是 `ack(id, 0)` 会被**静默忽略** —— 一个"我已经清零了"的调用什么都没做，
   * 而调用方没有任何办法发现（没有返回值、不抛错）。踩过一次：给建图水位写
   * 清零那一段时用了 `ack(…, 0)`，读回来还是旧值。
   *
   * 所以倒退必须是一个**显式命名**的方法：读到 `rewind` 就知道这里在做
   * 危险的事，而 `ack` 保持"只进不退"的强不变式。
   *
   * ## 语义差别（不只是少了个 MAX）
   *
   * 不碰 `last_success_at`：倒退**不是**一次成功消费。留着旧的成功时刻是对的
   * ——「上次真的建成是什么时候」在清库后仍然是有意义的历史。
   * 而 `heartbeat_at` 同理不动：倒退的是水位，不代表消费者此刻活着。
   *
   * @returns 是否真的改到了行（消费者未注册时是 false，不静默假成功）
   */
  rewind(consumerId: string, seq: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE consumer_cursors
            SET acked_seq = ?, last_error = NULL, updated_at = ?
          WHERE consumer_id = ?`,
      )
      .run(seq, this.clock.now(), consumerId)
    return info.changes > 0
  }

  heartbeat(consumerId: string): void {
    const now = this.clock.now()
    this.db
      .prepare("UPDATE consumer_cursors SET heartbeat_at = ?, updated_at = ? WHERE consumer_id = ?")
      .run(now, now, consumerId)
  }

  recordError(consumerId: string, error: string): void {
    const now = this.clock.now()
    this.db
      .prepare("UPDATE consumer_cursors SET last_error = ?, updated_at = ? WHERE consumer_id = ?")
      .run(error.slice(0, 500), now, consumerId)
  }

  markNeedsFullRebuild(consumerId: string): void {
    this.db
      .prepare(
        `UPDATE consumer_cursors
            SET needs_full_rebuild = 1, required = 0, updated_at = ?
          WHERE consumer_id = ?`,
      )
      .run(this.clock.now(), consumerId)
  }

  /** 全量重建完成后清除标记，重新参与阻塞清理。 */
  clearFullRebuild(consumerId: string, ackedSeq: number): void {
    const now = this.clock.now()
    this.db
      .prepare(
        `UPDATE consumer_cursors
            SET needs_full_rebuild = 0, required = 1, acked_seq = ?, updated_at = ?
          WHERE consumer_id = ?`,
      )
      .run(ackedSeq, now, consumerId)
  }

  /**
   * 抢占式获取租约。
   *
   * 规则：`lease_expires_at < now()` 时任何进程可抢占（CAS）。
   * 没有这条规则，进程崩溃后未释放的租约会让该消费者**永久卡死** ——
   * 而这只在崩溃后才发生，也就是最难复现的时候。
   */
  acquireLease(consumerId: string, owner: string, ttlMs = LEASE_TTL_MS): boolean {
    const now = this.clock.now()
    const info = this.db
      .prepare(
        `UPDATE consumer_cursors
            SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE consumer_id = ?
            AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at < ?)`,
      )
      .run(owner, now + ttlMs, now, consumerId, owner, now)
    return info.changes > 0
  }

  renewLease(consumerId: string, owner: string, ttlMs = LEASE_TTL_MS): boolean {
    const now = this.clock.now()
    const info = this.db
      .prepare(
        `UPDATE consumer_cursors
            SET lease_expires_at = ?, updated_at = ?
          WHERE consumer_id = ? AND lease_owner = ?`,
      )
      .run(now + ttlMs, now, consumerId, owner)
    return info.changes > 0
  }

  releaseLease(consumerId: string, owner: string): void {
    this.db
      .prepare(
        `UPDATE consumer_cursors
            SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE consumer_id = ? AND lease_owner = ?`,
      )
      .run(this.clock.now(), consumerId, owner)
  }

  /**
   * 心跳超期的消费者。
   *
   * 调用方应把它们标 `needs_full_rebuild=1` 并**在状态页告警** ——
   * 不是静默跳过：用户需要知道「图谱数据已经不完整了」。
   */
  staleConsumers(): ConsumerCursorRow[] {
    const now = this.clock.now()
    return this.list().filter((consumer) => {
      if (!consumer.required) return false
      const last = consumer.heartbeatAt ?? consumer.registeredAt
      return now - last > consumer.staleAfterMs
    })
  }

  /**
   * 可安全裁剪到的 seq。
   *
   * = 所有「required=1 且心跳未超期」消费者的 `MIN(acked_seq)`。
   * 没有任何这样的消费者时返回 0（不裁剪）—— 宁可占存储也不要静默丢数据。
   */
  retainableSeq(): number {
    const active = this.list().filter((consumer) => {
      if (!consumer.required || consumer.needsFullRebuild) return false
      const last = consumer.heartbeatAt ?? consumer.registeredAt
      return this.clock.now() - last <= consumer.staleAfterMs
    })
    if (active.length === 0) return 0
    return Math.min(...active.map((consumer) => consumer.ackedSeq))
  }
}
