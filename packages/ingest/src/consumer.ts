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
  /**
   * 依赖的上游消费者 —— 本消费者**不许跑在它前面**。
   *
   * ## 用户要的（原话）
   *
   * 「每个消费者都根据当前/当前一些消费者一起干活」
   * 「forge 蒸馏可能还会引用 kl-graph 第二阶段的 fact 之类的」
   *
   * 判据：蒸馏读的是图谱抽出来的 fact。如果蒸馏的游标跑到 seq=1000 而
   * 图谱只到 seq=200，那 200–1000 那段消息的 fact **还不存在** ——
   * 蒸馏会照常"成功"，只是产出里少了那一段的知识。而它不报错、
   * 不重试（游标已经推过去了），所以那段缺失是**永久**且**静默**的。
   *
   * 这正是本仓库最贵的那类 bug 的形状，所以判据放在骨架里而不是让
   * 每个 handler 自己记得查一次上游游标。
   *
   * ★ 不是"等上游追平"而是"不超过上游"：批次上界被夹到上游的
   * `acked_seq`，所以蒸馏仍然能处理图谱已经消化过的那部分，
   * 不会互相干等（那会变成死锁）。
   */
  dependsOn?: readonly string[]
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
  /**
   * 被上游游标夹住了（`dependsOn`）——本轮只处理到上游的位置。
   *
   * ★ 与 `lockedByOther` 一样**不是错误**：它是"按依赖顺序干活"的正常
   * 表现。但必须报上来，否则"蒸馏没进展"与"蒸馏在等图谱"不可区分
   * （而这两者的出路完全不同：后者要去看图谱为什么慢）。
   */
  waitingForUpstream: string | null
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
      waitingForUpstream: null,
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

    /**
     * ★★★ 依赖闸：本消费者不许跑在上游前面（见 `dependsOn` 的注释）。
     *
     * 做法是把**批次上界**夹到上游的 `acked_seq`，而不是"上游没追平就
     * 整轮不干活"：后者在两个消费者互相等待时会死锁，而且会让一个慢的
     * 上游把整条链路停住。夹上界的话本轮仍然处理上游已消化的那一段。
     *
     * ★ 上游**没注册**时不夹（`get()` 返回 null）—— 那说明这套部署里
     * 没有那个消费者（比如 kl 服务没起），此时夹成 0 会让蒸馏永久停在
     * 原地，而那是一次静默功能回归。判据只在"上游真的存在"时生效。
     */
    let upstreamLimit: number | null = null
    let waitingFor: string | null = null
    for (const upstreamId of this.options.dependsOn ?? []) {
      const upstream = this.cursors.get(upstreamId)
      if (upstream === null) continue
      if (upstreamLimit === null || upstream.ackedSeq < upstreamLimit) {
        upstreamLimit = upstream.ackedSeq
        waitingFor = upstreamId
      }
    }
    if (upstreamLimit !== null && upstreamLimit <= cursor.ackedSeq) {
      /**
       * 上游还没超过我 → 本轮无事可做，但**要说清是在等谁**。
       * 只返回 `processed: 0` 的话，"没新数据"与"在等图谱"不可区分。
       */
      this.cursors.heartbeat(consumerId)
      return { ...empty, ackedSeq: cursor.ackedSeq, waitingForUpstream: waitingFor }
    }

    const batch = this.changelog
      .changesSince(cursor.ackedSeq, this.options.batchSize ?? 500)
      .filter((row) => upstreamLimit === null || row.seq <= upstreamLimit)
    if (batch.length === 0) {
      this.cursors.heartbeat(consumerId)
      return {
        ...empty,
        ackedSeq: cursor.ackedSeq,
        // 被上界夹空与"真的没新数据"是两件事
        waitingForUpstream: upstreamLimit === null ? null : waitingFor,
      }
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
        /**
         * ★ 「被上游夹住」的判据是**还有夹在外面的活**，不是"刚好处理到上界"。
         *
         * 我第一版写成 `lastSeq >= upstreamLimit ? waitingFor : null` ——
         * 那会在"处理完最后一批、且上游已经追上来"时仍然报"在等上游"。
         * 实测（本文件那条"上游推进之后接着往下走"）转红：第二轮把 4..10
         * 全处理完了，却报 `waitingForUpstream: 'graph-export'`。
         *
         * 「到达上界」与「被上界挡住」是两件事：前者可能只是恰好处理完，
         * 后者要求 changelog 里**确实还有** seq > 上界的行。
         */
        waitingForUpstream:
          upstreamLimit !== null && this.changelog.changesSince(upstreamLimit, 1).length > 0
            ? waitingFor
            : null,
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
