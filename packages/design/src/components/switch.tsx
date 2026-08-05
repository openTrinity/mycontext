/**
 * Switch — 一个开/关切换（原生 checkbox 语义）。
 *
 * ## 它与 `SegmentedControl` 的分工
 *
 * SegmentedControl 是"从 N 个里选一个"，两段时会**同时显示两个标签**
 * （运行中 | 已停止）—— 而用户反馈那样"太重了，像两个并列的东西"。
 * 一个二态的**状态**（跑没跑）用开关更轻：一个滑块，亮=开，暗=关，
 * 旁边一句标签说它现在是什么。眼睛扫过去只有一个焦点，不是两个。
 *
 * ## 取自 cult/ui 的 switch（`vendor/cult-ui/primitives/switch.tsx`）
 *
 * 形态：一个 `h-5 w-9` 的胶囊，滑块 `translate-x` 到另一端。
 * ★ 不 import 那个文件：它依赖未安装的 `@radix-ui/react-switch`
 * 与 `@/lib/utils` 别名。按 vendor README 移植样式、用原生 checkbox 实现。
 *
 * 用原生 `<input type="checkbox" role="switch">`：读屏器会播报
 * "开关，选中/未选中"，键盘空格切换 —— 这些都是免费得到的，
 * 自己用 div + onClick 重写反而要补一堆 aria。
 *
 * ## ★ 颜色语义可反转（`onColor`）
 *
 * 数字分身那处的"开"是**正常运行**（该是中性/成功色），而"关"是
 * 用户主动停下（该显眼 —— 那是个需要知道的状态）。默认 accent 色表示开，
 * 但停止那处会传一个警示色进来，让"停着"这件事在视觉上不可能被忽略。
 */
import { useId } from "react"
import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** 读屏器标签。可见标签由调用方另放（见 label 插槽） */
  ariaLabel: string
  /** 开关右侧的可见文字。传了它整体就是可点的 label */
  label?: ReactNode
  /** 悬停说明 */
  title?: string
  /**
   * 开态的颜色。默认 accent。
   *
   * 传 `--status-warning` 之类可以让"开"表达一个需要注意的状态 ——
   * 见文件头「颜色语义可反转」。
   */
  onColorVar?: string
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  label,
  title,
  onColorVar = "--text-accent-normal",
}: SwitchProps) {
  const id = useId()

  const track = (
    <span
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150",
        disabled ? "opacity-50" : "",
      )}
      style={{
        // 开态用传进来的颜色，关态是中性槽色
        backgroundColor: checked ? `var(${onColorVar})` : "var(--bg-card-z0)",
      }}
    >
      <span
        className={cn(
          "absolute left-0.5 size-4 rounded-full bg-[var(--theme-white-white-100)] shadow-sm transition-transform duration-150",
          checked ? "translate-x-4" : "translate-x-0",
        )}
        aria-hidden
      />
    </span>
  )

  return (
    <label
      htmlFor={id}
      {...(title === undefined ? {} : { title })}
      className={cn(
        "inline-flex items-center gap-2",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
      )}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}
        // 视觉上隐藏但仍可聚焦/读屏（sr-only 的等价，不引额外类）
        className="peer absolute size-0 opacity-0"
      />
      {/* 焦点环挂在轨道上（input 是隐藏的） */}
      <span className="rounded-full peer-focus-visible:shadow-[var(--shadow-focus-ring)]">
        {track}
      </span>
      {label === undefined ? null : (
        <span className="typography-caption-400 text-[var(--text-base-secondary)]">{label}</span>
      )}
    </label>
  )
}
