/**
 * 把**外部驱动**的三个消费者包成 `CycleRunnable`，让它们进 `runCycle`。
 *
 * ## ★★★ 为什么需要这一层（它修的是"声明有、执行没有"）
 *
 * `CONSUMERS` 声明了 7 个消费者，而 `runSharedConsumersOnce` 的 runnables
 * 只有 **3 个**（fts / distill / persona-inbox）。另外三个各自跑在自己的
 * 定时器或 service 调用里：
 *
 * | 消费者 | 谁驱动它 |
 * |---|---|
 * | `graph-export` | `FeedService.graphTimer`（10 min `setInterval`） |
 * | `graph-build` | `FeedService.tickGraphSync` 内部顺序调用 |
 * | `distill-work` | `DistillService.maybeRefreshWorkLayer` |
 *
 * 后果不是报错，而是 `dependsOn` 那道闸对它们**没有执行力**：
 * 依赖闸在 `OutboxConsumer` 里，而这三个都不是 `OutboxConsumer`
 * —— 它们自己读写游标，压根不经过闸。
 *
 * 也就是说 `topology.ts` 里那句「顺序从『记得写对』变成『算出来的』」
 * 对这三条边**还没兑现**：它们仍然是"记得写对"，只是现在多了一行
 * 声明说它是算出来的。而将来有人把 `tickGraphSync` 里的两步拆开
 * （比如让建图走独立定时器以免阻塞导出），那条边就断了，
 * 而**声明仍然说它在**。
 *
 * ## ★★ 但周期**不能**统一（这是这一层最重要的约束）
 *
 * `runSharedConsumersOnce` 每 2 分钟一轮（跟着 `tickPull`），而导出是
 * 10 分钟一轮、建图是**小时级**。把它们塞进 2 分钟的循环 = 每 2 分钟
 * 问一次"要不要建图"。
 *
 * 所以分工是：**`runCycle` 负责顺序与依赖闸，"这一轮该不该真干活"的
 * 判据留在原处**（`decideAutoBuild` / `decideWorkRefresh` 都是纯函数，
 * 已经在做这件事）。不该干活时 `runOnce()` 返回
 * `{processed: 0, skipped: 0, …}` —— 那与"没数据"可区分
 * （`runCycle` 已经按这个约定记日志：两个都是 0 就不记）。
 *
 * ## ★★★ `runOnce()` **必须立即返回**
 *
 * `runCycle` 是**顺序**执行的（依赖要求下游看到上游这一轮的结果）。
 * 所以一个 await 到建图完成的 `runOnce()` 会把整轮堵住两小时 ——
 * 而 `local-index-fts` 排在同一轮里，且它是 `required: true`
 * （它落后时历史不能裁）。
 *
 * 幸运的是这三个现在就满足：`triggerIngest` 的签名是
 * `() => Promise<boolean | "cancelled">` —— 返回的是"起没起来"，
 * 不是"建完了"。这一层只需要**不破坏**那个性质，并用一条门禁锁住它。
 *
 * ## ★ 为什么在 apps 而不是 packages
 *
 * 它要 import `FeedService` 与 `DistillService`（都在 apps）。放进
 * `@mycontext/ingest` 会让那个包反向依赖宿主 —— 而 `topology.ts` 的
 * 全部价值在于它没有依赖。
 */
import type { Logger } from "@mycontext/kernel"
import type { CycleRunnable } from "@mycontext/ingest"

/** `runOnce()` 的返回形状（与 `CycleRunnable` 要求的一致）。 */
type CycleReport = Awaited<ReturnType<CycleRunnable["runOnce"]>>

/** 什么都没干的一轮。★ 两个 0 让 `runCycle` 不记日志（跑空一轮不是噪声源）。 */
const IDLE: CycleReport = {
  processed: 0,
  skipped: 0,
  ackedSeq: 0,
  lockedByOther: false,
  waitingForUpstream: null,
  needsFullRebuild: false,
}

/**
 * 这一层需要 `FeedService` 提供的最小接口。
 *
 * ★ 用结构类型而不是 import 那个类：那样这一层能被单测直接喂一个假对象，
 * 而不必造一个真的 `FeedService`（它要 vault、要导出目录、要 kl 配置）。
 */
export interface GraphSyncLike {
  /** 跑一轮导出（内部自己判"有没有新数据"）。 */
  tickGraphSync(): Promise<void>
  /** 导出游标当前到哪。 */
  exportedSeq(): number
  /** 建图游标当前到哪。 */
  builtSeq(): number
  /** 建图**现在正忙**吗（kl 的 HTTP 在跑 ingest）。 */
  graphBusy(): boolean
}

/** work 层那侧需要的最小接口。 */
export interface WorkLayerLike {
  /** 跑一轮 work 层刷新（内部按 `decideWorkRefresh` 判要不要真跑）。 */
  refreshWorkLayer(): Promise<void>
  /** work 游标当前到哪。 */
  workSeq(): number
}

/**
 * `graph-export` 的 runnable。
 *
 * ★ 它**不做**依赖判断（`dependsOn: []`）—— 导出是这条链的源头。
 */
export function createGraphExportRunnable(sync: GraphSyncLike, logger?: Logger): CycleRunnable {
  return {
    async runOnce(): Promise<CycleReport> {
      const before = sync.exportedSeq()
      try {
        /**
         * ★ `tickGraphSync` 内部有 `inFlightSync` 防重入 + `lag === 0` 早退，
         * 所以每轮无条件调它是安全的、而且便宜（一次 `SELECT` 读游标）。
         * 那两个判据留在原处是刻意的（见文件头 ★★）。
         */
        await sync.tickGraphSync()
      } catch (error) {
        /**
         * ★ 记 `skipped: 1` 而不是往上抛：`runCycle` 已经有一层错误隔离，
         * 但在这里记能带上**是哪个消费者**（那一层只知道 id）。
         * 而 `skipped: 1` 与"没数据"（两个 0）可区分。
         */
        logger?.warn("graph export cycle failed", {
          detail: error instanceof Error ? error.message : String(error),
        })
        return { ...IDLE, skipped: 1 }
      }
      const after = sync.exportedSeq()
      return {
        ...IDLE,
        // ★ `processed` 报**推进了多少 seq**，与别的消费者同口径
        processed: Math.max(0, after - before),
        ackedSeq: after,
      }
    },
  }
}

/**
 * `graph-build` 的 runnable。
 *
 * ## ★★★ 这一条是本文件存在的主要理由
 *
 * 建图的水位在 `graph-sync.ts` 里由 `tickGraphSync` 顺带推进
 * （导出成功之后调 `markBuiltToExport` / `ack`）。也就是说
 * 「建图不许跑在导出前面」这条边**是靠调用顺序保证的**，
 * 而不是靠依赖闸 —— 那正是要修的。
 *
 * ★ 这里**不重新实现建图**（那在 `FeedService` 里，要起 kl 进程）。
 * 这个 runnable 做的是：把"建图到哪了"报给 `runCycle`，
 * 让状态页能说出「建图在等导出」而不是「建图没进展」。
 *
 * ★★ 而"要不要建"的判据（`decideAutoBuild`：攒够 500 条或 24h）
 * 留在 `tickGraphSync` 里 —— 见文件头 ★★：周期不能统一。
 */
export function createGraphBuildRunnable(sync: GraphSyncLike): CycleRunnable {
  return {
    runOnce(): Promise<CycleReport> {
      const built = sync.builtSeq()
      const exported = sync.exportedSeq()
      /**
       * ★★★ 依赖闸在**这里**手写一次，因为它不是 `OutboxConsumer`。
       *
       * 判据与 `consumer.ts` 里那个逐字相同（"还有夹在外面的活"才叫
       * 被夹住，不是"刚好处理到上界"）：建图落后于导出说明它还有活，
       * 而那时它在等的是导出。
       *
       * ★ `exported === 0` 时**不报**在等 —— 那说明这套部署没起 kl 服务
       * （导出游标压根没注册），此时报"在等导出"会让状态页显示一个
       * 永远解除不了的等待。与 `consumer.ts` 的"上游没注册就不夹"同一条。
       */
      const waitingForUpstream = exported > 0 && built < exported ? "graph-export" : null
      return Promise.resolve({
        ...IDLE,
        ackedSeq: built,
        waitingForUpstream,
        /**
         * ★ 建图正忙时报 `skipped: 1`：那与"没活干"（两个 0）可区分，
         * 而它是排查"为什么图没更新"时第一个要问的（是在建、还是没开始）。
         */
        skipped: sync.graphBusy() ? 1 : 0,
      })
    },
  }
}

/**
 * `distill-work` 的 runnable。
 *
 * ★ 两个上游（`distill` 与 `graph-build`）的闸由 `runCycle` 的**顺序**
 * 保证它们先跑，而"上游到哪了"这个夹上界的判断在这里做不了
 * （work 层的进度不是逐 seq 处理的，它是"抽到哪个 seq 为止"）。
 * 所以这里只报进度与在等谁，真正的取舍留在 `decideWorkRefresh`。
 */
export function createWorkLayerRunnable(
  work: WorkLayerLike,
  sync: GraphSyncLike,
  logger?: Logger,
): CycleRunnable {
  return {
    async runOnce(): Promise<CycleReport> {
      const before = work.workSeq()
      /**
       * ★★ 建图正忙时**整轮让路**（不只是 playbook 那一步）。
       *
       * 这一条与 `distill.service.ts` 里那个 `graphBusy` 判断是**同一件事**，
       * 而两者都要留：依赖闸问"图建到哪个 seq"，`graphBusy` 问"现在忙吗"。
       * 删掉任一个都会留下一个"看起来在把关、实际不起作用"的条件。
       */
      if (sync.graphBusy()) {
        return { ...IDLE, ackedSeq: before, waitingForUpstream: "graph-build", skipped: 1 }
      }
      try {
        await work.refreshWorkLayer()
      } catch (error) {
        logger?.warn("work layer cycle failed", {
          detail: error instanceof Error ? error.message : String(error),
        })
        return { ...IDLE, ackedSeq: before, skipped: 1 }
      }
      const after = work.workSeq()
      return { ...IDLE, processed: Math.max(0, after - before), ackedSeq: after }
    },
  }
}
