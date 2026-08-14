# Evaluation TODO

Updated: 2026-08-12

This file tracks evaluation correctness, reproducibility, comparability, and
runner-maintenance work. Production retrieval/ingestion changes are listed only
when the evaluation module needs an experiment or diagnostic for them.

## P0 — Correctness before new experiments

### 1. Resolve Fact evidence through `source_unit_id`

- [x] In LoCoMo evidence scoring, resolve a Fact to `facts.source_unit_id` when
  it is present.
- [x] Expand all `chunk.metadata.member_message_ids` only for Chunk/Message
  hits, or as a legacy fallback for Facts without `source_unit_id`.
- [x] Avoid ambiguous `facts.id LIKE '<prefix>%' LIMIT 1` resolution: prefer an
  exact ID and fail on an ambiguous prefix.
- [x] Preserve both the cited Fact ID and resolved source unit in scored rows.
- [x] Report both metrics during the transition:
  - strict source-unit evidence recall;
  - legacy chunk-expanded evidence recall.
- [ ] Re-score existing LoCoMo Ask artifacts after the fix; rebuilding and
  re-running Ask should not be necessary.

Why it mattered: the former Fact → source chunk → all member messages mapping
could credit messages that the Fact did not come from, especially now that
Top-5 results are Fact-heavy.

Acceptance:

- A Fact with `source_unit_id` credits exactly that source message.
- A Chunk hit still credits every message physically contained in the chunk.
- Legacy databases without `source_unit_id` remain scoreable.

### 2. Parse graph evidence from the current `/ask` response schema

- [x] Read resolved nodes from `response.graph.components[].nodes`.
- [x] Continue excluding navigation-only `seeds` and `expandable` entries.
- [x] Decide whether `recalled_chunks` belongs to item recall, graph recall, or
  a separately reported channel; do not silently mix channels.
- [x] Add a golden test using the current `/ask` response shape.
- [ ] Recompute LoCoMo graph/combined evidence metrics from existing artifacts.

Why it mattered: the evaluator looked for a retired top-level `response.nodes`
field, so graph evidence was omitted from reports.

### 3. Align LongMemEval generation with the official `flat-turn` contract

- [x] For a Fact hit with `source_unit_id`, restore only that user turn and its
  immediately following assistant turn.
- [x] For a Fact without `source_unit_id`, retain whole-chunk expansion as a
  documented legacy fallback.
- [x] For a Chunk/Message hit, continue restoring all user turns represented by
  that retrieval unit and each immediately following assistant turn.
- [x] Keep Fact context fixed to the official default `none`: use the original
  source round and do not inject extracted Fact text into the prompt.
- [x] Record `fact_context_mode=none` in the generation run manifest.
- [x] Apply the official `model_context_tokens - max_tokens - 1000` retrieval
  limit and deterministic token-prefix truncation.
- [x] Add fixture tests for Fact, Chunk, duplicate Fact+Chunk, legacy Fact, and
  context truncation.
- [x] Re-run LongMemEval Generate after the change; Build and Ask were reused.
- [x] Re-run LongMemEval Score against the regenerated hypotheses.

Measured impact on the sample100 run before this fix:

- 420 Top-5 Fact hits, all with `source_unit_id`;
- former whole-chunk hydration restored 1,504 unique user turns;
- source-unit hydration restores 721 unique user turns;
- 783 extra user turns are currently added (2.09× total context);
- 80/100 cases change under source-unit hydration.

### 4. Commit core evaluation tests once the interfaces settle

- [ ] Add/commit tests for build contracts and configuration fingerprints.
- [ ] Add/commit tests for LoCoMo generation community-context handling.
- [x] Add source-unit evidence tests.
- [x] Add current graph-response parsing tests.
- [x] Add official-compatible LongMemEval hydration tests.
- [x] Add official judge-compatibility and raw-response persistence tests.
- [ ] Add resume incompatibility tests.

Note: some new evaluation tests currently exist locally but were intentionally
excluded from the previous commit.

## P1 — Reproducibility and experiment validity

### 5. Keep LongMemEval judging official-compatible and auditable

- [x] Preserve the official prompt, `temperature=0`, `max_tokens=10`, and
  `"yes" in response.lower()` label behavior.
- [x] Persist the raw Judge response next to its official parsed label and model
  in every scored hypothesis row.

### 6. Give every stage an immutable run manifest

- [ ] Use timestamp/run-ID directories consistently for LongMemEval Ask,
  Generate, and Score instead of relying on one mutable case-local result.
- [ ] Write `run.json` for LongMemEval Generate and Score.
- [ ] Refuse resume when any input/configuration fingerprint differs.
- [ ] Record:
  - input artifact paths and SHA256 values;
  - dataset/source/manifest fingerprint;
  - build configuration fingerprint;
  - Ask configuration and Top-K;
  - generation/judge model and endpoint (without credentials);
  - prompt text or prompt SHA256;
  - context hydration/fact mode and token budget;
  - Git commit and dirty-worktree fingerprint;
  - package/runtime versions;
  - start/end time, latency, token usage, and failures.
- [ ] Carry lineage from Build → Ask → Generate → Score.

### 7. Complete build/query configuration fingerprints

- [ ] Add production chunking/session-slicing settings to the build snapshot.
- [ ] Add extraction prompt/schema/strategy versions, not only model and
  strategy names.
- [ ] Add cleanup and improvement parameters that can change stored content.
- [ ] Add query settings to the Ask snapshot:
  - query rewrite model/configuration;
  - RRF/channel weights;
  - dedup mode;
  - graph radius/fanout/node limits;
  - reranker model, endpoint protocol, candidate window, and final cut;
  - community-context flags.
- [ ] Separate build compatibility fields from query experiment fields instead
  of calling both `retrieval_configuration`.

### 8. Add first-class LongMemEval retrieval metrics

- [x] Report KL-adapted `turn_recall@5` inside the normal Score artifact.
- [ ] Derive source-session/turn relevance from the benchmark answer-session
  annotations.
- [ ] Report Recall@1/3/5, complete-evidence recall, and MRR where the Gold
  permits it.
- [ ] Report Top-K diagnostics:
  - item type distribution (Fact/Chunk/etc.);
  - unique source chunks and source units;
  - repeated source-unit slots;
  - exact/near-duplicate candidates;
  - source concentration/entropy;
  - prompt user-turn count and token count.
- [ ] Produce per-question failure labels:
  - retrieval miss;
  - context-construction miss;
  - generation miss;
  - judge disagreement/failure.
- [ ] Add Recall@K curves and the same source-diversity metrics to LoCoMo.

### 9. Make KL, RAGFlow, and Khoj comparisons explicit and fair

- [ ] Keep a clearly labelled native end-to-end leaderboard.
- [ ] Add a normalized-retrieval leaderboard where every backend is mapped to
  the same original source-unit representation, prompt template, Top-K policy,
  and token budget.
- [ ] Record actual prompt tokens/context characters for every backend.
- [ ] Do not compare KL source-dialog hydration directly with raw external
  server chunks without labelling the context difference.
- [ ] Define how graph results, Facts, and chunks map to a common evidence unit.

### 10. Automate the LongMemEval end-to-end pipeline

- [x] Define an OmegaConf YAML experiment config for Convert, Build, Ask,
  Generate, and Score.
- [x] Add one resumable command for Convert → Build → Ask → Generate → Score.
- [x] Persist a credential-free, fully resolved experiment configuration.
- [x] Reuse compatible Convert/Build/Ask/Generate/Score artifacts.
- [ ] Smoke-test a complete case through the new pipeline against live services.

## P1 — Production hypotheses that evaluation should test

These are not evaluation-owned production changes. The evaluation module should
make them measurable through explicit A/B configurations.

### 11. Source-aware result diversity

- [ ] Compare the current Top-K against a two-pass selection policy: first take
  the best result per `source_chunk_id`, then fill remaining slots.
- [ ] Test per-source caps of 1 and 2.
- [ ] Measure QA, Recall@K, source coverage, Fact share, and multi-session score.

### 12. Extraction target/context leakage

- [ ] Add a diagnostic corpus where target and read-only neighbour facts are
  intentionally disjoint.
- [ ] Measure how often extraction assigns neighbour-only facts to the target
  source unit.
- [ ] Test context windows 0/1/3 and target-grounded evidence-quote validation.

### 13. Fact/Entity quality ablations

- [ ] Measure exact duplicates, semantic/source redundancy, and unique source
  coverage separately.
- [ ] Test suppression/normalization of generic `user`/`用户` entities.
- [ ] Test English-only extraction or generation-language enforcement.
- [ ] Compare whole-chunk extraction, message extraction, and message extraction
  plus chunk-aware consolidation.

## P2 — Runner architecture, efficiency, and usability

### 14. Share orchestration without merging dataset semantics

- [ ] Introduce common typed artifact/run-manifest models.
- [ ] Share process lifecycle, port allocation, health checks, shutdown, logging,
  retries, progress, and checkpoint helpers.
- [ ] Share backend client protocols for KL, RAGFlow, and Khoj.
- [ ] Keep conversion, Gold mapping, and official scoring dataset-specific.
- [ ] Reduce duplicated Build/Ask logic across LoCoMo and LongMemEval only after
  the artifact contracts are stable.

### 15. Improve server/process efficiency

- [ ] Measure KL Server startup time separately from query latency.
- [ ] Reuse bounded worker/process orchestration where isolation permits it.
- [ ] Record p50/p95 latency for Build, Ask, Generate, and Score.
- [ ] Record LLM requests, tokens, estimated cost, retries, and rate-limit time.
- [ ] Add clear ETA and active-case monitoring for long builds.

### 16. Normalize CLI and output behaviour

- [ ] Use consistent `--case`, `--first`, `--all`, `--resume`, `--overwrite`,
  `--run-id`, `--output-dir`, and concurrency semantics.
- [ ] Make default output locations consistent across datasets/backends.
- [ ] Ensure every resume path validates configuration before reusing output.
- [ ] Add a read-only `inspect` command that summarizes artifact completeness,
  configuration, failures, and next runnable stage.

## Suggested implementation order

1. Precise Fact `source_unit_id` evidence/hydration.
2. Current `/ask` graph-component evidence parsing.
3. Save raw LongMemEval Judge outputs without changing the official metric.
4. Tests for the three correctness fixes.
5. Re-score existing retrieval artifacts; regenerate LongMemEval hypotheses with
   official-compatible source-unit hydration.
6. Immutable run manifests and complete configuration fingerprints.
7. Retrieval diagnostics and normalized backend comparison.
8. Automated experiment runner/reporting.
9. Shared orchestration and performance work.
