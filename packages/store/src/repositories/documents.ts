/**
 * 文档（知识库 wiki / 钉盘）的仓储。
 *
 * ## ★ 与 `MinutesRepository` 同构，而且是**刻意**同构的
 *
 * 两者的采集形状一样：**每轮全量列元信息 + 逐篇补正文**。
 * 所以两个不变式也一样，而且都必须实现：
 *
 * · **upsert 要带守卫**：全量列意味着绝大多数行每轮都会重复写入。
 *   无条件 UPDATE 会让 `changes` 恒为 1 → 每轮给每篇文档发一个 Outbox seq →
 *   下游（图谱）每轮把全部文档重算一遍。而图谱重建是**小时级**的开销。
 * · **正文用 COALESCE 保留**：列举那一步 `content_text` 是 null，
 *   之后才补。不保留的话每轮只列不补的轮次会把已取到的正文**抹掉**，
 *   而那看起来像"文档突然没内容了"。
 *
 * ## ★ 守卫条件不能算进 `fetched_at`
 *
 * 它每轮都变。把它算进比较等于没有守卫 —— 这是 minutes 那边写明过的坑，
 * 这里复述一次是因为抄一份实现最容易连带抄错这一点。
 */
import type { SqliteDatabase } from "../database.js"
import type { DocumentInput, DocumentRow } from "./types.js"
import type { ChannelIdValue } from "./types.js"

interface DocumentDbRow {
  id: string
  channel_id: string
  external_id: string
  origin: string | null
  title: string | null
  doc_type: string | null
  extension: string | null
  url: string | null
  workspace_id: string | null
  content_text: string | null
  updated_at: number | null
  created_at: number | null
  fetched_at: number | null
  raw_record_id: string | null
}

function toDocument(row: DocumentDbRow): DocumentRow {
  return {
    id: row.id,
    channelId: row.channel_id as ChannelIdValue,
    externalId: row.external_id,
    origin: row.origin,
    title: row.title,
    docType: row.doc_type,
    extension: row.extension,
    url: row.url,
    workspaceId: row.workspace_id,
    contentText: row.content_text,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    fetchedAt: row.fetched_at ?? 0,
    rawRecordId: row.raw_record_id,
  }
}

export interface DocumentUpsertResult {
  changed: DocumentRow[]
  unchanged: number
}

export class DocumentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * upsert 一批文档。返回**真正变化的**那些（Outbox 只为它们发 seq）。
   *
   * 守卫看四列：`title` / `content_text` / `updated_at` / `url`。
   * 不看 `fetched_at`（每轮都变）、也不看 `origin`
   * —— 同一篇文档从 drive 与 wiki 两个入口看到时 origin 会来回翻，
   * 而那不是内容变化，不该触发下游重算。
   */
  upsertMany(inputs: readonly DocumentInput[]): DocumentUpsertResult {
    const insert = this.db.prepare(
      `INSERT INTO documents
         (id, channel_id, external_id, origin, title, doc_type, extension, url,
          workspace_id, content_text, updated_at, created_at, fetched_at, raw_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, external_id) DO UPDATE SET
         title         = COALESCE(excluded.title, documents.title),
         doc_type      = COALESCE(excluded.doc_type, documents.doc_type),
         extension     = COALESCE(excluded.extension, documents.extension),
         url           = COALESCE(excluded.url, documents.url),
         workspace_id  = COALESCE(excluded.workspace_id, documents.workspace_id),
         -- ★ 正文：新值优先，但 NULL 不覆盖已有（列举轮次不能抹掉已取的正文）
         content_text  = COALESCE(excluded.content_text, documents.content_text),
         updated_at    = COALESCE(excluded.updated_at, documents.updated_at),
         created_at    = COALESCE(excluded.created_at, documents.created_at),
         -- origin 保留**首次**看到的那个来源：它回答"这篇是怎么进来的"，
         -- 而后续从另一个入口再看到不改变这个事实。
         origin        = COALESCE(documents.origin, excluded.origin),
         fetched_at    = excluded.fetched_at,
         raw_record_id = COALESCE(excluded.raw_record_id, documents.raw_record_id)
       WHERE COALESCE(documents.title, '')        IS NOT COALESCE(excluded.title, documents.title, '')
          OR COALESCE(documents.content_text, '') IS NOT COALESCE(excluded.content_text, documents.content_text, '')
          OR COALESCE(documents.updated_at, 0)    IS NOT COALESCE(excluded.updated_at, documents.updated_at, 0)
          OR COALESCE(documents.url, '')          IS NOT COALESCE(excluded.url, documents.url, '')`,
    )

    const changed: DocumentRow[] = []
    let unchanged = 0

    for (const input of inputs) {
      const info = insert.run(
        input.id,
        input.channelId,
        input.externalId,
        input.origin ?? null,
        input.title ?? null,
        input.docType ?? null,
        input.extension ?? null,
        input.url ?? null,
        input.workspaceId ?? null,
        input.contentText ?? null,
        input.updatedAt ?? null,
        input.createdAt ?? null,
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

  findByExternalId(channelId: string, externalId: string): DocumentRow | null {
    const row = this.db
      .prepare<
        [string, string],
        DocumentDbRow
      >("SELECT * FROM documents WHERE channel_id = ? AND external_id = ?")
      .get(channelId, externalId)
    return row === undefined ? null : toDocument(row)
  }

  /**
   * 缺正文的文档（正文抓取的工作队列）。
   *
   * ★ 按 `updated_at` **新→旧**：最近改过的文档最可能被问到，
   * 而正文是逐篇一次 CLI 调用 —— 顺序决定了"前几轮就把有用的补上"。
   *
   * ## ★★ `readableExtensions` 必须在 SQL 里过滤，不能留给调用方
   *
   * 表格（`able`/`axls`）、脑图（`dingfm`）、图片、快捷链接这些
   * **永远**取不到正文。而它们与真文档混在同一个 `updated_at` 序里 ——
   * 实测这个库队首 8 篇里就有 2 篇 `able`，也就是每轮 5 个配额里
   * 有 40% 白烧在必然失败的调用上，而且**每轮都是同样那几篇**
   * （取不到 → `content_text` 仍是 null → 下一轮又排在前面）。
   *
   * 调用方按后缀跳过不能解决这个：那样只是不发 CLI 调用，
   * 配额已经被占掉了。必须在**取队列这一步**就排除。
   *
   * 不传 = 不过滤（老行为，给不关心后缀的调用方留着）。
   */
  listMissingBody(
    channelId: string,
    limit: number,
    readableExtensions?: readonly string[],
  ): DocumentRow[] {
    if (readableExtensions === undefined || readableExtensions.length === 0) {
      return this.db
        .prepare<[string, number], DocumentDbRow>(
          `SELECT * FROM documents
            WHERE channel_id = ? AND content_text IS NULL
            ORDER BY updated_at DESC NULLS LAST LIMIT ?`,
        )
        .all(channelId, limit)
        .map(toDocument)
    }
    // 后缀集合是代码里的常量（不是用户输入），但仍走占位符 —— 拼串是习惯问题。
    const holes = readableExtensions.map(() => "?").join(", ")
    return this.db
      .prepare<[string, ...string[], number], DocumentDbRow>(
        `SELECT * FROM documents
          WHERE channel_id = ? AND content_text IS NULL
            AND lower(coalesce(extension, '')) IN (${holes})
          ORDER BY updated_at DESC NULLS LAST LIMIT ?`,
      )
      .all(channelId, ...readableExtensions.map((e) => e.toLowerCase()), limit)
      .map(toDocument)
  }

  /**
   * 还缺多少篇正文（只算**能读**的后缀）。
   *
   * ★ 供采集侧决定用"冷启动速率"还是"稳态速率"（见
   * `ingest.service.ts` 的 `DOCUMENTS_BODY_PER_ROUND`）。
   * 必须按后缀过滤 —— 否则那些永远取不到正文的（实测本机 104 篇）
   * 会让判据恒为"还没追平"，于是永远跑冷启动档。
   */
  countMissingBody(channelId: string, readableExtensions: readonly string[]): number {
    if (readableExtensions.length === 0) return 0
    const holes = readableExtensions.map(() => "?").join(", ")
    return (
      this.db
        .prepare<[string, ...string[]], { c: number }>(
          `SELECT count(*) AS c FROM documents
            WHERE channel_id = ? AND content_text IS NULL
              AND lower(coalesce(extension, '')) IN (${holes})`,
        )
        .get(channelId, ...readableExtensions.map((e) => e.toLowerCase()))?.c ?? 0
    )
  }

  /** 有正文的文档（导出给图谱时只导这些 —— 没正文的进去只是噪声）。 */
  listWithBody(channelId: string, limit: number): DocumentRow[] {
    return this.db
      .prepare<[string, number], DocumentDbRow>(
        `SELECT * FROM documents
          WHERE channel_id = ? AND content_text IS NOT NULL AND content_text != ''
          ORDER BY updated_at DESC NULLS LAST LIMIT ?`,
      )
      .all(channelId, limit)
      .map(toDocument)
  }

  count(): number {
    return this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM documents").get()?.c ?? 0
  }

  /** 有正文的条数。状态页要能区分「采到 80 篇」与「其中 30 篇有正文」。 */
  countWithBody(): number {
    return (
      this.db
        .prepare<
          [],
          { c: number }
        >("SELECT count(*) AS c FROM documents WHERE content_text IS NOT NULL AND content_text != ''")
        .get()?.c ?? 0
    )
  }

  /**
   * 库里出现过的**空间**（知识库 / 云盘目录），带各自的篇数。
   *
   * ## ★★★ 为什么空间列表只能从**已采到的文档**反推
   *
   * 渠道契约里**没有**"列出全部知识库"这个能力（`ChannelDocuments` 只有
   * `list` / `body` / `readableExtensions`）。所以"用户能勾哪些空间"这个
   * 候选集只能是"我们已经见过的那些"。
   *
   * ★★ 这带来一个**必须在界面上说清**的限制：**没采过的空间勾不到**。
   * 那与会话列表那侧的形状相同（会话目录是采集时顺带落库的），
   * 但文档这侧更明显 —— 用户第一次进设置页时可能一个空间都没有。
   *
   * 不说的话用户会以为"我的某个知识库不在列表里 = 我们漏读了"，
   * 而真相是"那个空间里的文档还没被列举到"。
   *
   * ★ 空的 `workspace_id`（NULL）归成空串那一档，`title` 给 null ——
   * 那是"这个渠道的默认空间"（散落的云盘文件），不是"未知"。
   * 与 `document_coverage` 的 `space_external_id` 用同一个判据
   * （`COALESCE(workspace_id, '')`），否则两处的分区键对不上。
   */
  listSpaces(channelId: string): { spaceExternalId: string; documents: number }[] {
    return this.db
      .prepare<[string], { space: string; c: number }>(
        `SELECT COALESCE(workspace_id, '') AS space, count(*) AS c
           FROM documents
          WHERE channel_id = ?
          GROUP BY space
          ORDER BY c DESC`,
      )
      .all(channelId)
      .map((row) => ({ spaceExternalId: row.space, documents: row.c }))
  }
}
