/**
 * 规范化：渠道原生数据 → 规范表输入 + Outbox 条目。
 *
 * 纯函数（不碰数据库）是刻意的：规范化规则是最需要 fixture 驱动测试的部分，
 * 而「解析对了没有」不该依赖能不能开库。
 *
 * 关键约定：
 * · 所有 id 由我们生成（ULID 风格的时间有序 id），不用平台 id 当主键 ——
 *   平台 id 的形态与长度我们控制不了，而它已经作为 external_id 存着了；
 * · 时间已在渠道解析层归一成 unix ms，这里不再碰时间格式；
 * · `is_self` 一律传 undefined（未判定）：判定发生在身份确认之后的回填，
 *   这里猜一个值会永久丢失人格语料。
 */
import { createHash, randomBytes } from "node:crypto"
/**
 * 用渠道**无关**的 `*Like` 契约，不用钉钉的 `ParsedMessage`。
 *
 * 规范化层的输入必须是所有渠道的公共形态 —— 用某个渠道的具体类型会让
 * 「渠道无关性」只是注释里的说法：飞书的解析产物不含 `mentionTexts`
 * （它的 @ 是结构化字段，有真 ID），却会因为类型不匹配编译失败。
 */
import type { ParsedConversationLike, ParsedMessageLike } from "@mycontext/channels"
import type {
  ChangelogEntryInput,
  ConversationInput,
  MessageInput,
  RawRecordInput,
} from "@mycontext/store"
/** ★ 资格位图的**唯一**一份算法（抄错会让消费者取错段）。 */
import { eligibilityOf } from "@mycontext/store"

/**
 * 时间有序的唯一 id。
 *
 * 前 8 位是时间的 base36（毫秒），后面随机 —— 这样：
 * ① 主键有序，B-tree 插入不会随机分裂页；
 * ② 排序即近似时间序，调试时看 id 就知道先后。
 * 不引 ulid 依赖：这 6 行代码没有引一个包的价值。
 */
export function newId(nowMs: number): string {
  return `${nowMs.toString(36).padStart(9, "0")}${randomBytes(8).toString("hex")}`
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export interface NormalizeInput {
  channelId: string
  /** 已解析的会话与消息（来自渠道插件） */
  conversations: readonly ParsedConversationLike[]
  messages: readonly ParsedMessageLike[]
  /** 原始响应（整页），进 raw_records 供重放 */
  rawPayload: string
  rawResource: string
  /** 本人的外部标识集合：已确认时用于判定 is_self；未确认时传空集 */
  selfExternalIds: ReadonlySet<string>
  /**
   * 本人的**显示名**集合（真名 / 昵称 / 花名）。
   *
   * 用于把 content 里的 `@真名(花名)` 判成"@我了"—— 实测 `list-all`
   * 的消息**没有** `atUsers` 字段，@ 只在文本里，而文本里只有显示名没有 ID。
   *
   * 只与**本人**的名字比对（本人名字集合已确认且唯一），不试图解析其他人的 @：
   * 显示名到 ID 的映射有歧义（同名同姓实测 6 个），猜错会让数字人替别人回消息。
   */
  selfDisplayNames?: ReadonlySet<string>
  /** 身份是否已由用户确认。未确认时 is_self 一律留 null（未判定） */
  selfConfirmed: boolean
  /**
   * 这一批里哪些消息在**学习范围**内（按 `externalId`）。
   *
   * ## ★★★ 为什么要这个集合（DWD 只打标、不筛行）
   *
   * `messages` 是多个下游共用的明细层。改动前采集侧按**学习范围**把越界的
   * 行**丢掉** —— 于是分身（要监听范围内的新消息）与界面（要完整对话）
   * 永久拿不到那些数据。
   *
   * 现在越界的行**照样入库**，只是标 `learning_eligible = 0`，
   * 学习侧那五个消费者按标签取不到它们。
   *
   * ★ `undefined` = 调用方没算（存量路径 / 单测）→ 标签留 `undefined`
   * → 落库为 `NULL`（"没打过标"），而 learning 侧对 NULL 视为**合格**
   * （那些行当时通过了更严的旧闸）。见 v30 迁移的文件头。
   *
   * ★★ 用 `externalId` 而不是数组下标：这个函数内部会因为"会话解析不出来"
   * 而跳过某些消息，下标对不上；而 `(channel_id, external_id)` 是那张表的
   * 唯一键，天然是这一批里的稳定标识。
   */
  learningEligibleIds?: ReadonlySet<string>
  fetchedAt: number
}

export interface NormalizedBatch {
  raw: RawRecordInput[]
  conversations: ConversationInput[]
  messages: MessageInput[]
  /** 会话 external_id → 我们的 id 的映射（调用方要用它建外键） */
  conversationIdByExternal: Map<string, string>
}

/**
 * 把一页解析结果变成可入库的批次。
 *
 * 注意 `messages[].conversationId` 这里填的是**外部 id**：
 * 真正的内部 id 要等会话行 upsert 后才知道（可能是已存在的旧行）。
 * 调用方（persist）负责替换 —— 这个两步走是必要的，
 * 因为规范化是纯函数而"这个会话已经存在吗"必须查库。
 */
export function normalize(input: NormalizeInput): NormalizedBatch {
  const conversationIdByExternal = new Map<string, string>()
  const conversations: ConversationInput[] = []

  for (const parsed of input.conversations) {
    const id = newId(input.fetchedAt)
    conversationIdByExternal.set(parsed.externalId, id)
    conversations.push({
      id,
      channelId: input.channelId,
      externalId: parsed.externalId,
      type: parsed.type,
      title: parsed.title,
      memberCount: parsed.memberCount,
      isBotChannel: looksLikeBotChannel(parsed),
      createdAt: input.fetchedAt,
    })
  }

  const messages: MessageInput[] = []
  const latestByConversation = new Map<string, number>()
  const selfNames = input.selfDisplayNames ?? new Set<string>()

  for (const parsed of input.messages) {
    const sender = parsed.senderExternalId
    // ★ 身份未确认时一律 null（未判定）。猜错的代价是永久丢失人格语料，
    //   而 null 只是"晚一点再算"。
    const isSelf =
      !input.selfConfirmed || sender === null ? null : input.selfExternalIds.has(sender)

    /**
     * @我 的判定：结构化 ID 优先，文本显示名兜底。
     *
     * `parsed.mentions` 是真 ID（可靠但实测 list-all 不给）；
     * `mentionTexts` 是显示名，只拿来与**本人**名字集合比对。
     * 身份未确认时 selfNames 为空 → 不会把任何消息判成"@我"
     * （宁可不触发，也不能对全部消息都判成@我）。
     */
    const mentions = parsed.mentions.map((mention) => ({
      actorExternalId: mention.actorExternalId,
      isSelf: input.selfExternalIds.has(mention.actorExternalId),
    }))
    const selfMentionedByText =
      selfNames.size > 0 && (parsed.mentionTexts ?? []).some((text) => selfNames.has(text))
    if (selfMentionedByText && !mentions.some((mention) => mention.isSelf)) {
      // 落成"本人被@"的一行。用本人的某个 openId 作为 actor_external_id ——
      // 这一列的语义是 ID，不能塞显示名（那会让下游把它当 ID 去 join）。
      const selfId = [...input.selfExternalIds][0]
      if (selfId !== undefined) mentions.push({ actorExternalId: selfId, isSelf: true })
    }

    messages.push({
      id: newId(parsed.sentAt),
      channelId: input.channelId,
      // 占位：调用方按 conversationIdByExternal 或库里已有行替换
      conversationId: parsed.conversationExternalId,
      externalId: parsed.externalId,
      senderExternalId: sender,
      senderDisplayName: parsed.senderDisplayName,
      contentText: parsed.contentText,
      contentJson: parsed.contentJson,
      quotedExternalId: parsed.quotedExternalId,
      sentAt: parsed.sentAt,
      // 本人发的算 outbound，其余 inbound；未判定时按 inbound
      direction: isSelf === true ? "outbound" : "inbound",
      isSelf,
      /**
       * ★ 学习范围的资格标签（DWD 只打标、不筛行）。
       *
       * `undefined`（调用方没算）→ 落库为 NULL（"没打过标"），
       * 而 learning 侧对 NULL 视为**合格** —— 见 `learningEligibleIds`
       * 与 v30 迁移的文件头。
       */
      ...(input.learningEligibleIds === undefined
        ? {}
        : { learningEligible: input.learningEligibleIds.has(parsed.externalId) }),
      hasMedia: parsed.hasMedia,
      createdAt: input.fetchedAt,
      mentions,
      media: (parsed.media ?? []).map((asset) => ({
        kind: asset.kind,
        resourceId: asset.resourceId,
        resourceKind: asset.resourceKind,
        originalName: asset.originalName,
      })),
    })

    const previous = latestByConversation.get(parsed.conversationExternalId) ?? 0
    if (parsed.sentAt > previous) {
      latestByConversation.set(parsed.conversationExternalId, parsed.sentAt)
    }
  }

  // 会话的 last_message_at 用本批消息的最大时间（upsert 里会取 MAX，所以安全）
  for (const conversation of conversations) {
    const latest = latestByConversation.get(conversation.externalId)
    if (latest !== undefined) conversation.lastMessageAt = latest
  }

  const payloadHash = sha256(input.rawPayload)
  const raw: RawRecordInput[] = [
    {
      id: newId(input.fetchedAt),
      channelId: input.channelId,
      resource: input.rawResource,
      // 整页快照没有平台主键 → 空串（**不是 null**：可空会让唯一键失效）
      externalId: "",
      payload: input.rawPayload,
      payloadHash,
      source: "dws-cli",
      fetchedAt: input.fetchedAt,
    },
  ]

  return { raw, conversations, messages, conversationIdByExternal }
}

/**
 * 机器人/告警群的启发式判断。
 *
 * 判断错了用户可以在 UI 里改（`setBotChannel`），而且改过之后
 * 后续采集不会覆盖它（见 conversations 的 upsert）。
 * 所以这里可以放宽 —— 实测存在高频告警机器人，
 * 不排除会严重污染 routines 与 expertise 两个 facet。
 */
function looksLikeBotChannel(conversation: ParsedConversationLike): boolean {
  const title = conversation.title ?? ""
  return /机器人|告警|告 警|alert|alarm|monitor|bot|通知|notice|CI\/CD|jenkins/i.test(title)
}

/** 消息 → Outbox 条目。`digest` 用规范化内容 hash，消费者据此跳过无变化项。 */
export function toChangelogEntry(
  message: {
    id: string
    channelId: string
    sentAt: number
    contentText: string | null
    /**
     * ★ 学习范围的资格标签 —— 它决定这一条的 `eligibility` 位图
     * （也就是学习侧那五个消费者要不要看到它）。
     *
     * `undefined` / `null` = 没打过标（存量路径）→ `eligibility` 也留空，
     * 而消费侧对空视为**合格**（那些行当时通过了更严的旧闸）。
     */
    learningEligible?: boolean | null
  },
  emittedAt: number,
  rawRecordId?: string,
): ChangelogEntryInput {
  return {
    op: "upsert",
    entityType: "message",
    entityId: message.id,
    channelId: message.channelId,
    domain: "chat",
    /**
     * ★★★ 资格位图：让消费者按标签取自己那一段（v30）。
     *
     * ★ `undefined`（没打过标）时**不给这个键** —— 落库为 NULL，
     * 而消费侧对 NULL 视为合格。给一个 `0` 会把存量行说成"不合格"，
     * 于是学习侧下一轮拿不到历史。
     */
    ...(message.learningEligible === undefined || message.learningEligible === null
      ? {}
      : { eligibility: eligibilityOf({ learning: message.learningEligible }) }),
    occurredAt: message.sentAt,
    emittedAt,
    payloadRef: rawRecordId ?? null,
    digest: sha256(message.contentText ?? ""),
  }
}

/**
 * 听记 → Outbox 条目。
 *
 * `occurredAt` 用**会议开始时间**而不是抓取时间：下游按业务时间排序
 * （"上周的会议"），用抓取时间会让三个月前的会议看起来是今天发生的。
 * `startedAt` 缺失时退回 fetchedAt —— 排序会不准，但比落到 0（1970）好。
 *
 * `digest` 只算摘要与转写：`fetchedAt` 每轮都变，算进去会让每轮都产生新 seq，
 * 下游就会把全部听记反复重算一遍。
 */
export function toMinutesChangelogEntry(
  minutes: {
    id: string
    channelId: string
    startedAt: number | null
    fetchedAt: number
    summaryText: string | null
    transcriptJson: string | null
  },
  emittedAt: number,
  rawRecordId?: string,
): ChangelogEntryInput {
  return {
    op: "upsert",
    entityType: "minutes",
    entityId: minutes.id,
    channelId: minutes.channelId,
    domain: "minutes",
    occurredAt: minutes.startedAt ?? minutes.fetchedAt,
    emittedAt,
    payloadRef: rawRecordId ?? null,
    digest: sha256(`${minutes.summaryText ?? ""} ${minutes.transcriptJson ?? ""}`),
  }
}

/**
 * 文档 → Outbox 条目。
 *
 * `occurredAt` 用**文档的更新时间**（不是抓取时间）：与听记同一个理由 ——
 * 下游按业务时间排序，用抓取时间会让三个月前改的文档看起来是今天改的。
 * `updatedAt` 缺失时退回 `createdAt`、再退回 `fetchedAt`。
 *
 * `digest` 只算**标题 + 正文**：`fetchedAt` 每轮都变，算进去会让每轮都产生
 * 新 seq，而图谱重建是小时级开销 —— 那是本项目最贵的一次静默浪费。
 */
export function toDocumentChangelogEntry(
  document: {
    id: string
    channelId: string
    title: string | null
    contentText: string | null
    updatedAt: number | null
    createdAt: number | null
    fetchedAt: number
  },
  emittedAt: number,
  rawRecordId?: string,
): ChangelogEntryInput {
  return {
    op: "upsert",
    entityType: "document",
    entityId: document.id,
    channelId: document.channelId,
    domain: "doc",
    occurredAt: document.updatedAt ?? document.createdAt ?? document.fetchedAt,
    emittedAt,
    payloadRef: rawRecordId ?? null,
    digest: sha256(`${document.title ?? ""} ${document.contentText ?? ""}`),
  }
}
