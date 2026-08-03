import type { KlGraphEgo, KlGraphFacts, KlGraphFactsInput } from "@mycontext/ipc-contract"

/**
 * 上层图谱查询聚合器。
 *
 * 每个 delegate 都只打开自己的 knowledge.db；这里分别查询后在内存中排序、分页，
 * 从结构上杜绝跨渠道 JOIN 或把飞书事实写进钉钉图库。ego/数字分身保持钉钉口径。
 */
export class MultiGraphQueryService {
  constructor(
    private readonly primary: {
      ego(): KlGraphEgo
      facts(input: KlGraphFactsInput): KlGraphFacts
    },
    private readonly sources: readonly {
      facts(input: KlGraphFactsInput): KlGraphFacts
    }[],
  ) {}

  ego(): KlGraphEgo {
    return this.primary.ego()
  }

  facts(input: KlGraphFactsInput): KlGraphFacts {
    const requested = input.offset + input.limit
    const perSourceInput = { ...input, offset: 0, limit: requested }
    const results = [
      this.primary.facts(perSourceInput),
      ...this.sources.map((source) => source.facts(perSourceInput)),
    ]
    const available = results.some((result) => result.available)
    const facts = results
      .flatMap((result) => result.facts)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(input.offset, input.offset + input.limit)
    const total = results.reduce((sum, result) => sum + result.total, 0)
    const reasons = results
      .filter((result) => !result.available && result.reason !== null)
      .map((result) => result.reason)

    return {
      available,
      reason:
        total > 0
          ? null
          : available
            ? (results.find((result) => result.reason !== null)?.reason ?? null)
            : reasons.join("；") || "各渠道图谱都还不可用",
      total,
      facts,
    }
  }
}
