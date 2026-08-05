/**
 * Checkbox — 复选框
 *
 * 设计规范：
 * - 方框 16×16，radius 4px；选中态用品牌色填充 + 白色对勾
 * - label 与方框整体可点（包在 label 元素里），点击区域不止 16px
 * - 键盘可达：用原生 input 承载焦点与语义，视觉层仅做样式覆盖
 */
import { forwardRef } from "react"
import type { InputHTMLAttributes, ReactNode } from "react"
import { cn } from "../lib/cn.js"

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, disabled, ...props },
  ref,
) {
  return (
    <label
      className={cn(
        "group inline-flex cursor-pointer select-none items-center gap-[var(--gap-component-sm)]",
        disabled === true && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <input
          ref={ref}
          type="checkbox"
          disabled={disabled}
          className="peer size-4 cursor-pointer appearance-none rounded-[4px] border border-[var(--border-medium)] bg-[var(--control-input-bg)] transition-colors checked:border-[var(--control-core-button-default)] checked:bg-[var(--control-core-button-default)] focus-visible:shadow-[var(--shadow-focus-ring)] disabled:cursor-not-allowed"
          {...props}
        />
        {/* 对勾覆盖在 input 之上，仅在选中时显示 */}
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="pointer-events-none absolute hidden size-3 text-[var(--theme-white-white-100)] peer-checked:block"
        >
          <path
            d="M3 8.5l3 3 7-7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {label === undefined ? null : (
        <span className="typography-body-small-400 text-[var(--text-base-secondary)]">{label}</span>
      )}
    </label>
  )
})
