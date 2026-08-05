/**
 * 侧边栏导航项。
 *
 * 样式对齐参考设计系统的侧栏菜单项：`radius-lg` + `p-1 pl-1.5`（而不是固定 h-8 + px-2），
 * 左侧图标容器 24×24（16px 图标 + 4px 内边距），文字行高 20px。
 * 这套尺寸让「图标 / 文字 / 右侧徽标」三段各有独立的内边距与命中区，
 * 后续加菜单项操作（重命名、删除之类）时不用重排布局。
 *
 * 选中态用**中性加深底色**而非品牌色：侧栏里同时存在多种状态
 * （选中、hover、将来的拖拽目标），品牌色一上来就把最强的视觉权重给了「选中」，
 * 之后没有更强的颜色可用。参考实现也是这个取舍。
 *
 * 未开放的模块仍然可点：点进去在内容区说明「为什么还没有、何时会有」，
 * 比直接禁用更能传达路线图。视觉上用 Tag 提前告知，避免点击落空的意外感。
 */
import type { ReactNode } from "react"
import { Tag, cn } from "@mycontext/design"

export interface SidebarNavItemProps {
  label: string
  icon: ReactNode
  active?: boolean
  /** 右侧徽标文案，如「暂未开放」 */
  badge?: string | undefined
  onClick?: () => void
}

export function SidebarNavItem({
  label,
  icon,
  active = false,
  badge,
  onClick,
}: SidebarNavItemProps) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "group flex w-full min-w-0 cursor-pointer select-none items-center",
        "radius-lg p-1 pl-1.5 text-left outline-none",
        "transition-colors duration-150",
        active
          ? "bg-[var(--overlay-on-container-pressed)] text-[var(--text-base-primary)]"
          : cn(
              "text-[var(--text-base-secondary)]",
              "hover:bg-[var(--overlay-on-container-hover)] hover:text-[var(--text-base-primary)]",
            ),
      )}
    >
      {/* 图标容器：4px 内边距 + 16px 图标 = 24px，与文字容器等高 */}
      <span className="flex shrink-0 items-center justify-center p-1 [&_svg]:size-4">{icon}</span>
      <span className="typography-body-small-400 flex h-6 min-w-0 flex-1 items-center truncate px-1 leading-5">
        {label}
      </span>
      {badge === undefined ? null : (
        <Tag size="sm" status={active ? "default" : "disabled"} className="mr-0.5">
          {badge}
        </Tag>
      )}
    </button>
  )
}
