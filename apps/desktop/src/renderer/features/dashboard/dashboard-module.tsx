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
import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Avatar, Button } from "@mycontext/design"
import { resolveDisplayName } from "@mycontext/ipc-contract"
import {
  useAdoptableSession,
  useBootstrapState,
  useChannels,
  useDistillProgress,
  useFeedInfo,
  useIngestSnapshot,
  useKlGraphBuild,
  useKlGraphEgo,
  useKlGraphOverview,
  useKlServerStatus,
  useOnboardingSteps,
  usePersonaSnapshot,
  useSelfIdentity,
} from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useTheme } from "../../lib/use-theme.js"
import { EgoGraphPanel } from "../graph/ego-graph-panel.js"
import { FactsExplorer } from "../graph/facts-explorer.js"
import { entityColor } from "../graph/palette.js"
import { personaIdentityFromSteps } from "../persona/persona-identity.js"
import { FocusBridge } from "./focus-bridge.js"
import { GraphDetailPopover } from "./graph-detail-popover.js"
import { GreetingRow, pickChannelNick, resolveGreetingName } from "./greeting-row.js"
import { PersonaCard } from "./identity.js"
import { Distribution, Section } from "./primitives.js"
import {
  classifyGraphReason,
  describeKl,
  formatCount,
  readIdentityBar,
  readIdentityProblem,
  readIngest,
  readPersona,
  readProcessing,
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

export function DashboardModule() {
  const ingest = useIngestSnapshot(true)
  const distill = useDistillProgress(true)
  const persona = usePersonaSnapshot(true)
  const feed = useFeedInfo(true)
  const kl = useKlServerStatus()
  const buildGraph = useKlGraphBuild()
  const building = kl?.building === true
  const ego = useKlGraphEgo(building)
  const overview = useKlGraphOverview(building)
  const { resolved: mode } = useTheme()
  /** 实体类型名要翻译 —— 与 ego 图的图例共用 `graph` 那一份 key。 */
  const { t: tg } = useDynamicTranslation("graph")
  /**
   * 图里点一个人 → 事实面板筛到他。
   *
   * ★ 这个 state 在**仪表盘**而不是在两个子组件里 —— 那正是"把图谱
   * 并进来"这件事的意义：上面看到一个名字，下面立刻能看他说过什么。
   * 分成两页时这个动作要用户自己抄一遍名字。
   */
  const [entityFocus, setEntityFocus] = useState<string | null>(null)

  /**
   * 「刷新状态」按钮的加载态 + 失效入口。
   *
   * 用 `useQueryClient` 而不是逐个 hook 的 `refetch()`：这一屏的数据来自
   * 十几个 query（采集/图谱/数字人/水位/身份…），逐个列举必然漏，
   * 而漏掉的那个恰好就是用户在看的那个。全失效的代价是一次多余的重取。
   */
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

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
  const bootstrap = useBootstrapState()
  const session = bootstrap.data?.session ?? null
  /**
   * 渠道花名（钉钉昵称）—— 问候语优先用它。
   *
   * ★ 走 `useSelfIdentity`（query，只读本地一行）而不是 `useResolveSelf`
   * （mutation，每次真调渠道子进程）。让界面渲染触发一次渠道调用是
   * 那种"顺手写下、之后每次进页面都慢一下"的代价。
   *
   * 判定（与实名相同就不用）在 `pickChannelNick` 一处 ——
   * 引导第一步用的是同一个函数。
   */
  const selfIdentity = useSelfIdentity()
  const channelNick =
    session === null
      ? null
      : pickChannelNick(selfIdentity.data?.displayNames, resolveDisplayName(session))

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
   * 渠道现在连上了吗 —— 给「以下是历史数据」那句提示用。
   *
   * ★ 这与文件上方那句"曾经读 useChannels 是为了渠道筹码"不冲突：
   * 那枚筹码归 `AppHeader` 了，而这里要的是**另一个**判据 ——
   * 「这些数字还在增长吗」。引导走完之后应用不再判授权
   * （`onboarding.isDismissed()` 只看四步走过没有），所以登录态过期时
   * 仪表盘会一直显示历史数据而不给任何说明。见 `readIngest` 的 `staleData`。
   *
   * `undefined`（还在查）传 `null`：那时不下结论，免得已连接的账号
   * 首帧闪一下"历史数据"。
   */
  const channels = useChannels()
  const dingtalkState = channels.data?.find((item) => item.id === "dingtalk")?.status.state
  const channelConnected = dingtalkState === undefined ? null : dingtalkState === "authorized"

  const ing = readIngest(ingest.data ?? null, channelConnected)
  const per = readPersona(persona.data ?? null)
  const processing = readProcessing({ feed: feed.data ?? null, distill: distill.data ?? null })
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
    selfConfirmed: ingest.data?.selfConfirmed ?? null,
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
    identityState: ingest.data?.selfIdentityState,
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
        {session === null ? null : (
          <div className="col-span-12 flex items-center gap-4">
            {/*
              ★ 头像在 greeting **左边**（用户最后一次明确的顺序）。
              48px 的问候语是这一行的主内容，64px 头像是它的前导标识 ——
              "图标 + 文字"的常规读序。

              `items-center`：64px 头像与 48px 文字居中对齐，
              视觉重心在同一条水平线上。
            */}
            <Avatar
              name={resolveGreetingName(session, channelNick)}
              src={session.avatarUrl}
              size="xl"
            />
            <GreetingRow session={session} channelNick={channelNick} />
            {/*
              ── 刷新：把这一屏的状态重新读一遍 ──────────────

              ## ★★ 为什么需要它（而不是自动轮询）

              这一屏的数字平时靠**事件推送**保持新鲜（`useIngestProgress`
              把主进程推来的快照直接写进 query cache）——采集在跑时它比
              任何轮询都实时，也更省。

              但采集**不跑**时就没有事件。而那恰好是最需要看状态的时候
              （身份没绑上、被 blocked、权限不足）：数字停在旧值上，
              而用户唯一的出路是重启应用。这与我们修过的那批
              「点了没反应」是同一类问题 —— 系统没在骗人，只是没有出口。

              所以刷新是一个**用户主动**的动作，与"系统自动保持新鲜"
              不是一回事，两者并存。

              ## ★ 它不采集

              点它只是重新读一遍状态，**不会**去拉新消息（那是
              `ingest.runOnce`，另有入口）。文案必须说清 ——
              两者混淆会让用户以为点一下就能把落后的消息补上来。

              `ml-auto` 推到最右：它是这一行的次要动作，不该抢问候语的位置。
            */}
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              loading={refreshing}
              onClick={() => {
                setRefreshing(true)
                void queryClient.invalidateQueries().finally(() => setRefreshing(false))
              }}
              title="重新读取这一屏的状态（不会去拉新消息）"
            >
              刷新状态
            </Button>
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
          { label: "会话", value: ing?.conversations ?? "—" },
          { label: "图片与文件", value: ing?.media ?? "—" },
          { label: "实体", value: formatCount(graph?.entities ?? 0) },
          { label: "事实", value: formatCount(graph?.facts ?? 0) },
          { label: "关系边", value: formatCount(graph?.edges ?? 0) },
          { label: "消息", value: ing?.messages ?? "—" },
        ].map((item) => (
          <div key={item.label} className="col-span-6 sm:col-span-4 lg:col-span-2">
            <MiniStat label={item.label} value={item.value} />
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
          <PersonaCard persona={personaIdentity} snapshot={persona.data ?? null} cards={per} />
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
        {identity.selfState === "unconfirmed" && identityProblem !== null ? (
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
              tone={ingest.data?.blockedReason === null ? "warn" : "bad"}
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
          知识加工只在出事时出现一行 —— 那两个板块原来占的位置现在是空的，
          而"什么都没有"正是一切正常时最好的表达。
        */}
        {processing === null ? null : (
          <div className="col-span-12">
            <ProblemLine text={processing.text} tone={processing.tone} />
          </div>
        )}

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
              onClick={() => buildGraph.mutate(false)}
            >
              {/*
              ★★ 文案必须说清这是**增量**，不能叫「重新建图」。

              叫「重新」而做增量是一次真实的语义 bug：图谱侧的写入全部
              只增不减（实测 `upsert_entity` 是 `mention_count + 1`，
              facts/edges 是 `INSERT OR IGNORE`，而整个 storage 层
              **没有任何** DELETE / prune / 孤儿清理）。所以缩小采集范围
              之后，旧会话的实体与边**永远留在图里** —— 实测本机图库覆盖
              73 个会话而当前导出只有 72 个，交集仅 40 个：
              33 个已不在范围内的会话仍占着 26501 / 37566 条消息（70.5%）。

              用户点着一个写「重新」的按钮，得到的是"又加了一轮"，
              而仪表盘上那些数字里七成来自他已经取消勾选的会话。
              真正会清空重来的入口是状态页那个「重建」（`fresh=true`，
              它会删掉 knowledge.db + qdrant + 抽取缓存）。
            */}
              {building ? "建图中…" : graph?.available === true ? "继续建图（增量）" : "开始建图"}
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
          「建图中…」/「开始建图」），常驻等于把同一句话说两遍，
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
          onRebuild={() => buildGraph.mutate(false)}
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
        <FactsExplorer
          typeCounts={graph?.factTypes ?? []}
          entityFocus={entityFocus}
          onEntityFocusChange={setEntityFocus}
          onTotalChange={setFocusCount}
        />
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
function MiniStat({ label, value }: { label: string; value: string }) {
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
      */}
      <span className="typography-title-base-600 leading-none text-[var(--text-base-primary)]">
        {value}
      </span>
    </div>
  )
}
