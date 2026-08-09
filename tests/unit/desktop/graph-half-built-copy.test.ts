/**
 * 界面对**建图半成品**说的话，以及日志分级。
 *
 * ## 这一组锁的是「界面说了一句假话」
 *
 * 实测（用户截图 + 库里数字）：
 *
 * ```
 * chunks 2296   entities 60   facts 0   edges 0
 * ```
 *
 * 而界面显示「**实体与事实已就绪**，关系边还没建（建图的最后一步）」——
 * 事实是 0，说"已就绪"是假的；说"最后一步"更糟，它让用户以为再等等就好，
 * 于是他不会去查真正的原因。
 *
 * 根因是原判据只有三档，`edges === 0` 那一档**根本没看 facts**：
 *
 * ```ts
 * entities === 0 ? … : edges === 0 ? "实体与事实已就绪…" : null
 * ```
 *
 * ★ `entities>0 && facts===0` 不是罕见组合，而是一个**确定会出现**的状态：
 * 两者来自建图的不同阶段（实体一部分在 Phase A 就能落，事实要 Phase B 的
 * LLM 抽取），所以"Phase A 成功、Phase B 挂了"稳定产出它。
 * 实测那次 Phase B 是被网关打挂的（`Error 524: A timeout occurred`）。
 */
import { describe, expect, it } from "vitest"
import { describeGraphStage, klLogLevelFor } from "@main/services/kl-server.service.js"
import { describeBuildSchedule } from "@renderer/features/dashboard/dashboard-data.js"

describe("★★ facts=0 时不许说「事实已就绪」", () => {
  /**
   * ★★ 这条是那个 bug 的直接反面。
   *
   * 判据只能是"文案里不能出现「事实已就绪」这种说法"，而不能只断言
   * 文案变了 —— 后者换个措辞也能过，而用户看到的仍是假话。
   */
  it("★★ entities>0 且 facts=0 → 文案不能声称事实就绪", () => {
    const reason = describeGraphStage({ entities: 60, facts: 0, edges: 0 })
    expect(reason).not.toBeNull()
    expect(reason).not.toContain("实体与事实已就绪")
  })

  /**
   * ★ 而且要**指向那一步**：LLM 抽取。
   *
   * 说"再等等"或"最后一步"会让用户什么都不做，而这个状态需要他重试或换网关。
   */
  it("★ 文案指向 LLM 抽取那一步（用户能动手的地方）", () => {
    const reason = describeGraphStage({ entities: 60, facts: 0, edges: 0 })
    expect(reason).toMatch(/抽取|LLM/)
  })

  /**
   * ★ 两者都齐、只差边 → 才可以说"最后一步"。
   * 这条保证上面那个修复**没有把正确的那一档也改坏**。
   */
  it("★ facts>0 且 edges=0 → 仍然说「最后一步」", () => {
    const reason = describeGraphStage({ entities: 60, facts: 120, edges: 0 })
    expect(reason).toContain("关系边还没建")
  })

  /** 全空 → 说"建图没成功跑过"，与"跑了一半"是两件事。 */
  it("全空 → 说建图没成功跑过", () => {
    expect(describeGraphStage({ entities: 0, facts: 0, edges: 0 })).toContain("图是空的")
  })

  /** 全都有 → 不说话（没有问题就别占一行）。 */
  it("三者都有 → reason 为 null", () => {
    expect(describeGraphStage({ entities: 60, facts: 120, edges: 300 })).toBeNull()
  })
})

describe("★★ litellm 的固定提示不许提成 warn", () => {
  /**
   * ★★ 实测一次建图刷了**几十行连续 WARN**，全是这一句。
   *
   * 它被提成 warn 是因为句中带 "error"，命中了那条宽松规则。后果不是
   * "日志有点吵"，而是**真正的那行被埋掉** —— 同一批里
   * `[ERROR] Batch LLM error … Error 524` 才是原因，而它夹在中间，
   * 肉眼扫过去只看到一片黄。
   */
  it("★★ LiteLLM.Info 的调试提示 → debug", () => {
    const line = "LiteLLM.Info: If you need to debug this error, use `litellm._turn_on_debug()'."
    expect(klLogLevelFor(line)).toBe("debug")
  })

  /**
   * ★★ 但**真正的错误必须仍然是 warn** —— 这条是上面那个降级的边界。
   *
   * 只降 `LiteLLM.Info` 前缀那一类，不能顺手把 litellm 的真错误也吞掉。
   */
  it("★★ 真正的批量抽取错误仍是 warn（网关 524）", () => {
    const line =
      "[ERROR] Batch LLM error (10 msgs, first=chan:abc, transient): " +
      "APIConnectionError: litellm.APIConnectionError: Error 524: A timeout occurred"
    expect(klLogLevelFor(line)).toBe("warn")
  })

  /** ★ `LLM errors: N`（非零）仍是 warn —— 它是"建图成功但 facts=0"的唯一线索。 */
  it("★ LLM errors 非零仍是 warn", () => {
    expect(klLogLevelFor("  LLM errors: 37")).toBe("warn")
    expect(klLogLevelFor("  LLM errors: 0")).not.toBe("warn")
  })
})

describe("★ 「自动构建已关闭」要说出原因", () => {
  /**
   * ★★ `enabled` 为假的真实原因是**没配 LLM**（判据是 klBaseUrl 与
   * klApiKey 都非空），而原文案读起来像"你自己关掉了"——
   * 用户会去找一个不存在的开关。
   *
   * 实测撞上：界面同时显示「知识加工落后 28,819 条」+「自动构建已关闭」，
   * 两句合起来完全没有指向"去配模型"，而日志里 `llm not configured`
   * 早就写着原因。
   */
  it("★★ 关闭时文案指向「配置模型」", () => {
    const text = describeBuildSchedule({
      enabled: false,
      reason: "disabled",
      etaMs: null,
      willBuild: false,
      pendingMessages: 28_819,
      messagesToThreshold: 0,
      lagThreshold: 500,
    })
    expect(text?.text).toMatch(/配置模型|配模型/)
  })
})
