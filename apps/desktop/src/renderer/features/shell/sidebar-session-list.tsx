/**
 * 侧栏的搜索历史列表。
 *
 * 移植参考实现侧栏的两个模式：
 * ① **按时间分组**（置顶 / 今天 / 昨天 / 7 天内 / 更早）——
 *    平铺列表在几十个会话后就找不到东西了；
 * ② **hover 出操作条**（重命名 / 置顶 / 删除）——
 *    常驻按钮会让列表变成一片图标。
 *
 * 不搬的：archive/cron/多选（需求没要，且每一个都要配一套确认与撤销）。
 */
import { useState } from "react"
import { cn } from "@mycontext/design"
import type { SearchSessionSummary } from "@mycontext/ipc-contract"
import { CHANNEL_BRAND_ICONS } from "../channels/channel-icons.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface SidebarSessionListProps {
  sessions: readonly SearchSessionSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
  /** 当前时间（注入以便测试；缺省用系统时间） */
  nowMs?: number
}

type GroupKey = "pinned" | "today" | "yesterday" | "week" | "earlier"

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * 分组判定。
 *
 * 「今天」按**本地日历日**而不是「24 小时内」：用户说"今天"指的是日历日，
 * 凌晨 1 点看到昨晚 11 点的会话被归到"今天"会觉得不对。
 */
export function groupOf(session: SearchSessionSummary, nowMs: number): GroupKey {
  if (session.pinned) return "pinned"
  const startOfToday = new Date(nowMs).setHours(0, 0, 0, 0)
  if (session.lastActiveAt >= startOfToday) return "today"
  if (session.lastActiveAt >= startOfToday - MS_PER_DAY) return "yesterday"
  if (session.lastActiveAt >= startOfToday - 7 * MS_PER_DAY) return "week"
  return "earlier"
}

const GROUP_ORDER: readonly GroupKey[] = ["pinned", "today", "yesterday", "week", "earlier"]

/**
 * 会话的检索档位图标。
 *
 * ★ 认不出的档位（`all` / 未来的新档 / 旧会话没有这个字段）返回 null ——
 * 不画比画一个猜的图标好：这个图标是"答案从哪来"的唯一线索，猜错比没有更糟。
 */
function SessionScopeIcon({ scope }: { scope?: string | undefined }) {
  if (scope === undefined || scope === "") return null
  const Icon = CHANNEL_BRAND_ICONS[scope]
  if (Icon === undefined) return null
  return <Icon className="size-3 shrink-0 rounded-[3px]" />
}

export function SidebarSessionList({
  sessions,
  activeId,
  onSelect,
  onRename,
  onTogglePin,
  onDelete,
  nowMs,
}: SidebarSessionListProps) {
  const { t } = useDynamicTranslation("search")
  const now = nowMs ?? Date.now()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState("")

  if (sessions.length === 0) {
    return (
      <p className="typography-caption-400 px-3 py-2 text-[var(--text-base-tertiary)]">
        {t("sessions.empty")}
      </p>
    )
  }

  const grouped = new Map<GroupKey, SearchSessionSummary[]>()
  for (const session of sessions) {
    const key = groupOf(session, now)
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [session])
    else bucket.push(session)
  }

  const commitRename = (id: string): void => {
    const title = renameDraft.trim()
    if (title !== "") onRename(id, title)
    setRenamingId(null)
  }

  return (
    <nav className="flex flex-col gap-3" aria-label={t("sessions.title")}>
      {GROUP_ORDER.filter((key) => grouped.has(key)).map((key) => (
        <div key={key} className="flex flex-col gap-0.5">
          {/*
            ★ 分组标签要**读得见**，但不能与条目争。

            原来是 `caption-400`（12px）+ `text-base-tertiary`（35% 黑）——
            实测在浅色主题下"昨天""7 天内"几乎看不出来，于是分组这件事
            白做了：用户看到的是一列连续的历史，中间偶尔有一片模糊的灰。

            改成 tertiary → **secondary**（65%）并加 `font-medium`：
            分组标签的职责是"让人扫的时候能停下来"，35% 的对比度做不到。
            仍然保持 12px 且不加底色 —— 它是**标签**不是条目，
            放大或加底色会让它看起来可点。
          */}
          <span className="typography-caption-400 px-3 py-1 font-medium text-[var(--text-base-secondary)]">
            {t(`sessions.groups.${key}`)}
          </span>
          {(grouped.get(key) ?? []).map((session) => (
            <div
              key={session.id}
              data-testid={`session-item-${session.id}`}
              className={cn(
                "group relative flex items-center gap-1 rounded-[var(--radius-md)] px-3 py-1.5",
                "hover:bg-[var(--overlay-on-container-hover)]",
                activeId === session.id && "bg-[var(--overlay-on-container-selected)]",
              )}
            >
              {renamingId === session.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => commitRename(session.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename(session.id)
                    if (event.key === "Escape") setRenamingId(null)
                  }}
                  className="typography-body-small-400 min-w-0 flex-1 bg-transparent text-[var(--text-base-primary)] outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className="typography-body-small-400 flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-[var(--text-base-primary)]"
                  title={session.title ?? t("sessions.untitled")}
                >
                  {/*
                    ★★ 检索档位的品牌图标 —— 一个会话是"只搜钉钉"还是"只搜飞书"
                    直接决定它的答案，而列表里只有标题的话完全看不出来
                    （实测：三个会话都叫一句中文问句，没人知道哪个搜的是哪儿）。

                    ★ 用图标而不是文字：侧栏很窄，加两个字会把标题挤掉。
                    「混合」档没有品牌图标 —— 那时不画（下面 `SessionScopeIcon`
                    返回 null），因为它本来就不属于某一个渠道。
                  */}
                  <SessionScopeIcon scope={session.graphScope} />
                  <span className="min-w-0 flex-1 truncate">
                    {session.title ?? t("sessions.untitled")}
                  </span>
                </button>
              )}

              {/* hover 才出的操作条：常驻会让列表变成一片图标 */}
              <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <RowAction
                  label={t("sessions.actions.rename")}
                  onClick={() => {
                    setRenameDraft(session.title ?? "")
                    setRenamingId(session.id)
                  }}
                >
                  ✎
                </RowAction>
                <RowAction
                  label={t(session.pinned ? "sessions.actions.unpin" : "sessions.actions.pin")}
                  onClick={() => onTogglePin(session.id, !session.pinned)}
                >
                  {session.pinned ? "★" : "☆"}
                </RowAction>
                <RowAction
                  label={t("sessions.actions.delete")}
                  onClick={() => onDelete(session.id)}
                >
                  ×
                </RowAction>
              </div>
            </div>
          ))}
        </div>
      ))}
    </nav>
  )
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="size-5 shrink-0 rounded-[var(--radius-sm)] text-[var(--text-base-tertiary)] hover:bg-[var(--overlay-on-container-pressed)] hover:text-[var(--text-base-primary)]"
    >
      {children}
    </button>
  )
}
