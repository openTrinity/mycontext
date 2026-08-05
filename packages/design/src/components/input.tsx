/**
 * Input — 单行文本输入框
 *
 * 设计规范：
 * - 3 种尺寸：lg (padding 6px, radius 10px) | md (4px, radius 8px) | sm (2px, radius 8px)
 * - 布局：左侧图标容器 p-1 / 文字容器 flex-1 / 右侧后缀容器 p-1
 * - Default: bg --control-input-bg，border --border-medium
 * - Focus: border --border-focus + focus ring 阴影
 * - Error: border --status-error
 * - Disabled: bg --control-input-bg-disabled
 */
import { forwardRef } from "react"
import type { InputHTMLAttributes, ReactNode } from "react"
import { cn } from "../lib/cn.js"

export type InputSize = "sm" | "md" | "lg"

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: InputSize
  error?: boolean
  leftIcon?: ReactNode
  suffix?: ReactNode
}

const SIZES: Record<InputSize, { wrapper: string; text: string }> = {
  sm: { wrapper: "px-0.5 py-[1px] rounded-lg", text: "text-[13px] leading-5" },
  md: { wrapper: "px-1 py-[3px] rounded-lg", text: "text-sm leading-[22px]" },
  lg: { wrapper: "px-1.5 py-[5px] rounded-[10px]", text: "text-sm leading-[22px]" },
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = "md", error = false, leftIcon, suffix, className, disabled, ...props },
  ref,
) {
  const config = SIZES[size]

  return (
    <div
      className={cn(
        "flex items-center border transition-colors duration-150",
        "focus-within:shadow-[var(--shadow-focus-ring)]",
        config.wrapper,
        error
          ? "border-[var(--status-error)]"
          : "border-[var(--border-medium)] focus-within:border-[var(--border-focus)]",
        disabled === true
          ? "bg-[var(--control-input-bg-disabled)]"
          : "bg-[var(--control-input-bg)]",
        className,
      )}
    >
      {leftIcon === undefined ? null : (
        <span className="flex size-4 shrink-0 items-center justify-center p-1 text-[var(--text-base-tertiary)]">
          {leftIcon}
        </span>
      )}
      <input
        ref={ref}
        disabled={disabled}
        className={cn(
          "min-w-0 flex-1 bg-transparent px-1.5 py-0.5 outline-none",
          "text-[var(--text-base-primary)] placeholder:text-[var(--text-base-tertiary)]",
          "disabled:cursor-not-allowed disabled:text-[var(--text-base-disable)]",
          config.text,
        )}
        {...props}
      />
      {suffix === undefined ? null : <span className="shrink-0 p-1">{suffix}</span>}
    </div>
  )
})
