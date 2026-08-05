/**
 * ConversationSettingsDialog —— 当前会话的设置弹窗（右上角 icon 打开）。
 *
 * ## ★ 为什么这些东西从"常驻表头"移进弹窗
 *
 * 原来中栏顶部有一整条 `ReplyModeControls`：会话名 + 回复方式下拉 +
 * 触发条件下拉 + 白名单按钮 + 一两句说明，实测吃掉约 24% 的视口高度，
 * 而这一页的主体是下面那段对话。用户反馈"回复方式 / 只出草稿 /
 * 触发条件都放进类似会话设置的弹窗里"。
 *
 * 判据是**改的频率**：这些设置是"配一次，之后偶尔调"的东西，不是每次
 * 看对话都要用的。常驻表头把一个低频操作钉在最显眼的位置，挤掉了高频的
 * 主体内容。移进弹窗后，表头缩成一行标题 + 几个 icon（见 `chat-header`）。
 *
 * ## 三个 tab，因为它们回答三个不同的问题
 *
 * · **设置** —— 这个会话怎么回（回复方式 / 触发条件 / 白名单）；
 * · **成员** —— 群里有谁（发过言的人）+ 筛选；
 * · **搜索** —— 在这个会话里找一句话，点了跳过去。
 *
 * 单聊没有「成员」tab（就俩人，列出来是废话）——那一档按 `kind` 隐藏。
 */
import { useEffect, useMemo, useState } from "react"
import {
  Avatar,
  Button,
  Dialog,
  IconButton,
  Input,
  SegmentedControl,
  Tooltip,
} from "@mycontext/design"
import type { PersonaConversationView } from "@mycontext/ipc-contract"
import { useContactAvatars, usePersonaMembers, usePersonaMessageSearch } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { CloseIcon } from "../shell/icons.js"
import { MODE_KEY, MODE_ORDER } from "./labels.js"
import { formatRailTime } from "./message-time.js"

/**
 * 会话配置的三个视图类型 —— 派生自 IPC 契约，不再从已删的
 * `reply-mode-controls.tsx` 引入。
 */
type ReplyMode = PersonaConversationView["replyMode"]
type TriggerMode = PersonaConversationView["triggerMode"]
interface ReplyModePatch {
  replyMode?: ReplyMode
  triggerMode?: TriggerMode
  keywords?: string[]
}

type Tab = "settings" | "members" | "search"

export interface ConversationSettingsDialogProps {
  open: boolean
  onClose: () => void
  item: PersonaConversationView
  busy: boolean
  /** 打开时停在哪个 tab（设置 icon → settings，搜索 icon → search） */
  initialTab?: Tab
  onChange: (patch: ReplyModePatch) => void
  /** 点搜索结果 → 跳到消息流里那条（关弹窗 + 高亮） */
  onJumpToMessage: (messageId: string) => void
}

/** 触发条件四种，与用户描述的一一对应。 */
const TRIGGER_ORDER: readonly TriggerMode[] = ["none", "mention", "all", "keyword"]
const TRIGGER_KEY: Record<TriggerMode, string> = {
  none: "triggerNone",
  mention: "triggerMention",
  all: "triggerAll",
  keyword: "triggerKeyword",
}

export function ConversationSettingsDialog({
  open,
  onClose,
  item,
  busy,
  initialTab = "settings",
  onChange,
  onJumpToMessage,
}: ConversationSettingsDialogProps) {
  const { t } = useDynamicTranslation("persona")
  const { t: tc } = useDynamicTranslation()
  const [tab, setTab] = useState<Tab>(initialTab)

  /**
   * ★ 打开时（或入口切换时）跳到 `initialTab`。
   *
   * 挂载条件是父组件的 `settingsTab !== null`，而两个 icon 会把它设成
   * 不同的值又不卸载弹窗 —— 所以要在 `initialTab` 变化时同步 `tab`，
   * 否则从设置 icon 打开后再点搜索 icon，弹窗还停在设置 tab 上。
   */
  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  // 单聊没有成员 tab —— 切到别的会话若停在 members 上要落回 settings
  const showMembers = item.kind === "group"
  useEffect(() => {
    if (!showMembers && tab === "members") setTab("settings")
  }, [showMembers, tab])

  return (
    <Dialog open={open} onClose={onClose} className="radius-xl">
      <div
        className="relative flex flex-col overflow-hidden radius-xl border border-[var(--border-light)] bg-[var(--bg-base-normal)] shadow-[var(--shadow-lg)]"
        style={{
          width: "min(560px, calc(100vw - 96px))",
          height: "min(600px, calc(100vh - 96px))",
        }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-divider-light)] px-4 py-3">
          <h2 className="typography-body-base-500 min-w-0 flex-1 truncate text-[var(--text-base-primary)]">
            {item.title ?? item.externalId}
          </h2>
          <Tooltip content={tc("actions.close")} placement="left">
            <IconButton label={tc("actions.close")} size="sm" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </header>

        <div className="shrink-0 px-4 pt-3">
          <SegmentedControl
            value={tab}
            onChange={setTab}
            ariaLabel={t("settingsTabsLabel")}
            size="sm"
            block
            options={[
              { value: "settings", label: t("settingsTabConfig") },
              // 成员 tab 只对群聊出现（单聊就俩人）
              ...(showMembers
                ? [{ value: "members" as const, label: t("settingsTabMembers") }]
                : []),
              { value: "search", label: t("settingsTabSearch") },
            ]}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === "settings" ? (
            <SettingsPanel item={item} busy={busy} onChange={onChange} />
          ) : tab === "members" ? (
            <MembersPanel item={item} open={open && tab === "members"} />
          ) : (
            <SearchPanel
              conversationId={item.conversationId}
              onJump={(id) => {
                onJumpToMessage(id)
                onClose()
              }}
            />
          )}
        </div>
      </div>
    </Dialog>
  )
}

/**
 * 设置 tab：回复方式 + 触发条件 + 白名单。
 *
 * 与原来的 `ReplyModeControls` 同一套逻辑与注释，只是搬进弹窗、
 * 竖排成表单（弹窗有的是纵向空间，不必再挤成一行）。
 */
function SettingsPanel({
  item,
  busy,
  onChange,
}: {
  item: PersonaConversationView
  busy: boolean
  onChange: (patch: ReplyModePatch) => void
}) {
  const { t } = useDynamicTranslation("persona")
  const [keywords, setKeywords] = useState(item.keywords.join(" "))
  useEffect(() => {
    setKeywords(item.keywords.join(" "))
  }, [item.conversationId, item.keywords])

  const keywordsDirty = keywords.trim() !== item.keywords.join(" ")
  const keywordMissing = item.triggerMode === "keyword" && item.keywords.length === 0

  return (
    <div className="flex flex-col gap-5">
      {/*
        回复方式。
        ★ hint 随选中档变：yolo 那一档绕过全部判定，代价必须**当场**说清，
        而不是让用户去文档里找（选了才看到的警告才拦得住误选）。
      */}
      <Field
        label={t("replyMode")}
        hint={item.replyMode === "yolo" ? t("yoloWarn") : t("autoWarn")}
      >
        <SegmentedControl
          value={item.replyMode}
          onChange={(mode) => onChange({ replyMode: mode as ReplyMode })}
          ariaLabel={t("replyMode")}
          disabled={busy}
          size="sm"
          options={MODE_ORDER.map((mode) => ({ value: mode, label: t(MODE_KEY[mode]) }))}
        />
      </Field>

      {/* 触发条件 —— 四种 */}
      <Field label={t("triggerMode")}>
        <SegmentedControl
          value={item.triggerMode}
          onChange={(mode) => onChange({ triggerMode: mode as TriggerMode })}
          ariaLabel={t("triggerMode")}
          disabled={busy}
          size="sm"
          options={TRIGGER_ORDER.map((mode) => ({ value: mode, label: t(TRIGGER_KEY[mode]) }))}
        />
        {item.triggerMode === "keyword" ? (
          <div className="mt-2 flex items-center gap-2">
            <Input
              size="sm"
              value={keywords}
              disabled={busy}
              placeholder={t("keywordsPlaceholder")}
              aria-label={t("keywordsPlaceholder")}
              onChange={(event) => setKeywords(event.target.value)}
              error={keywordMissing}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !keywordsDirty}
              onClick={() =>
                onChange({ keywords: keywords.split(/\s+/).filter((word) => word !== "") })
              }
            >
              {t("saveKeywords")}
            </Button>
          </div>
        ) : null}
        {keywordMissing ? (
          <p className="typography-caption-400 mt-1 text-[var(--status-warning)]">
            {t("keywordsMissing")}
          </p>
        ) : null}
      </Field>
    </div>
  )
}

/** 表单里的一节：标题 + 说明 + 控件。 */
function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
        {label}
      </span>
      {hint === undefined ? null : (
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{hint}</span>
      )}
      {children}
    </div>
  )
}

/**
 * 成员 tab：发过言的人 + 筛选。
 *
 * ★ 标题写「发过言的 N 人」而不是「成员 N 人」：数据来源是消息发送者
 * （钉钉没有取群成员的接口），一个 500 人群里可能只有 40 个发过言。
 * 说成"成员"会让用户拿它跟钉钉的群人数对不上，然后以为漏采了。
 */
/**
 * 成员 tab：发过言的人 + 头像 + 筛选。
 *
 * ## ★ 三条变动，来自用户反馈"纯名字有点怪 / 统计数量不必"
 *
 * 1. **加头像**：一列纯文字名字读起来像一份清单，不像"人"。
 *    群聊的头像走 `useContactAvatars(externalIds, groupExternalId, nicks)`
 *    —— 群 externalId 走"共同群"捷径最快，缺花名会静默失败
 *    （见那个 hook 的注释），所以两个都传。
 * 2. **去掉每行的发言次数**：那是排查指标，不是给用户当"这个人是谁"
 *    的输入用的（用户看的是名字 + 头像）。
 * 3. **去掉顶部"发过言的 N 人"计数**：搜索框加名字列表本身已足够，
 *    数一行"多少人"不改变任何动作。
 *
 * 数据来源仍然是**发过言的人**（钉钉没有取花名册的接口）——
 * 那个语义不变，只是不再把它写成一行文字堆到界面上。
 */
function MembersPanel({ item, open }: { item: PersonaConversationView; open: boolean }) {
  const { t } = useDynamicTranslation("persona")
  const members = usePersonaMembers(item.conversationId, open)
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const list = members.data ?? []
    const needle = query.trim().toLowerCase()
    if (needle === "") return list
    return list.filter((m) => (m.displayName ?? m.externalId).toLowerCase().includes(needle))
  }, [members.data, query])

  // 批量取头像 —— 一次拿完，避免每行自己发一次请求（见 useContactAvatars 的注释）
  const externalIds = useMemo(() => (members.data ?? []).map((m) => m.externalId), [members.data])
  const nickByPeer = useMemo(() => {
    const map: Record<string, string> = {}
    for (const m of members.data ?? []) {
      if (m.displayName !== null && m.displayName !== "") map[m.externalId] = m.displayName
    }
    return map
  }, [members.data])
  const avatars = useContactAvatars(externalIds, item.externalId, nickByPeer)
  const avatarByPeer = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of avatars.data ?? []) {
      if (row.path !== null) map.set(row.externalId, row.path)
    }
    return map
  }, [avatars.data])

  return (
    <div className="flex h-full flex-col gap-2">
      <Input
        size="sm"
        value={query}
        placeholder={t("membersSearchPlaceholder")}
        aria-label={t("membersSearchPlaceholder")}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {filtered.map((m) => (
          <li
            key={m.externalId}
            className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5"
          >
            <Avatar
              name={m.displayName ?? m.externalId}
              src={avatarByPeer.get(m.externalId) ?? null}
              size="sm"
            />
            <span className="typography-body-small-400 min-w-0 flex-1 truncate text-[var(--text-base-primary)]">
              {m.displayName ?? m.externalId}
            </span>
          </li>
        ))}
        {!members.isLoading && filtered.length === 0 ? (
          <li className="typography-body-small-400 p-2 text-[var(--text-base-tertiary)]">
            {query.trim() === "" ? t("membersEmpty") : t("membersNoMatch")}
          </li>
        ) : null}
      </ul>
    </div>
  )
}

/**
 * 搜索 tab：会话内 like 搜索，点结果精确跳转。
 *
 * ★ 命中词高亮：用户搜"沙箱"要一眼看到它在句子里的哪 —— 尤其一条
 * 结果很长时。用大小写不敏感的分段高亮（`splitHighlight`）。
 */
function SearchPanel({
  conversationId,
  onJump,
}: {
  conversationId: string
  onJump: (messageId: string) => void
}) {
  const { t } = useDynamicTranslation("persona")
  const [query, setQuery] = useState("")
  const results = usePersonaMessageSearch(conversationId, query)
  const trimmed = query.trim()
  const hits = results.data ?? []

  return (
    <div className="flex h-full flex-col gap-2">
      <Input
        size="sm"
        value={query}
        placeholder={t("recordSearchPlaceholder")}
        aria-label={t("recordSearchPlaceholder")}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
      />
      {trimmed === "" ? (
        <p className="typography-body-small-400 p-2 text-[var(--text-base-tertiary)]">
          {t("recordSearchHint")}
        </p>
      ) : results.isFetching && hits.length === 0 ? (
        <p className="typography-body-small-400 p-2 text-[var(--text-base-tertiary)]">
          {t("loading")}
        </p>
      ) : hits.length === 0 ? (
        <p className="typography-body-small-400 p-2 text-[var(--text-base-tertiary)]">
          {t("recordSearchNoMatch", { query: trimmed })}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                onClick={() => onJump(hit.id)}
                title={t("recordSearchJumpHint")}
                className="flex w-full flex-col gap-0.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--overlay-on-container-hover)]"
              >
                <span className="typography-caption-400 flex items-center gap-2 text-[var(--text-base-tertiary)]">
                  <span className="min-w-0 truncate">
                    {hit.senderDisplayName ?? t("recordSearchUnknownSender")}
                  </span>
                  <span className="shrink-0">{formatRailTime(hit.sentAt)}</span>
                </span>
                <span className="typography-body-small-400 line-clamp-2 text-[var(--text-base-primary)]">
                  {splitHighlight(hit.contentText, trimmed)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 把命中词高亮出来（大小写不敏感）。
 *
 * ★ 用 indexOf 循环而不是正则：查询词里可能有正则元字符（用户搜 `a.b`
 * 或 `50%`），塞进 `new RegExp` 要么抛要么匹配错。indexOf 是字面匹配，
 * 与后端那条 LIKE 的语义一致。
 */
function splitHighlight(text: string, query: string): React.ReactNode {
  if (query === "") return text
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  let hitIndex = lower.indexOf(needle, from)
  let key = 0
  while (hitIndex !== -1) {
    if (hitIndex > from) parts.push(text.slice(from, hitIndex))
    parts.push(
      <mark
        key={key++}
        className="rounded-[2px] bg-[var(--status-fill-warning-container)] text-[var(--text-base-primary)]"
      >
        {text.slice(hitIndex, hitIndex + query.length)}
      </mark>,
    )
    from = hitIndex + query.length
    hitIndex = lower.indexOf(needle, from)
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}
