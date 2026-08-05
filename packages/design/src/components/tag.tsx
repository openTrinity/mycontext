/**
 * Tag — 胶囊标签。
 *
 * 用于状态、分类与轻量信息标记（「暂未开放」「Beta」这类）。
 * 三档高度严格对应 16 / 20 / 24px，与参考设计系统一致。
 *
 * 圆角走 rounded-full 而不是 token：胶囊形状由高度决定，
 * 换 radius token 会让它在不同尺寸下看起来不是同一个东西。
 */
import type { HTMLAttributes } from "react"
import { cn } from "../lib/cn.js"

export type TagSize = "sm" | "md" | "lg"

export type TagStatus = "default" | "disabled" | "accent" | "success" | "warning" | "error"

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  /** 高度：sm 16px、md 20px、lg 24px */
  size?: TagSize
  status?: TagStatus
  /** 左侧圆点，颜色跟随当前状态色 */
  showIndicator?: boolean
}

const SIZE: Record<TagSize, string> = {
  sm: "h-4 gap-[var(--gap-component-xs)] px-[var(--spacing-sm)] py-px typography-caption-400",
  md: "h-5 gap-[var(--gap-component-xs)] px-[var(--gap-component-md)] typography-caption-400",
  lg: "h-6 gap-[var(--gap-component-xs)] px-[var(--gap-component-lg)] typography-body-small-400",
}

const STATUS: Record<TagStatus, string> = {
  default: "bg-[var(--overlay-on-container-pressed)] text-[var(--text-base-secondary)]",
  disabled: "bg-[var(--overlay-on-container-hover)] text-[var(--text-base-disable)]",
  accent: "bg-[var(--status-fill-info-container)] text-[var(--status-link)]",
  success: "bg-[var(--status-fill-success-container)] text-[var(--status-success)]",
  warning: "bg-[var(--status-fill-warning-container)] text-[var(--status-warning)]",
  error: "bg-[var(--status-fill-error-container)] text-[var(--status-error)]",
}

const INDICATOR: Record<TagSize, string> = {
  sm: "before:size-[var(--gap-component-xs)]",
  md: "before:size-[var(--gap-component-sm)]",
  lg: "before:size-[var(--gap-component-sm)]",
}

export function Tag({
  className,
  size = "md",
  status = "default",
  showIndicator = false,
  children,
  ...props
}: TagProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full",
        SIZE[size],
        STATUS[status],
        showIndicator && "before:block before:shrink-0 before:rounded-full before:bg-current",
        showIndicator && "before:content-['']",
        showIndicator && INDICATOR[size],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}
