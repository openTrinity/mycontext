export { FeedServer } from "./server.js"
export type { FeedServerOptions } from "./server.js"

export { ExportMaterializer } from "./export-materializer.js"
export type {
  ExportedMessage,
  ExportResult,
  ExportOptions,
  ExportSourceCounts,
} from "./export-materializer.js"

export { GraphSyncService, GRAPH_SYNC_CONSUMER_ID, GRAPH_BUILD_CONSUMER_ID } from "./graph-sync.js"
export type { GraphSyncOptions, GraphSyncResult } from "./graph-sync.js"

export {
  decideAutoBuild,
  forecastAutoBuild,
  autoBuildBackoffMs,
  AUTO_BUILD_LAG_THRESHOLD,
  AUTO_BUILD_MAX_AGE_MS,
  AUTO_BUILD_MIN_INTERVAL_MS,
  AUTO_BUILD_BACKOFF_MS,
} from "./auto-build.js"
export type {
  AutoBuildInput,
  AutoBuildDecision,
  AutoBuildSkipReason,
  AutoBuildTriggerReason,
} from "./auto-build.js"

export { buildHandoffManifest, writeHandoffManifest } from "./handoff.js"
export type { HandoffManifest, BuildHandoffInput } from "./handoff.js"
