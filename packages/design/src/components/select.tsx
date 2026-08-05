/**
 * Select — 原生下拉选择
 *
 * ## 为什么是原生 `<select>` 而不是自绘浮层
 *
 * "从 N 个里选一个"是原生控件做得最好的一件事：键盘（上下键、首字母跳转）、
 * 读屏器语义、移动端的系统选择器、以及**下拉浮层的定位**（原生不受父容器
 * `overflow: hidden` 影响，而自绘的会被裁掉）。自己写要几十行才追上，
 * 而这个应用里没有任何原生做不到的需求（不需要多选、不需要图标选项）。
 *
 * `DropdownMenu` 是另一件事：那是**菜单**（一组动作），不是取值控件。
 *
 * ## ★ 为什么它必须存在（而不是各处自己写 className）
 *
 * 抽出来之前有三处原生 select，各自手写了一串几乎相同的类 ——
 * 而"几乎"是问题所在：
 *
 * | 位置 | 底色 | 内边距 | 文字色 |
 * |---|---|---|---|
 * | 会话表头（回复模式/触发条件） | `--bg-base-normal` | `px-1` | primary |
 * | 工作时间（起止小时） | `--bg-card-z1` | `px-2` | primary |
 * | 仪表盘渠道切换 | `--bg-card-z0` | `px-1.5` | secondary |
 *
 * 三个底色、三个内边距、两个文字色 —— 而它们在界面上是**同一种控件**。
 * 用户看到的是"这些下拉框长得都不太一样"，而这正是"杂乱、没有设计感"
 * 的一种具体成因：不是哪一处难看，是同类元素之间不一致。
 *
 * 底色统一取 `--control-input-bg`（与 `Input` 同源）—— 它们都是取值控件，
 * 本来就该看起来是一家的；而原来那三个底色分别对应三种**容器**层级，
 * 也就是说控件的外观跟着它碰巧被放在哪里变，那不是一个可维护的规则。
 */
import { forwardRef } from "react"
import type { ReactNode, SelectHTMLAttributes } from "react"
import { cn } from "../lib/cn.js"

/**
 * 两档尺寸。
 *
 * `sm` 是密集场景（会话表头那一行里挤着头像、标题、两个下拉与一个按钮），
 * `md` 与 `Input` 的默认档对齐（表单里与输入框并排时高度一致）。
 * 不给 `lg`：没有任何地方需要一个特大号下拉，而多一档就多一处要维护的对齐。
 */
export type SelectSize = "sm" | "md"

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: SelectSize
  children: ReactNode
}

const SIZES: Record<SelectSize, string> = {
  sm: "typography-caption-400 px-1.5 py-0.5",
  md: "typography-body-small-400 px-2 py-1",
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = "md", className, disabled, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      disabled={disabled}
      className={cn(
        "rounded-[var(--radius-sm)] border transition-colors duration-150",
        "text-[var(--text-base-primary)]",
        SIZES[size],
        /**
         * 焦点态与 `Input` 一致（边框转 focus 色 + focus ring）。
         *
         * 原来那三处**都没有**焦点样式 —— 键盘走到下拉框上时看不出来
         * 光标在哪，而那是原生控件唯一需要我们补的一块
         * （原生 focus ring 在自定义边框下会被盖住）。
         */
        "focus-visible:border-[var(--border-focus)] focus-visible:shadow-[var(--shadow-focus-ring)] focus-visible:outline-none",
        disabled === true
          ? "cursor-not-allowed border-[var(--border-divider-light)] bg-[var(--control-input-bg-disabled)] opacity-60"
          : "border-[var(--border-medium)] bg-[var(--control-input-bg)]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
})
