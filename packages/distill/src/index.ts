export {
  assertDistillable,
  filterDistillable,
  assertHasEvidence,
  normalizeScopeRef,
  DISTILL_REJECT_REASONS,
} from "./guards.js"
export type { DistillVerdict, DistillRejectReason, FacetCandidate } from "./guards.js"

export { computeRoutines, routineCandidates, percentile } from "./map/stats.js"
export type { RoutineStats, StatsOptions } from "./map/stats.js"

export {
  mapFacetWithLlm,
  parseFacetItems,
  resolveEvidence,
  renderMessageBlock,
  LLM_FACETS,
  DEFAULT_BATCH_SIZE,
} from "./map/llm-map.js"
export type { LlmFacet, MapLlmOptions, MapLlmResult } from "./map/llm-map.js"

export { createDistillHandler, DISTILL_CONSUMER_ID } from "./consumer.js"
export type { DistillHandlerOptions } from "./consumer.js"

export { DistillRunner, ALL_FACETS, STAT_FACET } from "./runner.js"
export type { DistillRunnerOptions, PlanInput, TaskRunResult } from "./runner.js"

export { mergeFacet, classifyRelation, isNumericFacet } from "./reduce/merger.js"
export type { FacetRow, MergeResult, MergeRelation } from "./reduce/merger.js"

/**
 * Materializer 只剩入口文件。
 *
 * `materializeAll` / `renderProfile` / `renderExpertise` / `renderSpec` /
 * `renderRules` 已删：画像整体由 forge 产出（`persona-persona/` 那个包），
 * 那五个渲染器把 `profile_facets` 铺成 `knowledge/*.md`，而**没有任何读者**
 * —— persona 的 workspace 只装 forge 的产物。留着的代价不是几百行代码，
 * 而是"随手把它接回去"会立刻造出两个真源：同一件事（这个人怎么说话）
 * 由 LLM 抽的结论与 forge 测的数字各说一遍，而模型会同时读到两份。
 */
export { renderEntry, AGENT_ENTRY_FILENAME } from "./materializer/render.js"
export type { MaterializedFile, RenderContext } from "./materializer/render.js"
