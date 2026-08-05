/**
 * 会话 JWT 测试。
 *
 * 重点不是「正常路径能签能验」，而是**各种伪造尝试都被拒**：
 * 这段代码是登录态的唯一判定依据，它宽容一分，登录门禁就少一分。
 */
import { createHmac, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { decodeJwtClaims, signJwt, verifyJwt } from "@mycontext/kernel"

const SECRET = Buffer.from("0".repeat(64), "hex")
// 显式 Buffer.from 复制一份：randomBytes 的返回类型是 Buffer<ArrayBufferLike>，
// 而 SignJwtInput.secret 要求 Buffer<ArrayBuffer>（SharedArrayBuffer 不兼容）。
const OTHER_SECRET = Buffer.from(randomBytes(32))
const ISSUER = "mycontext/test"
const NOW = Date.parse("2026-07-28T00:00:00.000Z")

function base64Url(input: string): string {
  return Buffer.from(input).toString("base64url")
}

const valid = (overrides: Partial<Parameters<typeof signJwt>[0]> = {}) =>
  signJwt({
    subject: "account-1",
    issuer: ISSUER,
    ttlSeconds: 3600,
    secret: SECRET,
    nowMs: NOW,
    ...overrides,
  })

const verify = (token: string, nowMs = NOW, secret = SECRET) =>
  verifyJwt({ token, issuer: ISSUER, secret, nowMs })

describe("签发与校验", () => {
  it("签出的 token 能验过，并带回 sub / iat / exp", () => {
    const result = verify(valid())
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.claims.sub).toBe("account-1")
    expect(result.claims.iat).toBe(Math.floor(NOW / 1000))
    expect(result.claims.exp).toBe(Math.floor(NOW / 1000) + 3600)
  })

  it("三段结构且 header 声明 HS256", () => {
    const [header, payload, signature] = valid().split(".")
    expect(signature).toBeTruthy()
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    })
    // payload 是编码不是加密：这里明确记录这一点，也确认没塞多余东西。
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString())
    expect(Object.keys(claims).sort()).toEqual(["exp", "iat", "iss", "sub"])
  })

  it("附加载荷会带进 claims", () => {
    const result = verify(valid({ payload: { device: "mac" } }))
    expect(result.valid && result.claims["device"]).toBe("mac")
  })

  it("token 里不含口令之类的敏感内容（payload 可被任何人解开）", () => {
    const token = valid({ payload: { device: "mac" } })
    expect(token).not.toContain("password")
    expect(decodeJwtClaims(token)?.sub).toBe("account-1")
  })
})

describe("拒绝伪造", () => {
  it("改动 payload 后签名失效", () => {
    const [header, , signature] = valid().split(".")
    const forged = `${header}.${base64Url(
      JSON.stringify({ sub: "account-2", iss: ISSUER, iat: 1, exp: 9_999_999_999 }),
    )}.${signature}`
    expect(verify(forged)).toEqual({ valid: false, reason: "signature" })
  })

  it("换一把密钥签的 token 验不过", () => {
    expect(verify(valid({ secret: OTHER_SECRET }))).toEqual({ valid: false, reason: "signature" })
  })

  it("用错误的密钥校验同一个 token 也验不过（密钥轮换后旧会话失效）", () => {
    expect(verify(valid(), NOW, OTHER_SECRET)).toEqual({ valid: false, reason: "signature" })
  })

  /**
   * alg: none 是 JWT 最经典的一类漏洞：库看到 alg 为 none 就跳过验签。
   * 这里签名一定先验，因此它落在 signature 而不是被放行。
   */
  it("alg:none + 空签名被拒", () => {
    const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }))
    const payload = base64Url(
      JSON.stringify({ sub: "account-1", iss: ISSUER, iat: 1, exp: 9_999_999_999 }),
    )
    expect(verify(`${header}.${payload}.`)).toEqual({ valid: false, reason: "signature" })
  })

  /**
   * alg 混淆：签名用的是正确的 HMAC，但 header 声称是别的算法。
   * 只认 HS256，因此即使签名对得上也拒——否则将来引入非对称算法时，
   * 「用公钥当 HMAC 密钥」这条经典攻击路径就成立了。
   */
  it("签名正确但 header 声称其他算法时被拒", () => {
    const header = base64Url(JSON.stringify({ alg: "HS512", typ: "JWT" }))
    const payload = base64Url(
      JSON.stringify({ sub: "account-1", iss: ISSUER, iat: 1, exp: 9_999_999_999 }),
    )
    const signature = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url")
    expect(verify(`${header}.${payload}.${signature}`)).toEqual({
      valid: false,
      reason: "unsupported-alg",
    })
  })

  it("签发方不匹配时被拒（别处签的同密钥 token 不能当会话用）", () => {
    const token = signJwt({
      subject: "account-1",
      issuer: "mycontext/export-link",
      ttlSeconds: 3600,
      secret: SECRET,
      nowMs: NOW,
    })
    expect(verify(token)).toEqual({ valid: false, reason: "issuer" })
  })

  it("段数不对、空串、乱码都归到 malformed 或 signature，不抛错", () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "...", "a.b.c"]) {
      expect(() => verify(bad)).not.toThrow()
      expect(verify(bad).valid).toBe(false)
    }
  })

  it("签名段长度不同时不抛错（timingSafeEqual 要求等长）", () => {
    const [header, payload] = valid().split(".")
    expect(() => verify(`${header}.${payload}.short`)).not.toThrow()
    expect(verify(`${header}.${payload}.short`)).toEqual({ valid: false, reason: "signature" })
  })

  it("缺少 sub 的 token 被拒（签名对也不行）", () => {
    // 手工签一个合法签名但 claim 不全的 token：验证「签名过了」不等于「放行」。
    const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    const payload = base64Url(JSON.stringify({ iss: ISSUER, iat: 1, exp: 9_999_999_999 }))
    const signature = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url")
    expect(verify(`${header}.${payload}.${signature}`)).toEqual({
      valid: false,
      reason: "malformed",
    })
  })

  /**
   * 附加载荷不能覆盖标准 claim。
   * 否则调用方一个 `payload: { sub: 攻击者可控值 }` 就能改掉会话主体，
   * 而这类调用看起来完全无害。
   */
  it("附加载荷无法覆盖 sub / exp / iss", () => {
    const token = valid({
      payload: { sub: "account-evil", exp: 9_999_999_999, iss: "elsewhere" },
    })
    const result = verify(token)
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.claims.sub).toBe("account-1")
    expect(result.claims.iss).toBe(ISSUER)
    expect(result.claims.exp).toBe(Math.floor(NOW / 1000) + 3600)
  })
})

describe("过期", () => {
  it("到期前一秒仍有效", () => {
    expect(verify(valid({ ttlSeconds: 60 }), NOW + 59_000).valid).toBe(true)
  })

  it("到期当秒即失效（边界取「不含」，宁可早一秒也不晚一秒）", () => {
    expect(verify(valid({ ttlSeconds: 60 }), NOW + 60_000)).toEqual({
      valid: false,
      reason: "expired",
    })
  })

  it("过期与篡改给出不同原因（一个是正常生命周期，一个值得报警）", () => {
    const expired = verify(valid({ ttlSeconds: 1 }), NOW + 10_000)
    expect(expired.valid === false && expired.reason).toBe("expired")
  })
})

describe("decodeJwtClaims", () => {
  it("不验签地读出 claims（只用于日志排障）", () => {
    expect(decodeJwtClaims(valid())?.sub).toBe("account-1")
  })

  it("非法输入返回 null 而不抛错", () => {
    expect(decodeJwtClaims("nope")).toBeNull()
    expect(decodeJwtClaims("a.b.c")).toBeNull()
  })
})
