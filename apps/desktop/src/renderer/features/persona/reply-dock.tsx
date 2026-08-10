/**
 * ReplyDock —— 消息流底部的回复区。
 *
 * ## ★ 它替掉的是「处理结果 / 待处理草稿」那种表单式样式
 *
 * 原来这一块是：一个 `待审草稿（N）` 标题 + 一句边界说明 + 一列草稿卡，
 * 每张卡里又有署名、正文、原因、四个按钮。也就是**一张表单**，
 * 而它所在的位置是一个聊天窗口的底部 —— 那里应该是"我要发什么"。
 *
 * 现在：**一条 tab 栏 + 一个输入区**，与任何 IM 的形态一致。
 * tab 栏回答"有几个候选"，输入区回答"发什么"。
 *
 * ## tab 有三类，顺序固定
 *
 * 1. **正在处理**（`generating`）—— 有在途的那一轮时排最前。
 *    它是唯一会自己变化的 tab，放最前是因为用户在等它。
 *    点开能看到"正在基于哪几条消息起草"（详情），那是把一个
 *    几秒到几十秒的黑箱变成可观察的过程。
 * 2. **草稿**（最多 10 条，最新在前）—— 模型写好等审的。
 * 3. **新建**（永远存在）—— 用户自己写。没有草稿时它是默认选中的那个，
 *    于是这一块在"什么都没有"的时候看起来就是一个普通的输入框
 *    （而不是一个写着"暂无草稿"的空状态卡）。
 *
 * ## ★ 为什么草稿上限是 10 条
 *
 * 用户要的。理由也成立：草稿是对**某一轮对话**的回复，而第 11 条草稿
 * 对应的那段对话早就被后面的消息盖过去了 —— 发出去会答非所问。
 * 超出的标记失效（`expired`）而不是删掉：那是"它曾经生成过"的记录，
 * 排查"为什么这条没发"时要用。
 *
 * ★ 上限在**渲染层**判（`DRAFT_TAB_LIMIT`）而不是后端：后端的
 * `pendingDrafts` 是全局的、跨会话的，而"最多留 N 个 tab"是这一个
 * 会话里的显示决定。后端那一路现在按 `maxDraftsPerConversation` 给每会话
 * **数量封顶**（默认 3，超出按最旧的先裁 —— 见 persona repo 的
 * `trimDraftsBeyondCap`），加上"本人已回过就作废"这一条语义过期；
 * 这里的 `DRAFT_TAB_LIMIT` 只是再兜一个**渲染上限**，防止后端上限被调很高时
 * tab 栏被撑爆。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button, Tag, cn } from "@mycontext/design"
import type { PersonaDraftView } from "@mycontext/ipc-contract"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { usePersonaTrace } from "../../lib/queries.js"
import { EventStream } from "../agent-stream/event-stream.js"
import { toChatItems } from "../agent-stream/to-chat-items.js"
import { ChevronDownIcon } from "../agent-stream/tool-icons.js"
import { RunTraceDialog } from "./run-trace-dialog.js"
import { PersonaSignature } from "./persona-signature.js"
import { explainDecisionReason, type ReasonKind } from "./decision-reason.js"

/**
 * 最多显示几个草稿 tab。见文件头。
 *
 * 11 个 tab 在 300px 的 tab 栏里必然要滚动，而"要横向滚才能看到全部候选"
 * 意味着后面那些永远不会被点 —— 那时它们不如不显示。
 */
export const DRAFT_TAB_LIMIT = 10
const DRAFT_HANDOFF_TIMEOUT_MS = 2_000

/** reason 的性质 → Tag 的状态色。`not-built` 用中性色：那不是用户的错。 */
const KIND_STATUS: Record<ReasonKind, "warning" | "default" | "accent"> = {
  actionable: "warning",
  "not-built": "default",
  "by-design": "accent",
}

export interface ReplyDockProps {
  /**
   * 当前会话 —— 订阅这个会话的 agent 过程流（见 GeneratingPanel）。
   *
   * 可空：这一块在"还没选中任何会话"时也会渲染（那时不订阅任何流）。
   */
  conversationId: string | null
  drafts: readonly PersonaDraftView[]
  /** 在途那一轮正在处理的消息 id（空 = 没有在途） */
  generatingIds: readonly string[]
  /** 在途那一轮什么时候开始的（用来显示"已经跑了几秒"） */
  generatingSince: number | null
  busy: boolean
  errorText: string | null
  /**
   * 别的会话里还有多少草稿。
   *
   * ★ 必须显示：顶栏报的是**全局**草稿数，这一块只显示当前会话的。
   * 不说的话"草稿 0"与顶栏的"13"就是一对矛盾的数字，
   * 而用户无从知道另外那些在哪 —— 他会以为草稿丢了。
   */
  otherCount?: number
  onResolve: (input: { draftId: string; action: "send" | "discard"; editedText?: string }) => void
  /** 用户自己写一条直接发 */
  onCompose: (text: string) => void
  /** 点"看引用"时把 message_id 交给消息流去滚动 + 高亮 */
  onShowCitations: (messageIds: readonly string[]) => void
}

type TabKey = { kind: "generating" } | { kind: "draft"; id: string } | { kind: "compose" }

export function ReplyDock({
  conversationId,
  drafts,
  generatingIds,
  generatingSince,
  busy,
  errorText,
  otherCount = 0,
  onResolve,
  onCompose,
  onShowCitations,
}: ReplyDockProps) {
  const { t } = useDynamicTranslation("persona")
  const generating = generatingIds.length > 0

  /**
   * 显示哪些草稿：按新→旧，最多 10 条。
   *
   * 排序键是 `createdAt` 降序 —— 最新那条对应的是最近的对话，
   * 也是最可能真的要发的那个。
   */
  const visible = useMemo(
    () => [...drafts].sort((a, b) => b.createdAt - a.createdAt).slice(0, DRAFT_TAB_LIMIT),
    [drafts],
  )
  const overflow = drafts.length - visible.length
  /**
   * 本轮生成开始前已经存在的草稿。
   *
   * 快照里的 `generating` 会先结束，草稿 query 随后才刷新。只拿
   * `visible[0]` 会在这段交接期误选上一轮的旧草稿；记住基线后才能
   * 精确找到这一轮新增加的那条。
   */
  const draftIdsAtGenerationStartRef = useRef(
    new Set(generating ? drafts.map((draft) => draft.id) : []),
  )
  const wasGeneratingRef = useRef(generating)

  /**
   * ★ 有草稿时默认选**最新那条**；没有才落到「新建」。
   *
   * 首版无条件默认 `compose`，而那让"有草稿要审"这件事在打开会话时
   * **看不见** —— 用户看到的是一个空输入框，草稿藏在一个他没点的 tab 后面。
   * 那正好把这一页的主要动作（审草稿）藏起来了。
   *
   * 用 `useState` 的初值而不是 effect：effect 会在第一帧之后才跑，
   * 那一帧显示的是 compose，于是打开会话时能看到一次闪动。
   */
  const [active, setActive] = useState<TabKey>(() => {
    const newest = [...drafts].sort((a, b) => b.createdAt - a.createdAt)[0]
    return newest === undefined ? { kind: "compose" } : { kind: "draft", id: newest.id }
  })
  /**
   * 用户手动点过 tab 了吗。
   *
   * ★ 它决定"草稿晚到"时要不要自动切过去。挂载时草稿常常还没到
   * （`usePersonaDrafts` 是独立的 query），于是初值那一段拿到的是空列表
   * → 落到 compose。草稿到了之后：
   *
   * · 用户还没碰过 tab → **切过去**（那是他打开这个会话想看的东西）；
   * · 用户已经点过（包括切到「新建」开始打字）→ **不动**。
   *
   * 少了这个标记只有两种坏结果：不自动切 = 草稿又被藏起来；
   * 无条件自动切 = 用户正在写的东西被一条新草稿抢走焦点。
   */
  const touchedRef = useRef(false)
  const pick = (next: TabKey) => {
    touchedRef.current = true
    setActive(next)
  }

  /**
   * 上一次渲染时是否在生成中 —— 供"生成刚结束"的自动跳转用。
   *
   * ★ 不能复用 `wasGeneratingRef`：那个在下面那个 effect 里就被更新成当前值了
   * （effect 按声明序跑），到自动跳转的 effect 里读它已经等于 `generating`，
   * "true→false 这次跳变"永远测不出来。所以单独一个、且在**自动跳转那个
   * effect 的末尾**才更新。
   */
  const prevGeneratingRef = useRef(generating)

  useEffect(() => {
    if (generating && !wasGeneratingRef.current) {
      draftIdsAtGenerationStartRef.current = new Set(drafts.map((draft) => draft.id))
    }
    wasGeneratingRef.current = generating
  }, [drafts, generating])

  /**
   * ★ 选中项要跟着数据走，但**不能**每次刷新都跳。
   *
   * 三条规则：
   * · 选中的草稿被发了/丢了（不在列表里了）→ 落到第一条草稿，没有则落到新建；
   * · 用户停在「新建」而**新草稿到了** → 不动（他正在打字）；
   * · 在途开始时也不抢焦点 —— 那会打断正在编辑的人。
   *
   * 反过来（每次都自动选最新草稿）在这一页是灾难：快照每几秒推一次，
   * 而用户一边读草稿一边被切走。
   */
  useEffect(() => {
    /**
     * ★ 本轮生成刚结束（generating: true→false）时，如果冒出了基线之外的**新草稿**，
     * 就跳过去 —— 无论当前停在哪个 tab。
     *
     * 这修的是："正在看某条草稿的历史时，新一轮生成完成后停在旧草稿上不动"。
     * 原来这段自动跳转只在 `active.kind === "generating"` 分支里做，于是用户
     * 若停在具体某条草稿 tab（看历史），下面那句 `visible.some(...id===active.id)`
     * 会因为旧草稿还在列表里而 return，新完成的草稿被藏起来 —— 看着像"没反应"。
     *
     * 例外沿用既有取舍：用户在生成期间切到「新建」正在打字（compose + touched）
     * 时不抢焦点。看草稿历史不算"正在打字"，所以照跳。
     */
    if (prevGeneratingRef.current && !generating) {
      const composing = active.kind === "compose" && touchedRef.current
      if (!composing) {
        const completedDraft = visible.find(
          (draft) => !draftIdsAtGenerationStartRef.current.has(draft.id),
        )
        if (completedDraft !== undefined) {
          prevGeneratingRef.current = generating
          setActive({ kind: "draft", id: completedDraft.id })
          return
        }
      }
    }
    prevGeneratingRef.current = generating

    if (active.kind === "generating") {
      if (generating) return

      const completedDraft = visible.find(
        (draft) => !draftIdsAtGenerationStartRef.current.has(draft.id),
      )
      if (completedDraft !== undefined) {
        setActive({ kind: "draft", id: completedDraft.id })
        return
      }

      /**
       * 生成可能以自动发送、静默或失败结束，那些情况不会产生新草稿。
       * 给草稿 query 一个很短的交接窗口；超时后才回到已有草稿或「新建」，
       * 避免一个永远存在但不可见的 generating 状态。
       */
      const timer = window.setTimeout(() => {
        const first = visible[0]
        setActive(first === undefined ? { kind: "compose" } : { kind: "draft", id: first.id })
      }, DRAFT_HANDOFF_TIMEOUT_MS)
      return () => window.clearTimeout(timer)
    }

    if (active.kind !== "draft") {
      /**
       * 停在「新建」而草稿**刚到**（挂载时它还没到）→ 切过去，
       * 但只在用户没碰过 tab 的时候（见 `touchedRef`）。
       */
      if (active.kind === "compose" && !touchedRef.current) {
        const first = visible[0]
        if (first !== undefined) setActive({ kind: "draft", id: first.id })
      }
      return
    }
    if (visible.some((draft) => draft.id === active.id)) return
    const first = visible[0]
    setActive(first === undefined ? { kind: "compose" } : { kind: "draft", id: first.id })
  }, [active, generating, visible])

  const activeDraft =
    active.kind === "draft" ? visible.find((draft) => draft.id === active.id) : undefined
  // 交接完成前保留 tab，避免快照先结束时 tab 突然消失、内容却仍显示过程事件。
  const showGeneratingTab = generating || active.kind === "generating"

  return (
    <div className="flex shrink-0 flex-col border-t border-[var(--border-divider-light)] bg-[var(--bg-card-z1)]">
      {/*
        ── tab 栏 ──────────────────────────────────────────
        ★ 灵巧的横条，**搭在**输入框上方（用户反馈"tab 那些切换能灵巧
        一点搭在输入框上方，样式轻量一点"）：
        · 不再有 padding-top（贴顶），底部去掉 border/bg，让它与
          下方的输入内容视觉连成一块；
        · tab 本身用 caption 号 + 圆角小气泡 —— 而不是原来的
          "font-medium + 卡片底色 + 阴影"那种沉重的段控件。
      */}
      <div
        role="tablist"
        aria-label={t("dockTabsLabel")}
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-3 pt-1.5"
      >
        {/*
          ★ 「正在处理」排最前且带脉冲点。
          它是唯一会自己变的 tab，而用户在等它 —— 放在最后会让人
          以为什么都没发生（那正是"很塑料"那类反馈的来源）。
        */}
        {showGeneratingTab ? (
          <TabButton
            selected={active.kind === "generating"}
            onSelect={() => pick({ kind: "generating" })}
            tone="live"
          >
            <span className="flex items-center gap-1.5">
              <span
                className="size-1.5 animate-pulse rounded-full bg-[var(--text-accent-normal)]"
                aria-hidden
              />
              {t("dockTabGenerating")}
            </span>
          </TabButton>
        ) : null}

        {visible.map((draft, index) => (
          <TabButton
            key={draft.id}
            selected={active.kind === "draft" && active.id === draft.id}
            onSelect={() => pick({ kind: "draft", id: draft.id })}
          >
            {t("dockTabDraft", { index: index + 1 })}
          </TabButton>
        ))}

        <TabButton selected={active.kind === "compose"} onSelect={() => pick({ kind: "compose" })}>
          {t("dockTabCompose")}
        </TabButton>

        {/* 被挤出去的草稿说一声（不是静默丢掉） */}
        {overflow > 0 ? (
          <span
            className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]"
            title={t("dockOverflowHint")}
          >
            {t("dockOverflow", { count: overflow })}
          </span>
        ) : null}
        {otherCount > 0 ? (
          <span className="typography-caption-400 ml-auto shrink-0 text-[var(--text-base-tertiary)]">
            {t("draftsElsewhere", { count: otherCount })}
          </span>
        ) : null}
      </div>

      {errorText === null ? null : (
        <p className="typography-caption-400 px-3 pt-1 text-[var(--status-error)]">{errorText}</p>
      )}

      {/* ── 内容区 ───────────────────────────────────────── */}
      <div className="px-3 pb-3 pt-1.5">
        {active.kind === "generating" ? (
          <GeneratingPanel
            conversationId={conversationId}
            messageIds={generatingIds}
            since={generatingSince}
            onShowCitations={onShowCitations}
          />
        ) : activeDraft !== undefined ? (
          <DraftPanel
            /**
             * ★ `key` 必须带 draftId：切 tab 时要**换一个**编辑态，
             * 而不是把上一条的编辑内容留在输入框里。
             * 不给 key 的话 React 复用同一个实例，于是切到草稿 2
             * 看到的是草稿 1 被改过的正文 —— 然后发出去。
             */
            key={activeDraft.id}
            draft={activeDraft}
            busy={busy}
            onResolve={onResolve}
            onShowCitations={onShowCitations}
          />
        ) : (
          <ComposePanel busy={busy} onCompose={onCompose} />
        )}
      </div>
    </div>
  )
}

/**
 * 一个 tab —— 灵巧的小 chip，不再是 sheet-style 的段控件。
 *
 * ## ★ 视觉：选中态**用下划线加重**，不用色块
 *
 * 用户反馈"tab 那些切换能灵巧一点搭在输入框上方，样式轻量一点"。
 * 首版是"选中项换底色 + 加粗 + 阴影"—— 那让整条 tab 栏有厚度，
 * 且未选那些看起来像"另外一档灰按钮"。
 *
 * 现在选中项用**下划线 + primary 色**（tab 栏的经典表达，
 * 与浏览器 tab 一致），未选是 tertiary 灰文字。整条栏没有背景色，
 * 视觉上"搭"在下方的输入内容之上，而不是自成一块。
 *
 * `live` 那档在**未选**时用强调色文字提醒"这里在动" ——
 * 选中时回落到通用样式（选中态本身已经足够醒目）。
 */
function TabButton({
  selected,
  onSelect,
  tone = "normal",
  children,
}: {
  selected: boolean
  onSelect: () => void
  tone?: "normal" | "live"
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "typography-caption-400 relative shrink-0 px-2 py-1.5 transition-colors duration-150",
        // 选中：下方两像素条 + primary 文字（无底色）
        selected
          ? "font-medium text-[var(--text-base-primary)] after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-t-[2px] after:bg-[var(--text-accent-normal)]"
          : "text-[var(--text-base-tertiary)] hover:text-[var(--text-base-primary)]",
        tone === "live" && !selected ? "text-[var(--text-accent-normal)]" : "",
      )}
    >
      {children}
    </button>
  )
}

/**
 * 在途那一轮的详情。
 *
 * ## ★ 为什么"正在处理"需要一个面板而不只是一个转圈
 *
 * 一轮是几秒到几十秒（要跑 ACP session + 模型）。只给转圈的话用户
 * 无法判断它是在干活还是卡住了 —— 而这两件事的下一步完全不同
 * （等 vs 点「立即处理」重试）。
 *
 * ## ★ 显示的是 agent 的**真实过程**，不是一句静态说明
 *
 * 这里曾经挂着一句写死的话（「要跑一次会话 agent（读上下文 + 检索事实 +
 * 生成），几秒到几十秒。」）。它描述的是**概念**，每一轮都一样，
 * 所以对"这一轮到底在干什么"零信息 —— 那正是"没有意义的纯文本"。
 *
 * 现在挂 `EventStream`（与搜索模块共用）：thinking、正文、tool 调用组
 * 逐条滚出来。这些事件 `mapSessionUpdate` 一直在产，只是过去在
 * `persona-acp.ts` 的 `textOf()` 里被丢成空串了。
 *
 * 仍然给两件可核对的事实：**跑了多久**、**在基于哪几条消息**（可点，
 * 点了消息流滚到那几条并高亮，于是用户能自己判断"它读的是对的那段对话吗"）。
 */
function GeneratingPanel({
  conversationId,
  messageIds,
  since,
  onShowCitations,
}: {
  conversationId: string | null
  messageIds: readonly string[]
  since: number | null
  onShowCitations: (ids: readonly string[]) => void
}) {
  const { t } = useDynamicTranslation("persona")
  /**
   * 已经跑了多久 —— 每秒自己走一格。
   *
   * 用本地 tick 而不是等快照推送：快照几秒一次，而一个"已经 3 秒"的
   * 数字停住不动会让人以为界面卡了（那正是它要回答的问题的反面）。
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = since === null ? null : Math.max(0, Math.round((now - since) / 1000))
  // agent 的真实过程（thinking / 正文 / tool 调用），随事件实时来。
  const trace = usePersonaTrace(conversationId)
  const items = useMemo(() => toChatItems(trace.items), [trace.items])
  /**
   * 跟随滚动的依赖。
   *
   * ★ **不能用 `items.length`** —— thinking 是流式**追加进同一个 item** 的，
   * 一段几百字的思考从头到尾 `length` 都是 1。用它做依赖的话跟随只在
   * "新增一个块"时触发，而那恰好错过了最需要跟随的那段（一个块内部
   * 持续变长）。所以取**总字符数**：它随每个 delta 变，才是"内容长了"的真身。
   */
  const traceLength = useMemo(
    () => items.reduce((sum, item) => sum + JSON.stringify(item).length, 0),
    [items],
  )
  const scrollRef = useStickToBottom(traceLength)

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--bg-base-normal)] p-3">
      <span className="typography-body-small-400 flex flex-wrap items-center gap-2 text-[var(--text-base-primary)]">
        <span className="flex items-center gap-1.5">
          <span
            className="size-2 animate-pulse rounded-full bg-[var(--text-accent-normal)]"
            aria-hidden
          />
          {t("dockGeneratingTitle", { count: messageIds.length })}
        </span>
        {seconds === null ? null : (
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("dockGeneratingElapsed", { seconds })}
          </span>
        )}
      </span>
      {/*
        ★ 真实过程。`busy` 让"还没有任何输出"的那几秒显示思考中指示器
        （实测首字要 ~3.8s，空白不给反馈会被当成卡死）；一旦有了 item
        它自己就不显示了（见 EventStream 里那段判据）。

        ## ★★ 必须**限高 + 内滚**，否则这一块会把消息流挤出屏幕

        用户报的「起草时看思考过程无法正常滚动」就是这里：整条 dock 是
        `shrink-0`（见本文件 270 行那个容器 —— 它不该被消息流压缩），
        而这一段过去**没有任何高度上限**。于是 thinking 越长 dock 越高，
        把上面的对话一路顶出可视区，而它自己又不是滚动容器 ——
        用户既滚不动这段过程，也看不见刚才的消息。

        与 `ComposePanel` 同一套判据（见 `COMPOSE_MAX_PX` 上方那段）：
        限一个最大高度，超了**内部滚动**，而不是 auto-grow 到几屏高。
        `overscroll-contain` 让滚到底时不把滚动甩给背后的消息流 ——
        否则用户想再看一行 thinking，结果整条对话跳走了。

        ★ 限高**只加在这里**，不加进 `EventStream`：那个组件是与搜索模块
        共用的（见它的文件头），搜索那一侧占的是整个中栏，限高会把它
        变成一个 240px 的小窗口。高度约束属于**布局**，归各自的调用方。
      */}
      <div
        ref={scrollRef}
        className="min-h-0 overflow-y-auto overscroll-contain"
        style={{ maxHeight: `${String(TRACE_MAX_PX)}px` }}
      >
        <EventStream items={items} busy />
      </div>
      {messageIds.length === 0 ? null : (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => onShowCitations(messageIds)}
          title={t("dockGeneratingShowHint")}
        >
          {t("dockGeneratingShow", { count: messageIds.length })}
        </Button>
      )}
    </div>
  )
}

/**
 * 一条草稿：署名 + 可编辑正文 + 为什么没自动发 + 动作。
 *
 * 与原来的 `DraftCard` 同一套逻辑（那些注释都还成立），差别只在
 * 它现在是**tab 的内容**而不是列表里的一张卡 —— 所以不再需要
 * 卡片边框（tab 已经表达了边界），正文区改成常驻可编辑
 * （原来要先点「编辑」，而绝大多数草稿都是"意思对，改两个字"）。
 */
function DraftPanel({
  draft,
  busy,
  onResolve,
  onShowCitations,
}: {
  draft: PersonaDraftView
  busy: boolean
  onResolve: ReplyDockProps["onResolve"]
  onShowCitations: ReplyDockProps["onShowCitations"]
}) {
  const { t } = useDynamicTranslation("persona")
  const base = draft.editedText ?? draft.text
  const [text, setText] = useState(base)
  /** 回看过程的弹窗开着没有（见下面那个入口的注释）。 */
  const [traceOpen, setTraceOpen] = useState(false)
  const explained = explainDecisionReason(draft.notSentReason)
  const dirty = text.trim() !== base.trim()
  const sendText = text.trim()

  return (
    <div className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        {/*
          ★ 署名在正文**之前**：用户读到这句话时就该已经知道"这不是我写的"。
          放在底部的话他会先把它当自己的草稿读一遍。
        */}
        <PersonaSignature />
        {dirty ? (
          <Tag size="sm" status="accent">
            {t("draftEdited")}
          </Tag>
        ) : null}
      </span>

      {/*
        ★ 正文常驻可编辑（不再需要先点「编辑」）。

        原来是"只读 + 一个编辑按钮"，而实测绝大多数草稿都要改两个字 ——
        那个按钮是每次都要点的一步。做成 textarea 之后它就是一个
        聊天输入框，与「新建」那一档形态一致。
      */}
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        aria-label={t("dockDraftEditLabel")}
        className={cn(
          "typography-body-small-400 w-full resize-y rounded-[var(--radius-md)] px-2.5 py-2",
          "border border-[var(--border-medium)] bg-[var(--bg-base-normal)] text-[var(--text-base-primary)]",
          "focus-visible:border-[var(--border-focus)] focus-visible:shadow-[var(--shadow-focus-ring)] focus-visible:outline-none",
        )}
      />

      {/*
        为什么没自动发。两种形态分开渲染（见 decision-reason.ts）：
        已知枚举翻成人话 + 给下一步；判定层给的那句话原样显示
        （它本来就是人话，而套一句"需要确认"什么也没说）。
      */}
      {draft.notSentReason === null ? null : explained === null ? (
        <span className="typography-caption-400 text-[var(--text-base-secondary)]">
          {t("reviewWhy", { reason: draft.notSentReason })}
        </span>
      ) : (
        <span className="typography-caption-400 flex flex-wrap items-center gap-1.5">
          <Tag size="sm" status={KIND_STATUS[explained.kind]}>
            {t(`reasonKind.${explained.kind}`)}
          </Tag>
          <span className="text-[var(--text-base-secondary)]">{t(explained.labelKey)}</span>
          {explained.actionKey === undefined ? null : (
            <span className="text-[var(--text-accent-normal)]">
              {t("nextStep", { action: t(explained.actionKey) })}
            </span>
          )}
        </span>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={busy || sendText === ""}
          onClick={() =>
            onResolve({
              draftId: draft.id,
              action: "send",
              // 只在真改过时传 —— 恒传会让每条都被记成"用户编辑过"
              ...(dirty ? { editedText: sendText } : {}),
            })
          }
        >
          {dirty ? t("sendEdited") : t("send")}
        </Button>
        {/* 引用可点：这是判断"它是不是在瞎编"的唯一手段 */}
        {draft.citations.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onShowCitations(draft.citations)}
            title={t("citationsHint")}
          >
            {t("citations", { count: draft.citations.length })}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onResolve({ draftId: draft.id, action: "discard" })}
          className="ml-auto"
        >
          {t("discard")}
        </Button>
      </div>

      {/*
        ★ 回看这条草稿是怎么想出来的 —— 一个**弹窗**，不是就地展开。

        ## 为什么不能就地展开

        这一块的主任务是**审正文**，而回看过程是次要的。原来它是一个折叠块，
        展开后把 trace（thinking + 正文 + 一列工具调用）铺在草稿下面，
        于是发送按钮被推到屏幕外 —— 用户要一边滚回去找按钮一边记着刚看到什么。
        而这一块住在消息流底部一个 `shrink-0` 的条里，它本来就不该变高。

        弹窗把两个任务分开：审在这里，回看在那里，看完关掉回到原位。
        `runId` 为 null（用户自己写的那条 / 老库里的草稿）时**入口都不给** ——
        显示一个点了只会说"没有过程"的按钮比不显示更糟。

        ★ 弹窗**只在打开时才挂载**：它的两个查询以 `open` 当 enabled，
        而一屏可能有 10 个草稿 tab —— 各预取一遍是白花的库查询。
      */}
      {draft.runId === null ? null : (
        <>
          <button
            type="button"
            onClick={() => setTraceOpen(true)}
            className={cn(
              "typography-caption-400 flex items-center gap-1 self-start",
              "-mx-1 rounded-[var(--radius-sm)] px-1 py-0.5",
              "text-[var(--text-base-tertiary)] transition-colors duration-150",
              "hover:bg-[var(--overlay-on-container-hover)] hover:text-[var(--text-base-secondary)]",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
            )}
          >
            {t("dockTraceShow")}
            <ChevronDownIcon className="size-3 shrink-0 -rotate-90" />
          </button>
          {traceOpen ? (
            <RunTraceDialog
              runId={draft.runId}
              open
              onClose={() => setTraceOpen(false)}
              /**
               * ★ 不传 `resultText`：用户眼前正在审的就是这条草稿，
               * 在弹窗里再抄一遍是同一句话说两次。
               * 也不传 `kindLabel` —— 它还没发出去，没有"来源"可言。
               */
              occurredAt={draft.createdAt}
            />
          ) : null}
        </>
      )}
      {/*
        ★ 边界必须说清：点「发送」是**真的以本人身份发出去**。
        放在按钮下面而不是这一块顶部：它解释的是那个按钮。
      */}
      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">{t("sendBoundary")}</p>
    </div>
  )
}

/**
 * 生成过程那一段的最大高度（px）。
 *
 * ## ★ 为什么比输入框（`COMPOSE_MAX_PX` = 240）矮
 *
 * 这一块住在消息流**底部**，它占多少就从对话里拿走多少。而这一段是
 * **过程**、上面的对话才是用户要回复的东西 —— 过程不该比它解释的对话占得多。
 *
 * 200px 约等于 thinking 的 6–7 行，够看清"它现在在干什么"这一件事；
 * 想读完整经过有草稿卡上的「看生成过程」弹窗（那里是全屏级空间，
 * 见 `run-trace-dialog.tsx` 文件头为什么它必须是弹窗）。
 */
const TRACE_MAX_PX = 200

/**
 * 跟着最新事件走的滚动容器。
 *
 * ## ★★ 为什么限高之后**必须**加这个
 *
 * 限高把"看不见对话"换成了"看不见最新一行"：thinking 一直在追加，而滚动
 * 位置停在顶部，于是用户盯着一段静止的文字，以为它卡住了 —— 那正是这一块
 * 存在的理由的反面（它要回答的就是"它还在动吗"）。
 *
 * ## ★ 但用户往上翻时**不许**把他拽回底部
 *
 * 用户往上滚一定是在读刚才那几行。此时每来一个新事件就 `scrollTop = max`
 * 会让他读的那一行被抢走 —— 这个反模式在聊天界面里很常见，且比不自动滚更烦。
 *
 * 判据是"当前是不是贴着底"（留 24px 容差，覆盖行高不整与亚像素误差）：
 * 贴底 → 跟随；已经往上翻了 → 一动不动，等他自己滚回底部再恢复跟随。
 */
function useStickToBottom(dep: unknown): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  /**
   * ★ 用 layout effect 而不是 effect：要在**浏览器绘制之前**改 scrollTop，
   * 否则用户会看到一帧"跳到旧位置又弹到底"的闪动。
   */
  useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    // 贴底容差 24px —— 见函数注释
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 24
    if (atBottom) node.scrollTop = node.scrollHeight
  }, [dep])
  return ref
}

/**
 * 「新建」——用户自己写一条。
 *
 * ## ★ 它为什么永远在，而且没草稿时是默认
 *
 * 用户的原话是「没有草稿时，就是也可以默认是一个新建草稿的感觉
 * （一旦输入文本，也可以当做发送）」。
 *
 * 做成常驻 tab 的好处是这一块**不需要空状态**：没有草稿时它就是一个
 * 普通的聊天输入框，而不是一张写着"暂无草稿"的卡片。空状态卡在
 * 一个输入区的位置上是很怪的东西 —— 那个位置本来就该能输入。
 *
 * `Cmd/Ctrl + Enter` 发送，裸 Enter 换行：这一块是**多行**输入
 * （草稿常常是两三句），裸 Enter 发送会让人写不完第二行。
 */
/**
 * 「新建」——用户自己写一条，与正常聊天软件同尺寸的多行输入。
 *
 * ## ★ 用户澄清（第二次反馈）：不是输入框本身太厚重
 *
 * 用户澄清"tab 那些切换能灵巧一点搭在输入框上方，样式轻量一点，
 * 并不是说输入框本身太厚重，我还希望输入框是多行的，还可以有 scroll bar
 * 呢，超过了最大高度的话"。所以：
 *
 * · **多行**：默认三行，与钉钉/微信的输入框同量级；
 * · **超过最大高度出滚动条**，不再"自动增高到 8 行"（那还是把
 *   长文本铺开成一整屏输入框，读者要在几屏输入框里翻）；
 * · 键盘提示挂在发送按钮的 `title` 上，不占常驻一行。
 *
 * `resize: none` 依然保留：手动拉手柄跟输入框本身的 max-height 冲突
 * —— 让内滚做那件事就够了。
 */
const COMPOSE_MAX_PX = 240

function ComposePanel({ busy, onCompose }: { busy: boolean; onCompose: (text: string) => void }) {
  const { t } = useDynamicTranslation("persona")
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const sendText = text.trim()

  const submit = () => {
    if (sendText === "" || busy) return
    onCompose(sendText)
    /**
     * ★ 乐观清空。
     *
     * 发送失败时正文**没了**吗？没有 —— 失败会走 `errorText` 显示在
     * tab 栏下面，而用户可以重新写。这里选乐观清空是因为成功是常态，
     * 而"点了发送但输入框里还留着那句话"会让人不确定到底发没发。
     */
    setText("")
  }

  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault()
            submit()
          }
        }}
        // 默认 3 行，超过 max-height 时**内部滚动**（不 auto-grow）
        rows={3}
        placeholder={t("dockComposePlaceholder")}
        aria-label={t("dockComposeLabel")}
        style={{ maxHeight: `${COMPOSE_MAX_PX}px` }}
        className={cn(
          "typography-body-small-400 w-full flex-1 resize-none overflow-y-auto rounded-[var(--radius-md)] px-2.5 py-1.5",
          "border border-[var(--border-medium)] bg-[var(--bg-base-normal)] text-[var(--text-base-primary)]",
          "placeholder:text-[var(--text-base-tertiary)]",
          "focus-visible:border-[var(--border-focus)] focus-visible:shadow-[var(--shadow-focus-ring)] focus-visible:outline-none",
        )}
      />
      {/*
        ★ 键盘提示挂在按钮的 `title` 上，不再常驻一行灰字。
        原来那句 44 字的说明是"读一次就够"的知识 —— 用户在 hover 按钮时
        才会想"能不能不用鼠标"，那时才需要出现。
      */}
      <Button
        size="sm"
        disabled={busy || sendText === ""}
        onClick={submit}
        title={t("dockComposeHint")}
      >
        {t("dockComposeSend")}
      </Button>
    </div>
  )
}
