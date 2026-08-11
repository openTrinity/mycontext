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
      ego(): Promise<KlGraphEgo>
      facts(input: KlGraphFactsInput): Promise<KlGraphFacts>
    },
    /**
     * ★ 函数而非数组：非主渠道的图库由 `ChannelPipelineManager` 在登录后
     * 现造（见 `MultiKlServerService` 里同一条注释）。
     */
    /** 主渠道 id（`channelId` 指到它时直接走 primary）。 */
    private readonly primaryChannelId: string,
    private readonly getSources: () => readonly {
      channelId: string
      facts(input: KlGraphFactsInput): Promise<KlGraphFacts>
      /** 那个渠道自己的 ego 图（切换到它时用）。 */
      ego?: () => Promise<KlGraphEgo>
    }[],
  ) {}

  private get sources(): readonly {
    channelId: string
    facts(i: KlGraphFactsInput): Promise<KlGraphFacts>
    ego?: () => Promise<KlGraphEgo>
  }[] {
    return this.getSources()
  }

  /**
   * ego 图 —— **只能落在一个渠道上**，不合并。
   *
   * ## ★★ 为什么不合并（这不是偷懒）
   *
   * 同一个人在两个渠道是两个不同的 external_id（钉钉是 openDingTalkId、
   * 飞书是 open_id），而两者**没有安全的映射** —— 靠显示名对齐不行
   * （同名同姓实测 6 个）。合并显示等于凭猜测把两个人的关系连起来，
   * 而那是"不报错、只是答错"里最坏的一种：用户会据此认为某两个人有往来。
   *
   * 所以界面上给的是**切换**而不是筛选：一次看一个渠道的关系图。
   *
   * `channelId` 不给或就是主渠道 → 主渠道（存量行为）。
   *
   * ## ★★ 指到一个挂不上的渠道时**不许落回主渠道**
   *
   * 原来这里是 `source?.ego === undefined ? this.primary.ego() : …` —— 于是
   * 「选了飞书但它的管线还没挂上」与「选了主渠道」走同一条路，返回的是
   * **主渠道的**关系图。实测的表现：用户在仪表盘切到飞书，下面的事实与关系
   * 一个都没换（截图里那个实体是钉钉库里的），而界面上没有任何痕迹说
   * "你看的不是飞书"。
   *
   * 这正是本仓库最贵的那类 bug：不报错，只是答错 —— 而且答的是
   * 「这个人在飞书里和谁有往来」这种会被当真的问题。
   *
   * 所以现在：认不出这个渠道就明确说不可用（`facts()` 下面那段同一判据）。
   */
  /**
   * ★ `async` —— 上游把 `GraphQueryService.ego()` 改成了异步：关系边要问 kl 的
   * HTTP（SQLite 的 `edges` 表在默认后端 ladybug 下按设计恒空）。
   * 这个聚合器只是转发，所以跟着变成 Promise。
   */
  async ego(channelId?: string): Promise<KlGraphEgo> {
    if (channelId === undefined || channelId === this.primaryChannelId) {
      return this.primary.ego()
    }
    const source = this.sources.find((item) => item.channelId === channelId)
    const ego = source?.ego
    if (ego === undefined) {
      return {
        available: false,
        reason: "这个渠道的图谱还没挂上（刚授权时要等一会儿，或者它还没建过图）",
        self: null,
        nodes: [],
        edges: [],
      }
    }
    return ego()
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
   *
   * ★ `async` —— 与 `ego()` 同一个理由：上游把 `GraphQueryService.facts()`
   * 改成了异步（关系边要问 kl 的 HTTP）。这里是聚合器，所以整条链跟着变
   * Promise；扇出那段用 `Promise.all` 而**不是**顺序 await ——
   * 逐个等的话 N 个渠道的延迟会线性叠加，而它们本来互不相干。
   */
  async facts(input: KlGraphFactsInput): Promise<KlGraphFacts> {
    const requested = input.offset + input.limit
    const perSourceInput = { ...input, offset: 0, limit: requested }
    const failedSources: { channelId: string; reason: string }[] = []
    /**
     * ★ 指定了渠道就**只查它**（仪表盘展示走这条：与 ego 图同一个取值范围）。
     * 不指定则合并（搜索走这条 —— 每条带 channelId 徽章，来源不会混）。
     */
    const only = input.channelId
    if (only !== undefined && only !== this.primaryChannelId) {
      const source = this.sources.find((item) => item.channelId === only)
      /**
       * ★★ 那个渠道没挂管线（没连 / 还在挂载中）→ **明确说不可用**。
       *
       * 这里原来是"落回主渠道：它是唯一能查的" —— 也就是 `source === undefined`
       * 时从这个 if 里掉出去，走到下面的合并分支，返回主渠道的事实。
       * 实测的表现：仪表盘切到飞书，事实列表一条都没换（那些是钉钉库里的），
       * 而界面上没有任何痕迹。
       *
       * 判据与下面那段 catch 完全一致（那里的注释已经写明"抛错要说出来而不是
       * 静默落回主渠道 —— 后者会让用户以为自己在看飞书的事实"）——
       * 「挂不上」漏了同一条判据，而它比抛错**更常见**。
       */
      if (source === undefined) {
        return {
          available: false,
          reason: "这个渠道的图谱还没挂上（刚授权时要等一会儿，或者它还没建过图）",
          total: 0,
          facts: [],
          failedSources: [],
        }
      }
      try {
        return await source.facts(input)
      } catch (error) {
        /**
         * ★ 抛错要**说出来**而不是静默落回主渠道 —— 后者会让用户以为
         * 自己在看飞书的事实，而看到的是钉钉的。
         */
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
          total: 0,
          facts: [],
          failedSources: [{ channelId: only, reason: "查询失败" }],
        }
      }
    }
    if (only === this.primaryChannelId) return this.primary.facts(input)
    /**
     * ★ 并发扇出（`Promise.all`）而不是逐个 await：各渠道的图库互不相干，
     * 顺序等的话延迟线性叠加。
     *
     * ★ 每个源自己 try/catch，**不能**让一个失败的 reject 掉整个 `Promise.all`
     * —— 那正是上面那段注释说的"一图失败不让整个查询失败"。失败的返回
     * `null` 并记进 `failedSources`，随后 filter 掉。
     */
    const settled = await Promise.all([
      this.primary.facts(perSourceInput),
      ...this.sources.map(async (source) => {
        try {
          const result = await source.facts(perSourceInput)
          if (!result.available && result.reason !== null) {
            failedSources.push({ channelId: source.channelId, reason: result.reason })
          }
          return result
        } catch (error) {
          failedSources.push({
            channelId: source.channelId,
            reason: error instanceof Error ? error.message : String(error),
          })
          return null
        }
      }),
    ])
    const results = settled.filter((result): result is KlGraphFacts => result !== null)
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
