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
  transcript_pages: number | null
  transcript_truncated: number | null
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
    transcriptPages: row.transcript_pages,
    // ★ 三态：null 保持 null（= 不知道），不要折成 false（= 抽干了）
    transcriptTruncated: row.transcript_truncated === null ? null : row.transcript_truncated === 1,
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
   * 与 messages 同一个道理：听记列表是**每轮全量抽干**的（`minutes list all`
   * 没有水位语义，所以每轮都从首页重新翻到底），所以绝大多数行每轮都会
   * 重复写入。无条件 UPDATE 会让 `changes` 恒为 1 → 每轮给每条听记都发一个
   * Outbox seq → 下游（图谱/蒸馏）每轮把全部听记重算一遍。
   *
   * 守卫条件只看**正文三列**（summary / transcript / speakers）与标题：
   * `fetched_at` 每轮都变，把它算进比较等于没有守卫。
   *
   * ## ★ `transcript_pages` / `transcript_truncated` **刻意不进守卫**
   *
   * 它们是 `transcript_json` 的**元数据**，必然跟着它一起变 ——
   * 加进去是冗余。而加错的代价是双向的：
   * · 只有它们变而正文没变（不可能，但如果发生）→ 发一个无意义的 seq；
   * · 更糟的是它们参与比较时的 COALESCE 写法容易写反，
   *   而写反的表现是"正文变了却没发 seq"（下游永远看不到新转写）。
   *
   * 它们**照常被写入**（在 SET 里），只是不作为"内容变了吗"的判据。
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
          summary_text, transcript_json, speakers_json,
          transcript_pages, transcript_truncated, fetched_at, raw_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, external_id) DO UPDATE SET
         title           = COALESCE(excluded.title, minutes.title),
         started_at      = COALESCE(excluded.started_at, minutes.started_at),
         duration_sec    = COALESCE(excluded.duration_sec, minutes.duration_sec),
         -- 正文：新值优先，但 NULL 不覆盖已有（见文件头「正文分两步」）
         summary_text    = COALESCE(excluded.summary_text, minutes.summary_text),
         transcript_json = COALESCE(excluded.transcript_json, minutes.transcript_json),
         speakers_json   = COALESCE(excluded.speakers_json, minutes.speakers_json),
         -- 转写的元数据跟着正文走（同样 NULL 不覆盖：只列元信息的轮次不该擦掉它）
         transcript_pages     = COALESCE(excluded.transcript_pages, minutes.transcript_pages),
         transcript_truncated = COALESCE(excluded.transcript_truncated, minutes.transcript_truncated),
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
        input.transcriptPages ?? null,
        // 布尔 → 0/1。`undefined`/`null` 都落成 NULL（= 不知道，见 v24 文件头）
        input.transcriptTruncated === undefined || input.transcriptTruncated === null
          ? null
          : input.transcriptTruncated
            ? 1
            : 0,
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

  /**
   * 缺正文的听记（正文抓取的工作队列）。
   *
   * ## ★ 转写没抽干（`transcript_truncated = 1`）的**不**重进队列
   *
   * 判据只有"一点正文都没有"。撞了渠道侧页数/字符上限的那些会议，
   * 重试还是会撞同一个上限 —— 每轮为它们各烧 20 次 CLI 调用，
   * 换回一模一样的结果。那是 `contact_avatars` 的终态 miss 同一个道理
   * （见那个文件头：不区分"重试有用"与"重试永远没用"会得到一个
   * 悄悄跑的无效重试循环）。
   *
   * 真要补全一场超长会议的转写，应当是**用户显式触发**的动作
   * （那时可以给更大的预算），而不是后台每 30 分钟白试一次。
   * 截断的事实存在 `transcript_truncated` 里，状态页会说出来。
   */
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

  /**
   * 转写没抽干的会议数。状态页用它显示「N 场会的转写不完整」。
   *
   * ★ 只算 `= 1`，**不算 NULL**：NULL 是老数据（"不知道抽干了没"），
   * 把它算进来会把一个未知说成已知的坏消息。老行会被下一次正文抓取
   * 自然刷新成 0/1 —— 前提是它进得了 `listMissingBody` 的队列
   * （只有正文全空的才进，所以老的"有正文但只有第一页"的行会**长期
   * 停留在 NULL**，这是已知的局限，不值得为它写一次数据迁移）。
   */
  countTranscriptTruncated(channelId: string): number {
    return (
      this.db
        .prepare<
          [string],
          { c: number }
        >("SELECT count(*) AS c FROM minutes WHERE channel_id = ? AND transcript_truncated = 1")
        .get(channelId)?.c ?? 0
    )
  }

  /** 最早一场会议的开始时间（unix ms）；null = 库里还没有会议。 */
  earliestStartedAt(channelId: string): number | null {
    return (
      this.db
        .prepare<
          [string],
          { t: number | null }
        >("SELECT min(started_at) AS t FROM minutes WHERE channel_id = ? AND started_at IS NOT NULL")
        .get(channelId)?.t ?? null
    )
  }

  count(): number {
    return this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM minutes").get()?.c ?? 0
  }
}

/** 上一轮听记列表抽干的结果。 */
export interface MinutesCoverageRow {
  /** 上一轮把 `minutes list all` 翻到底了吗。false = 撞了页数预算。 */
  drained: boolean
  /** 已覆盖到的最早会议时间（unix ms）；null = 库里还没有会议。 */
  earliestStartedAt: number | null
  /** 上一轮跨全部页一共列了多少条。 */
  listedTotal: number
  /** 上一轮什么时候跑的（让"这个结论有多旧"可判断）。 */
  lastRunAt: number
}

/**
 * 听记列表的覆盖面记账。
 *
 * ## ★ 为什么这件事需要落库，而不是只记一条 warn 日志
 *
 * 首版只取列表首页，于是第 51 场之前的会议永远采不到 —— 而那个缺失
 * **没有任何出口**：状态页的听记计数稳定停在 50，与"一共 50 场会"完全同形。
 * 文档那条链现在也只有一条 warn（`ingest.service.ts` 的
 * `documents listing truncated`），而用户看不到日志。
 *
 * 与 `backfill` 那三个数字（选的范围 / 已覆盖 / 还差多少）同一个思路：
 * **把落差摊开才能被看见**。
 *
 * ## 为什么不是内存里的一个字段
 *
 * 应用刚起来还没跑第一轮时，上一轮的结论仍然是当前最好的答案。
 * 存内存的话每次重启都退化成"未知"，而"未知"在界面上与"没问题"同形。
 *
 * 表结构与为什么不塞进 `sync_cursors`，见 v24 迁移的文件头。
 */
export class MinutesCoverageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** `null` = 还没跑过一轮（与"跑过但没抽干"是两件事）。 */
  get(channelId: string): MinutesCoverageRow | null {
    const row = this.db
      .prepare<
        [string],
        {
          drained: number
          earliest_started_at: number | null
          listed_total: number
          last_run_at: number
        }
      >("SELECT * FROM minutes_coverage WHERE channel_id = ?")
      .get(channelId)
    if (row === undefined) return null
    return {
      drained: row.drained === 1,
      earliestStartedAt: row.earliest_started_at,
      listedTotal: row.listed_total,
      lastRunAt: row.last_run_at,
    }
  }

  /**
   * 记一轮的结果。**每轮都覆盖**（不做"只增不减"）。
   *
   * 与 `sync_cursors.watermark` 的 `MAX()` 语义刻意不同：那个是水位，
   * 倒退意味着重复采集。这里是**上一轮的事实快照** —— 如果这一轮没抽干
   * 而上一轮抽干了，界面上该显示"现在没抽干"，而不是保留那个更好看的旧值。
   */
  record(
    channelId: string,
    input: { drained: boolean; earliestStartedAt: number | null; listedTotal: number; at: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO minutes_coverage
           (channel_id, drained, earliest_started_at, listed_total, last_run_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           drained = excluded.drained,
           earliest_started_at = excluded.earliest_started_at,
           listed_total = excluded.listed_total,
           last_run_at = excluded.last_run_at`,
      )
      .run(channelId, input.drained ? 1 : 0, input.earliestStartedAt, input.listedTotal, input.at)
  }
}
