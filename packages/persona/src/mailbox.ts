/**
 * 入站信箱。
 *
 * 内存队列 + `dh_inbox` 持久化镜像：崩溃重启不丢待处理消息。
 *
 * ## 为什么要合并同会话的短时间连发
 *
 * 用户在群里连打三句话（「那个」「沙箱的事」「你看一下」），
 * 逐条回复会得到三条刷屏式回应 —— 而人类会等他说完再回。
 * 3 秒窗口是折中：足够合并连打，又不至于让人觉得没反应。
 *
 * ## ★ 一个 turn 在跑时新来的消息去哪了
 *
 * 进 `pending`，下一轮 tick 一起取走 —— 也就是"累积成未处理列表下次一起给"。
 * 这是**刻意的**：turn 里 agent 正在读上下文，中途插消息会让它回一个
 * 半截的东西。
 *
 * 但累积必须有上限：一个活跃群 10 分钟能来上百条，全塞进 prompt 会
 * **爆 context**，而爆的形态是模型返回一个截断的回复或直接报错。
 * 所以 `takeBatch` 有 `MAX_BATCH_SIZE`，**取最新的**并把丢下的条数报出来
 * （取最新而不是最早：数字人要回的是"现在在说什么"）。
 *
 * ## ★ 按 message_id 去重（防消费者重放导致重复处理）
 *
 * 进程内信号（快）与 Outbox 兜底扫描（慢）可能送来同一条消息。
 * 去重键是 `message_id` 而不是"哪条路来的" —— 后者要求两条路的
 * 时序有保证，而那正是分布式里最不该假设的东西。
 */
import type { Clock } from "@mycontext/kernel"
import type { SqliteDatabase } from "@mycontext/store"

/**
 * 丢弃原因。
 *
 * ★ 这里**没有** `not_listening`：那是 `listening` 开关时代的原因，
 * 而那个开关已经删掉了（见 `supervisor.ts` 的文件头）。留着它会让
 * "用户没管过这个会话"看起来仍是一个丢弃理由。
 */
export type DropReason =
  | "bot_channel"
  | "self_conversation"
  | "already_answered"
  | "stale_message"
  | "batch_overflow"
  | "origin_agent"
  | "is_self"
  | "trigger_not_matched"
  /**
   * 会话的触发条件是「不触发」（`triggerMode: "none"`）。
   *
   * ★ 与 `trigger_not_matched` **分开**是刻意的，尽管两者都是"没触发"：
   * · `trigger_not_matched` = 条件配着、这条消息**碰巧**没命中
   *   （群里没 @我 / 没命中关键词）—— 用户可能想调条件；
   * · `trigger_none` = 用户**明确**说了这个会话不要管 —— 那是预期，
   *   不该出现在"为什么没回"的排查列表里。
   *
   * 合成一个的话前者会被后者的量淹掉（"不触发"的会话每条消息都记一次），
   * 而排查"我 @它了怎么没回"时那份日志就没用了。
   */
  | "trigger_none"
  | "kill_switch"

export interface InboxEntry {
  messageId: string
  conversationId: string
  enqueuedAt: number
}

/** 一批的条数上限。超出的**丢最早的**，并把丢了几条报给调用方。 */
export const MAX_BATCH_SIZE = 30

/**
 * 同一批连续失败多少次之后放弃。
 *
 * 不设上限的话，一条会让模型报错的消息（比如超长、或含让网关 400 的字符）
 * 会**永远**留在 pending 里每 8 秒重试一次 —— 烧配额且日志被刷满，
 * 而表现只是"这个会话一直没有回复"。
 */
export const MAX_TURN_ATTEMPTS = 3

export interface TakenBatch {
  entries: InboxEntry[]
  /**
   * 因为超过上限而**没进这一批**的条数。
   *
   * 必须报出来：不报的话"合并了 200 条"与"只看了最新 30 条"在结果上
   * 分不出来，而后者意味着 agent 漏看了前面的上下文。
   */
  overflow: number
}

export interface MailboxOptions {
  db: SqliteDatabase
  clock: Clock
  /** 同会话消息的合并窗口 */
  batchWindowMs?: number
  /**
   * 「对方说完了」的静默期。见 `DEFAULT_QUIET_MS`。
   *
   * 0 = 关掉这个判据（只看固定窗口）。测试里压缩时间用；生产别设 0 ——
   * 那就退回了"起草期间又来一条 → 草稿立刻作废"的老行为。
   */
  quietMs?: number
  /** 一批的条数上限 */
  maxBatchSize?: number
}

/**
 * 同会话消息的合并窗口。
 *
 * ★ 导出是为了让**唤醒**能对齐它：投递后立刻跑一轮调度只会拿到空批次
 * （`takeBatch` 会因为"最老那条还没等够窗口"而返回空），
 * 于是白跑一趟、消息还是要等下一个定时器 —— 那正是接唤醒之前的行为。
 * 唤醒必须排在 `窗口 + 一点余量` 之后。见 `persona.service.ts` 的 `wake()`。
 */
export const DEFAULT_BATCH_WINDOW_MS = 3000

/**
 * ★ 「对方还在说」的静默期 —— 合并窗口的第二个判据。
 *
 * ## 为什么固定窗口不够（真机实测的失效）
 *
 * 固定窗口只问"最老那条等够了吗"。对方以 5–10 秒的间隔连发时，第一条一到
 * 3 秒就开跑，而一轮起草要 4–6 秒 —— 于是下一条消息必然在起草期间到达，
 * 刚生成的草稿立刻被 `supersedeDraftsWithNewerInbound` 判
 * `superseded_by_newer_message`。
 *
 * 实测形态：一串 4 条、跨 70 余秒的连发产出 2 条草稿，**两条都被作废**。
 * 用户侧的表现是"最新这几条压根没起草"，而实际是起草了、烧了 token、
 * 然后自动扔掉。最该合并的场景反而一条都合不上。
 *
 * ## 判据：最后一条静默这么久，才认为"他说完了"
 *
 * 所以窗口有两个条件，**都要满足**：
 * · 最老那条等够 `batchWindowMs`（保证不会无限期攒着不回）；
 * · 最新那条静默够 `quietMs`（保证不在对方打字中途插话）。
 *
 * 6 秒的来源不是猜的：它要覆盖一轮起草的耗时（实测 4–6 秒），否则"起草期间
 * 又来一条"这个失效依然存在。比 3 秒的窗口长，但比 forge 侧判"这几条是一件事"
 * 的 `burst.gapSeconds`（300 秒）短得多 —— 那个尺度用在这里会让单条消息也等 5 分钟。
 *
 * ## 代价说清楚
 *
 * 对方**只发一条**时，首次响应从 3 秒变成 6 秒。这是刻意的取舍：一条晚 3 秒
 * 的回复没人察觉，而一条答非所问的回复（或者干脆没有回复）是可见的失败。
 */
export const DEFAULT_QUIET_MS = 6000

/** 已明确读过且超过这个时间仍未回复的消息，不再进入待审队列。 */
export const READ_REPLY_EXPIRY_MS = 4 * 60 * 60_000

/**
 * **无条件**的起草年龄上限 —— 与"读没读过"无关。
 *
 * ## ★ 为什么必须有这一条
 *
 * `READ_REPLY_EXPIRY_MS` 那条带 `conversationRead` 前置条件，也就是
 * **未读的群没有任何年龄上限**。实测踩过：历史回填把 7/13 的消息补进库，
 * 数字人给一条 **19 天前**的群消息起了草稿，而那个群有 3 条未读 ——
 * 于是既过不了"已读"这一关，也没有别的判据拦它。
 *
 * 「已读」应该只影响**多久算过时**（读过的更快过期），不该决定
 * **到底会不会过期**。一条躺了三周没人管的消息，不管读没读都已经过时了。
 *
 * ## 群 24 小时 / 单聊 4 小时
 *
 * 群里 @我 给一整天：跨夜、跨周末回一句"这个我看下"仍然是正常的社交动作。
 * 单聊沿用 4 小时：一对一等一天才回，那条回复本身就变成了另一个问题
 * （而且单聊没有"消息被别人接手了"这种自然消解）。
 *
 * 这两个数是**兜底**，不是主判据：正常路径下补历史根本不该投给数字人
 * （见 `IngestService.persist` 的 `backfill`）。这一条防的是"将来又出现
 * 某条灌历史数据的路径"，而那种 bug 的表现是静默烧 token。
 */
export const MAX_GROUP_DRAFTABLE_AGE_MS = 24 * 60 * 60_000
export const MAX_DIRECT_DRAFTABLE_AGE_MS = READ_REPLY_EXPIRY_MS

export class Mailbox {
  /** conversationId → 待处理消息（内存队列，DB 是镜像） */
  private readonly pending = new Map<string, InboxEntry[]>()
  /**
   * 已见过的 message_id。
   *
   * ★★ 去重原来防的是"两条投递路投同一条"（快通道 + changelog）。
   * 快通道已删（v4 §4），而它现在防的是**另一件事**：消费者的租约被
   * 抢占后**从 `acked_seq` 重放**（`consumer.ts` 那套），于是同一批消息
   * 会被再投一遍。
   *
   * 坏掉的表现是同一条消息被处理两遍 → **可能重复发送**
   * （不可逆的社交后果，比重复花钱严重）。
   */
  private readonly seen = new Set<string>()
  /** conversationId → 连续失败次数（成功即清零） */
  private readonly failures = new Map<string, number>()
  /** 热改过的批次上限（设置里调完立刻生效，不等重启） */
  private overrideMaxBatchSize: number | null = null

  setMaxBatchSize(size: number): void {
    this.overrideMaxBatchSize = size
  }

  constructor(private readonly options: MailboxOptions) {}

  /**
   * 入队。返回 false 表示重复（已被另一条通路收下）。
   *
   * 同时写 DB：崩溃重启后 `restore()` 能把它们捞回来。
   */
  push(entry: { messageId: string; conversationId: string }): boolean {
    if (this.seen.has(entry.messageId)) return false
    this.seen.add(entry.messageId)

    const now = this.options.clock.now()
    this.options.db
      .prepare(
        `INSERT OR IGNORE INTO dh_inbox
           (message_id, conversation_id, state, enqueued_at)
         VALUES (?, ?, 'pending', ?)`,
      )
      .run(entry.messageId, entry.conversationId, now)

    const bucket = this.pending.get(entry.conversationId)
    const item: InboxEntry = { ...entry, enqueuedAt: now }
    if (bucket === undefined) this.pending.set(entry.conversationId, [item])
    else bucket.push(item)
    return true
  }

  /**
   * 丢弃（准入闸命中）。
   *
   * **记原因**而不是静默丢：用户要能在运行日志里看到"为什么没回这条"。
   */
  drop(messageId: string, reason: DropReason): void {
    this.seen.add(messageId)
    this.options.db
      .prepare(
        `INSERT INTO dh_inbox (message_id, conversation_id, state, drop_reason, enqueued_at)
         VALUES (?, '', 'dropped', ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET state = 'dropped', drop_reason = excluded.drop_reason`,
      )
      .run(messageId, reason, this.options.clock.now())
  }

  /**
   * 取出某会话已"攒够"的一批。
   *
   * `entries` 为空表示还没到合并窗口 —— 调用方应稍后再试，而不是立刻处理。
   *
   * ★ 超过上限时**留最新的**、丢最早的，并把丢的条数放在 `overflow` 里。
   * 留最新而不是最早：数字人要回的是"现在在说什么"，一个小时前那条
   * 已经没人在等回复了。丢掉的那些仍会被 `markProcessed` 标掉 ——
   * 它们**不该**留在 pending 里等下一轮（那会让一个刷屏的群永远追不上）。
   */
  takeBatch(conversationId: string): TakenBatch {
    const bucket = this.pending.get(conversationId)
    if (bucket === undefined || bucket.length === 0) return { entries: [], overflow: 0 }

    const window = this.options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
    const oldest = bucket[0]
    if (oldest === undefined) return { entries: [], overflow: 0 }
    const now = this.options.clock.now()
    if (now - oldest.enqueuedAt < window) return { entries: [], overflow: 0 }

    /**
     * ★ 第二个判据：最新那条也要静默够久（见 `DEFAULT_QUIET_MS`）。
     *
     * 只看最老那条时，对方连发会让每一轮草稿都在生成期间被下一条消息作废。
     * 这里取 `at(-1)` 而不是重新扫库：`push` 保证了入队顺序，而"最后一次
     * 收到消息是什么时候"正是这个判据要的量。
     */
    const quiet = this.options.quietMs ?? DEFAULT_QUIET_MS
    if (quiet > 0) {
      const newest = bucket.at(-1)
      if (newest !== undefined && now - newest.enqueuedAt < quiet) {
        return { entries: [], overflow: 0 }
      }
    }

    this.pending.delete(conversationId)
    const limit = this.overrideMaxBatchSize ?? this.options.maxBatchSize ?? MAX_BATCH_SIZE
    if (bucket.length <= limit) return { entries: bucket, overflow: 0 }
    const overflow = bucket.slice(0, -limit)
    this.markDropped(
      overflow.map((entry) => entry.messageId),
      "batch_overflow",
    )
    return { entries: bucket.slice(-limit), overflow: overflow.length }
  }

  /** 强制取出（手动触发或关停前的清空）。 */
  drainBatch(conversationId: string): InboxEntry[] {
    const bucket = this.pending.get(conversationId) ?? []
    this.pending.delete(conversationId)
    return bucket
  }

  markProcessed(messageIds: readonly string[]): void {
    const statement = this.options.db.prepare(
      "UPDATE dh_inbox SET state = 'done', processed_at = ? WHERE message_id = ?",
    )
    const now = this.options.clock.now()
    for (const id of messageIds) statement.run(now, id)
  }

  private markDropped(messageIds: readonly string[], reason: DropReason): void {
    const statement = this.options.db.prepare(
      `UPDATE dh_inbox
          SET state = 'dropped', drop_reason = ?, processed_at = ?
        WHERE message_id = ? AND state = 'pending'`,
    )
    const now = this.options.clock.now()
    for (const id of messageIds) statement.run(reason, now, id)
  }

  /**
   * 一个 turn 失败了。返回是否**已放弃**这个会话的这一批。
   *
   * ★ 为什么需要它：turn 失败时 `markProcessed` 不会被调，那批消息留在
   * `pending` 里下一轮重来。对暂时性错误（网关限流）这是对的，
   * 但对**必然失败**的输入（超长、含让网关 400 的字符）它会永远重试 ——
   * 每 8 秒一次，烧配额、刷日志，而表现只是"这个会话一直没回复"。
   *
   * 放弃时把那批标成 `failed` 并记原因，于是它在运行日志里是**可见**的，
   * 而不是消失。
   */
  markTurnFailed(conversationId: string, messageIds: readonly string[], error: string): boolean {
    const attempts = (this.failures.get(conversationId) ?? 0) + 1
    this.failures.set(conversationId, attempts)
    if (attempts < MAX_TURN_ATTEMPTS) return false

    this.failures.delete(conversationId)
    const statement = this.options.db.prepare(
      "UPDATE dh_inbox SET state = 'failed', drop_reason = ?, processed_at = ? WHERE message_id = ?",
    )
    const now = this.options.clock.now()
    // 原因截断：drop_reason 是给人看的一行，不是完整堆栈
    const reason = `turn_failed: ${error.slice(0, 160)}`
    for (const id of messageIds) statement.run(reason, now, id)
    return true
  }

  /** 一个 turn 成功了 —— 清掉失败计数（否则偶发失败会累积到放弃）。 */
  markTurnSucceeded(conversationId: string): void {
    this.failures.delete(conversationId)
  }

  /** 连续失败次数（可观测性：状态页要能看出"这个会话在反复失败"）。 */
  failureCount(conversationId: string): number {
    return this.failures.get(conversationId) ?? 0
  }

  /**
   * 崩溃重启后把未处理的捞回内存。
   *
   * 只捞 `pending`（`processing` 的那些无法确定是否已发出去，
   * 重放它们可能造成重复回复 —— 交给用户在草稿箱里看）。
   */
  restore(): number {
    this.options.db
      .prepare(
        `UPDATE dh_inbox
            SET state = 'dropped', drop_reason = 'already_answered', processed_at = ?
          WHERE state = 'pending'
            AND EXISTS (
              SELECT 1
                FROM messages trigger_message
                JOIN messages reply
                  ON reply.conversation_id = trigger_message.conversation_id
                 AND reply.is_self = 1
                 AND reply.sent_at > trigger_message.sent_at
               WHERE trigger_message.id = dh_inbox.message_id
            )`,
      )
      .run(this.options.clock.now())

    this.options.db
      .prepare(
        `UPDATE dh_inbox
            SET state = 'dropped', drop_reason = 'stale_message', processed_at = ?
          WHERE state = 'pending'
            AND EXISTS (
              SELECT 1
                FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
                JOIN probe_snapshots p
                  ON p.channel_id = c.channel_id
                 AND p.conversation_external_id = c.external_id
               WHERE m.id = dh_inbox.message_id
                 AND m.sent_at < ?
                 AND p.unread_count = 0
                 AND p.observed_at >= m.sent_at
                 AND NOT EXISTS (
                   SELECT 1
                     FROM messages reply
                    WHERE reply.conversation_id = m.conversation_id
                      AND reply.is_self = 1
                      AND reply.sent_at > m.sent_at
                 )
            )`,
      )
      .run(this.options.clock.now(), this.options.clock.now() - READ_REPLY_EXPIRY_MS)

    const rows = this.options.db
      .prepare<[], { message_id: string; conversation_id: string; enqueued_at: number }>(
        `SELECT message_id, conversation_id, enqueued_at FROM dh_inbox
          WHERE state = 'pending' ORDER BY enqueued_at`,
      )
      .all()

    for (const row of rows) {
      this.seen.add(row.message_id)
      const item: InboxEntry = {
        messageId: row.message_id,
        conversationId: row.conversation_id,
        enqueuedAt: row.enqueued_at,
      }
      const bucket = this.pending.get(row.conversation_id)
      if (bucket === undefined) this.pending.set(row.conversation_id, [item])
      else bucket.push(item)
    }
    return rows.length
  }

  /** 待处理的会话（有消息在等的那些）。 */
  pendingConversations(): string[] {
    return [...this.pending.keys()].filter((id) => (this.pending.get(id)?.length ?? 0) > 0)
  }

  pendingCount(): number {
    let count = 0
    for (const bucket of this.pending.values()) count += bucket.length
    return count
  }

  /** 丢弃原因的统计：运行日志页展示"为什么没回"。 */
  dropStats(): Record<string, number> {
    const rows = this.options.db
      .prepare<[], { drop_reason: string | null; c: number }>(
        `SELECT drop_reason, count(*) AS c FROM dh_inbox
          WHERE state = 'dropped' GROUP BY drop_reason`,
      )
      .all()
    return Object.fromEntries(rows.map((row) => [row.drop_reason ?? "unknown", row.c]))
  }
}
