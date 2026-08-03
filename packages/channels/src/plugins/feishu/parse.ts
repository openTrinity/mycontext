import type {
  AuthStatus,
  ChannelPullPage,
  ParsedConversationLike,
  ParsedMessageLike,
} from "../../types.js"
import { normalizeUnix } from "../dingtalk/time.js"

export const LARK_AUTH_SCOPES = [
  // Identity/session: keep historical imports running without repeated consent.
  "offline_access",

  // Messages and conversations: match DingTalk's conversation, member and
  // hydrated-message coverage while remaining strictly read-only.
  "search:docs:read",
  "search:message",
  "im:chat:read",
  "im:chat.members:read",
  "im:message:readonly",
  "im:message.group_msg:get_as_user",
  "im:message.p2p_msg:get_as_user",
  "im:message.pins:read",
  "im:message.reactions:read",

  // People: resolve message/member IDs to searchable user profiles.
  "contact:user.base:readonly",
  "contact:user.basic_profile:readonly",
  "contact:user:search",

  // Documents: enumerate Drive/Wiki and fetch real document contents instead
  // of retaining search snippets only.
  "space:document:retrieve",
  "docx:document:readonly",
  "wiki:space:retrieve",
  "wiki:node:retrieve",
  "sheets:spreadsheet:read",
  "docs:document.media:download",

  // Meeting memory: match DingTalk Minutes metadata, AI artifacts/transcript
  // and media export. These grant reads/exports only, never mutation.
  "minutes:minutes.search:read",
  "minutes:minutes.basic:read",
  "minutes:minutes.artifacts:read",
  "minutes:minutes.media:export",
] as const

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function str(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.trim() !== "") return value
  return null
}

function bool(value: unknown): boolean {
  return value === true || value === "true"
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  return typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : []
}

export interface LarkIdentity {
  openId: string
  userName: string
  tenantKey: string
  tenantName: string
}

export function parseLarkIdentity(payload: unknown): LarkIdentity | null {
  const data = record(payload)
  const identities = record(data["identities"])
  const user = record(identities["user"] ?? data["identity"])
  const openId = str(user["openId"], user["open_id"], data["openId"], data["open_id"])
  if (openId === null) return null
  return {
    openId,
    userName:
      str(user["userName"], user["user_name"], user["name"], data["userName"]) ?? "飞书用户",
    tenantKey:
      str(user["tenantKey"], user["tenant_key"], data["tenantKey"], data["tenant_key"]) ?? "feishu",
    tenantName:
      str(user["tenantName"], user["tenant_name"], data["tenantName"], data["tenant_name"]) ??
      "飞书",
  }
}

export function parseLarkAuthStatus(payload: unknown): AuthStatus {
  const data = record(payload)
  const identities = record(data["identities"])
  const user = record(identities["user"] ?? data["identity"])
  const identity = parseLarkIdentity(payload)
  const rawStatus = str(user["status"], data["status"])
  const tokenStatus = str(user["tokenStatus"], user["token_status"], data["tokenStatus"])
  const scopes = stringList(user["scope"] ?? user["scopes"] ?? data["scope"] ?? data["scopes"])
  const verified = bool(data["verified"])
  const valid =
    rawStatus === "authenticated" || tokenStatus === "valid" || bool(user["authenticated"])
  const hasScopes = LARK_AUTH_SCOPES.every((scope) => scopes.includes(scope))
  if (identity === null || (!verified && !valid) || !hasScopes) return { state: "unauthorized" }
  return {
    state: "authorized",
    corpId: identity.tenantKey,
    corpName: identity.tenantName,
    userId: identity.openId,
    userName: identity.userName,
    accessExpiresAt: null,
    refreshExpiresAt: null,
    daysUntilRefreshExpiry: null,
  }
}

export interface LarkDeviceGrant {
  deviceCode: string
  userCode: string
  verifyUrl: string
  expiresInSeconds: number
}

export function parseLarkDeviceGrant(payload: unknown): LarkDeviceGrant | null {
  const data = record(payload)
  const deviceCode = str(data["device_code"], data["deviceCode"])
  const verifyUrl = str(
    data["verification_url"],
    data["verification_uri_complete"],
    data["verificationUrl"],
  )
  if (deviceCode === null || verifyUrl === null) return null
  const rawExpiry = data["expires_in"] ?? data["expiresIn"]
  return {
    deviceCode,
    userCode: str(data["user_code"], data["userCode"]) ?? deviceCode.slice(0, 8),
    verifyUrl,
    expiresInSeconds: typeof rawExpiry === "number" ? rawExpiry : 900,
  }
}

export function stringifyLarkContent(value: unknown): string {
  if (typeof value === "string") {
    try {
      return stringifyLarkContent(JSON.parse(value))
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.map(stringifyLarkContent).filter(Boolean).join(" ")
  if (typeof value === "object" && value !== null) {
    const row = value as Record<string, unknown>
    const direct = str(row["text"], row["title"], row["content"])
    if (direct !== null) return direct
    return Object.values(row).map(stringifyLarkContent).filter(Boolean).join(" ")
  }
  return ""
}

function timestamp(value: unknown, fallback: number): number {
  if (typeof value === "number") return normalizeUnix(value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return normalizeUnix(numeric)
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

function itemsOf(payload: unknown): unknown[] {
  const data = record(payload)
  for (const key of ["items", "messages", "results", "files"]) {
    if (Array.isArray(data[key])) return array(data[key])
  }
  return Array.isArray(payload) ? payload : []
}

/** Convert hydrated/search IM results into the channel-neutral ingest shape. */
export function parseLarkMessagePage(payload: unknown, fetchedAt: number): ChannelPullPage {
  const conversations = new Map<string, ParsedConversationLike>()
  const messages: ParsedMessageLike[] = []
  for (const raw of itemsOf(payload)) {
    const item = record(raw)
    const messageId = str(item["message_id"], item["messageId"])
    if (messageId === null) continue
    const chat = record(item["chat"])
    const partner = record(item["chat_partner"])
    const conversationId = str(item["chat_id"], item["chatId"], chat["chat_id"], chat["id"])
    if (conversationId === null) continue
    const sender = record(item["sender"])
    const chatType = str(item["chat_type"], item["chatType"], chat["chat_type"])
    conversations.set(conversationId, {
      externalId: conversationId,
      title: str(item["chat_name"], chat["name"], partner["name"]) ?? "飞书会话",
      type: chatType === "p2p" || chatType === "direct" ? "direct" : "group",
      memberCount: null,
    })
    messages.push({
      externalId: messageId,
      conversationExternalId: conversationId,
      senderExternalId: str(sender["open_id"], sender["openId"], sender["id"]),
      senderDisplayName: str(sender["name"], sender["display_name"]),
      contentText: stringifyLarkContent(item["content"] ?? item["body"]).trim() || null,
      contentJson: JSON.stringify(item["content"] ?? item["body"] ?? null),
      quotedExternalId: str(item["parent_id"], item["root_id"], item["parentId"]),
      sentAt: timestamp(item["create_time_iso"] ?? item["create_time"], fetchedAt),
      mentions: array(item["mentions"])
        .map(record)
        .map((mention) => str(mention["open_id"], mention["openId"], mention["id"]))
        .filter((id): id is string => id !== null)
        .map((actorExternalId) => ({ actorExternalId })),
      hasMedia: false,
    })
  }
  return {
    conversations: [...conversations.values()],
    messages,
    nextCursor: null,
    hasMore: false,
    itemCount: messages.length,
    rawPayload: JSON.stringify(payload),
  }
}

/** Treat each Drive search result as a durable source record in a synthetic Drive conversation. */
export function parseLarkDrivePage(payload: unknown, fetchedAt: number): ChannelPullPage {
  const conversationId = "feishu:drive"
  const messages: ParsedMessageLike[] = []
  for (const [index, raw] of itemsOf(payload).entries()) {
    const item = record(raw)
    const title = stringifyLarkContent(item["title"] ?? item["name"]).trim() || "飞书文档"
    const body = stringifyLarkContent(
      item["summary_highlighted"] ?? item["summary"] ?? item["snippet"] ?? item["content"] ?? title,
    ).trim()
    if (body === "") continue
    const externalId =
      str(item["token"], item["document_id"], item["file_token"], item["url"]) ??
      `drive:${String(index)}:${title}`
    messages.push({
      externalId: `drive:${externalId}`,
      conversationExternalId: conversationId,
      senderExternalId: str(item["owner_open_id"], item["creator_open_id"]),
      senderDisplayName: str(item["owner_name"], item["creator_name"]),
      contentText: `${title}\n${body}`,
      contentJson: JSON.stringify(item),
      quotedExternalId: null,
      sentAt: timestamp(item["edit_time_iso"] ?? item["edit_time"], fetchedAt),
      mentions: [],
      hasMedia: false,
    })
  }
  return {
    conversations: [
      { externalId: conversationId, title: "飞书云文档", type: "group", memberCount: null },
    ],
    messages,
    nextCursor: null,
    hasMore: false,
    itemCount: messages.length,
    rawPayload: JSON.stringify(payload),
  }
}
