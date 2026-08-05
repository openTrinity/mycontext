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
