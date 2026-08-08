# Ingestion Cost Profile

Normal ingestion always uses the same unit-incremental Phase A/Phase B runner.
`N` below is the current batch size; `V`/`E` are total graph nodes/edges; `K` is
the number of entities/facts affected by the batch; `P`/`E_P` are frontier
nodes/induced edges; `I_K` is structural incidence traversed for affected nodes;
`Q_P` is structural candidate pairs enumerated in the frontier; `C` is
changed-community membership rows; `S` is cached structural edges; and `D` is
embedding width. `Z`/`I_Z` are dirty serving-index keys and their incident
edges; `E_R`/`J` are facts-only entity-projection edges and PageRank iterations.

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
| Structural cache startup | Whole structural graph | Medium | One server-start scan plus resident bidirectional sets, `O(S)` time and memory |
| Structural cache delta | Batch structural edges | Light | Updates in-memory entity↔chunk and entity↔fact mappings, linear in new structural edges; it is part of the edge-construction checkpoint |
| Adjacency finalization | Dirty endpoints | Light–medium | Reconciles immutable buckets from committed incident edges, `O(Z + I_Z)`; full/broad/recovery paths remain `O(E)` |
| PageRank refresh | Facts-only projection | Conditional medium–heavy | Runs only when workset facts may change ABOUT inputs; scans facts/ABOUT, constructs per-fact entity pairs, then iterates over `E_R` up to `J` times |

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

The incremental path avoids recurring full-graph improvement scans, but it is
not strictly `O(K)`: structural work depends on affected-node degrees and
community work depends on the emitted frontier and changed memberships. A
server-level `StructuralCache`, indexed endpoint reads on both SQLite and
Ladybug, and keyed COMM_MEMBER projection keep that work output-sensitive.

| Step | Typical weight | Cost characteristics |
|---|---:|---|
| Recover affected IDs | Light | Reverse lookups over admitted chunks/facts, `O(N + output IDs)`. Falls back to `O(E)` when no StructuralCache is supplied. |
| ANN similarity | Medium | One bounded ANN search per affected node plus vector retrieval; approximately `O(K × A)` where A is the ANN result limit (50) |
| Intra-batch similarity | Medium–heavy for large batches | Dense pairwise cosine, `O(K² × D)` compute and `O(K²)` score matrices |
| Structural feature/frontier load | Light–heavy for hubs | Cache lookups avoid a store scan but traverse incident chunk/fact sets, `O(I_K)` plus set-intersection/pair-generation work. |
| Frontier communities | Medium | Indexed equality lookups cost `O(P + incident similarity edges)`; structural projection enumerates `Q_P` candidate pairs; Leiden runs four 3-iteration resolutions over `P`/`E_P`. Dense shared chunks/entities can dominate. |
| Community projection | Light | Exact `(node type, level, ID)` keys drive indexed reads and scoped `COMM_MEMBER` replacement, `O(C)`. Empty changes are a no-op. Legacy index creation is a one-time `O(V)` cost; UUID-only custom strategies use an `O(V)` compatibility scan. |
| Summary invalidation | Light | Marks affected summaries stale using local metadata updates. No LLM calls. |

Excluding ANN and dense cosine work itemized above, local incremental graph work
is approximately `O(K + I_K + P + Q_P + E_P + C)`, followed by an
`O(Z + I_Z)` adjacency refresh. Full improvement, a broad dirty frontier,
startup, or incremental-refresh failure uses the `O(E)` reconciliation path.
PageRank is reused for similarity/community-only changes but remains a
conditional global computation when the workset adds facts. Cacheless
standalone runs retain their explicit `O(E)` fallbacks. For mature graphs with
small, non-hub batches, LLM extraction and embedding latency normally dominate.

### Checkpoint semantics

The incremental improvement checkpoint is split into two independently
resumable steps:

- `improve.incremental_leiden` — runs Leiden on the frontier subgraph,
  stores both changed UUIDs and reversible `(node type, level, cluster ID)` keys.
- `improve.incremental_projection` — scoped COMM_MEMBER projection for the
  changed communities. On retry, it recovers both scope representations from
  checkpoint metadata, so reads as well as writes remain scoped.

`improve.incremental_similarity` covers ANN search, intra-batch cosine, and
similarity-edge insertion. The structural-cache delta belongs to
`phase_b.create_edges`: persisted structural edges are applied to the cache
before that checkpoint is marked complete, so an interrupted retry cannot skip
the cache update.

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
