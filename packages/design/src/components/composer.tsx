/**
 * Composer — 搜索输入框。
 *
 * 移植边界（需求明确）：
 * · **要**：容器外观（圆角 24px + `--control-input-bg` + inputbox 阴影 +
 *   focus 态）、左下角「添加文件」、右下角确认按钮；
 * · **不要**：回车提示线（需求原文「搜索回车按钮线没有用」）、
 *   mention、语音、模型选择器、连接器栏、品牌图标。
 *
 * 参考实现的 `chat-input.tsx` 有 3403 行，绝大部分是上面"不要"的那些。
 * 这里预算 ≤300 行，只做一个受控的多行输入 + 两个按钮。
 *
 * 交互约定：
 * · Enter 发送，Shift+Enter 换行（IME 组合中的 Enter 不发送，见下）；
 * · 高度自适应，上限 `maxHeight` 后内部滚动；
 * · 附件以 chip 形式排在输入区上方，可逐个移除。
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react"
import { cn } from "../lib/cn.js"
import { IconButton } from "./icon-button.js"

export interface ComposerAttachment {
  id: string
  name: string
  /** 字节数；未知时传 null（远端文件还没下载完的场景） */
  bytes: number | null
}

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** 附件按钮点击（由调用方打开文件选择对话框） */
  onAttach?: () => void
  attachments?: readonly ComposerAttachment[]
  onRemoveAttachment?: (id: string) => void
  placeholder?: string
  /** 正在生成时禁用发送并显示停止按钮 */
  busy?: boolean
  onStop?: () => void
  disabled?: boolean
  /** 输入区最大高度（px）；超过后内部滚动 */
  maxHeight?: number
  /** 首屏（无会话）时用更大的最小高度，与参考实现一致 */
  variant?: "hero" | "inline"
  attachLabel?: string
  sendLabel?: string
  stopLabel?: string
  className?: string
  /** 额外的左下角控件（放在附件按钮右边） */
  toolbarExtra?: ReactNode
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onAttach,
  attachments = [],
  onRemoveAttachment,
  placeholder,
  busy = false,
  onStop,
  disabled = false,
  maxHeight = 240,
  variant = "inline",
  attachLabel = "添加文件",
  sendLabel = "发送",
  stopLabel = "停止",
  className,
  toolbarExtra,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [focused, setFocused] = useState(false)

  // 高度自适应：内容变化时重算。用 scrollHeight 而不是 rows ——
  // 后者在换行与长单词折行时算不准。
  useEffect(() => {
    const node = textareaRef.current
    if (node === null) return
    node.style.height = "auto"
    node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`
  }, [value, maxHeight])

  const canSubmit = !disabled && !busy && (value.trim() !== "" || attachments.length > 0)

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter") return
    // Shift+Enter 换行。
    if (event.shiftKey) return
    /**
     * IME 组合中的 Enter **不能**发送。
     *
     * 中文输入法在候选框打开时按 Enter 是"确认选字"，
     * 拦不住的话用户每打一个词就发一条 —— 这是中文输入下必然发生的事故。
     * `isComposing` 是标准字段，比监听 compositionstart/end 更可靠。
     */
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    if (canSubmit) onSubmit()
  }

  return (
    <div
      className={cn(
        "relative w-full min-w-0 max-w-full",
        variant === "hero" && "rounded-[24px] bg-[var(--bg-card-z0)]",
        className,
      )}
    >
      <div
        className="relative w-full min-w-0 max-w-full cursor-text"
        onClick={() => textareaRef.current?.focus()}
      >
        <div
          className={cn(
            "relative z-10 flex w-full min-w-0 max-w-full flex-col",
            "overflow-hidden rounded-[24px] bg-[var(--control-input-bg)] p-[10px]",
            "shadow-[var(--shadow-inputbox)] transition-shadow",
            variant === "hero" ? "min-h-[120px]" : "min-h-[92px]",
            // focus 环用 box-shadow 而不是 border：border 会改变盒模型导致内容跳 1px
            focused && "ring-1 ring-[var(--control-input-border-focus)]",
          )}
        >
          {attachments.length > 0 && (
            <div className="mb-1 flex flex-wrap gap-1.5 px-1">
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="typography-caption-400 inline-flex max-w-full items-center gap-1 rounded-[var(--radius-md)] bg-[var(--bg-card-z1)] px-2 py-1 text-[var(--text-base-secondary)]"
                >
                  <span className="min-w-0 truncate">{attachment.name}</span>
                  {attachment.bytes !== null && (
                    <span className="shrink-0 text-[var(--text-base-tertiary)]">
                      {formatBytes(attachment.bytes)}
                    </span>
                  )}
                  {onRemoveAttachment !== undefined && (
                    <button
                      type="button"
                      aria-label={`移除 ${attachment.name}`}
                      className="shrink-0 cursor-pointer rounded-[var(--radius-sm)] px-0.5 text-[var(--text-base-tertiary)] hover:bg-[var(--overlay-on-container-hover)] hover:text-[var(--text-base-primary)]"
                      onClick={(event) => {
                        event.stopPropagation()
                        onRemoveAttachment(attachment.id)
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            rows={1}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className={cn(
              "typography-body-base-400 w-full flex-1 resize-none bg-transparent px-1 py-1",
              "text-[var(--text-base-primary)] outline-none",
              "placeholder:text-[var(--text-base-tertiary)]",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />

          {/* 底部工具条。**刻意没有回车提示线** —— 需求明确不要。 */}
          <div className="mt-auto flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-1">
              {onAttach !== undefined && (
                <IconButton
                  size="md"
                  variant="ghost"
                  label={attachLabel}
                  disabled={disabled}
                  onClick={(event) => {
                    event.stopPropagation()
                    onAttach()
                  }}
                >
                  <AttachIcon />
                </IconButton>
              )}
              {toolbarExtra}
            </div>

            {busy && onStop !== undefined ? (
              <RoundButton
                label={stopLabel}
                tone="neutral"
                onClick={(event) => {
                  event.stopPropagation()
                  onStop()
                }}
              >
                <StopIcon />
              </RoundButton>
            ) : (
              <RoundButton
                label={sendLabel}
                tone="brand"
                disabled={!canSubmit}
                onClick={(event) => {
                  event.stopPropagation()
                  if (canSubmit) onSubmit()
                }}
              >
                <SendIcon />
              </RoundButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 圆形实心按钮。
 *
 * 不复用 `IconButton`：它的 variant 只有 transparent / ghost（刻意的 ——
 * 那是工具栏图标按钮），而发送按钮需要实心品牌色。
 * 与其给 IconButton 加一个只有这里用的 variant，不如在本地写 20 行 ——
 * 前者会让「工具栏图标按钮」这个语义变模糊。
 */
function RoundButton({
  label,
  tone,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  tone: "brand" | "neutral"
  disabled?: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        tone === "brand"
          ? cn(
              "bg-[var(--control-core-button-default)] text-[var(--theme-white-white-100)]",
              "enabled:hover:bg-[var(--control-core-button-hover)]",
              "disabled:bg-[var(--control-core-button-disabled)] disabled:text-[var(--text-base-disable)]",
            )
          : "bg-[var(--bg-card-z1)] text-[var(--text-base-primary)] enabled:hover:bg-[var(--overlay-on-container-hover)]",
      )}
    >
      {children}
    </button>
  )
}

function AttachIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 13V3.5M8 3.5 4 7.5M8 3.5l4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  )
}
