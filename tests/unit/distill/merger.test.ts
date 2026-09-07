/**
 * facet 增量合并的三态语义。
 *
 * 纯函数测试（`mergeFacet` 的签名是 `(existing, candidate) => MergeResult`）——
 * **完全不碰模型**，所以可以穷举，也可以进门禁。
 *
 * 三态借鉴 colleague-skill 的 merger：补充 / 确认 / 矛盾。
 * 关键差异是我们按 `(facet, scope, scope_ref, key)` 精确定位到行，
 * 所以数值型走纯统计不调 LLM。
 */
import { describe, expect, it } from "vitest"
import { classifyRelation, isNumericFacet, mergeFacet } from "@mycontext/distill"
import type { FacetCandidate, FacetRow } from "@mycontext/distill"

const NOW = 1_785_000_000_000

function row(overrides: Partial<FacetRow> = {}): FacetRow {
  return {
    id: "f-1",
    facet: "tone",
    scope: "global",
    scopeRef: "",
    key: "catchphrases",
    valueJson: JSON.stringify(["收到", "我看一下"]),
    confidence: 0.6,
    evidenceJson: JSON.stringify(["m-1", "m-2"]),
    source: "llm",
    conflictJson: null,
    revision: 1,
    windowStart: null,
    windowEnd: null,
    updatedAt: NOW,
    ...overrides,
  }
}

function candidate(overrides: Partial<FacetCandidate> = {}): FacetCandidate {
  return {
    facet: "tone",
    scope: "global",
    scopeRef: "",
    key: "catchphrases",
    value: ["收到", "我看一下"],
    confidence: 0.7,
    evidence: ["m-3"],
    source: "llm",
    ...overrides,
  }
}

describe("首次写入", () => {
  it("existing 为 null → insert", () => {
    const result = mergeFacet(null, candidate())
    expect(result.action).toBe("insert")
    if (result.action === "insert") {
      expect(result.value).toEqual(["收到", "我看一下"])
      expect(result.evidence).toEqual(["m-3"])
    }
  })
})

describe("★ 用户手改是最高优先级", () => {
  /**
   * 没有这条的话，用户在审阅页改完一句话，下一轮蒸馏就把它改回去了 ——
   * 而用户不会再改第二次，他会关掉这个功能。
   */
  it("source='user' 的行不被 llm 覆盖", () => {
    const result = mergeFacet(row({ source: "user" }), candidate({ value: ["完全不同"] }))
    expect(result).toEqual({ action: "skip", reason: "user_override_wins" })
  })

  it("source='user' 的行不被 stat 覆盖", () => {
    const result = mergeFacet(row({ source: "user" }), candidate({ source: "stat" }))
    expect(result.action).toBe("skip")
  })

  it("用户再次手改可以覆盖自己之前的（source 都是 user）", () => {
    const result = mergeFacet(
      row({ source: "user" }),
      candidate({ source: "user", value: ["新的说法"] }),
    )
    expect(result.action).toBe("update")
  })
})

describe("三态：确认", () => {
  it("值相同 → 提升置信度但不重写值", () => {
    const result = mergeFacet(row({ confidence: 0.6 }), candidate({ confidence: 0.9 }))
    expect(result.action).toBe("update")
    if (result.action === "update") {
      expect(result.relation).toBe("confirm")
      expect(result.value).toEqual(["收到", "我看一下"])
      expect(result.confidence).toBeCloseTo(0.65, 5)
    }
  })

  it("证据仍然合并（20 句话都这么说比 3 句更有说服力）", () => {
    const result = mergeFacet(row(), candidate({ evidence: ["m-3", "m-4"] }))
    if (result.action === "update") {
      expect(result.evidence).toEqual(["m-3", "m-4", "m-1", "m-2"])
    }
  })

  it("置信度有上限（不会无限逼近 1）", () => {
    const result = mergeFacet(row({ confidence: 0.98 }), candidate({ evidence: ["m-1"] }))
    // 已到上限且证据无新增 → 无变化
    expect(result).toEqual({ action: "skip", reason: "no_change" })
  })
})

describe("三态：补充", () => {
  it("数组超集 → 补充，取新值", () => {
    const result = mergeFacet(row(), candidate({ value: ["收到", "我看一下", "稍等"] }))
    expect(result.action).toBe("update")
    if (result.action === "update") {
      expect(result.relation).toBe("supplement")
      expect(result.value).toEqual(["收到", "我看一下", "稍等"])
      // 置信度取两者较大值（新增细节不该降低已有信心）
      expect(result.confidence).toBe(0.7)
    }
  })

  it("空数组 → 有值 也算补充", () => {
    const result = mergeFacet(row({ valueJson: "[]" }), candidate({ value: ["收到"] }))
    if (result.action === "update") expect(result.relation).toBe("supplement")
  })
})

describe("★ 三态：矛盾（保留双结论并降置信）", () => {
  /**
   * 不自动选一个是刻意的：两个都有证据支撑，说明这个人在不同场景下
   * 确实表现不同（或者我们的抽取粒度太粗）。自动挑一个会丢掉这个信息，
   * 而降置信 + 展示双方让用户能一眼看出"这里需要人来判断"。
   */
  it("标量值不同 → 矛盾，双结论都留下", () => {
    const result = mergeFacet(
      row({ key: "formality", valueJson: JSON.stringify("casual"), confidence: 0.8 }),
      candidate({ key: "formality", value: "formal", confidence: 0.7 }),
    )
    expect(result.action).toBe("update")
    if (result.action === "update") {
      expect(result.relation).toBe("conflict")
      expect(result.conflict).toEqual({ existing: "casual", candidate: "formal" })
      // 降置信：min(0.8, 0.7) - 0.15
      expect(result.confidence).toBeCloseTo(0.55, 5)
    }
  })

  it("数组元素被替换（不是超集）→ 矛盾", () => {
    const result = mergeFacet(row(), candidate({ value: ["完全不同的说法"] }))
    if (result.action === "update") {
      expect(result.relation).toBe("conflict")
      expect(result.conflict).toBeDefined()
    }
  })

  it("置信度有下限（不会降到 0 让结论彻底消失）", () => {
    const result = mergeFacet(
      row({ key: "formality", valueJson: '"a"', confidence: 0.2 }),
      candidate({ key: "formality", value: "b", confidence: 0.2 }),
    )
    if (result.action === "update") expect(result.confidence).toBe(0.2)
  })

  it("**不做「取新的」**：矛盾时旧值必须留在 conflict 里", () => {
    const result = mergeFacet(
      row({ key: "formality", valueJson: '"old"' }),
      candidate({ key: "formality", value: "new" }),
    )
    if (result.action === "update") {
      // 取新的作为当前值，但旧的必须可见 —— 否则画像随最后一轮蒸馏漂移
      // 而用户永远看不到它变过。
      expect(result.value).toBe("new")
      expect(result.conflict?.existing).toBe("old")
    }
  })

  it("★ 二次矛盾：保留**最初**那一方，不被 value 列覆盖丢", () => {
    // 第一轮矛盾后的真实行形状：value 列 = candidate 单方的 "formal"，
    // 原始 existing "casual" 只躺在 conflict_json 里。
    const alreadyConflicted = row({
      key: "formality",
      valueJson: JSON.stringify("formal"),
      confidence: 0.6,
      conflictJson: JSON.stringify({ existing: "casual", candidate: "formal" }),
    })
    const result = mergeFacet(
      alreadyConflicted,
      candidate({ key: "formality", value: "文艺腔", confidence: 0.7 }),
    )
    if (result.action === "update") {
      expect(result.relation).toBe("conflict")
      // ★ 关键：existing 仍是最初的 "casual"，而不是 value 列的 "formal" ——
      // 否则审阅页上矛盾的"原始一方"就被静默覆盖丢了。
      expect(result.conflict?.existing).toBe("casual")
      expect(result.conflict?.candidate).toBe("文艺腔")
    }
  })
})

describe("关系判定（结构化比较，不让 LLM 判断）", () => {
  it.each([
    [["a", "b"], ["a", "b"], "confirm"],
    [["a"], ["a", "b"], "supplement"],
    [["a", "b"], ["a"], "conflict"],
    ["x", "x", "confirm"],
    ["x", "y", "conflict"],
    [1, 1, "confirm"],
    [1, 2, "conflict"],
    [{ a: 1 }, { a: 1 }, "confirm"],
    [{ a: 1 }, { a: 2 }, "conflict"],
  ])("%j vs %j → %s", (existing, incoming, expected) => {
    expect(classifyRelation(existing, incoming)).toBe(expected)
  })
})

describe("★ 数值型走纯统计（不调 LLM）", () => {
  it("routines 是数值 facet", () => {
    expect(isNumericFacet("routines")).toBe(true)
    expect(isNumericFacet("tone")).toBe(false)
    expect(isNumericFacet("persona")).toBe(false)
  })

  it("数值按证据条数加权平均", () => {
    const result = mergeFacet(
      row({
        facet: "routines",
        key: "response_latency_p50",
        valueJson: "300",
        // 3 条证据
        evidenceJson: JSON.stringify(["m-1", "m-2", "m-3"]),
      }),
      candidate({
        facet: "routines",
        key: "response_latency_p50",
        value: 100,
        // 1 条证据
        evidence: ["m-4"],
      }),
    )
    if (result.action === "update") {
      // (300*3 + 100*1) / 4 = 250
      expect(result.value).toBe(250)
      expect(result.relation).toBe("supplement")
    }
  })

  it("样本增多时置信度上升但有上限", () => {
    const result = mergeFacet(
      row({ facet: "routines", valueJson: "10", confidence: 0.93 }),
      candidate({ facet: "routines", value: 12 }),
    )
    if (result.action === "update") expect(result.confidence).toBeLessThanOrEqual(0.95)
  })

  it("值不是数值时退回普通路径（不硬算）", () => {
    const result = mergeFacet(
      row({ facet: "routines", valueJson: '"morning"' }),
      candidate({ facet: "routines", value: "evening" }),
    )
    expect(result.action).toBe("update")
    if (result.action === "update") expect(result.value).toBe("evening")
  })
})

describe("证据上限", () => {
  it("不超过 50 条（防止一行挂着几万个 message_id）", () => {
    const many = Array.from({ length: 80 }, (_, index) => `m-${index}`)
    const result = mergeFacet(null, candidate({ evidence: many }))
    if (result.action === "insert") expect(result.evidence.length).toBe(50)
  })

  it("合并时新证据在前（审阅页更可能想看最近的例子）", () => {
    const result = mergeFacet(
      row({ evidenceJson: JSON.stringify(["old-1", "old-2"]) }),
      candidate({ evidence: ["new-1"] }),
    )
    if (result.action === "update") expect(result.evidence[0]).toBe("new-1")
  })

  it("重复的 message_id 被去重", () => {
    const result = mergeFacet(
      row({ evidenceJson: JSON.stringify(["m-1", "m-2"]) }),
      candidate({ evidence: ["m-2", "m-3"] }),
    )
    if (result.action === "update") {
      expect(result.evidence).toEqual(["m-2", "m-3", "m-1"])
    }
  })
})
