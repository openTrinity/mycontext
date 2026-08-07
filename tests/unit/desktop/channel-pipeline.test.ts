/**
 * 渠道采集管线的挂载表。
 *
 * ## 这一层测的是"生命周期"，不是"管线里有什么"
 *
 * 三个不变式，每一条都对应一个真实的静默故障：
 *
 * 1. **端口不重号** —— 重号的表现是第二个 kl 起来时 `EADDRINUSE`，
 *    而那条错误落在 Python 的 stderr 里，界面上只显示"图谱不可用"；
 * 2. **中途失败整批回滚** —— 半挂载状态下已建好的那条在跑（占端口、在采集），
 *    而调用方以为这次挂载没成功；
 * 3. **卸载真的把表清空** —— 留在表里的旧句柄会让 UI 显示一个已经不存在
 *    的渠道，且下一次挂载会撞在自己占着的端口上。
 */
import { describe, expect, it, vi } from "vitest"
import { createLogger } from "@mycontext/kernel"
import { ChannelPipelineManager } from "../../../apps/desktop/src/main/bootstrap/channel-pipeline.js"
import type { ChannelPipelineSpec } from "../../../apps/desktop/src/main/bootstrap/channel-pipeline.js"

const logger = createLogger("test-pipeline", { level: "error" })

interface FakeParts {
  channelId: string
  klPort: number
}

/** 记账用的假工厂：谁被造了、谁被拆了、造的时候看到的 spec 是什么。 */
function fakeFactory(
  overrides: {
    failOn?: string
    disposeThrowsOn?: string
  } = {},
) {
  const created: ChannelPipelineSpec[] = []
  const disposed: string[] = []
  const create = (spec: ChannelPipelineSpec) => {
    if (overrides.failOn === spec.channelId) {
      throw new Error(`造不出来：${spec.channelId}`)
    }
    created.push(spec)
    return {
      parts: { channelId: spec.channelId, klPort: spec.klPort } satisfies FakeParts,
      dispose: async () => {
        if (overrides.disposeThrowsOn === spec.channelId) throw new Error("拆不掉")
        disposed.push(spec.channelId)
      },
    }
  }
  return { create, created, disposed }
}

function makeManager(
  factory: { create: (spec: ChannelPipelineSpec) => ReturnType<typeof fakeFactory>["create"] },
  options: { isPortFree?: (port: number) => Promise<boolean>; portScanLimit?: number } = {},
) {
  return new ChannelPipelineManager<FakeParts>({
    logger,
    create: factory.create as never,
    basePort: 8201,
    // 缺省：所有端口都空闲（不去碰真网络栈）
    isPortFree: options.isPortFree ?? (async () => true),
    ...(options.portScanLimit === undefined ? {} : { portScanLimit: options.portScanLimit }),
  })
}

describe("ChannelPipelineManager：挂载与端口分配", () => {
  it("挂两个渠道 → 各拿到不同端口，且都能 get 到", async () => {
    const factory = fakeFactory()
    const manager = makeManager(factory)

    await manager.mount("v1", ["dingtalk", "feishu"])

    expect(manager.vaultId()).toBe("v1")
    expect(manager.portOf("dingtalk")).toBe(8201)
    expect(manager.portOf("feishu")).toBe(8202)
    expect(manager.get("feishu")?.klPort).toBe(8202)
    expect(manager.all().map((item) => item.channelId)).toEqual(["dingtalk", "feishu"])
  })

  it("★ 端口被占 → 跳到下一个（真绑一次的语义，不是 HTTP 探测）", async () => {
    const factory = fakeFactory()
    const busy = new Set([8201, 8202])
    const manager = makeManager(factory, { isPortFree: async (port) => !busy.has(port) })

    await manager.mount("v1", ["feishu"])
    expect(manager.portOf("feishu")).toBe(8203)
  })

  it("★★ 同批已分出去的端口不复用（那个端口上的 kl 还在 warmup，探测会说它空闲）", async () => {
    const factory = fakeFactory()
    // 探测恒说空闲 —— 只有"排掉本批已分配"这条逻辑能防住重号
    const manager = makeManager(factory, { isPortFree: async () => true })

    await manager.mount("v1", ["a", "b", "c"])
    const ports = manager.all().map((item) => item.klPort)
    expect(new Set(ports).size).toBe(3)
    expect(ports).toEqual([8201, 8202, 8203])
  })

  it("扫完上限还没有空端口 → 报错而不是无限扫", async () => {
    const factory = fakeFactory()
    const manager = makeManager(factory, { isPortFree: async () => false, portScanLimit: 4 })

    await expect(manager.mount("v1", ["feishu"])).rejects.toMatchObject({
      code: "CHANNEL_PIPELINE_NO_PORT",
    })
  })

  it("get 未挂载的渠道返回 null（调用方据此降级，不是抛错）", async () => {
    const manager = makeManager(fakeFactory())
    expect(manager.get("feishu")).toBeNull()
    expect(manager.portOf("feishu")).toBeNull()
    expect(manager.vaultId()).toBeNull()
  })
})

describe("★★ ChannelPipelineManager：中途失败要整批回滚", () => {
  it("第二个渠道建失败 → 第一个也拆掉（不留半挂载）", async () => {
    const factory = fakeFactory({ failOn: "feishu" })
    const manager = makeManager(factory)

    await expect(manager.mount("v1", ["dingtalk", "feishu"])).rejects.toThrow(/造不出来/)

    // ★ 关键：已建好的那条必须被拆掉，且挂载表要空
    expect(factory.disposed).toEqual(["dingtalk"])
    expect(manager.all()).toEqual([])
    expect(manager.get("dingtalk")).toBeNull()
    // vaultId 也要清 —— 留着的话调用方会以为挂载成功了
    expect(manager.vaultId()).toBeNull()
  })

  it("回滚后还能重新挂（一次失败不把 Manager 永久卡死）", async () => {
    let fail = true
    const created: string[] = []
    const manager = new ChannelPipelineManager<FakeParts>({
      logger,
      basePort: 8201,
      isPortFree: async () => true,
      create: (spec) => {
        if (fail && spec.channelId === "feishu") throw new Error("第一次失败")
        created.push(spec.channelId)
        return {
          parts: { channelId: spec.channelId, klPort: spec.klPort },
          dispose: async () => undefined,
        }
      },
    })

    await expect(manager.mount("v1", ["dingtalk", "feishu"])).rejects.toThrow()
    fail = false
    await manager.mount("v1", ["dingtalk", "feishu"])
    expect(manager.all()).toHaveLength(2)
    // 第一轮的 dingtalk 也被造过 → 累计 3 次
    expect(created).toEqual(["dingtalk", "dingtalk", "feishu"])
  })

  it("★ 单条 dispose 抛错不影响其余条目从表里移除", async () => {
    const factory = fakeFactory({ disposeThrowsOn: "dingtalk" })
    const manager = makeManager(factory)
    await manager.mount("v1", ["dingtalk", "feishu"])

    await manager.unmount()
    // dingtalk 的 dispose 抛了，但表必须空 —— 留着就是"UI 显示一个不存在的渠道"
    expect(manager.all()).toEqual([])
    expect(factory.disposed).toEqual(["feishu"])
  })
})

describe("ChannelPipelineManager：卸载与重挂", () => {
  it("unmount 后 get 返回 null，且每条的 dispose 都被调过", async () => {
    const factory = fakeFactory()
    const manager = makeManager(factory)
    await manager.mount("v1", ["dingtalk", "feishu"])

    await manager.unmount()
    expect(manager.get("dingtalk")).toBeNull()
    expect(manager.vaultId()).toBeNull()
    // 倒序拆
    expect(factory.disposed).toEqual(["feishu", "dingtalk"])
  })

  it("★ mount 会先幂等卸载（切身份走同一条路，忘了卸就是两套采集同时跑）", async () => {
    const factory = fakeFactory()
    const manager = makeManager(factory)
    await manager.mount("v1", ["dingtalk"])
    await manager.mount("v2", ["dingtalk"])

    expect(factory.disposed).toEqual(["dingtalk"])
    expect(manager.vaultId()).toBe("v2")
    expect(factory.created.map((spec) => spec.vaultId)).toEqual(["v1", "v2"])
  })

  it("unmount 不抛（卸载失败而放弃比丢一条日志严重得多）", async () => {
    const factory = fakeFactory({ disposeThrowsOn: "feishu" })
    const manager = makeManager(factory)
    await manager.mount("v1", ["feishu"])
    await expect(manager.unmount()).resolves.toBeUndefined()
  })
})

describe("ChannelPipelineManager：授权后追加挂载", () => {
  it("mountOne 在已挂 vault 时建一条新的，端口接着往上走", async () => {
    const factory = fakeFactory()
    const manager = makeManager(factory)
    await manager.mount("v1", ["dingtalk"])

    const parts = await manager.mountOne("feishu")
    expect(parts?.klPort).toBe(8202)
    expect(manager.all()).toHaveLength(2)
  })

  it("★ 已挂着的渠道再 mountOne → 返回现有的，不重复建（重新授权会重复触发）", async () => {
    const factory = fakeFactory()
    const manager = makeManager(factory)
    await manager.mount("v1", ["feishu"])

    const again = await manager.mountOne("feishu")
    expect(again?.klPort).toBe(8201)
    expect(factory.created).toHaveLength(1)
  })

  it("★ 还没登录就授权 → 返回 null 且不抛（那是一条正常路径）", async () => {
    const factory = fakeFactory()
    const manager = makeManager(factory)
    await expect(manager.mountOne("feishu")).resolves.toBeNull()
    expect(factory.created).toEqual([])
  })
})

/**
 * ★★ 串行闸。
 *
 * `mount`（登录）与 `mountOne`（设置页新授权）是两个独立触发源，
 * 都可能在对方还没跑完时进来。并发跑的话两条管线会分到同一个端口
 * ——各自探测那一刻端口都还空着——而症状只在"边登录边授权"时出现。
 */
describe("★★ ChannelPipelineManager：并发挂载不重号", () => {
  it("mount 与 mountOne 并发 → 三条管线三个不同端口", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const manager = new ChannelPipelineManager<FakeParts>({
      logger,
      basePort: 8201,
      isPortFree: async () => true,
      create: async (spec) => {
        // 只把第一条卡住，模拟"登录挂载还没跑完，用户就在设置页授权了"
        if (first) {
          first = false
          await gate
        }
        return {
          parts: { channelId: spec.channelId, klPort: spec.klPort },
          dispose: async () => undefined,
        }
      },
    })

    const mounting = manager.mount("v1", ["a", "b"])
    // vaultId 还没设上（闸内还没跑到），所以这一条会被 defer —— 也是正确行为
    const appended = manager.mountOne("c")
    release()
    await mounting
    await appended

    const ports = manager.all().map((item) => item.klPort)
    expect(new Set(ports).size).toBe(ports.length)
  })

  it("★ 一次挂载失败不把闸永久卡死（后续挂载仍会执行）", async () => {
    const factory = fakeFactory({ failOn: "bad" })
    const manager = makeManager(factory)
    await expect(manager.mount("v1", ["bad"])).rejects.toThrow()

    await manager.mount("v1", ["ok"])
    expect(manager.get("ok")).not.toBeNull()
  })

  it("mountOne 在 mount 之后排队（不会读到挂载中途的表）", async () => {
    const factory = fakeFactory()
    const manager = makeManager(factory)
    const order: string[] = []
    const mounting = manager.mount("v1", ["a"]).then(() => order.push("mount"))
    const appended = manager.mountOne("b").then(() => order.push("mountOne"))
    await Promise.all([mounting, appended])
    expect(order).toEqual(["mount", "mountOne"])
  })
})

describe("ChannelPipelineManager：真端口探测", () => {
  it("★ 缺省探测走真 listen —— 被非 HTTP 程序占着的端口也判为不可用", async () => {
    const { createServer } = await import("node:net")
    const { isLocalPortFree } = await import(
      "../../../apps/desktop/src/main/bootstrap/channel-pipeline.js"
    )
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    try {
      // 这个端口上什么 HTTP 都没有（裸 TCP），HTTP 探测会误判成空闲
      await expect(isLocalPortFree(port)).resolves.toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    // 放开之后立刻又是空闲的
    await expect(isLocalPortFree(port)).resolves.toBe(true)
  })

  it("探测本身不泄漏监听（连续探同一个端口都说空闲）", async () => {
    const { isLocalPortFree } = await import(
      "../../../apps/desktop/src/main/bootstrap/channel-pipeline.js"
    )
    const probe = vi.fn(isLocalPortFree)
    await expect(probe(8299)).resolves.toBe(true)
    await expect(probe(8299)).resolves.toBe(true)
  })
})
