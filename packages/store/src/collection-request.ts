/**
 * 「这一轮**去不去拉**、拉哪些」—— **采集面**的唯一权威。
 *
 * ## ★★★ 为什么这一层必须存在（它修的是一个分层错误）
 *
 * 改动前采集面直接读**学习范围**（`readCollectionScope`）。而学习范围
 * 回答的是「什么该进**学习语料**」—— 那是一个**下游**的口径。
 * 拿它当采集面的判据，等于让一个下游替所有下游决定"能不能拿到数据"。
 *
 * 而另一个下游（数字分身）有自己的范围（监听范围），它要的东西被挡了：
 *
 * | 情形 | 现象 |
 * |---|---|
 * | 用户选了历史区间（`until` 在过去） | 新消息被上界挡住 → 不入库 → 分身**收不到** |
 * | 会话在监听范围、不在学习白名单 | 同上 |
 * | 分身**自己发的回复** | 走 `refreshConversation` → 同一道闸 → 同样进不来 |
 *
 * ★ 第三条有一个放大器：`admit()` 判"该不该回"要读**这个会话之前的往来**。
 * 分身回过的话不在库里 → 下一轮它看不见自己说过什么 → 可能重复说、
 * 或答得像没上下文。**而没有任何东西会报错。**
 *
 * ## ★★ 判据：采集面 = 学习范围 **∪** 监听范围
 *
 * 「并集」是这一层的全部内容，而它的方向必须理解对：
 *
 * · 并集**不是**放宽隐私边界 —— 两个范围都是**用户自己选的**。
 *   监听范围里的会话是他明确要求分身盯着的，采它的新消息正是他要的；
 * · 并集**仍然是**边界 —— 两个范围都没勾的会话，我们**不去拉**。
 *   而"不去拉"是唯一真正的收窄（不去拉 = 数据不存在）。
 *
 * ## ★ 时间维度的并集是"取更宽"，而两个范围的时间语义不同
 *
 * · 学习范围：`since`/`until`，**可回溯**（往回挖多久）；
 * · 监听范围：`enabledAt`，**不回溯**（从这一刻起的新消息）。
 *
 * 所以并集的下界取 `min(学习的 since, 监听的最早 enabledAt)`，
 * 而**上界只能来自学习范围** —— 监听范围没有上界（它盯的是"从现在起"，
 * 那个方向没有终点）。
 *
 * ★★★ 上界这一条是那三个洞里最实际的一个：用户选「学到 7 月 30 日」，
 * 而监听范围仍在盯那个群。若采集面照搬学习范围的 `until`，
 * 那个群的新消息全部被挡 —— 而用户的两个选择**都没有**要求这件事发生。
 *
 * 修法：**监听范围里的会话不受 `until` 约束**（它们要新消息），
 * 而其余会话仍受（那是学习范围的意思）。
 *
 * ## ★ 为什么在 store 而不是在采集侧
 *
 * 它要读两张表（`distill_sources` + `attention_scope`），而两者的解析
 * 都已经在这一层（`readDomainScope` / `AttentionScopeRepository`）。
 * 放采集侧会让那个服务再学一遍两张表的形状 —— 而那正是 v2 收敛掉的东西。
 */
import type { SqliteDatabase } from "./database.js"
import { readDomainScope, type ScopedDomain } from "./domain-scope.js"
import { AttentionScopeRepository, parseAttentionMode } from "./repositories/attention-scope.js"

/**
 * 这一轮的采集请求。
 *
 * ★ 它**只描述采集面**，不描述"拉回来的怎么处理" —— 后者由
 * `learning_eligible` 打标 + 消费者按标签取（见 v4 §5）。
 * 混在一起就是改动前那个分层错误。
 */
export interface CollectionRequest {
  /**
   * 一条都不该拉吗。
   *
   * ★ 判据：两个范围**都**说不要。任一个要，就得拉 ——
   * 而"要不要留给学习侧"是落库之后的事。
   */
  collectsNothing: boolean
  /**
   * 是否设了会话白名单。`false` = 不设限（全部会话都在采集面内）。
   *
   * ★★ 与 `DomainScope.restricted` 同一个语义（两种"空"的含义相反），
   * 见那个字段的注释。
   */
  restricted: boolean
  /**
   * 采集面内的会话（学习白名单 ∪ 监听名单）。`restricted === false` 时无意义。
   */
  allow: ReadonlySet<string>
  /**
   * 只受**监听范围**约束的那些会话（也就是"不在学习白名单里、但要盯"）。
   *
   * ## ★★★ 为什么要单独一个集合
   *
   * 它们**不受 `until` 约束** —— 用户要它们的新消息，而 `until` 是
   * 学习范围的上界（"学到某一天为止"）。拿 `until` 卡它们就是那第一个洞。
   *
   * ★ 而它们**仍然受 `since` 约束吗**？不受 —— 监听范围的语义是
   * "从 `enabledAt` 起的新消息"，那个下界比学习范围的 `since` 更晚，
   * 所以并集取更宽的那个（`min`）之后它自然被覆盖。
   */
  attentionOnly: ReadonlySet<string>
  /**
   * 时间下界（unix ms）；`null` = 不限；`undefined` = 两个范围都没说。
   *
   * ★ 取 `min(学习 since, 最早的 enabledAt)` —— 更早的那个更宽。
   */
  since: number | null | undefined
  /**
   * 时间上界（unix ms）；`undefined` = 不限。
   *
   * ★★ **只来自学习范围**，且**只作用于 `attentionOnly` 之外的会话**
   * （见那个字段的注释）。
   */
  until: number | undefined
  /**
   * 学习范围那一行**还没配过**（`unset`）。
   *
   * ★ 调用方据此决定要不要报 `scopeNotReady`（不推水位）——
   * 那个语义只属于学习范围（chat 的缺省是 `collect-nothing`）。
   */
  learningUnset: boolean
}

/**
 * 算这一轮的采集面。
 *
 * @param channelId 监听范围是 per-channel 的（`attention_scope.channel_id`）
 *
 * ## ★ 不缓存
 *
 * 与 `readDomainScope` / `AttentionRouter` 同一条理由：用户改了范围必须
 * **立刻**生效，而缓存过期的方向恰好是"继续采已经被移出的那些"。
 * 两次 `SELECT`（一次走主键、一次走部分索引）比一次 CLI 调用便宜几个数量级。
 */
export function readCollectionRequest(
  db: SqliteDatabase,
  domain: ScopedDomain,
  channelId: string,
): CollectionRequest {
  const learning = readDomainScope(db, domain)

  /**
   * ★★ 监听范围**只对 chat 有意义** —— 分身盯的是消息，不是文档或听记。
   *
   * 其余域直接退化成"学习范围就是采集面"。不这么做的话文档那条路会去
   * 读一张与它无关的表，而那个耦合没有任何收益。
   */
  if (domain !== "chat") {
    return {
      collectsNothing: learning.restricted && learning.allow.size === 0,
      restricted: learning.restricted,
      allow: learning.allow,
      attentionOnly: new Set(),
      since: learning.since,
      until: learning.until,
      learningUnset: learning.unset,
    }
  }

  const scope = new AttentionScopeRepository(db)
  const mode = scope.mode(channelId)
  /**
   * ★★★ `mode` 三态在这里的含义与路由那侧**不同**，必须分开想：
   *
   * | mode | 路由（投不投给分身） | ★ 采集面（去不去拉） |
   * |---|---|---|
   * | `unset` | 名单空→放行、非空→按名单 | ★ **不扩大采集面**（用户没表过态） |
   * | `all` | 全放行 | ★ **不扩大**（"盯全部已学习的" —— 那已在学习范围里） |
   * | `explicit` | 按名单 | ★ **按名单扩大** |
   *
   * ★ `all` 那一格是关键：它的语义是"盯**全部已学习的**会话"，
   * 也就是它的范围**天然是学习范围的子集** —— 扩大采集面没有对象。
   * 误判成"扩大到全部会话"会让一个选了"盯全部"的用户被采全部聊天历史，
   * 而他的学习范围可能只勾了 3 个群。**那是超范围采集。**
   */
  const attentionRows = mode === "explicit" ? scope.list(channelId).filter((row) => row.active) : []

  /**
   * ★ 只取 `active` 的行：关掉的会话不该再扩大采集面
   * （它的历史已经在库里了，而"以后别管它"包含"别再为它去拉"）。
   */
  const attentionIds = attentionRows.map((row) => row.conversationExternalId)
  const earliestEnabledAt =
    attentionRows.length === 0 ? undefined : Math.min(...attentionRows.map((row) => row.enabledAt))

  /**
   * 采集面的会话集合。
   *
   * ★★ 学习范围**不设限**时整个集合无意义（全部会话都在面内）——
   * 那时 `restricted: false`，监听名单是它的子集，不需要合并。
   */
  if (!learning.restricted) {
    return {
      collectsNothing: false,
      restricted: false,
      allow: new Set(),
      attentionOnly: new Set(),
      since: widerSince(learning.since, earliestEnabledAt),
      until: learning.until,
      learningUnset: learning.unset,
    }
  }

  const allow = new Set(learning.allow)
  const attentionOnly = new Set<string>()
  for (const id of attentionIds) {
    // ★ 记下"只因监听而在面内"的那些 —— 它们不受 `until` 约束
    if (!allow.has(id)) attentionOnly.add(id)
    allow.add(id)
  }

  return {
    /**
     * ★★★ 判据是**两个范围都空**。
     *
     * 只看学习范围（改动前的行为）会让"学习范围一个都没勾、但监听了 3 个群"
     * 这个组合整趟不采 —— 而那 3 个群正是用户明确要分身盯的。
     */
    collectsNothing: allow.size === 0,
    restricted: true,
    allow,
    attentionOnly,
    since: widerSince(learning.since, earliestEnabledAt),
    until: learning.until,
    learningUnset: learning.unset,
  }
}

/**
 * 两个下界取**更宽**（更早）的那个。
 *
 * ★ 三态：`null`（显式不限）最宽 —— 它一旦出现就是结果。
 * `undefined`（没配过）不参与比较（另一边有值就用另一边）。
 *
 * ★★ 抽成函数而不是内联一个三元：那个表达式要处理
 * `number | null | undefined` × `number | undefined` 六种组合，
 * 而写错的方向是"取了更晚的那个" = 漏采一段用户要的历史。
 */
function widerSince(
  learningSince: number | null | undefined,
  earliestEnabledAt: number | undefined,
): number | null | undefined {
  // null = 显式不限，最宽
  if (learningSince === null) return null
  if (learningSince === undefined) return earliestEnabledAt
  if (earliestEnabledAt === undefined) return learningSince
  return Math.min(learningSince, earliestEnabledAt)
}

/**
 * 一条消息的**业务时间**在采集面的时间窗内吗。
 *
 * ★★★ 与 `isOccurredAtInScope`（学习范围那个）的区别只有一处，
 * 而那一处正是那第一个洞：**`attentionOnly` 里的会话不受 `until` 约束**。
 *
 * @param partitionId 这条消息的会话 external_id
 */
export function isWithinCollectionWindow(
  request: CollectionRequest,
  partitionId: string,
  occurredAt: number,
): boolean {
  if (typeof request.since === "number" && occurredAt < request.since) return false
  /**
   * ★ 上界只卡"不是只因监听而在面内"的那些。
   *
   * 用户选「学到 7 月 30 日」而仍在盯某个群 —— 那个群的新消息必须能拉，
   * 否则分身收不到（而他的两个选择都没要求这件事发生）。
   */
  if (request.attentionOnly.has(partitionId)) return true
  if (request.until !== undefined && occurredAt > request.until) return false
  return true
}

/** 解析 mode 的 re-export（调用方偶尔要直接判它）。 */
export { parseAttentionMode }
