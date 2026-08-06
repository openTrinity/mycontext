/**
 * 「用户在引导里选的采集范围」—— **唯一权威**。
 *
 * ## ★★ 为什么要单独一个模块，而不是各处自己读 `distill_sources`
 *
 * 修复前有**四份**各自实现的 `scopedConversationIds()`（采集、蒸馏、forge、
 * 导出各一份），语义微妙地不一致：
 * · 采集与蒸馏：`enabled === false` → 返回 `[]` → 被解读成"不限"；
 * · 导出：`enabled === false` → 返回 `{}` → 也是"不限"。
 *
 * 于是"用户把 chat 源整个关掉"这个动作的效果是**采全部、蒸全部、导全部** ——
 * 与"勾了全部"完全同形。而实测的后果是库里 55% 的消息属于用户没勾的会话
 * （84,325 条里 46,415 条），且仍在以每小时 64% 的比例继续进来。
 *
 * 四份实现里只要有一份漂了就是一次隐私事故，而漂了不报错。所以这里把它
 * 收成一个纯函数，四处都调它。
 *
 * ## ★ `restricted` 必须与「白名单为空」分开表达
 *
 * 两种"空"的含义相反，而 `string[]` 表达不了这个区别：
 * · 用户**没配过**范围（老库、跳过了引导那一步）→ 不限，采全部；
 * · 用户配了范围但**一个都没勾** → 一个都不采。
 *
 * 修复前两者都是 `[]`，于是后者被当成前者 —— "我一个都不要"被执行成
 * "全都要"。这是最坏的一种方向搞反。用 `restricted: boolean` 显式区分：
 * 它为 true 时 `allow` 才是判据，为 false 时不设限。
 *
 * ## 为什么不缓存
 *
 * 用户改勾选必须**立刻**生效（下一轮采集就不许再碰被移出的会话）。
 * 缓存一份就多一个可能过期的副本，而过期的方向恰好是"继续采已经被
 * 取消勾选的会话" —— 那正是要消灭的问题。一次 `SELECT` 走主键，
 * 比一次 CLI 调用便宜几个数量级，没有缓存的理由。
 */
import type { SqliteDatabase } from "./database.js"
import type { DistillScope } from "./repositories/onboarding.js"

/** 采集范围的判定结果。用 `restricted` 区分"没配"与"配了空"（见文件头）。 */
export interface CollectionScope {
  /**
   * 是否设了会话白名单。
   *
   * `false` = 用户没配过范围 → 不设限；
   * `true` = `allow` 就是全部许可的会话（**可能为空** = 一个都不许）。
   */
  restricted: boolean
  /** 许可的会话 external_id。`restricted === false` 时无意义。 */
  allow: ReadonlySet<string>
  /** 时间下界（unix ms）；null = 用户显式选了"不限"；undefined = 没配过 */
  since: number | null | undefined
  /** 时间上界（unix ms）；undefined = 不限 */
  until: number | undefined
  /** chat 源本身是否开启。关掉时 `restricted` 为 true 且 `allow` 为空。 */
  enabled: boolean
}

/**
 * 判断一个会话是否在范围内。
 *
 * 抽成函数而不是让调用方写 `!scope.restricted || scope.allow.has(id)` ——
 * 那个表达式里有一个 `!` 与一个短路，抄错一次就是一次泄漏（而且不报错）。
 */
export function isConversationInScope(scope: CollectionScope, externalId: string): boolean {
  if (!scope.restricted) return true
  return scope.allow.has(externalId)
}

/**
 * 判断一条消息的业务时间是否在范围内。
 *
 * ★ `since === null`（显式不限）与 `since === undefined`（没配过）都放行。
 * 只有配了具体值才卡 —— 与 `backfillSince` 的三态语义一致。
 *
 * 上界要卡：用户选"到 7 月 30 日"是**排除**之后的消息，而增量采集拉的是
 * "现在"的消息 —— 不卡的话选了历史区间的用户会持续收到今天的消息。
 */
export function isSentAtInScope(scope: CollectionScope, sentAt: number): boolean {
  if (typeof scope.since === "number" && sentAt < scope.since) return false
  if (scope.until !== undefined && sentAt > scope.until) return false
  return true
}

/**
 * 读当前的采集范围。
 *
 * ## chat 源被关掉时返回「一个都不许」
 *
 * 这是相对修复前的**行为变更**，也是修复的一部分：源关掉的语义只能是
 * "不要采聊天"，不可能是"采全部聊天"。修复前它被当成不限（见文件头），
 * 于是取消勾选那个开关反而放开了全部限制。
 *
 * 注意与 `minutesEnabled()` / `documentsEnabled()` 的三态判断不同：那两处
 * 要区分"没配过"（默认开）与"显式关"，因为引导默认勾了它们。而 chat 源
 * 的 `enabled` 由引导第 3 步显式写入，没有"没配过但应该开"的情形 ——
 * 表里没这一行时下面走的是 `restricted: false`（不限），与老库兼容。
 */
export function readCollectionScope(db: SqliteDatabase): CollectionScope {
  const row = db
    .prepare<
      [string],
      { enabled: number; scope_json: string | null }
    >("SELECT enabled, scope_json FROM distill_sources WHERE kind = ?")
    .get("chat")

  // 表里没有这一行 = 从没配过（老库 / 跳过了引导第 3 步）→ 不设限。
  if (row === undefined) {
    return {
      restricted: false,
      allow: new Set(),
      since: undefined,
      until: undefined,
      enabled: true,
    }
  }

  const enabled = row.enabled === 1
  let scope: DistillScope
  try {
    scope = row.scope_json === null || row.scope_json === "" ? {} : JSON.parse(row.scope_json)
  } catch {
    /**
     * 坏 JSON 按**最严**处理（`restricted: true` + 空白名单 = 一个都不采）。
     *
     * 与 `OnboardingRepository` 里"坏 JSON 按缺省"相反，是刻意的：那里是
     * 为了让引导页还能打开（读路径，宽容无害），而这里决定的是"要不要去
     * 采一个会话"。判据不可靠时采全部是隐私问题，不采只是没数据。
     */
    return { restricted: true, allow: new Set(), since: undefined, until: undefined, enabled }
  }

  // 源关掉 → 一个都不许（见上面那段）。
  if (!enabled) {
    return {
      restricted: true,
      allow: new Set(),
      since: undefined,
      until: undefined,
      enabled: false,
    }
  }

  const ids = scope.conversationIds
  return {
    // ★ 判据是"这个键存在"，不是"它非空"—— 空数组是"一个都不勾"，不是"不限"。
    restricted: ids !== undefined,
    allow: new Set(ids ?? []),
    // 缺字段 = 用户选了"不限"（引导页对不限就是不写这个键）
    since: scope.since ?? null,
    until: scope.until,
    enabled: true,
  }
}
