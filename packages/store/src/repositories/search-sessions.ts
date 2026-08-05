/**
 * 搜索会话仓储。
 *
 * 两件事这里必须做对：
 * ① **UI 渲染只读这张表**（不读 opencode 的 session）——
 *    所以 `acp_session_id` 是可写可空的旁路字段，不是主键的一部分；
 * ② 一行 = 一个 ChatItem，落库形态与渲染形态相同 ——
 *    「刷新后看到的」与「流式过程中看到的」由同一份数据驱动。
 */
import type { SqliteDatabase } from "../database.js"

export interface SearchSessionRow {
  id: string
  title: string | null
  /** opencode 侧 id。**可为空**：未建或已失效，两者都不影响历史可见 */
  acpSessionId: string | null
  acpCwd: string
  harnessId: string
  modelRole: string
  sceneId: string | null
  state: "idle" | "streaming" | "error"
  pinned: boolean
  messageCount: number
  lastActiveAt: number
  createdAt: number
  archivedAt: number | null
}

export interface CreateSearchSessionInput {
  id: string
  acpCwd: string
  title?: string | null
  harnessId?: string
  modelRole?: string
  createdAt: number
}

export interface SearchMessageRow {
  id: string
  sessionId: string
  seq: number
  role: "user" | "assistant" | "system"
  itemType: string
  /** UnifiedContentBlock[] 的 JSON */
  contentJson: string
  toolName: string | null
  toolStatus: string | null
  turnId: string | null
  usageJson: string | null
  createdAt: number
}

export interface AppendSearchMessageInput {
  id: string
  sessionId: string
  seq: number
  role: "user" | "assistant" | "system"
  itemType: string
  contentJson: string
  toolName?: string | null
  toolStatus?: string | null
  turnId?: string | null
  usageJson?: string | null
  createdAt: number
}

interface SessionDbRow {
  id: string
  title: string | null
  acp_session_id: string | null
  acp_cwd: string
  harness_id: string
  model_role: string
  scene_id: string | null
  state: "idle" | "streaming" | "error"
  pinned: number
  message_count: number
  last_active_at: number
  created_at: number
  archived_at: number | null
}

function toSession(row: SessionDbRow): SearchSessionRow {
  return {
    id: row.id,
    title: row.title,
    acpSessionId: row.acp_session_id,
    acpCwd: row.acp_cwd,
    harnessId: row.harness_id,
    modelRole: row.model_role,
    sceneId: row.scene_id,
    state: row.state,
    pinned: row.pinned === 1,
    messageCount: row.message_count,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  }
}

interface MessageDbRow {
  id: string
  session_id: string
  seq: number
  role: "user" | "assistant" | "system"
  item_type: string
  content_json: string
  tool_name: string | null
  tool_status: string | null
  turn_id: string | null
  usage_json: string | null
  created_at: number
}

function toMessage(row: MessageDbRow): SearchMessageRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    role: row.role,
    itemType: row.item_type,
    contentJson: row.content_json,
    toolName: row.tool_name,
    toolStatus: row.tool_status,
    turnId: row.turn_id,
    usageJson: row.usage_json,
    createdAt: row.created_at,
  }
}

export class SearchSessionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: CreateSearchSessionInput): SearchSessionRow {
    this.db
      .prepare(
        `INSERT INTO search_chat_sessions
           (id, title, acp_cwd, harness_id, model_role, last_active_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title ?? null,
        input.acpCwd,
        input.harnessId ?? "opencode-acp",
        input.modelRole ?? "harness.search",
        input.createdAt,
        input.createdAt,
      )
    const created = this.findById(input.id)
    if (created === null) throw new Error("创建会话后读不回该行")
    return created
  }

  findById(id: string): SearchSessionRow | null {
    const row = this.db
      .prepare<[string], SessionDbRow>("SELECT * FROM search_chat_sessions WHERE id = ?")
      .get(id)
    return row === undefined ? null : toSession(row)
  }

  /** 侧栏列表：未归档的按最近活跃排序，置顶的在前。 */
  listActive(limit = 200): SearchSessionRow[] {
    return this.db
      .prepare<[number], SessionDbRow>(
        `SELECT * FROM search_chat_sessions
          WHERE archived_at IS NULL
          ORDER BY pinned DESC, last_active_at DESC
          LIMIT ?`,
      )
      .all(limit)
      .map(toSession)
  }

  /**
   * 更新 opencode 侧的 session id。
   *
   * 降级重建时调用。刻意做成独立方法而不是 upsert 的一部分：
   * 「我们的会话」与「opencode 的 session」是两个生命周期，
   * 混在一起会让人以为重建会影响我们的历史。
   */
  updateAcpSessionId(id: string, acpSessionId: string | null): void {
    this.db
      .prepare("UPDATE search_chat_sessions SET acp_session_id = ? WHERE id = ?")
      .run(acpSessionId, id)
  }

  rename(id: string, title: string): void {
    this.db.prepare("UPDATE search_chat_sessions SET title = ? WHERE id = ?").run(title, id)
  }

  setPinned(id: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE search_chat_sessions SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, id)
  }

  setState(id: string, state: SearchSessionRow["state"], at: number): void {
    this.db
      .prepare("UPDATE search_chat_sessions SET state = ?, last_active_at = ? WHERE id = ?")
      .run(state, at, id)
  }

  /** 归档而不是物理删：用户可能只是想把它从列表里挪走。真删走 remove()。 */
  archive(id: string, at: number): void {
    this.db.prepare("UPDATE search_chat_sessions SET archived_at = ? WHERE id = ?").run(at, id)
  }

  remove(id: string): void {
    // 消息与引用走 ON DELETE CASCADE
    this.db.prepare("DELETE FROM search_chat_sessions WHERE id = ?").run(id)
  }

  /**
   * 追加消息。
   *
   * `INSERT OR IGNORE` + UNIQUE(session_id, seq)：同 seq 重复写入被吃掉。
   * 这是 replay 抑制的**第三道**防线（前两道在 reducer 里），
   * 挡的是"抑制窗口漏了、hash 也没命中"的残余情况。
   */
  appendMessages(inputs: readonly AppendSearchMessageInput[]): number {
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO search_chat_messages
         (id, session_id, seq, role, item_type, content_json, tool_name, tool_status,
          turn_id, usage_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let inserted = 0
    for (const input of inputs) {
      inserted += statement.run(
        input.id,
        input.sessionId,
        input.seq,
        input.role,
        input.itemType,
        input.contentJson,
        input.toolName ?? null,
        input.toolStatus ?? null,
        input.turnId ?? null,
        input.usageJson ?? null,
        input.createdAt,
      ).changes
    }
    if (inserted > 0) this.refreshMessageCount(inputs[0]?.sessionId ?? "")
    return inserted
  }

  /** 更新已有 item（tool_call 从 running 变 success 时用）。 */
  updateMessage(
    id: string,
    patch: { contentJson?: string; toolStatus?: string; usageJson?: string },
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (patch.contentJson !== undefined) {
      sets.push("content_json = ?")
      values.push(patch.contentJson)
    }
    if (patch.toolStatus !== undefined) {
      sets.push("tool_status = ?")
      values.push(patch.toolStatus)
    }
    if (patch.usageJson !== undefined) {
      sets.push("usage_json = ?")
      values.push(patch.usageJson)
    }
    if (sets.length === 0) return
    values.push(id)
    this.db
      .prepare(`UPDATE search_chat_messages SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(values as never[]))
  }

  messages(sessionId: string): SearchMessageRow[] {
    return this.db
      .prepare<
        [string],
        MessageDbRow
      >("SELECT * FROM search_chat_messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId)
      .map(toMessage)
  }

  /** 下一个 seq。reducer 的 startSeq 用它，保证重启后接续而不是从 1 覆盖。 */
  nextSeq(sessionId: string): number {
    const row = this.db
      .prepare<
        [string],
        { max: number | null }
      >("SELECT MAX(seq) AS max FROM search_chat_messages WHERE session_id = ?")
      .get(sessionId)
    return (row?.max ?? 0) + 1
  }

  messageCount(sessionId: string): number {
    return (
      this.db
        .prepare<
          [string],
          { c: number }
        >("SELECT count(*) AS c FROM search_chat_messages WHERE session_id = ?")
        .get(sessionId)?.c ?? 0
    )
  }

  private refreshMessageCount(sessionId: string): void {
    if (sessionId === "") return
    this.db
      .prepare(
        `UPDATE search_chat_sessions
            SET message_count = (
              SELECT count(*) FROM search_chat_messages WHERE session_id = ?
            )
          WHERE id = ?`,
      )
      .run(sessionId, sessionId)
  }
}
