/**
 * 仪表盘的**时序 + 消化漏斗**取数。
 *
 * ## ★★ 为什么它不是 `IngestService.snapshot()` 的一部分
 *
 * 那个快照是**热路径**：`ingest.service.ts` 的 `persist()` 每批采集都发一次。
 * 它已经是 9 个全表 COUNT，而那个文件里记着一次实测教训 —— 逐条触发时
 * 20 万条累计约 21 分钟主进程阻塞（0.29ms@1万行 → 6.31ms@20万行）。
 *
 * 按天分桶**比那些 COUNT 更贵**。本机实测（32,878 行，只读连接）：
 *
 * ```
 * 只按 sent_at 分桶 90 天           →   4ms   （走 idx_msg_sent 覆盖索引）
 * 加 direction/has_media 分桶       → 108ms   （要回表，覆盖索引失效）
 * ChangelogRepository.head()        →   1ms
 * ```
 *
 * 108ms 按同比例外推，20 万条时约 650ms 一次。塞进快照等于给每一批采集
 * 加半秒阻塞 —— 那是重演一个已经修过的 bug。
 *
 * 所以：**独立通道 + 按 changelog head 缓存**。head 没动 → 数据没动 →
 * 直接返回上次那份（1ms 判定）。
 *
 * ## 这一层不做的事
 *
 * 只有 SELECT。不采集、不建图、不写库。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Clock, Logger } from "@mycontext/kernel"
import {
  ChangelogRepository,
  ConsumerCursorRepository,
  type SqliteDatabase,
} from "@mycontext/store"
import type { DashboardTrends, DashboardTrendsInput } from "@mycontext/ipc-contract"
import { readGraphAggregates, type GraphAggregates } from "./graph-query.service.js"

const MS_PER_DAY = 86_400_000

export interface DashboardTrendsOptions {
  logger: Logger
  clock: Clock
  /**
   * vault 的主库；`null` = 还没挂载（未登录）。
   *
   * ★ 取函数而不是值：vault 跟着登录/切身份挂，而本服务在装配阶段就构造好了
   * —— 与 `GraphQueryOptions.dataDir` 同一个理由（取值的话切身份后读的
   * 还是上一个身份的库，症状是"换了身份，图表还是上一个人的"）。
   */
  db: () => SqliteDatabase | null
  /** kl 的数据目录（图库是它下面的 `knowledge.db`）；空串 = 还没挂载 */
  klDataDir: () => string
  /**
   * 本地时区相对 UTC 的偏移（ms）。
   *
   * ★ 注入而不是在 SQL 里用 `'localtime'`：那个修饰符跟随**进程**时区，
   * 于是同一份库在不同机器上分桶不同、测试也没法固定。
   * 默认取本机偏移；测试传固定值。
   */
  dayOffsetMs?: () => number
  /** 只读图库的打开方式。注入以便测试（真实现要原生模块 + 真图库文件） */
  readGraph?: (path: string, sinceMs: number, dayOffsetMs: number) => GraphAggregates
}

/** 一天的桶（内部形状，含所有计数） */
interface DayBucket {
  at: number
  inbound: number
  outbound: number
  media: number
  chunks: number
}

export class DashboardTrendsService {
  /**
   * 上次结果 + 它对应的 changelog head 与窗口。
   *
   * ★ 缓存键必须**含窗口天数**：同一个 head 下用户切 7/30/90 天要拿到三份
   * 不同的数据。只按 head 缓存的话，切了周期而图不变 —— 那看起来像
   * "周期选择器坏了"。
   */
  private cache: { head: number; days: number; value: DashboardTrends } | null = null

  constructor(private readonly options: DashboardTrendsOptions) {}

  private get offsetMs(): number {
    const custom = this.options.dayOffsetMs
    if (custom !== undefined) return custom()
    /**
     * `getTimezoneOffset()` 返回的是"本地比 UTC 慢多少分钟"（+0800 得 -480），
     * 所以要取反才是"加多少毫秒能把 UTC 时刻搬到本地日历上"。
     * 实测本机（+0800）这样算出 28800000，与 SQLite `'localtime'` 分桶逐日一致。
     */
    return -new Date(this.options.clock.now()).getTimezoneOffset() * 60_000
  }

  /** 图库路径；空串 = 还没挂载（此时 `existsSync("")` 为 false，走降级） */
  private get graphDbPath(): string {
    const dir = this.options.klDataDir()
    return dir === "" ? "" : join(dir, "knowledge.db")
  }

  trends(input: DashboardTrendsInput): DashboardTrends {
    const db = this.options.db()
    if (db === null) return emptyTrends(input.days)

    /**
     * ★ 缓存判定放在最前，且**只做两次极便宜的查询**（head 1ms）。
     * head 与窗口都没变 → 上次那份就是当前答案。
     */
    const head = new ChangelogRepository(db).head()
    const cached = this.cache
    if (cached !== null && cached.head === head && cached.days === input.days) {
      return cached.value
    }

    const value = this.compute(db, input.days, head)
    this.cache = { head, days: input.days, value }
    return value
  }

  private compute(db: SqliteDatabase, windowDays: number, head: number): DashboardTrends {
    const offset = this.offsetMs
    const now = this.options.clock.now()
    /**
     * 窗口的第一天（本地 00:00）。
     *
     * 先把"现在"落到本地日历的当天 00:00，再往前推 `windowDays - 1` 天 ——
     * 于是「近 7 天」含今天共 7 个桶，而不是 8 个。
     */
    const todayStart = Math.floor((now + offset) / MS_PER_DAY) * MS_PER_DAY - offset
    const sinceMs = todayStart - (windowDays - 1) * MS_PER_DAY

    const messageRows = db
      .prepare<
        [number, number, number],
        { at: number; inbound: number; outbound: number; media: number }
      >(
        /**
         * ★ `WHERE sent_at >= ?` 让它走 `idx_msg_sent`（实测
         * `EXPLAIN QUERY PLAN` → `SEARCH messages USING COVERING INDEX
         * idx_msg_sent (sent_at>?)`）。把条件写成对 `sent_at` 的函数
         * （比如 `date(sent_at/1000,...) >= ...`）会让索引失效 → 全表扫。
         *
         * ## ★★★ `CAST(... AS INTEGER)` 不是装饰，少了它整张图恒空
         *
         * better-sqlite3 把 JS 的 `number` 绑成 **`real`**（实测
         * `SELECT typeof(?)` → `real`，即便值是整数 28800000）。
         * 而 SQLite 的 `/` 只要有一边是 real 就做**浮点**除法 ——
         * 于是 `(t + 28800000.0) / 86400000` 得 `20675.657…`，
         * 再乘回来还是原值，那个"取整到当天"的意图**完全失效**。
         *
         * 实测这个 bug 的表现：30 天窗口的 SQL 返回 **16,264 个"天"**
         * （每条消息各自一桶），全部落在窗口外被丢弃，图上是
         * **30 天全 0** —— 而库里有 32,896 条消息。
         *
         * 一个恒空的图 + 不报任何错，正是 CLAUDE.md §4 说的静默降级。
         * 所以除法两侧必须先 `CAST` 成整数。
         */
        `SELECT (CAST((sent_at + ?) / ${MS_PER_DAY} AS INTEGER)) * ${MS_PER_DAY}
                  - CAST(? AS INTEGER) AS at,
                sum(direction = 'inbound')  AS inbound,
                sum(direction = 'outbound') AS outbound,
                sum(has_media)              AS media
           FROM messages
          WHERE sent_at >= ?
          GROUP BY at ORDER BY at`,
      )
      .all(offset, offset, sinceMs)

    const graph = this.readGraph(sinceMs, offset)

    /**
     * ★★ 补齐空洞天。**必须**在服务端做。
     *
     * 本机实测 90 天窗口里只有 79 天有消息（周末与假期）。缺的那 11 天
     * 如果不在数组里，`type="monotone"` 会把缺口两端的点连成一条平滑曲线
     * —— 于是"那几天一条消息都没有"在图上表现为"那几天数据量平稳"。
     * 凭空造出一个不存在的趋势，且不报任何错。
     */
    const byDay = new Map<number, DayBucket>()
    for (let at = sinceMs; at <= todayStart; at += MS_PER_DAY) {
      byDay.set(at, { at, inbound: 0, outbound: 0, media: 0, chunks: 0 })
    }
    /**
     * ★ 落在窗口外的行**丢弃而不是并进边界桶**：夏令时切换那天
     * `sinceMs + n*MS_PER_DAY` 会与库里的桶差一小时，硬塞进最近的桶
     * 会让那一天凭空多出一倍数据。本机时区（+0800）没有夏令时，
     * 但这段代码不该依赖那件事。
     */
    for (const row of messageRows) {
      const bucket = byDay.get(row.at)
      if (bucket === undefined) continue
      bucket.inbound = row.inbound ?? 0
      bucket.outbound = row.outbound ?? 0
      bucket.media = row.media ?? 0
    }
    for (const row of graph?.chunksByDay ?? []) {
      const bucket = byDay.get(row.at)
      if (bucket !== undefined) bucket.chunks = row.count
    }

    const days = [...byDay.values()].sort((a, b) => a.at - b.at)

    const cursors = new ConsumerCursorRepository(db, this.options.clock)
    const messagesTotal = countOf(db, "messages")

    return {
      days,
      funnel: {
        messages: messagesTotal,
        // ★ 图库不可读时后三级给 0，但 `graphAvailable: false` 让 UI 显示 `—`
        units: graph?.units ?? 0,
        unitsByType: graph?.unitsByType ?? [],
        chunks: graph?.funnel.chunks ?? 0,
        facts: graph?.funnel.facts ?? 0,
        entities: graph?.funnel.entities ?? 0,
      },
      graphLag: {
        head,
        /**
         * ★ `build` 与 `export` 必须分开。实测本机 export 到 34,106
         * （只差 36，正常）而 build 停在 2,871 —— 只报一个"图谱落后"
         * 会把人引向错误的排查方向（卡住的是建图，不是导出）。
         */
        build: cursors.get("graph-build")?.ackedSeq ?? 0,
        export: cursors.get("graph-export")?.ackedSeq ?? 0,
      },
      coverage: {
        factsTimestamped: graph?.factsTimestamped ?? { done: 0, total: 0 },
        mediaDownloaded: {
          /**
           * ★ 判据是 `downloaded_at IS NOT NULL` —— "登记了一条资产"与
           * "文件真的在本地"是两件事。实测 2,844 条资产里只有 10 条
           * 有 `path`/`downloaded_at`（0.35%），而界面上只显示 2,844。
           */
          done: countOf(db, "media_assets", "downloaded_at IS NOT NULL"),
          total: countOf(db, "media_assets"),
        },
        communitySummaries: graph?.communitySummaries ?? { done: 0, total: 0, stale: 0 },
      },
      graphAvailable: graph !== null,
      windowDays,
      /**
       * 窗口里**真的有数据**的天数。
       *
       * ★ 与 `windowDays` 分开：用户点「近 90 天」而库里只有 89 天跨度时，
       * 界面要能说"实际覆盖 89 天" —— 否则那张图看起来像最早那天之前
       * 全是 0，而真相是那之前没有采集。
       */
      daysWithData: days.filter((d) => d.inbound + d.outbound > 0).length,
    }
  }

  /**
   * 读图库聚合。**读不到就返回 null**（而不是一堆 0）。
   *
   * ★ 「还没建图」与「建了但一条都没抽到」必须能区分：前者去点建图，
   * 后者要查为什么抽空。把"不知道"返回成"零"会让一个新装的库
   * 看起来像一个坏掉的库。
   */
  private readGraph(sinceMs: number, offset: number): GraphAggregates | null {
    const path = this.graphDbPath
    if (path === "") return null
    /**
     * ★ `existsSync` 只在**用真实现**时判。
     *
     * 注入了 `readGraph` 就说明调用方自己负责"能不能读"（测试替身、
     * 或将来换一个不落地成文件的后端）。在注入之上再判文件存在，
     * 等于让一个本该被替换掉的实现细节继续拦路 —— 那正是这个 seam
     * 要解开的东西（首版就是这么写的，于是替身永远不被调用，
     * 而测试看到的是"图库读不到"）。
     */
    const custom = this.options.readGraph
    if (custom === undefined && !existsSync(path)) return null
    try {
      return (custom ?? readGraphAggregates)(path, sinceMs, offset)
    } catch (error) {
      // 图库在建图中被写、或 schema 还没建全 —— 那不该让整块面板消失
      this.options.logger.debug("读图库聚合失败，图表降级", {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
}

/**
 * 表计数。
 *
 * ★ 表名是**代码里的字面量**，不来自入参 —— 拼进 SQL 的东西必须是常量。
 * `where` 同理。
 */
function countOf(db: SqliteDatabase, table: string, where?: string): number {
  const sql = `SELECT count(*) AS c FROM ${table}${where === undefined ? "" : ` WHERE ${where}`}`
  try {
    return db.prepare<[], { c: number }>(sql).get()?.c ?? 0
  } catch {
    // 表还不存在（迁移没跑完）→ 0，面板照常降级
    return 0
  }
}

/**
 * vault 还没挂载时的空值。
 *
 * ★ `days` 给**空数组**而不是一串 0：一个没登录的应用不该画出一条
 * "90 天都是 0"的曲线 —— 那看起来像采集彻底坏了。UI 据此显示
 * "还没有数据"。
 */
function emptyTrends(windowDays: number): DashboardTrends {
  return {
    days: [],
    funnel: { messages: 0, units: 0, unitsByType: [], chunks: 0, facts: 0, entities: 0 },
    graphLag: { head: 0, build: 0, export: 0 },
    coverage: {
      factsTimestamped: { done: 0, total: 0 },
      mediaDownloaded: { done: 0, total: 0 },
      communitySummaries: { done: 0, total: 0, stale: 0 },
    },
    graphAvailable: false,
    windowDays,
    daysWithData: 0,
  }
}
