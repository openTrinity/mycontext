export {
  assertDistillable,
  filterDistillable,
  assertHasEvidence,
  assertDeidentified,
  assertSelfAttributed,
  normalizeScopeRef,
  DISTILL_REJECT_REASONS,
} from "./guards.js"
export type {
  DistillVerdict,
  DistillRejectReason,
  FacetCandidate,
  DeidentifyRules,
  DeidentifyVerdict,
  SelfAttributionVerdict,
  EvidenceAuthorship,
} from "./guards.js"

export { computeRoutines, routineCandidates, percentile } from "./map/stats.js"
export type { RoutineStats, StatsOptions } from "./map/stats.js"

export {
  mapFacetWithLlm,
  parseFacetItems,
  resolveEvidence,
  renderMessageBlock,
  renderWorkBlock,
  LLM_FACETS,
  DEFAULT_BATCH_SIZE,
  FACET_TIMEOUT_MS,
} from "./map/llm-map.js"
export type { LlmFacet, MapLlmOptions, MapLlmResult } from "./map/llm-map.js"

/**
 * work 层的第二类语料：文档与纪要。
 *
 * 单独导出（而不是只在 runner 内部用）是为了让「文档不带作者」这件事可测：
 * `authorship` 恒为 `unknown`，而那是这一层唯一的安全前提。
 */
export { readWorkCorpus } from "./map/work-corpus.js"
export type { WorkCorpusItem } from "./map/work-corpus.js"

export { createDistillHandler, DISTILL_CONSUMER_ID } from "./consumer.js"
export type { DistillHandlerOptions } from "./consumer.js"

export { DistillRunner, ALL_FACETS, STAT_FACET } from "./runner.js"
export type { DistillRunnerOptions, PlanInput, TaskRunResult } from "./runner.js"

export { mergeFacet, classifyRelation, isNumericFacet } from "./reduce/merger.js"
export type { FacetRow, MergeResult, MergeRelation } from "./reduce/merger.js"

/**
 * 去重与稳定 key。
 *
 * 导出是为了让「同一件事必须落到同一行」这件事可测：`mergeFacet` 的三态
 * 只有在 key 稳定时才会被调到，而实测它原来**从未被调到**
 * （260/273 条停在 revision=1）—— 见 `reduce/dedupe.ts` 文件头。
 */
export { facetKey, candidateKey, findSimilar, similarity, overlap } from "./reduce/dedupe.js"
export type { ExistingFacet } from "./reduce/dedupe.js"

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

/**
 * work 层的产物渲染。
 *
 * 与上面那五个被删掉的渲染器不同，这个**有读者**：它写进 forge 的 skill 包
 * （`references/work.md`，已在 forge 配置的 `externalSkillFiles` 里登记，
 * 所以 publish 不会删、lock 不会锁），而 persona 的 workspace 装的就是那个包。
 */
export { renderWorkLayer } from "./materializer/work.js"
export type { WorkLayerResult, WorkPlaybookSection } from "./materializer/work.js"

/**
 * playbook：从 kl-graph 的 chunk 归纳「阶段序列」。
 *
 * ★ 这是 work 层与 kl-graph 的**分工落点**：切分/实体/时序归他们
 * （他们按 3 小时静默切好了 session），归纳归我们。
 * 见 `map/playbook.ts` 文件头的边界说明与通用性约束。
 */
export {
  inducePlaybooks,
  selectSources,
  processScore,
  validatePlaybook,
  resolvePlaybookEvidence,
  PLAYBOOK_BATCH_SIZE,
  PLAYBOOK_MAX_BATCHES,
  PLAYBOOK_SUGGESTED_TIMEOUT_MS,
} from "./map/playbook.js"
export type { Playbook, PlaybookStage, PlaybookSource, PlaybookResult } from "./map/playbook.js"
export { readPlaybookChunks } from "./map/playbook-chunks.js"

/**
 * work 层的攒批判据。
 *
 * 与 forge 分开定时是必须的：forge 免费（零模型调用），work 层每轮几万 token。
 * 挂同一个 6 小时定时器等于每天 4 次为同一批老语料付钱 —— 那正是 LLM 那半
 * 当年被关掉的原因。
 */
export {
  decideWorkRefresh,
  workBackoffMs,
  WORK_LAG_THRESHOLD,
  WORK_MAX_AGE_MS,
  WORK_BACKOFF_MS,
} from "./work-refresh.js"
export type {
  WorkRefreshInput,
  WorkRefreshDecision,
  WorkRefreshSkipReason,
  WorkRefreshTriggerReason,
} from "./work-refresh.js"
