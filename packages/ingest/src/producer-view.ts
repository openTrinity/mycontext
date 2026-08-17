/**
 * 生产者的**运行时视图** —— 声明 + 范围状态 + 本进程计数，合成一张可展示的表。
 *
 * ## ★★★ 为什么必须有这一层（它补的是一个不对称）
 *
 * 消费者侧早就有完整的运行时视图（`buildConsumerStatuses` →
 * `IngestSnapshot.consumers`：lag / absent / waiting / stale / unwired）。
 * 而生产者侧只有**一个全局对象**（`IngestSnapshot.scope`）：
 *
 * ```
 * scope: { restricted, allowed, droppedOutOfScope, lastDroppedAt }
 *                                 ↑
 *                    chat 与 doc 两条路累加进**同一对字段**
 * ```
 *
 * 三件事因此读不出来，而它们的出路完全不同：
 *
 * · **谁丢的** —— 「文档被挡掉 300 篇」与「聊天被挡掉 300 条」在界面上
 *   是同一个数字。前者去改文档的空间白名单，后者去改会话勾选；
 * · **范围就绪了吗** —— `scopeNotReady` 完全不可见，而它是那次
 *   "飞书一条都采不到"的根因（采集比范围行先跑、9 条全丢、水位照常前移）；
 * · **上一轮抽干了吗** —— 现在要从三个不同的地方拼：`minutesCoverage.drained`
 *   在快照里、文档的截断只有一条 warn 日志、chat 靠 `backfill` 那三个数字。
 *
 * ## ★★ 为什么是纯函数、而且不读库
 *
 * 与 `topology-view.ts` 同一条纪律：范围与计数都由调用方传进来。
 *
 * ① 单测能直接打到每个分支（范围没就绪 / 坏 JSON / 渠道没这个域），
 *    不必造一个跑得起来的采集管线去间接观察；
 * ② 快照那条路径已经很贵（9 个 `COUNT(*)`），不该再加查询 ——
 *    而范围**必须每轮现读**（用户改了范围下一轮就该生效），
 *    所以读的时机由调用方掌握。
 */
import { PRODUCERS, type DataDomain, type ProducerSpec, type ChannelIdLike } from "./topology.js"

/** 一个生产者本进程的丢弃计数。★ 与覆盖面无关 —— 那是落库之后的账。 */
export interface ProducerCounters {
  /** 因**超出用户范围**被丢弃的条数 */
  droppedOutOfScope: number
  /**
   * 其中因**渠道没给业务时间**被丢的条数。
   *
   * ★ 与上一个分开：「超出你选的日期」与「这条数据渠道没给时间」是两个
   * 事实，出路也不同（前者去改范围、后者要去看渠道解析）。
   */
  droppedUnknownTime: number
  /**
   * ★★★ 「**入库了**，但不给学习侧」的条数（`learning_eligible = 0`）。
   *
   * ## 它与 `droppedOutOfScope` 是两个事实，出路不同
   *
   * | | 事实 | 出路 |
   * |---|---|---|
   * | `droppedOutOfScope` | 压根没拉 / 没入库 | 改**采集面**（隐私边界） |
   * | `taggedIneligible` | ★ 入库了，只是学习侧看不到 | 改**学习范围**（放宽后立刻能学） |
   *
   * v4 的设计表原来写的是"把 dropped 改成打标为 0 的条数"。合成一个的
   * 后果很具体：一个正常状态（分身在用那些消息）会被报成"漏采了 300 条"，
   * 而真的漏采会被这个正常值淹掉。所以分成两个数。
   */
  taggedIneligible: number
  /** 最近一次丢弃的时刻；null = 本进程还没丢过 */
  lastDroppedAt: number | null
}

/** 范围状态的**最小投影** —— 这一层只要三个布尔，不要整个 `DomainScope`。 */
export interface ProducerScopeState {
  /**
   * 这个域现在**一条都不该采**（`collectsNothing`）。
   *
   * ★ 名字用"不采"而不是 `ready` 的反面：`ready: false` 读到调用点上
   * 会变成"没就绪的时候是采还是不采？"，而那个问题答错一次就是
   * 一次隐私事故或一次功能消失（`DomainScopeDefault` 的命名同一条判据）。
   */
  collectsNothing: boolean
  /** 用户还没配过这个域的范围（表里没有那一行） */
  unset: boolean
  /** `scope_json` 读不出来（坏 JSON）—— 与"没配过"必须分开 */
  unreadable: boolean
}

/** 一个生产者的完整状态（声明 + 运行时）。 */
export interface ProducerStatus {
  id: string
  purpose: string
  domains: readonly DataDomain[]
  schedule: ProducerSpec["schedule"]
  /**
   * 范围就绪了吗（可以开始采了）。
   *
   * ★ 判据是 `!collectsNothing`，**不含** `unset`：一个"没配过 +
   * 缺省 collect-all"的域（听记/文档）是**就绪**的 —— 它按缺省方向采。
   * 把 unset 算进"没就绪"会让那两个域在全新库上永久显示未就绪，
   * 而它们其实正常在采。
   */
  scopeReady: boolean
  /** 用户还没配过（与"没就绪"分开：见上） */
  scopeUnset: boolean
  /**
   * 范围**读不出来**（坏 JSON）。
   *
   * ★ 必须与 `scopeReady: false` 分开显示：前者用户自己能修
   * （在设置页重存一次范围），后者要去改勾选。而两者现在都表现为"不采"。
   */
  scopeUnreadable: boolean
  droppedOutOfScope: number
  droppedUnknownTime: number
  /** ★ 入库了但学习侧看不到的条数 —— 见 `ProducerCounters.taggedIneligible` */
  taggedIneligible: number
  lastDroppedAt: number | null
  /**
   * 上一轮**抽干了吗**。`null` = 这个调度形状没有"抽干"这件事。
   *
   * ★ 三个值三种含义，不能用布尔表达：
   * · `true` —— 上一轮翻到了 `hasMore=false`，覆盖面是完整的；
   * · `false` —— 撞了页数预算/截断，覆盖面**不完整**（条数是下界）；
   * · `null` —— `watermark` / `stream` 那两种调度压根没有这个概念
   *   （前者靠水位的连续前缀、后者是实时流）。报 false 会让界面说
   *   "还没采完"，而那对聊天是永远成立的一句废话。
   */
  drained: boolean | null
  /**
   * 当前挂着的渠道里**有没有**能产这个域的（修 G17）。
   *
   * false = 这个 vault 的渠道都没有这个能力（比如只连了飞书而这是听记）。
   * ★ 与 `scopeReady: false` 必须分开：前者的出路是"去连另一个渠道"，
   * 后者是"去改范围"。合成一个布尔会让用户对着范围设置反复调，
   * 而问题在别处。
   */
  supportedByChannel: boolean
}

export interface ProducerViewInput {
  producers?: readonly ProducerSpec[]
  /**
   * 当前挂着的渠道自述的域能力（**并集**）。
   *
   * ★ 并集而不是单个渠道：一个 vault 可能挂多个渠道，任一渠道有听记
   * 能力，听记那个生产者就是被支持的。`undefined` = 不判（全部支持）。
   */
  channelDomains?: readonly string[]
  /** 每个域的范围状态。缺的域按"就绪 + 没配过"处理（见 `resolve`）。 */
  scopes?: ReadonlyMap<DataDomain, ProducerScopeState>
  /** 每个**生产者 id** 的计数。缺的按全零。 */
  counters?: ReadonlyMap<string, ProducerCounters>
  /** 每个**生产者 id** 上一轮抽干了吗。缺的按 `null`（没有这个概念）。 */
  drained?: ReadonlyMap<string, boolean>
}

const ZERO: ProducerCounters = {
  droppedOutOfScope: 0,
  droppedUnknownTime: 0,
  taggedIneligible: 0,
  lastDroppedAt: null,
}

/**
 * 合成生产者状态表。
 *
 * ★ 遍历**声明**而不是遍历运行时数据：那样"声明了但这一轮没跑"会显示成
 * 一行（计数全零），而不是整行消失 —— 与 `buildConsumerStatuses` 按
 * `CONSUMERS` 遍历同一条理由（G2 那次就是"游标表里有、界面上没有"）。
 */
export function buildProducerStatuses(input: ProducerViewInput = {}): readonly ProducerStatus[] {
  const specs = input.producers ?? PRODUCERS
  const capable = input.channelDomains === undefined ? null : new Set(input.channelDomains)

  return specs.map((spec) => {
    const counters = input.counters?.get(spec.id) ?? ZERO
    /**
     * ★ 一个生产者可能投多个域（现在都是一个，但声明允许多个）。
     * 范围状态取**最严**的那个：任一域不采，这个生产者就不算完全就绪 ——
     * 报"就绪"而实际有一个域在丢数据是那种"看起来没问题"的静默故障。
     */
    const states = spec.domains
      .map((domain) => input.scopes?.get(domain))
      .filter((state): state is ProducerScopeState => state !== undefined)
    const collectsNothing = states.some((state) => state.collectsNothing)
    const unset = states.some((state) => state.unset)
    const unreadable = states.some((state) => state.unreadable)

    return {
      id: spec.id,
      purpose: spec.purpose,
      domains: spec.domains,
      schedule: spec.schedule,
      scopeReady: !collectsNothing,
      scopeUnset: unset,
      scopeUnreadable: unreadable,
      droppedOutOfScope: counters.droppedOutOfScope,
      droppedUnknownTime: counters.droppedUnknownTime,
      taggedIneligible: counters.taggedIneligible,
      lastDroppedAt: counters.lastDroppedAt,
      /**
       * ★ 只有会"抽干"的两种调度才可能有值。`watermark` 与 `stream`
       * 即使调用方误传了一个布尔也报 `null` —— 声明是权威，
       * 而"某些行的某列没有意义"必须由类型表达，不是靠调用方记得别传。
       */
      drained:
        spec.schedule === "drain-each-round" || spec.schedule === "tiered-listing"
          ? (input.drained?.get(spec.id) ?? null)
          : null,
      supportedByChannel:
        capable === null ? true : spec.domains.some((domain) => capable.has(domain)),
    }
  })
}

/** 这个渠道 id 能产哪些域（给状态页拼 `channelDomains` 用的小工具）。 */
export function producerDomainsOf(
  channelId: ChannelIdLike,
  channelCapabilities: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  return channelCapabilities[channelId] ?? []
}
