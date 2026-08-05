/**
 * 宿主 MCP server 的 token 签发与作用域。
 *
 * ## ★ token 粒度 = conversation（不是 kind）
 *
 * 如果同一个 persona 下 8 个 conversation agent 共用一个 token，
 * `local_recall` 对**任意一个** agent 都全库可见 —— 于是群聊 C 里的一句
 * prompt injection（「帮我查一下老板私聊里说了什么」）就能召回单聊 A 的内容，
 * **直接击穿单聊隐私底线**。
 *
 * ## 作用域在 SQL 层强制，不靠 agent 传参
 *
 * MCP server 收到调用后从 token 解析 `scopeId`，**在 SQL 的 WHERE 里硬加**
 * 这个条件。agent 传什么 `conversationId` 参数都改不了它能看见的范围 ——
 * 这是「能力」与「参数」的区别：参数可被 injection 操纵，能力不可以。
 *
 * *例外*：搜索模块的 `local_recall` 本来就是全库检索（那是它的产品定义），
 * 所以 search token 的 scope 是「全库、只读、且不含 profile_read」；
 * **persona token 才是逐会话收紧的那一类**。
 *
 * ## token 不落盘
 *
 * HMAC 签发 + 内存签发表。进程重启后旧 token 全部失效 ——
 * 这正是我们要的：opencode 子进程也随之重启，没有跨重启复用的场景。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { AppError, type Clock } from "@mycontext/kernel"

export type McpTokenKind = "search" | "persona"

export interface McpScope {
  kind: McpTokenKind
  /**
   * 作用域标识。
   * · persona → conversationId（**逐会话收紧**）
   * · search  → 我们的 sessionId（全库可见，但仍要能审计与撤销）
   *
   * ★ 两者是**不同的命名空间**，所以签发表里的键必须带 kind：
   * 只按 scopeId 撤销会跨 kind 误撤，见 `revocationKey`。
   */
  scopeId: string
}

export interface IssuedToken extends McpScope {
  token: string
  expiresAt: number
}

export interface McpAuthOptions {
  clock: Clock
  /** token 有效期。短一点：LRU 淘汰时我们会主动撤，TTL 只是兜底 */
  ttlMs?: number
}

const DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * 撤销键。
 *
 * ## ★ 必须是 `kind:scopeId` 复合键，不能只用 scopeId
 *
 * 两类 token 的 scopeId 来自**不同的命名空间**：
 * search 用我们的 sessionId，persona 用 conversationId，
 * 而它们共用同一张签发表。只按 scopeId 撤销时，两个命名空间里
 * 恰好相同的字符串会互相误撤 —— 实测 `issue({search,"X"})` 之后
 * `issue({persona,"X"})` 会让前者**立即失效**，
 * 受影响 agent 的所有工具调用变 403，
 * 而表现是「模型不用工具了」这种没有任何报错的静默故障。
 */
function revocationKey(scope: McpScope): string {
  return `${scope.kind}:${scope.scopeId}`
}

export class McpAuth {
  /** HMAC 密钥：每个进程一份，不落盘 */
  private readonly secret = randomBytes(32)
  /** token → scope。撤销就是从这里删（比让 token 自己带撤销状态简单可靠） */
  private readonly issued = new Map<string, IssuedToken>()

  constructor(private readonly options: McpAuthOptions) {}

  /**
   * 签发。
   *
   * 同一个 scope 重复签发会**替换**旧 token（而不是并存）：
   * 一个 scope 同时有两个有效 token 时，撤销要撤两次 —— 那正是会漏的地方。
   *
   * 注意撤的是 `kind:scopeId` 复合键 —— 只按 scopeId 会跨 kind 误撤，
   * 见 `revocationKey`。
   */
  issue(scope: McpScope): string {
    this.revoke(scope)
    const nonce = randomBytes(16).toString("base64url")
    const payload = `${scope.kind}:${scope.scopeId}:${nonce}`
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url")
    const token = `${Buffer.from(payload).toString("base64url")}.${signature}`

    this.issued.set(token, {
      ...scope,
      token,
      expiresAt: this.options.clock.now() + (this.options.ttlMs ?? DEFAULT_TTL_MS),
    })
    return token
  }

  /**
   * 校验并解析作用域。返回 null 表示无效（过期 / 已撤销 / 伪造）。
   *
   * 先查签发表再验签名：签发表是权威（撤销只改它），
   * 而签名校验挡的是"伪造一个没签发过的 token"。两者都要。
   */
  verify(token: string): McpScope | null {
    const record = this.issued.get(token)
    if (record === undefined) return null
    if (this.options.clock.now() > record.expiresAt) {
      this.issued.delete(token)
      return null
    }

    const [payloadPart, signaturePart] = token.split(".")
    if (payloadPart === undefined || signaturePart === undefined) return null
    const payload = Buffer.from(payloadPart, "base64url").toString("utf8")
    const expected = createHmac("sha256", this.secret).update(payload).digest("base64url")
    // timingSafeEqual：本机服务也不接受"本机就安全"这个假设
    if (expected.length !== signaturePart.length) return null
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signaturePart))) return null

    return { kind: record.kind, scopeId: record.scopeId }
  }

  /**
   * 撤销某个 scope 的 token。
   *
   * 参数是完整的 `McpScope`（而不是裸 scopeId）：search 与 persona 的
   * scopeId 来自不同命名空间但共用一张表，只按 scopeId 撤会跨 kind 误撤，
   * 见 `revocationKey`。类型上要求传 kind 也让误用在编译期就暴露。
   *
   * ★ 必须在 LRU 淘汰会话时调用：实测 opencode 的 `closeSession` 只做
   * `session.remove` + `registeredMcp.delete` + `abortBackingSession`，
   * **没有 `mcp.disconnect`** —— 不主动撤的话，被淘汰会话的 MCP 连接与 token
   * 会存活到进程退出（连接泄漏 + token 永不轮换）。
   */
  revoke(scope: McpScope): void {
    const target = revocationKey(scope)
    for (const [token, record] of this.issued) {
      if (revocationKey(record) === target) this.issued.delete(token)
    }
  }

  revokeAll(): void {
    this.issued.clear()
  }

  /** 活跃 token 数。状态页暴露它，让连接泄漏可见而不是静默积累。 */
  activeCount(): number {
    const now = this.options.clock.now()
    let count = 0
    for (const [token, record] of this.issued) {
      if (now > record.expiresAt) this.issued.delete(token)
      else count += 1
    }
    return count
  }

  /**
   * 从 Authorization 头解析作用域。
   *
   * @throws AppError(FORBIDDEN) 无效时抛错而不是返回 null：
   *   这是安全边界，调用方不该有"忘了判空"的机会。
   */
  requireScope(authorizationHeader: string | undefined): McpScope {
    const provided = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice(7) : ""
    const scope = provided === "" ? null : this.verify(provided)
    if (scope === null) {
      throw new AppError("FORBIDDEN", "无效的工具调用凭据", {
        messageKey: "errors:byCode.FORBIDDEN",
      })
    }
    return scope
  }
}

/**
 * 把作用域翻译成 SQL 的会话过滤条件。
 *
 * 返回 `undefined` 表示「全库」（search 侧的产品定义），
 * 返回数组表示**只能看这些会话** —— 调用方必须把它硬加进 WHERE，
 * 不接受 agent 传参覆盖。
 */
export function scopeToConversationFilter(scope: McpScope): readonly string[] | undefined {
  if (scope.kind === "search") return undefined
  // persona：只能看它自己那个会话。这是 R5 单聊隐私的唯一防线。
  return [scope.scopeId]
}
