/**
 * 自动建图的**触发策略**。
 *
 * ## 为什么这些判断值得单测
 *
 * `kl ingest` 是这个项目里最贵的一次操作（实测约 2 小时，其中 83 min 是
 * embedding，见 `auto-build.ts` 文件头那张表）。而它的两个失败方向
 * **都不报错**：
 *
 * · **触发太勤** → embedding 常态跑满，用户只感觉"机器一直很忙"；
 *   kl 的 smart-resume 只在每个 chunk 都已向量化时才跳过 Phase A，
 *   而新消息必然产生新 chunk → Phase A 整个重跑（50 min）。
 * · **触发太少 / 不触发** → 图永远是旧的。实测过：图库停在前一天 18:00
 *   而导出当天 03:24 就更新过，界面上完全看不出来。
 *
 * 两个方向都只有一个纯函数在把关，所以它的每条分支都要锁住。
 */
import { describe, expect, it } from "vitest"
import {
  decideAutoBuild,
  forecastAutoBuild,
  autoBuildBackoffMs,
  AUTO_BUILD_LAG_THRESHOLD,
  AUTO_BUILD_MAX_AGE_MS,
  type AutoBuildInput,
} from "@mycontext/knowledge-feed"

const NOW = 1_785_000_000_000

/**
 * 一个"图已建好、刚建完、没有新数据"的基线 —— 每条用例只改它关心的那一维。
 *
 * ★ `minIntervalMs: 0` —— **刻意关掉冷却**。
 *
 * 这个基线里 `lastBuiltAt` 是"1 分钟前"，而建图有一道默认 1 小时的最小间隔
 * （见 `AUTO_BUILD_MIN_INTERVAL_MS`）。不关掉的话下面每一条用例都会先撞
 * 冷却而 return，于是它们**测不到自己想测的那一维**（阈值、maxAge、forecast）
 * —— 全红，而且红的原因与用例名毫无关系。
 *
 * 冷却本身由 `auto-build-min-interval.test.ts` 专门覆盖：那一组的基线
 * 反过来（显式给冷却），因为它测的正是这一维。
 */
function base(over: Partial<AutoBuildInput> = {}): AutoBuildInput {
  return {
    ackedSeq: 1000,
    lastBuiltSeq: 1000,
    lastBuiltAt: NOW - 60_000,
    now: NOW,
    graphExists: true,
    enabled: true,
    ready: true,
    minIntervalMs: 0,
    ...over,
  }
}

describe("★ 两个硬闸：关了 / 没就绪", () => {
  it("用户关掉自动建图 → 不建，且原因是 disabled", () => {
    const d = decideAutoBuild(base({ enabled: false, graphExists: false, ackedSeq: 10_000 }))
    expect(d.build).toBe(false)
    expect(d.reason).toBe("disabled")
  })

  it("★ 关掉时连「首次」也不建（开关必须真的能关掉它）", () => {
    /**
     * 首次建图在下面是最高优先级 —— 所以要单独锁一条：
     * 开关必须排在它**前面**。反过来的话"关掉自动建图"对一个
     * 还没有图的账号完全无效，而那正是最需要它生效的时候
     * （没配 LLM key 时建图必然失败，静默重试会刷屏）。
     */
    const d = decideAutoBuild(base({ enabled: false, graphExists: false }))
    expect(d.reason).toBe("disabled")
  })

  /**
   * ★ 原因码叫 `build-in-progress` 而不是 `not-ready`。
   *
   * 判据只有一个：上一轮建图还在跑（`!klServer.status().building`）。而实测
   * 一轮 16 分钟、导出 10 分钟一轮 —— 这条会连着刷好几次。叫 `not-ready` 时
   * 那串日志读起来像"kl 起不来"，把人引向查 Python / 查端口，而实际上一切
   * 正常、那一轮正在出结果。一个把人引向错误方向的原因码比没有更糟。
   */
  it("kl 正在建上一轮 → 不建，原因是 build-in-progress（不是笼统的没就绪）", () => {
    const d = decideAutoBuild(base({ ready: false, ackedSeq: 99_999 }))
    expect(d.build).toBe(false)
    expect(d.reason).toBe("build-in-progress")
    // ★ 反证：别再用那个会误导的旧名字
    expect(d.reason).not.toBe("not-ready")
  })
})

describe("★ 首次建图不受攒批阈值约束", () => {
  it("图不存在 + 只有 200 条（远低于阈值）→ 也建", () => {
    /**
     * ★ 这是"引导跑完要能用"那条需求的落点。
     *
     * 一个刚跑完引导、只采了 200 条消息的新用户，如果被"攒够 500 条"
     * 挡住就永远等不到图 —— 而他接着就要用它。那正是"这个功能不能用"
     * 的形态，且没有任何报错。
     */
    const d = decideAutoBuild(
      base({ graphExists: false, lastBuiltSeq: 0, lastBuiltAt: null, ackedSeq: 200 }),
    )
    expect(d.build).toBe(true)
    expect(d.reason).toBe("first-build")
  })

  it("★ 图被清空过（游标还在但图没了）→ 仍算首次", () => {
    /**
     * 判据是 `graphExists` 而不是 `lastBuiltSeq === 0`：
     * "清空重来"会删 knowledge.db，但我们记的水位还在。
     * 只看水位的话那种情况永远不自动重建。
     */
    const d = decideAutoBuild(base({ graphExists: false, lastBuiltSeq: 5000, ackedSeq: 5000 }))
    expect(d.build).toBe(true)
    expect(d.reason).toBe("first-build")
  })

  it("★ 一条数据都没有时不建（kl 会报「没数据」）", () => {
    const d = decideAutoBuild(
      base({ graphExists: false, lastBuiltSeq: 0, lastBuiltAt: null, ackedSeq: 0 }),
    )
    expect(d.build).toBe(false)
    expect(d.reason).toBe("no-new-data")
  })
})

describe("★ 攒批：攒够条数才建", () => {
  it("刚好到阈值 → 建", () => {
    const d = decideAutoBuild(
      base({ lastBuiltSeq: 1000, ackedSeq: 1000 + AUTO_BUILD_LAG_THRESHOLD }),
    )
    expect(d.build).toBe(true)
    expect(d.reason).toBe("lag-threshold")
    if (d.build) expect(d.newMessages).toBe(AUTO_BUILD_LAG_THRESHOLD)
  })

  it("差一条 → 不建（阈值是真的在挡，不是摆设）", () => {
    const d = decideAutoBuild(
      base({ lastBuiltSeq: 1000, ackedSeq: 1000 + AUTO_BUILD_LAG_THRESHOLD - 1 }),
    )
    expect(d.build).toBe(false)
    expect(d.reason).toBe("below-threshold")
  })

  it("★ 没有新数据 → 不建（哪怕已经很久了）", () => {
    /**
     * 这一条拦的是"每 24h 无条件建一次"。
     *
     * 没有新数据时建图是**纯浪费**：Phase A 会跳过（chunk 都已向量化），
     * 但 Phase B 仍会重跑抽取与建图 —— 几十分钟换一个一模一样的图。
     */
    const d = decideAutoBuild(
      base({ lastBuiltSeq: 1000, ackedSeq: 1000, lastBuiltAt: NOW - 30 * AUTO_BUILD_MAX_AGE_MS }),
    )
    expect(d.build).toBe(false)
    expect(d.reason).toBe("no-new-data")
  })
})

describe("★ 攒批：攒够时间也建（低频用户不该看一张旧图）", () => {
  it("超过 24h 且有新数据 → 建，哪怕只有 3 条", () => {
    const d = decideAutoBuild(
      base({ lastBuiltSeq: 1000, ackedSeq: 1003, lastBuiltAt: NOW - AUTO_BUILD_MAX_AGE_MS }),
    )
    expect(d.build).toBe(true)
    expect(d.reason).toBe("max-age")
    if (d.build) expect(d.newMessages).toBe(3)
  })

  it("差一毫秒 → 不建", () => {
    const d = decideAutoBuild(
      base({ lastBuiltSeq: 1000, ackedSeq: 1003, lastBuiltAt: NOW - AUTO_BUILD_MAX_AGE_MS + 1 }),
    )
    expect(d.build).toBe(false)
    expect(d.reason).toBe("below-threshold")
  })

  it("图在但从没记过建图时刻（lastBuiltAt=null）→ 按「很久了」处理", () => {
    /**
     * 会出现在升级路径上：旧版本手动建过图，但那时还没有这个水位。
     * 当成"很久没建"是对的 —— 有新数据就建一次，之后水位就有了。
     */
    const d = decideAutoBuild(base({ lastBuiltSeq: 0, lastBuiltAt: null, ackedSeq: 3 }))
    expect(d.build).toBe(true)
    expect(d.reason).toBe("max-age")
  })
})

describe("★ 阈值可注入（测试与将来做成设置项都要用）", () => {
  it("给了 lagThreshold 就按它算，不用默认的 500", () => {
    const d = decideAutoBuild(base({ lastBuiltSeq: 1000, ackedSeq: 1010, lagThreshold: 10 }))
    expect(d.build).toBe(true)
    expect(d.reason).toBe("lag-threshold")
  })

  it("给了 maxAgeMs 就按它算", () => {
    const d = decideAutoBuild(
      base({ lastBuiltSeq: 1000, ackedSeq: 1001, lastBuiltAt: NOW - 2000, maxAgeMs: 1000 }),
    )
    expect(d.build).toBe(true)
    expect(d.reason).toBe("max-age")
  })
})

/**
 * ★★ 失败退避。
 *
 * 拦的是一类具体的刷屏：**立即返回**的失败（没装 Python / 没配 key /
 * 导出目录空）几毫秒就回来，不退避的话每 10 分钟一条同样的 warn，
 * 一天 144 条 —— 而用户以为它在建图。
 */
describe("★★ 连续失败要退避", () => {
  it("刚失败过 → 不建，原因是 backoff（与「攒得不够」要分开）", () => {
    const d = decideAutoBuild(
      base({
        graphExists: false,
        ackedSeq: 5000,
        consecutiveFailures: 1,
        lastFailureAt: NOW - 60_000,
      }),
    )
    expect(d.build).toBe(false)
    // ★ 不能是 below-threshold —— 那会让人以为"再攒攒就好了"
    expect(d.reason).toBe("backoff")
  })

  it("退避期满 → 重试", () => {
    const d = decideAutoBuild(
      base({
        graphExists: false,
        ackedSeq: 5000,
        consecutiveFailures: 1,
        lastFailureAt: NOW - autoBuildBackoffMs(1),
      }),
    )
    expect(d.build).toBe(true)
    expect(d.reason).toBe("first-build")
  })

  it("★ 退避排在「首次」之前（否则没配 key 的新账号每轮都重试）", () => {
    /**
     * 这是最常见的失败组合：图还没建过 + 建图总是立刻失败。
     * 退避如果排在首次之后，那个组合就完全不受退避约束。
     */
    const d = decideAutoBuild(
      base({
        graphExists: false,
        lastBuiltSeq: 0,
        lastBuiltAt: null,
        ackedSeq: 200,
        consecutiveFailures: 2,
        lastFailureAt: NOW - 1000,
      }),
    )
    expect(d.reason).toBe("backoff")
  })

  it("退避时长随失败次数递增，并在 2h 封顶（不做无限退避）", () => {
    expect(autoBuildBackoffMs(0)).toBe(0)
    expect(autoBuildBackoffMs(1)).toBe(30 * 60_000)
    expect(autoBuildBackoffMs(2)).toBe(60 * 60_000)
    expect(autoBuildBackoffMs(3)).toBe(2 * 60 * 60_000)
    // 封顶：第 50 次也是 2h —— 配置修好后最多等 2h 自己恢复
    expect(autoBuildBackoffMs(50)).toBe(2 * 60 * 60_000)
  })

  it("成功过一次就没有退避（failures 归零由调用方负责，这里只验 0 的语义）", () => {
    const d = decideAutoBuild(
      base({ graphExists: false, ackedSeq: 200, consecutiveFailures: 0, lastFailureAt: NOW - 1 }),
    )
    expect(d.build).toBe(true)
  })
})

/**
 * 「下次什么时候建」的预测 —— 界面上那个倒计时的数据源。
 *
 * ## 为什么它必须与 `decideAutoBuild` 同源（这是这组用例的重点）
 *
 * 界面自己算触发条件必然与真实判据漂移，而那种偏差**没人查得出来**：
 * 界面说「还差 300 条」而实际条件是另一套，两边都"看起来对"。
 * 所以 `forecastAutoBuild` 内部就调 `decideAutoBuild`，
 * 这里锁住的正是"预测里的 decision 与直接判定完全一致"。
 *
 * ## `etaMs === null` 与 `=== 0` 是两件事
 *
 * 0 = 即将开始；null = **等下去也不会开始**（被关闭 / 正在建 / 没有新数据）。
 * 给一个会走到 0 却什么都不发生的倒计时比不给更糟 —— 用户会一直等。
 */
describe("★ forecastAutoBuild：倒计时与真实判据同源", () => {
  it("decision 与直接调 decideAutoBuild 完全一致", () => {
    for (const over of [
      { enabled: false },
      { ready: false },
      { graphExists: false, ackedSeq: 200 },
      { ackedSeq: 1000 + AUTO_BUILD_LAG_THRESHOLD },
      { ackedSeq: 1001, lastBuiltAt: NOW - AUTO_BUILD_MAX_AGE_MS - 1 },
      { ackedSeq: 1001 },
      { consecutiveFailures: 2, lastFailureAt: NOW - 1_000, ackedSeq: 5000 },
    ]) {
      const input = base(over)
      expect(forecastAutoBuild(input).decision).toEqual(decideAutoBuild(input))
    }
  })

  it("关掉 / 正在建 / 没有新数据 → etaMs 为 null（不是 0）", () => {
    expect(forecastAutoBuild(base({ enabled: false })).etaMs).toBeNull()
    expect(forecastAutoBuild(base({ ready: false })).etaMs).toBeNull()
    // 没有新数据：时间到了也不会建（max-age 那条要求同时有新数据）
    expect(forecastAutoBuild(base({ ackedSeq: 1000 })).etaMs).toBeNull()
  })

  it("已满足条件 → etaMs 为 0（即将开始）", () => {
    const f = forecastAutoBuild(base({ ackedSeq: 1000 + AUTO_BUILD_LAG_THRESHOLD }))
    expect(f.decision.build).toBe(true)
    expect(f.etaMs).toBe(0)
  })

  it("★ 攒得不够 → 倒计时指向「攒够时间」那一刻", () => {
    const builtAt = NOW - 60_000
    const f = forecastAutoBuild(base({ ackedSeq: 1010, lastBuiltAt: builtAt }))
    expect(f.decision.reason).toBe("below-threshold")
    // 距 lastBuiltAt + maxAge 还有多久
    expect(f.etaMs).toBe(builtAt + AUTO_BUILD_MAX_AGE_MS - NOW)
    // 还差多少条也一并给出（两个条件谁先到都可能触发）
    expect(f.messagesToThreshold).toBe(AUTO_BUILD_LAG_THRESHOLD - 10)
  })

  it("★ 退避中 → 倒计时指向下次重试（否则界面上只是「没在建」）", () => {
    const failedAt = NOW - 5 * 60_000
    const f = forecastAutoBuild(
      base({ ackedSeq: 5000, consecutiveFailures: 1, lastFailureAt: failedAt }),
    )
    expect(f.decision.reason).toBe("backoff")
    expect(f.etaMs).toBe(failedAt + autoBuildBackoffMs(1) - NOW)
  })

  it("阈值回显出来，界面不必另写一份", () => {
    const f = forecastAutoBuild(base({ lagThreshold: 42, maxAgeMs: 99_000 }))
    expect(f.lagThreshold).toBe(42)
    expect(f.maxAgeMs).toBe(99_000)
  })
})
