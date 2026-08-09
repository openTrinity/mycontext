import type {
  KlGraphBuildResult,
  KlGraphOptimizeResult,
  KlGraphOverview,
  KlServerStatus,
} from "@mycontext/ipc-contract"
import type { Logger } from "@mycontext/kernel"
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
    /**
     * 诊断日志。**可选** —— 这个门面在测试里被大量直接构造，
     * 而那些用例不关心日志。
     *
     * ★ 有它是因为"渠道 → 端口"这个映射错了的时候完全静默
     * （界面标着 A 渠道、显示 B 渠道的数据），而排查需要它。见 `status()`。
     */
    private readonly logger?: Pick<Logger, "debug">,
  ) {}

  private get sources(): readonly SourceKlServer[] {
    return this.getSources()
  }

  /**
   * 「一个渠道 / 主渠道 / 全部」三分路 —— **只写一遍**。
   *
   * ## ★★ 为什么提成一个方法
   *
   * 下面五个动作（起 / 停 / 建图 / 优化 / 概览）原来各自手写一遍同样的三分支：
   *
   * ```ts
   * if (channelId !== undefined && channelId !== this.primaryChannelId) {
   *   const source = this.sources.find(…)
   *   …            // ← 每处都要记得"找不到时别落回主渠道"
   * }
   * if (channelId === this.primaryChannelId) …
   * …              // ← 全部
   * ```
   *
   * 五处各写一遍意味着**五次机会漏掉那条判据**，而漏掉的表现是静默打错对象：
   * 实测发生过"针对飞书的重建删掉了主渠道的图"。而这类错在 review 里极难看出
   * —— 三个分支长得都对，错的是缺了第四种情况。
   *
   * 现在分支只存在于这里；调用方只回答三个问题："打给一个渠道时做什么"、
   * "打给全部时做什么"、"那个渠道没挂时返回什么"。
   *
   * ★ 与 `ChannelRuntimeRegistry` 的分工：那一层管"哪些渠道存在"（含主渠道，
   * 是应用级的单一真源）；这一层多一个 `enabled()` 的概念（没采到语料的渠道
   * **刻意不起** kl），而那是 kl 特有的降级，不属于 registry。
   *
   * @param onOne 打给某一个渠道（`service` 是它自己的那个 kl 实例）
   * @param onAll 不指定渠道 = 全部
   * @param onMissing 指名了一个**没挂管线**的渠道 —— 必须显式给，
   *   因为"静默落回主渠道"正是要防的那个 bug
   */
  private route<T>(
    channelId: string | undefined,
    onOne: (service: KlServerService) => T,
    onAll: () => T,
    onMissing: (channelId: string) => T,
  ): T {
    if (channelId === undefined) return onAll()
    if (channelId === this.primaryChannelId) return onOne(this.primary)
    const source = this.sources.find((item) => item.channelId === channelId)
    return source === undefined ? onMissing(channelId) : onOne(source.service)
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
    /**
     * ★★ 渠道 → 端口的映射**必须可诊断**。
     *
     * 这一层是"哪个渠道走哪个 kl"的唯一裁决点，而它错了的表现是
     * **界面上标着 A 渠道、显示的是 B 渠道的数据** —— 不报错，只是答错。
     * 实测撞到过：卡片写「飞书 · 就绪 · 8200」，而 8200 是主渠道的端口
     * （飞书在 8201）。那时排查只能靠猜，因为这个映射从来没被打出来过。
     *
     * ★ 只打渠道 id 与端口（都不是隐私），且用 debug 级别 —— 它每次轮询
     * 都会调（3 秒一次），info 会把日志刷满。
     */
    this.logger?.debug("kl channel port map", {
      primary: { channelId: this.primaryChannelId, port: primary.port, state: primary.state },
      sources: sources.map((source) => ({
        channelId: source.channelId,
        port: source.service.status().port,
        state: source.service.status().state,
        enabled: source.enabled(),
      })),
    })
    const perChannel = [
      {
        channelId: this.primaryChannelId,
        state: primary.state,
        reason: primary.reason,
        port: primary.port,
        building: primary.building,
        buildProgress: primary.buildProgress,
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
          /**
           * ★ 进度也**逐渠道**带上，不能只留顶层那一个。
           *
           * 顶层 `buildProgress` 取的是"任意一个在建的渠道"（下面那行
           * `building?.buildProgress`），于是界面上「建图中 85%」不带归属 ——
           * 用户切到飞书时看到的可能是钉钉那一轮的百分比。
           */
          buildProgress: status.buildProgress,
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

  /**
   * 起服务。
   *
   * ## ★ `channelId` 给了就**只起那一个**
   *
   * 界面上「启动/重试」与渠道选择器同处一页 —— 用户在飞书那栏点「重试」
   * 的意图是重试飞书的 kl。不带渠道的话会把已经 ready 的主渠道也走一遍
   * （无害但没用），更要紧的是**失败的那个仍然没被重试**：
   * `failed` 之后不自动重起（那是刻意的，崩溃循环会刷屏），所以必须能
   * 精确地对那一个渠道重试。
   *
   * 不给 = 全部（登录时那条路走它）。
   */
  async ensureReady(channelId?: string): Promise<boolean> {
    return await this.route(
      channelId,
      (service) => service.ensureReady(),
      () => this.ensureAllReady(),
      // 没挂管线 → 起不来（false），而不是"顺手起了主渠道的"
      () => Promise.resolve(false),
    )
  }

  private async ensureAllReady(): Promise<boolean> {
    const primaryReady = await this.primary.ensureReady()
    const sourceReady = await Promise.all(
      this.sources
        .filter((source) => source.enabled())
        .map((source) => source.service.ensureReady()),
    )
    return primaryReady && sourceReady.every(Boolean)
  }

  /** 停服务。★ 与 `ensureReady` 同款按渠道分流（见那里的注释）。 */
  async stop(channelId?: string): Promise<void> {
    await this.route(
      channelId,
      (service) => service.stop(),
      async () => {
        await Promise.all([
          this.primary.stop(),
          ...this.sources.map((source) => source.service.stop()),
        ])
      },
      // 没挂管线 → 本来就没在跑，什么都不用停
      () => Promise.resolve(),
    )
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
    return await this.route(
      channelId,
      (service) => service.rebuildGraph(fresh),
      async () => {
        const results: KlGraphBuildResult[] = [await this.primary.rebuildGraph(fresh)]
        // 顺序执行：两边同时 embedding/抽取会让桌面机持续高负载。
        for (const source of this.sources) {
          if (source.enabled()) results.push(await source.service.rebuildGraph(fresh))
        }
        return combineBuild(results)
      },
      // ★★ 没挂管线 → 什么都不做。`fresh=true` 落回主渠道会**删掉它的图**
      (id) =>
        Promise.resolve({ ok: false, reason: `渠道未就绪：${id}`, entities: 0, facts: 0, edges: 0 }),
    )
  }

  /** 优化图谱。★ 与 `rebuildGraph` 同款按渠道分流（见那里的注释）。 */
  async optimizeGraph(channelId?: string): Promise<KlGraphOptimizeResult> {
    return await this.route(
      channelId,
      (service) => service.optimizeGraph(),
      () => this.optimizeAll(),
      (id) =>
        Promise.resolve({
          ok: false,
          reason: `渠道未就绪：${id}`,
          factEdges: 0,
          entityEdges: 0,
          entityCommunities: 0,
          factCommunities: 0,
        }),
    )
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
    /**
     * ★★ 指名了一个没挂管线的渠道 → **明确不可用**，不落回主渠道。
     *
     * 这里原来的注释写的是"落回主渠道（它是唯一能读的）"，而那会让用户在
     * 飞书那栏看到**钉钉的**图谱规模（实体数、事实数、枢纽实体…）
     * 并以为那是飞书的。与 `facts()` / `ego()` 里修掉的同一个形状。
     *
     * ★ `route` 的 `onAll` 返回 null，由下面那段合并逻辑接手 ——
     * 三分路的判据仍然只有一份（在 `route` 里），这里只是"全部"那一支
     * 的代码太长、不适合塞进回调。
     */
    const single = this.route<KlGraphOverview | null>(
      channelId,
      (service) => service.graphOverview(),
      () => null,
      (id) => ({
        available: false,
        reason: `渠道未就绪：${id}`,
        entities: 0,
        facts: 0,
        edges: 0,
        chunks: 0,
        messages: 0,
        entityTypes: [],
        factTypes: [],
        topEntities: [],
        recentFacts: [],
        buildSchedule: null,
      }),
    )
    if (single !== null) return single
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
