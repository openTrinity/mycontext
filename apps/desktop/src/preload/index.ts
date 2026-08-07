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
  onboarding: {
    complete: () => ipcRenderer.invoke(IPC_CHANNELS.onboardingComplete),
    skip: () => ipcRenderer.invoke(IPC_CHANNELS.onboardingSkip),
    steps: () => ipcRenderer.invoke(IPC_CHANNELS.onboardingSteps),
    stepDone: (input) => ipcRenderer.invoke(IPC_CHANNELS.onboardingStepDone, input),
    stepSkip: (input) => ipcRenderer.invoke(IPC_CHANNELS.onboardingStepSkip, input),
    restart: () => ipcRenderer.invoke(IPC_CHANNELS.onboardingRestart),
  },
  distill: {
    sources: () => ipcRenderer.invoke(IPC_CHANNELS.distillSources),
    sourceSave: (input) => ipcRenderer.invoke(IPC_CHANNELS.distillSourceSave, input),
    sourceReset: (input) => ipcRenderer.invoke(IPC_CHANNELS.distillSourceReset, input),
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
    limits: () => ipcRenderer.invoke(IPC_CHANNELS.personaLimits),
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
    selfAvatar: () => ipcRenderer.invoke(IPC_CHANNELS.mediaSelfAvatar),
  },
  preferences: {
    setLanguage: (input) => ipcRenderer.invoke(IPC_CHANNELS.preferencesSetLanguage, input),
    setQuitConfirmSuppressed: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.preferencesSetQuitConfirm, input),
  },
  profile: {
    update: (input) => ipcRenderer.invoke(IPC_CHANNELS.profileUpdate, input),
  },
  ingest: {
    snapshot: () => ipcRenderer.invoke(IPC_CHANNELS.ingestSnapshot),
    runOnce: () => ipcRenderer.invoke(IPC_CHANNELS.ingestRunOnce),
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
    feedInfo: () => ipcRenderer.invoke(IPC_CHANNELS.pipelineFeedInfo),
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
    serverStart: () => ipcRenderer.invoke(IPC_CHANNELS.klServerStart),
    serverStop: () => ipcRenderer.invoke(IPC_CHANNELS.klServerStop),
    graphBuild: (fresh?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.klGraphBuild, fresh ?? false),
    graphOverview: () => ipcRenderer.invoke(IPC_CHANNELS.klGraphOverview),
    graphOptimize: () => ipcRenderer.invoke(IPC_CHANNELS.klGraphOptimize),
    graphEgo: () => ipcRenderer.invoke(IPC_CHANNELS.klGraphEgo),
    graphFacts: (input) => ipcRenderer.invoke(IPC_CHANNELS.klGraphFacts, input),
    onStatus: (listener) => {
      const handler = (_event: unknown, payload: KlServerStatus) => listener(payload)
      ipcRenderer.on(IPC_EVENTS.klServerStatus, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.klServerStatus, handler)
    },
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
