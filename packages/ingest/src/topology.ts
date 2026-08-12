/**
 * 渠道数据平面的**拓扑声明** —— ODPS 式的显式形状。
 *
 * ## 用户原话
 *
 * 「我们需要接入生产者和消费者的架构，包括以后好扩展，其实要做成类似于
 *   odps 这种形式，帮我规划好架构并重构」
 *
 * ## 为什么是"声明 + 一个循环"，而不是重写那三个消费者
 *
 * 正确性相关的部分（租约抢占、从 `acked_seq` 重放、`required` 决定能不能裁
 * 历史、快通道/慢兜底按 `message_id` 去重）都是踩过坑才对的，重写等于
 * 把它们重新犯一遍。缺的不是实现，而是**这套架构在代码里没有名字**：
 * 谁是生产者、谁消费谁、谁依赖谁，散在 `ingest.service.ts` 的构造函数与
 * `runOnce()` 调用顺序里 —— 只能靠读代码推断，不能被查询、不能被展示、
 * 加一个消费者要改三处。
 *
 * 所以这一层做的是：把拓扑变成**数据**。
 *
 * · 生产者（`PRODUCERS`）：谁往 `knowledge_changelog` 投、投哪个 domain；
 * · 消费者（`CONSUMERS`）：id、`required`、依赖谁、有没有路由闸；
 * · 一个 `runCycle()` 按依赖序驱动，返回每个消费者这一轮干了什么。
 *
 * 加第四个消费者从"改三处代码"变成"往 `CONSUMERS` 加一行"。
 *
 * ## ★ 与 ODPS 的对应（用它的词，避免各叫各的）
 *
 * | ODPS | 这里 |
 * |---|---|
 * | 数据表 / 分区 | `knowledge_changelog`（seq 单调，按 domain 分） |
 * | 生产者写分区 | 采集器 `persist()` → `append()` |
 * | 订阅者 offset | `consumer_cursors.acked_seq`（带租约） |
 * | 任务依赖（DAG） | `ConsumerSpec.dependsOn` |
 * | 数据质量卡点 | `required`（落后时不许裁历史） |
 * | 路由 / 分发 | `routeToAttention`（只分身那条有） |
 *
 * ## ★★ 这个文件**不产生副作用**
 *
 * 它只描述拓扑与顺序。真正干活的仍是各自的 handler ——
 * 那样这份声明才能被测试、被界面读、被状态页展示，而不必启动一整套管线。
 */

/** changelog 里的业务域（与 `knowledge_changelog.domain` 一致）。 */
export type DataDomain = "chat" | "minutes" | "doc" | "contact"

/**
 * 生产者：往 changelog 投数据的那一侧。
 *
 * ★ 这里**只声明**，不含写入实现 —— 写入点在 `ingest.service.persist()`
 * 与各域的采集器里。声明的价值是"有哪些生产者、投什么域"这件事可查。
 */
export interface ProducerSpec {
  id: string
  /** 投哪些域 */
  domains: readonly DataDomain[]
  /**
   * 这个生产者受哪个**范围**约束。
   *
   * · `learning` —— 学习范围（`distill_sources.scope_json`，只增不减，可回溯）；
   * · `attention` —— 监听范围（`attention_scope`，只记实时流，可关掉）。
   *
   * ★ 用户原话把这两个说成"两个生产者渠道"。它们其实是同一条采集链上的
   * 两个**闸**：`learning` 决定什么进库（进而进 changelog），
   * `attention` 决定什么投给分身。分开声明是为了让"哪个范围管哪件事"
   * 不再需要读代码才知道。
   */
  scope: "learning" | "attention"
  /** 是否会回溯历史。`attention` 恒 false —— 它只管实时流。 */
  backfills: boolean
}

export const PRODUCERS: readonly ProducerSpec[] = [
  {
    id: "chat-ingest",
    domains: ["chat"],
    scope: "learning",
    backfills: true,
  },
  {
    id: "minutes-ingest",
    domains: ["minutes"],
    scope: "learning",
    backfills: true,
  },
  {
    /**
     * 分身的实时流生产者。
     *
     * ★ 它**不往 changelog 写**（消息已经由 `chat-ingest` 写过了）——
     * 它产出的是"这条消息属于分身的关心范围"这个判断，落点是
     * `attention_coverage` 的 routed/skipped 记账 + 投递给管控层。
     * 声明它是为了让「监听范围」在拓扑里可见：用户配的那个范围
     * 有一个明确的生产者在用它。
     */
    id: "attention-stream",
    domains: ["chat"],
    scope: "attention",
    backfills: false,
  },
]

/**
 * 消费者。
 *
 * ★ `id` 必须与 `consumer_cursors.consumer_id` 一致 —— 那张表是 offset 的
 * 唯一真相，声明里写错就会读到另一个消费者的进度。
 */
export interface ConsumerSpec {
  id: string
  /** 消费哪些域（`null` = 全部；FTS 就是全部） */
  domains: readonly DataDomain[] | null
  /**
   * 落后时能不能裁历史。
   *
   * `true` = 不能裁（丢了补不回来，如蒸馏语料）；
   * `false` = 可以裁（如分身：三天前没回的消息现在回也没意义）。
   */
  required: boolean
  /** 不许跑在这些消费者前面（DAG 的边） */
  dependsOn: readonly string[]
  /**
   * 有没有**路由闸** —— 只有分身那条有。
   *
   * 路由回答"这条消息属于关心范围吗"，与 `admit()`（该不该回）是两件事。
   */
  routed: boolean
  /** 一句话说明这个消费者干什么（状态页/文档直接用） */
  purpose: string
}

export const CONSUMERS: readonly ConsumerSpec[] = [
  {
    id: "local-index-fts",
    domains: null,
    required: true,
    dependsOn: [],
    routed: false,
    purpose: "全文索引：让搜索能命中",
  },
  {
    id: "graph-export",
    domains: ["chat", "minutes", "doc"],
    required: false,
    dependsOn: [],
    routed: false,
    purpose: "物化四件套喂知识图谱（外部消费者，落后可裁）",
  },
  {
    id: "distill",
    domains: ["chat"],
    required: true,
    /**
     * ★ 蒸馏引用图谱抽出的 fact —— 跑到图谱前面的话那段 fact 还不存在，
     * 而蒸馏会照常"成功"、游标照常推进，缺失**永久且静默**。
     */
    dependsOn: ["graph-export"],
    routed: false,
    purpose: "把新消息切成蒸馏窗口，产出画像语料",
  },
  {
    id: "persona-inbox",
    domains: ["chat"],
    required: false,
    dependsOn: [],
    routed: true,
    purpose: "把关心范围内的新消息投给数字分身管控层",
  },
]

/**
 * 按依赖序排出执行顺序（拓扑排序）。
 *
 * ## ★★ 为什么需要它：现在的顺序是**手写**在 `runOnce()` 调用里的
 *
 * `ingest.service.ts` 里是 `fts → distill → persona` 三行连续调用。
 * 那个顺序恰好满足依赖，但**没有任何东西保证它继续满足** ——
 * 有人调换两行、或在中间插一个新消费者，依赖就悄悄破了。
 * 而破了的表现是"蒸馏引用了还不存在的 fact"，不报错。
 *
 * 有了这个函数，顺序从"记得写对"变成"算出来的"。
 *
 * ★ 环：抛错而不是随便挑一个顺序 —— 一个成环的拓扑说明声明写错了，
 * 而静默降级成某个顺序会让那个错误在运行时以数据不一致的形式出现。
 */
export function resolveConsumerOrder(
  consumers: readonly ConsumerSpec[] = CONSUMERS,
): readonly string[] {
  const byId = new Map(consumers.map((spec) => [spec.id, spec]))
  const order: string[] = []
  const state = new Map<string, "visiting" | "done">()

  const visit = (id: string, trail: readonly string[]): void => {
    const seen = state.get(id)
    if (seen === "done") return
    if (seen === "visiting") {
      throw new Error(`消费者依赖成环：${[...trail, id].join(" → ")}`)
    }
    const spec = byId.get(id)
    /**
     * ★ 依赖一个**没声明**的消费者：跳过而不是抛。
     *
     * `graph-export` 是外部消费者（kl 服务没起时它压根不注册）。
     * 抛错会让整个循环起不来 —— 而那比"少一道依赖闸"糟得多。
     * 闸本身在 `OutboxConsumer` 里也做了同样的取舍（上游没注册就不夹）。
     */
    if (spec === undefined) return
    state.set(id, "visiting")
    for (const upstream of spec.dependsOn) visit(upstream, [...trail, id])
    state.set(id, "done")
    order.push(id)
  }

  for (const spec of consumers) visit(spec.id, [])
  return order
}

/** 这一轮某个消费者干了什么（`runCycle` 的返回项）。 */
export interface ConsumerOutcome {
  id: string
  processed: number
  skipped: number
  ackedSeq: number
  /** 没拿到租约（别的进程在消费）—— 不是错误 */
  lockedByOther: boolean
  /** 在等哪个上游（`null` = 没在等） */
  waitingForUpstream: string | null
  /** 需要全量重建（历史已被裁剪） */
  needsFullRebuild: boolean
  /** 这个消费者这一轮没跑（没注册 / 没启用） */
  absent: boolean
}

/** `runCycle` 要的最小接口 —— 只要能 `runOnce()` 就行（便于测试）。 */
export interface CycleRunnable {
  runOnce(): Promise<{
    processed: number
    skipped: number
    ackedSeq: number
    lockedByOther: boolean
    waitingForUpstream: string | null
    needsFullRebuild: boolean
  }>
}

/**
 * 按拓扑序跑一轮所有消费者。
 *
 * ★ **顺序执行**而不是并发：依赖要求下游看到上游这一轮的结果。
 * 并发跑的话 `dependsOn` 那道闸会读到上游**上一轮**的 `acked_seq`，
 * 于是每轮都慢一拍 —— 不错但没必要。
 *
 * ★ 单个消费者抛错不打断整轮：一个远程消费者限流不该让纯本地的 FTS
 * 也建不出来（`OutboxConsumer` 内部已有同样的取舍，这里是第二层）。
 */
export async function runCycle(
  runnables: ReadonlyMap<string, CycleRunnable>,
  consumers: readonly ConsumerSpec[] = CONSUMERS,
): Promise<readonly ConsumerOutcome[]> {
  const outcomes: ConsumerOutcome[] = []
  for (const id of resolveConsumerOrder(consumers)) {
    const runnable = runnables.get(id)
    if (runnable === undefined) {
      outcomes.push({
        id,
        processed: 0,
        skipped: 0,
        ackedSeq: 0,
        lockedByOther: false,
        waitingForUpstream: null,
        needsFullRebuild: false,
        absent: true,
      })
      continue
    }
    try {
      const report = await runnable.runOnce()
      outcomes.push({ id, ...report, absent: false })
    } catch {
      /**
       * 抛错记成 skipped 而不是往上抛 —— 但**不是**静默：
       * `processed: 0, skipped: 1` 与"没数据"可区分（后者两个都是 0）。
       */
      outcomes.push({
        id,
        processed: 0,
        skipped: 1,
        ackedSeq: 0,
        lockedByOther: false,
        waitingForUpstream: null,
        needsFullRebuild: false,
        absent: false,
      })
    }
  }
  return outcomes
}
