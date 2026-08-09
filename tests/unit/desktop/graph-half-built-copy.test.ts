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
   * ★★★ 两者都齐、而 `edges` 是 **0** → **不许说话**。
   *
   * ## 这条断言原来锁的是一句假话
   *
   * 它原来要求「关系边还没建（建图的最后一步）」。而实测下来那句话在一个
   * **完全建好**的图上永远为真：
   *
   * ```
   * GET /status → {"graph_backend":"ladybug","sqlite":{"edges":26558}}
   * SELECT COUNT(*) FROM edges  → 0
   * ```
   *
   * 边不是没建，是**搬家了**。上游 `storage/base.py` 的
   * `scan_edges_by_type` 注释明写「on the ladybug backend edges live in
   * LadybugDB and the SQLite `edges` table is empty」，
   * 而 `KL_GRAPH_BACKEND` 的默认值正是 `ladybug`。
   *
   * 代价：图有 26558 条边、检索正常，界面却一直说"还差最后一步"，
   * 用户据此反复点「重新建图」，而每次重建从零开始。
   *
   * ★ 所以 `0` 在这里**没有信息量**，不能作为报警依据。
   */
  it("★★★ facts>0 且 edges=0 → 不许说「关系边还没建」（ladybug 下 0 是正常值）", () => {
    expect(describeGraphStage({ entities: 60, facts: 120, edges: 0 })).toBeNull()
  })

  /**
   * ★★ 数不出来（`undefined`）时同样闭嘴。
   *
   * 这是"还没问过 /status"的形态。闭嘴比猜一句好 ——
   * 上面那条假警告正是"拿一个数不出来的值当 0 来解读"的后果。
   */
  it("★★ edges 为 undefined（还没问到真实值）→ 也不说话", () => {
    expect(describeGraphStage({ entities: 60, facts: 120, edges: undefined })).toBeNull()
  })

  /**
   * ★ 而 `facts===0` 那两档**不受影响** —— 它们读的是 SQLite 里真实的表。
   * 这条保证这次修复没把仍然有效的判据一起去掉。
   */
  it("★ edges 那一档去掉后，facts=0 仍然报警", () => {
    expect(describeGraphStage({ entities: 60, facts: 0, edges: undefined })).toMatch(/抽取|LLM/)
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

describe("★★ 建图文案不许承诺时长", () => {
  /**
   * ★★ 原来写着「正在建图（第一次要几分钟）」，而耗时**不可预测**。
   *
   * 实测同一台机器上跨两个数量级：
   * · 全量 Phase A **17 分钟**；
   * · 增量 Phase A **46.8 秒**（units_skipped 27651 / processed 3703）；
   * · 而 Phase B 的 LLM 抽取完全取决于网关 —— 有一轮整批被
   *   `Error 524: A timeout occurred` 打挂。
   *
   * ★ 承诺一个数字的后果不是"估得不准"，而是**它会引导错误操作**：
   * 超过那个数字之后用户认为卡住了，于是去点「重新建图」——
   * 那会把正在建的这一轮连同已建好的部分再删一遍，于是永远建不完。
   * 这与 `describeGraphStage` 那几句假警告是同一类代价。
   *
   * 判据锁在 `describeGraphStage` 的输出上（那是导出的纯函数）。
   * 建图中那两句在 `graphOverview` 里，由 `kl-graph-overview.test.ts` 覆盖。
   */
  it("★★ 空图那句只说会出网，不说要多久", () => {
    const reason = describeGraphStage({ entities: 0, facts: 0, edges: undefined })
    expect(reason).not.toBeNull()
    // ★ 代价仍要预告 —— 出网是用户该知道的（隐私 + 花钱）
    expect(reason).toContain("出网")
    // ★ 但不许出现任何时长承诺
    expect(reason).not.toMatch(/分钟|小时|秒/)
  })

  /** ★ 其余几档同样不许带时长。 */
  it("★ facts=0 那句也不带时长", () => {
    const reason = describeGraphStage({ entities: 60, facts: 0, edges: undefined })
    expect(reason).not.toMatch(/分钟|小时|秒/)
  })
})
