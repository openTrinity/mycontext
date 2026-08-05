/**
 * 保留策略。
 *
 * 实测体积：2 万条消息 ≈ 9.9MB 主库 + 10MB WAL。
 * 按每天 500 条、回溯 6 个月粗估 **300-500MB/账号**，其中最大的一块是
 * `raw_records`（它存**未裁剪的原始 JSON**）。而 `superseded_by` 链是永久增长的。
 *
 * 桌面端悄悄占掉 500MB 而没有任何提示，是会被当成 bug 报上来的 ——
 * 所以这里的每条规则都配了一个可在状态页展示的计数。
 *
 * 四条规则：
 * 1. payload 满 N 天后置 NULL（保留 hash 维持幂等）
 * 2. superseded_by 链只留最近 3 个修订
 * 3. Outbox 裁剪到「所有活跃必需消费者的最小 acked_seq」
 * 4. 空闲期 WAL checkpoint（不 checkpoint 的话 WAL 只增不减）
 *
 * ★ 裁剪不可逆：`payload_pruned_at` 非空的行无法重放。
 *   因此某消费者标了 `needs_full_rebuild=1` 时只能从外部重新拉取
 *   （而外部的历史窗口也有限）—— UI 必须把这一点说清。
 */
import { statSync } from "node:fs"
import { MS_PER_DAY, type Clock, type Logger } from "@mycontext/kernel"
import type { SqliteDatabase } from "./database.js"
import { ChangelogRepository, ConsumerCursorRepository } from "./repositories/changelog.js"

export interface RetentionOptions {
  /** payload 保留天数。30 天足够发现解析问题，之后留着只是在付存储成本。 */
  payloadRetentionDays?: number
  /** 修订链保留的修订数（链首与链尾之间的中间行会被删） */
  maxRevisions?: number
  /** Outbox 至少保留的条数下限（即使消费者都跟上了也留着，便于排查） */
  minChangelogRows?: number
}

export interface RetentionReport {
  prunedPayloads: number
  removedRevisions: number
  prunedChangelog: number
  staleConsumers: string[]
  walCheckpointed: boolean
}

export interface StorageStats {
  mainBytes: number
  walBytes: number
  rawRecords: number
  rawPruned: number
  messages: number
  vectors: number
  changelogRows: number
}

export class RetentionRunner {
  private readonly changelog: ChangelogRepository
  private readonly consumers: ConsumerCursorRepository

  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
    private readonly options: RetentionOptions = {},
    private readonly logger?: Logger,
  ) {
    this.changelog = new ChangelogRepository(db)
    this.consumers = new ConsumerCursorRepository(db, clock)
  }

  /**
   * 跑一轮裁剪。
   *
   * 本身是一个 Outbox 消费者（`retention`，`required=0` 不阻塞清理水位），
   * 所以它的进度、失败、可暂停都复用已有机制，不新引入一套调度。
   */
  run(options: { checkpoint?: boolean } = {}): RetentionReport {
    const prunedPayloads = this.prunePayloads()
    const removedRevisions = this.pruneRevisionChains()
    const { pruned, stale } = this.pruneChangelog()
    const walCheckpointed = options.checkpoint === true ? this.checkpointWal() : false

    const report: RetentionReport = {
      prunedPayloads,
      removedRevisions,
      prunedChangelog: pruned,
      staleConsumers: stale,
      walCheckpointed,
    }
    if (prunedPayloads > 0 || pruned > 0 || removedRevisions > 0) {
      this.logger?.info("retention pass", { ...report })
    }
    return report
  }

  /**
   * payload 裁剪：只保留 hash。
   *
   * 为什么保留 hash：幂等键与「这条我见过」的判断只需要它。
   * 而「任何解析 bug 都能从这里重放」这个能力**只在解析器还可能有 bug 的
   * 窗口内有价值** —— 30 天足够发现解析问题。
   */
  private prunePayloads(): number {
    const days = this.options.payloadRetentionDays ?? 30
    const cutoff = this.clock.now() - days * MS_PER_DAY
    return this.db
      .prepare(
        `UPDATE raw_records
            SET payload = NULL, payload_pruned_at = ?
          WHERE payload IS NOT NULL AND fetched_at < ?`,
      )
      .run(this.clock.now(), cutoff).changes
  }

  /**
   * 修订链裁剪：保留链首与最近 N 个修订，删中间行。
   *
   * 消息被编辑超过 3 次的场景极少，而无界链会让 JOIN 变慢。
   */
  private pruneRevisionChains(): number {
    const keep = this.options.maxRevisions ?? 3
    // 找出被指向次数超限的链：按 external_id 分组，保留最新 keep 个 + 最旧 1 个。
    const rows = this.db
      .prepare<[number], { channel_id: string; resource: string; external_id: string; n: number }>(
        `SELECT channel_id, resource, external_id, count(*) AS n
           FROM raw_records
          WHERE external_id <> ''
          GROUP BY channel_id, resource, external_id
         HAVING n > ?`,
      )
      .all(keep + 1)

    let removed = 0
    const deleteMiddle = this.db.prepare(
      `DELETE FROM raw_records
         WHERE id IN (
           SELECT id FROM raw_records
            WHERE channel_id = ? AND resource = ? AND external_id = ?
            ORDER BY fetched_at DESC
            LIMIT -1 OFFSET ?
         )
         AND id NOT IN (
           SELECT id FROM raw_records
            WHERE channel_id = ? AND resource = ? AND external_id = ?
            ORDER BY fetched_at ASC LIMIT 1
         )`,
    )
    for (const row of rows) {
      removed += deleteMiddle.run(
        row.channel_id,
        row.resource,
        row.external_id,
        keep,
        row.channel_id,
        row.resource,
        row.external_id,
      ).changes
    }
    return removed
  }

  /**
   * Outbox 裁剪。
   *
   * 心跳超期的消费者会被标 `needs_full_rebuild=1` 并降级为不阻塞清理，
   * **同时返回给调用方去告警** —— 不是静默跳过：
   * 用户需要知道「图谱数据已经不完整了」。
   */
  private pruneChangelog(): { pruned: number; stale: string[] } {
    const stale = this.consumers.staleConsumers()
    for (const consumer of stale) {
      this.consumers.markNeedsFullRebuild(consumer.consumerId)
      this.logger?.warn("consumer stale, downgraded and needs full rebuild", {
        consumerId: consumer.consumerId,
        lastHeartbeat: consumer.heartbeatAt,
      })
    }

    const retainable = this.consumers.retainableSeq()
    if (retainable <= 0) return { pruned: 0, stale: stale.map((c) => c.consumerId) }

    // 即使消费者都跟上了也留一段：排查「这条消息为什么没进索引」需要看变更记录。
    const minRows = this.options.minChangelogRows ?? 10_000
    const head = this.changelog.head()
    const floor = Math.max(0, head - minRows)
    const target = Math.min(retainable, floor)
    if (target <= 0) return { pruned: 0, stale: stale.map((c) => c.consumerId) }

    return { pruned: this.changelog.pruneUpTo(target), stale: stale.map((c) => c.consumerId) }
  }

  /**
   * WAL checkpoint。
   *
   * 实测 2 万条能产生 10MB WAL；不 checkpoint 的话它只增不减。
   * 只在采集空闲时调用（连续若干轮无新消息）—— 有写入时 TRUNCATE 会被阻塞。
   */
  private checkpointWal(): boolean {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)")
      return true
    } catch (error) {
      this.logger?.warn("wal checkpoint failed", { detail: (error as Error).message })
      return false
    }
  }
}

/** 库体积与行数统计。状态页显示它，让存储增长可见而不是等用户报 bug。 */
export function collectStorageStats(db: SqliteDatabase, dbPath: string): StorageStats {
  const count = (sql: string): number => db.prepare<[], { c: number }>(sql).get()?.c ?? 0

  let mainBytes = 0
  let walBytes = 0
  try {
    // 用 pragma 而不是 fs.statSync 算主库：库可能是 :memory:，且 page_count
    // 反映的是 SQLite 自己认为的大小（含空闲页），与"这个库占了多少"更相关。
    const pageCount = (db.pragma("page_count", { simple: true }) as number) ?? 0
    const pageSize = (db.pragma("page_size", { simple: true }) as number) ?? 0
    mainBytes = pageCount * pageSize
    if (dbPath !== ":memory:") {
      walBytes = walFileSize(`${dbPath}-wal`)
    }
  } catch {
    // 统计失败不该让调用方崩：这是展示用的数字，不是正确性依赖。
    // 保持已初始化的 0 值。
  }

  return {
    mainBytes,
    walBytes,
    rawRecords: count("SELECT count(*) AS c FROM raw_records"),
    rawPruned: count("SELECT count(*) AS c FROM raw_records WHERE payload IS NULL"),
    messages: count("SELECT count(*) AS c FROM messages"),
    vectors: count("SELECT count(*) AS c FROM message_vectors"),
    changelogRows: count("SELECT count(*) AS c FROM knowledge_changelog"),
  }
}

/** WAL 文件大小。读不到（还没 checkpoint 过、或权限问题）时按 0 处理。 */
function walFileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
