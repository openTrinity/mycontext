/**
 * Field — 表单字段容器（label + 控件 + 描述/错误）
 *
 * 错误态优先于描述：两者同时存在时只显示错误，避免用户在两行文字间来回找重点。
 * 通过 htmlFor / aria-describedby 建立无障碍关联。
 */
import { useId } from "react"
import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

export interface FieldProps {
  label: string
  /** 控件渲染函数：接收要绑定到控件上的无障碍属性 */
  children: (attributes: {
    id: string
    "aria-describedby": string | undefined
    "aria-invalid": boolean
  }) => ReactNode
  description?: string
  error?: string
  required?: boolean
  className?: string
}

export function Field({
  label,
  children,
  description,
  error,
  required = false,
  className,
}: FieldProps) {
  const id = useId()
  const messageId = `${id}-message`
  const hasMessage = error !== undefined || description !== undefined

  return (
    <div className={cn("flex flex-col gap-[var(--gap-component-sm)]", className)}>
      <label htmlFor={id} className="typography-body-small-400 text-[var(--text-base-secondary)]">
        {label}
        {required ? <span className="ml-0.5 text-[var(--status-error)]">*</span> : null}
      </label>
      {children({
        id,
        "aria-describedby": hasMessage ? messageId : undefined,
        "aria-invalid": error !== undefined,
      })}
      {hasMessage ? (
        <p
          id={messageId}
          className={cn(
            "typography-caption-400",
            error === undefined ? "text-[var(--text-base-tertiary)]" : "text-[var(--status-error)]",
          )}
        >
          {error ?? description}
        </p>
      ) : null}
    </div>
  )
}
