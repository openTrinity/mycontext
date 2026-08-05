/**
 * 会话签名密钥。
 *
 * 密钥用 Electron `safeStorage` 加密后落 `app_settings`：加解密由系统钥匙串
 * 托管（macOS 上即 Keychain），因此把 `mycontext.db` 单独拷到另一台机器
 * 也解不出来，里面的会话 token 自然作废。
 *
 * **诚实的边界**：这不是「防本机用户」的机制。同一台机器同一个系统用户
 * 本来就能让 safeStorage 解密，也就能签出任意 token。本地优先的应用在
 * 没有用户口令派生密钥的前提下做不到更强的保证。它真正提供的是：
 *   - 会话凭据不可被手改（改一个字节签名就失效）
 *   - 过期时间由凭据自身携带，不依赖另一处记录
 *   - 与未来远端 JWT 共用同一条校验路径
 *
 * safeStorage 不可用时（部分 Linux 桌面没有可用钥匙串）降级为明文存储并
 * 记 warn：此时防篡改仍然成立（改 token 就失效），只是「拷走库文件」不再
 * 被拦住。宁可退化一层也不要直接让登录功能不可用。
 */
import { randomBytes } from "node:crypto"
import { safeStorage } from "electron"
import type { Logger } from "@mycontext/kernel"
import type { SettingsRepository } from "@mycontext/store"

/** app_settings 里的键名。 */
export const SIGNING_KEY_SETTING = "auth.sessionSigningKey"

/** HMAC-SHA256 的密钥长度：与摘要等长，超过没有意义。 */
const KEY_BYTES = 32

interface StoredKey {
  /** 是否经过 safeStorage 加密。决定了怎么解回来。 */
  encrypted: boolean
  data: string
}

export interface SigningKeyProvider {
  /** 取当前签名密钥；不存在则生成并持久化。 */
  get(): Buffer
}

export interface SigningKeyStoreOptions {
  settings: SettingsRepository
  logger: Logger
  now?: () => Date
  /** 便于测试：注入一个假的 safeStorage */
  storage?: Pick<
    typeof safeStorage,
    "isEncryptionAvailable" | "encryptString" | "decryptString"
  > | null
}

export class SigningKeyStore implements SigningKeyProvider {
  /** 进程内缓存：每次签发都读一次库 + 走一次钥匙串解密没有必要。 */
  private cached: Buffer | null = null
  private readonly now: () => Date

  constructor(private readonly options: SigningKeyStoreOptions) {
    this.now = options.now ?? (() => new Date())
  }

  get(): Buffer {
    if (this.cached !== null) return this.cached
    const existing = this.read()
    this.cached = existing ?? this.generate()
    return this.cached
  }

  private get storage(): SigningKeyStoreOptions["storage"] {
    // 显式传 null 表示「就是没有」，undefined 表示「用 Electron 的」。
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

  /**
   * 读回密钥。任何异常都当作「没有密钥」并重新生成——
   * 密钥换了只意味着已有会话失效（要求重新登录），
   * 而抛错会让应用打不开，代价大得多。
   */
  private read(): Buffer | null {
    const raw = this.options.settings.get(SIGNING_KEY_SETTING)
    if (raw === null) return null

    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object")
      const { encrypted, data } = parsed as Partial<StoredKey>
      if (typeof data !== "string" || data === "") throw new Error("missing data")

      if (encrypted === true) {
        const storage = this.storage
        if (storage === null || storage === undefined || !this.available()) {
          throw new Error("encrypted key but no secure storage")
        }
        const decrypted = storage.decryptString(Buffer.from(data, "base64"))
        return Buffer.from(decrypted, "base64")
      }
      return Buffer.from(data, "base64")
    } catch (error) {
      this.options.logger.warn("session signing key unreadable, rotating", {
        reason: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  private generate(): Buffer {
    const key = randomBytes(KEY_BYTES)
    const encoded = key.toString("base64")
    const secure = this.available()
    const storage = this.storage

    let stored: StoredKey
    if (secure && storage !== null && storage !== undefined) {
      stored = { encrypted: true, data: storage.encryptString(encoded).toString("base64") }
    } else {
      this.options.logger.warn("secure storage unavailable, session key stored unencrypted")
      stored = { encrypted: false, data: encoded }
    }

    this.options.settings.set(SIGNING_KEY_SETTING, JSON.stringify(stored), this.now().toISOString())
    this.options.logger.info("session signing key created", { encrypted: stored.encrypted })
    return key
  }
}
