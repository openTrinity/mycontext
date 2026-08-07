import type {
  AuthStatus,
  ChannelPullPage,
  ParsedConversationLike,
  ParsedDocumentLike,
  ParsedMessageLike,
} from "../../types.js"
import { normalizeUnix } from "../dingtalk/time.js"

/**
 * 向用户索要的 OAuth 权限。
 *
 * ## ★★ 只列**实现真正用到**的，一条都不多要
 *
 * 多要一个权限不是"以后可能有用"，而是现在就让用户授出了我们并不读的数据面
 * —— 违反 CLAUDE.md 第 5 节（不许扩大读取面）。而且用户在授权页看到
 * 「会议全文」「联系人搜索」这类条目时，我们其实一次都不会调。
 *
 * 收窄前这里有 26 项，其中会议（minutes 四项）、媒体导出、文档媒体下载、
 * 联系人搜索、reaction、pins 全部**没有任何调用点**：
 * · 插件没有 `minutes` / `media` / `documents` 能力（`index.ts` 里没挂）；
 * · 消息命令显式传 `--no-reactions`；
 * · pins 从来没读过。
 *
 * ## ★ 加回一项之前
 *
 * 先有调用点，再加权限 —— 反过来（先要权限占位）就是上面那个问题。
 * 而且 `parseLarkAuthStatus` 会**逐项校验**：加了却没授出，
 * 这个账号会被判成 `unauthorized`（见那里的 `hasScopes`）。
 */
export const LARK_AUTH_SCOPES = [
  /** 长期有效的 refresh token —— 否则每次采集都要用户重新扫码。 */
  "offline_access",

  // 消息与会话：`+messages-search` / `+messages-mget` 用到的最小集合。
  /** 消息搜索（`im +messages-search`）。 */
  "search:message",
  /** 会话元信息（群名、类型）—— 会话列表与消息归属都要它。 */
  "im:chat:read",
  /** 只读消息正文（`+messages-mget` 补正文走这条）。 */
  "im:message:readonly",
  /**
   * ★★ 表情回复的读权限 —— **必须要，即使我们显式传了 `--no-reactions`**。
   *
   * ## 这条是真机验证逼出来的（一次错误收窄的记录）
   *
   * 收窄权限时我按"实现传了 `--no-reactions`，所以用不到 reactions"把它删了。
   * 那个推理是错的：CLI 把这个 scope 声明在**命令**上，在
   * **pre-flight 阶段**就校验（它自己的文档原文：
   * "already declared in each shortcut's `UserScopes` … so the framework's
   * pre-flight check surfaces a `missing_scope` error **before the request
   * is sent**"）。而 `--no-reactions` 只影响请求发出**之后**要不要额外查
   * reactions —— 管不到那道检查。
   *
   * 删掉它的表现：授权能过，但每次拉消息都
   * `missing required scope(s): im:message.reactions:read`，**一条数据都采不到**。
   *
   * ★ 所以判据不是"我们用不用这个数据"，而是"CLI 让不让我们调这条命令"。
   * 下次再收窄权限：**必须真机跑一次每条命令**，不能只读我们自己的代码。
   */
  "im:message.reactions:read",

  // 人：把消息里的 sender id 解析成可显示的名字。
  /**
   * 用户基本信息（`contact:user.base:readonly`）。
   *
   * ★ 只要 base，不要 `basic_profile` 与 `user:search`：前者含更多档案字段、
   * 后者是**按名字反查人**的能力，而我们只需要"这个 id 是谁"。
   * 反查是一个明显更大的读取面（CLAUDE.md 第 5 节点名了这类命令）。
   */
  "contact:user.base:readonly",

  // 云文档：`drive +search` 用到的两条。
  /** 文档搜索（`search:docs:read`）。 */
  "search:docs:read",
  /**
   * 取文档正文（`docx:document:readonly`）。
   *
   * ★ 保留它是因为采集侧确实要正文（现在只存了摘要片段，正文那一段
   * 待接 `documents` 契约）。不要 `sheets` / `media:download` / `wiki:*`：
   * 表格与媒体那两路没有实现，wiki 枚举也没有调用点。
   */
  "docx:document:readonly",
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

/**
 * 时间戳，**取不到就 null**（与上面那个带 fallback 的分开）。
 *
 * ★ 文档的时间必须能是 null：猜一个 now 会让下游按时间窗过滤时把一篇老
 * 文档当成刚改过的排到队首，或反过来漏掉它（见 `ParsedDocumentLike.updatedAt`）。
 * 消息那条路可以用 fallback（一条消息总有发送时间，取不到是解析问题），
 * 文档不行（搜索结果里确实可能没有这个字段）。
 */
function optionalTimestamp(value: unknown): number | null {
  if (typeof value === "number") return normalizeUnix(value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return normalizeUnix(numeric)
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

function itemsOf(payload: unknown): unknown[] {
  const data = record(payload)
  for (const key of ["items", "messages", "results", "files"]) {
    if (Array.isArray(data[key])) return array(data[key])
  }
  return Array.isArray(payload) ? payload : []
}

/**
 * 把 IM 搜索/补正文的结果转成**渠道无关**的中间形态。
 *
 * 这是渠道无关性的落点：时间格式、id 形态、@ 字段叫什么，全部在这里吸收 ——
 * 规范化层往下看不出数据来自哪个渠道（见 `ParsedMessageLike` 的注释）。
 */
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

/**
 * 把云文档搜索结果转成消息形态，塞进一个**合成的**「Drive」会话里。
 *
 * ## ★★ 这是一个已知的错形状，待接 `ChannelDocuments` 契约后删除
 *
 * 云文档不是聊天。伪装成 `type:"group"` 的假会话之后，每篇文档变成一条
 * message，于是它会污染四处：FTS 索引、会话列表（用户看到一个不存在的群）、
 * **消息水位**（文档的时间会推进采集水位），以及图谱里的会话边。
 *
 * 正解是 `documents` 表（契约已存在，钉钉那侧在用）。这里保留是因为
 * 删掉它等于飞书的文档一条都不采 —— 而"错地方的数据"至少还能被迁移，
 * "没采到的数据"要重新采一遍。
 */
/**
 * 云文档搜索结果 → **渠道无关的文档形态**（`documents` 表）。
 *
 * ## ★★ 这个函数替换掉的 `parseLarkDrivePage` 是一个正在污染数据的错形状
 *
 * 那个把每篇文档当一条 message、塞进一个合成的假群 `feishu:drive`
 * （`type:"group"`）。四处污染且**都不报错**：会话列表多出一个不存在的群、
 * FTS 把文档正文当聊天正文、**消息水位被文档的编辑时间推进**（文档比消息新
 * 时那段时间的真实消息会被当成已采过）、图谱里生出假群的会话边。
 *
 * ## `contentText` 恒为 null 是刻意的
 *
 * 搜索只返回**摘要片段**，不是正文。把片段写进 `contentText` 的话下游会把它
 * 当全文处理 —— 一篇长文档在图谱里只留几句话，而**看不出是残缺的**。
 * `null` = "有这篇文档但没取到内容"，与钉钉的表格同口径。见 `documents.ts`。
 *
 * 摘要没有被丢掉：它进 `title`（标题为空时的兜底），检索仍能命中这篇文档。
 */
export function parseLarkDriveDocuments(payload: unknown): ParsedDocumentLike[] {
  const out: ParsedDocumentLike[] = []
  for (const [index, raw] of itemsOf(payload).entries()) {
    const item = record(raw)
    const title = stringifyLarkContent(item["title"] ?? item["name"]).trim()
    const snippet = stringifyLarkContent(
      item["summary_highlighted"] ?? item["summary"] ?? item["snippet"],
    ).trim()
    const externalId = str(item["token"], item["document_id"], item["file_token"], item["url"])
    /**
     * ★ 没有稳定 id 的条目**跳过**，不再用下标兜底。
     *
     * 下标（`drive:3:标题`）不稳定：下一轮搜索的排序一变，同一篇文档就换了
     * id —— 于是它会被当成新文档反复入库，而旧的那条永远不会被更新。
     * 那是一个只在"文档多到分页"时才显形的静默重复。
     */
    if (externalId === null) continue
    out.push({
      externalId,
      /** 来源子域。飞书这条路只有云文档搜索一个入口。 */
      origin: "drive",
      // 标题缺失时退回摘要片段（截短）—— 总比在列表里显示空白好
      title: title !== "" ? title : snippet.slice(0, 60) || null,
      docType: str(item["type"], item["obj_type"], item["docs_type"]),
      extension: str(item["extension"], item["file_extension"]),
      url: str(item["url"], item["link"]),
      workspaceId: str(item["space_id"], item["wiki_space_id"]),
      /**
       * ★ 取不到时间就 `null`，**不猜一个 now**。
       *
       * 猜的后果是下游按时间窗过滤会漏掉它（或反过来，把一篇老文档
       * 当成刚改过的排到队首）。见 `ParsedDocumentLike.updatedAt` 的注释。
       */
      updatedAt: optionalTimestamp(item["edit_time_iso"] ?? item["edit_time"]),
      createdAt: optionalTimestamp(item["create_time_iso"] ?? item["create_time"]),
      // 正文要另一条命令（本机验不了，见 documents.ts 的 body()）
      contentText: null,
    })
    void index
  }
  return out
}