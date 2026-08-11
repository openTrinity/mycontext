/**
 * OnboardingView — 四步引导（步骤式，进度落库，可关掉后从上次那步继续）。
 *
 * ## ★ 进度来自数据库，不是组件 state
 *
 * 首版用局部 state 记"现在第几步"，于是关掉窗口再打开就从头开始。
 * 现在读 `onboarding_progress`（每步一行）——「上次停在哪」是一个需要
 * 跨会话存活的事实，放在 state 里等于每次重开都丢。
 *
 * 判据也在库里：四步都不是 pending 才算走完（done 与 skipped 都算走过）。
 * 首版判据是「有没有渠道已授权」—— 那把授权成功当成了引导完成，
 * 于是另外三步永远看不到（实测症状见 onboarding.service.ts 文件头）。
 *
 * ## ★ 可以前后跳，不是线性向导
 *
 * 用户可能先配数字人再回来授权。强制线性会让"我只想改第 2 步"
 * 变成"从头点一遍"。依赖关系由各步自己在面板里说明（比如第 1 步没授权时，
 * 后三步会提示它们依赖授权）。
 *
 * ## 「暂时跳过」必须留着
 *
 * 用户可能没网或不想现在授权，没有这个出口就会被卡在引导页进不了应用。
 */
import { useEffect, useMemo, useState } from "react"
import { BrandWordmark, Button } from "@mycontext/design"
import type {
  ChannelSummary,
  DistillSourceId,
  OnboardingStepId,
  OnboardingStepView,
} from "@mycontext/ipc-contract"
import {
  useAdoptableSession,
  useChannels,
  useCompleteOnboarding,
  useCompleteStep,
  useChannelConversations,
  useDistillSources,
  useIngestSnapshot,
  useOnboardingSteps,
  useSaveDistillSource,
  usePersonaSnapshot,
  useSkipOnboarding,
  useSkipStep,
} from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { ChannelAuthPanel } from "../channels/channel-auth-panel.js"
import { SelfIdentityPanel } from "../settings/self-identity-panel.js"
import { readIdentityProblem } from "../dashboard/dashboard-data.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { StepBar, type StepBarItem, type StepVisualState } from "./step-bar.js"
import { readPersonaIdentity } from "../persona/persona-identity.js"
import { DistillStep } from "./distill-step.js"
import { PersonaStep, type PersonaDraft } from "./persona-step.js"
import { SourcesStep, type SourcesDraft } from "./sources-step.js"
import { ModelConfigForm } from "../settings/model-config-form.js"
import { canRunPersona, personaCapableChannels } from "../../lib/channel-capability.js"
import { ChannelPicker } from "../shell/channel-picker.js"

const STEP_ORDER: readonly OnboardingStepId[] = [
  "channel",
  "model",
  "persona",
  "sources",
  "distill",
]

/** 各步是否已实装。五步都通了（第 5 步是真进度，不是占位）。 */
const IMPLEMENTED: Record<OnboardingStepId, boolean> = {
  channel: true,
  model: true,
  persona: true,
  sources: true,
  distill: true,
}

const DEFAULT_SOURCES: SourcesDraft = {
  rangeDays: 90,
  chatKinds: ["direct", "group"],
  conversationIds: [],
  // 缺省只勾**已接入**的两个：勾上未接入的等于给一个不会兑现的承诺
  enabledSources: ["chat", "minutes"],
}

/**
 * 从库里那一行的 payload 复原表单。
 *
 * ★ 解析在 `features/persona/persona-identity.ts`（**唯一**一份）：
 * 数字人页的草稿署名读的是同一份数据，抄两份会让引导页与草稿卡
 * 显示不同的形象 —— 而那两个本该是同一个"人"。
 *
 * ★★ `figureDropped` 要在这里**摘掉**：它是解析时**算出来的**
 * （被裁掉了几个键），不是用户数据。而这一步的草稿会被
 * `advance()` 原样当成 payload 写进 `onboarding_progress` ——
 * 留着它就是把一个派生量落进库，下次读出来时它已经与事实无关了
 * （那次裁剪早就发生过），而任何直接读 payload 的地方
 * （CDP 探针、将来的导出）都会把它当成真的字段。
 */
function readPersona(row: OnboardingStepView | undefined): PersonaDraft {
  const { figureDropped: _dropped, ...draft } = readPersonaIdentity(row)
  return draft
}

/**
 * 表单的初值。
 *
 * 走 `readPersona(undefined)` 而不是直接用 `DEFAULT_PERSONA_IDENTITY`：
 * 后者带着 `figureDropped`，而这个对象会被 `advance()` 当成 payload
 * 写进库（见上方那段注释）。让初值与回填值经过**同一个函数**，
 * 就不会出现"回填的干净、初值带了个派生字段"这种只在新用户身上发生的差异。
 */
const DEFAULT_PERSONA_DRAFT: PersonaDraft = readPersona(undefined)

function readSources(row: OnboardingStepView | undefined): SourcesDraft {
  const payload = row?.payload
  if (typeof payload !== "object" || payload === null) return DEFAULT_SOURCES
  const record = payload as {
    rangeDays?: unknown
    customRange?: unknown
    chatKinds?: unknown
    conversationIds?: unknown
    enabledSources?: unknown
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  /**
   * 自定义区间。两端都要是 `YYYY-MM-DD`，否则按"没填"处理。
   *
   * 不校验的话一个手改坏的 payload（比如 `from: "去年"`）会被原样
   * 送进 `Date.parse` → NaN → `since: NaN` 落库 → 蒸馏窗口算出一个
   * 荒谬的范围，而那不会报错。
   */
  const raw = record.customRange
  const isDate = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  const customRange =
    typeof raw === "object" && raw !== null
      ? (() => {
          const pair = raw as { from?: unknown; to?: unknown }
          return isDate(pair.from) && isDate(pair.to) ? { from: pair.from, to: pair.to } : null
        })()
      : null
  return {
    rangeDays:
      typeof record.rangeDays === "number" || record.rangeDays === null
        ? record.rangeDays
        : DEFAULT_SOURCES.rangeDays,
    customRange,
    chatKinds: strings(record.chatKinds).filter(
      (item): item is "direct" | "group" => item === "direct" || item === "group",
    ),
    conversationIds: strings(record.conversationIds),
    enabledSources: strings(record.enabledSources) as DistillSourceId[],
  }
}

/**
 * 主渠道 id —— 它的白名单走 `scope.conversationIds`（存量形状），
 * 其余渠道走 `perChannelConversationIds`。
 *
 * ★ 渲染层写死可接受：它只决定"哪一份走老字段"。真正的判据在主进程
 * （`DistillSourceService` 用 `plugin.meta.id`）。
 */
const PRIMARY_CHANNEL_ID = "dingtalk"

export function OnboardingView() {
  const { t } = useDynamicTranslation("onboarding")
  const { t: tc } = useDynamicTranslation()
  /**
   * 模型那一步的按钮文案在 `settings` 命名空间 —— 因为整个表单
   * （`ModelConfigForm`）是与设置页**共用**的，它的文案自然归 settings。
   * 抄一份到 onboarding.json 会让同一句话有两个来源，改一处漏一处。
   */
  const { t: ts } = useDynamicTranslation("settings")
  const errorText = useErrorText()

  const channels = useChannels()
  const steps = useOnboardingSteps()
  const distillSources = useDistillSources()
  /**
   * 会话列表 —— 这里只用它做「external_id → channelId」的反查（分桶用）。
   * `SourcesStep` 自己也拉一份；两处共用同一个 queryKey，所以不会多发请求。
   */
  const conversationList = useChannelConversations(true)
  const completeStep = useCompleteStep()
  const skipStep = useSkipStep()
  const saveSource = useSaveDistillSource()
  const complete = useCompleteOnboarding()
  const skip = useSkipOnboarding()
  /** 只为拿 `agentAvailable`（是否配了模型）—— 第 4 步要据此提前提示。 */
  const personaSnapshot = usePersonaSnapshot()

  /**
   * `steps.data ?? []` 不能直接进依赖：那个 `??` 每次渲染都产生新数组，
   * 会让下面的 useMemo 每帧重算，进而让依赖它的两个 useEffect 每帧重跑。
   * 依赖 `steps.data` 本身（react-query 保证同一份数据是同一个引用）。
   */
  const byStep = useMemo(
    () => new Map((steps.data ?? []).map((row) => [row.step as OnboardingStepId, row])),
    [steps.data],
  )
  const stepCount = steps.data?.length ?? 0

  const [activeId, setActiveId] = useState<OnboardingStepId>("channel")
  /**
   * 进度到了之后自动跳到第一个 pending 的步骤。
   *
   * 只在**首次**拿到进度时跳（`jumped` 闩住）—— 否则用户手动点回第 1 步，
   * 下一次 refetch 又会把他弹到第 3 步，表现是"点了没反应"。
   */
  const [jumped, setJumped] = useState(false)
  useEffect(() => {
    if (jumped || stepCount === 0) return
    const firstPending = STEP_ORDER.find((id) => byStep.get(id)?.state === "pending")
    if (firstPending !== undefined) setActiveId(firstPending)
    setJumped(true)
  }, [jumped, stepCount, byStep])

  const [persona, setPersona] = useState<PersonaDraft>(DEFAULT_PERSONA_DRAFT)
  const [sources, setSources] = useState<SourcesDraft>(DEFAULT_SOURCES)
  const [personaTouched, setPersonaTouched] = useState(false)
  /**
   * 表单从库里回填一次。
   *
   * 之后不再跟着 refetch 覆盖 —— 用户正在输入时被服务端数据盖掉
   * 是一种很难自查的"输入丢字"。
   */
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    if (hydrated || stepCount === 0) return
    setPersona(readPersona(byStep.get("persona")))
    const stored = readSources(byStep.get("sources"))
    setSources(stored.enabledSources.length === 0 ? DEFAULT_SOURCES : stored)
    setHydrated(true)
  }, [hydrated, stepCount, byStep])

  /**
   * ★ 包一层 `useMemo`：`channels.data ?? []` 每次 render 都产生一个**新数组**，
   * 而下面两个 `useMemo`（`authorizedChannelIds` / `readOnlyChannelIds`）
   * 把它当依赖 —— 于是那两个缓存每次都失效，等于没有缓存。
   * 依赖只写 `channels.data`：兜底的空数组不需要参与比较。
   */
  const list: ChannelSummary[] = useMemo(() => channels.data ?? [], [channels.data])
  /**
   * ★★ 引导第 1 步**当前在配哪个渠道** —— 用户要求「引导流程要能选渠道」。
   *
   * ## 为什么这不是个装饰性的下拉
   *
   * 改动前第 1 步的完成判据写死主渠道：`list.find(c => c.id === "dingtalk")`。
   * 后果是**只连飞书的用户第 1 步永远不会自动完成**（钉钉那条 `authorized`
   * 恒 false），他只能点「跳过此步」；下面那行「身份已确认」的绿字也永不出现。
   * 也就是说"引导"对只用飞书的人是走不通的。
   *
   * 现在第 1 步有一个明确的"我在配哪个渠道"，授权卡片、完成门、身份确认入口
   * 全部跟着它走。`null` = 还没选 → 取第一个可用渠道（多数人只连一个，
   * 那时它就是自动的、看不出有 picker）。
   */
  const [pickedChannelId, setPickedChannelId] = useState<string | null>(null)
  const availableChannels = useMemo(() => list.filter((c) => c.available), [list])
  const activeChannel =
    availableChannels.find((c) => c.id === pickedChannelId) ?? availableChannels[0]
  const authorized = activeChannel?.status.state === "authorized"
  /**
   * 有没有一个**已授权、且能跑数字分身**的渠道。
   *
   * ## ★★ 判据是渠道能力（`sendAs`），不是渠道 id
   *
   * 分身的本质是"以我的身份发消息"，而只读接入的渠道刻意不给这个能力
   * （飞书 `sendAs: []`）。第 3 步（数字分身）与第 5 步（开始学习）都要据此
   * 说话 —— 只连了只读渠道时它们**做不了**，而原来什么都不说：
   * · 第 3 步填完名字与形象，之后分身一直不说话且找不到原因；
   * · 第 5 步跑完得到 0 条结论，也不报错（`DistillService` 只读主库）。
   *
   * ★ 用 `canRunPersona` 而不是 `=== PRIMARY_CHANNEL_ID`：将来某个渠道开了
   * 发送能力时这里一行都不用改。
   */
  const personaHost = personaCapableChannels(list)[0]
  /**
   * 已授权的渠道 id 集合 —— 第 4 步的会话列表按它过滤。
   *
   * ★ 判据与 `persona-module.tsx` 那份一致（`available && authorized`）：
   * 未开放的渠道不该出现在任何列表里，而未授权的渠道采集不会跑。
   */
  const authorizedChannelIds = useMemo(
    () =>
      new Set(list.filter((c) => c.available && c.status.state === "authorized").map((c) => c.id)),
    [list],
  )
  /**
   * 已授权的渠道里，哪些是**只读接入**（不能以本人身份发消息）。
   *
   * 第 4 步据此说清"选中的会话只进图谱与搜索，不会用来替你回复" ——
   * 那一步叫「学习范围」，而只读渠道上"分身学会怎么说话"这件事不会发生。
   *
   * ★ 判据走 `canRunPersona`（读 `capabilities.sendAs`），不是比渠道 id。
   */
  const readOnlyChannelIds = useMemo(
    () => new Set(list.filter((c) => !canRunPersona(c)).map((c) => c.id)),
    [list],
  )

  /**
   * 本人身份是否已确认——授权后才有意义，所以只在 authorized 时订阅快照。
   *
   * 正常情况下授权成功即由主进程 `onAuthorized` 自动确认（见 startup.ts），
   * `selfConfirmed` 会很快变 true；只有同名多 ID 的歧义情形会停在 false，
   * 那时下面的完成门不自动打勾、并就地给出确认入口。
   */
  const ingestSnapshot = useIngestSnapshot(authorized)
  /**
   * 本机有一份可采纳的登录态吗 —— 「继承来的登录态」那一档要用它。
   * 只在已授权时问（未授权时它必然为空，白发一次 IPC）。
   */
  const adoptable = useAdoptableSession(authorized)
  const selfConfirmed = ingestSnapshot.data?.selfConfirmed ?? false
  /**
   * ★★ 第 1 步"够了吗"的判据 —— **按渠道能力分档**。
   *
   * ## 为什么不能一律要求 `selfConfirmed`
   *
   * 「确认本人身份」这件事只对**能跑数字分身**的渠道有意义：它决定 `is_self`
   * 能不能回填，而那是蒸馏语料的前置（不确认 → 蒸馏拒掉全部语料且不报错，
   * 这个坑真实踩过）。只读接入的渠道（`sendAs: []`，如飞书）压根没有 persona
   * 身份这一层，`selfConfirmed` 恒 false —— 一律要求它，等于**只连飞书的用户
   * 第 1 步永远不会自动完成**，只能靠「跳过此步」，而"跳过"在进度条上是另一
   * 个语义（用户会以为自己漏了什么）。
   *
   * 所以：能跑分身的渠道要 `selfConfirmed`（守住那个静默坑）；只读渠道
   * **授权即够**（它要的全部就是"能读到数据"）。
   *
   * ## ★★ 缺 `capabilities` 时必须倒向"要确认"，不能倒向"放宽"
   *
   * 不能直接写 `canRunPersona(activeChannel) ? selfConfirmed : authorized` ——
   * `canRunPersona` 在 `capabilities` **缺失**时返回 false（对"能不能发消息"
   * 这个问题保守是对的）。但拿它反推"要不要确认身份"就倒错了方向：
   * 旧主进程的响应不带 `capabilities`，于是主渠道会被当成只读渠道 →
   * 授权即打勾 → 身份歧义那个静默坑重新打开（实测：一条既有断言当场转红）。
   *
   * 判据因此改成**只有明确知道是只读**（`sendAs` 是显式空数组）才放宽；
   * 字段缺失、或还没读到渠道列表，都按"要确认"处理。
   */
  const activeIsReadOnly = activeChannel?.capabilities?.sendAs?.length === 0
  const channelStepSatisfied =
    activeChannel === undefined ? false : activeIsReadOnly ? authorized : selfConfirmed
  const unjudged = ingestSnapshot.data?.unjudged ?? 0
  /**
   * 身份没确认的**原因** —— 界面据此给不同的引导。
   *
   * ★ 原来这里只有 `selfConfirmed` 一个布尔值，于是所有成因都被显示成
   * 一句「检测到同名的多个账号」。而 `!selfConfirmed` 至少四种成因，
   * 只有一种是同名歧义（见 `IngestSnapshot.selfIdentityState`）——
   * 刚清过数据、解析失败过、还没授权都会走到这里，那时那句话是**假的**，
   * 会把用户指向一个不存在的重名同事。
   *
   * `undefined`（快照还没回来）→ 不下结论：下面那块整体不渲染。
   */
  const identityState = ingestSnapshot.data?.selfIdentityState
  const identityProblem = readIdentityProblem({
    selfState:
      identityState === undefined ? "unknown" : selfConfirmed ? "confirmed" : "unconfirmed",
    adoptable: adoptable.data,
    identityState,
  })

  /**
   * 授权且身份已确认，才把第 1 步记成 done（软门）。
   *
   * 不要求用户再点一次"下一步"：正常人授权即自动确认，`selfConfirmed`
   * 秒变 true，这个 effect 照旧自动打勾，体验零变化。
   *
   * ★ 收紧为 `selfConfirmed` 是为了堵一个静默坑：身份歧义时（同名多 ID）
   * 主进程不会替用户猜，`is_self` 全表保持 null → 蒸馏拒掉全部语料且不报错。
   * 若这里仍只看 `authorized` 就打勾，用户会看到"引导完成、蒸馏 0 结论"而
   * 无从知道原因。所以歧义时这步**不自动完成**，转而在下方显示确认入口。
   *
   * 这是**软门**：不自动打勾 ≠ 走不了。底部「跳过此步 / 跳过引导」始终可用，
   * 用户执意继续也不被拦——见 footer 的 skipStep / skip。
   */
  useEffect(() => {
    if (!authorized || !channelStepSatisfied) return
    if (byStep.get("channel")?.state === "done") return
    if (completeStep.isPending) return
    completeStep.mutate({ step: "channel" })
    // completeStep 每次渲染都是新对象，放进依赖会变成循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, channelStepSatisfied, byStep])

  const visualState = (id: OnboardingStepId): StepVisualState => {
    const state = byStep.get(id)?.state
    if (state === "done") return "done"
    if (state === "skipped") return "skipped"
    return id === activeId ? "current" : "pending"
  }

  const stepItems: StepBarItem[] = STEP_ORDER.map((id) => ({
    id,
    label: t(`steps.${id}`),
    state: visualState(id),
    implemented: IMPLEMENTED[id],
  }))

  const index = STEP_ORDER.indexOf(activeId)
  const busy = complete.isPending || skip.isPending || completeStep.isPending || skipStep.isPending

  /** 把当前这一步记成 done 并前进。资料源那步顺便把选择写进 distill_sources。 */
  const advance = () => {
    if (activeId === "persona") {
      if (persona.name.trim() === "") {
        setPersonaTouched(true)
        return
      }
      completeStep.mutate({ step: "persona", payload: persona })
    } else if (activeId === "sources") {
      /**
       * 两处都要写：
       * · `onboarding_progress.payload` —— 重进引导时回填表单；
       * · `distill_sources` —— 采集与蒸馏真正读的地方。
       *
       * 只写前者的话"我明明勾了"却不生效；只写后者则重进引导时表单是空的。
       */
      /**
       * 时间范围 → `since` / `until`。
       *
       * ★ 自定义区间**优先于**预设天数（两者互斥，见 SourcesDraft 的注释）。
       * `until` 取那一天的 **23:59:59.999** 而不是 00:00 ——
       * 用户选"到 7 月 30 日"意思是**包含**那一天，
       * 取 00:00 会把整个 7 月 30 日排除掉（少一天，而且不报错）。
       */
      const custom = sources.customRange ?? null
      const since =
        custom !== null
          ? new Date(`${custom.from}T00:00:00`).getTime()
          : sources.rangeDays === null
            ? undefined
            : Date.now() - sources.rangeDays * 86_400_000
      const until = custom === null ? undefined : new Date(`${custom.to}T23:59:59.999`).getTime()
      /**
       * ★★ 会话白名单要**按渠道分桶**，而且现在**逐渠道各存一次**。
       *
       * 勾选列表是混着多个渠道的（每项带 `channelId`），而白名单存的是
       * external_id —— 各渠道的 id 体系完全不同。整批塞给每个渠道等于让
       * 它按一批不存在的 id 过滤，**结果恒为零**且不报错。
       *
       * ★ 存法从"一次调用写所有库"改成"每个渠道调一次"：`save()` 现在收
       * 必填的 `channelId` 且只写那一个库。旧形状（主渠道走 `scope`、
       * 其余走 `perChannelConversationIds` 映射）造成过一次数据丢失 ——
       * 采集范围面板在飞书那栏保存时把钉钉的白名单清空了（详见
       * `distillSourceSaveInputSchema.channelId` 的注释）。
       */
      const conversationItems = conversationList.data?.items ?? []
      const channelOf = new Map(conversationItems.map((item) => [item.externalId, item.channelId]))
      /** `channelId → 该渠道被勾选的 externalId`。主渠道也是其中一桶。 */
      const buckets = new Map<string, string[]>([[PRIMARY_CHANNEL_ID, []]])
      for (const id of sources.conversationIds) {
        /**
         * ★ 查不到渠道 → 归给主渠道。那是存量数据的形状（旧的引导记录里
         * 没有 channelId），归错的代价是"主渠道多了一个不存在的 id"
         * （过滤时无害），而丢掉它会让用户的选择静默消失。
         */
        const channelId = channelOf.get(id) ?? PRIMARY_CHANNEL_ID
        buckets.set(channelId, [...(buckets.get(channelId) ?? []), id])
      }
      for (const source of distillSources.data ?? []) {
        for (const [channelId, ids] of buckets) {
          saveSource.mutate({
            channelId,
            kind: source.kind,
            enabled: sources.enabledSources.includes(source.kind),
            scope:
              source.kind === "chat"
                ? {
                    ...(since === undefined ? {} : { since }),
                    ...(until === undefined ? {} : { until }),
                    chatKinds: sources.chatKinds,
                    // ★ 只给**这个渠道自己的** id（其余源不按会话切）
                    conversationIds: ids,
                  }
                : {
                    ...(since === undefined ? {} : { since }),
                    ...(until === undefined ? {} : { until }),
                  },
          })
        }
      }
      completeStep.mutate({ step: "sources", payload: sources })
    } else if (activeId === "channel") {
      completeStep.mutate({ step: "channel" })
    } else if (activeId === "model") {
      // 模型步的保存走表单自己的按钮；这里点「下一步」= 用当前值继续（不强制填）。
      completeStep.mutate({ step: "model" })
    }

    const next = STEP_ORDER[index + 1]
    if (next !== undefined) setActiveId(next)
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg-base-normal)]">
      {/* 顶栏整条可拖窗口：无边框窗口下这里是唯一的拖动区 */}
      <header
        data-window-drag
        className="flex h-12 shrink-0 items-center gap-2 px-4"
        style={{ paddingLeft: 82 }}
      >
        <BrandWordmark size={18} mark />
      </header>

      {/*
        步骤条独占一条，与顶栏之间没有分隔线 —— 品牌 + 进度读起来是
        一个"页头"单元。它下面那条线才是页头与内容的边界。

        `px-12`：步骤条自己有 `max-w-[880px] mx-auto`，这里的 padding 只在
        窗口窄于 880 时起作用（那时圆点不该贴边）。
        `pb-4`：状态文字行去掉之后整条矮了一档，下留白跟着收 —— 否则
        步骤条与分隔线之间会空出一条与上方不对称的缝。
      */}
      <div className="shrink-0 border-b border-[var(--border-divider-light)] px-12 pb-4 pt-1">
        <StepBar
          items={stepItems}
          activeId={activeId}
          onSelect={(id) => setActiveId(id as OnboardingStepId)}
          comingSoonSuffix={t("steps.comingSoonSuffix")}
          stateLabels={{
            done: t("state.done"),
            skipped: t("state.skipped"),
            current: t("state.current"),
            pending: t("state.pending"),
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
          {/*
            ★ 内容宽度 720 而不是 560。

            560 是**纯表单**的舒适宽度（一列输入框），而这四步里有两步是
            网格与列表：步骤 2 的变体缩略图（7 列）、步骤 3 的资料源（2 列）
            与会话清单。把它们挤进 560 会让每行元素数不整、换行位置随内容跳
            —— 那正是"排布没规律"的来源。

            `gap-section-lg` 而不是 `xl`：卡片自己有边界与内边距，
            xl（28px）会让分区之间散开到读不出"它们属于同一步"。
          */}
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[var(--gap-section-lg)]">
            {/*
              ★ 当前步骤的标题 + 说明。
              说明原来长在竖排步骤条的每一项下面（248px 宽的小字），
              现在移到这里 —— 字号更大、就在视线落点上。
              竖排改横排时它是**必须有去处**的，否则那句话就是被删掉了
              （见 step-bar.tsx 文件头）。
            */}
            <div className="flex flex-col gap-1.5">
              <h1 className="typography-title-base-600 text-[var(--text-base-primary)]">
                {t(`steps.${activeId}`)}
              </h1>
              <p className="typography-body-base-400 text-[var(--text-base-secondary)]">
                {t(`steps.${activeId}Desc`)}
              </p>
            </div>

            {activeId === "channel" ? (
              channels.isLoading ? (
                <p className="typography-body-base-400 text-[var(--text-base-tertiary)]">
                  {t("detecting")}
                </p>
              ) : channels.error !== null ? (
                <div className="flex flex-col items-start gap-3">
                  <p className="typography-body-base-400 text-[var(--status-error)]">
                    {errorText(channels.error)}
                  </p>
                  <Button size="sm" variant="secondary" onClick={() => void channels.refetch()}>
                    {tc("app.retry")}
                  </Button>
                </div>
              ) : list.length === 0 ? null : (
                <div className="flex flex-col gap-[var(--gap-component-md)]">
                  {/*
                    ── 我在配哪个渠道 ──────────────────────────────────

                    ## ★★ 为什么这一步需要一个明确的选择

                    原来这里把**所有**渠道的授权卡片平铺出来，而完成判据写死
                    主渠道。于是只连飞书的用户：卡片有两张、第 1 步永远不自动
                    完成（钉钉那条 `authorized` 恒 false）、只能点「跳过此步」
                    —— 而"跳过"在进度条上是另一个语义，他会以为自己漏了什么。

                    现在这一步有一个明确的"当前渠道"：授权卡片、完成门、身份
                    确认入口全部跟着它。只有一个可用渠道时 `ChannelPicker`
                    自己退化成静态标识（见那个组件），所以多数人看不出有选择器。

                    ★ `side="bottom"`：引导页这一块在上半屏，默认 `"top"` 会
                    让浮层往窗口外飞（那个组件的文件头记了这条）。
                  */}
                  {availableChannels.length > 1 ? (
                    <ChannelPicker
                      options={availableChannels.map((c) => ({
                        id: c.id,
                        label: tc(c.labelKey, { defaultValue: c.id }),
                      }))}
                      activeId={activeChannel?.id ?? null}
                      onChange={setPickedChannelId}
                      ariaLabel={t("channel.pickerLabel")}
                      prefix={t("channel.pickerPrefix")}
                      side="bottom"
                    />
                  ) : null}
                  {activeChannel === undefined ? null : (
                    <ChannelAuthPanel
                      key={activeChannel.id}
                      channel={activeChannel}
                      variant="onboarding"
                    />
                  )}
                  {/*
                   * 已授权但身份还没确认（同名多 ID 的歧义情形）——就地给确认入口。
                   *
                   * 引导语气，不是红色告警：正常人根本走不到这里（授权即自动确认）。
                   * 走到这里的少数人，确认一下哪个账号是自己，蒸馏才能正确归属。
                   * 不确认也能继续：底部「跳过此步」始终可用（软门，不阻塞）。
                   */}
                  {/*
                   * ★★ 身份没确认时的引导 —— 按**真实原因**分叉。
                   *
                   * 原来这里是 `authorized && !selfConfirmed` 一律显示
                   * 「检测到同名的多个账号——确认一下哪个是你」。而那句话在
                   * 绝大多数成因下是假的：刚清过数据、解析失败过、还没绑身份
                   * 都会走到这里。用户会去找一个不存在的重名同事，
                   * 而真正该做的事（去授权 / 点采纳 / 重试解析）不被提及。
                   *
                   * 现在三档各说各的（判据在 `readIdentityProblem`）：
                   * · ambiguous → **真的**同名歧义，确认哪个是你；
                   * · adopt     → 本机有现成登录态，点「用这个身份」；
                   * · resolve   → 解析失败过，重试一次。
                   *
                   * ★ 「还没授权」那一档**刻意不说话**：上方那个授权面板已经
                   * 写着「为当前账号授权一次，才能确定『你』是谁」并带按钮 ——
                   * 在它下面再挂一个说同样话的框只是噪音，还会稀释上面这三档
                   * （那三档才是这里的职责）。
                   *
                   * 那两个按钮（解析/确认并回填）只在**自动确认没成功**时才
                   * 有意义 —— 正常路径上主进程授权后就自动 resolve+confirm 了
                   * （见 post-auth-identity 的 confirmIdentity）。所以整块由
                   * `identityProblem !== null` 门控，而不是"没确认就显示"。
                   */}
                  {identityProblem === null ? null : (
                    /**
                     * ★★ 这一块要读起来像**一个状态**，不是一条附加说明。
                     *
                     * 原来它是白底细边的小框（`bg-card-z0` + `border-divider-light`），
                     * 挂在授权面板下面 —— 与"补充说明"长得一样，容易被当成
                     * 可忽略的文字划过去。而它其实是一个**待办**：
                     * 未确认身份时蒸馏会拒掉全部语料（且不报错），画像出不来。
                     *
                     * 所以改成 warning 底色 + 一个标题行，让引导里的三档
                     * 在视觉上真的是三档：
                     *
                     *   未授权       → 上面那个授权面板（有按钮）
                     *   已授权待确认 → **这一块**（黄底 + 标题 + 解析入口）
                     *   已授权已就绪 → 两者都不出现，直接下一步
                     *
                     * ★ 标题与正文分行：标题回答"这是什么状态"，
                     * 正文回答"为什么要管它"。挤成一段时用户只读前半句。
                     */
                    <div className="flex flex-col gap-[var(--gap-component-sm)] rounded-[var(--radius-md)] bg-[var(--status-fill-warning-container)] p-[var(--gap-component-md)]">
                      {/*
                       * ★ `typography-title-small-500`，不是 `body-small-500`
                       * —— 后者**不存在**（排版表里没有这一档），写上去不会生成
                       * 任何样式：文字静默退回浏览器默认字号，且不报错。
                       * 这里要的是"小号粗标题"，而表里对应的就是 title-small-500
                       * （15px/500），与下面那行 body-small-400（13px）正好成对。
                       */}
                      <span className="typography-title-small-500 text-[var(--status-warning)]">
                        {t("channel.identityPendingTitle")}
                      </span>
                      <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
                        {identityProblem.kind === "ambiguous"
                          ? t("channel.identityAmbiguous")
                          : identityProblem.kind === "adopt"
                            ? t("channel.identityAdoptable", {
                                corpName: identityProblem.corpName,
                                userName: identityProblem.userName,
                              })
                            : t("channel.identityUnresolved")}
                      </p>
                      <SelfIdentityPanel confirmed={selfConfirmed} unjudged={unjudged} />
                    </div>
                  )}
                  {/*
                    ★ 第三档：已授权、身份也确认了 → 明确说"这一步完成了"。

                    原来这一档**什么都不显示**，于是它与"还在加载"、
                    "出了点问题但没提示"在界面上长得一样 —— 用户不知道
                    该不该等，也不知道能不能往下走。一行绿字就解决。
                  */}
                  {authorized && selfConfirmed && identityProblem === null ? (
                    <p className="typography-body-small-400 text-[var(--status-success)]">
                      {t("channel.identityReady")}
                    </p>
                  ) : null}
                </div>
              )
            ) : null}

            {activeId === "model" ? (
              /**
               * 模型配置：保存即记 stepDone("model") 并前进。
               * 用与设置页**同一个**表单组件（单一真源），避免两处分叉。
               *
               * ★ 表单不带分区标题 —— 上方已经有「配置模型」标题 + 一句说明
               * （见 model-config-form.tsx 文件头）。
               */
              <ModelConfigForm
                saveLabel={ts("model.saveAndNext")}
                onSaved={() => {
                  completeStep.mutate({ step: "model" })
                  const next = STEP_ORDER[STEP_ORDER.indexOf("model") + 1]
                  if (next !== undefined) setActiveId(next)
                }}
              />
            ) : null}

            {activeId === "persona" ? (
              <PersonaStep
                value={persona}
                onChange={(next) => {
                  setPersona(next)
                  setPersonaTouched(false)
                }}
                showNameError={personaTouched}
                personaHostConnected={personaHost !== undefined}
              />
            ) : null}

            {activeId === "sources" ? (
              <SourcesStep
                value={sources}
                onChange={setSources}
                sources={distillSources.data ?? []}
                /**
                 * ★★ 只列**已连渠道**的会话。
                 *
                 * 这一步存的是**采集白名单**（决定采哪些会话），而采集按渠道
                 * 各自跑 —— 所以该列的是"现在连着的那些渠道"的会话。
                 * 保存端本来就按渠道分桶（见上面 `buckets`），多渠道一直支持。
                 *
                 * ★ 上一版我写死了主渠道，理由是"这一步喂给蒸馏、而蒸馏只读
                 * 主库"。那个前提是错的（`conversationIds` 是采集白名单，不是
                 * 蒸馏语料清单），真机表现：只连飞书时列表里是**已退登渠道**的
                 * 55 个历史会话，而连着的飞书 4 个反倒看不见。
                 *
                 * ★ 用已授权而不是"全部渠道"：退登的渠道采集不会跑，把它的
                 * 历史会话混进"接下来采哪些"里会让人以为它还在采。
                 */
                channelFilter={authorizedChannelIds}
                readOnlyChannelIds={readOnlyChannelIds}
              />
            ) : null}

            {activeId === "distill" ? (
              <DistillStep
                rangeDays={sources.rangeDays}
                /**
                 * 是否配了模型：用 `agentAvailable` 而不是再查一次配置。
                 * 那个字段的判据跟着**实际路径**走（见 PersonaService），
                 * 所以它为 true 就意味着抽取型任务真的能跑。
                 */
                modelConfigured={personaSnapshot.data?.agentAvailable ?? false}
                /**
                 * ★ 语料来自主渠道的库（`DistillService` 只有一个 `this.db`）。
                 *
                 * 这里复用 `personaHost` 而不是单独判主渠道：能跑分身的渠道
                 * 与"语料所在的渠道"目前是同一个（都是主渠道），而**两者分叉
                 * 的那天**这个字段该跟着语料走 —— 到时把判据换成显式的
                 * 主渠道授权态（`authorized`），别让它继续跟着分身能力漂。
                 */
                corpusChannelConnected={authorized}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* 底部操作条：跳过在左、前进在右，符合「继续」的视线动线 */}
      <footer className="flex shrink-0 items-center justify-between border-t border-[var(--border-divider-light)] px-8 py-4">
        <Button
          size="md"
          variant="ghost"
          disabled={busy}
          onClick={() => skip.mutate()}
          title={t("skipHint")}
        >
          {t("skip")}
        </Button>

        <div className="flex items-center gap-2">
          {index > 0 ? (
            <Button
              size="md"
              variant="ghost"
              disabled={busy}
              onClick={() => setActiveId(STEP_ORDER[index - 1] ?? "channel")}
            >
              {t("back")}
            </Button>
          ) : null}

          <Button
            size="md"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              skipStep.mutate({ step: activeId })
              const next = STEP_ORDER[index + 1]
              if (next !== undefined) setActiveId(next)
            }}
          >
            {t("skipStep")}
          </Button>

          {index < STEP_ORDER.length - 1 ? (
            <Button size="md" disabled={busy} onClick={advance}>
              {t("next")}
            </Button>
          ) : (
            <Button size="md" disabled={busy} onClick={() => complete.mutate()}>
              {t("enter")}
            </Button>
          )}
        </div>
      </footer>
    </div>
  )
}
