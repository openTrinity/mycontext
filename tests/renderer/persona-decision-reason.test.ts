/**
 * `decision_reason` → 人话 + 下一步动作的门禁。
 *
 * ## 为什么这个映射需要门禁
 *
 * 用户开了自动回复却总在出草稿时，界面上唯一能解释"为什么"的就是这段文案。
 * 而它坏掉的方式是**静默**的：
 *
 * · policy 那边加了一条 reason，这里没补 → 界面显示一个原样的英文标识符；
 * · 补了映射但没补语言包 → 界面显示 `reasons.xxx` 这样一串 key；
 * · 把 `not-built` 标成 `actionable` → 界面让用户去改一个不存在的开关。
 *
 * 三种都不会报错，也都不会让别的测试变红。
 *
 * ## ★ 第三条是这里最要紧的
 *
 * `low_confidence` / `risk_not_low` 是**产品刻意没做**（我们不采信模型
 * 自评，见 `UNEVALUATED_CONFIDENCE`）。给它们配"下一步动作"等于让用户
 * 去找一个不存在的入口 —— 那比不告诉他更糟：他会以为是自己没找到。
 *
 * 反过来同样要锁：`grant_missing` / `grant_expired` 的入口**已经做了**
 * （设置页的「申请授权」），继续标 not-built 会让用户不去点那个按钮，
 * 于是自动发送永远差这一条而没有任何东西说差的是它。
 */
import { describe, expect, it } from "vitest"
import { DECISION_REASONS, type DecisionReason } from "@mycontext/persona"
import { LANGUAGES, resources } from "@mycontext/i18n"
import {
  DECISION_REASON_INFO,
  DROP_REASON_KEYS,
  explainDecisionReason,
} from "@renderer/features/persona/decision-reason"

/** 按 `a.b.c` 取语言包里的值；取不到返回 undefined。 */
function lookup(lang: (typeof LANGUAGES)[number], key: string): string | undefined {
  let node: unknown = resources[lang].persona
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === "string" ? node : undefined
}

/**
 * 产品还没做的那些 reason。
 *
 * 写死在测试里而不是从被测代码读 —— 从被测代码读的话
 * "把 grant_missing 改成 actionable" 会让测试跟着改，等于没锁。
 * 这份清单变化时应该是**人**来改它（那时正好复审一遍是不是真做完了）。
 *
 * ## 这一轮从五条减到两条，逐条说清为什么
 *
 * · `grant_missing` / `grant_expired` → **actionable**：授权入口做好了
 *   （设置页「申请授权」→ `requestGrant` → `dh_send_grants`），用户点一下
 *   就能解决。留成 not-built 的代价是他根本不会去点。
 * · `scene_disallows_auto` → **by-design**：`evaluateScene` 的五条是真判定
 *   （群里必须 @我、不许有问号、不许含承诺、≤60 字、不许是占位文案）。
 *   它不是"功能缺失"，而是"这条草稿本身不适合自动发"——那两件事的处置
 *   完全不同（一个是等我们修，一个是他看一眼就能发）。
 *
 * 剩下这两条仍然是 not-built，但理由是**刻意不做**而不是来不及做：
 * 我们不采信模型自评（`UNEVALUATED_CONFIDENCE` 的注释写明了为什么），
 * 所以它们现在基本到不了 —— 真到了说明有人接了自评，那时该复审这份清单。
 */
const NOT_BUILT: readonly DecisionReason[] = ["low_confidence", "risk_not_low"]

describe("★ 每条 reason 都有文案（漏一条 = 界面上显示原样标识符）", () => {
  it("policy 的 DECISION_REASONS 与映射表的 key 完全一致", () => {
    /**
     * 双向比较：policy 加了这里没补是"显示标识符"，
     * 这里多了一条是"policy 里已经删了的死代码"（会误导下一个读的人）。
     */
    expect(Object.keys(DECISION_REASON_INFO).sort()).toEqual([...DECISION_REASONS].sort())
  })

  it.each(LANGUAGES)("%s：每条 reason 的 labelKey 在语言包里有非空文案", (lang) => {
    const missing = DECISION_REASONS.filter((reason) => {
      const text = lookup(lang, DECISION_REASON_INFO[reason].labelKey)
      return text === undefined || text.trim() === ""
    })
    expect(missing).toEqual([])
  })

  it.each(LANGUAGES)("%s：每个 actionKey 也有非空文案", (lang) => {
    const missing = DECISION_REASONS.filter((reason) => {
      const key = DECISION_REASON_INFO[reason].actionKey
      if (key === undefined) return false
      const text = lookup(lang, key)
      return text === undefined || text.trim() === ""
    })
    expect(missing).toEqual([])
  })

  it.each(LANGUAGES)("%s：三种 kind 都有标签文案（Tag 上要显示它）", (lang) => {
    for (const kind of ["actionable", "not-built", "by-design"]) {
      expect(lookup(lang, `reasonKind.${kind}`)?.trim()).toBeTruthy()
    }
  })
})

describe("★ 分类正确：不能让用户去改一个改不了的东西", () => {
  it.each(NOT_BUILT)("%s 标成 not-built，且不给下一步动作", (reason) => {
    const info = DECISION_REASON_INFO[reason]
    expect(info.kind).toBe("not-built")
    /**
     * 这是这个文件里最重要的一条断言。
     *
     * 给一个"产品还没做"的原因配上"去改设置"的按钮 —— 用户点进去
     * 找不到那个开关，然后会认为是自己的问题。
     */
    expect(info.actionKey).toBeUndefined()
  })

  it("★ 每个 actionable 都必须有下一步动作（否则等于只说了句风凉话）", () => {
    const actionable = DECISION_REASONS.filter(
      (reason) => DECISION_REASON_INFO[reason].kind === "actionable",
    )
    // 反面保护：不能靠"没有 actionable"来通过
    expect(actionable.length).toBeGreaterThan(0)
    expect(
      actionable.filter((reason) => DECISION_REASON_INFO[reason].actionKey === undefined),
    ).toEqual([])
  })

  it("用户自己选的那两个是 by-design，不是「被拦住」", () => {
    // mode_not_auto 与 dry_run 都不是问题 —— 用不同的颜色，也不给动作
    expect(DECISION_REASON_INFO.mode_not_auto.kind).toBe("by-design")
    expect(DECISION_REASON_INFO.dry_run.kind).toBe("by-design")
  })

  it("★ 频率上限是 actionable 的 —— 它是 8 条里唯一防「群里连发」的那条", () => {
    /**
     * `rate_limited` 必须能改：真触到上限时用户的诉求是"我知道，放宽点"，
     * 而不是"等着"。标成 not-built 会让他没有出路。
     */
    expect(DECISION_REASON_INFO.rate_limited).toMatchObject({
      kind: "actionable",
      actionKey: "reasons.actions.editRateLimit",
    })
  })

  /**
   * ★ 授权那两条**必须**是 actionable，而且必须给同一个动作。
   *
   * 这是 `NOT_BUILT` 那条断言的反面，单独锁一次：入口已经做好了
   * （设置页「申请授权」），标回 not-built 的话用户不会去点它 ——
   * 于是自动发送永远差这一条，而界面上写着"功能还没做"。
   * 那是这个项目里最贵的一类错误：功能在，用户以为不在。
   */
  it("★ 授权缺失/过期是 actionable，且指向同一个「去申请授权」", () => {
    for (const reason of ["grant_missing", "grant_expired"] as const) {
      expect(DECISION_REASON_INFO[reason]).toMatchObject({
        kind: "actionable",
        actionKey: "reasons.actions.requestGrant",
      })
    }
  })

  /**
   * ★ 场景判定是 by-design，不是 not-built，也不是 actionable。
   *
   * 三档的区别在这一条上最容易搞错：`evaluateScene` 的五条是真判定，
   * 所以不是"功能没做"；但用户也**没有开关可改**（那五条是安全底线，
   * 不该可配）—— 标成 actionable 会让他去找一个我们刻意不提供的入口。
   * 正确的信息是"这条草稿本身不适合自动发，你看一眼就能发"。
   */
  it("★ 场景不允许自动发是 by-design，且不给下一步动作", () => {
    expect(DECISION_REASON_INFO.scene_disallows_auto.kind).toBe("by-design")
    expect(DECISION_REASON_INFO.scene_disallows_auto.actionKey).toBeUndefined()
  })

  /**
   * ★ 判定层说该本人拍板 —— 同样是 by-design。
   *
   * 它来自 forge 的决策层（`rules.json` 的风险类 / band / scope），
   * 也就是**这个人自己的历史**测出来的结论。标成 not-built 会让用户以为
   * 是我们没做完，而实际上这正是这个功能在正常工作。
   */
  it("★ agent_requires_review 是 by-design，且不给下一步动作", () => {
    expect(DECISION_REASON_INFO.agent_requires_review.kind).toBe("by-design")
    expect(DECISION_REASON_INFO.agent_requires_review.actionKey).toBeUndefined()
  })
})

describe("未知 reason 不给兜底文案", () => {
  it("★ 返回 null，让调用方原样显示", () => {
    /**
     * `generation_failed` 是我们自己在模型调用失败时塞的，不在 policy 的枚举里。
     * 兜底成一句"暂时无法自动发送"会把**真错误**伪装成正常判定，
     * 而那正是需要被看到的那类信息。
     */
    expect(explainDecisionReason("generation_failed")).toBeNull()
    expect(explainDecisionReason(null)).toBeNull()
  })
})

describe("准入闸的丢弃原因", () => {
  it.each(LANGUAGES)("%s：每条 drop reason 都有非空文案", (lang) => {
    const missing = Object.values(DROP_REASON_KEYS).filter((key) => {
      const text = lookup(lang, key)
      return text === undefined || text.trim() === ""
    })
    expect(missing).toEqual([])
  })

  it("与 decision reason 分开（两者含义不同，混在一起会误导）", () => {
    /**
     * drop = 根本没进队列；decision reason = 生成了但没自动发。
     * 用户看到"没触发"与"触发了但被拦"要采取的动作完全不同。
     */
    expect(DROP_REASON_KEYS.trigger_not_matched).toBe("drops.trigger_not_matched")
    expect(Object.keys(DECISION_REASON_INFO)).not.toContain("trigger_not_matched")
  })
})
