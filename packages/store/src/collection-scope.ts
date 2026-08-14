/**
 * 「用户在引导里选的**聊天**采集范围」—— 四处调用方的**唯一权威**。
 *
 * ## ★★★ 这一层现在是 `readDomainScope(db, "chat")` 的薄封装
 *
 * 三态语义（没配过 / 显式关 / 配了值）已经收敛进 `domain-scope.ts` ——
 * 那里是三个域共用的一份实现，而这个文件保留下来的理由**只有一个**：
 * `readCollectionScope` / `CollectionScope` / `isConversationInScope` /
 * `isSentAtInScope` 这四个名字被采集、蒸馏、forge、导出四处调用。
 *
 * 改签名就要同时改那四处 —— 而它们不一致过一次，后果是库里 55% 的消息
 * 属于用户没勾的会话（见下面那段实测）。所以这一层**不动名字、不动签名**，
 * 只把实现转过去。
 *
 * ★ 也就是说：新代码请直接用 `readDomainScope`（它支持 minutes/doc），
 * 这四个名字留给既有调用方。
 *
 * ## ★★ 为什么当初要单独一个模块，而不是各处自己读 `distill_sources`
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
import {
  isOccurredAtInScope,
  isPartitionInScope,
  readDomainScope,
  type DomainScope,
} from "./domain-scope.js"

/**
 * 采集范围的判定结果。用 `restricted` 区分"没配"与"配了空"（见文件头）。
 *
 * ★ 它现在是 `DomainScope` 的**别名式子集**（少一个 `unset`）。
 * 不直接 `= DomainScope` 是刻意的：`unset` 是新语义，四处既有调用方
 * 都不该被迫认识它。而 `DomainScope` 结构上包含 `CollectionScope` 的全部
 * 字段，所以 `readDomainScope` 的返回值可以直接当它用。
 */
export interface CollectionScope {
  /**
   * 是否设了会话白名单。
   *
   * `false` = 不设限；
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
 * ★ 转发到 `isPartitionInScope` —— 判据只有一份。这个名字保留是因为
 * 四处调用方都用它，而"会话"在 chat 语境下比"分区"好读。
 */
export function isConversationInScope(scope: CollectionScope, externalId: string): boolean {
  return isPartitionInScope(scope as DomainScope, externalId)
}

/**
 * 判断一条消息的业务时间是否在范围内。
 *
 * ★ 同样转发（`isOccurredAtInScope`）。
 *
 * ★ `since === null`（显式不限）与 `since === undefined`（没配过）都放行。
 * 只有配了具体值才卡 —— 与 `backfillSince` 的三态语义一致。
 *
 * 上界要卡：用户选"到 7 月 30 日"是**排除**之后的消息，而增量采集拉的是
 * "现在"的消息 —— 不卡的话选了历史区间的用户会持续收到今天的消息。
 */
export function isSentAtInScope(scope: CollectionScope, sentAt: number): boolean {
  return isOccurredAtInScope(scope as DomainScope, sentAt)
}

/**
 * 读当前的**聊天**采集范围。
 *
 * ★★ 实现已转到 `readDomainScope(db, "chat")` —— 三态语义在那里只有一份。
 * 这个函数保留的唯一理由是四处调用方用它的名字与签名（见文件头）。
 *
 * 下面这些判据都还成立，只是判据的**实现**搬到了 `domain-scope.ts`：
 *
 * ## chat 源被关掉时返回「一个都不许」
 *
 * 源关掉的语义只能是"不要采聊天"，不可能是"采全部聊天"。更早的一版把它
 * 当成不限，于是取消勾选那个开关反而放开了全部限制。
 *
 * ## ★★ 「表里没有这一行」也是「一个都不采」
 *
 * 这一条曾经反着写（返回 `restricted: false` = 不限 = 采全部），理由是
 * "兼容没配过范围的老库"。但那让**清空渠道数据**变成一个陷阱：清完之后
 * `distill_sources` 是空的 → 读成"不限" → 采集把**全部**会话都拉回来，
 * 而用户刚刚明确表达的是"我要归零"。方向正好相反，且不报错。
 *
 * 现在这条由 `DOMAIN_SCOPE_DEFAULTS.chat = "collect-nothing"` 表达 ——
 * 而 minutes/doc 的方向相反（`collect-all`，引导默认勾了它们）。
 * 两个方向都对，代价不对称的方向不同（见 `domain-scope.ts` 文件头）。
 *
 * ★ `unset` 字段**刻意不透出**：`CollectionScope` 没有它，所以既有调用方
 * 的类型不变。要用它的新代码（chat 的 `scopeNotReady` 判据）直接调
 * `readDomainScope`。
 */
export function readCollectionScope(db: SqliteDatabase): CollectionScope {
  return readDomainScope(db, "chat")
}
