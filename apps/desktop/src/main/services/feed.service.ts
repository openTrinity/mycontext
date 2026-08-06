/**
 * 知识管道服务：Feed Server 的生命周期 + 导出物化。
 *
 * ## 为什么 Feed Server 只在有登录账号时起
 *
 * 它暴露的是**某个账号**的 vault 数据。登出后仍在监听，
 * 就等于给一个已登出的会话留了一个数据出口 —— 而这个出口只有 Bearer 保护，
 * token 又写在了 handoff.json 里（算法团队要读）。
 * 所以生命周期严格跟随 vault：挂载时起、卸载时停。
 *
 * ## token 与端口
 *
 * 随机端口（固定端口更容易被本机脚本猜到）+ 随机 token，
 * 两者一起写进 `shared/handoff.json`（权限 600）供算法团队读取。
 */
import { join } from "node:path"
import type { Clock, Logger } from "@mycontext/kernel"
import { AppError } from "@mycontext/kernel"
import {
  buildHandoffManifest,
  ExportMaterializer,
  FeedServer,
  forecastAutoBuild,
  GraphSyncService,
  writeHandoffManifest,
} from "@mycontext/knowledge-feed"
import type { ExportResult } from "@mycontext/knowledge-feed"
import { formatDwsIsoTime } from "@mycontext/channels"
import {
  ChangelogRepository,
  ConsumerCursorRepository,
  DistillSourceRepository,
  type SqliteDatabase,
} from "@mycontext/store"
import type { ExportResultView, FeedInfo, KlGraphOverview } from "@mycontext/ipc-contract"

/**
 * 这个 vault 的导出落点 —— **attach 时给，不在构造时给**。
 *
 * ## ★★ 为什么必须按 vault
 *
 * `exportRoot` 里是四件套（聊天正文的投影），`handoffFile` 里是给算法团队的
 * 一页运行时事实（含 Feed 的 token 与那两个目录的绝对路径）。
 * 两者都直接派生自这个身份的语料 —— 换个身份就不成立。
 *
 * ★ `handoffFile` 原来是**一个**应用级路径（`shared/handoff.json`），
 * 于是两个身份共用一份、谁后挂载谁覆盖 —— 算法团队拿到的永远是
 * "最后一次登录的那个身份"，而这件事在文件里完全看不出来。
 * 现在一身份一份，删 vault 时一并消失。
 */
export interface FeedDirs {
  /** 这个身份的数据根（= vault 目录）。写进 handoff 的 `shared.root` */
  dataRoot: string
  /** 四件套导出目录（注入上游的 `KL_DWS_EXPORT_DIR`） */
  exportRoot: string
  /** 图谱数据目录（= 算法团队的 `databaseDir`）。只告知，不由本服务写 */
  klRoot: string
  /** `handoff.json` 的完整路径 */
  handoffFile: string
}

export interface FeedServiceOptions {
  clock: Clock
  logger: Logger
  /**
   * ★ 导出与 handoff 的落点已改为**在 attach 时给**（见 `FeedDirs`）：
   * 它们按 vault 分（导出物是语料的投影 = 聊天内容）。
   * 原来这里是 `sharedRoot: string`，一个应用级目录跨身份共用。
   */
  /**
   * embedding 网关配置：写进 handoff.json 让算法团队零配置调通同一个网关。
   *
   * ★ 函数而非值：网关配置在运行期可变（用户在设置里改了）。attach 时
   * （登录）现读，让 handoff.json 反映当前配置——改配置后到下次登录刷新。
   */
  embedding: () => {
    baseUrl: string
    model: string
    /** 算法侧写死的维度（外部约束，不是我们的选择） */
    dim: number
  }
  /** 我们本地索引自用的 embedding（仅告知，不共享向量） */
  localEmbedding: { model: string; dim: number }
  /** LLM 网关：图谱侧的抽取阶段用同一个（模型名的坑见 handoff.ts 的 llm.modelNote）。函数，见 embedding 注释 */
  llm: () => { baseUrl: string; model: string }
  /**
   * 图谱同步周期。
   *
   * 10 分钟：导出是"有新 seq 才写"（见 GraphSyncService），所以空转很便宜；
   * 而图谱的消费者是人（问一句"上周会上聊了什么"），不需要秒级新鲜度。
   * 设 0 关闭自动同步（仍可手动触发 pipelineExport）。
   */
  graphSyncIntervalMs?: number
  /** 单元测试里关掉定时器，只手动 tick */
  autoStart?: boolean
  /**
   * 自动建图的接线。**惰性**（函数而不是值），两个原因：
   *
   * · `klServer` 在装配顺序上晚于 `feed`（它要 exportDir，而那是 feed 的
   *   产物）—— 装配这一刻拿不到它；
   * · `building` / 图存不存在 / 用户开没开开关都是**随时在变**的，
   *   装配时取的快照到那一轮已经过期。
   *
   * 不给 = 只导出不建图（老行为）。
   */
  autoBuild?: {
    /** 用户开着自动建图吗 */
    enabled: () => boolean
    /** 现在能建吗（kl 就绪且不在建图中） */
    ready: () => boolean
    /** 图库里有东西吗（false = 还没建过 / 被清空过） */
    graphExists: () => boolean
    /**
     * 真的去建。三态：
     * · `true` = 建成了；
     * · `false` = 失败（会进退避）；
     * · `"cancelled"` = 被主动打断（退出应用 / 停服务）→ **不进退避**，
     *   见 `KlGraphBuildResult.cancelled` 的注释。
     */
    trigger: () => Promise<boolean | "cancelled">
  }
}

/** 图谱同步的默认周期。见 options 注释。 */
const GRAPH_SYNC_INTERVAL_MS = 10 * 60_000

export class FeedService {
  private server: FeedServer | null = null
  private db: SqliteDatabase | null = null
  /** 当前 vault 的导出落点。未 attach 时 null。 */
  private dirs: FeedDirs | null = null
  private graphSync: GraphSyncService | null = null
  private graphTimer: NodeJS.Timeout | null = null
  private inFlightSync: Promise<unknown> | null = null

  constructor(private readonly options: FeedServiceOptions) {}

  /** vault 挂载时调用。幂等：重复调用先停旧的。 */
  async attach(db: SqliteDatabase, dirs: FeedDirs): Promise<void> {
    await this.detach()
    this.db = db
    this.dirs = dirs
    const server = new FeedServer({
      db,
      clock: this.options.clock,
      logger: this.options.logger.child("Feed"),
    })
    const port = await server.start()
    this.server = server

    // handoff.json：算法团队读它就知道端口、token、共享目录与两个网关（LLM + embedding）。
    const manifestPath = dirs.handoffFile
    const embedding = this.options.embedding()
    const llm = this.options.llm()
    writeHandoffManifest(
      manifestPath,
      buildHandoffManifest({
        // ★ 三个路径显式给 —— 不让 handoff 那侧再拼一份目录布局（见那里的注释）
        dataRoot: dirs.dataRoot,
        dwsExportDir: dirs.exportRoot,
        klDataDir: dirs.klRoot,
        feedPort: port,
        feedToken: server.token,
        embeddingBaseUrl: embedding.baseUrl,
        embeddingModel: embedding.model,
        embeddingDim: embedding.dim,
        localEmbeddingModel: this.options.localEmbedding.model,
        localEmbeddingDim: this.options.localEmbedding.dim,
        llmBaseUrl: llm.baseUrl,
        llmModel: llm.model,
        nowMs: this.options.clock.now(),
      }),
    )

    // 端口进日志，token **不进**（日志会被贴到 issue 里）。
    this.options.logger.info("feed server started", { port, manifestPath })

    /**
     * 图谱同步：挂 Outbox，有新 seq 才重新导出四件套。
     *
     * 与 Feed Server 同生命周期（跟随 vault）—— 登出后不该再往共享目录写
     * 一个已登出账号的数据。
     */
    /**
     * ★ 自动建图在这里接上（见 graph-sync.ts 与 auto-build.ts 的文件头）。
     *
     * 曾经刻意不接，理由是"数据准备好"与"花钱建图"该是两个独立决定。
     * 但实测的后果是**引导跑完根本没有图**，而用户接着就要用它 ——
     * 那时"独立决定"变成了"这个功能不能用"。
     *
     * 所以改成**攒批**自动：首次必建，之后攒够 500 条或 24h 才建。
     * 判据是纯函数（`decideAutoBuild`），成本数字记在那个文件头。
     */
    const auto = this.options.autoBuild
    this.graphSync = new GraphSyncService({
      db,
      clock: this.options.clock,
      logger: this.options.logger.child("GraphSync"),
      materialize: () => this.materialize(),
      ...(auto === undefined
        ? {}
        : {
            autoBuild: () => {
              const mark = this.graphSync?.buildWatermark() ?? { seq: 0, at: null }
              return {
                lastBuiltSeq: mark.seq,
                lastBuiltAt: mark.at,
                graphExists: auto.graphExists(),
                enabled: auto.enabled(),
                ready: auto.ready(),
              }
            },
            triggerIngest: async () => {
              const started = await auto.trigger()
              return started
            },
          }),
    })
    this.graphSync.register()

    const interval = this.options.graphSyncIntervalMs ?? GRAPH_SYNC_INTERVAL_MS
    if (interval > 0 && this.options.autoStart !== false) {
      this.graphTimer = setInterval(() => void this.tickGraphSync(), interval)
      // 挂载时先跑一轮：登录后立刻有一份最新快照，不用等一个周期。
      void this.tickGraphSync()
    }
  }

  /**
   * 跑一轮图谱同步。
   *
   * `inFlightSync` 让 `detach()` 能等它收尾 —— 不等的话导出中途库被关掉，
   * 会往已关闭的连接上读（与采集侧 logout 竞态是同一类问题）。
   */
  async tickGraphSync(): Promise<void> {
    const sync = this.graphSync
    if (sync === null) return
    if (this.inFlightSync !== null) return
    const run = sync.runOnce()
    this.inFlightSync = run
    try {
      const result = await run
      /**
       * ★ 建图水位只在**真的建成**之后推，而且推的是那一轮的 `ackedSeq`。
       *
       * 三个都要对：
       * · `ingestTriggered` 为真才推 —— 没建就推等于宣称"已经建到这了"，
       *   那批数据永远进不了图而且没人知道；
       * · 推的是 `result.ackedSeq`（**建图看到的那份导出**的水位），
       *   不是 `head`：建图跑的几十分钟里又有新消息进来，
       *   拿新的 head 会把那些没进图的也算进去；
       * · `trigger()` 是**等建完**才 resolve 的（KlServerService.rebuildGraph
       *   内部轮询 /status 到终态）—— 所以走到这里图已经建好了。
       */
      if (result.ingestTriggered) {
        sync.markBuilt(result.ackedSeq)
        this.options.logger.info("graph auto-built", {
          ackedSeq: result.ackedSeq,
          reason: result.ingestReason,
        })
      }
    } finally {
      this.inFlightSync = null
    }
  }

  async detach(): Promise<void> {
    if (this.graphTimer !== null) clearInterval(this.graphTimer)
    this.graphTimer = null
    // 等在途的那一轮导出收尾再放开 db —— 调用方随后会关库。
    const inFlight = this.inFlightSync
    if (inFlight !== null) await inFlight.catch(() => undefined)
    this.inFlightSync = null
    this.graphSync = null

    if (this.server !== null) {
      await this.server.stop()
      this.options.logger.info("feed server stopped")
    }
    this.server = null
    this.db = null
  }

  info(): FeedInfo {
    const server = this.server
    const db = this.db
    if (server === null || db === null) {
      return { running: false, baseUrl: "", tokenReady: false, head: 0, consumers: [] }
    }
    const changelog = new ChangelogRepository(db)
    const head = changelog.head()
    return {
      running: true,
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      // ★ 只给「是否就绪」，不给 token 本身：渲染进程能拿到的东西
      // 一次 XSS 就能偷走。token 的正当读者是算法团队（handoff.json，0600）
      // 与主进程自己，都不经过渲染层。
      //
      // ⚠️ 这里恒为 true（token 在 FeedServer 构造时生成，不会是空串）——
      // 也就是它当前不传递任何信息。留着是为了将来 token 改为外部注入时
      // 不必改协议；UI 判断"能不能取 token"应当看 `running`。
      tokenReady: server.token !== "",
      head,
      consumers: new ConsumerCursorRepository(db, this.options.clock).list().map((consumer) => ({
        consumerId: consumer.consumerId,
        ackedSeq: consumer.ackedSeq,
        lag: head - consumer.ackedSeq,
        needsFullRebuild: consumer.needsFullRebuild,
      })),
    }
  }

  /**
   * 全量物化。
   *
   * 一期给算法团队的主通道是文件（他们的 loader 本来就读目录，改动量为 0）；
   * Outbox 的 `/v1/changes` 作为增量通道同时提供，他们想切随时切 ——
   * 两条路共用同一份水位。
   */
  export(): ExportResultView {
    if (this.db === null) {
      return {
        sourceCount: 0,
        totalMessages: 0,
        totalMinutes: 0,
        totalDocuments: 0,
        headSeq: 0,
        exportDir: "",
      }
    }
    const result = this.materialize()
    return {
      sourceCount: result.sources.length,
      totalMessages: result.totalMessages,
      totalMinutes: result.totalMinutes,
      totalDocuments: result.totalDocuments,
      headSeq: result.headSeq,
      exportDir: this.exportDir,
    }
  }

  /** 导出落点。手动导出与自动同步必须是**同一个**目录，否则会有两份不一致的 bundle。 */
  private get exportDir(): string {
    return this.requireDirs().exportRoot
  }

  /**
   * 当前 vault 的导出落点。
   *
   * ★ 未 attach 时抛错而不是退回应用级目录：那种兜底会把"忘了接线"
   * 变成"导出物写进了公共目录"—— 一次静默的跨身份写入，
   * 而下游（图谱建图）会照常成功，只是吃的是别人的语料。
   */
  private requireDirs(): FeedDirs {
    const dirs = this.dirs
    if (dirs === null) throw new AppError("DB_UNAVAILABLE", "尚未登录，导出目录未就绪")
    return dirs
  }

  /**
   * 真正的物化。手动 `export()` 与自动 `tickGraphSync()` 共用这一条路径 ——
   * 两处各写一份实现迟早会漂（一处改了字段另一处没改，而 ingest 不报错）。
   */
  private materialize(): ExportResult {
    const db = this.db
    if (db === null) throw new AppError("DB_UNAVAILABLE", "尚未登录，无法导出")
    return new ExportMaterializer({
      db,
      clock: this.options.clock,
      exportDir: this.exportDir,
      // 时间格式化按渠道注入：knowledge-feed 不该知道钉钉的时区约定
      formatTime: formatDwsIsoTime,
      logger: this.options.logger.child("Export"),
      // ★ 只把用户在引导里选的范围导进知识图谱（见 ExportOptions.scope）。
      // 不读的话就是全库全时段 —— "选了没用"里最实质的一条。
      scope: this.exportScope(db),
    }).run()
  }

  /**
   * 从 `distill_sources` 的 `chat` 源读出导出范围。
   *
   * `enabled === false` 时返回一个**空白名单**语义……不，反过来：
   * 源没开就当"不限"（`undefined`）——那与"没配范围"一致，导全库。
   * 真正要收窄的是**开了且配了会话/时间**的情况。`conversationIds` 存的是
   * external_id（引导写的就是它），直接透传给 materializer 的白名单。
   */
  private exportScope(db: SqliteDatabase): {
    conversationExternalIds?: readonly string[]
    since?: number
    until?: number
  } {
    const chat = new DistillSourceRepository(db).list().find((s) => s.kind === "chat")
    if (chat === undefined || !chat.enabled) return {}
    const scope: { conversationExternalIds?: readonly string[]; since?: number; until?: number } =
      {}
    if (chat.scope.conversationIds !== undefined && chat.scope.conversationIds.length > 0) {
      scope.conversationExternalIds = chat.scope.conversationIds
    }
    if (chat.scope.since !== undefined) scope.since = chat.scope.since
    if (chat.scope.until !== undefined) scope.until = chat.scope.until
    return scope
  }

  /** 图谱同步的落后条数。状态页用它显示「图谱落后 N 条」。 */
  graphLag(): number {
    return this.graphSync?.lag() ?? 0
  }

  /**
   * 自动建图的**调度快照** —— 界面上「下次多久后构建」那一块的数据源。
   *
   * ## ★ 与真实触发判据同源（这是重点）
   *
   * 它调的是 `forecastAutoBuild`，而那个函数内部就是 `decideAutoBuild`
   * —— 也就是**真正决定建不建的那一个**。界面自己算的话必然与它漂移，
   * 而"界面说还差 300 条、实际条件却是另一套"这种偏差没人查得出来。
   *
   * ## 为什么放在 FeedService
   *
   * 两个水位都在这里（`GraphSyncService` 的 `lag()` 与 `buildWatermark()`），
   * 而阈值与开关来自 `autoBuild`（也是这里注入的）。数据都在手上，
   * 让别的服务来读它们只会多一份耦合。
   *
   * 没接自动建图（`autoBuild` 未注入 / 未挂载 vault）→ null，
   * 界面据此不显示那一块（而不是显示一堆 0，那会像"永远不会建"）。
   */
  graphBuildSchedule(): KlGraphOverview["buildSchedule"] {
    const sync = this.graphSync
    const auto = this.options.autoBuild
    if (sync === null || auto === undefined) return null

    const mark = sync.buildWatermark()
    const head = sync.head()
    const forecast = forecastAutoBuild({
      /**
       * ★ 用 changelog 的 head 而不是导出游标的 ackedSeq。
       *
       * 两者的差别是"数据已经采到哪"与"已经导出到哪"。界面上那个数字
       * 要回答的是「还差多少条会触发建图」，而导出是 10 分钟一轮的中间步骤
       * —— 拿 ackedSeq 会让数字在导出前后跳一下，看起来像倒退。
       */
      ackedSeq: head,
      lastBuiltSeq: mark.seq,
      lastBuiltAt: mark.at,
      now: this.options.clock.now(),
      graphExists: auto.graphExists(),
      enabled: auto.enabled(),
      ready: auto.ready(),
    })

    return {
      enabled: auto.enabled(),
      reason: forecast.decision.reason,
      willBuild: forecast.decision.build,
      pendingMessages: Math.max(0, head - mark.seq),
      messagesToThreshold: forecast.messagesToThreshold,
      lagThreshold: forecast.lagThreshold,
      maxAgeMs: forecast.maxAgeMs,
      etaMs: forecast.etaMs,
      lastBuiltAt: mark.at,
      syncIntervalMs: this.options.graphSyncIntervalMs ?? GRAPH_SYNC_INTERVAL_MS,
    }
  }
}
