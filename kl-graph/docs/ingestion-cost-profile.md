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
| Server index hot-swap | Whole graph | Medium–heavy | Rebuilds in-memory adjacency by scanning all graph edges, `O(E)` |

## Improvement modes

- `off`: no similarity/community work.
- `auto`: `full` when no complete community-column baseline exists; otherwise
  `incremental`. An empty batch does no improvement.
- `incremental`: explicit batch-targeted update; rejected if no full baseline
  exists.
- `full`: explicit graph-wide periodic improvement.

The state-based `auto` policy replaces timestamp watermarks and “full every N
runs.” It reflects whether incremental community assignment is actually safe,
while `full` remains available for intentional global re-clustering.

### Incremental improvement

| Step | Typical weight | Cost characteristics |
|---|---:|---|
| Recover affected IDs | Medium on large graphs | Reads batch facts and scans structural graph edges to find touched entities |
| ANN similarity | Medium | One bounded ANN search per affected node plus vector retrieval; approximately `O(K × ANN)` |
| Intra-batch similarity | Medium–heavy for large batches | Dense pairwise cosine, `O(K² × D)` compute and `O(K²)` score matrices |
| Structural feature load | Medium on large graphs | Scans MENTIONS/AUTHORED_BY/ABOUT edges, `O(E)` |
| Frontier communities | Medium | Builds global graph projections (`O(V+E)`), then runs four Leiden resolutions only on new/touched nodes plus one-hop neighbors |
| Community projection | Medium–heavy | Rewrites the complete derived `COMM_MEMBER` projection, `O(V)` assignments/edges |

Incremental improvement is substantially cheaper than full all-pairs
similarity when `K << V`, but it is not constant-time: global structural scans
and the complete membership projection remain. Large backfills can make `K²`
intra-batch similarity expensive; use `full` deliberately when a global
re-cluster is desired, not merely because a batch is large.

### Full improvement

| Step | Typical weight | Cost characteristics |
|---|---:|---|
| Fact similarity | Very heavy | Loads all fact vectors and performs chunked all-pairs cosine, `O(F² × D)` compute and `O(F × D)` resident vectors. The implementation notes about 1.1 GB for 17k facts at 4096 dimensions |
| Entity similarity | Heavy | Same graph-wide all-pairs pattern for entities, followed by structural hybrid scoring |
| Entity disambiguation | Variable/heavy | Phonetic/hybrid candidate generation plus an LLM judge capped by `llm_max_budget` (default 500) |
| Entity communities | Medium–heavy | Four graph-wide Leiden resolutions |
| Fact communities | Medium–heavy | Four graph-wide Leiden resolutions; the HDBSCAN topic path is currently disabled |
| Community projection | Medium–heavy | Deletes and rebuilds every `COMM_MEMBER` edge |

For most incremental server runs, LLM extraction and embeddings dominate wall
time and external cost. For mature graphs with small incoming batches,
community projection/index hot-swap can dominate local CPU and I/O. Full
improvement is the principal RAM/CPU risk because of its all-pairs vector work.
