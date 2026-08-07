import { describe, expect, it, vi } from "vitest"
import type { KlGraphEgo, KlGraphFacts, KlGraphFactsInput } from "@mycontext/ipc-contract"
import { MultiGraphQueryService } from "@main/services/multi-graph-query.service"

const INPUT: KlGraphFactsInput = {
  days: null,
  types: [],
  entityName: null,
  keyword: "项目",
  limit: 2,
  offset: 0,
}

const ego: KlGraphEgo = { available: false, reason: "钉钉未建图", self: null, nodes: [], edges: [] }

function result(channelId: string, at: number): KlGraphFacts {
  return {
    available: true,
    reason: null,
    total: 1,
    facts: [
      {
        id: `${channelId}:fact-1`,
        channelId,
        text: `${channelId} 事实`,
        type: "STATUS",
        confidence: 0.9,
        at,
        entities: [],
      },
    ],
  }
}

describe("MultiGraphQueryService", () => {
  it("分别查询每个物理图库，再按时间汇总", () => {
    const dingtalkFacts = vi.fn(() => result("dingtalk", 10))
    const feishuFacts = vi.fn(() => result("feishu", 20))
    const service = new MultiGraphQueryService(
      { ego: () => ego, facts: dingtalkFacts },
      "dingtalk",
      () => [{ channelId: "feishu", facts: feishuFacts }],
    )

    const merged = service.facts(INPUT)

    expect(dingtalkFacts).toHaveBeenCalledOnce()
    expect(feishuFacts).toHaveBeenCalledOnce()
    expect(merged.total).toBe(2)
    expect(merged.facts.map((fact) => fact.channelId)).toEqual(["feishu", "dingtalk"])
  })

  it("ego 保持钉钉口径，不把飞书做成数字分身", () => {
    const service = new MultiGraphQueryService(
      { ego: () => ego, facts: () => result("dingtalk", 10) },
      "dingtalk",
      () => [{ channelId: "feishu", facts: () => result("feishu", 20) }],
    )
    expect(service.ego()).toBe(ego)
  })
})
