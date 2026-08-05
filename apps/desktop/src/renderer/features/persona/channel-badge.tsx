/**
 * ChannelBadge —— 「这条数据来自哪个渠道」。
 *
 * ## 为什么数字人页需要它
 *
 * 这一页展示的是**别人发给本人的消息**与**要以本人身份发出去的草稿**。
 * 目标形态是多渠道（钉钉 + 飞书 + 未来更多，见 .REQ.md），那时左栏会
 * 混排两个渠道的会话 —— 而"我正在回的这条是哪个 IM 里的"直接决定了
 * 回复的语气与格式，也决定了发出去会落到谁的手机上。
 *
 * 单渠道时它看起来是装饰；第二个渠道接进来的那一刻它变成必需品。
 * 现在就摆上，是为了让"渠道"这个维度在界面上一直是可见的，
 * 而不是等混排出问题了再补。
 *
 * ## ★ 未知渠道要能降级，不能崩
 *
 * 图标表是 `Record<string, …>` + 查不到就只渲染名字。收窄成
 * `Record<ChannelId, …>` 看起来更严格，但渠道 id 是**从数据库里读出来的字符串**
 * （`conversations.channel_id`），不是编译期常量 —— 老库里的一个拼写、
 * 或者一个我们还没配图标的新渠道，都会让 `ICONS[id]` 取到 undefined。
 * 那时渲染 `undefined` 作为组件会让整棵 React 树抛错，而表现是**整页白屏**。
 *
 * 名字走 `channels:<id>.label`（已有的命名空间），缺 key 时 i18next 回落到
 * key 本身 —— 难看但不是白屏，且一眼能看出缺了哪个 key。
 */
import type { ComponentType } from "react"
import { DingTalkIcon, cn } from "@mycontext/design"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

/**
 * 渠道 id → 品牌图标。
 *
 * 与 `channel-auth-panel.tsx` 里那张表同一套写法（那里也是
 * `dingtalk: DingTalkIcon`）。品牌图标是生成物（`pnpm sync:brand-icons`），
 * 保留官方品牌色 —— 所以这里**不给它套 currentColor**。
 */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  dingtalk: DingTalkIcon,
}

export interface ChannelBadgeProps {
  /** 渠道 id，来自 `conversations.channel_id` */
  channelId: string
  /**
   * `chip` 有底色与边框（页面级：它是一个限定词，要能被扫到）；
   * `inline` 只有图标 + 文字（会话级：那一行已经有标题与人数，不该再加一个框）。
   */
  variant?: "chip" | "inline"
  className?: string
}

export function ChannelBadge({ channelId, variant = "chip", className }: ChannelBadgeProps) {
  const { t } = useDynamicTranslation("channels")
  const Icon = ICONS[channelId]
  const label = t(`${channelId}.label`)

  return (
    <span
      className={cn(
        "typography-caption-400 inline-flex shrink-0 items-center gap-1",
        variant === "chip" ? "rounded-[var(--radius-sm)] bg-[var(--bg-card-z0)] px-1.5 py-0.5" : "",
        "text-[var(--text-base-secondary)]",
        className,
      )}
      // 图标 + 名字是同一个信息，读屏器念一次就够
      title={label}
    >
      {/* 品牌标识是方的，圆角一下让它在小尺寸下不那么突兀 */}
      {Icon === undefined ? null : <Icon className="size-3.5 rounded-[3px]" />}
      <span>{label}</span>
    </span>
  )
}
