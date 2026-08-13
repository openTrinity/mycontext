/**
 * 聊天的覆盖面记账 —— 回答「这段日期我到底有多少 / 齐没齐」。
 *
 * ## ★★★ 这里**没有**「共需多少」那个分母，而且不能有
 *
 * 渠道 API 不提供"某会话某天共有多少条"（`packages/channels/src/types.ts`
 * 只有 `hasMore` / `nextCursor`）。所以百分比只能靠编，而这个项目已经因为
 * 编分母吃过一次（仪表盘那句假的「才学了 0.0%」）。
 *
 * 判据落在 `drained` 上：
 * · `drained = 1` → 这一天翻到了 `hasMore=false`，`localCount` **就是**全部；
 * · `drained = 0` → 还在回溯，`localCount` 是**下界**。
 *
 * ## ★★ 通用部分在 `CoverageRepositoryBase`
 *
 * `bump` / `markDrained` / `markDaysDrained` / `listDays` / `summarize`
 * 与 `document_coverage`（v29）**逐字相同** —— 那五条判据（累加 vs 覆盖、
 * `COALESCE` 保留 listed_total、`MIN(drained)` 而不是 MAX、
 * 不凭空造行）已经在这里踩齐了，让文档那张表再实现一遍等于五次犯同样错的
 * 机会。所以它们搬到了基类，见那个文件头。
 *
 * **这个类只留聊天独有的那一件事**：`rebuildFromMessages`。
 *
 * ## 与 `MinutesCoverageRepository` 的**刻意不同**
 *
 * 那张表一个渠道一行、每轮整体覆盖；这张按 `(会话, 天)`，一轮只动碰到的那些行。
 * 听记的列表是一次性全量的（没有 per-会话 的分页），所以它不需要分区维度。
 */
import type { SqliteDatabase } from "../database.js"
import {
  CoverageRepositoryBase,
  toDayBucket,
  type CoverageDay,
  type CoverageRow,
  type CoverageSummary,
} from "./coverage-base.js"

export { toDayBucket }

/**
 * 一天 + 一个会话的覆盖情况。
 *
 * ★ 保留 `conversationExternalId` 这个字段名（而不是直接用基类的
 * `partitionId`）：调用方读的是"哪个会话"，而 `partitionId` 在聊天语境里
 * 是一个需要翻译的词。类型别名让基类的通用性与调用方的可读性都成立。
 */
export interface ChatCoverageRow extends Omit<CoverageRow, "partitionId"> {
  conversationExternalId: string
}

/**
 * 按天聚合的覆盖情况（跨会话）。界面上「这段日期」那一行读的是它。
 *
 * ★ `pendingConversations` 而不是基类的 `pendingPartitions`：同上，
 * 界面要说的是"还有 3 个群没齐"。
 */
export interface ChatCoverageDay extends Omit<CoverageDay, "pendingPartitions"> {
  pendingConversations: number
}

export interface ChatCoverageSummary extends Omit<CoverageSummary, "pendingPartitions"> {
  pendingConversations: number
}

export class ChatCoverageRepository extends CoverageRepositoryBase {
  constructor(db: SqliteDatabase) {
    super(db, "chat_coverage", "conversation_external_id")
  }

  /**
   * 累加某个 (会话, 天) 的本地条数。
   *
   * ★ 这是基类 `bump` 的**改名转发**，不是重新实现：入参用
   * `conversationExternalId` 让调用方不必知道"分区"这个词。
   * 全部判据（累加 / COALESCE / drained 覆盖）都在基类里，只有一份。
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
    super.bumpPartition(channelId, {
      partitionId: input.conversationExternalId,
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
      conversationExternalId: string
      dayBucket: string
      drained: boolean
      listedTotal?: number | null
      at: number
    },
  ): void {
    super.markPartitionDrained(channelId, {
      partitionId: input.conversationExternalId,
      dayBucket: input.dayBucket,
      drained: input.drained,
      ...(input.listedTotal === undefined ? {} : { listedTotal: input.listedTotal }),
      at: input.at,
    })
  }

  /** 按天聚合（把基类的 `pendingPartitions` 翻译成 `pendingConversations`）。 */
  listDays(channelId: string, fromDay: string, toDay: string): ChatCoverageDay[] {
    return super.listDaysAggregated(channelId, fromDay, toDay).map((day) => ({
      dayBucket: day.dayBucket,
      localCount: day.localCount,
      drained: day.drained,
      pendingConversations: day.pendingPartitions,
    }))
  }

  /** 区间汇总（同上，只翻译字段名）。 */
  summarize(channelId: string, fromDay: string, toDay: string): ChatCoverageSummary {
    const summary = super.summarizeRange(channelId, fromDay, toDay)
    return {
      localCount: summary.localCount,
      days: summary.days,
      drainedDays: summary.drainedDays,
      pendingConversations: summary.pendingPartitions,
    }
  }

  /** 某个会话的逐天明细 —— 「哪个群还没齐」点开之后看的。 */
  listByConversation(channelId: string, conversationExternalId: string): ChatCoverageRow[] {
    return super.listByPartition(channelId, conversationExternalId).map((row) => ({
      conversationExternalId: row.partitionId,
      dayBucket: row.dayBucket,
      localCount: row.localCount,
      listedTotal: row.listedTotal,
      drained: row.drained,
      updatedAt: row.updatedAt,
    }))
  }

  /**
   * 从 `messages` 表重建计数（**幂等**）。★ 聊天独有，不进基类。
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
   * ★ 为什么它不进基类：文档那张表**没有**对应的重建路径。文档按空间分区，
   * 而 `documents.workspace_id` 允许为 NULL（散落的云盘文件），
   * 一条 `GROUP BY workspace_id` 会把它们全归到一个 NULL 组 ——
   * 那与 v29 里"空串 = 默认空间"的约定不一致。硬塞进基类就要让基类知道
   * 每张表的空值约定，那就不再是共用逻辑了。
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
    return this.db
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
      .run(at, channelId).changes
  }
}
