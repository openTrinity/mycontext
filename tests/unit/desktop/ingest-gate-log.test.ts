/**
 * 「本轮被闸住」的日志：**要有痕迹，但不能刷屏**。
 *
 * ## 为什么需要这一层测试
 *
 * 6 处闸门原本是静默 `return`。于是 blocked / 睡眠期间的日志长这样：
 * 导出照跑、`messages` 一小时纹丝不动、**一条错误都没有** —— 与"真的
 * 没人说话"完全无法区分。实测那 2.5 小时就是这么过去的，定位它得去翻
 * `pmset -g log` 才能发现是睡眠。这正是 CLAUDE.md 第 4 节说的静默降级。
 *
 * 而另一头同样是坑：不节流的话最密的探针（10s 一轮）一小时能刷 360 条
 * 一模一样的行，把真错误淹掉 —— 那等于用噪音问题换掉静默问题。
 *
 * 所以两个方向都要钉住：**第一轮必须有**、**之后要被压住**。
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AppError, createLogger, ManualClock } from "@mycontext/kernel"
import type { ChannelPlugin, ChannelPullPage } from "@mycontext/channels"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"
/** 与 `GATE_LOG_THROTTLE_MS` 同值；写字面量以便那个常量改动时这里会红。 */
const THROTTLE_MS = 5 * 60_000

function emptyPage(): ChannelPullPage {
  return {
    conversations: [],
    messages: [],
    nextCursor: null,
    hasMore: false,
    itemCount: 0,
    rawPayload: "{}",
  }
}

/**
 * 走**真实的落盘日志**而不是 mock logger：这条日志的价值就在于
 * "运维时能在 dws/应用日志里看到"，mock 掉就等于没测到那条路。
 */
function setup(): {
  service: IngestService
  clock: ManualClock
  /** 日志里 `ingest round skipped` 的行（已解析）。 */
  skipped: () => { reason?: string; route?: string; blockedReason?: string }[]
  close: () => void
} {
  const vault = openTestVault()
  const clock = new ManualClock(START)
  const logFile = join(mkdtempSync(join(tmpdir(), "mycontext-gatelog-")), "app.jsonl")
  const plugin = {
    meta: { id: CHANNEL },
    auth: { status: async () => ({ state: "expired" }) },
    ingest: {
      probe: async () => null,
      pull: async () => emptyPage(),
    },
  } as unknown as ChannelPlugin

  const service = new IngestService({
    db: vault.db,
    dbPath: vault.path,
    clock,
    logger: createLogger("test-gate-log", { level: "info", filePath: logFile }),
    plugin,
    autoStart: false,
  })
  service.start()

  return {
    service,
    clock,
    skipped: () => {
      let raw: string
      try {
        raw = readFileSync(logFile, "utf8")
      } catch {
        return []
      }
      return (
        raw
          .split("\n")
          .filter((l) => l.includes("ingest round skipped"))
          // 落盘格式是 `{timestamp, level, category, message, ...fields}`
          // —— fields 摊在顶层，不是嵌在 data 下（见 logger.ts 的 record）。
          .map((l) => JSON.parse(l) as { reason?: string; route?: string; blockedReason?: string })
      )
    },
    close: () => vault.close(),
  }
}

/** 让服务进入 blocked：复核报 expired（refresh token 真过期），救不回来。 */
async function enterBlocked(service: IngestService): Promise<void> {
  // recordError 是私有的 —— 这里刻意从外面调它，因为要测的正是
  // "进了 blocked 之后闸门会不会留痕"，而不是它怎么进去的。
  await (service as unknown as { recordError: (e: unknown) => Promise<void> }).recordError(
    new AppError("SESSION_EXPIRED", "渠道登录已过期，需要重新授权", { retryable: false }),
  )
}

describe("★★ 被闸住的那一轮要在日志里留痕（且节流）", () => {
  it("★★ 睡眠期间跳过：第一轮就写日志，写清原因与哪一路", async () => {
    const h = setup()

    h.service.suspend()
    await h.service.tickPull()

    const rows = h.skipped()
    expect(rows.length).toBe(1)
    expect(rows[0]?.reason).toBe("suspended")
    // 哪一路必须能分辨：否则只知道"有东西被闸了"而不知道是消息还是文档
    expect(rows[0]?.route).toBe("pull")
    h.close()
  })

  it("★★ 节流窗口内的后续轮次不再写（否则 10s 一轮会淹掉真错误）", async () => {
    const h = setup()
    h.service.suspend()

    // 模拟探针节律：窗口内连打 20 轮
    for (let i = 0; i < 20; i += 1) {
      h.clock.advance(10_000)
      await h.service.tickProbe()
    }

    expect(h.skipped().length).toBe(1)
    h.close()
  })

  it("★ 过了节流窗口再写一条（长时间睡眠也要持续可见）", async () => {
    const h = setup()
    h.service.suspend()

    await h.service.tickProbe()
    h.clock.advance(THROTTLE_MS + 1_000)
    await h.service.tickProbe()

    expect(h.skipped().length).toBe(2)
    h.close()
  })

  it("★ 不同路各有自己的名额（睡眠与 blocked 不互相顶掉）", async () => {
    const h = setup()
    h.service.suspend()

    await h.service.tickProbe()
    await h.service.tickPull()

    const routes = h.skipped().map((r) => r.route)
    expect(routes).toContain("probe")
    expect(routes).toContain("pull")
    h.close()
  })

  it("★★ blocked 那一路要带上具体类型（两种的处置完全不同）", async () => {
    const h = setup()
    await enterBlocked(h.service)

    await h.service.tickPull()

    const row = h.skipped().find((r) => r.reason === "blocked")
    expect(row).toBeDefined()
    /**
     * `session_expired`（重新扫码）与 `permission_required`（去来源应用授权）
     * 的处置完全不同 —— 日志里只写"blocked"等于让排查的人再猜一次。
     */
    expect(row?.blockedReason).toBe("session_expired")
    h.close()
  })

  it("★ clearBlocked 之后第一轮重新可见（以为修好了其实没修好，最该看到）", async () => {
    const h = setup()
    await enterBlocked(h.service)
    await h.service.tickPull()
    expect(h.skipped().length).toBe(1)

    // 用户点了「重试」，但其实没修好 —— 下一轮又被闸住
    h.service.clearBlocked()
    await enterBlocked(h.service)
    await h.service.tickPull()

    /**
     * 不清节流表的话这一条会落在上次的 5 分钟窗口里被吞掉 ——
     * 而它恰恰是最该看到的那一条。
     */
    expect(h.skipped().length).toBe(2)
    h.close()
  })
})
