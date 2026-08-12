import type {
  AuthStatus,
  ChannelAppBinding,
  ChannelConversationItem,
  ChannelPullPage,
  ParsedConversationLike,
  ParsedDocumentLike,
  ParsedMessageLike,
} from "../../types.js"
import { normalizeUnix } from "../dingtalk/time.js"
import { daysUntil } from "../dingtalk/parse.js"

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
  /**
   * ★★ `tenantKey` 缺失时**不编造** `"feishu"` 这个字面量。
   *
   * ## 那个兜底为什么危险（隔离键会退化）
   *
   * `tenantKey` 进的是 `AuthStatus.corpId`，而 corpId 是身份隔离键
   * `(accountId, channelId, corpId, userId)` 的一段（`ChannelIdentityVaultRepository`）。
   * 兜底成常量的话，**两个不同租户的账号会拿到同一个 corpId** —— 键退化成
   * 只靠 userId 区分，而界面上"组织名"全都显示「飞书」，用户在身份切换器里
   * 分不出这两个"飞书"是哪个公司。更糟的是它**看起来是个合法值**，
   * 没有任何迹象表明这是"读不到"（CLAUDE.md §4 说的静默降级）。
   *
   * ## 实测：正常路径根本用不到兜底
   *
   * `contact +get-user` / `auth status` 的响应里 `tenant_key` 是实打实有的
   * （实测本机：16 字符）。所以这个分支只在**上游改了字段名**时才触发 ——
   * 那正是最需要它说真话的时候。
   *
   * ## 做法：派生一个**带标记且唯一**的值
   *
   * `unknown-tenant:<openId 前 12 位>` —— 三个性质：
   * · **唯一**：跟着 openId 走，两个账号不会撞；
   * · **可识别**：`unknown-tenant:` 前缀一眼看出是"没读到租户"而不是真 id；
   * · **稳定**：同一个人每次解析出同一个值，不会每次授权都新建一个 vault。
   * `tenantName` 同理不再兜「飞书」（那会显示成一个像真的组织名），
   * 而是明确说「未知组织」。
   */
  const tenantKey = str(
    user["tenantKey"],
    user["tenant_key"],
    data["tenantKey"],
    data["tenant_key"],
  )
  const tenantName = str(
    user["tenantName"],
    user["tenant_name"],
    data["tenantName"],
    data["tenant_name"],
  )
  return {
    openId,
    userName:
      str(user["userName"], user["user_name"], user["name"], data["userName"]) ?? "飞书用户",
    tenantKey: tenantKey ?? `unknown-tenant:${openId.slice(0, 12)}`,
    tenantName: tenantName ?? "未知组织",
  }
}

/**
 * 从 `contact +get-user` 的响应里取组织 id（`tenant_key`）。
 *
 * ## ★★ 为什么导出（而不是各处一份）
 *
 * 组织 id 有**两条**需要它的路：
 * · `FeishuAuth.status()` —— 界面上显示的组织名走这条；
 * · `createFeishuIdentity().resolveSelf()` —— 采集侧解析本人身份走这条。
 *
 * 上一轮只修了后者，于是界面上仍是「未知组织」而单测全绿
 * （CDP 探针量出 corpId 长度 27 = 派生值才暴露）。两条路解析同一件事，
 * 那个解析必须**只有一份** —— 各写一份就会再分叉一次。
 *
 * ## 实测层级（本机，飞书已授权）
 *
 * `.data.user.tenant_key`（16 字符）。兜 `.user.*` 与顶层是防上游改信封 ——
 * 那时它至少还能取到，而不是静默回落到派生值。
 */
export function readFeishuTenantKey(payload: unknown): string | null {
  const root = record(payload)
  const candidates = [record(record(root["data"])["user"]), record(root["user"]), root]
  for (const user of candidates) {
    const raw = user["tenant_key"] ?? user["tenantKey"]
    if (typeof raw === "string" && raw !== "") return raw
  }
  return null
}

/**
 * 组织（租户）信息 —— 从 `api GET /open-apis/tenant/v2/tenant/query --as bot`。
 *
 * ## 实测响应（本机，2026-08）
 *
 * ```
 * .data.tenant.name        = '<组织名>'          ← 这才是可读的组织名
 * .data.tenant.tenant_key  = 16 字符
 * .data.tenant.display_id  = 'F…'（组织的公开短号）
 * .data.tenant.domain      = '<子域>.feishu.cn'
 * ```
 *
 * ★ 我一度断言"组织名两条命令都不给、只能显示 tenant_key 短码" ——
 * 错在只查了 shortcut 层（`auth status` / `contact +get-user`）没查 API 层。
 * 界面上那串短码是用户指出来的。
 *
 * 只取 `name`：`display_id` 与 `domain` 是组织的公开标识但对用户没意义
 * （他要的是"这是哪个公司"）；头像暂不用（组织 logo 界面上没有位置）。
 */
export function readFeishuTenantName(payload: unknown): string | null {
  const root = record(payload)
  const candidates = [record(record(root["data"])["tenant"]), record(root["tenant"]), root]
  for (const tenant of candidates) {
    const raw = tenant["name"]
    if (typeof raw === "string" && raw.trim() !== "") return raw
  }
  return null
}

/**
 * 应用层绑定 —— 与"人登录了没有"正交，所以**单独解析**，
 * 且在未授权时也要能返回（见 `ChannelAppBinding` 的说明）。
 *
 * ## 实测字段位置（本机，`auth status --json --verify`）
 *
 * ```
 * .appId                      = 'cli_…'（20 字符）   ← 顶层，不在 identities 下
 * .identities.bot.appName     = '<某人>的飞书 CLI'   ← 应用名只有 bot 这一支有
 * ```
 *
 * ★ `appName` 是**应用**的名字，不是组织名（曾一度想拿它当组织名用 ——
 * 不对，那会把「某人的飞书 CLI」显示成组织）。
 */
function parseLarkAppBinding(payload: unknown): ChannelAppBinding | undefined {
  const data = record(payload)
  const appId = str(data["appId"], data["app_id"])
  if (appId === null || appId.trim() === "") return undefined
  const bot = record(record(data["identities"])["bot"])
  return { appId, appName: str(bot["appName"], bot["app_name"]) }
}

export function parseLarkAuthStatus(payload: unknown, now: Date = new Date()): AuthStatus {
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
  const appBinding = parseLarkAppBinding(payload)
  /**
   * ★★ 未授权时**照样带上 appBinding** —— 这正是两步之间那个中间态。
   *
   * "应用已绑、人还没登录"与"什么都没有"在界面上是两件完全不同的事：
   * 前者只差第 ② 步（点「登录」即可），后者要从第 ① 步开始。
   * 原来两者都返回裸 `{state:"unauthorized"}`，于是界面无法区分，
   * 只能给一颗含糊的「开始授权」按钮。
   */
  if (identity === null || (!verified && !valid) || !hasScopes) {
    return appBinding === undefined
      ? { state: "unauthorized" }
      : { state: "unauthorized", appBinding }
  }
  /**
   * 两个过期时间。CLI 用 camelCase（`expiresAt`/`refreshExpiresAt`），
   * 但也兜一下 snake_case —— 上游换风格时不至于静默变回「—」。
   */
  const accessExpiresAt = str(user["expiresAt"], user["expires_at"], data["expiresAt"])
  const refreshExpiresAt = str(
    user["refreshExpiresAt"],
    user["refresh_expires_at"],
    data["refreshExpiresAt"],
  )
  return {
    state: "authorized",
    ...(appBinding === undefined ? {} : { appBinding }),
    corpId: identity.tenantKey,
    corpName: identity.tenantName,
    userId: identity.openId,
    userName: identity.userName,
    /**
     * ★★ 这三个原来硬编码 `null`，界面上就是两行「—」（用户截图）。
     *
     * CLI **给了**这两个时间，在 `identities.user` 下（实测本机响应）：
     *
     *     expiresAt        2026-08-10T19:42:17+08:00   access token
     *     refreshExpiresAt 2026-08-17T17:42:17+08:00   refresh token（7 天）
     *
     * 也就是说不是"拿不到"，是这一层没读。
     *
     * ★ `daysUntilRefreshExpiry` 复用钉钉那侧的 `daysUntil` —— 两处各写一份
     * 会让同一个界面上出现两种口径（一个按自然日、一个按 24 小时整除，
     * 跨零点时差一天）。它已经导出，直接用。
     *
     * ★ 取不到时仍是 `null`（而不是 0）：`daysUntil` 对无法解析的串返回 0，
     * 而 0 的意思是"今天就到期" —— 那与"不知道"完全不同，会让界面催用户
     * 去重新授权一个其实还有效的凭据。
     */
    accessExpiresAt: accessExpiresAt ?? refreshExpiresAt,
    refreshExpiresAt,
    daysUntilRefreshExpiry: refreshExpiresAt === null ? null : daysUntil(refreshExpiresAt, now),
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
 *
 * @param selfOpenId 本人的 open_id（`ou_…`），拿不到时给 null。
 *   只用于**单聊会话名**那条推导 —— 见下面 `fromPartner` 那段。
 */
export function parseLarkMessagePage(
  payload: unknown,
  fetchedAt: number,
  selfOpenId: string | null = null,
): ChannelPullPage {
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
    const isDirect = chatType === "p2p" || chatType === "direct"
    /**
     * ★★ 单聊的会话名要从**对端的名字**里取。
     *
     * 实测：消息搜索的响应里 `chat_partner` **只有 open_id、没有名字**
     * （`{"open_id":"ou_…"}`），而 `chat_name` / `chat.name` 在单聊上压根不存在。
     * 于是原来那三个候选全空 → 每个单聊都叫「飞书会话」，用户在采集范围里
     * 看到几行一模一样的「飞书会话」，完全没法选。
     *
     * 而 `sender.name` **是有真名的**。所以单聊取"对端那条消息"的 sender 名。
     *
     * ## ★★ 两条判据，缺一不可
     *
     * ① `sender.open_id === chat_partner.open_id` —— 明确是对端发的。
     * ② `sender.open_id !== selfOpenId` —— **不是我**发的。
     *
     * 只有 ① 时漏掉一整类：**对端从没发过消息**的单聊（我发出去对方没回）。
     * 实测本机 4 个飞书单聊里有 3 个是这样 —— 它们的 `chat_partner.open_id`
     * 在整页消息里一次都不作为 sender 出现，于是判据 ① 永不成立，
     * 标题恒为占位。改动前那一版只有 ①，所以那 3 个会话仍然叫「飞书会话」。
     *
     * ★ 这时 ② 给出的名字**是我自己的** —— 那不对，所以只在
     * `senderOpenId !== selfOpenId` 时才采用（也就是"能确定不是我"）。
     * 只有我自己发过消息的单聊仍然取不到对端名字（响应里确实没有），
     * 那时保持占位 —— 编一个名字比显示占位更糟。
     *
     * ★ `selfOpenId` 为 null（身份还没解析）时 ② 整条跳过，退化成只有 ①，
     * 与改动前行为一致 —— 而不是把我自己的名字当成对端名。
     *
     * ★ 已经有名字的会话**不覆盖**：同一个会话会在多页里重复出现，而后一页
     * 可能恰好只有我自己发的消息 —— 那时不该把已经拿到的名字冲成占位。
     */
    const partnerOpenId = str(partner["open_id"], partner["openId"])
    const senderOpenId = str(sender["open_id"], sender["openId"], sender["id"])
    const senderName = str(sender["name"], sender["display_name"])
    /** ① 明确是对端发的 */
    const byPartnerId =
      isDirect && partnerOpenId !== null && senderOpenId === partnerOpenId ? senderName : null
    /** ② 能确定"不是我"（对端没发过消息时这条是唯一出路） */
    const byNotSelf =
      isDirect && selfOpenId !== null && senderOpenId !== null && senderOpenId !== selfOpenId
        ? senderName
        : null
    const fromPartner = byPartnerId ?? byNotSelf

    const known = conversations.get(conversationId)
    /**
     * ★★ 推不出名字时给 **null**，而不是写一个占位字符串进库。
     *
     * 占位值（`飞书会话`）是非 null 的，而落库那侧是
     * `title = COALESCE(excluded.title, conversations.title)` —— 于是占位会
     * **覆盖掉一个已经拿到的真名**：同一个会话在下一页/下一轮里恰好只有我
     * 自己发言时，那次 upsert 就把名字冲回占位了。
     *
     * 上面那句"已有名字优先于占位"只在**单页内**成立（`conversations` 是这一页
     * 的 Map），跨页跨轮次不成立 —— 而跨轮次才是常态。
     *
     * 给 null 之后 `COALESCE` 天然保护已有真名，且"这个会话还没有名字"这件事
     * 如实传下去（渲染层据此给兜底文案，见 `sources-step.tsx`）——
     * 而不是把一个我们编的字符串伪装成渠道给的会话名。
     */
    const title =
      str(item["chat_name"], chat["name"], partner["name"]) ??
      fromPartner ??
      // 上一页已经拿到的名字仍然优先（同一页内多条消息时有用）
      known?.title ??
      null
    conversations.set(conversationId, {
      externalId: conversationId,
      title,
      type: isDirect ? "direct" : "group",
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

/**
 * `im +chat-list` 一页 → 渠道无关的会话项 + 下一页游标。
 *
 * ## 实测的响应形状（2026-08，随包 CLI，值已换成假的）
 *
 * ```json
 * { "ok": true, "identity": "user", "data": {
 *     "chats": [{
 *       "chat_id": "oc_FAKE00000000000000000000000000",
 *       "chat_mode": "p2p",            // p2p | group | topic
 *       "chat_status": "normal",
 *       "external": false,
 *       "name": "张三",
 *       "p2p_target_id": "ou_FAKE0000000000000000000000000",
 *       "p2p_target_type": "bot",      // bot | user
 *       "tenant_key": "FAKE000000000000"
 *     }],
 *     "has_more": false, "page_token": null } }
 * ```
 *
 * ## ★★★ `chats` 可能是 `null`（不是空数组）
 *
 * 实测：账号里没有群时 `--types=group` 返回的 `chats` 就是 `null`。
 * 不挡住的话下游 `.map` 直接抛，而那会让整个会话列表变成"读取失败"
 * —— 一个"你没有群"的正常状态被显示成故障。
 *
 * ## ★★ 机器人会话**照常列出**
 *
 * 实测这个账号 4 个 p2p 里 3 个是 `p2p_target_type: "bot"`（应用通知）。
 * 不过滤：它们是真会话、库里也真有它们的消息（采集已在采），
 * 藏掉等于"4 个会话只显示 1 个"且无从解释。选不选由用户定。
 *
 * ## `kind` 的映射
 *
 * `p2p` → `direct`，其余（`group` / `topic`）→ `group`。
 * topic（话题群）归 group 而不是单独一档：上层只有这两种，
 * 而话题群在"要不要采它"这件事上与普通群没区别。
 */
export function parseLarkChatList(payload: unknown): {
  items: ChannelConversationItem[]
  nextToken: string | null
  hasMore: boolean
} {
  const data = record(record(payload)["data"] ?? payload)
  // ★ `chats` 为 null 时 `array()` 给空数组 —— 见上面那段
  const rows = array(data["chats"])
  const items: ChannelConversationItem[] = []
  for (const raw of rows) {
    const item = record(raw)
    const externalId = str(item["chat_id"], item["id"])
    // 没有 id 的条目跳过：白名单里没有能反查它的命令，留着也选不动
    if (externalId === null) continue
    const mode = str(item["chat_mode"], item["mode"])
    const name = str(item["name"], item["title"])
    items.push({
      externalId,
      title: name,
      kind: mode === "p2p" ? "direct" : "group",
      /**
       * ★ 这条命令**不返回成员数**（实测字段只有上面那 8 个）。
       * 给 null 而不是猜 —— 合并层会用本地表里的值补（那是真数的）。
       */
      memberCount: null,
      /**
       * ★ 同样不返回最后消息时间。
       *
       * 注意 `--sort=active_time` 只影响**排序**，不会多给一个时间字段。
       * 猜一个 now 的后果是列表按"刚刚"排序、且下游按时间窗过滤时全部命中，
       * 那比没有时间更糟。合并层会用本地表的 `last_message_at` 补。
       */
      lastMessageAt: null,
    })
  }
  /**
   * ★ `hasMore` 与游标**都要给**，且以 `hasMore` 为准。
   *
   * 钉钉那边实测过 277 页里 276 页 `hasMore:false` 却仍返回非空游标
   * （见 `ChannelPullPage.nextCursor` 的注释）—— 只看游标会永不终止。
   * 飞书这条命令目前没观察到那个毛病（单页 has_more:false + page_token:null），
   * 但判据照同一条走，不给它机会。
   */
  return {
    items,
    nextToken: str(data["page_token"], data["pageToken"]),
    hasMore: data["has_more"] === true,
  }
}
