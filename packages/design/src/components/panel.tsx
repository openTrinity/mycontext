/**
 * Panel — 一块承载内容的**面**（卡 / 卡内凹槽 / 只要内边距的裸块）。
 *
 * ## ★★ 为什么需要它：容器是手抄的，共 5 处一模一样的类串
 *
 * 这个仓库里没有任何一处定义过"一张卡长什么样"。
 * `facts-explorer.tsx`、`ego-graph-panel.tsx`（×3）、`identity.tsx`、
 * `primitives.tsx`、`step-section.tsx` 各写了一份：
 *
 *     rounded-[var(--radius-lg)] bg-[var(--bg-card-z1)] ring-1 ring-[var(--border-divider-light)] p-4
 *
 * 手抄的东西必然漂移，而漂移在用户侧的观感就是**割裂** ——
 * 「还是很怪，整体设计能不能和谐点，不要有很割裂的感觉」说的正是这个。
 *
 * 量到的两处后果（在运行中的应用里量的，不是审美判断）：
 *
 * 1. **同色套同色**：仪表盘的分身卡是 `rgb(38,38,38)`，它**里面**四个
 *    数字卡也是 `rgb(38,38,38)` —— 零色阶差，四个框只靠 1px 描边浮在
 *    同色底上。而 `step-section.tsx` 的注释里早写过这条规则
 *    （「分区已经有边界了，里面再套卡片会变成'框里的框'」），
 *    只是没有一个地方**执行**它；
 * 2. **两种写法差 1px**：引导第 1 步（`channel-auth-panel.tsx`）用
 *    `border`，第 2/3/4 步用 `ring`。两者圆角值相同
 *    （`radius-lg` 与 `rounded-[var(--radius-lg)]` 都只是 10px 的
 *    `border-radius`；`corner-shape: squircle` 只挂在 `.corner-squircle` 上，
 *    卡片没用它），所以差别**只**在描边占不占布局：
 *    border 让内容窄 1px、外缘宽 1px。相邻两步的卡因此对不齐。
 *
 * ## ★ `sunken` 是这里最重要的一档
 *
 * `--bg-card-z0` 在暗色下是 `rgba(255,255,255,0.06)`、亮色下是
 * `rgba(20,20,20,0.04)` —— 都是**半透明**的。所以它叠在暗底上自动变亮、
 * 叠在亮底上自动变暗，两套主题下都天然是"比父级更靠内的一层"。
 *
 * 于是层级靠**色阶**表达，而不是再套一圈描边。这也是为什么 `sunken`
 * **没有** ring：它已经与父级分开了，再加描边就是同一件事说两遍。
 *
 * ## ★ 内边距必须可关（`pad="none"`）
 *
 * 不是"为了灵活而灵活" —— 三处真实需求已经在那儿了：
 * ego 图的画布必须齐边（给 16px 内边距会在图周围留一圈死区）、
 * 邻居列表要 `p-2`（行的 hover 底色要贴近边）、空态占位不需要内边距。
 * 写死 `p-4` 会逼调用方在外面覆盖，于是又变回手抄。
 *
 * ## 为什么住在 `packages/design` 而不是某个 feature 里
 *
 * 引导页（`step-section.tsx`）、图谱（`facts-explorer.tsx`）、仪表盘
 * 三处都要用。跨 feature 的东西放进其中一个 feature，另外两个就要
 * 反向 import —— 那是下一次漂移的起点。
 */
import type { ElementType, ReactNode } from "react"
import { cn } from "../lib/cn.js"

/**
 * 面的层级。
 *
 * ★ 这是**容器层级**，与"数值语气"（good/warn/bad）是两个维度。
 * 调用方那边不要共用一个 prop 名去传两者 —— `StatTile` 就同时有
 * `tone`（语气）与 `surface`（层级），混成一个会让两个概念纠缠。
 */
export type PanelTone = "raised" | "sunken" | "flat"

/**
 * 内边距档位。
 *
 * `none` 给必须齐边的内容（画布、图片）；`sm`/`md` 是列表项与卡片的两档。
 * ★ 这几档是**照现有用法定的**，不是先设计再套：
 * `md`(16) 是卡片的默认，`ms`(12) 是列表项（事实行），`sm`(8) 是密集列表
 * （邻居栏，行的 hover 底色要贴边），`none`(0) 是画布。
 */
export type PanelPad = "md" | "ms" | "sm" | "none"

const TONE: Record<PanelTone, string> = {
  // 一张卡：抬起一层 + 一圈发丝描边
  raised: "bg-[var(--bg-card-z1)] ring-1 ring-[var(--border-divider-light)]",
  // 卡**内部**的凹槽：只靠色阶下沉，不要描边（见文件头）
  sunken: "bg-[var(--bg-card-z0)]",
  // 只要圆角与内边距（分组用，不额外引入一个面）
  flat: "",
}

const PAD: Record<PanelPad, string> = {
  md: "p-4",
  ms: "p-3",
  sm: "p-2",
  none: "",
}

export interface PanelProps {
  tone?: PanelTone
  pad?: PanelPad
  /**
   * 渲染成什么标签。默认 `div`。
   *
   * 语义上是一个独立分区时传 `"section"` —— 读屏器的分区导航靠它。
   */
  as?: ElementType
  className?: string
  children: ReactNode
}

export function Panel({
  tone = "raised",
  pad = "md",
  as: Tag = "div",
  className,
  children,
}: PanelProps) {
  return (
    <Tag className={cn("rounded-[var(--radius-lg)]", TONE[tone], PAD[pad], className)}>
      {children}
    </Tag>
  )
}

export interface PanelHeaderProps {
  title: ReactNode
  /** 一句说明。缺省时不占位（不是渲染一个空行） */
  hint?: ReactNode
  /** 右上角的动作区（按钮、计数 + 清空之类） */
  action?: ReactNode
}

/**
 * 面的标题行：标题 + 一句说明 + 右上角动作。
 *
 * ## ★ 标题用 `body-base-500`，不是 heading 号
 *
 * 这是**面内部**的标题，不是页面标题 —— 用 heading 号会与页头
 * （`AppHeader` 的 h1、引导页的步骤条）的层级打架。
 * 比正文重一档就够把"这一块叫什么"与"这一块的内容"分开。
 *
 * ★ `items-start` 而不是 `items-center`：`hint` 让左侧变两行高，
 * 居中会把右上角那个动作按钮拽到两行的中间 —— 它该跟着**标题**那一行。
 */
export function PanelHeader({ title, hint, action }: PanelHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="flex min-w-0 flex-col">
        <span className="typography-body-base-500 text-[var(--text-base-primary)]">{title}</span>
        {hint === undefined ? null : (
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{hint}</span>
        )}
      </span>
      {action === undefined ? null : <span className="shrink-0">{action}</span>}
    </div>
  )
}
