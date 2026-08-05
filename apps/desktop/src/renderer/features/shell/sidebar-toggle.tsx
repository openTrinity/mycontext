/**
 * SidebarToggle — 侧栏折叠 / 展开按钮。
 *
 * 同一个组件放两处：
 *   - 顶栏（收起时可见）：hover 触发浮层预览，点击固定展开
 *   - 侧栏 System-bar（固定展开时可见）：点击收起
 *
 * hover 触发只挂在这个按钮上，不做「屏幕左缘热区」：热区容易在用户
 * 拖窗口、划过左边界时误触发，浮层反复闪烁比少一个入口更烦人。
 *
 * data-no-drag 必需：本组件常位于 data-window-drag 内，
 * 而拖拽区里的鼠标事件由系统窗口管理器接管，会让 mouseenter/mouseleave
 * 乱序抖动（表现为浮层反复闪烁、点击失效）。
 */
import { useTranslation } from "react-i18next"
import { IconButton, Tooltip } from "@mycontext/design"
import { SidebarHideIcon, SidebarShowIcon } from "./icons.js"

export interface SidebarToggleProps {
  collapsed: boolean
  floating: boolean
  onToggle: () => void
  onPin: () => void
  onHoverStart: () => void
  /** 鼠标离开：只解除抑制，不关闭浮层（浮层展开后可能盖住本按钮） */
  onHoverEnd: () => void
}

export function SidebarToggle({
  collapsed,
  floating,
  onToggle,
  onPin,
  onHoverStart,
  onHoverEnd,
}: SidebarToggleProps) {
  const { t } = useTranslation()
  const label = t(
    collapsed && !floating ? "sidebar.expand" : floating ? "sidebar.pin" : "sidebar.collapse",
  )
  const hint = t(
    floating ? "sidebar.pinHint" : collapsed ? "sidebar.expandHint" : "sidebar.collapse",
  )

  return (
    <Tooltip content={hint} placement="bottom">
      <span
        data-no-drag
        className="inline-flex"
        // 收起态才需要 hover 预览；展开态 hover 无意义。
        onMouseEnter={collapsed ? onHoverStart : undefined}
        onMouseLeave={collapsed ? onHoverEnd : undefined}
      >
        <IconButton label={label} size="md" onClick={floating ? onPin : onToggle}>
          {collapsed && !floating ? <SidebarShowIcon /> : <SidebarHideIcon />}
        </IconButton>
      </span>
    </Tooltip>
  )
}
