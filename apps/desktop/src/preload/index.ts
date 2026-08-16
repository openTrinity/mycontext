/**
 * preload：contextBridge 暴露最小 API 面。
 *
 * 只暴露具名方法，不暴露 ipcRenderer 本身——否则渲染层可以调任意通道，
 * contextIsolation 的隔离意义就没了。事件订阅同理：只给具名的 onAuthProgress，
 * 不给通用的 on(channel, listener)。
 */
import { contextBridge, ipcRenderer } from "electron"
import { IPC_CHANNELS, IPC_EVENTS } from "@mycontext/ipc-contract"
import type {
  ChannelAuthProgressEvent,
  ChannelAuthStartInput,
  Credentials,
  DistillProgressView,
  IngestSnapshot,
  MyContextApi,
  PersonaSnapshotView,
  PersonaTraceEvent,
  QuitDecision,
  KlServerStatus,
  SearchStreamEvent,
} from "@mycontext/ipc-contract"

const api: MyContextApi = {
  app: {
    bootstrapState: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrapState),
    statusReport: () => ipcRenderer.invoke(IPC_CHANNELS.statusReport),
    onQuitRequested: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(IPC_EVENTS.shellQuitRequested, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.shellQuitRequested, handler)
    },
    quitDecision: (input: QuitDecision) =>
      ipcRenderer.invoke(IPC_CHANNELS.shellQuitDecision, input),
    onQuitting: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(IPC_EVENTS.shellQuitting, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.shellQuitting, handler)
    },
  },
  auth: {
    register: (input: Credentials) => ipcRenderer.invoke(IPC_CHANNELS.register, input),
    login: (input: Credentials) => ipcRenderer.invoke(IPC_CHANNELS.login, input),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.logout),
  },
  channels: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.channelList),
    authStatus: (input) => ipcRenderer.invoke(IPC_CHANNELS.channelAuthStatus, input),
    authStart: (input: ChannelAuthStartInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.channelAuthStart, input),
    authCancel: (input) => ipcRenderer.invoke(IPC_CHANNELS.channelAuthCancel, input),
    authReset: (input) => ipcRenderer.invoke(IPC_CHANNELS.channelAuthReset, input),
    onAuthProgress: (listener) => {
      const handler = (_event: unknown, payload: ChannelAuthProgressEvent) => listener(payload)
      ipcRenderer.on(IPC_EVENTS.channelAuthProgress, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.channelAuthProgress, handler)
    },
    adoptableSession: () => ipcRenderer.invoke(IPC_CHANNELS.channelAdoptableSession),
    adoptSession: () => ipcRenderer.invoke(IPC_CHANNELS.channelAdoptSession),
    identityList: () => ipcRenderer.invoke(IPC_CHANNELS.channelIdentityList),
    identitySwitch: (input) => ipcRenderer.invoke(IPC_CHANNELS.channelIdentitySwitch, input),
    conversations: () => ipcRenderer.invoke(IPC_CHANNELS.channelConversations),
    dataWipe: (input) => ipcRenderer.invoke(IPC_CHANNELS.channelDataWipe, input ?? {}),
  },
  storage: {
    usage: () => ipcRenderer.invoke(IPC_CHANNELS.storageUsage),
    clearCaches: (input) => ipcRenderer.invoke(IPC_CHANNELS.clearCaches, input ?? {}),
  },
  onboarding: {
    complete: () => ipcRenderer.invoke(IPC_CHANNELS.onboardingComplete),
    skip: () => ipcRenderer.invoke(IPC_CHANNELS.onboardingSkip),
    steps: () => ipcRenderer.invoke(IPC_CHANNELS.onboardingSteps),
    stepDone: (input) => ipcRenderer.invoke(IPC_CHANNELS.onboardingStepDone, input),
    stepSkip: (input) => ipcRenderer.invoke(IPC_CHANNELS.onboardingStepSkip, input),
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.onboardingRestart),
  },
  distill: {
    sources: (input) => ipcRenderer.invoke(IPC_CHANNELS.distillSources, input ?? {}),
    sourceSave: (input) => ipcRenderer.invoke(IPC_CHANNELS.distillSourceSave, input),
    sourceReset: (input) => ipcRenderer.invoke(IPC_CHANNELS.distillSourceReset, input),
    chatCoverage: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatCoverage, input),
    documentSpaces: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentSpaces, input),
    attentionScope: (input) => ipcRenderer.invoke(IPC_CHANNELS.attentionScope, input),
    attentionScopeSave: (input) => ipcRenderer.invoke(IPC_CHANNELS.attentionScopeSave, input),
    attentionScopeDisable: (input) => ipcRenderer.invoke(IPC_CHANNELS.attentionScopeDisable, input),
    progress: () => ipcRenderer.invoke(IPC_CHANNELS.distillProgress),
    start: (input) => ipcRenderer.invoke(IPC_CHANNELS.distillStart, input),
    reset: () => ipcRenderer.invoke(IPC_CHANNELS.distillReset),
    onProgress: (listener) => {
      const handler = (_event: unknown, payload: DistillProgressView) => listener(payload)
      ipcRenderer.on(IPC_EVENTS.distillProgress, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.distillProgress, handler)
    },
  },
  persona: {
    snapshot: () => ipcRenderer.invoke(IPC_CHANNELS.personaSnapshot),
    conversations: () => ipcRenderer.invoke(IPC_CHANNELS.personaConversations),
    configSave: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaConfigSave, input),
    limits: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaLimits, input ?? {}),
    limitsSave: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaLimitsSave, input),
    messages: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaMessages, input),
    drafts: () => ipcRenderer.invoke(IPC_CHANNELS.personaDrafts),
    draftResolve: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaDraftResolve, input),
    composeSend: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaComposeSend, input),
    runs: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaRuns, input),
    runTrace: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaRunTrace, input),
    runDetail: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaRunDetail, input),
    liveTrace: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaLiveTrace, input),
    onTrace: (listener) => {
      const handler = (_event: unknown, payload: PersonaTraceEvent) => listener(payload)
      ipcRenderer.on(IPC_EVENTS.personaTrace, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.personaTrace, handler)
    },
    activities: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaActivities, input),
    members: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaMembers, input),
    searchMessages: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaSearchMessages, input),
    killSwitch: (input) => ipcRenderer.invoke(IPC_CHANNELS.personaKillSwitch, input),
    tick: () => ipcRenderer.invoke(IPC_CHANNELS.personaTick),
    onSnapshot: (listener) => {
      const handler = (_event: unknown, payload: PersonaSnapshotView) => listener(payload)
      ipcRenderer.on(IPC_EVENTS.personaSnapshot, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.personaSnapshot, handler)
    },
  },
  media: {
    download: (input) => ipcRenderer.invoke(IPC_CHANNELS.mediaDownload, input),
    downloadForMessages: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.mediaDownloadForMessages, input),
    avatars: (input) => ipcRenderer.invoke(IPC_CHANNELS.mediaAvatars, input),
    avatarsFetch: (input) => ipcRenderer.invoke(IPC_CHANNELS.mediaAvatarsFetch, input),
    uploadImage: (input) => ipcRenderer.invoke(IPC_CHANNELS.mediaUploadImage, input),
    saveAs: (input) => ipcRenderer.invoke(IPC_CHANNELS.mediaSaveAs, input),
    selfAvatar: (input) => ipcRenderer.invoke(IPC_CHANNELS.mediaSelfAvatar, input ?? {}),
  },
  preferences: {
    setLanguage: (input) => ipcRenderer.invoke(IPC_CHANNELS.preferencesSetLanguage, input),
    setQuitConfirmSuppressed: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.preferencesSetQuitConfirm, input),
    setWorkLayerEnabled: (input) => ipcRenderer.invoke(IPC_CHANNELS.preferencesSetWorkLayer, input),
  },
  profile: {
    update: (input) => ipcRenderer.invoke(IPC_CHANNELS.profileUpdate, input),
  },
  ingest: {
    snapshot: () => ipcRenderer.invoke(IPC_CHANNELS.ingestSnapshot),
    runOnce: (input) => ipcRenderer.invoke(IPC_CHANNELS.ingestRunOnce, input ?? {}),
    clearBlocked: () => ipcRenderer.invoke(IPC_CHANNELS.ingestClearBlocked),
    resolveSelf: () => ipcRenderer.invoke(IPC_CHANNELS.ingestResolveSelf),
    confirmSelf: () => ipcRenderer.invoke(IPC_CHANNELS.ingestConfirmSelf),
    readSelf: () => ipcRenderer.invoke(IPC_CHANNELS.ingestReadSelf),
    intervals: () => ipcRenderer.invoke(IPC_CHANNELS.ingestIntervals),
    intervalsSave: (input) => ipcRenderer.invoke(IPC_CHANNELS.ingestIntervalsSave, input),
    onProgress: (listener) => {
      const handler = (_event: unknown, payload: IngestSnapshot) => listener(payload)
      ipcRenderer.on(IPC_EVENTS.ingestProgress, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.ingestProgress, handler)
    },
  },
  pipeline: {
    feedInfo: (input) => ipcRenderer.invoke(IPC_CHANNELS.pipelineFeedInfo, input ?? {}),
    export: () => ipcRenderer.invoke(IPC_CHANNELS.pipelineExport),
  },
  search: {
    sessionList: () => ipcRenderer.invoke(IPC_CHANNELS.searchSessionList),
    sessionDetail: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchSessionDetail, input),
    sessionCreate: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchSessionCreate, input),
    sessionRename: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchSessionRename, input),
    sessionPin: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchSessionPin, input),
    sessionDelete: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchSessionDelete, input),
    prompt: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchPrompt, input),
    cancel: (input) => ipcRenderer.invoke(IPC_CHANNELS.searchCancel, input),
    onStream: (listener) => {
      const handler = (_event: unknown, payload: SearchStreamEvent) => listener(payload)
      ipcRenderer.on(IPC_EVENTS.searchStream, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.searchStream, handler)
    },
  },
  kl: {
    serverStatus: () => ipcRenderer.invoke(IPC_CHANNELS.klServerStatus),
    serverStart: (input) => ipcRenderer.invoke(IPC_CHANNELS.klServerStart, input ?? {}),
    serverStop: (input) => ipcRenderer.invoke(IPC_CHANNELS.klServerStop, input ?? {}),
    /**
     * ★★ `channelId` 必须转发 —— 少了它，"给谁建图"这件事就丢了。
     *
     * 这里原来是 `(fresh?: boolean) => invoke(channel, fresh ?? false)`：
     * 渲染层传了两个参数、主进程 handler 也收两个（`register.ts` 那条
     * `(_event, fresh, channelId)`），但**这一层只转发第一个** ——
     * 于是 `channelId` 恒为 undefined，走进"不指定渠道就全建"那条路。
     *
     * 实测后果（本机日志）：在飞书那栏点一次「建图」，
     * `[Main:KlServer] graph build started` 与
     * `[Main:KlServer:feishu] graph build started` **各来一条** ——
     * 建了两个渠道。而 `fresh=true` 走同一条路，也就是在飞书那栏点「重建」
     * 会把主渠道那份图一起删了重烧（不可逆、几小时、出网烧 LLM）。
     *
     * ★ 为什么 typecheck 没拦住：契约里是
     * `graphBuild(fresh?: boolean, channelId?: string)`，而 TS 允许把
     * **少参数**的函数赋给多参数的类型（刻意的规则，不是 bug）。
     * 所以这一层的漏参是类型系统天然看不见的一类 ——
     * 门禁在 `tests/unit/desktop/preload-arity.test.ts`。
     */
    graphBuild: (fresh?: boolean, channelId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.klGraphBuild, fresh ?? false, channelId),
    graphOverview: (input) => ipcRenderer.invoke(IPC_CHANNELS.klGraphOverview, input ?? {}),
    graphOptimize: (channelId) => ipcRenderer.invoke(IPC_CHANNELS.klGraphOptimize, channelId),
    graphEgo: (input) => ipcRenderer.invoke(IPC_CHANNELS.klGraphEgo, input ?? {}),
    graphFacts: (input) => ipcRenderer.invoke(IPC_CHANNELS.klGraphFacts, input),
    onStatus: (listener) => {
      const handler = (_event: unknown, payload: KlServerStatus) => listener(payload)
      ipcRenderer.on(IPC_EVENTS.klServerStatus, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.klServerStatus, handler)
    },
  },
  dashboard: {
    trends: (input) => ipcRenderer.invoke(IPC_CHANNELS.dashboardTrends, input),
  },
  advancedAi: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.advancedAiRead),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.advancedAiSave, input),
  },
  dwsSource: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.dwsSourceRead),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.dwsSourceSave, input),
  },
  runtimeConfig: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeConfigRead),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.runtimeConfigSave, input),
    probe: (input) => ipcRenderer.invoke(IPC_CHANNELS.runtimeConfigProbe, input),
    onChanged: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(IPC_EVENTS.runtimeConfigChanged, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.runtimeConfigChanged, handler)
    },
  },
}

contextBridge.exposeInMainWorld("mycontext", api)
