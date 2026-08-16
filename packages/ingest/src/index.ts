export {
  normalize,
  newId,
  sha256,
  toChangelogEntry,
  toMinutesChangelogEntry,
  toDocumentChangelogEntry,
} from "./normalizer.js"
export type { NormalizeInput, NormalizedBatch } from "./normalizer.js"

export { persistBatch, persistMinutes, persistDocuments } from "./outbox.js"
export type { PersistResult, PersistMinutesResult, PersistDeps } from "./outbox.js"

export {
  IngestScheduler,
  AdaptiveInterval,
  WINDOW_OVERLAP_MS,
  WINDOW_LOOKAHEAD_MS,
  INITIAL_BACKFILL_MS,
  MIN_WINDOW_MS,
} from "./scheduler.js"
export type {
  ChangeHint,
  ProbeResult,
  PullWindow,
  PullPageResult,
  SchedulerOptions,
} from "./scheduler.js"

export { OutboxConsumer } from "./consumer.js"
export type {
  ConsumerHandler,
  ConsumerHandlerResult,
  OutboxConsumerOptions,
  ConsumeReport,
} from "./consumer.js"

export {
  createFtsHandler,
  createVectorHandler,
  FTS_CONSUMER_ID,
  VECTOR_CONSUMER_ID,
} from "./local-index.js"
export type { Embedder, VectorHandlerOptions } from "./local-index.js"

/**
 * 数据平面的**拓扑声明**（ODPS 式的显式形状）。
 *
 * 生产者/消费者/域/依赖/路由从"散在构造函数与调用顺序里"变成可查询的数据；
 * `runCycle` 按依赖序驱动。见 `topology.ts` 文件头。
 *
 * ★ `checkTopologyConsistency` 是这套声明的**自检** —— 把拓扑变成数据的
 * 代价是"漏一行不会编译失败"，而它已经真的漏过（`doc-ingest` 没声明）。
 */
export {
  DOMAINS,
  PRODUCERS,
  CONSUMERS,
  activeDomains,
  checkTopologyConsistency,
  resolveConsumerOrder,
  runCycle,
  activeDomainsForChannel,
  producerSpec,
} from "./topology.js"
export type {
  DataDomain,
  DomainSpec,
  ProducerSpec,
  ConsumerSpec,
  ConsumerOutcome,
  CycleRunnable,
  ChannelIdLike,
} from "./topology.js"

/**
 * 拓扑的**展示视图** —— 声明 + 游标 + 上一轮结果合成一张表。
 *
 * ★ 纯函数、不读库：`runCycle` 的返回值（含 `waitingForUpstream`）原先
 * 只进日志，这一层把它接到状态页上。见 `topology-view.ts` 文件头。
 */
export { buildConsumerStatuses, buildDomainStatuses } from "./topology-view.js"
export type { ConsumerStatus, DomainStatus, TopologyViewInput } from "./topology-view.js"

/**
 * 生产者的**运行时视图** —— 补上消费者侧早就有、生产者侧一直没有的那张表。
 *
 * ★ 它修的是"谁丢的数据"这个问题读不出来：chat 与 doc 两条路原来累加进
 * 同一对快照字段，于是「文档挡掉 300 篇」与「聊天挡掉 300 条」同形。
 * 见 `producer-view.ts` 文件头。
 */
export { buildProducerStatuses, producerDomainsOf } from "./producer-view.js"
export type {
  ProducerStatus,
  ProducerViewInput,
  ProducerCounters,
  ProducerScopeState,
} from "./producer-view.js"

/**
 * 生产者骨架 —— 三个域共用的四件事（范围闸 / 丢弃计数 / 落库 / 覆盖面记账）。
 *
 * ★ 它修的是两个真实的隐私缺口：文档那条路压根没有闸，
 * 而聊天那条路的时间闸被会话闸挡住了（`if (scope.restricted)` 套在外面）。
 * 见 `producer.ts` 文件头。
 */
export { ProducerRunner, admitByScope } from "./producer.js"
export type {
  DomainProducer,
  ProducerRunResult,
  CoverageAccounting,
  ScopeAdmission,
} from "./producer.js"
