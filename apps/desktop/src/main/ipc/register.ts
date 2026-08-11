/**
 * IPC 注册。
 *
 * 统一约定：
 * - 入参先过 contract 里的 zod schema，非法直接返回 IPC_BAD_REQUEST（不进业务）
 * - 一律返回 Result<T>，不让异常跨进程（Error 无法结构化克隆，code 会丢失）
 * - handler 表由 MyContextApi 的类型反推，漏注册会在编译期报错
 */
import { app, ipcMain } from "electron"
import { randomUUID } from "node:crypto"
import { scopedChannelId, sourceKeyOf } from "@mycontext/channels"
import { attempt, AppError, type Logger } from "@mycontext/kernel"
import {
  IPC_CHANNELS,
  channelAuthStartInputSchema,
  channelIdInputSchema,
  channelIdentitySwitchInputSchema,
  createSearchSessionInputSchema,
  credentialsSchema,
  distillSourceResetInputSchema,
  channelDataWipeInputSchema,
  distillSourceSaveInputSchema,
  distillStartInputSchema,
  personaConfigSaveInputSchema,
  personaDraftResolveInputSchema,
  personaComposeSendInputSchema,
  personaKillSwitchInputSchema,
  personaRuntimeLimitsSchema,
  mediaDownloadInputSchema,
  mediaDownloadForMessagesInputSchema,
  mediaAvatarsInputSchema,
  mediaUploadImageInputSchema,
  mediaSaveAsInputSchema,
  klGraphFactsInputSchema,
  dashboardTrendsInputSchema,
  personaMessagesInputSchema,
  personaRunsInputSchema,
  personaRunDetailInputSchema,
  personaRunTraceInputSchema,
  personaLiveTraceInputSchema,
  personaActivitiesInputSchema,
  personaMembersInputSchema,
  personaSearchMessagesInputSchema,
  onboardingStepDoneInputSchema,
  onboardingStepSkipInputSchema,
  pinSearchSessionInputSchema,
  renameSearchSessionInputSchema,
  searchPromptInputSchema,
  searchSessionIdInputSchema,
  saveAdvancedAiInputSchema,
  saveDwsSourceInputSchema,
  saveRuntimeConfigInputSchema,
  probeRuntimeConfigInputSchema,
  saveIngestIntervalsInputSchema,
  setLanguageInputSchema,
  setQuitConfirmInputSchema,
  setWorkLayerInputSchema,
  updateProfileInputSchema,
} from "@mycontext/ipc-contract"
import type { BootstrapState } from "@mycontext/ipc-contract"
import { z } from "zod"
import type { AuthService } from "../services/auth.service.js"
import type { ChannelService } from "../services/channel.service.js"
import type { ActiveIdentityService } from "../services/active-identity.service.js"
import type { OnboardingService } from "../services/onboarding.service.js"
import type { DistillSourceService } from "../services/distill-source.service.js"
import type { DistillService } from "../services/distill.service.js"
import type { MediaService } from "../services/media.service.js"
import { toLocalFileUrl } from "../windows/local-file-url.js"
import {
  adoptExistingSession,
  describeAdoptableSession,
  routeAuthorizedIdentity,
} from "../bootstrap/post-auth-identity.js"
import type { PersonaService } from "../services/persona.service.js"
import type { PreferencesService } from "../services/preferences.service.js"
import type { StatusService } from "../services/status.service.js"
import type { DataPlaneService } from "../services/data-plane.service.js"
import type { SearchService } from "../services/search.service.js"
import type { KlServerService } from "../services/kl-server.service.js"
import type { GraphQueryService } from "../services/graph-query.service.js"
import type { DashboardTrendsService } from "../services/dashboard-trends.service.js"
import type { AdvancedAiService } from "../services/advanced-ai.service.js"
import type { DwsSourceService } from "../services/dws-source.service.js"
import type { ChannelDataWipeService } from "../services/channel-data-wipe.service.js"
import type { RuntimeConfigService } from "../services/runtime-config.service.js"

export interface IpcDependencies {
  auth: AuthService
  status: StatusService
  channels: ChannelService
  /** 身份切换器 —— 列身份与切身份两个通道用它 */
  activeIdentity: ActiveIdentityService
  onboarding: OnboardingService
  distillSources: DistillSourceService
  distill: DistillService
  persona: PersonaService
  media: MediaService
  preferences: PreferencesService
  dataPlane: DataPlaneService
  search: SearchService
  /**
   * ★ `graphOverview` 的签名比 `KlServerService` 的宽一个可选参数（渠道 id）——
   * 装配层传的是 `MultiKlServerService`，它按 id 路由到对应的图库。
   */
  klServer: Pick<KlServerService, "status"> & {
    ensureReady(channelId?: string): ReturnType<KlServerService["ensureReady"]>
    stop(channelId?: string): ReturnType<KlServerService["stop"]>
    graphOverview(channelId?: string): ReturnType<KlServerService["graphOverview"]>
    rebuildGraph(fresh?: boolean, channelId?: string): ReturnType<KlServerService["rebuildGraph"]>
    optimizeGraph(channelId?: string): ReturnType<KlServerService["optimizeGraph"]>
  }
  /**
   * 图谱只读查询。
   *
   * ★ `ego` 的签名比 `GraphQueryService` 的宽一个可选参数（渠道 id）——
   * 装配层传进来的是 `MultiGraphQueryService`，它按 id 路由到对应的图库。
   * 界面上图谱是**切换**而不是混合：同一个人在两个渠道是两个 external_id，
   * 没有安全的映射（见 `MultiGraphQueryService.ego`）。
   *
   * 用结构类型而不是那个具体类：这一层只需要这两个方法。
   */
  graphQuery: {
    ego(channelId?: string): ReturnType<GraphQueryService["ego"]>
    facts(input: Parameters<GraphQueryService["facts"]>[0]): ReturnType<GraphQueryService["facts"]>
  }
  /** 仪表盘的时序 + 消化漏斗（独立通道，见该服务的文件头） */
  dashboardTrends: DashboardTrendsService
  advancedAi: AdvancedAiService
  dwsSource: DwsSourceService
  runtimeConfig: RuntimeConfigService
  /** 清空当前渠道数据（不可逆，默认只预演）。见那个服务的文件头 */
  channelDataWipe: ChannelDataWipeService
  logger: Logger
}

/** 校验入参并返回解析后的值；失败抛 AppError 由 attempt 收敛。 */
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new AppError("IPC_BAD_REQUEST", "请求参数不合法", {
      messageKey: "errors:ipc.badRequest",
      context: { issues: result.error.issues.map((issue) => issue.path.join(".")) },
    })
  }
  return result.data
}

const statusInputSchema = z.object({
  channelId: z.string().min(1),
  refresh: z.boolean().optional(),
})

export function registerIpc(deps: IpcDependencies): void {
  const {
    auth,
    status,
    channels,
    activeIdentity,
    onboarding,
    distillSources,
    distill,
    persona,
    media,
    preferences,
    dataPlane,
    search,
    klServer,
    graphQuery,
    dashboardTrends,
    advancedAi,
    dwsSource,
    runtimeConfig,
    channelDataWipe,
    logger,
  } = deps

  ipcMain.handle(IPC_CHANNELS.bootstrapState, () =>
    attempt<BootstrapState>(async () => {
      const session = auth.currentSession()
      /**
       * 只有已登录才判定 onboarding：未登录时先过登录门禁。
       *
       * ★ 判据是**引导自己的进度**，不再看 `hasAnyAuthorized()`。
       *
       * 首版用"有没有渠道已授权"当判据 —— 那在只有"授权"一步时是等价的，
       * 但引导现在有 4 步（授权 / 数字人 / 蒸馏源 / 蒸馏进度），
       * 于是**授权成功就跳过了另外三步**：实测 vault 里没有任何 onboarding
       * 记录（说明没被 dismiss），而 `dws auth status` 返回 authenticated，
       * 引导就再也不出现了。
       *
       * 顺带的好处：不再为了判定引导去跑一次 DWS 子进程（约 0.6s），
       * 启动态因此快了一截。
       */
      const needsOnboarding = session !== null && !onboarding.isDismissed()

      return {
        appVersion: app.getVersion(),
        platform: `${process.platform}-${process.arch}`,
        hasAccount: auth.hasAccount(),
        session,
        needsOnboarding,
        // 随启动态一起下发：渲染层首帧就需要语言，多一次往返就多一次闪烁。
        language: preferences.language(),
        // 同理下发退出确认状态：设置页首帧就要读它。
        quitConfirmSuppressed: preferences.quitConfirmSuppressed(),
        // 工作层开关同理。对一个**花钱**的开关，首帧闪烁（先"关"再跳"开"）
        // 会让人以为自己没开成，于是又点一次。
        workLayerEnabled: preferences.workLayerEnabled(),
      }
    }),
  )

  ipcMain.handle(IPC_CHANNELS.statusReport, () => attempt(() => status.report()))

  ipcMain.handle(IPC_CHANNELS.register, (_event, payload: unknown) =>
    attempt(() => auth.register(parse(credentialsSchema, payload))),
  )

  ipcMain.handle(IPC_CHANNELS.login, (_event, payload: unknown) =>
    attempt(() => auth.login(parse(credentialsSchema, payload))),
  )

  ipcMain.handle(IPC_CHANNELS.logout, () => attempt(() => auth.logout()))

  // ---------------- 渠道 ----------------

  ipcMain.handle(IPC_CHANNELS.channelList, () => attempt(() => channels.list()))

  ipcMain.handle(IPC_CHANNELS.channelAuthStatus, (_event, payload: unknown) =>
    attempt(() => {
      const input = parse(statusInputSchema, payload)
      return channels.status(input.channelId, input.refresh === true)
    }),
  )

  ipcMain.handle(IPC_CHANNELS.channelAuthStart, (_event, payload: unknown) =>
    attempt(() => {
      const input = parse(channelAuthStartInputSchema, payload)
      return channels.startLogin(input.channelId, input.mode)
    }),
  )

  ipcMain.handle(IPC_CHANNELS.channelAuthCancel, (_event, payload: unknown) =>
    attempt(() => channels.cancelLogin(parse(channelIdInputSchema, payload).channelId)),
  )

  /**
   * 「本机有一份可采纳的登录态吗」——**纯查询**，界面渲染那个入口时调。
   *
   * ★ 与下面的 adopt 严格分开：这个只读身份行 + 查一次 `auth status`，
   * 而 adopt 会 spawn 解析身份与取头像。渲染时绝不能顺带触发后者
   * （那正是首版"登录后自动补跑"的毛病，见 post-auth-identity.ts）。
   */
  ipcMain.handle(IPC_CHANNELS.channelAdoptableSession, () =>
    attempt(() =>
      describeAdoptableSession({
        readSelfIdentity: () => dataPlane.readSelfIdentity(),
        channelStatus: () => channels.safeStatus("dingtalk"),
      }),
    ),
  )

  /**
   * 采纳本机已有的登录态（**用户显式点的**）。
   *
   * 不自动做的理由见 `adoptExistingSession` 的注释：自动会替用户选定身份，
   * 而他之后真去授权换组织时反被身份守卫拦住 —— 那个冲突是自动补跑
   * 自己制造的。
   */
  ipcMain.handle(IPC_CHANNELS.channelAdoptSession, () =>
    attempt(async () => {
      /**
       * ★★ 先把身份**路由到它自己的 vault**，再落身份行 —— 与正常授权
       * （`onAuthorized`）走同一条顺序，理由也一样（见 `routeAuthorizedIdentity`）。
       *
       * 漏了这一步的后果（实测，用户日志）：采纳只往当前挂载的库里写一行
       * 身份，而 control 库里**没有** `(account, channel, corp, user) → vault`
       * 那条映射 → `activeIdentity.currentIdentity()` 仍是 null →
       * 渠道命令不钉 profile、采集不起、界面继续显示"未连接"。
       * 也就是说采纳"成功"了但整个应用不认。
       *
       * 路由完成时若真的切了 vault，`mount()` 会带着目标身份重新 attach，
       * 那时 `pollingEnabled` 为真 —— 采集与事件流在这一步才起来。
       */
      const status = await channels.safeStatus("dingtalk")
      if (status.state === "authorized") {
        const session = auth.currentSession()
        const vaultId = auth.currentVaultId()
        await routeAuthorizedIdentity({
          identity: activeIdentity,
          logger,
          session:
            session === null || vaultId === null
              ? null
              : { accountId: session.accountId, baseVaultId: vaultId },
          newVaultId: () => randomUUID(),
          // 同 onAuthorized：必须带「来源应用」那一段（见那里的注释）
          channelId: scopedChannelId("dingtalk", sourceKeyOf(dwsSource.path() ?? undefined)),
          status,
        })
      }
      const adopted = await adoptExistingSession({
        dataPlane,
        media,
        auth,
        logger,
        toFileUrl: toLocalFileUrl,
        readSelfIdentity: () => dataPlane.readSelfIdentity(),
        channelStatus: () => channels.safeStatus("dingtalk"),
      })
      return { adopted }
    }),
  )

  /**
   * 这个账号下的全部渠道身份（界面上的身份切换列表）。
   *
   * ★ 未登录时给空数组而不是抛：设置页在登录前也会渲染，
   * 而"读不到就报错"会让整页红，而事实只是"还没登录"。
   */
  ipcMain.handle(IPC_CHANNELS.channelIdentityList, () =>
    attempt(() => {
      const session = auth.currentSession()
      if (session === null) return []
      return activeIdentity.listView(session.accountId)
    }),
  )

  /**
   * 切到另一个渠道身份。
   *
   * ★ 这是个**重动作**（卸采集/卸 agent/停图谱 → 挂新的），所以由
   * `ActiveIdentityService` 自己串顺序并挡并发（见它的 in-flight 闸）。
   * 这一层只做参数校验与登录态检查。
   */
  ipcMain.handle(IPC_CHANNELS.channelIdentitySwitch, (_event, payload: unknown) =>
    attempt(async () => {
      const input = parse(channelIdentitySwitchInputSchema, payload)
      const session = auth.currentSession()
      if (session === null) throw new AppError("AUTH_NOT_SIGNED_IN", "尚未登录")
      const switched = await activeIdentity.switchTo({
        accountId: session.accountId,
        channelId: input.channelId,
        corpId: input.corpId,
        userId: input.userId,
      })
      return { switched: switched !== null }
    }),
  )

  // ---------------- Onboarding ----------------

  ipcMain.handle(IPC_CHANNELS.onboardingComplete, () => attempt(() => onboarding.complete()))
  ipcMain.handle(IPC_CHANNELS.onboardingSkip, () => attempt(() => onboarding.skip()))
  ipcMain.handle(IPC_CHANNELS.onboardingSteps, () => attempt(() => onboarding.steps()))
  ipcMain.handle(IPC_CHANNELS.onboardingStepDone, (_event, payload: unknown) =>
    attempt(() => {
      const input = parse(onboardingStepDoneInputSchema, payload)
      return onboarding.completeStep(input.step, input.payload)
    }),
  )
  ipcMain.handle(IPC_CHANNELS.onboardingStepSkip, (_event, payload: unknown) =>
    attempt(() => onboarding.skipStep(parse(onboardingStepSkipInputSchema, payload).step)),
  )
  ipcMain.handle(IPC_CHANNELS.onboardingRestart, () => attempt(() => onboarding.restart()))

  // ---------------- 蒸馏资料源 ----------------

  /**
   * ★ 读**某个渠道**的资料源。不给 = 主渠道（存量调用点行为不变）。
   * 不带渠道的后果：采集范围面板切到飞书却显示钉钉的范围，
   * 保存时又把钉钉那批 id 存成飞书的（见 `DistillSourceService.list`）。
   */
  ipcMain.handle(IPC_CHANNELS.distillSources, (_event, payload: unknown) =>
    attempt(() => {
      const channelId = (payload as { channelId?: unknown } | null)?.channelId
      return distillSources.list(typeof channelId === "string" ? channelId : undefined)
    }),
  )
  ipcMain.handle(IPC_CHANNELS.distillSourceSave, (_event, payload: unknown) =>
    attempt(() => distillSources.save(parse(distillSourceSaveInputSchema, payload))),
  )
  ipcMain.handle(IPC_CHANNELS.distillSourceReset, (_event, payload: unknown) =>
    attempt(() => distillSources.reset(parse(distillSourceResetInputSchema, payload).kind)),
  )
  // 走子进程拿全量会话（约 5s，三路合并）。失败会降级成本地列表而不是报错。
  ipcMain.handle(IPC_CHANNELS.channelConversations, () =>
    attempt(() => distillSources.conversations()),
  )

  /**
   * 清空当前渠道的数据。**不可逆**，所以 schema 里 `dryRun` 默认 true ——
   * 漏传参数的后果是"只报了个数"而不是"删掉几万条真实聊天记录"。
   */
  ipcMain.handle(IPC_CHANNELS.channelDataWipe, (_event, payload: unknown) =>
    attempt(() => channelDataWipe.wipe(parse(channelDataWipeInputSchema, payload))),
  )

  // ---------------- 蒸馏执行 ----------------

  ipcMain.handle(IPC_CHANNELS.distillProgress, () => attempt(() => distill.progress()))
  ipcMain.handle(IPC_CHANNELS.distillStart, (_event, payload: unknown) =>
    attempt(() => distill.start(parse(distillStartInputSchema, payload))),
  )
  ipcMain.handle(IPC_CHANNELS.distillReset, () => attempt(() => distill.reset()))

  // ---------------- 数字人 ----------------

  ipcMain.handle(IPC_CHANNELS.personaSnapshot, () => attempt(() => persona.snapshot()))
  ipcMain.handle(IPC_CHANNELS.personaConversations, () => attempt(() => persona.conversations()))
  ipcMain.handle(IPC_CHANNELS.personaConfigSave, (_event, payload: unknown) =>
    attempt(() => persona.saveConfig(parse(personaConfigSaveInputSchema, payload))),
  )
  ipcMain.handle(IPC_CHANNELS.personaMessages, (_event, payload: unknown) =>
    attempt(() => {
      const input = parse(personaMessagesInputSchema, payload)
      return persona.messages(input.conversationId, input.limit, input.includeIds)
    }),
  )
  ipcMain.handle(IPC_CHANNELS.personaDrafts, () => attempt(() => persona.drafts()))
  ipcMain.handle(IPC_CHANNELS.personaDraftResolve, (_event, payload: unknown) =>
    attempt(() => persona.resolveDraft(parse(personaDraftResolveInputSchema, payload))),
  )
  ipcMain.handle(IPC_CHANNELS.personaComposeSend, (_event, payload: unknown) =>
    attempt(() => persona.composeSend(parse(personaComposeSendInputSchema, payload))),
  )
  ipcMain.handle(IPC_CHANNELS.personaRunTrace, (_event, payload: unknown) =>
    attempt(() => persona.runTrace(parse(personaRunTraceInputSchema, payload).runId)),
  )
  ipcMain.handle(IPC_CHANNELS.personaRunDetail, (_event, payload: unknown) =>
    attempt(() => persona.runDetail(parse(personaRunDetailInputSchema, payload).runId)),
  )
  ipcMain.handle(IPC_CHANNELS.personaLiveTrace, (_event, payload: unknown) =>
    attempt(() => persona.liveTrace(parse(personaLiveTraceInputSchema, payload).conversationId)),
  )

  ipcMain.handle(IPC_CHANNELS.personaRuns, (_event, payload: unknown) =>
    attempt(() => persona.runs(parse(personaRunsInputSchema, payload).conversationId)),
  )
  ipcMain.handle(IPC_CHANNELS.personaActivities, (_event, payload: unknown) =>
    attempt(() => persona.activities(parse(personaActivitiesInputSchema, payload).conversationId)),
  )
  ipcMain.handle(IPC_CHANNELS.personaMembers, (_event, payload: unknown) =>
    attempt(() => persona.members(parse(personaMembersInputSchema, payload).conversationId)),
  )
  ipcMain.handle(IPC_CHANNELS.personaSearchMessages, (_event, payload: unknown) =>
    attempt(() => persona.searchMessages(parse(personaSearchMessagesInputSchema, payload))),
  )
  ipcMain.handle(IPC_CHANNELS.personaKillSwitch, (_event, payload: unknown) =>
    attempt(() => {
      persona.setKillSwitch(parse(personaKillSwitchInputSchema, payload).active)
      return true as const
    }),
  )
  ipcMain.handle(IPC_CHANNELS.personaTick, () => attempt(() => persona.tick()))
  ipcMain.handle(IPC_CHANNELS.personaLimits, () => attempt(() => persona.limits()))
  ipcMain.handle(IPC_CHANNELS.personaLimitsSave, (_event, payload: unknown) =>
    /**
     * `.partial()`：设置页每次只改一项，全字段必填会让 UI 必须回传
     * 一份完整快照 —— 而那份快照可能是它上次读到的旧值，
     * 于是"改并发"会把别人刚改的 LRU 覆盖回去。
     */
    attempt(() => persona.limitsSave(parse(personaRuntimeLimitsSchema.partial(), payload))),
  )

  // ---------------- 媒体与头像 ----------------

  ipcMain.handle(IPC_CHANNELS.mediaDownload, (_event, payload: unknown) =>
    attempt(async () => {
      const result = await media.download(parse(mediaDownloadInputSchema, payload).mediaId)
      // 同上：渲染层要的是能加载的 URL，不是磁盘路径
      return result.path === undefined ? result : { ...result, path: toLocalFileUrl(result.path) }
    }),
  )
  /**
   * 一屏消息的媒体一次下完。
   *
   * 不返回路径 —— 只返回计数。渲染层拿到"下了几个"之后**重新查一次消息**
   * （`invalidateQueries`），路径会随消息一起回来（那里已经转过
   * `mycontext-file://`）。让这个通道也返回路径等于把同一份数据从两条路
   * 送出去，而它们会不一致（这一条下完的瞬间，另一条还是旧的）。
   */
  ipcMain.handle(IPC_CHANNELS.mediaDownloadForMessages, (_event, payload: unknown) =>
    attempt(() =>
      media.downloadForMessages(parse(mediaDownloadForMessagesInputSchema, payload).messageIds),
    ),
  )
  /**
   * 一批人的头像。
   *
   * ## ★ 这个通道**只读缓存**，永不起子进程
   *
   * 改动前它既读缓存又负责去取，于是 60 个人共享**一次成败**：任何一个人
   * 的 CLI 抛错（exit≠0 / 30s 超时）都让整个 `attempt` 返回 failure，
   * 渲染层 `data` 变 `undefined`，**这一屏所有头像一起退回首字母** ——
   * 包括那 154 个只需要读一行 SQL 的人。而 `retry: false`（main.tsx）
   * 意味着一次失败就停在失败上。这正是"时好时坏、像在重新加载"的成因。
   *
   * 现在：读缓存立刻返回（失败面只剩 SQLite 自己），去取交给
   * `mediaAvatarsFetch`。已经取到过的头像于是变成**必然显示**的。
   */
  ipcMain.handle(IPC_CHANNELS.mediaAvatars, (_event, payload: unknown) =>
    attempt(() => {
      const input = parse(mediaAvatarsInputSchema, payload)
      return media.avatarsFromCache(input.externalIds).map((entry) => ({
        externalId: entry.externalId,
        /**
         * ★ 返回的是 `mycontext-file://` URL，不是文件系统路径。
         *
         * 实测：从 `http://localhost:5273`（dev 的渲染层 origin）加载
         * `file://` 被 Chromium 直接拦掉，而失败是**静默**的
         * （`<img onerror>` → 回退到首字母兜底）。踩过一次：
         * 23 个头像下载成功、界面上 img 数量是 0。
         */
        path: entry.path === null ? null : toLocalFileUrl(entry.path),
        missReason: entry.missReason,
        needsFetch: entry.needsFetch,
      }))
    }),
  )

  /**
   * 去取那些还没取到的头像。**每个人独立成败。**
   *
   * ## ★ 为什么与 `mediaAvatars` 分开
   *
   * 见那个通道的注释：混在一起时一个人的超时会带走整批。分开之后
   * 渲染层的流程是「先读缓存（快、不会失败）→ 再补齐（慢、可能部分失败）
   * → 补完重读缓存」，于是**任何一次抖动最多影响一个人**。
   *
   * ## 串行而不是 Promise.all
   *
   * 每个头像要 2-3 次子进程调用；并发 60 个会同时起上百个子进程，
   * 而 DWS 本身也会限流 —— 那时它们会一起失败，然后因为
   * `failed` 是可重试的，下次打开页面再一起失败一遍。
   *
   * ## ★ 只返回计数，不返回路径
   *
   * 与 `mediaDownloadForMessages` 同一个理由：让两个通道都能给出路径
   * 等于把同一份数据从两条路送出去，而它们会不一致。
   * 渲染层拿到"取到了几个"之后重读缓存那条通道。
   */
  ipcMain.handle(IPC_CHANNELS.mediaAvatarsFetch, (_event, payload: unknown) =>
    attempt(async () => {
      const input = parse(mediaAvatarsInputSchema, payload)
      let fetched = 0
      let failed = 0
      for (const externalId of input.externalIds) {
        /**
         * ★ `nick` 必须传下去。
         *
         * 没有共同群时取头像要靠 `chat search-common --nicks <花名>`，
         * 而那个参数缺失时 `findViaCommonGroups` **立刻返回 null、
         * 一次命令都不调** —— 结果是 `path: null, reason: null`，
         * 看起来像"这个人没设头像"（正常），实际是我们没去找。
         * 实测踩到：48 个单聊对方全部 `reason: ok` 而 path 全空。
         */
        const nick = input.nickByExternalId?.[externalId]
        /**
         * ★ 逐个 try/catch —— 这是"一个人的失败只影响他自己"的**第二道**保险。
         *
         * `media.avatar()` 内部已经 catch 了渠道抛的错（转成 `failed` 并
         * 落一条可重试的 miss）。这一层兜的是它**之外**的意外
         * （比如 SQLite 写失败）。两层都有是刻意的：这个循环的不变式是
         * "无论如何都要走完 60 个人"，而它不该依赖被调方的实现细节。
         */
        try {
          const result = await media.avatar({
            externalId,
            ...(nick === undefined || nick === "" ? {} : { nick }),
            ...(input.groupExternalId === undefined || input.groupExternalId === null
              ? {}
              : { groupExternalId: input.groupExternalId }),
          })
          if (result.path === null) failed += 1
          else fetched += 1
        } catch (error) {
          failed += 1
          logger.warn("avatar fetch failed", {
            externalId: externalId.slice(0, 8),
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return { fetched, failed }
    }),
  )

  /**
   * 取本人头像并回填账号。
   *
   * ★ 两件事一起做是刻意的：取到了就该显示出来，而"显示"意味着写账号。
   * 分成两个调用的话渲染层要自己保证顺序，而它没有理由知道
   * "manual 不被覆盖"这条规则。
   *
   * ★ `force: true` —— 这个通道的**唯一**入口是设置页那个「从渠道获取」
   * 按钮（用户显式点击）。不 force 的话缓存命中会直接返回那张旧图，
   * 于是"我在钉钉换了头像"这个最主要的使用场景点多少次都没反应。
   * 批量取头像走的是 `mediaAvatars`，那条路不 force。
   */
  ipcMain.handle(IPC_CHANNELS.mediaSelfAvatar, () =>
    attempt(async () => {
      const result = await media.selfAvatar({ force: true })
      if (result.path === null) return { path: null, reason: result.reason }
      /**
       * ★ 必须转成 `mycontext-file://` 才交给渲染层。
       *
       * 第一版这里直接返回了裸的文件系统路径 —— 而渲染层拿一个
       * `/tmp/…/x.jpg` 当 `<img src>` 用是**加载不了**的
       * （相对当前 origin 解析成 `http://localhost:5273/tmp/…`）。
       * 而失败是静默的：`Avatar` 的 onError 切到首字母兜底，
       * 界面看起来就是"取头像这个功能没做"。
       *
       * 这个坑在本仓库栽过一次（`file://` 那次：23 个头像下载成功、
       * DOM 里 img 数量是 0）。旁边的 `mediaAvatars` 与 `mediaUploadImage`
       * 都转了，只有这个新通道漏了 —— 靠在真应用里调一次 IPC 发现的。
       */
      const url = toLocalFileUrl(result.path)
      /**
       * 写账号时遵守 manual 优先（`applyChannelProfile` 内部判）。
       *
       * ★ 这里**只**传头像，不带显示名：这个通道是「从渠道获取头像」这个
       * 用户显式动作，他点的是头像按钮 —— 顺带改掉他的显示名会是个意外。
       * 显示名的回填在授权后那条链上（`startup.ts` 的 `onAuthorized`）。
       */
      const written = auth.applyChannelProfile({ avatarUrl: url }).avatarWritten
      return { path: url, reason: null, written }
    }),
  )
  ipcMain.handle(IPC_CHANNELS.mediaUploadImage, (_event, payload: unknown) =>
    attempt(() => {
      const saved = media.saveUploadedImage(parse(mediaUploadImageInputSchema, payload))
      // 同上。上传完要立刻显示预览，所以这里也必须给可加载的 URL
      return { ...saved, path: toLocalFileUrl(saved.path) }
    }),
  )
  /**
   * 另存为。
   *
   * ★ 返回的 `path` 是**用户选的**磁盘路径，不转 `mycontext-file://` ——
   * 它只用于日志与提示文案，不会被当成 `<img src>`。
   */
  ipcMain.handle(IPC_CHANNELS.mediaSaveAs, (_event, payload: unknown) =>
    attempt(() => media.saveAs(parse(mediaSaveAsInputSchema, payload).mediaId)),
  )

  // ---------------- 偏好设置 ----------------

  ipcMain.handle(IPC_CHANNELS.preferencesSetLanguage, (_event, payload: unknown) =>
    attempt(() => preferences.setLanguage(parse(setLanguageInputSchema, payload).language)),
  )

  ipcMain.handle(IPC_CHANNELS.preferencesSetQuitConfirm, (_event, payload: unknown) =>
    attempt(() =>
      preferences.setQuitConfirmSuppressed(parse(setQuitConfirmInputSchema, payload).suppressed),
    ),
  )

  ipcMain.handle(IPC_CHANNELS.preferencesSetWorkLayer, (_event, payload: unknown) =>
    attempt(() => {
      const { enabled } = parse(setWorkLayerInputSchema, payload)
      const result = preferences.setWorkLayerEnabled(enabled)
      /**
       * ★ 打开之后**立刻评估一次**，不等 6 小时的下一轮。
       *
       * 不接这一行的实测后果：开关打开于 19:33:57，而最后一轮蒸馏是 19:33:34
       * （早 23 秒）—— 那一晚什么都没发生，而界面上不会说"在等下一轮"，
       * 于是看起来就是"开了没反应"。
       *
       * 落库先于触发：那一轮读的是 `preferences.workLayerEnabled()`，
       * 顺序颠倒的话它读到的还是旧值（关），于是判据直接 `disabled` 返回。
       */
      distill.workLayerToggled(enabled)
      return result
    }),
  )

  ipcMain.handle(IPC_CHANNELS.profileUpdate, (_event, payload: unknown) =>
    attempt(() => auth.updateProfile(parse(updateProfileInputSchema, payload))),
  )

  // ---------------- 数据面：采集与知识管道 ----------------

  ipcMain.handle(IPC_CHANNELS.ingestSnapshot, () => attempt(() => dataPlane.snapshot()))
  /**
   * 立即同步。带 `channelId` 时只跑那一个渠道 —— 状态页按渠道分区，
   * 按钮该只作用于用户正在看的那个（见 `DataPlaneService.runOnce`）。
   *
   * ## ★★★ 为什么这里要打两条日志（进入 + 结果）
   *
   * 实测（打包态）：用户点了「立即同步」，日志里**一条记录都没有**。
   * 而"没有日志"同时兼容两种完全不同的成因，无法分辨：
   *
   * ① 按钮是 disabled（`data.running` 为假），那一下压根没发出 IPC；
   * ② IPC 发了、采集真跑了、只是一条新消息都没拉到 —— `runPull` 成功且
   *    空的那条路全程不打日志。
   *
   * 处置完全相反（前者要去修 running 判据，后者要去看渠道那侧为什么没数据），
   * 所以必须先把这条边界钉死：**这条日志在，就说明点到了**。
   */
  ipcMain.handle(IPC_CHANNELS.ingestRunOnce, (_event, payload: unknown) =>
    attempt(async () => {
      const channelId =
        typeof (payload as { channelId?: unknown } | null)?.channelId === "string"
          ? (payload as { channelId: string }).channelId
          : undefined
      logger.info("ingest run once requested", { channelId: channelId ?? "(all)" })
      const result = await dataPlane.runOnce(channelId)
      logger.info("ingest run once finished", {
        channelId: channelId ?? "(all)",
        changed: result.changed,
        unchanged: result.unchanged,
      })
      return result
    }),
  )
  ipcMain.handle(IPC_CHANNELS.ingestClearBlocked, () =>
    attempt(() => {
      dataPlane.clearBlocked()
      return true as const
    }),
  )
  // 解析可能抛 SELF_IDENTITY_AMBIGUOUS —— 那正是要透给 UI 的信息：
  // 「无法唯一确定身份」必须让用户看到并手动确认，不能退回到"挑一个"。
  ipcMain.handle(IPC_CHANNELS.ingestResolveSelf, () => attempt(() => dataPlane.resolveSelf()))
  ipcMain.handle(IPC_CHANNELS.ingestConfirmSelf, () => attempt(() => dataPlane.confirmSelf()))
  // 只读：不碰渠道，还没解析过时给 null（见 data-plane 的实现注释）
  ipcMain.handle(IPC_CHANNELS.ingestReadSelf, () => attempt(() => dataPlane.readSelfIdentity()))

  ipcMain.handle(IPC_CHANNELS.ingestIntervals, () => attempt(() => dataPlane.intervals()))
  ipcMain.handle(IPC_CHANNELS.ingestIntervalsSave, (_event, payload: unknown) =>
    attempt(() => dataPlane.intervalsSave(parse(saveIngestIntervalsInputSchema, payload))),
  )

  ipcMain.handle(IPC_CHANNELS.pipelineFeedInfo, (_event, payload: unknown) =>
    attempt(() =>
      dataPlane.feedInfo(
        typeof (payload as { channelId?: unknown } | null)?.channelId === "string"
          ? (payload as { channelId: string }).channelId
          : undefined,
      ),
    ),
  )
  ipcMain.handle(IPC_CHANNELS.pipelineExport, () => attempt(() => dataPlane.export()))

  // ---------------- 搜索模块 ----------------

  ipcMain.handle(IPC_CHANNELS.searchSessionList, () => attempt(() => search.list()))

  ipcMain.handle(IPC_CHANNELS.searchSessionDetail, (_event, payload: unknown) =>
    attempt(() => search.detail(parse(searchSessionIdInputSchema, payload).sessionId)),
  )

  ipcMain.handle(IPC_CHANNELS.searchSessionCreate, (_event, payload: unknown) =>
    attempt(() => {
      const input = parse(createSearchSessionInputSchema, payload)
      return search.create(input.query, input.scope)
    }),
  )

  ipcMain.handle(IPC_CHANNELS.searchSessionRename, (_event, payload: unknown) =>
    attempt(() => {
      const input = parse(renameSearchSessionInputSchema, payload)
      search.rename(input.sessionId, input.title)
      return true as const
    }),
  )

  ipcMain.handle(IPC_CHANNELS.searchSessionPin, (_event, payload: unknown) =>
    attempt(() => {
      const input = parse(pinSearchSessionInputSchema, payload)
      search.setPinned(input.sessionId, input.pinned)
      return true as const
    }),
  )

  ipcMain.handle(IPC_CHANNELS.searchSessionDelete, (_event, payload: unknown) =>
    attempt(() => {
      search.remove(parse(searchSessionIdInputSchema, payload).sessionId)
      return true as const
    }),
  )

  ipcMain.handle(IPC_CHANNELS.searchPrompt, (_event, payload: unknown) =>
    attempt(async () => {
      const input = parse(searchPromptInputSchema, payload)
      await search.prompt(input.sessionId, input.query)
      return true as const
    }),
  )

  // 取消：丢弃当前 turn 的后续事件（reducer 侧），状态由 prompt 收尾置回。
  ipcMain.handle(IPC_CHANNELS.searchCancel, (_event, payload: unknown) =>
    attempt(() => {
      search.cancel(parse(searchSessionIdInputSchema, payload).sessionId)
      return true as const
    }),
  )

  // ---------------- 知识图谱（kl）子进程 ----------------

  ipcMain.handle(IPC_CHANNELS.klServerStatus, () => attempt(() => klServer.status()))
  /**
   * 起 kl。★ 带渠道：`failed` 之后不自动重起（刻意的），所以必须能精确地
   * 对某一个渠道重试 —— 见 `MultiKlServerService.ensureReady`。
   */
  ipcMain.handle(IPC_CHANNELS.klServerStart, (_event, payload: unknown) =>
    attempt(() =>
      klServer.ensureReady(
        typeof (payload as { channelId?: unknown } | null)?.channelId === "string"
          ? (payload as { channelId: string }).channelId
          : undefined,
      ),
    ),
  )
  ipcMain.handle(IPC_CHANNELS.klServerStop, (_event, payload: unknown) =>
    attempt(async () => {
      await klServer.stop(
        typeof (payload as { channelId?: unknown } | null)?.channelId === "string"
          ? (payload as { channelId: string }).channelId
          : undefined,
      )
      return true as const
    }),
  )
  /**
   * 建图。★ 第二个参数是渠道 id：界面上按钮与渠道选择器同处一页，
   * 用户在飞书那栏点「重建」的意图是重建飞书的图 —— 不带渠道会把钉钉那
   * 37826 个 chunk 一起重烧（约 3 小时且出网），而 `fresh` 还会**删数据**。
   */
  ipcMain.handle(IPC_CHANNELS.klGraphBuild, (_event, fresh: unknown, channelId: unknown) =>
    attempt(async () => {
      const target =
        typeof channelId === "string" && channelId !== "" ? channelId : undefined
      /**
       * ★★★ 建图**之前先导出一次** —— 否则手动建图在"刚采完"那段必然失败。
       *
       * ## 实测的形态（用户点钉钉「建图」一直报错）
       *
       * 建图读的是**导出的四件套**（`exports/<渠道>/chat/records.jsonl`），
       * 而导出由 `FeedService` 的定时器推进 —— 周期 **10 分钟**
       * （`GRAPH_SYNC_INTERVAL_MS`），挂载后另有一次 90 秒补跑。
       *
       * 于是"采集刚写完、定时器还没到"这个窗口里，库里有数据而导出目录是空的：
       *
       *     06:08:13  主渠道最后一次 graph sync tick（head: 0，那时还没授权钉钉）
       *     06:09:33  钉钉的 1007 条消息落库
       *     06:0x     用户点「建图」→ records.jsonl 是 0 字节
       *               → "建图没有产出任何内容（连切块都没完成）"
       *     06:18     下一次定时 tick 才会导出 —— 用户不可能等
       *
       * 那句报错还把人指向 embedding 网关（"去设置确认网关地址与密钥"），
       * 而网关是好的 —— 这是最坏的一种错误提示：症状指向一个无关的方向。
       *
       * 手动点建图的语义就是"用现在库里的数据建一次"，所以先把库里的东西
       * 导出来是这个动作的一部分，不是额外的好意。
       *
       * ★ `export()` 会导出**全部**渠道（主 + 各 source），代价是一次
       * 增量物化（只写新增的 seq，见 `FeedService.export`），远小于一次建图。
       * 不按渠道细分是因为 `dataPlane.export()` 本来就是全量入口，
       * 而多导一个渠道不会让这次建图变慢（建图只读它自己那个目录）。
       *
       * ★ 导出失败**不阻断**建图：那时建图会给出它自己的、更准确的原因
       * （比如"导出还没生成"那一档），而在这里抛错会把它盖掉。
       */
      try {
        const exported = dataPlane.export()
        logger.info("export before manual graph build", {
          channelId: target ?? "(primary)",
          headSeq: exported.headSeq,
          messages: exported.totalMessages,
        })
      } catch (error) {
        logger.warn("export before manual graph build failed (continuing)", {
          detail: error instanceof Error ? error.message : String(error),
        })
      }
      const result = await klServer.rebuildGraph(fresh === true, target)
      /**
       * ★ 手动建图成功后把建图水位推到已导出水位。
       *
       * 自动建图在 `feed.tickGraphSync` 里 `markBuilt`，而手动这条走
       * `rebuildGraph` 直接返回、从不推 `graph-build` 游标 —— 于是图建好了
       * 但游标停在 0，仪表盘红字误报"图谱只消化了 0.0%"（见
       * `GraphSyncService.markBuiltToExport` 的实测）。只在**真的建成**后推
       * （`ok` 且非 `cancelled`）：失败/被打断时推等于宣称建到这了。
       */
      if (result.ok && result.cancelled !== true) dataPlane.markGraphBuiltToExport()
      return result
    }),
  )
  ipcMain.handle(IPC_CHANNELS.klGraphOptimize, (_event, channelId: unknown) =>
    attempt(() =>
      klServer.optimizeGraph(
        typeof channelId === "string" && channelId !== "" ? channelId : undefined,
      ),
    ),
  )

  /**
   * 图谱概览（可视化版块）。
   *
   * 同步读一次只读 SQLite —— 建图**期间**也要能看（那正是用户最想看的
   * 时刻），而那时 kl 的 HTTP 端点在忙（实测 `/entity` 直接 500）。
   */
  /**
   * 图谱规模。带 `channelId` 时只看那一个渠道 —— 仪表盘上那六个数与下面
   * 那张关系图必须说同一个渠道（见 `MultiKlServerService.graphOverview`）。
   */
  ipcMain.handle(IPC_CHANNELS.klGraphOverview, (_event, payload: unknown) =>
    attempt(() =>
      Promise.resolve(
        klServer.graphOverview(
          typeof (payload as { channelId?: unknown } | null)?.channelId === "string"
            ? (payload as { channelId: string }).channelId
            : undefined,
        ),
      ),
    ),
  )

  /**
   * 以「我」为中心的关系子图（ego graph）。
   *
   * 关系由"同一条 fact 里共现"推导。★ 那一步要问 kl 的 `/facts` ——
   * SQLite 的 `edges` 表在默认后端（ladybug）下按设计恒空，
   * 完整推理见 `GraphQueryOptions.factsOfEntity` 的注释。
   */
  /**
   * ★ ego 图带渠道：一次看**一个**渠道的关系图（不合并 —— 同一个人在两个
   * 渠道是两个 external_id，没有安全映射，见 MultiGraphQueryService.ego）。
   */
  ipcMain.handle(IPC_CHANNELS.klGraphEgo, (_event, payload: unknown) =>
    attempt(() =>
      /**
       * ★ `channelId` 可缺省（不给 = 主渠道）。所以这里不能直接 parse 一个
       * 必填 schema —— 手工取值并校验形状：非字符串一律当"没给"。
       */
      Promise.resolve(
        graphQuery.ego(
          typeof (payload as { channelId?: unknown } | null)?.channelId === "string"
            ? (payload as { channelId: string }).channelId
            : undefined,
        ),
      ),
    ),
  )

  /**
   * 带过滤的事实检索（时间范围 / 类型 / 实体 / 关键词）。
   *
   * 图里有 6663 条事实、跨一整月 —— "最近 12 条"回答不了
   * "上周关于沙箱的决策有哪些"这类问题。
   */
  ipcMain.handle(IPC_CHANNELS.klGraphFacts, (_event, payload: unknown) =>
    attempt(() => Promise.resolve(graphQuery.facts(parse(klGraphFactsInputSchema, payload)))),
  )

  /**
   * 仪表盘的时序（按天分桶）+ 消化漏斗 + 覆盖度。
   *
   * ★ 独立通道而不是并进 `ingestSnapshot`：分桶实测 108ms（本机 32,878 行），
   * 而那个快照是每批采集都发的热路径。服务侧按 changelog head 缓存 ——
   * head 没动就直接返回上次那份（1ms 判定）。
   */
  ipcMain.handle(IPC_CHANNELS.dashboardTrends, (_event, payload: unknown) =>
    attempt(() =>
      Promise.resolve(dashboardTrends.trends(parse(dashboardTrendsInputSchema, payload))),
    ),
  )

  // ---------------- 隐藏的极客配置页 ----------------

  ipcMain.handle(IPC_CHANNELS.advancedAiRead, () => attempt(() => advancedAi.read()))

  ipcMain.handle(IPC_CHANNELS.advancedAiSave, (_event, payload: unknown) =>
    attempt(() => {
      advancedAi.save(parse(saveAdvancedAiInputSchema, payload), new Date().toISOString())
      return true as const
    }),
  )

  /**
   * 自备 dws 的路径。保存时会**真跑一次** `--version`（见 DwsSourceService），
   * 跑不起来就抛 CONFIG_INVALID —— 让"填错路径"当场可见，
   * 而不是几百行之后表现成「未检测到有效登录态」。
   */
  ipcMain.handle(IPC_CHANNELS.dwsSourceRead, () => attempt(() => dwsSource.view()))

  ipcMain.handle(IPC_CHANNELS.dwsSourceSave, (_event, payload: unknown) =>
    attempt(() => {
      const view = dwsSource.save(parse(saveDwsSourceInputSchema, payload))
      /**
       * ★ 换了 dws（或清回随包那份）→ 解除采集的 blocked 终态。
       *
       * 换 binary 正是"我在修这个连不上的问题"的信号，而它**真的可能**修好：
       * 实测过同一份登录态下两个版本的判断完全相反 —— 开源版 v1.0.56 报
       * `token_refresh_failed`（旧登录态刷不动），而用户自己那份闭源版报
       * `authenticated: true`。
       *
       * 不清的话：采集因为旧 binary 刷不动 token 而 blocked，用户换成能用的
       * 那份之后采集**仍然**不跑 —— 而他刚做的恰恰是唯一正确的补救动作。
       *
       * 纯内存赋值（清三个字段），不会抛；未挂载数据面时是 no-op。
       */
      dataPlane.clearBlocked()
      return view
    }),
  )

  // ---------------- 模型网关配置（用户可见，单一真源）----------------

  ipcMain.handle(IPC_CHANNELS.runtimeConfigRead, () => attempt(() => runtimeConfig.view()))

  ipcMain.handle(IPC_CHANNELS.runtimeConfigSave, (_event, payload: unknown) =>
    attempt(() =>
      runtimeConfig.save(parse(saveRuntimeConfigInputSchema, payload), new Date().toISOString()),
    ),
  )

  ipcMain.handle(IPC_CHANNELS.runtimeConfigProbe, (_event, payload: unknown) =>
    attempt(() => runtimeConfig.probe(parse(probeRuntimeConfigInputSchema, payload))),
  )

  logger.debug("ipc handlers registered", { count: Object.keys(IPC_CHANNELS).length })
}
