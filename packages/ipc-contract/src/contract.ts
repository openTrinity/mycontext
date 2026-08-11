/**
 * renderer ↔ main 的唯一契约。
 *
 * 通道名、入参 schema、返回类型都定义在这里；两侧只依赖本包，
 * 因此新增能力时「忘记改另一侧」会在编译期暴露。
 *
 * 约定：所有 handler 返回 Result<T>（不抛异常跨进程），
 * 入参在 main 侧用这里的 schema 校验后才进业务。
 */
import { z } from "zod"

// ---------------------------------------------------------------
// 通道名
// ---------------------------------------------------------------

export const IPC_CHANNELS = {
  bootstrapState: "mycontext:app/bootstrap-state",
  statusReport: "mycontext:app/status-report",
  register: "mycontext:auth/register",
  login: "mycontext:auth/login",
  logout: "mycontext:auth/logout",
  // IM 渠道授权
  channelList: "mycontext:channel/list",
  channelAuthStatus: "mycontext:channel/auth-status",
  channelAuthStart: "mycontext:channel/auth-start",
  channelAuthCancel: "mycontext:channel/auth-cancel",
  // Onboarding
  onboardingComplete: "mycontext:onboarding/complete",
  onboardingSkip: "mycontext:onboarding/skip",
  /** 读四步进度（引导页据此决定停在哪步、回填哪些表单） */
  onboardingSteps: "mycontext:onboarding/steps",
  /** 标记单步完成/跳过 */
  onboardingStepDone: "mycontext:onboarding/step-done",
  onboardingStepSkip: "mycontext:onboarding/step-skip",
  /** 重新走引导（设置页入口） */
  onboardingRestart: "mycontext:onboarding/restart",
  /** 蒸馏资料源：读 / 存 / 重置水位 */
  distillSources: "mycontext:distill/sources",
  distillSourceSave: "mycontext:distill/source-save",
  distillSourceReset: "mycontext:distill/source-reset",
  /** 会话列表（蒸馏源选择用；走渠道 CLI） */
  channelConversations: "mycontext:channel/conversations",
  /** 蒸馏：进度 / 开跑 / 重来 */
  distillProgress: "mycontext:distill/progress",
  distillStart: "mycontext:distill/start",
  distillReset: "mycontext:distill/reset",
  /**
   * 清空当前渠道的数据（不可逆）。
   *
   * 替换掉了设置里那个「重置蒸馏水位」—— 后者不删任何数据，回答不了
   * 「这个渠道的数据脏了，我要从零重来」。见
   * `ChannelDataWipeService` 的文件头（清什么、留什么、为什么要停服务）。
   */
  channelDataWipe: "mycontext:channel/data-wipe",
  /** 数字人：状态 / 会话配置 / 草稿 / 运行日志 / kill switch */
  personaSnapshot: "mycontext:persona/snapshot",
  personaConversations: "mycontext:persona/conversations",
  personaConfigSave: "mycontext:persona/config-save",
  personaDrafts: "mycontext:persona/drafts",
  personaDraftResolve: "mycontext:persona/draft-resolve",
  /**
   * 用户自己写一条并以本人身份发出去（不经草稿）。
   *
   * ★ 与 `personaDraftResolve` 分开而不是复用它：那个通道的入参是
   * `draftId`，语义是"处置一条**已存在**的草稿"。让它接受"没有 draftId
   * 时新建一条"会让一个通道有两种完全不同的前置条件，而其中一种
   * （新建）要做的校验（会话存在、正文非空）恰好是另一种不需要的。
   *
   * 它仍然走同一个 `SendGuard`：授权、停摆、频率三道闸对"用户自己发的"
   * 同样有效 —— 停摆的意义就是"现在别以我的身份说话"，
   * 而那与这句话是谁写的无关。
   */
  personaComposeSend: "mycontext:persona/compose-send",
  personaRuns: "mycontext:persona/runs",
  /**
   * 读某一轮的 agent 过程（thinking / 正文 / tool 调用）。
   *
   * 与实时的 `personaTrace` 事件互补：那条推的是**正在跑**的那一轮，
   * 这条按 `runId` 回看**已经跑完**的（草稿卡上"看生成过程"）。
   * 两者返回同一个形状 —— 落库形态与渲染形态相同（见 v19 迁移文件头）。
   */
  personaRunTrace: "mycontext:persona/run-trace",
  /**
   * 读某一轮的**元信息**（触发消息 / 判定与原因 / 耗时与 token）。
   *
   * ★ 与 `personaRunTrace` 分开：那条给**过程**（thinking/正文/tool），
   * 这条给**结论与代价**。两者都只在用户展开某一条历史时才需要，
   * 所以都不塞进 `personaActivities`（一次 20 条，19 条不会被展开）。
   */
  personaRunDetail: "mycontext:persona/run-detail",
  personaLiveTrace: "mycontext:persona/live-trace",
  personaActivities: "mycontext:persona/activities",
  personaMessages: "mycontext:persona/messages",
  /**
   * 群成员 —— 从**发过言的人**归并（钉钉没有取群成员的接口）。
   * 会话设置弹窗里的成员列表用它。
   */
  personaMembers: "mycontext:persona/members",
  /**
   * 会话内 like 搜索聊天记录，返回命中的消息 + id（用来精确跳转）。
   * 与全局搜索（FTS）分开：这里要的是字面子串匹配 + 会话内。
   */
  personaSearchMessages: "mycontext:persona/search-messages",
  personaKillSwitch: "mycontext:persona/kill-switch",
  personaTick: "mycontext:persona/tick",
  /** 媒体：下载一个资源 / 批量取头像 */
  mediaDownload: "mycontext:media/download",
  /**
   * 批量取头像 —— **只读缓存**，永不起子进程、永不因渠道抖动失败。
   *
   * ★ 与 `mediaAvatarsFetch` 分开是这条链路稳定性的关键。合在一起时
   * 60 个人共享一次成败：任何一个人的 CLI 超时都让整个 IPC 返回 failure，
   * 于是**一屏头像全部退回首字母**，包括那些早就取到过的。
   * 拆开后「以前取到过的」变成必然显示。
   */
  mediaAvatars: "mycontext:media/avatars",
  /**
   * 去取还没取到的头像（慢、可能部分失败、每人独立成败）。
   *
   * 只返回计数；渲染层拿到之后重读 `mediaAvatars`。
   */
  mediaAvatarsFetch: "mycontext:media/avatars-fetch",
  /**
   * 把一批消息上挂的媒体**一次性下下来**。
   *
   * ★ 与 `mediaDownload` 分开而不是让渲染层循环调它：一屏 20 张图
   * 会是 20 次 IPC + 20 个并发子进程。这个通道在主进程里串行跑完再返回，
   * 渲染层只等一个 promise。
   */
  mediaDownloadForMessages: "mycontext:media/download-for-messages",
  /** 上传本地图片（数字人形象 / 用户头像） */
  mediaUploadImage: "mycontext:media/upload-image",
  /** 把已下载的媒体另存为到用户选的位置（只收 mediaId，见入参 schema） */
  mediaSaveAs: "mycontext:media/save-as",
  /**
   * 取**本人**头像并回填进账号。
   *
   * ★ 单独一个通道而不是复用 `mediaAvatars`：那个是按 externalId 批量取，
   * 而这个还要**写账号**（且要遵守"用户手动设过的不覆盖"）。
   * 混在一起会让"读头像"这个动作有写副作用。
   */
  mediaSelfAvatar: "mycontext:media/self-avatar",
  personaLimits: "mycontext:persona/limits",
  personaLimitsSave: "mycontext:persona/limits-save",
  // 偏好设置
  preferencesSetLanguage: "mycontext:preferences/set-language",
  /**
   * 是否在退出前弹确认框。用户可在设置里反悔——所以是 set 而不是 dismiss。
   *
   * ★ 与 `preferencesSetLanguage` 拆开，不合并成一个"set 一切偏好"通道：
   * 偏好之间没有共同的入参形状，合并会让 schema 变成一个歧义联合。
   */
  preferencesSetQuitConfirm: "mycontext:preferences/set-quit-confirm",
  /**
   * 开/关「工作层抽取」（LLM 抽职责/流程/经验，写进 skill 包的 `work.md`）。
   *
   * ★ 单独一个通道，理由同 `preferencesSetQuitConfirm`：偏好之间没有共同的
   * 入参形状。而这一个还有一层特殊性 —— 它是唯一一个**打开就开始花钱**的
   * 偏好（每轮几万 token 的模型调用），所以它必须是显式动作，不能被
   * 某个"保存全部设置"顺手带上。
   */
  preferencesSetWorkLayer: "mycontext:preferences/set-work-layer",
  /**
   * 渲染层回话：用户在确认框里选了什么。
   *
   * ★ 用 invoke（而不是再来一个单向事件）：主进程那侧是
   * `await` 在等这个决定，而 invoke 天然带请求-响应配对。
   * 单向事件要自己维护"这条回复对应哪次询问"。
   */
  shellQuitDecision: "mycontext:shell/quit-decision",
  /** 改显示名 / 头像。改头像会把来源标成 manual（渠道回填从此不再覆盖） */
  profileUpdate: "mycontext:profile/update",
  // 数据面：采集与知识管道
  ingestSnapshot: "mycontext:ingest/snapshot",
  ingestRunOnce: "mycontext:ingest/run-once",
  ingestClearBlocked: "mycontext:ingest/clear-blocked",
  ingestResolveSelf: "mycontext:ingest/resolve-self",
  ingestConfirmSelf: "mycontext:ingest/confirm-self",
  ingestReadSelf: "mycontext:ingest/read-self",
  /**
   * 本机是否有一份**可采纳**的渠道登录态（查询，不产生副作用）。
   *
   * dws 的登录态按系统用户共享，所以新注册的账号可能一进来就"已授权" ——
   * 那份登录态属于这台机器，不属于这个账号。这个通道回答"有没有可采纳的"，
   * 由界面渲染一个写明组织与账号的入口；采纳与否由用户决定。
   */
  channelAdoptableSession: "mycontext:channel/adoptable-session",
  /** 采纳本机已有的登录态：落身份行 + 刷新账号头像与显示名（用户显式触发）。 */
  channelAdoptSession: "mycontext:channel/adopt-session",
  /**
   * 这个账号下的**全部渠道身份**（界面上的身份切换列表）。
   *
   * 隔离维度是 `(channelId, corpId, userId)` —— 一个人可能在多个组织里
   * 各有一个身份，每个身份一份独立的数据。查询，无副作用。
   */
  channelIdentityList: "mycontext:channel/identity-list",
  /**
   * 切到另一个渠道身份（**卸载当前 vault → 挂载那个身份的**）。
   *
   * ★ 是个重动作：会停采集、卸 agent、停图谱服务（切完要重付一次
   * warmup，实测冷启约 90s）。界面必须把"正在切换"表达出来。
   */
  channelIdentitySwitch: "mycontext:channel/identity-switch",
  ingestIntervals: "mycontext:ingest/intervals",
  ingestIntervalsSave: "mycontext:ingest/intervals-save",
  pipelineFeedInfo: "mycontext:pipeline/feed-info",
  pipelineExport: "mycontext:pipeline/export",
  // 搜索模块
  searchSessionList: "mycontext:search/session-list",
  searchSessionDetail: "mycontext:search/session-detail",
  searchSessionCreate: "mycontext:search/session-create",
  searchSessionRename: "mycontext:search/session-rename",
  searchSessionPin: "mycontext:search/session-pin",
  searchSessionDelete: "mycontext:search/session-delete",
  searchPrompt: "mycontext:search/prompt",
  searchCancel: "mycontext:search/cancel",
  // 知识图谱（kl）子进程
  klServerStatus: "mycontext:kl/server-status",
  klServerStart: "mycontext:kl/server-start",
  klServerStop: "mycontext:kl/server-stop",
  klGraphBuild: "mycontext:kl/graph-build",
  /** 知识图谱概览（可视化版块）：规模 + 类型分布 + 枢纽实体 + 最近事实 */
  klGraphOverview: "mycontext:kl/graph-overview",
  /** 以「我」为中心的关系子图（ego graph），按 IM 渠道标注 */
  klGraphEgo: "mycontext:kl/graph-ego",
  /** 带过滤的事实检索（时间范围 / 类型 / 实体 / 关键词） */
  klGraphFacts: "mycontext:kl/graph-facts",
  klGraphOptimize: "mycontext:kl/graph-optimize",
  /**
   * 仪表盘的时序 + 消化漏斗。
   *
   * ★ 单独一个通道而不是并进 `ingestSnapshot`：按天分桶实测 108ms
   * （本机 32,878 行），而那个快照是每批采集都发的热路径。
   * 完整推理见 `dashboardTrendsSchema` 的注释。
   */
  dashboardTrends: "mycontext:dashboard/trends",
  // 隐藏的极客配置页
  advancedAiRead: "mycontext:advanced-ai/read",
  advancedAiSave: "mycontext:advanced-ai/save",
  /** 自备 dws 可执行文件的路径（内部同学用闭源版的入口；随包开源版兜底） */
  dwsSourceRead: "mycontext:dws-source/read",
  dwsSourceSave: "mycontext:dws-source/save",
  // 模型网关（用户可见的运行时配置：主 LLM + embedding + KL 专用三项）
  runtimeConfigRead: "mycontext:runtime-config/read",
  runtimeConfigSave: "mycontext:runtime-config/save",
  /** 探测网关：验证 baseUrl/key 通不通，并拉回可选模型列表 */
  runtimeConfigProbe: "mycontext:runtime-config/probe",
} as const

/** 主进程 → 渲染层的单向事件（ipcRenderer.on，非 invoke）。 */
export const IPC_EVENTS = {
  channelAuthProgress: "mycontext:channel/auth-progress",
  /** 采集状态变化：状态页据此刷新，不用轮询 */
  ingestProgress: "mycontext:ingest/progress",
  /** 搜索的流式输出 */
  searchStream: "mycontext:search/stream",
  /** 数字人状态变化（新消息提醒、草稿数、kill switch）—— UI 据此刷新不用轮询 */
  personaSnapshot: "mycontext:persona/snapshot",
  /**
   * agent 过程的流式推送（正在处理那一轮的 thinking / 正文 / tool 调用）。
   *
   * ★ **不搭 `personaSnapshot` 的车**：那个每次要跑 3 个 UPDATE + 2 个 COUNT
   * （正是它被 250ms 节流的原因），把 token 级的流塞进去会把开销乘几十倍。
   */
  personaTrace: "mycontext:persona/trace",
  /** 蒸馏进度变化（引导页第 4 步实时显示） */
  distillProgress: "mycontext:distill/progress",
  /** kl 子进程状态变化：设置/状态页据此刷新，不用轮询 */
  klServerStatus: "mycontext:kl/server-status",
  /**
   * 主进程在问「真要退出吗」。渲染层收到后弹**自己画的**确认框，
   * 用户选完走 `shellQuitDecision` 回话。
   *
   * ★ 为什么不用 `dialog.showMessageBox`：那个永远是系统灰框
   * （字体、圆角、按钮样式都由 OS 决定），与应用的设计系统对不上。
   * 而这是用户按 ⌘Q 时唯一看到的界面 —— 它不该看起来像另一个程序。
   */
  shellQuitRequested: "mycontext:shell/quit-requested",
  /**
   * 应用正在优雅退出。渲染层收到后挂遮罩告知"正在关闭"。
   *
   * ★ 只发一次、不带 payload：这不是状态同步，就是"开始了"这一记提示。
   * 渲染层收到后就锁死界面到进程消失——中间不会再有事件更新。
   */
  shellQuitting: "mycontext:shell/quitting",
  /**
   * 模型网关配置已变更。设置面板据此刷新，并提示哪些消费点「已即时生效」、
   * 哪些要「下次子进程重启才生效」（见 RuntimeConfigService）。
   */
  runtimeConfigChanged: "mycontext:runtime-config/changed",
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
export type IpcEvent = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]

// ---------------------------------------------------------------
// 校验规则
// ---------------------------------------------------------------

/** 口令下限 8 位：本地账号无爆破面，过高要求只会让用户记不住而复用弱口令。 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 256

export const credentialsSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /**
   * 「记住登录」：为 true 时把会话写入本地，重启应用不需再次输入口令。
   * 默认 false —— 记住登录意味着拿到这台设备的人能直接进入应用，
   * 必须由用户显式选择而不是默认开启。
   */
  remember: z.boolean().optional(),
})

export type Credentials = z.infer<typeof credentialsSchema>

// ---------------------------------------------------------------
// 返回结构
// ---------------------------------------------------------------

export const authSessionSchema = z.object({
  accountId: z.string(),
  email: z.string(),
  signedInAt: z.string(),
  /** 会话来源：本次输入口令登录，还是从持久化的会话 token 恢复 */
  restored: z.boolean().optional(),
  /**
   * 会话凭据的元信息。
   *
   * 只放过期时间，**不放 token 本身**：渲染层不需要它（所有需要凭据的调用
   * 都在主进程发起），而把 token 递到渲染层就等于给 XSS 一个可偷的东西。
   * 接入远端统一登录后这里可以补 scope 之类的元信息，形状不变。
   */
  tokens: z
    .object({
      expiresAt: z.string().optional(),
    })
    .optional(),
  /**
   * 用户身份：显示名与头像。
   *
   * 都可空 —— 空时由 `resolveDisplayName()` / Avatar 的首字母兜底处理。
   * `avatarSource` 透给 UI 是为了让设置页能显示"这是渠道给的还是你设的"
   * （用户看到自己没设过头像却有一个，会想知道它从哪来）。
   */
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  avatarSource: z.enum(["manual", "channel"]).nullable(),
})

export type AuthSession = z.infer<typeof authSessionSchema>

/**
 * 显示名的兜底顺序。
 *
 * `displayName`（用户设的）→ email 的 `@` 前缀。
 *
 * 为什么不用整个 email：侧栏宽度有限，`someone@company.com` 会被截断成
 * `someone@compa…`，而截断处正好是最没信息量的域名部分。
 * 取 `@` 前缀既短又是人自己认得的那部分。
 *
 * 纯函数放契约包：主进程与渲染层都要用同一套规则 ——
 * 两边各写一份的话会在某个边缘情形（空串/只有 @）上不一致。
 */
export function resolveDisplayName(session: {
  displayName?: string | null
  email: string
}): string {
  const explicit = session.displayName
  if (explicit !== null && explicit !== undefined && explicit.trim() !== "") {
    return explicit.trim()
  }
  const local = session.email.split("@")[0] ?? ""
  return local === "" ? session.email : local
}

/** 勾选「记住登录」时会话 token 的有效期（天）。到期后需重新输入口令。 */
export const REMEMBER_SESSION_DAYS = 30

/**
 * 未勾选「记住登录」时会话 token 的有效期（小时）。
 *
 * 不落盘，所以正常情况下退出应用就失效；给一个有限的短有效期是为了
 * 让「未记住」的会话也有明确的上界，而不是只要进程不退就永久有效。
 */
export const SESSION_TTL_HOURS = 12

// ---------------------------------------------------------------
// 语言偏好
// ---------------------------------------------------------------

/**
 * 支持的界面语言。
 *
 * 定义在契约里而不是 i18n 包里，因为主进程也要校验与持久化这个值，
 * 而主进程不依赖 i18n（渲染层才有 i18next）。
 */
export const LANGUAGES = ["zh", "en"] as const
export type Language = (typeof LANGUAGES)[number]

/** `system` 表示跟随系统语言，不固定为某一种。 */
export const languagePreferenceSchema = z.enum(["system", ...LANGUAGES])
export type LanguagePreference = z.infer<typeof languagePreferenceSchema>

export const setLanguageInputSchema = z.object({ language: languagePreferenceSchema })

/**
 * 退出前是否弹确认框。true = 不再问、直接走 dispose。
 *
 * 值域是布尔而不是三态：用户在设置里显式关掉即"下次不问"，与 UI 上
 * "下次不再提醒"的勾选合流到同一个持久化位。
 */
export const setQuitConfirmInputSchema = z.object({ suppressed: z.boolean() })

/**
 * 开/关工作层抽取。
 *
 * ★ 字段是 `enabled`（正向），与 `setQuitConfirmInputSchema` 的 `suppressed`
 * （反向）刻意不同。那边反向是因为"读值失败要默认会问"；这边正向是因为
 * **读值失败必须默认不花钱** —— boolean 的默认 false 恰好对应"关"，
 * 语义对齐，不需要在 UI 上再翻一层。
 */
export const setWorkLayerInputSchema = z.object({ enabled: z.boolean() })

/**
 * 用户在退出确认框里的选择。
 *
 * `dontAskAgain` 只在 `confirmed` 为 true 时有意义：取消退出时勾了
 * "下次不再提醒"是个自相矛盾的组合（下次也不问、但这次不退？），
 * 所以主进程只在 confirmed 分支读它。UI 上取消也会清掉勾选。
 */
export const quitDecisionInputSchema = z.object({
  confirmed: z.boolean(),
  dontAskAgain: z.boolean(),
})

export type QuitDecision = z.infer<typeof quitDecisionInputSchema>

/**
 * 改资料。
 *
 * 两个字段都可选：只改名字时不该动头像（反之亦然）。
 * `null` 是**显式清空**（与 undefined 的"不改"区分）——
 * 清空头像会把 source 标成 manual，见 accounts.ts 的 updateProfile。
 */
export const updateProfileInputSchema = z.object({
  displayName: z.string().max(64).nullable().optional(),
  avatarUrl: z.string().max(2048).nullable().optional(),
})

export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>

// ---------------------------------------------------------------
// 引导流程
// ---------------------------------------------------------------

export const ONBOARDING_STEP_IDS = ["channel", "model", "persona", "sources", "distill"] as const
export const onboardingStepSchema = z.enum(ONBOARDING_STEP_IDS)
export type OnboardingStepId = z.infer<typeof onboardingStepSchema>

/**
 * 单步的状态。
 *
 * `skipped` 与 `pending` 刻意分开：用户明确跳过之后重进引导，
 * 那一步该显示"已跳过"而不是"还没做"——后者会让人以为操作没生效。
 */
export const onboardingStepStateSchema = z.enum(["pending", "done", "skipped"])

export const onboardingStepViewSchema = z.object({
  step: onboardingStepSchema,
  state: onboardingStepStateSchema,
  /** 该步的产物（数字人名字/形象、选了哪些源…）。重跑引导时回填表单 */
  payload: z.unknown(),
  updatedAt: z.number(),
})

export type OnboardingStepView = z.infer<typeof onboardingStepViewSchema>

export const onboardingStepDoneInputSchema = z.object({
  step: onboardingStepSchema,
  payload: z.unknown().optional(),
})

export const onboardingStepSkipInputSchema = z.object({ step: onboardingStepSchema })

// ---------------------------------------------------------------
// 蒸馏资料源
// ---------------------------------------------------------------

export const DISTILL_SOURCE_IDS = [
  "chat",
  "minutes",
  "doc",
  "mail",
  "calendar",
  "todo",
  "attendance",
  "ding",
  "drive",
] as const
export const distillSourceKindSchema = z.enum(DISTILL_SOURCE_IDS)
export type DistillSourceId = z.infer<typeof distillSourceKindSchema>

/**
 * 蒸馏范围。
 *
 * 各源用到的字段不同（聊天有会话白名单，日历只有时间范围）——
 * 所以是一个宽松对象而不是每源一个 schema：后者会让加一个源就要动契约。
 */
export const distillScopeSchema = z.object({
  since: z.number().optional(),
  until: z.number().optional(),
  chatKinds: z.array(z.enum(["direct", "group"])).optional(),
  conversationIds: z.array(z.string()).optional(),
})

export type DistillScopeInput = z.infer<typeof distillScopeSchema>

export const distillSourceViewSchema = z.object({
  kind: distillSourceKindSchema,
  enabled: z.boolean(),
  scope: distillScopeSchema,
  lastSyncedSeq: z.number(),
  state: z.enum(["idle", "running", "failed"]),
  lastError: z.string().nullable(),
  /**
   * 采集器的状态。
   *
   * · `ready` —— 采集器已接入，勾了就会有数据；
   * · `planned` —— **命令已确认可用**（逐个查过 DWS 的 reference：
   *   `doc list`/`doc read`、`mail folder list`、`calendar list`/`event get`、
   *   `todo task list`、`attendance` 系列、`ding message list`、
   *   `drive list`/`drive download` 都存在），但我们的采集器还没写。
   *
   * ★ 为什么从 `implemented: boolean` 改成这个：原来的 UI 文案是
   * 「未接入」，而那句话读起来像"这个渠道不支持" —— 事实是**我们**
   * 还没写采集器。这个区别对用户有意义：前者他只能放弃，
   * 后者他知道那是排期问题，而且勾上的选择会被记住。
   *
   * 仍然必须透给 UI：勾了 `planned` 的源却永远等不到数据，
   * 而且**不会报错** —— 那正是这个项目里反复出现的那类静默失败。
   */
  status: z.enum(["ready", "planned"]),
})

export type DistillSourceView = z.infer<typeof distillSourceViewSchema>

export const distillSourceSaveInputSchema = z.object({
  /**
   * 存**哪个渠道**的范围。★★★ 必填。
   *
   * ## 为什么必填，以及为什么删掉了 `perChannelConversationIds`
   *
   * 原来这里没有渠道、而是多一个 `perChannelConversationIds` 映射：
   * 主渠道的白名单走 `scope.conversationIds`，其余渠道走那个映射，
   * 服务层**一次写所有库**。
   *
   * 那个形状要求调用方"记住自己是哪个渠道，并把白名单放进对应的位置"，
   * 而它记错的后果是数据丢失：采集范围面板在飞书那栏保存时判
   * `isPrimary=false`，于是 `scope` 里不带 `conversationIds`，
   * 而服务层把这个 scope 原样写进**主库** → 钉钉的白名单被清空。
   *
   * 实测（本机）：钉钉的 `conversationIds` 从 9 个变成字段整个消失，
   * 之后按「不设限」重采，消息从 1730 涨到 3921（92 个会话全采）——
   * 超范围采集，CLAUDE.md 第 5 节。
   *
   * 现在：一次只存一个渠道，白名单**统一**放 `scope.conversationIds`
   * （里面就是那个渠道自己的 external_id，不存在跨库复制的可能）。
   */
  channelId: z.string().min(1),
  kind: distillSourceKindSchema,
  enabled: z.boolean(),
  scope: distillScopeSchema,
})

export const distillSourceResetInputSchema = z.object({ kind: distillSourceKindSchema })

/**
 * 清空当前渠道数据的入参与结果。
 *
 * `dryRun` 默认 **true** —— 这个动作不可逆，契约层就该偏向安全的那一侧：
 * 漏传参数的后果是"只报了个数"，而不是"删掉了几万条真实聊天记录"。
 */
export const channelDataWipeInputSchema = z.object({
  dryRun: z.boolean().default(true),
})

export const channelDataWipeResultSchema = z.object({
  rows: z.number(),
  byTable: z.array(z.object({ table: z.string(), rows: z.number() })),
  removedPaths: z.number(),
  dryRun: z.boolean(),
  /**
   * 身份映射有没有被解除（预演时是"将会解除"）。
   *
   * ★ 与 `rows` 分开：用户要确认的不只是"删了多少条"，更是"是不是真的
   * 要重新授权了"。而后者的判据是这一行 —— 归零的语义就在它上面。
   */
  identityUnbound: z.boolean(),
  /**
   * 授权有没有真的退掉。
   *
   * ★ 与 `identityUnbound` 分开：token 在系统钥匙串里，删 vault 目录带不走
   * 它 —— 退登是一次子进程调用，会独立失败。合成一个字段的话
   * "数据清了但仍然已授权"这个真实中间态就没法如实告诉用户。
   */
  authRevoked: z.boolean(),
})

export type ChannelDataWipeInput = z.infer<typeof channelDataWipeInputSchema>
export type ChannelDataWipeResult = z.infer<typeof channelDataWipeResultSchema>

/** 会话列表项（蒸馏源选择用）。 */
export const channelConversationSchema = z.object({
  externalId: z.string(),
  title: z.string().nullable(),
  kind: z.enum(["direct", "group"]),
  memberCount: z.number().nullable(),
  lastMessageAt: z.number().nullable(),
  /**
   * 这个会话属于哪个渠道。**可选**（旧客户端不带）。
   *
   * ## ★★ 为什么必须带上
   *
   * 会话白名单存的是 `external_id`，而那是**渠道内**唯一的 —— 两个渠道的
   * id 体系完全不同。不带渠道的话：
   * · UI 上两个渠道的会话混成一个列表，用户分不清哪个是哪个；
   * · 存回去时也分不出该写进哪个渠道的库 —— 而写错的后果是那个渠道按一批
   *   不存在的 id 过滤，**结果恒为零**（见 `DistillSourceService.save`）。
   */
  channelId: z.string().optional(),
})

export type ChannelConversationView = z.infer<typeof channelConversationSchema>

/**
 * 一个渠道在这次列举里的结果。
 *
 * ## ★★ 为什么需要它（`truncated` 那个布尔说不出「为什么」）
 *
 * 界面上「没读到任何会话」曾经把三种完全不同的情况说成同一句话，
 * 而它们要用户做的事**恰好相反**：
 *
 * · `expired` —— 渠道登录过期 → 去重新授权（等下去永远不会有）；
 * · `cannot-enumerate` —— 这个渠道**没有会话列举能力** → 这一步不用选，
 *   采过一轮之后本地库里会有；
 *   ★ 现存渠道**都有**这个能力（飞书的 `im +chat-list` 已接上）。
 *   这一档留着是给"新接的渠道还没实现 conversations"用的 —— 那时它得能
 *   诚实地说出来，而不是显示成一个没有解释的空列表（那正是飞书接上之前
 *   的表现）。
 * · `ok` 且 0 项 —— 真的没有会话（新账号 / 全是保密群）。
 *
 * 实测踩到的正是这个：新库上钉钉过期 + 飞书不能列举 → 两个渠道都 0 项，
 * 界面一句「没读到任何会话」，而用户对着它无事可做。
 */
export const channelConversationSourceSchema = z.object({
  channelId: z.string(),
  /** 这个渠道贡献了多少项（远端与本地合并去重之后）。 */
  count: z.number().int().nonnegative(),
  state: z.enum([
    /** 正常列到了（可能仍是窗口内的一部分，见 `truncated`）。 */
    "ok",
    /**
     * **从没连过**这个渠道（没绑身份 / 配置目录还没初始化）。
     *
     * ★ 与 `expired` 分开是刻意的：说"过期"暗示曾经连过、重连就能恢复，
     * 而这一档要走的是一次**完整授权**。更要紧的是引导第 4 步该拿它当
     * 「整条不显示」的信号 —— 没连过的渠道采集不会跑，把它的提示挂在
     * 「接下来学哪些」里只会让人困惑（实测用户反馈：只连了飞书，这一步
     * 却先甩一句钉钉的过期提示，而下面列的全是飞书的会话）。
     */
    "never-connected",
    /** 连过但登录过期 —— 靠等不会好，要用户去重新连接。 */
    "expired",
    /** 这个渠道不支持预先列举会话（采过之后才有）。 */
    "cannot-enumerate",
    /** 库还没挂上（刚授权那个窗口）—— 几秒后自己好转。 */
    "not-ready",
    /** 其他失败（渠道命令报错）。 */
    "failed",
  ]),
  /** 失败时的原因（给用户看的那句）；正常时 null。 */
  reason: z.string().nullable(),
})

export type ChannelConversationSourceView = z.infer<typeof channelConversationSourceSchema>

/**
 * 会话列表结果。
 *
 * `truncated` 必须透到 UI：钉钉侧拿不到全量单聊（渠道分页能力的硬限制，
 * 见 channels/plugins/dingtalk/conversations.ts）。不透的话 UI 只能
 * 把一个有窗口的列表说成"全部会话"，用户找不到某个群时会以为是我们漏读了。
 *
 * ★ `sources` 是**逐渠道**的交代（见上面那个 schema）：`truncated` 只说
 * "不是全集"，而用户需要知道**哪个渠道、为什么**，否则一个空列表无事可做。
 * 可选是为了兼容旧主进程（渲染层要能在缺这个字段时退回旧文案）。
 */
export const channelConversationListSchema = z.object({
  items: z.array(channelConversationSchema),
  truncated: z.boolean(),
  sources: z.array(channelConversationSourceSchema).optional(),
})

export type ChannelConversationListView = z.infer<typeof channelConversationListSchema>

// ---------------------------------------------------------------
// 蒸馏进度
// ---------------------------------------------------------------

/**
 * 蒸馏进度。
 *
 * `skipped` 与 `done` **必须分开**：全 skipped 说明"这段时间没语料"
 * 或"身份没确认"，而全 done 说明真的蒸出了东西。混成一种的话
 * "蒸馏完成但画像是空的"看起来就完全正常。
 */
/**
 * forge（测量型蒸馏引擎）的状态。
 *
 * ## ★ 为什么必须单独一块，而不是塞进上面那些计数
 *
 * 上面的 `total` / `done` 等全是 **LLM 任务表**（`distill_tasks`）的计数。
 * 而画像现在由 forge 产出，它**不切窗、不入队**（全量重算），于是那张表
 * 恒空 —— `total === 0`，UI 走「等待中」分支。
 *
 * 后果实测很难受：forge 跑了两三分钟、pull 了几千条、发布了十几个文件、
 * 判了个覆盖度等级，而用户看到的一直是「等待中」，直到他以为坏了关掉。
 * 连带 `emptyAfterFinish`（跑完但画像为空 → 去确认身份）那条提示也永不
 * 触发，因为它要求 `total > 0`。
 *
 * ## 每个字段都是"缺了就看不出问题"的那种
 *
 * · `available` / `unavailableReason` —— 没装 Python 时蒸馏根本不会跑，
 *   而那时唯一的痕迹是一行启动日志；
 * · `asks` —— **0 是失败**，不是「这个人没被问过」。单聊被误判成群聊时
 *   一条 ask 都挖不出来，而风格层照常有数字，产物看起来是完整的；
 * · `grade` —— forge 对 `asks === 0` 专门判 D（否则能拿到 B，
 *   而 B 读起来像"基本可信"，恰恰是最没有证据的那部分）。
 */
export const forgeStatusSchema = z.object({
  /** 引擎能不能跑（缺 Python / 缺引擎都是**预期状态**，不是异常） */
  available: z.boolean(),
  /** 不能跑的人话原因，可直接显示 */
  unavailableReason: z.string().nullable(),
  /**
   * 这一轮正在跑吗。
   *
   * 与 `running_`（LLM 任务的定时器）分开：只跑 forge 时那个定时器
   * 根本不存在，混用会让「正在蒸馏」永远不显示。
   */
  running: z.boolean(),
  /** 正在跑哪一步；null = 没在跑 */
  step: z.enum(["pull", "build", "publish"]).nullable(),
  /** 上一轮跑完的时刻（unix ms）；null = 这个 vault 还没蒸过 */
  lastRunAt: z.number().nullable(),
  /** 上一轮成功了吗 */
  lastOk: z.boolean().nullable(),
  /** 失败停在哪一步 */
  failedStep: z.enum(["pull", "build", "publish"]).nullable(),
  /** 失败或语料不完整的原因 */
  reason: z.string().nullable(),
  /** 灌进语料库的消息数 */
  messages: z.number(),
  /** 配对出的 (上下文 → 我的回复) 数 */
  turns: z.number(),
  /** 挖掘出的「别人问我」数，**含没回的**（0 = 决策层整个是默认值） */
  asks: z.number(),
  /** 发布出的文件数 */
  files: z.number(),
  /** 覆盖度等级 A–D；null = 读不到（不猜） */
  grade: z.string().nullable(),
})

export type ForgeStatusView = z.infer<typeof forgeStatusSchema>

export const distillProgressSchema = z.object({
  total: z.number(),
  pending: z.number(),
  running: z.number(),
  done: z.number(),
  failed: z.number(),
  skipped: z.number(),
  costTokens: z.number(),
  /** 最近一条失败原因 —— 只报数字用户不知道该怎么办 */
  lastError: z.string().nullable(),
  /** 画像里已有多少条结论（进度 100% 但结论为 0 是要能看出来的） */
  facetCount: z.number(),
  /** 是否正在跑 */
  running_: z.boolean(),
  /** ★ forge 的状态 —— 现在画像的**唯一**来源，见 forgeStatusSchema */
  forge: forgeStatusSchema,
})

export type DistillProgressView = z.infer<typeof distillProgressSchema>

export const distillStartInputSchema = z.object({
  /** 往前多少天；null = 不限 */
  days: z.number().nullable().optional(),
  windowDays: z.number().optional(),
})

// ---------------------------------------------------------------
// 数字人
// ---------------------------------------------------------------

/**
 * 回复模式。
 *
 * 两档：`draft`（出草稿等审）与 `auto`（准入闸过就以本人身份发）。
 *
 * 早期还有 `smart` / `silent`：前者与 `auto` 的差别对用户不成立
 * （无非是"没通过时降级成什么"，是内部实现细节），后者表达的
 * "别管这个会话"现在由 `triggerMode: "none"` 更直接地表达。
 *
 * 库里可能残留 `smart`/`silent` 行 —— 读回时会被白名单拦住并退回
 * 缺省 `draft`，新代码不再写它们。不做数据迁移。
 *
 * ★ `yolo`（界面上叫「直出」）是"不过判定闸直接发"那一档。
 * 它绕过的是"要不要发"的判断；急停、按 draftId 重读库比对 contentHash、
 * @占位符校验、grant 被撤销仍然生效 —— 详见 `@mycontext/persona` 的
 * `REPLY_MODES` 注释。
 */
export const REPLY_MODES = ["auto", "draft", "yolo"] as const
/**
 * 触发条件。四种，与界面上那四个选项一一对应：
 * `none` 不触发 / `mention` @我时 / `all` 每条消息 / `keyword` 命中关键词。
 *
 * ★ `none` 是新增的那一个。在它存在之前，"这个会话别管"只能靠
 * `replyMode: "silent"` 表达 —— 而那让**范围**问题挤进了**模式**里，
 * 造出两条等价路径（silent 与 none 都让会话不出草稿），用户无从选。
 */
export const TRIGGER_MODES = ["none", "all", "mention", "keyword"] as const

export const personaSnapshotSchema = z.object({
  running: z.boolean(),
  /**
   * agent 编排是否可用。
   *
   * ★ false 时 UI **必须**显示降级横幅：这时仍会出草稿，
   * 但那是占位草稿而不是模型生成的。不明示的话用户会以为模型很差。
   */
  agentAvailable: z.boolean(),
  /**
   * 降级的**真实原因**（没降级 → null）。
   *
   * ★ 为什么必须带这个而不是只带 `agentAvailable`：只有布尔值时横幅
   * 只能说一句话，而那句话对 opencode 那几类原因是**错的** ——
   * 实测同事的日志是 `opencode_version_unreadable`，而横幅让他去配模型，
   * 他的模型本来就配好了。那是主动把用户推向修不好问题的地方。
   *
   * 取值：`llm_not_configured` / `opencode_missing` /
   * `opencode_version_unreadable` / `opencode_too_old:<found><<required>`。
   * 不用 enum：`opencode_too_old` 带具体版本号，而 UI 对未登记的值
   * 走兜底文案（显示一个陌生串也好过显示一句错话）。
   */
  degradedReason: z.string().nullable(),
  killSwitch: z.boolean(),
  /**
   * 「能自动发」的会话数 = 回复模式为 `auto` 的会话数。
   *
   * ★ 曾经是 `whitelistCount`（在白名单里的会话数）。白名单那道门已删 ——
   * 选了「自动」本身就是授权，`replyMode === "auto"` 是"这个会话会自动发"的
   * 唯一判据。这是这一屏唯一有不可逆后果的数字，摆在顶部。
   * （更早叫 `listeningCount`；`listening` 概念早已删。）
   */
  autoReplyCount: z.number(),
  pendingInbox: z.number(),
  pendingDrafts: z.number(),
  residents: z.array(z.string()),
  /** 常驻上限（LRU）。UI 要能看出"8 个里用了 3 个" */
  maxResident: z.number(),
  /**
   * 正在生成中的那几轮：这一轮在处理哪些消息。
   *
   * ## ★ 为什么放在快照里而不是新开一个通道
   *
   * 快照本来就在推（`emitSnapshotThrottled`，250ms 节流），而这个信息
   * 的更新时机与它完全重合（开始生成 / 生成结束）。新开一个通道意味着
   * 多一套订阅与失效路径，而拿到的是同一时刻的同一件事。
   *
   * ## 为什么带 messageIds 而不只是一个布尔
   *
   * 用户要的是「看到当前正在处理的引用哪些**新消息**」——
   * 一个"正在生成中"的转圈回答不了那个问题。带上 id 之后
   * 消息流能就地把那几条标出来。
   */
  generating: z.array(
    z.object({
      conversationId: z.string(),
      /** 这一轮的输入消息（触发它的那一批） */
      messageIds: z.array(z.string()),
      startedAt: z.number(),
    }),
  ),
})

export type PersonaSnapshotView = z.infer<typeof personaSnapshotSchema>

export const personaConversationSchema = z.object({
  conversationId: z.string(),
  /**
   * 所属渠道 id（`'dingtalk'` | `'feishu'` …）。UI 用它渲染渠道标识。
   *
   * ★ 来自 `conversations.channel_id`（**会话**属于哪个渠道），
   * 不是渠道插件的 `meta`（**应用支持**哪些渠道）—— 多渠道后两者不是一回事，
   * 而这一栏要答的是前者。
   */
  channelId: z.string(),
  externalId: z.string(),
  title: z.string().nullable(),
  kind: z.enum(["direct", "group"]),
  memberCount: z.number().nullable(),
  lastMessageAt: z.number().nullable(),
  messageCount: z.number(),
  /** 待数字人处理的消息数（新消息提醒用它） */
  unreadForPersona: z.number(),
  /**
   * **人**的未读数（钉钉红点，来自 L1 探针的 `unreadPoint`）。
   *
   * ★ 与 `unreadForPersona` 刻意分开，两个都要有：
   * · `unreadCount` —— **我**还没读；
   * · `unreadForPersona` —— **数字人**还没处理。
   *
   * 混成一个数字的话用户无从知道"这条等我看"还是"等它跑" ——
   * 而这两件事的下一步动作完全不同。
   */
  unreadCount: z.number(),
  replyMode: z.enum(REPLY_MODES),
  triggerMode: z.enum(TRIGGER_MODES),
  keywords: z.array(z.string()),
  personaNote: z.string().nullable(),
  /**
   * 单聊对方的 `openDingTalkId`（群聊为 null）。
   *
   * ## ★ 为什么不能直接用 `externalId` 取头像
   *
   * 单聊的 `externalId` 是**会话** id（实测 `cid…`，47 字符），
   * 而取头像要的是**人**的 id（实测 `D0AU…`，33 字符）。
   * 两者形态都不同，拿会话 id 去查成员详情必然空 ——
   * 而那会落一条**终态** miss（`no_avatar_set`），于是那个人的头像
   * 永久取不到，表现是"单聊就是没有头像"。
   *
   * 从该会话里任一条**对方发的**消息的 `sender_external_id` 取。
   */
  peerExternalId: z.string().nullable(),
  /**
   * 最新一条消息的摘要 —— 侧栏每行要显示「显示名 + 最新一条 + 时间」。
   *
   * ★ 与 `lastMessageAt` 来自**同一条**记录（同一个 SQL 里取）。
   * 分两次查会让"时间是 10:31 而正文是 10:28 那条"这种错悄悄出现 ——
   * 而那种不一致没人能发现，因为两个值单独看都是对的。
   *
   * 正文在 SQL 里已截断到 80 字：侧栏只显示一行，把几千字的消息整条
   * 传过来等于每次刷列表都搬一遍无用字节。
   *
   * `lastMessageIsSelf` 是**三态**：`null` = 身份还没确认，那时不该
   * 假装知道这条是谁发的（侧栏据此决定要不要加「我：」前缀）。
   */
  lastMessageText: z.string().nullable(),
  lastMessageSender: z.string().nullable(),
  lastMessageIsSelf: z.boolean().nullable(),
})

export type PersonaConversationView = z.infer<typeof personaConversationSchema>

export const personaConfigSaveInputSchema = z.object({
  conversationId: z.string().min(1),
  replyMode: z.enum(REPLY_MODES).optional(),
  triggerMode: z.enum(TRIGGER_MODES).optional(),
  keywords: z.array(z.string()).optional(),
  personaNote: z.string().max(2000).nullable().optional(),
})

/** 管控层的运行参数（LRU / 并发 / 批次上限 / 工作时间）。 */
export const personaRuntimeLimitsSchema = z.object({
  /** 常驻 agent 上限 */
  maxResident: z.number().min(1).max(64),
  /** 全局并发 turn 上限 */
  maxConcurrentTurns: z.number().min(1).max(16),
  /** 一批最多带几条消息进 prompt */
  maxBatchSize: z.number().min(1).max(200),
  /** 空闲多久回收一个常驻 agent（分钟） */
  idleEvictMinutes: z.number().min(1).max(1440),
  /**
   * 每个会话最多保留几条 pending 草稿。取代按时效的自动过期
   * （见 v18-draft-cap 迁移的文件头）。超出的按 created_at 从旧到新裁掉。
   * 默认 3：草稿是候选不是待办，太多反而挑花眼；1–20 由用户按自己的节奏调。
   */
  maxDraftsPerConversation: z.number().min(1).max(20),
  /**
   * 工作时间 —— 只在这个窗口内允许自动发送。
   *
   * ★ 与"设 auto + 白名单"分开的一道门：**自动发送默认关**里的两把锁，
   * 是"我打开了它但**这会儿**别发"的实现。默认周一到周五 9-19 点。
   *
   * 全时段等价于 `days: [0..6], startHour: 0, endHour: 24` —— 允许
   * 但要用户自己勾/填出来（不额外加"始终允许"开关：等价的语义有两种
   * 表达时用户会以为它们不一样）。
   */
  workHours: z.object({
    /** 0=周日 … 6=周六 —— 与 `Date.getDay()` 同源 */
    days: z.array(z.number().int().min(0).max(6)),
    /** 本地时间的开始小时（含），0..23 */
    startHour: z.number().int().min(0).max(23),
    /**
     * 本地时间的结束小时（不含），1..24。
     *
     * ★ 允许 24（表示"到当天结束"）：`withinWorkHours` 用 `hour < endHour`
     * 判定，如果只到 23 就会有一小时（23:00-23:59）永远发不出去。
     */
    endHour: z.number().int().min(1).max(24),
  }),
  /**
   * 自动发送的频率上限 —— 防"数字人在一个群里连发"。
   *
   * ## ★ 为什么并进这条统一的运行参数面（而不是留在独立键上）
   *
   * 它原来存在一个独立的 `RATE_LIMIT_KEY`，只被 policy 那条读，而设置页
   * 读的是这个 schema —— 两个 reader 不相交，于是 UI **从来看不到它**。
   * 用户看到「短时间发太多，去改频率上限」却找不到那个入口。并进来之后
   * 那句 action 才名副其实。
   *
   * ## ★ 0 = 不限
   *
   * `perConversation` / `global` 填 0 表示这一关关闭（`withinRateLimit`
   * 里对 0 短路）。想彻底不管的人一键关掉，而不是去改代码或填一个大数。
   * 所以下限是 0 而不是 1。窗口仍要 > 0（0 窗口没有意义 —— 那不是"关闭"
   * 的表达，关闭走的是把条数设 0）。
   */
  rateLimit: z.object({
    /** 单会话在窗口内最多几条；0 = 不限 */
    perConversation: z.number().int().min(0),
    /** 单会话窗口（毫秒）。UI 以分钟呈现，存时换算 */
    perConversationWindowMs: z.number().int().min(1),
    /** 全局在窗口内最多几条；0 = 不限 */
    global: z.number().int().min(0),
    /** 全局窗口（毫秒）。UI 以小时呈现 */
    globalWindowMs: z.number().int().min(1),
  }),
})

export type PersonaRuntimeLimits = z.infer<typeof personaRuntimeLimitsSchema>

// ---------------------------------------------------------------
// 媒体与头像
// ---------------------------------------------------------------

export const mediaDownloadInputSchema = z.object({ mediaId: z.string().min(1) })

/**
 * 一次把若干条消息上挂的媒体下下来。
 *
 * ## ★ 入参是 `messageIds` 而不是 `mediaIds`
 *
 * 渲染层手上天然有的是"这一屏有哪些消息"。传消息 id 让主进程自己去
 * `media_assets` 查该下哪些 —— 渲染层不必先遍历一遍 media 数组，
 * 也不会因为它漏了某个字段而少下一张。
 *
 * ## ★ 有上限，且上限在契约里
 *
 * 一个活跃群一周几百张图（实测），全量下是几百 MB 磁盘 + 几百次子进程。
 * 所以这个通道**只服务"用户正在看的那一屏"**：`max(80)` 与消息窗口
 * （`limit: 80`）对齐。要下更多是另一件事（那需要显式的"下载全部"入口
 * 与进度反馈），不该由一次翻页悄悄触发。
 */
export const mediaDownloadForMessagesInputSchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(80),
})

export const mediaDownloadForMessagesResultSchema = z.object({
  /** 这次真的下成功了几个（已经在本地的不计入） */
  downloaded: z.number(),
  failed: z.number(),
  /** 本来就已经在本地、这次没动的 */
  skipped: z.number(),
})

export type MediaDownloadForMessagesResult = z.infer<typeof mediaDownloadForMessagesResultSchema>

/**
 * 把一个已下载的媒体「另存为」到用户选的位置。
 *
 * ## ★ 入参只有 `mediaId`，**不接受路径**
 *
 * 让渲染层传"从哪读"等于开一个任意文件读取的口子：渲染层可能被注入
 * （群聊正文是不可信输入），那时一个 `{ path: "~/.ssh/id_rsa" }` 就能把
 * 任意文件复制到任意位置。用 mediaId 去 `media_assets` 反查真实路径 ——
 * 能被导出的集合因此**结构上**限定在"我们自己下载过的媒体"里。
 *
 * 目标路径由**主进程**通过系统的保存对话框拿到，渲染层同样不参与。
 */
export const mediaSaveAsInputSchema = z.object({ mediaId: z.string().min(1) })

/**
 * 另存为的结果。
 *
 * ★ `saved: false` 不是错误 —— 用户在保存对话框里点「取消」是完全正常的
 * 操作。抛错的话渲染层会弹一个"失败"的提示，而用户明明是自己取消的。
 */
export const mediaSaveAsResultSchema = z.object({
  saved: z.boolean(),
  /** 保存到哪了（`saved: false` 时为 null） */
  path: z.string().nullable(),
})

export type MediaSaveAsResult = z.infer<typeof mediaSaveAsResultSchema>

/**
 * 批量取头像。
 *
 * ★ 一次要一批而不是逐个：取一个人的头像要 2-3 次 CLI 调用
 * （实测每次 0.3-0.8s），而一屏消息可能有 8 个不同的人 ——
 * 逐个 IPC 会让消息流一边渲染一边卡。上限 60：一屏不可能超过这个数。
 */
export const mediaAvatarsInputSchema = z.object({
  externalIds: z.array(z.string().min(1)).max(60),
  /**
   * 这些人所在的会话（群）。
   *
   * 传了能省掉"搜共同群"那一步 —— 我们是从这个会话看到他们的，
   * 所以它本身就是一个共同群。单聊**不要传**：那个 id 不是群，
   * 传下去会让查询必然空并落一条**终态** miss（头像从此永久取不到）。
   */
  groupExternalId: z.string().nullable().optional(),
  /**
   * `externalId → 花名`。**没有共同群时唯一的出路。**
   *
   * ## ★ 不传这个的后果：整条路径静默失效
   *
   * 取头像有两条路：① 已知共同群 → 直接查成员详情；
   * ② 不知道 → `chat search-common --nicks <花名>` 搜共同群。
   *
   * 而 `--nicks` 是**必填**的：`findViaCommonGroups` 拿不到花名时
   * **立刻返回 null，一次命令都不调**。于是结果是
   * `path: null, reason: null` —— 看起来像"这个人没设头像"（正常），
   * 实际是我们压根没去找。实测踩到：48 个单聊对方全部返回
   * `reason: ok` 而 `path` 全空。
   *
   * 单聊的花名就是**会话标题**（钉钉单聊的标题即对方名字）。
   */
  nickByExternalId: z.record(z.string(), z.string()).optional(),
})

/** 一个人的头像结果。`path` 为 null 时 UI 退回首字母色块。 */
export const contactAvatarViewSchema = z.object({
  externalId: z.string(),
  /** 可加载的 `mycontext-file://` URL（主进程在 IPC 边界转过） */
  path: z.string().nullable(),
  /**
   * 取不到的原因。
   *
   * ★ 透给 UI 是为了让"没有头像"这件事**可解释**：
   * `not_set`/`not_reachable` 是正常的（钉钉自己也显示文字头像），
   * 只有 `failed` 才值得让用户点一下重试。
   */
  missReason: z.string().nullable(),
  /**
   * 还值得去取吗。
   *
   * ★ 由**主进程**判而不是让渲染层看 `path === null` 自己推：
   * 那个判断要区分「终态 miss」（没设头像 → 重试永远同一个答案）
   * 与「可重试」（缺花名 / 网络失败 + 6 小时退避），而那是
   * `contact-avatars.ts` 的知识。让渲染层复制一份的话，两边会分叉 ——
   * 而分叉的表现是每次进页面对几十个"本来就没头像"的人各重试一遍。
   */
  needsFetch: z.boolean(),
})

export type ContactAvatarView = z.infer<typeof contactAvatarViewSchema>

/** `mediaAvatarsFetch` 的结果：只有计数，路径由重读缓存那条通道给。 */
export const avatarFetchResultSchema = z.object({
  fetched: z.number(),
  failed: z.number(),
})

export type AvatarFetchResult = z.infer<typeof avatarFetchResultSchema>

/** 消息上挂的媒体（图片/文件）。 */
export const messageMediaViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  /** 已下载 → 本地路径；未下载 → null（UI 给一个「下载」按钮） */
  path: z.string().nullable(),
  mime: z.string().nullable(),
  bytes: z.number().nullable(),
  originalName: z.string().nullable(),
  /** 能不能内联预览（图片可以，未知类型只给"打开文件"） */
  previewable: z.boolean(),
})

export type MessageMediaView = z.infer<typeof messageMediaViewSchema>

/**
 * 上传一张本地图片。
 *
 * ## ★ 为什么走 IPC 传字节而不是让渲染层直接读文件路径
 *
 * 渲染层拿到的 `File` 只有一个**沙箱内**的引用，没有真实路径
 * （Electron 21+ 起 `File.path` 已移除）。而即便有，渲染层也不该
 * 直接往 userData 写 —— 那等于把一个任意写文件的能力交给了
 * 可能被 XSS 的那一层。
 *
 * 所以：渲染层读成 base64 → 主进程校验 + 落盘 → 返回路径。
 */
export const mediaUploadImageInputSchema = z.object({
  /**
   * base64 编码的图片字节（不含 data URI 前缀）。
   *
   * 上限 4MB（base64 后约 5.5MB 字符）。头像不需要更大 ——
   * 而没有上限意味着一次 IPC 能把主进程的内存打满。
   */
  base64: z.string().min(1).max(5_600_000),
  /** 用途：决定落在哪个子目录，也决定文件名前缀 */
  purpose: z.enum(["figure", "avatar"]),
})

export const uploadedImageSchema = z.object({
  /** 本地绝对路径（渲染层用 `file://` 加载） */
  path: z.string(),
  bytes: z.number(),
  mime: z.string(),
})

export type UploadedImageView = z.infer<typeof uploadedImageSchema>

export const personaDraftSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /**
   * 产出这条草稿的那一轮 run。**回看生成过程的入口。**
   *
   * 可空：用户自己写的那条（composeSend）没有 run；老库里的草稿也可能没有。
   * 为 null 时 UI 不显示"看生成过程"（而不是显示一个点了没反应的按钮）。
   */
  runId: z.string().nullable(),
  text: z.string(),
  editedText: z.string().nullable(),
  /** 为什么没自动发 —— 草稿箱里直接看得到 */
  notSentReason: z.string().nullable(),
  citations: z.array(z.string()),
  createdAt: z.number(),
})

export type PersonaDraftView = z.infer<typeof personaDraftSchema>

/**
 * 一条 agent 过程项（= 一个 `ChatItem` 的传输形态）。
 *
 * ★ 字段与 `searchChatItemSchema` **同构**：两个模块用的是同一个 ChatItem
 * 模型，渲染件也共用（`features/agent-stream/`）。不同构的话共用渲染件就得
 * 在里面分叉，而那套折叠/分组的判据是调过的，分叉等于把它复制一遍。
 *
 * `contentJson` 走字符串（`UnifiedContentBlock[]` 的 JSON）：传输层不解析它，
 * 与搜索同一口径。
 */
export const personaTraceItemSchema = z.object({
  id: z.string(),
  seq: z.number(),
  role: z.enum(["user", "assistant", "system"]),
  itemType: z.enum(["message", "thought", "tool_call", "plan", "error"]),
  contentJson: z.string(),
  toolName: z.string().nullable(),
  toolStatus: z.enum(["pending", "running", "success", "error"]).nullable(),
  turnId: z.string().nullable(),
  createdAt: z.number(),
})

export type PersonaTraceItem = z.infer<typeof personaTraceItemSchema>

/**
 * agent 过程的流式推送。
 *
 * `items` 是**当前的完整快照**而不是增量：一轮的 item 数是个位数到几十，
 * 全量推的代价可以忽略，而增量推要求渲染层自己做合并（按 id 覆盖）——
 * 那是一处只在"tool_call 状态变化"时才会暴露的 bug 温床。
 *
 * `done` 为 true 表示这一轮结束（UI 据此收起动效）。
 */
export const personaTraceEventSchema = z.object({
  conversationId: z.string(),
  items: z.array(personaTraceItemSchema),
  done: z.boolean(),
})

export type PersonaTraceEvent = z.infer<typeof personaTraceEventSchema>

/** 按 runId 回看过程的入参。 */
export const personaRunTraceInputSchema = z.object({ runId: z.string().min(1) })

/** 取某会话当前 in-flight trace 快照的入参。 */
export const personaLiveTraceInputSchema = z.object({ conversationId: z.string().min(1) })

export const personaDraftResolveInputSchema = z.object({
  draftId: z.string().min(1),
  action: z.enum(["send", "discard"]),
  /** 编辑后的正文（发送时用它替换原文） */
  editedText: z.string().max(4000).optional(),
})

/**
 * 用户自己写一条直接发。
 *
 * `max(4000)` 与草稿那条一致 —— 两条路最终进同一个渠道命令，
 * 上限不同会让"草稿能发但自己写的发不出去"这种差异出现在长文本上。
 */
export const personaComposeSendInputSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1).max(4000),
})

export const personaRunSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  triggerMessageId: z.string().nullable(),
  draftText: z.string().nullable(),
  confidence: z.number().nullable(),
  decision: z.string(),
  /** 未自动发送时必填 —— 静默降级是最难调试的产品行为 */
  decisionReason: z.string().nullable(),
  latencyMs: z.number().nullable(),
  costTokens: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
})

export type PersonaRunView = z.infer<typeof personaRunSchema>

export const personaActivitySchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  kind: z.enum(["auto_sent", "user_accepted", "user_edited"]),
  text: z.string(),
  occurredAt: z.number(),
  /**
   * 产生这条回复的那一轮 run —— 界面拿它回看「这句话是怎么想出来的」。
   *
   * ★ 可空：用户自己写的那条本来就没有 run，升级前的旧记录也没有。
   * 那时界面**不显示**"看处理过程"入口 —— 一个点了没反应的入口
   * 比没有入口更糟。
   *
   * ★ 与「有 run 但没 trace」是不同的状态：那时入口要在，展开后明说
   * "这一轮没有留下过程"。该状态**不该普遍出现** —— 曾经普遍出现过，
   * 但归因（"走了直连降级"）是错的：真因是 `appendTrace` 的行主键不带
   * runId，重启后新轮次把旧痕迹改嫁走了（已修，见 store 侧那个方法）。
   */
  runId: z.string().nullable(),
})

export type PersonaActivityView = z.infer<typeof personaActivitySchema>

/**
 * 一轮 run 的元信息 —— 回答「为什么会跑、判成了什么、贵不贵」。
 *
 * ★ 与 `personaRunTrace`（过程）分成两个通道：两者都只在用户**展开某一条**
 * 时才需要，塞进列表查询等于给 19 条不会被展开的记录白做 join。
 */
export const personaRunDetailSchema = z.object({
  runId: z.string(),
  decision: z.string(),
  /**
   * 未自动发送时的原因（机器码）。
   *
   * ★ 界面**必须**用 `explainDecisionReason()` 翻成人话，而不是各写一份映射
   * —— 同一个 reason 在运行日志与这里必须是同一句话，否则用户会以为
   * 是两回事。
   */
  decisionReason: z.string().nullable(),
  latencyMs: z.number().nullable(),
  costTokens: z.number().nullable(),
  error: z.string().nullable(),
  /** 触发这一轮的那条消息。null = 已被保留策略清掉（其余字段仍有效） */
  trigger: z
    .object({
      senderDisplayName: z.string().nullable(),
      contentText: z.string().nullable(),
    })
    .nullable(),
})

export type PersonaRunDetailView = z.infer<typeof personaRunDetailSchema>

/** 读某一轮的元信息。与 `personaRunTraceInputSchema` 同形（都按 runId）。 */
export const personaRunDetailInputSchema = z.object({ runId: z.string().min(1) })

export type PersonaRunDetailInput = z.infer<typeof personaRunDetailInputSchema>

/** 消息可视化用的一条消息。 */
export const personaMessageSchema = z.object({
  id: z.string(),
  senderDisplayName: z.string().nullable(),
  /** 发送者的 openDingTalkId —— 头像按它查 */
  senderExternalId: z.string().nullable(),
  contentText: z.string().nullable(),
  sentAt: z.number(),
  isSelf: z.boolean().nullable(),
  /** 是否 @了本人（可视化里高亮） */
  mentionsSelf: z.boolean(),
  origin: z.string(),
  /**
   * 被引用的那条消息。
   *
   * ★ `quoted_external_id` 从一开始就在解析并落库
   * （`message-parse.ts` 读 `quotedMessage.openMessageId`），而 UI
   * 一直没用它 —— 于是"某人回复了某句"在界面上看起来是一句突然的话。
   *
   * 这里解析成**已经查好的那条**（发送者 + 正文摘要）而不是只给 id：
   * 让渲染层再发一次 IPC 去查会让一屏 20 条消息变成 20 次往返。
   * 查不到时为 null（被引用的消息可能在采集窗口之外）。
   */
  quoted: z
    .object({
      id: z.string().nullable(),
      senderDisplayName: z.string().nullable(),
      /** 截断到 80 字：引用块只占一两行，全文会把气泡撑爆 */
      excerpt: z.string(),
    })
    .nullable(),
  /** 挂在这条消息上的图片/文件 */
  media: z.array(messageMediaViewSchema),
  /**
   * 「这条是数字分身发的」+ 它当时引用了哪些消息。`null` = 本人自己打的。
   *
   * ## ★ 为什么不能只用 `origin`
   *
   * `origin='agent'` 只标**自动发送**的那些（它们要被排除出蒸馏语料）。
   * 而界面上要分辨三种：本人手打 / 分身自动发 / 分身起草**经本人确认**后发。
   * 后两种在 `origin` 上不同（`agent` / `human`），但都不是本人自己想的那句话
   * —— 都该标出来。`source` 正是这个区分。
   *
   * ## 为什么要带 citations
   *
   * 用户的原话是「点击后能显示引用的区域」。引用的消息通常比"最近 80 条"
   * 更早（实测 53 条引用一条都不在窗口里），所以渲染层拿到 id 之后要走
   * `personaMessagesInput.includeIds` 那条路把它们显式取回来。
   */
  agentSend: z
    .object({
      /** `agent_auto`（自动发）| `user_approved`（草稿经本人确认后发） */
      source: z.string(),
      runId: z.string().nullable(),
      /** 当时引用的消息 id。空数组 = 有角标但没有可看的引用（降级，不是错误） */
      citations: z.array(z.string()),
    })
    .nullable(),
})

export type PersonaMessageView = z.infer<typeof personaMessageSchema>

export const personaMessagesInputSchema = z.object({
  conversationId: z.string().min(1),
  limit: z.number().min(1).max(200).optional(),
  /**
   * 额外必须包含的消息 id（草稿的 `citations`）。
   *
   * ★ 为什么需要它：草稿引用的是**当时**触发它的那些消息，而中栏只加载
   * 最近 N 条。实测在真实数据上 53 条引用**一条都不在**那 80 条窗口里 ——
   * 于是点「看引用」什么都不会发生（没有报错，就是没反应）。
   *
   * 上限与 limit 同量级：引用数由 `citations` 决定，不是用户输入。
   */
  includeIds: z.array(z.string().min(1)).max(200).optional(),
})

export const personaKillSwitchInputSchema = z.object({ active: z.boolean() })
export const personaRunsInputSchema = z.object({ conversationId: z.string().min(1) })
export const personaActivitiesInputSchema = z.object({ conversationId: z.string().min(1) })

export const personaMembersInputSchema = z.object({ conversationId: z.string().min(1) })

/**
 * 群成员（发过言的人）。
 *
 * ★ 字段命名成 `messageCount` 而不是 `count`：它是"这个人在这个群里
 * 发过多少条"，UI 会用它排序并说明"这是发言者不是全体成员"。
 */
export const personaMemberSchema = z.object({
  externalId: z.string(),
  displayName: z.string().nullable(),
  messageCount: z.number(),
})
export type PersonaMemberView = z.infer<typeof personaMemberSchema>

export const personaSearchMessagesInputSchema = z.object({
  conversationId: z.string().min(1),
  query: z.string().min(1).max(200),
  limit: z.number().min(1).max(100).optional(),
})

/** 会话内搜索命中的一条。`id` 用来精确跳转到消息流里那条。 */
export const personaMessageHitSchema = z.object({
  id: z.string(),
  contentText: z.string(),
  senderDisplayName: z.string().nullable(),
  sentAt: z.number(),
})
export type PersonaMessageHit = z.infer<typeof personaMessageHitSchema>

/** 应用启动态：renderer 据此决定渲染登录页、Onboarding 还是主壳。 */
export const bootstrapStateSchema = z.object({
  appVersion: z.string(),
  platform: z.string(),
  /** 是否已存在任意本地账号：false 时 UI 进入「注册」而非「登录」 */
  hasAccount: z.boolean(),
  session: authSessionSchema.nullable(),
  /**
   * 是否需要走 Onboarding：已登录本地账号、没有任何渠道已授权、
   * 且用户此前没有完成或跳过过。
   */
  needsOnboarding: z.boolean(),
  /**
   * 已持久化的语言偏好。
   *
   * 随启动态一起下发而不是单独一个 IPC：渲染层在首帧就需要它，
   * 多一次往返就多一次「先渲染成系统语言再跳成用户选择」的闪烁。
   */
  language: languagePreferenceSchema,
  /**
   * 退出前是否**不**再弹确认框。true = 用户已经勾过"下次别问"。
   *
   * 与 language 同随启动态下发的理由相同：设置页首帧就要读它、
   * 免得先渲染成默认再跳成用户选择。
   */
  quitConfirmSuppressed: z.boolean(),
  /**
   * 工作层抽取是否开着。`false` = 关（默认）。
   *
   * 随启动态下发，理由同上面两个：设置页首帧就要读它，否则会先渲染成"关"
   * 再跳成"开" —— 而对一个**花钱**的开关，那一下闪烁会让人以为自己没开成。
   */
  workLayerEnabled: z.boolean(),
})

export type BootstrapState = z.infer<typeof bootstrapStateSchema>

// ---------------------------------------------------------------
// IM 渠道授权
// ---------------------------------------------------------------

export const CHANNEL_IDS = ["dingtalk", "feishu"] as const

export const authModeSchema = z.enum(["loopback", "device"])
export type AuthMode = z.infer<typeof authModeSchema>

/** 授权状态：判别联合，避免「未授权却有组织名」这类矛盾状态。 */
export const authStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unauthorized") }),
  z.object({
    state: z.literal("expired"),
    corpName: z.string().optional(),
    userName: z.string().optional(),
  }),
  z.object({
    state: z.literal("authorized"),
    corpId: z.string(),
    corpName: z.string(),
    userId: z.string(),
    userName: z.string(),
    accessExpiresAt: z.string().nullable(),
    refreshExpiresAt: z.string().nullable(),
    daysUntilRefreshExpiry: z.number().nullable(),
  }),
])

export type AuthStatus = z.infer<typeof authStatusSchema>

/** refresh token 剩余天数低于此值时在 UI 上提醒续期。 */
export const REFRESH_EXPIRY_WARNING_DAYS = 3

/**
 * 渠道摘要。
 *
 * 文案传的是 i18n key 而不是文本：主进程不知道用户当前选的什么语言
 * （语言是渲染层的状态），在这里拼好中文就等于把渠道插件钉死在一种语言上。
 * 渲染层拿到 key 后自己 `t()`，新增渠道只需在语言包里加译文。
 */
export const channelSummarySchema = z.object({
  id: z.string(),
  /** 渠道名的 i18n key，如 `channels:dingtalk.label` */
  labelKey: z.string(),
  descriptionKey: z.string(),
  available: z.boolean(),
  /** 授权步骤说明的 i18n key 列表，各渠道自述 */
  stepKeys: z.array(z.string()),
  status: authStatusSchema,
  /** 是否正在授权中（用于 UI 禁用按钮与显示进度） */
  loginInProgress: z.boolean(),
  /**
   * 渠道能力 —— 只暴露渲染层真正要用的那两项。
   *
   * ## ★★ `sendAs` 是「数字分身能不能在这个渠道上跑」的判据
   *
   * 分身的本质就是**以我的身份发消息**，所以这不是一个新造的标记，
   * 而是本来就该问的那个问题。空数组 = 只读接入（飞书刻意如此，
   * 见 `plugins/feishu/index.ts` 头注释第一行：`deliberately no persona/send`）。
   *
   * ★ 没有新加一个 `personaCapable: boolean`：那会让「这个渠道能不能发消息」
   * 有**两个真源**，而它们迟早分叉 —— 而渲染层原来的做法更糟：
   * 七处各写一份 `channelId === "dingtalk"`，也就是七份拷贝。
   *
   * ## 为什么不整份透传 `ChannelCapabilities`
   *
   * 那里面还有 `ingest` / `changeProbe` / `media` —— 采集层的实现细节，
   * 渲染层不该看见（看见了就会有人拿它做 UI 判据，而它随实现变）。
   */
  capabilities: z.object({
    sendAs: z.array(z.enum(["self", "bot"])),
    domains: z.array(z.enum(["chat", "doc", "minutes", "contact"])),
  }),
})

export type ChannelSummary = z.infer<typeof channelSummarySchema>

export const channelAuthStartInputSchema = z.object({
  channelId: z.string().min(1),
  mode: authModeSchema.default("loopback"),
})

export type ChannelAuthStartInput = z.input<typeof channelAuthStartInputSchema>

export const channelIdInputSchema = z.object({ channelId: z.string().min(1) })

/** 授权进度事件：主进程流式推给渲染层。 */
export const authProgressSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("starting") }),
  z.object({ phase: z.literal("browser-opened"), url: z.string() }),
  z.object({ phase: z.literal("scope-authorization"), url: z.string() }),
  z.object({
    phase: z.literal("device-code"),
    userCode: z.string(),
    verifyUrl: z.string(),
    expiresInSeconds: z.number(),
  }),
  z.object({ phase: z.literal("waiting") }),
  z.object({ phase: z.literal("succeeded"), status: authStatusSchema }),
  /**
   * 失败带 i18n key 与参数，而不是拼好的文案。
   *
   * `detail` 是外部 CLI 的原始输出片段（本身没有译文），
   * 渲染层把它作为插值参数塞进译文，因此两种语言下都能看到原始原因。
   */
  z.object({
    phase: z.literal("failed"),
    messageKey: z.string(),
    detail: z.string().optional(),
  }),
  z.object({ phase: z.literal("cancelled") }),
])

export type AuthProgress = z.infer<typeof authProgressSchema>

/** 事件载荷：带上 channelId，渲染层可能同时关注多个渠道。 */
export const channelAuthProgressEventSchema = z.object({
  channelId: z.string(),
  progress: authProgressSchema,
})

export type ChannelAuthProgressEvent = z.infer<typeof channelAuthProgressEventSchema>

export const configEntryViewSchema = z.object({
  key: z.string(),
  envName: z.string(),
  source: z.enum(["default", "dotenv", "env"]),
  sensitive: z.boolean(),
  value: z.string().nullable(),
  configured: z.boolean(),
})

/** 运行状态报告：用于肉眼确认基建（目录/数据库/配置注入）是否正常。 */
export const statusReportSchema = z.object({
  appVersion: z.string(),
  electronVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  packaged: z.boolean(),
  paths: z.object({
    userData: z.string(),
    /** 控制库（账号与应用级设置） */
    database: z.string(),
    /** 各账号 vault 的根目录 */
    vaults: z.string(),
    logs: z.string(),
  }),
  database: z.object({
    appliedVersion: z.number(),
    migrations: z.array(z.object({ version: z.number(), name: z.string(), appliedAt: z.string() })),
    accountCount: z.number(),
  }),
  config: z.array(configEntryViewSchema),
  /** .env 文件是否被实际读取（开发态） */
  dotenvLoaded: z.boolean(),
  /**
   * 实际读取到的 .env 路径；未读到为 null。
   * 只有布尔值的话，「.env 没生效」查不出是没找到还是找错了文件。
   */
  dotenvPath: z.string().nullable(),
})

export type StatusReport = z.infer<typeof statusReportSchema>
export type ConfigEntryView = z.infer<typeof configEntryViewSchema>

// ---------------------------------------------------------------
// 数据面（采集与知识管道）
// ---------------------------------------------------------------

/**
 * 采集状态。
 *
 * `storage` 一节是刻意暴露给 UI 的：桌面端悄悄占掉几百 MB 而没有任何提示，
 * 是会被当成 bug 报上来的。**存储增长必须可见。**
 *
 * `blockedReason` 也是：登录过期与缺授权靠重试永远好不了，
 * 静默重试只会让用户以为功能坏了。UI 必须显式引导。
 */
export const ingestSnapshotSchema = z.object({
  running: z.boolean(),
  channelId: z.string(),
  messages: z.number(),
  conversations: z.number(),
  /** is_self 未判定的消息数：>0 时提示「请先确认身份，否则无法蒸馏」 */
  unjudged: z.number(),
  outboxHead: z.number(),
  ftsIndexed: z.number(),
  /** FTS 消费者落后的条数。「新消息多久能搜到」的直接指标 */
  ftsLag: z.number(),
  probeIntervalMs: z.number(),
  /** 是否处于降频状态（探针耗时占了太多周期） */
  probeThrottled: z.boolean(),
  lastError: z.string().nullable(),
  blockedReason: z.enum(["session_expired", "permission_required"]).nullable(),
  /**
   * 连续失败轮数（成功一轮归零）。
   *
   * >0 意味着采集正在**退避重试**（跳过若干轮以免烧 CLI 调用）。
   * 必须暴露给 UI：不显示的话"采集变慢了"与"卡住了"在界面上完全一样。
   */
  failedAttempts: z.number(),
  selfConfirmed: z.boolean(),
  /**
   * 本人身份**为什么**还没确认 —— `null` = 已确认（正常）。
   *
   * ## ★★ 为什么光有 `selfConfirmed` 不够
   *
   * 界面原来只有那个布尔值，于是「没确认」这一个状态被显示成一句
   * 「检测到同名的多个账号——确认一下哪个是你」。而 `!selfConfirmed`
   * 至少有四种成因，只有**一种**是同名歧义：
   *
   * · `unbound`   —— 还没绑渠道身份（没授权 / 刚清过数据）。这时该做的是
   *   去授权，而不是"确认哪个是你"；
   * · `unresolved` —— 已绑身份但身份行还没解析出来（授权后那次自动
   *   resolve 失败过，比如当时没网）。该做的是点一下重试；
   * · `ambiguous` —— **真的**同名多 ID / 两条判据冲突。这才是那句文案的场景；
   * · `unconfirmed` —— 身份行有了、但 `confirmed_at` 还是空（历史库、
   *   或 confirm 那一步被打断）。该做的是确认+回填。
   *
   * 拿一种成因的文案去覆盖另外三种，用户会被指向一件不需要做的事
   * （去找一个不存在的重名同事），而真正该做的那件不会被提到。
   * 这与 CLAUDE.md §4 的「不要用一句话盖住没验证过的分支」同一条。
   */
  selfIdentityState: z.enum(["unbound", "unresolved", "ambiguous", "unconfirmed"]).nullable(),
  /** 媒体元数据行数（一期只记资源 ID，不下载字节） */
  mediaAssets: z.number(),
  /** 听记条数 */
  minutes: z.number(),
  /**
   * 听记的**覆盖面**。`null` = 还没跑过一轮采集。
   *
   * ## ★ 为什么需要它（与 `backfill` 那三个数字同一个理由）
   *
   * 首版只取列表首页，于是第 51 场之前的会议永远采不到 —— 而那个缺失
   * **完全静默**：`minutes` 这个计数会稳定停在 50，与"这个账号一共
   * 50 场会"在界面上无法区分。上面那个数字回答的是"我有多少"，
   * 而这里回答的是"**是不是全部**"。
   */
  minutesCoverage: z
    .object({
      /** 上一轮把列表翻到底了吗。false = 撞了页数预算，覆盖不全。 */
      drained: z.boolean(),
      /** 已覆盖到的最早会议时间（unix ms）；null = 库里还没有会议。 */
      earliestStartedAt: z.number().nullable(),
      /**
       * 有几场会的**转写**没抽干（撞了渠道侧的页数/字符上限）。
       *
       * 与 `drained` 分开：那个说的是"会议列表全不全"，
       * 这个说的是"某几场会的逐句转写全不全"。两者的处置不同 ——
       * 前者等下一轮或放宽预算，后者需要用户显式为那几场会补拉。
       */
      transcriptTruncated: z.number(),
    })
    .nullable(),
  storage: z.object({
    mainBytes: z.number(),
    walBytes: z.number(),
    rawRecords: z.number(),
    /** 已裁剪 payload 的行数，让「这些行为什么没有原文」可解释 */
    rawPruned: z.number(),
    vectors: z.number(),
  }),
  /** 心跳超期的消费者：状态页要**告警**，不能静默跳过 */
  staleConsumers: z.array(z.string()),
  /**
   * 「用户选的采集范围 vs 库里实际覆盖的范围」。
   *
   * ★ 必须暴露给 UI。这个落差过去是**完全静默**的：引导页选 180 天，
   * 而采集写死回溯 7 天且没人读那个选择 —— 状态页每个数字都正常
   * （消息在涨、无错误、蒸馏等级 A），唯一的症状是画像薄，而"薄"没有
   * 参照物。把三个数摊开，"还差 170 天"才能被看见。
   */
  backfill: z.object({
    /** 用户选的下界（unix ms）；null = 不限或没配 */
    since: z.number().nullable(),
    /** 已覆盖到的最早时间；null = 库里还没有消息 */
    coveredFrom: z.number().nullable(),
    /** 还差多少毫秒到目标；0 = 已到位（★ 仅当 `started` 为 true 时是这个含义） */
    remainingMs: z.number(),
    /**
     * 采集**有没有真的开始**（库里有消息，或回填推进过）。
     *
     * ★ 与 `remainingMs` 必须分开：「一条消息都没有」曾经也被算成
     * `remainingMs: 0`，与"已覆盖到目标"返回同一个值 —— 于是引导页
     * 对一个**采集完全失败**的库显示「选的 N 天已全部采集完成」。
     * 实测踩到过（游标 status=failed、watermark=0、messages 表空，
     * 而界面报"完成"，蒸馏跟着 0 语料 / 覆盖度 D）。
     *
     * false 时 UI 必须说"还没开始 / 正在等第一批"，不能说"已完成"。
     */
    started: z.boolean(),
    /**
     * 回填卡住了的原因；null = 正常。
     *
     * 与 `remainingMs` 分开：那个只说"还差多少"，而**差着不动**与
     * "正在推进"在界面上是同一个数字。实测踩过一次活锁（窗宽固定 7 天
     * 而一窗的消息数超过单轮预算），当时日志里只有一行 info，
     * 看起来和正在跑一模一样。
     */
    stalled: z.string().nullable(),
    /**
     * 当前正在回填的时间窗；null = 这一刻没有在跑的窗。
     *
     * ★ 只报 `remainingMs`（"还差 38 天"）时进度是**不可感**的：
     * 那个数字每几分钟才动一次，用户分不清"在跑"与"卡住"。
     * 而"正在拉 6-11 到 6-13"是看得见在动的 —— 引导第四步靠它
     * 让等待变成可观察的过程，而不是一个静止的数字。
     */
    activeWindow: z
      .object({
        start: z.number(),
        end: z.number(),
      })
      .nullable(),
    /** 已采集的消息总数（该渠道）。进度条的分子。 */
    messages: z.number(),
  }),
  /**
   * 实时事件通路（长连接推送）的健康状态。渠道不支持 / 未起时为 null。
   *
   * ★ `state` 必须能区分「起来了」与「真在投递」：钉钉实测长连接会 ready +
   * connected 但**零投递**（云端订阅没建成）。所以 `delivering` 单独表示
   * "stdout 真收到过事件"，`ready` 只表示"本地 bus 起来了"。状态页据此区分
   * "正常"与"接通但零投递、正在靠轮询"——两者在别的指标上完全一样。
   *
   * 它挂了/零投递**不影响消息完整性**：事件只是叫醒信号，正文永远走轮询。
   */
  eventStream: z
    .object({
      state: z.enum(["stopped", "starting", "ready", "delivering", "backoff"]),
      /** 最近一次真正收到事件的时刻（unix ms）；null = 从没收到过。 */
      lastEventAt: z.number().nullable(),
      /** 累计去重后投递的事件数。0 且 state=ready 就是"接通但零投递"。 */
      delivered: z.number(),
      /** 连续重连次数（成功建连或收到事件后归零）。 */
      reconnects: z.number(),
      /**
       * 订阅**覆盖面**（`event list` 目录 + `event status` 实际订阅对账）。
       *
       * ★ 与 `state` 分开的理由：`state=delivering` 只说"通路在投递"，
       * 不说"覆盖了几个会话"。钉钉的 `at` 一个订阅覆盖全部群的「@我」，而
       * 单聊/指定群要**逐会话**订阅 —— 没订阅的会话只能靠轮询。两者都摊开，
       * 才不会把「事件通路正常」误读成「所有消息都秒级到」。
       *
       * null = 还没对账过 / 读取失败（`auditError` 给原因）。
       */
      audit: z
        .object({
          catalog: z.array(z.string()),
          globalKeys: z.array(z.string()),
          perConversationKeys: z.array(z.string()),
          activeSubscriptions: z.number(),
          error: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  /**
   * 逐渠道的采集快照。**可选**（单渠道时省略，旧渲染层不改也能跑）。
   *
   * ## ★★ 为什么顶层那一份不够
   *
   * 顶层快照来自 `snapshotIngest()` —— 它挑**一个**渠道返回（主渠道活跃就
   * 只返回主渠道）。于是另一个渠道采集彻底停了、blocked 了、或一条都没采到，
   * 界面上完全看不出来：显示的数字是主渠道的，而且看起来很正常。
   *
   * 与 `KlServerStatus.perChannel` 同一条理由（隐藏失败）。这里只带
   * 用户真正要看的那几个数，不整份复制 —— 那会让 IPC 载荷翻倍。
   */
  perChannel: z
    .array(
      z.object({
        channelId: z.string(),
        running: z.boolean(),
        messages: z.number(),
        conversations: z.number(),
        /** 图片与文件条数 —— 与 messages/conversations 一起构成"这个渠道采到了什么" */
        mediaAssets: z.number(),
        /**
         * 以下这些也是**渠道级**的（各渠道一个物理库，各自一套水位与索引）。
         *
         * ★ 少一个的表现是"切了渠道但那个数不动" —— 实测漏了 `ftsIndexed`，
         * 于是飞书那栏显示「已采集 8 条 · 其中 **1,665** 条已能被搜到」，
         * 两个数字互相矛盾而没有任何报错。
         *
         * ★ 判据是"这个数是从哪个库查出来的"：从渠道库查的就该在这里。
         * `eventStream` 是主渠道特有的长连接，**刻意不放**。
         */
        ftsIndexed: z.number(),
        ftsLag: z.number(),
        unjudged: z.number(),
        outboxHead: z.number(),
        minutes: z.number(),
        probeIntervalMs: z.number(),
        probeThrottled: z.boolean(),
        selfConfirmed: z.boolean(),
        /**
         * 存储用量 —— **也是渠道级的**。
         *
         * ## ★★ 这里原来没有它，而注释里写着「`storage` 是整个 vault 的文件体积」
         *
         * 那句话在"一个 vault 一个库"的时代是对的。现在每个非主渠道有自己的
         * 物理库（`sources/<channelId>/core.sqlite`），而 `collectStorageStats`
         * 拿的正是**那个 IngestService 自己的** `db`/`dbPath` —— 也就是说
         * 逐渠道的真值一直算出来了，只是没往上传。
         *
         * 实测的坏形态：选着飞书，运行状态页显示「库体积 187.7 MB ·
         * 原生留存 7,666」，而飞书库真值是 **640 KB / 4 条**（那两个数是主库的
         * 192 MB / 7,684）。数量级差 300 倍，而界面上没有任何痕迹说这是别人的数。
         *
         * ★ 判据仍是上面那条："这个数是从哪个库查出来的"。storage 从渠道库查，
         * 所以它属于这里 —— 那条注释当时把**实现细节**（当时只有一个库）
         * 当成了**语义**（vault 级）。
         */
        storage: z.object({
          mainBytes: z.number(),
          walBytes: z.number(),
          rawRecords: z.number(),
          rawPruned: z.number(),
          vectors: z.number(),
        }),
        lastError: z.string().nullable(),
        /**
         * ★ 与顶层同一个枚举，不是裸 string：它们是**同一个字段**
         * （逐渠道 vs 挑一个渠道），两处类型不一样会让消费方各写一套
         * 文案映射，而其中一套迟早漏掉一个取值。
         */
        blockedReason: z.enum(["session_expired", "permission_required"]).nullable(),
      }),
    )
    .optional(),
})

export type IngestSnapshot = z.infer<typeof ingestSnapshotSchema>

/**
 * 采集轮询周期（`dh_settings.ingestIntervals`）。
 *
 * ## ★ `probeBaseMs` 是「基础周期」，不是「绝对周期」
 *
 * 探针走 `AdaptiveInterval`：一轮耗时超过周期的一半就自动降频（几百个群之后
 * 它会自己退让）。所以配 10s 时实际可能看到 20s —— 这一点必须在 UI 上写清楚，
 * 否则用户会以为设置没生效。`probeMaxMs` 是降频的上界。
 *
 * ## ⚠️ `pullMs` 不建议跟着降到 10s
 *
 * L2 是**全量时间窗分页**（实测一轮最多 600 页），10s 一轮会持续占满采集锁
 * 并挤掉发送。让"新消息秒级可见"的是**事件叫醒 + 探针 hint → 定向补拉**
 * （见 `IngestService.refreshConversation`），不是把全量轮询加密。
 */
export const ingestIntervalsSchema = z.object({
  /** 探针基础周期（毫秒）。默认 10s，可配 5s–120s。 */
  probeBaseMs: z.number().min(5_000).max(120_000),
  /** 探针降频上界（毫秒）。默认 120s。 */
  probeMaxMs: z.number().min(10_000).max(600_000),
  /** L2 全量拉取周期（毫秒）。默认 2min，可配 30s–10min。 */
  pullMs: z.number().min(30_000).max(600_000),
  /** 听记轮询周期（毫秒）。默认 30min，可配 5min–2h。 */
  minutesMs: z.number().min(300_000).max(7_200_000),
  /**
   * 文档轮询周期（毫秒）。默认 60min，可配 15min–6h。
   *
   * ★ 原先写死在 `DOCUMENTS_INTERVAL_MS`，与其它四项不同源 —— 也就是
   * 「采集频率」这个面板宣称能配采集，而实际漏了一路。文档是最低频的一路
   * （知识库节点变动远慢于聊天），但"最低频"不等于"不该可配"：
   * 一个知识库重度使用的账号会希望它更勤，而只用聊天的账号希望它更懒。
   */
  documentsMs: z.number().min(900_000).max(21_600_000),
  /**
   * 轮转扫描（L1.5）周期（毫秒）。默认 30s，可配 15s–5min。
   *
   * ## ★★ 这一级补的是探针那 87% 的盲区
   *
   * 探针只调 `list-unread-conversations` —— 只返回**有未读红点**的会话。
   * 实测覆盖率只有 **13.3%**（23/173），而盲区里有 **33 个会话在 48 小时内
   * 有新消息**（在客户端读过就没红点了，而"读过"恰恰说明那是最活跃的）。
   *
   * 它能做到 30 秒一轮是因为判据**不逐会话发请求**：一次会话目录调用
   * （带缓存）+ 一次 GROUP BY 就知道谁落后，只有真落后的才付补拉的钱。
   * 所以下界给到 15s —— 比全量分页便宜得多，允许比 `pullMs` 更勤。
   */
  activeScanMs: z.number().min(15_000).max(300_000),
  /**
   * 建图**最小间隔**（毫秒）。默认 1h，可配 15min–6h。
   *
   * ## ★★ 它是「至少隔多久」，不是「每隔多久」
   *
   * 自动建图原有三条判据（`packages/knowledge-feed/src/auto-build.ts`）：
   * 攒够 500 条新消息 → 建；24h 没建过 → 建；否则不建。
   * 缺的正是**成功之后的冷却** —— 活跃群里 500 条可能十几分钟就攒够，
   * 于是建图被反复触发。
   *
   * 而每次建图的固定成本与"新增了多少"基本无关：
   * · 全量解析四件套导出（本机 chat 目录 21MB）；
   * · 把全库 MENTIONS/ABOUT 边一次性读进内存算结构相似度；
   * · **improve 阶段目前仍是全量** —— 对全图重算相似边与社区划分，
   *   这是最吃 CPU 的一段（上游注释原文 "Scroll all entity points"）。
   *
   * 所以这一项限的是**触发频率**，而不是"多久必须建一次"。数据不够时
   * 到点也不会建；数据够了也要等冷却过去。
   *
   * ## 为什么放进 `ingestIntervals` 而不是新开一组
   *
   * 这一组已经有完整的存取链（schema → vault 的 `dh_settings` → IPC → 面板），
   * 而"多久建一次图"与"多久拉一次数据"对用户是同一类心智（后台多勤）。
   * 新开一组要把五层各重复一遍。
   *
   * ★ 区间与 `documentsMs` 同（15min–6h）：下界 15min 是因为再短就等于没有
   * 冷却；上界 6h 留在 `max-age`（24h）之下 —— 那条兜底必须仍然能生效。
   *
   * ★ **只管自动触发**：用户手动点「建图」按钮不受它限制。挡住一次明确的
   * 点击就是"点了没反应"，而那比多跑一次建图糟得多。
   */
  graphBuildMinIntervalMs: z.number().min(900_000).max(21_600_000),
})

export type IngestIntervals = z.infer<typeof ingestIntervalsSchema>

/** 保存采集周期：全字段可选（只改一项不该把其余擦回缺省）。 */
export const saveIngestIntervalsInputSchema = ingestIntervalsSchema.partial()

export type SaveIngestIntervalsInput = z.infer<typeof saveIngestIntervalsInputSchema>

/** 本人身份的待确认结果。**身份错了后面全错**，所以必须人工确认。 */
export const selfIdentityViewSchema = z.object({
  channelId: z.string(),
  userId: z.string(),
  openIds: z.array(z.object({ kind: z.string(), value: z.string() })),
  /** 仅展示，**不参与判定** */
  displayNames: z.array(z.string()),
  corpName: z.string().nullable(),
  /**
   * 组织 ID —— 用来检测「渠道当前用的身份」与「这个账号绑定的身份」是否错位。
   *
   * ★ 比对必须用 `corpId` 而不是 `corpName`：后者是显示名，同一个组织
   * 在不同接口/版本上可能给出不同写法（实测见过「钉钉」与全称并存），
   * 而 ID 是稳定的。名字只用于**告警文案**里告诉用户是哪两个组织。
   */
  corpId: z.string().nullable(),
  /** 已在语料中识别到的本人消息条数：给用户一个可核对的数字 */
  matchedMessageCount: z.number(),
  confirmed: z.boolean(),
})

export type SelfIdentityView = z.infer<typeof selfIdentityViewSchema>

/**
 * 一个渠道身份（界面上的身份切换列表用）。
 *
 * ## ★ 为什么 `corpId`/`userId` 也要给渲染层
 *
 * 切换时要拿它们当键回传（`(channelId, corpId, userId)` 才唯一定位一个身份
 * —— userId 只在**企业内**唯一，同一个人在两家企业下是两个不同的 userId）。
 * 它们是标识符而不是凭据，且渲染层本来就通过 `selfIdentityView.corpId`
 * 看得到当前那个，所以这里不构成新的暴露面。
 *
 * ★ **不含** vaultId：那是存储布局，渲染层不需要知道（与 `AuthSession`
 * 刻意不带 vaultId 同一条原则）。
 */
export const channelIdentitySchema = z.object({
  channelId: z.string(),
  corpId: z.string(),
  userId: z.string(),
  /** 组织名与真名 —— 仅展示（会改，不参与判定） */
  corpName: z.string().nullable(),
  userName: z.string().nullable(),
  /** 是不是当前生效的那个 */
  active: z.boolean(),
  /** 最近用过的时间（ISO）。null = 绑定后还没用过 */
  lastUsedAt: z.string().nullable(),
})

export type ChannelIdentity = z.infer<typeof channelIdentitySchema>

/** 切身份的输入。键必须是三元组，见 `channelIdentitySchema` 的注释。 */
export const channelIdentitySwitchInputSchema = z.object({
  channelId: z.string().min(1),
  corpId: z.string().min(1),
  userId: z.string().min(1),
})

export type ChannelIdentitySwitchInput = z.infer<typeof channelIdentitySwitchInputSchema>

/**
 * Feed 接口信息。
 *
 * ## ★ 不含 token 本身
 *
 * 与 `authSessionSchema` 同一条原则：**渲染进程能拿到的东西，
 * 一次 XSS 就能偷走**。token 只有两个正当消费者 ——
 * 算法团队（从 `handoff.json` 读，mode 0600）与主进程自己，
 * 两者都不需要经过渲染层。
 *
 * ## 一期用户怎么拿到 token
 *
 * **走 `handoff.json`**（路径由状态页显示，用户在终端里 `cat` 它）。
 * 「由主进程复制到剪贴板」是一个合理的将来做法，但那需要一条
 * clipboard IPC，而它**尚未实现** —— 所以这里不承诺它，
 * 免得读者以为 UI 上已经有那个按钮（首版注释就是这么写的）。
 */
export const feedInfoSchema = z.object({
  running: z.boolean(),
  baseUrl: z.string(),
  /**
   * token 是否已就绪。**刻意不给 token 本身**，见上文。
   *
   * ⚠️ 当前实现下 `running === true` 时它恒为 true
   * （token 在 FeedServer 构造时就生成好了，不可能为空串）——
   * 也就是说它现在**不传递任何信息**。保留它是为了让将来
   * 「token 从外部注入且可能缺失」时 UI 不必改协议；
   * UI 侧判断"能不能取 token"应当看 `running`。
   */
  tokenReady: z.boolean(),
  head: z.number(),
  consumers: z.array(
    z.object({
      consumerId: z.string(),
      ackedSeq: z.number(),
      lag: z.number(),
      needsFullRebuild: z.boolean(),
    }),
  ),
})

export type FeedInfo = z.infer<typeof feedInfoSchema>

export const exportResultSchema = z.object({
  /**
   * 写出的 source 目录数（`chat` / `minutes`），**不是文件数**。
   *
   * 首版叫 fileCount 且确实是"每会话一个 JSON"。现在导出的是 kl-graph 的
   * 标准四件套（每个 source 一组 `manifest + scopes/records/resources.jsonl`），
   * 文件数恒为 `source 数 × 4` —— 那个数字对用户没有意义，
   * 有意义的是"导出了哪几类数据、各多少条"。
   */
  sourceCount: z.number(),
  totalMessages: z.number(),
  totalMinutes: z.number(),
  /** 导出的文档篇数（**只算有正文的** —— 没正文的进图谱只是噪声） */
  totalDocuments: z.number(),
  headSeq: z.number(),
  exportDir: z.string(),
})

export type ExportResultView = z.infer<typeof exportResultSchema>

// ---------------------------------------------------------------
// 搜索模块
// ---------------------------------------------------------------

/** 侧栏列表用的会话摘要。刻意不含消息内容（列表不需要，传了只是浪费）。 */
export const searchSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  pinned: z.boolean(),
  messageCount: z.number(),
  lastActiveAt: z.number(),
  createdAt: z.number(),
  state: z.enum(["idle", "streaming", "error"]),
  /**
   * 检索档位（侧栏要显示"这个会话搜的是哪些渠道"）。
   * **可选**：旧主进程 + 新渲染层时不存在（见 `buildProgress.startedAt`
   * 那条同款注释）。用它之前必须判 undefined。
   */
  graphScope: z.string().optional(),
})

export type SearchSessionSummary = z.infer<typeof searchSessionSummarySchema>

/** 一个可渲染项。与 agent-runtime 的 ChatItem 同形，但契约独立定义。 */
export const searchChatItemSchema = z.object({
  id: z.string(),
  seq: z.number(),
  role: z.enum(["user", "assistant", "system"]),
  itemType: z.enum(["message", "thought", "tool_call", "plan", "error"]),
  /** UnifiedContentBlock[]，由渲染层解析 */
  contentJson: z.string(),
  toolName: z.string().nullable(),
  toolStatus: z.enum(["pending", "running", "success", "error"]).nullable(),
  turnId: z.string().nullable(),
  createdAt: z.number(),
})

export type SearchChatItem = z.infer<typeof searchChatItemSchema>

export const searchSessionDetailSchema = z.object({
  session: searchSessionSummarySchema,
  items: z.array(searchChatItemSchema),
  /**
   * Agent 运行时是否可用。
   *
   * false 时 UI 显示降级提示 —— **不静默降质**：
   * 「答案质量突然变差」比「明确告知能力降级」难排查得多。
   */
  agentAvailable: z.boolean(),
  /**
   * 本会话最近一轮走的是**降级路径**时，这里给出人类可读的原因；
   * 走了 agent turn（或还没跑过任何一轮）则为 null。
   *
   * 判据**跟实际路径走**而非二进制在不在：装了 opencode 不等于本轮真走了
   * agent（ensureAgent/ensureSession 可能失败落回 recallOnly）。UI 据此决定
   * 是否挂降级横幅、挂什么文案。
   */
  degradedReason: z.string().nullable(),
})

export type SearchSessionDetail = z.infer<typeof searchSessionDetailSchema>

export const createSearchSessionInputSchema = z.object({
  /** 首个查询：用它生成标题 */
  query: z.string().trim().min(1).max(4000),
  /**
   * 检索档位：这个会话去问哪几个渠道的图谱。
   *
   * ## ★ 为什么只在**建会话**时给，`searchPromptInput` 里没有
   *
   * 档位决定连哪个 kl，而那是 opencode **进程**的 env（spawn 之后改不了）。
   * 允许每轮改的话，同一个会话的前后两轮会跑在两个进程上 —— 而 ACP 的
   * session 是绑进程的，换进程就意味着 resume 失败 + 回灌历史。
   * 也就是"改档位"实际上等于"新建一个会话"，那不如让它就是新建。
   *
   * 不给 = `"dingtalk"`（与迁移 v24 的 DEFAULT 一致）。★ 缺省**不能**是
   * `all`：那会让不带这个字段的旧渲染层建出的会话突然检索全部渠道。
   */
  scope: z.string().min(1).optional(),
})

export const searchPromptInputSchema = z.object({
  sessionId: z.string().min(1),
  query: z.string().trim().min(1).max(4000),
})

export const searchSessionIdInputSchema = z.object({ sessionId: z.string().min(1) })

export const renameSearchSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
})

export const pinSearchSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  pinned: z.boolean(),
})

/** 流式事件：主进程 → 渲染层。一次推一批（200ms 内的合并）。 */
export const searchStreamEventSchema = z.object({
  sessionId: z.string(),
  items: z.array(searchChatItemSchema),
  /** 本轮是否结束（UI 据此关掉"停止"按钮） */
  done: z.boolean(),
  /**
   * 本轮走了降级路径时的人类可读原因；走了 agent turn 则为 null。
   * 与 `searchSessionDetailSchema.degradedReason` 同义，只是随流式事件即时带下来，
   * 让降级横幅不必等 detail 刷新。
   */
  degradedReason: z.string().nullable(),
})

export type SearchStreamEvent = z.infer<typeof searchStreamEventSchema>

// ---------------------------------------------------------------
// 知识图谱（kl）子进程状态
// ---------------------------------------------------------------

/**
 * kl-server（Python 检索服务）的运行状态快照。
 *
 * 「降级必须可见」：kl 是可选增强，起不来时搜索仍能用（agent 靠自身推理 +
 * 本地召回），但用户要能看到"图谱检索为什么没用上"。所以状态机对 UI 全程可见。
 *
 * - stopped：没起（或已停）。首次用到 kl 才懒启动。
 * - starting：进程已拉起，正在 warmup（实测 ~90s：Qdrant mmap）。
 * - ready：`/health` 返回 ok，可查。
 * - failed：起不来/崩溃/warmup 超时。带 reason，给一次手动重试（不自动无限重启）。
 */
export const klServerStatusSchema = z.object({
  state: z.enum(["stopped", "starting", "ready", "failed"]),
  /** failed 时的人类可读原因；其它状态为 null */
  reason: z.string().nullable(),
  /** 端口（starting/ready 时有值，便于诊断）；未起时 null */
  port: z.number().nullable(),
  /**
   * 是否正在建图（in-server `POST /ingest`）。
   *
   * 建图与服务是**两回事**，但它们的关系已经变了：
   *
   * · **增量**建图（`fresh=false`，自动建图与「建图」按钮都走这条）由跑着的
   *   server 自己干，复用同一个 Qdrant writer —— 服务**不停**，`state` 仍是
   *   `ready`，检索照常可用。
   * · 只有**重建**（`fresh=true`）要删数据文件，那时才先 stop（见
   *   `rebuildGraph` 里的注释：删一个被 mmap 打开的文件在 macOS 上不报错，
   *   却会让读写永远对不上）。
   *
   * ★ 所以 `building:true` **不**意味着服务不可用。UI 必须把它渲染在
   *   「图谱数据」那一块，而不是拿它覆盖服务徽章 —— 实测踩过：服务 `/health`
   *   ok、图里有 29230 条消息，UI 却显示「建图占用中」，把一个能用的服务
   *   说成不可用，而一轮增量建图要跑几十分钟。
   */
  building: z.boolean(),
  /**
   * embedding/LLM 是否要出网。
   *
   * kl 的数据留在本机，但它的 embedding 与 LLM 调用会打到远端网关 ——
   * 这是 local-first 的边界，UI 要明示（沿用"降级必须可见"）。
   */
  networkEgress: z.boolean(),
  /**
   * 建图进度（phase / percent / startedAt）。null = 没在建图。
   *
   * ## ★★ 当前**没有 UI 消费方** —— 只用于日志与诊断
   *
   * 曾经拿它在状态页渲染进度，改了两轮都没对，最后整块移除了。
   * 留这段注释是为了让下一个人先看见坑，而不是重走一遍。
   *
   * ### 坑一：上游只有一半 percent 是真的
   *
   * `kl_server.py` 的 ingest 里两种性质泾渭分明：
   *
   * ```python
   * pipeline.run_phase_a(progress_callback=lambda ph, pct:
   *     _set_progress("running", ph, pct * 0.4, ...))       # ← 真实回调
   * _set_progress("running", "phase_b", 0.4, ...)           # ← 写死的里程碑
   * await pipeline.run_extraction()   # 几十分钟，期间 percent 恒为 0.4
   * _set_progress("running", "phase_b", 0.7, ...)           # ← 写死
   * ```
   *
   * 实测（20s 间隔采样三次）percent / 实体数 / 事实数**全部一动不动**：
   * ```
   * 13:36:15 | phase_b 40% | extraction + graph build | 实体 873 事实 2718
   * 13:36:35 | phase_b 40% | extraction + graph build | 实体 873 事实 2718
   * 13:36:55 | phase_b 40% | extraction + graph build | 实体 873 事实 2718
   * ```
   * 也就是**最慢的那一段恰好没有进度**，而静止在 40% 的进度条看起来就是卡死。
   *
   * ### 坑二：它会卡在 stale 值上，不会自己清
   *
   * 这个字段只在 `KlServerService.awaitIngest()` 的轮询里维护。而
   * `optimizeGraph()` 会先 `await this.stop()` 停掉 server —— 于是那个轮询
   * 读不到 `/status`，它的 catch 是"偶发探测失败是常态，继续轮询"，
   * 字段就**保持在最后一次读到的值**上直到 ingest 超时。
   * 实测表现：优化都跑完了（「优化完成」已经显示），下面还挂着
   * 「抽实体 + 建图 已运行 12 分钟」，而后端此刻报的是 `phase_a 0.2`。
   *
   * ### 要重新做进度，得先解决这两件事
   *
   * 1. 给 `kl-graph` 的 `run_extraction()` 加真实回调（那份代码在
   *    我们仓库里，可改），否则 Phase B 永远没有可信百分比；
   * 2. 把这个字段的生命周期从 `awaitIngest` 里提出来，让它在
   *    stop / optimize / 失败等任何路径上都被明确清空 —— 现在它的清除依赖
   *    "轮询能读到终态"，而那个前提在停 server 时就不成立。
   *
   * 在那之前：**别拿它渲染任何用户可见的进度**。一个经常显示错信息的进度指示
   * 比没有更糟 —— 它让人以为卡住或以为已跑完，两种误判都会引出多余的操作
   * （点第二次、重启应用）。`tests/renderer/kl-panel-build-state.test.tsx`
   * 里有门禁盯着这件事。
   */
  buildProgress: z
    .object({
      phase: z.string(),
      percent: z.number(),
      /**
       * 本轮建图开始的时间戳（epoch ms）。诊断用（见上面那段）。
       *
       * 由主进程在触发 ingest 时记下，**不**取 kl 的 `updated_at`：
       * 那个是"进度上次变化"的时刻，而 Phase B 期间它也不怎么变
       * （每次轮询都会刷 updated_at，但阶段没推进）。
       *
       * ★ `optional`：升级路径上会出现**新渲染层 + 旧主进程**（开发态热更
       * 就是这样：vite 只 reload 渲染层，主进程还在跑旧的 `awaitIngest`）。
       * 那时这个字段不存在 —— 而任何拿它做减法的代码都会得到 NaN
       * （实测界面上显示过「已运行 NaN 分钟」）。声明成 optional 是让类型
       * 说实话：**用它之前必须先判 undefined**。
       */
      startedAt: z.number().optional(),
    })
    .nullable(),
  /**
   * 逐渠道的状态。**可选** —— 单渠道时省略（旧渲染层不改也能跑）。
   *
   * ## ★★ 为什么顶层聚合不够，必须把每个渠道摊开
   *
   * 顶层那几个字段是**合并**过的：`state` 取主渠道、`building` 是"任一在建"、
   * `networkEgress` 是"任一出网"。于是一个渠道的 kl 彻底起不来时，
   * 顶层仍然显示 `ready`（主渠道好着）—— 那一路整个坏掉而 UI 说一切正常。
   *
   * 这正是本仓库最贵的那类 bug 的形状：不报错，只是少了一半数据。
   * 摊开之后"哪个渠道坏了、坏在哪"变成可见的，而不是要去翻日志。
   */
  perChannel: z
    .array(
      z.object({
        channelId: z.string(),
        state: z.enum(["stopped", "starting", "ready", "failed"]),
        reason: z.string().nullable(),
        port: z.number().nullable(),
        building: z.boolean(),
        /**
         * 这个渠道**自己**的建图进度。没在建 → `null`。
         *
         * ## ★★ 为什么顶层那个不够
         *
         * 顶层 `buildProgress` 取的是"**任意**一个在建的渠道"的进度
         * （`MultiKlServerService.status()` 里 `find(status => status.building)`）。
         * 于是界面上那行「建图中 85%」**不带渠道归属** —— 用户看到的是一个
         * 不知道属于谁的百分比。而在多渠道下这个歧义是实打实的：切到飞书时
         * 显示的可能是钉钉那一轮的进度（用户报的正是这个）。
         *
         * ★ 与顶层同一个形状（`percent` 是 0–1 小数，`startedAt` 可选），
         * 所以渲染层可以复用 `klBuildPercent`。同样**只拿它显示百分比**，
         * 不做时间减法 —— 见顶层那段关于「已运行 NaN 分钟」的注释。
         */
        buildProgress: z
          .object({
            phase: z.string(),
            percent: z.number(),
            startedAt: z.number().optional(),
          })
          .nullable()
          .optional(),
        /**
         * 这个渠道当前**没在跑**的原因（还没采到消息 → 不起 Python/Qdrant）。
         * 与 `reason` 分开：那个是"失败"，这个是"刻意没起"，
         * 混成一个会让一次正常的降级看起来像故障。
         */
        idle: z.boolean(),
      }),
    )
    .optional(),
})

export type KlServerStatus = z.infer<typeof klServerStatusSchema>

/**
 * 建图（`kl ingest`）的结果。
 *
 * 建图是长任务（LLM 抽实体 + embedding，几分钟）且**出网**。跑完返回图规模，
 * 失败带原因。`ok:false` 时 entities/facts/edges 为 0。
 */
export const klGraphBuildResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().nullable(),
  /**
   * ★ 被**主动打断**（退出应用 / 停服务 / 清库前置停），不是失败。
   *
   * ## 为什么要在契约上单开一个字段
   *
   * `awaitIngest` 唯一的失败判据是「进程没了」（时间上限刻意删掉了）。
   * 那条判据分不清"崩了"与"我们自己关的"，于是**每次退出应用**都会走出：
   * ```
   * shutdown step started {"step":"klServer"}          ← 我们杀 kl
   * graph build failed {"reason":"建图中断：kl-server 进程已退出"}
   * graph auto build failed {"consecutiveFailures":1,"retryAfterMs":1800000}
   * ```
   * 而 `consecutiveFailures` 会让下次启动后**半小时不自动建图** —— 这一轮
   * 根本没失败。每次退出都撞一次，自动建图基本就废了。
   *
   * 消费方（`GraphSyncService`）据此**不计入** `consecutiveFailures`。
   * 不用 reason 字符串匹配来区分：那是个迟早漂移的判据。
   *
   * `ok` 仍然是 false（这一轮确实没建成），但语义是"下次再来"而不是"坏了"。
   */
  cancelled: z.boolean().optional(),
  entities: z.number(),
  facts: z.number(),
  edges: z.number(),
  /**
   * 这一轮**产出了多少** —— 前后差值 + 处理量。`undefined` = 没测到
   * （失败/被打断，或上游没给那几个数）。
   *
   * ## ★★ 为什么必须与绝对值分开
   *
   * `entities/facts/edges` 回答"图里现在有多少"，而用户问的是
   * "这一轮干了什么"。增量建图下两者差别很大：一轮可能只新增几十个实体，
   * 而总数是几百 —— 只报总数的话每轮看起来都"没动"（数字几乎不变），
   * 而那恰恰让人以为增量没生效。
   *
   * `unitsSkipped` 是**增量收益的唯一证据**（实测一轮 36613 发现 /
   * 2589 跳过 / 34024 处理）。
   */
  volume: z
    .object({
      /** 实体净增（可为负：fresh 重建或上游合并了重复实体） */
      entities: z.number(),
      facts: z.number(),
      edges: z.number(),
      unitsDiscovered: z.number(),
      /** 命中缓存跳过的 —— 增量到底省了多少就看这个 */
      unitsSkipped: z.number(),
      unitsProcessed: z.number(),
      chunksCreated: z.number(),
    })
    .optional(),
})

export type KlGraphBuildResult = z.infer<typeof klGraphBuildResultSchema>

/**
 * 知识图谱概览 —— 可视化版块的数据。
 *
 * ## ★ 为什么是"概览 + 分布"，不是"把 2170 个实体画成一张网"
 *
 * 力导向图在几百个节点以上就变成一团毛线：既看不出结构，也点不准
 * 任何一个节点。而用户在这一页真正要回答的是三个问题：
 *
 * ① 图**建起来了吗**（entities/facts/edges 三个数，0 就是没建起来）；
 * ② 抽出来的**是什么**（Person / System / Project 的分布；
 *    DECISION / DELEGATE / CAUSAL 这些 fact 类型的分布）；
 * ③ 谁是**枢纽**（按提及数排的实体 —— 那是"这个组织在聊什么"的答案）。
 *
 * 三个都是**聚合**问题，聚合视图答得比节点图好。真正要看关系时走
 * 检索页的 `kl ask`（那里有 graph walk），而不是在这里拖节点。
 */
export const klGraphOverviewSchema = z.object({
  /** 图是否可读（数据库文件存在且有 schema）。false 时其余字段为 0/空。 */
  available: z.boolean(),
  /** 不可读的原因（还没建图 / 文件缺失），供 UI 给一句可行动的话。 */
  reason: z.string().nullable(),
  entities: z.number(),
  facts: z.number(),
  edges: z.number(),
  /** 已切块的消息数 —— 与采集侧的消息总数对比就知道图落后多少。 */
  chunks: z.number(),
  messages: z.number(),
  /** 实体类型分布，按数量降序。 */
  entityTypes: z.array(z.object({ type: z.string(), count: z.number() })),
  /** fact 类型分布，按数量降序。DECISION/DELEGATE 这些是这套图的价值所在。 */
  factTypes: z.array(z.object({ type: z.string(), count: z.number() })),
  /**
   * 枢纽实体（按 mention_count 降序）。
   *
   * ★ `name` 是**真实人名与系统名** —— 它来自用户自己的聊天记录，
   * 属于本机数据。UI 可以显示（那是他自己的数据），但**绝不能**进日志、
   * 进导出、进任何离开这台机器的东西（见 scripts/check-no-local-data.mjs）。
   */
  topEntities: z.array(z.object({ name: z.string(), type: z.string(), mentions: z.number() })),
  /** 最近抽到的事实（带类型与置信度），让"图里到底有什么"可感。 */
  recentFacts: z.array(
    z.object({
      text: z.string(),
      type: z.string(),
      confidence: z.number(),
      at: z.number().nullable(),
    }),
  ),
  /**
   * 自动建图的**调度状态**：为什么现在没在建、下一次什么条件下建。
   *
   * ## ★ 为什么它可以显示，而 `KlServerStatus.buildProgress` 不能
   *
   * 那个字段是上游 kl 自报的百分比 —— 实测 Phase B 恒为 40%、
   * 停 server 时会卡在 stale 值上，所以被明确禁止渲染
   * （见 `klServerStatusSchema.buildProgress` 那段长注释）。
   *
   * 这一块完全不同：全部由**我们自己库里的水位**算出来
   * （`head` / `lastBuiltSeq` / `lastBuiltAt`），而且与真实触发判据
   * 同源（同一个 `forecastAutoBuild`）。它是确定的、单调的、可解释的。
   *
   * `null` = 还没接上自动建图（未登录 / 没配 autoBuild）。
   */
  buildSchedule: z
    .object({
      /** 用户是否开着自动建图 */
      enabled: z.boolean(),
      /**
       * 当前不建的原因码（`disabled` / `build-in-progress` / `no-new-data` /
       * `below-threshold` / `backoff`），或将要建的原因
       * （`first-build` / `lag-threshold` / `max-age`）。
       *
       * 每一个都要能区分 —— 界面上要说的话完全不同（见
       * `AutoBuildSkipReason` 的注释：一个把人引向错误方向的原因码
       * 比没有原因码更糟）。
       */
      reason: z.string(),
      /** 现在是否满足触发条件（下一轮同步就会开始建） */
      willBuild: z.boolean(),
      /** 自上次成功建图以来的新消息数 */
      pendingMessages: z.number(),
      /** 还差多少条到条数阈值。0 = 已达到 */
      messagesToThreshold: z.number(),
      /** 生效的条数阈值（回显，避免界面另写一份） */
      lagThreshold: z.number(),
      /** 生效的时间阈值（ms） */
      maxAgeMs: z.number(),
      /**
       * 生效的**冷却**（两次建图的最小间隔，ms）。
       *
       * ★ 回显是为了让界面能说出"最小间隔 1 小时，可在设置里改" ——
       * 而不是让它自己写一个 1h 的常量（那样用户改成 6h 之后界面还说 1h）。
       */
      minIntervalMs: z.number(),
      /**
       * 距下次触发还有多久（ms）。
       *
       * `null` = **不由时间决定**（被关闭 / 正在建 / 没有新数据）。
       * ★ 与 `0` 必须区分：0 是"即将开始"，null 是"等下去也不会开始"。
       * 给一个会走到 0 却什么都不发生的倒计时比不给更糟。
       */
      etaMs: z.number().nullable(),
      /** 上次成功建图的时刻；null = 从没建过 */
      lastBuiltAt: z.number().nullable(),
      /** 图谱同步（导出四件套）的周期，供界面解释倒计时的粒度 */
      syncIntervalMs: z.number(),
    })
    .nullable(),
  /**
   * 最近一轮建图**产出了多少**（差值 + 处理量）。`null` = 这次启动还没建过。
   *
   * ## ★★ 为什么与上面那些绝对值分开
   *
   * `entities` / `facts` / `edges` 回答"图里现在有多少"，而用户问的是
   * "刚才那一轮干了什么"。增量建图下两者差别很大：一轮可能只新增几十个实体，
   * 而总数是几百 —— 只报总数的话每轮看起来都"没动"，
   * 而那恰恰让人以为增量没生效。
   *
   * `unitsSkipped` 是**增量收益的唯一证据**：实测一轮
   * 36613 发现 / 2589 跳过 / 34024 处理，也就是缓存真的省下了那 2589 个单元
   * 的 LLM 抽取（那是钱与时间）。
   */
  lastBuild: z
    .object({
      entities: z.number(),
      facts: z.number(),
      edges: z.number(),
      unitsDiscovered: z.number(),
      unitsSkipped: z.number(),
      unitsProcessed: z.number(),
      chunksCreated: z.number(),
    })
    .nullable(),
})

export type KlGraphOverview = z.infer<typeof klGraphOverviewSchema>

/**
 * 优化图谱（`kl improve`，periodic 阶段）的结果。
 *
 * 在建图产出的原始图之上补 SIMILAR_TO 边 + 实体消歧（出网烧 LLM）+ 社群检测。
 * 社群检测建的 `community_L*` 列是 `kl entity` 查询的前提（缺列会 500）。
 * 跑完返回补了多少边/多少社群，失败带原因。
 */
export const klGraphOptimizeResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().nullable(),
  factEdges: z.number(),
  entityEdges: z.number(),
  entityCommunities: z.number(),
  factCommunities: z.number(),
})

export type KlGraphOptimizeResult = z.infer<typeof klGraphOptimizeResultSchema>

/**
 * 以「我」为中心的关系子图（ego graph）。
 *
 * ## ★ 为什么是 ego 图而不是全图
 *
 * 实测本机图谱 2170 实体 / 54826 边 —— 全图画出来是一团毛线：既看不出
 * 结构，也点不准任何一个节点。而用户在这一页要问的是**「我」周围**的事：
 * 我常和谁一起出现、涉及哪些系统与项目、这些关系来自哪个 IM。
 *
 * 所以只取「我」的一跳邻居（上限 `TOP_PEERS`）+ 他们之间的边。
 * 那既是一张能看清的图，也正好是唯一有信息量的那部分。
 *
 * ## ★ 关系是**推导**出来的，因为图里几乎没有 entity↔entity 边
 *
 * 实测边的分布里 `entity SIMILAR_TO entity` 只有 147 条，而
 * `fact ABOUT entity` 有 9661 条。所以"谁和谁有关系"的信号是
 * **同一条 fact 里共现** —— `weight` 就是共现的 fact 数。
 */
export const klGraphEgoSchema = z.object({
  available: z.boolean(),
  /** 不可读或找不到「我」的原因，供 UI 给一句可行动的话。 */
  reason: z.string().nullable(),
  /**
   * 「我」在图里对应的那个实体。
   *
   * ★ 可能为 null：图建好了但里面没有我（身份没确认 / 名字没被抽成实体）。
   * 那时 UI 必须**明说**而不是画一张空图 —— 后者看起来像"功能坏了"。
   */
  self: z.object({ id: z.string(), name: z.string() }).nullable(),
  nodes: z.array(
    z.object({
      id: z.string(),
      /**
       * ★ 真实人名/系统名（本机数据）。可以显示 —— 那是用户自己的数据，
       * 但**绝不能**进日志或导出（见 scripts/check-no-local-data.mjs）。
       */
      name: z.string(),
      type: z.string(),
      mentions: z.number(),
      /** 0 = 我自己，1 = 一跳邻居 */
      hop: z.number(),
      /** 这个关系出现在哪些 IM 渠道（`'dingtalk'` | `'feishu'` …） */
      channels: z.array(z.string()),
    }),
  ),
  edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      /** 共现的 fact 数 —— 边的粗细按它 */
      weight: z.number(),
    }),
  ),
})

export type KlGraphEgo = z.infer<typeof klGraphEgoSchema>

/**
 * 事实检索的入参。
 *
 * ## 为什么这一页需要真正的检索而不是"最近 12 条"
 *
 * 图谱里有 6663 条事实、跨一整月。"最近 12 条"回答不了任何具体问题 ——
 * 而用户会问的是"上周关于沙箱的决策有哪些""小吴这个月说过什么"。
 * 那要求时间范围 + 类型 + 实体 + 关键词四个维度。
 */
export const klGraphFactsInputSchema = z.object({
  /**
   * 时间范围的天数。null = 全部。
   *
   * 用天数而不是一对时间戳：预设（7/30/90）是用户真正会点的东西，
   * 而"自定义起止"在这一页还没有人要过 —— 加了就是一个没人用的日历控件。
   */
  days: z.number().int().positive().nullable(),
  /** 只要这些 fact 类型；空数组 = 全部 */
  types: z.array(z.string()).max(16),
  /** 只看与这个实体（按名字精确匹配）相关的事实；null = 不限 */
  entityName: z.string().max(200).nullable(),
  /**
   * 正文关键词。
   *
   * ★ 服务端会把它当成**短语**送进 fts5（而不是原样拼进 MATCH）——
   * 用户输入里的 `"` / `*` / `NEAR(` 都有 FTS 语法含义，原样传会抛错。
   */
  keyword: z.string().max(200),
  limit: z.number().int().positive().max(100),
  offset: z.number().int().nonnegative(),
  /**
   * 只看这一个渠道的事实。**可选**，不给 = 全部渠道合并。
   *
   * ## ★ 为什么"可选"这件事本身有意义
   *
   * 两个消费者要的语义**不同**，而这个字段正是区分它们的开关：
   * · **仪表盘展示** → 传它。那一页是"看某个渠道的图谱"，与 ego 图同一个
   *   取值范围（页头那枚筹码管整页）。混着显示会让用户以为两边的事实
   *   在同一条线索上，而它们的 external_id 体系不同。
   * · **搜索** → 不传。那里保留混合检索（每条带 channelId 徽章，来源清楚，
   *   而且"跨渠道找一件事"正是搜索的价值）。
   */
  channelId: z.string().min(1).optional(),
})

export type KlGraphFactsInput = z.infer<typeof klGraphFactsInputSchema>

export const klGraphFactsSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  /** 满足当前筛选的总条数（分页与"共 N 条"都用它） */
  total: z.number(),
  facts: z.array(
    z.object({
      id: z.string(),
      /**
       * ★ 真实聊天内容（本机数据）。可以上屏 —— 那是用户自己的数据，
       * 但**绝不能**进日志或导出（见 scripts/check-no-local-data.mjs）。
       */
      text: z.string(),
      type: z.string(),
      confidence: z.number(),
      at: z.number().nullable(),
      /** 事实来自哪个物理隔离的渠道图库。旧数据/旧客户端可不带。 */
      channelId: z.string().min(1).optional(),
      /** 这条事实在说谁/什么（最多 4 个实体名） */
      entities: z.array(z.string()),
    }),
  ),
  /**
   * 查询**失败**的渠道图库。**可选**（无失败时省略，旧渲染层不改也能跑）。
   *
   * ## ★★ 为什么必须能表达
   *
   * 多图库查询的判据是"任一图有结果就算成功"—— 那对**降级**是对的
   * （一个渠道的图坏了不该让整个检索失败），但它同时把失败**吞掉**了：
   * 用户看到的是一个正常的结果列表，只是少了一半来源，且没有任何痕迹。
   *
   * 这与本仓库的硬规则同源：**不可读必须与"0 条"可区分**。
   */
  failedSources: z.array(z.object({ channelId: z.string(), reason: z.string() })).optional(),
})

export type KlGraphFacts = z.infer<typeof klGraphFactsSchema>

// ---------------------------------------------------------------
// 仪表盘趋势与消化漏斗
// ---------------------------------------------------------------

/**
 * 仪表盘的**时序 + 漏斗**数据。
 *
 * ## ★★ 为什么它不塞进 `IngestSnapshot`
 *
 * 那个快照是**热路径**：`ingest.service.ts` 的 `persist()` 每批都要发一次，
 * 而它已经是 9 个全表 COUNT。那里记过一次实测教训 —— 逐条触发时
 * 20 万条累计约 21 分钟主进程阻塞（0.29ms@1万 → 6.31ms@20万）。
 *
 * 而按天分桶**比那些 COUNT 更贵**：本机 32,878 行实测
 * 「带 direction/has_media 的 90 天分桶」耗时 **108ms**
 * （要回表，覆盖索引失效）。按同比例外推，20 万条时约 650ms 一次。
 * 塞进快照就等于给每一批采集加半秒阻塞 —— 那是重演已经修过的 bug。
 *
 * 所以它是**独立通道 + 按 changelog head 缓存**：head 没动就直接返回上次
 * 结果（`ChangelogRepository.head()` 实测 1ms）。
 *
 * ## ★ 为什么漏斗比"图里有多少"重要
 *
 * 现有 `KlGraphOverview` 回答"图里现在有多少实体/事实"。但本机实测：
 * 32,878 条消息进去，落地 **975** 条 fact，而 `graph-build` 消费者的
 * `acked_seq` 只有 2,871 —— changelog head 是 34,142，**落后 31,271 条，
 * 只消化了 8.4%**。
 *
 * 界面上完全看不出来：实体数在涨、无错误、状态正常。唯一的症状是
 * "结论有点少"，而"少"没有参照物。这正是本仓库最贵的那类 bug
 * （静默降级，CLAUDE.md §4）。漏斗把每一级的绝对值摊开，
 * 缺口就有了参照物。
 */
export const dashboardTrendsSchema = z.object({
  /**
   * 按天分桶的数据量。
   *
   * ## ★★ 空洞天必须由**服务端**补 0，不能只返回有数据的天
   *
   * 本机实测 90 天窗口里只有 **79 天**有消息（周末与假期）。
   * 缺的那 11 天如果不在数组里，`type="monotone"` 会把缺口两端的点
   * 连成一条**平滑曲线** —— 于是"那几天一条消息都没有"在图上表现为
   * "那几天数据量平稳" 。凭空造出一个不存在的趋势，且不报任何错。
   *
   * 补 0 之后曲线会掉到底，那才是真相。
   */
  days: z.array(
    z.object({
      /** 当天 00:00 的 unix ms（本地时区）。x 轴用它 */
      at: z.number(),
      /** 收到的消息数 */
      inbound: z.number(),
      /** 发出的消息数 */
      outbound: z.number(),
      /** 带媒体的消息数 */
      media: z.number(),
      /**
       * 当天的消息里有多少**进了图谱**（已切块）。
       *
       * ★ 与 `inbound+outbound` 画在同一张图上时，两条线的裂口就是
       * "图谱落后"在时间上的分布 —— 比一个总数更能说明落后在哪一段。
       * 图库不可读时恒 0（此时 `graphAvailable` 为 false，UI 据此不画这条线）。
       */
      chunks: z.number(),
    }),
  ),
  /**
   * 消化漏斗的五级绝对值。
   *
   * ★ 只给绝对值，**比率交给 UI 算** —— 口径留在一处（`dashboard-data.ts`）。
   * 两边各算一次除法迟早漂移，而那时界面上两个百分比不一致。
   *
   * ★ **不含 `edges`**：那张表在默认后端（ladybug）下按设计恒空
   * （实测 `/status` 报 26,558 而 `SELECT COUNT(*) FROM edges` 得 0，
   * 完整推理见 `graph-query.service.ts` 的 `factsOfEntity` 注释）。
   * 放进漏斗会显示成"边全丢了"。
   */
  funnel: z.object({
    /** 采集侧的消息总数 */
    messages: z.number(),
    /** kl 侧登记的处理单元数 */
    units: z.number(),
    /**
     * 处理单元**按来源分类**（`type` = kl 原始 source_type：message/minutes/wiki…，
     * 友好名字映射在渲染层 i18n）。面板据此说"处理了 N 条聊天、M 条会议记录"，
     * 而不是一个笼统的总数。空数组 = 旧库没有 units 表 / 还没建图。
     */
    unitsByType: z.array(z.object({ type: z.string(), count: z.number() })),
    /** 切出来的块数 */
    chunks: z.number(),
    /** 抽出来的事实数 */
    facts: z.number(),
    /** 抽出来的实体数 */
    entities: z.number(),
  }),
  /**
   * 图谱建图落后多少（消费者水位对账）。
   *
   * ★ `build` 与 `export` 必须**分开**：实测本机 export 已到 34,106
   * （只差 36，正常），而 build 停在 2,871。只报一个"图谱落后"
   * 会把人引向错误的排查方向 —— 卡住的是建图，不是导出。
   */
  graphLag: z.object({
    /** changelog 的头（分母） */
    head: z.number(),
    /** `graph-build` 消费者的 acked_seq */
    build: z.number(),
    /** `graph-export` 消费者的 acked_seq */
    export: z.number(),
  }),
  /**
   * 三组覆盖度。**分子分母都给** —— UI 不做除法之外的推断。
   *
   * 每一组都是一个真实的、当前不可见的缺口（本机实测）：
   * · fact 有时间戳 450/975（**54% 没有**，CAUSAL 类高达 70%）；
   * · 媒体已下载 10/2,844（**0.35%** —— "有 2844 张图"与"能看 10 张图"是两件事）；
   * · 社群有摘要 4/16，另有 7 个标了 stale。
   */
  coverage: z.object({
    /** 有时间戳的 fact / 全部 fact。★ 无时间戳的那些进不了任何时序图 */
    factsTimestamped: z.object({ done: z.number(), total: z.number() }),
    /** 已下载到本地的媒体 / 全部媒体资产 */
    mediaDownloaded: z.object({ done: z.number(), total: z.number() }),
    /** 有摘要的社群 / 全部社群，以及摘要已过期的个数 */
    communitySummaries: z.object({
      done: z.number(),
      total: z.number(),
      stale: z.number(),
    }),
  }),
  /**
   * 图库能不能读。
   *
   * ## ★ 为什么必须与"全 0"区分
   *
   * `false` = 还没建过图（文件不存在 / 没 schema）。那时 `funnel` 的后三级
   * 与 `coverage` 里图谱那两组都是 0 —— 而"没建过图"与"建了但一条都没抽到"
   * 的处置完全不同（前者去点建图，后者要查为什么抽空）。
   *
   * UI 据此把后三级显示成 `—` 而不是 `0`：把"不知道"显示成"零"
   * 会让一个新装的库看起来像一个坏掉的库。
   */
  graphAvailable: z.boolean(),
  /** 这份数据覆盖的窗口天数（回显入参，避免 UI 另写一份） */
  windowDays: z.number(),
  /**
   * 库里**实际有数据**的天数。
   *
   * ★ 与 `windowDays` 分开：用户点「近 90 天」而库里只有 89 天跨度
   * （本机实测 5-12 → 8-10）时，界面必须能说"实际覆盖 89 天"——
   * 否则那张图看起来像是最早那一天之前的数据都是 0，
   * 而真相是那之前**没有采集**。
   */
  daysWithData: z.number(),
})

export type DashboardTrends = z.infer<typeof dashboardTrendsSchema>

/** 仪表盘趋势的入参。 */
export const dashboardTrendsInputSchema = z.object({
  /**
   * 窗口天数。与 `klGraphFactsInputSchema.days` 同一套预设（7/30/90），
   * 刻意不做自定义起止 —— 那是一个还没有人要过的日历控件。
   */
  days: z.number().int().positive().max(400),
})

export type DashboardTrendsInput = z.infer<typeof dashboardTrendsInputSchema>

// ---------------------------------------------------------------
// 高级 AI 配置（隐藏入口）
// ---------------------------------------------------------------

/**
 * 需求原文要求「隐藏的地方可以极客配置自己的 ai，harness & llm model」。
 *
 * ★ 一条硬约束：这份配置**不影响**发送门禁与自动回复策略 ——
 * 配的是"用什么脑子"，不是"能不能动手"。
 */
export const advancedAiConfigViewSchema = z.object({
  baseUrl: z.string(),
  /** 只给后 4 位：UI 上能看到完整 key 就意味着任何能截图的人都能拿到它 */
  apiKeyTail: z.string().nullable(),
  modelRoles: z.record(z.string(), z.string()),
  harness: z.record(z.string(), z.string()),
  /** 逃生阀：覆盖上面所有推导的原文 JSON */
  rawConfigJson: z.string().nullable(),
})

export type AdvancedAiConfigView = z.infer<typeof advancedAiConfigViewSchema>

export const saveAdvancedAiInputSchema = z.object({
  baseUrl: z.string().max(2000),
  /** null = 不改（"没填"必须与"清空"可区分，因为 UI 不回显旧 key） */
  apiKey: z.string().max(500).nullable(),
  modelRoles: z.record(z.string(), z.string().max(200)),
  harness: z.record(z.string(), z.string().max(50)),
  rawConfigJson: z.string().max(100_000).nullable(),
})

/**
 * 自备 dws 的路径配置。
 *
 * 随包分发的是**开源版**（npm 依赖）；闭源版不随仓库分发，只能由用户
 * 自己装好再指路径。这份配置就是那个入口，**兜底永远是随包那份**。
 */
export const dwsSourceViewSchema = z.object({
  /** 用户在 UI 上填的路径；null = 没填 */
  configuredPath: z.string().nullable(),
  /**
   * `.env` / 环境变量（`MYCONTEXT_DWS_SOURCE`）里那条；null = 没配。
   *
   * 与 `configuredPath` 分开：UI 要能说清"这条从 .env 来"，否则开发者
   * 在 `.env` 里配了却看到输入框是空的，会以为配置丢了。
   * 优先级 UI 值 > 这个 > 随包那份。
   */
  pathFromDefaults: z.string().nullable(),
  /**
   * 设了但那个文件现在用不了（换机器 / 卸载了）。
   *
   * ★ 单独一个字段而不是把 configuredPath 清空：UI 必须能说出
   * 「你设的那个找不到了，现在用的是随包版」——若直接清空，
   * 用户会以为自己没设过，而那条路径其实还在库里。
   */
  configuredMissing: z.boolean(),
  /** 实际生效的是哪一份 */
  effectiveSource: z.enum(["custom", "bundled"]),
  /** 实际生效那份的 `--version` 首行；null = 连版本都读不出来 */
  effectiveVersion: z.string().nullable(),
  /**
   * 用户填的渠道号（`DWS_CHANNEL`）；null = 没填。
   *
   * ★ 它是**自有 dws 的附属项**：渠道号与二进制内置的 OAuth 身份配套，
   * 所以只在用了自有 dws 时才生效（见 `channelActive`）。
   *
   * ★ 回显**完整值**（与 apiKey 不同）：它是分发方标识而不是密钥，
   * 看不到旧值反而没法确认"我填的是不是那个"。
   */
  channelCode: z.string().nullable(),
  /**
   * 来自默认层（`.env` / 环境变量）的渠道号；null = 默认层也是空。
   *
   * 与 `channelCode` 分开，UI 才能区分"我在这儿填的"与"从环境来的" ——
   * 否则开发者在 `.env` 里配了却在 UI 上看到空，会以为配置丢了。
   */
  channelFromDefaults: z.string().nullable(),
  /**
   * 用户填的渠道号此刻是否生效（= 是否正在用自有 dws）。
   *
   * "填了但没生效"必须能说出来：否则用户填完看不出任何变化，
   * 会以为保存失败了。
   */
  channelActive: z.boolean(),
})

export type DwsSourceView = z.infer<typeof dwsSourceViewSchema>

/**
 * 两项独立可改：字段**缺省** = 这一项不改，`null`/空串 = 清除。
 *
 * ★ patch 而不是整份覆盖：两项的生命周期不同（路径是"装了闭源版才填"、
 * 渠道号是"组织限定了渠道才填"），整份覆盖会让"只想改渠道号"的请求
 * 把路径顺手清掉，而那是静默的数据丢失。
 */
export const saveDwsSourceInputSchema = z.object({
  path: z.string().max(4000).nullable().optional(),
  channelCode: z.string().max(200).nullable().optional(),
})

// ---------------------------------------------------------------
// 模型网关运行时配置（用户可见，单一真源）
// ---------------------------------------------------------------

/**
 * 一个配置项的展示形态。
 *
 * 敏感项（apiKey）只给 `configured` + 后 4 位 `tail`，不回显明文 ——
 * 与状态页的 `configEntryViewSchema` 同一个理由：能看到完整 key 就意味着
 * 任何能截图的人都能拿到它。`source` 表明这一项当前的值从哪来
 * （用户在设置里存的 / .env / 真实环境变量 / 内置默认）。
 */
export const runtimeConfigFieldSchema = z.object({
  value: z.string(),
  source: z.enum(["user", "env", "dotenv", "default"]),
})

export const runtimeConfigSecretFieldSchema = z.object({
  configured: z.boolean(),
  /** 已配置时给后 4 位，未配置为 null */
  tail: z.string().nullable(),
  source: z.enum(["user", "env", "dotenv", "default"]),
})

/**
 * 模型网关配置视图。
 *
 * 主配置（`llm*` / `modelMain` / `embedModel`）+ KL 专用三项。
 * KL 三项留空表示「回退主配置」，所以视图里额外给 `klEffective*`
 * （真正会用到的值，已解析回退），让 UI 能显示「当前实际用的是 X」。
 */
export const runtimeConfigViewSchema = z.object({
  llmBaseUrl: runtimeConfigFieldSchema,
  llmApiKey: runtimeConfigSecretFieldSchema,
  modelMain: runtimeConfigFieldSchema,
  embedModel: runtimeConfigFieldSchema,
  klLlmBaseUrl: runtimeConfigFieldSchema,
  klLlmApiKey: runtimeConfigSecretFieldSchema,
  klModelMain: runtimeConfigFieldSchema,
  /** KL 回退解析后**实际生效**的三项（明文 base/model，key 只给 configured） */
  klEffective: z.object({
    baseUrl: z.string(),
    model: z.string(),
    apiKeyConfigured: z.boolean(),
  }),
})

export type RuntimeConfigView = z.infer<typeof runtimeConfigViewSchema>

/**
 * 保存模型网关配置。
 *
 * 每个字符串字段都可选：只改主模型时不该动 baseUrl。apiKey 用
 * `string | null | undefined` 三态：undefined = 不改，null = 清空，
 * 字符串 = 设为新值（UI 不回显旧 key，"没填"必须与"清空"可区分）。
 * KL 字段留空字符串即「回退主配置」。
 */
export const saveRuntimeConfigInputSchema = z.object({
  llmBaseUrl: z.string().max(2000).optional(),
  llmApiKey: z.string().max(500).nullable().optional(),
  modelMain: z.string().max(200).optional(),
  embedModel: z.string().max(200).optional(),
  klLlmBaseUrl: z.string().max(2000).optional(),
  klLlmApiKey: z.string().max(500).nullable().optional(),
  klModelMain: z.string().max(200).optional(),
})

export type SaveRuntimeConfigInput = z.infer<typeof saveRuntimeConfigInputSchema>

/**
 * save 返回：哪些消费点已即时生效、哪些要下次子进程重启。
 * UI 据此显示分级横幅（诚实标注，不假装全部实时）。
 */
export const runtimeConfigApplySchema = z.object({
  /** 进程内消费者（数字人直连、autoBuild 判定）已即时生效 */
  appliedNow: z.boolean(),
  /** 需要重启子进程才生效的模块（opencode agent / kl-server） */
  needsRestart: z.array(z.enum(["agent", "klServer"])),
})

export type RuntimeConfigApply = z.infer<typeof runtimeConfigApplySchema>

/**
 * 探测网关（「测试连接」按钮）。
 *
 * ★ 为什么这个动作值得存在：模型名填错**不会当场报错** ——
 * 它在几小时后的蒸馏/建图里表现为 `model_not_found`，而那个错是静默的
 * （日志里一行，界面上什么都没有）。一次探测把「几小时后静默失败」
 * 变成「现在当场告诉你」。
 *
 * 而同一次请求顺带解决第二件事：`/v1/models` 的返回**就是**可选模型列表，
 * 于是模型名可以从"猜着填的输入框"变成"从列表里挑"。
 *
 * 探测用**草稿值**（用户正在输入还没保存的），不是已存的配置 ——
 * 否则「先存错的再测」这个顺序就没法用了。
 */
export const probeRuntimeConfigInputSchema = z.object({
  /** 留空则用当前已解析的值（可只测 key、不重填 URL） */
  baseUrl: z.string().max(2000).optional(),
  /** 留空则用已存的 key（UI 不回显，所以"不改 key 只测连通"要能表达） */
  apiKey: z.string().max(500).optional(),
})

export type ProbeRuntimeConfigInput = z.infer<typeof probeRuntimeConfigInputSchema>

export const runtimeConfigProbeSchema = z.object({
  ok: z.boolean(),
  /**
   * 失败原因分类。UI 据此给可照做的下一步，而不是抛一段英文报文：
   * · `unauthorized` —— key 不对（HTTP 401/403）
   * · `unreachable` —— 地址连不上（DNS/超时/拒连）
   * · `badResponse` —— 连上了但不是 OpenAI 兼容的 /v1/models（多半 URL 填到了别处）
   * · `noKey` —— 还没填 key
   */
  reason: z.enum(["unauthorized", "unreachable", "badResponse", "noKey"]).nullable(),
  /** 网关原文（截断）。放在折叠区里给会看的人，不直接怼到界面上 */
  detail: z.string().nullable(),
  /** 探到的模型 id 列表（成功时非空）。UI 用它做模型选择器 */
  models: z.array(z.string()),
})

export type RuntimeConfigProbe = z.infer<typeof runtimeConfigProbeSchema>
