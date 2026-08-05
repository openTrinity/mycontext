/**
 * 授权到期与撤销的处置。
 *
 * ★ 核心：**正确性不依赖本地 TTL**。
 *   `expires_at` 是我们自己算的，用户在宿主应用里手动撤销时我们感知不到。
 *   所以真正的判据是「真发一次看返回什么」——
 *   权限类错误 → 标撤销 + 立即降级 + **不重试**。
 *
 * 全部注入 ManualClock：7 天 TTL 靠 sleep 测不了。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock, MS_PER_DAY, MS_PER_HOUR } from "@mycontext/kernel"
import { ConversationRepository } from "@mycontext/store"
import {
  GrantManager,
  RECOMMENDED_TTL,
  RECOMMENDED_TTL_MS,
  SendGuard,
  type SendExecutor,
  type SendTarget,
} from "@mycontext/persona"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const START = 1_785_000_000_000

function seedConversation(vault: TestVault, id = "conv-1"): void {
  new ConversationRepository(vault.db).upsert({
    id,
    channelId: "dingtalk",
    externalId: `ext-${id}`,
    type: "group",
    createdAt: START,
  })
}

function setup() {
  const vault = openTestVault()
  seedConversation(vault)
  const clock = new ManualClock(START)
  const downgraded: { conversationId: string; reason: string }[] = []
  const manager = new GrantManager({
    db: vault.db,
    clock,
    logger: createLogger("test", { level: "error" }),
    downgradeToDraft: (conversationId, reason) => void downgraded.push({ conversationId, reason }),
  })
  return { vault, clock, manager, downgraded }
}

function grantTimed(manager: GrantManager, ttlMs = RECOMMENDED_TTL_MS): void {
  manager.record({
    id: "grant-1",
    conversationId: "conv-1",
    grantType: "timed",
    permParams: { openCid: "ext-conv-1" },
    ttl: RECOMMENDED_TTL,
    ttlMs,
  })
}

describe("记录授权", () => {
  it("timed 授权按 TTL 推算到期时间", () => {
    const context = setup()
    grantTimed(context.manager)
    expect(context.manager.get("conv-1")?.expiresAt).toBe(START + RECOMMENDED_TTL_MS)
    context.vault.close()
  })

  it("permanent 授权没有到期时间", () => {
    const context = setup()
    context.manager.record({
      id: "g",
      conversationId: "conv-1",
      grantType: "permanent",
      permParams: {},
      ttl: null,
      ttlMs: null,
    })
    expect(context.manager.get("conv-1")?.expiresAt).toBeNull()
    context.vault.close()
  })

  it("原始授权维度（permParams）原样存下（不同渠道形态不同）", () => {
    const context = setup()
    grantTimed(context.manager)
    expect(context.manager.get("conv-1")?.permParams).toEqual({ openCid: "ext-conv-1" })
    context.vault.close()
  })

  it("重新授权清掉撤销标记（那正是「重新授权」的意思）", () => {
    const context = setup()
    grantTimed(context.manager)
    context.manager.markRevoked("grant-1")
    expect(context.manager.get("conv-1")?.revokedAt).not.toBeNull()

    context.clock.advance(1000)
    grantTimed(context.manager)
    expect(context.manager.get("conv-1")?.revokedAt).toBeNull()
    context.vault.close()
  })
})

describe("有效性判定（本地前置，目的是不浪费必然失败的调用）", () => {
  it("有效期内可用", () => {
    const context = setup()
    grantTimed(context.manager)
    expect(context.manager.requireValid("conv-1", "chat.message:send")).not.toBeNull()
    context.vault.close()
  })

  it("从未授权 → null", () => {
    const context = setup()
    expect(context.manager.requireValid("conv-1", "chat.message:send")).toBeNull()
    context.vault.close()
  })

  it("★ 本地推算的 TTL 到期后不可用（24h 默认值的那个坑）", () => {
    const context = setup()
    grantTimed(context.manager, 24 * MS_PER_HOUR)
    context.clock.advance(24 * MS_PER_HOUR + 1)
    expect(context.manager.requireValid("conv-1", "chat.message:send")).toBeNull()
    context.vault.close()
  })

  it("已撤销 → null", () => {
    const context = setup()
    grantTimed(context.manager)
    context.manager.markRevoked("grant-1")
    expect(context.manager.requireValid("conv-1", "chat.message:send")).toBeNull()
    context.vault.close()
  })

  it("scope 不匹配 → null（不同 scope 的授权不能互认）", () => {
    const context = setup()
    grantTimed(context.manager)
    expect(context.manager.requireValid("conv-1", "chat.message:read")).toBeNull()
    context.vault.close()
  })
})

describe("★ 撤销：标记 + 立即降级 + 不重试", () => {
  /**
   * 只标撤销不降级的话，下一条消息会再试一次并再弹一次窗 ——
   * 而重试对授权问题永远没用。
   */
  it("markRevoked 同时把会话降级为草稿", () => {
    const context = setup()
    grantTimed(context.manager)
    context.manager.markRevoked("grant-1")
    expect(context.downgraded).toEqual([{ conversationId: "conv-1", reason: "grant_missing" }])
    context.vault.close()
  })

  it("发送成功时刷新 last_verified（授权确实有效的唯一证据）", () => {
    const context = setup()
    grantTimed(context.manager)
    context.clock.advance(5000)
    context.manager.touchVerified("grant-1")
    expect(context.manager.get("conv-1")?.lastVerifiedAt).toBe(START + 5000)
    context.vault.close()
  })
})

describe("续授提醒（到期是可预见的事）", () => {
  it("到期前 24h 内的授权被列出", () => {
    const context = setup()
    grantTimed(context.manager, 2 * MS_PER_DAY)
    // 还剩 2 天 → 不提醒
    expect(context.manager.expiringSoon()).toEqual([])

    // 推进到只剩 12 小时
    context.clock.advance(2 * MS_PER_DAY - 12 * MS_PER_HOUR)
    expect(context.manager.expiringSoon().map((g) => g.conversationId)).toEqual(["conv-1"])
    context.vault.close()
  })

  it("已过期的不在提醒列表里（那时该走降级而不是提醒）", () => {
    const context = setup()
    grantTimed(context.manager, MS_PER_HOUR)
    context.clock.advance(2 * MS_PER_HOUR)
    expect(context.manager.expiringSoon()).toEqual([])
    context.vault.close()
  })

  it("permanent 授权不需要提醒", () => {
    const context = setup()
    context.manager.record({
      id: "g",
      conversationId: "conv-1",
      grantType: "permanent",
      permParams: {},
      ttl: null,
      ttlMs: null,
    })
    context.clock.advance(365 * MS_PER_DAY)
    expect(context.manager.expiringSoon()).toEqual([])
    context.vault.close()
  })
})

describe("定时清扫过期授权", () => {
  /**
   * 定时扫而不是等下一条消息来时才发现：用户打开数字人页面时就该看到
   * 「这几个会话的授权过期了」，而不是等到有人给他发消息。
   */
  it("过期的授权触发会话降级", () => {
    const context = setup()
    grantTimed(context.manager, MS_PER_HOUR)
    context.clock.advance(MS_PER_HOUR + 1)
    expect(context.manager.sweepExpired()).toEqual(["conv-1"])
    expect(context.downgraded).toEqual([{ conversationId: "conv-1", reason: "grant_expired" }])
    context.vault.close()
  })

  it("未过期的不动", () => {
    const context = setup()
    grantTimed(context.manager)
    expect(context.manager.sweepExpired()).toEqual([])
    context.vault.close()
  })
})

/**
 * ★★ 与 SendGuard 接起来的端到端：宿主侧撤销我们感知不到，
 * 所以正确性来自"真发一次看返回什么"。
 */
describe("★ 宿主侧撤销：真发一次才知道", () => {
  function makeGuard(
    context: ReturnType<typeof setup>,
    executorResult: Awaited<ReturnType<SendExecutor["send"]>>,
  ) {
    let calls = 0
    const guard = new SendGuard({
      drafts: { get: () => ({ text: "沙箱环境部署完成了", editedText: null }) },
      grants: context.manager,
      executor: {
        send: () => {
          calls += 1
          return Promise.resolve(executorResult)
        },
      },
      clock: context.clock,
      logger: createLogger("test", { level: "error" }),
      downgradeToDraft: (conversationId, reason) =>
        void context.downgraded.push({ conversationId, reason }),
      forceShortCircuit: false,
    })
    return { guard, callCount: () => calls }
  }

  const target: SendTarget = { kind: "group", externalId: "ext-conv-1" }

  it("本地看起来有效，但真发返回权限错误 → 标撤销 + 降级 + 不重试", async () => {
    const context = setup()
    grantTimed(context.manager)
    // 本地判定"有效"
    expect(context.manager.requireValid("conv-1", "chat.message:send")).not.toBeNull()

    const { guard, callCount } = makeGuard(context, {
      ok: false,
      code: "PERMISSION_REQUIRED",
      detail: "user revoked in host app",
    })
    const outcome = await guard.send({
      draftId: "d-1",
      conversationId: "conv-1",
      target,
      mentions: [],
      idempotencyKey: "uuid-1",
      dryRun: false,
    })

    expect(outcome).toEqual({ state: "blocked_no_grant", reason: "permission_denied" })
    // ★ 三件事都发生了
    expect(context.manager.get("conv-1")?.revokedAt).not.toBeNull()
    expect(context.downgraded.some((item) => item.conversationId === "conv-1")).toBe(true)
    expect(callCount()).toBe(1) // 不重试
    context.vault.close()
  })

  it("撤销之后再发被本地前置拦住（不再浪费调用）", async () => {
    const context = setup()
    grantTimed(context.manager)
    const first = makeGuard(context, {
      ok: false,
      code: "PERMISSION_REQUIRED",
      detail: "revoked",
    })
    await first.guard.send({
      draftId: "d-1",
      conversationId: "conv-1",
      target,
      mentions: [],
      idempotencyKey: "uuid-1",
      dryRun: false,
    })

    const second = makeGuard(context, { ok: true })
    const outcome = await second.guard.send({
      draftId: "d-2",
      conversationId: "conv-1",
      target,
      mentions: [],
      idempotencyKey: "uuid-2",
      dryRun: false,
    })
    expect(outcome.state).toBe("blocked_no_grant")
    expect(second.callCount()).toBe(0)
    context.vault.close()
  })

  it("成功发送后 last_verified 被刷新", async () => {
    const context = setup()
    grantTimed(context.manager)
    const { guard } = makeGuard(context, { ok: true, externalId: "sent-1" })
    context.clock.advance(1000)
    await guard.send({
      draftId: "d-1",
      conversationId: "conv-1",
      target,
      mentions: [],
      idempotencyKey: "uuid-1",
      dryRun: false,
    })
    expect(context.manager.get("conv-1")?.lastVerifiedAt).toBe(START + 1000)
    context.vault.close()
  })
})
