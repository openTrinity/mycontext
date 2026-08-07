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
  ) {}

  private get sources(): readonly SourceKlServer[] {
    return this.getSources()
  }

  status(): KlServerStatus {
    const primary = this.primary.status()
    const active = this.sources
      .filter((source) => source.enabled())
      .map((source) => source.service.status())
    const building = [primary, ...active].find((status) => status.building)
    return {
      ...primary,
      building: building !== undefined,
      buildProgress: building?.buildProgress ?? primary.buildProgress,
      networkEgress: [primary, ...active].some((status) => status.networkEgress),
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

  async rebuildGraph(fresh = false): Promise<KlGraphBuildResult> {
    const results: KlGraphBuildResult[] = [await this.primary.rebuildGraph(fresh)]
    // 顺序执行：两边同时 embedding/抽取会让桌面机持续高负载。
    for (const source of this.sources) {
      if (source.enabled()) results.push(await source.service.rebuildGraph(fresh))
    }
    return combineBuild(results)
  }

  async optimizeGraph(): Promise<KlGraphOptimizeResult> {
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

  graphOverview(): KlGraphOverview {
    const primary = this.primary.graphOverview()
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
