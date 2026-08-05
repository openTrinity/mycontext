/**
 * 场景判定的门禁。
 *
 * ## ★ 这一组锁的是"能不能以本人身份自动发出去"
 *
 * 它替掉了两个写死的假值（`sceneAllowsAuto: false` + `risk: "medium"`），
 * 所以它现在是**真正决定自动发送与否**的那一层。断言必须逐条覆盖，
 * 而且要覆盖"放行"这一侧 —— 只测"拦住"的话，一个恒返回 false 的实现
 * 也能全绿，而那等于自动发送从未生效（与首版一样）。
 *
 * ## 为什么不测"某句话具体是什么风险"
 *
 * 那是措辞判断，会随语料漂移。这里测的是**规则的结构性质**：
 * 白名单式（默认拒）、全过才放行、失败原因全列不短路、
 * risk 与 allowsAuto 同源。
 */
import { describe, expect, it } from "vitest"
import { evaluateScene, riskFromScene, MAX_AUTO_LENGTH, SCENE_RULES } from "@mycontext/persona"
import type { SceneInput } from "@mycontext/persona"

/** 一个**全部规则都过**的基线：单聊、短、无疑问、无承诺。 */
function baseline(overrides: Partial<SceneInput> = {}): SceneInput {
  return {
    conversationKind: "direct",
    mentionsSelf: false,
    draftText: "收到",
    ...overrides,
  }
}

describe("★ 场景判定：全过才放行（白名单式）", () => {
  it("基线（单聊 + 短 + 无疑问无承诺）→ 允许自动发", () => {
    const verdict = evaluateScene(baseline())
    /**
     * ★ 这一条是整组里最重要的。
     *
     * 没有它的话，一个 `return { allowsAuto: false, ... }` 的实现能让
     * 其余所有断言通过 —— 而那正是首版的行为（恒 false）。
     * 也就是说：缺了这条断言，"接了场景判定"与"没接"无法区分。
     */
    expect(verdict.allowsAuto).toBe(true)
    expect(verdict.failedRules).toEqual([])
  })

  it("群聊里没 @我 → 拒（在一屋子人面前替本人发言，风险不对称）", () => {
    const verdict = evaluateScene(baseline({ conversationKind: "group", mentionsSelf: false }))
    expect(verdict.allowsAuto).toBe(false)
    expect(verdict.failedRules).toContain("is_direct_or_mentioned")
  })

  it("群聊里 @我 了 → 放行（成本闸的同一条判据）", () => {
    const verdict = evaluateScene(baseline({ conversationKind: "group", mentionsSelf: true }))
    expect(verdict.allowsAuto).toBe(true)
  })

  it("单聊不要求 @我（钉钉单聊通常 @不了人，要求它等于永不自动发）", () => {
    const verdict = evaluateScene(baseline({ conversationKind: "direct", mentionsSelf: false }))
    expect(verdict.failedRules).not.toContain("is_direct_or_mentioned")
  })
})

describe("★ 疑问句不自动发（它把球踢回去，或替本人向别人要承诺）", () => {
  /**
   * ★ 全角问号单独测。
   *
   * 中文输入法默认出全角 `？`，只判半角会让这一整类漏过去 ——
   * 而实测语料里全角占绝大多数。这是那种"看起来判了、实际半数没判"的漏洞。
   */
  it.each([
    ["半角问号", "这样可以吗?"],
    ["全角问号", "这样行？"],
    ["行吗", "明天上线行吗"],
    ["什么时候", "什么时候能好"],
    ["要不要", "要不要我改一下"],
    ["你觉得", "你觉得这样合适"],
  ])("%s → 拒", (_label, text) => {
    const verdict = evaluateScene(baseline({ draftText: text }))
    expect(verdict.allowsAuto).toBe(false)
    expect(verdict.failedRules).toContain("no_question")
  })

  it("陈述句不受影响（否则这条规则会把正常回复全拦掉）", () => {
    expect(evaluateScene(baseline({ draftText: "已经上线了" })).allowsAuto).toBe(true)
  })
})

describe("★ 承诺不自动发（它替本人产生了别人会依赖的义务）", () => {
  it.each([
    ["我来", "我来处理"],
    ["我负责", "这块我负责"],
    ["明天给", "明天给你"],
    ["没问题", "没问题"],
    ["一定", "一定按时"],
    ["保证", "保证不出错"],
  ])("%s → 拒", (_label, text) => {
    const verdict = evaluateScene(baseline({ draftText: text }))
    expect(verdict.allowsAuto).toBe(false)
    expect(verdict.failedRules).toContain("no_commitment")
  })

  /**
   * 「没问题」读起来像客套，实际是对一个请求的应允 —— 发出去之后
   * 对方就真的在等了，而本人可能根本不知道这条消息存在过。
   */
  it("「没问题」也算承诺（它读起来像客套，实际是应允）", () => {
    expect(evaluateScene(baseline({ draftText: "没问题" })).failedRules).toContain("no_commitment")
  })
})

describe("★ 长度与空正文", () => {
  it(`超过 ${String(MAX_AUTO_LENGTH)} 字 → 拒（长回复更像"替本人做决定"）`, () => {
    const long = "好".repeat(MAX_AUTO_LENGTH + 1)
    const verdict = evaluateScene(baseline({ draftText: long }))
    expect(verdict.allowsAuto).toBe(false)
    expect(verdict.failedRules).toContain("within_length")
  })

  it("正好等于上限 → 放行（边界是含的）", () => {
    const exact = "好".repeat(MAX_AUTO_LENGTH)
    expect(evaluateScene(baseline({ draftText: exact })).allowsAuto).toBe(true)
  })

  /**
   * 长度按**码点**数而不是 `.length`：emoji 是代理对，
   * 用 `.length` 会让一条 30 个 emoji 的消息算成 60 字被拦掉。
   */
  it("emoji 按码点算（.length 会把代理对算成两个字符）", () => {
    const emoji = "🙂".repeat(MAX_AUTO_LENGTH)
    expect(evaluateScene(baseline({ draftText: emoji })).allowsAuto).toBe(true)
  })

  it("空正文 → 拒（发一条空消息比不发更糟）", () => {
    expect(evaluateScene(baseline({ draftText: "   " })).failedRules).toContain("within_length")
  })
})

describe("★ 占位与拒答文案不自动发", () => {
  /**
   * `extractDraft` 在模型把思考过程当正文返回时会替换成这句占位。
   * 那句话的语义就是"需要人看一眼"—— 自动发出去等于反着执行它。
   */
  it("extractDraft 的占位句 → 拒", () => {
    const verdict = evaluateScene(baseline({ draftText: "（这条需要人工确认后回复）" }))
    expect(verdict.allowsAuto).toBe(false)
    expect(verdict.failedRules).toContain("no_placeholder")
  })

  it.each(["抱歉，我无法回答这个", "作为一个AI助手我不能", "我是一个语言模型"])(
    "模型自述 %s → 拒",
    (text) => {
      expect(evaluateScene(baseline({ draftText: text })).allowsAuto).toBe(false)
    },
  )
})

describe("★ 失败原因全列，不短路（与 policy 的 failedConditions 同理）", () => {
  it("同时犯三条 → 三条都报出来", () => {
    const verdict = evaluateScene({
      conversationKind: "group",
      mentionsSelf: false,
      // 又长、又是疑问、又有承诺
      draftText: "我来处理这件事，你觉得这样可以吗" + "好".repeat(MAX_AUTO_LENGTH),
    })
    expect(verdict.failedRules).toContain("is_direct_or_mentioned")
    expect(verdict.failedRules).toContain("no_question")
    expect(verdict.failedRules).toContain("no_commitment")
    expect(verdict.failedRules).toContain("within_length")
    /**
     * 只给第一个的话用户会"改一次、还是不发、再改一次"——
     * 而这个字段存在的全部理由就是避免那个循环。
     */
    expect(verdict.failedRules.length).toBeGreaterThanOrEqual(4)
  })

  it("每条规则都能被单独触发（没有死规则）", () => {
    /**
     * ★ 反向覆盖：确认 `SCENE_RULES` 里每一条都真的会被某个输入触发。
     *
     * 死规则（列在常量里但代码从不 push 它）是这类判定最容易出现的问题 ——
     * 它让"五道闸"看起来比实际严格。这一条就是原本的
     * `no_recent_recall` 被删掉的原因：`recalled_at` 列根本不存在，
     * 那条规则的输入恒为 0、恒通过。
     */
    const triggered = new Set<string>()
    const cases: SceneInput[] = [
      baseline({ conversationKind: "group", mentionsSelf: false }),
      baseline({ draftText: "行吗" }),
      baseline({ draftText: "我来" }),
      baseline({ draftText: "" }),
      baseline({ draftText: "（这条需要人工确认后回复）" }),
    ]
    for (const input of cases) {
      for (const rule of evaluateScene(input).failedRules) triggered.add(rule)
    }
    for (const rule of SCENE_RULES) {
      expect(triggered.has(rule), `规则 ${rule} 没有任何输入能触发它 —— 死规则`).toBe(true)
    }
  })
})

describe("★ risk 与 allowsAuto 同源（不会自相矛盾）", () => {
  it("全过 → low", () => {
    expect(riskFromScene(evaluateScene(baseline()))).toBe("low")
  })

  it("只差「非 @我」→ medium（形式问题，不是内容危险）", () => {
    const verdict = evaluateScene(baseline({ conversationKind: "group", mentionsSelf: false }))
    expect(riskFromScene(verdict)).toBe("medium")
  })

  it("只差长度 → medium", () => {
    const verdict = evaluateScene(baseline({ draftText: "好".repeat(MAX_AUTO_LENGTH + 1) }))
    expect(riskFromScene(verdict)).toBe("medium")
  })

  it("命中承诺 → high（内容层面的危险信号）", () => {
    expect(riskFromScene(evaluateScene(baseline({ draftText: "我来处理" })))).toBe("high")
  })

  it("命中疑问 → high", () => {
    expect(riskFromScene(evaluateScene(baseline({ draftText: "行吗" })))).toBe("high")
  })

  /**
   * ★ 不允许出现「场景说能发、风险说不是 low」这种组合。
   *
   * 那种矛盾会让 policy 的两条判定互相打架，而且没人能解释为什么。
   * 同源派生（`riskFromScene` 只读 verdict）在结构上排除了它，
   * 这条断言锁住那个结构。
   */
  it("allowsAuto 为 true 时 risk 必然是 low", () => {
    const inputs: SceneInput[] = [
      baseline(),
      baseline({ conversationKind: "group", mentionsSelf: true }),
      baseline({ draftText: "已经上线了" }),
      baseline({ draftText: "好".repeat(MAX_AUTO_LENGTH) }),
    ]
    for (const input of inputs) {
      const verdict = evaluateScene(input)
      if (verdict.allowsAuto) expect(riskFromScene(verdict)).toBe("low")
    }
  })
})
