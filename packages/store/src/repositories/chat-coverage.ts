/**
 * 聊天的覆盖面记账 —— 回答「这段日期我到底有多少 / 齐没齐」。
 *
 * ## ★★★ 这里**没有**「共需多少」那个分母，而且不能有
 *
 * 渠道 API 不提供"某会话某天共有多少条"（`packages/channels/src/types.ts`
 * 只有 `hasMore` / `nextCursor`）。所以百分比只能靠编，而这个项目已经因为
 * 编分母吃过一次（仪表盘那句假的「才学了 0.0%」）。
 *
 * 这张表只存能观测到的三件事，判据因此落在 `drained` 上：
 *
 * · `drained = 1` → 这一天翻到了 `hasMore=false`，`localCount` **就是**全部；
 * · `drained = 0` → 还在回溯，`localCount` 是**下界**。
 *
 * 两种情况必须让界面能说出不同的话（「已采完 N 条」/「已采到 N 条，还在回溯」），
 * 而不是把同一个可疑的数字画成进度条。
 *
 * ## 与 `MinutesCoverageRepository` 的两处**刻意不同**
 *
 * ① 那张表一个渠道一行、每轮整体覆盖；这张按 `(会话, 天)`，一轮只动碰到的那些行。
 * ② `localCount` 用**累加**而不是覆盖 —— 一天的消息会跨多轮采进来
 *    （回溯翻页 + 实时流），每轮覆盖会让计数在轮次之间反复跳回小值。
 *    `drained` 与 `listedTotal` 仍然覆盖：它们是"这一轮的结论"。
 */
import type { SqliteDatabase } from "../database.js"

/** 一天 + 一个会话的覆盖情况。 */
export interface ChatCoverageRow {
  conversationExternalId: string
  /** `YYYY-MM-DD`（写入侧按本地时区算好，读侧不再换算） */
  dayBucket: string
  /** 库里这一天有多少条（真值） */
  localCount: number
  /** 渠道这一轮列了多少条。`null` = 这一轮没走列表（只有实时流） */
  listedTotal: number | null
  /** true = 这一天已抽干，`localCount` 就是全部 */
  drained: boolean
  updatedAt: number
}

/** 按天聚合的覆盖情况（跨会话）。界面上「这段日期」那一行读的是它。 */
export interface ChatCoverageDay {
  dayBucket: string
  /** 这一天全部会话合起来有多少条 */
  localCount: number
  /**
   * 这一天**是否全部会话都抽干了**。
   *
   * ★ 判据是 `MIN(drained)` 而不是 `MAX` —— 有一个会话没齐，这一天就不能
   * 说"齐了"。反过来（用 MAX）会让 91 个会话里 90 个齐了就报"已采完"，
   * 而那正是静默数据缺失的样子。
   */
  drained: boolean
  /** 这一天还有几个会话没抽干（`drained=0`）。0 = 都齐了 */
  pendingConversations: number
}

/**
 * 把一个业务时间戳算成 `YYYY-MM-DD`（**本地时区**）。
 *
 * ★ 提成导出函数而不是让每个调用方写一遍：时区换算错一次，
 * 覆盖面就会整体偏一天，而那种偏差在界面上极难发现（数字都对，
 * 只是归到了隔壁那一天）。写入侧统一用它，读侧不再换算。
 *
 * ★ 用本地时区而不是 UTC：用户说的"8 月 12 日那天的消息"是他所在时区的
 * 那一天。用 UTC 会让晚上 8 点之后的消息归到第二天（东八区），
 * 于是"今天采了多少"与用户自己数的对不上。
 */
export function toDayBucket(at: number): string {
  const date = new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * 库里那一行的形状。
 *
 * ★ 具名接口而不是内联字面量：内联传给 `prepare<>` 时 `.all()` 的返回
 * 推不出元素类型（`row` 会变成隐式 any），而跟随本目录既有做法
 * （`MediaDbRow`）就没这个问题。不用 `as any` 绕 —— 那会盖住真实形状差异。
 */
interface ChatCoverageDbRow {
  conversation_external_id: string
  day_bucket: string
  local_count: number
  listed_total: number | null
  drained: number
  updated_at: number
}

/** 按天聚合的那条查询返回的形状。 */
interface ChatCoverageDayDbRow {
  day_bucket: string
  local_count: number
  all_drained: number
  pending: number
}

/**
 * ★ 具名 mapper 而不是内联箭头函数。
 *
 * `better-sqlite3` 的 `.all()` 不把 `prepare<>` 的行类型透传出来（返回
 * `unknown[]`），所以内联 `(row) => ...` 里的 `row` 是隐式 any。本目录既有
 * 做法（`toMedia`）正是用具名 mapper 把类型补在参数上 —— 那不是风格，
 * 是唯一不写 `as any` 的办法（`as any` 会盖住真实形状差异，CLAUDE.md §6）。
 */
function toDayAgg(row: ChatCoverageDayDbRow): ChatCoverageDay {
  return {
    dayBucket: row.day_bucket,
    localCount: row.local_count,
    drained: row.all_drained === 1,
    pendingConversations: row.pending,
  }
}

function toRow(row: ChatCoverageDbRow): ChatCoverageRow {
  return {
    conversationExternalId: row.conversation_external_id,
    dayBucket: row.day_bucket,
    localCount: row.local_count,
    listedTotal: row.listed_total,
    drained: row.drained === 1,
    updatedAt: row.updated_at,
  }
}

export class ChatCoverageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 累加某个 (会话, 天) 的本地条数。
   *
   * ★ `local_count` 用 `+ excluded` 累加 —— 见类注释②。
   * `listed_total` / `drained` 覆盖：它们是"这一轮的结论"，
   * 而这一轮没抽干就该显示没抽干，即使上一轮抽干过。
   *
   * ★ `listedTotal === null` 时**保留库里的旧值**（`COALESCE`）：
   * 实时流那条路不走列表，它不知道渠道说有多少条 —— 让它把一个
   * 已知的值清成 NULL 就是丢信息。
   */
  bump(
    channelId: string,
    input: {
      conversationExternalId: string
      dayBucket: string
      delta: number
      listedTotal?: number | null
      drained?: boolean
      at: number
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO chat_coverage
           (channel_id, conversation_external_id, day_bucket,
            local_count, listed_total, drained, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, conversation_external_id, day_bucket) DO UPDATE SET
           local_count = chat_coverage.local_count + excluded.local_count,
           listed_total = COALESCE(excluded.listed_total, chat_coverage.listed_total),
           drained = excluded.drained,
           updated_at = excluded.updated_at`,
      )
      .run(
        channelId,
        input.conversationExternalId,
        input.dayBucket,
        input.delta,
        input.listedTotal ?? null,
        input.drained === true ? 1 : 0,
        input.at,
      )
  }

  /**
   * 只把某个 (会话, 天) 标成抽干 / 没抽干，不动计数。
   *
   * 翻页翻到 `hasMore=false` 那一刻要记的就是这个，而那时不该再加一遍条数
   * （条数在写消息时已经累加过了）。
   */
  markDrained(
    channelId: string,
    input: {
      conversationExternalId: string
      dayBucket: string
      drained: boolean
      listedTotal?: number | null
      at: number
    },
  ): void {
    this.bump(channelId, {
      conversationExternalId: input.conversationExternalId,
      dayBucket: input.dayBucket,
      delta: 0,
      ...(input.listedTotal === undefined ? {} : { listedTotal: input.listedTotal }),
      drained: input.drained,
      at: input.at,
    })
  }

  /**
   * 从 `messages` 表重建计数（**幂等**）。
   *
   * ## ★★★ 为什么必须有这个，而不能只靠采集时累加
   *
   * `bump()` 只在**新消息写进库**那一刻累加。而实测（本机真库）：
   * 62 个连续采集页全是 `changed:0 / unchanged:51` —— 历史早就采完了，
   * 回溯只是在重读同一批消息，`persistBatch` 全部判重。
   *
   * 也就是说只有累加的话，`local_count` 对**存量数据永远是 0**，
   * 界面会说"这段日期 0 条"，而库里有 36296 条。用户问的是
   * 「已经有了多少」——那必须包含已经采到的，不是只包含以后新来的。
   *
   * ★ 用 `INSERT ... ON CONFLICT ... SET local_count = excluded.local_count`
   * （覆盖而不是累加）：这里的值是从 `messages` **数出来的真值**，
   * 重跑一次结果相同。累加的话每次重建都会翻倍。
   *
   * ★ 不动 `drained` / `listed_total`：那两个是采集侧的结论，
   * 重建计数这件事不该顺手改掉它们（`COALESCE` 保留既有值）。
   *
   * ★ `day_bucket` 用 SQLite 的 `localtime` 修饰符算 —— 必须与
   * `toDayBucket()`（JS 本地时区）落在同一天，否则同一条消息在两条路上
   * 会被归到不同的天，而两个数字都"看起来对"。
   */
  rebuildFromMessages(channelId: string, at: number): number {
    const result = this.db
      .prepare(
        `INSERT INTO chat_coverage
           (channel_id, conversation_external_id, day_bucket, local_count, listed_total, drained, updated_at)
         SELECT m.channel_id,
                c.external_id,
                date(m.sent_at / 1000, 'unixepoch', 'localtime'),
                count(*),
                NULL,
                0,
                ?
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE m.channel_id = ?
          GROUP BY c.external_id, date(m.sent_at / 1000, 'unixepoch', 'localtime')
         ON CONFLICT(channel_id, conversation_external_id, day_bucket) DO UPDATE SET
           local_count = excluded.local_count,
           listed_total = COALESCE(chat_coverage.listed_total, excluded.listed_total),
           updated_at = excluded.updated_at`,
      )
      .run(at, channelId)
    return result.changes
  }

  /**
   * 把一段日期标成「列表已抽干」。
   *
   * ## ★★★ 为什么是按**天**而不是按 (会话, 天)
   *
   * 回溯的窗是**全局时间窗**（跨所有在范围内的会话一起翻），所以
   * "这个窗抽干了"是一句关于**日期**的话，不是关于某个会话的话。
   * 硬塞成 per-conversation 就要求调用方回答"哪些会话齐了"——
   * 而那个信息在窗抽干这一刻并不存在（没出现的会话可能是那天真的没消息，
   * 也可能是它压根不在这一页里）。
   *
   * 所以这里只更新**已有行**（`UPDATE`，不 INSERT）：判据是
   * 「我们有这一天这个会话的数据，且这一天的列表翻完了 → 它齐了」。
   *
   * ★ 一天没有任何行时不凭空造行 —— 那会把"这天没消息"与"这天采完了 0 条"
   * 混成同一个东西，而前者是事实、后者是结论。少一行让界面说"没有数据"，
   * 那是诚实的。
   */
  markDaysDrained(channelId: string, fromDay: string, toDay: string, at: number): number {
    const result = this.db
      .prepare(
        `UPDATE chat_coverage SET drained = 1, updated_at = ?
          WHERE channel_id = ? AND day_bucket >= ? AND day_bucket <= ?`,
      )
      .run(at, channelId, fromDay, toDay)
    return result.changes
  }

  /**
   * 按天聚合，用于界面上「这段日期已有多少」。
   *
   * `fromDay` / `toDay` 是 `YYYY-MM-DD`，闭区间。★ 文本比较对
   * `YYYY-MM-DD` 是正确的字典序（零填充过），所以不需要转时间戳。
   */
  listDays(channelId: string, fromDay: string, toDay: string): ChatCoverageDay[] {
    return this.db
      .prepare<[string, string, string], ChatCoverageDayDbRow>(
        `SELECT day_bucket,
                SUM(local_count) AS local_count,
                MIN(drained) AS all_drained,
                SUM(CASE WHEN drained = 0 THEN 1 ELSE 0 END) AS pending
           FROM chat_coverage
          WHERE channel_id = ? AND day_bucket >= ? AND day_bucket <= ?
          GROUP BY day_bucket
          ORDER BY day_bucket`,
      )
      .all(channelId, fromDay, toDay)
      .map(toDayAgg)
  }

  /**
   * 整段区间的汇总（界面顶部那一行）。
   *
   * ★ 返回 `days` 而不只是总数：「共 12 天里 9 天齐了」比一个百分比诚实，
   * 而且它是**可观测的**（不需要那个拿不到的分母）。
   */
  summarize(
    channelId: string,
    fromDay: string,
    toDay: string,
  ): { localCount: number; days: number; drainedDays: number; pendingConversations: number } {
    const rows = this.listDays(channelId, fromDay, toDay)
    return {
      localCount: rows.reduce((sum, row) => sum + row.localCount, 0),
      days: rows.length,
      drainedDays: rows.filter((row) => row.drained).length,
      pendingConversations: rows.reduce((sum, row) => sum + row.pendingConversations, 0),
    }
  }

  /** 某个会话的逐天明细 —— 「哪个群还没齐」点开之后看的。 */
  listByConversation(channelId: string, conversationExternalId: string): ChatCoverageRow[] {
    return this.db
      .prepare<[string, string], ChatCoverageDbRow>(
        `SELECT * FROM chat_coverage
          WHERE channel_id = ? AND conversation_external_id = ?
          ORDER BY day_bucket`,
      )
      .all(channelId, conversationExternalId)
      .map(toRow)
  }
}
