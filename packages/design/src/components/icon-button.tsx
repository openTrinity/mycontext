/**
 * IconButton — 纯图标按钮。
 *
 * label 必填并映射到 aria-label：图标按钮没有可读文本，缺了它对读屏用户等于空按钮。
 * title 默认取 label，也可单独传入更详细的悬浮说明。
 *
 * 交互态与设计系统一致：
 * - transparent（默认）：无底色，hover / pressed 用 overlay-on-container 叠加
 * - ghost：常态就带浅底，用于需要「看得见是个按钮」的场景
 * - 过渡只针对颜色相关属性并显式声明 duration/easing，避免 transition-all 带来的抖动
 * - focus-visible 给 2px 品牌色 ring：键盘操作可见，鼠标点击不出现
 */
import { forwardRef } from "react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { cn } from "../lib/cn.js"

export type IconButtonSize = "sm" | "md" | "lg"
export type IconButtonVariant = "transparent" | "ghost"

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  children: ReactNode
  size?: IconButtonSize
  variant?: IconButtonVariant
  /** 选中态（如侧边栏当前项） */
  active?: boolean
}

const SIZES: Record<IconButtonSize, string> = {
  sm: "size-6 radius-sm",
  md: "size-8 radius-md",
  lg: "size-9 radius-lg",
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    children,
    size = "md",
    variant = "transparent",
    active = false,
    className,
    title,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={title ?? label}
      aria-pressed={active}
      className={cn(
        "box-border inline-flex shrink-0 items-center justify-center border border-transparent",
        "transition-[color,background-color,border-color,box-shadow] duration-200 ease-out",
        "motion-reduce:transition-none",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
        "disabled:cursor-not-allowed",
        SIZES[size],
        active
          ? "bg-[var(--overlay-on-container-selected)] text-[var(--text-accent-normal)]"
          : cn(
              variant === "ghost"
                ? "bg-[var(--control-ghost-button-default)] text-[var(--text-base-primary)]"
                : "bg-transparent text-[var(--text-base-secondary)]",
              "cursor-pointer",
              "hover:bg-[var(--overlay-on-container-hover)] hover:text-[var(--text-base-primary)]",
              "active:bg-[var(--overlay-on-container-pressed)]",
            ),
        "disabled:bg-transparent disabled:text-[var(--text-base-disable)] disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
})
