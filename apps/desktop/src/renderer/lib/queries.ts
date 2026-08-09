/**
 * react-query 封装：查询 key 与 mutation 集中定义，避免各组件各写一套 key。
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { resolveLanguage } from "@mycontext/i18n"
import type {
  AuthMode,
  AuthProgress,
  SaveRuntimeConfigInput,
  ProbeRuntimeConfigInput,
  Credentials,
  DistillScopeInput,
  DistillSourceId,
  KlGraphFactsInput,
  KlServerStatus,
  LanguagePreference,
  OnboardingStepId,
  PersonaRuntimeLimits,
  PersonaTraceItem,
  SaveIngestIntervalsInput,
  UpdateProfileInput,
} from "@mycontext/ipc-contract"
import { unwrap } from "./api.js"

export const QUERY_KEYS = {
  bootstrap: ["bootstrap"] as const,
  status: ["status"] as const,
  channels: ["channels"] as const,
  ingest: ["ingest"] as const,
  /** 已解析的本人身份（只读）。与 ingest 分开：它变化频率低得多 */
  selfIdentity: ["self-identity"] as const,
  /** 本机是否有一份可采纳的渠道登录态（见 useAdoptableSession） */
  adoptableSession: ["adoptable-session"] as const,
  /** 这个账号下的全部渠道身份（身份切换器） */
  channelIdentities: ["channel", "identities"] as const,
  feed: ["feed"] as const,
  searchSessions: ["search", "sessions"] as const,
  advancedAi: ["advanced-ai"] as const,
  dwsSource: ["dws-source"] as const,
  runtimeConfig: ["runtime-config"] as const,
  onboardingSteps: ["onboarding", "steps"] as const,
  distillSources: ["distill", "sources"] as const,
  channelConversations: ["channel", "conversations"] as const,
  distillProgress: ["distill", "progress"] as const,
  personaSnapshot: ["persona", "snapshot"] as const,
  personaConversations: ["persona", "conversations"] as const,
  personaDrafts: ["persona", "drafts"] as const,
  personaLimits: ["persona", "limits"] as const,
  ingestIntervals: ["ingest", "intervals"] as const,
}

export function useBootstrapState() {
  return useQuery({
    queryKey: QUERY_KEYS.bootstrap,
    queryFn: async () => unwrap(await window.mycontext.app.bootstrapState()),
  })
}

export function useStatusReport(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.status,
    queryFn: async () => unwrap(await window.mycontext.app.statusReport()),
    enabled,
  })
}

/** 认证类操作成功后都要刷新 bootstrap（它决定渲染登录页还是主壳）。 */
function useAuthMutation<TInput>(perform: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: perform,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.status })
    },
  })
}

export function useRegister() {
  return useAuthMutation<Credentials>(async (input) =>
    unwrap(await window.mycontext.auth.register(input)),
  )
}

export function useLogin() {
  return useAuthMutation<Credentials>(async (input) =>
    unwrap(await window.mycontext.auth.login(input)),
  )
}

export function useLogout() {
  return useAuthMutation<void>(async () => unwrap(await window.mycontext.auth.logout()))
}

// ---------------------------------------------------------------
// IM 渠道
// ---------------------------------------------------------------

export function useChannels() {
  return useQuery({
    queryKey: QUERY_KEYS.channels,
    queryFn: async () => unwrap(await window.mycontext.channels.list()),
    // 查询会 spawn 子进程，别在窗口聚焦时反复跑。
    staleTime: 30_000,
  })
}

/** 授权成功后要刷三处：渠道列表、bootstrap（账号 session + 头像）、self-identity（渠道花名）。 */
function useChannelMutation<TInput>(perform: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: perform,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.channels })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap })
      /**
       * ★ selfIdentity 也必须失效 —— 授权改的身份不止 bootstrap 里那份**账号**
       * session（displayName/avatarUrl），还有这份**渠道**身份（钉钉花名、
       * openId 列表，见 self-identity-panel / dashboard）。漏掉它的表现是：
       * 重新授权后侧栏头像刷新了，而身份面板里的渠道花名还是旧的 ——
       * 两份身份分别缓存，只失效一份就只刷一半。
       */
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.selfIdentity })
    },
  })
}

export function useStartChannelAuth() {
  return useChannelMutation<{ channelId: string; mode: AuthMode }>(async (input) =>
    unwrap(await window.mycontext.channels.authStart(input)),
  )
}

export function useCancelChannelAuth() {
  return useChannelMutation<{ channelId: string }>(async (input) =>
    unwrap(await window.mycontext.channels.authCancel(input)),
  )
}

/** 订阅授权进度事件。组件卸载时自动退订。 */
export function useAuthProgress(
  channelId: string,
  onProgress: (progress: AuthProgress) => void,
): void {
  // 用 ref 存回调：避免调用方每次渲染都传新函数导致反复订阅。
  const handler = useRef(onProgress)
  handler.current = onProgress

  useEffect(() => {
    return window.mycontext.channels.onAuthProgress((event) => {
      if (event.channelId !== channelId) return
      handler.current(event.progress)
    })
  }, [channelId])
}

/**
 * 本机有一份**可采纳**的渠道登录态吗（查询，无副作用）。
 *
 * ## ★ 这个状态是什么
 *
 * dws 的登录态按**系统用户**共享（token 密钥在 Keychain，`DWS_CONFIG_DIR`
 * 隔离不了它），所以新注册的账号可能一进来就是"已授权" —— 而那份登录态
 * 属于这台机器，不属于这个账号：身份行、头像、显示名都还没落库。
 *
 * `data` 为 `null` = 没有可采纳的（已有身份行，或本机确实未授权）。
 *
 * ★ 只在**已授权**时查（`enabled`）：未授权时答案必然是 null，
 * 而这个查询会跑一次 `auth status`（子进程）—— 白花。
 */
export function useAdoptableSession(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.adoptableSession,
    queryFn: async () => unwrap(await window.mycontext.channels.adoptableSession()),
    enabled,
  })
}

/**
 * 采纳本机已有的登录态：落身份行 + 回填账号头像与显示名。
 *
 * ## ★ 为什么是 mutation（用户点出来的），不是登录后自动跑
 *
 * 首版是自动的，两个真问题（详见 `adoptExistingSession` 的注释）：
 * 它**替用户决定了用哪个身份** —— 而一旦自动写进身份行，用户之后真去
 * 授权换组织时会撞 `SELF_IDENTITY_CONFLICT`，也就是自动补跑自己制造了
 * 那个冲突；以及它在用户没操作时就 spawn 2-3 次子进程。
 *
 * 走 `useChannelMutation` 复用那套失效逻辑（渠道列表 + bootstrap +
 * selfIdentity）—— 采纳改的正是同样那几样东西，与授权那条路一致。
 * 顺带把 `adoptableSession` 也失效掉：采纳成功后它应该变成 null。
 */
export function useAdoptSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await window.mycontext.channels.adoptSession()),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.channels })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.selfIdentity })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adoptableSession })
    },
  })
}

/**
 * 这个账号下的全部渠道身份（身份切换器的数据源）。
 *
 * 一个人可能在多个组织里各有一个身份，每个身份一份独立的数据 ——
 * 隔离维度是 `(channelId, corpId, userId)`。未登录时主进程给空数组。
 */
export function useChannelIdentities(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.channelIdentities,
    queryFn: async () => unwrap(await window.mycontext.channels.identityList()),
    enabled,
  })
}

/**
 * 切到另一个渠道身份。
 *
 * ## ★★ 切完要把**几乎所有**缓存都作废
 *
 * 这不是"刷新一个字段"，而是换了一整份数据：会话、消息、画像、图谱、
 * 数字人配置、引导进度全部跟着变。漏掉任何一个 key 的表现是
 * "切了身份但某一块还显示上一个人的东西" —— 而那正是这轮要修的那类
 * 静默错误换了个位置（只不过这次在渲染层）。
 *
 * 所以这里**不逐个列**，直接 `invalidateQueries()` 全清 —— 少列一个的
 * 代价（显示别人的数据）远大于多刷几个查询的代价。
 */
export function useSwitchChannelIdentity() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { channelId: string; corpId: string; userId: string }) =>
      unwrap(await window.mycontext.channels.identitySwitch(input)),
    // ★ 全清：见上面的注释（漏一个 key 就是显示上一个身份的数据）
    onSettled: () => void queryClient.invalidateQueries(),
  })
}

// ---------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------

export function useCompleteOnboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await window.mycontext.onboarding.complete()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap }),
  })
}

export function useSkipOnboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await window.mycontext.onboarding.skip()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap }),
  })
}

/**
 * 四步进度。引导页据此决定停在哪一步、回填哪些表单。
 *
 * `enabled` 让未登录时不查：那时主进程还没绑 vault，查了只会拿到空数组
 * —— 而空数组与"四步都还没做"在 UI 上无法区分。
 */
export function useOnboardingSteps(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.onboardingSteps,
    queryFn: async () => unwrap(await window.mycontext.onboarding.steps()),
    enabled,
  })
}

/**
 * 单步完成/跳过后要刷两处：进度本身，以及 bootstrap
 * （四步全非 pending 时 `needsOnboarding` 会翻成 false）。
 */
function useStepMutation<TInput>(perform: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: perform,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.onboardingSteps })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap })
    },
  })
}

export function useCompleteStep() {
  return useStepMutation<{ step: OnboardingStepId; payload?: unknown }>(async (input) =>
    unwrap(await window.mycontext.onboarding.stepDone(input)),
  )
}

export function useSkipStep() {
  return useStepMutation<{ step: OnboardingStepId }>(async (input) =>
    unwrap(await window.mycontext.onboarding.stepSkip(input)),
  )
}

export function useRestartOnboarding() {
  return useStepMutation<void>(async () => unwrap(await window.mycontext.onboarding.restart()))
}

// ---------------------------------------------------------------
// 蒸馏资料源
// ---------------------------------------------------------------

export function useDistillSources(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.distillSources,
    queryFn: async () => unwrap(await window.mycontext.distill.sources()),
    enabled,
  })
}

function useDistillMutation<TInput>(perform: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: perform,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.distillSources }),
  })
}

export function useSaveDistillSource() {
  return useDistillMutation<{
    /**
     * 存哪个渠道的范围。★★★ 必填 —— 见
     * `distillSourceSaveInputSchema.channelId`（旧形状造成过一次数据丢失：
     * 在飞书那栏保存把钉钉的会话白名单清空了）。
     */
    channelId: string
    kind: DistillSourceId
    enabled: boolean
    scope: DistillScopeInput
  }>(async (input) => unwrap(await window.mycontext.distill.sourceSave(input)))
}

export function useResetDistillSource() {
  return useDistillMutation<{ kind: DistillSourceId }>(async (input) =>
    unwrap(await window.mycontext.distill.sourceReset(input)),
  )
}

/**
 * 清空当前渠道的数据（**不可逆**）。
 *
 * 用法是两步：先 `mutate({ dryRun: true })` 拿到条数给用户看，确认后再
 * `mutate({ dryRun: false })`。默认 `dryRun: true` 由契约层保证 ——
 * 这里也显式传，让调用点读起来没有歧义。
 *
 * 清完后**把全部缓存作废**（不只是 distillSources）：库刚被清空，
 * 消息数、图谱概览、数字人待处理、蒸馏进度全都变了。只失效一个 key 的话
 * 界面上会留着一堆清空前的数字，而那与"没生效"看起来一样。
 */
export function useWipeChannelData() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { dryRun: boolean; dropSearch?: boolean }) =>
      unwrap(await window.mycontext.channels.dataWipe(input)),
    onSuccess: (_result, variables) => {
      // 预演不改库 —— 那时作废缓存只会白刷一遍（snapshot 有全表 COUNT）
      if (variables.dryRun) return
      void queryClient.invalidateQueries()
    },
  })
}

/**
 * 会话列表（选蒸馏范围用）。
 *
 * `staleTime` 给得长：它要 spawn 三次 DWS 子进程（实测约 4.8s），
 * 而"我能看到哪些群"这件事分钟级内不会变。
 * `enabled` 交给调用方 —— 只有真的展开了会话选择器才值得付这 4.8s。
 */
// ---------------------------------------------------------------
// 蒸馏执行
// ---------------------------------------------------------------

/**
 * 蒸馏进度。
 *
 * 同时**订阅推送**：蒸馏是分钟级的过程，轮询要么太频要么太疏
 * （看起来卡住）。推送让"刚跑完一个任务"立刻可见 —— 那是用户判断
 * "它还在动"的唯一依据。
 */
export function useDistillProgress(enabled = true) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: QUERY_KEYS.distillProgress,
    queryFn: async () => unwrap(await window.mycontext.distill.progress()),
    enabled,
  })

  useEffect(() => {
    if (!enabled) return
    return window.mycontext.distill.onProgress((progress) => {
      // 直接写缓存而不是 invalidate：省一次往返，且推来的就是完整快照
      queryClient.setQueryData(QUERY_KEYS.distillProgress, progress)
    })
  }, [enabled, queryClient])

  return query
}

export function useStartDistill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { days?: number | null; windowDays?: number }) =>
      unwrap(await window.mycontext.distill.start(input)),
    onSuccess: (progress) => {
      queryClient.setQueryData(QUERY_KEYS.distillProgress, progress)
    },
  })
}

export function useResetDistill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await window.mycontext.distill.reset()),
    onSuccess: (progress) => {
      queryClient.setQueryData(QUERY_KEYS.distillProgress, progress)
    },
  })
}

// ---------------------------------------------------------------
// 数字人
// ---------------------------------------------------------------

/** 数字人状态 + 订阅推送（新消息提醒与草稿数都靠它）。 */
export function usePersonaSnapshot(enabled = true) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: QUERY_KEYS.personaSnapshot,
    queryFn: async () => unwrap(await window.mycontext.persona.snapshot()),
    enabled,
  })

  useEffect(() => {
    if (!enabled) return
    return window.mycontext.persona.onSnapshot((snapshot) => {
      queryClient.setQueryData(QUERY_KEYS.personaSnapshot, snapshot)
      // 快照变了通常意味着会话的「待处理」数也变了 —— 顺手刷会话列表
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.personaConversations })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.personaDrafts })
      // 当前会话内容与处理结果也会在同一轮变化，不能等切换会话才刷新。
      void queryClient.invalidateQueries({ queryKey: ["persona", "messages"] })
      void queryClient.invalidateQueries({ queryKey: ["persona", "activities"] })
    })
  }, [enabled, queryClient])

  return query
}

export function usePersonaConversations(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.personaConversations,
    queryFn: async () => unwrap(await window.mycontext.persona.conversations()),
    enabled,
  })
}

/**
 * 会话消息。
 *
 * `includeIds` 是草稿的 `citations` —— 它们**必须**进 queryKey：
 * 不进的话点「看引用」拿不到新数据（react-query 认为这个 query 没变），
 * 而那些消息通常在"最近 80 条"之外，于是点了没有任何反应。
 */
export function usePersonaMessages(
  conversationId: string | null,
  includeIds: readonly string[] = [],
) {
  const idsKey = [...includeIds].sort().join(",")
  return useQuery({
    queryKey: ["persona", "messages", conversationId, idsKey] as const,
    queryFn: async () =>
      unwrap(
        await window.mycontext.persona.messages({
          conversationId: conversationId ?? "",
          limit: 80,
          ...(includeIds.length === 0 ? {} : { includeIds: [...includeIds] }),
        }),
      ),
    enabled: conversationId !== null,
  })
}

export function usePersonaRuns(conversationId: string | null) {
  return useQuery({
    queryKey: ["persona", "runs", conversationId] as const,
    queryFn: async () =>
      unwrap(await window.mycontext.persona.runs({ conversationId: conversationId ?? "" })),
    enabled: conversationId !== null,
  })
}

export function usePersonaActivities(conversationId: string | null) {
  return useQuery({
    queryKey: ["persona", "activities", conversationId] as const,
    queryFn: async () =>
      unwrap(await window.mycontext.persona.activities({ conversationId: conversationId ?? "" })),
    enabled: conversationId !== null,
  })
}

/** 群成员（发过言的人）。只在会话设置弹窗打开时才查（`enabled`）。 */
export function usePersonaMembers(conversationId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["persona", "members", conversationId] as const,
    queryFn: async () =>
      unwrap(await window.mycontext.persona.members({ conversationId: conversationId ?? "" })),
    enabled: enabled && conversationId !== null,
    // 成员是"发过言的人"，一次会话里变化很慢 —— 别每次打开弹窗都重查
    staleTime: 60_000,
  })
}

/**
 * 会话内搜索聊天记录。
 *
 * ★ `keepPreviousData`：输入时逐字触发查询，不留上一次结果的话
 * 列表会在每次击键时闪一下空白。搜索是交互式的，闪白比慢一点更糟。
 */
export function usePersonaMessageSearch(conversationId: string | null, query: string) {
  const trimmed = query.trim()
  return useQuery({
    queryKey: ["persona", "search-messages", conversationId, trimmed] as const,
    queryFn: async () =>
      unwrap(
        await window.mycontext.persona.searchMessages({
          conversationId: conversationId ?? "",
          query: trimmed,
        }),
      ),
    enabled: conversationId !== null && trimmed !== "",
    placeholderData: keepPreviousData,
  })
}

export function usePersonaDrafts(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.personaDrafts,
    queryFn: async () => unwrap(await window.mycontext.persona.drafts()),
    enabled,
  })
}

/** 会话配置变更后要刷会话列表与快照（listeningCount 会变）。 */
function usePersonaMutation<TInput, TOut>(perform: (input: TInput) => Promise<TOut>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: perform,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.personaConversations })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.personaSnapshot })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.personaDrafts })
      /**
       * ★ 消息列表也要失效。
       *
       * 发出去的那条消息**会进消息历史**（采集下一轮会把它拉回来，而
       * `claimAgentOrigin` 会把它标成分身发的）。不失效的话用户点了发送
       * 之后消息流里什么都不变 —— 与"没发出去"在界面上完全一样。
       *
       * 这一条对「用户自己写一条直接发」尤其要紧：那条消息没有草稿卡
       * 可以消失作为反馈，消息流是**唯一**能证明它发出去了的地方。
       */
      void queryClient.invalidateQueries({ queryKey: ["persona", "messages"] })
    },
  })
}

export function useSavePersonaConfig() {
  return usePersonaMutation(
    async (input: {
      conversationId: string
      replyMode?: "auto" | "draft" | "yolo"
      triggerMode?: "none" | "all" | "mention" | "keyword"
      keywords?: string[]
      personaNote?: string | null
    }) => unwrap(await window.mycontext.persona.configSave(input)),
  )
}

/**
 * 管控层运行参数（LRU / 并发 / 批次上限）。
 *
 * 存的是"这台机器能同时跑几个 agent"，不是内容 —— 所以 staleTime 给长：
 * 它只在用户自己改的时候变，而那时 mutation 会主动 invalidate。
 */
export function usePersonaLimits(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.personaLimits,
    queryFn: async () => unwrap(await window.mycontext.persona.limits()),
    staleTime: 60_000,
    enabled,
  })
}

export function useSavePersonaLimits() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Partial<PersonaRuntimeLimits>) =>
      unwrap(await window.mycontext.persona.limitsSave(input)),
    onSuccess: (next) => {
      // 用返回值直接写缓存：再查一次会让"改完立刻显示旧值"闪一下
      queryClient.setQueryData(QUERY_KEYS.personaLimits, next)
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.personaSnapshot })
    },
  })
}

/**
 * agent 过程：**实时**那一半。
 *
 * 订阅 `personaTrace` 事件，只保留**当前会话**那一轮的 items。
 *
 * ★ 不进 react-query 缓存：这是 token 级的流（一轮几十次推送），
 * 写缓存会让每次推送触发一遍 query 的失效/重取链路。用 local state
 * 直接吃事件是这类流的正确形态（搜索模块的流式渲染同款）。
 *
 * 会话切换时清空：上一轮的过程留在屏幕上会被当成这一轮的。
 */
export function usePersonaTrace(conversationId: string | null): {
  items: PersonaTraceItem[]
  done: boolean
} {
  const [state, setState] = useState<{ items: PersonaTraceItem[]; done: boolean }>({
    items: [],
    done: false,
  })
  useEffect(() => {
    setState({ items: [], done: false })
    if (conversationId === null) return undefined
    /**
     * ★ 挂载先拉一次 in-flight 快照，再接增量。
     *
     * 修"起草中的消息切走再回来就没了"：`onTrace` 是纯增量流，重新挂载订阅从零
     * 开始。若此刻正有一轮在生成，先把主进程留着的"到目前为止"补上 ——
     * 否则界面空着直到下一次 token 推送（而那可能要好几秒，或这一轮已近结束
     * 几乎不再推）。`unlisten` 已设置说明未被卸载；快照回来时若没有更新的增量
     * 就用它兜底，有增量则增量为准（done 一定是全量替换，不会被旧快照盖回去）。
     */
    let alive = true
    const unlisten = window.mycontext.persona.onTrace((event) => {
      if (event.conversationId !== conversationId) return
      // 推的是全量快照（见契约注释），直接替换即可 —— 不用自己按 id 合并。
      setState({ items: event.items, done: event.done })
    })
    void window.mycontext.persona.liveTrace({ conversationId }).then((result) => {
      if (!alive || !result.ok) return
      const snapshot = result.data
      // 只在还没收到任何增量时用快照兜底（收到过就以增量为准，别把新的盖回旧的）
      setState((prev) => (prev.items.length === 0 && !prev.done ? snapshot : prev))
    })
    return () => {
      alive = false
      unlisten()
    }
  }, [conversationId])
  return state
}

/**
 * agent 过程：**回看**那一半（按 runId 读已经跑完的那一轮）。
 *
 * `enabled` 让它只在用户真的展开「看生成过程」时才查 —— 草稿列表里
 * 每条都预取一遍是白花的库查询（一屏可能十条）。
 */
export function usePersonaRunTrace(runId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["persona", "run-trace", runId] as const,
    queryFn: async () => unwrap(await window.mycontext.persona.runTrace({ runId: runId ?? "" })),
    // 已经跑完的那一轮不会再变 —— 查一次就够。
    staleTime: Infinity,
    enabled: enabled && runId !== null,
  })
}

/**
 * 那一轮的元信息（触发消息 / 判定与原因 / 耗时 token）。
 *
 * 与 `usePersonaRunTrace` 同一套门控：`enabled` 让它只在用户真的展开
 * 某一条时才查 —— 历史面板一屏 20 条，各预取一遍是白花的库查询。
 *
 * `staleTime: Infinity` 同理：跑完的那一轮不会再变。
 */
export function usePersonaRunDetail(runId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["persona", "run-detail", runId] as const,
    queryFn: async () => unwrap(await window.mycontext.persona.runDetail({ runId: runId ?? "" })),
    staleTime: Infinity,
    enabled: enabled && runId !== null,
  })
}

export function useResolveDraft() {
  return usePersonaMutation(
    async (input: { draftId: string; action: "send" | "discard"; editedText?: string }) =>
      unwrap(await window.mycontext.persona.draftResolve(input)),
  )
}

/**
 * 采集轮询周期。
 *
 * `staleTime` 给长（同 `usePersonaLimits`）：它只在用户自己改时变，
 * 而那时 mutation 会写缓存。
 */
export function useIngestIntervals(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.ingestIntervals,
    queryFn: async () => unwrap(await window.mycontext.ingest.intervals()),
    staleTime: 60_000,
    enabled,
  })
}

export function useSaveIngestIntervals() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveIngestIntervalsInput) =>
      unwrap(await window.mycontext.ingest.intervalsSave(input)),
    onSuccess: (next) => {
      // 用返回值直接写缓存：再查一次会让"改完立刻显示旧值"闪一下。
      queryClient.setQueryData(QUERY_KEYS.ingestIntervals, next)
      // 保存会重挂采集（新周期才生效）→ 快照里的 probeIntervalMs 也变了。
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ingest })
    },
  })
}

/**
 * 用户自己写一条直接发。
 *
 * 与 `useResolveDraft` 分开是因为它们的入参与前置条件不同（那个要
 * draftId），但走的是同一个 `usePersonaMutation` —— 于是成功后
 * 消息列表与快照的失效逻辑只有一份。
 */
export function useComposeSend() {
  return usePersonaMutation(async (input: { conversationId: string; text: string }) =>
    unwrap(await window.mycontext.persona.composeSend(input)),
  )
}

export function useSetKillSwitch() {
  return usePersonaMutation(async (input: { active: boolean }) =>
    unwrap(await window.mycontext.persona.killSwitch(input)),
  )
}

export function usePersonaTick() {
  return usePersonaMutation(async () => unwrap(await window.mycontext.persona.tick()))
}

// ---------------------------------------------------------------
// 媒体与头像
// ---------------------------------------------------------------

/**
 * 一批人的头像。**两段式：先读缓存，再后台补齐。**
 *
 * ## ★ 为什么必须两段
 *
 * 改动前这是一个 IPC：读缓存与去取合在一起，60 个人共享**一次成败**。
 * 而 `media.avatar()` 里对渠道的调用会抛（CLI exit≠0 / 30s 超时），
 * 于是任何一个人的抖动 → 整个 IPC failure → `unwrap` 抛 →
 * react-query 的 `data` 变 `undefined` → **这一屏所有头像一起退回首字母**，
 * 包括那些早就取到、只需要读一行 SQL 的人。而 `main.tsx` 是
 * `retry: false`，一次失败就停在失败上。
 *
 * 实测形态：库里 154 行已缓存 + 磁盘 159 个文件都健在，界面却经常整屏
 * 只有首字母 —— 这就是"以前加载过为什么又没了"的真正答案（缓存没坏，
 * 是显示这一步被一个无关的人的失败带走了）。
 *
 * 现在：
 * · `avatars` 只读缓存 —— 没有子进程、没有网络，**几乎不可能失败**；
 * · 有人 `needsFetch` 时才调 `avatarsFetch`（每人独立成败）；
 * · 补完 invalidate 第一条，重读缓存把新取到的显示出来。
 *
 * ## ★ `staleTime` 现在给 30s 而不是 10 分钟
 *
 * 原来的 10 分钟是为了压住"每次 refetch 都起几十个子进程"。而现在读缓存
 * 不起子进程了，长 staleTime 反倒有害：后台补齐完成后要能**及时**看到。
 *
 * ## ★ `queryKey` 含 id 列表，所以列表一变就是另一个 query
 *
 * 会话列表来一个新会话，key 就变 → react-query 认为是没见过的 query →
 * `data` 变 `undefined` → 界面上所有头像同时消失。而这一页的列表是被
 * 快照推送驱动刷的（250ms 节流）、还带着 `lastMessageAt` 这种随消息变的
 * 字段 —— 活跃时段几秒就变一次。
 *
 * `placeholderData: keepPreviousData` 让 key 变化期间继续显示上一批。
 * 这比"把 ids 从 key 里拿掉"更对：那样两个调用方（左栏单聊对端、
 * 消息流发送者，两批 id 完全不同）会互相覆盖对方的结果。
 */
export function useContactAvatars(
  externalIds: readonly string[],
  groupExternalId: string | null,
  /**
   * `externalId → 花名`。**没有共同群时必须传**。
   *
   * ★ 取头像的第二条路是 `chat search-common --nicks <花名>`，而那个参数
   * 缺失时渠道层**一次命令都不调**就返回 null —— 结果是
   * `path: null, reason: null`，看起来像"这个人没设头像"（正常），
   * 实际是我们压根没去找。实测踩到：48 个单聊对方全部这样。
   *
   * 群聊里可以不传（有 `groupExternalId` 那条捷径）。
   */
  nickByExternalId?: Readonly<Record<string, string>>,
) {
  const queryClient = useQueryClient()
  // key 里用排序后的串：调用方每次渲染都可能传一个新数组
  const idsKey = [...externalIds].sort().join(",")
  const cached = useQuery({
    queryKey: ["media", "avatars", idsKey, groupExternalId] as const,
    queryFn: async () =>
      unwrap(
        await window.mycontext.media.avatars({
          externalIds: [...externalIds],
          groupExternalId,
          ...(nickByExternalId === undefined ? {} : { nickByExternalId }),
        }),
      ),
    enabled: externalIds.length > 0,
    // 读缓存很便宜（一次 SQL），但也不必每次渲染都读
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })

  /**
   * 还没取到、且值得去取的那些人。
   *
   * `needsFetch` 由主进程判 —— 它要区分终态 miss（没设头像 → 重试永远
   * 同一个答案）与可重试（缺花名 / 网络失败 + 6 小时退避），
   * 而那是 `contact-avatars.ts` 的知识。渲染层复制一份的话两边会分叉，
   * 表现是每次进页面对几十个"本来就没头像"的人各重试一遍。
   */
  const pending = useMemo(
    () => (cached.data ?? []).filter((entry) => entry.needsFetch).map((entry) => entry.externalId),
    [cached.data],
  )
  const pendingKey = pending.join(",")

  /**
   * 后台补齐。
   *
   * ## ★ 为什么是 `useEffect` + 手写去重，而不是一个 query
   *
   * 它有副作用（写 `contact_avatars`、下文件），而且**不该**被
   * react-query 的重试/刷新机制驱动 —— 每次触发都是几十次子进程调用。
   * `inFlight` 那个 ref 保证同一批人只补一次：没有它的话
   * 「补完 → invalidate → 重读 → 仍有人没取到（终态之外的失败）→ 再补」
   * 会变成一个每轮几十个子进程的死循环。
   */
  const inFlight = useRef<string | null>(null)
  useEffect(() => {
    if (pendingKey === "" || inFlight.current === pendingKey) return
    inFlight.current = pendingKey
    void (async () => {
      try {
        const result = unwrap(
          await window.mycontext.media.avatarsFetch({
            externalIds: pending,
            groupExternalId,
            ...(nickByExternalId === undefined ? {} : { nickByExternalId }),
          }),
        )
        // 只在真取到东西时重读：没取到就没有新路径，重读是白刷
        if (result.fetched > 0) {
          await queryClient.invalidateQueries({ queryKey: ["media", "avatars"] })
        }
      } catch {
        /**
         * ★ 吞掉：补齐失败**不该影响已经显示出来的头像**。
         *
         * 这正是改动前那个 bug 的反面 —— 那时补齐与读缓存共享成败，
         * 失败会把整屏头像清空。现在失败就是"这几个人这次没取到"，
         * 主进程已经给他们记了可重试的 miss（6 小时后自然再试）。
         */
      }
    })()
  }, [pendingKey, pending, groupExternalId, nickByExternalId, queryClient])

  return cached
}

/**
 * 下载一个媒体资源。
 *
 * 成功后 invalidate 消息列表 —— 那是 `path` 变成非 null 的唯一途径，
 * 不刷的话用户点了下载但图片仍然显示"点击下载"。
 */
export function useDownloadMedia() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { mediaId: string }) =>
      unwrap(await window.mycontext.media.download(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["persona", "messages"] })
    },
  })
}

/**
 * 把一屏消息的媒体一次下完（打开会话时自动跑，用户不必点每一张）。
 *
 * ## ★ 只在**真下了东西**时才 invalidate
 *
 * 消息里的图第二次打开这个会话时已经全在本地了，那时主进程返回
 * `downloaded: 0`。无条件 invalidate 会让"打开会话 → 重查消息 →
 * 自动下载 effect 再跑一次 → 又 invalidate"变成一个无限循环
 * （每轮都是一次 IPC + 一次 SQL）。判 `downloaded > 0` 就断开了那个环：
 * 没下到新东西就没有新路径，也就没有重查的理由。
 */
export function useDownloadMediaForMessages() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { messageIds: readonly string[] }) =>
      unwrap(await window.mycontext.media.downloadForMessages(input)),
    onSuccess: (result) => {
      if (result.downloaded > 0) {
        void queryClient.invalidateQueries({ queryKey: ["persona", "messages"] })
      }
    },
  })
}

/**
 * 把一张已下载的图另存为到用户选的位置。
 *
 * ★ 不 invalidate 任何 query：另存为**不改应用状态**（只是往用户选的
 * 目录复制一份）。刷消息列表是白刷，而这一页每次刷都可能重取头像。
 */
export function useSaveMediaAs() {
  return useMutation({
    mutationFn: async (input: { mediaId: string }) =>
      unwrap(await window.mycontext.media.saveAs(input)),
  })
}

/**
 * 上传一张本地图片（数字人形象 / 用户头像）。
 *
 * 不 invalidate 任何东西：调用方拿到路径之后自己决定存到哪
 * （形象存 onboarding payload，头像走 profile.update）。
 */
/**
 * 取本人头像（从渠道）。
 *
 * ★ 不是 query 而是 mutation：它有副作用（可能写账号），而且要用户
 * 显式点一下 —— 自动取的话会在每次打开设置时多花 2-3 次 CLI 调用。
 */
export function useFetchSelfAvatar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await window.mycontext.media.selfAvatar()),
    onSuccess: () => {
      // 写了账号 → bootstrap 里的 session 变了（侧栏头像也读它）
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap })
    },
  })
}

export function useUploadImage() {
  return useMutation({
    mutationFn: async (input: { base64: string; purpose: "figure" | "avatar" }) =>
      unwrap(await window.mycontext.media.uploadImage(input)),
  })
}

export function useChannelConversations(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.channelConversations,
    queryFn: async () => unwrap(await window.mycontext.channels.conversations()),
    enabled,
    staleTime: 5 * 60_000,
  })
}

// ---------------------------------------------------------------
// 偏好设置
// ---------------------------------------------------------------

/**
 * 切换界面语言。
 *
 * 先切 i18n（界面立刻响应），再落盘。顺序反过来的话，用户点一下要等一次
 * IPC 往返才看到变化，而这次往返失败与否都不影响「这一次会话里用哪种语言」。
 * 落盘失败只意味着重启后回到旧语言，因此不阻塞界面。
 */
export function useSetLanguage() {
  const queryClient = useQueryClient()
  const { i18n } = useTranslation()
  return useMutation({
    mutationFn: async (preference: LanguagePreference) => {
      await i18n.changeLanguage(resolveLanguage(preference))
      return unwrap(await window.mycontext.preferences.setLanguage({ language: preference }))
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap }),
  })
}

/**
 * 切"退出前确认"开关。
 *
 * 与 `useSetLanguage` 同样是应用级偏好，读值由 bootstrap 一并下发；
 * 写完后 invalidate bootstrap 刷 UI。
 */
export function useSetQuitConfirmSuppressed() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (suppressed: boolean) =>
      unwrap(await window.mycontext.preferences.setQuitConfirmSuppressed({ suppressed })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap }),
  })
}

/**
 * 开/关工作层抽取。
 *
 * 与上面两个偏好同构（读值随 bootstrap 下发，写完 invalidate 刷 UI）。
 * 差别只在语义：这一个**打开就开始花钱**，所以 UI 那侧要给成本提示，
 * 而不是像语言/主题那样一点就改。
 */
export function useSetWorkLayerEnabled() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      unwrap(await window.mycontext.preferences.setWorkLayerEnabled({ enabled })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap }),
  })
}

/**
 * 改显示名 / 头像。
 *
 * 改头像会把来源标成 `manual` —— 之后渠道授权**不再覆盖**它
 * （包括"清空"：清空也是一次明确的选择，见 accounts.ts 的 updateProfile）。
 *
 * 成功后刷 bootstrap：会话里带着显示名与头像，侧栏那颗按钮直接读它。
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateProfileInput) =>
      unwrap(await window.mycontext.profile.update(input)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap }),
  })
}

// ---------------------------------------------------------------
// 数据面（采集与知识管道）
// ---------------------------------------------------------------

/**
 * 采集状态。
 *
 * 不轮询：主进程在入库后主动推快照（见下面的 useIngestProgress）。
 * 轮询会在空闲时白跑，而在忙时又跟不上 —— 两头都不对。
 */
export function useIngestSnapshot(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.ingest,
    queryFn: async () => unwrap(await window.mycontext.ingest.snapshot()),
    enabled,
  })
}

/** 订阅采集进度：主进程推来的快照直接写进 query cache，省掉一次往返。 */
export function useIngestProgress(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    return window.mycontext.ingest.onProgress((snapshot) => {
      queryClient.setQueryData(QUERY_KEYS.ingest, snapshot)
    })
  }, [queryClient])
}

/**
 * 立即同步。★ 收 `channelId`：状态页按渠道分区，按钮该只作用于用户正在看的
 * 那个渠道（不带的话在飞书那栏点它会跑钉钉那 1600 条的一轮）。
 */
export function useRunIngestOnce() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input?: { channelId?: string }) =>
      unwrap(await window.mycontext.ingest.runOnce(input)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ingest }),
  })
}

export function useClearIngestBlocked() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await window.mycontext.ingest.clearBlocked()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ingest }),
  })
}

/**
 * 解析本人身份。
 *
 * 失败（尤其是 SELF_IDENTITY_AMBIGUOUS）要原样透给 UI：
 * 「无法唯一确定身份」必须让用户看到，不能退回到"挑一个" ——
 * 身份错了画像从根上错，且不可逆。
 */
export function useResolveSelf() {
  return useMutation({
    mutationFn: async () => unwrap(await window.mycontext.ingest.resolveSelf()),
  })
}

export function useConfirmSelf() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await window.mycontext.ingest.confirmSelf()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ingest }),
  })
}

/**
 * 已解析的本人身份（**只读**，可缓存）。
 *
 * ★ 是 query 而不是 mutation —— 与 `useResolveSelf` 的区别在主进程侧：
 * 那个每次都真调渠道（子进程）并可能抛歧义错误，这个只读本地一行。
 * 用它来显示渠道花名这类"顺手"的信息，不该让界面渲染触发渠道调用。
 *
 * 身份还没解析过时 `data` 是 `null`（正常状态）—— 调用方按"拿不到就不显示"处理。
 */
export function useSelfIdentity(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.selfIdentity,
    queryFn: async () => unwrap(await window.mycontext.ingest.readSelf()),
    enabled,
  })
}

/**
 * @param channelId 看哪个渠道的知识加工进度。★ 进 queryKey，否则切渠道命中
 *   同一份缓存（界面上表现为"落后条数不跟着变"）。
 */
export function useFeedInfo(enabled: boolean, channelId?: string) {
  return useQuery({
    queryKey: [...QUERY_KEYS.feed, channelId ?? "primary"],
    queryFn: async () =>
      unwrap(
        await window.mycontext.pipeline.feedInfo(
          channelId === undefined ? undefined : { channelId },
        ),
      ),
    enabled,
  })
}

export function useExportPipeline() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => unwrap(await window.mycontext.pipeline.export()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.feed }),
  })
}

// ---------------------------------------------------------------
// 搜索模块
// ---------------------------------------------------------------

export function useSearchSessions(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.searchSessions,
    queryFn: async () => unwrap(await window.mycontext.search.sessionList()),
    enabled,
  })
}

export function useSearchSessionDetail(sessionId: string | null) {
  return useQuery({
    queryKey: [...QUERY_KEYS.searchSessions, sessionId],
    queryFn: async () =>
      unwrap(await window.mycontext.search.sessionDetail({ sessionId: sessionId ?? "" })),
    enabled: sessionId !== null,
  })
}

/** 建会话。成功后调用方切到该会话并立刻发第一条 prompt。 */
export function useCreateSearchSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { query: string; scope?: string }) =>
      unwrap(await window.mycontext.search.sessionCreate(input)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.searchSessions }),
  })
}

export function useSearchPrompt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { sessionId: string; query: string }) =>
      unwrap(await window.mycontext.search.prompt(input)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.searchSessions }),
  })
}

/** 取消当前 turn。不 invalidate：turn 收尾时 prompt 自己会刷新会话详情。 */
export function useCancelSearch() {
  return useMutation({
    mutationFn: async (sessionId: string) =>
      unwrap(await window.mycontext.search.cancel({ sessionId })),
  })
}

/** 会话的增删改：三个都只 invalidate 列表，不做乐观更新（成本低、出错面小）。 */
export function useSearchSessionMutations() {
  const queryClient = useQueryClient()
  const invalidate = (): void =>
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.searchSessions })

  const rename = useMutation({
    mutationFn: async (input: { sessionId: string; title: string }) =>
      unwrap(await window.mycontext.search.sessionRename(input)),
    onSuccess: invalidate,
  })
  const pin = useMutation({
    mutationFn: async (input: { sessionId: string; pinned: boolean }) =>
      unwrap(await window.mycontext.search.sessionPin(input)),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: async (sessionId: string) =>
      unwrap(await window.mycontext.search.sessionDelete({ sessionId })),
    onSuccess: invalidate,
  })
  return { rename, pin, remove }
}

/**
 * 订阅搜索的流式输出，并暴露**最近一轮**的运行时降级原因。
 *
 * `degradedReason` 跟**实际走的路**走（后端 M2.9 随每条 stream 带下来）：
 * 走了 agent turn → null；落回本地召回 → 非空文案。这比静态的
 * `agentAvailable`（只表示"装没装 opencode"）准确 —— 装了但本轮起不来时，
 * 用户仍要看到降级横幅。切换会话时清空（reason 是上一会话的，不该串）。
 *
 * 收到 `done` 时刷新该会话详情（一期流式是"整批落库后通知"）。
 */
export function useSearchStream(sessionId: string | null): { degradedReason: string | null } {
  const queryClient = useQueryClient()
  const [degradedReason, setDegradedReason] = useState<string | null>(null)

  useEffect(() => {
    // 换会话：上一会话的降级态不该带过来。
    setDegradedReason(null)
    return window.mycontext.search.onStream((event) => {
      // 只认当前会话的事件。sessionId 为 null（首屏）时不认任何事件 ——
      // 否则后台会话的一条 stream 会在首屏闪一条不属于这里的降级横幅。
      if (sessionId === null || event.sessionId !== sessionId) return
      setDegradedReason(event.degradedReason)
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEYS.searchSessions, event.sessionId],
      })
      if (event.done) {
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.searchSessions })
      }
    })
  }, [queryClient, sessionId])

  return { degradedReason }
}

// ---------------------------------------------------------------
// 高级 AI 配置（隐藏入口）
// ---------------------------------------------------------------

export function useAdvancedAiConfig() {
  return useQuery({
    queryKey: QUERY_KEYS.advancedAi,
    queryFn: async () => unwrap(await window.mycontext.advancedAi.read()),
  })
}

export function useSaveAdvancedAiConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      baseUrl: string
      apiKey: string | null
      modelRoles: Record<string, string>
      harness: Record<string, string>
      rawConfigJson: string | null
    }) => unwrap(await window.mycontext.advancedAi.save(input)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.advancedAi }),
  })
}

/**
 * 自备 dws 的路径。
 *
 * ★ 保存失败是**预期路径之一**（填错了、跑不起来），所以调用方要拿
 * mutation 的 error 显示原因 —— 主进程那边会拒绝并给出可操作的错误。
 */
export function useDwsSource() {
  return useQuery({
    queryKey: QUERY_KEYS.dwsSource,
    queryFn: async () => unwrap(await window.mycontext.dwsSource.read()),
  })
}

export function useSaveDwsSource() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      path?: string | null | undefined
      channelCode?: string | null | undefined
    }) => unwrap(await window.mycontext.dwsSource.save(input)),
    /**
     * ★★ 全失效，且用 `onSettled` —— 换渠道客户端等于换掉了整条链的底层。
     *
     * ## 原来只失效两个 key，而那漏掉了受影响最大的几个
     *
     * 旧写法是 `onSuccess` 里失效 `dwsSource` + `channels`。而换 binary
     * 之后**主进程侧**已经做了更多事（`register.ts` 的 `dwsSourceSave`）：
     * 它会调 `dataPlane.clearBlocked()` 解除采集的终态闸。
     *
     * 于是漏掉的那些 key 全都停在旧值上：`ingest`（blocked 刚被清）、
     * `selfIdentity`、`adoptableSession`、`status`、`channelIdentities`。
     * 表现正是用户报的那件事：**换了客户端，界面上「采集未运行 / 身份未确认」
     * 一个都不变，要重启应用才认**。
     *
     * ★ 用全失效而不是把那 5 个 key 补上：列举必然再漏（这次就漏了 5 个），
     * 而"换底层"影响的面本来就是"几乎所有渠道相关的东西"。代价是一次多余的
     * 重取，比"界面说的与实际不一致"便宜得多。
     * 对照组就在本文件里 —— `useSwitchChannelIdentity` 用的正是全失效。
     *
     * ★ `onSettled` 而不是 `onSuccess`：主进程是**先 save 再 clearBlocked**，
     * 所以即便 save 抛错，状态也可能已经变了一半。"失败就不刷新"会留下一个
     * 比刷新更糟的中间态。
     *
     * ## ★ 事件流不用管（实测确认）
     *
     * 长连接的 binary 是在 spawn 那一刻定的，看起来需要重连。但
     * `DingTalkEventConsumer` 的重连是 `while` 循环里每轮都调 `spawnOnce()`，
     * 而那里面 `runtime.resolve("dws")` 是**现读**的（`events.ts:194`）——
     * 也就是它下次退避重连时自然就用上新 binary 了，不需要我们介入。
     */
    onSettled: () => void queryClient.invalidateQueries(),
  })
}

// ---------------------------------------------------------------
// 模型网关配置（用户可见，单一真源）
// ---------------------------------------------------------------

export function useRuntimeConfig() {
  const queryClient = useQueryClient()
  // 主进程改了网关（比如别处保存）→ 订阅事件刷新，不用轮询。
  useEffect(() => {
    const off = window.mycontext.runtimeConfig.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.runtimeConfig })
    })
    return off
  }, [queryClient])
  return useQuery({
    queryKey: QUERY_KEYS.runtimeConfig,
    queryFn: async () => unwrap(await window.mycontext.runtimeConfig.read()),
  })
}

export function useSaveRuntimeConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveRuntimeConfigInput) =>
      unwrap(await window.mycontext.runtimeConfig.save(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.runtimeConfig })
      // baseUrl/apiKey 是单一真源 —— 高级面板也读它，一并失效。
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.advancedAi })
      /**
       * ★★ 「配了模型没有」这件事的**消费方**也要失效，否则横幅在说谎。
       *
       * 打包实测抓到的一幕：引导第 2 步「配置模型」已经打勾、主进程日志里
       * `llm holder reconfigured` + `gateway changed; restarting kl-server`
       * 都跑完了，而第 5 步仍然显示
       * 「没配模型 —— 抽取型任务会失败。去『设置 → 高级』配 LLM。」
       *
       * 原因是那个横幅的判据是 `personaSnapshot.agentAvailable`
       * （见 onboarding-view 传给 DistillStep 的 `modelConfigured`），
       * 而这里只失效了 runtimeConfig / advancedAi 两个 key —— 那份快照
       * 一直是**启动那一刻**的（`agentAvailable: false`）。
       *
       * 连带的谎更具体：同一页那句「配好模型后**下次启动**会自动整理」也来自
       * 这份过期快照，于是用户以为必须重启，而实际上 kl 已经带着新网关跑着、
       * 点「开始学习」就会立刻建图（实测 0 秒延迟）。
       *
       * `distillProgress` 同理：它的 `forge.available/unavailableReason`
       * 也随模型配置变。
       */
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.personaSnapshot })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.distillProgress })
      /**
       * kl 的状态**不在这里** —— 它走 IPC 推送（`kl.onStatus`）而不是
       * react-query，主进程 `onGatewayChanged` 重起 kl 时会自己 `pushStatus`。
       * 在这里 invalidate 一个不存在的 key 是无害但会误导后来的人。
       */
    },
  })
}

/**
 * 订阅主进程的「网关配置变了」事件 → 失效受影响的 query。
 *
 * ## ★★ 为什么除了 `useSaveRuntimeConfig` 还要这一条
 *
 * 那个 `onSuccess` 只覆盖"**在这个渲染进程里**点了保存"这一条路。而
 * `runtimeConfigChanged` 是主进程在**每次** `runtimeConfig.save()` 之后
 * 广播的（见 startup.ts 的 `onChange`），来源不止一处：
 * · 引导页第 2 步与设置页是**两个**组件复用同一个表单，但将来可能不是；
 * · 主进程自己可能因为别的原因 reconfigure（adopt 旧配置、迁移）。
 *
 * 挂在 App 级订阅一次，比在每个消费方各自记得失效可靠 —— 后者漏一处的
 * 表现就是这次实测到的那个：第 2 步打了勾、kl 都重启了，而第 5 步还在说
 * 「没配模型，去设置里配 LLM」。
 *
 * 返回 void：这是个纯副作用 hook。
 */
export function useRuntimeConfigSync(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    return window.mycontext.runtimeConfig.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.runtimeConfig })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.advancedAi })
      // 「配了模型没有」的两个消费方 —— 见 useSaveRuntimeConfig 里那段注释。
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.personaSnapshot })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.distillProgress })
    })
  }, [queryClient])
}

/**
 * 探测网关（「测试连接」）。
 *
 * ★ 用 mutation 而不是 query：它是**用户点出来的动作**（有副作用意味 ——
 * 打一次外网请求），不是随组件挂载就该自动跑的读取。用 query 的话
 * refetch/重挂载都会偷偷打网关，而那是用户没要求的出网行为。
 */
export function useProbeRuntimeConfig() {
  return useMutation({
    mutationFn: async (input: ProbeRuntimeConfigInput) =>
      unwrap(await window.mycontext.runtimeConfig.probe(input)),
  })
}

// ---------------------------------------------------------------
// 知识图谱（kl）子进程
// ---------------------------------------------------------------

/**
 * kl-server 状态：初值走 `serverStatus()`，之后订阅 `onStatus` 实时更新。
 *
 * 仿 useSearchStream 的模式（useState + useEffect 订阅），不用 react-query 的
 * 轮询——状态由主进程的状态机事件驱动（starting→ready/failed），推比拉准。
 */
export function useKlServerStatus(): KlServerStatus | null {
  const [status, setStatus] = useState<KlServerStatus | null>(null)
  useEffect(() => {
    let alive = true
    void window.mycontext.kl.serverStatus().then((r) => {
      if (alive && r.ok) setStatus(r.data)
    })
    const off = window.mycontext.kl.onStatus((s) => setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

/** 启动 kl-server（懒启动；warmup 期间状态经 onStatus 推 UI）。 */
/**
 * 起 kl-server。★ 收 `channelId`：`failed` 之后不自动重起（刻意的），
 * 所以必须能精确地对某一个渠道重试。不给 = 全部。
 */
export function useKlServerStart() {
  return useMutation({
    mutationFn: async (channelId?: string) =>
      unwrap(
        await window.mycontext.kl.serverStart(channelId === undefined ? undefined : { channelId }),
      ),
  })
}

/** 停止 kl-server。 */
/** 停止 kl-server。★ 与 `useKlServerStart` 同款按渠道。 */
export function useKlServerStop() {
  return useMutation({
    mutationFn: async (channelId?: string) =>
      unwrap(
        await window.mycontext.kl.serverStop(channelId === undefined ? undefined : { channelId }),
      ),
  })
}

/** 触发建图（export→ingest，长任务、出网）。完成后 server 会重载新图。 */
export function useKlGraphBuild() {
  const queryClient = useQueryClient()
  return useMutation({
    /**
     * `fresh` 由调用方决定：false（默认）增量，true 清空重来（贵，会重烧抽取）。
     * 两个入口在 UI 上分开，避免一次误点就把已建好的图删了重跑。
     */
    /**
     * ★ 第二个参数是渠道 id：按钮与渠道选择器同处一页，不带的话在飞书那栏
     * 点「重建」会把钉钉的图一起删了重烧（约 3 小时且出网）。
     */
    mutationFn: async (input?: boolean | { fresh?: boolean; channelId?: string }) => {
      const opts: { fresh?: boolean; channelId?: string } =
        typeof input === "boolean" ? { fresh: input } : (input ?? {})
      return unwrap(await window.mycontext.kl.graphBuild(opts.fresh ?? false, opts.channelId))
    },
    /**
     * 建完立刻重取概览。
     *
     * 不失效的话页面上仍是建图**之前**的那份数字（多半是 0）——
     * 用户等了几分钟、按钮回到"重新建图"，而下面的数字一动不动，
     * 看起来就是"跑完了但什么都没建出来"。
     */
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["kl", "graph-overview"] })
    },
  })
}

/**
 * 图谱概览（可视化版块）。
 *
 * ## ★ 建图期间要**轮询**，其它时候不必
 *
 * 建图是分钟级的，而 entities/facts/edges 是一路涨上去的 —— 那个"在长"的
 * 过程本身就是最好的进度指示（比一个百分比可信：百分比是我们算的，
 * 行数是真数据）。所以 `building` 时每 5s 拉一次，否则只在打开页面时拉。
 *
 * 5s 而不是 1s：这几个 COUNT 走的是只读连接，但建图时 SQLite 正在被写，
 * 拉太勤会跟写者抢锁。
 */
/**
 * @param channelId 看哪个渠道的图谱规模。与 `useKlGraphEgo` 同一个取值范围
 *   —— 仪表盘那六个数与下面那张图必须说同一个渠道，否则读者会把两边对不上
 *   的数字当成 bug。★ 进 queryKey，否则切渠道命中同一份缓存（点了没反应）。
 */
export function useKlGraphOverview(building: boolean, channelId?: string) {
  return useQuery({
    queryKey: ["kl", "graph-overview", channelId ?? "primary"],
    queryFn: async () =>
      unwrap(
        await window.mycontext.kl.graphOverview(
          channelId === undefined ? undefined : { channelId },
        ),
      ),
    refetchInterval: building ? 5_000 : false,
    staleTime: 3_000,
  })
}

/**
 * 以「我」为中心的关系子图。
 *
 * `staleTime` 给 30s：它读的是只读 SQLite（实测拼图 2ms + 几百行查询），
 * 但图谱**只在建图后才变** —— 秒级重取是白花主进程的同步查询。
 *
 * 建图中每 5s 重取一次：那时用户正等着看图长出来。
 */
/**
 * @param channelId 看**哪个渠道**的关系图。
 *
 * ★ 图谱是**切换**而不是混合：同一个人在两个渠道是两个 external_id，
 * 没有安全的映射（靠显示名对齐不行，同名同姓实测 6 个）。合并会凭猜测把
 * 两个人的关系连起来 —— 不报错，只是答错。见 `MultiGraphQueryService.ego`。
 *
 * ★ `channelId` 进 queryKey：不进的话切换渠道命中同一份缓存，
 * 界面上表现为"点了没反应"。
 */
export function useKlGraphEgo(building: boolean, channelId?: string) {
  return useQuery({
    /**
     * ★ `channelId` 进 key —— 少了它切渠道会命中同一份缓存，于是飞书那栏
     * 显示的是钉钉的关系图（实测过：切过去数字一条都不变）。
     */
    queryKey: ["kl", "graph-ego", channelId ?? "primary"],
    queryFn: async () => {
      const view = unwrap(
        await window.mycontext.kl.graphEgo(channelId === undefined ? undefined : { channelId }),
      )
      /**
       * ★★★ 「图谱服务还没起来」要当成**失败**抛出去，让 react-query 重试。
       *
       * ## 为什么必须抛
       *
       * 关系数据要问 kl 的 HTTP（`edges` 表在 ladybug 下恒空，见主进程侧
       * `GraphQueryOptions.factsOfEntity`），而 kl 是懒启动的 ——
       * 实测 warmup 约 10s。界面在那之前就查了，于是第一次拿到的是
       * `available: false`。
       *
       * 而 `available: false` 在 react-query 看来是**成功**（拿到了数据），
       * 于是它被缓存住、`refetchInterval` 平时又是 `false` ——
       * **那一次失败就是最终答案**，面板从此一直空着。
       *
       * 实测同一份数据的两个状态：kl 没跑 → nodes 0；kl 在跑 → nodes 25
       * / edges 64。也就是面板空与数据无关，只跟"查得早了几秒"有关。
       *
       * ★ 只对"服务没起来"这一类抛。其余的 `available: false`
       * （身份没确认 / 图里没有你 / 真的没抽到关联）是**稳定结论**，
       * 重试一百次也一样 —— 那些要原样返回，让面板显示那句话。
       */
      if (
        view.available === false &&
        view.reason !== null &&
        /图谱服务|还没就绪/.test(view.reason)
      ) {
        throw new Error(view.reason)
      }
      return view
    },
    /**
     * ★ 建图中 5s 轮询（用户正等着看图长出来）；平时不轮询 ——
     * 图只在建图后才变，秒级重取是白花主进程的查询。
     */
    refetchInterval: building ? 5_000 : false,
    /**
     * ★★ 但**失败要重试**：上面把"服务没起来"抛成了错误，
     * 而 kl 的 warmup 实测约 10s，所以退避几次一定能等到。
     * 不重试的话就回到了那个 bug —— 早查一次，从此空着。
     */
    retry: 5,
    retryDelay: (attempt) => Math.min(2_000 * 2 ** attempt, 15_000),
    staleTime: 30_000,
  })
}

/**
 * 带过滤的事实检索。
 *
 * ★ `placeholderData: keepPreviousData` 是刻意的：过滤器一改 queryKey 就变，
 * 没有它列表会先变空再填回来（闪一下）。规范里写的是"重取时保持上一次
 * 渲染、降低不透明度"——不做骨架屏、不跳布局。
 */
export function useKlGraphFacts(input: KlGraphFactsInput) {
  return useQuery({
    queryKey: ["kl", "graph-facts", input] as const,
    queryFn: async () => unwrap(await window.mycontext.kl.graphFacts(input)),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

/** 优化图谱（kl improve：SIMILAR_TO 边 + 消歧 + 社群）。出网烧 LLM，几分钟。 */
export function useKlGraphOptimize() {
  const queryClient = useQueryClient()
  return useMutation({
    /** ★ 与 `useKlGraphBuild` 同款按渠道（见那里的注释）。 */
    mutationFn: async (channelId?: string) =>
      unwrap(await window.mycontext.kl.graphOptimize(channelId)),
    // 优化会补边与社群 —— 概览上的边数会变，跑完要重取。
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["kl", "graph-overview"] })
    },
  })
}

/**
 * 仪表盘的时序 + 消化漏斗。
 *
 * ## ★ 为什么不跟着 `ingestSnapshot` 走
 *
 * 那个快照每批采集都推一次，而这一份按天分桶实测 108ms（本机 32,878 行）
 * —— 完整推理见主进程 `dashboard-trends.service.ts` 的文件头。
 * 主进程侧按 changelog head 缓存，所以重复调用是便宜的（head 未变即命中）。
 *
 * ## ★ `staleTime` 与轮询
 *
 * 30s：数据只在"采集进了新消息"或"建图跑完"时才变，而两者都是分钟级。
 * 建图中 5s 轮询 —— 那时用户正等着看漏斗后三级长上去
 * （与 `useKlGraphOverview` 同一个理由）。
 *
 * ★ `placeholderData: keepPreviousData`：切周期时 queryKey 变，
 * 没有它整张图会先塌成空再画回来（闪一下）。规范要求重取时保持上一次
 * 渲染 —— 不做骨架屏、不跳布局。
 */
export function useDashboardTrends(days: number, building: boolean) {
  return useQuery({
    queryKey: ["dashboard", "trends", days] as const,
    queryFn: async () => unwrap(await window.mycontext.dashboard.trends({ days })),
    placeholderData: keepPreviousData,
    refetchInterval: building ? 5_000 : false,
    staleTime: 30_000,
  })
}
