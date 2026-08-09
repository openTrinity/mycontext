/**
 * guard 的起草判定 —— **12 条降级逐条穷举**。
 *
 * ## 为什么这一组必须存在
 *
 * 这 12 条是从 `persona.py` 的 `decide_action` 搬进 TS 的
 * （见 `docs/persona-architecture.md` 第 5 节的搬迁清单）。搬错一条的表现
 * **不是报错**，而是"某一类问题突然开始自动回了" —— 而那是以本人身份发出去
 * 的、不可逆的社交后果。
 *
 * 两层覆盖，缺一不可：
 * · 这一组 —— 逐条、可穷举、跑得快；
 * · `scripts/check-gate-parity.mjs` —— 拿**真的** forge 产物验 TS 与 Python
 *   给出相同 verdict。单测用的是我们自己编的输入，而这类 bug 的成因恰恰是
 *   "编的形状与真实返回不一样"。
 *
 * ## ★ 每条都配一个**反面**
 *
 * 只验"命中时拦住"是不够的：一条恒返回 draft 的实现能让那些断言全绿。
 * 所以每条都要再验"不命中时**不**拦" —— 否则这一组测的是"它总是拦"，
 * 而不是"它按规则拦"。
 */
import { describe, expect, it } from "vitest"
import { evaluateGate, defaultGuardPolicy, type ForgeAdvice } from "@mycontext/persona"
import type { MessageClassification, RecipientTraits, TraitCoverage } from "@mycontext/persona"

/** 一切都放行的基线。每条用例只改动它关心的那一个字段。 */
const CLEAN_CLASSIFICATION: MessageClassification = {
  genuineAsk: true,
  chitchat: false,
  askKind: "status_chase",
  riskTags: [],
  riskDetectable: true,
  askKindDetectable: true,
}

/** band A = `low-risk allowed`，不是 manual-only。 */
const CLEAN_RECIPIENT: RecipientTraits = {
  resolved: true,
  toneBand: "A",
  sensitive: false,
}

const CLEAN_COVERAGE: TraitCoverage = {
  askKinds: true,
  riskTags: true,
  replyShapes: true,
  unavailable: null,
}

const ADVICE: ForgeAdvice = {
  byAskKind: { status_chase: "answer", decision_request: "answer", other_ask: "answer" },
  defaultAction: "draft",
  thinAskKinds: [],
  alwaysDraftKinds: [],
  bands: {
    A: { autoAnswer: "low-risk allowed" },
    C: { autoAnswer: "draft only" },
    S: { autoAnswer: "manual only" },
  },
}

function judge(
  patch: {
    classification?: Partial<MessageClassification>
    recipient?: Partial<RecipientTraits>
    coverage?: Partial<TraitCoverage>
    advice?: Partial<ForgeAdvice>
  } = {},
) {
  return evaluateGate({
    classification: { ...CLEAN_CLASSIFICATION, ...patch.classification },
    recipient: { ...CLEAN_RECIPIENT, ...patch.recipient },
    coverage: { ...CLEAN_COVERAGE, ...patch.coverage },
    advice: { ...ADVICE, ...patch.advice },
    policy: defaultGuardPolicy("auto"),
  })
}

describe("★ 基线：什么都不命中时真的放行", () => {
  /**
   * ★★ 这条是整组里最重要的一条。
   *
   * 没有它，一个恒返回 `draft` 的实现会让下面每一条断言都通过 ——
   * 于是这一组测的是"它总是拦"，而不是"它按规则拦"。
   */
  it("测量全干净 → reply（否则下面每条反面断言都是恒真的）", () => {
    const verdict = judge()
    expect(verdict.action).toBe("reply")
    // 没有任何降级 → decidingReason 为 null
    expect(verdict.decidingReason).toBeNull()
    // 分类记录仍然记着（它不是 downgrade）
    expect(verdict.because[0]).toContain("measured default")
  })
})

describe("★ 12 条降级：逐条 + 反面", () => {
  it("① rules.json 读不出来 → draft（fail closed）", () => {
    const verdict = judge({ coverage: { unavailable: "JSONDecodeError" } })
    expect(verdict.action).toBe("draft")
    expect(verdict.decidingReason).toContain("rules.json unusable")
  })

  it("② 判不了「在问什么」→ draft", () => {
    expect(judge({ classification: { askKindDetectable: false } }).action).toBe("draft")
  })

  it("③ 判不了「拍板还是转手」→ draft", () => {
    expect(judge({ coverage: { replyShapes: false } }).action).toBe("draft")
  })

  /**
   * ④ 这一条是**政策**搬迁的核心样本。
   *
   * forge 的 `signals.json` 把 `decision_request` 硬编码进 `alwaysDraftKinds`，
   * 而那与"这个人过去怎么聊天"无关 —— 它是一条企业策略。现在它在
   * `GuardPolicy.alwaysReviewAskKinds` 里，**取值不变**（所以行为不变）。
   */
  it("④ 被要求决策 → draft，即使测量说这类他 answer", () => {
    const verdict = judge({ classification: { askKind: "decision_request" } })
    expect(verdict.action).toBe("draft")
    expect(verdict.decidingReason).toContain("always the owner's call")
    // ★ 反面：测量表里它确实是 answer —— 拦它的是政策，不是测量
    expect(ADVICE.byAskKind["decision_request"]).toBe("answer")
  })

  it("④ 反面：不在名单里的问题类型不受这条影响", () => {
    expect(judge({ classification: { askKind: "status_chase" } }).action).toBe("reply")
  })

  it("⑤ 证据不足 → draft（保守档）", () => {
    const verdict = judge({ advice: { thinAskKinds: ["status_chase"] } })
    expect(verdict.action).toBe("draft")
    expect(verdict.decidingReason).toContain("too few examples")
  })

  it("⑤ 反面：政策配成 allow 时不因证据不足降级", () => {
    const verdict = evaluateGate({
      classification: CLEAN_CLASSIFICATION,
      recipient: CLEAN_RECIPIENT,
      coverage: CLEAN_COVERAGE,
      advice: { ...ADVICE, thinAskKinds: ["status_chase"] },
      policy: { ...defaultGuardPolicy("auto"), onInsufficientEvidence: "allow" },
    })
    expect(verdict.action).toBe("reply")
  })

  it("⑥ 命中风险类 → draft", () => {
    const verdict = judge({ classification: { riskTags: ["commitment"] } })
    expect(verdict.action).toBe("draft")
    expect(verdict.decidingReason).toContain("commitment")
  })

  /**
   * ⑥ 的一个细节：`sometimes_settles` 与 `never_settle` **动作相同、
   * reason 不同**。
   *
   * 一个本人**偶尔**会拍板的类别仍然不是 agent 可以替他拍板的类别 ——
   * 但"为什么拦我"这句话得说准。合成一句会让用户以为是同一回事。
   */
  it("⑥ sometimes_settles 仍然拦，但理由措辞不同", () => {
    const verdict = evaluateGate({
      classification: { ...CLEAN_CLASSIFICATION, riskTags: ["money"] },
      recipient: CLEAN_RECIPIENT,
      coverage: CLEAN_COVERAGE,
      advice: ADVICE,
      policy: {
        ...defaultGuardPolicy("auto"),
        riskClassPolicy: { money: "sometimes_settles" },
      },
    })
    expect(verdict.action).toBe("draft")
    expect(verdict.decidingReason).toContain("never by an agent")
  })

  /**
   * ⑦ ★★ 这是整组里最危险的**反向** bug。
   *
   * 没有风险词表时 `riskTags` 必然是空数组 —— 看起来像"没有风险"。
   * 把它当放行的话，一个没蒸出风险词表的 build 会**什么都自动回**，
   * 而外观与一切正常完全一样。
   */
  it("⑦ ★★ 没有风险词表 → draft（空 riskTags 不等于没风险）", () => {
    const verdict = judge({ classification: { riskDetectable: false, riskTags: [] } })
    expect(verdict.action).toBe("draft")
    expect(verdict.decidingReason).toContain("risk cannot be ruled out")
  })

  it("⑧ 纯客套且不是真在问事 → silent", () => {
    const verdict = judge({ classification: { chitchat: true, genuineAsk: false } })
    expect(verdict.action).toBe("silent")
    expect(verdict.decidingReason).toContain("acknowledgement")
  })

  it("⑧ 反面：客套但**同时**是真在问事 → 不 silent", () => {
    // "在忙吗？帮我看下这个" —— 客套开头，但确实在问
    expect(judge({ classification: { chitchat: true, genuineAsk: true } }).action).toBe("reply")
  })

  it("⑨ 收件人认不出 → draft", () => {
    const verdict = judge({ recipient: { resolved: false } })
    expect(verdict.action).toBe("draft")
    expect(verdict.decidingReason).toContain("not resolved")
  })

  it("⑩ 敏感岗位（HR/财务/法务/高管）→ draft", () => {
    expect(judge({ recipient: { sensitive: true } }).action).toBe("draft")
  })

  it("⑪ band S → draft", () => {
    const verdict = judge({ recipient: { toneBand: "S" } })
    expect(verdict.action).toBe("draft")
    expect(verdict.decidingReason).toContain("band S")
  })

  it("⑪ toneBand 为 null 时按 S 处理（最保守那一档）", () => {
    // 与 Python 侧 `person.get("toneBand") or "S"` 逐字一致
    expect(judge({ recipient: { toneBand: null } }).action).toBe("draft")
  })

  it("⑪ band 标了 manual-only → draft", () => {
    expect(judge({ recipient: { toneBand: "S" } }).action).toBe("draft")
  })

  /**
   * ⑪ 的一个**刻意保留的不一致**。
   *
   * band C 的 `autoAnswer` 是 `"draft only"`，而 Python 侧那个分支只比
   * `"manual only"` —— 所以 C 不会在这里被降级。看起来像疏漏，但改它
   * 就是改行为，而这一轮只搬不改。
   *
   * 锁住它是为了让"哪天有人想收紧"这件事**显式**发生（改这条测试 +
   * 加进 GuardPolicy），而不是顺手改一行然后没人知道行为变了。
   */
  it("⑪ ★ band C（draft only）**不**在这一条被降级 —— 与 Python 侧一致", () => {
    expect(judge({ recipient: { toneBand: "C" } }).action).toBe("reply")
  })

  /**
   * ⑫ **已删除**：`autonomy.scope === "draft_only"`。
   *
   * 那一条问的是"用户有没有授权自动发送"，而 host 侧由 `replyMode` 唯一
   * 表达。删掉它之后 `isScopeOnlyDowngrade()` 那个按英文原文匹配的补丁
   * 函数整个消失。
   */
  it("⑫ ★ scope 那条降级在 TS 侧不存在（授权由 replyMode 唯一表达）", () => {
    // 政策里没有任何 scope 字段，所以"授权"根本不参与起草判定
    const verdict = judge()
    expect(verdict.action).toBe("reply")
    expect(verdict.because.join(" ")).not.toContain("autonomy scope")
  })
})

describe("★ rank 表：只能收紧，不能放宽", () => {
  /**
   * ★★ 这条不变量比任何一条具体规则都重要。
   *
   * 缺了它，一条宽松的规则会**撤销**前面所有严格的判定 —— 而那正是
   * "某一类问题突然开始自动回了"的成因。
   */
  it("silent 之后再来一条 draft 不能把它放宽回 draft", () => {
    // 纯客套（→ silent）+ 收件人认不出（→ draft）：silent 的 rank 更高
    const verdict = judge({
      classification: { chitchat: true, genuineAsk: false },
      recipient: { resolved: false },
    })
    expect(verdict.action).toBe("silent")
  })

  it("多条降级同时命中 → because 记全部，decidingReason 只记决定性的那条", () => {
    const verdict = judge({
      classification: { riskTags: ["commitment"], riskDetectable: false },
      recipient: { sensitive: true, toneBand: "S" },
    })
    expect(verdict.action).toBe("draft")
    // ★ 全部列出：用户改完一条发现还是出草稿会觉得我们在骗他
    expect(verdict.because.length).toBeGreaterThan(3)
    // ★ 而 decidingReason 不是 because[0]（那永远是分类记录）
    expect(verdict.decidingReason).not.toContain("measured default")
  })
})

describe("★ 分类记录不是降级理由", () => {
  /**
   * `because[0]` 永远是 "measured default for `X` is answer" —— 它记的是
   * "我们量出这类问题的默认动作是啥"，不是"为什么拦住了这一条"。
   *
   * 拿它当原因给用户看会得到一句自相矛盾的话：草稿卡上写着「默认动作是
   * answer」，而这条恰恰没有 answer。实测踩到过。
   */
  it("askKind 不在测量表里 → 记「不在表里」而不是一个编的默认值", () => {
    const verdict = judge({ classification: { askKind: "never_seen_kind" } })
    expect(verdict.because[0]).toContain("not in the measured table")
    // 表里没有 → 用 defaultAction（draft），也就是安全的那一侧
    expect(verdict.action).toBe("draft")
  })
})

describe("★★ 产物发布的名单只能让政策更严，不能更松", () => {
  /**
   * host 的 `alwaysReviewAskKinds` 是**下界**。产物发布一份更长的名单时，
   * 多出来的类型也要拦 —— 忽略它们的方向是危险的那一侧。
   *
   * 反过来（产物名单更短）不能放宽 host 的政策：那会让这条政策又回到
   * forge 手里，而这次重构要消除的正是那个。
   */
  it("★ 产物名单里多出来的类型也拦（取并集）", () => {
    const verdict = judge({
      classification: { askKind: "status_chase" },
      // 产物说这个环境下 status_chase 也永远该人工
      advice: { alwaysDraftKinds: ["status_chase"] },
    })
    expect(verdict.action).toBe("draft")
    expect(verdict.decidingReason).toContain("always the owner's call")
  })

  it("★ 反面：产物名单为空**不能**放宽 host 的政策", () => {
    const verdict = judge({
      classification: { askKind: "decision_request" },
      advice: { alwaysDraftKinds: [] },
    })
    // host 的 DEFAULT_ALWAYS_REVIEW_ASK_KINDS 仍然拦住它
    expect(verdict.action).toBe("draft")
  })
})
