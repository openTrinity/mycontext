# Ingest API and Cost Guide

`POST /ingest` is the single server-side ingestion entry point. It is
asynchronous: the request validates and queues a server-local export directory,
then returns immediately. Use `GET /status` to follow the run.

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
| `full` | Force graph-wide similarity, disambiguation, and community reconstruction. | Initial seeding, intentional re-clustering, or repair. |
| `off` | Skip all similarity/community improvement. | Fast loading when only chunk/entity/fact retrieval is needed, or periodic dependencies are unavailable. |

`auto` is based on persisted community state. There are no timestamp watermarks,
incremental run counters, or “full every N runs” rules.

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

Only one ingestion job writes at a time. Queued jobs run serially while query
traffic continues.

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

Phase A completion makes chunk vector/BM25 retrieval usable. Phase B adds the
extracted graph. Finalization refreshes the server's in-memory adjacency index.

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

## Cost analysis by step

Variables used below:

- `B`: source bytes scanned in this request;
- `U`: candidate source units found while scanning;
- `N`: new chunks admitted to the batch;
- `T`: extraction input tokens;
- `K_e`, `K_f`: affected entities and new facts in the batch;
- `V`, `V_e`, `E`: total graph nodes, entities, and edges;
- `D`: embedding vector width;
- `F`: total facts in the graph;
- `A`: the ANN result limit per affected node (currently 50).

“External cost” means paid or remote-model work. “Local cost” means server CPU,
RAM, disk I/O, and graph/Qdrant operations.

| Phase / step | Scope | Weight | Cost and scaling |
|---|---|---:|---|
| A1. Scan and parse sources | Input tree | Light–medium | Local file I/O and parsing, approximately `O(B)`. Large exports can be I/O-bound. |
| A2. Chunk content | All scanned candidate units | Light–medium | Local text/session splitting occurs before stored-unit filtering, so recurring scans still pay this CPU cost for seen inputs. More/smaller chunks increase every downstream per-chunk cost for admitted units. |
| A3. Deduplicate units | Candidate units | Light | Indexed SQLite lookups, approximately `O(U)`. No model calls. |
| A4. Persist chunks and lineage | New units/chunks | Light | One SQLite commit point plus ordered unit/chunk mappings, approximately `O(N)`. |
| A5. Embed chunks | New chunks | Heavy | Remote embedding work, approximately `O(N × D)` plus network latency. Byte-identical texts share one embedding call, but each chunk still gets a point. |
| B1. Extraction-cache lookup | New chunks | Light | Indexed SQLite reads. Cache hits remove the dominant extraction cost. |
| B2. LLM extraction | Cache misses | Usually heaviest | External cost approximately proportional to `T`; wall time depends on endpoint latency, batching, and `concurrency`. This usually dominates a normal ingest. |
| B3. Build/update entities | Batch | Medium | Linear folding/upserts. High-mention entities may trigger bounded entity-description summarization LLM calls. |
| B4. Build facts | Batch | Light–medium | Linear normalization, deterministic IDs, and inserts. No separate LLM call beyond extraction. |
| B5. Embed entities and facts | New graph nodes | Heavy | Remote embedding work approximately `O((K_e + K_f) × D)`. Existing deterministic vector IDs are skipped. |
| B6. Build structural edges | Batch | Medium | Local work linear in extracted mentions/facts plus chat temporal/reply relationships. Graph writes can dominate for edge-rich batches. |
| I1. Recover improvement targets | Batch | Light | Reverse lookups on StructuralCache (`chunk→entities`, `fact→entities`), approximately `O(K)`. Falls back to `O(E)` store scan when cache is absent (e.g. standalone scripts). |
| I2. Incremental ANN similarity | Affected nodes + graph | Medium | Bounded ANN search and vector retrieval, roughly `O((K_e + K_f) × A)`. Structural features for hybrid scoring served from StructuralCache (no store scan). |
| I3. Intra-batch similarity | Affected nodes | Medium–very heavy | Dense cosine matrices: `O((K_e² + K_f²) × D)` compute and `O(K_e² + K_f²)` score memory. Large backfills are the risk case. |
| I4. Incremental communities | Frontier only | Medium | Queries only edges touching new nodes via `scan_edges_for_nodes` (`O(frontier edges)`), builds frontier-only igraph, runs four Leiden resolutions (3 iterations each). No full graph load. |
| I5. Community projection | Changed communities | Light | Scoped rebuild: deletes and rebuilds `COMM_MEMBER` edges only for communities whose membership changed, approximately `O(changed × avg_community_size)`. Full `O(V)` rebuild only on first seed or `full` mode. |
| I6. Summary invalidation | Touched communities | Light | Marks affected stored summaries stale using local metadata updates. It does not regenerate summaries or call an LLM. |
| F1. Full fact similarity | Whole graph | Very heavy | Loads all fact vectors and performs chunked all-pairs cosine: `O(F² × D)` compute and `O(F × D)` resident vectors. The implementation estimates about 1.1 GB for 17k facts at 4096 dimensions. |
| F2. Full entity similarity | Whole graph | Heavy | Graph-wide all-pairs vector prefilter, approximately `O(V_e² × D)`, plus structural hybrid scoring for retained candidates. |
| F3. Entity disambiguation | Whole graph | Variable/heavy | Local phonetic/hybrid candidate generation plus an LLM judge capped at 500 calls by default. |
| F4. Full communities | Whole graph | Medium–heavy | Four entity and four fact Leiden resolutions over graph-wide projections. |
| Z1. Server finalization | Whole graph | Medium–heavy | Hot-swap rebuild scans all graph edges to reconstruct in-memory adjacency, `O(E)`. |

### Practical interpretation

- For ordinary incremental requests, extraction LLM calls are normally the
  largest external cost; chunk and graph embeddings are second.
- Incremental improvement is `O(K + frontier)`: a server-level
  `StructuralCache` eliminates structural-edge rescans, `scan_edges_for_nodes`
  eliminates full-graph loading for Leiden, and scoped COMM_MEMBER projection
  avoids the `O(V)` delete-rebuild cycle.
- The only remaining graph-wide cost is server finalization (`O(E)` adjacency
  hot-swap), which is a local in-memory scan independent of the improvement
  pipeline.
- Full improvement is the primary CPU/RAM risk. Do not select `full` merely
  because a batch is large; use it when global re-clustering is intentionally
  required.
- `concurrency` can reduce extraction wall time until the model endpoint or rate
  limit saturates. It does not reduce token cost and can increase transient load.

Community-summary generation and community-vector embedding are separate tools;
they are not part of `POST /ingest` and have their own LLM/embedding costs.

For a compact scaling-only view, see
[Ingestion Cost Profile](ingestion-cost-profile.md).
