/**
 * AppHeader — 内容区顶栏（48px）。
 *
 * 布局对齐参考设计系统的 page-header：
 *   [交通灯让位] [侧栏折叠按钮（仅收起态）] [标题] ………… [右侧操作区]
 *
 * 三个细节让它「不像随手写的」：
 * 1. 整条是窗口拖动区，但内部可交互元素用 data-no-drag 退出——
 *    否则按钮点不动、标题无法双击最大化。
 * 2. 底部分隔线只在内容滚动后出现（showDivider），静止时顶栏与内容融为一体。
 * 3. 收起态才渲染折叠按钮；标题左侧留白随之变化，用 transition 平滑过渡。
 */
import { cn } from "@mycontext/design"
import type { ReactNode } from "react"
import { useTrafficLightPadding } from "../../lib/use-traffic-light-padding.js"

export interface AppHeaderProps {
  title: string
  /** 侧栏是否占据窗口左上角（固定展开时为 true，交通灯由侧栏让位） */
  sidebarOccupiesTopLeft: boolean
  /** 折叠按钮，仅在侧栏收起时传入 */
  toggle?: ReactNode
  /** 内容已滚动时显示底部分隔线 */
  showDivider?: boolean
  /** 右侧操作区 */
  actions?: ReactNode
}

export function AppHeader({
  title,
  sidebarOccupiesTopLeft,
  toggle,
  showDivider = false,
  actions,
}: AppHeaderProps) {
  const { paddingLeft } = useTrafficLightPadding(sidebarOccupiesTopLeft)

  return (
    <header
      data-window-drag
      className={cn(
        "flex h-12 shrink-0 items-center gap-1 border-b pr-2.5",
        "transition-[border-color,padding] duration-200 ease-out motion-reduce:transition-none",
        showDivider ? "border-[var(--border-divider-light)]" : "border-transparent",
      )}
      style={{ paddingLeft: paddingLeft + 8 }}
    >
      {toggle === undefined ? null : (
        <span data-no-drag className="inline-flex">
          {toggle}
        </span>
      )}

      {/*
        标题：pointer-events-none 让它不吃掉拖动——顶栏空白区要能拖动窗口，
        标题本身没有交互需求。

        ★ `pl-6` 是**算出来的**，不是挑好看的：让「标题左缘」与
        「内容区左缘」落在同一条线上。

        两边各自的构成（都以 `main` 的左缘为基准）：
        · 标题  = header 的 `paddingLeft`(0，侧栏展开时) + 8 + 本行 `pl-6`(24) = 32
        · 内容  = 内容区的 `px-8`                                           = 32

        原来本行是 `px-2`(8) → 标题落在 16，而内容在 `p-6` 的 24 ——
        实测 x=244 vs 252，差 8px。整页因此没有一条共同的左基线，
        那是"看着割裂"里最难指名道姓却最持续的一条。

        ⚠️ 改内容区的 `px-8` 时**这里要一起改**，两个数是一对。
        ⚠️ 侧栏**收起**时 `toggle` 会占掉左边一格，那时标题本来就该缩进
        （它右边有个按钮），不参与这条对齐。
      */}
      <h1
        className={cn(
          "typography-body-base-500 pointer-events-none min-w-0 flex-1 truncate pl-6 pr-2",
          "text-[var(--text-base-primary)]",
        )}
      >
        {title}
      </h1>

      {actions === undefined ? null : (
        <span data-no-drag className="flex shrink-0 items-center gap-1">
          {actions}
        </span>
      )}
    </header>
  )
}
