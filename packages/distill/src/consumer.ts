/**
 * `distill` 消费者：有新消息就把对应时间窗排进 `distill_tasks`。
 *
 * ## 为什么消费者只**入队**，不直接跑
 *
 * Outbox 消费者持着租约，而跑蒸馏是几十秒到几分钟的 LLM 调用。
 * 在 handler 里跑会让租约在处理期间过期 → 被别的持有者抢占 → 同一批消息
 * 被重复蒸馏（真金白银）。所以这里只做一件很快的事：**算出该蒸哪些窗口**。
 *
 * 真正跑任务由宿主的定时器驱动（`DistillRunner.runBatch`），
 * 它与租约无关，可以慢慢跑、可以被用户中断、可以跨重启续跑。
 *
 * ## ★ `required: true`
 *
 * 这个消费者落后时**不能**裁剪 raw_records/changelog 历史 ——
 * 裁了就等于永久丢掉那段时间的画像来源。与 graph-export（外部消费者，
 * `required: false`）是相反的选择，理由是"丢了能不能补回来"。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import {
  DistillTaskRepository,
  MessageRepository,
  type ChangelogRow,
  type SqliteDatabase,
} from "@mycontext/store"
import { ALL_FACETS } from "./runner.js"

export const DISTILL_CONSUMER_ID = "distill"

/** 窗口对齐粒度。与 runner 的 plan 用同一个单位，否则两边切出的窗口不重合。 */
const WINDOW_MS = 7 * 86_400_000

export interface DistillHandlerOptions {
  db: SqliteDatabase
  clock: Clock
  logger?: Logger
  newId: () => string
  /** 窗口长度（ms）。默认 7 天 */
  windowMs?: number
}

/**
 * 把一批变更映射成"要蒸哪些窗口"。
 *
 * ★ 按**窗口去重**：一批 500 条消息大概率都落在同一个窗口里，
 * 逐条入队会产生 500 次相同的 enqueue（都被幂等挡掉，但白跑 500 次查询）。
 */
export function createDistillHandler(options: DistillHandlerOptions) {
  const tasks = new DistillTaskRepository(options.db)
  const messages = new MessageRepository(options.db)
  const windowMs = options.windowMs ?? WINDOW_MS

  return (batch: readonly ChangelogRow[]): { processed: number; skipped: number } => {
    const now = options.clock.now()
    let processed = 0
    let skipped = 0
    /** 窗口起点集合。用 Set 而不是数组：同一批里重复的窗口只算一次。 */
    const windows = new Set<number>()

    for (const entry of batch) {
      // 未实现的实体类型（document/minutes）：跳过 + 计数、**不告警**（预期状态）
      if (entry.entityType !== "message") {
        skipped += 1
        continue
      }
      // 删除不产生蒸馏任务：已有结论的证据里可能引用它，但那由
      // materializer 渲染时判空处理 —— 为一次删除重蒸一整个窗口不值得
      if (entry.op === "delete") {
        skipped += 1
        continue
      }

      const message = messages.findById(entry.entityId)
      if (message === null) {
        skipped += 1
        continue
      }
      // 窗口按绝对时间对齐（floor 到 windowMs 的整数倍）：
      // 不对齐的话每条消息都会算出一个略微不同的窗口起点，
      // 于是同一段时间被切成无数重叠的窗口。
      windows.add(Math.floor(message.sentAt / windowMs) * windowMs)
      processed += 1
    }

    let created = 0
    for (const start of windows) {
      for (const facet of ALL_FACETS) {
        const inserted = tasks.enqueue(
          {
            id: options.newId(),
            facet,
            scope: "global",
            scopeRef: "",
            windowStart: start,
            windowEnd: start + windowMs,
          },
          now,
        )
        if (inserted) created += 1
      }
    }

    if (created > 0) {
      options.logger?.info("distill tasks enqueued", {
        created,
        windows: windows.size,
        fromChanges: processed,
      })
    }

    return { processed, skipped }
  }
}
