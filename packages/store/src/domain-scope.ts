/**
 * 「某个数据域的采集范围」—— 三态语义的**唯一**一份实现。
 *
 * ## ★★★ 为什么要这一层（它收敛的是一个真实的分散判据）
 *
 * 同一个问题「`distill_sources` 里没有这个 kind 的行，怎么办」，
 * 修复前有**三处各自回答**，而且给了三个不同的答案：
 *
 * | 域 | 判据在哪 | 「没配过」时 |
 * |---|---|---|
 * | chat | `collection-scope.ts` `readCollectionScope` | **一个都不采** |
 * | minutes | `ingest.service.ts` `minutesEnabled` / `minutesTimeRange` | **默认开、不限时间** |
 * | doc | `ingest.service.ts` `documentsEnabled` | **默认开、不限时间** |
 *
 * ★★ **这两个方向相反不是 bug，统一它才是 bug。** 代价不对称的方向不同：
 *
 * · chat 的默认值若放宽 → **隐私事故**（采了用户没同意的全部聊天历史）。
 *   而且「清空渠道数据」之后 `distill_sources` 是空的，读成"不限"会让采集
 *   把全部会话拉回来 —— 与用户刚刚表达的"我要归零"方向正好相反；
 * · minutes/doc 的默认值若收紧 → **功能静默消失**（引导默认勾了它们，
 *   用户没显式关过，凭什么不采）。
 *
 * 所以要收敛的**不是方向**，而是「这个判据在哪里表达」。做法是让方向成为
 * 声明里的一等公民（`DOMAIN_SCOPE_DEFAULTS`），而不是散在三处实现里 ——
 * 第四个域接进来时它**必须**在那张表里出现（否则 `domainScopeDefault` 抛错），
 * 而不是靠读者去比对三处代码猜一个默认值。
 *
 * ## ★ 为什么住在 `store` 而不是 `ingest`
 *
 * `DomainSpec`（拓扑声明）在 `@mycontext/ingest`，而 ingest 依赖 store，
 * 反向不成立。而**闸是在 store 这一层执行的**（`isConversationInScope` /
 * `isSentAtInScope` 都在这里，采集/蒸馏/forge/导出四处都调它们）。
 * 把默认值放在 ingest 会让 store 反向依赖，或者让四处调用方各自传一个
 * 默认值进来 —— 后者等于把刚收敛掉的分散判据换个形式再散一次。
 *
 * 拓扑那侧要展示这个信息时从这里 import（方向正确）。
 *
 * ## ★ 为什么不缓存
 *
 * 与 `readCollectionScope` 同一条理由：用户改了范围必须**立刻**生效
 * （下一轮采集就不许再碰被移出的会话）。缓存一份就多一个可能过期的副本，
 * 而过期的方向恰好是"继续采已经被取消的那些" —— 那正是要消灭的问题。
 * 一次 `SELECT` 走主键，比一次 CLI 调用便宜几个数量级。
 */
import type { SqliteDatabase } from "./database.js"
import type { DistillScope } from "./repositories/onboarding.js"

/**
 * 这个域「表里没有那一行」时的缺省方向。
 *
 * ★ 措辞是**动作**（采什么）而不是布尔（严/松）：`strict: true` 那种命名
 * 读到调用点上会变成"strict 的时候是采还是不采？"—— 而这个问题答错一次
 * 就是一次隐私事故或一次功能消失。用动作命名让它在调用点自解释。
 */
export type DomainScopeDefault = "collect-nothing" | "collect-all"

/**
 * 每个域「没配过」时的缺省方向。**新域必须在这里出现。**
 *
 * ★ 用 `Record<ChangelogDomain, …>`（必填而非 Partial）是这一层的关键：
 * 加一个域而忘了表态会**编译失败**，而不是静默拿到某个默认值。
 * 这与 `DomainSpec.producedBy` 是同一手法 —— 让"漏了表态"变成编译错误。
 *
 * ★ `contact` 标 `collect-nothing`：通讯录属 PII，相关渠道命令不在白名单内
 * （CLAUDE.md §5），压根没有采集器。标 `collect-all` 会在将来有人接
 * contact 采集器时给它一个"默认全采 PII"的起点 —— 那是最坏的默认值。
 */
export const DOMAIN_SCOPE_DEFAULTS = {
  chat: "collect-nothing",
  minutes: "collect-all",
  doc: "collect-all",
  contact: "collect-nothing",
} as const satisfies Record<string, DomainScopeDefault>

/** `distill_sources.kind` 里与数据域对应的那几个。 */
export type ScopedDomain = keyof typeof DOMAIN_SCOPE_DEFAULTS

/**
 * 取某个域的缺省方向。
 *
 * ★ 抛错而不是回落到某个方向：一个不在表里的域名说明调用方拼错了字，
 * 而"静默用 collect-all"会让那个拼写错误表现为**超范围采集**
 * （最坏的方向），"静默用 collect-nothing"则表现为停采（也是静默故障）。
 * 两个静默降级都比一个响亮的错误糟。
 */
export function domainScopeDefault(domain: string): DomainScopeDefault {
  const value = (DOMAIN_SCOPE_DEFAULTS as Record<string, DomainScopeDefault | undefined>)[domain]
  if (value === undefined) {
    throw new Error(`域 ${domain} 没有在 DOMAIN_SCOPE_DEFAULTS 里声明缺省方向`)
  }
  return value
}

/**
 * 一个域的范围判定结果。
 *
 * ★ `restricted` 必须与「白名单为空」分开表达 —— 两种"空"的含义相反，
 * 而 `string[]` 表达不了这个区别：
 * · 用户**没配过**范围 → 按域的缺省方向；
 * · 用户配了范围但**一个都没勾** → 一个都不采。
 *
 * 修复前（更早的那一版）两者都是 `[]`，于是后者被当成前者 ——
 * "我一个都不要"被执行成"全都要"。用 `restricted: boolean` 显式区分。
 */
export interface DomainScope {
  /**
   * 是否设了分区白名单。
   *
   * `false` = 不设限；
   * `true` = `allow` 就是全部许可的分区（**可能为空** = 一个都不许）。
   */
  restricted: boolean
  /** 许可的分区键（会话 / 空间的 external_id）。`restricted === false` 时无意义。 */
  allow: ReadonlySet<string>
  /** 时间下界（unix ms）；null = 用户显式选了"不限"；undefined = 没配过 */
  since: number | null | undefined
  /** 时间上界（unix ms）；undefined = 不限 */
  until: number | undefined
  /** 这个源本身是否开启 */
  enabled: boolean
  /**
   * 这个域**还没配过**范围（表里没有那一行）。
   *
   * ## ★★★ 为什么必须单独一个字段，而不是让调用方看 `since === undefined`
   *
   * chat 那侧的调用方要靠它做一件**正确性相关**的事：`scopeNotReady` ——
   * 采集器可能比范围行先跑，那一轮拉到的消息会被全丢，而**水位不能推**
   * （推了那批消息就永远回不来，实测过：飞书拉到 9 条、全丢、之后 20 分钟
   * 一条不采）。
   *
   * `since === undefined` 表达不了这件事：用户显式选"不限时间"时它也是
   * undefined（那时范围是配过的、采集该正常跑）。两者混一起会让
   * "选了不限时间"的用户永远推不动水位。
   */
  unset: boolean
  /**
   * `scope_json` **读不出来**（坏 JSON）。
   *
   * ## ★★★ 为什么它必须与 `unset` / `restricted` 都分开
   *
   * 这三者是**三个不同的事实**，而更早的实现把它们挤进两个字段，
   * 于是同一个"坏 JSON"在两个域上被解读成相反的方向：
   *
   * | 域 | 坏 JSON 时的旧行为 | 后果 |
   * |---|---|---|
   * | chat | `restricted: true` + 空白名单 ⇒ 一条都不采 | 隐私侧（对） |
   * | minutes | `minutesTimeRange` 返回 `{}` ⇒ **不限时间、照采** | 超范围（错） |
   *
   * minutes 那侧的理由是"不让手改过的库停采"，而它**忽略了一件事**：
   * 用户可能选的是"只学最近 30 天"，JSON 坏掉之后照采就把全部历史采回来了
   * —— 按 CLAUDE.md 第 5 节那是隐私事故，而"停采"只是没数据。
   *
   * 但"停采"这个方向有一个真实的代价：它**静默**（用户看不出成因）。
   * 所以判据是：**按最严处理，但要可见** —— 调用方拿到这个标记就必须
   * 记一条 warn（见 `IngestService.domainScopeOrWarn`）。
   *
   * ★ 把它挤进 `restricted` 的另一个坏处：`restricted` 的语义是
   * "用户设了分区白名单"，而坏 JSON 时我们**根本不知道**他设了没有。
   * 让一个"不知道"去冒充一个"知道"，下一个读代码的人必然读错。
   */
  unreadable: boolean
}

/**
 * 判断一个分区（会话 / 空间）是否在范围内。
 *
 * 抽成函数而不是让调用方写 `!scope.restricted || scope.allow.has(id)` ——
 * 那个表达式里有一个 `!` 与一个短路，抄错一次就是一次泄漏（而且不报错）。
 */
export function isPartitionInScope(scope: DomainScope, partitionId: string): boolean {
  if (!scope.restricted) return true
  return scope.allow.has(partitionId)
}

/**
 * 判断一个业务时间是否在范围内。
 *
 * ★ `since === null`（显式不限）与 `since === undefined`（没配过）都放行 ——
 * "没配过"这件事由 `unset` 表达，且它的处置是调用方的决定
 * （chat 要中断本轮、minutes/doc 要照常采），不是这个纯函数的。
 *
 * 上界要卡：用户选"到 7 月 30 日"是**排除**之后的数据，而增量采集拉的是
 * "现在"的 —— 不卡的话选了历史区间的用户会持续收到今天的数据。
 */
export function isOccurredAtInScope(scope: DomainScope, occurredAt: number): boolean {
  if (typeof scope.since === "number" && occurredAt < scope.since) return false
  if (scope.until !== undefined && occurredAt > scope.until) return false
  return true
}

/**
 * 这个域现在**一条都不该采**吗。
 *
 * ## ★★★ 为什么必须有这个函数（反证抓出来的一个真实漏洞）
 *
 * 我第一版让 doc 那条采集路只用**时间闸**（`isOccurredAtInScope`），
 * 而完全不看 `restricted`。于是 `DOMAIN_SCOPE_DEFAULTS.doc` 那个声明
 * 对文档来说是**装饰性的** —— 反证时把它从 `collect-all` 改成
 * `collect-nothing`，9 条用例**一条都没转红**。
 *
 * 那正是这一轮要消灭的形态：声明写着一件事，代码里没有任何地方执行它。
 * 而它的危险方向很具体：将来有人按隐私要求把某个域的缺省改成
 * `collect-nothing`，改完**以为生效了**，实际那个域照采。
 *
 * ## 判据：`restricted` 且白名单为空
 *
 * · chat：用户配了范围但一个都没勾 ⇒ 一个都不采（既有语义）；
 * · minutes/doc：`DistillScope` 里**没有**空间白名单字段（那是 G6），
 *   所以有行时 `restricted` 恒 false；只有 `unset` + 缺省
 *   `collect-nothing` 会让它为 true —— 也就是恰好只在"该按缺省不采"
 *   的时候为真。
 *
 * ★ 抽成函数而不是让调用方写 `scope.restricted && scope.allow.size === 0`：
 * 那个表达式有两个条件与一个隐含前提（"空 allow 才算不采"），
 * 抄错一次的方向是**采了不该采的**。
 */
export function collectsNothing(scope: DomainScope): boolean {
  return scope.restricted && scope.allow.size === 0
}

/**
 * 读某个域当前的采集范围。
 *
 * ## 三态（这是这个函数存在的全部理由）
 *
 * | 库里的状态 | 结果 |
 * |---|---|
 * | 没有这一行 | 按 `domainScopeDefault(domain)`；`unset: true` |
 * | `enabled = 0`（显式关） | `restricted: true` + 空白名单 = 一个都不采 |
 * | 有行且开启 | 按 `scope_json` 解析 |
 *
 * ## ★★ 「源关掉」的语义只能是"不要采"
 *
 * 更早的一版把它读成"不限"（= 采全部），于是**取消勾选那个开关反而放开了
 * 全部限制**。实测后果：库里 55% 的消息属于用户没勾的会话
 * （84,325 条里 46,415 条），且仍在以每小时 64% 的比例继续进来。
 *
 * ## ★ 坏 JSON 按**最严**处理
 *
 * 与 `OnboardingRepository` 里"坏 JSON 按缺省"相反，是刻意的：那里是为了
 * 让引导页还能打开（读路径，宽容无害），而这里决定的是"要不要去采一个
 * 会话"。判据不可靠时采全部是隐私问题，不采只是没数据。
 *
 * ★ 坏 JSON 时 `unset: false`：那一行**存在**（用户配过），只是内容读不出来。
 * 报成 unset 会让 chat 那侧走 `scopeNotReady`（不推水位、每轮重试），
 * 而一个手改坏的库会因此永久停在原地 —— 那是把一个数据问题升级成死锁。
 */
export function readDomainScope(db: SqliteDatabase, domain: ScopedDomain): DomainScope {
  const fallback = domainScopeDefault(domain)
  const row = db
    .prepare<
      [string],
      { enabled: number; scope_json: string | null }
    >("SELECT enabled, scope_json FROM distill_sources WHERE kind = ?")
    .get(domain)

  /**
   * 表里没有这一行 = 用户还没说过要采什么（全新库 / 刚被清空 / 跳过了引导）
   * → 按这个域的缺省方向。
   */
  if (row === undefined) {
    return {
      restricted: fallback === "collect-nothing",
      allow: new Set(),
      since: undefined,
      until: undefined,
      // ★ 恒 true：`enabled` 回答"用户关了吗"，而这里是"还没配过" ——
      // 报 false 会让上层显示"用户把文档源关了"，那是错的归因。
      enabled: true,
      unset: true,
      unreadable: false,
    }
  }

  const enabled = row.enabled === 1
  let scope: DistillScope
  try {
    scope = row.scope_json === null || row.scope_json === "" ? {} : JSON.parse(row.scope_json)
  } catch {
    // 见文件头：坏 JSON 按最严处理，但 unset 为 false（那一行存在）。
    return {
      restricted: true,
      allow: new Set(),
      since: undefined,
      until: undefined,
      enabled,
      unset: false,
      // ★ 这一行存在、但内容读不出来 —— 与"没配过"和"设了白名单"都不同
      unreadable: true,
    }
  }

  // 源关掉 → 一个都不许（见上面那段）。
  if (!enabled) {
    return {
      restricted: true,
      allow: new Set(),
      since: undefined,
      until: undefined,
      enabled: false,
      unset: false,
      unreadable: false,
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
    unset: false,
    unreadable: false,
  }
}
