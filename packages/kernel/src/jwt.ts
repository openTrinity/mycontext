/**
 * HS256 JWT 签发与校验。
 *
 * 自己实现而不引三方库：需要的只是 HMAC-SHA256 + base64url，
 * node:crypto 全都有；而 jsonwebtoken 这类库的历史漏洞几乎都出在
 * 「解析阶段过于宽容」——alg 混淆、alg:none、kid 注入。
 * 这里的实现刻意不宽容：只认 HS256，其余一律拒。
 *
 * 本阶段签的是**本地会话** token（没有服务端，密钥只在本机），
 * 结构按标准 claim 来（sub/iat/exp/iss），这样后续接远端统一登录时
 * 校验逻辑与消费方代码不用改，只换密钥来源与签发方。
 *
 * ⚠️ 本地 JWT 不是「防本机用户」的机制：能读到密钥的人就能签任意 token。
 * 它的作用是让「登录态」有一个不可被手改的、自带过期时间的单一凭据
 * （改一个字节签名就失效），以及与未来远端会话共用同一套校验路径。
 */
import { createHmac, timingSafeEqual } from "node:crypto"

/** 只支持一种算法。多一种就多一条 alg 混淆的攻击面。 */
const ALGORITHM = "HS256"

export interface JwtClaims {
  /** subject：本阶段是 accountId */
  sub: string
  /** 签发时间（秒） */
  iat: number
  /** 过期时间（秒） */
  exp: number
  /** 签发方，用于隔离不同用途的 token */
  iss: string
  /** 自定义载荷。不要放敏感信息——JWT 的 payload 只是编码，不是加密。 */
  [key: string]: unknown
}

export type JwtVerifyResult =
  | { valid: true; claims: JwtClaims }
  /**
   * 失败一定带原因：调用方要据此区分「让用户重新登录」（expired）
   * 与「有人动过存储」（signature/malformed，值得记一条 warn）。
   */
  | { valid: false; reason: "malformed" | "unsupported-alg" | "signature" | "expired" | "issuer" }

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

function sign(data: string, secret: Buffer): string {
  return base64UrlEncode(createHmac("sha256", secret).update(data).digest())
}

export interface SignJwtInput {
  subject: string
  issuer: string
  /** 有效期（秒） */
  ttlSeconds: number
  secret: Buffer
  /** 当前时间（毫秒），便于测试注入 */
  nowMs?: number
  /** 附加载荷（非敏感） */
  payload?: Record<string, unknown>
}

export function signJwt(input: SignJwtInput): string {
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000)
  const header = { alg: ALGORITHM, typ: "JWT" }
  const claims: JwtClaims = {
    ...input.payload,
    sub: input.subject,
    iss: input.issuer,
    iat: issuedAt,
    exp: issuedAt + input.ttlSeconds,
  }

  const encoded = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`
  return `${encoded}.${sign(encoded, input.secret)}`
}

export interface VerifyJwtInput {
  token: string
  issuer: string
  secret: Buffer
  nowMs?: number
}

/**
 * 校验并解析。
 *
 * 顺序是刻意的：**先验签名，再看 claim**。
 * 反过来的话，未签名的 payload 就能影响控制流（比如伪造一个远未来的 exp
 * 让「过期」分支不走），而这类逻辑最终总会被人当成「已验证」来用。
 */
export function verifyJwt(input: VerifyJwtInput): JwtVerifyResult {
  const parts = input.token.split(".")
  if (parts.length !== 3) return { valid: false, reason: "malformed" }
  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string]

  const expected = sign(`${encodedHeader}.${encodedPayload}`, input.secret)
  const actual = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  // 长度不同时 timingSafeEqual 会抛，所以先比长度；长度本身不是秘密。
  if (actual.length !== expectedBuffer.length) return { valid: false, reason: "signature" }
  if (!timingSafeEqual(actual, expectedBuffer)) return { valid: false, reason: "signature" }

  let header: unknown
  let claims: unknown
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8"))
    claims = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"))
  } catch {
    return { valid: false, reason: "malformed" }
  }

  if (
    typeof header !== "object" ||
    header === null ||
    (header as Record<string, unknown>)["alg"] !== ALGORITHM
  ) {
    return { valid: false, reason: "unsupported-alg" }
  }

  if (typeof claims !== "object" || claims === null) return { valid: false, reason: "malformed" }
  const record = claims as Record<string, unknown>
  if (
    typeof record["sub"] !== "string" ||
    record["sub"] === "" ||
    typeof record["iat"] !== "number" ||
    typeof record["exp"] !== "number"
  ) {
    return { valid: false, reason: "malformed" }
  }

  // 签发方不匹配即拒：避免别处签的同密钥 token 被当成会话用。
  if (record["iss"] !== input.issuer) return { valid: false, reason: "issuer" }

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000)
  if (record["exp"] <= nowSeconds) return { valid: false, reason: "expired" }

  return { valid: true, claims: record as JwtClaims }
}

/** 不校验签名地读取 claim。仅用于日志与排障，**不可**用于任何判定。 */
export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const claims: unknown = JSON.parse(base64UrlDecode(parts[1] as string).toString("utf8"))
    if (typeof claims !== "object" || claims === null) return null
    return claims as JwtClaims
  } catch {
    return null
  }
}
