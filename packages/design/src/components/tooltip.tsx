/**
 * Tooltip — 轻量悬浮提示。
 *
 * 只做本仓库需要的部分：hover/focus 触发、四向定位、可选快捷键徽标、
 * 越界自动翻转。不引 floating-ui：一个提示框拖进定位引擎不值得，
 * 而 title 属性又太慢（系统级延迟约 1s）且不能自定义样式。
 *
 * 定位用 fixed + 实测坐标而不是 absolute：祖先若有 overflow:hidden
 * （侧栏、顶栏都有）会把 absolute 的提示裁掉。
 */
import { cloneElement, useCallback, useId, useLayoutEffect, useRef, useState } from "react"
import type { ReactElement, ReactNode } from "react"
import { cn } from "../lib/cn.js"

export type TooltipPlacement = "top" | "bottom" | "left" | "right"

export interface TooltipProps {
  content: ReactNode
  /** 右侧显示的快捷键，如 "⌘ B" */
  shortcut?: string
  placement?: TooltipPlacement
  /** 显示延迟（ms）：避免鼠标扫过时闪现一串提示 */
  delay?: number
  children: ReactElement<{
    onMouseEnter?: (event: unknown) => void
    onMouseLeave?: (event: unknown) => void
    onFocus?: (event: unknown) => void
    onBlur?: (event: unknown) => void
    ref?: unknown
  }>
}

const GAP = 8

export function Tooltip({
  content,
  shortcut,
  placement = "bottom",
  delay = 320,
  children,
}: TooltipProps) {
  const id = useId()
  const anchorRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const show = useCallback(() => {
    clear()
    timer.current = setTimeout(() => setOpen(true), delay)
  }, [clear, delay])

  const hide = useCallback(() => {
    clear()
    setOpen(false)
    setPos(null)
  }, [clear])

  // 用 layout effect 在绘制前定位，避免提示先出现在左上角再跳到目标位置。
  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    const tip = tipRef.current
    if (!anchor || !tip) return

    const a = anchor.getBoundingClientRect()
    const t = tip.getBoundingClientRect()

    const candidates: Record<TooltipPlacement, { top: number; left: number }> = {
      bottom: { top: a.bottom + GAP, left: a.left + a.width / 2 - t.width / 2 },
      top: { top: a.top - t.height - GAP, left: a.left + a.width / 2 - t.width / 2 },
      right: { top: a.top + a.height / 2 - t.height / 2, left: a.right + GAP },
      left: { top: a.top + a.height / 2 - t.height / 2, left: a.left - t.width - GAP },
    }

    const fits = (p: { top: number; left: number }) =>
      p.top >= 0 &&
      p.left >= 0 &&
      p.top + t.height <= window.innerHeight &&
      p.left + t.width <= window.innerWidth

    // 首选方向放不下时按 bottom→top→right→left 顺序找一个能放下的。
    const order: TooltipPlacement[] = [placement, "bottom", "top", "right", "left"]
    const chosen = order.map((key) => candidates[key]).find(fits) ?? candidates[placement]

    setPos({
      top: Math.round(chosen.top),
      left: Math.round(Math.max(4, Math.min(chosen.left, window.innerWidth - t.width - 4))),
    })
  }, [open, placement])

  const child = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node
      const { ref } = children as unknown as { ref?: unknown }
      if (typeof ref === "function") (ref as (n: HTMLElement | null) => void)(node)
      else if (ref !== null && typeof ref === "object") {
        ;(ref as { current: HTMLElement | null }).current = node
      }
    },
    onMouseEnter: (event: unknown) => {
      children.props.onMouseEnter?.(event)
      show()
    },
    onMouseLeave: (event: unknown) => {
      children.props.onMouseLeave?.(event)
      hide()
    },
    onFocus: (event: unknown) => {
      children.props.onFocus?.(event)
      show()
    },
    onBlur: (event: unknown) => {
      children.props.onBlur?.(event)
      hide()
    },
  })

  return (
    <>
      {child}
      {open ? (
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className={cn(
            "pointer-events-none fixed z-[200] flex items-center gap-1.5",
            "radius-md bg-[var(--bg-tooltip)] px-2 py-1 shadow-[var(--shadow-md)]",
            "typography-caption-400 whitespace-nowrap text-[var(--text-tooltip)]",
            // 未定位完成前不可见，避免闪一下左上角
            pos === null ? "opacity-0" : "opacity-100",
          )}
          style={pos === null ? { top: 0, left: 0 } : pos}
        >
          <span>{content}</span>
          {shortcut === undefined ? null : (
            <span className="radius-sm bg-[var(--overlay-on-tooltip)] px-1 py-px font-mono-token text-[11px]">
              {shortcut}
            </span>
          )}
        </div>
      ) : null}
    </>
  )
}
