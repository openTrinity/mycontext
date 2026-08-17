/**
 * 数据面的行类型。
 *
 * 单独一个文件是因为它们被 store / ingest / retrieval / distill / persona
 * 五个包共用 —— 放进任何一个仓储文件都会让另外四个 import 到一堆无关的东西。
 *
 * 命名约定：DB 列是 snake_case，TS 侧一律 camelCase，转换发生在仓储层。
 * 不用 ORM 也不自动映射：手写映射函数虽然啰嗦，但「这个字段在库里叫什么」
 * 永远只有一处答案，改列名时编译器会把所有用到的地方指出来。
 */

/** 渠道 ID。与 `@mycontext/channels` 的 ChannelId 同值，此处不 import 以免 L2→L3 反向依赖。 */
export type ChannelIdValue = string

export interface RawRecordInput {
  id: string
  channelId: ChannelIdValue
  resource: string
  /** 平台主键；无主键的资源（列表快照等）必须传空串而不是 null */
  externalId: string
  payload: string
  payloadHash: string
  source: string
  fetchedAt: number
}

export interface ActorInput {
  id: string
  channelId: ChannelIdValue
  externalId: string
  kind: "user" | "bot" | "system"
  displayName?: string | null
  staffId?: string | null
  isSelf?: boolean
  seenAt: number
}

export interface ConversationInput {
  id: string
  channelId: ChannelIdValue
  externalId: string
  type: "direct" | "group"
  title?: string | null
  memberCount?: number | null
  isSelfInvolved?: boolean
  isBotChannel?: boolean
  lastMessageAt?: number | null
  createdAt: number
}

export interface ConversationRow {
  id: string
  channelId: ChannelIdValue
  externalId: string
  type: "direct" | "group"
  title: string | null
  memberCount: number | null
  isSelfInvolved: boolean
  isBotChannel: boolean
  lastMessageAt: number | null
  createdAt: number
}

export interface MessageMentionInput {
  actorExternalId: string
  isSelf: boolean
}

/**
 * 媒体资源（图片 / 文件 / 音视频）。
 *
 * ## 一期只存元数据，不存字节
 *
 * `path` 为 NULL 即表示"还没下载"，`downloadedAt` 同理 —— 这让
 * 「有这张图但没下载」与「没有这张图」在库里可区分。
 * 下载是**逐条**外部调用（`chat message download-media` / `drive download`），
 * 会引入体积、并发、失败重试三类新问题；先把"这条消息有什么资源"记准，
 * 按需下载留给二期。
 *
 * `sha256` 也留空：它是**内容**哈希，没下载就算不出来。
 * 不要用 resourceId 填这一列 —— 那会让"内容是否相同"的语义变成"ID 是否相同"。
 */
export interface MediaAssetInput {
  id: string
  messageId: string
  kind: "image" | "file" | "audio" | "video"
  /**
   * 平台侧资源 ID（mediaId / fileId）。
   *
   * 复用 `sha256` 列存它是错的（见上），所以走 `original_name` 之外的新列 ——
   * 见 VAULT v8 迁移：加 `resource_id` + `resource_kind`。
   */
  resourceId: string
  /** 取字节时该用哪个命令：`mediaId` → download-media，`fileId` → drive download */
  resourceKind: string
  mime?: string | null
  bytes?: number | null
  originalName?: string | null
}

/** 听记（钉钉「闪记/听记」）。转写正文可能很大，按 JSON 整存。 */
export interface MinutesInput {
  id: string
  channelId: ChannelIdValue
  externalId: string
  title?: string | null
  startedAt?: number | null
  durationSec?: number | null
  summaryText?: string | null
  transcriptJson?: string | null
  speakersJson?: string | null
  /**
   * 转写实际抽了几页。`undefined` = 这次调用不带正文（只列元信息），
   * 由 upsert 的 COALESCE 保留已有值。
   */
  transcriptPages?: number | null
  /** 转写撞了渠道侧的上限、没抽干。见 v24 迁移的文件头。 */
  transcriptTruncated?: boolean | null
  fetchedAt: number
  rawRecordId?: string | null
}

export interface MinutesRow {
  id: string
  channelId: ChannelIdValue
  externalId: string
  title: string | null
  startedAt: number | null
  durationSec: number | null
  summaryText: string | null
  transcriptJson: string | null
  speakersJson: string | null
  /** NULL = 老数据（那时只取第一页，而"是不是全部"当时没存下来）。 */
  transcriptPages: number | null
  /**
   * `null` = **不知道**（老数据），不是"抽干了"。
   * 三态是刻意的，见 v24 迁移文件头。
   */
  transcriptTruncated: boolean | null
  fetchedAt: number
  rawRecordId: string | null
}

/**
 * 文档（知识库 wiki / 钉盘）。
 *
 * `contentText` 为 null = **没取到正文**（这类文档没有 markdown、或权限/已删），
 * 不是"文档是空的" —— 与 `media_assets.path` 同一个口径。
 * 所以 upsert 用 COALESCE 保留已有正文（列举与读正文是两步，见仓储注释）。
 */
export interface DocumentInput {
  id: string
  channelId: ChannelIdValue
  externalId: string
  /** 来源子域：`wiki` / `drive` —— 进 doc_type 之外单独记，便于按来源排查 */
  origin?: string | null
  title?: string | null
  docType?: string | null
  extension?: string | null
  url?: string | null
  workspaceId?: string | null
  contentText?: string | null
  updatedAt?: number | null
  createdAt?: number | null
  fetchedAt: number
  rawRecordId?: string | null
}

export interface DocumentRow {
  id: string
  channelId: ChannelIdValue
  externalId: string
  origin: string | null
  title: string | null
  docType: string | null
  extension: string | null
  url: string | null
  workspaceId: string | null
  contentText: string | null
  updatedAt: number | null
  createdAt: number | null
  fetchedAt: number
  rawRecordId: string | null
}

export interface MessageInput {
  id: string
  channelId: ChannelIdValue
  conversationId: string
  externalId: string
  senderActorId?: string | null
  senderExternalId?: string | null
  senderDisplayName?: string | null
  contentText?: string | null
  contentJson?: string | null
  quotedExternalId?: string | null
  threadId?: string | null
  /** unix ms。解析层负责按渠道时区归一，仓储层只存整数 */
  sentAt: number
  direction: "inbound" | "outbound"
  /** null = 未判定（不是 0）；身份确认后回填 */
  isSelf?: boolean | null
  origin?: "human" | "agent"
  /**
   * 这条消息在**学习范围**内吗（DWD 的资格标签，v30）。
   *
   * ## ★★★ 它为什么存在（DWD 只打标、不筛行）
   *
   * `messages` 是**多个下游共用**的明细层：学习侧（fts/graph/distill）、
   * 数字分身、界面的消息历史。改动前 `persist()` 按**学习侧**的口径把
   * 越界的行**丢掉** —— 于是另外两个下游永久拿不到那些数据
   * （最实际的后果：分身收不到"超出学习 `until`"的新消息，
   * 也看不见自己发过的回复）。
   *
   * ODPS 的惯例是「明细层只打标，筛选在消费侧」，这个字段就是那个标。
   *
   * ★ `undefined` / `null` = 打标之前入库的（存量行）。learning 侧的判据
   * 必须是 `IS NOT 0` 而**不是** `= 1` —— 后者会把 NULL 排除掉，
   * 而那会让存量库的图谱下一轮变空。见 v30 迁移的文件头。
   *
   * ★★ **没有** `attentionEligible` 的对应物：监听范围可以关掉、
   * `enabled_at` 只能变早，所以一个落库那刻的快照会往"更松"的方向漂
   * （"我关了它还在回消息"）。那一侧的判据必须是 `AttentionRouter`
   * 每条现判。
   */
  learningEligible?: boolean | null
  hasMedia?: boolean
  rawRecordId?: string | null
  createdAt: number
  mentions?: readonly MessageMentionInput[]
  /** 媒体元数据。与 mentions 一样是"随消息一起写"的从属数据。 */
  media?: readonly Omit<MediaAssetInput, "id" | "messageId">[]
}

export interface MessageRow {
  id: string
  channelId: ChannelIdValue
  conversationId: string
  externalId: string
  senderActorId: string | null
  senderExternalId: string | null
  senderDisplayName: string | null
  contentText: string | null
  contentJson: string | null
  quotedExternalId: string | null
  threadId: string | null
  sentAt: number
  direction: "inbound" | "outbound"
  isSelf: boolean | null
  origin: "human" | "agent"
  /** 见 `MessageInput.learningEligible`。`null` = 打标之前入库的（存量行）。 */
  learningEligible: boolean | null
  hasMedia: boolean
  rawRecordId: string | null
  revision: number
  createdAt: number
}

/** Outbox 的实体类型。含本轮不采集的 document/minutes —— 消费者约定见 handoff 文档。 */
export const CHANGELOG_ENTITY_TYPES = [
  "message",
  "conversation",
  "actor",
  "document",
  "minutes",
  "note",
] as const
export type ChangelogEntityType = (typeof CHANGELOG_ENTITY_TYPES)[number]

export const CHANGELOG_DOMAINS = ["chat", "doc", "minutes", "contact"] as const
export type ChangelogDomain = (typeof CHANGELOG_DOMAINS)[number]

export interface ChangelogEntryInput {
  op: "upsert" | "delete"
  entityType: ChangelogEntityType
  entityId: string
  channelId: ChannelIdValue
  domain: ChangelogDomain
  /** 业务时间（消息发出的时间），不是写入时间 */
  occurredAt: number
  emittedAt: number
  payloadRef?: string | null
  /** 规范化内容 hash：消费者据此跳过无实质变化的项 */
  digest: string
  /**
   * **资格位图** —— 哪些消费者该看到这一条（v30）。
   *
   * ## ★★★ 它让"谁能看到什么"从五处 SQL 的 WHERE 变成一行声明
   *
   * 改动前 changelog 里每一条都是"所有消费者都看"，而筛选靠
   * `persist()` 在**写入侧**丢掉行 —— 于是学习侧的口径替所有下游
   * 做了决定（见 v30 迁移的文件头）。
   *
   * 现在消费者按 `ConsumerSpec.requires` 声明自己要哪个标签，
   * `changesSince` 据此过滤。
   *
   * ★ `undefined` = 打标之前写的（存量行）。消费侧对它的处置与
   * `messages.learning_eligible` 的 `NULL` 一致：**learning 侧视为合格**
   * （`IS NOT 0`），因为那些行当时通过了更严的旧闸。
   *
   * 位定义见 `ELIGIBILITY_BITS`。
   */
  eligibility?: number | undefined
}

/**
 * 资格位图的位定义。
 *
 * ★ 用位图而不是一个布尔列：将来加第二个维度（比如"只给某个新消费者"）
 * 时不用再改一次表结构，而消费者那侧的判据形状不变。
 *
 * ★★ 而**监听范围刻意不在这里** —— 它可以关掉、`enabled_at` 只能变早，
 * 所以一个落库那刻的快照会往"更松"的方向漂（"我关了它还在回消息"）。
 * 那一侧的判据是 `AttentionRouter` 每条现判。见 v30 迁移的文件头。
 */
export const ELIGIBILITY_BITS = {
  /** bit 0：在**学习范围**内（fts / graph-export / distill / distill-work 要它） */
  learning: 1,
} as const

/** 从一个"在不在学习范围内"算出位图。★ 唯一一份实现（抄错会让消费者取错段）。 */
export function eligibilityOf(input: { learning: boolean }): number {
  return input.learning ? ELIGIBILITY_BITS.learning : 0
}

export interface ChangelogRow extends ChangelogEntryInput {
  seq: number
  payloadRef: string | null
}

export interface SelfIdentityRecord {
  channelId: ChannelIdValue
  userId: string
  /** 一人可能多 ID（飞书有 open_id / union_id / user_id 三套） */
  openIds: readonly { kind: string; value: string }[]
  /** 仅展示，**禁止参与 is_self 判定** */
  displayNames: readonly string[]
  corpId: string | null
  corpName: string | null
  /** null = 用户尚未确认 → 拒绝蒸馏 */
  confirmedAt: number | null
}

export interface SyncCursorRow {
  scope: string
  cursor: string | null
  windowStart: number | null
  windowEnd: number | null
  /** 已**完整落库**的时间水位。只有整窗所有分页确认入库后才推进 */
  watermark: number
  pageCount: number
  truncated: boolean
  status: "idle" | "running" | "failed" | "done"
  lastError: string | null
  attempts: number
  updatedAt: number
}

export interface ConsumerCursorRow {
  consumerId: string
  ackedSeq: number
  required: boolean
  registeredAt: number
  heartbeatAt: number | null
  staleAfterMs: number
  needsFullRebuild: boolean
  leaseOwner: string | null
  leaseExpiresAt: number | null
  lastError: string | null
  lastSuccessAt: number | null
  updatedAt: number
}
