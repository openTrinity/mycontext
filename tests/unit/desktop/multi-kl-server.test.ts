import { describe, expect, it, vi } from "vitest"
import type {
  KlGraphBuildResult,
  KlGraphOptimizeResult,
  KlGraphOverview,
  KlServerStatus,
} from "@mycontext/ipc-contract"
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
