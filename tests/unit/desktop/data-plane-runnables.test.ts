/**
 * `runCycle` 的**外部驱动**消费者接线（修 G12）。
 *
 * ## ★★★ 这个文件锁的是什么
 *
 * `CONSUMERS` 声明了 7 个消费者，而 `runSharedConsumersOnce` 原来只驱动
 * **3 个**。另外三个各自跑在别处的定时器里 —— 于是它们声明的 `dependsOn`
 * **没有执行力**：依赖闸在 `OutboxConsumer` 里，而那三个都不是。
 *
 * 三条断言，每条对应一个真实的失败模式：
 *
 * ① **不该干活时立刻返回**（两个 0）—— 否则 `runCycle` 每 2 分钟一轮，
 *    而建图是小时级的；
 * ② **`runOnce()` 不许 await 到建图完成** —— `runCycle` 是顺序执行的，
 *    堵两小时会让 `local-index-fts`（`required: true`）也停住；
 * ③ **上游没注册时不报"在等"** —— 那说明这套部署没起 kl 服务，
 *    报了会让状态页显示一个永远解除不了的等待。
 */
import { describe, expect, it, vi } from "vitest"
import { createLogger } from "@mycontext/kernel"
import {
  createGraphBuildRunnable,
  createGraphExportRunnable,
  createWorkLayerRunnable,
  type GraphSyncLike,
  type WorkLayerLike,
} from "../../../apps/desktop/src/main/services/data-plane-runnables.js"

const logger = createLogger("test", { level: "error" })

/** 一个可控的假 sync。★ 只实现 runnable 真的会调的四个方法。 */
function fakeSync(overrides: Partial<GraphSyncLike> = {}): GraphSyncLike {
  return {
    tickGraphSync: () => Promise.resolve(),
    exportedSeq: () => 0,
    builtSeq: () => 0,
    graphBusy: () => false,
    ...overrides,
  }
}

describe("graph-export runnable", () => {
  it("★★ 导出没推进 → processed 0 / skipped 0（与「出错了」可区分）", async () => {
    /**
     * `runCycle` 只在"真有话说"时记日志（两个 0 就跳过）。所以跑空一轮
     * **必须**是两个 0 —— 报 `skipped: 1` 会让日志每 2 分钟刷一条，
     * 而那会把真正的异常淹掉。
     */
    const report = await createGraphExportRunnable(fakeSync(), logger).runOnce()
    expect(report.processed).toBe(0)
    expect(report.skipped).toBe(0)
  })

  it("★★ 导出推进了 → processed 报**推进了多少 seq**（与别的消费者同口径）", async () => {
    let seq = 100
    const sync = fakeSync({
      exportedSeq: () => seq,
      tickGraphSync: () => {
        seq = 140
        return Promise.resolve()
      },
    })
    const report = await createGraphExportRunnable(sync, logger).runOnce()
    expect(report.processed).toBe(40)
    expect(report.ackedSeq).toBe(140)
  })

  it("★★★ 导出抛错 → skipped 1 而不是往上抛（一个远程消费者不该打断整轮）", async () => {
    /**
     * `runCycle` 自己也有一层错误隔离，但在这一层记能带上**是哪个消费者**。
     * 而 `skipped: 1` 与"没数据"（两个 0）可区分 —— 那是排查时第一个要问的。
     */
    const sync = fakeSync({ tickGraphSync: () => Promise.reject(new Error("boom")) })
    const report = await createGraphExportRunnable(sync, logger).runOnce()
    expect(report.skipped).toBe(1)
    expect(report.processed).toBe(0)
  })
})

describe("graph-build runnable：依赖闸手写在这里（它不是 OutboxConsumer）", () => {
  it("★★★ 建图落后于导出 → 报「在等 graph-export」", () => {
    const sync = fakeSync({ exportedSeq: () => 500, builtSeq: () => 120 })
    return createGraphBuildRunnable(sync)
      .runOnce()
      .then((report) => {
        expect(report.waitingForUpstream).toBe("graph-export")
        expect(report.ackedSeq).toBe(120)
      })
  })

  it("★★★ 导出游标是 0（kl 服务没起）→ **不报**在等（否则是个解除不了的等待）", async () => {
    /**
     * `graph-export` 由 kl 服务侧推进；没起服务时它压根不注册，游标是 0。
     * 那时报"建图在等导出"会让状态页显示一个永远解除不了的等待 ——
     * 而真相是"这套部署没有图谱这一路"。
     *
     * ★ 这一条与 `consumer.ts` 里"上游没注册就不夹"是同一条判据。
     */
    const report = await createGraphBuildRunnable(
      fakeSync({ exportedSeq: () => 0, builtSeq: () => 0 }),
    ).runOnce()
    expect(report.waitingForUpstream).toBeNull()
  })

  it("★★ 追平了 → 不报在等（「到达上界」不等于「被上界挡住」）", async () => {
    const report = await createGraphBuildRunnable(
      fakeSync({ exportedSeq: () => 500, builtSeq: () => 500 }),
    ).runOnce()
    expect(report.waitingForUpstream).toBeNull()
  })

  it("★★ 建图正忙 → skipped 1（「在建」与「没开始」必须可区分）", async () => {
    const report = await createGraphBuildRunnable(
      fakeSync({ exportedSeq: () => 500, builtSeq: () => 500, graphBusy: () => true }),
    ).runOnce()
    expect(report.skipped).toBe(1)
  })

  it("★★★ runOnce **不调** tickGraphSync（建图不许把整轮堵住）", async () => {
    /**
     * ## 这一条防的是最贵的那个失败模式
     *
     * `runCycle` 是**顺序**执行的（依赖要求下游看到上游这一轮的结果）。
     * 所以一个 await 到建图完成的 `runOnce()` 会把整轮堵住两小时 ——
     * 而 `local-index-fts` 排在同一轮里，且它 `required: true`
     * （落后时 changelog 历史不能裁）。
     *
     * 也就是说：一次建图会让**全文索引停两小时**，而用户看到的是"搜不到
     * 刚才那条消息"。
     *
     * ★ 断言的是"这个 runnable 只读游标、不触发任何动作" ——
     * 真正的建图仍由 `FeedService` 的定时器起（那条路是异步的）。
     */
    const tick = vi.fn(() => Promise.resolve())
    await createGraphBuildRunnable(fakeSync({ tickGraphSync: tick })).runOnce()
    expect(tick).not.toHaveBeenCalled()
  })
})

describe("distill-work runnable", () => {
  const fakeWork = (overrides: Partial<WorkLayerLike> = {}): WorkLayerLike => ({
    refreshWorkLayer: () => Promise.resolve(),
    workSeq: () => 0,
    ...overrides,
  })

  it("★★★ 建图正忙 → 整轮让路 + 报「在等 graph-build」", async () => {
    /**
     * 实测：建图用 12 并发打同一个 LLM 网关时，playbook 归纳这条路
     * **必然** HTTP 524（Cloudflare 前置，源站 100s 内没返回）。
     * 两边抢同一个网关，而归纳是单次长请求 —— 它必然是输的那一方。
     *
     * ★ 而它必须报"在等 graph-build"而不是静默返回：否则
     * 「work 层在等建图」与「work 层没进展」在状态页上同形，
     * 而两者的出路完全不同。
     */
    const refresh = vi.fn(() => Promise.resolve())
    const report = await createWorkLayerRunnable(
      fakeWork({ refreshWorkLayer: refresh }),
      fakeSync({ graphBusy: () => true }),
      logger,
    ).runOnce()
    expect(refresh).not.toHaveBeenCalled()
    expect(report.waitingForUpstream).toBe("graph-build")
    expect(report.skipped).toBe(1)
  })

  it("★★ 不忙 → 调一次 refresh，processed 报推进了多少", async () => {
    let seq = 10
    const report = await createWorkLayerRunnable(
      fakeWork({
        workSeq: () => seq,
        refreshWorkLayer: () => {
          seq = 25
          return Promise.resolve()
        },
      }),
      fakeSync(),
      logger,
    ).runOnce()
    expect(report.processed).toBe(15)
    expect(report.ackedSeq).toBe(25)
  })

  it("★★ refresh 抛错 → skipped 1 + 保留原来的 ackedSeq（不报成 0）", async () => {
    /**
     * ★ `ackedSeq` 必须保留真实值：报 0 会让状态页显示"work 层退回原点"，
     * 而它其实只是这一轮失败了 —— 那两件事在界面上完全不同。
     */
    const report = await createWorkLayerRunnable(
      fakeWork({ workSeq: () => 88, refreshWorkLayer: () => Promise.reject(new Error("x")) }),
      fakeSync(),
      logger,
    ).runOnce()
    expect(report.skipped).toBe(1)
    expect(report.ackedSeq).toBe(88)
  })
})
