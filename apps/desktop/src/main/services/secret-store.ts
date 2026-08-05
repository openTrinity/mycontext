/**
 * 通用的本机密文存储。
 *
 * 与 `SigningKeyStore` 同一套机制（`safeStorage` + `app_settings`），
 * 但面向**任意键值**：高级 AI 配置里的 apiKey 就走这里。
 *
 * 为什么不复用 SigningKeyStore：那个类的语义是「一个会自动轮换的签名密钥」
 * （读不出来就重新生成）。而 apiKey 读不出来时**不能**重新生成 ——
 * 只能报"需要重新填"。两种失败处置相反的东西不该共用一个类。
 *
 * `safeStorage` 不可用时降级为明文落库并**记一条警告**：
 * 明文比"完全不能用"好，但用户有权知道。
 */
import { safeStorage } from "electron"
import type { Logger } from "@mycontext/kernel"
import type { SettingsRepository } from "@mycontext/store"

interface StoredSecret {
  encrypted: boolean
  data: string
}

export interface SecretStoreOptions {
  settings: SettingsRepository
  logger: Logger
  now?: () => Date
  /** 便于测试：注入一个假的 safeStorage */
  storage?: Pick<
    typeof safeStorage,
    "isEncryptionAvailable" | "encryptString" | "decryptString"
  > | null
}

export class SecretStore {
  private readonly now: () => Date

  constructor(private readonly options: SecretStoreOptions) {
    this.now = options.now ?? (() => new Date())
  }

  read(key: string): string | null {
    const raw = this.options.settings.get(this.settingKey(key))
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSecret>
      if (typeof parsed.data !== "string" || parsed.data === "") return null
      if (parsed.encrypted !== true) return Buffer.from(parsed.data, "base64").toString("utf8")

      const storage = this.storage
      if (storage === null || storage === undefined || !this.available()) {
        // 换了机器 / 钥匙串重置：读不出来就是读不出来，**不能猜也不能生成**。
        this.options.logger.warn("secret unreadable (no secure storage), needs re-entry", { key })
        return null
      }
      return storage.decryptString(Buffer.from(parsed.data, "base64"))
    } catch (error) {
      this.options.logger.warn("secret unreadable, needs re-entry", {
        key,
        reason: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  write(key: string, value: string): void {
    const storage = this.storage
    const secure = this.available()
    const stored: StoredSecret =
      secure && storage !== null && storage !== undefined
        ? { encrypted: true, data: storage.encryptString(value).toString("base64") }
        : { encrypted: false, data: Buffer.from(value, "utf8").toString("base64") }

    if (!secure) {
      // 明文比"完全不能用"好，但用户有权知道 —— 所以这是 warn 而不是 debug。
      this.options.logger.warn("secure storage unavailable, secret stored in plaintext", { key })
    }
    this.options.settings.set(
      this.settingKey(key),
      JSON.stringify(stored),
      this.now().toISOString(),
    )
  }

  private settingKey(key: string): string {
    return `secret.${key}`
  }

  private get storage(): SecretStoreOptions["storage"] {
    return this.options.storage === undefined ? safeStorage : this.options.storage
  }

  private available(): boolean {
    const storage = this.storage
    if (storage === null || storage === undefined) return false
    try {
      return storage.isEncryptionAvailable()
    } catch {
      return false
    }
  }
}
