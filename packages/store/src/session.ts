/**
 * 会话持久化。
 *
 * 存的是一个签名后的会话 token（JWT）字符串，不是解析后的字段。
 * 这样「是否已登录」只有一个判定依据——token 验得过就是登录态——
 * 不会出现「记录里写着还没过期、token 却已失效」这种两份状态打架的情况。
 *
 * 用 app_settings 的单条记录而不建新表：会话是「最多一条」的单例状态，
 * 建表会让 schema 里多一张永远只有 0/1 行的表。
 *
 * token 的 payload 只含 accountId 与时间（sub/iat/exp/iss），
 * **不含口令、摘要或盐**——JWT 的 payload 是编码而非加密，
 * 拿到它不能反推口令；签名密钥不在这张表里（见 SigningKeyStore），
 * 所以单独拷走这条记录也无法在别的机器上通过校验。
 *
 * 真伪与过期的判定由 AuthService 做（签名校验 + 账号是否仍存在），
 * 本模块只管读写。
 */
import type { SettingsRepository } from "./accounts.js"

/** app_settings 里的键名。加前缀避免与后续模块的配置键撞车。 */
export const SESSION_SETTING_KEY = "auth.sessionToken"

export class SessionStore {
  constructor(private readonly settings: SettingsRepository) {}

  /**
   * 读取会话 token。
   *
   * 只判断「有没有」，不做任何形态检查：一个格式不对的字符串
   * 与一个签名错误的字符串，结论都是「验不过 → 未登录」，
   * 在这里提前分流只会多出一条与签名校验重复的判定路径。
   */
  read(): string | null {
    const raw = this.settings.get(SESSION_SETTING_KEY)
    if (raw === null || raw.trim() === "") return null
    return raw
  }

  write(token: string, updatedAt: string): void {
    this.settings.set(SESSION_SETTING_KEY, token, updatedAt)
  }

  clear(): void {
    this.settings.delete(SESSION_SETTING_KEY)
  }
}
