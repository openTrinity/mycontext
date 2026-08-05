/**
 * 媒体资源与听记的仓储。
 *
 * 两者放一起的理由与 conversations.ts 相同：它们都是「随采集一起写、
 * 被蒸馏与图谱一起读」的从属数据，且都很小。分成两个文件会让调用方
 * 持有两个对象却总是同时用。
 *
 * ## 媒体的写入在 MessageRepository 里，不在这里
 *
 * 媒体是**消息的从属数据**（和 mentions 一样），必须与消息在同一个事务、
 * 同一次 upsert 里写 —— 否则会出现"消息在库里但媒体丢了"，
 * 而那个不一致没有任何东西会报错。这里只提供**读**与**下载回填**。
 */
import type { SqliteDatabase } from "../database.js"
import type { MinutesInput, MinutesRow } from "./types.js"

export interface MediaAssetRow {
  id: string
  messageId: string
  kind: "image" | "file" | "audio" | "video"
  resourceId: string
  resourceKind: string
  sha256: string | null
  path: string | null
  mime: string | null
  bytes: number | null
  originalName: string | null
  downloadedAt: number | null
}

interface MediaDbRow {
  id: string
  message_id: string
  kind: "image" | "file" | "audio" | "video"
  resource_id: string
  resource_kind: string
  sha256: string | null
  path: string | null
  mime: string | null
  bytes: number | null
  original_name: string | null
  downloaded_at: number | null
}

function toMedia(row: MediaDbRow): MediaAssetRow {
  return {
    id: row.id,
    messageId: row.message_id,
    kind: row.kind,
    resourceId: row.resource_id,
    resourceKind: row.resource_kind,
    sha256: row.sha256,
    path: row.path,
    mime: row.mime,
    bytes: row.bytes,
    originalName: row.original_name,
    downloadedAt: row.downloaded_at,
  }
}

export class MediaAssetRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listByMessage(messageId: string): MediaAssetRow[] {
    return this.db
      .prepare<[string], MediaDbRow>("SELECT * FROM media_assets WHERE message_id = ?")
      .all(messageId)
      .map(toMedia)
  }

  /**
   * 按内部 id 取一行。
   *
   * ★ 「另存为」用它把 mediaId 换成真实路径 —— 那是**唯一**允许的方向：
   * 让调用方直接传路径等于开一个任意文件读取的口子（渲染层渲染的是
   * 群聊正文，属于不可信输入）。
   */
  findById(id: string): MediaAssetRow | null {
    const row = this.db
      .prepare<[string], MediaDbRow>("SELECT * FROM media_assets WHERE id = ?")
      .get(id)
    return row === undefined ? null : toMedia(row)
  }

  /**
   * 未下载的资源（二期下载器的工作队列）。
   *
   * 按 rowid 升序 = 大致的采集顺序：先下载先看到的，比随机顺序更符合直觉。
   */
  listPending(limit: number): MediaAssetRow[] {
    return this.db
      .prepare<
        [number],
        MediaDbRow
      >("SELECT * FROM media_assets WHERE downloaded_at IS NULL ORDER BY rowid LIMIT ?")
      .all(limit)
      .map(toMedia)
  }

  /** 下载完成后回填。`sha256` 是**内容**哈希，只有下载后才算得出。 */
  markDownloaded(
    id: string,
    info: { path: string; sha256: string; bytes: number; mime?: string | null; at: number },
  ): void {
    this.db
      .prepare(
        `UPDATE media_assets
            SET path = ?, sha256 = ?, bytes = ?, mime = COALESCE(?, mime), downloaded_at = ?
          WHERE id = ?`,
      )
      .run(info.path, info.sha256, info.bytes, info.mime ?? null, info.at, id)
  }

  count(): number {
    return (
      this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM media_assets").get()?.c ?? 0
    )
  }
}

interface MinutesDbRow {
  id: string
  channel_id: string
  external_id: string
  title: string | null
  started_at: number | null
  duration_sec: number | null
  summary_text: string | null
  transcript_json: string | null
  speakers_json: string | null
  fetched_at: number
  raw_record_id: string | null
}

function toMinutes(row: MinutesDbRow): MinutesRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    externalId: row.external_id,
    title: row.title,
    startedAt: row.started_at,
    durationSec: row.duration_sec,
    summaryText: row.summary_text,
    transcriptJson: row.transcript_json,
    speakersJson: row.speakers_json,
    fetchedAt: row.fetched_at,
    rawRecordId: row.raw_record_id,
  }
}

export interface MinutesUpsertResult {
  /** 内容真正变化的行（Outbox 只为这些发变更） */
  changed: MinutesRow[]
  unchanged: number
}

export class MinutesRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * upsert 一批听记。
   *
   * ## 为什么用 `WHERE ... IS NOT ...` 守卫而不是无条件更新
   *
   * 与 messages 同一个道理：听记列表是**每轮全量**拉的（`minutes list all`
   * 不支持时间过滤），所以绝大多数行每轮都会重复写入。
   * 无条件 UPDATE 会让 `changes` 恒为 1 → 每轮给每条听记都发一个 Outbox seq →
   * 下游（图谱/蒸馏）每轮把全部听记重算一遍。
   *
   * 守卫条件只看**正文三列**（summary / transcript / speakers）：
   * `fetched_at` 每轮都变，把它算进比较等于没有守卫。
   *
   * ## 正文分两步到位
   *
   * `list` 只给元信息，正文要再调 `get summary` / `get transcription`。
   * 所以同一条听记会先以 `summary_text = NULL` 落库、之后再补正文 ——
   * 用 COALESCE 保留已有正文，避免后续只拉列表的轮次把正文抹掉。
   */
  upsertMany(inputs: readonly MinutesInput[]): MinutesUpsertResult {
    const insert = this.db.prepare(
      `INSERT INTO minutes
         (id, channel_id, external_id, title, started_at, duration_sec,
          summary_text, transcript_json, speakers_json, fetched_at, raw_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, external_id) DO UPDATE SET
         title           = COALESCE(excluded.title, minutes.title),
         started_at      = COALESCE(excluded.started_at, minutes.started_at),
         duration_sec    = COALESCE(excluded.duration_sec, minutes.duration_sec),
         -- 正文：新值优先，但 NULL 不覆盖已有（见文件头「正文分两步」）
         summary_text    = COALESCE(excluded.summary_text, minutes.summary_text),
         transcript_json = COALESCE(excluded.transcript_json, minutes.transcript_json),
         speakers_json   = COALESCE(excluded.speakers_json, minutes.speakers_json),
         fetched_at      = excluded.fetched_at,
         raw_record_id   = COALESCE(excluded.raw_record_id, minutes.raw_record_id)
       WHERE COALESCE(minutes.summary_text, '')    IS NOT COALESCE(excluded.summary_text, minutes.summary_text, '')
          OR COALESCE(minutes.transcript_json, '') IS NOT COALESCE(excluded.transcript_json, minutes.transcript_json, '')
          OR COALESCE(minutes.speakers_json, '')   IS NOT COALESCE(excluded.speakers_json, minutes.speakers_json, '')
          OR COALESCE(minutes.title, '')           IS NOT COALESCE(excluded.title, minutes.title, '')`,
    )

    const changed: MinutesRow[] = []
    let unchanged = 0

    for (const input of inputs) {
      const info = insert.run(
        input.id,
        input.channelId,
        input.externalId,
        input.title ?? null,
        input.startedAt ?? null,
        input.durationSec ?? null,
        input.summaryText ?? null,
        input.transcriptJson ?? null,
        input.speakersJson ?? null,
        input.fetchedAt,
        input.rawRecordId ?? null,
      )
      if (info.changes === 0) {
        unchanged += 1
        continue
      }
      // 取库里那一行：冲突分支下 id 保留旧值，下游必须拿到真实 id。
      const stored = this.findByExternalId(input.channelId, input.externalId)
      if (stored !== null) changed.push(stored)
    }

    return { changed, unchanged }
  }

  findByExternalId(channelId: string, externalId: string): MinutesRow | null {
    const row = this.db
      .prepare<
        [string, string],
        MinutesDbRow
      >("SELECT * FROM minutes WHERE channel_id = ? AND external_id = ?")
      .get(channelId, externalId)
    return row === undefined ? null : toMinutes(row)
  }

  /** 缺正文的听记（正文抓取的工作队列）。 */
  listMissingBody(channelId: string, limit: number): MinutesRow[] {
    return this.db
      .prepare<[string, number], MinutesDbRow>(
        `SELECT * FROM minutes
          WHERE channel_id = ? AND summary_text IS NULL AND transcript_json IS NULL
          ORDER BY started_at DESC LIMIT ?`,
      )
      .all(channelId, limit)
      .map(toMinutes)
  }

  count(): number {
    return this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM minutes").get()?.c ?? 0
  }
}
