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
 * 生产者/消费者/依赖/路由从"散在构造函数与调用顺序里"变成可查询的数据；
 * `runCycle` 按依赖序驱动。见 `topology.ts` 文件头。
 */
export { PRODUCERS, CONSUMERS, resolveConsumerOrder, runCycle } from "./topology.js"
export type {
  DataDomain,
  ProducerSpec,
  ConsumerSpec,
  ConsumerOutcome,
  CycleRunnable,
} from "./topology.js"
