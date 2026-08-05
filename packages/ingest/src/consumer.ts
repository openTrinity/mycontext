/**
 * Outbox 消费者的通用骨架。
 *
 * 三个消费者（FTS 建索引 / 向量 / 蒸馏）的差异只在「拿到一批变更做什么」，
 * 而**租约、重放、心跳、错误隔离**这些正确性相关的部分完全相同 ——
 * 让每个消费者各写一遍是三次犯同样错的机会。
 *
 * 两条硬约束（都是抢占安全的前提，不是可选项）：
 * · **处理必须幂等**：租约过期被抢占后，新持有者从 `acked_seq` 重放；
 * · **一批失败不能卡住整条游标**：远程调用（embedding）会限流，
 *   卡住的话纯本地的 FTS 也建不出来。失败计数单独存，游标继续推进。
 */
import { LEASE_RENEW_MS, type ChangelogRow } from "@mycontext/store"
import { ChangelogRepository, ConsumerCursorRepository } from "@mycontext/store"
import type { Clock, Logger } from "@mycontext/kernel"
import type { SqliteDatabase } from "@mycontext/store"

export interface ConsumerHandlerResult {
  /** 成功处理的条数 */
  processed: number
  /** 失败但**允许跳过**的条数（不阻塞游标推进） */
  skipped: number
}

export interface ConsumerHandler {
  (batch: readonly ChangelogRow[]): Promise<ConsumerHandlerResult> | ConsumerHandlerResult
}

export interface OutboxConsumerOptions {
  db: SqliteDatabase
  clock: Clock
  consumerId: string
  owner: string
  handler: ConsumerHandler
  /** 单批条数。FTS 可以很大（纯本地），embedding 要小（远程限流） */
  batchSize?: number
  required?: boolean
  logger?: Logger
}

export interface ConsumeReport {
  /** 本次推进到的 seq */
  ackedSeq: number
  processed: number
  skipped: number
  /** 没拿到租约（别的进程在消费）时为 true —— 这不是错误 */
  lockedByOther: boolean
  /** 是否需要全量重建（历史已被裁剪） */
  needsFullRebuild: boolean
}

export class OutboxConsumer {
  private readonly changelog: ChangelogRepository
  private readonly cursors: ConsumerCursorRepository
  private lastRenewAt = 0

  constructor(private readonly options: OutboxConsumerOptions) {
    this.changelog = new ChangelogRepository(options.db)
    this.cursors = new ConsumerCursorRepository(options.db, options.clock)
  }

  /**
   * 注册（幂等）。
   *
   * 传当前最小保留 seq：若它 > 0 说明历史已被裁剪过，
   * 这个消费者会被标 `needs_full_rebuild` 走全量而不是从 0 增量
   * （后者会得到一份**静默缺数据**的索引）。
   */
  register(minRetainedSeq = 0): void {
    this.cursors.register(this.options.consumerId, {
      required: this.options.required ?? true,
      minRetainedSeq,
    })
  }

  /** 跑一轮消费。返回报告而不是抛错：调用方是定时循环，不该被单轮失败打断。 */
  async runOnce(): Promise<ConsumeReport> {
    const { consumerId, owner } = this.options
    const empty: ConsumeReport = {
      ackedSeq: 0,
      processed: 0,
      skipped: 0,
      lockedByOther: false,
      needsFullRebuild: false,
    }

    if (!this.cursors.acquireLease(consumerId, owner)) {
      return { ...empty, lockedByOther: true }
    }
    this.lastRenewAt = this.options.clock.now()

    const cursor = this.cursors.get(consumerId)
    if (cursor === null) return empty
    if (cursor.needsFullRebuild) {
      // 不在这里做全量重建：那是调用方的策略决定（可能要问用户，
      // 也可能要走 /v1/snapshot）。这里只把事实报上去。
      return { ...empty, ackedSeq: cursor.ackedSeq, needsFullRebuild: true }
    }

    const batch = this.changelog.changesSince(cursor.ackedSeq, this.options.batchSize ?? 500)
    if (batch.length === 0) {
      this.cursors.heartbeat(consumerId)
      return { ...empty, ackedSeq: cursor.ackedSeq }
    }

    try {
      const result = await this.options.handler(batch)
      const lastSeq = batch.at(-1)?.seq ?? cursor.ackedSeq
      // 即使有 skipped 也推进游标：一批失败不能卡死整条链路。
      // 失败的行由 handler 自己记进各自的失败计数表（状态页会显示）。
      this.cursors.ack(consumerId, lastSeq)
      this.renewIfNeeded()
      return {
        ackedSeq: lastSeq,
        processed: result.processed,
        skipped: result.skipped,
        lockedByOther: false,
        needsFullRebuild: false,
      }
    } catch (error) {
      // 整批失败（不是单条失败）：不推进游标，下次重放。
      // 这是幂等必须成立的地方 —— 重放会再处理一遍同样的条目。
      const detail = (error as Error).message
      this.cursors.recordError(consumerId, detail)
      this.options.logger?.warn("outbox consumer batch failed", { consumerId, detail })
      return { ...empty, ackedSeq: cursor.ackedSeq }
    }
  }

  /** 长时间处理中续租，避免被别的进程抢走。 */
  private renewIfNeeded(): void {
    const now = this.options.clock.now()
    if (now - this.lastRenewAt < LEASE_RENEW_MS) return
    this.cursors.renewLease(this.options.consumerId, this.options.owner)
    this.lastRenewAt = now
  }

  release(): void {
    this.cursors.releaseLease(this.options.consumerId, this.options.owner)
  }

  lag(): number {
    const cursor = this.cursors.get(this.options.consumerId)
    return this.changelog.head() - (cursor?.ackedSeq ?? 0)
  }
}
