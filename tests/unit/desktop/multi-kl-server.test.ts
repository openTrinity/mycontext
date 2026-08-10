import { describe, expect, it, vi } from "vitest"
import type {
  KlGraphBuildResult,
  KlGraphOptimizeResult,
  KlGraphOverview,
  KlServerStatus,
} from "@mycontext/ipc-contract"
import { klGraphOverviewSchema } from "@mycontext/ipc-contract"
import type { KlServerService } from "@main/services/kl-server.service"
import { MultiKlServerService } from "@main/services/multi-kl-server.service"

const status: KlServerStatus = {
  state: "ready",
  reason: null,
  port: 8200,
  building: false,
  networkEgress: true,
  buildProgress: null,
}

function server(channel: string, count: number) {
  const build: KlGraphBuildResult = {
    ok: true,
    reason: null,
    entities: count,
    facts: count * 2,
    edges: count * 3,
  }
  const optimize: KlGraphOptimizeResult = {
    ok: true,
    reason: null,
    factEdges: count,
    entityEdges: count,
    entityCommunities: count,
    factCommunities: count,
  }
  const overview: KlGraphOverview = {
    available: true,
    reason: null,
    entities: count,
    facts: count * 2,
    edges: count * 3,
    chunks: count * 4,
    messages: count * 5,
    buildSchedule: null,
    entityTypes: [{ type: "Person", count }],
    factTypes: [{ type: "STATUS", count: count * 2 }],
    topEntities: [{ name: "共享项目", type: "Project", mentions: count }],
    recentFacts: [{ text: `${channel}事实`, type: "STATUS", confidence: 0.9, at: count }],
    /** 「这一轮建了多少」—— 每个渠道各有自己的一轮，所以值不同。 */
    lastBuild: {
      entities: count,
      facts: count * 2,
      edges: count * 3,
      unitsDiscovered: count * 6,
      unitsSkipped: 0,
      unitsProcessed: count * 6,
      chunksCreated: count * 4,
    },
  }
  return {
    status: vi.fn(() => status),
    ensureReady: vi.fn(async () => true),
    stop: vi.fn(async () => undefined),
    rebuildGraph: vi.fn(async () => build),
    optimizeGraph: vi.fn(async () => optimize),
    graphOverview: vi.fn(() => overview),
  }
}

describe("MultiKlServerService", () => {
  /**
   * ★★★ 门面返回的 `graphOverview` 必须带**契约要求的全部字段**。
   *
   * ## 这一条锁的是「上游加字段、门面没跟」这个形状
   *
   * `MultiKlServerService` 是我们这侧加的合并层，而 `KlGraphOverview` 的形状
   * 由契约（`packages/ipc-contract`）定、由上游演进。上游加一个必填字段时，
   * 单渠道那条路自动就有（它直接转发 `KlServerService.graphOverview()`），
   * 而**合并路径与"渠道未就绪"那条兜底路径是手写的对象字面量** ——
   * 漏一个字段 typecheck 会报，但那要等到有人跑 typecheck；
   * 而如果那个字段恰好可选，就连 typecheck 都不报，直接静默丢数据。
   *
   * 实测过一次：上游 `1ec1ca4f` 加了 `lastBuild`（「这一轮建了多少」），
   * 两条手写路径都没给 —— 这条门禁就是那次的回归锁。
   *
   * ★ 判据用 zod schema 的键集而不是硬编码字段名：上游再加字段时**自动**
   * 覆盖，不需要有人记得来改这条测试。
   */
  it("★★★ graphOverview 的键集与契约一致（合并路径 + 未就绪兜底）", () => {
    const expected = Object.keys(klGraphOverviewSchema.shape).sort()

    const dingtalk = server("钉钉", 2)
    const feishu = server("飞书", 3)
    const service = new MultiKlServerService(dingtalk as unknown as KlServerService, () => [
      { service: feishu as unknown as KlServerService, enabled: () => true },
    ])

    // ① 合并路径（不给 channelId）
    expect(Object.keys(service.graphOverview()).sort()).toEqual(expected)
    // ② 「那个渠道没挂上」的兜底路径
    expect(Object.keys(service.graphOverview("未挂载的渠道")).sort()).toEqual(expected)
  })

  /**
   * ★★ `lastBuild` 取主渠道那份，**不求和**。
   *
   * 它回答的是"刚刚那次建图的增量"，而各渠道各自建图、各有自己的一轮。
   * 把两个渠道的增量加起来得到的是一个**没有对应任何一次真实建图**的数 ——
   * 用户看到「本轮 +24 个实体」却找不到是哪一次建的。
   *
   * ★ 也不能给 null：那会让主渠道刚建完的增量在多渠道下消失，
   * 而合并路径正是用户的常态视图。
   */
  it("★★ lastBuild 取主渠道那份（求和会得到一个不存在的「一轮」）", () => {
    const dingtalk = server("钉钉", 2)
    const feishu = server("飞书", 3)
    const service = new MultiKlServerService(dingtalk as unknown as KlServerService, () => [
      { service: feishu as unknown as KlServerService, enabled: () => true },
    ])

    const out = service.graphOverview().lastBuild
    // 主渠道 count=2 → entities 2；求和会是 5，给 null 会是 null
    expect(out?.entities).toBe(2)
    expect(out).not.toBeNull()
  })

  it("渠道有数据时分别建图，统计只在上层合并", async () => {
    const dingtalk = server("钉钉", 2)
    const feishu = server("飞书", 3)
    const service = new MultiKlServerService(dingtalk as unknown as KlServerService, () => [
      { service: feishu as unknown as KlServerService, enabled: () => true },
    ])

    const built = await service.rebuildGraph(false)
    expect(dingtalk.rebuildGraph).toHaveBeenCalledOnce()
    expect(feishu.rebuildGraph).toHaveBeenCalledOnce()
    expect(built).toMatchObject({ ok: true, entities: 5, facts: 10, edges: 15 })

    const overview = service.graphOverview()
    expect(overview.messages).toBe(25)
    expect(overview.entityTypes).toEqual([{ type: "Person", count: 5 }])
    expect(overview.topEntities).toEqual([{ name: "共享项目", type: "Project", mentions: 5 }])
  })

  it("飞书还没有数据时不启动也不建空图", async () => {
    const dingtalk = server("钉钉", 2)
    const feishu = server("飞书", 3)
    const service = new MultiKlServerService(dingtalk as unknown as KlServerService, () => [
      { service: feishu as unknown as KlServerService, enabled: () => false },
    ])

    await service.ensureReady()
    await service.rebuildGraph(false)
    expect(dingtalk.ensureReady).toHaveBeenCalledOnce()
    expect(feishu.ensureReady).not.toHaveBeenCalled()
    expect(feishu.rebuildGraph).not.toHaveBeenCalled()
  })
})

/**
 * ## ★★★ 路由不变式：**每个渠道的动作只能打到它自己的 kl**
 *
 * 这一组是这个文件里最重要的部分，因为它守的那件事**反复破了四次**，
 * 而每次的表现都是"不报错、只是打错了对象"：
 *
 * · preload 漏转发 `channelId` → 点飞书的建图，日志里主渠道与飞书各建一次；
 * · 渲染层用页面级 `channelId ?? undefined` → 为 null 时退化成"全建"；
 * · `perChannel` 缺失时的回落卡拿"选中渠道 + 顶层端口"拼出一张假卡
 *   （标着飞书、端口 8200、进度是钉钉那一轮的）；
 * · `facts()` / `ego()` 认不出渠道就静默落回主渠道。
 *
 * 前三条都在**这一层之外**，但这一层是"渠道 → kl 实例"的**唯一裁决点** ——
 * 所以先把它锁死：只要这里成立，错就只可能出在传参上，而传参有
 * `preload-arity.test.ts` 与渲染层那组门禁盯着。
 *
 * ## 判据：断言"另一个渠道**一次都没被调**"
 *
 * 不是断言"目标渠道被调了" —— 那在"两个都调了"时也成立，而"两个都调了"
 * 正是 `fresh=true` 删掉另一个渠道整张图的那个 bug。
 * 所以每条都要反证：`expect(其他.方法).not.toHaveBeenCalled()`。
 */
describe("★★★ 路由：渠道 → 它自己的 kl（每条都反证另一个没被碰）", () => {
  /** 造一个"主渠道 + 飞书"的门面，两边都能数调用次数。 */
  function pair() {
    const primary = server("dingtalk", 10)
    const feishu = server("feishu", 3)
    const service = new MultiKlServerService(
      primary as unknown as KlServerService,
      () => [
        {
          channelId: "feishu",
          service: feishu as unknown as KlServerService,
          // 有数据 —— 否则会走 idle 那条降级，验不到路由
          enabled: () => true,
        },
      ],
      "dingtalk",
    )
    return { service, primary, feishu }
  }

  it("★★★ ensureReady('feishu') 只起飞书", async () => {
    const { service, primary, feishu } = pair()
    await service.ensureReady("feishu")
    expect(feishu.ensureReady).toHaveBeenCalledTimes(1)
    expect(primary.ensureReady).not.toHaveBeenCalled()
  })

  it("★★★ ensureReady('dingtalk') 只起主渠道", async () => {
    const { service, primary, feishu } = pair()
    await service.ensureReady("dingtalk")
    expect(primary.ensureReady).toHaveBeenCalledTimes(1)
    expect(feishu.ensureReady).not.toHaveBeenCalled()
  })

  it("★★★ stop('feishu') 只停飞书（停错渠道会打断另一路的检索）", async () => {
    const { service, primary, feishu } = pair()
    await service.stop("feishu")
    expect(feishu.stop).toHaveBeenCalledTimes(1)
    expect(primary.stop).not.toHaveBeenCalled()
  })

  it("★★★ stop('dingtalk') 只停主渠道", async () => {
    const { service, primary, feishu } = pair()
    await service.stop("dingtalk")
    expect(primary.stop).toHaveBeenCalledTimes(1)
    expect(feishu.stop).not.toHaveBeenCalled()
  })

  it("★★★ 建图('feishu') 只建飞书", async () => {
    const { service, primary, feishu } = pair()
    await service.rebuildGraph(false, "feishu")
    expect(feishu.rebuildGraph).toHaveBeenCalledTimes(1)
    expect(primary.rebuildGraph).not.toHaveBeenCalled()
  })

  /**
   * ★★★ 这一条对应**不可逆的数据丢失**。
   *
   * `fresh=true` 会删掉 knowledge.db + qdrant + 抽取缓存。打错渠道等于
   * 把另一个渠道那几万个 chunk 删了重烧（实测约 3 小时、出网烧 LLM）。
   */
  it("★★★ 重建（fresh=true, 'feishu'）绝不能碰主渠道的图", async () => {
    const { service, primary, feishu } = pair()
    await service.rebuildGraph(true, "feishu")
    expect(feishu.rebuildGraph).toHaveBeenCalledWith(true)
    expect(primary.rebuildGraph).not.toHaveBeenCalled()
  })

  it("★★★ 重建（fresh=true, 'dingtalk'）绝不能碰飞书的图", async () => {
    const { service, primary, feishu } = pair()
    await service.rebuildGraph(true, "dingtalk")
    expect(primary.rebuildGraph).toHaveBeenCalledWith(true)
    expect(feishu.rebuildGraph).not.toHaveBeenCalled()
  })

  it("★★ optimizeGraph('feishu') 只优化飞书", async () => {
    const { service, primary, feishu } = pair()
    await service.optimizeGraph("feishu")
    expect(feishu.optimizeGraph).toHaveBeenCalledTimes(1)
    expect(primary.optimizeGraph).not.toHaveBeenCalled()
  })

  it("★★ graphOverview('feishu') 读飞书的图库", () => {
    const { service, primary, feishu } = pair()
    service.graphOverview("feishu")
    expect(feishu.graphOverview).toHaveBeenCalledTimes(1)
    expect(primary.graphOverview).not.toHaveBeenCalled()
  })

  /**
   * ★★★ 指到一个**没挂管线**的渠道时：什么都不做，且**明确报未就绪**。
   *
   * 这是最容易写成"落回主渠道"的分支（`find` 返回 undefined 之后顺着往下走）
   * —— 而那会让一次针对飞书的重建把主渠道的图删了。
   */
  it("★★★ 未挂载的渠道：不碰任何 kl，且返回未就绪", async () => {
    const { service, primary, feishu } = pair()
    const result = await service.rebuildGraph(true, "unknown-channel")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("unknown-channel")
    expect(primary.rebuildGraph).not.toHaveBeenCalled()
    expect(feishu.rebuildGraph).not.toHaveBeenCalled()
  })

  /**
   * ★★ `perChannel` 里每个渠道的**端口**必须是它自己的。
   *
   * 实测撞到过界面显示「飞书 · 8200」而 8200 是主渠道的端口。
   * 这条直接锁死"渠道 ↔ 端口"的对应关系。
   */
  it("★★ perChannel 的端口逐渠道对应（不能串）", () => {
    const primary = server("dingtalk", 10)
    const feishu = server("feishu", 3)
    // 两边给不同端口 —— 串了就能看出来
    primary.status = vi.fn(() => ({ ...status, port: 8200 }))
    feishu.status = vi.fn(() => ({ ...status, port: 8201 }))
    const service = new MultiKlServerService(
      primary as unknown as KlServerService,
      () => [
        {
          channelId: "feishu",
          service: feishu as unknown as KlServerService,
          enabled: () => true,
        },
      ],
      "dingtalk",
    )

    const rows = service.status().perChannel ?? []
    expect(rows.find((row) => row.channelId === "dingtalk")?.port).toBe(8200)
    expect(rows.find((row) => row.channelId === "feishu")?.port).toBe(8201)
    // ★ 主渠道那条永远在（渲染层的回落分支依赖这一点）
    expect(rows.length).toBe(2)
  })

  /**
   * ★ 不给渠道时才是"全部"（自动建图那条路走它）——
   * 上面那些修复不能把这条也改掉。
   */
  it("★ 不指定渠道 → 两边都建（自动建图那条路）", async () => {
    const { service, primary, feishu } = pair()
    await service.rebuildGraph(false)
    expect(primary.rebuildGraph).toHaveBeenCalledTimes(1)
    expect(feishu.rebuildGraph).toHaveBeenCalledTimes(1)
  })
})

/**
 * ## ★★★ 查询与推送必须是**同一份**状态
 *
 * 渲染层拿 kl 状态的方式是"首帧查一次 + 之后全靠 `onStatus` 推送"
 * （`useKlServerStatus`）。这意味着**推送**才是长期生效的那一份 ——
 * 而它曾经来自另一个对象：
 *
 * · 查询走 `MultiKlServerService.status()` → 有 `perChannel`（两条）；
 * · 推送走 `KlServerService.pushStatus()` → `this.status()`，**没有** `perChannel`。
 *
 * 于是界面在第一次状态变化后就退化成"只有一个渠道"，并落进渲染层的
 * 缺失回落分支 —— 实测显示成一张「飞书 · 就绪 · 8200」的卡
 * （标签是飞书、端口是主渠道的）。用户报了这个，而排查绕了几轮，
 * 因为**渲染层的代码是对的**，错的是它收到的数据来自谁。
 *
 * 这条门禁锁的是"合并状态里一定有 perChannel 且渠道齐全" ——
 * 也就是推送源必须交出这一份。接线那侧（`mergedStatus`）由
 * `spawn-wiring` 那类装配门禁与真机日志覆盖。
 */
describe("★★★ 推送给渲染层的状态必须带 perChannel", () => {
  it("★★★ 合并状态含全部渠道（推送源交出的就是这一份）", () => {
    const primary = server("dingtalk", 10)
    const feishu = server("feishu", 3)
    const service = new MultiKlServerService(
      primary as unknown as KlServerService,
      () => [
        {
          channelId: "feishu",
          service: feishu as unknown as KlServerService,
          enabled: () => true,
        },
      ],
      "dingtalk",
    )

    const merged = service.status()
    /**
     * ★ 判据是"字段存在且渠道齐全"。
     *
     * `perChannel` 在契约里是 optional（为了兼容旧主进程），所以
     * "推了一份没有它的状态"在类型上完全合法 —— 那正是这个 bug 能存在的原因。
     * 断言必须显式检查它不是 undefined。
     */
    expect(merged.perChannel).toBeDefined()
    expect(merged.perChannel?.map((row) => row.channelId).sort()).toEqual(["dingtalk", "feishu"])
  })
})
