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
