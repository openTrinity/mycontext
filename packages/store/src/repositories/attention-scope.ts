/**
 * 数字分身的**监听范围**（关心范围）与它的**路由**。
 *
 * ## 这一层回答的两个问题（用户原话）
 *
 * 「消费者是不是得有个路由模块，看这段时间新消息会不会是我这个数字分身的
 *   设置要关心的，这个是路由判断是否需要的部分，还有执行消费的部分」
 *
 * · **范围**：哪些会话、从什么时候起（`AttentionScopeRepository`）；
 * · **路由**：某条消息在不在范围内（`routeToAttention`，纯函数）。
 *
 * ## ★★★ 路由是纯函数，而且**只判范围**
 *
 * 它刻意**不**判「该不该回」—— 那是 `admit()` 的事（kill switch / 自己发的 /
 * 已回过 / 触发词 / 太旧…）。两者分开的判据是**问题不同**：
 *
 * | 谁 | 问的是 | 变了会怎样 |
 * |---|---|---|
 * | 路由 | 这条消息属于分身的关心范围吗 | 不属于 → 根本不该进管控层 |
 * | admit | 这条消息现在该触发一次回复吗 | 不该 → 进了但被丢弃，有理由可查 |
 *
 * 混在一起的后果是"范围外"和"暂时不回"用同一个 reason 表达，而它们
 * 一个是配置问题、一个是时机问题 —— 用户排查时需要的正是这个区别。
 *
 * ## ★ 为什么纯函数而不是方法
 *
 * 本仓库反复出现"两头都锁了、中间那根线是裸的"。路由是**判据**，
 * 把它提成不碰 db 的纯函数，测试才能直接打到每一个分支，
 * 而不是透过一个要造库、造消息、造配置的服务去间接观察。
 */
import type { SqliteDatabase } from "../database.js"

/** 监听范围里的一条会话。 */
export interface AttentionScopeRow {
  conversationExternalId: string
  /** 从这一刻起的新消息才算在范围内（unix ms） */
  enabledAt: number
  active: boolean
  /** 'user' = 用户显式勾的；'learning' = 跟随学习范围自动并入 */
  source: string
  updatedAt: number
}

/**
 * 路由的输入。
 *
 * ★ 只收**判据需要的**字段，不收整个消息对象 —— 那样测试要造一堆无关字段，
 * 而多余字段会让"路由到底看了什么"变得不明显。
 */
export interface AttentionRouteInput {
  conversationExternalId: string
  /** 消息的业务时间（不是入库时间：回填一段历史不该被当成"刚发生"） */
  sentAt: number
  /** 这个会话在监听范围里的那一行；`null` = 不在名单里 */
  scope: { enabledAt: number; active: boolean } | null
}

/** 路由结论。`reason` 只在不放行时有值。 */
export type AttentionRoute =
  | { routed: true }
  | { routed: false; reason: "not_in_scope" | "scope_disabled" | "before_enabled_at" }

/**
 * 这条消息属于数字分身的关心范围吗。
 *
 * 三条判据，顺序有理由（便宜的先判、语义更"根本"的先判）：
 *
 * ① 不在名单里 → `not_in_scope`（最常见，也最便宜）；
 * ② 在名单但被关掉 → `scope_disabled`。**与①分开**是因为它们的出路不同：
 *    ① 要用户去勾选，② 说明曾经勾过又关了（"只增不减"下这是唯一的收回方式）；
 * ③ 早于 `enabled_at` → `before_enabled_at`。
 *
 * ★★★ ③ 是监听范围与学习范围最本质的差别：**监听只管实时流**
 * （用户原话「他只需要记录实时流的内容」）。没有这一条的话，一次历史回填
 * 会把几万条旧消息全部路由给管控层 —— 而那不是"分身很勤奋"，
 * 是它对着三个月前的消息起草回复（本仓库实测过 19 天前的群消息被起草）。
 */
export function routeToAttention(input: AttentionRouteInput): AttentionRoute {
  if (input.scope === null) return { routed: false, reason: "not_in_scope" }
  if (!input.scope.active) return { routed: false, reason: "scope_disabled" }
  if (input.sentAt < input.scope.enabledAt) {
    return { routed: false, reason: "before_enabled_at" }
  }
  return { routed: true }
}

export class AttentionScopeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** 路由用的单条查询。`null` = 这个会话不在名单里（与"在名单但关了"不同）。 */
  get(channelId: string, conversationExternalId: string): AttentionScopeRow | null {
    const row = this.db
      .prepare<[string, string], AttentionScopeDbRow>(
        `SELECT * FROM attention_scope
          WHERE channel_id = ? AND conversation_external_id = ?`,
      )
      .get(channelId, conversationExternalId)
    return row === undefined ? null : toScopeRow(row)
  }

  /** 名单全量（界面用）。含 `active = 0` 的历史项 —— 那是"曾经关心过"。 */
  list(channelId: string): AttentionScopeRow[] {
    return this.db
      .prepare<[string], AttentionScopeDbRow>(
        `SELECT * FROM attention_scope WHERE channel_id = ?
          ORDER BY active DESC, updated_at DESC`,
      )
      .all(channelId)
      .map(toScopeRow)
  }

  /**
   * 把一批会话加进监听范围（**只增不减**）。
   *
   * ## ★★★ 已经在名单里的行：`enabled_at` **只能变早**
   *
   * 与学习范围的 `since` 同一条规则（见 `mergeScopeOnlyGrowing`）：
   * 变晚等于放弃一段已经在盯的时间。用 `MIN(既有, 新)`。
   *
   * ★ 重新启用一个关掉的会话时 `active` 置回 1，但**不重置** `enabled_at`
   * —— 那个时间点是"从哪儿开始关心"，不是"上次启用时间"。
   * 重置会让中间那段消息永久落在范围外（而用户以为重新打开就都算）。
   *
   * ★ `source` 用 `MIN`（字典序 'learning' < 'user'）会写错语义，所以显式
   * 判：一旦是 `user` 就永远是 `user` —— 用户显式勾过的不该被自动并入覆盖成
   * "系统加的"，否则界面会把它说成"跟随学习范围"，而那是错的归因。
   */
  add(
    channelId: string,
    entries: readonly { conversationExternalId: string; enabledAt: number; source?: string }[],
    at: number,
  ): number {
    const stmt = this.db.prepare(
      `INSERT INTO attention_scope
         (channel_id, conversation_external_id, enabled_at, active, source, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(channel_id, conversation_external_id) DO UPDATE SET
         enabled_at = MIN(attention_scope.enabled_at, excluded.enabled_at),
         active = 1,
         source = CASE WHEN attention_scope.source = 'user' THEN 'user' ELSE excluded.source END,
         updated_at = excluded.updated_at`,
    )
    let changed = 0
    for (const entry of entries) {
      const result = stmt.run(
        channelId,
        entry.conversationExternalId,
        entry.enabledAt,
        entry.source ?? "user",
        at,
      )
      changed += result.changes
    }
    return changed
  }

  /**
   * 把一个会话从监听范围里**关掉**（不删行）。
   *
   * ## ★ 这是"只增不减"下唯一的收回方式，而它是**允许**的
   *
   * 「只增不减」针对的是**学习范围**（消费者已经消费过历史，缩小会让
   * 图谱/画像与范围永久不一致）。监听范围不存任何历史 —— 关掉它
   * 只是"以后别管这个群了"，没有任何已有产出会因此变得不自洽。
   *
   * 把这两件事混成同一条规则会得到一个荒谬的结论：用户永远无法让分身
   * 停止盯着某个群。那不是隐私保护，是产品缺陷。
   *
   * ★ 不删行：留着 `active = 0` 让"曾经关心过"可查，也让重新打开时
   * `enabled_at` 还在（见 `add` 的注释）。
   */
  disable(channelId: string, conversationExternalId: string, at: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE attention_scope SET active = 0, updated_at = ?
          WHERE channel_id = ? AND conversation_external_id = ? AND active = 1`,
      )
      .run(at, channelId, conversationExternalId)
    return result.changes > 0
  }

  /** 当前在范围内的会话数（界面上那个"盯着 N 个会话"）。 */
  activeCount(channelId: string): number {
    return (
      this.db
        .prepare<
          [string],
          { c: number }
        >("SELECT count(*) AS c FROM attention_scope WHERE channel_id = ? AND active = 1")
        .get(channelId)?.c ?? 0
    )
  }
}

/**
 * 监听范围的**实时流**覆盖面记账。
 *
 * ★ 同时记 `routed` 与 `skipped`：只记放行的话，"范围设窄了"与
 * "那段时间没消息"不可区分 —— 而那正是用户会来问的那个问题。
 */
export class AttentionCoverageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  bump(
    channelId: string,
    input: { dayBucket: string; routed: number; skipped: number; at: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO attention_coverage
           (channel_id, day_bucket, routed_count, skipped_count, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, day_bucket) DO UPDATE SET
           routed_count = attention_coverage.routed_count + excluded.routed_count,
           skipped_count = attention_coverage.skipped_count + excluded.skipped_count,
           updated_at = excluded.updated_at`,
      )
      .run(channelId, input.dayBucket, input.routed, input.skipped, input.at)
  }

  /** 区间汇总。★ 与 chat_coverage 一样**不给百分比**（分母同样拿不到）。 */
  summarize(
    channelId: string,
    fromDay: string,
    toDay: string,
  ): { routed: number; skipped: number; days: number } {
    const row = this.db
      .prepare<[string, string, string], { routed: number; skipped: number; days: number }>(
        `SELECT COALESCE(sum(routed_count), 0) AS routed,
                COALESCE(sum(skipped_count), 0) AS skipped,
                count(*) AS days
           FROM attention_coverage
          WHERE channel_id = ? AND day_bucket >= ? AND day_bucket <= ?`,
      )
      .get(channelId, fromDay, toDay)
    return { routed: row?.routed ?? 0, skipped: row?.skipped ?? 0, days: row?.days ?? 0 }
  }
}

/** 库里那一行的形状（具名接口 —— `.all()` 不透传 `prepare<>` 的行类型）。 */
interface AttentionScopeDbRow {
  conversation_external_id: string
  enabled_at: number
  active: number
  source: string
  updated_at: number
}

function toScopeRow(row: AttentionScopeDbRow): AttentionScopeRow {
  return {
    conversationExternalId: row.conversation_external_id,
    enabledAt: row.enabled_at,
    active: row.active === 1,
    source: row.source,
    updatedAt: row.updated_at,
  }
}
