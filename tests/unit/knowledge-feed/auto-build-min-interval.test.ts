/**
 * 建图的**最小间隔**（成功之后的冷却）。
 *
 * ## 为什么需要这一维
 *
 * 原有三条判据只有「攒够 500 条」与「24h 兜底」，缺的是**成功之后的冷却**。
 * 活跃群里 500 条可能十几分钟就攒够，于是建图被反复触发 —— 而每次建图的
 * 固定成本与"新增了多少"基本无关：全量解析导出目录、把全库结构边读进内存、
 * improve 阶段对全图重算相似度与社区划分（上游目前仍是全量）。
 * 也就是说频繁触发付的几乎是全价。
 *
 * ## ★ 这一组与 `auto-build.test.ts` 的分工
 *
 * 那个文件的基线显式 `minIntervalMs: 0`（关掉冷却），因为它测的是阈值、
 * maxAge、forecast 那几维 —— 不关的话每条都先撞冷却，红的原因与用例名无关。
 *
 * 这一组反过来：**只测冷却**，所以基线显式给冷却。两组各自只动自己那一维。
 */
import { describe, expect, it } from "vitest"
import {
  AUTO_BUILD_LAG_THRESHOLD,
  AUTO_BUILD_MAX_AGE_MS,
  AUTO_BUILD_MIN_INTERVAL_MS,
  decideAutoBuild,
  type AutoBuildInput,
} from "@mycontext/knowledge-feed"

const NOW = 1_785_000_000_000
const HOUR = 60 * 60 * 1000

/** 基线：图已建好、**新数据已过条数阈值**、上次建图就在刚刚。 */
function base(over: Partial<AutoBuildInput> = {}): AutoBuildInput {
  return {
    ackedSeq: 1000 + AUTO_BUILD_LAG_THRESHOLD,
    lastBuiltSeq: 1000,
    lastBuiltAt: NOW - 60_000,
    now: NOW,
    graphExists: true,
    enabled: true,
    ready: true,
    ...over,
  }
}

describe("★★ 冷却挡得住「条数已达标」", () => {
  /**
   * ★★ 本组最重要的一条。
   *
   * 它锁的是 gate 在 `decide()` 里的**位置**：必须排在 `lag-threshold`
   * 判断之前。放到后面的话 `newMessages >= threshold` 会先 return true，
   * 冷却永远不生效 —— 而"不生效"在界面上完全看不出来（建图照常跑，
   * 只是比预期频繁）。所以这条用例刻意让条数**已经达标**。
   */
  it("★★ 条数够了但距上次建图不到 1h → 不建，原因是 min-interval", () => {
    const d = decideAutoBuild(base())
    expect(d.build).toBe(false)
    expect(d.reason).toBe("min-interval")
  })

  it("★ 过了冷却 → 恢复按条数触发", () => {
    const d = decideAutoBuild(base({ lastBuiltAt: NOW - (AUTO_BUILD_MIN_INTERVAL_MS + 1) }))
    expect(d.build).toBe(true)
    expect(d.reason).toBe("lag-threshold")
  })

  it("刚好到冷却边界（差 1ms）→ 仍然挡住", () => {
    const d = decideAutoBuild(base({ lastBuiltAt: NOW - (AUTO_BUILD_MIN_INTERVAL_MS - 1) }))
    expect(d.reason).toBe("min-interval")
  })

  it("冷却可注入（设置项要用）", () => {
    // 自定义 15min：距上次 20min → 该放行
    const d = decideAutoBuild(base({ lastBuiltAt: NOW - 20 * 60_000, minIntervalMs: 15 * 60_000 }))
    expect(d.build).toBe(true)
  })
})

describe("★★ 冷却不该挡住的两件事", () => {
  /**
   * ★★ 首次建图必须立刻建。
   *
   * 新用户跑完引导时 `lastBuiltAt` 是 null；被冷却挡住的话他要等 1 小时
   * 才有图，而在那之前整个产品是空的 —— 那正是"用不了"的形态。
   */
  it("★★ 从没建过（lastBuiltAt=null）→ first-build，不受冷却影响", () => {
    const d = decideAutoBuild(base({ graphExists: false, lastBuiltSeq: 0, lastBuiltAt: null }))
    expect(d.build).toBe(true)
    expect(d.reason).toBe("first-build")
  })

  /**
   * ★ `max-age`（24h 兜底）与冷却是**相反方向**的两条闸：
   * 那条说"最久多久必须建"，这条说"最快多久才允许建"。
   *
   * 24h 天然大于冷却上界（6h），所以两者不冲突 —— 但如果哪天有人把
   * 冷却的上限调到 24h 以上，这条会红，那正是它该红的时候。
   */
  it("★ 超过 24h 且有新数据 → max-age 照样触发（冷却早就过了）", () => {
    const d = decideAutoBuild(
      base({
        ackedSeq: 1003,
        lastBuiltSeq: 1000,
        lastBuiltAt: NOW - AUTO_BUILD_MAX_AGE_MS - HOUR,
      }),
    )
    expect(d.build).toBe(true)
    expect(d.reason).toBe("max-age")
  })

  /**
   * ★ 没有新数据时，原因码要说"没数据"而不是"在冷却"。
   *
   * 两者的下一步不同：前者要等消息进来，后者要等时间过去。
   * 说错了用户会去查采集（以为消息没进来），而实际只需要等。
   */
  it("★ 没有新数据 → no-new-data 优先于 min-interval", () => {
    const d = decideAutoBuild(base({ ackedSeq: 1000, lastBuiltSeq: 1000 }))
    expect(d.reason).toBe("no-new-data")
  })
})

describe("默认值", () => {
  it("默认冷却是 1 小时", () => {
    expect(AUTO_BUILD_MIN_INTERVAL_MS).toBe(HOUR)
  })

  /**
   * ★ 默认冷却必须**远小于** maxAge，否则那条兜底会被冷却压掉。
   * 这条不是重复上面那个用例：它锁的是两个常量之间的关系，
   * 而那个锁的是一次具体判定。
   */
  it("★ 冷却远小于 maxAge（否则 24h 兜底会失效）", () => {
    expect(AUTO_BUILD_MIN_INTERVAL_MS).toBeLessThan(AUTO_BUILD_MAX_AGE_MS)
  })
})
