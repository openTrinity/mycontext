/**
 * 本机 cursor-agent CLI 登录 → Agent API Key 解析链。
 *
 * 优先级：显式 key > 环境变量 > SDK auth 存储 > CLI 登录铸造。
 * 不读真钥匙串、不打真网 —— 全部注入。
 */
import { describe, expect, it, vi } from "vitest"
import {
  parseCursorAgentStatusJson,
  ensureCursorApiKey,
} from "@mycontext/agent-runtime"

describe("parseCursorAgentStatusJson", () => {
  it("authenticated + 有 token 标记 → authenticated true", () => {
    expect(
      parseCursorAgentStatusJson({
        status: "authenticated",
        isAuthenticated: true,
        hasAccessToken: true,
        hasRefreshToken: true,
      }),
    ).toEqual({
      authenticated: true,
      hasAccessToken: true,
      hasRefreshToken: true,
    })
  })

  it("unauthenticated → authenticated false", () => {
    expect(
      parseCursorAgentStatusJson({
        status: "unauthenticated",
        isAuthenticated: false,
        hasAccessToken: false,
        hasRefreshToken: false,
      }),
    ).toEqual({
      authenticated: false,
      hasAccessToken: false,
      hasRefreshToken: false,
    })
  })

  it("坏形状 → authenticated false（不抛）", () => {
    expect(parseCursorAgentStatusJson(null).authenticated).toBe(false)
    expect(parseCursorAgentStatusJson("x").authenticated).toBe(false)
  })
})

describe("ensureCursorApiKey", () => {
  it("显式 key 优先，不碰 CLI / store", async () => {
    const mint = vi.fn()
    const loadSdkStore = vi.fn()
    const result = await ensureCursorApiKey({
      explicitKey: " sk-explicit ",
      loadSdkStore,
      mintFromAccessToken: mint,
      readCliAccessToken: () => "access-should-not-run",
    })
    expect(result).toEqual({ apiKey: "sk-explicit", source: "explicit" })
    expect(mint).not.toHaveBeenCalled()
    expect(loadSdkStore).not.toHaveBeenCalled()
  })

  it("无显式 → 读环境变量 CURSOR_API_KEY", async () => {
    const result = await ensureCursorApiKey({
      explicitKey: "",
      env: { CURSOR_API_KEY: "sk-from-env" },
      loadSdkStore: async () => undefined,
      readCliAccessToken: () => null,
      mintFromAccessToken: async () => {
        throw new Error("should not mint")
      },
    })
    expect(result).toEqual({ apiKey: "sk-from-env", source: "env" })
  })

  it("无显式无 env → SDK store", async () => {
    const result = await ensureCursorApiKey({
      explicitKey: "",
      env: {},
      loadSdkStore: async () => ({ apiKey: "sk-from-sdk-store" }),
      readCliAccessToken: () => null,
      mintFromAccessToken: async () => {
        throw new Error("should not mint")
      },
    })
    expect(result).toEqual({ apiKey: "sk-from-sdk-store", source: "sdk-store" })
  })

  it("前面都空 + CLI 有 access token → mint 并写入 store", async () => {
    const saveSdkStore = vi.fn(async () => undefined)
    const mintFromAccessToken = vi.fn(async () => ({ apiKey: "sk-minted" }))
    const result = await ensureCursorApiKey({
      explicitKey: "",
      env: {},
      loadSdkStore: async () => undefined,
      saveSdkStore,
      readCliAccessToken: () => "cli-access-token",
      mintFromAccessToken,
      nowMs: () => 1_700_000_000_000,
    })
    expect(result).toEqual({ apiKey: "sk-minted", source: "cli-login" })
    expect(mintFromAccessToken).toHaveBeenCalledWith("cli-access-token")
    expect(saveSdkStore).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-minted",
        version: 1,
      }),
    )
  })

  it("CLI 无 token → missing", async () => {
    const result = await ensureCursorApiKey({
      explicitKey: "",
      env: {},
      loadSdkStore: async () => undefined,
      readCliAccessToken: () => null,
      mintFromAccessToken: async () => ({ apiKey: "nope" }),
    })
    expect(result).toEqual({ apiKey: "", source: "missing" })
  })
})

describe("tryReadSdkAuthApiKeySync", () => {
  it("读临时 auth.json 拿到未过期 key", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const { tryReadSdkAuthApiKeySync } = await import("@mycontext/agent-runtime")
    // 通过改 HOME 指向临时目录，让 getDefaultSdkAuthPath 落到我们写的文件
    const home = mkdtempSync(join(tmpdir(), "mycontext-sdk-auth-"))
    const prev = process.env.HOME
    process.env.HOME = home
    try {
      const dir = join(home, ".cursor", "sdk")
      const { mkdirSync } = await import("node:fs")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({
          version: 1,
          backendUrl: "https://api2.cursor.sh",
          apiKey: "sk-cached",
          apiKeyExpiresAtMs: Date.now() + 60_000,
          createdAtMs: Date.now(),
        }),
        "utf8",
      )
      expect(tryReadSdkAuthApiKeySync()).toBe("sk-cached")
    } finally {
      if (prev === undefined) delete process.env.HOME
      else process.env.HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})
