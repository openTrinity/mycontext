/**
 * 文档的覆盖面记账（v29 `document_coverage`）—— 补齐「三类数据」的最后一类。
 *
 * ## 用户要的
 *
 * 「要说明现在已有那部分日期的那部分业务数据…**不管是消息还是听记，文档等**」
 *
 * 消息那半在 v27、听记那半在 v24，文档这半一直缺着 —— 于是界面对文档只能给
 * 一个总条数，说不出"这段日期齐没齐"。而"两类能回答、一类不能"是最难解释
 * 的状态：用户会以为文档那栏坏了。
 *
 * ## ★★ 通用逻辑全部在 `CoverageRepositoryBase`
 *
 * 那五条判据（`local_count` 累加而非覆盖、`listed_total` 用 COALESCE 保留、
 * `drained` 覆盖、按天聚合用 `MIN(drained)`、`markDaysDrained` 只 UPDATE
 * 不 INSERT）已经在 `chat_coverage` 那边踩齐了。抄一遍等于给自己五次犯同样
 * 错的机会，而错了都不报错 —— 只是界面上的数字偏了。
 *
 * 所以这个类**只有改名转发**：把"分区"翻译成"空间"，让调用方不必知道
 * 基类的抽象词。
 *
 * ## ★ 分区是**空间**（知识库 / 云盘目录），不是单篇文档
 *
 * 文档按空间翻页，一篇文档不存在"翻完了"这件事。完整理由见 v29 迁移的
 * 文件头 —— 硬套成 per-document 会要求调用方回答"哪些文档齐了"，
 * 而那个信息在一页翻完的那一刻并不存在。
 *
 * ★ 空间为空（散落的云盘文件、`documents.workspace_id IS NULL`）时用**空串**：
 * 那是"这个渠道的默认空间"，不是"未知"。后者需要 NULL，而 NULL 进不了
 * `WITHOUT ROWID` 的主键。
 */
import type { SqliteDatabase } from "../database.js"
import {
  CoverageRepositoryBase,
  type CoverageDay,
  type CoverageRow,
  type CoverageSummary,
} from "./coverage-base.js"

/** 一天 + 一个空间的覆盖情况。 */
export interface DocumentCoverageRow extends Omit<CoverageRow, "partitionId"> {
  /** 知识库 / 云盘目录的 external_id；`''` = 默认空间 */
  spaceExternalId: string
}

/** 按天聚合（跨空间）。界面上「这段日期」那一行读的是它。 */
export interface DocumentCoverageDay extends Omit<CoverageDay, "pendingPartitions"> {
  /** 这一天还有几个空间没抽干。0 = 都齐了 */
  pendingSpaces: number
}

export interface DocumentCoverageSummary extends Omit<CoverageSummary, "pendingPartitions"> {
  pendingSpaces: number
}

/** 把 `workspace_id` 归一成分区键。★ NULL / undefined → 空串（默认空间）。 */
export function toSpaceKey(workspaceId: string | null | undefined): string {
  return workspaceId ?? ""
}

export class DocumentCoverageRepository extends CoverageRepositoryBase {
  constructor(db: SqliteDatabase) {
    super(db, "document_coverage", "space_external_id")
  }

  /** 累加某个 (空间, 天) 的本地篇数（基类 `bump` 的改名转发）。 */
  bump(
    channelId: string,
    input: {
      spaceExternalId: string
      dayBucket: string
      delta: number
      listedTotal?: number | null
      drained?: boolean
      at: number
    },
  ): void {
    super.bumpPartition(channelId, {
      partitionId: input.spaceExternalId,
      dayBucket: input.dayBucket,
      delta: input.delta,
      ...(input.listedTotal === undefined ? {} : { listedTotal: input.listedTotal }),
      ...(input.drained === undefined ? {} : { drained: input.drained }),
      at: input.at,
    })
  }

  /** 只标抽干、不动计数（基类 `markDrained` 的改名转发）。 */
  markDrained(
    channelId: string,
    input: {
      spaceExternalId: string
      dayBucket: string
      drained: boolean
      listedTotal?: number | null
      at: number
    },
  ): void {
    super.markPartitionDrained(channelId, {
      partitionId: input.spaceExternalId,
      dayBucket: input.dayBucket,
      drained: input.drained,
      ...(input.listedTotal === undefined ? {} : { listedTotal: input.listedTotal }),
      at: input.at,
    })
  }

  /** 按天聚合（把基类的 `pendingPartitions` 翻译成 `pendingSpaces`）。 */
  listDays(channelId: string, fromDay: string, toDay: string): DocumentCoverageDay[] {
    return super.listDaysAggregated(channelId, fromDay, toDay).map((day) => ({
      dayBucket: day.dayBucket,
      localCount: day.localCount,
      drained: day.drained,
      pendingSpaces: day.pendingPartitions,
    }))
  }

  /** 区间汇总（同上，只翻译字段名）。 */
  summarize(channelId: string, fromDay: string, toDay: string): DocumentCoverageSummary {
    const summary = super.summarizeRange(channelId, fromDay, toDay)
    return {
      localCount: summary.localCount,
      days: summary.days,
      drainedDays: summary.drainedDays,
      pendingSpaces: summary.pendingPartitions,
    }
  }

  /** 某个空间的逐天明细 —— 「哪个知识库还没齐」点开之后看的。 */
  listBySpace(channelId: string, spaceExternalId: string): DocumentCoverageRow[] {
    return super.listByPartition(channelId, spaceExternalId).map((row) => ({
      spaceExternalId: row.partitionId,
      dayBucket: row.dayBucket,
      localCount: row.localCount,
      listedTotal: row.listedTotal,
      drained: row.drained,
      updatedAt: row.updatedAt,
    }))
  }

  /**
   * 从 `documents` 表重建计数（**幂等**）。
   *
   * ## ★★★ 为什么文档也必须有重建路径（与 `chat_coverage` 同一个理由）
   *
   * `bump()` 只在**新文档写进库**那一刻累加。而文档的守卫条件很严
   * （`title`/`content_text`/`updated_at`/`url` 四列都没变就判重），
   * 所以存量库里 `local_count` 会**永远是 0** —— 界面说"这段日期 0 篇"，
   * 而库里有几百篇。用户问的是「已经有了多少」，那必须包含已经采到的。
   *
   * ## ★★ 与聊天那份的两处**刻意不同**
   *
   * ① 分桶用 `COALESCE(updated_at, created_at, fetched_at)` —— 与
   *    `toDocumentChangelogEntry` 的 `occurredAt` **同一个判据**。
   *    用 `fetched_at` 分桶会让三个月前改的文档全落到今天，
   *    于是"这段日期有多少"永远只有今天那一格有数；
   * ② `space_external_id` 用 `COALESCE(workspace_id, '')` —— v29 约定
   *    空串是默认空间。用 NULL 会让这些行进不了主键（`WITHOUT ROWID`），
   *    整条 INSERT 静默失败一部分。
   *
   * ★ 覆盖而不是累加（`SET local_count = excluded.local_count`）：
   * 这里的值是从 `documents` **数出来的真值**，重跑结果相同。
   * 累加的话每次重建都会翻倍。
   *
   * ★ 不动 `drained` / `listed_total`：那两个是采集侧的结论。
   */
  rebuildFromDocuments(channelId: string, at: number): number {
    return this.db
      .prepare(
        `INSERT INTO document_coverage
           (channel_id, space_external_id, day_bucket, local_count, listed_total, drained, updated_at)
         SELECT d.channel_id,
                COALESCE(d.workspace_id, ''),
                date(COALESCE(d.updated_at, d.created_at, d.fetched_at) / 1000, 'unixepoch', 'localtime'),
                count(*),
                NULL,
                0,
                ?
           FROM documents d
          WHERE d.channel_id = ?
            AND COALESCE(d.updated_at, d.created_at, d.fetched_at) IS NOT NULL
          GROUP BY COALESCE(d.workspace_id, ''),
                   date(COALESCE(d.updated_at, d.created_at, d.fetched_at) / 1000, 'unixepoch', 'localtime')
         ON CONFLICT(channel_id, space_external_id, day_bucket) DO UPDATE SET
           local_count = excluded.local_count,
           listed_total = COALESCE(document_coverage.listed_total, excluded.listed_total),
           updated_at = excluded.updated_at`,
      )
      .run(at, channelId).changes
  }
}
