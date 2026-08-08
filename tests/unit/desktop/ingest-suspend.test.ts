/**
 * 睡眠期间不发起新一轮采集（`powerMonitor` 的 suspend/resume）。
 *
 * ## 为什么需要这一层测试
 *
 * macOS 睡眠期间每 16-18 分钟 DarkWake 一次（窗口 2-4 秒）跑维护任务，
 * `setInterval` 在那几秒里**照样触发**。而那时网络还没起来 —— 渠道 CLI 的
 * token 懒惰刷新（access token 只活 2 小时）撞在这里就拿不到 token，
 * 报 `not_authenticated` + exit 2。实测 2026-08-08：13:11:01 DarkWake →
 * 13:11:05 `Entering Sleep`，4 条命令夹在中间全部失败。
 *
 * 所以每一轮睡眠都稳定产出一批注定失败的请求：白烧子进程、污染
 * `lastError`、把退避计数推上去。
 *
 * ## ★★ 自愈那一条是本文件最重要的断言
 *
 * `resume` 不是保证送达的。`suspended` 卡在 true 就是**永久静默停采** ——
 * 正是这次要修的那个 bug 的形状，不能自己再造一个。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import type { ChannelPlugin, ChannelPullPage } from "@mycontext/channels"
import { IngestService } from "@main/services/ingest.service.js"
import { openTestVault } from "../../helpers/vault.js"

const START = 1_700_000_000_000
const CHANNEL = "dingtalk"
/** 与 `SUSPEND_SELF_HEAL_MS` 同值；测试刻意写字面量以便改动时这里会红。 */
const SELF_HEAL_MS = 2 * 60 * 60_000

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

/** 记录渠道被调了几次 —— 断言的是"请求根本没发出去"，不是"某个标志变了"。 */
function setup(): {
  service: IngestService
  clock: ManualClock
  pullCalls: () => number
  probeCalls: () => number
  close: () => void
} {
  const vault = openTestVault()
  const clock = new ManualClock(START)
  let pullCalls = 0
  let probeCalls = 0
  const plugin = {
    meta: { id: CHANNEL },
    auth: { status: async () => ({ state: "unauthorized" }) },
    ingest: {
      probe: async () => {
        probeCalls += 1
        return null
      },
      pull: async () => {
        pullCalls += 1
        return emptyPage()
      },
    },
  } as unknown as ChannelPlugin

  const service = new IngestService({
    db: vault.db,
    clock,
    logger: createLogger("test-suspend", { level: "error" }),
    plugin,
    dbPath: vault.path,
    autoStart: false,
  })
  service.start()
  return {
    service,
    clock,
    pullCalls: () => pullCalls,
    probeCalls: () => probeCalls,
    close: () => vault.close(),
  }
}

describe("★★ 睡眠期间不发起新一轮采集", () => {
  it("★★ suspend 之后 tick 一次请求都不发（DarkWake 窗口里的空转）", async () => {
    const h = setup()

    h.service.suspend()
    await h.service.tickPull()
    await h.service.tickProbe()

    /**
     * 断言渠道调用数而不是返回值：返回 0 也可能是"发了但没数据"，
     * 而这里要证明的是**根本没发**（省的正是那个子进程）。
     */
    expect(h.pullCalls()).toBe(0)
    expect(h.probeCalls()).toBe(0)
    h.close()
  })

  it("resume 之后立刻恢复采集", async () => {
    const h = setup()

    h.service.suspend()
    await h.service.tickPull()
    expect(h.pullCalls()).toBe(0)

    h.service.resume()
    await h.service.tickPull()

    expect(h.pullCalls()).toBe(1)
    h.close()
  })

  it("★ resume 清掉退避（否则开盖后还要空转几轮才有新消息）", async () => {
    const h = setup()

    // 睡眠期间那几次 DarkWake 已经把退避推上去了
    h.service.suspend()
    h.service.resume()

    expect(h.service.snapshot().failedAttempts).toBe(0)
    h.close()
  })

  it("★★ resume 事件丢了 → 超时自愈，不永久停采", async () => {
    const h = setup()

    h.service.suspend()
    // 刚过自愈时限（模拟 resume 从未送达）
    h.clock.advance(SELF_HEAL_MS + 1)
    await h.service.tickPull()

    /**
     * 这一条挡的是"修一个静默停采、造一个新的静默停采"。
     * 两个方向的代价不对称：误判成醒着只是多一批失败请求（已被
     * `recordError` 的复核归成瞬时故障），误判成睡着是不可恢复的。
     */
    expect(h.pullCalls()).toBe(1)
    h.close()
  })

  it("自愈时限内仍然按睡眠处理（不能一超时就放行整个窗口）", async () => {
    const h = setup()

    h.service.suspend()
    h.clock.advance(SELF_HEAL_MS - 1_000)
    await h.service.tickPull()

    expect(h.pullCalls()).toBe(0)
    h.close()
  })

  it("重复 suspend 不刷新起点（否则每次 DarkWake 都续一次命，自愈永不触发）", async () => {
    const h = setup()

    h.service.suspend()
    h.clock.advance(SELF_HEAL_MS - 1_000)
    // DarkWake 里若又来一次 suspend，不能把计时重新归零
    h.service.suspend()
    h.clock.advance(2_000)
    await h.service.tickPull()

    expect(h.pullCalls()).toBe(1)
    h.close()
  })
})
