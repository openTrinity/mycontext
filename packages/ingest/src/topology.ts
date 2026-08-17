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
 * 历史、投递按 `message_id` 去重防重放）都是踩过坑才对的，重写等于
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
  /**
   * 这个域是**可采的业务域**，还是**仅为历史兼容保留**。
   *
   * ## ★★★ 为什么它不能与 `producedBy` 合成一个字段
   *
   * 两者回答的是不同的问题，而把 `contact` 塞进 `producedBy: "absent"`
   * 已经暴露出这个混淆：
   *
   * | 字段 | 问的是 | 变了会怎样 |
   * |---|---|---|
   * | `producedBy` | **当前**有没有生产者 | 接上采集器就该变成 active |
   * | `kind` | 这个域**会不会**有采集器 | 永远不变（它是安全边界的产物） |
   *
   * `contact` 的真实状态是后者：PII 类命令按 CLAUDE.md §5 **永远不进
   * 白名单**，所以它不是"还没做"，是"不会做"。而 `absent` 的语义
   * （"当前没有"）会让界面**给它一行** —— 于是用户看到一个永远
   * "0 条、lag 0"的通讯录域，读起来像坏了。
   *
   * ★ 判据落在这里之后，界面按 `kind === "collectable"` 过滤，
   * 而 `legacy-only` 的域**只在**两个地方存在：`CHANGELOG_DOMAINS`
   * （历史库里可能真有行）与这张声明表（说清为什么保留它）。
   */
  kind: "collectable" | "legacy-only"
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
  /**
   * 哪些渠道**有能力**产这个域。`undefined` = 不限（所有渠道）。
   *
   * ## ★★★ 为什么域声明必须有 per-channel 维度
   *
   * `DOMAINS` 是**一张全局表**，而 `capabilities.domains` 是 per-channel 的：
   * 钉钉自述 `["chat","contact","doc","minutes"]`，飞书只有 `["chat","doc"]`
   * （它没有听记）。于是在一个只连了飞书的部署里，状态页会显示
   * `minutes` 域"active、0 条" —— 而事实是**这个渠道没有听记**。
   *
   * 那与 `contact` 那个已经被 `absentReason` 解决的问题**形状完全相同**，
   * 只是原因不同：一个是"我们不采"，一个是"这个渠道没有"。
   * 两者用户该做的事不同（前者什么都做不了，后者可以去连另一个渠道），
   * 所以必须能分开表达。
   *
   * ★ 这里存的是**声明侧的期望**，运行时仍要与 `capabilities.domains`
   * 对账（见 `checkTopologyConsistency` 判据⑥）—— 两者不一致说明
   * 有人加了插件却没改声明，而那种漂移不报错、只在界面上显形。
   */
  channels?: readonly ChannelIdLike[]
}

/**
 * 渠道 id（这一层只当字符串用）。
 *
 * ★ 不 import `ChannelId`（`@mycontext/channels` 的类型）：那会让这个
 * **纯声明**文件依赖渠道包，而它现在能被单测直接读、不启动任何管线，
 * 正是因为它没有依赖。判据⑥收的是调用方传进来的字符串数组，
 * 所以这里只需要一个宽类型。
 */
export type ChannelIdLike = string

export const DOMAINS: readonly DomainSpec[] = [
  { id: "chat", kind: "collectable", producedBy: "active", purpose: "聊天消息（单聊与群聊）" },
  {
    id: "minutes",
    kind: "collectable",
    producedBy: "active",
    purpose: "会议听记（摘要与转写）",
    /**
     * ★ 只有钉钉有听记能力（飞书插件的 `capabilities.domains` 是
     * `["chat","doc"]`，且它压根没有 `minutes` 契约实现）。
     * 不声明的话只连飞书的部署会显示一个"听记 0 场"，而那读起来像坏了。
     */
    channels: ["dingtalk"],
  },
  { id: "doc", kind: "collectable", producedBy: "active", purpose: "知识库文档与云盘文件" },
  {
    id: "contact",
    /**
     * ★★ `legacy-only` 而不是 `collectable` + `absent`：
     * 后者的含义是"当前没有生产者"（一个可能改变的事实），
     * 而这个域的真实状态是"永远不会有" —— PII 类命令不进白名单
     * （CLAUDE.md §5）。界面按 `kind` 过滤，所以它不会占一行。
     */
    kind: "legacy-only",
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
 * 这个渠道当前**真的能产**的域。
 *
 * ## ★★ 为什么它收 `capabilities` 而不是自己去查插件
 *
 * 这个文件必须保持"纯声明、不启动管线就能测" —— 那是它现在能被单测
 * 直接锁住 id 与顺序的全部理由。import 渠道插件会引入 CLI、进程、
 * 授权状态一整条依赖。
 *
 * 所以判据是**两个输入的交集**：
 * ① 声明说这个域该由哪些渠道产（`DomainSpec.channels`）；
 * ② 渠道自述它有哪些域（`capabilities.domains`）。
 *
 * ★ 取交集而不是只信任一侧：只信声明会漏掉"插件加了能力但没改声明"，
 * 只信 capabilities 会漏掉"我们还没写这个域的采集器"（`producedBy`）。
 * 两个方向的漂移都由判据⑥报出来，而这个函数给出的是**当前能干什么**。
 */
export function activeDomainsForChannel(
  channelId: ChannelIdLike,
  capabilities: readonly string[],
  domains: readonly DomainSpec[] = DOMAINS,
): readonly DataDomain[] {
  const declared = new Set(capabilities)
  return domains
    .filter((domain) => {
      if (domain.kind !== "collectable") return false
      if (domain.producedBy !== "active") return false
      // 声明限了渠道 → 必须包含它；没限 = 不限
      if (domain.channels !== undefined && !domain.channels.includes(channelId)) return false
      // 渠道自述里必须有这个域（它才是运行时的真相）
      return declared.has(domain.id)
    })
    .map((domain) => domain.id)
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
   * ★★★ `scope` 字段**已删**（v4 §6.3）。
   *
   * 它原来是 `"learning" | "attention"`，用来区分"这个生产者受哪个范围管"。
   * 而 `attention-stream` 从这张表摘掉之后（它是**消费者** ——
   * 输入是我们自己的表），所有生产者都受同一个**采集面**管
   * （`readCollectionRequest` = 学习范围 ∪ 监听范围），
   * 那个字段没有区分度了。
   *
   * ★ 而它的存在正是自检判据① 需要 `filter(p => p.scope === "learning")`
   * 这个特例的原因 —— **一张声明表需要跳过某几行才能自检，就是分类错了**。
   */
  /** 是否会回溯历史。`attention` 恒 false —— 它只管实时流。 */
  backfills: boolean
  /** 一句话说明它产什么（状态页/文档直接用） */
  purpose: string
  /**
   * **调度形状**。这是声明，不是策略。
   *
   * ## ★★ 为什么这件事值得进声明
   *
   * 三个域的调度天生不同，而"为什么听记没有水位"这个问题现在只能靠
   * 读三个 tick 的实现来回答：
   *
   * | 值 | 谁 | 形状 |
   * |---|---|---|
   * | `watermark` | chat | 时间窗 + 水位 + 截断二分 + 回填 + 对账 |
   * | `drain-each-round` | minutes | 每轮从 cursor=null 重新抽干 N 页 |
   * | `tiered-listing` | doc | 分档周期（冷启动/稳态）+ 正文补齐配额 |
   * | `stream` | attention | 实时流，**不写 changelog** |
   *
   * ★ 它也是 `haltsOnScopeNotReady` 的**理由**（见下）：只有 `watermark`
   * 那种会推进一个不可回退的水位的才需要那道保护。
   */
  schedule: "watermark" | "drain-each-round" | "tiered-listing" | "stream"
  /**
   * 范围没就绪时，这个生产者要不要**中断本轮并且不推进度**。
   *
   * ## ★★★ 为什么只有一个生产者需要它（而不是全都要）
   *
   * `scopeNotReady` 修的是一次真实事故：采集器比范围行先跑（实测相差
   * 1 秒），那一轮拉到的 9 条全被闸门丢掉，而**水位照常前移** ——
   * 之后 `since` 之后没有新消息，就永远不再拉。用户看到"已采集 0"，
   * 日志里一个错都没有。
   *
   * 关键在于"**水位照常前移**"这一步：它让那批消息永远回不来。
   * 而另两个域每轮从头列举（`drain-each-round` / `tiered-listing`），
   * 所以"这一轮白丢"的代价只是一轮 CLI 调用 —— 下一轮范围就绪了，
   * 同样的数据会再列一遍。
   *
   * ★ 写成声明而不是散在三个 tick 里的 if：那样"为什么听记不需要它"
   * 可查，而不必读三处实现去比对。
   */
  haltsOnScopeNotReady: boolean
}

export const PRODUCERS: readonly ProducerSpec[] = [
  {
    id: "chat-ingest",
    domains: ["chat"],
    backfills: true,
    schedule: "watermark",
    /** ★ 唯一为 true 的：只有它推进一个不可回退的水位（见上面那段 ★★★）。 */
    haltsOnScopeNotReady: true,
    purpose: "拉聊天消息，落库并发 changelog",
  },
  {
    id: "minutes-ingest",
    domains: ["minutes"],
    backfills: true,
    schedule: "drain-each-round",
    haltsOnScopeNotReady: false,
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
    backfills: true,
    schedule: "tiered-listing",
    haltsOnScopeNotReady: false,
    purpose: "拉知识库文档与云盘文件",
  },
]

/** 按 id 取生产者声明。找不到抛错 —— 拼错 id 的静默后果是拿不到调度语义。 */
export function producerSpec(
  id: string,
  producers: readonly ProducerSpec[] = PRODUCERS,
): ProducerSpec {
  const spec = producers.find((producer) => producer.id === id)
  if (spec === undefined) throw new Error(`生产者 ${id} 没有在 PRODUCERS 里声明`)
  return spec
}

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
  /**
   * 这个消费者**在这套代码里接线了吗**。
   *
   * ## ★★★ 为什么需要这个字段（它表达的是 G7 那个真实状态）
   *
   * `local-index-vector` 有完整实现（`createVectorHandler`）与 id 常量，
   * 而 **apps 侧零引用** —— 也就是"有实现、从来没跑过"。这既不是 bug
   * （embedding 是远程付费调用，接不接是产品决定），也不是待办
   * （标 planned 是一个不会兑现的承诺）。
   *
   * 不表达它的代价：它要么不在声明里（那么"我们有没有向量检索"只能靠
   * grep 回答），要么在声明里但状态页会显示一个永远 `absent` 的消费者
   * —— 而 `absent` 的含义是"这套部署没起它"（像 kl 服务没起），
   * 与"我们压根没接"是两件事。
   *
   * ★ 与 `DomainSpec.producedBy` 同一手法：让"没接"成为**声明里的
   * 一等公民**，而不是让读者去比对两个文件。
   */
  wiring: "wired" | "unwired"
  /**
   * `unwired` 时说清**为什么没接**。
   *
   * ★ 与 `purpose` 分开：前者是"它该干什么"，这是"为什么现在不干"。
   * 界面必须能显示后者 —— 否则"没接"与"接了但坏了"在用户眼里同形
   * （`DomainSpec.absentReason` 是同一条判据）。
   */
  unwiredReason?: string
}

export const CONSUMERS: readonly ConsumerSpec[] = [
  {
    id: "local-index-fts",
    domains: null,
    required: true,
    dependsOn: [],
    routed: false,
    wiring: "wired",
    purpose: "全文索引：让搜索能命中",
  },
  {
    /**
     * ★★ 有实现、**没接线**（G7）。
     *
     * `createVectorHandler` 与 `VECTOR_CONSUMER_ID` 都在
     * `local-index.ts` 里导出，而 apps 侧零引用 —— grep 全仓只有
     * `packages/ingest/src/index.ts` 的 re-export。
     *
     * 声明它（而不是不写）的理由：不写的话"我们有没有向量检索"这个问题
     * 只能靠 grep 回答；而 `wiring: "unwired"` 让状态页能把它与
     * `absent`（这套部署没起它，如 kl 服务没起）区分开 —— 后者是环境问题、
     * 前者是产品决定，用户该做的事完全不同。
     */
    id: "local-index-vector",
    domains: null,
    /**
     * ★ `required: false` —— 一个没接线的消费者**绝不能**阻塞裁剪。
     * 标 true 会让 `retainableSeq()` 把它算进"活跃必需消费者"，
     * 于是 changelog 永远裁不动（它的 acked_seq 恒 0）。
     * 而它没注册过游标，所以实际上进不了那个集合 —— 但声明必须与
     * "接上之后也不该阻塞"这个意图一致（embedding 落后是常态）。
     */
    required: false,
    dependsOn: [],
    routed: false,
    wiring: "unwired",
    unwiredReason: "向量检索要远程 embedding（按量付费），本期不默认开启",
    purpose: "向量索引：让语义检索能命中",
  },
  {
    id: "graph-export",
    domains: ["chat", "minutes", "doc"],
    required: false,
    dependsOn: [],
    routed: false,
    wiring: "wired",
    purpose: "物化四件套喂知识图谱（外部消费者，落后可裁）",
  },
  {
    /**
     * ★★★ 这一行**原来漏了**（G2），而它的水位正是仪表盘那句
     * 「图谱只消化了 X%」的分子（`dashboard-trends.service.ts` 直接按
     * 字符串 `"graph-build"` 读它）。
     *
     * 漏声明的三个后果：
     * ① 状态页拓扑卡**看不到它** —— 而它恰恰是最容易卡住的那个
     *    （建图是小时级，Phase A 会全量重跑向量化）；
     * ② `buildConsumerStatuses` 按 `CONSUMERS` 遍历，所以游标表里有行、
     *    界面上没有这一行；
     * ③ 只能靠硬编码字符串读它，而 `topology.test.ts` 那条
     *    "id 必须与真实常量一致"的门禁管不到它。
     *
     * ★ 与 `graph-export` **必须分开**两个游标：导出的语义是"数据准备到哪"
     * （1 秒），建图是"图里真的有到哪"（2 小时）。合并会让"数据准备好了"
     * 被记成"图已经建好了" —— 一个静默的谎。
     */
    id: "graph-build",
    domains: ["chat", "minutes", "doc"],
    /** 落后不该阻止裁剪：图谱要历史时重新全量导出即可（与 graph-export 同理）。 */
    required: false,
    /**
     * ★ 建图读的是**已导出**的四件套，所以不许跑在导出前面。
     * 这条边原来是**隐式**成立的（同一个 `FeedService` 顺序调用），
     * 声明它的价值是：顺序从"记得写对"变成"算出来的"，
     * 且状态页能说出「建图在等导出」而不是「建图没进展」。
     */
    dependsOn: ["graph-export"],
    routed: false,
    wiring: "wired",
    purpose: "把导出的四件套喂给 kl 建图（抽 fact / 实体 / 社群）",
  },
  {
    id: "distill",
    domains: ["chat"],
    required: true,
    /**
     * ★★★ 这里**原来是** `["graph-export"]`，而那条边贴错了消费者。
     *
     * ## 核对（这是删掉它的全部依据）
     *
     * `packages/distill/src/consumer.ts` 的 import 只有三行：
     * `@mycontext/kernel`、`@mycontext/store`（`DistillTaskRepository` +
     * `MessageRepository`）、`./runner.js`。它的 handler 做的唯一一件事是
     * **把 changelog 的 seq 映射成时间窗、enqueue 进 `distill_tasks`** ——
     * 全文**不 import 任何图谱**，不读 `knowledge.db`，不碰 fact。
     *
     * 真正读 kl 图库的是 `packages/distill/src/map/playbook-chunks.ts`
     * （只读 `chunks` 表），而它由 `DistillService.maybeInducePlaybooks()`
     * 调用 —— 那属于 **`distill-work`** 这个消费者的活。
     *
     * ## 留着它的代价（不是零）
     *
     * 平时看不出来：`graph-export` 是外部消费者，kl 服务没起时它压根不注册，
     * 此时依赖闸不生效（`consumer.ts` 的"上游没注册就不夹"）。
     * 但 kl **起着而导出慢**时（实测导出 1 秒、建图 2 小时），
     * `distill` 会白等一个它不需要的上游 —— 而它要的语料就在 `messages` 表里。
     *
     * 而更贵的那一半是**声明说了谎**：读这一行的人会以为蒸馏读图谱，
     * 于是排查"画像缺了一段"时去查图谱，而真因在别处。
     *
     * ★ 那条边真正的归属见 `distill-work` 的 `dependsOn`（下一项）。
     */
    dependsOn: [],
    routed: false,
    wiring: "wired",
    purpose: "把新消息切成蒸馏窗口，产出画像语料",
  },
  {
    /**
     * ★★ 这一行也**原来漏了**（G2）。`distill.service.ts` 里
     * `WORK_CONSUMER_ID = "distill-work"` 会真的注册游标（两处：
     * `maybeRefreshWorkLayer` 与手动 ack 那条路）。
     */
    id: "distill-work",
    domains: ["chat"],
    /**
     * `required: false` —— 它落后**不该**阻止裁剪历史。work 层抽的是长期
     * 结论，漏掉一段中间历史只会让它少几条证据；而让一个可能被用户关掉的
     * 消费者卡住整个 Outbox 的清理水位，代价是库无限增长。
     * 这与 `distill.service.ts` 里 register 时的取舍必须一致。
     */
    required: false,
    /**
     * 两个上游，各自管一件事：
     *
     * · `distill` —— work 层抽长期结论（职责、规矩），引用的是蒸馏产出。
     *   抢跑会引用还不存在的结论，而它会照常"成功"；
     * · `graph-build` ★**新增** —— playbook 归纳读 kl 的 `chunks` 表
     *   （`playbook-chunks.ts`）。建图没跑完时那张表是**旧的或空的**，
     *   于是归纳出的"工作套路"来自一份过期快照 —— 而它同样会"成功"，
     *   产出一份看起来很有底气的错误画像。
     *
     * ★★ 这条边**取代**了原来挂在 `distill` 上的 `graph-export`：
     * 那条贴错了消费者（见上一项的核对），而正确的上游也不是 export
     * 而是 **build** —— 导出完成只说明四件套是新的，`chunks` 表要等
     * `kl ingest` 跑完才更新（两者相差小时级）。
     *
     * ★ 依赖闸是"夹上界"而不是"干等"（`consumer.ts` 的既有取舍），
     * 所以慢建图只会让 work 层按图谱的节奏走，不会把它停住。
     */
    dependsOn: ["distill", "graph-build"],
    routed: false,
    wiring: "wired",
    purpose: "从蒸馏产出里抽长期结论（职责、规矩、工作套路）",
  },
  {
    id: "persona-inbox",
    domains: ["chat"],
    required: false,
    dependsOn: [],
    routed: true,
    wiring: "wired",
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
    /**
     * `consumer_cursors` 里**实际注册过**的 id（判据⑤用）。
     *
     * ★ 由调用方传而不是这一层去读库：这个文件必须保持"纯声明、不启动
     * 管线就能测"。不传 = 跳过判据⑤（纯声明自检仍然有效）。
     */
    registeredConsumerIds?: readonly string[]
    /**
     * 各渠道**自述**的域能力（判据⑥用）：`channelId → capabilities.domains`。
     *
     * ★ 同样由调用方传：这一层不能 import 渠道插件（那会引入 CLI、
     * 进程与授权状态，而这个文件的全部价值在于它没有依赖）。
     * 不传 = 跳过判据⑥。
     */
    channelDomains?: Readonly<Record<string, readonly string[]>>
  } = {},
): readonly string[] {
  const domains = input.domains ?? DOMAINS
  const producers = input.producers ?? PRODUCERS
  const consumers = input.consumers ?? CONSUMERS
  const problems: string[] = []

  /**
   * ① 标 `active` 的域必须真的有生产者。
   *
   * ## ★★★ 这里原来有一个 `filter(p => p.scope === "learning")` 特例
   *
   * 那是因为 `attention-stream` 在这张表里，而它**不写 changelog**
   * （它产的是路由判断）—— 把它算进来会让一个只有它的域看起来"有人在产"。
   *
   * 而那个特例本身就是**分类错了的信号**：一张声明表需要跳过某几行
   * 才能自检，说明它混了两种东西。`attention-stream` 已经摘掉了
   * （它是**消费者** —— 输入是我们自己的表，见 v4 §6.3），
   * 于是这张表内部同质，filter 可以删。
   */
  const written = new Set(producers.flatMap((p) => p.domains))
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
    /**
     * ★★ `legacy-only` 与 `producedBy: "active"` 是**矛盾**的组合。
     *
     * `legacy-only` 的含义是"永远不会有采集器"（安全边界），
     * 而 `active` 的含义是"现在就有生产者在投"。同时成立说明有人接了
     * 一个本该不接的域的采集器 —— 而 `contact` 那个域正是 PII
     * （CLAUDE.md §5）。这一条要能**响亮地**报出来。
     */
    if (domain.kind === "legacy-only" && domain.producedBy === "active") {
      problems.push(`域 ${domain.id} 标了 legacy-only（永不采集），却又标了 active（有生产者在投）`)
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

  /**
   * ④ `unwired` 必须说清为什么（与域的 `absentReason` 同一条判据）。
   *
   * 不说的话状态页只能显示"这个消费者没在跑"，而那与"这套部署没起它"
   * （`absent`）、"它卡住了"（stale）在用户眼里同形 —— 三者该做的事完全不同。
   */
  for (const consumer of consumers) {
    if (consumer.wiring === "unwired" && (consumer.unwiredReason ?? "") === "") {
      problems.push(`消费者 ${consumer.id} 标了 unwired 但没写 unwiredReason`)
    }
  }

  /**
   * ⑤ **库里注册过的消费者都必须在声明里**（这一条修的是 G2）。
   *
   * ## ★★★ 为什么这条判据必须存在，且必须收一个外部输入
   *
   * 把拓扑变成**数据**的代价是"漏一行不会编译失败"。而 G2 正是这么发生的：
   * `graph-build` 与 `distill-work` 都会真的往 `consumer_cursors` 注册，
   * 却都不在 `CONSUMERS` 里。后果不是报错，而是**状态页少两行** ——
   * 一个卡住的建图消费者在界面上根本不存在。
   *
   * 判据只能靠"库里实际有哪些 id"来立，而这一层**刻意不读库**
   * （它是纯声明、不启动管线就能测）。所以 id 由调用方传进来：
   * · 单测传一组已知 id（门禁）；
   * · 状态页/自检传 `ConsumerCursorRepository.list()` 的真实结果。
   *
   * ★ 反向**不报**（声明了但库里没有）：那是正常状态 —— `graph-export`
   * 在没起 kl 服务的部署里就不注册，而 `local-index-vector` 压根没接线。
   * 那两种情况分别由 `absent`（运行时）与 `wiring`（声明）表达。
   */
  for (const id of input.registeredConsumerIds ?? []) {
    if (!consumers.some((consumer) => consumer.id === id)) {
      problems.push(`游标表里有消费者 ${id}，但 CONSUMERS 里没有声明它`)
    }
  }

  /**
   * ⑥ **`DomainSpec.channels` 必须与渠道自述的能力对账**（修 G17）。
   *
   * ## ★★★ 为什么这一条不能省
   *
   * `DOMAINS` 是全局表，`capabilities.domains` 是 per-channel 的。
   * 两者漂了之后的表现**只在界面上**：
   *
   * · 声明说某个域只有钉钉能产，而飞书插件后来加了那个能力
   *   → 飞书那侧永远不显示它（用户以为功能没做）；
   * · 声明没限渠道，而某个渠道压根没有那个能力
   *   → 那个渠道显示"听记 0 场"（读起来像坏了，事实是它没有听记）。
   *
   * 两个方向都不报错，所以判据必须显式。
   *
   * ★ 只报**声明限了渠道、而那个渠道自述有这个能力**这一个方向
   *   （声明比事实更窄）。反方向（渠道没这个能力、而声明没限它）
   *   **不报** —— 那是常态：`doc` 域两个渠道都有，将来第三个渠道
   *   可能没有，而那时正确的做法是给它加 `channels` 限定，
   *   不是让自检对每一个"这个渠道恰好没有"都报一次。
   *
   * ★ `legacy-only` 的域跳过：`contact` 在钉钉的 capabilities 里确实存在
   *   （它真有通讯录接口），而我们永远不采它。那不是漂移。
   */
  for (const [channelId, capabilities] of Object.entries(input.channelDomains ?? {})) {
    const declared = new Set(capabilities)
    for (const domain of domains) {
      if (domain.kind !== "collectable") continue
      if (domain.channels === undefined) continue
      if (domain.channels.includes(channelId)) continue
      if (declared.has(domain.id)) {
        problems.push(`域 ${domain.id} 的 channels 里没有 ${channelId}，但那个渠道自述有这个能力`)
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
