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
} from "./topology.js"
export type {
  DataDomain,
  DomainSpec,
  ProducerSpec,
  ConsumerSpec,
  ConsumerOutcome,
  CycleRunnable,
} from "./topology.js"

/**
 * 拓扑的**展示视图** —— 声明 + 游标 + 上一轮结果合成一张表。
 *
 * ★ 纯函数、不读库：`runCycle` 的返回值（含 `waitingForUpstream`）原先
 * 只进日志，这一层把它接到状态页上。见 `topology-view.ts` 文件头。
 */
export { buildConsumerStatuses, buildDomainStatuses } from "./topology-view.js"
export type { ConsumerStatus, DomainStatus, TopologyViewInput } from "./topology-view.js"
