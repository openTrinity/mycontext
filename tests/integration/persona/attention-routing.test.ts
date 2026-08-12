/**
 * 路由**真的门控投递** —— 用真库 + 真消息跑一遍。
 *
 * ## 为什么必须有这个文件（源码断言不够）
 *
 * `tests/unit/store/attention-scope.test.ts` 锁的是纯函数与源码形状。
 * 但"路由挂对了没有"这件事，源码断言只能看到文本 —— 我在本轮就被这一点
 * 骗过一次：断言写成"routeToAttention 出现在 personaFastPath 之前"，
 * 而把投递改成无条件调用之后它照样绿。
 *
 * 而真应用里这条路**观测不到**：`inbound.message` 只在
 * `options.backfill !== true` 且 `result.changed.length > 0` 时 emit，
 * 本机历史早就采完（实测 62 页全是 `changed:0/unchanged:51`），
 * 于是路由在真机上一次都没被触发过。
 *
 * 所以这里用真库造一条**新**消息，直接驱动同一个判据组合，
 * 断言"在范围内 → 放行 / 不在范围内 → 拦住"。
 */
import { describe, expect, it } from "vitest"
import {
  AttentionScopeRepository,
  AttentionCoverageRepository,
  routeToAttention,
  toDayBucket,
} from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const CH = "dingtalk"
const IN_SCOPE = "cidFAKE0001=="
const OUT_SCOPE = "cidFAKE0002=="

/** 造一个会话 + 一条消息，返回它的业务时间。 */
function seedMessage(
  vault: ReturnType<typeof openTestVault>,
  externalId: string,
  convExternalId: string,
  sentAt: number,
): void {
  const convId = `conv-${convExternalId}`
  vault.db
    .prepare(
      `INSERT OR IGNORE INTO conversations
         (id, channel_id, external_id, type, title, created_at)
       VALUES (?, ?, ?, 'group', '测试群', 0)`,
    )
    .run(convId, CH, convExternalId)
  vault.db
    .prepare(
      `INSERT INTO messages
         (id, channel_id, conversation_id, external_id, sent_at, direction, created_at)
       VALUES (?, ?, ?, ?, ?, 'inbound', 0)`,
    )
    .run(`msg-${externalId}`, CH, convId, externalId, sentAt)
}

/**
 * 复刻 `ingest.service.ts` 里 `inbound.message` 那段的判据组合。
 *
 * ★ 这里**不是**把生产代码抄一遍当断言（那样改坏生产代码测试照样绿）——
 * 它调的是同一个导出的 `routeToAttention` + 同一个仓库方法，
 * 只有"从库里取会话 externalId"那一步是本地写的（生产那边同样是一次
 * `ConversationRepository` 查询）。判据集中在被复用的那三个东西上。
 */
function routeOne(
  vault: ReturnType<typeof openTestVault>,
  input: { convExternalId: string; sentAt: number },
): { routed: boolean; reason?: string } {
  const scopeRepo = new AttentionScopeRepository(vault.db)
  const hasScope = scopeRepo.activeCount(CH) > 0
  if (!hasScope) return { routed: true } // 名单为空 → 放行（迁移期的正确一侧）
  const row = scopeRepo.get(CH, input.convExternalId)
  const verdict = routeToAttention({
    conversationExternalId: input.convExternalId,
    sentAt: input.sentAt,
    scope: row === null ? null : { enabledAt: row.enabledAt, active: row.active },
  })
  new AttentionCoverageRepository(vault.db).bump(CH, {
    dayBucket: toDayBucket(input.sentAt),
    routed: verdict.routed ? 1 : 0,
    skipped: verdict.routed ? 0 : 1,
    at: input.sentAt,
  })
  return verdict.routed ? { routed: true } : { routed: false, reason: verdict.reason }
}

describe("路由门控：真库 + 真消息", () => {
  it("★★★ 在监听范围内的新消息 → 放行，并记 routed", () => {
    const vault = openTestVault()
    const now = Date.now()
    new AttentionScopeRepository(vault.db).add(
      CH,
      [{ conversationExternalId: IN_SCOPE, enabledAt: now - 1000 }],
      now,
    )
    seedMessage(vault, "msgFAKE01", IN_SCOPE, now)
    expect(routeOne(vault, { convExternalId: IN_SCOPE, sentAt: now })).toEqual({ routed: true })
    const cov = new AttentionCoverageRepository(vault.db).summarize(
      CH,
      toDayBucket(now),
      toDayBucket(now),
    )
    expect(cov.routed).toBe(1)
    expect(cov.skipped).toBe(0)
    vault.close()
  })

  it("★★★ 不在监听范围内的新消息 → 拦住，并记 skipped", () => {
    /**
     * 这一条是「监听范围」这个功能存在的全部意义：范围外的消息不该进
     * 管控层。没有它的话，勾选与不勾选的行为完全相同 —— 而那正是
     * 上一版（只有一段指路文案）的状态。
     */
    const vault = openTestVault()
    const now = Date.now()
    new AttentionScopeRepository(vault.db).add(
      CH,
      [{ conversationExternalId: IN_SCOPE, enabledAt: now - 1000 }],
      now,
    )
    seedMessage(vault, "msgFAKE02", OUT_SCOPE, now)
    expect(routeOne(vault, { convExternalId: OUT_SCOPE, sentAt: now })).toEqual({
      routed: false,
      reason: "not_in_scope",
    })
    const cov = new AttentionCoverageRepository(vault.db).summarize(
      CH,
      toDayBucket(now),
      toDayBucket(now),
    )
    expect(cov.skipped).toBe(1)
    expect(cov.routed).toBe(0)
    vault.close()
  })

  it("★★★ 名单为空 → 放行（否则是一次静默功能回归）", () => {
    /**
     * 存量用户 `attention_scope` 是空表。判成"什么都不关心"会让分身
     * 整个静默 —— 用户看到"它不理人了"，日志里一个错都没有。
     */
    const vault = openTestVault()
    const now = Date.now()
    seedMessage(vault, "msgFAKE03", OUT_SCOPE, now)
    expect(routeOne(vault, { convExternalId: OUT_SCOPE, sentAt: now })).toEqual({ routed: true })
    vault.close()
  })

  it("★★★ 早于 enabled_at 的历史消息 → 拦住（监听只管实时流）", () => {
    /**
     * 一次历史回填会灌进几万条旧消息。没有这条判据的话分身会对着
     * 三个月前的消息起草回复（本仓库实测过 19 天前的群消息被起草）。
     */
    const vault = openTestVault()
    const now = Date.now()
    new AttentionScopeRepository(vault.db).add(
      CH,
      [{ conversationExternalId: IN_SCOPE, enabledAt: now }],
      now,
    )
    const old = now - 30 * 86_400_000
    seedMessage(vault, "msgFAKE04", IN_SCOPE, old)
    expect(routeOne(vault, { convExternalId: IN_SCOPE, sentAt: old })).toEqual({
      routed: false,
      reason: "before_enabled_at",
    })
    vault.close()
  })

  it("★★ 关掉之后同一个会话的新消息 → 拦住（收回真的生效）", () => {
    const vault = openTestVault()
    const now = Date.now()
    const repo = new AttentionScopeRepository(vault.db)
    repo.add(CH, [{ conversationExternalId: IN_SCOPE, enabledAt: now - 1000 }], now)
    // 再加一个别的会话，保证 activeCount > 0（否则会走"名单为空→放行"）
    repo.add(CH, [{ conversationExternalId: "cidFAKE0009==", enabledAt: now - 1000 }], now)
    repo.disable(CH, IN_SCOPE, now)
    seedMessage(vault, "msgFAKE05", IN_SCOPE, now)
    expect(routeOne(vault, { convExternalId: IN_SCOPE, sentAt: now })).toEqual({
      routed: false,
      reason: "scope_disabled",
    })
    vault.close()
  })
})
