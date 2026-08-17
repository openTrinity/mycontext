/**
 * 生产者骨架 —— 三个域（chat / minutes / doc）**共用**的那四件事。
 *
 * ## ★★★ 为什么需要这一层（它修的是一个真实的隐私缺口）
 *
 * 上一版把**消费者**侧做成了声明式（`PRODUCERS` / `CONSUMERS` / `runCycle`），
 * 但 `PRODUCERS` 是**纯声明** —— 注释里明写"这里只声明，不含写入实现"。
 * 于是三个域的执行各自手写在 `ingest.service.ts` 里，而其中四件事是
 * **同一件事**、有三份实现：
 *
 * ① 读这个域的范围（三态：没配过 / 显式关 / 配了值）；
 * ② 按范围过滤，并**累加一个可见的丢弃计数**；
 * ③ 落库 + 同事务发 changelog；
 * ④ 按 (分区, 天) 记覆盖面。
 *
 * 三份实现已经漂出**两个**真实缺陷（都是隐私方向）：
 *
 * · **文档那份压根没有闸** —— `runDocuments()` 第一行是 `documents.list({})`，
 *   全程不看范围（已在上一个提交修掉）；
 * · **聊天那份的时间闸被会话闸挡住了** —— `persist()` 里那段过滤整个包在
 *   `if (scope.restricted)` 里面，而 `restricted` 的语义是"设了**会话**白名单"。
 *   于是「配了 since、但没配 conversationIds」这个组合下 `since` **完全失效**。
 *
 *   ★ 那不是一个假想的组合，它是**飞书那一行的真实形状**：
 *   `DistillSourceService.syncTimeWindowToSources()` 给每个非主渠道库写
 *   `{since, until, chatKinds}` 而**刻意不带 `conversationIds`**
 *   （跨渠道复制 `cid…` 会按一批不存在的 id 过滤 → 恒零，比超采更糟）。
 *   实测（这个文件的门禁）：配 `since = 30 天前`，一条 100 天前的消息
 *   **照样落库**。
 *
 * 两个缺陷的形状相同：**判据有三份，其中一份漂了**。所以这一层做的事是
 * 把那四件事收成一份，让"忘了加闸"与"闸被别的条件挡住"在结构上不可能。
 *
 * ## ★★ 这一层**不收调度**（那是刻意的边界）
 *
 * 三个域的调度天生不同，硬合并会让最难的那段更难：
 *
 * | 域 | 调度 |
 * |---|---|
 * | chat | 水位 + 窗队列 + 截断二分 + 回填 + 对账（不变式最多） |
 * | minutes | 每轮从 cursor=null 抽干 N 页（没有水位语义） |
 * | doc | 分档周期 + 正文补齐队列（正文要二次调用） |
 *
 * 水位算错是这条链路上最贵的错误（永久漏采或永久重拉），而它的全部复杂度
 * 来自"只推已抽干的连续前缀"这个不变式。给那段代码加一个"这一趟不算水位"
 * 的分支，比留着三份范围闸危险得多。
 *
 * 所以边界画在：**拿到一批数据之后、落库之前**。调度把一批交给 runner，
 * runner 回答"哪些进了库、丢了几条、范围就绪了吗"。
 *
 * ## ★ 为什么在 `ingest` 而不是 `store`
 *
 * 它要调 `persist*`（在这个包里）与覆盖面仓储（在 store）。放 store 会让
 * store 反向依赖 ingest。而范围**判据**本身在 store（`domain-scope.ts`）——
 * 那是对的分层：判据是纯函数、被四处调用方共用；执行骨架在这里。
 */
import type { Clock, Logger } from "@mycontext/kernel"
import {
  collectsNothing,
  isOccurredAtInScope,
  isPartitionInScope,
  readDomainScope,
  toDayBucket,
  type DomainScope,
  type ScopedDomain,
  type SqliteDatabase,
} from "@mycontext/store"

/**
 * 一个域的生产者**适配器** —— 只回答"这批东西怎么取分区 / 取时间 /
 * 怎么落库 / 怎么记覆盖面"。
 *
 * ★ 泛型在 item 上：三个域的 item 类型完全不同
 * （`ParsedMessageLike` / `ParsedMinutesLike` / `ParsedDocumentLike`），
 * 而 runner 只需要从它们身上取两个标量。用 `unknown` + 回调会让调用方
 * 在闭包里写 `as`，而那会盖住真实的形状差异（CLAUDE.md §6）。
 */
export interface DomainProducer<TItem> {
  /** 这个生产者投哪个域（决定读哪一行范围 + 日志归属） */
  readonly domain: ScopedDomain
  /**
   * 从一个 item 取**分区键**（会话 / 空间的 external_id）。
   *
   * ★ 返回 `null` = 这个域不按分区切（听记就是：它是全量列举，
   * 没有"某个分区抽干了"这件事）。那时分区闸整个跳过 —— 而**不是**
   * 拿一个空串去查白名单（那会让所有听记都被判成"不在名单里"）。
   */
  partitionOf(item: TItem): string | null
  /**
   * 从一个 item 取**业务时间**（unix ms）。
   *
   * ★ 返回 `null` = 渠道没给时间。runner 对它的处置是
   * 「设了界就挡、没设界就放行」—— 见 `run()` 里那段。
   * 这里**不许**回落到 `now`：那会让每个 item 都"是今天的"，
   * 于是任何 `since` 都放行，闸门等于不存在。
   */
  occurredAtOf(item: TItem): number | null
  /**
   * 落库 + 同事务发 changelog。转发到 `persistBatch` / `persistMinutes` /
   * `persistDocuments` 之一。
   *
   * ★ runner **不自己拼** `persist*` 的入参：那三个函数的 batch 形状不同
   * （chat 要 `conversations` 做外键、另两个不要），而拼参数是各域真正
   * 不同的那部分。让 runner 去拼就要在里面按域分叉 —— 那就把刚收敛掉的
   * 东西又散开了。
   */
  persist(items: readonly TItem[]): { changed: number; unchanged: number }
  /**
   * 按 (分区, 天) 记覆盖面。不给 = 这个域这一轮不记
   * （听记没有 per-partition 覆盖面表）。
   */
  account?: ((input: CoverageAccounting) => void) | undefined
  /**
   * 记账的**语义**：这一格的数字是"新增了多少"还是"共有多少"。
   *
   * ## ★★★ 为什么这必须由域声明，而不是 runner 挑一个
   *
   * 两张覆盖面表回答的是**不同的问题**，而它们的写入语义因此相反：
   *
   * | 域 | 语义 | 为什么 |
   * |---|---|---|
   * | chat | `accumulate` | 一天的消息会跨多轮进来，覆盖会让计数在轮次之间跳回小值 |
   * | doc | `snapshot` | "这个空间这天有多少篇"是**快照量** —— 一篇文档被改十次仍然是一篇 |
   *
   * 用错方向的后果都很具体、而且都不报错：
   * · 文档用 accumulate → 改动频繁的空间篇数**虚高到几倍**；
   * · 聊天用 snapshot → 每轮把总量覆盖成"这一轮新增的那几条"。
   *
   * ★ 缺省 `accumulate`（chat / minutes 的语义），因为它是 `bumpPartition`
   * 的既有行为 —— 让新接进来的域**显式**要求 snapshot，而不是反过来。
   */
  readonly accounting?: "accumulate" | "snapshot"
}

/**
 * 覆盖面记账的一次调用。
 *
 * ★ 与 `CoverageRepositoryBase.bumpPartition` / `markDrained` 两者都同形 ——
 * 用哪一个由 `DomainProducer.accounting` 决定（见那个字段）。
 */
export interface CoverageAccounting {
  partitionId: string
  dayBucket: string
  /**
   * 这个格子的数字。
   *
   * · `accounting: "accumulate"` → **新增多少**（累加进 `local_count`）；
   * · `accounting: "snapshot"` → **共有多少**（写 `listed_total`，
   *   而 `local_count` 的真值由各自的 `rebuildFrom*` 从实体表数出来）。
   */
  delta: number
  /** 渠道说这个格子共有多少；`null` = 这一轮不知道（保留旧值） */
  listedTotal?: number | null
  drained?: boolean
}

/** 一次闸门判定的结果。 */
export interface ScopeAdmission<TItem> {
  /** 留下来的那些 */
  kept: readonly TItem[]
  /** 被丢掉的总条数 */
  dropped: number
  /** 其中因**渠道没给业务时间**被丢的条数（与"超出日期"分开记，见下） */
  droppedUnknownTime: number
}

/**
 * 「这一批里哪些在范围内」—— **唯一**一份闸门判据。
 *
 * ## ★★★ 为什么必须抽成一个函数（它修的是一个真实的隐私缺口）
 *
 * 这段判据原来有三份实现，其中一份漂了：`persist()` 里那段过滤整个包在
 * `if (scope.restricted)` 里面，而 `restricted` 的语义是"设了**会话**白名单"。
 * 于是「配了 since、但没配 conversationIds」这个组合下 `since` **完全失效**。
 *
 * ★ 那不是假想的组合，它是**飞书那一行的真实形状**：
 * `syncTimeWindowToSources()` 给每个非主渠道库写 `{since, until, chatKinds}`
 * 而**刻意不带 `conversationIds`**（跨渠道复制 `cid…` 会按一批不存在的 id
 * 过滤 → 恒零，比超采更糟）。实测：配 `since = 30 天前`，一条 100 天前的
 * 消息照样落库。
 *
 * ## ★★ 两道闸**并列**，不许一个套在另一个里面
 *
 * · 分区闸：`isPartitionInScope` 自己处理"没设白名单就放行"（内部判
 *   `restricted`）—— 所以调用方**不该**再包一层 `if (restricted)`；
 * · 时间闸：独立生效，与有没有白名单无关。
 *
 * ★ `partitionOf` 返回 `null` = 这个域不按分区切（听记是全量列举）
 * → 分区闸跳过。**不是**拿空串去查白名单（那会让所有听记都被判成
 * "不在名单里"，于是听记整个停采而日志里只有一句"丢了 N 条"）。
 */
export function admitByScope<TItem>(
  scope: DomainScope,
  items: readonly TItem[],
  accessors: {
    partitionOf: (item: TItem) => string | null
    occurredAtOf: (item: TItem) => number | null
  },
): ScopeAdmission<TItem> {
  /**
   * 用户**真的设了界**吗（决定"时间未知"怎么处置）。
   *
   * ★ `since === null`（显式不限）与 `undefined`（没配过）都算没设界 ——
   * 只有具体数字才算。
   */
  const bounded = typeof scope.since === "number" || scope.until !== undefined
  let droppedUnknownTime = 0
  const kept = items.filter((item) => {
    const partition = accessors.partitionOf(item)
    if (partition !== null && !isPartitionInScope(scope, partition)) return false

    const occurredAt = accessors.occurredAtOf(item)
    if (occurredAt === null) {
      /**
       * 渠道没给业务时间。
       *
       * 判据：**只在用户真的设了界的时候**才挡。没设界时本来全放行，
       * 此时把"时间未知"挡掉是凭空丢数据（渠道对某类数据就是不给时间，
       * 见 `ParsedDocumentLike.updatedAt` 的契约注释）。
       * 设了界时按 CLAUDE.md 第 5 节走隐私那一侧（判据不可靠时不采）。
       */
      if (!bounded) return true
      droppedUnknownTime += 1
      return false
    }
    return isOccurredAtInScope(scope, occurredAt)
  })
  return { kept, dropped: items.length - kept.length, droppedUnknownTime }
}

export interface ProducerRunResult {
  /** 真正变化的条数（下游快通道要投的就是这些） */
  changed: number
  /** 因内容一致被跳过的条数（重叠窗口下这个数会很大，正常） */
  unchanged: number
  /**
   * 因**超出用户范围**被丢弃的条数。
   *
   * ★ 必须暴露：静默丢弃是本仓库最贵的那类 bug（CLAUDE.md 第 4 节）——
   * 不记的话"闸门挡掉了 300 条"与"这段时间本来没数据"完全同形。
   */
  droppedOutOfScope: number
  /**
   * 其中因**渠道没给业务时间**而被丢的条数。
   *
   * ★ 与上一个分开记：「超出你选的日期」与「这条数据渠道没给时间」是
   * 两个事实，出路也不同（前者去改范围、后者要去看渠道解析）。
   * 合成一个数字会让后者永远查不出来。
   */
  droppedUnknownTime: number
  /**
   * 范围**还没就绪**（表里没有那一行，且这个域的缺省是"一条都不采"）。
   *
   * ## ★★★ 调用方必须据此**不推水位**
   *
   * 这是那个"飞书一条都采不到"的根因：采集器可能比范围行先跑
   * （实测日志相差 1 秒），那一轮拉到的 9 条全被丢掉，而水位照常前移
   * —— 之后 `since` 之后没有新消息，就**永远不再拉**。用户看到
   * 「已采集消息 0」，日志里一个错都没有。
   *
   * ★ 只在**整批都被丢掉**时才为 true：批里有留下来的说明范围是有效的
   * （用户就是选了个子集），那时照常推水位。
   */
  scopeNotReady: boolean
}

export interface ProducerRunnerOptions {
  db: SqliteDatabase
  clock: Clock
  channelId: string
  logger?: Logger
}

/**
 * 跑一批数据过完整的生产者链路。
 *
 * 顺序是固定的（每一步都依赖上一步的结论）：
 * ① 读范围 → ② 逐条判闸（分区 + 时间）→ ③ 落库（同事务发 changelog）
 * → ④ 记覆盖面。
 */
export class ProducerRunner {
  /**
   * **按域**累计的丢弃计数（本进程内）。
   *
   * ## ★★★ 为什么必须按域分（修 G16）
   *
   * 改动前 chat 与 doc 两条路累加进**同一对**快照字段
   * （`IngestSnapshot.scope.droppedOutOfScope`）。于是
   * 「文档被挡掉 300 篇」与「聊天被挡掉 300 条」在界面上是同一个数字 ——
   * 而两者的出路完全不同：前者去改文档的空间白名单，后者去改会话勾选。
   *
   * ★ 在 runner 里而不是让调用方各记一份：那正是"判据有多份"的形状，
   * 而这一层存在的全部理由就是消灭它。
   *
   * ★★ 进程内内存而不是落库：它回答的是"**本进程**挡掉了多少"，
   * 跨重启累加没有意义（用户会把上次运行挡掉的量误读成现在仍在漏）。
   * 与 `IngestService.droppedOutOfScope` 同一条判据。
   */
  private readonly counters = new Map<
    ScopedDomain,
    { dropped: number; unknownTime: number; tagged: number; lastAt: number | null }
  >()

  constructor(private readonly options: ProducerRunnerOptions) {}

  /**
   * 某个域本进程累计丢了多少（给快照 / `buildProducerStatuses` 用）。
   *
   * ★ 没跑过的域返回全零而不是 `undefined`：调用方要的是"这个域挡了多少"，
   * 而"还没跑过"与"跑了没挡"在那个问题上是同一个答案（0）。
   * 让它返回 undefined 会逼每个调用点写一次 `?? 0`。
   */
  countersOf(domain: ScopedDomain): {
    dropped: number
    unknownTime: number
    tagged: number
    lastAt: number | null
  } {
    return this.counters.get(domain) ?? { dropped: 0, unknownTime: 0, tagged: 0, lastAt: null }
  }

  /** 全部域的计数（快照那侧一次取完，避免逐域查）。 */
  allCounters(): ReadonlyMap<
    ScopedDomain,
    { dropped: number; unknownTime: number; tagged: number; lastAt: number | null }
  > {
    return this.counters
  }

  /**
   * 记「入库了但**不给学习侧**」的条数（`learning_eligible = 0`）。
   *
   * ## ★★★ 为什么是**新的一个数**，而不是并进 `dropped`
   *
   * v4 的设计表里写的是"把 dropped 改成打标为 0 的条数"。核对之后
   * 那个说法会**合并两个出路不同的事实**：
   *
   * | 计数 | 事实 | 用户的出路 |
   * |---|---|---|
   * | `dropped` | ★ **压根没拉** / 拉了但不入库 | 改**采集面** —— 那是隐私边界 |
   * | `tagged` | ★ **入库了**，只是学习侧看不到 | 改**学习范围** —— 数据在，随时能放宽后被学 |
   *
   * 合成一个的后果很具体：用户看到"挡了 300 条"，去查是不是漏采了 ——
   * 而那 300 条**就在库里**、分身也在用它们。那是把一个正常状态报成事故。
   *
   * 反过来也一样：真的漏采（渠道没给时间、范围没就绪）会被这个正常值
   * 淹掉 —— 而那才是要救的那一类。
   */
  noteTaggedIneligible(domain: ScopedDomain, count: number): void {
    if (count <= 0) return
    const current = this.countersOf(domain)
    this.counters.set(domain, { ...current, tagged: current.tagged + count })
  }

  /**
   * 清零。
   *
   * ★ 用户改了范围时必须清：那个数字回答的是"**当前范围下**挡掉了多少"，
   * 跨范围累加会让用户把改范围之前挡掉的量误读成新范围仍在漏
   * （`IngestService.applyScopeChange` 里对那两个字段做的是同一件事）。
   */
  resetCounters(): void {
    this.counters.clear()
  }

  /** 记一次丢弃进按域计数（`noteDropped` 里调，与日志同一处）。 */
  private bumpCounters(domain: ScopedDomain, dropped: number, unknownTime: number): void {
    const current = this.countersOf(domain)
    this.counters.set(domain, {
      ...current,
      dropped: current.dropped + dropped,
      unknownTime: current.unknownTime + unknownTime,
      lastAt: this.options.clock.now(),
    })
  }

  /**
   * 跑一批。
   *
   * @param producer 这个域的适配器
   * @param items 渠道这一轮给的一批
   * @param options.listedTotals 每个 (分区, 天) 渠道说共有多少
   *   —— 只有走"列举"的域有这个信息（文档）。
   * @param options.drained 这一轮这些格子抽干了吗（截断了就是没抽干）。
   */
  run<TItem>(
    producer: DomainProducer<TItem>,
    items: readonly TItem[],
    options: { drained?: boolean } = {},
  ): ProducerRunResult {
    const scope = readDomainScope(this.options.db, producer.domain)

    /**
     * ★★ 「这个域现在一条都不该采」→ 整批丢弃 + 报 `scopeNotReady`。
     *
     * 判据走 `collectsNothing`（store 里那个共用函数），而**不是**
     * `scope.restricted && scope.allow.size === 0` 写在这里 ——
     * 那个表达式有两个条件与一个隐含前提，抄错一次的方向是超范围采集。
     *
     * ★ 空批（`items.length === 0`）时**不报** `scopeNotReady`：
     * 那一轮本来就没东西可丢，报了会让调用方误以为"范围没就绪"而
     * 停止推水位 —— 于是一个安静的频道永远推不动水位（活锁）。
     */
    if (collectsNothing(scope)) {
      if (items.length > 0) {
        this.noteDropped(producer.domain, items.length, 0, scope)
      }
      return {
        changed: 0,
        unchanged: 0,
        droppedOutOfScope: items.length,
        droppedUnknownTime: 0,
        scopeNotReady: items.length > 0,
      }
    }

    /**
     * ★★★ 闸门判据走 `admitByScope` —— 那是**唯一**一份实现。
     *
     * 不在这里内联是刻意的：`persist()`（chat 那条路）也要用同一段判据，
     * 而它的调度（水位/窗队列）不适合整段搬进 runner。两处各写一遍就是
     * 把刚收敛掉的东西再散一次 —— 而已经漂过两次了（文档那条没有闸、
     * 聊天那条的时间闸被会话闸挡住）。
     */
    const admitted = admitByScope(scope, items, {
      partitionOf: (item) => producer.partitionOf(item),
      occurredAtOf: (item) => producer.occurredAtOf(item),
    })
    const kept = admitted.kept
    const droppedUnknownTime = admitted.droppedUnknownTime

    const dropped = items.length - kept.length
    if (dropped > 0) {
      this.noteDropped(producer.domain, dropped, droppedUnknownTime, scope)
    }

    /**
     * ★ 整批都被丢掉时**不落库**，但也**不报** `scopeNotReady`。
     *
     * 两者的区别：`collectsNothing`（上面那个分支）说明范围**还没配好**
     * ——那时水位不能推。而走到这里说明范围是**有效**的，只是这一批
     * 恰好全部越界（用户就是选了个子集）——那时照常推水位，
     * 否则一个"只勾了 1 个群"的用户会因为别的群的消息而永远推不动水位。
     */
    if (kept.length === 0) {
      return {
        changed: 0,
        unchanged: 0,
        droppedOutOfScope: dropped,
        droppedUnknownTime,
        scopeNotReady: false,
      }
    }

    const persisted = producer.persist(kept)

    /**
     * ★ 覆盖面记账**在落库之后**，且只记**留下来的**那些。
     *
     * 记范围外的会让覆盖面与实体表永久对不上：`listedTotal` 说这天有
     * 300 条、库里只有 20 条（其余被闸门挡了），界面于是显示
     * "还差 280 条没采到" —— 而那 280 条是用户明确不要的。
     * 一个永远追不平的进度比没有进度更糟。
     *
     * ★ 记账失败**不许**影响采集：它是派生物（观测量），采集是正事。
     * 但也不静默 —— 吞掉异常并记日志，让"覆盖面为 0"与"记账挂了"可区分。
     */
    const account = producer.account
    if (account !== undefined) {
      try {
        for (const [key, delta] of this.byPartitionDay(producer, kept)) {
          /**
           * ★ 分隔符用 ` `：分区 id 是渠道给的字符串，可能含任何
           * 可打印字符。用冒号或空格的话 `split` 会把 id 切成两半 ——
           * 于是 `dayBucket` 拿到 id 的后半段，这一天的数据被记到一个
           * 不存在的日期上，而两个数字都会「看起来对」。
           */
          const [partitionId, dayBucket] = key.split(" ")
          if (partitionId === undefined || dayBucket === undefined) continue
          account({
            partitionId,
            dayBucket,
            delta,
            /**
             * ★★★ `snapshot` 语义要把这一格的数字也放进 `listedTotal`。
             *
             * 两张覆盖面表的写入语义相反（见 `DomainProducer.accounting`）：
             * · accumulate（chat）→ `delta` 累加进 `local_count`；
             * · snapshot（doc）→ 这一格"共有多少"，而 `local_count` 的真值
             *   由 `rebuildFromDocuments` 从实体表数出来，这个数字进
             *   `listed_total`（"渠道说有多少"）。
             *
             * 不给的话文档那条路会丢掉 `listedTotal` —— 而那是"这天齐没齐"
             * 唯一的外部参照（`drained=false` 时 `local_count` 只是下界）。
             */
            ...(producer.accounting === "snapshot" ? { listedTotal: delta } : {}),
            ...(options.drained === undefined ? {} : { drained: options.drained }),
          })
        }
      } catch (error) {
        this.options.logger?.warn("coverage accounting failed", {
          channelId: this.options.channelId,
          domain: producer.domain,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      changed: persisted.changed,
      unchanged: persisted.unchanged,
      droppedOutOfScope: dropped,
      droppedUnknownTime,
      scopeNotReady: false,
    }
  }

  /**
   * 把一批按 (分区, 天) 分组计数。
   *
   * ★ 分桶用**业务时间**，与 changelog 的 `occurredAt` 同一个判据 ——
   * 两处漂了的话「闸门放行的」与「覆盖面记账的」会落在不同的日期上，
   * 而两边的数字都"看起来对"。
   *
   * ★ 时间为 null 的（只有"没设界"时才会走到这里）归到**今天**：
   * 覆盖面必须给一个具体的天，而库里那一行的 `fetched_at` 就是 now。
   */
  private byPartitionDay<TItem>(
    producer: DomainProducer<TItem>,
    items: readonly TItem[],
  ): Map<string, number> {
    const now = this.options.clock.now()
    const counts = new Map<string, number>()
    for (const item of items) {
      const partition = producer.partitionOf(item)
      if (partition === null) continue
      const key = `${partition} ${toDayBucket(producer.occurredAtOf(item) ?? now)}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }

  /**
   * 记一次丢弃 —— **给不整段走 runner 的那条路**（聊天）用的公开入口。
   *
   * ## ★★★ 为什么它必须存在
   *
   * 聊天那条路刻意不整段走 runner：它推进一个不可回退的水位
   * （`commitProgress` / `confirmedEnd` / `splitIfTruncated` 那套不变式），
   * 而水位算错是这条链路上最贵的错误。
   *
   * 但"丢了多少"这件事必须与另两条路进**同一个**按域计数器 ——
   * 否则 `buildProducerStatuses` 里 chat 那一行永远是 0，而它恰恰是
   * 量级最大的那个域（实测越界过 46,415 条）。
   *
   * ★ 也就是：runner 在那条路上只承担**记账**，不承担调度与落库。
   * 那个边界写在 `PRODUCERS` 的 `schedule: "watermark"` 上。
   */
  noteDroppedFor(
    domain: ScopedDomain,
    dropped: number,
    unknownTime: number,
    scope: DomainScope,
  ): void {
    this.noteDropped(domain, dropped, unknownTime, scope)
  }

  /**
   * 记一次丢弃。
   *
   * ★ 日志**必须带渠道**：这条说的是「丢了 N 条数据」，而多渠道下不带渠道
   * 就没法回答"谁丢的" —— 实测排查时撞到过（钉钉与飞书两路同时在跑，
   * 只能靠时间戳猜是哪一路，猜错方向白查一轮）。
   * 丢数据的日志不带来源，等于知道出血却不知道伤口在哪。
   */
  private noteDropped(
    domain: ScopedDomain,
    dropped: number,
    unknownTime: number,
    scope: DomainScope,
  ): void {
    // ★ 计数与日志在**同一处**：分开会出现"日志记了、计数没记"的漂移
    this.bumpCounters(domain, dropped, unknownTime)
    this.options.logger?.info("producer dropped out-of-scope items", {
      channelId: this.options.channelId,
      domain,
      dropped,
      // ★ 单独报：它与"超出日期"的出路不同（见 `droppedUnknownTime`）
      droppedUnknownTime: unknownTime,
      /**
       * ★ 把"为什么丢"也说出来：`restricted` + `allowed: 0` 才是
       * 「白名单是空的，一条都不许过」，而 `restricted: false` 时丢弃
       * 只可能来自时间窗。两者的处置完全不同。
       */
      restricted: scope.restricted,
      allowed: scope.restricted ? scope.allow.size : null,
      since: scope.since,
      until: scope.until,
    })
  }
}
