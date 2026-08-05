/**
 * 账号仓储。
 *
 * 只负责持久化，不做口令哈希（那是 AuthService 的职责）：
 * 仓储不认识明文口令，避免把 crypto 逻辑散落到数据层。
 */
import type { SqliteDatabase } from "./database.js"

export interface AccountRecord {
  id: string
  /** 该账号的数据库所在 vault（一对一，注册时生成） */
  vaultId: string
  emailCanonical: string
  emailDisplay: string
  passwordHash: string
  salt: string
  hashParams: string
  createdAt: string
  lastLoginAt: string | null
  /** 用户自己设的显示名。未设时为 null（由 resolveDisplayName 兜底） */
  displayName: string | null
  avatarUrl: string | null
  /** 头像来源。决定渠道授权时能不能覆盖 —— 见 avatar_source 的迁移注释 */
  avatarSource: AvatarSource | null
}

/**
 * 头像来源。
 *
 * · `manual`  —— 用户手动设的，**渠道回填永不覆盖**
 * · `channel` —— 从渠道授权拿到的，同来源的新值可以更新
 */
export type AvatarSource = "manual" | "channel"

export interface CreateAccountInput {
  id: string
  vaultId: string
  emailCanonical: string
  emailDisplay: string
  passwordHash: string
  salt: string
  hashParams: string
  createdAt: string
}

interface AccountRow {
  id: string
  vault_id: string
  email_canonical: string
  email_display: string
  password_hash: string
  salt: string
  hash_params: string
  created_at: string
  last_login_at: string | null
  display_name: string | null
  avatar_url: string | null
  avatar_source: string | null
}

function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    vaultId: row.vault_id,
    emailCanonical: row.email_canonical,
    emailDisplay: row.email_display,
    passwordHash: row.password_hash,
    salt: row.salt,
    hashParams: row.hash_params,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    // 只认两个已知值：库里出现别的字符串（手改/降级回滚）时按"未设"处理，
    // 而不是把它当成一个未知来源传下去。
    avatarSource:
      row.avatar_source === "manual" || row.avatar_source === "channel" ? row.avatar_source : null,
  }
}

export class AccountRepository {
  constructor(private readonly db: SqliteDatabase) {}

  count(): number {
    const row = this.db
      .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM accounts")
      .get()
    return row?.total ?? 0
  }

  findByEmail(emailCanonical: string): AccountRecord | null {
    const row = this.db
      .prepare<[string], AccountRow>("SELECT * FROM accounts WHERE email_canonical = ?")
      .get(emailCanonical)
    return row === undefined ? null : toRecord(row)
  }

  /** 按 id 查：恢复持久化会话时用来确认账号仍然存在。 */
  findById(id: string): AccountRecord | null {
    const row = this.db.prepare<[string], AccountRow>("SELECT * FROM accounts WHERE id = ?").get(id)
    return row === undefined ? null : toRecord(row)
  }

  create(input: CreateAccountInput): AccountRecord {
    this.db
      .prepare(
        `INSERT INTO accounts
           (id, vault_id, email_canonical, email_display, password_hash, salt, hash_params, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.vaultId,
        input.emailCanonical,
        input.emailDisplay,
        input.passwordHash,
        input.salt,
        input.hashParams,
        input.createdAt,
      )
    return {
      ...input,
      lastLoginAt: null,
      displayName: null,
      avatarUrl: null,
      avatarSource: null,
    }
  }

  markLogin(id: string, at: string): void {
    this.db.prepare("UPDATE accounts SET last_login_at = ? WHERE id = ?").run(at, id)
  }

  /**
   * 用户手动改资料。
   *
   * 传了 `avatarUrl`（含显式传 null = 清空）就把 source 标成 `manual` ——
   * 这是"用户做过选择"的唯一记录点，渠道回填据此不再覆盖。
   *
   * ★ 清空也标 manual：那同样是一个选择（"我就要首字母"）。
   * 若清空后把 source 置回 null，下一次授权会把头像填回来 —— 静默地违背用户意图。
   */
  updateProfile(
    id: string,
    patch: { displayName?: string | null | undefined; avatarUrl?: string | null | undefined },
  ): void {
    if (patch.displayName !== undefined) {
      this.db
        .prepare("UPDATE accounts SET display_name = ? WHERE id = ?")
        .run(patch.displayName === "" ? null : patch.displayName, id)
    }
    if (patch.avatarUrl !== undefined) {
      this.db
        .prepare("UPDATE accounts SET avatar_url = ?, avatar_source = 'manual' WHERE id = ?")
        .run(patch.avatarUrl === "" ? null : patch.avatarUrl, id)
    }
  }

  /**
   * 渠道授权后回填头像/显示名。
   *
   * ## ★ 规则：manual **且有图** 才不被覆盖
   *
   * ```
   * source='manual' 且 avatar_url 非空 → 跳过（用户设过一张图）
   * source='manual' 且 avatar_url 为空 → 填入（见下，那不是"不要头像"）
   * source='channel'                   → 更新（同来源的新值，比如换了工牌照）
   * source=null                        → 填入（第一次拿到）
   * ```
   *
   * ## ★ 为什么 `manual` + 空值要当成"没设过"
   *
   * 只看 `source` 的话，一行 `avatar_url=NULL, avatar_source='manual'`
   * 会让渠道头像**永久**填不进来。而这种行在真实数据里出现了
   * （实测本机两个账号里有一个是这样）—— 表现是"我自己的头像永远是
   * 首字母，点「从渠道获取」也没用"（取到了，但写不进账号）。
   *
   * 它是怎么来的：设置页的保存按钮原来**总是同时提交两个字段**，
   * 所以用户只改了个名字、而头像框本来是空的，就会发出
   * `avatarUrl: null` → `updateProfile` 写下 `source='manual'`。
   * 也就是说这个状态**不是**"我不要头像"，而是改名字的副作用。
   * （产生端也已经修掉：现在只提交真的改过的字段。两处一起改是刻意的 ——
   * 那边不再**产生**这种行，这边能**修复**存量的行。）
   *
   * 即便用户真的手动清空过：一个空头像与"没有头像"在**显示上完全一样**
   * （都是首字母兜底），所以填进去不覆盖任何用户能看见的选择 ——
   * 只会让他终于有个头像。真要表达"就是不要头像"，那需要一个独立的
   * 布尔字段，而不是靠 NULL 的双重含义。
   *
   * 显示名与头像**分开判**：用户可能改了名字但没设头像，
   * 那时头像仍应该能从渠道填进来。
   *
   * @returns 实际写了哪些字段（调用方据此决定要不要推 UI 更新）
   */
  applyChannelProfile(
    id: string,
    incoming: { displayName?: string | null | undefined; avatarUrl?: string | null | undefined },
  ): { displayNameWritten: boolean; avatarWritten: boolean } {
    const current = this.findById(id)
    if (current === null) return { displayNameWritten: false, avatarWritten: false }

    // 显示名：只在用户没设过时填（用户设的名字优先于渠道的）
    let displayNameWritten = false
    const incomingName = incoming.displayName
    if (
      incomingName !== undefined &&
      incomingName !== null &&
      incomingName !== "" &&
      current.displayName === null
    ) {
      this.db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").run(incomingName, id)
      displayNameWritten = true
    }

    let avatarWritten = false
    const incomingAvatar = incoming.avatarUrl
    /**
     * ★ 判「当前有没有一张用户自己设的图」，而不是只判 source。
     *
     * 空串与 NULL 同等对待：前者是输入框的空值形态，而 `Avatar` 对
     * `src=""` 也是走兜底的 —— 两处判据要一致，否则"看起来没头像"
     * 与"库里算有头像"会分叉。
     */
    const hasManualImage =
      current.avatarSource === "manual" && current.avatarUrl !== null && current.avatarUrl !== ""
    if (
      incomingAvatar !== undefined &&
      incomingAvatar !== null &&
      incomingAvatar !== "" &&
      !hasManualImage
    ) {
      this.db
        .prepare("UPDATE accounts SET avatar_url = ?, avatar_source = 'channel' WHERE id = ?")
        .run(incomingAvatar, id)
      avatarWritten = true
    }

    return { displayNameWritten, avatarWritten }
  }
}

/**
 * 键值设置。
 *
 * 同一份实现服务两张表，由 `table` 决定：
 * - `app_settings`（control 库）：应用级，与账号无关（会话、签名密钥、语言）
 * - `vault_settings`（vault 库）：账号级，换账号应重新计算（onboarding 状态等）
 *
 * 表名不来自外部输入，只能是这两个字面量之一——所以拼进 SQL 是安全的，
 * 而键与值始终走占位符绑定。
 */
export type SettingsTable = "app_settings" | "vault_settings"

export class SettingsRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly table: SettingsTable = "app_settings",
  ) {}

  get(key: string): string | null {
    const row = this.db
      .prepare<[string], { value: string }>(`SELECT value FROM ${this.table} WHERE key = ?`)
      .get(key)
    return row === undefined ? null : row.value
  }

  set(key: string, value: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO ${this.table}(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, updatedAt)
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`).run(key)
  }
}
