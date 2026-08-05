/**
 * 本地账号认证。
 *
 * 本阶段是纯本地账号（无服务端），但**登录态的唯一依据是一个签名会话
 * token（HS256 JWT）**：登录时签发，启动时校验，验得过才算登录。
 * 这么做而不是存一条「登录了、什么时候过期」的记录，是因为后者需要两处
 * 状态保持一致（记录与真实有效性），而这种不一致是最难查的一类问题。
 * token 自带过期时间，改一个字节就验不过，判定只有一条路径。
 *
 * 会话有两种存在形式：
 *   - 内存态：当前进程的登录状态，退出即失效
 *   - 持久态（「记住登录」）：token 写入 app_settings，启动时校验后恢复
 *
 * 两种形式签发的 token 完全一样，区别只在于要不要落盘。
 *
 * ⚠️ 边界：签名密钥在本机（见 SigningKeyStore），所以这不是「防本机用户」
 * 的机制——能读到密钥的人就能签任意 token。它保证的是凭据不可被手改、
 * 过期由凭据自身携带，以及与未来远端 JWT 共用同一条校验路径。
 * 接远端统一登录时，只需把签发换成远端、密钥换成公钥，消费方代码不用动。
 */
import { randomUUID } from "node:crypto"
import { AppError, signJwt, verifyJwt, type Logger } from "@mycontext/kernel"
import {
  PASSWORD_MIN_LENGTH,
  REMEMBER_SESSION_DAYS,
  SESSION_TTL_HOURS,
  type AuthSession,
  type UpdateProfileInput,
  type Credentials,
} from "@mycontext/ipc-contract"
import type { AccountRecord, AccountRepository, SessionStore } from "@mycontext/store"
import type { PasswordHasher } from "./password-hasher.js"

/**
 * 从账号行取出身份三件套。
 *
 * 抽成函数而不是在两处（登录 / 恢复会话）各写一遍：
 * 漏掉一处的表现是"重启后头像没了"—— 而那看起来像头像存储坏了。
 */
function profileOf(account: AccountRecord): {
  displayName: string | null
  avatarUrl: string | null
  avatarSource: "manual" | "channel" | null
} {
  return {
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    avatarSource: account.avatarSource,
  }
}
import type { SigningKeyProvider } from "./signing-key.service.js"

/**
 * 邮箱格式校验。
 * 刻意保持宽松（只要求 local@domain.tld 形状）：过严的正则会拒掉合法地址，
 * 而本地账号的邮箱只是登录标识，不需要可达性保证。
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * JWT 的 iss。带用途后缀：将来若有别的本地 token（比如导出链接签名），
 * 同一把密钥签出来的东西不会被误当成会话。
 */
export const SESSION_ISSUER = "mycontext/local-session"

const HOUR_IN_SECONDS = 60 * 60

/** 归一化：去空格 + 转小写，避免 "A@x.com" 与 "a@x.com" 注册出两个账号。 */
export function canonicalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export interface AuthServiceOptions {
  accounts: AccountRepository
  sessions: SessionStore
  signingKey: SigningKeyProvider
  hasher: PasswordHasher
  logger: Logger
  now?: () => Date
  /**
   * 登录态变化回调：装配层据此打开/关闭该账号的 vault。
   *
   * 由 AuthService 通知而不是让装配层自己轮询，是因为「什么时候算登录成功」
   * 只有这里知道（注册、口令登录、会话恢复三条路径），
   * 而 vault 必须在任何账号级数据被读取之前就绑定好。
   */
  onSessionChange?: (session: { accountId: string; vaultId: string } | null) => void
}

export class AuthService {
  private session: AuthSession | null = null
  /** 当前会话对应的 vaultId。不放进 AuthSession——渲染层不需要知道存储布局。 */
  private vaultId: string | null = null
  private readonly now: () => Date

  constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date())
  }

  currentSession(): AuthSession | null {
    return this.session
  }

  /** 当前登录账号的 vaultId；未登录为 null。 */
  currentVaultId(): string | null {
    return this.vaultId
  }

  hasAccount(): boolean {
    return this.options.accounts.count() > 0
  }

  /**
   * 启动时校验持久化的会话 token 并恢复登录态。
   *
   * 以下情况都清掉记录并返回 null（即「未登录」）：
   * 没有 token、签名不对、已过期、签发方不对、或账号已不存在。
   * 任何一种都只是要求重新登录，不该让应用打不开。
   */
  restoreSession(): AuthSession | null {
    const token = this.options.sessions.read()
    if (token === null) return null

    const verified = verifyJwt({
      token,
      issuer: SESSION_ISSUER,
      secret: this.options.signingKey.get(),
      nowMs: this.now().getTime(),
    })

    if (!verified.valid) {
      // 过期是正常生命周期，其余原因意味着 token 被改过或密钥换了，值得留痕。
      if (verified.reason === "expired") {
        this.options.logger.info("session token expired")
      } else {
        this.options.logger.warn("session token rejected", { reason: verified.reason })
      }
      this.options.sessions.clear()
      return null
    }

    const account = this.options.accounts.findById(verified.claims.sub)
    if (account === null) {
      this.options.logger.warn("session token points to a missing account")
      this.options.sessions.clear()
      return null
    }

    this.session = {
      accountId: account.id,
      email: account.emailDisplay,
      signedInAt: new Date(verified.claims.iat * 1000).toISOString(),
      restored: true,
      tokens: { expiresAt: new Date(verified.claims.exp * 1000).toISOString() },
      ...profileOf(account),
    }
    this.vaultId = account.vaultId
    this.options.onSessionChange?.({ accountId: account.id, vaultId: account.vaultId })
    this.options.logger.info("session restored", { accountId: account.id })
    return this.session
  }

  async register(input: Credentials): Promise<AuthSession> {
    const email = canonicalizeEmail(input.email)
    if (!EMAIL_PATTERN.test(email)) {
      throw new AppError("AUTH_INVALID_EMAIL", "邮箱格式不正确", {
        messageKey: "errors:auth.invalidEmail",
      })
    }
    if (input.password.length < PASSWORD_MIN_LENGTH) {
      throw new AppError("AUTH_WEAK_PASSWORD", `口令至少需要 ${PASSWORD_MIN_LENGTH} 位`, {
        messageKey: "errors:auth.weakPassword",
        messageParams: { min: PASSWORD_MIN_LENGTH },
      })
    }
    if (this.options.accounts.findByEmail(email) !== null) {
      throw new AppError("AUTH_EMAIL_TAKEN", "该邮箱已注册", {
        messageKey: "errors:auth.emailTaken",
      })
    }

    const credential = await this.options.hasher.hash(input.password)
    const timestamp = this.now().toISOString()
    const account = this.options.accounts.create({
      id: randomUUID(),
      // vaultId 独立生成而不复用 accountId：将来「删账号但保留数据取证」
      // 或「一个账号多 vault」都不需要动这条一对一映射的存储格式。
      vaultId: randomUUID(),
      emailCanonical: email,
      emailDisplay: input.email.trim(),
      passwordHash: credential.hash,
      salt: credential.salt,
      hashParams: credential.params,
      createdAt: timestamp,
    })

    this.options.logger.info("account registered", { accountId: account.id })
    return this.startSession(account, input.remember === true)
  }

  async login(input: Credentials): Promise<AuthSession> {
    const email = canonicalizeEmail(input.email)
    const account = this.options.accounts.findByEmail(email)

    // 账号不存在与口令错误返回同一个错误：避免暴露「哪些邮箱已注册」。
    if (account === null) {
      throw new AppError("AUTH_INVALID_CREDENTIALS", "邮箱或口令不正确", {
        messageKey: "errors:auth.invalidCredentials",
      })
    }

    const valid = await this.options.hasher.verify({
      password: input.password,
      hash: account.passwordHash,
      salt: account.salt,
      params: account.hashParams,
    })
    if (!valid) {
      this.options.logger.warn("login rejected", { accountId: account.id })
      throw new AppError("AUTH_INVALID_CREDENTIALS", "邮箱或口令不正确", {
        messageKey: "errors:auth.invalidCredentials",
      })
    }

    const timestamp = this.now().toISOString()
    this.options.accounts.markLogin(account.id, timestamp)
    this.options.logger.info("login succeeded", { accountId: account.id })
    return this.startSession(account, input.remember === true)
  }

  logout(): true {
    if (this.session !== null) {
      this.options.logger.info("logout", { accountId: this.session.accountId })
    }
    this.session = null
    this.vaultId = null
    // 显式登出一定要清掉持久 token：否则重启又自动进去，与用户意图相反。
    this.options.sessions.clear()
    // 通知装配层关闭 vault：账号级数据不该在登出后仍可读。
    this.options.onSessionChange?.(null)
    return true
  }

  /**
   * 签发会话 token 并建立登录态。
   *
   * 两种情况签的是同一种 token，只是有效期不同：
   * 勾了「记住登录」给 30 天并落盘，没勾则只给几小时且不落盘
   * （进程内有效，退出即失效）。
   *
   * 没勾也签 token 而不是只放一个内存对象，是为了让「当前登录态」
   * 只有一种表示形式——否则 currentSession 会有两种来源，
   * 后续接远端登录时又要各写一遍。
   */
  private startSession(account: AccountRecord, remember: boolean): AuthSession {
    const issuedAtMs = this.now().getTime()
    const ttlSeconds = remember
      ? REMEMBER_SESSION_DAYS * 24 * HOUR_IN_SECONDS
      : SESSION_TTL_HOURS * HOUR_IN_SECONDS

    const token = signJwt({
      subject: account.id,
      issuer: SESSION_ISSUER,
      ttlSeconds,
      secret: this.options.signingKey.get(),
      nowMs: issuedAtMs,
    })

    const expiresAt = new Date(issuedAtMs + ttlSeconds * 1000).toISOString()
    this.session = {
      accountId: account.id,
      email: account.emailDisplay,
      signedInAt: new Date(issuedAtMs).toISOString(),
      tokens: { expiresAt },
      ...profileOf(account),
    }
    this.vaultId = account.vaultId

    if (remember) {
      this.options.sessions.write(token, this.session.signedInAt)
      this.options.logger.info("session remembered", { accountId: account.id, expiresAt })
    } else {
      // 未勾选时清掉可能存在的旧 token，避免「上次记住了、这次没勾」仍被自动登录。
      this.options.sessions.clear()
    }

    // vault 必须在任何账号级数据被读取之前就绑定好，因此放在返回之前。
    this.options.onSessionChange?.({ accountId: account.id, vaultId: account.vaultId })
    return this.session
  }

  /**
   * 改显示名 / 头像。
   *
   * 返回**更新后的会话**而不是 void：UI 拿着它直接替换本地状态，
   * 省掉一次"改完再查一次"的往返（那期间界面会显示旧值，看起来像没生效）。
   *
   * 改头像会把来源标成 manual —— 之后渠道授权不再覆盖（见 accounts.ts）。
   */
  /**
   * 用渠道取到的显示名/头像回填账号。
   *
   * ## ★ 与 `updateProfile` 的区别只有一条：**用户设过的永不被覆盖**
   *
   * `updateProfile` 是用户自己在设置里改，所以它把 `avatar_source`
   * 标成 `manual`。这个方法是渠道回填，要尊重那个标记 ——
   * 用户显式上传过一张图（或显式清空过），渠道不该悄悄改回去。
   * 显示名同理：用户设过就不动（判据在 store 那侧）。
   *
   * 规则本身在 `AccountRepository.applyChannelProfile` 里（那是唯一真源），
   * 这里只负责刷新内存里的 session 并返回"哪些字段真写了"。
   *
   * ## ★ 为什么不再是 `applyChannelAvatar(url)`
   *
   * 原来只收头像一个参数，而 store 那侧的 `applyChannelProfile` **一直**
   * 支持 `displayName` —— 于是账号显示名永远不会从渠道回填（没有调用方
   * 传它）。能力齐备而入口缺失，这类缺口不报错，只让字段一直是 NULL。
   *
   * 两个字段合成一次调用而不是给显示名再开一个方法：覆盖规则是**逐字段
   * 独立**判的（头像 manual、名字用户设过），分成两次调用会让上层出现
   * "头像取不到 → 顺带跳过显示名"这种耦合。
   *
   * 两个字段都可省：只传一个时另一个不动（store 那侧按 `undefined` 跳过）。
   *
   * @returns 各字段是否真写了（false = 用户设过，跳过）
   */
  applyChannelProfile(incoming: {
    displayName?: string | undefined
    avatarUrl?: string | undefined
  }): { displayNameWritten: boolean; avatarWritten: boolean } {
    const current = this.session
    if (current === null) return { displayNameWritten: false, avatarWritten: false }
    const applied = this.options.accounts.applyChannelProfile(current.accountId, incoming)
    // 一个字段都没写 → 不必重读账号刷 session（那是一次多余的查询）
    if (!applied.displayNameWritten && !applied.avatarWritten) return applied

    const account = this.options.accounts.findById(current.accountId)
    if (account !== null) this.session = { ...current, ...profileOf(account) }
    return applied
  }

  updateProfile(patch: UpdateProfileInput): AuthSession {
    const current = this.session
    if (current === null) throw new AppError("AUTH_NOT_SIGNED_IN", "尚未登录")

    this.options.accounts.updateProfile(current.accountId, patch)
    const account = this.options.accounts.findById(current.accountId)
    if (account === null) throw new AppError("AUTH_NOT_SIGNED_IN", "账号已不存在")

    this.session = { ...current, ...profileOf(account) }
    return this.session
  }
}
