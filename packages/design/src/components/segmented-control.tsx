/**
 * SegmentedControl — 一组互斥选项，横向并排（"分段控件"）。
 *
 * ## 它替掉的是什么
 *
 * 侧栏的「草稿模式 / 自动判断」、会话设置里的「不触发 / @我时 / 每条消息 /
 * 命中关键词」原来都是原生 `<select>` 或一排 `<button>` 各自手写样式。
 * 两个问题：
 *
 * · **下拉框藏住了选项** —— 只有 2-4 个选项且每个都短的时候，下拉框要求
 *   用户点开才知道有什么，而分段控件一眼看完。更要紧的是它藏住了
 *   "现在是哪个"旁边还有什么，而那正是用户要判断的（"我是不是该换成自动"）。
 * · **一排 button 各写一遍** —— 实测三处的选中态用了三种表达
 *   （底色 / 边框 / 字重），于是同一种控件在三个地方长得不一样。
 *
 * ## 设计取自 cult/ui 的 tabs（`vendor/cult-ui/primitives/tabs.tsx`）
 *
 * 那份的形态是：外层一个浅色槽（`bg-muted p-1 rounded-lg`），选中项
 * **升起**成卡片（`bg-background shadow`）。这个"凹槽 + 浮起"的对比
 * 比"选中项加底色"更容易在扫视中定位，因为它给的是**深度**差而不只是色差。
 *
 * ★ 不 import 那个文件：它依赖 `@radix-ui/react-tabs`（本仓库没装）
 * 与 `@/lib/utils` 的路径别名。按 vendor README 的规矩**移植样式**，
 * 用原生元素实现语义。
 *
 * ## 语义用 `role="radiogroup"` 而不是 tablist
 *
 * tab 的语义是"切换同一区域的不同面板"，而这里是**取一个值**
 * （它会被保存进配置）。读屏器读到 radiogroup 会播报"3 个选项中的第 2 个"，
 * 那正是用户需要知道的；读成 tablist 则不会。
 *
 * 键盘：左右方向键在选项间移动并**直接选中**（radio 的标准行为），
 * 而不是移动焦点再按空格 —— 后者对一个只有 4 个短选项的控件是多余的一步。
 */
import { useCallback, useId, useRef } from "react"
import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** 悬停说明。用在"这个选项会做什么"需要一句话解释时 */
  title?: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  /** 整组禁用（保存中）。单个选项的禁用在 option 上 */
  disabled?: boolean
  /** 读屏器用的组标签 —— 没有它读屏器只报"单选组"而不说是关于什么的 */
  ariaLabel: string
  size?: "sm" | "md"
  /** 撑满容器宽度（侧栏的两个 tab 要等分） */
  block?: boolean
  className?: string
}

const SIZES = {
  sm: "typography-caption-400 px-2 py-1",
  md: "typography-body-small-400 px-3 py-1.5",
} as const

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  size = "md",
  block = false,
  className,
}: SegmentedControlProps<T>) {
  const name = useId()
  const containerRef = useRef<HTMLDivElement | null>(null)

  /**
   * 左右方向键切换。
   *
   * ★ 跳过 `disabled` 的选项而不是停在它上面：停下来之后用户再按一次
   * 才能过去，而"按了没反应"是这个项目里反复出现的那类体验问题。
   * 环绕（到头回到另一端）是 radiogroup 的标准行为。
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
      if (step === 0 || disabled) return
      event.preventDefault()
      const usable = options.filter((option) => option.disabled !== true)
      if (usable.length === 0) return
      const current = usable.findIndex((option) => option.value === value)
      const next = usable[(current + step + usable.length) % usable.length]
      if (next !== undefined) {
        onChange(next.value)
        // 焦点跟着走，否则连按方向键会停在原来那个按钮上
        containerRef.current
          ?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)
          ?.focus()
      }
    },
    [disabled, onChange, options, value],
  )

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        // 凹槽：比页面底色**深**一档，让选中项浮起来时对比是"深度"而不只是色相
        "inline-flex items-center gap-0.5 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] p-0.5",
        block ? "flex w-full" : "",
        disabled ? "opacity-60" : "",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value
        const itemDisabled = disabled || option.disabled === true
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={option.value}
            name={name}
            disabled={itemDisabled}
            /**
             * ★ 只有选中项进 tab 序列（`tabIndex={0}`），其余是 -1。
             *
             * 这是 radiogroup 的标准做法：Tab 键进入这个组时落在当前值上，
             * 组内移动交给方向键。不这样做的话一个 4 选项的控件要按 4 次 Tab
             * 才能走过去，而它在语义上只是**一个**控件。
             */
            tabIndex={selected ? 0 : -1}
            {...(option.title === undefined ? {} : { title: option.title })}
            onClick={() => {
              if (!itemDisabled) onChange(option.value)
            }}
            className={cn(
              "min-w-0 flex-1 truncate rounded-[var(--radius-sm)] transition-all duration-150",
              "focus-visible:shadow-[var(--shadow-focus-ring)] focus-visible:outline-none",
              SIZES[size],
              selected
                ? // 浮起：卡片底色 + 一层极浅的阴影（取自 cult/ui 的 data-[state=active]）
                  "font-medium bg-[var(--bg-card-z1)] text-[var(--text-base-primary)] shadow-sm"
                : "text-[var(--text-base-tertiary)] hover:text-[var(--text-base-secondary)]",
              itemDisabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
