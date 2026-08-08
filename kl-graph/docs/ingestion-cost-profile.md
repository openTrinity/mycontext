# Ingestion Cost Profile

Normal ingestion always uses the same unit-incremental Phase A/Phase B runner.
`N` below is the current batch size; `V`/`E` are total graph nodes/edges; `K` is
the number of entities/facts affected by the batch; and `D` is embedding width.

| Stage | Scope | Typical weight | Main scaling / bottleneck |
|---|---|---:|---|
| Source scan, parse, chunk | Batch/input tree | Light–medium | Local file I/O and parsing, approximately linear in source bytes |
| Unit deduplication | Batch | Light | Indexed SQLite lookups by immutable unit identity, approximately `O(N)` |
| Chunk persistence | Batch | Light | SQLite transaction and lineage rows, approximately `O(N)` |
| Chunk embedding | New chunks | Heavy | Remote embedding latency/tokens, approximately `O(N × D)`; duplicate text vectors are reused |
| LLM extraction | New chunks | Usually heaviest | Paid/network LLM work, batched with configured concurrency; approximately linear in input tokens |
| Entity construction | Batch | Medium | Linear extraction folding plus SQLite upserts; hub descriptions can add bounded concurrent LLM calls |
| Fact construction | Batch | Light–medium | Linear fact normalization and inserts |
| Entity/fact embedding | New graph nodes | Heavy | Remote embedding latency, approximately `O((entities + facts) × D)` |
| Structural edge construction | Batch | Medium | Linear in extracted mentions/facts, plus chat temporal/reply relationships |
| Structural cache delta | Batch | Light | Updates in-memory entity↔chunk and entity↔fact mappings from new edges, approximately `O(K)` |
| Server index hot-swap | Whole graph | Medium–heavy | Rebuilds in-memory adjacency by scanning all graph edges, `O(E)` |

## Improvement modes

- `off`: no similarity/community work.
- `auto`: `full` when no complete community-column baseline exists; otherwise
  `incremental`. An empty batch does no improvement.
- `incremental`: explicit batch-targeted update; rejected if no full baseline
  exists.
- `full`: explicit graph-wide periodic improvement.

The state-based `auto` policy replaces timestamp watermarks and "full every N
runs." It reflects whether incremental community assignment is actually safe,
while `full` remains available for intentional global re-clustering.

### Incremental improvement

The incremental path is `O(K)` in all steps except server finalization. A
`StructuralCache` (server-level in-memory mirror of entity↔chunk and
entity↔fact edges) eliminates global structural scans; `scan_edges_for_nodes`
(backend-level indexed edge query) eliminates full graph loading for Leiden;
and scoped COMM_MEMBER projection avoids the `O(V)` delete-rebuild cycle.

| Step | Typical weight | Cost characteristics |
|---|---:|---|
| Recover affected IDs | Light | Reverse lookups on StructuralCache (`chunk→entities`, `fact→entities`), approximately `O(K)`. Falls back to `O(E)` store scan when cache is absent. |
| ANN similarity | Medium | One bounded ANN search per affected node plus vector retrieval; approximately `O(K × A)` where A is the ANN result limit (50) |
| Intra-batch similarity | Medium–heavy for large batches | Dense pairwise cosine, `O(K² × D)` compute and `O(K²)` score matrices |
| Structural feature load | Light | Served from StructuralCache (`entity→chunks`, `entity→facts`); no store scan. Delta-applied per batch in `O(K)`. |
| Frontier communities | Medium | Queries only frontier edges via `scan_edges_for_nodes` (`O(frontier edges)`), builds frontier-only igraph, runs four Leiden resolutions on the subgraph (3 iterations each). No full graph load. |
| Community projection | Light | Scoped rebuild: only deletes and rebuilds `COMM_MEMBER` edges for communities whose membership changed, approximately `O(changed × avg_community_size)`. Full rebuild only on first seed or `full` mode. |
| Summary invalidation | Light | Marks affected summaries stale using local metadata updates. No LLM calls. |

Incremental improvement is `O(K + frontier)` overall. The only remaining
graph-wide cost is server finalization (`O(E)` adjacency hot-swap), which is
a local in-memory scan independent of the improvement pipeline. For mature
graphs with small incoming batches, the bottleneck is now LLM extraction and
embedding API latency rather than local graph operations.

### Checkpoint semantics

The incremental improvement checkpoint is split into two independently
resumable steps:

- `improve.incremental_leiden` — runs Leiden on the frontier subgraph,
  stores the changed community UUID set in checkpoint metadata.
- `improve.incremental_projection` — scoped COMM_MEMBER projection for the
  changed communities. On retry after a mid-step crash, recovers the changed
  set from checkpoint metadata.

The similarity step (`improve.incremental_similarity`) is unchanged: a single
checkpoint key covers ANN search, intra-batch cosine, edge insertion, and
structural cache delta.

### Full improvement

| Step | Typical weight | Cost characteristics |
|---|---:|---|
| Fact similarity | Very heavy | Loads all fact vectors and performs chunked all-pairs cosine, `O(F² × D)` compute and `O(F × D)` resident vectors. The implementation notes about 1.1 GB for 17k facts at 4096 dimensions |
| Entity similarity | Heavy | Same graph-wide all-pairs pattern for entities, followed by structural hybrid scoring |
| Entity disambiguation | Variable/heavy | Phonetic/hybrid candidate generation plus an LLM judge capped at `llm_max_budget` (default 500) |
| Entity communities | Medium–heavy | Four graph-wide Leiden resolutions |
| Fact communities | Medium–heavy | Four graph-wide Leiden resolutions; the HDBSCAN topic path is currently disabled |
| Community projection | Medium–heavy | Deletes and rebuilds every `COMM_MEMBER` edge (full rebuild path) |

For most incremental server runs, LLM extraction and embeddings dominate wall
time and external cost. Full improvement is the principal RAM/CPU risk because
of its all-pairs vector work. Do not select `full` merely because a batch is
large; use it when global re-clustering is intentionally required.
