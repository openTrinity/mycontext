/**
 * 数据面协调器。
 *
 * 存在的理由：采集与 Feed 的生命周期都**严格跟随 vault**（登录挂载、登出卸载），
 * 而这个规则如果散在 auth 的 `onSessionChange` 回调里，就会出现
 * 「登出了但采集还在跑」——那意味着已登出的账号数据仍在被写入与暴露。
 *
 * 一处开关，一处销毁。
 */
import type { BrowserWindow } from "electron"
import type { Clock, Logger } from "@mycontext/kernel"
import { AppError, isAppError } from "@mycontext/kernel"
import type {
  ChannelEvents,
  ChannelEventSubscriptionAudit,
  ChannelPlugin,
} from "@mycontext/channels"
import { extractMentionTexts, mentionsSelf } from "@mycontext/channels"
import type { PersonaSupervisor } from "@mycontext/persona"
import {
  ConversationRepository,
  MessageRepository,
  SelfIdentityRepository,
  inferSelfExternalIdFromDirectChats,
  type PurgeReport,
  type SqliteDatabase,
} from "@mycontext/store"
import {
  IPC_EVENTS,
  type ExportResultView,
  type FeedInfo,
  type IngestSnapshot,
  type SelfIdentityView,
} from "@mycontext/ipc-contract"
import { AUTO_BUILD_MIN_INTERVAL_MS } from "@mycontext/knowledge-feed"
import { IngestService } from "./ingest.service.js"
import type { FeedDirs, FeedService } from "./feed.service.js"

export interface DataPlaneOptions {
  clock: Clock
  logger: Logger
  plugin: ChannelPlugin
  /**
   * 其余渠道，各自一个物理库。
   *
   * ★ **函数**而不是数组：它们的 `FeedService` 由 `ChannelPipelineManager`
   * 在**登录后**按"用户连了哪几个渠道"现造，而本服务在装配阶段就构造好了。
   * 传数组的后果是它恒为空 —— 于是那些渠道的 `IngestService` 一个都不起、
   * 导出物一条都不生成，且完全静默（这正是改动前飞书那一路的形态）。
   */
  sources?: () => readonly { plugin: ChannelPlugin; feed: FeedService }[]
  feed: FeedService
  getWindow: () => BrowserWindow | null
  /** 关闭自动定时器（测试用） */
  autoStart?: boolean
  /**
   * 取数字人管控层（给了就挂 `persona-inbox` 消费者）。
   *
   * 用函数而不是直接传实例：`PersonaService.attach` 与 `DataPlane.attach`
   * 的先后顺序由 startup 决定，传实例会拿到一个 attach 之前的 null。
   */
  getPersonaSupervisor?: () => PersonaSupervisor | null
  /**
   * 投递给数字人成功后的回调（叫醒调度 + 推快照）。
   *
   * 与 `getPersonaSupervisor` 成对：给了 supervisor 却不给这个，
   * 消息会进队列但要等 8 秒才被处理（见 `PersonaService.wake`）。
   */
  onPersonaDelivered?: () => void
  /**
   * 采集轮询周期（可配置，来自设置页）。透传给 `IngestService.intervals`。
   * 不给时用内置默认（探针 10s）。
   */
  intervals?: {
    probeBaseMs?: number
    probeMaxMs?: number
    pullMs?: number
    minutesMs?: number
    documentsMs?: number
    activeScanMs?: number
  }
}

export interface DataPlaneSourceAttachment {
  channelId: string
  db: SqliteDatabase
  dbPath: string
  /**
   * 这个渠道的导出/图谱落点。★ 与主渠道一样按 vault 分（见 `FeedDirs`）——
   * 少了它飞书的导出会落回主渠道的目录并互相覆盖。
   */
  feedDirs: FeedDirs
}

/** 采集轮询周期配置（`dh_settings.ingestIntervals`）。全字段可选。 */
interface IngestIntervals {
  probeBaseMs?: number
  probeMaxMs?: number
  pullMs?: number
  minutesMs?: number
  documentsMs?: number
  activeScanMs?: number
  /**
   * 建图最小间隔。**与上面几项不同：它不是"多久跑一次"，而是"至少隔多久"**
   * —— 完整的 why 见契约里 `graphBuildMinIntervalMs` 的注释。
   *
   * ★ 它也不由 `IngestService` 消费（那是采集），而是被自动建图的判据
   * （`auto-build.ts` 的 `decide()`）读走。放在同一组是因为存取链与
   * 设置面板都是同一套。
   */
  graphBuildMinIntervalMs?: number
}

/**
 * 从 vault 的 `dh_settings` 读采集轮询周期。没配 / 表还没建 → undefined
 * （IngestService 用内置默认，探针 10s）。只取数字字段，其余忽略。
 */
function readIngestIntervals(db: SqliteDatabase): IngestIntervals | undefined {
  try {
    const row = db
      .prepare<[string], { value_json: string }>("SELECT value_json FROM dh_settings WHERE key = ?")
      .get("ingestIntervals")
    if (row === undefined) return undefined
    const parsed = JSON.parse(row.value_json) as Record<string, unknown>
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
    const iv: IngestIntervals = {}
    const probeBaseMs = num(parsed["probeBaseMs"])
    const probeMaxMs = num(parsed["probeMaxMs"])
    const pullMs = num(parsed["pullMs"])
    const minutesMs = num(parsed["minutesMs"])
    const documentsMs = num(parsed["documentsMs"])
    const activeScanMs = num(parsed["activeScanMs"])
    const graphBuildMinIntervalMs = num(parsed["graphBuildMinIntervalMs"])
    if (probeBaseMs !== undefined) iv.probeBaseMs = probeBaseMs
    if (probeMaxMs !== undefined) iv.probeMaxMs = probeMaxMs
    if (pullMs !== undefined) iv.pullMs = pullMs
    if (minutesMs !== undefined) iv.minutesMs = minutesMs
    if (documentsMs !== undefined) iv.documentsMs = documentsMs
    if (activeScanMs !== undefined) iv.activeScanMs = activeScanMs
    if (graphBuildMinIntervalMs !== undefined)
      iv.graphBuildMinIntervalMs = graphBuildMinIntervalMs
    return Object.keys(iv).length === 0 ? undefined : iv
  } catch {
    // 表还不存在（迁移没跑完）/ JSON 坏了 → 用默认，不让它挡住采集启动。
    return undefined
  }
}

/** 状态推送的最小间隔。人眼看不出 4Hz 与 40Hz 的差别，而后者的代价是实打实的。 */
const SNAPSHOT_THROTTLE_MS = 250

/**
 * 采集周期的缺省值。**必须与 `IngestService` 里那几个常量同源**
 * （probe 10s / max 120s / pull 2min / minutes 30min）——
 * 两处各写一份会让设置页显示的默认值与实际跑的不一致，而那种偏差查不出来。
 *
 * ★ 这里**不再**有 `graphBuildMinIntervalMs`（自动建图的最小间隔）。
 * rebase 到 main 之后那套节流换了机制：不再按"至少隔多久"，而是按
 * **连续失败次数**退避（`auto-build.ts` 的 `AUTO_BUILD_BACKOFF_MS`，
 * 30min / 1h / 2h 三档）。保留一个并行的最小间隔等于两套节流各判一次，
 * 而它们不一致时的表现是"该建的时候没建"—— 静默且难查。
 */
const INTERVAL_DEFAULTS: Required<IngestIntervals> = {
  probeBaseMs: 10_000,
  probeMaxMs: 120_000,
  pullMs: 2 * 60_000,
  minutesMs: 30 * 60_000,
  documentsMs: 60 * 60_000,
  activeScanMs: 30_000,
  /**
   * ★ 与 `auto-build.ts` 同源 —— 两处各写一份会让设置页显示的默认值与实际
   * 生效的不一致，而那种偏差查不出来（面板说 1 小时、实际按另一个值退避）。
   */
  graphBuildMinIntervalMs: AUTO_BUILD_MIN_INTERVAL_MS,
}

/** 生效的采集周期（全字段都有值 —— 缺省与用户配置合并后的结果）。 */
type IngestIntervalsView = Required<IngestIntervals>

/**
 * 保存入参。**显式带 `| undefined`**：zod 的 `.partial()` 在
 * `exactOptionalPropertyTypes` 下产出的正是"键存在、值为 undefined"，
 * 用 `Partial<>` 接不住（那表示"键可以不存在"，是另一件事）。
 */
type IngestIntervalsPatch = { [K in keyof IngestIntervals]?: number | undefined }

/**
 * 丢掉 `undefined` 的字段。
 *
 * ★ 必需：zod 的 `.partial()` 会**产出显式 undefined** 的键，
 * 而 `{...a, ...b}` 里 b 的显式 undefined 会把 a 的值覆盖成 undefined ——
 * 表现是"只改了一项，其余全变缺省"。persona 的 limitsSave 踩过同一个坑。
 */
function pickDefined(patch: IngestIntervalsPatch): Partial<IngestIntervals> {
  const out: Partial<IngestIntervals> = {}
  if (patch.probeBaseMs !== undefined) out.probeBaseMs = patch.probeBaseMs
  if (patch.probeMaxMs !== undefined) out.probeMaxMs = patch.probeMaxMs
  if (patch.pullMs !== undefined) out.pullMs = patch.pullMs
  if (patch.minutesMs !== undefined) out.minutesMs = patch.minutesMs
  if (patch.documentsMs !== undefined) out.documentsMs = patch.documentsMs
  if (patch.activeScanMs !== undefined) out.activeScanMs = patch.activeScanMs
  /**
   * ★ 漏掉这一行的后果是**保存静默不生效**：面板上选了新值、请求成功、
   * 界面回显也对（乐观更新），但落库时这个字段被丢掉，下次读回来还是旧值。
   * 而"保存了没生效"是最难查的一类 —— 没有任何报错。
   */
  if (patch.graphBuildMinIntervalMs !== undefined)
    out.graphBuildMinIntervalMs = patch.graphBuildMinIntervalMs
  return out
}

export class DataPlaneService {
  private ingest: IngestService | null = null
  private readonly sourceIngest = new Map<string, IngestService>()
  private readonly sourceDatabases = new Map<string, SqliteDatabase>()
  private sourceAttachments: DataPlaneSourceAttachment[] = []
  private readonly activeChannels = new Set<string>()
  private db: SqliteDatabase | null = null
  /**
   * 当前 vault 的库路径。留着是为了 `intervalsSave` 能**原地重挂**采集
   * （周期是构造时读进 IngestService 的，改了要重建才生效）。
   */
  private dbPath: string | null = null
  /** 当前 vault 的导出落点（透传给 FeedService；原地重挂时复用） */
  private feedDirs: FeedDirs | null = null
  /**
   * 实时事件长连接（渠道支持时）。**只当叫醒信号**：收到就定向补拉那个会话，
   * 正文仍走采集。它挂了不影响完整性（见 ChannelEvents 契约注释）。
   */
  private eventStream: ChannelEvents | null = null
  /**
   * 最近一次订阅面对账的结果。
   *
   * ★ 缓存而不是在 `snapshot()` 里现算：对账要跑两条 `dws` 子命令（各百毫秒级），
   * 而 `snapshot()` 是同步的、且被 250ms 节流地高频调用。挂在快照路径上会把
   * 状态推送变成"每次都起两个子进程"。所以 attach 时算一次，之后按需刷新。
   */
  private eventAudit: ChannelEventSubscriptionAudit | null = null
  /** 节流状态：上次推送时刻 + 待推的定时器。 */
  private lastPushAt = 0
  private pushTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: DataPlaneOptions) {}

  /** 当前的非主渠道配置（惰性取，见 `DataPlaneOptions.sources`）。 */
  private sourceOptions(): readonly { plugin: ChannelPlugin; feed: FeedService }[] {
    return this.options.sources?.() ?? []
  }

  /**
   * vault 挂载。`dbPath` 用于统计 WAL 体积（状态页显示）。
   *
   * `feedDirs` 只是**透传**给 `FeedService`（导出与 handoff 的落点按 vault 分）。
   * 本服务不自己存一份 —— 多一个副本就多一个可能过期的真源。
   *
   * ## ★★ `pollingEnabled: false` —— 挂上库但**不拉数据**
   *
   * 这两件事原来绑在一起，而它们的前置条件不同：
   * · **挂库**（`this.db = db`）是"解析身份"的前置 —— `resolveSelf()` 要写
   *   身份行、要拿库里的单聊做交集判据；
   * · **拉数据**（定时器 + 事件长连接）必须等到**有身份之后**，否则渠道命令
   *   不带 `--profile`，会跟着 CLI 的全局身份读到别人的数据。
   *
   * 绑在一起的后果（实测，用户日志）：未绑身份时装配层整个跳过 `attach`
   * → `this.db` 为 null → 点「用这个身份」时 `resolveSelf()` 抛
   * 「尚未登录，无法解析身份」→ 采纳失败。**又是一个死锁**：
   * 挂库是获得身份的前置，而我把它挡在了"要先有身份"后面。
   *
   * 所以拆开：未绑身份时仍然挂库（纯本地、无副作用），只是不起定时器与长连接。
   * 绑上身份后走 `switchTo()` → `mount()`，那时 `pollingEnabled` 为真，
   * `attach` 重跑一遍把它们起起来。
   *
   * ## `sourceAttachments` —— 其余渠道各自的物理库
   *
   * 飞书一个独立 SQLite。每个 attachment 会得到自己的 `IngestService` ——
   * 那样 FTS/蒸馏/数字人三个 Outbox 消费者天然跟着走，不用给它们各加一次
   * "要不要处理这个渠道"的判据。
   */
  async attach(
    db: SqliteDatabase,
    dbPath: string,
    feedDirs: FeedDirs,
    /**
     * 其余渠道各自的物理库。★ 放在 `options` **之前**：它是位置参数里
     * 更"数据面"的那一个，而 `options` 是可选开关 —— 与既有调用点
     * （只传前三个）都兼容。
     */
    sourceAttachments: readonly DataPlaneSourceAttachment[] = [],
    options: { pollingEnabled?: boolean } = {},
  ): Promise<void> {
    const pollingEnabled = options.pollingEnabled !== false
    await this.detach()
    this.db = db
    this.dbPath = dbPath
    /**
     * ★ 记下这套目录：`intervalsSave()` 会**原地重挂**（改采集周期要重建
     * IngestService），那时必须用同一套 —— 让调用方再传一次等于给了一个
     * 传错的机会，而传错的表现是导出物落到别的身份目录下且不报错。
     */
    this.feedDirs = feedDirs
    this.sourceAttachments = [...sourceAttachments]

    const ingest = new IngestService({
      db,
      dbPath,
      clock: this.options.clock,
      logger: this.options.logger.child("Ingest"),
      plugin: this.options.plugin,
      ...(this.options.autoStart === undefined ? {} : { autoStart: this.options.autoStart }),
      ...(() => {
        const supervisor = this.options.getPersonaSupervisor?.() ?? null
        return supervisor === null ? {} : { personaSupervisor: supervisor }
      })(),
      ...(this.options.onPersonaDelivered === undefined
        ? {}
        : { onPersonaDelivered: this.options.onPersonaDelivered }),
      // 轮询周期：优先构造参数（测试注入），否则从这个 vault 的 dh_settings 读。
      ...(() => {
        const iv = this.options.intervals ?? readIngestIntervals(db)
        return iv === undefined ? {} : { intervals: iv }
      })(),
      ...(this.options.intervals === undefined ? {} : { intervals: this.options.intervals }),
      /**
       * 常驻 agent 的会话 → external_id 列表，给探针做定向补拉（最不能漏消息）。
       *
       * supervisor 给的是**内部** conversationId，这里用 db 翻成 external_id
       * （渠道命令认后者）。db 为 null（未 attach）时给空 —— 那时也没在跑。
       */
      residentConversationExternalIds: () => {
        const supervisor = this.options.getPersonaSupervisor?.() ?? null
        if (supervisor === null || this.db === null) return []
        const conversations = new ConversationRepository(this.db)
        const out: string[] = []
        for (const agent of supervisor.residentConversations()) {
          const conv = conversations.findById(agent.conversationId)
          if (conv !== null) out.push(conv.externalId)
        }
        return out
      },
    })

    /**
     * 快通道：入库后把状态推给 UI，不让渲染层轮询。
     *
     * ## ★ 订阅**批级**事件，不订阅逐条的 `inbound.message`
     *
     * 首版这里订阅的是 `inbound.message`（逐条），而 `pushSnapshot()`
     * 每次要做 9 个全表 `COUNT(*)` + 2 个 pragma + 一次 IPC send。
     * better-sqlite3 是同步的，所以那是主进程的硬阻塞：
     * 实测单次 0.29ms@1万行 → 6.31ms@20万行，回溯 20 万条累计约 **21 分钟**
     * 主进程阻塞 —— 直接冲击「数字人 15-20s 响应」这个目标。
     *
     * 首版注释写的是「用状态快照而不是逐条以免打满 IPC」，但**订阅本身是逐条的**，
     * 所以那道防护从未生效。现在两处都改：
     * ① 订阅 `batch.persisted`（每批一次，不是每条一次）；
     * ② 再加 250ms 节流，挡住"很多小批连着来"的情况。
     *
     * 数字人的逐条订阅仍走 `ingest.events` 的 `inbound.message`
     * （进程内，不过 IPC、不查库）。
     */
    ingest.events.on("batch.persisted", () => this.pushSnapshotThrottled())
    // 窗口推进不一定产生新行；activeWindow / floor / stalled 仍要实时推给 UI。
    ingest.events.on("backfill.changed", () => this.pushSnapshotThrottled())

    /**
     * ★★ 两道门**都要过**，而它们问的不是同一件事：
     *
     * · `pollingEnabled` —— **有没有绑身份**。没绑时挂库但不起定时器/长连接，
     *   否则渠道命令不带 `--profile`，会跟着 CLI 的全局身份读到别人的数据。
     *   （`this.ingest` 仍然赋值：那个实例本身无副作用，而快照与
     *   `resolveSelf`/`confirmSelf` 都要经过它 —— 不赋值就是另一个死锁。）
     * · `primaryAuthorized` —— **这个渠道授权了没**。没授权时它的 CLI 会一直
     *   失败刷日志，但 vault 级的消费者（FTS/蒸馏/数字人）仍要存在。
     *
     * 合起来：定时器只在"绑了身份**且**这个渠道授权了"时起。
     * 少任何一个判据都会让一类环境静默出错 —— 前者读到别人的数据，
     * 后者刷满失败日志。
     */
    // Some capability-only test plugins omit auth; treat those as already usable.
    const primaryStatus =
      this.options.plugin.auth === undefined
        ? ({ state: "authorized" } as const)
        : await this.options.plugin.auth.status().catch(() => null)
    const primaryAuthorized = primaryStatus?.state === "authorized"
    // Shared vault consumers must exist even when DingTalk is disconnected.
    ingest.start(pollingEnabled && primaryAuthorized)
    if (primaryAuthorized) this.activeChannels.add(this.options.plugin.meta.id)
    this.ingest = ingest
    /**
     * ★ 导出落点跟着 vault 走（见 FeedDirs）—— 由这一层透传。
     * `DataPlaneService` 自己不认识那些路径，只是把 attach 时收到的传下去：
     * 多一层"它也存一份路径"会多一个可能过期的副本。
     */
    await this.options.feed.attach(db, feedDirs)

    /**
     * 其余渠道：**每个一套独立的 `IngestService`**（各自的物理库）。
     *
     * ★ 为什么是"多起一个实例"而不是"让 IngestService 支持多库"：
     * 它内部注册了 FTS / 蒸馏 / 数字人三个 Outbox 消费者，多起一个实例
     * 那三个天然跟着走；改成多库支持则要给每个消费者各加一次
     * "这条记录属于哪个渠道"的判据，而漏一处就是静默不处理。
     */
    for (const sourceOption of this.sourceOptions()) {
      const plugin = sourceOption.plugin
      if (plugin.ingest === undefined) continue
      const attachment = sourceAttachments.find((item) => item.channelId === plugin.meta.id)
      if (attachment === undefined) continue
      const source = new IngestService({
        db: attachment.db,
        dbPath: attachment.dbPath,
        clock: this.options.clock,
        logger: this.options.logger.child(`Ingest:${plugin.meta.id}`),
        plugin,
        ...(this.options.autoStart === undefined ? {} : { autoStart: this.options.autoStart }),
        ...(() => {
          const iv = this.options.intervals ?? readIngestIntervals(attachment.db)
          return iv === undefined ? {} : { intervals: iv }
        })(),
      })
      source.events.on("batch.persisted", () => this.pushSnapshotThrottled())
      this.sourceIngest.set(plugin.meta.id, source)
      this.sourceDatabases.set(plugin.meta.id, attachment.db)
      await sourceOption.feed.attach(attachment.db, attachment.feedDirs)

      /**
       * 未授权的渠道**不起采集**：它的 CLI 会一直失败，而那些失败会刷满日志
       * 并让状态页显示"正在采集"。授权成功时走 `activateChannel()` 补起来。
       */
      const status = await plugin.auth.status().catch(() => null)
      if (status?.state === "authorized") {
        source.start()
        this.activeChannels.add(plugin.meta.id)
      }
    }

    /**
     * 实时事件长连接（渠道支持时）。收到事件 → 定向补拉那个会话，让
     * 「@我的消息」秒级可见，而不必等下一轮全局轮询。
     *
     * ★ 只当叫醒信号：`refreshConversation` 走的是采集那条落库路径，事件本身
     * 不落库（见 ChannelEvents 契约）。所以事件挂了、零投递、或这个账号根本
     * 收不到（实测过），都只是"退回等轮询"，完整性不受影响。
     *
     * ★ 不受 `autoStart` 门控：那个门控的是**定时器**，而事件流是不是要起
     * 由**渠道有没有这个能力**决定（`plugin.events`）。测试用的假插件不给
     * events 工厂 → 不起流；生产的钉钉插件给 → 起真长连接。这样单测可以
     * 注入一个假 events 工厂来验接线，而不会误起真的 `dws` 子进程。
     */
    if (this.options.plugin.events !== undefined && pollingEnabled) {
      const stream = this.options.plugin.events({
        clock: this.options.clock,
        onSignal: (signal) => void this.refreshConversation(signal.conversationExternalId),
      })
      stream.start()
      this.eventStream = stream
      /**
       * 起完就对一次账（覆盖面）。**不 await**：对账要跑两条 dws 子命令，
       * 而 attach 在登录关键路径上 —— 让它拖慢登录不值得。算完写进缓存，
       * 下一次快照推送就带上了。失败也不影响采集（audit 自己不抛）。
       */
      void stream
        .audit()
        .then((audit) => {
          this.eventAudit = audit
          if (audit.error !== null) {
            this.options.logger.warn("event subscription audit failed", { detail: audit.error })
          } else {
            this.options.logger.info("event subscription audit", {
              catalog: audit.catalog.length,
              global: audit.globalKeys.length,
              perConversation: audit.perConversationKeys.length,
              active: audit.activeSubscriptions,
            })
          }
          this.pushSnapshotThrottled()
        })
        .catch(() => undefined)
    }
  }

  async detach(): Promise<void> {
    // 定时器先清：库即将被关掉，而 pushSnapshot 会查库。
    if (this.pushTimer !== null) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    /**
     * ★ 事件长连接先停：它的 onSignal 会调 refreshConversation（查库）。
     * 不先停就关库的话，一条晚到的事件会往已关闭的连接上补拉。
     * stop() 会退订服务端订阅（event stop --all）—— 不退会泄漏常驻子进程。
     */
    const stream = this.eventStream
    this.eventStream = null
    this.eventAudit = null
    if (stream !== null) await stream.stop().catch(() => undefined)
    // ★ await：`stop()` 会等在途的那一轮采集收尾。
    // 不等就关库的话，正在 await DWS 子进程（实测约 0.6s）的那一轮回来后
    // 会写到已关闭的连接上，抛出无人 catch 的
    // `The database connection is not open`（实测 logout 时稳定复现）。
    await this.ingest?.stop()
    await Promise.all([...this.sourceIngest.values()].map((source) => source.stop()))
    await Promise.all(this.sourceOptions().map((source) => source.feed.detach()))
    this.sourceIngest.clear()
    this.sourceDatabases.clear()
    this.sourceAttachments = []
    this.activeChannels.clear()
    this.ingest = null
    this.db = null
    this.dbPath = null
    this.feedDirs = null
    await this.options.feed.detach()
  }

  /** 当前 vault 的导出落点。未 attach 时抛错（那是接线漏了，不该静默兜底）。 */
  private requireFeedDirs(): FeedDirs {
    const dirs = this.feedDirs
    if (dirs === null) throw new AppError("DB_UNAVAILABLE", "尚未登录，导出目录未就绪")
    return dirs
  }

  /**
   * 读采集轮询周期（缺省 + 用户配置合并后的**生效值**）。
   *
   * 未登录时也返回缺省值而不是抛错：设置页在登录前也会渲染，
   * 而"读不到就显示空"会让用户以为配置丢了。
   */
  intervals(): IngestIntervalsView {
    const stored = this.db === null ? undefined : readIngestIntervals(this.db)
    return { ...INTERVAL_DEFAULTS, ...(stored ?? {}) }
  }

  /**
   * 保存采集轮询周期并**立刻生效**。
   *
   * ★ 为什么要重挂采集：周期是 `IngestService` 构造时读进去的
   * （`AdaptiveInterval` 与两个 setInterval 都在构造/start 时定型），
   * 只写库不重建的话用户会看到"保存成功但周期没变"——那正是配置项最容易
   * 出现的静默无效。所以写完库后原地 detach + attach 一次。
   *
   * 合并语义：`patch` 只覆盖给了的字段（改一项不该把其余擦回缺省）。
   */
  async intervalsSave(patch: IngestIntervalsPatch): Promise<IngestIntervalsView> {
    const db = this.db
    const dbPath = this.dbPath
    const sourceAttachments = [...this.sourceAttachments]
    if (db === null || dbPath === null) {
      throw new AppError("DB_UNAVAILABLE", "尚未登录，无法保存采集周期")
    }
    const next: IngestIntervalsView = { ...this.intervals(), ...pickDefined(patch) }
    db.prepare(
      `INSERT INTO dh_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = excluded.updated_at`,
    ).run("ingestIntervals", JSON.stringify(next), this.options.clock.now())
    for (const source of sourceAttachments) {
      source.db
        .prepare(
          `INSERT INTO dh_settings (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                            updated_at = excluded.updated_at`,
        )
        .run("ingestIntervals", JSON.stringify(next), this.options.clock.now())
    }

    this.options.logger.info("ingest intervals saved", { ...next })
    // 重挂让新周期生效（见方法注释）。attach 内部会先 detach。
    // ★ 两样都复用 attach 时记下的（见 feedDirs 与 sourceAttachments 的注释）：
    // 让调用方再传一次等于给了一个传错的机会，而传错不报错。
    await this.attach(db, dbPath, this.requireFeedDirs(), this.sourceAttachments)
    this.pushSnapshot()
    return next
  }

  /** 进程内的逐条订阅（数字人用）。vault 未挂载时返回 null。 */
  get events(): IngestService["events"] | null {
    return this.ingest?.events ?? null
  }

  snapshot(): IngestSnapshot {
    const ingest = this.snapshotIngest()
    if (ingest === null) {
      // 未登录时给一个"全零"快照而不是抛错：状态页在登录前也会渲染。
      return {
        running: false,
        channelId: this.options.plugin.meta.id,
        messages: 0,
        conversations: 0,
        unjudged: 0,
        outboxHead: 0,
        ftsIndexed: 0,
        ftsLag: 0,
        probeIntervalMs: 0,
        probeThrottled: false,
        lastError: null,
        blockedReason: null,
        failedAttempts: 0,
        // 未登录时"没配范围、没覆盖任何时间、也没有在跑的窗"。
        // ★ `started: false` —— 未登录当然还没开始采，不能让 UI 报"已完成"。
        backfill: {
          since: null,
          coveredFrom: null,
          remainingMs: 0,
          stalled: null,
          activeWindow: null,
          messages: 0,
          started: false,
        },
        selfConfirmed: false,
        /**
         * 未登录/未挂载 → `unbound`：那时既没有身份行，也不该去解析。
         * 给 `unresolved` 会让界面提示"点一下解析身份"，而实际要做的是先登录。
         */
        selfIdentityState: "unbound",
        mediaAssets: 0,
        minutes: 0,
        // 未登录时"还没跑过一轮"→ null。给 `drained: true` 会把未知说成没问题。
        minutesCoverage: null,
        storage: { mainBytes: 0, walBytes: 0, rawRecords: 0, rawPruned: 0, vectors: 0 },
        staleConsumers: [],
        eventStream: null,
      }
    }
    // 事件通路健康由 DataPlane 持有（长连接不在采集层）——覆盖 ingest 的 null。
    const health = ingest === this.ingest ? this.eventStream?.health() : undefined
    return {
      ...ingest.snapshot(),
      ...(this.perChannelSnapshot() ?? {}),
      eventStream:
        health === undefined
          ? null
          : {
              ...health,
              // 覆盖面：attach 后异步算好的那份（还没算完时为 null）。
              audit:
                this.eventAudit === null
                  ? null
                  : {
                      catalog: [...this.eventAudit.catalog],
                      globalKeys: [...this.eventAudit.globalKeys],
                      perConversationKeys: [...this.eventAudit.perConversationKeys],
                      activeSubscriptions: this.eventAudit.activeSubscriptions,
                      error: this.eventAudit.error,
                    },
            },
    }
  }

  /**
   * 手动跑一轮采集（状态页的「立即同步」）。
   *
   * ★ `channelId` 给了就**只跑那一个** —— 状态页现在按渠道分区展示，
   * 而那里的按钮就该只作用于用户正在看的那个渠道。不带的话用户在飞书
   * 那一栏点「立即同步」，跑的却是全部（含钉钉那 1600 条的一轮），
   * 而界面上看不出发生了什么。
   *
   * 不给 = 全部活跃渠道（存量行为）。
   */
  async runOnce(channelId?: string): Promise<{ changed: number; unchanged: number }> {
    const ingest = this.ingest
    const primaryId = this.options.plugin.meta.id
    const wanted = (id: string): boolean => channelId === undefined || channelId === id
    /**
     * ★★ 主渠道没挂时，**别的渠道照样要能同步**。
     *
     * 这里原来是 `if (this.ingest === null) return {0,0}` —— 一个提前返回，
     * 理由大概是"没登录就没什么可采"。但 `this.ingest` 只代表**主渠道**那一路：
     * 主渠道未挂（未登录 / 正在重挂 / 那个渠道没授权）时，给飞书点「立即同步」
     * 会**静默返回 0**，而飞书的管线明明挂着、能采。
     *
     * 表现是"点了没反应、也不报错" —— 与本仓库其他几处静默降级同一个形状。
     * 现在判据改成"这一次要采的那些源里有没有能跑的"。
     */
    const active = [
      ...(ingest !== null && this.activeChannels.has(primaryId) && wanted(primaryId)
        ? [ingest]
        : []),
      ...[...this.sourceIngest.entries()]
        .filter(([id]) => this.activeChannels.has(id) && wanted(id))
        .map(([, source]) => source),
    ]
    if (active.length === 0) return { changed: 0, unchanged: 0 }
    const results = await Promise.all(
      active.map(async (source) => {
        source.clearBackoff()
        await source.tickProbe()
        return source.tickPull()
      }),
    )
    const result = results.reduce(
      (total, current) => ({
        changed: total.changed + current.changed,
        unchanged: total.unchanged + current.unchanged,
      }),
      { changed: 0, unchanged: 0 },
    )
    this.pushSnapshot()
    return result
  }

  /** Start a secondary source immediately after its authorization succeeds. */
  activateChannel(channelId: string): void {
    if (channelId === this.options.plugin.meta.id) {
      this.ingest?.clearBlocked()
      this.ingest?.start(true)
      this.activeChannels.add(channelId)
      return
    }
    const source = this.sourceIngest.get(channelId)
    if (source === undefined) {
      throw new AppError("CHANNEL_UNSUPPORTED", `未知数据源：${channelId}`)
    }
    source.clearBlocked()
    source.start()
    this.activeChannels.add(channelId)
  }

  clearBlocked(): void {
    this.ingest?.clearBlocked()
    this.pushSnapshot()
  }

  /**
   * 系统睡眠 / 唤醒（由 `powerMonitor` 驱动，见 `IngestService.suspend`）。
   *
   * 未 attach（未登录）时静默 no-op —— 与这一层其它转发方法一致。
   * 不推快照：睡眠不改变库里的任何数字，而 `snapshot()` 有 9 个全表 COUNT。
   */
  suspendIngest(): void {
    this.ingest?.suspend()
  }

  resumeIngest(): void {
    this.ingest?.resume()
  }

  /**
   * 定向补拉一个会话（发送后 / 事件叫醒），并推快照让 UI 立刻刷新。
   *
   * ★ 为什么在数据面这一层暴露：`PersonaService` 不该依赖 `IngestService`
   * （现在依赖是单向的 DataPlane → persona，反过来会成环）。所以 persona
   * 发完消息只发一个**回调**，由 startup 接到这里 —— 数据面是唯一持有
   * ingest 句柄的地方。未 attach（未登录）时静默 no-op。
   *
   * @param options.reason `"self-sent"` = 我们自己刚发出一条，要秒级拉回来
   *   显示。它**绕过范围闸**（见 `IngestService.refreshConversation`）——
   *   事件叫醒那条路径不传，于是越界会话的事件收到了也不会去拉。
   */
  async refreshConversation(
    conversationExternalId: string,
    options: { reason?: "self-sent" } = {},
  ): Promise<void> {
    const ingest = this.ingest
    if (ingest === null) return
    const changed = await ingest.refreshConversation(conversationExternalId, options)
    // 只有真拉到新消息才推快照 —— 没变化时推一次是白刷（snapshot 有全表 COUNT）。
    if (changed > 0) this.pushSnapshot()
  }

  /**
   * 用户改了采集范围之后把库对齐到新范围（清越界 + 让回填重新往回挖）。
   *
   * 与 `refreshConversation` 同一个理由放在这一层：ingest 句柄只有数据面
   * 持有。未登录时返回 null（没库可对齐，不是错误 —— 设置页在登录前
   * 也可能被打开）。
   *
   * ★ 导出与建图**不在这里**触发：那是 `FeedService` 的职责。由装配层
   * （`startup.ts` 的 `distillSources.onScopeChanged`）在这之后接着调，
   * 否则 ingest/dataPlane 会反向依赖 feed 而成环。
   */
  /**
   * 清掉**某个渠道**越界的语料。
   *
   * ## ★★ `channelId` 决定动哪个库
   *
   * 这个方法原来只认主渠道（`this.ingest`），于是"在飞书面板改小范围"会去清
   * **主渠道**的越界消息 —— 而飞书那边一条都不清。两个后果都真实发生过：
   * 主渠道被误清（它的范围没变，那些消息本来是合规的），
   * 飞书的越界数据留着继续喂给图谱。
   *
   * ★ 那个渠道没在跑 → 返回 null（调用方按"没什么可清"处理）。
   * 不落回主渠道 —— 那正是上面那个 bug 的形状。
   */
  applyScopeChange(
    channelId: string = this.options.plugin.meta.id,
    options: { dryRun?: boolean } = {},
  ): PurgeReport | null {
    const source =
      channelId === this.options.plugin.meta.id
        ? this.ingest
        : (this.sourceIngest.get(channelId) ?? null)
    if (source === null) return null
    return source.applyScopeChange(options)
  }

  /**
   * 解析本人身份。
   *
   * **不自动确认**：解析可能有歧义（同名同姓返回多个 ID），
   * 而身份错了后面全错且不可逆。所以这里只给出候选，
   * 由用户在 UI 上核对「姓名 + 工号 + 已识别到 N 条本人消息」后确认。
   */
  async resolveSelf(channelId: string = this.options.plugin.meta.id): Promise<SelfIdentityView> {
    const db = this.database(channelId)
    const plugin = this.plugin(channelId)
    const identity = plugin.identity
    if (db === null) throw new AppError("DB_UNAVAILABLE", "尚未登录，无法解析身份")
    if (identity === undefined) {
      throw new AppError("CHANNEL_UNSUPPORTED", "该渠道不支持身份解析")
    }

    /**
     * ★ 注入「单聊交集」这条兜底判据（完整说明见 store 的
     * `inferSelfExternalIdFromDirectChats` 与 self-identity.ts 文件头 §5）。
     *
     * 为什么在这里注入而不是让插件自己查库：`channels`(L2) 不能依赖 `store`(L3)，
     * 而这条推断本质是一句 SQL。所以由这一层把结果喂进去。
     *
     * 它救的是"search 那条路失败"的场景 —— 从前那时只能弹窗要用户手动确认，
     * 而未确认期间蒸馏会拒掉**全部**语料。推不出来就返回 null，行为与从前一致。
     */
    const inferFromMessages = (): string | null => {
      const inference = inferSelfExternalIdFromDirectChats(db, this.options.plugin.meta.id)
      if (inference.ok) {
        this.options.logger.info("self openId inferred from direct chats", {
          directChats: inference.directChats,
        })
        return inference.externalId
      }
      // 推不出来是正常状态（库为空 / 单聊不足 / 交集不唯一）—— 记 debug 不记 warn。
      this.options.logger.debug("self openId inference unavailable", {
        reason: inference.reason,
        directChats: inference.directChats,
      })
      return null
    }

    // 抛出的 SELF_IDENTITY_AMBIGUOUS 直接透给 UI：
    // 「无法唯一确定」必须让用户看到，不能退回到"挑一个"。
    /**
     * ★ 记一笔"这次是不是歧义失败" —— 那个事实只在抛错的这一刻存在。
     *
     * 身份行压根没写成，所以事后从库里看，「同名多 ID」与「还没解析过」
     * 完全同形，而两者要给用户的引导相反（确认哪个是你 / 点一下解析）。
     * 界面据此分叉，见 `IngestSnapshot.selfIdentityState`。
     */
    let resolved: Awaited<ReturnType<typeof identity.resolveSelf>>
    try {
      resolved = await identity.resolveSelf({ inferFromMessages })
    } catch (error) {
      if (isAppError(error) && error.code === "SELF_IDENTITY_AMBIGUOUS") {
        this.ingest?.noteIdentityAmbiguous(true)
      }
      throw error
    }
    // 解析成功 → 清掉那一笔（否则用户修好之后界面还在说"同名歧义"）
    this.ingest?.noteIdentityAmbiguous(false)
    // 走的哪条路要可见：三条路的可靠性不同，出问题时第一个要问的就是这个。
    this.options.logger.info("self identity resolved", { source: resolved.source })
    const repository = new SelfIdentityRepository(db)
    repository.upsert({
      channelId: plugin.meta.id,
      userId: resolved.userId,
      openIds: resolved.openIds,
      displayNames: resolved.displayNames,
      corpId: resolved.corpId,
      corpName: resolved.corpName,
    })

    const stored = repository.get(plugin.meta.id)
    return {
      channelId: plugin.meta.id,
      userId: resolved.userId,
      openIds: resolved.openIds,
      displayNames: resolved.displayNames,
      corpName: resolved.corpName,
      corpId: resolved.corpId,
      matchedMessageCount: this.countSelfCandidates(
        db,
        resolved.openIds.map((id) => id.value),
      ),
      confirmed: stored?.confirmedAt !== null && stored?.confirmedAt !== undefined,
    }
  }

  /**
   * 读**已经解析过**的本人身份。不碰渠道。
   *
   * ## ★ 为什么需要它，而不是让界面调 `resolveSelf`
   *
   * `resolveSelf` 每次都**真调渠道**（子进程）并 upsert 一次，
   * 而且同名多 ID 时会抛 `SELF_IDENTITY_AMBIGUOUS` —— 那是个需要用户
   * 处理的错误。把它挂在界面上当"读一下花名"用有两个后果：
   * 每次渲染跑一次子进程调用，以及一个用户没触发的动作弹出歧义错误。
   *
   * 所以这个方法只读本地那一行。**没有那一行时返回 `null`**
   * （还没解析过是正常状态，不是错误）—— 调用方按"拿不到就不显示"处理。
   *
   * `matchedMessageCount` 仍然现算：它是"已识别到 N 条本人消息"，
   * 随采集推进而变，缓存它会显示一个过期数字。
   */
  readSelfIdentity(): SelfIdentityView | null {
    const db = this.db
    if (db === null) return null
    const channelId = this.options.plugin.meta.id
    const stored = new SelfIdentityRepository(db).get(channelId)
    if (stored === null) return null

    return {
      channelId,
      userId: stored.userId,
      openIds: [...stored.openIds],
      displayNames: [...stored.displayNames],
      corpName: stored.corpName,
      corpId: stored.corpId,
      matchedMessageCount: this.countSelfCandidates(
        db,
        stored.openIds.map((id) => id.value),
      ),
      confirmed: stored.confirmedAt !== null,
    }
  }

  /** 确认身份 → 回填历史消息的 is_self 与「@我」。 */
  confirmSelf(channelId: string = this.options.plugin.meta.id): {
    backfilled: number
    mentionsBackfilled: number
  } {
    const db = this.database(channelId)
    if (db === null) throw new AppError("DB_UNAVAILABLE", "尚未登录")
    const repository = new SelfIdentityRepository(db)
    const identity = repository.get(channelId)
    if (identity === null) {
      throw new AppError("SELF_IDENTITY_AMBIGUOUS", "尚未解析身份，无法确认")
    }

    repository.confirm(channelId, this.options.clock.now())
    const messages = new MessageRepository(db)
    const selfIds = identity.openIds.map((entry) => entry.value)
    const backfilled = messages.backfillSelf(channelId, selfIds)

    /**
     * ★ 「@我」也要回填，否则历史消息永远不会触发数字人。
     *
     * 「@我」的判定要拿 content 里的 `@真名(花名)` 与本人名字集合比对，
     * 而确认之前那个集合是空的 → 采到的历史消息一条 mention 都没落。
     * 不回填的话「@我」只对确认之后的新消息生效，而这个缺失是静默的
     * （表里就是没有那些行，看不出"本该有"）。
     */
    let mentionsBackfilled = 0
    const selfId = selfIds[0]
    if (selfId !== undefined && identity.displayNames.length > 0) {
      const selfNames = new Set(identity.displayNames)
      const hits: { messageId: string; selfExternalId: string }[] = []
      // 一次最多扫 5 万条：再多说明是超大回溯，下一次确认/重启会继续。
      for (const candidate of messages.listMentionBackfillCandidates(channelId, 50_000)) {
        if (mentionsSelf(extractMentionTexts(candidate.contentText), selfNames)) {
          hits.push({ messageId: candidate.id, selfExternalId: selfId })
        }
      }
      mentionsBackfilled = messages.backfillSelfMentions(hits)
    }

    /**
     * ★★ 顺手补齐单聊的会话名 —— 那个信息一直在库里，只是没人汇总。
     *
     * 飞书的单聊在渠道接口里**没有会话名**，而每条消息的
     * `sender_display_name` 有真名。判据是"这个单聊里 `is_self = 0` 的那个人"
     * —— 而 `is_self` 正是**上面这一步**刚回填好的，所以只能放在这里。
     *
     * 实测（本机）：飞书 4 个单聊全无名字，界面上只能显示 id 尾段
     * （`#2c78b681`），用户在采集范围里没法选。
     *
     * ★ 只补 `title IS NULL` 的行，渠道给的名字永远优先 —— 幂等，
     * 重复 confirm 不会改动已有名字。完整判据见
     * `ConversationRepository.backfillDirectTitlesFromSenders`。
     */
    const titlesBackfilled = new ConversationRepository(db).backfillDirectTitlesFromSenders(
      channelId,
    )

    this.options.logger.info("self identity confirmed", {
      channelId,
      backfilled,
      mentionsBackfilled,
      titlesBackfilled,
    })
    this.pushSnapshot()
    return { backfilled, mentionsBackfilled }
  }

  /**
   * 知识加工（Outbox → 图谱）的进度。
   *
   * ★ `channelId` 给了就读**那个渠道自己的** `FeedService` —— 每条采集管线
   * 有自己的库与自己的 Outbox 游标，所以"落后多少条"是渠道级的数字。
   *
   * 不带的话界面上会出现「飞书采了 8 条 · 知识加工落后 **11,309** 条」——
   * 那 11309 是钉钉的水位，与飞书毫无关系。实测就是这个形态。
   */
  feedInfo(channelId?: string): FeedInfo {
    if (channelId === undefined || channelId === this.options.plugin.meta.id) {
      return this.options.feed.info()
    }
    const source = this.sourceOptions().find((item) => item.plugin.meta.id === channelId)
    // 那个渠道没挂管线 → 落回主渠道（它是唯一能读的），而不是编一个 0
    return source === undefined ? this.options.feed.info() : source.feed.info()
  }

  export(): ExportResultView {
    const primary = this.options.feed.export()
    const results = [primary, ...this.sourceOptions().map((source) => source.feed.export())]
    return {
      sourceCount: results.reduce((sum, item) => sum + item.sourceCount, 0),
      totalMessages: results.reduce((sum, item) => sum + item.totalMessages, 0),
      totalMinutes: results.reduce((sum, item) => sum + item.totalMinutes, 0),
      totalDocuments: results.reduce((sum, item) => sum + item.totalDocuments, 0),
      headSeq: results.reduce((sum, item) => sum + item.headSeq, 0),
      exportDir: primary.exportDir,
    }
  }

  private plugin(channelId: string): ChannelPlugin {
    if (this.options.plugin.meta.id === channelId) return this.options.plugin
    const source = this.sourceOptions().find((item) => item.plugin.meta.id === channelId)
    if (source === undefined) throw new AppError("CHANNEL_UNSUPPORTED", `未知渠道：${channelId}`)
    return source.plugin
  }

  private database(channelId: string): SqliteDatabase | null {
    return channelId === this.options.plugin.meta.id
      ? this.db
      : (this.sourceDatabases.get(channelId) ?? null)
  }

  /**
   * 顶层快照读哪个 `IngestService`。
   *
   * ## ★★ 永远是**主渠道**（这一条是修一个真实的错位）
   *
   * 原来的实现是"主渠道没在跑就挑一个活跃的 source"。那在单渠道时无害，
   * 但多渠道之后它让**顶层快照的语义变成"某个不确定的渠道"** —— 而下游
   * （渲染层的 `?? snap.x` 兜底、`readIngest` 的问题判据）都假设顶层是主渠道。
   *
   * 实测的错位形态：主渠道重挂那一瞬间这里返回飞书的 ingest，于是顶层
   * 「已采集」变成 8，而用户选的是钉钉 —— 一个属于另一个渠道的数字，
   * 不报错。
   *
   * 逐渠道的数字走 `perChannel`（那才是它该在的地方）。顶层只回答
   * "主渠道怎么样"，未挂载时由 `snapshot()` 给全零 + `running:false`。
   */
  private snapshotIngest(): IngestService | null {
    return this.ingest
  }

  /**
   * 手动建图成功后把建图水位推到已导出水位（见
   * `FeedService.markGraphBuiltToExport`）。IPC 层在手动「同步」成功后调，
   * 否则 `graph-build` 游标停在 0、界面误报"消化了 0.0%"。
   */
  markGraphBuiltToExport(): boolean {
    return this.options.feed.markGraphBuiltToExport()
  }

  /**
   * 逐渠道的采集快照（`IngestSnapshot.perChannel`）。
   *
   * ★ 只在**真有多个渠道**时给：单渠道时顶层那一份就是全部，多带一份
   * 一样的数据只会让渲染层多一条要判空的分支。
   *
   * ★ 每个渠道各自 try/catch：一个渠道的库出问题不能让整份快照失败 ——
   * 那会让状态页整体空白，而它正是用来诊断这类问题的地方。
   */
  private perChannelSnapshot(): { perChannel: NonNullable<IngestSnapshot["perChannel"]> } | null {
    if (this.sourceIngest.size === 0) return null
    const rows: NonNullable<IngestSnapshot["perChannel"]> = []
    const primaryId = this.options.plugin.meta.id
    const collect = (channelId: string, source: IngestService): void => {
      try {
        const snap = source.snapshot()
        rows.push({
          channelId,
          running: this.activeChannels.has(channelId) && snap.running,
          messages: snap.messages,
          conversations: snap.conversations,
          mediaAssets: snap.mediaAssets,
          ftsIndexed: snap.ftsIndexed,
          ftsLag: snap.ftsLag,
          unjudged: snap.unjudged,
          outboxHead: snap.outboxHead,
          minutes: snap.minutes,
          probeIntervalMs: snap.probeIntervalMs,
          probeThrottled: snap.probeThrottled,
          selfConfirmed: snap.selfConfirmed,
          // ★ 渠道级的存储用量（各渠道一个物理库，见契约里 storage 那段注释）
          storage: snap.storage,
          lastError: snap.lastError,
          blockedReason: snap.blockedReason,
        })
      } catch (error) {
        rows.push({
          channelId,
          running: false,
          messages: 0,
          conversations: 0,
          mediaAssets: 0,
          ftsIndexed: 0,
          ftsLag: 0,
          unjudged: 0,
          outboxHead: 0,
          minutes: 0,
          probeIntervalMs: 0,
          probeThrottled: false,
          selfConfirmed: false,
          // 查不出来时给全 0，而不是省略 —— 省略会让渲染层逐字段兜底填上主渠道的值
          storage: { mainBytes: 0, walBytes: 0, rawRecords: 0, rawPruned: 0, vectors: 0 },
          lastError: error instanceof Error ? error.message : String(error),
          blockedReason: null,
        })
      }
    }
    /**
     * ★★ 主渠道那一行**必须**在，哪怕它的 `IngestService` 还没挂上。
     *
     * 原来是 `if (this.ingest !== null) collect(...)` —— 于是重挂那一瞬间
     * （`intervalsSave` / 范围变更都会 detach+attach）主渠道行**消失**，
     * 而渲染层"找不到那个渠道就落回顶层快照"，顶层在 ingest 为 null 时是
     * 一份**全零**快照 → 界面上「会话 0 · 消息 0」，而库里有 1674 条。
     *
     * 实测就是这个形态（用户截图：会话 0 / 消息 0，而实体 361、事实 719 正常
     * —— 因为那三个来自图库，不走这条路）。
     *
     * 挂载中给一行"0 但标记未在跑"比让它整行消失好：前者是一个可解释的
     * 中间态，后者会让下游落回一个语义完全不同的兜底值。
     */
    if (this.ingest !== null) collect(primaryId, this.ingest)
    else {
      rows.push({
        channelId: primaryId,
        running: false,
        messages: 0,
        conversations: 0,
        mediaAssets: 0,
        ftsIndexed: 0,
        ftsLag: 0,
        unjudged: 0,
        outboxHead: 0,
        minutes: 0,
        probeIntervalMs: 0,
        probeThrottled: false,
        selfConfirmed: false,
        // 同上：挂载中给 0，别让下游落回另一个渠道的体积
        storage: { mainBytes: 0, walBytes: 0, rawRecords: 0, rawPruned: 0, vectors: 0 },
        lastError: null,
        blockedReason: null,
      })
    }
    for (const [channelId, source] of this.sourceIngest) collect(channelId, source)
    return { perChannel: rows }
  }

  /** 按候选 ID 数一下语料里有多少条本人消息：给用户一个可核对的数字。 */
  private countSelfCandidates(db: SqliteDatabase, externalIds: readonly string[]): number {
    if (externalIds.length === 0) return 0
    const placeholders = externalIds.map(() => "?").join(",")
    return (
      db
        .prepare<
          string[],
          { c: number }
        >(`SELECT count(*) AS c FROM messages WHERE sender_external_id IN (${placeholders})`)
        .get(...externalIds)?.c ?? 0
    )
  }

  private pushSnapshot(): void {
    const window = this.options.getWindow()
    if (window === null || window.isDestroyed()) return
    // ingest 已卸载（logout / detach 竞态）时不查库：库可能已经关了。
    if (this.ingest === null) return
    this.lastPushAt = this.options.clock.now()
    window.webContents.send(IPC_EVENTS.ingestProgress, this.snapshot())
  }

  /**
   * 节流推送：首次立刻推，之后每 250ms 最多一次，尾部保证补一次。
   *
   * 「尾部补一次」是必需的：没有它的话最后一批的状态永远不会到 UI，
   * 表现为「采集完了但计数少了一批」—— 那种偏差用户会当成丢消息报上来。
   */
  private pushSnapshotThrottled(): void {
    if (this.pushTimer !== null) return
    const elapsed = this.options.clock.now() - this.lastPushAt
    if (elapsed >= SNAPSHOT_THROTTLE_MS) {
      this.pushSnapshot()
      return
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.pushSnapshot()
    }, SNAPSHOT_THROTTLE_MS - elapsed)
  }
}
