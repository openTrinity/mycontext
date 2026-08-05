/**
 * 会话签名密钥存储测试。
 *
 * 关注点是**降级与自愈**：钥匙串不可用、记录损坏、解密失败——
 * 这些都不该让应用打不开，代价最多是「要求重新登录」。
 *
 * electron 需要 mock：在 Node 里 require("electron") 拿到的是二进制路径，
 * 不是模块，直接 import 会在加载期就失败。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  },
}))

import { createLogger } from "@mycontext/kernel"
import { openStore, SettingsRepository, type StoreHandle } from "@mycontext/store"
import { SigningKeyStore, SIGNING_KEY_SETTING } from "@main/services/signing-key.service"

const silentLogger = createLogger("Test", { level: "error" })
const NOW = new Date("2026-07-28T00:00:00.000Z")

/** 假钥匙串：加密就是加个前缀，足以验证「存的不是明文、读回来一致」。 */
function fakeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
  }
}

let store: StoreHandle
let settings: SettingsRepository

beforeEach(() => {
  store = openStore({ path: ":memory:" })
  settings = new SettingsRepository(store.db)
})

const create = (storage: ReturnType<typeof fakeStorage> | null) =>
  new SigningKeyStore({ settings, logger: silentLogger, now: () => NOW, storage })

describe("密钥生成与复用", () => {
  it("首次调用生成 32 字节密钥并持久化", () => {
    const key = create(fakeStorage()).get()
    expect(key).toHaveLength(32)
    expect(settings.get(SIGNING_KEY_SETTING)).not.toBeNull()
  })

  it("同一实例内复用（不每次都解一遍钥匙串）", () => {
    const storage = fakeStorage()
    const spy = vi.spyOn(storage, "decryptString")
    const keyStore = create(storage)
    expect(keyStore.get().equals(keyStore.get())).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it("重启后读回同一把密钥（否则每次启动都要重新登录）", () => {
    const first = create(fakeStorage()).get()
    const second = create(fakeStorage()).get()
    expect(second.equals(first)).toBe(true)
  })

  it("可用钥匙串时落盘内容是加密的，不含密钥明文", () => {
    const key = create(fakeStorage()).get()
    const stored = JSON.parse(settings.get(SIGNING_KEY_SETTING) ?? "{}")
    expect(stored.encrypted).toBe(true)
    // 密文再经 base64 落盘，所以要解一层才能看到假加密的前缀。
    expect(Buffer.from(stored.data, "base64").toString()).toContain("enc:")
    expect(settings.get(SIGNING_KEY_SETTING)).not.toContain(key.toString("base64"))
  })
})

describe("降级与自愈", () => {
  it("钥匙串不可用时降级为明文存储，但功能仍可用", () => {
    const keyStore = create(fakeStorage(false))
    expect(keyStore.get()).toHaveLength(32)
    expect(JSON.parse(settings.get(SIGNING_KEY_SETTING) ?? "{}").encrypted).toBe(false)
  })

  it("明文存储的密钥重启后仍能读回", () => {
    const first = create(fakeStorage(false)).get()
    expect(create(fakeStorage(false)).get().equals(first)).toBe(true)
  })

  it("记录损坏时换一把新密钥而不抛错（代价是重新登录，不是打不开）", () => {
    create(fakeStorage()).get()
    settings.set(SIGNING_KEY_SETTING, "{ not json", NOW.toISOString())

    const keyStore = create(fakeStorage())
    expect(() => keyStore.get()).not.toThrow()
    expect(keyStore.get()).toHaveLength(32)
  })

  it("解密失败时同样换新密钥", () => {
    create(fakeStorage()).get()
    const broken = {
      ...fakeStorage(),
      decryptString: () => {
        throw new Error("keychain denied")
      },
    }
    expect(() => create(broken).get()).not.toThrow()
  })

  /**
   * 加密过的密钥遇到「钥匙串没了」的机器：不能把 base64 密文当明文密钥用，
   * 那样会得到一把错的密钥并让签名校验以令人困惑的方式失败。
   * 正确做法是判定为不可读、重新生成。
   */
  it("加密记录 + 无钥匙串时判定为不可读并重新生成", () => {
    const original = create(fakeStorage()).get()
    const fallback = create(fakeStorage(false)).get()
    expect(fallback.equals(original)).toBe(false)
  })

  it("完全没有安全存储实现时也能工作", () => {
    expect(create(null).get()).toHaveLength(32)
  })
})
