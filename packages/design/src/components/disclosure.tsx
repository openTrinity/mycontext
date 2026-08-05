/**
 * Disclosure — 可折叠分区（标题行 + 展开的内容）
 *
 * ## 为什么需要它
 *
 * 设置里的「数字分身」原来把三块东西平铺在一屏：形象定制（8 个风格 +
 * 11 个部位 + 十几个色块 + 圆角 + 预设）、运行参数（5 行）、自动发送白名单
 * （一列会话）。它们是同一层级、没有边界、没有折叠 —— 页面打开就是
 * 一片没有节奏的控件，而用户来这一页通常只想改**一件**事。
 *
 * 折叠把"这一页有哪几块"提到了扫视层：收起时一屏能看完全部分区标题，
 * 展开的只有当前要动的那一块。
 *
 * ## 设计契约
 *
 * · 用原生 `<details>/<summary>`：键盘可达、可被浏览器搜索命中（Cmd+F
 *   能展开命中的分区）、无需 JS 管状态。自己写一套 button+aria-expanded
 *   要多几十行才追上，而且搜索命中那条追不上。
 * · **默认展开由调用方决定**（`defaultOpen`）—— 哪一块是"主要的"是页面
 *   的判断，不是组件的。
 * · 标题行右侧可放一个状态摘要（`summary`），收起时也能看到关键信息
 *   （"6 个会话"/"周一至周五 9-19 点"）—— 折叠不该让人为了看一个数字
 *   去展开。
 * · 箭头用 CSS 跟随 `open` 旋转，不用两个图标切换：后者在快速开合时
 *   会闪一下。
 */
import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

export interface DisclosureProps {
  title: ReactNode
  /** 标题下方的一句说明。收起时也显示 —— 它帮人决定要不要展开 */
  hint?: ReactNode
  /** 标题行最右侧的状态摘要（收起时可见的关键信息） */
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

export function Disclosure({
  title,
  hint,
  summary,
  defaultOpen = false,
  children,
  className,
}: DisclosureProps) {
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group rounded-[var(--radius-lg)] bg-[var(--bg-card-z1)] ring-1 ring-[var(--border-divider-light)]",
        className,
      )}
    >
      <summary
        className={cn(
          // `list-none` + `[&::-webkit-details-marker]:hidden`：去掉浏览器
          // 默认的三角，我们自己画一个（默认那个不跟随设计 token）
          "flex cursor-pointer list-none items-center gap-3 px-4 py-3",
          "[&::-webkit-details-marker]:hidden",
          "rounded-[var(--radius-lg)] transition-colors hover:bg-[var(--overlay-on-container-hover)]",
          "focus-visible:shadow-[var(--shadow-focus-ring)]",
        )}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--text-base-tertiary)] transition-transform duration-150 group-open:rotate-90"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="typography-body-base-500 text-[var(--text-base-primary)]">{title}</span>
          {hint === undefined ? null : (
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{hint}</span>
          )}
        </span>
        {summary === undefined ? null : (
          <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
            {summary}
          </span>
        )}
      </summary>
      {/* 内容与标题行之间给一条分隔线：展开后边界才清楚 */}
      <div className="border-t border-[var(--border-divider-light)] px-4 py-3">{children}</div>
    </details>
  )
}
