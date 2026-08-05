/**
 * EventStream — ChatItem[] → 渲染分派表。
 *
 * ## ★ 这个目录（`features/agent-stream/`）是**共用**的
 *
 * 搜索模块与数字分身都要渲染同一套 agent 过程（thinking / 正文 / tool 调用组），
 * 而这套折叠、分组、自动收起的判据是调过的（见下面各段）。放在 `features/search/`
 * 下面让第二个消费者只能 import 一个"别人模块里的组件"，早晚被复制一份 ——
 * 那时两份的折叠阈值会各自漂。
 *
 * 配套地，文案（`stream.*`）从 `search.json` 移到了 **`common.json`**：
 * 组件不再硬编码 `useDynamicTranslation("search")`，而是用默认（common）
 * 命名空间。这比给每个子组件传一个 namespace prop 干净 —— 那 5 个组件全都
 * 只用 `stream.*`，没有一个真的需要"按调用方切换文案"。
 *
 * ## 视觉结构（移植参考实现的 chat feed）
 *
 * 借的是它的**结构与交互**，颜色/字号全部映射到 mycontext 的 design token：
 *
 * · **问** = 右侧异形圆角气泡（12/12/4/12），`w-fit` 内容自适应、`max-w` 才换行；
 * · **答** = 左对齐无气泡的正文，最高对比度（页面重心）；
 * · **证据** = 连续的工具调用折叠成**一组工作记录**（`ToolCallGroup`）：
 *   头部是纯文本摘要 + chevron，**无卡片、无边框、无底色**；
 *   展开后是一列扁平的 `ToolCallRow`。
 *
 * ## ★ 为什么工具行坚决不做成卡片
 *
 * 这是参考实现注释里写明、我们实测也认同的一条：工具调用是**正文旁的工作
 * 记录**，不是内容。一条描边卡片就有重量，一列卡片下来答案会沦为"其中一张
 * 卡"。所以整组只付一次视觉成本（一行可点的摘要），展开才铺细节。
 *
 * ## 折叠策略（同样照搬）
 *
 * · running 且不足 4 项 → 展开（用户想看它正在干什么）；
 * · 达到 4 项 → 折叠（再多就是噪音）；
 * · running → 完成后延迟 600ms 自动收起（让用户看到"跑完了"这一下，
 *   而不是内容瞬间消失）。
 *
 * 折叠动画用 **CSS Grid 行轨**（`grid-rows-[0fr]` → `[1fr]`）而不是
 * `height:auto` 测量：后者要么跳变、要么得逐项动画，实测都会卡。
 *
 * 动效全部尊重 `prefers-reduced-motion`。
 */
import { useEffect, useRef, useState } from "react"
import { cn } from "@mycontext/design"
import type { ChatItem, ToolStatus, UnifiedContentBlock } from "@mycontext/agent-runtime"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { MarkdownBody, stripNoise } from "./markdown-body.js"
import { ShinyText } from "./shiny-text.js"
import { BanIcon, ChevronDownIcon, CircleXIcon } from "./tool-icons.js"
import { ThinkingIndicator } from "./thinking-indicator.js"
import { isIdentifierLike, toolActionOf, toolIconOf, toolTitleOf } from "./tool-semantics.js"

export interface EventStreamProps {
  items: readonly ChatItem[]
  /** 点击引用 [n] 时打开来源抽屉 */
  onCitationClick?: ((ordinal: number) => void) | undefined
  /**
   * 本轮是否还在跑。用于在**尚无任何输出**时显示思考中指示器 ——
   * 实测模型首字要 ~3.8s，那几秒空白不给反馈会被当成卡死。
   */
  busy?: boolean
}

/** 达到这个数量的工具组默认折叠（参考实现取 4）。 */
const GROUP_COLLAPSE_THRESHOLD = 4

/** 折叠摘要最多列几项，超出用"等"收尾。 */
const SUMMARY_MAX = 3

/** running → 完成后延迟多久自动收起（让"跑完了"这一下被看见）。 */
const AUTO_COLLAPSE_DELAY_MS = 600

/**
 * 摘要**不该展示**的工具。
 *
 * `skill` 的 content 是 SKILL.md 正文 —— 我们**自己写给 agent 的指令**
 * （几十行 markdown、与用户的问题无关），展开等于把自己的 prompt 糊到
 * 用户脸上，还会把整组撑成整页最长的一块。
 */
const DETAIL_SUPPRESSED = new Set(["skill"])

type StreamNode =
  | { kind: "item"; key: string; item: ChatItem }
  | { kind: "tools"; key: string; items: ChatItem[] }

/**
 * 把扁平 item 列表折成渲染节点：**连续的 tool_call 合成一组**。
 *
 * 与参考实现的 `groupItemIds` 同构，两处差异：
 * ① 它把 thought 当"对分组透明"（因为它隐藏 thought）；我们**显示** thought，
 *    所以 thought 会断开分组 —— 一段思考之后的工具属于新的一段工作。
 * ② 分组只看**相邻**关系，不看 turnId：一轮里「查→答→再查」的两段工具本就
 *    该分成两组，用 turnId 归并会把中间的答案跳过去。
 *
 * 单条也走分组（`items.length === 1`）—— 参考实现在这种情况退化成 single，
 * 但那让"一个工具"和"两个工具"长得完全不同（一个有摘要头、一个没有），
 * 视觉上更跳。我们统一用组，组头对单条同样成立（"1 个操作"）。
 */
function toNodes(items: readonly ChatItem[]): StreamNode[] {
  const nodes: StreamNode[] = []
  for (const item of items) {
    if (item.itemType === "tool_call") {
      const last = nodes.at(-1)
      if (last?.kind === "tools") {
        last.items.push(item)
        continue
      }
      nodes.push({ kind: "tools", key: item.id, items: [item] })
      continue
    }
    nodes.push({ kind: "item", key: item.id, item })
  }
  return nodes
}

export function EventStream({ items, onCitationClick, busy = false }: EventStreamProps) {
  const nodes = toNodes(items)
  /**
   * 只在「本轮还没有任何 agent 产出」时显示思考中。
   *
   * 判据是最后一个 item 仍是**用户消息** —— 一旦有了 tool_call / thought /
   * message，事件流本身就在动了，再挂一个"思考中"是重复噪音。
   */
  const lastItem = items.at(-1)
  const showThinking = busy && lastItem?.role === "user"

  return (
    <div className="flex flex-col gap-[var(--gap-section-lg)]">
      {nodes.map((node) =>
        node.kind === "tools" ? (
          <ToolCallGroup key={node.key} items={node.items} />
        ) : (
          <ItemRow key={node.key} item={node.item} onCitationClick={onCitationClick} />
        ),
      )}
      {showThinking && <ThinkingIndicator />}
    </div>
  )
}

function ItemRow({
  item,
  onCitationClick,
}: {
  item: ChatItem
  onCitationClick?: ((ordinal: number) => void) | undefined
}) {
  switch (item.itemType) {
    case "message":
      return item.role === "user" ? (
        <UserMessage item={item} />
      ) : (
        <AssistantMessage item={item} onCitationClick={onCitationClick} />
      )
    case "thought":
      return <ThoughtRow item={item} />
    case "tool_call":
      return <ToolCallRow item={item} />
    case "plan":
      return <PlanRow item={item} />
    case "error":
      return <ErrorRow item={item} />
  }
}

/** 组的聚合状态。参考实现的 `groupStatusOf` 同构。 */
type GroupStatus = "running" | "completed" | "error" | "cancelled"

function groupStatusOf(items: readonly ChatItem[]): GroupStatus {
  // running 优先：只要还有一个在跑，整组就是"在跑"。
  if (items.some((item) => (item.toolStatus ?? "pending") === "running")) return "running"
  if (items.some((item) => item.toolStatus === "error")) return "error"
  if (items.some((item) => (item.toolStatus ?? "pending") === "pending")) return "cancelled"
  return "completed"
}

/**
 * 一组连续的工具调用。
 *
 * 头部是**纯文本**摘要（"3 个操作 · 查知识图谱、执行命令" + chevron），
 * 无卡片无边框无底色 —— 见文件头「为什么坚决不做成卡片」。
 */
function ToolCallGroup({ items }: { items: readonly ChatItem[] }) {
  const { t } = useDynamicTranslation()
  const status = groupStatusOf(items)
  const count = items.length

  const [collapsed, setCollapsed] = useState(
    () => status !== "running" || count >= GROUP_COLLAPSE_THRESHOLD,
  )
  const previousStatus = useRef(status)

  /**
   * running 结束后延迟收起；项数越过阈值时立即收起。
   *
   * 延迟 600ms 而不是立刻：turn 刚结束就把内容抽走，用户会觉得"刚才那行是什么
   * 我还没看清"。留一拍让"跑完了"被看见。
   */
  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = status

    if (previous === "running" && status !== "running") {
      const timer = setTimeout(() => setCollapsed(true), AUTO_COLLAPSE_DELAY_MS)
      return () => clearTimeout(timer)
    }
    if (status === "running" && count < GROUP_COLLAPSE_THRESHOLD) {
      setCollapsed(false)
    } else if (count >= GROUP_COLLAPSE_THRESHOLD) {
      setCollapsed(true)
    }
    return undefined
  }, [status, count])

  if (count === 0) return null

  // 摘要：按动作归并 + **带计数**，最多 3 项，超出用省略号收尾。
  //
  // ★ 为什么带计数：真数据里一组有 12 个 bash（agent 反复 kl 查询），
  //   纯去重后摘要就是"执行命令、搜索内容" —— 完全看不出它跑了 12 次还是 2 次。
  //   `执行命令 ×9` 才说明了这一组的规模，而规模正是用户想从折叠态知道的事。
  //
  // ★ 连接符走 i18n 而不是硬写 `、`：中文的顿号在英文下会渲染成
  //   "Use skill、Query knowledge graph"（实测截图确认）—— 那是中文标点漏进
  //   英文界面，i18n 的 en 侧给的是 ", "。
  const counts = new Map<string, number>()
  for (const item of items) {
    const title = displayTitleOf(item, t)
    if (title === "") continue
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  // 出现次数多的排前面：一组里"主要在干什么"比"顺带做了什么"更值得占位置。
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const summaryText =
    ranked
      .slice(0, SUMMARY_MAX)
      .map(([title, n]) => (n > 1 ? `${title} ×${String(n)}` : title))
      .join(t("stream.group.separator")) +
    (ranked.length > SUMMARY_MAX ? t("stream.group.more") : "")

  const muted = status === "error" || status === "cancelled"

  return (
    <div data-tool-group="" data-group-status={status} className="w-full">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        aria-busy={status === "running" ? true : undefined}
        className={cn(
          "typography-body-small-400 group flex max-w-full items-center gap-[var(--gap-component-sm)]",
          "-mx-[var(--spacing-sm)] rounded-[var(--radius-sm)] px-[var(--spacing-sm)] py-[var(--spacing-xxs)]",
          "overflow-hidden text-left transition-colors duration-150",
          "hover:bg-[var(--overlay-on-container-hover)]",
          "focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
          muted ? "text-[var(--text-base-tertiary)]" : "text-[var(--text-base-secondary)]",
        )}
      >
        <span className="shrink-0">{t("stream.group.action", { count })}</span>

        {/*
          分隔点。参考实现靠 `gap-1.5` 的空白分段，但那是在纯英文下 ——
          中文没有词间空格，「4 个操作 部分失败」两段会读成一句话
          （实测截图确认）。一个 `·` 把"数量"和"摘要/状态"明确分开。
        */}
        {(collapsed && summaryText !== "") || status !== "completed" ? (
          <span aria-hidden="true" className="shrink-0 text-[var(--text-base-disable)]">
            ·
          </span>
        ) : null}

        {collapsed && summaryText !== "" && (
          <span className="typography-caption-400 min-w-0 truncate text-[var(--text-base-tertiary)]">
            {summaryText}
          </span>
        )}

        {status === "running" && (
          // 折叠时用流光（有东西在动，但不闪）；展开时静态 —— 展开区里每行
          // 自己会流光，头部再流一遍就是两处在动，视觉噪音翻倍。
          <span className="typography-caption-400 shrink-0 whitespace-nowrap">
            {collapsed ? (
              <ShinyText text={t("stream.group.processing")} />
            ) : (
              <span className="text-[var(--text-base-tertiary)]">
                {t("stream.group.processing")}
              </span>
            )}
          </span>
        )}
        {status === "error" && (
          <span className="typography-caption-400 shrink-0 text-[var(--text-base-disable)]">
            {t("stream.group.failed")}
          </span>
        )}
        {status === "cancelled" && (
          <span className="typography-caption-400 shrink-0">{t("stream.group.cancelled")}</span>
        )}

        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none",
            collapsed && "-rotate-90",
          )}
        />
      </button>

      {/*
        折叠动画走 CSS Grid 行轨：`0fr` → `1fr`。
        比 height:auto 好在不需要测量，比逐项 motion 好在只有一个动画。
        `inert` 让折叠区里的按钮不可 focus（否则 Tab 会跳进看不见的地方）。
      */}
      <div
        aria-hidden={collapsed}
        inert={collapsed ? true : undefined}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          collapsed
            ? "pointer-events-none grid-rows-[0fr] opacity-0"
            : "grid-rows-[1fr] opacity-100",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col pl-[var(--spacing-xxs)]">
            {items.map((item) => (
              <ToolCallRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 这一行/这一项显示的标题（动作译名或模型给的描述）。 */
function displayTitleOf(item: ChatItem, t: (key: string) => string): string {
  const title = toolTitleOf(item.toolName ?? "")
  return title.kind === "literal" ? title.text : t(`stream.toolAction.${title.action}`)
}

/**
 * 单条工具调用行。
 *
 * 扁平：无卡片、无边框、无底色。左侧 16px 语义图标（终端/文档/放大镜…），
 * 中间标题，右侧状态字，最右 chevron —— **chevron 只在 hover/focus 时显形**，
 * 常态不占注意力（参考实现的做法，实测比常显干净得多）。
 *
 * running 时标题走流光而不是加个 spinner：一列 spinner 在转会让整页很躁，
 * 而流光只是让文字"活着"。
 */
function ToolCallRow({ item }: { item: ChatItem }) {
  const { t } = useDynamicTranslation()
  const [expanded, setExpanded] = useState(false)

  const rawName = (item.toolName ?? "").replace(/^mycontext_/, "")
  const status: ToolStatus = item.toolStatus ?? "pending"
  const title = toolTitleOf(rawName)
  const titleText = title.kind === "literal" ? title.text : t(`stream.toolAction.${title.action}`)
  const action = toolActionOf(rawName)

  const isRunning = status === "running"
  const isError = status === "error"
  const muted = isError

  // 状态字：running / success **不显示**（跑完是常态，不值得占一个词）。
  // 只有等待中与失败/取消要说出来 —— 参考实现同口径。
  const statusLabel = isError
    ? t("stream.toolError")
    : status === "pending"
      ? t("stream.toolPending")
      : ""

  const hasDetail = item.content.length > 0 && !DETAIL_SUPPRESSED.has(rawName)

  // 终态图标覆盖动作图标：失败/取消本身就是要传达的信息。
  const Icon = isError ? CircleXIcon : status === "pending" ? BanIcon : toolIconOf(action)

  const heading = (
    <>
      {isRunning ? (
        <>
          <ShinyText
            text={titleText}
            className={cn(
              "typography-body-small-400 min-w-0 break-words",
              isIdentifierLike(titleText) && "font-mono-token",
            )}
          />
          {/* 屏幕阅读器需要知道它在跑（流光是纯视觉的） */}
          <span className="sr-only">{t("stream.toolRunning")}</span>
        </>
      ) : (
        <span
          className={cn(
            "typography-body-small-400 min-w-0 break-words",
            isIdentifierLike(titleText) && "font-mono-token",
            muted ? "text-[var(--text-base-tertiary)]" : "text-[var(--text-base-secondary)]",
          )}
        >
          {titleText}
        </span>
      )}

      {statusLabel !== "" && (
        <span
          className={cn(
            "typography-caption-400 shrink-0",
            muted ? "text-[var(--text-base-tertiary)]" : "text-[var(--text-base-secondary)]",
          )}
        >
          {statusLabel}
        </span>
      )}

      {hasDetail && (
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 self-center text-[var(--text-base-disable)]",
            "transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
            // 常态隐形、hover/focus 才显形 —— 这是"可展开"的提示，不是装饰。
            expanded
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            !expanded && "-rotate-90",
          )}
        />
      )}
    </>
  )

  return (
    <div
      data-tool-row=""
      data-tool-action={action}
      aria-busy={isRunning ? true : undefined}
      className="group flex w-full items-start gap-[var(--gap-component-md)] py-[var(--spacing-xs)] text-left"
    >
      {/*
        图标与标题的垂直对齐。

        ★ 关键：给图标一个**和标题行等高的盒子**（`h-5` = 20px = 标题的
        line-height），让 `items-center` 在这个盒子里居中 14px 的图形。

        为什么不是 `mt-px` 之类的微调（我先写的就是那版，实测偏 2px）：
        标题是 13px 字 / 20px 行高的**行盒**，它的视觉中心在行盒中央；
        而裸图标只有 14px 高，顶对齐时两者中心天然差 (20-14)/2 = 3px。
        用 margin 去补是在猜一个具体数字 —— 换字号/行高就又错，
        而且外层 `items-baseline` 让基线参与计算后，那个数字还不是 3。

        等高盒子把"对齐"变成结构事实：两个 20px 的盒子并排、各自内部居中，
        必然对齐，与字号无关（改 typography 档位也不用回来调）。
      */}
      <span
        aria-hidden="true"
        className={cn(
          "flex h-5 shrink-0 items-center justify-center",
          muted ? "text-[var(--text-base-disable)]" : "text-[var(--text-base-tertiary)]",
        )}
      >
        <Icon className="size-3.5 shrink-0" />
      </span>

      <div className="flex min-w-0 flex-1 flex-col">
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className={cn(
              "flex min-w-0 flex-wrap items-baseline gap-x-[var(--gap-component-md)] gap-y-px",
              "rounded-[var(--radius-sm)] text-left outline-none",
              "focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
            )}
          >
            {heading}
          </button>
        ) : (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--gap-component-md)] gap-y-px">
            {heading}
          </div>
        )}

        {hasDetail && expanded && (
          <div className="flex min-w-0 flex-col gap-[var(--gap-component-xxs)] pt-[var(--spacing-xs)]">
            <div className="typography-caption-400 min-w-0 whitespace-pre-wrap break-words text-[var(--text-base-tertiary)]">
              <Blocks blocks={item.content} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 用户的提问：右侧气泡。
 *
 * 移植参考实现 `Request` 原子的形状：`w-fit`（内容窄就窄、宽到 max-w 才换行）、
 * **异形圆角 12/12/4/12**（右下角收紧成 4px —— 气泡"指向"发送者那侧，
 * 是 IM 的基本语言）、`px-3 py-2`、15px/24px 行高、`whitespace-pre-wrap`。
 *
 * ★ 底色用 `--bg-card-accent`（品牌色 10% alpha 薄底）而**不是**
 * `--bg-brand-panel`：后者在**两个**主题下都是深蓝（亮色 `#0d1a3f`），
 * 配 `--text-base-primary`（亮色 `#141414`）实测对比度 **1.08:1** —— 字直接
 * 消失。那个 token 是给登录页"整块深色面板配 inverted 文字"用的，不是气泡底。
 * 现在三套主题色 × 明暗最差 13.2:1，全部过 AA。
 */
function UserMessage({ item }: { item: ChatItem }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "w-fit min-w-0 max-w-[80%] whitespace-pre-wrap break-words",
          "bg-[var(--bg-card-accent)] text-[var(--text-base-primary)]",
          // 异形圆角：右下角 4px，其余 12px
          "rounded-[var(--radius-xl)] rounded-br-[var(--spacing-xs)]",
          "px-[var(--spacing-lg)] py-[var(--spacing-md)]",
          "typography-body-reading-400",
        )}
      >
        <Blocks blocks={item.content} />
      </div>
    </div>
  )
}

/**
 * assistant 答案：视觉重心。
 * 左对齐、无气泡、最高对比度正文 —— 答案该是页面上最"实"的东西。
 */
function AssistantMessage({
  item,
  onCitationClick,
}: {
  item: ChatItem
  onCitationClick?: ((ordinal: number) => void) | undefined
}) {
  return (
    <div className="typography-body-reading-400 break-words text-[var(--text-base-primary)]">
      <Blocks blocks={item.content} onCitationClick={onCitationClick} markdown />
    </div>
  )
}

/** 思考过程：默认折叠，与工具组同一套"纯文本头 + chevron"语言。 */
function ThoughtRow({ item }: { item: ChatItem }) {
  const { t } = useDynamicTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-[var(--gap-component-xs)]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          "typography-body-small-400 flex items-center gap-[var(--gap-component-sm)] self-start",
          "-mx-[var(--spacing-sm)] rounded-[var(--radius-sm)] px-[var(--spacing-sm)] py-[var(--spacing-xxs)]",
          "text-[var(--text-base-tertiary)] transition-colors duration-150",
          "hover:bg-[var(--overlay-on-container-hover)] hover:text-[var(--text-base-secondary)]",
          "focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
        )}
      >
        {t("stream.thoughtToggle")}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
      </button>
      <div
        aria-hidden={!open}
        inert={open ? undefined : true}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="typography-body-small-400 whitespace-pre-wrap break-words border-l border-[var(--border-light)] pl-[var(--spacing-lg)] leading-relaxed text-[var(--text-base-tertiary)]">
            <Blocks blocks={item.content} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** 计划：小标题 + 缩进正文，无底色（有底色的方块会比答案先被看到）。 */
function PlanRow({ item }: { item: ChatItem }) {
  const { t } = useDynamicTranslation()
  return (
    <div className="flex flex-col gap-[var(--gap-component-xxs)]">
      <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("stream.planTitle")}
      </span>
      <div className="typography-body-small-400 whitespace-pre-wrap break-words pl-[var(--spacing-lg)] text-[var(--text-base-secondary)]">
        <Blocks blocks={item.content} />
      </div>
    </div>
  )
}

/**
 * 错误：低饱和的容器色 + 图标。
 *
 * 用 `--status-fill-error-container`（10% alpha）而不是实心红：错误要能被看见，
 * 但一块饱和红会盖过它上面的答案。
 */
function ErrorRow({ item }: { item: ChatItem }) {
  return (
    <div
      role="alert"
      className={cn(
        "typography-body-small-400 flex w-fit max-w-full items-start gap-[var(--gap-component-md)]",
        "rounded-[var(--radius-lg)] bg-[var(--status-fill-error-container)]",
        "px-[var(--spacing-lg)] py-[var(--spacing-md)] text-[var(--status-error)]",
      )}
    >
      <CircleXIcon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 whitespace-pre-wrap break-words">
        <Blocks blocks={item.content} />
      </div>
    </div>
  )
}

function Blocks({
  blocks,
  onCitationClick,
  markdown = false,
}: {
  blocks: readonly UnifiedContentBlock[]
  onCitationClick?: ((ordinal: number) => void) | undefined
  /**
   * 文本块按 Markdown 渲染。只给 assistant 答案开 —— 用户的提问是纯文本
   * （他打的 `*` 就是 `*`，不该被解释成斜体），工具输出是命令 dump
   * （里面的 `#`/`-` 全是 shell 语法，走 markdown 会被吃掉）。
   */
  markdown?: boolean
}) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "text") {
          if (!markdown) return <span key={index}>{block.text}</span>
          const text = stripNoise(block.text)
          return text === "" ? null : <MarkdownBody key={index} text={text} />
        }
        if (block.kind === "code") {
          /**
           * 代码块底色用 `--bg-card-z0`（半透明叠加）而不是 `--bg-base-normal`：
           * 后者**就是页面底色**，代码块会完全看不出边界。
           */
          return (
            <pre
              key={index}
              className="typography-body-small-400 font-mono-token my-[var(--spacing-md)] overflow-auto rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] p-[var(--spacing-lg)] leading-relaxed"
            >
              <code>{block.code}</code>
            </pre>
          )
        }
        // 引用：上标小标签，点开来源抽屉并跳回原始消息。
        return (
          <button
            key={index}
            type="button"
            title={block.label}
            onClick={() => onCitationClick?.(block.ordinal)}
            className={cn(
              "mx-0.5 inline-flex min-w-[15px] items-center justify-center align-super",
              "rounded-[var(--radius-sm)] bg-[var(--status-fill-info-container)] px-1",
              "typography-caption-400 tabular-nums text-[var(--status-link)]",
              "transition-colors duration-150 hover:underline",
              "focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
            )}
          >
            {block.ordinal}
          </button>
        )
      })}
    </>
  )
}
