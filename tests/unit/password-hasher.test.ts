import { describe, expect, it } from "vitest"
import { ScryptPasswordHasher } from "@main/services/password-hasher"

/** 真实 scrypt 较慢，这里用轻量参数验证逻辑正确性（强度参数由生产默认值保证）。 */
const hasher = new ScryptPasswordHasher({ algorithm: "scrypt", N: 1024, r: 8, p: 1, keyLength: 32 })

describe("ScryptPasswordHasher", () => {
  it("同一口令验证通过", async () => {
    const credential = await hasher.hash("password123")
    await expect(hasher.verify({ password: "password123", ...credential })).resolves.toBe(true)
  })

  it("错误口令验证失败", async () => {
    const credential = await hasher.hash("password123")
    await expect(hasher.verify({ password: "password124", ...credential })).resolves.toBe(false)
  })

  it("每次哈希使用不同盐，相同口令产生不同摘要", async () => {
    const first = await hasher.hash("password123")
    const second = await hasher.hash("password123")
    expect(first.salt).not.toBe(second.salt)
    expect(first.hash).not.toBe(second.hash)
  })

  it("摘要中不包含口令明文", async () => {
    const credential = await hasher.hash("my-secret-password")
    expect(JSON.stringify(credential)).not.toContain("my-secret-password")
  })

  it("Unicode 口令按 NFKC 归一后可稳定验证", async () => {
    const credential = await hasher.hash("café-口令-123")
    await expect(hasher.verify({ password: "café-口令-123", ...credential })).resolves.toBe(true)
  })

  it("参数损坏时返回 false 而不是抛错", async () => {
    const credential = await hasher.hash("password123")
    await expect(
      hasher.verify({ ...credential, password: "password123", params: "not-json" }),
    ).resolves.toBe(false)
  })

  it("摘要长度不匹配时返回 false（timingSafeEqual 不会抛错）", async () => {
    const credential = await hasher.hash("password123")
    await expect(
      hasher.verify({ ...credential, password: "password123", hash: "c2hvcnQ=" }),
    ).resolves.toBe(false)
  })

  it("生产默认参数可用（N=2^15）", async () => {
    const production = new ScryptPasswordHasher()
    const credential = await production.hash("password123")
    await expect(production.verify({ password: "password123", ...credential })).resolves.toBe(true)
  })
})
