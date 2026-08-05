/**
 * 原生留存仓储。
 *
 * 幂等键是 `(channel_id, resource, external_id, payload_hash)`：
 * 同一条内容重复拉取不产生新行，而内容变了会产生新行（供 superseded_by 串链）。
 *
 * ★ `external_id` 必须传空串而不是 null。SQLite 中 `NULL != NULL`，
 * 可空列参与 UNIQUE 时那些行的唯一性**完全不生效** —— 实测重放 3 次得到 3 行。
 * 幂等这个不变式就是靠这个唯一键承载的，所以这条不是风格问题。
 */
import type { SqliteDatabase } from "../database.js"
import type { RawRecordInput } from "./types.js"

export interface RawInsertResult {
  /** 实际新增的行 id（已存在的不在其中） */
  inserted: string[]
  /** 因幂等被跳过的条数 */
  skipped: number
}

export class RawRecordRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 批量写入，重复内容跳过。
   *
   * 用 `INSERT OR IGNORE` + `changes` 判断而不是先 SELECT 再 INSERT：
   * 后者在并发下有 TOCTOU 窗口，而这里的调用方（采集调度）本来就允许两层重叠。
   */
  insertMany(records: readonly RawRecordInput[]): RawInsertResult {
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO raw_records
         (id, channel_id, resource, external_id, payload, payload_hash, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const inserted: string[] = []
    let skipped = 0
    for (const record of records) {
      const info = statement.run(
        record.id,
        record.channelId,
        record.resource,
        record.externalId,
        record.payload,
        record.payloadHash,
        record.source,
        record.fetchedAt,
      )
      if (info.changes > 0) inserted.push(record.id)
      else skipped += 1
    }
    return { inserted, skipped }
  }

  /** 按幂等键找已有行的 id（重复内容时用它作为 message.raw_record_id）。 */
  findId(
    channelId: string,
    resource: string,
    externalId: string,
    payloadHash: string,
  ): string | null {
    const row = this.db
      .prepare<
        [string, string, string, string],
        { id: string }
      >(`SELECT id FROM raw_records WHERE channel_id = ? AND resource = ? AND external_id = ? AND payload_hash = ?`)
      .get(channelId, resource, externalId, payloadHash)
    return row?.id ?? null
  }

  /**
   * 标记内容修订：老行指向新行。
   *
   * 保留链而不是直接覆盖，是因为「消息被编辑过」本身是画像与检索都需要知道的事实
   * （用户改口了 vs 从没这么说过，是两件事）。
   */
  markSuperseded(oldId: string, newId: string): void {
    this.db.prepare("UPDATE raw_records SET superseded_by = ? WHERE id = ?").run(newId, oldId)
  }

  count(): number {
    return this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM raw_records").get()?.c ?? 0
  }

  /** 已裁剪 payload 的行数：状态页要显示，让存储增长可见。 */
  countPruned(): number {
    return (
      this.db
        .prepare<[], { c: number }>("SELECT count(*) AS c FROM raw_records WHERE payload IS NULL")
        .get()?.c ?? 0
    )
  }

  /** 读回原始 payload（解析 bug 重放用）；已裁剪的行返回 null。 */
  payload(id: string): string | null {
    const row = this.db
      .prepare<[string], { payload: string | null }>("SELECT payload FROM raw_records WHERE id = ?")
      .get(id)
    return row?.payload ?? null
  }
}
