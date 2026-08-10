# Ingest API and Cost Guide

`POST /ingest` is the server-side source-ingestion entry point. It is
asynchronous: the request validates and queues a server-local export directory,
then returns immediately. `POST /improve` queues graph-wide periodic
maintenance without source data. Use `GET /status` to follow either job.

## Request

```http
POST /ingest
Content-Type: application/json

{
  "input_dir": "/srv/exports/dingtalk",
  "source_id": "dingtalk-personal",
  "concurrency": 50,
  "improve_mode": "auto"
}
```

| Field | Required | Default | Meaning |
|---|---:|---:|---|
| `input_dir` | Yes | — | Existing directory on the server filesystem. Source bytes are not uploaded in the request. |
| `source_id` | Yes | — | Stable caller-owned namespace. Deduplication identity is `(source_id, source_type, unit_id)`. |
| `concurrency` | No | `50` | Maximum concurrent extraction LLM calls. Must be at least 1. It does not control local parsing or graph-write parallelism. |
| `improve_mode` | No | `auto` | One of `auto`, `incremental`, `full`, or `off`; see below. |

Unknown fields are rejected. The removed `run_improve` Boolean is not accepted;
use `improve_mode`.

### Improvement policy

| Mode | Behavior | Use when |
|---|---|---|
| `auto` | If graph nodes exist but no full community baseline exists, run full improvement once. Otherwise improve only nodes affected by this batch. An empty batch does nothing. | Normal production ingestion. |
| `incremental` | Force batch-targeted ANN similarity and one-hop frontier community assignment. Fails when no full baseline exists. | You know the graph was fully initialized and want to prevent a global pass. |
| `full` | Force graph-wide similarity and disambiguation; also reconstruct communities when the community feature is enabled. | Initial seeding, intentional global refresh, or repair. |
| `off` | Skip all similarity/community improvement. | Fast loading when only chunk/entity/fact retrieval is needed, or periodic dependencies are unavailable. |

The full-baseline requirement for forced `incremental` mode is checked when
improvement begins, after Phase A and Phase B have persisted their outputs. On
an initial non-empty ingestion, forced `incremental` therefore fails during the
improve phase without rolling back the completed build. The durable workset and
checkpoints remain; retry the same input with `auto` or `full` to resume the
completed work and create the baseline. If the admitted batch has no
improvement targets, improvement resolves to `off` and no baseline check runs.

`auto` is based on persisted community state. There are no timestamp watermarks,
incremental run counters, or “full every N runs” rules.

## Periodic full improvement

Use the dedicated endpoint to rebuild derived graph relationships without
scanning a source directory or running extraction:

```http
POST /improve
Content-Type: application/json

{
  "mode": "full"
}
```

`mode` is optional and currently accepts only `full`. The job rebuilds
graph-wide fact/entity similarity, runs entity disambiguation, and refreshes the
server's in-memory adjacency index. It does not create chunks, entities, or
facts from source data. Hierarchical detection and its LLM summaries run only
when `pipelines.communities.enabled: true` (or
`KL_COMMUNITIES_ENABLED=1`); communities are disabled by default.

`POST /improve` and `POST /ingest` use the same single-writer queue, so a full
maintenance pass cannot overlap an ingestion write. Use this endpoint for
periodic maintenance in an incremental-first deployment. Use
`POST /ingest` with `improve_mode: "full"` only when new source ingestion and a
full rebuild intentionally belong to the same job.

## Responses and queueing

When no ingestion is active:

```json
{
  "status": "started",
  "run_id": "...",
  "ingest": {
    "run_id": "...",
    "source_id": "dingtalk-personal",
    "improve_mode": "auto",
    "state": "running",
    "phase": "phase_a",
    "percent": 0.0,
    "detail": "queued"
  }
}
```

When another run is active, the new request is persisted and queued:

```json
{
  "status": "continued",
  "run_id": "active-run-id",
  "queued_run_id": "new-run-id",
  "queued_source": "dingtalk-personal"
}
```

Only one ingestion or improvement job writes at a time. Queued jobs run
serially while query traffic continues. `/improve` returns the same response
shape; a queued response uses `"queued_job": "improve"` instead of
`queued_source`.

### Errors

| HTTP status | Cause |
|---:|---|
| `400` | `input_dir` does not exist or is not a directory on the server. |
| `422` | Missing/invalid fields, invalid `improve_mode`, or an unknown request field. |
| `503` | The retrieval server has not completed startup. |

Execution failures appear in `GET /status` with `state: "error"` and the error
message. Forced `incremental`/`full` improvement fails if the periodic extra is
missing. `auto` logs and skips improvement when those optional dependencies are
unavailable; a later `auto` retry can seed the still-missing baseline.

## Status

Poll `GET /status` and read its `ingest` object. Important fields are:

- `state`: `idle`, `running`, `done`, or `error`;
- `phase`: `phase_a`, `phase_b`, `improve`, `finalize`, or empty when finished;
- `percent` and `detail`;
- `units_discovered`, `units_skipped`, `units_processed`, and `chunks_created`;
- `run_id`, `source_id`, `improve_mode`, and `error`.

The object also includes `job_type`, either `ingest` or `improve`. For an
improvement-only job, `source_id` is null, `improve_mode` is `full`, and all
unit/chunk counters remain zero. The containing field is still named `ingest`
for response compatibility.

Phase A completion makes chunk vector/BM25 retrieval usable. Phase B adds the
extracted graph. Finalization reconciles affected in-memory adjacency buckets
from committed graph state. It refreshes the facts-only PageRank prior only
when the workset contains facts that may have changed its ABOUT projection.

## Incremental and retry semantics

Every request executes the same Phase A/Phase B orchestration. On an empty
database all units are new, so the request naturally acts as an initial load. On
an existing database, units already committed for the same composite identity
are skipped.

The exact admitted batch is stored as a durable workset. Checkpoints resume
embedding, extraction, graph construction, and improvement from that workset;
the workset is deleted only after the run and server finalization succeed.
Timestamps order content but never decide whether it is admitted. A late unseen
unit is processed normally.

A same-ID/different-content source unit is currently warned about and skipped;
replacement/deletion semantics remain a separate feature.

### Crash recovery

If the server process is killed mid-ingestion (OOM, kill -9, power loss):

- **Extraction cache** (`extraction_cache.db`): preserved. Phase B re-extraction
  hits the cache for already-extracted chunks, so those chunks are not billed
  twice. Chunks that had not reached the cache before the crash remain misses
  and still require LLM extraction.
- **Checkpoint**: persists which steps completed. On retry, completed steps are
  skipped. The checkpoint JSON is written atomically (write-tmp + rename).
- **Workset** (`ingest_batches` / `ingest_batch_chunks` tables): if the chunk
  count is inconsistent (e.g. due to external deletion or disk corruption), the
  server raises a RuntimeError with an actionable message. The workset is NOT
  automatically recovered — SQLite transactions are atomic, so a mismatch
  indicates external corruption, not a mid-transaction crash. Use `--fresh-db`
  to start a clean rebuild (extraction cache is preserved).
- **LadybugDB lock**: the backend uses an OS-level database lock, which the OS
  releases when the owning process exits. A lock error therefore indicates a
  live concurrent owner or a permissions/filesystem problem; startup fails
  without deleting database-related files.
- **LadybugDB WAL**: automatic removal is limited to a rejected WAL found when
  no main database existed before open. If a main database already exists, the
  WAL may contain recoverable state, so both files are preserved and startup
  fails loudly for manual diagnosis.

## Cost analysis by step

Variables used below:

- `B`: source bytes scanned in this request;
- `U`: candidate source units found while scanning;
- `N`: new chunks admitted to the batch;
- `T`: extraction input tokens;
- `K_e`, `K_f`: affected entities and new facts in the batch;
- `V`, `V_e`, `E`: total graph nodes, entities, and edges;
- `S`: structural edges held by the server-level cache;
- `P`, `E_P`: nodes and induced edges in the one-hop community frontier;
- `I_K`: structural incidences traversed for affected/frontier nodes;
- `Q_P`: structural candidate pairs enumerated inside the frontier (for example,
  the sum of entity pairs per shared chunk);
- `C`: membership rows in communities whose assignments changed;
- `D`: embedding vector width;
- `F`: total facts in the graph;
- `A`: the ANN result limit per affected node (currently 50).
- `Z`, `I_Z`: dirty adjacency keys and their incident stored edges;
- `E_R`, `J`: edges in the facts-only entity projection and PageRank iterations.

“External cost” means paid or remote-model work. “Local cost” means server CPU,
RAM, disk I/O, and graph/Qdrant operations.

| Phase / step | Scope | Weight | Cost and scaling |
|---|---|---:|---|
| A1. Scan and parse sources | Input tree | Light–medium | Local file I/O and parsing, approximately `O(B)`. Large exports can be I/O-bound. |
| A2. Chunk content | All scanned candidate units | Light–medium | Local text/session splitting occurs before stored-unit filtering, so recurring scans still pay this CPU cost for seen inputs. More/smaller chunks increase every downstream per-chunk cost for admitted units. |
| A3. Deduplicate units | Candidate units | Light | Indexed SQLite lookups, approximately `O(U)`. No model calls. |
| A4. Persist chunks and lineage | New units/chunks | Light | One SQLite commit point plus ordered unit/chunk mappings, approximately `O(N)`. |
| A5. Embed chunks | New chunks | Heavy | Remote embedding work, approximately `O(N × D)` plus network latency. Byte-identical texts share one embedding call, but each chunk still gets a point. |
| B1. Extraction-cache lookup | New chunks | Light | Indexed reads from separate `extraction_cache.db`. Cache hits remove the dominant extraction cost; the rolling LRU retains at most 100k rows by default (`KL_EXTRACTION_CACHE_MAX_ENTRIES`), which must be at least the largest extraction workset. |
| B2. LLM extraction | Cache misses | Usually heaviest | External cost approximately proportional to `T`; wall time depends on endpoint latency, batching, and `concurrency`. This usually dominates a normal ingest. |
| B3. Build/update entities | Batch | Medium | Linear folding/upserts. High-mention entities may trigger bounded entity-description summarization LLM calls. |
| B4. Build facts | Batch | Light–medium | Linear normalization, deterministic IDs, and inserts. No separate LLM call beyond extraction. |
| B5. Embed entities and facts | New graph nodes | Heavy | Remote embedding work approximately `O((K_e + K_f) × D)`. Existing deterministic vector IDs are skipped. |
| B6. Build structural edges | Batch | Medium | Local work linear in extracted mentions/facts plus chat temporal/reply relationships. Graph writes can dominate for edge-rich batches. |
| I1. Recover improvement targets | Batch | Light | Reverse cache lookups over admitted chunk/fact IDs, `O(N + output IDs)`. Without the server cache, standalone callers fall back to `O(E)` structural scans. |
| I2. Incremental ANN similarity | Affected nodes + graph | Medium | Bounded ANN search and vector retrieval, roughly `O((K_e + K_f) × A)`. Hybrid structural scoring is degree/set-size sensitive and adds work proportional to candidate sets traversed. |
| I3. Intra-batch similarity | Affected nodes | Medium–very heavy | Dense cosine matrices: `O((K_e² + K_f²) × D)` compute and `O(K_e² + K_f²)` score memory. Large backfills are the risk case. |
| I4. Incremental communities | One-hop frontier | Medium | Discovers structural neighbors in `O(K + I_K)`, performs indexed similarity lookups in `O(P + incident edges)`, enumerates `Q_P` structural pairs, then runs four 3-iteration Leiden resolutions over `P` nodes/`E_P` edges. Dense shared chunks/entities can dominate without a graph-wide scan. |
| I5. Community projection | Changed communities | Light | Indexed reads plus scoped `COMM_MEMBER` replacement, `O(C)` rows. A legacy database pays a one-time `O(V)` assignment-index build; UUID-only custom strategies retain an `O(V)` compatibility fallback. Empty-change runs do no projection. |
| I6. Summary invalidation | Touched communities | Light | Marks affected stored summaries stale using local metadata updates. It does not regenerate summaries or call an LLM. |
| F1. Full fact similarity | Whole graph | Very heavy | Loads all fact vectors and performs chunked all-pairs cosine: `O(F² × D)` compute and `O(F × D)` resident vectors. The implementation estimates about 1.1 GB for 17k facts at 4096 dimensions. |
| F2. Full entity similarity | Whole graph | Heavy | Graph-wide all-pairs vector prefilter, approximately `O(V_e² × D)`, plus structural hybrid scoring for retained candidates. |
| F3. Entity disambiguation | Whole graph | Variable/heavy | Local phonetic/hybrid candidate generation plus an LLM judge capped at 500 calls by default. |
| F4. Full communities | Whole graph | Medium–heavy | Four entity and four fact Leiden resolutions over graph-wide projections. |
| Z1. Adjacency finalization | Dirty endpoints | Light–medium | Rereads authoritative incident edges and replaces immutable buckets, approximately `O(Z + I_Z)`. A full improvement, broad frontier, startup, or failed incremental refresh falls back to `O(E)`. |
| Z2. PageRank refresh | Facts-only entity projection | Medium–heavy when triggered | Runs only when workset facts may have changed facts/ABOUT inputs. It scans facts and ABOUT edges, constructs entity pairs per fact, then performs up to `J` iterations over `E_R`; improvement-only changes reuse the current prior. |

### Practical interpretation

- For ordinary incremental requests, extraction LLM calls are normally the
  largest external cost; chunk and graph embeddings are second.
- Excluding ANN and dense cosine work shown in I2/I3, local incremental graph
  work is approximately `O(K + I_K + P + Q_P + E_P + C)`. High-degree entities
  can make a small batch locally expensive without causing a whole-graph scan.
- The structural cache costs `O(S)` startup reads and resident memory. Batch
  deltas are applied inside the durable edge-construction checkpoint.
- Normal server finalization is output-sensitive (`O(Z + I_Z)`) and atomically
  publishes copy-on-write adjacency buckets. Full improvement, broad dirty
  frontiers, startup, and recovery retain the `O(E)` reconciliation path.
- PageRank is a serving-index prior, not an optional improvement step. It is
  reused for similarity/community-only changes and recomputed when new facts
  may have changed the ABOUT projection.
- Full improvement is the primary CPU/RAM risk. Do not select `full` merely
  because a batch is large; use it when global re-clustering is intentionally
  required.
- `concurrency` can reduce extraction wall time until the model endpoint or rate
  limit saturates. It does not reduce token cost and can increase transient load.

Community-summary generation and community-vector embedding are separate tools;
they are not part of `POST /ingest` and have their own LLM/embedding costs.

For a compact scaling-only view, see
[Ingestion Cost Profile](ingestion-cost-profile.md).
