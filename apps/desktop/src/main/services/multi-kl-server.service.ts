import type {
  KlGraphBuildResult,
  KlGraphOptimizeResult,
  KlGraphOverview,
  KlServerStatus,
} from "@mycontext/ipc-contract"
import type { KlServerService } from "./kl-server.service.js"

export interface SourceKlServer {
  channelId: string
  service: KlServerService
  /** 没有采集数据的渠道不启动 Python/Qdrant，也不拖累主渠道建图。 */
  enabled: () => boolean
}

/**
 * UI 侧的多图库门面。写入与建图仍由每个 KlServerService 各管各的目录；
 * 这里只顺序调度并在内存里合并统计，避免两套重任务同时把本机跑满。
 */
export class MultiKlServerService {
  /**
   * ★ `sources` 是**函数**而不是数组：非主渠道的 kl 由
   * `ChannelPipelineManager` 在**登录后**按"用户连了哪几个渠道"现造，
   * 而这个门面在装配阶段就构造好了。传数组的话它永远是空的 ——
   * 那正是改动前的形态（飞书那一路恒不可见，且完全静默）。
   */
  constructor(
    private readonly primary: KlServerService,
    private readonly getSources: () => readonly SourceKlServer[],
    /** 主渠道的 id（`perChannel` 里要标出它是哪个）。 */
    private readonly primaryChannelId = "dingtalk",
  ) {}

  private get sources(): readonly SourceKlServer[] {
    return this.getSources()
  }

  /**
   * 合并状态 + **逐渠道**摊开。
   *
   * ## ★★ 为什么必须有 `perChannel`
   *
   * 顶层那几个字段是合并过的（`state` 取主渠道、`building`/`networkEgress`
   * 是"任一"）。于是某个渠道的 kl 彻底 failed 时顶层仍显示 `ready`
   * —— 那一路整个坏掉而 UI 说一切正常，只能靠翻日志发现。
   *
   * ★ `idle`（还没采到消息 → 刻意不起）与 `failed` 分开：合成一个会让一次
   * 正常的降级看起来像故障，而用户会去点"重试"——那什么也修不了。
   */
  status(): KlServerStatus {
    const primary = this.primary.status()
    const sources = this.sources
    const active = sources.filter((source) => source.enabled())
    const activeStatuses = active.map((source) => source.service.status())
    const building = [primary, ...activeStatuses].find((status) => status.building)
    const perChannel = [
      {
        channelId: this.primaryChannelId,
        state: primary.state,
        reason: primary.reason,
        port: primary.port,
        building: primary.building,
        idle: false,
      },
      ...sources.map((source) => {
        const enabled = active.includes(source)
        const status = source.service.status()
        return {
          channelId: source.channelId,
          state: status.state,
          reason: status.reason,
          port: status.port,
          building: status.building,
          // 没采到消息 → 我们**刻意**没起它。不是故障。
          idle: !enabled && status.state === "stopped",
        }
      }),
    ]
    return {
      ...primary,
      building: building !== undefined,
      buildProgress: building?.buildProgress ?? primary.buildProgress,
      networkEgress: [primary, ...activeStatuses].some((status) => status.networkEgress),
      perChannel,
    }
  }

  async ensureReady(): Promise<boolean> {
    const primaryReady = await this.primary.ensureReady()
    const sourceReady = await Promise.all(
      this.sources
        .filter((source) => source.enabled())
        .map((source) => source.service.ensureReady()),
    )
    return primaryReady && sourceReady.every(Boolean)
  }

  async stop(): Promise<void> {
    await Promise.all([this.primary.stop(), ...this.sources.map((source) => source.service.stop())])
  }

  /**
   * 建图。
   *
   * ## ★ `channelId` 给了就**只建那一个**
   *
   * 界面上「建图/重建」按钮与渠道选择器同处一页，而用户在飞书那一栏点
   * 「重建」时的意图显然是"重建飞书的图" —— 不带渠道的话会把钉钉那
   * 37826 个 chunk 一起重烧（实测约 3 小时、且出网烧 LLM）。
   *
   * ★★ `fresh=true` 尤其危险：它**删数据**。把一次针对飞书的重建变成
   * "两个渠道的图全删了重来"是不可逆的。
   *
   * 不给 = 全部（存量行为，自动建图那条路走它）。
   */
  async rebuildGraph(fresh = false, channelId?: string): Promise<KlGraphBuildResult> {
    if (channelId !== undefined && channelId !== this.primaryChannelId) {
      const source = this.sources.find((item) => item.channelId === channelId)
      if (source !== undefined) return await source.service.rebuildGraph(fresh)
      // 那个渠道没挂管线 → 什么都不做，而不是"顺手建了主渠道的"
      return { ok: false, reason: `渠道未就绪：${channelId}`, entities: 0, facts: 0, edges: 0 }
    }
    if (channelId === this.primaryChannelId) return await this.primary.rebuildGraph(fresh)

    const results: KlGraphBuildResult[] = [await this.primary.rebuildGraph(fresh)]
    // 顺序执行：两边同时 embedding/抽取会让桌面机持续高负载。
    for (const source of this.sources) {
      if (source.enabled()) results.push(await source.service.rebuildGraph(fresh))
    }
    return combineBuild(results)
  }

  /** 优化图谱。★ 与 `rebuildGraph` 同款按渠道分流（见那里的注释）。 */
  async optimizeGraph(channelId?: string): Promise<KlGraphOptimizeResult> {
    if (channelId !== undefined && channelId !== this.primaryChannelId) {
      const source = this.sources.find((item) => item.channelId === channelId)
      if (source !== undefined) return await source.service.optimizeGraph()
      return {
        ok: false,
        reason: `渠道未就绪：${channelId}`,
        factEdges: 0,
        entityEdges: 0,
        entityCommunities: 0,
        factCommunities: 0,
      }
    }
    if (channelId === this.primaryChannelId) return await this.primary.optimizeGraph()
    return await this.optimizeAll()
  }

  private async optimizeAll(): Promise<KlGraphOptimizeResult> {
    const results: KlGraphOptimizeResult[] = [await this.primary.optimizeGraph()]
    for (const source of this.sources) {
      if (source.enabled()) results.push(await source.service.optimizeGraph())
    }
    return {
      ok: results.every((result) => result.ok),
      reason: combineReasons(results),
      factEdges: results.reduce((sum, result) => sum + result.factEdges, 0),
      entityEdges: results.reduce((sum, result) => sum + result.entityEdges, 0),
      entityCommunities: results.reduce((sum, result) => sum + result.entityCommunities, 0),
      factCommunities: results.reduce((sum, result) => sum + result.factCommunities, 0),
    }
  }

  /**
   * 图谱规模。
   *
   * ★ `channelId` 给了就**只看那一个渠道** —— 与 `MultiGraphQueryService.ego`
   * 同一个取值范围：仪表盘上那六个数与下面那张关系图必须说同一个渠道，
   * 否则读者会把两边对不上的数字当成 bug。
   *
   * 不给 = 合并全部（状态页那一块要的是"一共多大"）。
   */
  graphOverview(channelId?: string): KlGraphOverview {
    if (channelId !== undefined && channelId !== this.primaryChannelId) {
      const source = this.sources.find((item) => item.channelId === channelId)
      // 那个渠道没挂管线 → 落回主渠道（它是唯一能读的）
      if (source !== undefined) return source.service.graphOverview()
    }
    const primary = this.primary.graphOverview()
    if (channelId === this.primaryChannelId) return primary
    const results = [
      primary,
      ...this.sources
        .filter((source) => source.enabled())
        .map((source) => source.service.graphOverview()),
    ]
    const available = results.some((result) => result.available)
    return {
      available,
      reason: available
        ? null
        : results
            .map((result) => result.reason)
            .filter(Boolean)
            .join("；") || null,
      entities: sum(results, "entities"),
      facts: sum(results, "facts"),
      edges: sum(results, "edges"),
      chunks: sum(results, "chunks"),
      messages: sum(results, "messages"),
      entityTypes: mergeCounts(results.flatMap((result) => result.entityTypes)),
      factTypes: mergeCounts(results.flatMap((result) => result.factTypes)),
      topEntities: mergeEntities(results.flatMap((result) => result.topEntities)).slice(0, 20),
      recentFacts: results
        .flatMap((result) => result.recentFacts)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
        .slice(0, 12),
      // 自动建图调度目前由主数据面统一管理；多图库只合并图数据，
      // 不重新推导水位，避免与 FeedService 的真实触发判据漂移。
      buildSchedule: primary.buildSchedule,
      // 「这一轮建了多少」取主渠道那份，不求和（见后续提交里那段完整注释）
      lastBuild: primary.lastBuild,
    }
  }
}

function combineBuild(results: readonly KlGraphBuildResult[]): KlGraphBuildResult {
  return {
    ok: results.every((result) => result.ok),
    reason: combineReasons(results),
    entities: results.reduce((sum, result) => sum + result.entities, 0),
    facts: results.reduce((sum, result) => sum + result.facts, 0),
    edges: results.reduce((sum, result) => sum + result.edges, 0),
  }
}

function combineReasons(results: readonly { ok: boolean; reason: string | null }[]): string | null {
  const reasons = results
    .filter((result) => !result.ok)
    .map((result) => result.reason)
    .filter(Boolean)
  return reasons.length === 0 ? null : reasons.join("；")
}

function sum(
  results: readonly KlGraphOverview[],
  key: "entities" | "facts" | "edges" | "chunks" | "messages",
): number {
  return results.reduce((total, result) => total + result[key], 0)
}

function mergeCounts(
  rows: readonly { type: string; count: number }[],
): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + row.count)
  return [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)
}

function mergeEntities(
  rows: readonly { name: string; type: string; mentions: number }[],
): Array<{ name: string; type: string; mentions: number }> {
  const entities = new Map<string, { name: string; type: string; mentions: number }>()
  for (const row of rows) {
    const key = `${row.type}\u0000${row.name}`
    const current = entities.get(key)
    entities.set(key, { ...row, mentions: row.mentions + (current?.mentions ?? 0) })
  }
  return [...entities.values()].sort((a, b) => b.mentions - a.mentions)
}
