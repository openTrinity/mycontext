/**
 * 时序服务的**分桶**门禁。
 *
 * ## ★★ 这个文件存在的直接原因：一个只在真库上才现形的 bug
 *
 * 首版的分桶 SQL 写的是 `((sent_at + ?) / 86400000) * 86400000 - ?`。
 * 看起来对，语法也对，typecheck 与 lint 全过 —— 但它**恒定失效**：
 *
 * better-sqlite3 把 JS 的 `number` 绑成 **`real`**（实测
 * `SELECT typeof(?)` → `real`，即便值是整数 28800000），而 SQLite 的 `/`
 * 只要有一边是 real 就做浮点除法。于是那个"取整到当天"的意图完全没生效，
 * 乘回来还是原值 —— **每条消息各自一个桶**。
 *
 * 实测那次的表现：30 天窗口的 SQL 返回 **16,264 个"天"**，全部落在窗口外
 * 被丢弃，图上是 **30 天全 0**，而库里有 32,896 条消息。
 * 不报错、不告警、不慢 —— 只是图空了。
 *
 * 纯函数测试抓不到它（它是 SQL 与驱动的交互），所以这一组必须跑**真库**。
 */
import { describe, expect, it } from "vitest"
import { createLogger, ManualClock } from "@mycontext/kernel"
import { DashboardTrendsService } from "@main/services/dashboard-trends.service.js"
import type { GraphAggregates } from "@main/services/graph-query.service.js"
import { openTestVault, type TestVault } from "../../helpers/vault.js"

const MS_PER_DAY = 86_400_000
/** +0800，与本机一致。固定值而不是读系统 —— 否则测试结果跟着跑测机器的时区变 */
const OFFSET = 8 * 3_600_000
/** 2026-08-10 12:00 本地。固定基点，用例不依赖"现在" */
const NOW = 1_786_320_000_000

const logger = createLogger("test-dashboard-trends", { level: "error" })

function service(
  vault: TestVault,
  options: { graph?: GraphAggregates | null } = {},
): DashboardTrendsService {
  return new DashboardTrendsService({
    logger,
    clock: new ManualClock(NOW),
    db: () => vault.db,
    // 空串 = 图库没挂载 → `readGraph` 走降级返回 null（除非下面注入）
    klDataDir: () => (options.graph === undefined ? "" : "/fake/kl"),
    dayOffsetMs: () => OFFSET,
    ...(options.graph === undefined || options.graph === null
      ? {}
      : { readGraph: () => options.graph as GraphAggregates }),
  })
}

/** 塞一条消息。只填分桶要用的那几列 —— 值全是编造的（CLAUDE.md §1.2） */
function insertMessage(
  vault: TestVault,
  sentAt: number,
  direction: "inbound" | "outbound",
  hasMedia = false,
): void {
  const id = `msgFAKE${String(sentAt)}${direction}`
  vault.db
    .prepare(
      `INSERT INTO conversations (id, channel_id, external_id, type, created_at)
       VALUES ('convFAKE0001', 'dingtalk', 'cidFAKE0001==', 'group', 0)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run()
  vault.db
    .prepare(
      `INSERT INTO messages
         (id, channel_id, conversation_id, external_id, sent_at, direction, origin, has_media, created_at)
       VALUES (?, 'dingtalk', 'convFAKE0001', ?, ?, ?, 'human', ?, 0)`,
    )
    .run(id, id, sentAt, direction, hasMedia ? 1 : 0)
}

/** 本地某天的 00:00（相对固定基点往前推 n 天） */
function dayStart(daysAgo: number): number {
  const today = Math.floor((NOW + OFFSET) / MS_PER_DAY) * MS_PER_DAY - OFFSET
  return today - daysAgo * MS_PER_DAY
}

describe("按天分桶", () => {
  it("★ 同一天的多条消息落进**同一个**桶（锁住那个浮点除法 bug）", () => {
    const vault = openTestVault()
    // 同一天的三个不同时刻 —— 若除法是浮点的，这三条会各自成桶
    insertMessage(vault, dayStart(1) + 3_600_000, "inbound")
    insertMessage(vault, dayStart(1) + 7 * 3_600_000, "inbound")
    insertMessage(vault, dayStart(1) + 20 * 3_600_000, "outbound")

    const result = service(vault).trends({ days: 7 })
    const bucket = result.days.find((d) => d.at === dayStart(1))

    expect(bucket).toBeDefined()
    expect(bucket?.inbound).toBe(2)
    expect(bucket?.outbound).toBe(1)
    /**
     * ★★ 这一条是那个 bug 的真正判据：**桶数必须等于窗口天数**。
     * 浮点除法下这里会是 7 + 3（每条消息一个额外的桶）或者干脆全是 0。
     */
    expect(result.days).toHaveLength(7)
  })

  it("桶数恒等于窗口天数，且含今天", () => {
    const vault = openTestVault()
    insertMessage(vault, dayStart(0) + 3_600_000, "inbound")

    for (const days of [7, 30, 90]) {
      const result = service(vault).trends({ days })
      expect(result.days).toHaveLength(days)
      // 最后一个桶是今天（「近 7 天」含今天共 7 个，不是 8 个）
      expect(result.days.at(-1)?.at).toBe(dayStart(0))
      expect(result.days[0]?.at).toBe(dayStart(days - 1))
    }
  })

  it("★★ 空洞天补 0，而不是从数组里缺席", () => {
    const vault = openTestVault()
    // 只有第 1 天和第 5 天有数据，中间三天是空的
    insertMessage(vault, dayStart(1) + 3_600_000, "inbound")
    insertMessage(vault, dayStart(5) + 3_600_000, "outbound")

    const result = service(vault).trends({ days: 7 })

    /**
     * ★ 缺的那几天**必须在数组里**（值为 0）。不在的话
     * `type="monotone"` 会把缺口两端连成一条平滑曲线 ——
     * "那几天一条消息都没有"就被画成了"那几天数据量平稳"。
     */
    expect(result.days).toHaveLength(7)
    for (const daysAgo of [2, 3, 4]) {
      const hole = result.days.find((d) => d.at === dayStart(daysAgo))
      expect(hole).toBeDefined()
      expect(hole?.inbound).toBe(0)
      expect(hole?.outbound).toBe(0)
    }
    // 而"有数据的天"只数真的有数据的
    expect(result.daysWithData).toBe(2)
  })

  it("窗口外的消息不进桶（也不并进边界桶）", () => {
    const vault = openTestVault()
    insertMessage(vault, dayStart(0) + 3_600_000, "inbound")
    // 窗口之前很久的一条
    insertMessage(vault, dayStart(60) + 3_600_000, "inbound")

    const result = service(vault).trends({ days: 7 })
    const total = result.days.reduce((sum, d) => sum + d.inbound + d.outbound, 0)
    // 只有窗口内那 1 条；那条老的既不出现也不被塞进第一个桶
    expect(total).toBe(1)
    expect(result.days[0]?.inbound).toBe(0)
    // ★ 但漏斗第一级是**全库**总数，两条都算
    expect(result.funnel.messages).toBe(2)
  })

  it("media 只数带媒体的那些", () => {
    const vault = openTestVault()
    insertMessage(vault, dayStart(1) + 3_600_000, "inbound", true)
    insertMessage(vault, dayStart(1) + 4_600_000, "inbound", false)

    const result = service(vault).trends({ days: 7 })
    const bucket = result.days.find((d) => d.at === dayStart(1))
    expect(bucket?.inbound).toBe(2)
    expect(bucket?.media).toBe(1)
  })
})

describe("图库读不到时的降级", () => {
  it("★ graphAvailable=false，而不是把后几级报成 0 条真结论", () => {
    const vault = openTestVault()
    insertMessage(vault, dayStart(1) + 3_600_000, "inbound")

    const result = service(vault).trends({ days: 7 })

    /**
     * ★★ 「还没建图」与「建了但一条都没抽到」的处置完全不同
     * （前者去点建图，后者要查为什么抽空）。这个布尔是 UI 把后四级
     * 显示成 `—` 而不是 `0` 的唯一依据。
     */
    expect(result.graphAvailable).toBe(false)
    // 采集侧的数字仍然是真的 —— 图库读不到不该影响这一级
    expect(result.funnel.messages).toBe(1)
    // 图上「进了图谱」那条线不画（UI 按 graphAvailable 判），值是 0
    expect(result.days.every((d) => d.chunks === 0)).toBe(true)
  })

  it("图库可读时把聚合数接进漏斗与覆盖度", () => {
    const vault = openTestVault()
    insertMessage(vault, dayStart(1) + 3_600_000, "inbound")

    const result = service(vault, {
      graph: {
        funnel: { chunks: 3409, facts: 975, entities: 602 },
        units: 32_930,
        unitsByType: [
          { type: "message", count: 32_828 },
          { type: "minutes", count: 8 },
          { type: "wiki", count: 94 },
        ],
        factsTimestamped: { done: 450, total: 975 },
        communitySummaries: { done: 4, total: 16, stale: 7 },
        chunksByDay: [{ at: dayStart(1), count: 42 }],
      },
    }).trends({ days: 7 })

    expect(result.graphAvailable).toBe(true)
    expect(result.funnel.units).toBe(32_930)
    // 按类型分类也要透下去（面板用它拼"聊天 N · 会议记录 M · 文档 K"）
    expect(result.funnel.unitsByType).toEqual([
      { type: "message", count: 32_828 },
      { type: "minutes", count: 8 },
      { type: "wiki", count: 94 },
    ])
    expect(result.funnel.facts).toBe(975)
    expect(result.coverage.factsTimestamped).toEqual({ done: 450, total: 975 })
    expect(result.coverage.communitySummaries.stale).toBe(7)
    // chunksByDay 要落到对应那一天的桶上
    expect(result.days.find((d) => d.at === dayStart(1))?.chunks).toBe(42)
  })
})

describe("缓存", () => {
  it("★ head 没变时返回**同一个对象**（不重算）", () => {
    const vault = openTestVault()
    insertMessage(vault, dayStart(1) + 3_600_000, "inbound")
    const svc = service(vault)

    const first = svc.trends({ days: 7 })
    const second = svc.trends({ days: 7 })
    // 同一引用 = 真的命中了缓存，而不是"算出了相等的结果"
    expect(second).toBe(first)
  })

  it("★★ 缓存键含窗口天数 —— 切周期必须拿到新数据", () => {
    const vault = openTestVault()
    insertMessage(vault, dayStart(1) + 3_600_000, "inbound")
    const svc = service(vault)

    const seven = svc.trends({ days: 7 })
    const thirty = svc.trends({ days: 30 })

    /**
     * ★ 只按 head 缓存的话这里会拿到 7 天那一份 —— 表现是"切了周期图不变"，
     * 而那看起来像周期选择器坏了。
     */
    expect(thirty).not.toBe(seven)
    expect(thirty.days).toHaveLength(30)
    expect(seven.days).toHaveLength(7)
  })
})

describe("vault 没挂载（未登录）", () => {
  it("★ days 给**空数组**而不是一串 0", () => {
    const svc = new DashboardTrendsService({
      logger,
      clock: new ManualClock(NOW),
      db: () => null,
      klDataDir: () => "",
      dayOffsetMs: () => OFFSET,
    })
    const result = svc.trends({ days: 30 })

    /**
     * ★★ 一个没登录的应用不该画出一条"30 天都是 0"的曲线 ——
     * 那看起来像采集彻底坏了。空数组让 UI 显示"还没有数据"。
     */
    expect(result.days).toEqual([])
    expect(result.graphAvailable).toBe(false)
    expect(result.daysWithData).toBe(0)
    // 窗口天数仍然回显（UI 的周期选择器要它）
    expect(result.windowDays).toBe(30)
  })
})
