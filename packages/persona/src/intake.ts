/**
 * ① intake —— 「这一轮要回什么」。
 *
 * ## 这一层回答的问题
 *
 * · 合并同会话最近多久 / 多少条的新消息？
 * · 送给模型多长的上下文？
 * · 这一轮**有多新**（本人回过了吗 / 有更新消息吗 / 库落后多少）？
 *
 * 三个问题曾经分居三处：合批窗口在 `mailbox.ts`（3s/6s/30 条）、折成"一件事"
 * 的判据在 forge 的 `rules.json → policy.burst`（300s/12 条）、送进模型的
 * 条数硬编码在 service 里（30 条）。三个数字回答同一个问题的三个侧面，
 * 而**没有任何一处能回答"这一轮到底看了多少"**。
 *
 * 归到 `IntakePolicy` 一处之后顺带得到一个好处：compose 的输入变成完全
 * 确定的数据（`TurnRequest`），可以拿一个 fixture 单测出草稿 ——
 * 不用起库、不用起进程、不用起模型。
 *
 * ## ★ 为什么"装配上下文"属于收而不属于生成
 *
 * 因为它是**策略**，不是能力。"看多少条"与"合并多久"是同一个取舍的两面
 * （合得多就要看得多，否则模型会读到一串没有来由的话）。放在生成那边的话，
 * 这个取舍会被"prompt 怎么拼"的细节掩盖 —— 而它其实是产品决策。
 *
 * ## 这一层**没有** LLM，也没有子进程判断
 *
 * 全部是 SQL 加窗口算术。唯一的外部调用是媒体按需下载（IO，不是判断），
 * 而它失败时不影响这一轮 —— 只是 agent 看不到那张图，且在 transcript 里明示。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import {
  MessageRepository,
  ConversationRepository,
  type MessageRow,
  type SqliteDatabase,
} from "@mycontext/store"
import type { ContextMessage, TurnFreshness, TurnRequest } from "./contracts.js"
import { DEFAULT_BATCH_WINDOW_MS, MAX_BATCH_SIZE } from "./mailbox.js"

/**
 * 收消息这一层的**全部**窗口口径。
 *
 * ★ 一份配置，一处校验。加一个窗口参数只能加在这里 —— 这是让
 * "三个数字回答同一个问题"不再发生的结构性手段。
 */
export interface IntakePolicy {
  /** 最老那条至少等这么久（保证不会无限期攒着不回）。 */
  batchWindowMs: number
  /**
   * 最新那条至少静默这么久（保证不在对方打字中途插话）。
   *
   * 0 = 关掉这个判据。测试里压缩时间用；生产别设 0 —— 那退回了
   * "起草期间又来一条 → 草稿立刻作废"的老行为。
   */
  quietMs: number
  /** 一批最多几条。超出丢最早的并把条数报出来。 */
  maxBatchSize: number
  /**
   * 送进模型的上下文条数。
   *
   * ★ 与 `maxBatchSize` 是两件事：批次是"这一轮要回哪几条"，
   * 上下文是"为了读懂它们要看多少历史"。前者 30 条时后者必须 ≥30，
   * 否则模型会看到一串没有来由的话。
   */
  contextMessages: number
  /** 最多送几张图进 prompt。 */
  maxPromptImages: number
}

/**
 * 缺省口径。
 *
 * `batchWindowMs` / `maxBatchSize` 沿用 `mailbox.ts` 的既有常量。
 *
 * `contextMessages: 30` 是从 `persona.service.ts` 的硬编码搬来的，行为不变。
 *
 * ## ★★ `quietMs` **不再**沿用 mailbox 的 6 秒
 *
 * `mailbox.ts` 那个 6 秒的注释写着「它要覆盖**一轮起草的耗时**（实测 4-6 秒）」
 * —— 而那个实测**已经过期**（CLAUDE.md §4：注释里的实测结论有保质期）。
 * 库里现在的真实耗时是 **19-82 秒**（推理模型 + 每轮三五千 token）。
 *
 * 后果实测（2026-08-10 00:08 那段）：对方 15 秒内连发 4 条，本该合成一批
 * 回一次，实际产出**两条**独立回复（"确实" / "那你得谢谢我"）——
 * 因为第一批攒够 6 秒就开跑，而那一轮跑了 20 多秒，期间又来了 3 条。
 * 表现是**分身在追着回，每次只回到一个片段**。
 *
 * 所以提到 25 秒：它要覆盖 p50 量级的起草耗时，让"起草期间又来一条"
 * 从常态变回偶发。代价说清楚 —— **对方只发一条时，首次响应从 6 秒变成
 * 25 秒**。这是刻意的取舍：晚 20 秒的一条完整回复，好过 6 秒后的一句
 * 答非所问（后者还会再引出一轮追回）。
 *
 * ★ 没有取更长（比如 60 秒）：那已经超出"像人在打字"的范围，
 * 对方会觉得没人理。而真正的根治是"起草期间新消息作废这一轮并重新合批"，
 * 那是另一件事（见 `docs/persona-architecture.md`）。
 */
export const DEFAULT_INTAKE_POLICY: IntakePolicy = {
  batchWindowMs: DEFAULT_BATCH_WINDOW_MS,
  quietMs: 25_000,
  maxBatchSize: MAX_BATCH_SIZE,
  contextMessages: 30,
  maxPromptImages: 3,
}

/**
 * 媒体按需下载。
 *
 * ★ 窄回调而不是注入整个 MediaService：intake 只需要"把这几条的媒体下下来"
 * 这一个动作。给它整个 service 会顺带给它另存为、上传、头像批取 ——
 * 而那些与这一层无关，却让它多出三条不该有的依赖。
 *
 * 不提供时只用**已经在本地**的图（实测库里 13% 的图在本地），
 * 其余在 transcript 里标「（图片，未下载）」—— 降级明示，不静默。
 */
export type MediaDownloader = (messageIds: readonly string[]) => Promise<unknown>

export interface TurnAssemblerOptions {
  db: SqliteDatabase
  clock: Clock
  logger: Logger
  policy?: Partial<IntakePolicy>
  downloadMedia?: MediaDownloader
}

/**
 * 把「一批消息 id」装配成 `TurnRequest`。
 *
 * 调度（合批窗口、并发、LRU）仍在 `Mailbox` / `PersonaSupervisor`；
 * 这个类负责的是**批次拿到之后**那一段：改目标、取上下文、挂媒体、算新鲜度。
 */
export class TurnAssembler {
  private readonly policy: IntakePolicy

  constructor(private readonly options: TurnAssemblerOptions) {
    this.policy = { ...DEFAULT_INTAKE_POLICY, ...options.policy }
  }

  /** 这一层生效的口径（供 supervisor / wake 对齐同一份值）。 */
  get effectivePolicy(): IntakePolicy {
    return this.policy
  }

  /**
   * 装配一轮。返回 null = 这一批没法回（会话行没了 / 一条消息都查不到）。
   */
  async assemble(
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<TurnRequest | null> {
    const { db } = this.options
    const conversation = new ConversationRepository(db).findById(conversationId)
    if (conversation === null) return null

    const messages = new MessageRepository(db)
    const requestedTriggerId = messageIds.at(-1) ?? null
    let trigger = requestedTriggerId === null ? null : messages.findById(requestedTriggerId)

    /**
     * ★ 触发点过时了 → **改回最新那条**，而不是跳过这一轮。
     *
     * ## 为什么不能跳过
     *
     * 跳过看起来安全，实测是一个**消息丢失**的坑：`takeBatch` 取走这批时
     * `dh_inbox` 已经标成 `done`，而 `restore()` 只捞 `pending` 的。于是
     * "草稿被作废"之后那几条消息既不在草稿箱、也不在队列里 —— 实测形态：
     * 一串连发留下 4 条等回复的消息，本人一条没回，而系统永远不会再为它们起草。
     *
     * ## ★★ 这里修掉了一个已知的洞（原实现在 service 里，注释承认未修）
     *
     * 原来改目标时**不看 @提及**，而群聊的缺省触发模式是 `mention`
     * （要求被 @）。于是一个热闹的群里可能把目标改到一条**没有 @ 本人**的
     * 消息上，然后为它起草 —— 那既违背用户设的触发条件，也是在烧 token。
     *
     * 现在按**与准入闸相同的判据**找新目标：群聊且触发模式要求 @ 时，
     * 只认被 @ 的那些。判据同源是关键 —— 两处判据不同是最难查的那类 bug。
     */
    if (trigger !== null) {
      const newest = this.latestInboundAfter(conversationId, trigger.sentAt, {
        requireMention: this.requiresMention(conversation.type, conversationId),
      })
      if (newest !== null) {
        this.options.logger.info("intake retargeting to a newer inbound message", {
          conversationId,
          from: trigger.id,
          to: newest.id,
        })
        trigger = newest
      }
    }
    if (trigger === null) return null

    /**
     * 上下文：会话内最近 N 条，**正序**（模型读的是对话顺序）。
     *
     * ★ 在改目标**之后**取：库里现在可能多了几条，用旧上下文会让模型
     * 回一条它看不见的消息。
     */
    const rows = messages.recentInConversation(conversationId, this.policy.contextMessages)
    const context = await this.attachMedia(rows)

    /**
     * ★ @提及只查一次，下游全都用这个值。
     *
     * 从 `message_mentions.is_self` 读而不是在正文里再匹配一遍 ——
     * 采集时已经解析并落库了（含花名匹配与全角括号那些边界），
     * 而"两处判据不同"是最难查的那类 bug。
     */
    const mentionsSelf = this.batchMentionsSelf(messageIds)

    return {
      conversationId,
      conversationKind: conversation.type === "group" ? "group" : "direct",
      conversationExternalId: conversation.externalId,
      peerOpenId: conversation.type === "group" ? null : this.resolvePeerOpenId(conversationId),
      trigger: { messageId: trigger.id, sentAt: trigger.sentAt },
      batchMessageIds: [...messageIds],
      // 溢出由 Mailbox 统计并记日志；装配层拿不到那个数，由调用方补
      batchOverflow: 0,
      mentionsSelf,
      context,
      freshness: this.freshness(conversationId, trigger.sentAt),
    }
  }

  /**
   * 这一轮的新鲜度**事实**（判定在 guard）。
   *
   * ## ★ "本人已回"以 `persona.py fresh` 的判据为准
   *
   * 三处判过这件事，判据还不一样。只有 `fresh` 那份**区分了分身代发**
   * （`isOwner && !isAgentSent`）—— 那才是对的：分身自己发出去的消息也是
   * 本人 id，把它当成"本人已经回了"会**静默压掉第一次自动回复之后的每一次
   * 跟进**（`runtime.py` 的 `recent_messages` 注释里写着同一件事）。
   *
   * 所以这里的 SQL 带 `origin != 'agent'`。
   */
  private freshness(conversationId: string, triggerSentAt: number): TurnFreshness {
    const { db } = this.options
    const ownerReplied =
      db
        .prepare<[string, number], { hit: number }>(
          `SELECT 1 AS hit FROM messages
            WHERE conversation_id = ? AND sent_at > ?
              AND is_self = 1
              AND COALESCE(origin, 'human') != 'agent'
            LIMIT 1`,
        )
        .get(conversationId, triggerSentAt) !== undefined
    const newerInbound =
      db
        .prepare<[string, number], { hit: number }>(
          `SELECT 1 AS hit FROM messages
            WHERE conversation_id = ? AND sent_at > ? AND is_self = 0
            LIMIT 1`,
        )
        .get(conversationId, triggerSentAt) !== undefined
    return {
      ownerRepliedAfter: ownerReplied,
      newerInboundArrived: newerInbound,
      collectionLagMs: this.collectionLagMs(),
    }
  }

  /**
   * 采集滞后多久。**读不出来时返回 null，而不是 0。**
   *
   * ★ 这个区别是整个新鲜度判定里最关键的一条：不知道 ≠ 零。库落后于平台时
   * "最新那行"确实是我们**有**的最新一行，而更新的可能存在只是还没采回来 ——
   * 这是三种 stale 里唯一在数据本身看不出来的。guard 把 null 当不安全处理。
   *
   * ## ★ 判据与 forge 侧逐字一致
   *
   * `runtime.py` 的 `collection_lag()` 用的是
   * `SELECT MAX(watermark) FROM sync_cursors WHERE watermark > 0`，
   * 而**不是**"最新消息的时间戳" —— 后者会让一个安静的会话报出几小时的滞后、
   * 看起来像坏了，而采集其实完全跟得上。
   *
   * 两边必须同源：`fresh` 拿这个数与 `rules.json` 的 `maxLagSeconds` 比，
   * 而 guard 也要用它。各查一遍会让"库落后时照样发"这个失效悄悄回来。
   *
   * ★ `sync_cursors` 的主键是 `scope`（形如 `dingtalk:chat:l2`），
   * **没有** `channel_id` 列 —— 所以这里也不按渠道筛，与 forge 一致。
   */
  private collectionLagMs(): number | null {
    const row = this.options.db
      .prepare<
        [],
        { watermark: number | null }
      >("SELECT MAX(watermark) AS watermark FROM sync_cursors WHERE watermark > 0")
      .get()
    const watermark = row?.watermark ?? null
    if (watermark === null || watermark <= 0) return null
    const lag = this.options.clock.now() - watermark
    return lag < 0 ? 0 : lag
  }

  /**
   * 群聊的缺省触发模式要求被 @ 吗。
   *
   * 判据与 `admit()` 的 `resolveTriggerMode` **同源**：配了就用配的，
   * 没配按会话类型取缺省（群 `mention` / 单聊 `none`）。
   * 单聊不受 mention 限制（钉钉单聊里通常也 @不了人）。
   */
  private requiresMention(conversationType: string, conversationId: string): boolean {
    if (conversationType !== "group") return false
    const row = this.options.db
      .prepare<
        [string],
        { trigger_mode: string | null }
      >("SELECT trigger_mode FROM dh_conversation_configs WHERE conversation_id = ?")
      .get(conversationId)
    const mode = row?.trigger_mode ?? "mention"
    return mode === "mention"
  }

  /**
   * 触发消息之后对方说的**最新**那条；没有就返回 null。
   *
   * 直接查库、`ORDER BY sent_at DESC LIMIT 1`，而不是在上下文窗里筛：
   * 那个窗口是给起草用的固定条数，一个刷屏的群里 30 条可能全是别人的对话，
   * 于是真正更新的那条落在窗外 —— 判据就变成"最近 30 条里有没有"，
   * 而它想问的是"库里有没有"。
   *
   * 用 `sent_at` 而不是入库时间：判的是"对方在那之后说了话"，
   * 而入库时间受采集时机影响（回填一段历史会让每一条都看起来"更新"）。
   */
  private latestInboundAfter(
    conversationId: string,
    sentAt: number,
    opts: { requireMention: boolean },
  ): MessageRow | null {
    const { db } = this.options
    /**
     * ★ 要求被 @ 时用 EXISTS 子查询而不是 JOIN：一条消息可能 @ 了多个人
     * （`message_mentions` 是一对多），JOIN 会让它出现多行 ——
     * `LIMIT 1` 时结果碰巧还对，但那是运气。
     */
    const sql = opts.requireMention
      ? `SELECT id FROM messages m
          WHERE m.conversation_id = ? AND m.is_self = 0 AND m.sent_at > ?
            AND EXISTS (SELECT 1 FROM message_mentions x
                         WHERE x.message_id = m.id AND x.is_self = 1)
          ORDER BY m.sent_at DESC LIMIT 1`
      : `SELECT id FROM messages
          WHERE conversation_id = ? AND is_self = 0 AND sent_at > ?
          ORDER BY sent_at DESC LIMIT 1`
    const row = db.prepare<[string, number], { id: string }>(sql).get(conversationId, sentAt)
    if (row === undefined) return null
    return new MessageRepository(db).findById(row.id)
  }

  /** 这一批里有没有 @我。空批次给 false（`IN ()` 是非法 SQL，且没消息也谈不上被 @）。 */
  private batchMentionsSelf(messageIds: readonly string[]): boolean {
    if (messageIds.length === 0) return false
    const placeholders = messageIds.map(() => "?").join(",")
    return (
      this.options.db
        .prepare<string[], { hit: number }>(
          `SELECT 1 AS hit FROM message_mentions
            WHERE is_self = 1 AND message_id IN (${placeholders})
            LIMIT 1`,
        )
        .get(...messageIds) !== undefined
    )
  }

  /**
   * 单聊对端的 openDingTalkId。
   *
   * ★ 取这个会话里最近一条**非本人**消息的 `sender_external_id`。
   * 不拿 `conversations.external_id` 顶替：那在单聊里是**会话**标识
   * （实测本库 52 个单聊的 external_id 都是 `cid…`，47 字符；而对端
   * openDingTalkId 是 `D…`，33-34 字符）。传错的表现不是发错人，而是
   * 服务端回「单聊时 receiverUid 不能为空」—— 一个指向我们压根没传的参数名的报错。
   *
   * 查不到给 null，让下游如实降级而不是拿一个错的 id 去问。
   */
  private resolvePeerOpenId(conversationId: string): string | null {
    const row = this.options.db
      .prepare<[string], { external_id: string | null }>(
        `SELECT sender_external_id AS external_id FROM messages
          WHERE conversation_id = ? AND is_self = 0 AND sender_external_id IS NOT NULL
          ORDER BY sent_at DESC LIMIT 1`,
      )
      .get(conversationId)
    const id = row?.external_id ?? null
    return id === "" ? null : id
  }

  /**
   * 给上下文挂媒体，并**按需**把图下下来。
   *
   * ## ★ 为什么要按需下载
   *
   * 实测库里 1915 张图只有 242 张在本地（13%）—— 媒体是"用户在界面上看到
   * 那一屏时才下"的。起草这条路上没人下过，所以不下载等于绝大多数轮次
   * agent 仍然看不到图。
   *
   * 范围限定到**最近几条带图的消息**（与 `maxPromptImages` 对齐）：多下的
   * 这一轮也送不进去，白花 0.3-0.8s/张的子进程开销。
   *
   * ## ★ 下载失败不算失败
   *
   * 原因多是能力性的（钉盘文件还没接、登录态过期、资源被撤回）。那时
   * transcript 里那条会标「（图片，未下载）」—— agent 知道有张图看不到，
   * 而这一轮照样出草稿。为了一张图让整轮生成失败是错的取舍。
   */
  private async attachMedia(rows: readonly MessageRow[]): Promise<ContextMessage[]> {
    if (rows.length === 0) return []
    const { db } = this.options

    const read = (): Map<string, ContextMessage["media"][number][]> => {
      const placeholders = rows.map(() => "?").join(",")
      const found = db
        .prepare<
          string[],
          {
            message_id: string
            kind: string
            path: string | null
            mime: string | null
            bytes: number | null
            original_name: string | null
          }
        >(
          `SELECT message_id, kind, path, mime, bytes, original_name
             FROM media_assets WHERE message_id IN (${placeholders})`,
        )
        .all(...rows.map((row) => row.id))
      const byMessage = new Map<string, ContextMessage["media"][number][]>()
      for (const item of found) {
        const list = byMessage.get(item.message_id) ?? []
        // ★ 真磁盘路径（**不**转 mycontext-file://）—— 这份要被 readFileSync 读
        list.push({
          kind: item.kind,
          path: item.path,
          mime: item.mime,
          // `bytes` / `originalName` 是标注用的，缺了会让标注静默退化（见契约注释）
          bytes: item.bytes,
          originalName: item.original_name,
        })
        byMessage.set(item.message_id, list)
      }
      return byMessage
    }

    let mediaByMessage = read()
    const download = this.options.downloadMedia
    if (download !== undefined) {
      /**
       * 从新到旧挑「有未下载的图」的消息，最多 `maxPromptImages` 条。
       * 顺序必须与取图顺序一致 —— 不一致会去下一批这一轮用不上的图。
       */
      const needs: string[] = []
      for (let i = rows.length - 1; i >= 0 && needs.length < this.policy.maxPromptImages; i -= 1) {
        const row = rows[i]
        if (row === undefined) continue
        const assets = mediaByMessage.get(row.id) ?? []
        if (assets.some((asset) => asset.kind === "image" && asset.path === null)) {
          needs.push(row.id)
        }
      }
      if (needs.length > 0) {
        try {
          await download(needs)
          mediaByMessage = read()
        } catch (error) {
          // 见方法头：不抛。warn 而不是 debug —— "agent 看不到图"值得能被查到。
          this.options.logger.warn("intake media download failed", {
            detail: error instanceof Error ? error.message : String(error),
            messages: needs.length,
          })
        }
      }
    }

    return rows.map((row) => ({
      messageId: row.id,
      senderDisplayName: row.senderDisplayName,
      contentText: row.contentText,
      // `is_self` 在库里可空；null 按"不是本人"处理（那是保守的那一侧）
      isSelf: row.isSelf === true,
      sentAt: row.sentAt,
      media: mediaByMessage.get(row.id) ?? [],
    }))
  }
}
