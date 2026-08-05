/**
 * 发送授权的管理。
 *
 * ## 这一层建模的是**外部约束**，不是我们的可选项
 *
 * 实测来源应用的 `chmod --help` 原文：「chat.* scope **每次执行都需要用户在
 * 宿主 UI 中确认，模型无法静默绕过**」，`--ttl` **默认只有 24h**。
 * 确认弹窗在**第三方宿主应用**里，我们的 Electron 无法代劳。
 *
 * 不建模的后果：用户开了 auto，**次日起每次发送都失败或弹窗**，
 * 而 policy 的其余 7 条全都通过了 → `decision_reason` 也解释不了。
 * 这是"功能昨天还好好的"这类最难排查的故障。
 *
 * ## ★ expires_at 是本地推算值，正确性不依赖它
 *
 * 用户在宿主应用里**手动撤销**授权时，我们库里那行仍然"未过期"。
 * 所以：
 * · 本地 TTL 只是**优化**（提前拦住必然失败的调用 + 驱动续授提醒）；
 * · 正确性只来自「真发一次看返回什么」——
 *   权限类错误 → 立刻标 `revoked_at` + 降级为 draft + **不重试**。
 */
import { MS_PER_DAY, MS_PER_HOUR, type Clock, type Logger } from "@mycontext/kernel"
import type { SqliteDatabase } from "@mycontext/store"
import { SEND_SCOPE } from "./send-guard.js"

/** 建议的 TTL：比默认 24h 长，减少续授频率。 */
export const RECOMMENDED_TTL = "7d"
export const RECOMMENDED_TTL_MS = 7 * MS_PER_DAY
/** 到期前多久开始提醒续授。 */
export const RENEWAL_WARNING_MS = 24 * MS_PER_HOUR

export interface GrantRecord {
  id: string
  conversationId: string
  scope: string
  agentCode: string
  grantType: "once" | "session" | "timed" | "permanent"
  permParams: Record<string, string>
  ttl: string | null
  grantedAt: number
  /** 本地推算值。null = permanent */
  expiresAt: number | null
  revokedAt: number | null
  lastVerifiedAt: number | null
}

interface GrantDbRow {
  id: string
  conversation_id: string
  scope: string
  agent_code: string
  grant_type: string
  perm_params_json: string
  ttl: string | null
  granted_at: number
  expires_at: number | null
  revoked_at: number | null
  last_verified_at: number | null
}

function toGrant(row: GrantDbRow): GrantRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    scope: row.scope,
    agentCode: row.agent_code,
    grantType: row.grant_type as GrantRecord["grantType"],
    permParams: JSON.parse(row.perm_params_json) as Record<string, string>,
    ttl: row.ttl,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastVerifiedAt: row.last_verified_at,
  }
}

export interface GrantManagerOptions {
  db: SqliteDatabase
  clock: Clock
  logger: Logger
  /** 会话降级为 draft（授权失效时调用） */
  downgradeToDraft: (conversationId: string, reason: string) => void
}

export class GrantManager {
  constructor(private readonly options: GrantManagerOptions) {}

  /**
   * 记录一次授权成功。
   *
   * `expiresAt` 由 `grantedAt + ttl` 推算 —— 见文件头：它只是优化。
   */
  record(input: {
    id: string
    conversationId: string
    grantType: GrantRecord["grantType"]
    permParams: Record<string, string>
    ttl: string | null
    ttlMs: number | null
    agentCode?: string
  }): void {
    const now = this.options.clock.now()
    // permanent 没有到期时间
    const expiresAt =
      input.grantType === "permanent" || input.ttlMs === null ? null : now + input.ttlMs

    this.options.db
      .prepare(
        `INSERT INTO dh_send_grants
           (id, conversation_id, scope, agent_code, grant_type, perm_params_json,
            ttl, granted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, scope, agent_code) DO UPDATE SET
           grant_type = excluded.grant_type,
           perm_params_json = excluded.perm_params_json,
           ttl = excluded.ttl,
           granted_at = excluded.granted_at,
           expires_at = excluded.expires_at,
           -- 重新授权时清掉撤销标记（这正是"重新授权"的意思）
           revoked_at = NULL`,
      )
      .run(
        input.id,
        input.conversationId,
        SEND_SCOPE,
        input.agentCode ?? "wukong",
        input.grantType,
        JSON.stringify(input.permParams),
        input.ttl,
        now,
        expiresAt,
      )

    this.options.logger.info("send grant recorded", {
      conversationId: input.conversationId,
      grantType: input.grantType,
      expiresAt,
    })
  }

  get(conversationId: string, agentCode = "wukong"): GrantRecord | null {
    const row = this.options.db
      .prepare<[string, string, string], GrantDbRow>(
        `SELECT * FROM dh_send_grants
          WHERE conversation_id = ? AND scope = ? AND agent_code = ?`,
      )
      .get(conversationId, SEND_SCOPE, agentCode)
    return row === undefined ? null : toGrant(row)
  }

  /**
   * 取有效授权。返回 null 表示不可用（从未授权 / 已撤销 / 本地已过期）。
   *
   * 供 SendGuard 的第 ④ 层前置使用 —— 目的是**不浪费一次必然失败的调用**，
   * 而不是"确认一定能发出去"（后者只有真发才知道）。
   */
  requireValid(
    conversationId: string,
    scope: string,
  ): { id: string; expiresAt: number | null } | null {
    if (scope !== SEND_SCOPE) return null
    const grant = this.get(conversationId)
    if (grant === null || grant.revokedAt !== null) return null
    if (grant.expiresAt !== null && grant.expiresAt <= this.options.clock.now()) return null
    return { id: grant.id, expiresAt: grant.expiresAt }
  }

  /**
   * 该会话的授权是否**明确不可用**。
   *
   * ## ★ 与 `requireValid() === null` 的区别
   *
   * `requireValid` 把三种情况塞进同一个 null：从没授权过 / 被撤销 / 已过期。
   * 而它们的处置**不同**：
   *
   * · 从没授权过 → 照常发（那道授权在真实环境上拿不到，见 send-guard），
   * · 被撤销或已过期 → 拦住（渠道明确说过"不行"）。
   *
   * 所以这个方法只回答后者。`false` 意味着"没有理由拦"，
   * **不**意味着"一定能发出去"—— 后者只有真发才知道。
   */
  isDenied(conversationId: string, scope: string): boolean {
    if (scope !== SEND_SCOPE) return false
    const grant = this.get(conversationId)
    // 没有记录 ≠ 被拒
    if (grant === null) return false
    if (grant.revokedAt !== null) return true
    return grant.expiresAt !== null && grant.expiresAt <= this.options.clock.now()
  }

  /**
   * 标记撤销 + **立即降级为草稿**。
   *
   * 三件事必须同时发生（见 send-guard 第 ④ 层）：标撤销、降级、不重试。
   * 只标撤销不降级的话，下一条消息会再试一次并再弹一次窗。
   */
  markRevoked(grantId: string): void {
    const now = this.options.clock.now()
    const row = this.options.db
      .prepare<
        [string],
        { conversation_id: string }
      >("SELECT conversation_id FROM dh_send_grants WHERE id = ?")
      .get(grantId)

    this.options.db
      .prepare("UPDATE dh_send_grants SET revoked_at = ? WHERE id = ?")
      .run(now, grantId)

    if (row !== undefined) {
      this.options.downgradeToDraft(row.conversation_id, "grant_missing")
      this.options.logger.warn("send grant revoked, conversation downgraded to draft", {
        conversationId: row.conversation_id,
        grantId,
      })
    }
  }

  /**
   * 刷新"上次确认有效"的时间。
   *
   * 只在**真发成功**时调用 —— 这是授权确实有效的唯一证据。
   */
  touchVerified(grantId: string): void {
    this.options.db
      .prepare("UPDATE dh_send_grants SET last_verified_at = ? WHERE id = ?")
      .run(this.options.clock.now(), grantId)
  }

  /**
   * 即将到期、需要提醒续授的授权。
   *
   * 提前 24h 提醒：授权到期是**可预见**的事，让用户在发现"数字人不发消息了"
   * 之前就知道要续 —— 事后解释永远比事前提醒差。
   */
  expiringSoon(): GrantRecord[] {
    const now = this.options.clock.now()
    return this.options.db
      .prepare<[number, number], GrantDbRow>(
        `SELECT * FROM dh_send_grants
          WHERE revoked_at IS NULL AND expires_at IS NOT NULL
            AND expires_at > ? AND expires_at <= ?
          ORDER BY expires_at`,
      )
      .all(now, now + RENEWAL_WARNING_MS)
      .map(toGrant)
  }

  /**
   * 已过期的授权 → 需要把对应会话降级。
   *
   * 定时跑（而不是等下一条消息来时才发现）：用户打开数字人页面时
   * 就该看到「这几个会话的授权过期了」，而不是等到有人给他发消息。
   */
  sweepExpired(): string[] {
    const now = this.options.clock.now()
    const rows = this.options.db
      .prepare<[number], GrantDbRow>(
        `SELECT * FROM dh_send_grants
          WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(now)

    const downgraded: string[] = []
    for (const row of rows) {
      this.options.downgradeToDraft(row.conversation_id, "grant_expired")
      downgraded.push(row.conversation_id)
    }
    if (downgraded.length > 0) {
      this.options.logger.info("expired grants swept, conversations downgraded", {
        count: downgraded.length,
      })
    }
    return downgraded
  }
}
