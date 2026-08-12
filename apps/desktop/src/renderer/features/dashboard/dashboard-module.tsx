/**
 * 仪表盘 —— **唯一**一页。用户打开应用第一眼看的就是它。
 *
 * ## 这一页回答四个问题
 *
 * ① **它掌握了我多少东西**（主数字 + 图谱规模）；
 * ② **我的数字分身现在什么状态**（能不能自动回、有多少要我审）；
 * ③ **它认识我周围的谁**（ego 图 + 邻居排名 + 实体类型分布）；
 * ④ **它从聊天里读出了什么**（可检索的事实面板）。
 *
 * ## ★ 知识图谱**没有**独立入口了
 *
 * 原来侧栏有一栏叫「知识图谱」。两个问题：
 * · 那个名字本身是技术词 —— 用户不会为了"看看它认识谁"点进一个
 *   叫图谱的地方；
 * · 它与仪表盘讲的是同一个故事的两段，分开之后两边都不完整
 *   （仪表盘不知道图里有什么，图谱页不知道分身在干什么）。
 *
 * 所以整块搬进来了：规模三数 → 主数字旁边的小指标；
 * 事实类型分布 → 事实面板顶部（它同时**是过滤器**）；
 * 枢纽实体 → ego 图右侧的邻居列表（那一栏排的就是"谁是核心"）。
 *
 * ## ★ 刻意删掉的两块：知识管道与画像蒸馏
 *
 * 原来这一页有五个板块，其中「知识管道」摆的是 Outbox 消费者的
 * `acked_seq` / lag / 死信，「画像蒸馏」摆的是 `distill_tasks` 的
 * facet × 窗口状态机。那些数字**要求用户理解我们的架构**才能读懂 ——
 * 而他要的答案只有"能不能用、有没有出事"。
 *
 * 但那两块各有一个真实的失效信号（消费者卡死 → 搜不到最近的消息；
 * 蒸馏 0 结论 → 画像是空的）。所以不是删功能，是**换表达**：
 * 压成一行人话（见 `readProcessing`），正常时不占地方。
 * 技术细节仍在「运行状态」页 —— 那里本来就是给排查用的。
 *
 * ## ★ 视觉规格有出处，不是审美偏好
 *
 * 数字卡、分布条、主数字的尺寸与几何按 `dataviz` skill 的
 * `marks-and-anatomy.md` 定，实现在 `./primitives.tsx`。
 * 配色是**验证过的**（见 `../graph/palette.ts` 文件头记的那两组
 * `ALL CHECKS PASS`），不是挑好看的。
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { Avatar, Button, Panel, PanelHeader } from "@mycontext/design"
import {
  useAdoptableSession,
  useBootstrapState,
  useDashboardTrends,
  useKlGraphBuild,
  useOnboardingSteps,
  useContactAvatars,
} from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useTheme } from "../../lib/use-theme.js"
import { EgoGraphPanel } from "../graph/ego-graph-panel.js"
import { FactsExplorer } from "../graph/facts-explorer.js"
import { ENTITY_NEUTRAL, entityColor } from "../graph/palette.js"
import { useDashboardScope } from "./use-dashboard-scope.js"
import { personaIdentityFromSteps } from "../persona/persona-identity.js"
import { FocusBridge } from "./focus-bridge.js"
import { Funnel } from "./funnel.js"
import { GraphDetailPopover } from "./graph-detail-popover.js"
import { GreetingRow } from "./greeting-row.js"
import { CountUp } from "./count-up.js"
import { PersonaCard } from "./identity.js"
import { CoverageBar, Distribution, Section } from "./primitives.js"
import {
  classifyGraphReason,
  describeKl,
  describeUnitsByType,
  formatCount,
  readFactTimestampGap,
  readIdentityBar,
  readIdentityProblem,
  readIngest,
  readPersona,
  readTrendSummary,
} from "./dashboard-data.js"

/** 一句话的问题提示条。全页共用一种样式，于是"哪里坏了"扫一眼就找得到。 */
function ProblemLine({ text, tone }: { text: string; tone: "warn" | "bad" }) {
  const style =
    tone === "bad"
      ? "bg-[var(--status-fill-error-container)] text-[var(--status-error)]"
      : "bg-[var(--status-fill-warning-container)] text-[var(--status-warning)]"
  return (
    <p className={`typography-body-small-400 rounded-[var(--radius-md)] px-3 py-2 ${style}`}>
      {text}
    </p>
  )
}

export interface DashboardModuleProps {
  /**
   * 页头那枚取值范围筹码选中的渠道（见 `ScopeChip`）。
   *
   * ★★ 这一页的**每一个数字**都跟着它走：六个清点数、关系图、事实列表。
   * 那正是它必须由 shell 提供而不是本组件自己 state 的理由 ——
   * 控件在页头（与页面标题同级），而它管的是整页。
   *
   * `null` = 还没读到渠道列表 → 退回"第一个已授权的渠道"（见 `graphChannel`）。
   */
  activeChannelId?: string | null
}

export function DashboardModule({ activeChannelId = null }: DashboardModuleProps = {}) {
  /**
   * ★★ 这一页的**全部数据**从一个 hook 来（见 `useDashboardScope`）。
   *
   * 上一版是一处一处判渠道（七处），而漏了两处就静默显示**另一个渠道的数字**
   * —— 实测：飞书采了 8 条却显示「知识加工落后 11,309 条」（钉钉的水位），
   * 数字分身那一排也是钉钉的草稿数。两个都不报错，只是属于别的渠道。
   *
   * 收口之后"这一页的数据"只有一个来源，漏字段变成拿不到值而不是拿错值。
   */
  const scope = useDashboardScope(activeChannelId)
  const graphChannel = scope.channelId
  const { ego, overview, kl, building } = scope
  const buildGraph = useKlGraphBuild()
  const { resolved: mode } = useTheme()
  /** 实体类型名要翻译 —— 与 ego 图的图例共用 `graph` 那一份 key。 */
  const { t: tg } = useDynamicTranslation("graph")
  /**
   * 渠道显示名（`channels` 命名空间已有 `<id>.label`）。
   *
   * ★ 给 `readIngest` 用：那三句提示原来把渠道名写死成「钉钉」，
   * 而这一页的数字全按 picker 选中的渠道取 —— 选飞书时会读到
   * 「钉钉未连接」。见 `readIngest` 的 `channelName` 注释。
   */
  const { t: tch } = useDynamicTranslation("channels")
  const { t: tp } = useDynamicTranslation("persona")
  /**
   * 图里点一个人 → 事实面板筛到他。
   *
   * ★ 这个 state 在**仪表盘**而不是在两个子组件里 —— 那正是"把图谱
   * 并进来"这件事的意义：上面看到一个名字，下面立刻能看他说过什么。
   * 分成两页时这个动作要用户自己抄一遍名字。
   */
  const [entityFocus, setEntityFocus] = useState<string | null>(null)

  /**
   * ★★ 换渠道时清掉被筛实体。
   *
   * 实体名只在**一个渠道的图**里有意义。不清的表现（用户截图）：在钉钉点了
   * 某个人看他的事实，切到飞书之后联动带仍写着「关于 <那个人>」、事实列表
   * 仍按他筛 —— 而那个名字在飞书的图里根本不存在。于是要么显示"0 条事实"
   * （像是飞书没数据），要么更糟：飞书恰好也有同名实体，于是显示的是
   * **另一个人**的事实，而界面上没有任何痕迹说这两个"他"不是一个人。
   *
   * ★ 一并清 `focusCount`：它是上一个渠道那次查询的总数，留着会让
   * 联动带在新渠道上显示一个来自旧渠道的数字。
   */
  useEffect(() => {
    setEntityFocus(null)
    setFocusCount(null)
  }, [scope.channelId])

  /**
   * 数字分身的名字与形象（引导流程的 payload）。
   *
   * ★ 这里曾经还读 `useChannels()` —— 那是给那枚渠道筹码用的，
   * 它现在归 `AppHeader`（整页的取值范围，由 `app-shell.tsx` 提供）。
   *
   * `useBootstrapState` 回来了，但用途变了：不再是给那条被删掉的身份条，
   * 而是给顶部那一行**问候语 + 头像**（见 `greeting-row.tsx` 文件头里
   * 那张对照表 —— 它与身份条不是同一个东西）。
   */
  const steps = useOnboardingSteps()
  const personaIdentity = personaIdentityFromSteps(steps.data)
  /** app 登录账号 —— 只给头像那张**照片**用（`avatarUrl`）。名字改由渠道账号定。 */
  const bootstrap = useBootstrapState()
  const session = bootstrap.data?.session ?? null
  /**
   * 问候语用**当前渠道**绑定的已授权账号名（用户要求）。
   *
   * ★ 直接读 `scope.channels` 里当前渠道那条 `status`（授权态自带
   * `userName`，见 `authStatusSchema`）——不再走 app 登录账号或主渠道花名。
   * 切到飞书就是飞书账号名，切到钉钉就是钉钉账号名，跟着页头 picker 走。
   *
   * · `channelId === undefined`（渠道列表还没读到）→ `undefined`，整行不出现；
   * · 当前渠道 `status.state !== "authorized"` → `null` → 显示「渠道未授权」；
   * · 已授权 → `status.userName`。
   */
  const accountName: string | null | undefined = (() => {
    if (scope.channelId === undefined) return undefined
    const status = scope.channels.find((c) => c.id === scope.channelId)?.status
    if (status === undefined) return undefined
    return status.state === "authorized" ? status.userName : null
  })()

  /**
   * 问候语头像 —— **也要跟着渠道走**（用户要求：各渠道自己的名字和头像）。
   *
   * ## ★★ 为什么不能用 app 登录账号那张（原来的做法）
   *
   * 原来是 `src={session?.avatarUrl}`，而 `session` 是**应用登录账号**，
   * 全应用一份、不随渠道变。于是切到飞书仍显示钉钉那张脸 ——
   * 名字是飞书的、头像是钉钉的，比两个都错更让人困惑。
   *
   * ## 做法：拿当前渠道**本人的 openId** 去查那个渠道的头像缓存
   *
   * `status.userId` 在已授权分支里就是本人在这个渠道的 openId
   * （钉钉 `openDingTalkId` / 飞书 `open_id`，见各自 `resolveSelf`）。
   * `useContactAvatars` 现在收 `channelId` 并把它带进 queryKey 与 IPC，
   * 于是"用哪个渠道的取法、查哪个渠道的缓存"都对得上。
   *
   * ★ `groupExternalId` 传 `null`：**本人不属于任何"共同群"**。
   * 传一个会话 id 下去会让查询必然空并落一条**终态** miss ——
   * 那之后这张头像永久取不到（`mediaAvatarsInputSchema` 的注释记了这个坑）。
   *
   * ★ 取不到就回落到 app 账号那张、再回落首字母：头像缺失是这个功能的
   * 正常状态之一（用户可能就是默认头像 —— 实测本机飞书返回的正是
   * `default-avatar_v3`），不该为它留一块空白。
   */
  const selfExternalId = (() => {
    if (scope.channelId === undefined) return null
    const status = scope.channels.find((c) => c.id === scope.channelId)?.status
    return status?.state === "authorized" ? status.userId : null
  })()
  const selfAvatars = useContactAvatars(
    selfExternalId === null ? [] : [selfExternalId],
    null,
    undefined,
    scope.channelId,
  )
  const channelAvatarUrl =
    selfExternalId === null
      ? null
      : (selfAvatars.data?.find((entry) => entry.externalId === selfExternalId)?.path ?? null)

  /**
   * 联动带当前筛出来多少条。
   *
   * 由 `FactsExplorer` 回传 —— 那个数字是它查出来的，联动带自己再查一次
   * 会得到**两次请求两个答案**（分页/过滤条件不同步时它们会不一致，
   * 而"同一屏上两个总数"是读者最没法处理的一种矛盾）。
   */
  const [focusCount, setFocusCount] = useState<number | null>(null)

  /**
   * 点了图上的点之后**滚到联动带**。
   *
   * ★ 这是"感知不到"那条反馈的直接修法之一：状态变了但视口没动的话，
   * 用户看到的就是"点了没反应"。
   *
   * `block: "nearest"` 而不是 `center`：已经可见时**不要**滚 ——
   * 那种没必要的跳动本身就是一种噪声。
   */
  const bridgeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (entityFocus === null) return
    bridgeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [entityFocus])

  /**
   * 被筛实体在图里的类型色。
   *
   * ★ 与图上那个节点**同一个值**（都走 `entityColor`）—— 颜色是
   * "上面那个点 = 这条带 = 下面这批事实"的连接件。
   * 不在 ego 图里的实体（从事实列表的筹码点进来的）没有颜色，
   * 那时联动带不画色点而不是给一个猜的颜色。
   */
  const focusColor = (() => {
    if (entityFocus === null) return null
    const node = ego.data?.nodes.find((item) => item.name === entityFocus)
    return node === undefined ? null : entityColor(node.type, mode)
  })()

  /**
   * ★ `scope.channelConnected` —— 渠道现在连上了吗（给「以下是历史数据」用）。
   *
   * rebase 时 main 上新加了这个判据（原来写在这个组件里，读 `useChannels()`
   * 自己算）。而这一版的重构正是把"渠道作用域"整个收进 hook —— 那里已经有
   * `useChannels()`（算 `authorizedChannelIds`），所以判据也归它，
   * 免得同一个查询在两处各读一遍、而两处的结论可能不一致。
   */
  const ing = readIngest(
    scope.ingest,
    scope.channelConnected,
    // 取不到就让 readIngest 用「渠道」那个中性缺省，不硬猜一个渠道名
    scope.channelId === null
      ? undefined
      : tch(`${scope.channelId}.label`, { defaultValue: scope.channelId }),
  )
  const per = readPersona(scope.persona)
  const klView = describeKl(kl)
  const graph = overview.data ?? null
  /**
   * 自动构建的调度状态（「下次多久后构建」）。
   *
   * ★ 数据源与真实触发判据同源（`forecastAutoBuild`），且全部来自我们
   * 自己库里的水位 —— 与 `KlServerStatus.buildProgress` 那个**不可渲染**的
   * 上游百分比是两回事（后者 Phase B 恒 40%、停 server 时卡在 stale 值上，
   * 见契约里那段注释与 kl-panel-build-state 的门禁）。
   */
  /**
   * ★ `graph.reason` 该常驻还是收进 popover —— 见 `classifyGraphReason`。
   *
   * `building` 取的是 kl 的状态机而不是"文案里有没有'正在建图'"：
   * 后者会在改文案的那天静默失效，而失效的表现是"黄条又常驻了"。
   */
  const graphReasonKind = classifyGraphReason({
    reason: graph?.reason ?? null,
    building,
    available: graph?.available ?? false,
  })
  /** 进度那一档的说明文字 —— 交给 popover 的第三段。 */
  const graphProgressNote = graphReasonKind === "progress" ? (graph?.reason ?? null) : null

  /**
   * ★ 本人身份**未确认**：一条必须被看见的警示。
   *
   * 未确认时蒸馏会**静默**拒掉全部语料（历史上 9768 条全被守卫拒掉，
   * 而进度页显示"完成"）—— 所以它不能只是"某处的一个状态字"。
   *
   * ## 为什么它在这里而不再是页头那条身份条
   *
   * 上一版页头有一条「头像 + 高鹏 + 本人身份已确认」。两个问题：
   * · 侧栏底部**本来就常驻**同一份（头像 + 名字 + 邮箱），于是同一屏
   *   两个同名头像，读者要找它们的区别（其实没有）；
   * · 它平时永远显示「已确认」—— 一句恒亮的、永远不需要动作的话。
   *
   * 现在只在**出事时**出现，并且与这一页其他"哪里坏了"同一种样式
   * （`ProblemLine`）—— 于是"有问题的地方"在扫视层面是同一类东西。
   *
   * 判据走 `readIdentityBar`（纯函数、有单测）：`null` 是"还在读"，
   * **不能**当成未确认 —— 那会在启动那一瞬间闪一条假警报。
   */
  const identity = readIdentityBar({
    channels: [],
    personaName: personaIdentity.name,
    selfConfirmed: scope.ingest?.selfConfirmed ?? null,
  })

  /**
   * ★ 未确认时那条红字该指向哪个入口 —— 见 `readIdentityProblem` 的注释。
   *
   * 只在**真的未确认**时才查（`enabled`）：这个查询会在主进程跑一次
   * `auth status`（子进程），而已确认的账号问它答案必然是 null。
   */
  const adoptable = useAdoptableSession(identity.selfState === "unconfirmed")
  const identityProblem = readIdentityProblem({
    selfState: identity.selfState,
    adoptable: adoptable.data,
    // ★ 把原因带上：没有它「真的同名歧义」与「只是还没解析」无法区分
    /**
     * ★ 走 `scope.ingest` —— 这个组件不再自己调 `useIngestSnapshot`
     * （那些查询已收进 `useDashboardScope`）。`scopeSnapshot` 用 `...snap`
     * 展开，所以这个顶层字段照旧在。
     */
    identityState: scope.ingest?.selfIdentityState,
  })

  /**
   * 实体类型分布用**分类色**（验证过的 4 个 slot），未知类型走中性灰。
   *
   * 与事实类型不同：实体类型之间没有强弱（人不比系统"更重要"），
   * 那是 nominal —— 按 `choosing-a-form.md` 该用 categorical。
   *
   * ★ 标签要翻译。截图自查时抓到过：这一栏原样显示 kl 给的
   * `Person` / `System` / `Unknown` —— 而右上角图例上写的是"人""系统"。
   * 同一个东西在同一屏上两种叫法，读者会以为它们是不同的维度。
   * i18n 已经有这批 key（`type.*`，图例在用），这里复用同一份。
   */
  const entityRows = (graph?.entityTypes ?? []).map((row) => ({
    label: tg(`type.${row.type}`, { defaultValue: row.type }),
    value: row.count,
    color: entityColor(row.type, mode),
  }))

  return (
    /**
     * ★ `px-8` 而不是 `p-6` —— 与 `AppHeader` 的左缘对齐。
     *
     * 页头的 h1 左缘在 `paddingLeft + 8`（交通灯让位）再 `pl-6`，
     * 而这里原来是 `p-6` —— 量到的结果是 h1 文字 x=244、内容 x=252。
     * 差 8px 意味着整页**没有一条共同的左基线**，那是"割裂"里最难
     * 指名道姓、但扫一眼就不舒服的一条。
     *
     * ★ 两档垂直节奏。
     *
     * · **组间** `gap-section-xxxl`(28px) —— 就是这一层：
     *   「它掌握了什么」与「它认识的人与事」之间；
     * · **段间** 24px —— 在下面那个 12 列栅格的 `gap-6` 里
     *   （问候 / 清点 / 分身 三段之间）。
     *
     * 28 与 24 只差 4px，读起来几乎是同一档 —— 那是**刻意**的：
     * 上半部分那三段本来就属于同一个板块，它们之间不该比板块之间还宽。
     *
     * ⚠️ 别把组间换成 `gap-section-lg`(16px)：那与段间的 24 差 8px，
     * 会读成"板块之间比段之间还近"，层级反过来。
     * （更早一版栽过同型的错：组内 14 vs 组间 16，两档在数值上成立、
     * 在眼睛里不成立。）
     */
    <div className="flex flex-col gap-[var(--gap-section-xxxl)] px-8 py-6">
      {/*
        ── 组 A：它掌握了什么 ───────────────────────────────

        ★★ 这一组上一版还有一条「头像 + 高鹏 + 本人身份已确认」的身份条，
        它被**删掉**了。

        侧栏底部（`sidebar-user-button.tsx`）本来就常驻着同一份身份 ——
        头像 + 名字 + 邮箱，切到哪一页都在。于是同一屏出现两个同名头像，
        而读者会去找它们的区别（其实没有）。那是"很割裂"里的一条。

        本人身份归**侧栏**，这一页只讲分身。身份未确认那条警示没有丢，
        它变成了下面的 `ProblemLine`（见 `identity` 的注释）。

        渠道筹码（「钉钉」）移到了 `AppHeader` 的 actions 槽 ——
        它是**整页的取值范围**，该与页面标题同级。
      */}
      {/*
        ★★★ 上半部分走一套 **12 列栅格**，三段的左缘落在**同一条线**上。

        ## 为什么是栅格而不是继续调 flex

        这一块改了七八轮都没解决"不对齐"，因为每一段都是独立的 flex 行、
        各自用 `justify-end` / `flex-1 basis-[140px]` / `gap-x-8` 决定位置
        —— **没有任何一处定义"这一页的列在哪"**。于是在真应用里量出四条
        互不重合的左缘（头像 64 / 卡片 428 / 清点数 928 / h1 60），
        块与块之间那些"奇怪的空白"就是这些线之间的残余。

        用户："你不觉得很不对齐吗，奇怪的空白很多也不是很有设计感"。
        间距微调救不了它 —— 问题不在间距的**值**，在于**没有共同的参照**。

        flex 是"按内容排"（有多宽占多宽），grid 是"按列排"——
        而"对齐"要的正是后者。

        ## 三段怎么占列

        · 段 1（问候）  ：`col-span-12`（跨满）
        · 段 2（清点）  ：六项各 `col-span-2`（6×2 = 12）
        · 段 3（分身）  ：分身块 `col-span-4` + 四个卡片各 `col-span-2`

        于是：段 2 第 1 项左缘 = 头像左缘 = 分身形象左缘（第 1 列）；
        段 2 第 3 项左缘 = 段 3 第 1 个卡片左缘 —— 上下两段互相锚定。
        全页只剩**一条左基线 + 一条右基线**，中间的空白全是列间隙。

        `gap-6`(24px) 同时做**列间隙**与**段间距** —— 一个值，
        于是横竖两个方向的节奏是同一个。上一版横 32/竖 20/28 三个值。
      */}
      <div className="grid grid-cols-12 gap-6">
        {/* ── 段 1：你是谁 ───────────────────────────────── */}
        {accountName === undefined ? null : (
          <div className="col-span-12 flex items-center gap-4">
            {/*
              ★ 头像在 greeting **左边**（用户最后一次明确的顺序）。
              48px 的问候语是这一行的主内容，64px 头像是它的前导标识 ——
              "图标 + 文字"的常规读序。

              `items-center`：64px 头像与 48px 文字居中对齐，
              视觉重心在同一条水平线上。

              ★ 照片优先用**当前渠道本人**那张（`channelAvatarUrl`，见上面
              那段说明），取不到才回落 app 登录账号的 `avatarUrl`、
              再回落首字母。名字兜底用 `accountName`（当前渠道账号名）；
              未授权时 `accountName===null`，兜底首字母用「未」而不是空。
            */}
            <Avatar
              name={accountName ?? "未授权"}
              src={channelAvatarUrl ?? session?.avatarUrl ?? null}
              size="xl"
            />
            <GreetingRow accountName={accountName} />
            {/*
              ── 刷新按钮去哪了 ──────────────────────────────

              它移到了顶栏右上角（`app-shell.tsx` 的 actions 槽、渠道筹码左边）。
              原来它挂在这一行 `ml-auto` 推到最右，落在问候语与大数字之间一片
              空白的奇怪位置（用户反馈）。刷新是**整屏**的全局动作，与顶栏那枚
              渠道筹码同一类，归到顶栏更合理。见 `RefreshStatusButton`。
            */}
          </div>
        )}

        {/*
          ── 段 2：它掌握了多少 ──────────────────────────

          六个静态清点数，**各占 2 列**、左对齐。

          ★ 上一版是 `justify-end`（整排挤在右边），于是左边一大片空白
          而第一项的左缘落在 x=928 —— 与头像的 64 差了 860px。
          现在第一项就在第 1 列，与头像、分身形象**同一条线**。

          ★ 窄屏降级：`sm:col-span-4`（三列两行）→ `col-span-6`（两列三行）。
          每一档都是 12 的整除数，所以**换行之后仍然对齐**。
        */}
        {[
          { label: "会话", value: ing?.conversations ?? "—", count: scope.ingest?.conversations },
          { label: "图片与文件", value: ing?.media ?? "—", count: scope.ingest?.mediaAssets },
          {
            label: "认识的人和事物",
            value: formatCount(graph?.entities ?? 0),
            count: graph?.entities ?? 0,
          },
          { label: "记住的事", value: formatCount(graph?.facts ?? 0), count: graph?.facts ?? 0 },
          { label: "关系", value: formatCount(graph?.edges ?? 0), count: graph?.edges ?? 0 },
          { label: "消息", value: ing?.messages ?? "—", count: scope.ingest?.messages },
        ].map((item) => (
          <div key={item.label} className="col-span-6 sm:col-span-4 lg:col-span-2">
            <MiniStat label={item.label} value={item.value} count={item.count} />
          </div>
        ))}

        {/*
          ── 段 3：它现在怎么样（数字分身） ────────────────

          ## ★★ 上一版这里有一条 `border-t` 分割线，删了

          用户：「分割线可能也没有很有必要」。而它确实是多余的 ——
          它想分隔的两块（上面的问候+清点 / 这里的分身）**已经**靠内容
          区分得很清楚：一边是 48px 问候语与六个裸排的数，一边是
          「我的数字分身 小小周」加四个凹槽卡片。

          更糟的是那条线自己需要上下留白，于是我上一版给它 8px + 8px ——
          结果线被夹死、上下两块反而被推远，用户看到的是"排布有点紧密"。

          现在靠**间距**分段（外层栅格的 `gap-6`），
          而四个 `StatTile` 的凹槽本来就是"这一段开始了"的信号。
          这与 `primitives.tsx` 文件头那条原则一致：
          **层级靠色阶与间距，加重的只有数据** —— 不靠线，也不靠框。

          ★ `col-span-12` + 内部自己也是 12 列（见 `identity.tsx`）：
          于是分身块占 4 列、四个卡片各 2 列，它们的列边界与上面段 2 的
          六个清点数**共用同一套线**（段 2 第 3 项 = 段 3 第 1 个卡片）。
        */}
        <div className="col-span-12">
          {/*
            ★★ 数字分身只在主渠道工作 —— 其余渠道是**只读**接入
            （不进自动回复/发消息链路，结构上就没挂 personaSupervisor）。
            
            不支持时必须换成一句说明，而不是显示**另一个渠道的**草稿数：
            后者会让用户以为"这 3 条草稿会发到飞书"，而它们其实是钉钉的。
          */}
          {scope.personaSupported ? (
            <PersonaCard persona={personaIdentity} snapshot={scope.persona} cards={per} />
          ) : (
            <div className="radius-lg border border-[var(--border-divider-light)] px-4 py-3">
              <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
                {tp("unsupportedChannel", {
                  defaultValue: "数字分身功能暂未开通这个渠道",
                })}
              </p>
              <p className="typography-caption-400 mt-1 text-[var(--text-base-tertiary)]">
                {tp("unsupportedChannelHint", {
                  defaultValue:
                    "这个渠道是只读接入：数据只用于建图与搜索，不会进入自动回复或发消息链路。",
                })}
              </p>
            </div>
          )}
        </div>

        {/*
          ── 这一组的问题行 ─────────────────────────────────

          ★ 身份未确认排在**最前面** —— 它的后果比其余几条都重：
          蒸馏会拒掉**全部**语料，且不报错。上面那些数字看起来一切正常，
          而实际上画像是空的。

          ★★ 指向哪个入口**分情形**（判据走 `readIdentityProblem`，有单测）：
          最常见的成因是"继承来的登录态"，它的正确动作在**渠道页**
          （设置 → 渠道 → 采纳本机登录态），而「解析身份」按钮解决不了它。

          ★ 另一半说的是「运行状态」页而不是「设置」——
          `SelfIdentityPanel` 挂在 `StatusPanel` 里（见 data-plane-panel.tsx）。
          从前那句写的是"去设置里确认一下"，而那个页面上根本没有这个入口。
        */}
        {/*
          ★★ 这条横幅**只对主渠道**成立。
          
          非主渠道压根没有身份行（`readSelfIdentity` 返回的是主渠道那一行，
          而 `selfConfirmed` 在它们的 perChannel 里恒 false）—— 于是选了飞书时
          这条恒亮，且它指向的操作（去运行状态解析身份）在飞书上不存在：
          那一页的身份卡本身就只对主渠道渲染。
          
          一条恒亮、且照着做也没有结果的红色告警比不显示糟得多 ——
          用户会学会忽略它，而主渠道真的没确认时也一起忽略了。
        */}
        {scope.personaSupported &&
        identity.selfState === "unconfirmed" &&
        identityProblem !== null ? (
          <div className="col-span-12">
            <ProblemLine
              text={
                identityProblem.kind === "adopt"
                  ? `本人身份还没确认 —— 蒸馏会拒掉全部语料。本机已登录「${identityProblem.corpName}」，去设置的渠道页采纳这份登录态`
                  : identityProblem.kind === "ambiguous"
                    ? "同名账号有多个，没法自动确定哪个是你 —— 蒸馏会拒掉全部语料，去「运行状态」页确认"
                    : "本人身份还没确认 —— 蒸馏会拒掉全部语料，去「运行状态」页解析并确认"
              }
              tone="bad"
            />
          </div>
        ) : null}

        {ing?.problem === undefined || ing.problem === null ? null : (
          <div className="col-span-12">
            <ProblemLine
              text={ing.problem}
              tone={scope.ingest?.blockedReason === null ? "warn" : "bad"}
            />
          </div>
        )}
        {/*
          ── 听记覆盖面 ─────────────────────────────────────

          ## ★ 为什么在这里出现，而不是加进上面那六个清点数

          那六个是 `lg:col-span-2` × 6 = 恰好 12 列（注释里那条"换行之后
          仍然对齐"的不变式靠的就是这个）。加第七个会让每一档都不再是
          12 的整除数 —— 而这一条要说的本来也不是"有多少"而是"全不全"。

          与旁边那些 `ProblemLine` 同一个口径：**只在出事时出现一行**，
          一切正常时什么都没有。听记条数本身仍然在 `IngestCards` 里
          （给别的面板用），这里只负责"它是不是全部"这个问题。

          `tone="warn"` 而不是 `bad`：覆盖不全是"还差一些"而不是"坏了"，
          而且它不阻塞任何东西（会议照常在采、图谱照常在建）。
        */}
        {ing?.minutesHint === undefined || ing.minutesHint === null ? null : (
          <div className="col-span-12">
            <ProblemLine text={`听记：${ing.minutesHint}`} tone="warn" />
          </div>
        )}
        {/*
          ── 「知识加工落后 N 条」不在仪表盘出现（用户要求）──────────

          这句原来在这里（`readProcessing` 的一行）。用户明确不要它出现在
          仪表盘：它讲的是水位落后的架构细节，而仪表盘要答的是"能不能用"。
          落后本身在**运行状态页**仍有完整表达（那里本就是排查用的）。
          `readProcessing` 的判据保留（状态页在用），仪表盘只是不再渲染。
        */}

        {/*
          ── 分身的降级提示 ─────────────────────────────────

          四个数（待我确认 / 可自动回复 / 正在排队 / 常驻会话）在
          `PersonaCard` 的下半部分 —— 它们与"它是谁"是同一个主语的两半。

          但降级提示留在这里（卡**之外**的一行），因为它是**出事时**才出现的
          东西 —— 塞进那张卡会让卡的高度随状态跳。
        */}
        {per?.degraded === undefined || per.degraded === null ? null : (
          <div className="col-span-12">
            <ProblemLine text={per.degraded} tone={per.killSwitch ? "bad" : "warn"} />
          </div>
        )}
      </div>
      {/* ── 组 A 结束 ─────────────────────────────────────── */}

      {/*
        ── 数据流水与消化 ───────────────────────────────────

        ★ 这个板块回答的是组 A **答不了**的那个问题。

        组 A 的数字全是**累计标量**（32,878 条消息、602 个实体）。它们说
        "有多少"，但说不出两件事：

        ① **节律** —— 一个周期内进来了多少、什么时候忙。曲线一眼就有，
           而一个总数永远看不出来；
        ② **消化率** —— 喂进去多少 vs 真的落地多少。实测本机图谱只消化了
           8.4%（`graph-build` 水位 2,871 / changelog head 34,142），
           而组 A 那 602 个实体看起来完全正常。

        第二条是这一块存在的主要理由：那是一个**当前完全不可见**的缺口，
        而它决定了检索与画像的上限。见 `readGraphLag` 的判据注释。
      */}
      <TrendsSection building={building} />

      {/*
        ── 它认识的人与事 ───────────────────────────────────

        ★ 图与事实**合成一个板块**，不是两个。

        这一页的文件头已经写过同一个判断（撤掉独立「知识图谱」栏的理由）：
        「它与仪表盘讲的是同一个故事的两段，分开之后两边都不完整」。
        图与事实是那句话的下一层实例 —— 图回答"它认识谁"，事实回答
        "关于这个人它知道什么"。

        分成两个板块时"点上面 → 下面变"这条因果要跨过一个板块边界、
        两条 ProblemLine 和一屏距离，于是它在用户侧不存在（这正是
        「我点个图谱的点我很难感知到下面会有筛选」那句反馈）。
        贴在一起 + 中间那条联动带，因果才是**可见**的。
      */}
      <Section
        title="它认识的人与事"
        grid={false}
        subtitle={
          ego.data?.available === true && ego.data.self !== null
            ? `以「${ego.data.self.name}」为中心 · ${formatCount(ego.data.nodes.length - 1)} 个直接关联 · 点一个人看关于他的事实`
            : `kl · ${klView.text}`
        }
        action={
          /*
            ★ 两颗放一行：ⓘ 在左、动作在右。

            左信息右动作是这一页其余地方的既有顺序（数字分身右上角那排
            也是"看"在前、"设"在后）。而 ⓘ 只在真有内容时渲染
            （见 `GraphDetailPopover`：点开什么都没有的入口比没有更糟）。
          */
          <div className="flex items-center gap-1.5">
            <GraphDetailPopover overview={graph ?? null} progressNote={graphProgressNote} />
            <Button
              size="sm"
              variant="secondary"
              disabled={kl === null || building || buildGraph.isPending}
              /**
               * ★ 带上页头选中的渠道 —— 这一页的每个数字都跟着它，
               * 建图这个动作也必须。不带会把另一个渠道的图一起建
               * （preload 那层曾经把 channelId 吞掉，见 `preload-arity` 门禁）。
               */
              onClick={() =>
                buildGraph.mutate({
                  fresh: false,
                  ...(graphChannel === undefined ? {} : { channelId: graphChannel }),
                })
              }
            >
              {/*
              ★★ 这颗按钮**绝不能**叫「重新建图」—— 那是一次真实的语义 bug。

              图谱侧的写入全部只增不减（实测 `upsert_entity` 是
              `mention_count + 1`，facts/edges 是 `INSERT OR IGNORE`，
              而整个 storage 层**没有任何** DELETE / prune / 孤儿清理）。
              所以缩小采集范围之后，旧会话的实体与边**永远留在图里** ——
              实测本机图库覆盖 73 个会话而当前导出只有 72 个，交集仅 40 个：
              33 个已不在范围内的会话仍占着 26501 / 37566 条消息（70.5%）。

              用户点着一个写「重新」的按钮，得到的是"又加了一轮"。
              真正会清空重来的入口是状态页那个「重建」（`fresh=true`，
              它会删掉 knowledge.db + qdrant + 抽取缓存）。

              ★ 现在叫「同步」（原来是「继续建图（增量）」）。这个词比原来那句
              更贴那条约束：「同步」说的是"把新采到的补进去"，本身就不含
              "清空重来"的意思；而「建图」这个词让人以为每次都从头来一遍
              （那也正是"为什么每次都要几分钟"这类困惑的来源）。

              ★★ 三档仍然要分开 —— 它们回答的是不同的问题：
              · 进行中 → 「同步中…」（按钮同时被 disabled，见上）；
              · 已有图 → 「同步」（补增量）；
              · 还没有图 → 「首次同步」而不是光「同步」：第一次要烧全部语料的
                embedding（分钟级、出网、花钱），与后续那种几十秒的增量
                完全不是一件事。不区分的话用户会以为第一次也很快。
            */}
              {building ? "同步中…" : graph?.available === true ? "同步" : "首次同步"}
            </Button>
          </div>
        }
      >
        {/*
          建图/降级的原因移进板块**内部、图的上方**。
          原来它们夹在两个板块之间，而那时读者不知道那句话在说哪一块。
        */}
        {buildGraph.data?.ok === false && buildGraph.data.reason !== null ? (
          <ProblemLine text={buildGraph.data.reason} tone="bad" />
        ) : null}
        {/*
          ★★ `graph.reason` **只在"要用户动手"时常驻**。

          那个字段有四种来源，前三种（正在建图 ×2、还没建过图）是**进度或
          入口的复述** —— 它们与旁边那颗按钮说的是同一件事（按钮上写着
          「同步中…」/「首次同步」），常驻等于把同一句话说两遍，
          而版面被挤掉一行。第四种（facts=0 抽取没成功）才有下一步动作。

          判据在 `classifyGraphReason`（纯函数、按结构化事实分档，不匹配文案）。
          进度那两档进右上角那颗 ⓘ 的 popover。
        */}
        {graphReasonKind === "actionable" &&
        graph?.reason !== undefined &&
        graph.reason !== null ? (
          <ProblemLine text={graph.reason} tone="warn" />
        ) : null}

        <EgoGraphPanel
          data={ego.data}
          loading={ego.isLoading}
          building={building}
          onRebuild={() =>
            buildGraph.mutate({
              fresh: false,
              ...(graphChannel === undefined ? {} : { channelId: graphChannel }),
            })
          }
          onPickEntity={setEntityFocus}
          focusedName={entityFocus}
        />

        {/*
          实体类型分布放在图**下面**而不是另开一个板块：
          它说的是同一张图里"这些点分别是什么"，紧贴着才读得出来。
        */}
        {entityRows.length === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
              全图的实体类型（共 {formatCount(graph?.entities ?? 0)} 个）
            </span>
            <Distribution rows={entityRows} />
          </div>
        )}

        {/*
          ── 联动带：图与事实之间那条看得见的因果 ──────────────
          它必须在**中间** —— 放图上面（用户在看图）或列表下面
          （滚过去才看到）都答不了"点了之后哪里变了"。
        */}
        <div ref={bridgeRef} className="scroll-mt-4">
          <FocusBridge
            focus={entityFocus}
            color={focusColor}
            count={focusCount}
            onClear={() => setEntityFocus(null)}
          />
        </div>

        {/*
          事实检索：从消息里抽出来的陈述句。
          它与上面那张图共用 `entityFocus` —— 那正是"合成一块"的意义。
        */}
        {/*
          ★★ 渠道还没定下来时**不渲染**这一块。

          `FactsExplorer` 收到 `channelId: undefined` 的语义是"**合并全部渠道**"
          （搜索那条路要它，见 `klGraphFactsInputSchema`）。而仪表盘是
          "看某一个渠道的图谱" —— 渠道列表还没加载完的那一瞬间
          `graphChannel` 是 undefined，于是这里会显示**两个渠道合并**的事实，
          而标题与上面那张图已经在按某个具体渠道渲染。

          与 `useKlGraphEgo` 的 `enabled` 是同一类问题（见那里的完整分析），
          只是这一处不能靠 `enabled` 解决：`undefined` 在那一层是合法语义，
          关掉它会把搜索的合并检索一起关掉。所以门开在调用方。
        */}
        {graphChannel === undefined ? null : (
          <FactsExplorer
            typeCounts={graph?.factTypes ?? []}
            channelId={graphChannel}
            entityFocus={entityFocus}
            onEntityFocusChange={setEntityFocus}
            onTotalChange={setFocusCount}
          />
        )}
      </Section>
    </div>
  )
}

/**
 * 静态清点数：会话 / 图片与文件 / 实体 / 事实 / 关系边 / 消息。
 *
 * ## ★ 它**不带**容器（凹槽），与下面四个 `StatTile` 不同
 *
 * 两者是不同的东西，不该长一样：
 * · 这里是**静态清点**（它读过多少）—— 看一眼知道规模，之后不用再管；
 * · `StatTile` 是**当前状态**（有几条等我审）—— 那是要盯的数，值得一个
 *   凹槽把它框出来，让人回到这一页时先看到它。
 *
 * 给这六个也加凹槽会变成"十个一样的方块"，那时"哪个要我动手"读不出来。
 */
function MiniStat({
  label,
  value,
  count,
}: {
  label: string
  /** 已格式化的展示串。`count` 缺失（如"—"占位）时直接显示它。 */
  value: string
  /**
   * 原始数值。给了就用 `CountUp` 从 0 滚到它（`formatCount` 同源格式化）；
   * `undefined`（渠道未连、拿不到数）就静态显示 `value`——占位符不该"从 0 数到 —"。
   *
   * ★ 显式带上 `undefined`：这六个数用 `.map` 一起过，`scope.ingest?.x` 天然
   * 是 `number | undefined`，`exactOptionalPropertyTypes` 下不能塞进 `count?:`。
   */
  count?: number | undefined
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{label}</span>
      {/*
        比例数字（见 primitives.tsx 文件头）：单个数字不需要纵向对齐。

        ## ★★ 18px，这个字号被压小过一次又改回来了

        上一版压到 15px（`title-small-500`），为的是"让六个数挤进同一行"。
        但 15px 与 12px 的 label 只差 3px —— 主次读不出来，两行看着像
        同一级的两个词。用户："MiniStat 可能也太小了，也不一定强求在一行里"。

        改回 18px（`title-base-600`）之后与 12px 的 label 差 6px，
        "标签小而淡 / 数字大而实"那个对比才成立。装不下就换行 ——
        换行比压字号好，那是这一轮松掉的那条假约束。

        ## ★ CountUp：数值型才滚，占位符静态

        有原始 `count` 就交给 `CountUp`（从 0 弹到目标，reduced-motion 直显终值、
        只在进入视口时数一次），拿不到数的"—"仍走静态 `value` ——
        让"从 0 数到 —"这种荒唐态不出现。
      */}
      {count === undefined ? (
        <span className="typography-title-base-600 leading-none text-[var(--text-base-primary)]">
          {value}
        </span>
      ) : (
        <CountUp
          value={count}
          className="typography-title-base-600 leading-none text-[var(--text-base-primary)]"
        />
      )}
    </div>
  )
}

/**
 * 周期选项。
 *
 * ★ 与事实面板那组（7/30/90）保持一致 —— 同一页里两个周期选择器
 * 给不同的档位，用户会以为它们量的是不同的东西。
 */
const TREND_RANGES = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
] as const

/**
 * ★★ recharts **懒加载**，这是本文件唯一的 `lazy`。
 *
 * 实测产物（`electron-vite build`，不是估算）：图表落到一个
 * **801 KiB raw / 164 KiB gzip** 的独立 chunk，而首屏 entry 只从
 * 6003 KiB 涨到 6028 KiB（+25 KiB，0.4%）—— 那 25 KiB 是与 renderer
 * 共用的依赖被提到共享图上，不是 recharts 独有的开销。
 * 产物里 `grep -c recharts`：chunk 75 次，首屏 entry **0 次**。
 *
 * 仪表盘是打开应用第一眼的那一页 —— 为一张要滚一下才看到的图在首屏
 * 多解析 800 KiB 不值得。
 *
 * ★ 必须放在**模块顶层**：写在组件里的话每次渲染都造一个新的 lazy 组件，
 * React 会把它当成不同的类型 → 每次重挂载 → 每次重播 Suspense 兜底。
 */
const TrendChart = lazy(() => import("./trend-chart.js"))

/**
 * 数据流水与消化。
 *
 * ## ★ 为什么单独一个组件而不是写在 `DashboardModule` 里
 *
 * 它有自己的 state（周期）与自己的 query。写在上面那个组件里的话，
 * 切周期会让**整页**重渲染（含 ego 图那张 canvas 与事实列表）——
 * 而实际变的只有这一块。
 */
function TrendsSection({ building }: { building: boolean }) {
  const [days, setDays] = useState<number>(30)
  const trends = useDashboardTrends(days, building)
  const { resolved: mode } = useTheme()

  const data = trends.data ?? null
  const summary = readTrendSummary(data)
  const factGap = readFactTimestampGap(data)
  // 「读过的内容」按类型拆一句人话（聊天 N · 会议记录 M · 文档 K）
  const unitsBreakdown = describeUnitsByType(data?.funnel.unitsByType)

  /**
   * 图上有没有数据。
   *
   * ★ 判据是 `days.length > 0` 而**不是** `summary !== null`：
   * vault 没挂载时 `days` 是空数组（见服务侧 `emptyTrends` 的注释 ——
   * 刻意不返回一串 0，否则会画出一条"90 天全是 0"的曲线，
   * 那看起来像采集彻底坏了）。
   */
  const hasData = data !== null && data.days.length > 0

  return (
    <Section
      title="最近在忙什么"
      grid={false}
      subtitle={
        summary === null
          ? "还没有可统计的数据"
          : `${formatCount(summary.inbound + summary.outbound)} 条消息 · 日均 ${formatCount(summary.perDay)} 条` +
            (data !== null && data.daysWithData < data.windowDays
              ? ` · 实际覆盖 ${String(data.daysWithData)} 天`
              : "")
      }
      action={
        /*
          周期选择器。`aria-pressed` 而不是 `role="tablist"`：
          它切的是同一块内容的取值范围，不是切换面板。

          ★★ `data-range-scope="trends"` 是**必须的**，不是可选的元数据。

          这一页现在有**两组**「近 7/30/90 天」：这一组切时序图的窗口，
          事实面板那组筛事实。两组都是匿名 `button[aria-pressed]` 且文案
          完全相同 —— 实测 `check-dashboard-ui` 因此命中了错的那一组
          （它按文案 `.find()`，而本组在 DOM 里更靠前），把时序图切成
          7 天之后报「事实过滤器没生效 159 → 159」。

          那是一个**假故障**：过滤器好得很，是探针点错了按钮。
          所以两组各带一个 scope，门禁按 scope 取自己那一组。
        */
        <div className="flex items-center gap-1">
          {TREND_RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              data-range-scope="trends"
              aria-pressed={days === range.days}
              onClick={() => setDays(range.days)}
              className={`typography-caption-400 rounded-[var(--radius-sm)] px-2 py-1 transition-colors duration-150 ${
                days === range.days
                  ? "bg-[var(--bg-card-z0)] text-[var(--text-base-primary)]"
                  : "text-[var(--text-base-tertiary)] hover:bg-[var(--overlay-on-container-hover)]"
              }`}
            >
              {range.label}
            </button>
          ))}
        </div>
      }
    >
      {/*
        ── 「才学了 X%（还差 N 条）」不在仪表盘出现（用户要求）──────────

        这句原来排在图之前（`readGraphLag` 的 bad/warn 档）。用户明确不要它
        出现在仪表盘：`graph-build` 水位是批处理的、天然落后，且这台机器上
        它有"初始建图从没推过游标"的历史成因，算出来的比例常常与真实覆盖
        相反（实测图已建好而水位停在 0 → 报 0.0%）。这类"数字与事实相反"的
        提示放在首页只会误导。落后本身在**运行状态页**仍有完整表达。
        `readGraphLag` 的判据保留（状态页/popover 在用），仪表盘不再渲染。
      */}

      <Panel tone="raised" className="flex flex-col gap-4">
        {hasData ? (
          <>
            {/* 图例 —— 手写而不用 recharts 的 `<Legend>`：那个的排版与
                字号跟不上这一页的 token，而这里只有三项。 */}
            <div className="flex flex-wrap items-center gap-4">
              <LegendDot color={entityColor("Person", mode)} label="收到" />
              <LegendDot color={entityColor("System", mode)} label="发出" />
              {data.graphAvailable ? (
                <LegendDot color={ENTITY_NEUTRAL[mode]} label="已学习" />
              ) : null}
              {summary?.busiest === undefined || summary.busiest === null ? null : (
                <span className="typography-caption-400 ml-auto text-[var(--text-base-tertiary)]">
                  最忙{" "}
                  {new Date(summary.busiest.at).toLocaleDateString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                  })}
                  {" · "}
                  {formatCount(summary.busiest.count)} 条
                </span>
              )}
            </div>
            {/*
              `Suspense` 的兜底是一个**等高的空块**，不是 spinner：
              chunk 从本地磁盘加载是几十毫秒，一个转圈会闪一下就消失
              —— 那比什么都不显示更吵。等高是为了不跳布局。
            */}
            <Suspense fallback={<div className="h-[260px]" />}>
              <TrendChart
                days={data.days}
                mode={mode}
                showChunks={data.graphAvailable}
                height={260}
              />
            </Suspense>
            {summary !== null && summary.emptyDays > 0 ? (
              <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
                其中 {String(summary.emptyDays)} 天没有任何消息 —— 周末，或那几天采集没跑
              </p>
            ) : null}
          </>
        ) : (
          <p className="typography-body-small-400 py-8 text-center text-[var(--text-base-tertiary)]">
            {trends.isLoading ? "正在统计…" : "还没有采集到数据 —— 先在设置里连上钉钉"}
          </p>
        )}
      </Panel>

      {/* 学到了什么 与 拿全了没 并排：都是"全不全"的问题，同一层级 */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel tone="raised" className="flex flex-col gap-3">
          <PanelHeader title="从这些内容里学到了什么" hint="读了多少 → 记住了多少" />
          <Funnel
            stages={[
              {
                label: "消息",
                value: data?.funnel.messages ?? null,
                color: entityColor("Person", mode),
              },
              {
                label: "读过的内容",
                value: data?.graphAvailable === true ? data.funnel.units : null,
                color: entityColor("Person", mode),
                // ★ 分类摘要放进 hint —— 用友好名字，不出现 message/wiki 这种原始类型码
                ...(unitsBreakdown === null ? {} : { hint: unitsBreakdown }),
              },
              {
                label: "内容片段",
                value: data?.graphAvailable === true ? data.funnel.chunks : null,
                color: entityColor("Project", mode),
                hint: "把相邻的消息合成一小段再理解，所以比消息少是正常的",
              },
              {
                label: "记住的事",
                value: data?.graphAvailable === true ? data.funnel.facts : null,
                color: entityColor("Organization", mode),
                hint: "从内容里读出来的一条条要点",
              },
              {
                label: "认识的人和事物",
                value: data?.graphAvailable === true ? data.funnel.entities : null,
                color: entityColor("System", mode),
              },
            ]}
          />
          {data?.graphAvailable === false ? (
            <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
              还在学习中 —— 点上面那块的「同步」开始
            </p>
          ) : null}
        </Panel>

        <Panel tone="raised" className="flex flex-col gap-3">
          <PanelHeader title="拿全了没" hint="已经拿到的 / 应该有的" />
          <div className="flex flex-col gap-3">
            <CoverageBar
              label="记得发生的时间"
              done={data?.coverage.factsTimestamped.done ?? 0}
              total={data?.coverage.factsTimestamped.total ?? 0}
              color={entityColor("Organization", mode)}
              /*
                ★ 0.6 这个阈值：实测本机 450/975 = 46% 会亮黄。那是**对的** ——
                一半的事实没有时间戳意味着"上周的决策有哪些"这类问题
                只能在另一半里找。
              */
              warnBelow={0.6}
              {...(factGap === null ? {} : { hint: factGap })}
            />
            <CoverageBar
              label="图片已下载"
              done={data?.coverage.mediaDownloaded.done ?? 0}
              total={data?.coverage.mediaDownloaded.total ?? 0}
              color={entityColor("Project", mode)}
              /*
                ★ 0.5：实测本机 10/2844 = 0.35% 会亮黄。「登记了 2844 条资产」
                与「能看 10 张图」是两件事，而现在的界面只显示前者。
              */
              warnBelow={0.5}
              hint="没下载的那些暂时看不到原图"
            />
            {/*
              ★ 「社群摘要」那一条**去掉了**（不再透出社群这个概念）。
              社群能力已在算法侧默认关闭（config `KL_COMMUNITIES_ENABLED=0`），
              而它本就是个技术概念、对用户没有意义。契约里那个字段先留着
              （删它要动 schema + 服务 + 测试，且以后可能重新启用），
              只是界面不再显示。
            */}
          </div>
        </Panel>
      </div>
    </Section>
  )
}

/** 图例上的一项：色点 + 名字。 */
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="typography-caption-400 text-[var(--text-base-secondary)]">{label}</span>
    </span>
  )
}
