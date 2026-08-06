/**
 * 图谱同步：Outbox → 重新物化四件套 → （可选）触发 `kl ingest`。
 *
 * ## 为什么挂在 Outbox 上而不是定时全量导出
 *
 * 全量导出 9541 条消息实测约 1 秒、写 4MB —— 单看不贵，
 * 但**每 N 分钟无条件重写一遍**有两个坏处：
 * ① 没有新数据时也在写盘（SSD 寿命是真实成本，而收益为零）；
 * ② 拿不到"有没有变化"这个信号 —— 而 `kl ingest` 是**昂贵**操作
 *    （LLM 抽取实体 + 重建社群，几分钟量级）。无脑触发等于反复烧 LLM 配额。
 *
 * 挂 Outbox 之后这两件事都由 `acked_seq` 回答：
 * 有新 seq 才重新导出，导出了才考虑触发 ingest。
 *
 * ## ★ 为什么是"重新导出全量"而不是"追加增量"
 *
 * 看起来挂了 Outbox 就该只写新增的那几条。但他们的 loader 是
 * **读整个 records.jsonl 重建**（`load_all_messages` 没有增量入口），
 * 所以"追加"对他们没有意义 —— 而且更糟：
 *
 * · 追加会让同一条消息在编辑后出现**两行**（`revision` 变了但 id 不变），
 *   而 loader 不去重，图谱里就会有两个矛盾的版本；
 * · 会话标题改了之后 `scopes.jsonl` 里也会有两行同 id 的 scope。
 *
 * 所以正确的粒度是：**Outbox 只用来判断"要不要重新导出"**，
 * 导出本身仍是全量快照（幂等、无历史包袱）。
 * 这与 FTS 那个消费者不同 —— 那边是真正的增量索引，因为我们自己的
 * `messages_fts` 支持逐条 upsert。
 *
 * ## ★ ingest 的触发：**攒批**自动，不是每轮都建
 *
 * 曾经默认完全不触发，理由是"让数据准备好与花钱建图是两个独立的决定"。
 * 那个理由半对：建图确实贵，但**不建的代价被低估了** —— 实测本机
 * 图库停在前一天 18:00，而导出当天 03:24 就更新过。也就是用户看到的
 * 图与事实永远慢一天，而引导跑完根本没有图（那时"后续想用"是空话）。
 *
 * 现在改成有条件自动：首次必建，之后攒够 500 条或攒够 24h 才建。
 * 判据在 `auto-build.ts`（纯函数，成本数字记在那个文件头）——
 * 不能无条件挂上来，因为 kl 的 Phase A 会**全量重跑向量化**（50 min），
 * 而导出是 10 分钟一轮。
 *
 * `triggerIngest` 仍然是可选参数：不传就只导出（单测与"用户关掉开关"
 * 都走这条路）。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import {
  ChangelogRepository,
  ConsumerCursorRepository,
  type SqliteDatabase,
} from "@mycontext/store"
import {
  autoBuildBackoffMs,
  decideAutoBuild,
  type AutoBuildInput,
  type AutoBuildSkipReason,
  type AutoBuildTriggerReason,
} from "./auto-build.js"

/** 消费者 id。与 FTS/vector 并列，各自独立推进游标。 */
export const GRAPH_SYNC_CONSUMER_ID = "graph-export"

/**
 * 「上次成功建图到哪个 seq」的水位。
 *
 * ## ★ 为什么用第二个游标而不是加一张表 / 加一列
 *
 * `consumer_cursors.ack()` 恰好同时写 `acked_seq` 与 `last_success_at` ——
 * 而"建到哪"与"什么时候建的"正是攒批判据要的两个值。复用它意味着
 * **零迁移**，而且状态页那套（lag / staleConsumers）自动就能看到它。
 *
 * `graph-export` 那个游标不能兼任：它推进的语义是"**导出**到哪"，
 * 而导出与建图是两件事（导出 1 秒，建图 2 小时）。合并的话
 * "数据准备好了"就会被记成"图已经建好了"—— 而那是一个静默的谎。
 *
 * `required: false`：它落后不该阻止裁剪历史（与 graph-export 同理，
 * 图谱要历史时重新全量导出即可）。
 */
export const GRAPH_BUILD_CONSUMER_ID = "graph-build"

export interface GraphSyncResult {
  /** 本轮是否真的重新导出了 */
  exported: boolean
  /** 追上到哪个 seq */
  ackedSeq: number
  /** 落后多少条（>0 且 exported=false 说明被锁或出错了） */
  lag: number
  /** 是否触发了 kl ingest */
  ingestTriggered: boolean
  /**
   * 这一轮**为什么**（没）触发建图。
   *
   * ★ 必须透出来：一个"导出了但没建图"的轮次与"建了"在日志上
   * 只差一个布尔，而用户会问"为什么图还是旧的"。原因分成
   * disabled / build-in-progress / no-new-data / below-threshold 四种，
   * 每种的下一步都不同（见 `auto-build.ts`）。
   */
  ingestReason: AutoBuildSkipReason | AutoBuildTriggerReason | null
  error: string | null
}

export interface GraphSyncOptions {
  db: SqliteDatabase
  clock: Clock
  logger?: Logger
  /** 重新物化四件套。返回导出的消息条数 */
  materialize: () => { totalMessages: number; totalMinutes: number }
  /**
   * 触发图谱重建。不传 = 只导出不触发（单测与"用户关了开关"走这条）。
   *
   * 返回三态，**必须区分**（见下面消费处与 `cancelled` 的注释）：
   * · `true`      —— 建成了；
   * · `false`     —— 失败（没装 Python / 没配 key / 导出为空 / kl 崩了）→ 进退避；
   * · `"cancelled"` —— 被我们自己打断（退出应用 / 停服务）→ **不进退避**。
   *
   * 兼容旧签名（`Promise<boolean>`）：`"cancelled"` 是新增的第三态，
   * 老实现返回 boolean 时行为不变。
   *
   * 不抛错，因为触发失败不该让导出这一步回滚。
   */
  triggerIngest?: (() => Promise<boolean | "cancelled">) | undefined
  /**
   * 建图的**判据输入**。不传 = 每次导出后都触发（老行为）。
   *
   * ★ 拆成一个 getter 而不是几个死值：`graphExists` 与 `ready` 都是
   * 随时在变的（图可能被清空、kl 可能正在建图），装配时刻取的值
   * 到这一轮已经过期了。
   */
  autoBuild?: (() => Omit<AutoBuildInput, "ackedSeq" | "now">) | undefined
}

/**
 * 图谱同步器。
 *
 * 不用 `OutboxConsumer`：那个类的语义是「逐条处理 changelog 行」
 * （handler 收到的是 `ChangelogRow[]`），而我们这里**不关心每条是什么**，
 * 只关心"有没有新的"。硬套会得到一个忽略入参的 handler —— 那种
 * "看起来在逐条处理其实没有"的代码比直接读游标更难懂。
 *
 * 但**游标表是同一张**（`consumer_cursors`），所以：
 * · 保留策略仍然会因为我们落后而不裁剪历史（`required = true`）；
 * · 状态页的 `staleConsumers` 也能看到我们卡住了。
 */
export class GraphSyncService {
  private readonly changelog: ChangelogRepository
  private readonly cursors: ConsumerCursorRepository
  private running = false
  /**
   * 连续建图失败次数 + 上次失败时刻。**只在内存里**（见 auto-build.ts
   * 文件头"失败要退避"）：失败多半是配置问题，用户填完 key 会重启应用，
   * 那时应该立刻重试而不是继续等 2 小时。
   */
  private failures = 0
  private lastFailureAt: number | null = null

  constructor(private readonly options: GraphSyncOptions) {
    this.changelog = new ChangelogRepository(options.db)
    this.cursors = new ConsumerCursorRepository(options.db, options.clock)
  }

  /**
   * 注册（幂等）。
   *
   * `required: false` 是刻意的 —— 与 FTS 不同：图谱是**外部消费者**，
   * 它落后不该阻止我们裁剪 `raw_records`（那会让本地库无限增长）。
   * 图谱要历史时重新全量导出即可，它不依赖 Outbox 的历史保留。
   */
  register(): void {
    this.cursors.register(GRAPH_SYNC_CONSUMER_ID, { required: false, minRetainedSeq: 0 })
    // 建图水位（见 GRAPH_BUILD_CONSUMER_ID 的注释）——同样不阻塞裁剪
    this.cursors.register(GRAPH_BUILD_CONSUMER_ID, { required: false, minRetainedSeq: 0 })
  }

  /**
   * 上次成功建图的水位与时刻。
   *
   * 供 `decideAutoBuild` 与状态页用。没建过时是 `{ seq: 0, at: null }`。
   */
  buildWatermark(): { seq: number; at: number | null } {
    const row = this.cursors.get(GRAPH_BUILD_CONSUMER_ID)
    return { seq: row?.ackedSeq ?? 0, at: row?.lastSuccessAt ?? null }
  }

  /**
   * 记一次**成功**的建图。
   *
   * ★ 只在真的建成之后调。失败时不推水位 —— 否则下一轮会以为
   * "已经建到这了"，那批数据永远进不了图而且没人知道
   * （与 runOnce 里"先导出成功再推游标"是同一条纪律）。
   */
  markBuilt(seq: number): void {
    this.cursors.ack(GRAPH_BUILD_CONSUMER_ID, seq)
  }

  /**
   * 把建图水位清零 —— 图库**被清空**之后必须调。
   *
   * ## ★ 为什么不能只删文件
   *
   * `wipeGraphData()`（`fresh=true` 的清库）删掉 knowledge.db / qdrant_data /
   * extraction_cache，也就是图里一条 fact 都不剩了。但这个游标留在旧位置，
   * 于是「待建条数」= `head - ackedSeq` 只算清库之后新采的那几条 ——
   * 而真实要重建的是**全部**语料。
   *
   * 实测这台机器清库后：游标停在 84988、head 85395，界面据此显示"待建 407 条"，
   * 而 kl 那边实际要重烧 37826 个 chunk（约 3 小时）。差了两个数量级的预期，
   * 用户会以为"马上就好"然后反复重启，而每次重启都让 Phase A 从零开始。
   *
   * ## 不影响触发判据
   *
   * `decideAutoBuild` 判"首次"靠 `graphExists()`（读图库行数）而不是这个游标，
   * 所以清零**不会**改变"要不要建"，只让"还差多少"说真话。
   * 也就是这一条修的是可观测性，不是调度 —— 但错的数字会诱发错的操作。
   *
   * ★ 必须走 `rewind` 而不是 `ack(…, 0)`：后者是 `MAX(acked_seq, 0)`，
   * 会被静默忽略（见 `ConsumerCursorRepository.rewind` 的注释）。
   *
   * @returns 是否真的清了（游标未注册时 false）
   */
  resetBuildWatermark(): boolean {
    return this.cursors.rewind(GRAPH_BUILD_CONSUMER_ID, 0)
  }

  /** 当前落后多少条。状态页用它显示「图谱落后 N 条」。 */
  lag(): number {
    const head = this.changelog.head()
    const acked = this.cursors.get(GRAPH_SYNC_CONSUMER_ID)?.ackedSeq ?? 0
    return Math.max(0, head - acked)
  }

  /**
   * changelog 的当前 head（"数据已经采到哪"）。
   *
   * 与 `lag()` 分开暴露：那个算的是**导出**落后多少，而建图的调度判据
   * 要的是"采集到哪了"。拿导出游标去算「还差多少条触发建图」会让
   * 那个数字在每轮导出前后跳一下，看起来像倒退
   * （见 `FeedService.graphBuildSchedule` 里的注释）。
   */
  head(): number {
    return this.changelog.head()
  }

  /**
   * 跑一轮。
   *
   * 返回报告而不是抛错：调用方是定时循环，不该被单轮失败打断
   * （与 OutboxConsumer 同一个约定）。
   */
  async runOnce(): Promise<GraphSyncResult> {
    const head = this.changelog.head()
    const acked = this.cursors.get(GRAPH_SYNC_CONSUMER_ID)?.ackedSeq ?? 0
    const lag = Math.max(0, head - acked)
    const idle: GraphSyncResult = {
      exported: false,
      ackedSeq: acked,
      lag,
      ingestTriggered: false,
      ingestReason: null,
      error: null,
    }

    if (lag === 0) return idle
    // 防重入：导出会写几 MB，两轮重叠会互相覆盖到半截的文件。
    if (this.running) return idle
    this.running = true

    try {
      const counts = this.options.materialize()
      // ★ 先导出成功、再推游标。顺序反了就会在导出失败时
      // 把这批变更"确认"掉 —— 那批数据永远不会进图谱，且没人知道。
      this.cursors.ack(GRAPH_SYNC_CONSUMER_ID, head)
      this.options.logger?.info("graph export synced", {
        ackedSeq: head,
        lag,
        messages: counts.totalMessages,
        minutes: counts.totalMinutes,
      })

      /**
       * ★ 建图**要不要**触发是一个判断，不是"有 triggerIngest 就触发"。
       *
       * 判据在 `decideAutoBuild`（纯函数）。不给 `autoBuild` 时退回老行为
       * （每次导出后都触发）—— 那条路径只有单测在走。
       */
      let ingestTriggered = false
      let ingestReason: AutoBuildSkipReason | AutoBuildTriggerReason | null = null
      if (this.options.triggerIngest !== undefined) {
        const decision =
          this.options.autoBuild === undefined
            ? ({ build: true, reason: "lag-threshold" } as const)
            : decideAutoBuild({
                ...this.options.autoBuild(),
                ackedSeq: head,
                now: this.options.clock.now(),
                consecutiveFailures: this.failures,
                lastFailureAt: this.lastFailureAt,
              })
        ingestReason = decision.reason
        if (decision.build) {
          let outcome: boolean | "cancelled" = false
          try {
            outcome = await this.options.triggerIngest()
          } catch (error) {
            // 触发失败不回滚导出：数据已经在盘上，手动建图仍然能用。
            this.options.logger?.warn("graph ingest trigger failed", {
              detail: error instanceof Error ? error.message : String(error),
            })
          }
          ingestTriggered = outcome === true
          /**
           * ★★ 被主动打断（退出应用 / 停服务）→ **既不算成功也不算失败**。
           *
           * 算失败的后果实测过：每次退出应用都会撞一次
           * ```
           * shutdown step started {"step":"klServer"}   ← 我们杀 kl
           * graph build failed {"reason":"建图中断：kl-server 进程已退出"}
           * graph auto build failed {"consecutiveFailures":1,
           *                          "retryAfterMs":1800000}
           * ```
           * 于是下次启动后**半小时不自动建图**，而这一轮根本没失败。
           * 每次退出都撞一次的话自动建图基本就废了。
           *
           * 也不清零 `failures`：这一轮什么都没验证 —— 如果之前真的连续
           * 失败过（比如网关坏了），一次"被打断"不该把那个信号抹掉。
           */
          if (outcome === "cancelled") {
            this.options.logger?.info("graph auto build cancelled; not counted as failure", {
              consecutiveFailures: this.failures,
            })
          } else if (outcome) {
            this.failures = 0
            this.lastFailureAt = null
          } else {
            /**
             * ★ `false` 与抛错**都**算失败，都要进退避。
             *
             * 立即返回 false 的那类（没装 Python / 没配 key / 导出目录空）
             * 才是最需要退避的 —— 它几毫秒就回来，不退避就是每 10 分钟
             * 刷一条同样的 warn。
             */
            this.failures += 1
            this.lastFailureAt = this.options.clock.now()
            this.options.logger?.warn("graph auto build failed", {
              consecutiveFailures: this.failures,
              retryAfterMs: autoBuildBackoffMs(this.failures),
            })
          }
        } else {
          /**
           * ★★ 没建也要说一句，且说清原因 —— 而且必须是 **info**。
           *
           * 这条原来是 `debug`，于是打包态（`logLevel: info`）看不见。代价实测
           * 过：同事点了「开始学习」之后没建图，日志里只有几条
           * `graph export synced`，**为什么不建完全查不出来** —— 而 dev 态
           * 一切正常（那边 logLevel 是 debug）。于是那看起来像"打包版不调建图
           * 接口"，其实两边都在判、只是打包版的结论不可见。
           *
           * 频率不是问题：导出是 10 分钟一轮，一天最多 144 条。
           * 而这五个原因（disabled / build-in-progress / no-new-data / below-threshold /
           * backoff）各自的下一步完全不同，缺了它只能靠猜。
           */
          this.options.logger?.info("graph ingest skipped", {
            reason: decision.reason,
            ackedSeq: head,
          })
        }
      }

      return { exported: true, ackedSeq: head, lag, ingestTriggered, ingestReason, error: null }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.options.logger?.warn("graph export failed", { detail })
      return { ...idle, error: detail }
    } finally {
      this.running = false
    }
  }
}
