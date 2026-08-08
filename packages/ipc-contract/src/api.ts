import type { Result } from "@mycontext/kernel"
import type {
  ChannelIdentity,
  ChannelIdentitySwitchInput,
  AdvancedAiConfigView,
  DwsSourceView,
  AuthSession,
  UpdateProfileInput,
  AuthStatus,
  BootstrapState,
  ChannelAuthProgressEvent,
  ChannelConversationListView,
  ChannelDataWipeResult,
  DistillProgressView,
  PersonaConversationView,
  PersonaDraftView,
  PersonaRuntimeLimits,
  ContactAvatarView,
  AvatarFetchResult,
  UploadedImageView,
  MediaSaveAsResult,
  MediaDownloadForMessagesResult,
  PersonaMessageView,
  PersonaRunView,
  PersonaActivityView,
  PersonaRunDetailView,
  PersonaMemberView,
  PersonaMessageHit,
  PersonaSnapshotView,
  PersonaTraceItem,
  PersonaTraceEvent,
  QuitDecision,
  DistillSourceId,
  DistillScopeInput,
  DistillSourceView,
  OnboardingStepId,
  OnboardingStepView,
  ChannelAuthStartInput,
  ChannelSummary,
  Credentials,
  ExportResultView,
  SearchSessionDetail,
  SearchSessionSummary,
  SearchStreamEvent,
  FeedInfo,
  IngestSnapshot,
  IngestIntervals,
  SaveIngestIntervalsInput,
  KlServerStatus,
  KlGraphBuildResult,
  KlGraphOverview,
  KlGraphOptimizeResult,
  KlGraphEgo,
  KlGraphFacts,
  KlGraphFactsInput,
  DashboardTrends,
  DashboardTrendsInput,
  LanguagePreference,
  RuntimeConfigView,
  SaveRuntimeConfigInput,
  RuntimeConfigApply,
  ProbeRuntimeConfigInput,
  RuntimeConfigProbe,
  SelfIdentityView,
  StatusReport,
} from "./contract.js"

/**
 * preload 暴露给 renderer 的 API 形状。
 *
 * main 侧的 handler 注册表与这里由同一组类型约束，
 * 因此少注册一个通道会在编译期报错，而不是运行时白屏。
 */
export interface MyContextApi {
  app: {
    bootstrapState(): Promise<Result<BootstrapState>>
    statusReport(): Promise<Result<StatusReport>>
    /**
     * 订阅"主进程在问要不要退出"。返回取消订阅函数。
     *
     * 收到后渲染层弹自己画的确认框；用户选完必须调 `quitDecision`
     * 回话，否则主进程会等到超时（见 quit-flow 的 DECISION_TIMEOUT_MS）
     * 后按"确认退出"处理。
     */
    onQuitRequested(listener: () => void): () => void
    /** 回话：用户在确认框里选了什么。 */
    quitDecision(input: QuitDecision): Promise<Result<true>>
    /**
     * 订阅"应用正在退出"事件。返回取消订阅函数。
     *
     * 收到后渲染层挂遮罩、锁死交互——之后不会再有事件更新，
     * dispose 跑完 Electron 会自己收尾进程。
     */
    onQuitting(listener: () => void): () => void
  }
  auth: {
    register(input: Credentials): Promise<Result<AuthSession>>
    login(input: Credentials): Promise<Result<AuthSession>>
    logout(): Promise<Result<true>>
  }
  channels: {
    list(): Promise<Result<ChannelSummary[]>>
    /** refresh 为 true 时跳过缓存，强制重新查询 */
    authStatus(input: { channelId: string; refresh?: boolean }): Promise<Result<AuthStatus>>
    authStart(input: ChannelAuthStartInput): Promise<Result<AuthStatus>>
    authCancel(input: { channelId: string }): Promise<Result<boolean>>
    /**
     * 订阅授权进度。返回取消订阅函数。
     * 只暴露具名订阅而不是整个 ipcRenderer，避免渲染层能监听任意通道。
     */
    onAuthProgress(listener: (event: ChannelAuthProgressEvent) => void): () => void
    /**
     * 本机是否有一份**可采纳**的渠道登录态（查询，无副作用）。
     *
     * dws 的登录态按系统用户共享（token 密钥在 Keychain，`DWS_CONFIG_DIR`
     * 隔离不了它），所以新注册的账号可能一进来就是"已授权" —— 而那份登录态
     * 属于这台机器，不属于这个账号：它的身份行、头像、显示名都还没落库。
     *
     * `null` = 没有可采纳的（这个账号已经有身份行，或本机确实未授权）。
     * 非 null 时界面给一个写明组织与账号的入口，由**用户决定**要不要采纳
     * —— 不自动采纳的理由见 `adoptExistingSession` 的注释（自动会替用户
     * 选定身份，之后他真去换组织时反被身份守卫拦住）。
     */
    adoptableSession(): Promise<Result<{ corpName: string; userName: string } | null>>
    /**
     * 采纳本机已有的登录态：落身份行 + 回填账号的头像与显示名。
     *
     * 幂等：已经有身份行时什么都不做并返回 false。
     */
    adoptSession(): Promise<Result<{ adopted: boolean }>>
    /**
     * 这个账号下的全部渠道身份（身份切换列表）。最近用过的在前。
     *
     * 未登录时返回空数组（那时没有账号，也就没有身份）。
     */
    identityList(): Promise<Result<ChannelIdentity[]>>
    /**
     * 切到另一个渠道身份。
     *
     * ★ 是个**重动作**：卸载当前 vault（停采集、卸 agent、停图谱服务）→
     * 挂载那个身份的。切完图谱要重付一次 warmup（实测冷启约 90s），
     * 所以界面要把"正在切换 / 正在准备图谱"表达出来，
     * 否则用户会以为数据丢了。
     *
     * 幂等：切到当前身份直接返回（不白付一次卸载+挂载）。
     */
    identitySwitch(input: ChannelIdentitySwitchInput): Promise<Result<{ switched: boolean }>>
    /**
     * 会话列表（蒸馏范围选择用）。
     *
     * 走渠道 CLI 拿"全部能看到的会话"并与本地已采信息合并 ——
     * 只读本地表会漏掉"还没采过的群"，而那可能正是用户想蒸馏的。
     */
    conversations(): Promise<Result<ChannelConversationListView>>
    /**
     * 清空当前渠道的数据 —— 把这个渠道身份**整个归零**（**不可逆**）。
     *
     * 删掉整个 vault 目录（语料、索引、图谱、画像产物、下载的媒体、
     * **渠道凭据**）并解除身份映射。也就是说清完之后：退出已授权、
     * 学习范围为空、本人身份未确认、数字人身份没了 —— 下次要重新授权、
     * 重新确认身份、重新选范围、重新建数字人。
     *
     * 完整理由（为什么是删目录而不是逐表清）见主进程
     * `ChannelDataWipeService` 的文件头。
     *
     * ★ `dryRun` 默认 **true**：这个动作删的是真实聊天记录，
     * 契约层就偏向安全的那一侧。UI 应当先预演、把数字给用户看、再确认。
     */
    dataWipe(input?: { dryRun?: boolean }): Promise<Result<ChannelDataWipeResult>>
  }
  onboarding: {
    complete(): Promise<Result<true>>
    skip(): Promise<Result<true>>
    /** 四步进度。引导页据此决定停在哪步、回填哪些表单 */
    steps(): Promise<Result<OnboardingStepView[]>>
    stepDone(input: { step: OnboardingStepId; payload?: unknown }): Promise<Result<true>>
    stepSkip(input: { step: OnboardingStepId }): Promise<Result<true>>
    /** 重走引导（设置页入口）。各步 payload 保留，只清状态 */
    restart(): Promise<Result<true>>
  }
  distill: {
    sources(): Promise<Result<DistillSourceView[]>>
    sourceSave(input: {
      kind: DistillSourceId
      enabled: boolean
      scope: DistillScopeInput
      /**
       * 其余渠道各自的会话白名单。`scope.conversationIds` 是**主渠道**那份。
       *
       * ★ 必须分开：白名单存的是 external_id，而各渠道的 id 体系不同 ——
       * 复制过去等于按一批不存在的 id 过滤，结果恒为零（见契约里的注释）。
       */
      perChannelConversationIds?: Record<string, string[]>
    }): Promise<Result<true>>
    /** 清某个源的蒸馏水位 —— 下一轮从头再蒸（facet 幂等合并，不删已有结论） */
    sourceReset(input: { kind: DistillSourceId }): Promise<Result<true>>
    /** 蒸馏进度（引导页第 4 步与设置页都读它） */
    progress(): Promise<Result<DistillProgressView>>
    /** 切窗入队并开始跑。幂等：重复调用不产生重复任务 */
    start(input: {
      days?: number | null
      windowDays?: number
    }): Promise<Result<DistillProgressView>>
    /** 重来一遍（清任务与水位，**不删已有结论**） */
    reset(): Promise<Result<DistillProgressView>>
    /** 订阅进度推送。返回取消订阅函数 */
    onProgress(listener: (progress: DistillProgressView) => void): () => void
  }
  persona: {
    snapshot(): Promise<Result<PersonaSnapshotView>>
    /** 会话列表（含回复模式、触发条件与「待处理」数 —— 新消息提醒用后者） */
    conversations(): Promise<Result<PersonaConversationView[]>>
    configSave(input: {
      conversationId: string
      replyMode?: "auto" | "draft" | "yolo"
      triggerMode?: "none" | "all" | "mention" | "keyword"
      keywords?: string[]
      personaNote?: string | null
    }): Promise<Result<true>>
    /** 管控层运行参数（LRU / 并发 / 批次上限） */
    limits(): Promise<Result<PersonaRuntimeLimits>>
    limitsSave(input: Partial<PersonaRuntimeLimits>): Promise<Result<PersonaRuntimeLimits>>
    /** 会话消息（可视化）。带 mentionsSelf 供高亮 */
    messages(input: {
      conversationId: string
      limit?: number
      /**
       * 额外必须包含的消息 id（草稿的 citations）。
       *
       * 引用的消息往往比"最近 N 条"更早 —— 不带这个的话
       * 点「看引用」会没有任何反应（那条消息不在列表里）。
       */
      includeIds?: string[]
    }): Promise<Result<PersonaMessageView[]>>
    drafts(): Promise<Result<PersonaDraftView[]>>
    /**
     * 处理草稿。
     *
     * `delivered` 为 false 表示**只标了状态、没真的发** ——
     * 真发要过外部强制的授权层，那个入口还没有。UI 必须据此明示，
     * 不能让用户以为点了就发出去了。
     */
    /**
     * 发送或丢弃一条草稿。
     *
     * ★ `action: "send"` 现在是**真发**（走 `SendGuard` 四层）。
     * `delivered` 为 false 时 `reason` 说明为什么没发出去
     * （`grant_missing` / `rate_limited` / 网关失败…）—— UI 要显示它，
     * 否则用户只看到"点了没发"而不知道该做什么。
     */
    draftResolve(input: {
      draftId: string
      action: "send" | "discard"
      editedText?: string | undefined
    }): Promise<Result<{ ok: boolean; delivered: boolean; reason?: string }>>
    /**
     * 用户自己写一条直接发（回复区的输入框）。
     *
     * 与 draftResolve 分开：那个处置的是已存在的草稿。这条仍然走同一个
     * SendGuard（停摆/授权/频率三道闸对"用户自己发的"同样有效），
     * 见 PersonaService.composeSend 的注释。
     */
    composeSend(input: {
      conversationId: string
      text: string
    }): Promise<Result<{ ok: boolean; delivered: boolean; reason?: string }>>
    runs(input: { conversationId: string }): Promise<Result<PersonaRunView[]>>
    /** 回看某一轮的 agent 过程（thinking / 正文 / tool 调用）。没有痕迹时返回空数组 */
    runTrace(input: { runId: string }): Promise<Result<PersonaTraceItem[]>>
    /**
     * 那一轮的**元信息**：触发消息 / 判定与原因 / 耗时与 token。
     *
     * ★ 与 `runTrace` 分开而不是合成一个"详情"：那条给过程、这条给结论，
     * 而过程可能很长（要滚动）而结论只有三行 —— 合并会让"我只想知道
     * 为什么只出草稿"也得等整段 trace 传过来。
     *
     * `null` = 这个 runId 查不到（老库 / 已被清理）。
     */
    runDetail(input: { runId: string }): Promise<Result<PersonaRunDetailView | null>>
    /**
     * 取某个会话**当前正在生成**的那一轮 trace 快照（含未完成）。
     *
     * ★ 为什么需要它：`onTrace` 是纯增量流，会话切走再回来时订阅是从零开始的，
     * 生成中途的内容就丢了（用户报的"起草中的消息没持久化，下次查看就看不到"）。
     * 挂载时先拉一次这个快照，把"到目前为止"补齐，再接增量。
     * 没有正在生成的轮次时返回 `{ items: [], done: true }`。
     */
    liveTrace(input: {
      conversationId: string
    }): Promise<Result<{ items: PersonaTraceItem[]; done: boolean }>>
    /**
     * 订阅 agent 过程的流式推送（正在处理那一轮）。返回取消订阅函数。
     *
     * ★ 与 `onSnapshot` 分开：那个是低频的状态快照（有 9 个全表 COUNT，
     * 被节流），这个是 token 级的流。合在一起会把快照的开销乘几十倍。
     */
    onTrace(listener: (event: PersonaTraceEvent) => void): () => void
    /** 当前会话中已成功发生的自动发送与用户采纳结果 */
    activities(input: { conversationId: string }): Promise<Result<PersonaActivityView[]>>
    /** 群成员（发过言的人）——会话设置弹窗的成员列表 */
    members(input: { conversationId: string }): Promise<Result<PersonaMemberView[]>>
    /** 会话内 like 搜索聊天记录，命中项带 id 供精确跳转 */
    searchMessages(input: {
      conversationId: string
      query: string
      limit?: number
    }): Promise<Result<PersonaMessageHit[]>>
    /** 全局停摆开关。用户发现说错话时的第一反应，必须立刻生效 */
    killSwitch(input: { active: boolean }): Promise<Result<true>>
    /** 手动跑一轮调度（"立即处理"按钮） */
    tick(): Promise<Result<{ dispatched: number; skippedBusy: number }>>
    onSnapshot(listener: (snapshot: PersonaSnapshotView) => void): () => void
  }
  media: {
    /**
     * 下载一个媒体资源。幂等 —— 已经下过直接返回路径。
     *
     * `ok: false` 时 `detail` 是给人看的原因（钉盘文件还没接、
     * 缺平台 id、命令失败），不是给机器判定的。
     */
    download(input: {
      mediaId: string
    }): Promise<Result<{ ok: boolean; path?: string; detail?: string }>>
    /**
     * 把这些消息上挂的媒体一次下完（打开会话时自动调，不用用户点）。
     *
     * 只返回计数，**不返回路径** —— 拿到结果后重查一次消息，
     * 路径会随消息回来。两条路各送一份同样的数据必然会不一致。
     */
    downloadForMessages(input: {
      messageIds: readonly string[]
    }): Promise<Result<MediaDownloadForMessagesResult>>
    /**
     * 批量读头像缓存。**快、且不会因渠道抖动失败。**
     *
     * ★ 只读缓存：不起子进程、不碰网络。想去取用 `avatarsFetch`。
     * 两者分开是这条链路稳定性的关键 —— 合在一起时一个人的 CLI 超时
     * 会让整批返回 failure，于是一屏头像全部退回首字母（包括早就取到的）。
     *
     * 返回的每一项带 `needsFetch`，调用方据此决定要不要调 `avatarsFetch`。
     */
    avatars(input: {
      externalIds: string[]
      groupExternalId?: string | null
      nickByExternalId?: Readonly<Record<string, string>>
    }): Promise<Result<ContactAvatarView[]>>
    /**
     * 去取还没取到的头像。**慢**（每人 2-3 次 CLI 调用），每人独立成败。
     *
     * 只返回计数 —— 路径由重读 `avatars` 拿（同一份数据不从两条路送）。
     */
    avatarsFetch(input: {
      externalIds: string[]
      groupExternalId?: string | null
      nickByExternalId?: Readonly<Record<string, string>>
    }): Promise<Result<AvatarFetchResult>>
    /**
     * 存一张本地图片（数字人形象 / 用户头像）。
     *
     * ★ 传 base64 而不是路径：渲染层拿到的 `File` 没有真实路径
     * （Electron 21+ 移除了 `File.path`），而即便有，也不该让渲染层
     * 直接往 userData 写。主进程按**魔术字节**校验类型后落盘。
     */
    uploadImage(input: {
      base64: string
      purpose: "figure" | "avatar"
    }): Promise<Result<UploadedImageView>>
    /**
     * 把一个已下载的媒体另存为到用户选的位置（系统保存对话框）。
     *
     * ★ 只收 `mediaId`：让渲染层传路径等于开一个任意文件读取的口子
     * （群聊正文是不可信输入，渲染层可能被注入）。
     *
     * 用户点「取消」时返回 `{ saved: false }` —— 那不是错误。
     */
    saveAs(input: { mediaId: string }): Promise<Result<MediaSaveAsResult>>
    /**
     * 取**本人**头像并回填账号。
     *
     * ★ 本人的头像也只能走"共同群的成员详情"那条路：
     * `contact user get-self` / `user search` 的返回里**都没有头像字段**
     * （逐条查过 reference）。好在本人必然在自己所在的每个群里，
     * 所以共同群一定找得到。
     *
     * `written: false` 表示取到了但**没写账号** —— 用户手动设过头像，
     * 而 manual 永不被渠道覆盖。
     */
    selfAvatar(): Promise<Result<{ path: string | null; reason: string | null; written?: boolean }>>
  }
  preferences: {
    /** 持久化语言偏好。`system` 表示跟随系统。 */
    setLanguage(input: { language: LanguagePreference }): Promise<Result<true>>
    /**
     * 退出前是否**不**再弹确认框。true = 不再问；false = 恢复提醒。
     *
     * 反悔路径：用户在设置里手动打开开关。
     */
    setQuitConfirmSuppressed(input: { suppressed: boolean }): Promise<Result<true>>
    /**
     * 开/关工作层抽取（LLM 抽职责/流程/经验 → skill 包里的 `work.md`）。
     *
     * ★ 打开这个开关会开始**花钱**：每轮蒸馏对四个维度各发一次请求，
     * 每次上万 token。所以它默认关，且只能由用户显式打开。
     */
    setWorkLayerEnabled(input: { enabled: boolean }): Promise<Result<true>>
  }
  profile: {
    /**
     * 改显示名 / 头像。返回更新后的会话（UI 直接替换本地状态，不用再查一次）。
     *
     * 改头像会把来源标成 `manual` —— 之后渠道授权不再覆盖它。
     */
    update(input: UpdateProfileInput): Promise<Result<AuthSession>>
  }
  ingest: {
    snapshot(): Promise<Result<IngestSnapshot>>
    /** 手动触发一轮采集（状态页的「立即同步」按钮） */
    runOnce(input?: { channelId?: string }): Promise<Result<{ changed: number; unchanged: number }>>
    /** 用户处理完终态（重新扫码 / 完成授权）后清除 blocked */
    clearBlocked(): Promise<Result<true>>
    /** 解析本人身份（歧义时返回失败，由 UI 引导手动确认） */
    resolveSelf(): Promise<Result<SelfIdentityView>>
    /**
     * 确认本人身份并回填历史消息。
     *
     * 回填两件事：`is_self`（含 direction）与「@我」——
     * 后者不回填的话历史消息永远不会触发数字人（见 data-plane 的实现注释）。
     */
    confirmSelf(): Promise<Result<{ backfilled: number; mentionsBackfilled: number }>>
    /**
     * 读**已经解析过**的本人身份。
     *
     * ★ 与 `resolveSelf` 的区别是它**不碰渠道**：只读本地那一行，
     * 所以可以给界面当普通查询用（`resolveSelf` 每次都跑子进程调用，
     * 且同名多 ID 时会抛歧义错误 —— 那不该被"顺手显示个花名"触发）。
     *
     * 还没解析过时返回 `null`，那是正常状态而不是错误。
     */
    readSelf(): Promise<Result<SelfIdentityView | null>>
    /**
     * 读采集轮询周期。
     *
     * ★ `probeBaseMs` 是**基础**周期，探针会自适应降频（见
     * `ingestIntervalsSchema` 的注释）—— UI 上要说清，否则"设了 10s 看到 20s"
     * 会被当成没生效。
     */
    intervals(): Promise<Result<IngestIntervals>>
    /** 保存采集轮询周期（全字段可选，改一项不擦其余）。返回合并后的完整值。 */
    intervalsSave(input: SaveIngestIntervalsInput): Promise<Result<IngestIntervals>>
    /** 订阅采集状态变化。返回取消订阅函数。 */
    onProgress(listener: (snapshot: IngestSnapshot) => void): () => void
  }
  pipeline: {
    /** Feed 接口信息（给算法团队联调用） */
    feedInfo(input?: { channelId?: string }): Promise<Result<FeedInfo>>
    /** 物化导出（全量快照） */
    export(): Promise<Result<ExportResultView>>
  }
  search: {
    /** 侧栏列表（不含消息内容） */
    sessionList(): Promise<Result<SearchSessionSummary[]>>
    sessionDetail(input: { sessionId: string }): Promise<Result<SearchSessionDetail>>
    /** 建会话。用首个查询生成标题 */
    /**
     * 建会话。`scope` = 检索档位（去问哪几个渠道的图谱）。
     * 不给 = 主渠道 —— 见 `createSearchSessionInputSchema` 里为什么缺省
     * 不能是 `all`。
     */
    sessionCreate(input: {
      query: string
      scope?: string
    }): Promise<Result<SearchSessionSummary>>
    sessionRename(input: { sessionId: string; title: string }): Promise<Result<true>>
    sessionPin(input: { sessionId: string; pinned: boolean }): Promise<Result<true>>
    sessionDelete(input: { sessionId: string }): Promise<Result<true>>
    prompt(input: { sessionId: string; query: string }): Promise<Result<true>>
    cancel(input: { sessionId: string }): Promise<Result<true>>
    /** 订阅流式输出。返回取消订阅函数。 */
    onStream(listener: (event: SearchStreamEvent) => void): () => void
  }
  kl: {
    /** 当前 kl-server 状态快照 */
    serverStatus(): Promise<Result<KlServerStatus>>
    /** 懒启动（若未起）；返回是否 ready */
    serverStart(input?: { channelId?: string }): Promise<Result<boolean>>
    /** 停止 kl-server（无孤儿） */
    serverStop(input?: { channelId?: string }): Promise<Result<true>>
    /** 触发建图（export→ingest，长任务、出网）。跑完返回图规模；期间 server 会重载。 */
    graphBuild(fresh?: boolean, channelId?: string): Promise<Result<KlGraphBuildResult>>
    /**
     * 图谱概览（规模 + 类型分布 + 枢纽实体 + 最近事实）。
     *
     * 建图**期间**也能调：它读的是本机 SQLite，不经 kl 的 HTTP
     * （那时 server 在忙，`/entity` 实测直接 500）。
     */
    graphOverview(input?: { channelId?: string }): Promise<Result<KlGraphOverview>>
    /**
     * 以「我」为中心的关系子图（ego graph）。
     *
     * 只取一跳邻居 + 他们之间的边 —— 全图 2170 个节点是一团毛线，
     * 而"我周围"才是这一页要回答的问题。关系由**同一条 fact 里共现**
     * 推导（图里几乎没有 entity↔entity 边）。
     */
    graphEgo(input?: { channelId?: string }): Promise<Result<KlGraphEgo>>
    /**
     * 带过滤的事实检索（时间范围 / 类型 / 实体 / 关键词）。
     *
     * 图里有 6663 条事实、跨一整月 —— "最近 12 条"回答不了
     * "上周关于沙箱的决策有哪些"这类问题，所以这一页需要真正的检索。
     */
    graphFacts(input: KlGraphFactsInput): Promise<Result<KlGraphFacts>>
    /** 优化图谱（kl improve，periodic：SIMILAR_TO 边 + 消歧 + 社群）。出网烧 LLM。
     * 是 `kl entity`/`community` 查询可用的前提（建 community_L* 列）。 */
    graphOptimize(channelId?: string): Promise<Result<KlGraphOptimizeResult>>
    /** 订阅状态变化。返回取消订阅函数。 */
    onStatus(listener: (status: KlServerStatus) => void): () => void
  }
  dashboard: {
    /**
     * 时序（按天分桶）+ 消化漏斗 + 覆盖度。
     *
     * ★ 与 `ingest.snapshot()` **分开**的通道：分桶实测 108ms
     * （本机 32,878 行），而快照是每批采集都发的热路径。
     * 主进程侧按 changelog head 缓存 —— head 没动就是上次那份。
     */
    trends(input: DashboardTrendsInput): Promise<Result<DashboardTrends>>
  }
  advancedAi: {
    /** 读配置。apiKey 只回后 4 位 */
    read(): Promise<Result<AdvancedAiConfigView>>
    save(input: {
      baseUrl: string
      apiKey: string | null
      modelRoles: Record<string, string>
      harness: Record<string, string>
      rawConfigJson: string | null
    }): Promise<Result<true>>
  }
  /**
   * 自备 dws 可执行文件的路径。
   *
   * 随包分发的是**开源版**（npm 依赖）；闭源版不随仓库分发，只能由用户
   * 自己装好再指路径。**兜底永远是随包那份** —— 路径失效时自动退回，
   * 而不是让渠道整个不可用。
   */
  dwsSource: {
    read(): Promise<Result<DwsSourceView>>
    /**
     * 两项独立：字段缺省 = 不改，`null`/空串 = 清除。
     *
     * 路径会被**真跑一次** `--version` 验证，跑不起来就拒绝并说明原因。
     * 渠道号只校验格式 —— 它有效与否只有服务端在授权时才知道。
     */
    save(input: {
      path?: string | null | undefined
      channelCode?: string | null | undefined
    }): Promise<Result<DwsSourceView>>
  }
  /**
   * 模型网关配置（用户可见，单一真源）。设置面板、onboarding 第 2 步、
   * 以及隐藏高级面板的 baseUrl/apiKey 都走这里。
   */
  runtimeConfig: {
    /** 读配置视图。apiKey 只回「是否已配置」+ 后 4 位 */
    read(): Promise<Result<RuntimeConfigView>>
    /** 保存。返回哪些消费点已即时生效、哪些要重启子进程 */
    save(input: SaveRuntimeConfigInput): Promise<Result<RuntimeConfigApply>>
    /** 探测网关：验证连通性并拉回模型列表（用草稿值，不必先保存） */
    probe(input: ProbeRuntimeConfigInput): Promise<Result<RuntimeConfigProbe>>
    /** 订阅配置变化。返回取消订阅函数 */
    onChanged(listener: () => void): () => void
  }
}

declare global {
  interface Window {
    mycontext: MyContextApi
  }
}
