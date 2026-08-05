import { describe, expect, it, beforeEach } from "vitest"
import { createLogger, decodeJwtClaims } from "@mycontext/kernel"
import {
  AccountRepository,
  openStore,
  SessionStore,
  SettingsRepository,
  type StoreHandle,
} from "@mycontext/store"
import { AuthService, canonicalizeEmail } from "@main/services/auth.service"
import type { PasswordHasher } from "@main/services/password-hasher"
import type { SigningKeyProvider } from "@main/services/signing-key.service"

/**
 * 测试用哈希器：真实 scrypt（N=2^15）单次约 100ms，
 * 一组用例跑下来会拖到十几秒。算法本身另有专门用例覆盖。
 */
const fakeHasher: PasswordHasher = {
  hash: async (password) => ({
    hash: `hashed:${password}`,
    salt: "salt",
    params: JSON.stringify({ algorithm: "scrypt" }),
  }),
  verify: async ({ password, hash }) => hash === `hashed:${password}`,
}

const silentLogger = createLogger("Test", { level: "error" })

/** 固定密钥：签名逻辑本身由 jwt.test.ts 覆盖，这里只要「同一把」。 */
const FIXED_KEY = Buffer.alloc(32, 7)
const fixedKey: SigningKeyProvider = { get: () => FIXED_KEY }

let store: StoreHandle
let auth: AuthService
let sessions: SessionStore
/** 可控时钟：验证会话 token 的过期判定 */
let currentTime: Date

/** 用同一个库重建一个 AuthService，模拟「应用重启」 */
function restartApp(
  now: () => Date = () => currentTime,
  signingKey: SigningKeyProvider = fixedKey,
): AuthService {
  return new AuthService({
    accounts: new AccountRepository(store.db),
    sessions: new SessionStore(new SettingsRepository(store.db)),
    signingKey,
    hasher: fakeHasher,
    logger: silentLogger,
    now,
  })
}

beforeEach(() => {
  store = openStore({ path: ":memory:" })
  currentTime = new Date("2026-07-28T00:00:00.000Z")
  sessions = new SessionStore(new SettingsRepository(store.db))
  auth = new AuthService({
    accounts: new AccountRepository(store.db),
    sessions,
    signingKey: fixedKey,
    hasher: fakeHasher,
    logger: silentLogger,
    now: () => currentTime,
  })
})

describe("邮箱归一化", () => {
  it("去空格并转小写", () => {
    expect(canonicalizeEmail("  User@Example.COM ")).toBe("user@example.com")
  })
})

describe("注册", () => {
  it("成功后建立会话并保留原始大小写用于展示", async () => {
    const session = await auth.register({ email: "User@Example.com", password: "password123" })
    expect(session.email).toBe("User@Example.com")
    expect(session.accountId).toBeTruthy()
    expect(auth.currentSession()).toEqual(session)
    expect(auth.hasAccount()).toBe(true)
  })

  it("拒绝重复邮箱（含大小写/空格差异）", async () => {
    await auth.register({ email: "user@example.com", password: "password123" })
    await expect(
      auth.register({ email: " USER@example.com ", password: "password456" }),
    ).rejects.toMatchObject({ code: "AUTH_EMAIL_TAKEN" })
  })

  it("拒绝过短口令", async () => {
    await expect(auth.register({ email: "a@b.com", password: "short" })).rejects.toMatchObject({
      code: "AUTH_WEAK_PASSWORD",
    })
  })

  it("拒绝格式非法的邮箱", async () => {
    for (const email of ["not-an-email", "missing@domain", "@example.com", "a b@example.com"]) {
      await expect(auth.register({ email, password: "password123" })).rejects.toMatchObject({
        code: "AUTH_INVALID_EMAIL",
      })
    }
  })
})

describe("登录", () => {
  beforeEach(async () => {
    await auth.register({ email: "user@example.com", password: "password123" })
    auth.logout()
  })

  it("正确口令可登录", async () => {
    const session = await auth.login({ email: "user@example.com", password: "password123" })
    expect(session.accountId).toBeTruthy()
    expect(auth.currentSession()).not.toBeNull()
  })

  it("邮箱大小写与空格不影响登录", async () => {
    const session = await auth.login({ email: " USER@Example.COM ", password: "password123" })
    expect(session.accountId).toBeTruthy()
  })

  it("错误口令被拒绝且不建立会话", async () => {
    await expect(
      auth.login({ email: "user@example.com", password: "wrong-password" }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" })
    expect(auth.currentSession()).toBeNull()
  })

  it("不存在的账号与错误口令返回同一个错误码，避免暴露已注册邮箱", async () => {
    const missing = await auth
      .login({ email: "nobody@example.com", password: "password123" })
      .catch((error: unknown) => error)
    const wrong = await auth
      .login({ email: "user@example.com", password: "nope-nope" })
      .catch((error: unknown) => error)

    expect((missing as { code: string }).code).toBe("AUTH_INVALID_CREDENTIALS")
    expect((wrong as { code: string }).code).toBe("AUTH_INVALID_CREDENTIALS")
    expect((missing as Error).message).toBe((wrong as Error).message)
  })

  it("登录会记录 last_login_at", async () => {
    const accounts = new AccountRepository(store.db)
    expect(accounts.findByEmail("user@example.com")?.lastLoginAt).toBeNull()
    await auth.login({ email: "user@example.com", password: "password123" })
    expect(accounts.findByEmail("user@example.com")?.lastLoginAt).not.toBeNull()
  })
})

describe("登出", () => {
  it("清空会话", async () => {
    await auth.register({ email: "user@example.com", password: "password123" })
    expect(auth.currentSession()).not.toBeNull()
    expect(auth.logout()).toBe(true)
    expect(auth.currentSession()).toBeNull()
  })

  it("未登录时登出不报错", () => {
    expect(auth.logout()).toBe(true)
  })
})

describe("首启状态", () => {
  it("无账号时 hasAccount 为 false", () => {
    expect(auth.hasAccount()).toBe(false)
  })
})

describe("会话 token（记住登录）", () => {
  const credentials = { email: "user@example.com", password: "password123" }
  const SESSION_KEY = "auth.sessionToken"

  it("未勾选时不落盘，重启后需重新登录", async () => {
    await auth.register({ ...credentials, remember: false })
    expect(sessions.read()).toBeNull()

    const afterRestart = restartApp()
    expect(afterRestart.restoreSession()).toBeNull()
    expect(afterRestart.currentSession()).toBeNull()
    expect(afterRestart.hasAccount()).toBe(true)
  })

  it("未勾选时仍签发 token（登录态只有一种表示形式）", async () => {
    const session = await auth.register({ ...credentials, remember: false })
    expect(session.tokens?.expiresAt).toBeTruthy()
    // 12 小时的短有效期，不是 30 天
    const ttlHours =
      (Date.parse(session.tokens?.expiresAt ?? "") - currentTime.getTime()) / (60 * 60 * 1000)
    expect(ttlHours).toBe(12)
  })

  it("勾选后重启可自动恢复会话", async () => {
    await auth.register({ ...credentials, remember: true })
    const token = sessions.read()
    expect(token).toBeTruthy()

    const afterRestart = restartApp()
    const restored = afterRestart.restoreSession()
    expect(restored?.email).toBe("user@example.com")
    expect(restored?.restored).toBe(true)
    expect(afterRestart.currentSession()).not.toBeNull()
  })

  it("落盘的是签名 token，sub 为 accountId", async () => {
    const session = await auth.register({ ...credentials, remember: true })
    const token = sessions.read() ?? ""
    expect(token.split(".")).toHaveLength(3)
    expect(decodeJwtClaims(token)?.sub).toBe(session.accountId)
    expect(decodeJwtClaims(token)?.iss).toBe("mycontext/local-session")
  })

  it("登录时勾选同样生效", async () => {
    await auth.register(credentials)
    auth.logout()
    await auth.login({ ...credentials, remember: true })
    expect(sessions.read()).not.toBeNull()
    expect(restartApp().restoreSession()).not.toBeNull()
  })

  it("落盘内容不含口令、摘要或盐", async () => {
    await auth.register({ ...credentials, remember: true })
    const raw = new SettingsRepository(store.db).get(SESSION_KEY)
    expect(raw).not.toBeNull()
    expect(raw).not.toContain("password123")
    expect(raw).not.toContain("hashed:")
    expect(raw).not.toContain("salt")
    // JWT 的 payload 是编码不是加密，所以解开后也要确认干净。
    expect(JSON.stringify(decodeJwtClaims(raw ?? ""))).not.toContain("password")
  })

  it("显式登出会清掉 token（否则重启又自动进去）", async () => {
    await auth.register({ ...credentials, remember: true })
    expect(sessions.read()).not.toBeNull()
    auth.logout()
    expect(sessions.read()).toBeNull()
    expect(restartApp().restoreSession()).toBeNull()
  })

  it("上次记住、这次没勾，则旧 token 被清除", async () => {
    await auth.register({ ...credentials, remember: true })
    auth.logout()
    await auth.login({ ...credentials, remember: false })
    expect(sessions.read()).toBeNull()
  })

  it("超过有效期后不再恢复，并清掉过期 token", async () => {
    await auth.register({ ...credentials, remember: true })

    // 越过 30 天有效期
    const expired = new Date(currentTime.getTime() + 31 * 24 * 60 * 60 * 1000)
    const afterRestart = restartApp(() => expired)
    expect(afterRestart.restoreSession()).toBeNull()
    expect(sessions.read()).toBeNull()
  })

  it("有效期内（第 29 天）仍可恢复", async () => {
    await auth.register({ ...credentials, remember: true })
    const within = new Date(currentTime.getTime() + 29 * 24 * 60 * 60 * 1000)
    expect(restartApp(() => within).restoreSession()).not.toBeNull()
  })

  it("账号已被删除时不恢复，并清掉悬空 token", async () => {
    await auth.register({ ...credentials, remember: true })
    store.db.prepare("DELETE FROM accounts").run()

    const afterRestart = restartApp()
    expect(afterRestart.restoreSession()).toBeNull()
    expect(sessions.read()).toBeNull()
  })

  it("token 损坏时不抛错，按未登录处理并清理", async () => {
    await auth.register({ ...credentials, remember: true })
    new SettingsRepository(store.db).set(SESSION_KEY, "{ not valid json", currentTime.toISOString())

    const afterRestart = restartApp()
    expect(() => afterRestart.restoreSession()).not.toThrow()
    expect(afterRestart.currentSession()).toBeNull()
    expect(sessions.read()).toBeNull()
  })

  /**
   * 篡改 token 的 payload 想换个账号进去——签名对不上，直接判未登录。
   * 这是「以 JWT 为依据」相对于「存一条明文记录」的实际收益：
   * 手改存储改不出一个能用的登录态。
   */
  it("篡改 token 后无法恢复登录态", async () => {
    await auth.register({ ...credentials, remember: true })
    const [header, , signature] = (sessions.read() ?? "").split(".")
    const forged = Buffer.from(
      JSON.stringify({
        sub: "someone-else",
        iss: "mycontext/local-session",
        iat: 1,
        exp: 9_999_999_999,
      }),
    ).toString("base64url")

    new SettingsRepository(store.db).set(
      SESSION_KEY,
      `${header}.${forged}.${signature}`,
      currentTime.toISOString(),
    )

    const afterRestart = restartApp()
    expect(afterRestart.restoreSession()).toBeNull()
    expect(sessions.read()).toBeNull()
  })

  /**
   * 换一台机器 / 钥匙串里的密钥没了 → 密钥变了 → 旧 token 全部失效。
   * 这正是我们想要的：拷走 mycontext.db 不等于拷走登录态。
   */
  it("签名密钥变化后旧 token 失效", async () => {
    await auth.register({ ...credentials, remember: true })

    const rotated = { get: () => Buffer.alloc(32, 9) }
    const afterRestart = restartApp(() => currentTime, rotated)
    expect(afterRestart.restoreSession()).toBeNull()
    expect(sessions.read()).toBeNull()
  })

  it("恢复的会话与口令登录的会话对上层是同一形态", async () => {
    await auth.register({ ...credentials, remember: true })
    const direct = auth.currentSession()

    const restored = restartApp().restoreSession()
    expect(restored?.accountId).toBe(direct?.accountId)
    expect(restored?.email).toBe(direct?.email)
    expect(restored?.tokens?.expiresAt).toBe(direct?.tokens?.expiresAt)
  })
})
