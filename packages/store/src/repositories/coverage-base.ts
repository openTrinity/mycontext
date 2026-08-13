/**
 * 「按 (分区, 天) 记覆盖面」这件事的**共用实现**。
 *
 * ## ★★★ 为什么要抽这一层（而不是让文档那张表再抄一遍 chat 的仓储）
 *
 * `chat_coverage`（v27）与 `document_coverage`（v29）的形状是**同构**的：
 * 一个分区列 + `day_bucket` + `local_count` / `listed_total` / `drained`。
 * 而它们的读写有五处判据，每一处抄错都是一次静默的数字错误：
 *
 * ① `local_count` 用**累加**（一天的数据会跨多轮进来，覆盖会让计数
 *    在轮次之间反复跳回小值）；
 * ② `listed_total` 用 `COALESCE(excluded, 表)` —— 传 null 时**保留**旧值
 *    （实时流那条路不走列表，让它把已知值清成 NULL 就是丢信息）；
 * ③ `drained` **覆盖**（它是"这一轮的结论"）；
 * ④ 按天聚合用 `MIN(drained)` 而不是 `MAX` —— 有一个分区没齐，
 *    这一天就不能说齐了。用 MAX 会让 91 个会话里 90 个齐了就报"已采完"，
 *    而那正是静默数据缺失的样子；
 * ⑤ `markDaysDrained` 只 `UPDATE` 不 `INSERT` —— 一天没有任何行时不凭空造行，
 *    否则"这天没数据"与"这天采完了 0 条"会混成同一个东西。
 *
 * 这五条已经在 chat 那份里踩齐了。让 document 再实现一遍等于给自己五次
 * 犯同样错的机会，而错了都不报错 —— 只是界面上的数字偏了。
 *
 * ## ★★ 为什么是"基类 + 一个分区列名"，而不是一个泛型工具函数
 *
 * 差异**只有两样**：表名、分区列名（`conversation_external_id` /
 * `space_external_id`）。其余 SQL 完全一致。
 *
 * 表名与列名要拼进 SQL，所以不可能用参数绑定 —— 它们必须是子类提供的
 * **常量**。用构造参数传字符串是这个约束下最直白的形状：子类各自一行，
 * 而且 `PARTITION_COLUMNS` 那张白名单让"拼接"不可能拼进外部输入
 * （见 `assertSafeIdentifier`）。
 *
 * ## ★ 为什么不合并成一张物理表（加一列 `kind`）
 *
 * 想过，不行：两张表的**分区语义不同**。聊天按会话翻页（"这个会话齐了"
 * 是一句成立的话），文档按空间翻页（一篇文档没有"翻完"这件事）。
 * 合表之后 `markDaysDrained` 要按 kind 分叉，而"某些行的某列没有意义"
 * 是最容易被读错的形状（v28 的文件头写过同一条）。
 *
 * 共用**行为**、分开**存储**，是这两个约束的唯一交集。
 *
 * ## ★★ 为什么基类的方法叫 `bumpPartition` 而不是 `bump`
 *
 * 子类要用 `bump` / `markDrained` / `listDays` / `summarize` 这几个**公开名字**
 * 暴露各自的语义（`conversationExternalId` / `spaceExternalId`）—— 那是既有
 * 调用方与既有测试用的名字，改了就是一次无谓的破坏性变更。
 *
 * 而 TypeScript 不允许"同名不同签名"的重写（`TS2416`）：子类的
 * `bump(channelId, {conversationExternalId})` 与基类的
 * `bump(channelId, {partitionId})` 参数不兼容。第一版正是这么写的，
 * 11 条既有用例连编译都过不了。
 *
 * 所以基类换名字、子类保持原名。代价是基类方法名略啰嗦，
 * 换来的是**零调用方改动** —— 而这一层本来就不该被外部直接调用
 * （它是 `protected`）。
 */
import type { SqliteDatabase } from "../database.js"

/**
 * 允许作为分区列名的白名单。
 *
 * ★★ 这不是形式主义：这一层要把列名拼进 SQL 字符串（参数绑定绑不了标识符）。
 * 白名单让"拼接"在结构上不可能拼进外部输入 —— 而如果哪天有人把一个
 * 来自配置/请求的字符串传进来，`assertSafeIdentifier` 会抛，
 * 而不是拼出一条注入 SQL。
 */
const PARTITION_COLUMNS = ["conversation_external_id", "space_external_id"] as const
export type PartitionColumn = (typeof PARTITION_COLUMNS)[number]

/** 允许的表名白名单。同上：标识符不能绑定，所以只能白名单。 */
const COVERAGE_TABLES = ["chat_coverage", "document_coverage"] as const
export type CoverageTable = (typeof COVERAGE_TABLES)[number]

function assertSafeIdentifier(table: CoverageTable, column: PartitionColumn): void {
  if (!COVERAGE_TABLES.includes(table)) throw new Error(`覆盖面表名不在白名单里：${table}`)
  if (!PARTITION_COLUMNS.includes(column)) throw new Error(`分区列名不在白名单里：${column}`)
}

/**
 * 把一个业务时间戳算成 `YYYY-MM-DD`（**本地时区**）。
 *
 * ★ 只有一份实现（这里），所有写入侧都调它：时区换算错一次，覆盖面就会
 * 整体偏一天 —— 而那种偏差在界面上极难发现（数字都对，只是归到了隔壁那天）。
 *
 * ★ 用本地时区而不是 UTC：用户说的"8 月 12 日那天"是他所在时区的那一天。
 * 用 UTC 会让东八区晚上 8 点之后的数据归到第二天，于是"今天有多少"
 * 与用户自己数的对不上。
 */
export function toDayBucket(at: number): string {
  const date = new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/** 一天 + 一个分区的覆盖情况。 */
export interface CoverageRow {
  /** 分区键（会话 external_id / 空间 external_id） */
  partitionId: string
  /** `YYYY-MM-DD`（写入侧按本地时区算好，读侧不再换算） */
  dayBucket: string
  /** 库里这一天有多少条（真值） */
  localCount: number
  /** 渠道这一轮列了多少条。`null` = 这一轮没走列表 */
  listedTotal: number | null
  /** true = 这一天已抽干，`localCount` 就是全部 */
  drained: boolean
  updatedAt: number
}

/** 按天聚合（跨分区）。界面上「这段日期」那一行读的是它。 */
export interface CoverageDay {
  dayBucket: string
  localCount: number
  /** ★ `MIN(drained)` 语义：有一个分区没齐，这一天就不算齐（见文件头④） */
  drained: boolean
  /** 这一天还有几个分区没抽干。0 = 都齐了 */
  pendingPartitions: number
}

/** 区间汇总。★ **没有百分比** —— 分母（"共需多少"）在渠道 API 里不存在。 */
export interface CoverageSummary {
  localCount: number
  days: number
  drainedDays: number
  pendingPartitions: number
}

interface CoverageDbRow {
  partition_id: string
  day_bucket: string
  local_count: number
  listed_total: number | null
  drained: number
  updated_at: number
}

interface CoverageDayDbRow {
  day_bucket: string
  local_count: number
  all_drained: number
  pending: number
}

/**
 * ★ 具名 mapper 而不是内联箭头函数：`better-sqlite3` 的 `.all()` 不把
 * `prepare<>` 的行类型透传出来，内联 `(row) => ...` 里的 `row` 是隐式 any。
 * 本目录既有做法（`toMedia`）正是把类型补在具名函数的参数上 ——
 * 那不是风格，是唯一不写 `as any` 的办法（CLAUDE.md §6）。
 */
function toDayAgg(row: CoverageDayDbRow): CoverageDay {
  return {
    dayBucket: row.day_bucket,
    localCount: row.local_count,
    drained: row.all_drained === 1,
    pendingPartitions: row.pending,
  }
}

function toCoverageRow(row: CoverageDbRow): CoverageRow {
  return {
    partitionId: row.partition_id,
    dayBucket: row.day_bucket,
    localCount: row.local_count,
    listedTotal: row.listed_total,
    drained: row.drained === 1,
    updatedAt: row.updated_at,
  }
}

/**
 * 覆盖面仓储的共用实现。子类只提供表名与分区列名。
 *
 * ★ `abstract` 而不是直接导出：一个"随便传表名就能用"的类会诱导别人
 * 拿它去读别的表，而那些表没有这五条判据的语义。
 */
export abstract class CoverageRepositoryBase {
  protected constructor(
    protected readonly db: SqliteDatabase,
    private readonly table: CoverageTable,
    private readonly partitionColumn: PartitionColumn,
  ) {
    assertSafeIdentifier(table, partitionColumn)
  }

  /**
   * 累加某个 (分区, 天) 的本地条数。
   *
   * ★ `local_count` 用 `+ excluded` **累加** —— 一天的数据会跨多轮进来
   * （回溯翻页 + 实时流），每轮覆盖会让计数在轮次之间反复跳回小值。
   * ★ `listed_total` 传 null 时保留旧值（`COALESCE`）：实时流那条路不走列表，
   * 它不知道渠道说有多少条，让它把已知值清成 NULL 就是丢信息。
   * ★ `drained` 覆盖：它是"这一轮的结论"，这一轮没抽干就该显示没抽干，
   * 即使上一轮抽干过。
   */
  protected bumpPartition(
    channelId: string,
    input: {
      partitionId: string
      dayBucket: string
      delta: number
      listedTotal?: number | null
      drained?: boolean
      at: number
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO ${this.table}
           (channel_id, ${this.partitionColumn}, day_bucket,
            local_count, listed_total, drained, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, ${this.partitionColumn}, day_bucket) DO UPDATE SET
           local_count = ${this.table}.local_count + excluded.local_count,
           listed_total = COALESCE(excluded.listed_total, ${this.table}.listed_total),
           drained = excluded.drained,
           updated_at = excluded.updated_at`,
      )
      .run(
        channelId,
        input.partitionId,
        input.dayBucket,
        input.delta,
        input.listedTotal ?? null,
        input.drained === true ? 1 : 0,
        input.at,
      )
  }

  /**
   * 只把某个 (分区, 天) 标成抽干 / 没抽干，**不动计数**。
   *
   * 翻页翻到 `hasMore=false` 那一刻要记的就是这个，而那时不该再加一遍条数
   * （条数在写数据时已经累加过了）。
   */
  protected markPartitionDrained(
    channelId: string,
    input: {
      partitionId: string
      dayBucket: string
      drained: boolean
      listedTotal?: number | null
      at: number
    },
  ): void {
    this.bumpPartition(channelId, {
      partitionId: input.partitionId,
      dayBucket: input.dayBucket,
      delta: 0,
      ...(input.listedTotal === undefined ? {} : { listedTotal: input.listedTotal }),
      drained: input.drained,
      at: input.at,
    })
  }

  /**
   * 把一段日期标成「列表已抽干」。
   *
   * ## ★★★ 为什么只 `UPDATE` 已有行，不 INSERT
   *
   * 回溯的窗是**全局时间窗**（跨所有在范围内的分区一起翻），所以
   * "这个窗抽干了"是一句关于**日期**的话，不是关于某个分区的话。
   *
   * 一天没有任何行时**不凭空造行** —— 那会把"这天没数据"与"这天采完了
   * 0 条"混成同一个东西，而前者是事实、后者是结论。少一行让界面说
   * "没有数据"，那是诚实的。
   */
  markDaysDrained(channelId: string, fromDay: string, toDay: string, at: number): number {
    return this.db
      .prepare(
        `UPDATE ${this.table} SET drained = 1, updated_at = ?
          WHERE channel_id = ? AND day_bucket >= ? AND day_bucket <= ?`,
      )
      .run(at, channelId, fromDay, toDay).changes
  }

  /**
   * 按天聚合，用于界面上「这段日期已有多少」。
   *
   * `fromDay` / `toDay` 是 `YYYY-MM-DD`，闭区间。★ 文本比较对
   * `YYYY-MM-DD` 是正确的字典序（零填充过），所以不需要转时间戳。
   */
  protected listDaysAggregated(channelId: string, fromDay: string, toDay: string): CoverageDay[] {
    return this.db
      .prepare<[string, string, string], CoverageDayDbRow>(
        `SELECT day_bucket,
                SUM(local_count) AS local_count,
                MIN(drained) AS all_drained,
                SUM(CASE WHEN drained = 0 THEN 1 ELSE 0 END) AS pending
           FROM ${this.table}
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
   * ★ 返回 `days` / `drainedDays` 而不只是总数：「共 12 天里 9 天齐了」
   * 比一个百分比诚实，而且它是**可观测的**（不需要那个拿不到的分母）。
   */
  protected summarizeRange(channelId: string, fromDay: string, toDay: string): CoverageSummary {
    const rows = this.listDaysAggregated(channelId, fromDay, toDay)
    return {
      localCount: rows.reduce((sum, row) => sum + row.localCount, 0),
      days: rows.length,
      drainedDays: rows.filter((row) => row.drained).length,
      pendingPartitions: rows.reduce((sum, row) => sum + row.pendingPartitions, 0),
    }
  }

  /** 某个分区的逐天明细 —— 「哪个群/哪个知识库还没齐」点开之后看的。 */
  protected listByPartition(channelId: string, partitionId: string): CoverageRow[] {
    return this.db
      .prepare<[string, string], CoverageDbRow>(
        `SELECT ${this.partitionColumn} AS partition_id, day_bucket, local_count,
                listed_total, drained, updated_at
           FROM ${this.table}
          WHERE channel_id = ? AND ${this.partitionColumn} = ?
          ORDER BY day_bucket`,
      )
      .all(channelId, partitionId)
      .map(toCoverageRow)
  }
}
