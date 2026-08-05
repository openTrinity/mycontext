/**
 * 索引表仓储：FTS5（contentless + bigram）与向量。
 *
 * 这两张表是**派生数据**：随时可从 `messages` 重建，因此不进备份体积统计，
 * 重建也不需要 DDL —— 只要回拨对应消费者的游标即可。
 *
 * FTS 的写入形态由 `@mycontext/retrieval` 的 bigram 切分决定（那是 L3），
 * 这里只负责「把切好的串存进去 / 按 MATCH 查回 message_id」，不理解分词语义。
 * 这条分工让 L2 不依赖 L3。
 */
import type { SqliteDatabase } from "../database.js"

export interface FtsHit {
  messageId: string
  conversationId: string
  /** bm25 分数（越小越相关，SQLite 的约定）。contentless 下依然可用，
   *  但 detail='none' 下会全为 0 —— 那个配置因此不可用。 */
  score: number
}

export class FtsIndexRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 建/更新某条消息的索引行。
   *
   * rowid 由 `messages_fts_state` 分配（AUTOINCREMENT），FTS 侧只写 rowid ——
   * 因为 contentless 表的 `UNINDEXED` 列**读出来是 NULL**（实测），
   * 存不住 message_id 映射。
   *
   * @param seg 已 bigram 化的可检索串（由调用方切好）
   */
  upsert(input: {
    messageId: string
    conversationId: string
    seg: string
    contentHash: string
    indexedAt: number
  }): "inserted" | "updated" | "unchanged" {
    const existing = this.db
      .prepare<
        [string],
        { rowid_alias: number; content_hash: string }
      >("SELECT rowid_alias, content_hash FROM messages_fts_state WHERE message_id = ?")
      .get(input.messageId)

    if (existing !== undefined) {
      if (existing.content_hash === input.contentHash) return "unchanged"
      // 内容变了（消息被编辑/撤回）→ 删旧行再插同 rowid。
      // DELETE 需要建表时带 contentless_delete=1，否则直接报错（实测）。
      this.db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(existing.rowid_alias)
      this.db
        .prepare("INSERT INTO messages_fts(rowid, seg) VALUES (?, ?)")
        .run(existing.rowid_alias, input.seg)
      this.db
        .prepare(
          `UPDATE messages_fts_state
              SET conversation_id = ?, content_hash = ?, indexed_at = ?
            WHERE message_id = ?`,
        )
        .run(input.conversationId, input.contentHash, input.indexedAt, input.messageId)
      return "updated"
    }

    const info = this.db
      .prepare(
        `INSERT INTO messages_fts_state
           (message_id, conversation_id, content_hash, indexed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.messageId, input.conversationId, input.contentHash, input.indexedAt)
    this.db
      .prepare("INSERT INTO messages_fts(rowid, seg) VALUES (?, ?)")
      .run(Number(info.lastInsertRowid), input.seg)
    return "inserted"
  }

  /**
   * 检索。
   *
   * @param matchExpr 已**逐 token 转义**的 MATCH 表达式（见 retrieval/match-expr）。
   *   未转义的用户输入会被当 FTS5 语法执行：实测 `-沙箱` 直接抛
   *   `no such column: 沙箱` —— 用户输入一个 `-` 就 500，不是边缘情况。
   * @param conversationIds 作用域限制。**这是隐私边界**：persona 侧的 token
   *   决定它能看哪些会话，条件由调用方硬加，不接受 agent 传参。
   */
  search(
    matchExpr: string,
    options: { limit?: number; conversationIds?: readonly string[] } = {},
  ): FtsHit[] {
    const limit = options.limit ?? 50
    const scope = options.conversationIds

    if (scope !== undefined && scope.length === 0) return []

    const scopeClause =
      scope === undefined ? "" : `AND s.conversation_id IN (${scope.map(() => "?").join(",")})`

    const rows = this.db
      .prepare<unknown[], { message_id: string; conversation_id: string; score: number }>(
        `SELECT s.message_id, s.conversation_id, bm25(messages_fts) AS score
           FROM messages_fts
           JOIN messages_fts_state s ON s.rowid_alias = messages_fts.rowid
          WHERE messages_fts MATCH ? ${scopeClause}
          ORDER BY score
          LIMIT ?`,
      )
      .all(matchExpr, ...(scope ?? []), limit)

    return rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      score: row.score,
    }))
  }

  /** 该消息是否已建索引且内容未变（增量建索引的跳过判断）。 */
  isCurrent(messageId: string, contentHash: string): boolean {
    const row = this.db
      .prepare<
        [string, string],
        { c: number }
      >("SELECT count(*) AS c FROM messages_fts_state WHERE message_id = ? AND content_hash = ?")
      .get(messageId, contentHash)
    return (row?.c ?? 0) > 0
  }

  remove(messageId: string): void {
    const existing = this.db
      .prepare<
        [string],
        { rowid_alias: number }
      >("SELECT rowid_alias FROM messages_fts_state WHERE message_id = ?")
      .get(messageId)
    if (existing === undefined) return
    this.db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(existing.rowid_alias)
    this.db.prepare("DELETE FROM messages_fts_state WHERE message_id = ?").run(messageId)
  }

  count(): number {
    return (
      this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM messages_fts_state").get()?.c ??
      0
    )
  }

  /**
   * 完整性自检。
   *
   * 索引与源表失配是**静默故障**（搜不到但不报错），必须有主动检测：
   * 每次全量重建后跑一次，启动时也跑一次。
   */
  integrityCheck(): { ok: boolean; error?: string } {
    try {
      this.db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }
}

export interface VectorRecord {
  messageId: string
  dim: number
  embedding: Buffer
  quant: "int8" | "float32"
  scale: number | null
  model: string
  embeddedAt: number
}

export class VectorRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsertMany(records: readonly VectorRecord[]): void {
    const statement = this.db.prepare(
      `INSERT INTO message_vectors
         (message_id, dim, embedding, quant, scale, model, embedded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         dim = excluded.dim, embedding = excluded.embedding, quant = excluded.quant,
         scale = excluded.scale, model = excluded.model, embedded_at = excluded.embedded_at`,
    )
    for (const record of records) {
      statement.run(
        record.messageId,
        record.dim,
        record.embedding,
        record.quant,
        record.scale,
        record.model,
        record.embeddedAt,
      )
    }
  }

  /**
   * 加载常驻向量。
   *
   * 有上限与时间窗是刻意的：实测 1024 维 int8 = 1KB/条 → 20 万条约 200MB，
   * 这是可接受的上限。超过后只常驻最近的部分，更早的走 FTS + 会话二次筛。
   * **降级必须可见**（状态页显示常驻/总数），不能静默变差。
   */
  loadResident(options: { limit?: number; sinceMs?: number } = {}): VectorRecord[] {
    const limit = options.limit ?? 200_000
    const since = options.sinceMs
    const sql =
      since === undefined
        ? `SELECT v.* FROM message_vectors v
             JOIN messages m ON m.id = v.message_id
            ORDER BY m.sent_at DESC LIMIT ?`
        : `SELECT v.* FROM message_vectors v
             JOIN messages m ON m.id = v.message_id
            WHERE m.sent_at >= ?
            ORDER BY m.sent_at DESC LIMIT ?`
    const rows =
      since === undefined
        ? this.db.prepare<[number], VectorDbRow>(sql).all(limit)
        : this.db.prepare<[number, number], VectorDbRow>(sql).all(since, limit)
    return rows.map(toVector)
  }

  has(messageId: string): boolean {
    const row = this.db
      .prepare<
        [string],
        { c: number }
      >("SELECT count(*) AS c FROM message_vectors WHERE message_id = ?")
      .get(messageId)
    return (row?.c ?? 0) > 0
  }

  count(): number {
    return (
      this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM message_vectors").get()?.c ?? 0
    )
  }

  /** 记一次 embedding 失败。一批失败不能卡住整条游标，所以单独计数。 */
  recordFailure(messageId: string, error: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO vector_failures (message_id, attempts, last_error, last_attempt_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           attempts = attempts + 1, last_error = excluded.last_error,
           last_attempt_at = excluded.last_attempt_at`,
      )
      .run(messageId, error.slice(0, 300), at)
  }

  countFailures(): number {
    return (
      this.db.prepare<[], { c: number }>("SELECT count(*) AS c FROM vector_failures").get()?.c ?? 0
    )
  }
}

interface VectorDbRow {
  message_id: string
  dim: number
  embedding: Buffer
  quant: string
  scale: number | null
  model: string
  embedded_at: number
}

function toVector(row: VectorDbRow): VectorRecord {
  return {
    messageId: row.message_id,
    dim: row.dim,
    embedding: row.embedding,
    quant: row.quant === "float32" ? "float32" : "int8",
    scale: row.scale,
    model: row.model,
    embeddedAt: row.embedded_at,
  }
}
