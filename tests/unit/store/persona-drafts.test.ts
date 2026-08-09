import { describe, expect, it } from "vitest"
import { ConversationRepository, MessageRepository, PersonaRunRepository } from "@mycontext/store"
import { openTestVault } from "../../helpers/vault.js"

const NOW = 1_785_306_600_000

function setup() {
  const vault = openTestVault()
  new ConversationRepository(vault.db).upsert({
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cid-1",
    type: "direct",
    title: "测试会话",
    memberCount: 2,
    createdAt: NOW,
  })
  const messages = new MessageRepository(vault.db)
  messages.upsertMany([
    {
      id: "incoming",
      channelId: "dingtalk",
      conversationId: "conv-1",
      externalId: "msg-in",
      contentText: "在吗",
      sentAt: NOW,
      direction: "inbound",
      isSelf: false,
      origin: "human",
      createdAt: NOW,
    },
  ])
  const runs = new PersonaRunRepository(vault.db)
  runs.insertDraft(
    {
      id: "draft-1",
      runId: null,
      conversationId: "conv-1",
      replyToExternalId: "msg-in",
      text: "在",
      citations: ["incoming"],
      notSentReason: "mode_not_auto",
    },
    NOW + 10,
  )
  return { vault, messages, runs }
}

/** 往 conv-1 再插 n 条 pending 草稿，created_at 依次递增（越新序号越大）。 */
function seedDrafts(
  runs: PersonaRunRepository,
  conversationId: string,
  ids: readonly string[],
  baseAt: number,
): void {
  ids.forEach((id, index) => {
    runs.insertDraft(
      {
        id,
        runId: null,
        conversationId,
        replyToExternalId: "msg-in",
        text: `候选 ${id}`,
        citations: [],
        notSentReason: null,
      },
      baseAt + index,
    )
  })
}

/**
 * 「本人已回过」这一轮 —— **只挡自动发，不动草稿状态**。
 *
 * ## ★ 曾经有三处执行点，全都删了
 *
 * 生成后丢弃 / 点发送时拒 / 后台扫描作废 —— 合起来的效果是草稿在用户眼前
 * 自己消失、或者按下发送被告知"已过期"。而那条规则的前提（"你回过了就说明
 * 不需要它了"）不成立：用户可能想补一句、换个说法。
 *
 * 所以 `expireAnsweredDrafts` / `expireDraftIfAnswered` / `isReplyTurnOpen`
 * **全部已删除**，草稿一律保留。
 *
 * ## ★★ 判据搬去哪了（这是这段注释最要紧的一句）
 *
 * 搬到 `TurnFreshness.ownerRepliedAfter`（`packages/persona/src/intake.ts`
 * 算，`guard.ts` 的 `freshnessBlocksAutoSend` 用）。搬的时候顺带修正了判据：
 * **区分分身代发** —— 分身自己发出去的消息也是本人 id，把它当成"本人已经
 * 回了"会静默压掉第一次自动回复之后的每一次跟进。
 * 那一条由 `tests/unit/persona/intake.test.ts` 正反两面锁住。
 *
 * 这个 describe 现在只锁存储层的那一半：**本人回了之后草稿照样是 pending**。
 */
describe("待审草稿：本人已回过 → 草稿仍然保留（不再被作废）", () => {
  it("★ 本人回复之后，草稿仍然是 pending", () => {
    const { vault, messages, runs } = setup()
    messages.upsertMany([
      {
        id: "self-reply",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "msg-self",
        contentText: "在的",
        sentAt: NOW + 1000,
        direction: "outbound",
        isSelf: true,
        origin: "human",
        createdAt: NOW + 1000,
      },
    ])

    // ★ 草稿**照样在** —— 存储层没有任何东西会因为"本人回过"去动它
    expect(runs.pendingDrafts()).toHaveLength(1)
    const state = vault.db
      .prepare<[], { state: string }>("SELECT state FROM dh_drafts WHERE id = 'draft-1'")
      .get()?.state
    expect(state).toBe("pending")
    vault.close()
  })

  it("别人的后续消息同样不动草稿", () => {
    const { vault, messages, runs } = setup()
    messages.upsertMany([
      {
        id: "peer-followup",
        channelId: "dingtalk",
        conversationId: "conv-1",
        externalId: "msg-peer-2",
        contentText: "？",
        sentAt: NOW + 1000,
        direction: "inbound",
        isSelf: false,
        origin: "human",
        createdAt: NOW + 1000,
      },
    ])

    expect(runs.pendingDrafts()).toHaveLength(1)
    vault.close()
  })
})

/**
 * 待审草稿：每会话数量上限（取代按时效的自动过期，见 v18-draft-cap 迁移）。
 *
 * 核心不变量：超出 cap 的按 `created_at` **从旧到新**裁掉，保留最新的 cap 条；
 * 原因写 `over_draft_cap`；`keepIds` 里的那条即使最旧也不裁（发送中防竞态）。
 */
describe("待审草稿：每会话数量上限", () => {
  it("插 5 条 → cap=3 → 留最新 3 条，最旧 2 条 expired 且原因正确", () => {
    const { vault, runs } = setup()
    // setup 已有 draft-1（最旧，NOW+10）。再插 4 条更新的。
    seedDrafts(runs, "conv-1", ["draft-2", "draft-3", "draft-4", "draft-5"], NOW + 100)

    // 5 条 pending，cap=3 → 裁掉最旧的 2 条（draft-1, draft-2）。
    expect(runs.trimDraftsBeyondCap(3, NOW + 10_000)).toBe(2)

    const kept = runs
      .pendingDrafts()
      .map((d) => d.id)
      .sort()
    expect(kept).toEqual(["draft-3", "draft-4", "draft-5"])

    const trimmed = vault.db
      .prepare<
        [],
        { id: string; state: string; expired_reason: string | null }
      >("SELECT id, state, expired_reason FROM dh_drafts WHERE id IN ('draft-1','draft-2') ORDER BY id")
      .all()
    expect(trimmed).toEqual([
      { id: "draft-1", state: "expired", expired_reason: "over_draft_cap" },
      { id: "draft-2", state: "expired", expired_reason: "over_draft_cap" },
    ])
    vault.close()
  })

  it("★ keepIds 里的那条即使最旧也不被裁（发送中防竞态）", () => {
    const { vault, runs } = setup()
    // draft-1 是最旧的。再插 4 条更新的 → cap=3 时 draft-1 本应被裁。
    seedDrafts(runs, "conv-1", ["draft-2", "draft-3", "draft-4", "draft-5"], NOW + 100)

    // 把最旧的 draft-1 放进 keepIds：它不该被裁，于是被裁的是次旧的 draft-2。
    expect(runs.trimDraftsBeyondCap(3, NOW + 10_000, { keepIds: ["draft-1"] })).toBe(1)

    const state = vault.db
      .prepare<[], { state: string }>("SELECT state FROM dh_drafts WHERE id = 'draft-1'")
      .get()?.state
    expect(state).toBe("pending")

    const trimmed = vault.db
      .prepare<[], { state: string }>("SELECT state FROM dh_drafts WHERE id = 'draft-2'")
      .get()?.state
    expect(trimmed).toBe("expired")
    vault.close()
  })

  it("未超上限时不动（cap ≥ 会话内草稿数 → 0 条被裁）", () => {
    const { vault, runs } = setup()
    seedDrafts(runs, "conv-1", ["draft-2"], NOW + 100)
    // 2 条 pending，cap=3 → 不裁。
    expect(runs.trimDraftsBeyondCap(3, NOW + 10_000)).toBe(0)
    expect(runs.pendingDrafts()).toHaveLength(2)
    vault.close()
  })

  it("上限按会话分区（一个会话刷屏不挤掉另一个会话的草稿）", () => {
    const { vault, runs } = setup()
    new ConversationRepository(vault.db).upsert({
      id: "conv-2",
      channelId: "dingtalk",
      externalId: "cid-2",
      type: "group",
      title: "另一个会话",
      memberCount: 9,
      createdAt: NOW,
    })
    // conv-1：draft-1 + 3 条新的 = 4 条（超 cap=3，裁 1）。
    seedDrafts(runs, "conv-1", ["a2", "a3", "a4"], NOW + 100)
    // conv-2：只有 1 条（不该被 conv-1 的超额影响）。
    seedDrafts(runs, "conv-2", ["b1"], NOW + 100)

    expect(runs.trimDraftsBeyondCap(3, NOW + 10_000)).toBe(1)
    // conv-2 的那条原封不动。
    const b1 = vault.db
      .prepare<[], { state: string }>("SELECT state FROM dh_drafts WHERE id = 'b1'")
      .get()?.state
    expect(b1).toBe("pending")
    vault.close()
  })
})
