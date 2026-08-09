/**
 * ChatHeader —— 中栏对话上方的一行：头像 + 标题 + 右上角几个 icon。
 *
 * ## ★ 它替掉的是那条又高又满的 `ReplyModeControls`
 *
 * 原来中栏顶部是：头像 + 会话名 + 类型/人数 + 渠道徽章 + 未读 +
 * 回复方式下拉 + 触发条件下拉 + 白名单按钮 + 一两句说明，竖着两行、
 * 实测吃掉约 24% 视口。用户反馈"右上角有几个 icon 按钮，把回复方式 /
 * 只出草稿 / 触发条件放进会话设置弹窗；不用重复显示钉钉 icon
 * （顶栏有了）；聊天记录也要有精确搜索能跳转；群聊能看成员"。
 *
 * 现在这一行只留**身份**（头像 + 名字 + 未读），设置全进弹窗。
 *
 * ## 右上角三个 icon，各开一个东西
 *
 * · 🔍 记录搜索 —— 打开设置弹窗并定位到「搜索」tab；
 * · 🕘 历史处理结果 —— 一个 popover，显示这个会话最近的自动发送/采纳记录
 *   （原来那块 `ActivityFeed` 常驻在回复区下面，用户说"不需要处理结果，
 *   顶多右上角放历史"）。★ 点其中一条 → 开一个**独立弹窗**看那一轮的
 *   完整过程（`RunTraceDialog`）：过程原来是就地展开的，而这个 popover
 *   有高度上限、外面还套着 `overflow-hidden` 的布局区，于是几十条
 *   tool_call 挤在几行里读不了（用户报的「没法 scroll、看不全」）；
 * · ⚙️ 会话设置 —— 打开设置弹窗的「设置」tab。
 *
 * ★ 不再显示渠道 icon：顶栏（`PersonaHeaderControls`）已经有了，
 * 会话头再放一个是重复。类型/人数移进了设置弹窗的成员 tab。
 */
import { useState } from "react"
import { Avatar, IconButton, Tooltip } from "@mycontext/design"
import type { PersonaActivityView, PersonaConversationView } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { SettingsIcon } from "../shell/icons.js"
import { formatBadgeCount } from "./conversation-rail.js"
import { ActivityFeed } from "./activity-feed.js"

export interface ChatHeaderProps {
  item: PersonaConversationView
  /** 单聊对方头像（群聊为 null） */
  peerAvatar?: string | null
  activities: readonly PersonaActivityView[]
  onOpenSettings: () => void
  onOpenSearch: () => void
}

export function ChatHeader({
  item,
  peerAvatar,
  activities,
  onOpenSettings,
  onOpenSearch,
}: ChatHeaderProps) {
  const { t } = useDynamicTranslation("persona")
  const [historyOpen, setHistoryOpen] = useState(false)

  return (
    <div className="relative flex shrink-0 items-center gap-2 border-b border-[var(--border-divider-light)] px-4 py-2.5">
      <Avatar name={item.title ?? item.externalId} src={peerAvatar ?? null} size="sm" />
      <span className="typography-body-small-400 font-medium min-w-0 flex-1 truncate text-[var(--text-base-primary)]">
        {item.title ?? item.externalId}
      </span>

      {/*
        ★ 未读留在会话头。
        进到一个会话里最先要知道的是"这里有几条我还没看过" ——
        只在左栏显示的话，选中之后那个数字就滚出视野了。
      */}
      {item.unreadCount > 0 ? (
        <span
          className="typography-caption-400 font-medium shrink-0 rounded-full bg-[var(--text-accent-normal)] px-1.5 text-[var(--theme-white-white-100)]"
          title={t("unreadBadgeHint")}
        >
          {t("unreadInline", { count: formatBadgeCount(item.unreadCount) })}
        </span>
      ) : null}

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip content={t("recordSearchTitle")} placement="bottom">
          <IconButton label={t("recordSearchTitle")} size="sm" onClick={onOpenSearch}>
            <SearchGlyph />
          </IconButton>
        </Tooltip>
        {/*
          历史处理结果：一个 popover 而不是常驻栏。
          用户说"不需要处理结果，顶多右上角放历史" —— 所以它默认收起，
          点开才看，关掉就走。
        */}
        <Tooltip content={t("historyTitle")} placement="bottom">
          <IconButton
            label={t("historyTitle")}
            size="sm"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
          >
            <HistoryGlyph />
          </IconButton>
        </Tooltip>
        <Tooltip content={t("settingsTitle")} placement="bottom">
          <IconButton label={t("settingsTitle")} size="sm" onClick={onOpenSettings}>
            <SettingsIcon />
          </IconButton>
        </Tooltip>
      </div>

      {historyOpen ? (
        <>
          {/* 点外面收起 —— 一个透明的全屏捕获层，不压暗（它只是个小 popover） */}
          <div className="fixed inset-0 z-30" aria-hidden onClick={() => setHistoryOpen(false)} />
          {/*
            ★ 高度用 `max-h-[min(60vh,32rem)]` 而不是写死的 `max-h-72`（288px）。

            288px 在 800px 高的默认窗口里只用掉 36% —— 也就是说这个 popover
            明明有地方可以长，却把自己压到只能露三四条，于是"最近发过什么"
            这件事要在一个很短的窗口里滚。取 60vh 与 32rem 的较小值：
            大窗口上跟着长，小窗口上不会顶出屏幕。

            ★★ 滚动容器**必须是这里这一层**（`overflow-y-auto` 挂在有
            `max-h` 的那个盒子上）。挂在没有高度约束的祖先上是"能滚不动"的
            经典成因 —— 内容会把父级撑高，父级永远没有溢出。

            `overscroll-contain`：滚到底时不把滚动继续传给背后的消息流
            （那会让人以为自己滚错了地方）。
          */}
          <div className="absolute right-3 top-full z-40 mt-1 flex max-h-[min(60vh,32rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-pop)] shadow-[var(--shadow-lg)]">
            <div className="flex shrink-0 flex-col gap-0.5 border-b border-[var(--border-divider-light)] px-3 py-2.5">
              <span className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
                {t("historyTitle")}
              </span>
              <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                {t("historyHint")}
              </span>
            </div>
            {/*
              ★ 只有这一层滚。`min-h-0` 让 flex 子项真的能被压缩 ——
              缺了它 `flex-1` 不收缩，内容把 popover 顶破 `max-h`
              而不是滚动（这一条与 `RunTraceDialog` 里那层是同一个坑）。

              ★★ 列表里**不再有就地展开的过程块**：那是「没法 scroll」的
              另一半成因（一段几十条的 trace 铺在一个 288px 的列表里）。
              现在点一条开独立弹窗（见 `ActivityFeed` 与 `RunTraceDialog`）。
            */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2.5">
              <ActivityFeed activities={activities} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function HistoryGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
      <path
        d="M8 3.2a4.8 4.8 0 1 0 4.6 6.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M8 5.4V8l1.8 1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M12.6 3v2.4h-2.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
