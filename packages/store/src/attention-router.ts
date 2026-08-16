/**
 * 监听范围的**路由器** —— 快通道与慢兜底**唯一**共用的那道闸。
 *
 * ## ★★★ 为什么必须有这个类（它修的是一个真实的正确性缺陷）
 *
 * 路由（`routeToAttention`）本来只挂在**快通道**上：`IngestService` 的
 * `inbound.message` 事件回调里。而投递给管控层有**两条**路：
 *
 * · 快通道 —— 入库后的进程内事件，毫秒级；
 * · 慢兜底 —— `persona-inbox` 消费者扫 changelog（崩溃 / 漏事件时补上）。
 *
 * 慢兜底那条路**完全没有过路由**（`inbox-consumer.ts` 全文零引用
 * `attention_scope`）。也就是用户勾的监听范围在那条路上不生效。
 *
 * 而这个缺陷有一个放大器：`inbound.message` 只在 `backfill !== true`
 * 且 `changed.length > 0` 时 emit。本机历史早已采完（实测 62 个连续页
 * 全是 `changed:0 / unchanged:51`），所以**快通道在真机上几乎不触发** ——
 * 实际生效的多半正是没有路由的那条。
 *
 * 修法不是"在慢兜底里也抄一遍"（那就有两份判据，迟早分叉，而分叉的表现是
 * "快通道拦了、慢兜底放了"这种谁都看不出来的不一致），而是把判据收成
 * **一个对象**，两条路都持它。
 *
 * ## ★ 为什么是类而不是继续用纯函数
 *
 * `routeToAttention` 仍然是纯函数、仍然是判据的真源 —— 这个类不替代它，
 * 只是把它**执行一次所需要的三件事**打包：
 *
 * ① 名单空不空（决定要不要生效，见下）；
 * ② 取这个会话在名单里的那一行；
 * ③ 记账 routed / skipped 两侧。
 *
 * 打包的收益是 statement 复用：逐条投递时每条都 `new Repository()` +
 * 重建 prepared statement，在回溯 20 万条时是分钟级的差别。
 *
 * ## ★★ 不缓存 `activeCount`
 *
 * 与 `readCollectionScope` 同一条理由：用户改了范围必须**立刻**生效。
 * 缓存一份就多一个可能过期的副本，而过期的方向恰好是
 * "继续把已经取消关心的会话投给分身" —— 那正是要消灭的问题。
 * 一次 `count(*)` 走部分索引 `idx_attention_active`，比一次 CLI 调用
 * 便宜几个数量级。
 */
import type { Clock } from "@mycontext/kernel"
import type { SqliteDatabase } from "./database.js"
import {
  AttentionCoverageRepository,
  AttentionScopeRepository,
  routeToAttention,
  type AttentionMode,
  type AttentionRoute,
} from "./repositories/attention-scope.js"
import { toDayBucket } from "./repositories/chat-coverage.js"

/** 路由一条消息要的最小输入。★ 不收整个消息对象 —— 见 `AttentionRouteInput`。 */
export interface AttentionRouterInput {
  channelId: string
  conversationExternalId: string
  /** 消息的**业务时间**（不是入库时间：回填一段历史不该被当成"刚发生"） */
  sentAt: number
}

/**
 * 路由结论 + 「这次判定生效了吗」。
 *
 * ★ `enforced` 必须与 `routed` 分开：mode 为 `unset` 时我们**放行**
 * （见 `route()`），那时 `routed: true` 的含义是"没有配置所以不拦"，
 * 而不是"在范围内"。混成一个布尔会让状态页把"用户还没配监听范围"
 * 显示成"全部会话都在范围内"。
 */
export interface AttentionRouterVerdict {
  routed: boolean
  /** 不放行的原因；放行时为 null */
  reason: Exclude<AttentionRoute, { routed: true }>["reason"] | null
  /** 用户**表过态** ⇒ 这次判定真的按他的配置执行了 */
  enforced: boolean
  /**
   * 这次判定走的哪个模式（诊断与界面用，不参与判断）。
   *
   * ★ 报出来是因为 `routed: true` 现在有**两个**来源
   * （`unset` 的"还没配所以不拦"与 `all` 的"用户选了全部"），
   * 而它们在界面上该说不同的话。
   */
  mode: AttentionMode
}

export class AttentionRouter {
  private readonly scope: AttentionScopeRepository
  private readonly coverage: AttentionCoverageRepository

  constructor(
    db: SqliteDatabase,
    private readonly clock: Clock,
  ) {
    this.scope = new AttentionScopeRepository(db)
    this.coverage = new AttentionCoverageRepository(db)
  }

  /**
   * 这条消息属于分身的关心范围吗（**并记账**）。
   *
   * ## ★★★ 三个模式，而不是"名单空不空"（这修的是一个方向错误）
   *
   * 改动前判据只有一条：`activeCount === 0` → 放行全部。而**三个不同的
   * 用户动作**都会让那个计数归零，其中一个的方向是反的：
   *
   * · 从没配过 → 放行（对：存量库那张表是空的，判成"什么都不关心"
   *   会让分身**整个静默**，用户看到"它不理人了"而日志里一个错都没有）；
   * · 引导里一个都不勾 → 放行（对：那是"不收窄"的意思）；
   * · **设置里把全部关掉** → 旧判据也放行（**错**：用户把最后一个会话
   *   关掉之后分身盯得更多了，而它不报错）。
   *
   * 三态（`AttentionMode`）把这三件事分开：前两个分别是 `unset` 与 `all`
   * （都放行，区别只在记账与 `enforced`），第三个是 `explicit` + 空名单
   * （**一条都不放行**）。
   *
   * ★ 这一条与 `readDomainScope` 的「没配过就什么都不采」方向**相反**，
   * 而两者都对 —— 代价不对称的方向不同：采集的默认值若放宽是**隐私事故**
   * （采了用户没同意的历史），投递的默认值若收紧是**功能消失**
   * （分身不干活，且无从排查）。
   *
   * ★ `unset` 时**不记账**：那一段时间的 routed/skipped 都不代表用户配置的
   * 效果，记进去会让"范围设窄了"与"还没配范围"在覆盖面上同形。
   * 而 `all` **要记** —— 它是一次用户决定，覆盖面该反映它的效果。
   */
  route(input: AttentionRouterInput): AttentionRouterVerdict {
    const mode = this.scope.mode(input.channelId)

    /**
     * ★★★ `unset`（存量库 / 还没表态）→ **回落到旧判据**，而不是无条件放行。
     *
     * ## 这一条我第一版写错了，而错法很具体
     *
     * 第一版写的是 `if (mode === "unset") return 放行` —— 而那会让
     * **一个已经配好监听范围的存量库静默失去收窄效果**：
     * 那些库里 `attention_scope` 有行、但没有 mode 键（它是这一轮新加的），
     * 于是用户明确勾过的 3 个群变成"盯全部"。
     *
     * 被集成测试当场抓到（5 条转红：范围外的消息全部被放行）。
     *
     * ## 正确的回落是「旧判据」，也就是按名单空不空判
     *
     * · 名单**空** → 放行、不记账（存量升级那一档，不能让分身静默停摆）；
     * · 名单**非空** → 按名单判（用户配过，那个配置必须继续生效）。
     *
     * ★ 这样 `unset` 的行为与改动前**逐字相同**，而三态带来的新能力
     * 全部落在"用户显式写过 mode"之后：
     * · `all` —— 放行且**记账**（那是一次决定，不是缺省）；
     * · `explicit` + 空名单 —— **一条都不放行**（"把全部关掉"应有的效果，
     *   而旧判据在这里方向是反的）。
     *
     * ★★ 而 `disable()` 现在会顺带写 `mode: "explicit"` —— 所以"逐个关到
     * 最后一个"这条路径会落进 explicit，拿到正确的收窄语义。
     * 那是 G11 真正被修掉的地方，不是靠改 `unset` 的方向。
     */
    const enforced =
      mode === "explicit" || (mode === "unset" && this.scope.activeCount(input.channelId) > 0)

    if (mode === "unset" && !enforced) {
      return { routed: true, reason: null, enforced: false, mode }
    }

    /**
     * ★ `all`：放行、**记账**、`enforced: true`。
     *
     * 与 `unset` 的空名单只差记账与 enforced，而那正是要区分的两件事：
     * 「你还没说要盯什么」与「你说了盯全部」在界面上是两句不同的话。
     */
    if (mode === "all") {
      this.bump(input, true)
      return { routed: true, reason: null, enforced: true, mode }
    }

    /**
     * ★★★ 按名单判。`explicit` 时**名单为空就一条都不放行**。
     *
     * 这里刻意**不**再判一次 `activeCount === 0` → 放行 —— 那个判断正是
     * 旧的错误方向：用户把最后一个会话关掉之后分身反而盯得更多。
     */
    const row = this.scope.get(input.channelId, input.conversationExternalId)
    const verdict = routeToAttention({
      conversationExternalId: input.conversationExternalId,
      sentAt: input.sentAt,
      scope: row === null ? null : { enabledAt: row.enabledAt, active: row.active },
    })
    this.bump(input, verdict.routed)
    return verdict.routed
      ? { routed: true, reason: null, enforced: true, mode }
      : { routed: false, reason: verdict.reason, enforced: true, mode }
  }

  /**
   * 记账 routed / skipped **两侧**。
   *
   * ★ 只记放行的话，"范围设窄了"与"那段时间没消息"不可区分 ——
   * 而那正是用户会来问的那个问题。
   *
   * ★ 记账失败**不许**影响投递：它是派生物，投递是正事。但也不静默 ——
   * 抛出去会打断整条投递链（那才是真正的损失），所以吞掉异常并让调用方
   * 通过覆盖面数字对不上来发现（覆盖面本身就不是账本，是观测量）。
   *
   * ★ `dayBucket` 按**消息的业务时间**分桶，不是记账时刻：一条昨天的消息
   * 今天被慢兜底捞回来时，它属于昨天那一天的实时流覆盖面。
   */
  private bump(input: AttentionRouterInput, routed: boolean): void {
    try {
      this.coverage.bump(input.channelId, {
        dayBucket: toDayBucket(input.sentAt),
        routed: routed ? 1 : 0,
        skipped: routed ? 0 : 1,
        at: this.clock.now(),
      })
    } catch {
      // 见上面那段注释：派生物失败不该拖垮投递
    }
  }
}
