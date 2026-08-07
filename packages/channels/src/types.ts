/**
 * IM 渠道契约。
 *
 * 契约刻意做得薄：只约束「能力声明 + 授权 + 标准出入站」，不约束数据获取方式。
 * 钉钉用 CLI 拉、飞书用官方 SDK 长连、Telegram 用 Bot API webhook 都能塞进来。
 *
 * 本阶段只实现 auth 一段；pull / start / sendReply 等先定类型不实现，
 * 让后续补齐时不用改契约（也避免现在凭想象把签名定歪）。
 */
import type { Clock } from "@mycontext/kernel"

export type ChannelId = "dingtalk" | "feishu"

/**
 * 渠道元信息。
 *
 * 文案一律是 i18n key，不是文本：渠道插件跑在主进程，而语言是渲染层的状态，
 * 在插件里写死中文就等于让整条链路只支持一种语言。
 */
export interface ChannelMeta {
  id: ChannelId
  /** 渠道名的 i18n key，如 `channels:dingtalk.label` */
  labelKey: string
  descriptionKey: string
  /** 本阶段是否可用；false 时 UI 显示「暂未开放」 */
  available: boolean
}

export interface ChannelCapabilities {
  chatTypes: ("direct" | "group")[]
  /** 数据获取方式：宿主据此决定起轮询还是长连 */
  ingest: ("poll" | "push")[]
  /** 是否有廉价的「有无新消息」探针（有则宿主用两级轮询省开销） */
  changeProbe: boolean
  media: boolean
  /** 发送身份。钉钉本期只用 self */
  sendAs: ("self" | "bot")[]
  domains: ("chat" | "doc" | "minutes" | "contact")[]
}

// ---------------------------------------------------------------
// 授权
// ---------------------------------------------------------------

/**
 * 授权状态。
 *
 * 用判别联合而不是「一个大对象 + 一堆可选字段」：UI 里就不需要到处判空，
 * 且「未授权却读到了 corpName」这类矛盾状态在类型层面就不可能出现。
 */
export type AuthStatus =
  | { state: "unauthorized" }
  | {
      /** 有历史登录记录但 refresh token 已过期，需要重新扫码 */
      state: "expired"
      corpName?: string | undefined
      userName?: string | undefined
    }
  | {
      state: "authorized"
      corpId: string
      corpName: string
      userId: string
      userName: string
      /** access token 到期时间（DWS 会自动刷新，仅供展示） */
      accessExpiresAt: string | null
      /** refresh token 到期时间：到点必须重新扫码 */
      refreshExpiresAt: string | null
      /** 距 refresh 到期还有几天；UI 据此决定是否显示提醒 */
      daysUntilRefreshExpiry: number | null
    }

/** 授权方式。loopback 自动拉浏览器并回调；device 显示授权码手动输入。 */
export type AuthMode = "loopback" | "device"

/** 授权过程中推给 UI 的进度事件。 */
export type AuthProgress =
  | { phase: "starting" }
  /** loopback：拿到授权 URL（已自动打开浏览器，同时给用户手动兜底） */
  | { phase: "browser-opened"; url: string }
  /** OAuth 登录完成后，进入 DWS 的 PAT 推荐权限确认页。 */
  | { phase: "scope-authorization"; url: string }
  /** device：拿到授权码与验证页 */
  | { phase: "device-code"; userCode: string; verifyUrl: string; expiresInSeconds: number }
  | { phase: "waiting" }
  | { phase: "succeeded"; status: AuthStatus }
  /**
   * 失败带 i18n key 与原始细节。
   * `detail` 是外部 CLI 的原始输出（没有译文），作为插值参数交给 UI，
   * 这样两种语言下都看得到真正的原因。
   */
  | { phase: "failed"; messageKey: string; detail?: string }
  | { phase: "cancelled" }

export interface AuthContext {
  mode: AuthMode
  signal: AbortSignal
  onProgress: (progress: AuthProgress) => void
}

export interface ChannelAuth {
  /** 供 UI 展示的授权步骤说明的 i18n key（各渠道方式不同，由插件自己描述） */
  describeStepKeys(): string[]
  status(): Promise<AuthStatus>
  login(ctx: AuthContext): Promise<AuthStatus>
  /**
   * 退出授权。**渠道不支持时可省略**。
   *
   * ★ 为什么这是必需能力而不是"删掉配置目录就行"：token 的密钥在系统
   * 钥匙串里（钉钉实测），删目录之后 CLI 会从钥匙串重建一份 profiles，
   * `auth status` 照样返回已授权。所以"退出授权"只能由渠道自己做。
   *
   * 返回是否真的退出了（复查 status 得到的结论，不看 exit code）。
   * **不抛**：失败只降级成"凭据还在"，由调用方决定怎么呈现。
   */
  logout?(): Promise<boolean>
}

// ---------------------------------------------------------------
// 采集
// ---------------------------------------------------------------

/**
 * 探针结果：「哪些会话可能有新消息」。
 *
 * 刻意做得很薄（只有时间与未读数）：探针的价值在于**便宜**，
 * 一旦它开始返回正文就失去了存在意义（不如直接拉正文）。
 */
export interface ChannelProbeResult {
  conversations: {
    externalId: string
    lastMsgAt: number | null
    unreadCount: number | null
  }[]
  /** 缺席的已知会话可明确视为 unread=0。 */
  completeUnreadSnapshot?: boolean
}

/** 一页正文。时间已由插件归一成 unix ms —— 上层不该再碰时区。 */
export interface ChannelPullPage {
  conversations: ParsedConversationLike[]
  messages: ParsedMessageLike[]
  /**
   * 下一页游标。
   *
   * ⚠️ **非空不代表还有下一页** —— 实测钉钉 277 页里有 **276 页**
   * `hasMore: false` 却仍返回一个非空 `nextCursor`。
   * 只看游标翻页会永不终止，必须以 `hasMore` 为准（见下）。
   */
  nextCursor: string | null
  /**
   * 服务端明确告知的「还有下一页」。**这才是翻页的终止判据。**
   *
   * 渠道无此语义时由插件填 `nextCursor !== null`（退回间接信号）。
   */
  hasMore: boolean
  /** 本页消息条数（截断检测用） */
  itemCount: number
  /** 原始响应，进 raw_records 供重放 */
  rawPayload: string
  /**
   * 服务端**拒绝读取**的会话 external_id。渠道无此语义时省略。
   *
   * ★ 与「这个会话本页没消息」必须分开 —— 这是 CLAUDE.md 第 5 节那条
   * 硬规则：识别到就跳过，**明确记成「不可读」而不是「0 条」**。
   *
   * 实测来源：保密群在逐会话接口上硬拒（`server_error_code=1001`），
   * 但 `list-all` 会为同一个群返回十几条**伪消息** —— `content` 是那句
   * 拒绝提示，而 `sender`/`createTime`/`openMessageId` 是真实值。
   * 不识别的话它们会入库，于是界面显示「已采集 13 条」，
   * 把不可读伪装成已采集，同时把「谁在这个保密群里」记了下来。
   */
  refusedConversations?: string[]
  /**
   * 本页是因为**防御性分页上限**而停下的（服务端还说有下一页）。
   *
   * ## ★ 为什么必须与 `hasMore` 分开
   *
   * `hasMore=false` 有两种完全不同的含义：「真的抽干了」与「我们不再翻了」。
   * 合成一个的后果是上层把"只采了 20 页"记成"这个时间窗采完了"并推进水位
   * —— 剩下的消息永久丢失，而日志里一个错都没有。
   *
   * 与 `ChannelConversationList.truncated` 同一个角色：拿不全是事实，
   * 那就必须能表达出来。渠道没有这个语义时省略。
   */
  truncated?: boolean
}

/**
 * 中间形态。
 *
 * **这是渠道无关性的落点**：各渠道的原生差异（时间格式、ID 形态、
 * 引用字段叫什么）全部吸收在插件里，规范化层往下看不出数据来自哪个渠道。
 * 类型定义在这里而不是各插件内部，就是为了让这个契约是显式的。
 */
export interface ParsedMessageLike {
  externalId: string
  conversationExternalId: string
  /** 该渠道的**主** ID（飞书取 open_id）。is_self 判定只用它，不用显示名 */
  senderExternalId: string | null
  senderDisplayName: string | null
  contentText: string | null
  contentJson: string | null
  quotedExternalId: string | null
  sentAt: number
  mentions: { actorExternalId: string }[]
  /**
   * @ 到的**显示名**（真名与花名都收）。
   *
   * 与 `mentions`（ID）分开：显示名无法安全映射成 ID（同名同姓实测 6 个），
   * 上层只用它与**本人**已知名字集合比对。
   *
   * 可选：飞书等渠道的 @ 是结构化字段（有真 ID），没有"从文本抽显示名"
   * 这个环节。规范化层按 `?? []` 处理 —— 让新渠道不必为一个钉钉特有的
   * 解析产物填空数组。
   */
  mentionTexts?: string[]
  hasMedia: boolean
  /** 媒体元数据。一期只记 ID 不下载字节；渠道未实现时可省略。 */
  media?: ParsedMediaLike[]
}

/** 媒体元数据。`resourceKind` 决定二期用哪个命令下载。 */
export interface ParsedMediaLike {
  kind: "image" | "file" | "audio" | "video"
  resourceId: string
  resourceKind: string
  originalName: string | null
}

export interface ParsedConversationLike {
  externalId: string
  title: string | null
  type: "direct" | "group"
  memberCount: number | null
}

export interface ChannelPullSpec {
  /** 窗口起点（unix ms） */
  start: number
  /** 窗口终点（unix ms） */
  end: number
  /** 分页游标；首页传 null */
  cursor: string | null
  limit: number
  signal?: AbortSignal
}

/**
 * 定向拉某一个会话的近期消息（`chat message list`，按会话 + 时间方向）。
 *
 * ## 与 `pull`（`list-all`）的分工
 *
 * `pull` 是**全局时间窗**分页（一轮几百页），用于「把这段时间里所有会话
 * 的消息抽干」。而这个是**单会话**定向拉，用于两个"要立刻看见"的场景：
 * · 我们自己刚发出一条 → 秒级把它拉回来显示（否则要等下一轮 2 分钟的 `pull`）；
 * · 探针/事件说某个会话有更新 → 只补那一个，不必等全局轮询。
 *
 * `chat message list` 的目标三选一互斥：群用 `openConversationId`，
 * 单聊用对端 `openDingTalkId`（我们没有 userId）。
 *
 * ## ★★ 翻页靠 `since` 推进，**不是** cursor —— 这条命令没有 `--cursor`
 *
 * 实测 `dws chat message list --cursor <x>` 直接 `exit=3`：
 * `unknown flag: --cursor`（可用 flag 只有 direction/group/limit/
 * open-dingtalk-id/time/user）。响应里那个 `nextCursor` 字段**无处可传**，
 * 它只是个信息性的边界值。帮助文档写的翻页方式是
 * 「`hasMore=true` 时用结果中的边界 createTime 作为下次 `--time`」。
 *
 * 这与 `pull`（`list-all`）完全不同 —— 那条命令有真 `--cursor`，
 * 游标是 256 字符的字符串。两者混起来看会写出一个永远翻不动的循环：
 * 首版就是这样（`ChannelConversationPullSpec` 没有任何游标字段、
 * 唯一调用点是单次调用），于是定向拉**恒只取第一页**。
 * 实测一个群第一页 97 条、抽干 636 条。
 *
 * ## ★★ `direction` 与「退一秒重叠」
 *
 * 时间边界是 **exclusive**，而 `createTime` **只到秒**：
 * 实测以「本页最旧那一秒」当下一页 `--time` 时，该秒的其余消息
 * **永久丢失**（两种朴素推进法各丢 24 条，且丢的不是同一批）。
 * 所以调用方推进时必须往回让 `PAGE_OVERLAP_MS`，并靠
 * `openMessageId`/`payload_hash` 去重 —— 少了任一条都会静默丢消息。
 */
export interface ChannelConversationPullSpec {
  /** 群：openConversationId；单聊：对端 openDingTalkId。见 kind。 */
  target: { kind: "group"; openConversationId: string } | { kind: "direct"; peerOpenId: string }
  /**
   * 时间游标（unix ms）。语义随 `direction`：
   * · `newer`（默认）= 从这个时间点往**现在**拉；
   * · `older` = 从这个时间点往**更早**拉。
   *
   * 翻页就是把它推到本页的边界时间（往回让一秒，见文件头）。
   */
  since: number
  /**
   * 时间方向。默认 `newer`（增量补拉的语义）。
   *
   * 抽干一个会话要用 `older`：从窗上界往回翻，`hasMore=false` 才算到底。
   * 实测 `older` 的分页是干净的（12 页零重复、`hasMore` 诚实）。
   */
  direction?: "newer" | "older"
  limit: number
  signal?: AbortSignal
}

/** 采集能力。只实现读路径；发送是另一个接口（授权模型完全不同）。 */
export interface ChannelIngest {
  /** 廉价探针。渠道无此能力时返回 null，上层退化为纯定期轮询 */
  probe(signal?: AbortSignal): Promise<ChannelProbeResult | null>
  /** 拉一页正文（全局时间窗） */
  pull(spec: ChannelPullSpec): Promise<ChannelPullPage>
  /**
   * 定向拉单个会话的近期消息。渠道无此能力时可省略（上层退回等全局轮询）。
   * 返回形状与 `pull` 同（复用同一条落库路径）。
   */
  pullConversation?(spec: ChannelConversationPullSpec): Promise<ChannelPullPage>
}

/**
 * 会话列表能力。
 *
 * 与 `ChannelIngest.pull` 分开：那个按**时间窗**拉消息，
 * 这个拉的是"用户能看到哪些会话"（含从没采过消息的）——
 * 选蒸馏范围时需要后者，否则还没采过的群不会出现在选项里。
 */
export interface ChannelConversations {
  list(signal?: AbortSignal): Promise<ChannelConversationList>
}

/**
 * 实时事件推送能力（长连接）。**只当叫醒信号，不承载完整性。**
 *
 * ## 为什么是"叫醒"而不是"喂消息"
 *
 * 事件的解析路径与采集（`pull`/`pullConversation`）不同源，两个真源必然漂。
 * 所以事件只交出"哪个会话有动静"，正文永远走采集那条路 —— 这也意味着
 * **事件通路挂了不影响消息完整性**，只是"新消息要等下一轮轮询"而不是秒级。
 *
 * ## 健康状态必须能区分「起来了」与「真在投递」
 *
 * 钉钉实测：长连接会打 ready 且 state=connected，但可能**零投递**
 * （云端订阅没建成）。所以 `EventStreamHealth.state` 用 `delivering` 单独表示
 * "stdout 真收到过事件"，`ready` 只表示"本地 bus 起来了"。状态页据此区分
 * "正常"与"接通但零投递、正在靠轮询"。
 *
 * 渠道无此能力时整个字段省略（上层退化为纯轮询）。
 */
export interface ChannelEvents {
  /** 起长连接。幂等。 */
  start(): void
  /** 停长连接并退订（服务端订阅不清会泄漏）。 */
  stop(): Promise<void>
  /** 健康快照（状态页读）。 */
  health(): ChannelEventStreamHealth
  /**
   * 订阅面对账：这个账号的事件**覆盖面**有多大。
   *
   * ★ 与 `health()` 分开：那个说"通路通不通"，这个说"通了也只覆盖哪些会话"。
   * 钉钉的事件按 key 分两类：`at` 一个订阅覆盖全部群的「@我」，而单聊/指定群
   * 要**逐会话**订阅 —— 没订阅的会话只能靠轮询。两件事都摊开，用户才不会把
   * 「事件通路正常」误读成「所有消息都秒级到」。
   *
   * 失败**不抛**（这是可观测性，不是关键路径），用返回值里的 `error` 表达。
   */
  audit(): Promise<ChannelEventSubscriptionAudit>
}

/** 订阅面对账结果。见 `ChannelEvents.audit`。 */
export interface ChannelEventSubscriptionAudit {
  /** 可订阅的事件 key（目录）。 */
  catalog: readonly string[]
  /** 一个订阅即覆盖全部的 key（钉钉的 `at`）。 */
  globalKeys: readonly string[]
  /** 需要逐会话订阅的 key（钉钉的单聊/指定群）。 */
  perConversationKeys: readonly string[]
  /** 当前活跃订阅数。 */
  activeSubscriptions: number
  /** 读取失败原因；null = 成功。 */
  error: string | null
}

/** 事件通路健康状态。`delivering` 才是"真在投递"（见 ChannelEvents 注释）。 */
export type ChannelEventStreamState = "stopped" | "starting" | "ready" | "delivering" | "backoff"

export interface ChannelEventStreamHealth {
  state: ChannelEventStreamState
  /** 最近一次真正收到事件的时刻（unix ms）；null = 从没收到过。 */
  lastEventAt: number | null
  /** 累计去重后投递的事件数。0 且 state=ready 就是"接通但零投递"。 */
  delivered: number
  /** 连续重连次数（成功建连或收到事件后归零）。 */
  reconnects: number
}

/**
 * 事件叫醒信号。**只带去重键与会话 id**（正文不带 —— 事件不落库）。
 * 上层据 `conversationExternalId` 定向补拉那个会话。
 */
export interface ChannelEventSignal {
  eventId: string
  conversationExternalId: string
}

/**
 * 起事件 consumer 需要的注入。刻意只有两项：
 * · `clock` —— lastEventAt / 退避计时（渠道包内禁裸 Date.now）；
 * · `onSignal` —— 收到（去重后）事件时回调，上层在这里定向补拉。
 * runtime/processes/logger 是插件构造时就持有的，不从这里传。
 */
export interface ChannelEventsDeps {
  clock: Clock
  onSignal: (signal: ChannelEventSignal) => void
}

/**
 * 会话列表结果。
 *
 * 带 `truncated` 而不是裸数组：钉钉侧**没有**能全量列单聊的命令
 * （`list-all-conversations` 的 `--cursor` 实测无效、`--limit` 硬顶 100、
 * `hasMore` 恒 false —— 见 dingtalk/conversations.ts 文件头）。
 * 拿不全是事实，那就必须能表达出来 —— 否则 UI 只能说"这就是全部会话"，
 * 用户找不到某个群时会以为是我们没读到，而不是列表本来就有窗口。
 */
export interface ChannelConversationList {
  items: ChannelConversationItem[]
  /** 列表可能不完整（渠道分页能力不足）。UI 据此提示并提供手动输入 ID 的出口 */
  truncated: boolean
}

export interface ChannelConversationItem {
  externalId: string
  title: string | null
  kind: "direct" | "group"
  memberCount: number | null
  /** unix ms；渠道未提供时为 null */
  lastMessageAt: number | null
}

/** 一条听记（会议转写）的渠道无关形态。 */
export interface ParsedMinutesLike {
  externalId: string
  title: string | null
  /** unix ms */
  startedAt: number | null
  durationSec: number | null
  summaryText: string | null
  transcriptJson: string | null
  speakersJson: string | null
}

export interface ChannelMinutesPage {
  items: ParsedMinutesLike[]
  /** 下一页游标（钉钉侧 flag 实测是 `--cursor`） */
  nextToken: string | null
  hasMore: boolean
}

/**
 * 听记采集能力。
 *
 * 与 `ChannelIngest` 分开的理由见 dingtalk/minutes.ts 文件头：
 * 无水位语义、正文二次调用、变更频率低 —— 三点都与消息不同。
 */
export interface ChannelMinutes {
  list(spec?: {
    cursor?: string | null
    limit?: number
    /**
     * 时间下界 / 上界（unix ms）。**范围合规的落点**，不是优化。
     *
     * ★ 采集侧必须把用户在引导里选的范围传下来：不传的话抽干历史会把
     * 用户明确排除掉的时间段整段采回来（CLAUDE.md 第 5 节）。
     * `undefined`/`null` = 不限（用户没配过范围，或显式选了不限）。
     *
     * 渠道侧负责把它翻成自己的格式（钉钉要 ISO-8601 **带偏移**）。
     */
    since?: number | null
    until?: number | null
    signal?: AbortSignal
  }): Promise<{
    page: ChannelMinutesPage
    rawPayload: string
  }>
  /**
   * 取一场会议的正文（摘要 + 逐句转写）。
   *
   * ★ 实现必须**抽干转写的分页**（钉钉侧 `hasNext` + `--cursor`）。
   * 只取第一页的表现是"一场长会只有开头几分钟"，而那看起来像
   * "这场会就这么短"—— 又一个静默的数据缺失。
   */
  body(
    externalId: string,
    signal?: AbortSignal,
  ): Promise<{
    summaryText: string | null
    transcriptJson: string | null
    /**
     * 转写实际抽了几页。**恒 ≥ 1**（调用成功就至少跑了一页）。
     *
     * 与 `transcriptTruncated` 分开：这个是"抽了多少"，那个是"抽干了吗"。
     * 排查时第一个要问的是前者（1 页就完 vs 20 页还没完，成因完全不同）。
     */
    transcriptPages: number
    /**
     * 撞了实现自己的上限、**没有抽干**。
     *
     * ★ 必须能表达：不标注的话下游会把它当完整转写用，
     * 于是"这场会没提过 X"这类结论是错的（与 `ChannelDocuments.list`
     * 的 `truncated` 同一个理由）。
     */
    transcriptTruncated: boolean
    rawPayload: string
  }>
}

/**
 * 一篇文档的元信息 + 可选正文。**渠道无关形状**（与 `ParsedMessageLike` 同一个角色）。
 *
 * `contentText` 为 `null` 表示「没取到正文」，而不是「文档是空的」——
 * 与 `media_assets.path` 为 null 同一个口径：
 * 「有这个东西但没取到内容」必须与「没有这个东西」可区分。
 */
export interface ParsedDocumentLike {
  externalId: string
  /** 来源子域：钉钉是 `wiki`（知识库）/ `drive`（钉盘最近访问） */
  origin: string
  title: string | null
  /** 渠道侧的文档类型（钉钉：`ALIDOC` / `OTHER`…） */
  docType: string | null
  /** 文件后缀（决定这类文档能不能读到正文） */
  extension: string | null
  url: string | null
  /** 所属知识库/空间 id；没有归属时为 null */
  workspaceId: string | null
  /** unix ms；★ 取不到就 null，不要猜一个 now（下游按时间窗过滤会漏掉它） */
  updatedAt: number | null
  createdAt: number | null
  /** Markdown 正文；null = 没取到 */
  contentText: string | null
}

/**
 * 文档采集能力。
 *
 * ## ★ 为什么是独立能力而不是塞进 `ingest`
 *
 * 与听记同一个理由，而且更彻底：
 * · **没有时间窗语义** —— `drive recent` 按"最近访问"排序、`wiki node list`
 *   按目录树，两者都不接受 start/end。所以 `IngestScheduler` 那套
 *   「重叠窗口 + 水位」在这里没有对应物。
 * · **两个独立的枚举入口** —— 个人视角（drive）与团队视角（wiki），
 *   而 wiki 还要**递归**目录。这与"翻一页正文"完全不是同一种循环。
 * · **正文要二次调用** —— 列举只给 nodeId，正文得再调 `doc read`。
 *
 * ## ★ 为什么列举与读正文分成两个方法
 *
 * 因为「哪些文档存在」很便宜（一次调用几十条），而「正文」是**逐篇**一次
 * CLI 调用（实测 0.3-0.8s）。合成一个方法的话，一轮采集要串行几十次调用
 * 才返回 —— 而那期间采集锁被占着，消息侧收不到新消息。
 * 分开之后上层可以「先全量列元信息、每轮只补 N 篇正文」（与听记同款策略）。
 */
export interface ChannelDocuments {
  /**
   * 列文档元信息（不含正文）。一次返回一批，`hasMore` 为翻页判据。
   *
   * 实现可以聚合多个子域（钉钉把 drive + wiki 合成一条流），
   * 上层只看到"一批文档"。
   */
  list(spec?: { cursor?: string | null; limit?: number; signal?: AbortSignal }): Promise<{
    items: ParsedDocumentLike[]
    nextToken: string | null
    hasMore: boolean
    /**
     * 是否因为防御性上限而**截断**了（递归深度 / 单库节点数）。
     * ★ 必须能表达：截断不可见的话下游会把"只采了 500 篇"当成"一共 500 篇"。
     */
    truncated: boolean
    rawPayload: string
  }>
  /**
   * 取一篇文档的正文。取不到（这类文档没有 markdown / 权限 / 已删）时
   * `contentText` 为 null —— **不抛**，因为"某一篇取不到"是常态而非错误。
   */
  body(
    doc: Pick<ParsedDocumentLike, "externalId" | "extension">,
    signal?: AbortSignal,
  ): Promise<{ contentText: string | null; rawPayload: string | null }>
  /**
   * 哪些后缀**可能**读到正文（小写，不带点）。
   *
   * ## ★ 为什么这要进契约，而不是让采集侧硬编码
   *
   * 采集侧的正文队列有**每轮配额**（见 `DOCUMENTS_BODY_PER_ROUND`）。
   * 而表格 / 脑图 / 图片 / 快捷链接这些**永远**取不到正文，却与真文档
   * 混在同一个 `updated_at` 序里 —— 实测队首 8 篇有 2 篇是表格，
   * 也就是每轮配额被白占 40%，而且**每轮都是同样那几篇**
   * （取不到 → 仍是 null → 下一轮又排在前面）。
   *
   * 光靠 `body()` 内部跳过不够：那只是不发 CLI 调用，配额已经花掉了。
   * 要在**取队列的 SQL** 里就排除，而 SQL 在采集侧 ——
   * 于是渠道必须把这个集合说出来。
   *
   * 不给 = 不过滤（队列里什么都可能有，退回老行为）。
   */
  readableExtensions?: readonly string[]
}

/** 本人身份。**蒸馏正确性的地基**，见 self-identity 的实现注释。 */
export interface ChannelIdentity {
  /**
   * @param options.inferFromMessages 从**已采集的消息**反推本人标识的兜底判据。
   *   由上层注入而不是插件自己查库：`channels`(L2) 不能依赖 `store`(L3)。
   *   返回 `null` = 推不出来（正常状态，不是错误）。
   *   完整判据见 store 的 `inferSelfExternalIdFromDirectChats`。
   */
  resolveSelf(options?: {
    signal?: AbortSignal | undefined
    inferFromMessages?: (() => string | null) | undefined
  }): Promise<{
    userId: string
    openIds: { kind: string; value: string }[]
    displayNames: string[]
    corpId: string | null
    corpName: string | null
    /** 这次走的哪条路。只用于日志与诊断，不参与判定。 */
    source: "get-self" | "search" | "direct-chat-intersection"
  }>
}

// ---------------------------------------------------------------
// 头像
// ---------------------------------------------------------------

/**
 * 取不到头像的**渠道无关**原因。
 *
 * ## ★ 为什么这个枚举必须存在，而不能直接用钉钉那套
 *
 * 钉钉的原因是 `no_common_group` / `no_avatar_set` / `download_failed` /
 * `lookup_skipped` —— 其中「共同群」是一个**纯钉钉概念**：那条路是因为
 * 钉钉没有开放的用户头像接口，只能从共同群的成员详情里捞 `avatarMediaId`
 * （见 `plugins/dingtalk/avatar.ts` 文件头）。飞书有正经的头像字段，
 * 压根没有"共同群"这一步。把钉钉的词汇写进契约，等于让每个新渠道
 * 都要把自己的失败情形硬翻译成一个它没有的概念。
 *
 * ## 分四种而不是一种：**终态 vs 可重试**这条线必须留着
 *
 * 这不是为了好看。合成一个"失败"的后果是：每次打开页面都会对那些
 * **本来就没有头像**的人各重试一次，几十个人就是几十次子进程调用，
 * 而结果永远一样（这个坑在钉钉那边真实踩过，见 avatar.ts 文件头）。
 *
 * · `not_set` / `not_reachable` —— **终态**，重试没有意义；
 * · `not_attempted` / `failed`  —— **可重试**。
 *
 * ★ `not_attempted` 与 `not_reachable` 的区别尤其要保留：
 * "我们压根没去查"（缺定位所需的信息）不是"查了，拿不到这个人"。
 * 前者往往是**暂时**的——缺的那条信息可能只是还没采到。
 * 归成终态的后果是：信息后来齐了，头像却永久不再取。
 */
export type ChannelAvatarMiss =
  /** 对方没设头像。终态 —— 渠道自己也会显示文字头像 */
  | "not_set"
  /** 拿不到这个人（钉钉：没有共同群）。终态 */
  | "not_reachable"
  /** 缺少定位所需的信息，一次请求都没发出。**可重试** */
  | "not_attempted"
  /** 查了但失败（网络 / 下载）。**可重试** */
  | "failed"

export type ChannelAvatarResult =
  | {
      ok: true
      /** 落地后的本地文件绝对路径 */
      path: string
      /**
       * 渠道侧的内容标识（钉钉是 `avatarMediaId`）。
       *
       * 用途是**缓存失效**：换了头像这个值会变，宿主据此知道要重新下。
       * 不叫 `mediaId` 是因为那是钉钉的词——别的渠道可能给的是 URL 或 etag。
       */
      cacheKey: string
    }
  | { ok: false; reason: ChannelAvatarMiss; detail?: string }

export interface ChannelAvatarRequest {
  /** 目标的渠道主 ID（与 `ParsedMessageLike.senderExternalId` 同一体系） */
  externalId: string
  /**
   * 显示名（真名或花名）。
   *
   * 可选是因为**不是每个渠道都需要它**：钉钉靠它搜共同群（没有就查不了，
   * 那正是 `not_attempted` 的来源），而有正经头像接口的渠道会直接忽略。
   */
  displayName?: string | null
  /**
   * 已知的共同会话。传了通常能省一次搜索 —— 渠道可忽略。
   *
   * 调用方常常知道这个：我们是从某个会话的消息里看到这个人的，
   * 那个会话如果是群，它本身就是一个共同群。
   */
  viaConversationExternalId?: string | null
  /**
   * 落地目录。
   *
   * ★ 由**宿主**给，与 `mediaRunner` 同一个理由：路径是宿主的概念
   * （`<userData>/avatars`），渠道层不该知道文件系统布局。
   */
  outputDir: string
  signal?: AbortSignal
}

/**
 * 头像获取能力。
 *
 * ## ★ 没有 `ofSelf` 是刻意的
 *
 * "谁是本人"是**宿主**的知识（`SelfIdentityRepository` 里那一行），
 * 渠道层不该知道。宿主侧的 `MediaService.selfAvatar()` 负责
 * 「查出本人的 ID 与显示名 → 调 `ofUser`」这层编排。
 *
 * 放进契约的话，每个渠道都要重新实现一遍同样的编排，
 * 而它们读的是同一张表。
 */
export interface ChannelAvatars {
  /** 取一个人的头像。单聊对象、群成员、本人都走这一个入口 */
  ofUser(request: ChannelAvatarRequest): Promise<ChannelAvatarResult>
  /**
   * 取群/会话头像。
   *
   * 可选：**钉钉没有这个能力** —— `conversation-info` 不返回群头像，
   * 也没有"群 avatarMediaId"这种字段（见 avatar.ts 文件头）。
   * 未实现时调用方用首字母色块兜底，那也是钉钉自己的做法。
   */
  ofConversation?(request: ChannelAvatarRequest): Promise<ChannelAvatarResult>
}

// ---------------------------------------------------------------
// 插件
// ---------------------------------------------------------------

export interface ChannelPlugin {
  meta: ChannelMeta
  capabilities: ChannelCapabilities
  auth: ChannelAuth
  /**
   * 采集与身份。
   *
   * 可选是刻意的：飞书一期只有契约桩（无真实 API），
   * 而「渠道存在但还不能采集」是一个需要能表达的真实状态 ——
   * 用可选字段表达它，比让桩抛「未实现」要好（后者会让上层到处 try/catch）。
   */
  ingest?: ChannelIngest
  identity?: ChannelIdentity
  /**
   * 听记（会议转写）采集。
   *
   * 单独一个能力而不是塞进 `ingest`：它没有时间窗语义（不支持 start/end 过滤，
   * 只能全量列 + 翻页），正文还要二次调用 —— 与消息的「重叠窗口 + 水位」
   * 模型完全不同，硬塞进同一个接口会让两边都别扭。
   */
  minutes?: ChannelMinutes
  /**
   * 文档采集（知识库 wiki + 钉盘）。
   *
   * 单独一个能力而不是塞进 `ingest`：没有时间窗语义、有两个独立枚举入口
   * （其中一个要递归目录）、正文还要二次调用 —— 见 `ChannelDocuments` 注释。
   * 渠道无此能力时上层不采文档（`documents` 表留空且状态页明示）。
   */
  documents?: ChannelDocuments
  /** 会话列表（蒸馏源选择用）。渠道无此能力时上层退化为只用本地已采会话。 */
  conversations?: ChannelConversations
  /**
   * 实时事件推送（长连接叫醒信号）。渠道无此能力时上层退化为纯轮询。
   *
   * 是**工厂**而不是实例：它要在**登录之后**（有了会话上下文与回调）才起，
   * 而插件在登录前就装配好了。所以这里给一个"用 onSignal 造一个 consumer"
   * 的工厂，由数据面在 attach 时调用（见 DataPlaneService）。
   */
  events?: (deps: ChannelEventsDeps) => ChannelEvents
  /**
   * 头像获取。
   *
   * 与 `mediaRunner` 分开而不是让宿主自己拿 runner 去拼命令：
   * 「怎么才能拿到一个人的头像」是**渠道特有**的知识
   * （钉钉要经共同群绕三条命令，飞书直接有字段）。
   * 让宿主拼命令等于把那份知识漏到渠道层外面 —— 改动前就是这样：
   * `media.service.ts` 直接 import 了钉钉的 `fetchAvatar`。
   */
  avatars?: ChannelAvatars
  /**
   * 媒体下载（聊天里的图片、文件）。
   *
   * ★ 为什么这一项是"能跑命令"而不是一个高层接口：媒体下载**必须**
   * 指定落地路径，而路径是**宿主**的概念（`<userData>/media`）。
   * 包成 `downloadMedia(id)` 的话渠道层就要知道文件系统布局。
   *
   * 只透出 `json`/`run` 两个方法（都过白名单闸）——
   * 拿到它的人能跑的命令集合与我们自己完全一样，不多一条。
   */
  mediaRunner?: MediaRunner
}

/**
 * 媒体下载需要的最小能力：跑一条（白名单内的）命令。
 *
 * 用一个具名接口而不是 `Pick<DwsCli, …>`：后者会让 `types.ts`
 * （L0，纯类型）依赖 `cli.ts`（含 node:child_process），而那是分层反向。
 */
export interface MediaRunner {
  json<T>(args: readonly string[], options?: { signal?: AbortSignal }): Promise<T>
  run(
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
}
