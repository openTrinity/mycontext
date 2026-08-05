/**
 * SidebarResizer — 侧栏右缘拖拽调宽手柄。
 *
 * 命中区 5px（视觉 1px 竖线，hover/拖拽时才显色）：太窄会让用户难以抓住，
 * 太宽会挡到侧栏内容的点击。
 *
 * 用 Pointer Events 而非 mouse：pointer 自带 setPointerCapture，
 * 鼠标拖出窗口再松开也能正确收到 pointerup，不会出现「松手了还在跟随」。
 */
import { useCallback, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@mycontext/design"

export interface SidebarResizerProps {
  width: number
  onWidthChange: (width: number) => void
}

export function SidebarResizer({ width, onWidthChange }: SidebarResizerProps) {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const origin = useRef({ x: 0, width: 0 })

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      origin.current = { x: event.clientX, width }
      setDragging(true)
      // 拖拽期间锁定全局光标与文本选择：否则划过内容区会选中文字、光标乱跳。
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
    },
    [width],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return
      onWidthChange(origin.current.width + (event.clientX - origin.current.x))
    },
    [dragging, onWidthChange],
  )

  const endDrag = useCallback(() => {
    if (!dragging) return
    setDragging(false)
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
  }, [dragging])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("sidebar.resize")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="group absolute inset-y-0 right-0 z-10 w-[5px] cursor-col-resize"
    >
      <div
        className={cn(
          "absolute inset-y-0 right-0 w-px transition-colors duration-150",
          dragging
            ? "bg-[var(--border-focus)]"
            : "bg-transparent group-hover:bg-[var(--border-focus)]",
        )}
      />
    </div>
  )
}
