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
 * ★ `enforced` 必须与 `routed` 分开：名单为空时我们**放行**（见 `route()`），
 * 那时 `routed: true` 的含义是"没有配置所以不拦"，而不是"在范围内"。
 * 混成一个布尔会让状态页把"用户还没配监听范围"显示成"全部会话都在范围内"。
 */
export interface AttentionRouterVerdict {
  routed: boolean
  /** 不放行的原因；放行时为 null */
  reason: Exclude<AttentionRoute, { routed: true }>["reason"] | null
  /** 名单非空 ⇒ 这次判定真的按用户配置执行了 */
  enforced: boolean
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
   * ## ★★★ 名单为空 → 放行（迁移期的正确一侧）
   *
   * `attention_scope` 是 v28 新加的表，存量用户那张表是空的。空表判成
   * "什么都不关心"会让分身**整个静默** —— 用户看到的是"它不理人了"，
   * 而日志里一个错都没有。那是一次静默功能回归，比"多投几个会话"糟得多。
   *
   * 所以判据是「名单非空才生效」。这一条与 `readCollectionScope` 的
   * 「没配过就什么都不采」方向**相反**，而两者都对 —— 因为代价不对称的
   * 方向不同：采集的默认值若放宽是**隐私事故**（采了用户没同意的历史），
   * 投递的默认值若收紧是**功能消失**（分身不干活，且无从排查）。
   *
   * ★ 名单空时**不记账**：那一段时间的 routed/skipped 都不代表用户配置的
   * 效果，记进去会让"范围设窄了"与"还没配范围"在覆盖面上同形。
   */
  route(input: AttentionRouterInput): AttentionRouterVerdict {
    if (this.scope.activeCount(input.channelId) === 0) {
      return { routed: true, reason: null, enforced: false }
    }
    const row = this.scope.get(input.channelId, input.conversationExternalId)
    const verdict = routeToAttention({
      conversationExternalId: input.conversationExternalId,
      sentAt: input.sentAt,
      scope: row === null ? null : { enabledAt: row.enabledAt, active: row.active },
    })
    this.bump(input, verdict.routed)
    return verdict.routed
      ? { routed: true, reason: null, enforced: true }
      : { routed: false, reason: verdict.reason, enforced: true }
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
