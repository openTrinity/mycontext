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
 * 一个域的声明。
 *
 * ## ★★★ 为什么必须有 `producedBy`（这修的是一个真实的声明/事实不一致）
 *
 * `CHANGELOG_DOMAINS` 里有四个域，而 `normalizer.ts` 只产三个：
 * `chat`（:218）、`minutes`（:253）、`doc`（:289）。**`contact` 没有任何
 * 生产者往它投**。
 *
 * 这个不一致本身不会报错 —— 它的后果在**界面**上：拓扑视图/状态页按声明
 * 画，就会永久显示一个"contact 域，0 条，lag 0"。而用户读到的是
 * "通讯录数据采到了 0 条"（像是坏了），事实是"我们压根没做这一路"。
 * 这正是 `DistillSourceView.status: "planned"` 那个字段存在的理由 ——
 * 同一个问题，已经有了正确的表达方式：**说清是"没做"还是"做了没数据"**。
 *
 * ## ★★ 为什么不干脆把 `contact` 从类型里删掉
 *
 * 删不掉，而且不该删：
 *
 * ① `knowledge_changelog.domain` 是 TEXT 列，历史库里**可能**已经有
 *    `contact` 行（`ChangelogRepository.domainHeads()` 对四个域各查一次）。
 *    从类型里摘掉会让读回的行变成一个类型上不存在的值 —— 而那种
 *    "类型说不可能、数据里真有"的分歧只能靠 `as` 掩盖（CLAUDE.md §6）；
 * ② `ChannelPlugin.capabilities.domains` 里钉钉自述了 `contact`
 *    （`plugins/dingtalk/index.ts:42`）—— 那是**渠道能力**（它确实有通讯录
 *    接口），与"我们有没有采集器"是两件事。两者都对，不能互相覆盖。
 *
 * 所以正确做法是让"有没有生产者"成为**声明里的一等公民**，
 * 而不是让读者去比对两个文件。
 *
 * ## ★ 而 `contact` 的生产者短期内做不出来（这一点要写在这里，不是别处）
 *
 * PII 类命令（花名册、手机号反查、离职名单）按 CLAUDE.md §5 **不进
 * 渠道命令白名单**。所以 `contact` 不是"排期问题"，是"边界问题" ——
 * 把它标成 `planned` 反而是一个不会兑现的承诺。用 `absent` 表达
 * "声明保留（历史数据/渠道能力都提到它），但我们不产"。
 */
export interface DomainSpec {
  id: DataDomain
  /** 这个域**当前有没有生产者**。见上面那段 ★★★。 */
  producedBy: "active" | "absent"
  /** 一句话说明这个域装什么（状态页/文档直接用） */
  purpose: string
  /**
   * `absent` 时说清**为什么没有**。
   *
   * ★ 与 `purpose` 分开：前者是"它是什么"，这是"为什么现在是空的"。
   * 界面必须能显示后者 —— 否则"没做"与"做了没数据"在用户眼里同形。
   */
  absentReason?: string
}

export const DOMAINS: readonly DomainSpec[] = [
  { id: "chat", producedBy: "active", purpose: "聊天消息（单聊与群聊）" },
  { id: "minutes", producedBy: "active", purpose: "会议听记（摘要与转写）" },
  { id: "doc", producedBy: "active", purpose: "知识库文档与云盘文件" },
  {
    id: "contact",
    producedBy: "absent",
    purpose: "通讯录与组织关系",
    /**
     * ★ 措辞刻意不是"暂未实现"：那读起来像排期。真实原因是安全边界 ——
     * 通讯录类命令属于 PII，不进白名单（CLAUDE.md §5）。
     */
    absentReason: "通讯录属 PII，相关渠道命令不在白名单内，没有采集器",
  },
]

/** 当前**真的有生产者**的域。消费者的 `domains` 与界面都该按它过滤。 */
export function activeDomains(domains: readonly DomainSpec[] = DOMAINS): readonly DataDomain[] {
  return domains.filter((domain) => domain.producedBy === "active").map((domain) => domain.id)
}

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
  /** 一句话说明它产什么（状态页/文档直接用） */
  purpose: string
}

export const PRODUCERS: readonly ProducerSpec[] = [
  {
    id: "chat-ingest",
    domains: ["chat"],
    scope: "learning",
    backfills: true,
    purpose: "拉聊天消息，落库并发 changelog",
  },
  {
    id: "minutes-ingest",
    domains: ["minutes"],
    scope: "learning",
    backfills: true,
    purpose: "拉会议听记（摘要 + 转写）",
  },
  {
    /**
     * ★★ 这个生产者**原来漏声明了**。
     *
     * `normalizer.ts:289` 的 `toDocumentChangelogEntry` 确实在产 `doc` 域，
     * `persistDocuments()` 也确实在写 —— 但 `PRODUCERS` 里没有它。
     * 后果是拓扑视图会显示"doc 域有数据、但没有任何生产者" ——
     * 一个自相矛盾的画面，而声明本身不会报错。
     *
     * 这正是"把拓扑变成数据"这件事的代价：数据漏了一行不会像代码那样
     * 编译失败。所以下面 `assertTopologyConsistent()` 把它变成可检查的。
     */
    id: "doc-ingest",
    domains: ["doc"],
    scope: "learning",
    backfills: true,
    purpose: "拉知识库文档与云盘文件",
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
     *
     * ★★ 判据实现在 `AttentionRouter`（store 层），而**不是**在某个调用点
     * —— 它被快通道与慢兜底两条投递路共用。改动前路由只在快通道上，
     * 慢兜底整条绕过监听范围（见 `deliverMessage` 的注释）。
     */
    id: "attention-stream",
    domains: ["chat"],
    scope: "attention",
    backfills: false,
    purpose: "按监听范围把新消息路由给数字分身管控层",
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
 * 拓扑声明的**自检** —— 让"声明漏一行"变成可检查的。
 *
 * ## ★★★ 为什么必须有这个函数
 *
 * 把拓扑变成**数据**的代价是：数据错了不会像代码那样编译失败。
 * 已经真的发生过两次：
 *
 * ① `PRODUCERS` 漏了 `doc-ingest` —— 而 `normalizer.ts:289` 一直在产
 *    `doc` 域。拓扑视图会画出"这个域有数据、但没有生产者"；
 * ② `contact` 域没有任何生产者 —— 视图会画出一个永远空的域，
 *    读起来像"通讯录采到了 0 条"（像坏了），而事实是"我们不采"。
 *
 * 两个错误都不报错、都只在界面上显形，而界面上显形时已经在用户眼前了。
 *
 * ## ★ 返回问题列表而不是抛错
 *
 * 调用方是单测（门禁）与状态页。抛错会让状态页在一个**声明**问题上
 * 整页打不开 —— 而那比"少一条自检"糟得多。让它返回人话描述，
 * 单测断言为空，状态页需要时可以显示。
 *
 * ★ 三条判据都是"两个声明之间的一致性"，不去读 `normalizer.ts`：
 * 那样就要么用正则扫源码（脆），要么把 normalizer import 进来（循环）。
 * 判据落在"`DOMAINS` 里标 active 的域，必须有生产者投它"这一条上 ——
 * 而 normalizer 加了新域却忘了改 `DOMAINS` 时，`CHANGELOG_DOMAINS`
 * 那侧的类型会先拦住（两者共用 `DataDomain`）。
 */
export function checkTopologyConsistency(
  input: {
    domains?: readonly DomainSpec[]
    producers?: readonly ProducerSpec[]
    consumers?: readonly ConsumerSpec[]
  } = {},
): readonly string[] {
  const domains = input.domains ?? DOMAINS
  const producers = input.producers ?? PRODUCERS
  const consumers = input.consumers ?? CONSUMERS
  const problems: string[] = []

  /**
   * ① 标 `active` 的域必须真的有生产者。
   *
   * ★ 只数**写 changelog** 的生产者：`attention-stream` 不写
   * （它产的是路由判断），把它算进来会让一个只有 attention 生产者的域
   * 看起来"有人在产"，而 changelog 里其实永远是空的。
   */
  const written = new Set(producers.filter((p) => p.scope === "learning").flatMap((p) => p.domains))
  for (const domain of domains) {
    if (domain.producedBy === "active" && !written.has(domain.id)) {
      problems.push(`域 ${domain.id} 标了 active，但没有任何生产者往它投`)
    }
    if (domain.producedBy === "absent" && written.has(domain.id)) {
      problems.push(`域 ${domain.id} 标了 absent，但 ${[...written].join("/")} 里有生产者在投它`)
    }
    // absent 必须说清为什么 —— 否则界面只能显示"空"，与"坏了"同形
    if (domain.producedBy === "absent" && (domain.absentReason ?? "") === "") {
      problems.push(`域 ${domain.id} 标了 absent 但没写 absentReason`)
    }
  }

  /** ② 生产者投的域必须在 `DOMAINS` 里声明过（拼错一个字不会报错）。 */
  const declared = new Set(domains.map((domain) => domain.id))
  for (const producer of producers) {
    for (const domain of producer.domains) {
      if (!declared.has(domain)) {
        problems.push(`生产者 ${producer.id} 投了未声明的域 ${domain}`)
      }
    }
  }

  /**
   * ③ 消费者声明的域里不该有 `absent` 的。
   *
   * `domains: null` = 消费全部（FTS 就是），跳过 —— 它按 changelog 里
   * 实际有什么来消费，声明一个空域对它没有代价。
   */
  const absent = new Set(
    domains.filter((domain) => domain.producedBy === "absent").map((domain) => domain.id),
  )
  for (const consumer of consumers) {
    for (const domain of consumer.domains ?? []) {
      if (absent.has(domain)) {
        problems.push(`消费者 ${consumer.id} 声明消费 ${domain}，但那个域没有生产者`)
      }
    }
  }

  return problems
}

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
