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

  /**
   * ## ★★ 这一组锁的是"选了飞书，看到的必须不是钉钉的数据"
   *
   * 实测的坏形态（用户截图）：仪表盘切到飞书，下面的事实与关系一条都没换 ——
   * 那些实体是钉钉库里的，而界面上**没有任何痕迹**说"你看的不是飞书"。
   *
   * 成因是 `facts()` 里那句"那个渠道没挂管线 → 落回主渠道：它是唯一能查的"：
   * `source === undefined` 时从 if 里掉出去，走到下面的合并分支。
   * 而同一个函数里 catch 那条路的注释已经写明了正确判据
   * （"抛错要说出来而不是静默落回主渠道"）—— 「挂不上」漏了同一条，
   * 且它比抛错**常见得多**（刚授权、还在挂载中都会命中）。
   *
   * 这是本仓库最贵的那类 bug：不报错，只是答错。而答的是
   * 「这个人在飞书里和谁有往来」这种会被当真的问题。
   */
  describe("★★ 指到一个挂不上的渠道时不许落回主渠道", () => {
    /** 只有主渠道挂着 —— 也就是"飞书刚授权，管线还没挂上"那一刻。 */
    function primaryOnly() {
      const primaryFacts = vi.fn(() => result("dingtalk", 10))
      const primaryEgo = vi.fn(() => ego)
      const service = new MultiGraphQueryService(
        { ego: primaryEgo, facts: primaryFacts },
        "dingtalk",
        () => [],
      )
      return { service, primaryFacts, primaryEgo }
    }

    it("facts：给出 available:false，而不是主渠道的事实", () => {
      const { service, primaryFacts } = primaryOnly()

      const out = service.facts({ ...INPUT, channelId: "feishu" })

      // ★ 核心判据：一条钉钉的事实都不许出现
      expect(out.facts).toEqual([])
      expect(out.total).toBe(0)
      expect(out.available).toBe(false)
      expect(out.reason).not.toBeNull()
      // ★ 主渠道的图库压根不该被查（查了就说明还在走合并分支）
      expect(primaryFacts).not.toHaveBeenCalled()
    })

    it("ego：同一条判据（关系图错渠道比事实错更容易被当真）", () => {
      const { service, primaryEgo } = primaryOnly()

      const out = service.ego("feishu")

      expect(out.available).toBe(false)
      expect(out.nodes).toEqual([])
      expect(out.edges).toEqual([])
      expect(out.self).toBeNull()
      expect(primaryEgo).not.toHaveBeenCalled()
    })

    it("挂上了就走它自己的（别把上面那条修成「永远不可用」）", () => {
      const feishuEgo: KlGraphEgo = {
        available: true,
        reason: null,
        self: { id: "e1", name: "我", type: "PERSON", weight: 1 },
        nodes: [],
        edges: [],
      }
      const feishuFacts = vi.fn(() => result("feishu", 20))
      const primaryFacts = vi.fn(() => result("dingtalk", 10))
      const service = new MultiGraphQueryService(
        { ego: () => ego, facts: primaryFacts },
        "dingtalk",
        () => [{ channelId: "feishu", facts: feishuFacts, ego: () => feishuEgo }],
      )

      expect(service.facts({ ...INPUT, channelId: "feishu" }).facts[0]?.channelId).toBe("feishu")
      expect(service.ego("feishu")).toBe(feishuEgo)
      expect(primaryFacts).not.toHaveBeenCalled()
    })

    /**
     * ★ 不给 channelId 仍然合并（搜索走这条 —— 每条带渠道徽章，来源不会混）。
     * 上面那条修复只该影响"指名了一个挂不上的渠道"，别顺手改了合并那条路。
     */
    it("不指定渠道时照旧合并（搜索那条路不受影响）", () => {
      const service = new MultiGraphQueryService(
        { ego: () => ego, facts: () => result("dingtalk", 10) },
        "dingtalk",
        () => [{ channelId: "feishu", facts: () => result("feishu", 20) }],
      )
      expect(service.facts(INPUT).total).toBe(2)
    })
  })
})
