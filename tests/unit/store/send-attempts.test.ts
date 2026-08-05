/**
 * `dh_send_attempts` 的写入门禁。
 *
 * ## ★ 为什么这张表单独一组门禁
 *
 * 它是 policy 频率限制（9 条里**唯一**防"数字人在群里连发"的那条）的
 * 数据来源。而在这一轮之前，它**没有写入方** —— 于是
 * `recentSendTimestamps` 永远返回空数组，`rate_limited` 永远通过。
 *
 * 那个失效形态是本项目里最阴的一类：限流"生效但没触上限"与
 * "完全没生效"在外观上一模一样（都不拦），只有在真的连发时才暴露 ——
 * 而那时已经发出去了，不可逆。
 *
 * 所以这一组的核心断言是**闭环**：写一行 → 频率判定读得到 → 真的会拦。
 * 只验"写进去了"是不够的：写了但字段对不上（比如 `sent_at` 留 null）
 * 时读侧仍然是空的，而那时表里有数据、看起来一切正常。
 */
import { describe, expect, it } from "vitest"
import { ManualClock, MS_PER_MINUTE } from "@mycontext/kernel"
import { evaluatePolicy, DEFAULT_WORK_HOURS, UNEVALUATED_CONFIDENCE } from "@mycontext/persona"
import type { PolicyInput } from "@mycontext/persona"
import { ConversationRepository, PersonaRunRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

/** 工作日下午 3 点（周三）：默认工作时间内，免得撞上作息判定。 */
const NOW = new Date(2026, 6, 1, 15, 0, 0).getTime()

function seed() {
  const vault = openTestVault()
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cidFAKE",
    type: "group",
    title: "测试群",
    memberCount: 5,
    createdAt: NOW,
  })
  return vault
}

function attempt(over: Partial<Parameters<PersonaRunRepository["recordSendAttempt"]>[0]> = {}) {
  return {
    idempotencyKey: "key-1",
    draftId: "d1",
    conversationId: "conv-1",
    targetKind: "group" as const,
    targetExternalId: "cidFAKE",
    atExternalIds: [] as readonly string[],
    contentHash: "hash-1",
    grantId: null,
    state: "sent" as const,
    sentMessageExternalId: "msgFAKE",
    usedDryRun: false,
    error: null,
    attemptedAt: NOW,
    sentAt: NOW,
    source: "agent_auto" as const,
    ...over,
  }
}

describe("★ 写入 → 频率判定读得到（闭环，不只是「写进去了」）", () => {
  it("记一条 sent 之后 recentSendTimestamps 就能读到", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    expect(runs.recentSendTimestamps({ conversationId: "conv-1", sinceMs: 0 })).toEqual([])

    runs.recordSendAttempt(attempt())

    expect(runs.recentSendTimestamps({ conversationId: "conv-1", sinceMs: 0 })).toEqual([NOW])
    // 全局口径也要读到（policy 有两个窗口）
    expect(runs.recentSendTimestamps({ sinceMs: 0 })).toEqual([NOW])
    vault.close()
  })

  /**
   * ★ 整组里最重要的一条：写进去的记录**真的会让 policy 拦住**。
   *
   * 这一条把"表里有行"与"限流生效"连起来。缺了它的话，
   * 一个把 `sentAt` 写成 null 的实现能让上面那条断言之外的一切通过 ——
   * 而那时读侧是空的，限流照样从不触发。
   */
  it("写满上限之后 policy 判 rate_limited（限流第一次真的生效）", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    const clock = new ManualClock(NOW)

    const base: PolicyInput = {
      replyMode: "auto",
      sceneAllowsAuto: true,
      agentAllowsAuto: true,
      confidence: UNEVALUATED_CONFIDENCE,
      risk: "low",
      bannedPhraseHits: [],
      recentSendsInConversation: [],
      recentSendsGlobal: [],
      killSwitchActive: false,
      grant: { expiresAt: NOW + 86_400_000, revokedAt: null },
      dryRun: false,
      workHours: DEFAULT_WORK_HOURS,
      rateLimit: {
        perConversation: 2,
        perConversationWindowMs: 10 * MS_PER_MINUTE,
        global: 100,
        globalWindowMs: 60 * MS_PER_MINUTE,
      },
    }

    // 先确认在没有发送记录时是能发的 —— 否则下面的断言证明不了任何事
    expect(evaluatePolicy(base, clock).decision).toBe("auto_sent")

    // 写两条（等于上限）
    runs.recordSendAttempt(attempt({ idempotencyKey: "k1", sentAt: NOW - MS_PER_MINUTE }))
    runs.recordSendAttempt(attempt({ idempotencyKey: "k2", sentAt: NOW - 2 * MS_PER_MINUTE }))

    const recent = runs.recentSendTimestamps({
      conversationId: "conv-1",
      sinceMs: NOW - 10 * MS_PER_MINUTE,
    })
    expect(recent).toHaveLength(2)

    const verdict = evaluatePolicy({ ...base, recentSendsInConversation: recent }, clock)
    expect(verdict.decision).not.toBe("auto_sent")
    expect(verdict.reason).toBe("rate_limited")
    vault.close()
  })
})

describe("★ 发送来源决定是否进入 agent-sent 隔离账本", () => {
  it("自动发送进入 agent-sent，用户审核发送不进入", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    runs.recordSendAttempt(
      attempt({
        idempotencyKey: "auto",
        sentMessageExternalId: "msg-auto",
        source: "agent_auto",
      }),
    )
    runs.recordSendAttempt(
      attempt({
        idempotencyKey: "approved",
        sentMessageExternalId: "msg-approved",
        source: "user_approved",
      }),
    )

    expect(runs.agentSentExternalIds(0)).toEqual(["msg-auto"])
    vault.close()
  })
})

describe("★ 数字分身活动流只展示成功发生的用户结果", () => {
  it("区分自动发送、原样采纳与编辑后发送，并排除失败尝试", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    const addDraft = (id: string, text: string) =>
      runs.insertDraft(
        {
          id,
          runId: null,
          conversationId: "conv-1",
          replyToExternalId: null,
          text,
          citations: [],
          notSentReason: null,
        },
        NOW,
      )

    addDraft("auto-draft", "自动回复")
    runs.recordSendAttempt(
      attempt({
        idempotencyKey: "auto",
        draftId: "auto-draft",
        source: "agent_auto",
        sentAt: NOW - 3,
      }),
    )

    addDraft("accepted-draft", "原样采纳")
    runs.recordSendAttempt(
      attempt({
        idempotencyKey: "accepted",
        draftId: "accepted-draft",
        source: "user_approved",
        sentAt: NOW - 2,
      }),
    )

    addDraft("edited-draft", "原稿")
    runs.saveDraftEdit("edited-draft", "用户改后的正文")
    runs.recordSendAttempt(
      attempt({
        idempotencyKey: "edited",
        draftId: "edited-draft",
        source: "user_approved",
        sentAt: NOW - 1,
      }),
    )

    addDraft("failed-draft", "没有发出去")
    runs.recordSendAttempt(
      attempt({
        idempotencyKey: "failed",
        draftId: "failed-draft",
        source: "agent_auto",
        state: "failed",
        sentAt: null,
      }),
    )

    expect(runs.recentActivities("conv-1")).toEqual([
      {
        id: "edited",
        conversationId: "conv-1",
        kind: "user_edited",
        text: "用户改后的正文",
        occurredAt: NOW - 1,
      },
      {
        id: "accepted",
        conversationId: "conv-1",
        kind: "user_accepted",
        text: "原样采纳",
        occurredAt: NOW - 2,
      },
      {
        id: "auto",
        conversationId: "conv-1",
        kind: "auto_sent",
        text: "自动回复",
        occurredAt: NOW - 3,
      },
    ])
    vault.close()
  })
})

describe("★ 只有真发成功才计入限流", () => {
  it.each([
    ["reserved（占位未发）", "reserved" as const],
    ["failed（发失败）", "failed" as const],
    ["blocked_no_grant（没授权）", "blocked_no_grant" as const],
  ])("%s 不计入", (_label, state) => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    /**
     * 这三种都没有真的发出去。算进来会让限流比实际更严 ——
     * 用户看到"明明没发几条却被限流"，然后就不信这个功能了。
     */
    runs.recordSendAttempt(attempt({ state, sentAt: null }))
    expect(runs.recentSendTimestamps({ conversationId: "conv-1", sinceMs: 0 })).toEqual([])
    vault.close()
  })

  it("失败的尝试仍然**落库**（只是不计入限流）", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)
    runs.recordSendAttempt(attempt({ state: "failed", sentAt: null, error: "ETIMEDOUT" }))
    /**
     * 失败也要写：连续失败很多次本身是要能看见的信号
     * （授权被撤销、网关限流）。只写成功的话这张表会变成
     * 一张"看起来一切顺利"的表。
     */
    const row = vault.db
      .prepare<
        [],
        { state: string; error: string | null }
      >(`SELECT state, error FROM dh_send_attempts`)
      .get()
    expect(row?.state).toBe("failed")
    expect(row?.error).toBe("ETIMEDOUT")
    vault.close()
  })
})

describe("★ 幂等键是主键：重试复用同一个 key 只留一行", () => {
  it("同 key 重写覆盖（重试时不抛主键冲突）", () => {
    const vault = seed()
    const runs = new PersonaRunRepository(vault.db)

    // 第一次失败
    runs.recordSendAttempt(attempt({ state: "failed", sentAt: null, error: "ETIMEDOUT" }))
    /**
     * 重试**必须**复用同一个 idempotencyKey —— 那是服务端幂等的要求
     * （实测 24h 内同值不重复投递）。所以这里不能抛主键冲突：
     * 那时我们正在处理一次已经失败的发送，再抛一个错只会掩盖原因。
     */
    runs.recordSendAttempt(attempt({ state: "sent", sentAt: NOW }))

    const rows = vault.db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM dh_send_attempts`)
      .get()
    expect(rows?.c).toBe(1)
    expect(runs.recentSendTimestamps({ conversationId: "conv-1", sinceMs: 0 })).toEqual([NOW])
    vault.close()
  })
})

describe("★ @人 列表的存法", () => {
  it("空列表存 NULL 而不是空串（查询里 IS NULL 才判得出来）", () => {
    const vault = seed()
    new PersonaRunRepository(vault.db).recordSendAttempt(attempt({ atExternalIds: [] }))
    const row = vault.db
      .prepare<
        [],
        { at_external_ids: string | null }
      >(`SELECT at_external_ids FROM dh_send_attempts`)
      .get()
    expect(row?.at_external_ids).toBeNull()
    vault.close()
  })

  it("多个 @人 逗号分隔（与命令参数同形，便于对账）", () => {
    const vault = seed()
    new PersonaRunRepository(vault.db).recordSendAttempt(attempt({ atExternalIds: ["DeA", "DeB"] }))
    const row = vault.db
      .prepare<
        [],
        { at_external_ids: string | null }
      >(`SELECT at_external_ids FROM dh_send_attempts`)
      .get()
    expect(row?.at_external_ids).toBe("DeA,DeB")
    vault.close()
  })
})
