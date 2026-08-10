/**
 * 蒸馏准入守卫。
 *
 * 三条 guard 各防一种**不可逆**的画像污染 —— 污染后的结论会作为
 * 下一轮的基线继续放大，而这个过程没有任何一刻会"报错"。
 */
import { describe, expect, it } from "vitest"
import {
  assertDeidentified,
  assertDistillable,
  assertHasEvidence,
  assertSelfAttributed,
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

/**
 * ★★ 脱敏：结论正文里不许出现真实姓名/商标/内部系统名。
 *
 * ## 为什么需要**第二道**防线
 *
 * `SYSTEM_PROMPT` 第 8 条已经要求脱敏。而实测第一版跑出的 59 条结论里
 * **有 5 条**带着不该出现的内容：一位同事的真实花名（原话引用
 * 「我明天让某某看下」）、内部监控系统名、两个第三方产品名、渠道 CLI 命令。
 *
 * 模型会漏。而这一层的产物（`work.md`）进 agent 的 skill 包，而 skill 包
 * **会被导出、分享、进 git** —— 一旦进去就不可撤回（fork/镜像/CI 日志都留存）。
 * 所以两道：prompt 让绝大多数一次做对，守卫兜住剩下的。
 */
describe("★★ assertDeidentified", () => {
  const candidate = (value: unknown): FacetCandidate => ({
    facet: "workflow",
    scope: "global",
    scopeRef: "",
    key: "k",
    value,
    confidence: 0.8,
    evidence: ["m1"],
    source: "llm",
  })

  it("★★ 正文里有真实姓名 → 拦下", () => {
    const verdict = assertDeidentified(candidate("明天让小王看下这个 bug"), {
      forbidden: ["小王"],
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.hits).toContain("小王")
  })

  it("脱敏过的同一条结论 → 放行（换名字，留行为）", () => {
    /**
     * ★ 这条与上一条是一对：要守的性质是"换掉名字就该过"，而不是
     * "含人名的结论整条丢掉"。行为本身（指定负责人次日跟进）有价值。
     */
    const verdict = assertDeidentified(candidate("明天让对应负责人看下这个 bug"), {
      forbidden: ["小王"],
    })
    expect(verdict.ok).toBe(true)
  })

  /**
   * ★★ `tasks` 的 value 是**对象**，人名最可能藏在 `from` 里
   * （「谁提出的」）。只查 `task` 字段会漏掉它 —— 而那恰好是最危险的字段。
   */
  it("★★ 对象型 value 的每个字段都查（不只查 task）", () => {
    const verdict = assertDeidentified(
      candidate({ task: "review 代码", from: "小王", askKind: "help_request" }),
      { forbidden: ["小王"] },
    )
    expect(verdict.ok, "from 字段里的人名被漏掉了").toBe(false)
  })

  it("大小写不敏感（商标名常见混写）", () => {
    expect(assertDeidentified(candidate("用 FooBar 打包"), { forbidden: ["foobar"] }).ok).toBe(
      false,
    )
  })

  it("空名单 → 放行（不给名单 = 不检查，那时唯一防线是 prompt）", () => {
    expect(assertDeidentified(candidate("任何内容"), { forbidden: [] }).ok).toBe(true)
  })

  /**
   * ★ 命中的字面量返回给调用方，但**不该进日志** —— 那就是真实姓名，
   * 进日志等于换个地方泄漏。调用方只报个数（见 runner 的 `droppedNotDeidentified`）。
   */
  it("★ 返回命中项供调用方计数（但调用方只报个数，不报内容）", () => {
    const verdict = assertDeidentified(candidate("小王和小李都说了"), {
      forbidden: ["小王", "小李", "小张"],
    })
    expect(verdict.hits).toHaveLength(2)
  })
})

/**
 * ★★ 归因守卫：结论必须由**本人的话**支撑。
 *
 * ## 这一组锁的是实测到的一次画像污染
 *
 * 按 `evidence_json` 回查每条证据的 `is_self`（本机库 33924 条消息 / 273 条结论）：
 *
 * ```
 * tasks: 本人 154 / 他人 61      role: 本人 151 / 他人 16
 * ```
 *
 * 后果在产物里直接可见 —— `role` 一节同时出现两个互相矛盾的人
 * （「前端开发，负责页面渲染」与「不负责前端开发实现」），且他/她混用。
 * 那是把群里另一个人的职责写进了本人画像。
 *
 * `SYSTEM_PROMPT` 第 1 条已经写了「只描述标注为「我」的那个人」而压不住，
 * 所以这件事必须落在**落库前**的判据上。
 */
describe("★★ assertSelfAttributed（归因）", () => {
  const selfOnly = { m_self: true, m_other: false, d1: null } as const
  const authorship = new Map<string, boolean | null>(Object.entries(selfOnly))

  function withEvidence(facet: string, evidence: string[]): FacetCandidate {
    return {
      facet,
      scope: "global",
      scopeRef: "",
      key: "k",
      value: "某条结论",
      confidence: 0.8,
      evidence,
      source: "llm",
    }
  }

  it("★★ role/workflow/artifacts/knowhow：混入他人证据 → 拒", () => {
    /**
     * 那四个问的是「**他**怎么做」，一条别人说的话不足以证明他的做法。
     */
    for (const facet of ["role", "workflow", "artifacts", "knowhow"]) {
      const verdict = assertSelfAttributed(withEvidence(facet, ["m_self", "m_other"]), authorship)
      expect(verdict.ok, `${facet} 放过了他人证据`).toBe(false)
      expect(verdict.ok === false && verdict.reason).toBe("foreign_evidence")
    }
  })

  it("★ tasks：允许他人证据（触发句本来就是别人说的），但要有本人的回应", () => {
    expect(assertSelfAttributed(withEvidence("tasks", ["m_self", "m_other"]), authorship).ok).toBe(
      true,
    )
  })

  it("★★ 一条本人证据都没有 → 拒（不分 facet）", () => {
    const verdict = assertSelfAttributed(withEvidence("tasks", ["m_other"]), authorship)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toBe("no_self_evidence")
  })

  it("★★ 引用了这一批语料里没有的 id → 拒", () => {
    /**
     * 与 `resolveEvidence` 只校验序号范围是互补的：那一道保证序号落在批次内，
     * 这一道保证映射回的 id 真的在喂给模型的那批语料里。
     */
    const verdict = assertSelfAttributed(withEvidence("tasks", ["m_self", "0mp0编的"]), authorship)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toBe("unknown_evidence")
  })

  it("★ 文档（作者未知）不能单独支撑结论，但也不算「编造的 id」", () => {
    /**
     * 文档没有可用的作者字段（见 `work-corpus.ts`），所以它只能作为环境背景。
     * 单靠它 → `no_self_evidence`（而不是 `unknown_evidence`）。
     */
    const verdict = assertSelfAttributed(withEvidence("role", ["d1"]), authorship)
    expect(verdict.ok === false && verdict.reason).toBe("no_self_evidence")
  })

  it("空归因表 → 放行（调用方没给语料就无从判断；生产路径一定会给）", () => {
    expect(assertSelfAttributed(withEvidence("role", ["whatever"]), new Map()).ok).toBe(true)
  })
})
