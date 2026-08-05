/**
 * 采集游标仓储。
 *
 * 三个字段各管一件事，混用会**静默丢消息**：
 *   window_start/window_end  当前正在处理的时间窗（尚未确认完成）
 *   cursor                   该窗内分页的 nextCursor（首页 "0"）
 *   watermark                已**完整落库**的时间水位
 *
 * 关键规则：只有整窗的所有分页都确认入库后，watermark 才推进到 window_end。
 * 半途崩溃 → watermark 不动 → 下次整窗重跑（靠 payload_hash 幂等兜住）。
 * 「取一页推一次水位」会在崩溃时永久丢掉窗口尾部的消息，而且看起来像采到了。
 */
import type { Clock } from "@mycontext/kernel"
import type { SqliteDatabase } from "../database.js"
import type { SyncCursorRow } from "./types.js"

interface CursorDbRow {
  scope: string
  cursor: string | null
  window_start: number | null
  window_end: number | null
  watermark: number
  page_count: number
  truncated: number
  status: "idle" | "running" | "failed" | "done"
  last_error: string | null
  attempts: number
  updated_at: number
}

function toCursor(row: CursorDbRow): SyncCursorRow {
  return {
    scope: row.scope,
    cursor: row.cursor,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    watermark: row.watermark,
    pageCount: row.page_count,
    truncated: row.truncated === 1,
    status: row.status,
    lastError: row.last_error,
    attempts: row.attempts,
    updatedAt: row.updated_at,
  }
}

export class SyncCursorRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  get(scope: string): SyncCursorRow | null {
    const row = this.db
      .prepare<[string], CursorDbRow>("SELECT * FROM sync_cursors WHERE scope = ?")
      .get(scope)
    return row === undefined ? null : toCursor(row)
  }

  /** 水位。没有这一行时返回 0（首次采集，调用方据此决定回溯起点）。 */
  watermark(scope: string): number {
    return this.get(scope)?.watermark ?? 0
  }

  /** 开一个新窗口：写下 window 边界与 running 状态，但**不动** watermark。 */
  beginWindow(scope: string, windowStart: number, windowEnd: number): void {
    const now = this.clock.now()
    this.db
      .prepare(
        `INSERT INTO sync_cursors
           (scope, cursor, window_start, window_end, watermark, page_count, truncated,
            status, attempts, updated_at)
         VALUES (?, '0', ?, ?, 0, 0, 0, 'running', 0, ?)
         ON CONFLICT(scope) DO UPDATE SET
           cursor = '0', window_start = excluded.window_start,
           window_end = excluded.window_end, page_count = 0, truncated = 0,
           status = 'running', last_error = NULL, updated_at = excluded.updated_at`,
      )
      .run(scope, windowStart, windowEnd, now)
  }

  /** 记录分页推进。注意**只**动 cursor 与 page_count，watermark 保持不变。 */
  advancePage(scope: string, nextCursor: string | null): void {
    this.db
      .prepare(
        `UPDATE sync_cursors
            SET cursor = ?, page_count = page_count + 1, updated_at = ?
          WHERE scope = ?`,
      )
      .run(nextCursor, this.clock.now(), scope)
  }

  /**
   * 整窗确认完成 → 推进 watermark。
   *
   * `effectiveEnd` 应传**服务端返回的最大业务时间**而不是本地 `now`：
   * 本地时钟慢时 `window_end` 会小于服务端最新时间，用本地值推水位
   * 会让重叠窗口失效，进而漏掉那段差值里的消息。
   *
   * ## ★ 必须是 upsert，不能是纯 UPDATE
   *
   * 原来这里是 `UPDATE ... WHERE scope = ?` —— 那一行不存在时它
   * **静默 no-op**（sqlite 的 UPDATE 影响 0 行不是错误）。
   * 实时路碰不到这个坑，因为 `beginWindow` 总在前面把行建出来；
   * 但任何"先 commit 后 begin"的调用序列都会静默丢掉这次推进，
   * 而表现是"进度永远是 0"，与"回溯还没开始跑"完全同形。
   *
   * `MAX(watermark, excluded.watermark)` 在冲突分支上保住了原有的
   * 「只增不减」语义。
   */
  commitWindow(scope: string, effectiveEnd: number): void {
    const now = this.clock.now()
    this.db
      .prepare(
        `INSERT INTO sync_cursors
           (scope, cursor, window_start, window_end, watermark, page_count, truncated,
            status, attempts, updated_at)
         VALUES (?, NULL, NULL, NULL, ?, 0, 0, 'idle', 0, ?)
         ON CONFLICT(scope) DO UPDATE SET
           watermark = MAX(sync_cursors.watermark, excluded.watermark), cursor = NULL,
           status = 'idle', attempts = 0, last_error = NULL, updated_at = excluded.updated_at`,
      )
      .run(scope, effectiveEnd, now)
  }

  /**
   * 反向回填：把**下界**往更早的时间推。
   *
   * ## ★ 为什么不能用 `commitWindow`
   *
   * 那个是 `MAX(watermark, ?)` —— 单向**前进**，专门防水位回退。
   * 回填走的是相反方向（下界要越来越小），用它等于什么都不做。
   *
   * ## ★ 为什么不是裸的 `MIN(watermark, ?)`
   *
   * `beginWindow` 给新 scope 插的是 `watermark = 0`，而 `MIN(0, floor)`
   * 恒为 0 —— 下界会永久卡在 0，读起来像「已经回填到 1970 年了」，
   * 于是回填在第一轮之后就再也不跑，且看起来是**完成**的状态。
   *
   * 所以 0 显式表示「还没记过下界」：真实下界总是正的 unix ms，
   * 两者不会混淆。
   *
   * @param floor 已确认**完整落库**的时间左端。约束与 `commitWindow` 对称：
   *   调用方必须保证 `[floor, 原下界)` 区间内的所有分页都已落库。
   */
  commitFloor(scope: string, floor: number): void {
    const now = this.clock.now()
    this.db
      .prepare(
        `INSERT INTO sync_cursors
           (scope, cursor, window_start, window_end, watermark, page_count, truncated,
            status, attempts, updated_at)
         VALUES (?, NULL, NULL, NULL, ?, 0, 0, 'idle', 0, ?)
         ON CONFLICT(scope) DO UPDATE SET
           watermark = CASE WHEN sync_cursors.watermark = 0
                            THEN excluded.watermark
                            ELSE MIN(sync_cursors.watermark, excluded.watermark) END,
           cursor = NULL, status = 'idle', attempts = 0, last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(scope, floor, now)
  }

  /** 失败：记录原因并累加尝试次数，watermark 保持不动（下次整窗重跑）。 */
  failWindow(scope: string, error: string): void {
    const now = this.clock.now()
    this.db
      .prepare(
        `INSERT INTO sync_cursors
           (scope, cursor, window_start, window_end, watermark, page_count, truncated,
            status, last_error, attempts, updated_at)
         VALUES (?, NULL, NULL, NULL, 0, 0, 0, 'failed', ?, 1, ?)
         ON CONFLICT(scope) DO UPDATE SET
           status = 'failed', last_error = excluded.last_error,
           attempts = sync_cursors.attempts + 1, updated_at = excluded.updated_at`,
      )
      .run(scope, error.slice(0, 500), now)
  }

  /** 疑似被服务端截断：调用方会把该窗二分切小重取。 */
  markTruncated(scope: string): void {
    this.db
      .prepare("UPDATE sync_cursors SET truncated = 1, updated_at = ? WHERE scope = ?")
      .run(this.clock.now(), scope)
  }

  /**
   * 钉住回溯链的终点。
   *
   * ## ★ 为什么这是一个**只写一次**的操作
   *
   * 回溯的终点是"实时路的起点"（`now - 7d`），而那是个随挂钟移动的值。
   * 每轮重算的话终点一直往前爬，而回溯每轮只推进一天 —— 补到最后
   * 那一天之后终点永远比进度多出一小段，于是**这条链永不结束**：
   * 每 2 分钟去拉一个几分钟宽的窗，而那段时间实时路本来就在拉。
   *
   * 所以第一次问的时候把它算出来存住，之后一直用那个值。
   * 存在 `window_end` 上：那一列在回溯这条 scope 上没有别的用途
   * （回溯不做截断检测、也不靠它崩溃恢复）。
   *
   * `WHERE window_end IS NULL` 是这个"只写一次"的执行者 ——
   * 放在 SQL 里而不是调用方的 if，是因为调用方那一侧要判两次
   * （读一次、写一次），中间的竞态会让两个进程冻出不同的终点。
   */
  freezeBackfillCeiling(scope: string, ceiling: number): void {
    const now = this.clock.now()
    this.db
      .prepare(
        `INSERT INTO sync_cursors
           (scope, cursor, window_start, window_end, watermark, page_count, truncated,
            status, attempts, updated_at)
         VALUES (?, NULL, NULL, ?, 0, 0, 0, 'idle', 0, ?)
         ON CONFLICT(scope) DO UPDATE SET
           window_end = excluded.window_end, updated_at = excluded.updated_at
         WHERE sync_cursors.window_end IS NULL`,
      )
      .run(scope, ceiling, now)
  }

  /**
   * 标记"这一窗正在跑"，**不动** window_end。
   *
   * 与 `beginWindow` 的区别就是这一点：回溯链把 `window_end` 当作
   * 冻住的终点存着（见 `freezeBackfillCeiling`），用 `beginWindow`
   * 会把它覆盖掉，于是每轮重新冻一次 —— 那正是"回溯永不结束"那个 bug。
   */
  markRunning(scope: string, windowStart: number): void {
    const now = this.clock.now()
    this.db
      .prepare(
        `UPDATE sync_cursors
            SET window_start = ?, cursor = '0', page_count = 0,
                status = 'running', last_error = NULL, updated_at = ?
          WHERE scope = ?`,
      )
      .run(windowStart, now, scope)
  }

  list(): SyncCursorRow[] {
    return this.db
      .prepare<[], CursorDbRow>("SELECT * FROM sync_cursors ORDER BY scope")
      .all()
      .map(toCursor)
  }
}

export interface ProbeSnapshot {
  channelId: string
  conversationExternalId: string
  lastMsgAt: number | null
  unreadCount: number | null
  observedAt: number
}

/**
 * 探针快照仓储。
 *
 * 廉价探针（实测约 0.7s）与上次快照比对，决定是否值得付正文拉取的成本（约 0.6s）。
 * 已知盲区：用户在客户端读过的会话会从未读列表消失，此时探针探不到 ——
 * 因此正文层保留固定周期的兜底轮询。**不追求零延迟，追求零丢失。**
 */
export class ProbeSnapshotRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(channelId: string, conversationExternalId: string): ProbeSnapshot | null {
    const row = this.db
      .prepare<
        [string, string],
        {
          channel_id: string
          conversation_external_id: string
          last_msg_at: number | null
          unread_count: number | null
          observed_at: number
        }
      >(
        `SELECT * FROM probe_snapshots
          WHERE channel_id = ? AND conversation_external_id = ?`,
      )
      .get(channelId, conversationExternalId)
    if (row === undefined) return null
    return {
      channelId: row.channel_id,
      conversationExternalId: row.conversation_external_id,
      lastMsgAt: row.last_msg_at,
      unreadCount: row.unread_count,
      observedAt: row.observed_at,
    }
  }

  upsert(snapshot: ProbeSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO probe_snapshots
           (channel_id, conversation_external_id, last_msg_at, unread_count, observed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, conversation_external_id) DO UPDATE SET
           last_msg_at = excluded.last_msg_at,
           unread_count = excluded.unread_count,
           observed_at = excluded.observed_at`,
      )
      .run(
        snapshot.channelId,
        snapshot.conversationExternalId,
        snapshot.lastMsgAt,
        snapshot.unreadCount,
        snapshot.observedAt,
      )
  }

  /** 完整未读快照中缺席的已知会话，明确回填为已读。 */
  markAbsentAsRead(
    channelId: string,
    unreadConversationExternalIds: readonly string[],
    observedAt: number,
  ): number {
    const placeholders = unreadConversationExternalIds.map(() => "?").join(",")
    const exclusion =
      unreadConversationExternalIds.length === 0
        ? ""
        : ` AND c.external_id NOT IN (${placeholders})`
    const snapshotExclusion =
      unreadConversationExternalIds.length === 0
        ? ""
        : ` AND conversation_external_id NOT IN (${placeholders})`
    const updated = this.db
      .prepare(
        `UPDATE probe_snapshots
            SET unread_count = 0, observed_at = ?
          WHERE channel_id = ?${snapshotExclusion}`,
      )
      .run(observedAt, channelId, ...unreadConversationExternalIds)
    const inserted = this.db
      .prepare(
        `INSERT INTO probe_snapshots
           (channel_id, conversation_external_id, last_msg_at, unread_count, observed_at)
         SELECT c.channel_id, c.external_id, c.last_message_at, 0, ?
           FROM conversations c
          WHERE c.channel_id = ?${exclusion}
         ON CONFLICT(channel_id, conversation_external_id) DO UPDATE SET
           last_msg_at = MAX(
             COALESCE(probe_snapshots.last_msg_at, 0),
             COALESCE(excluded.last_msg_at, 0)
           ),
           unread_count = 0,
           observed_at = excluded.observed_at`,
      )
      .run(observedAt, channelId, ...unreadConversationExternalIds)
    return updated.changes + inserted.changes
  }

  /**
   * 对账：**探针说有更新、而我们库里没有**的那些会话。
   *
   * ## ★ 为什么必须有这个查询（实测数据）
   *
   * 时间窗那套（水位 + 2 分钟重叠 + 5 分钟前探）在"消息按时到达"时是对的，
   * 但它有一个结构性的漏洞：**服务端延迟超过重叠窗**时，那段时间已经被
   * 水位推过去了，固定窗口**再也不会覆盖它**。
   *
   * 实测这台机器（92 个会话）：
   * · 10 个会话的探针 `lastMsgAt` 晚于我们库里该会话的最新消息；
   * · 最严重的落后 **559 分钟**（探针 19:49，我们 10:30）；
   * · 其中 3 个会话我们**一条消息都没有**（探针却说有未读 1 / 35 / 35）。
   *
   * 而 watermark 已经推到了这些时间之后 —— 也就是说这些消息**永久漏采**，
   * 而界面上没有任何迹象（采集状态是 idle、没有错误）。
   *
   * ## 判据是「探针 vs 我们库里」，不是「探针 vs 水位」
   *
   * 水位是全局的一个时间点，而漏采是**逐会话**的。用水位比会漏掉
   * "水位很新但某个会话落后很多"这种情况 —— 那恰好是上面那 10 个。
   *
   * ## 只返回 externalId + 该从哪个时间点补
   *
   * 补哪一段由调用方决定（它知道窗口预算）。给出 `fromMs` 是因为
   * "从我们库里那条的时间开始"比"从探针说的时间开始"更保险：
   * 中间那段可能不止一条。
   */
  staleConversations(
    channelId: string,
    options: { toleranceMs?: number; limit?: number } = {},
  ): { conversationExternalId: string; probeLastMsgAt: number; oursLastMsgAt: number | null }[] {
    /**
     * 容差：探针与我们的时间戳来自不同来源，秒级抖动不算漏采。
     *
     * ★ 实测两条抖动样本：探针 21:37:19 vs 我们 21:36:34（45 秒）、
     * 探针 18:50:25 vs 我们 18:50:22（3 秒）—— 那两个会话的消息其实
     * 都采到了，只是探针的 `lastMsgCreateAt` 与消息的 `sentAt` 不是
     * 同一个口径。而真实的漏采是**分钟到小时**量级（实测 6 / 43 / 235 /
     * 559 分钟、以及三个 ∞）。
     *
     * 取 60 秒把抖动挡在外面，同时最小的真实落后（6 分钟）仍然报得出来。
     * 取太大（比如 5 分钟）会掩盖"刚刚漏了一条"，那是这个查询的主要用途。
     */
    const tolerance = options.toleranceMs ?? 60_000
    return this.db
      .prepare<
        [string, number, number],
        { external_id: string; probe_last: number; ours_last: number | null }
      >(
        `SELECT p.conversation_external_id AS external_id,
                p.last_msg_at              AS probe_last,
                (SELECT MAX(m.sent_at)
                   FROM messages m
                   JOIN conversations c ON c.id = m.conversation_id
                  WHERE c.channel_id = p.channel_id
                    AND c.external_id = p.conversation_external_id) AS ours_last
           FROM probe_snapshots p
          WHERE p.channel_id = ?
            AND p.last_msg_at IS NOT NULL
            AND (ours_last IS NULL OR p.last_msg_at > ours_last + ?)
          ORDER BY p.last_msg_at DESC
          LIMIT ?`,
      )
      .all(channelId, tolerance, options.limit ?? 20)
      .map((row) => ({
        conversationExternalId: row.external_id,
        probeLastMsgAt: row.probe_last,
        oursLastMsgAt: row.ours_last,
      }))
  }
}
