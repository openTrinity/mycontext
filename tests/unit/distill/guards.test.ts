/**
 * 蒸馏准入守卫。
 *
 * 三条 guard 各防一种**不可逆**的画像污染 —— 污染后的结论会作为
 * 下一轮的基线继续放大，而这个过程没有任何一刻会"报错"。
 */
import { describe, expect, it } from "vitest"
import {
  assertDistillable,
  assertHasEvidence,
  filterDistillable,
  normalizeScopeRef,
  type FacetCandidate,
} from "@mycontext/distill"
import type { ConversationRow, MessageRow } from "@mycontext/store"
import { isAppError } from "@mycontext/kernel"

const NOW = 1_785_000_000_000

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "m-1",
    channelId: "dingtalk",
    conversationId: "conv-1",
    externalId: "ext-1",
    senderActorId: null,
    senderExternalId: "DeMINE",
    senderDisplayName: "小周",
    contentText: "沙箱环境部署完成了",
    contentJson: null,
    quotedExternalId: null,
    threadId: null,
    sentAt: NOW,
    direction: "outbound",
    isSelf: true,
    origin: "human",
    hasMedia: false,
    rawRecordId: null,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  }
}

function conversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conv-1",
    channelId: "dingtalk",
    externalId: "cid-1",
    type: "group",
    title: "沙箱项目群",
    memberCount: 12,
    isSelfInvolved: true,
    isBotChannel: false,
    lastMessageAt: NOW,
    createdAt: NOW,
    ...overrides,
  }
}

describe("三条 guard", () => {
  it("正常的本人消息通过", () => {
    expect(assertDistillable(message(), conversation())).toEqual({ ok: true })
  })

  /**
   * ★ is_self = null 表示"还没判定"，此时把它当成任一边都是猜。
   * 猜"不是本人"会永久丢失人格语料（之后没有信号能纠回来）。
   */
  it("身份未判定（is_self=null）拒绝", () => {
    expect(assertDistillable(message({ isSelf: null }), conversation())).toEqual({
      ok: false,
      reason: "identity_unconfirmed",
    })
  })

  /**
   * ★ 数字人自产消息永久排除：auto 模式下自动回复量大，
   * 不排除的话画像会在几轮内坍缩到模型自己的口吻（自我强化漂移）。
   */
  it("origin='agent' 拒绝（防自我强化漂移）", () => {
    expect(assertDistillable(message({ origin: "agent" }), conversation())).toEqual({
      ok: false,
      reason: "self_generated",
    })
  })

  /**
   * ★ 机器人群会严重污染 routines（活跃时段被告警拉平）
   * 与 expertise（运维术语被当成本人的专业领域）。
   */
  it("机器人/告警群拒绝", () => {
    expect(assertDistillable(message(), conversation({ isBotChannel: true }))).toEqual({
      ok: false,
      reason: "bot_channel",
    })
  })

  it("空内容拒绝（没什么可蒸馏的）", () => {
    for (const text of [null, "", "   ", "\n\t"]) {
      expect(assertDistillable(message({ contentText: text }), conversation()).ok).toBe(false)
    }
  })

  it("用户关掉该会话的蒸馏时拒绝", () => {
    expect(assertDistillable(message(), conversation(), { distillEnabled: false })).toEqual({
      ok: false,
      reason: "distill_disabled",
    })
  })

  it("他人消息也可进蒸馏（用于学「对这些人怎么说话」）", () => {
    // is_self=false 是**已判定**的他人消息 —— 它是关系与语境的语料，
    // 与 is_self=null（未判定）完全不同。
    expect(assertDistillable(message({ isSelf: false }), conversation())).toEqual({ ok: true })
  })
})

describe("批量过滤与计数", () => {
  it("返回被拒的分类计数（进度页要显示「跳过了多少、为什么」）", () => {
    const conversations = new Map([
      ["conv-1", conversation()],
      ["conv-bot", conversation({ id: "conv-bot", isBotChannel: true })],
    ])
    const result = filterDistillable(
      [
        message({ id: "ok-1" }),
        message({ id: "unjudged", isSelf: null }),
        message({ id: "agent", origin: "agent" }),
        message({ id: "bot", conversationId: "conv-bot" }),
        message({ id: "empty", contentText: "" }),
      ],
      conversations,
    )

    expect(result.accepted.map((m) => m.id)).toEqual(["ok-1"])
    expect(result.rejected).toEqual({
      identity_unconfirmed: 1,
      self_generated: 1,
      bot_channel: 1,
      empty_content: 1,
      distill_disabled: 0,
    })
  })

  it("会话查不到的消息被跳过（不崩）", () => {
    const result = filterDistillable([message({ conversationId: "missing" })], new Map())
    expect(result.accepted).toEqual([])
  })

  it("按会话的蒸馏开关生效", () => {
    const result = filterDistillable([message()], new Map([["conv-1", conversation()]]), {
      distillEnabledByConversation: new Map([["conv-1", false]]),
    })
    expect(result.rejected.distill_disabled).toBe(1)
  })
})

describe("★ 无证据的结论一律拒绝", () => {
  const candidate = (evidence: string[]): FacetCandidate => ({
    facet: "tone",
    scope: "global",
    scopeRef: "",
    key: "catchphrases",
    value: ["收到"],
    confidence: 0.8,
    evidence,
    source: "llm",
  })

  it("有证据时通过", () => {
    expect(() => assertHasEvidence(candidate(["m-1", "m-2"]))).not.toThrow()
  })

  /**
   * 这是可信度与可审计的**底线，不是可配置项**：
   * 允许无证据的结论进来，等于允许模型往画像里写它想出来的东西。
   */
  it("空证据抛 DISTILL_NO_EVIDENCE", () => {
    try {
      assertHasEvidence(candidate([]))
      expect.unreachable("应当抛错")
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) expect(error.code).toBe("DISTILL_NO_EVIDENCE")
    }
  })
})

describe("scopeRef 规范化（防唯一键失效）", () => {
  it("global 一律空串", () => {
    expect(normalizeScopeRef("global", null)).toBe("")
    expect(normalizeScopeRef("global", "ignored")).toBe("")
  })

  it("conversation / contact 必须有值", () => {
    expect(normalizeScopeRef("conversation", "conv-1")).toBe("conv-1")
    expect(() => normalizeScopeRef("conversation", null)).toThrow()
    expect(() => normalizeScopeRef("contact", "")).toThrow()
  })
})
