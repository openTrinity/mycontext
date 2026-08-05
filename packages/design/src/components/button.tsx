/**
 * Button — 基础按钮
 *
 * 设计规范（与设计系统尺寸阶梯对齐）：
 * - Size: xs 24px (2px 6px, radius 6px) | sm 28px (4px 8px, radius 8px)
 *         | md 32px (6px 10px, radius 8px) | lg 36px (8px 12px, radius 10px)
 * - Variant: primary | secondary | ghost | danger
 * - 字重：primary 用 Medium(500)，其余用 Regular(400)
 * - 左侧图标 16px，右侧图标 14px
 *
 * 圆角实现：无描边变体（primary/ghost/danger）用 clip-path 超椭圆；
 * secondary 依赖 border 视觉，不启用 clip-path 以免裁掉描边。
 */
import { forwardRef } from "react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { cn } from "../lib/cn.js"
import { attachRefs, useSquircle } from "../lib/use-squircle.js"

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"
export type ButtonSize = "xs" | "sm" | "md" | "lg"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  prefixIcon?: ReactNode
  suffixIcon?: ReactNode
  /** 撑满父容器宽度 */
  block?: boolean
  loading?: boolean
  children?: ReactNode
}

const SIZES: Record<ButtonSize, { frame: string; text: string; radius: number }> = {
  xs: { frame: "h-6 px-1.5 gap-1", text: "text-[12px] leading-[18px]", radius: 6 },
  sm: { frame: "h-7 px-2 gap-1", text: "text-[13px] leading-5", radius: 8 },
  md: { frame: "h-8 px-2.5 gap-1.5", text: "text-sm leading-[22px]", radius: 8 },
  lg: { frame: "h-9 px-3 gap-1.5", text: "text-sm leading-[22px]", radius: 10 },
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: cn(
    "bg-[var(--control-core-button-default)] text-[var(--theme-white-white-100)] font-medium",
    "hover:bg-[var(--control-core-button-hover)] active:bg-[var(--control-core-button-active)]",
    "disabled:bg-[var(--control-core-button-disabled)] disabled:text-[var(--text-base-disable)]",
  ),
  secondary: cn(
    "bg-transparent text-[var(--text-base-primary)] border border-[var(--border-medium)]",
    "hover:bg-[var(--control-ghost-button-default)]",
    "disabled:text-[var(--text-base-disable)] disabled:border-[var(--border-light)]",
  ),
  ghost: cn(
    "bg-[var(--control-ghost-button-default)] text-[var(--text-base-primary)]",
    "hover:bg-[var(--control-ghost-button-hover)]",
    "disabled:bg-[var(--control-ghost-button-disabled)] disabled:text-[var(--text-base-disable)]",
  ),
  danger: cn(
    "bg-[var(--status-error)] text-[var(--theme-white-white-100)] font-medium",
    "hover:opacity-90",
    "disabled:bg-[var(--status-fill-error-container)] disabled:text-[var(--text-base-disable)]",
  ),
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    prefixIcon,
    suffixIcon,
    block = false,
    loading = false,
    disabled,
    className,
    children,
    ...props
  },
  ref,
) {
  const config = SIZES[size]
  // secondary 依赖描边，clip-path 会把 1px border 裁掉，故不启用。
  const squircle = useSquircle<HTMLButtonElement>({
    radius: config.radius,
    enabled: variant !== "secondary",
  })

  return (
    <button
      ref={attachRefs(ref, squircle.ref)}
      disabled={disabled === true || loading}
      style={squircle.clipPath === undefined ? undefined : { clipPath: squircle.clipPath }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap",
        "cursor-pointer select-none transition-colors duration-150",
        "disabled:cursor-not-allowed",
        config.frame,
        config.text,
        variant === "secondary" && "rounded-lg",
        VARIANTS[variant],
        block && "w-full",
        className,
      )}
      {...props}
    >
      {loading ? (
        <Spinner />
      ) : prefixIcon ? (
        <span className="flex size-4 items-center justify-center">{prefixIcon}</span>
      ) : null}
      {children === undefined ? null : <span className="px-1">{children}</span>}
      {suffixIcon === undefined ? null : (
        <span className="flex size-[14px] items-center justify-center">{suffixIcon}</span>
      )}
    </button>
  )
})

function Spinner() {
  return (
    <svg className="size-4 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
