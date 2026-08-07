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
    /**
     * ★ 函数而非数组：非主渠道的图库由 `ChannelPipelineManager` 在登录后
     * 现造（见 `MultiKlServerService` 里同一条注释）。
     */
    private readonly getSources: () => readonly {
      channelId: string
      facts(input: KlGraphFactsInput): KlGraphFacts
    }[],
  ) {}

  private get sources(): readonly { channelId: string; facts(i: KlGraphFactsInput): KlGraphFacts }[] {
    return this.getSources()
  }

  ego(): KlGraphEgo {
    return this.primary.ego()
  }

  /**
   * 逐图查询后在内存里合并排序分页。
   *
   * ## ★★ 一图失败不让整个查询失败，但**必须留痕**
   *
   * "任一图有结果就算成功"这条降级判据是对的，但它原来把失败整个吞掉了：
   * 用户看到一个正常的结果列表，只是少了一半来源，而没有任何痕迹。
   * 现在失败的渠道进 `failedSources` —— 与"这个渠道本来就没有事实"可区分。
   *
   * ★ `facts()` 抛错也算失败（不是只看 `available:false`）：图库文件损坏 /
   * 表结构不认识都会抛，而那时整个查询会 500，连另一个渠道的结果都拿不到。
   */
  facts(input: KlGraphFactsInput): KlGraphFacts {
    const requested = input.offset + input.limit
    const perSourceInput = { ...input, offset: 0, limit: requested }
    const failedSources: { channelId: string; reason: string }[] = []
    const results = [
      this.primary.facts(perSourceInput),
      ...this.sources.flatMap((source) => {
        try {
          const result = source.facts(perSourceInput)
          if (!result.available && result.reason !== null) {
            failedSources.push({ channelId: source.channelId, reason: result.reason })
          }
          return [result]
        } catch (error) {
          failedSources.push({
            channelId: source.channelId,
            reason: error instanceof Error ? error.message : String(error),
          })
          return []
        }
      }),
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
      // 无失败时不带这个字段 —— 免得渲染层要判空数组
      ...(failedSources.length === 0 ? {} : { failedSources }),
    }
  }
}
