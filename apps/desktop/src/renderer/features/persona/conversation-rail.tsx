/**
 * ConversationRail —— 左栏：搜索 + 三档 tab + 会话行。
 *
 * ## ★ 三档 tab：全部 / 自动判断 / 草稿模式
 *
 * · **全部**（默认）—— 扁平混排，按**最新消息时间**从新到旧排
 *   （与钉钉等 IM 一致：谁刚来消息谁在最上面），**不分组** ——
 *   用户反馈"全部 tab 里不用混着草稿和自动的分区"；
 * · **自动判断** —— 只显示回复模式设成 auto 的（那就是"会自动发"）；
 * · **草稿模式** —— 只显示只出草稿的（其余全部）。
 *
 * ★ 分类判据是回复模式（`behavesAsAuto` = `replyMode === "auto"`）。
 * 白名单那道门已删，选了自动本身就是授权 —— 是否真发还要过运行时闸，
 * 但那是逐条、事后的事，不影响"这个会话被设成会自动发了吗"这一列的归类。
 *
 * ## 搜索是 like 而不是模糊匹配
 *
 * 用 `includes`（大小写不敏感）：用户搜的是他记得的那几个字，
 * 而模糊匹配会把"沙"和"箱"分开命中一堆无关会话。搜标题**与最新一条**
 * 正文 —— 只搜标题的话"我记得有人提过沙箱"搜不到。
 *
 * ## 每行三样东西：名字 / 最新一条 / 时间
 *
 * IM 侧栏的标准形态：是谁、在说什么、多久以前 —— "要不要点进去"
 * 的三个输入都在这里。
 */
import { useMemo, useState } from "react"
import { Avatar, Input, SegmentedControl, cn } from "@mycontext/design"
import type { PersonaConversationView } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { formatRailTime } from "./message-time.js"

export interface ConversationRailProps {
  items: readonly PersonaConversationView[]
  loading: boolean
  activeId: string | null
  /**
   * 每个会话有几条待审草稿。
   *
   * ★ 这一栏必须显示它：审草稿是这一页的主要动作，而"哪个会话里有草稿"
   * 原本只能靠逐个点进去试。待处理数与草稿数是**两件不同的事**
   * （待处理 = 还没跑，草稿 = 跑完了等你审）。
   */
  draftCounts?: ReadonlyMap<string, number>
  /**
   * `openDingTalkId → 可加载的头像 URL`。
   *
   * ★ 由容器批量取好传进来，而不是这一栏自己去查：一屏几十个会话
   * 各发一次请求会打满 IPC，而取头像本身是 2-3 次 CLI 调用。
   */
  avatarByPeer?: ReadonlyMap<string, string>
  onSelect: (conversationId: string) => void
}

/**
 * 这个会话**实际上**会自动发吗。
 *
 * ★ 判据就是「回复模式是 auto」——白名单那道门已删（见 policy.ts 文件头），
 * 选了自动本身就是授权。是否真发还要过运行时闸（工作时间/场景/频率/授权），
 * 但那些是**逐条**的、事后才知道；分类这一列问的是"用户把它设成会自动发了吗"。
 */
function behavesAsAuto(item: PersonaConversationView): boolean {
  /**
   * `yolo` 也算"会自己发"的那一组 —— 它比 auto 更自动（连判定都不过）。
   * 漏掉它的表现是：选了 yolo 的会话被归到「只出草稿」那一组，
   * 而它其实在自动发消息 —— 侧栏的分组正好说了反话。
   */
  return item.replyMode === "auto" || item.replyMode === "yolo"
}

export function ConversationRail({
  items,
  loading,
  activeId,
  draftCounts,
  avatarByPeer,
  onSelect,
}: ConversationRailProps) {
  const { t } = useDynamicTranslation("persona")
  const [query, setQuery] = useState("")
  /**
   * ★ 三个 tab：全部 / 自动判断 / 草稿模式。
   *
   * 用户反馈的演进路径：
   * · 首版用互斥 tab（草稿 / 自动），"想抽查自动那批得先切过去，切过去
   *   草稿又看不见"——不成立；
   * · 改成两组同屏（都渲染），"两个都应该有"——但那样搜索/滚动都不能
   *   聚焦其中一类；
   * · 现在：**默认「全部」（分组渲染，两类同屏）**，另两个 tab 各自
   *   只显示一类（要专门抽查时用）。
   *
   * 默认 `all` 而不是 `draft`：多数情况下用户想扫完 = 直接看两类；
   * 只有想集中审草稿或只抽查自动时才切。
   */
  const [tab, setTab] = useState<"all" | "auto" | "yolo" | "draft">("all")

  /**
   * ★ 四档 tab 的数据切分。
   *
   * · `all`：**扁平混排**，按**最新消息时间**从新到旧排 ——
   *   用户反馈"全部 tab 里不用混着草稿/自动的分区"，也要求侧栏顺序就是
   *   最新消息的顺序（与钉钉等 IM 一致：谁刚来消息谁在最上面）；
   * · `auto` / `yolo` / `draft`：从 `all` 里按**实际行为**过滤出对应那类，
   *   排序同上。
   *
   * ★ 三类**互斥**：`replyMode` 三档一一对应，一个会话只落一处。
   * 刻意不让「直出」同时出现在「自动」里 —— 那会让三个 tab 的条数加起来
   * 大于总数，而用户会拿它们当分区看（"我有几个会话在自动发"这个问题
   * 需要一个确定的答案）。"会自动发的总数"由 `全部` 与设置页回答。
   */
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const match = (item: PersonaConversationView) => {
      if (needle === "") return true
      /**
       * 搜标题**与最新一条正文**。
       *
       * 只搜标题的话"我记得有人提过沙箱"这种查法搜不到 —— 而那正是
       * 用户会用搜索的场合（记得内容、忘了在哪个群）。
       */
      const haystack = `${item.title ?? item.externalId}\n${item.lastMessageText ?? ""}`
      return haystack.toLowerCase().includes(needle)
    }
    /**
     * ★ 纯按最新消息时间从新到旧 —— 侧栏顺序 = 消息新旧顺序。
     *
     * 原来是「草稿数 → 待处理 → 时间」三级：谁草稿多/未读多谁靠前，
     * 而那会让一个"三天前有 5 条草稿"的会话压在"一分钟前刚来消息"的上面，
     * 与用户对 IM 列表的直觉相反。草稿数/未读仍然在行上以角标呈现
     * （见 ConversationRow），不再参与排序。
     *
     * `lastMessageAt` 为 null（还没有任何消息）排到最后 —— 用 0 兜底。
     */
    const byRecency = (a: PersonaConversationView, b: PersonaConversationView) =>
      (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)

    const all: PersonaConversationView[] = []
    const draft: PersonaConversationView[] = []
    const auto: PersonaConversationView[] = []
    const yolo: PersonaConversationView[] = []
    for (const item of items) {
      if (!match(item)) continue
      all.push(item)
      // 三档互斥：直出单独一桶，不再混进 auto（见上面注释）
      if (item.replyMode === "yolo") yolo.push(item)
      else if (behavesAsAuto(item)) auto.push(item)
      else draft.push(item)
    }
    all.sort(byRecency)
    draft.sort(byRecency)
    auto.sort(byRecency)
    yolo.sort(byRecency)
    return { all, draft, auto, yolo }
  }, [items, query])

  const empty = groups.all.length === 0

  const renderRow = (item: PersonaConversationView) => (
    <li key={item.conversationId}>
      <ConversationRow
        item={item}
        active={item.conversationId === activeId}
        draftCount={draftCounts?.get(item.conversationId) ?? 0}
        peerAvatar={
          item.peerExternalId === null ? null : (avatarByPeer?.get(item.peerExternalId) ?? null)
        }
        onSelect={() => onSelect(item.conversationId)}
      />
    </li>
  )

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-[var(--border-divider-light)]">
      <div className="flex shrink-0 flex-col gap-2 px-3 py-2.5">
        {/*
          搜索框在最上面：它作用于下面的全部内容，而"过滤器在它作用的
          内容之上"是这一仓库里已经定过的规矩（见 facts-explorer 的文件头）。
        */}
        <Input
          size="sm"
          value={query}
          placeholder={t("railSearchPlaceholder")}
          aria-label={t("railSearchLabel")}
          onChange={(event) => setQuery(event.target.value)}
          leftIcon={<SearchIcon />}
          {...(query === ""
            ? {}
            : {
                suffix: (
                  <button
                    type="button"
                    aria-label={t("railSearchClear")}
                    onClick={() => setQuery("")}
                    className="typography-caption-400 px-1 text-[var(--text-base-tertiary)] transition-colors hover:text-[var(--text-base-primary)]"
                  >
                    ×
                  </button>
                ),
              })}
        />

        {/*
          ★ 四档 tab：全部 / 自动判断 / 直出 / 草稿模式。
          `all` 混排；切到单类时只渲染那一类的行，不再有分组标题
          （那时分类由 tab 自身表达，标题只是重复）。

          顺序沿用「按风险从低到高」的既有约定（见 labels.ts 的 MODE_ORDER）：
          全部 → 自动判断 → 直出 → 草稿模式里，`直出` 紧跟在 `自动判断` 之后，
          因为它是那一档的"更激进版本"，放在一起用户才好对比。
        */}
        <SegmentedControl
          value={tab}
          onChange={setTab}
          ariaLabel={t("railTabsLabel")}
          size="sm"
          block
          options={[
            { value: "all", label: t("railTabAll") },
            { value: "auto", label: t("railTabAuto2") },
            { value: "yolo", label: t("railTabYolo") },
            { value: "draft", label: t("railTabDraft2") },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <p className="typography-body-small-400 p-2 text-[var(--text-base-tertiary)]">
            {t("loading")}
          </p>
        ) : empty ||
          (tab === "auto" && groups.auto.length === 0) ||
          (tab === "yolo" && groups.yolo.length === 0) ||
          (tab === "draft" && groups.draft.length === 0) ? (
          <div className="flex flex-col gap-1 p-2">
            <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {/*
                空态四种：搜不到 / 没有会话 / 这一类是空。
                搜索优先说，其次单类为空，再次全空 —— 合成一句会让用户
                不知道该清搜索、切 tab 还是去授权。
              */}
              {query.trim() !== ""
                ? t("railNoMatch", { query: query.trim() })
                : items.length === 0
                  ? t("noConversations")
                  : tab === "auto"
                    ? t("railNoAuto")
                    : tab === "yolo"
                      ? t("railNoYolo")
                      : tab === "draft"
                        ? t("railNoDraft")
                        : t("noConversations")}
            </p>
            {items.length === 0 ? (
              <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
                {t("noConversationsHint")}
              </p>
            ) : null}
          </div>
        ) : tab === "all" ? (
          // ★ 「全部」不分组：直接按活跃度混排（草稿数 → 待处理 → 时间）——
          // 用户反馈"全部 tab 里不用混着草稿和自动判断的区分"。
          <ul className="flex flex-col gap-0.5">{groups.all.map(renderRow)}</ul>
        ) : (
          // 单类 tab：也是一列 —— tab 本身表达了这是哪一类
          <ul className="flex flex-col gap-0.5">
            {(tab === "auto" ? groups.auto : tab === "yolo" ? groups.yolo : groups.draft).map(
              renderRow,
            )}
          </ul>
        )}
      </div>
    </aside>
  )
}

/**
 * 徽标里的数字。
 *
 * ★ 超过 99 显示 `99+`：实测真实数据里有 353 未读的告警群，
 * 而一个三位数徽标会把会话标题挤掉 —— 那时用户连"这是哪个群"都看不出来了。
 * 精确到个位对"有很多没读"这个判断没有任何增量信息。
 */
export function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count)
}

/** 会话行：头像 + 名字/时间 + 最新一条 + 徽标。 */
function ConversationRow({
  item,
  active,
  draftCount,
  peerAvatar,
  onSelect,
}: {
  item: PersonaConversationView
  active: boolean
  draftCount: number
  /** 单聊对方的头像 URL；群聊与取不到时为 null（退回首字母色块） */
  peerAvatar: string | null
  onSelect: () => void
}) {
  const { t } = useDynamicTranslation("persona")

  /**
   * 预览文字：本人发的加「我：」前缀，群里别人发的加发送者名。
   *
   * ★ `lastMessageIsSelf` 是三态。`null`（身份还没确认）时**不加**前缀 ——
   * 那时我们确实不知道是谁发的，而猜错一半会比不说更让人困惑。
   *
   * ★ **图片/文件占位归一**：原始 `content_text` 是
   * `[图片消息](mediaId=$iwEcAqNqcGcDAATRA…)` —— 后面几十字 mediaId
   * 对用户没有任何意义，在窄窄的侧栏预览里正好把可读的部分挤没。
   * 归一成 `[图片]` / `[文件]` / `[语音]` / `[视频]`（与微信/钉钉
   * 一致的表达）。归一只在**这一层**做，不改 `content_text` 本身
   * （消息流里点开还能看 mediaId，那是排查用的）。
   */
  const preview = useMemo(() => {
    const text = summarizeForPreview(item.lastMessageText)
    if (text === null || text === "") return null
    if (item.lastMessageIsSelf === true) return t("railPreviewSelf", { text })
    // 单聊里对方名字就是会话标题，再写一遍是重复
    if (item.kind === "group" && item.lastMessageSender !== null) {
      return t("railPreviewSender", { sender: item.lastMessageSender, text })
    }
    return text
  }, [item.lastMessageText, item.lastMessageIsSelf, item.lastMessageSender, item.kind, t])

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-[var(--radius-md)] px-2 py-2 text-left",
        "transition-colors duration-150 hover:bg-[var(--overlay-on-container-hover)]",
        active ? "bg-[var(--overlay-on-container-selected)]" : "",
      )}
    >
      {/*
        ★ 单聊显示对方的真头像；群聊退回首字母色块。
        群聊不是"我们没做"—— 钉钉压根没有群头像字段（与它自己的行为一致）。
      */}
      <Avatar name={item.title ?? item.externalId} src={peerAvatar ?? null} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* 第一行：名字 + 时间（时间靠右，那是 IM 侧栏的固定位置） */}
        <span className="flex items-baseline gap-2">
          <span className="typography-body-small-400 min-w-0 flex-1 truncate text-[var(--text-base-primary)]">
            {item.title ?? item.externalId}
          </span>
          {item.lastMessageAt === null ? null : (
            <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
              {formatRailTime(item.lastMessageAt)}
            </span>
          )}
        </span>
        {/* 第二行：最新一条 + 徽标。徽标与预览同一行 —— 竖着堆会让每行占三行高 */}
        <span className="flex items-center gap-1.5">
          <span className="typography-caption-400 min-w-0 flex-1 truncate text-[var(--text-base-tertiary)]">
            {preview ?? t("railNoMessages")}
          </span>
          {/*
            三个徽标，含义各不相同，所以视觉也必须不同：

            · **未读**（accent 实心）—— **我**还没读（钉钉的红点）；
            · 草稿（info 浅底）—— 数字人已经写好了等你审；
            · 待处理（error 实心）—— 数字人还没跑，等调度。

            合成一个数字会让"有 3 条我没看"、"有 3 条要审"、"有 3 条还没跑"
            看起来一样，而这三件事的下一步动作完全不同。
          */}
          {item.unreadCount > 0 ? (
            <span
              className="typography-caption-400 font-medium shrink-0 rounded-full bg-[var(--text-accent-normal)] px-1.5 text-[var(--theme-white-white-100)]"
              title={t("unreadBadgeHint")}
            >
              {formatBadgeCount(item.unreadCount)}
            </span>
          ) : null}
          {draftCount > 0 ? (
            <span
              className="typography-caption-400 shrink-0 rounded-full bg-[var(--status-fill-info-container)] px-1.5 text-[var(--status-link)]"
              title={t("draftBadgeHint")}
            >
              {t("draftBadge", { count: draftCount })}
            </span>
          ) : null}
          {item.unreadForPersona > 0 ? (
            <span
              className="typography-caption-400 shrink-0 rounded-full bg-[var(--status-error)] px-1.5 text-[var(--theme-white-white-100)]"
              title={t("pendingBadgeHint")}
            >
              {formatBadgeCount(item.unreadForPersona)}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 把富媒体消息的原始 `content_text` 归一成侧栏能读的一句话。
 *
 * ## ★ 为什么要在这里做，而不是在采集层
 *
 * 采集层的 `content_text` 是**其它地方**的输入 —— 蒸馏用它做统计，
 * FTS 用它建索引，消息流点开也要能看到里面的 mediaId（排查"这条图片
 * 到底是哪一份"）。改那一层等于让所有下游一起丢信息。
 *
 * 而侧栏预览是**给人看的一句话**，几十字宽的位置装不下一个 mediaId。
 * 所以只在这一层归一。
 *
 * ## 判据
 *
 * 上游归一后的形态（见 `content-extract.ts`）：
 * · `[图片消息](mediaId=...)` / `[文件消息](mediaId=...)` /
 *   `[语音消息](mediaId=...)` / `[视频消息](mediaId=...)`
 *
 * 提取占位 + 混排的文字部分：`前文 [图片消息](...) 后文` → `前文 [图片] 后文`。
 * 全靠**正则替换那段带 mediaId 的括号**，不做 markdown 解析
 * （这里不是渲染，是压缩摘要）。
 */
const MEDIA_PLACEHOLDER = /\[(图片|文件|语音|视频)消息\]\(mediaId=[^)]*\)/g
const PREVIEW_LABEL: Record<string, string> = {
  图片: "[图片]",
  文件: "[文件]",
  语音: "[语音]",
  视频: "[视频]",
}

export function summarizeForPreview(text: string | null): string | null {
  if (text === null) return null
  const cleaned = text
    .replace(MEDIA_PLACEHOLDER, (_full, kind: string) => PREVIEW_LABEL[kind] ?? `[${kind}]`)
    // 折叠连续空白（占位替换后可能留双空格）
    .replace(/\s+/g, " ")
    .trim()
  return cleaned === "" ? null : cleaned
}
