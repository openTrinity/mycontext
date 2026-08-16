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
 * 监听范围的**模式** —— 三态，而不是"名单空不空"。
 *
 * ## ★★★ 为什么"名单为空"表达不了这件事（这修的是一个真实的方向错误）
 *
 * 改动前判据只有一条：`activeCount === 0` → 放行全部。而**三个不同的
 * 用户动作**都会让那个计数归零：
 *
 * | 用户做了什么 | 表里 | 旧判断 | 用户的预期 |
 * |---|---|---|---|
 * | 从没配过（新装 / 存量升级） | 空 | 放行全部 | ？（他还没表态） |
 * | 引导里一个都不勾 | 空 | 放行全部 | 「盯全部」✅ |
 * | **设置里把全部关掉** | 有行但 `active=0` | **放行全部** | 「都不盯」❌ |
 *
 * 第三行是方向搞反：用户把最后一个会话关掉之后，**分身盯得更多了**。
 * 而它不报错 —— 用户看到的是"我关光了它还在回消息"。
 *
 * ## 三态各自的行为
 *
 * · `unset` —— 放行全部、**不记账**、`enforced: false`。
 *   这是存量库读不到那个键时的值，行为与改动前**逐字相同**
 *   （不能破：让存量用户的分身在一次升级后静默停摆比多投几个会话糟得多）；
 * · `all` —— 放行全部、**记账**、`enforced: true`。
 *   它是一次**用户决定**，所以覆盖面该记、界面该说"你选了盯全部"；
 * · `explicit` —— 按名单判。**名单为空 = 一条都不放行**（那正是
 *   "把全部关掉"这个动作应有的效果）。
 *
 * ★ `unset` 与 `all` 的行为差别**只在 enforced 与记账** —— 两者都放行。
 * 那是刻意的：把 `all` 做成"放行"而不是"写一份全量名单"，
 * 避免替用户写一份 `enabled_at` 只能变早、只增不减的具体名单
 * （那比一个标量难撤回得多）。
 */
export type AttentionMode = "unset" | "all" | "explicit"

/** `vault_settings` 里那个键的前缀。★ 与 mode 的读写实现放在一处，避免拼错。 */
export const ATTENTION_MODE_KEY_PREFIX = "attention.mode."

/**
 * 某个渠道的 mode 键。
 *
 * ★ 走 `vault_settings`（`SettingsRepository`）而不是新开一张表：它是
 * **每渠道一个标量**，而新表要一次迁移 + 一条读写路径 + 一次 wipe 清单
 * 同步。带渠道后缀的标量键是这个库里既有的做法
 * （`chatCoverage.backfilled.<channelId>` 与 `runtimeLimits.<channelId>`
 * 都是它）。
 */
export function attentionModeKey(channelId: string): string {
  return `${ATTENTION_MODE_KEY_PREFIX}${channelId}`
}

/**
 * 把存的字符串解析成 mode。
 *
 * ★★ 读不出来（null / 空 / 手改成别的值）一律回落 `unset` ——
 * 而 `unset` 的行为与改动前**逐字相同**。这是这一层唯一能选的方向：
 * 回落 `explicit` 会让一个手改坏的库让分身静默停摆，
 * 回落 `all` 会让"从没配过"冒充"用户选了全部"（于是覆盖面开始记
 * 一段不代表任何配置的账）。
 */
export function parseAttentionMode(raw: string | null): AttentionMode {
  if (raw === "all") return "all"
  if (raw === "explicit") return "explicit"
  return "unset"
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
   * ## ★★★ 这个判断的**依据**（三条，都可复核）
   *
   * 「只增不减」的真正判据是"缩小会不会让**已有产出**与配置矛盾"。
   * 对监听范围逐条查：
   *
   * ① 这张表**不引用任何消息数据** —— 全文零处提到 `messages`/`content_text`；
   * ② `disable` 只置 `active = 0`，**不删任何行**（重开时 `enabled_at` 还在）；
   * ③ 图谱（`knowledge-feed`）、蒸馏（`distill`）、分身（`persona`）
   *    三个包里对 `attention_scope` **零引用** —— 没有任何消费者的产出
   *    派生自它。
   *
   * 三条都成立 ⇒ 关掉它不可能让任何已有产出变得不自洽 ⇒ 可逆是对的。
   *
   * ★ 而学习范围三条全反：它决定 `messages` 里存什么、图谱与画像都派生自它。
   * 那才是"只增不减"该管的地方。
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

  /**
   * 读这个渠道的 mode。
   *
   * ★★ 表**不存在**时也回落 `unset`（而不是抛）：这个仓储会在
   * `AttentionRouter` 里被逐条投递调用，而 `vault_settings` 在某些
   * 早期库上可能还没建。抛错会打断整条投递链 —— 而回落 `unset` 的
   * 行为与改动前逐字相同（放行、不记账）。
   */
  mode(channelId: string): AttentionMode {
    try {
      const row = this.db
        .prepare<[string], { value: string }>("SELECT value FROM vault_settings WHERE key = ?")
        .get(attentionModeKey(channelId))
      return parseAttentionMode(row?.value ?? null)
    } catch {
      // 见上面那段：读不出来一律 unset（改动前的行为）
      return "unset"
    }
  }

  /**
   * 写这个渠道的 mode。
   *
   * ★ `at` 收 unix ms 而 `vault_settings.updated_at` 是 ISO 文本
   * （`SettingsRepository.set` 的签名如此）—— 转换在这里做一次，
   * 让调用方只需要给一个时钟读数（与这个文件其余方法一致）。
   */
  setMode(channelId: string, mode: AttentionMode, at: number): void {
    this.db
      .prepare(
        `INSERT INTO vault_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(attentionModeKey(channelId), mode, new Date(at).toISOString())
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
