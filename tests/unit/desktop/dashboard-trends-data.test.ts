/**
 * 仪表盘时序与漏斗的**判据**门禁。
 *
 * ## ★ 这一组锁的不是"算得对不对"，是"算错的时候会不会静默"
 *
 * 这一块的每一条判据都对应一个**已经踩过或差点踩到**的静默降级：
 *
 * · 分桶的整数除法（少了 `CAST` 整张图恒空，而不报任何错）；
 * · 空洞天补 0（不补的话缺口被平滑成"平稳"）；
 * · `graphAvailable=false` 与"全 0"的区分（新装的库 vs 坏掉的库）；
 * · 无时间戳的 fact 必须被说出来（54% 会被时序图静默丢掉）。
 *
 * 这些都不会让测试变红、不会让 lint 报错、界面上也看不出来 ——
 * 只有门禁能锁住（与 `dashboard-data.test.ts` 同一个理由）。
 */
import { describe, expect, it } from "vitest"
import type { DashboardTrends } from "@mycontext/ipc-contract"
import {
  GRAPH_LAG_OK,
  GRAPH_LAG_WARN,
  readFactTimestampGap,
  readGraphLag,
  readTrendSummary,
} from "@renderer/features/dashboard/dashboard-data.js"

const MS_PER_DAY = 86_400_000

/** 造一份 trends。默认是一个"健康的小库"，各用例只改自己关心的那部分。 */
function trends(patch: Partial<DashboardTrends> = {}): DashboardTrends {
  return {
    days: [],
    funnel: { messages: 0, units: 0, chunks: 0, facts: 0, entities: 0 },
    graphLag: { head: 0, build: 0, export: 0 },
    coverage: {
      factsTimestamped: { done: 0, total: 0 },
      mediaDownloaded: { done: 0, total: 0 },
      communitySummaries: { done: 0, total: 0, stale: 0 },
    },
    graphAvailable: true,
    windowDays: 30,
    daysWithData: 0,
    ...patch,
  }
}

/** 造 n 天，每天的收/发由回调给（`at` 从一个固定基点起，避免依赖当前时间）。 */
function days(
  n: number,
  fill: (index: number) => { inbound: number; outbound: number; chunks?: number },
): DashboardTrends["days"] {
  const base = 1_780_000_000_000
  return Array.from({ length: n }, (_, i) => {
    const v = fill(i)
    return {
      at: base + i * MS_PER_DAY,
      inbound: v.inbound,
      outbound: v.outbound,
      media: 0,
      chunks: v.chunks ?? 0,
    }
  })
}

describe("周期汇总", () => {
  it("空数据给 null，而不是一份全 0 的汇总", () => {
    /**
     * ★ 「还没有数据」与「有数据但都是 0」必须能区分。
     * 返回全 0 的汇总会让 UI 画出一条贴底的曲线 —— 那看起来像采集坏了，
     * 而真相是还没开始采。
     */
    expect(readTrendSummary(null)).toBeNull()
    expect(readTrendSummary(trends({ days: [] }))).toBeNull()
  })

  it("日均按**有数据的天**算，不按窗口天数", () => {
    /**
     * ★★ 这是这个文件里最容易写错的一条。
     *
     * 一个刚采了 3 天的库选「近 90 天」时，按窗口天数算的日均要除以 90 ——
     * 那个数字既不是他的真实节奏，也不说明任何问题（看起来像"几乎没数据"）。
     */
    const view = readTrendSummary(
      trends({
        days: days(90, (i) =>
          i >= 87 ? { inbound: 50, outbound: 50 } : { inbound: 0, outbound: 0 },
        ),
        daysWithData: 3,
      }),
    )
    // 300 条 / 3 天 = 100，而不是 300/90 = 3
    expect(view?.perDay).toBe(100)
  })

  it("daysWithData 为 0 时日均给 0 而不是 NaN", () => {
    // NaN 会直接进 DOM（显示 "NaN"），而这是一个 0 除 0 的自然结果
    const view = readTrendSummary(
      trends({ days: days(7, () => ({ inbound: 0, outbound: 0 })), daysWithData: 0 }),
    )
    expect(view?.perDay).toBe(0)
    expect(Number.isNaN(view?.perDay)).toBe(false)
  })

  it("数出空洞天 —— 那是「采集断了还是周末」的入口", () => {
    const view = readTrendSummary(
      trends({
        days: days(10, (i) =>
          i % 5 === 0 ? { inbound: 0, outbound: 0 } : { inbound: 10, outbound: 5 },
        ),
        daysWithData: 8,
      }),
    )
    expect(view?.emptyDays).toBe(2)
  })

  it("全空的窗口没有「最忙的一天」", () => {
    /** ★ 最忙那天是 0 条时给 null：显示"最忙 5-12 · 0 条"是句废话且误导 */
    const view = readTrendSummary(
      trends({ days: days(7, () => ({ inbound: 0, outbound: 0 })), daysWithData: 0 }),
    )
    expect(view?.busiest).toBeNull()
  })

  it("最忙那天取收+发之和的峰", () => {
    const view = readTrendSummary(
      trends({
        days: days(5, (i) =>
          i === 2 ? { inbound: 600, outbound: 300 } : { inbound: 10, outbound: 10 },
        ),
        daysWithData: 5,
      }),
    )
    expect(view?.busiest?.count).toBe(900)
    expect(view?.inbound).toBe(640)
    expect(view?.outbound).toBe(340)
  })
})

describe("图谱落后的判据", () => {
  it("head 为 0 时给 null，不是「已追平」", () => {
    /**
     * ★★ 一个**还没有任何数据**的库不该显示"追平了"。
     * `0/0` 在数学上可以说是 100%，但在界面上那句话是假的 ——
     * 它会让一个空库看起来像一个健康的库。
     */
    expect(readGraphLag(trends({ graphLag: { head: 0, build: 0, export: 0 } }))).toBeNull()
  })

  it("追平时 tone=good 且**不说话**", () => {
    /** 正常时不占地方 —— 与这一页其余 ProblemLine 同一个口径 */
    const view = readGraphLag(trends({ graphLag: { head: 1000, build: 1000, export: 1000 } }))
    expect(view?.tone).toBe("good")
    expect(view?.text).toBeNull()
  })

  it("留 5% 给在途：消化 96% 仍算追平", () => {
    /**
     * 建图是批量的，水位天生落后一点。判据太严会天天亮灯，
     * 而一个天天亮灯的仪表盘等于没有仪表盘。
     */
    const view = readGraphLag(trends({ graphLag: { head: 10_000, build: 9_600, export: 10_000 } }))
    expect(view?.tone).toBe("good")
  })

  it("本机实测的那一档（8.4%）判成 bad，且说清「只覆盖一小部分」", () => {
    /**
     * ★★★ 这条用例锚的是**真实数据**：实测 `graph-build.acked_seq = 2871`
     * 而 changelog head = 34142 → 8.4%。
     *
     * 当时界面上：602 个实体、975 条事实，全部显示正常。用户会把那些数字
     * 当成"它了解我的全部"，于是搜不到东西时以为是检索不行 ——
     * 而真正的原因是 91.6% 的聊天还没进图。所以这句话必须点出
     * "下面的数字是局部的"。
     */
    const view = readGraphLag(trends({ graphLag: { head: 34_142, build: 2_871, export: 34_106 } }))
    expect(view?.tone).toBe("bad")
    expect(view?.behind).toBe(31_271)
    expect(view?.text).toContain("8.4%")
    // 必须点出"局部"这件事，否则用户会误读下面的实体/事实数
    expect(view?.text).toMatch(/只覆盖|一小部分/)
  })

  it("按比例而不是按绝对条数 —— 小库与大库两端都成立", () => {
    /**
     * ★ 绝对条数的判据在两端都失效：小库落后 500 条是正常在途，
     * 大库落后 500 条又太宽。同一个比例在两个量级上给同一个结论才对。
     */
    const small = readGraphLag(trends({ graphLag: { head: 100, build: 50, export: 100 } }))
    const large = readGraphLag(trends({ graphLag: { head: 1_000_000, build: 500_000, export: 0 } }))
    expect(small?.tone).toBe(large?.tone)
  })

  it("阈值边界：>=70% 正常、>=30% 警告、更低是坏", () => {
    const at = (ratio: number) =>
      readGraphLag(trends({ graphLag: { head: 1000, build: Math.round(1000 * ratio), export: 0 } }))
        ?.tone
    expect(at(GRAPH_LAG_OK)).toBe("neutral")
    expect(at(GRAPH_LAG_WARN)).toBe("warn")
    expect(at(GRAPH_LAG_WARN - 0.01)).toBe("bad")
  })

  it("build 超过 head 时比例封在 1，不给 >100%", () => {
    // 水位与 head 是两次查询，理论上能看到 build 略超前的瞬时态
    const view = readGraphLag(trends({ graphLag: { head: 1000, build: 1200, export: 0 } }))
    expect(view?.ratio).toBe(1)
    expect(view?.behind).toBe(0)
  })
})

describe("无时间戳的事实必须被说出来", () => {
  it("全都有时间戳时不说话", () => {
    expect(
      readFactTimestampGap(
        trends({
          coverage: {
            factsTimestamped: { done: 975, total: 975 },
            mediaDownloaded: { done: 0, total: 0 },
            communitySummaries: { done: 0, total: 0, stale: 0 },
          },
        }),
      ),
    ).toBeNull()
  })

  it("一条事实都没有时不说话（那是「还没建图」，不是「缺时间戳」）", () => {
    expect(
      readFactTimestampGap(
        trends({
          coverage: {
            factsTimestamped: { done: 0, total: 0 },
            mediaDownloaded: { done: 0, total: 0 },
            communitySummaries: { done: 0, total: 0, stale: 0 },
          },
        }),
      ),
    ).toBeNull()
  })

  it("本机实测的 525/975 要报出条数与比例", () => {
    /**
     * ★★ 实测本机 450 有时间戳 / 975 总数 → 525 条（54%）没有。
     * 任何"事实按时间"的统计都会**静默**丢掉那 525 条 ——
     * 这句话就是那个静默的出口（CLAUDE.md §4）。
     */
    const text = readFactTimestampGap(
      trends({
        coverage: {
          factsTimestamped: { done: 450, total: 975 },
          mediaDownloaded: { done: 0, total: 0 },
          communitySummaries: { done: 0, total: 0, stale: 0 },
        },
      }),
    )
    expect(text).toContain("525")
    expect(text).toContain("54%")
    // 必须说清后果：不计入按时间的统计
    expect(text).toMatch(/不计入|没有时间/)
  })
})
