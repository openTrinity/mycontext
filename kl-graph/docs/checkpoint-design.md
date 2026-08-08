# Checkpointing & Transaction Design for Resumable Ingestion

> **This document is the source of truth** for checkpoint semantics, transaction
> boundaries, and commit-vs-cache decisions across all pipeline steps — current
> and future. Update this document first when adding new steps.

---

## 1. Context & Problem

> Note (post-cutover): the extraction cache now lives in the `extraction_cache`
> table of `knowledge.db` (keyed by md5 of chunk id, success-only rows);
> deleting or `--fresh-db`-ing `knowledge.db` clears it. The JSON-per-chunk
> "disk cache" layout described throughout this doc — including the `extraction`
> (B.1) commit-vs-cache row and the `_load_extraction_cache` replay references —
> is historical.

The ingestion pipeline (`kl_graph/ingest/pipeline.py`) orchestrates a multi-phase process:
- **Phase A**: Load sources → persist chunks to SQLite → embed chunks to Qdrant
- **Phase B.1**: LLM extraction (per-chunk, cached to disk)
- **Phase B.2**: Graph build (entities, facts, embeddings, edges)
- **Improve**: Similarity edges, community detection, disambiguation, summarization

If the user powers off or the process crashes mid-pipeline, we want to resume from where we left off without re-doing expensive work. Some resilience already exists (per-chunk extraction cache, Qdrant point-id dedup), but there's no unified checkpoint that tracks which *pipeline steps* completed.

**Symptoms of missing checkpoints:**
- A crash during Phase B.2 (e.g., after entities are built but before edges) causes the next canonical runner invocation to re-run all of Phase B.2 — re-upserting entities (inflating `mention_count`), re-building facts, re-embedding things that Qdrant already has (wasted CPU on dedup checks).
- The improve phase has no step-level tracking — a crash at community detection re-runs similarity from scratch.

---

## 2. Storage Architecture: Where Data Lives

The pipeline interacts with storage exclusively through the `KnowledgeStore` abstraction (`kl_graph/storage/base.py`). The checkpoint system is built against this abstraction — it uses `store.count_chunks()`, `store.count_entities()`, etc. for verification and never touches SQLite/LadybugDB directly.

| Store | Abstraction | Write Mode | Read Visibility |
|-------|-------------|-----------|-----------------|
| **KnowledgeStore** | `kl_graph/storage/base.py` (ABC) | Each `insert_*` / `upsert_*` commits atomically | Immediately visible to the retrieval server |
| **QdrantStore** | `kl_graph/storage/qdrant_store.py` | `upsert_batch` commits per 256-point batch | Immediately visible |
| **Extraction cache** | Filesystem (JSON per chunk) | Written per-chunk after successful LLM call | Only consumed by the pipeline itself |
| **Checkpoint** | Single JSON file | Written atomically (write-tmp + rename) | Only consumed by the pipeline itself |

**Concrete backends for KnowledgeStore:**
- `SQLiteStore` — WAL mode, each `insert_*` does its own `conn.commit()`
- `LadybugStore` — delegates structured data to SQLite, graph paths to Kuzu fork

**Key property:** Both KnowledgeStore implementations and Qdrant make data visible immediately on commit. There is no "staging area" concept — the retrieval server (`kl_server.py`) reads the same stores that the pipeline writes to, and it sees partial results as they're committed.

---

## 3. Transaction Boundaries & Commit Points

### Design Choice: Progressive Commit vs Cache-then-Commit

| Approach | Crash Behavior | Server Consistency | Resume Cost |
|----------|---------------|-------------------|-------------|
| **Progressive commit** | Crash mid-step → partial data in store; resume re-runs step, idempotent inserts handle overlap | Server may see partial state during ingestion | O(n) no-op inserts for already-committed items |
| **Cache-then-commit** | Crash mid-step → nothing written to store; all work lost | Server always sees a consistent snapshot | Full re-do of the crashed step from scratch |

**We use BOTH patterns**, choosing per step based on the step's characteristics (see Step Commit Taxonomy below).

### Step Commit Taxonomy

Each pipeline step falls into one of three patterns:

#### Pattern A: Single-Transaction Steps (all-or-nothing)

The step performs ONE `store.insert_*` / `store.upsert_*` call. KnowledgeStore implementations wrap this in a single DB transaction. Either all rows commit or none do. **There is no partial state on crash.**

| Step | Store Call | Row Count | Crash Behavior |
|------|-----------|-----------|----------------|
| `persist_chunks` | `store.insert_chunks_with_units(chunks, units, memberships)` | ~5000 | Chunks, source units, and ordered mappings commit together or all roll back |
| `persist_scopes` | `store.insert_scopes(scopes)` | ~100 | All or nothing |
| `build_entities` | `store.upsert_entities(entity_list)` | ~5000 | All or nothing |
| `build_facts` | `store.insert_facts(all_facts)` | ~17000 | All or nothing |

**On crash before commit:** Transaction rolls back. No data in store. Step re-runs from scratch on resume.
**On crash after commit:** All data is in store. Checkpoint marks done. Step skips on resume.
**On resume (step not checkpointed):** Re-runs the full step. `INSERT OR IGNORE` makes it idempotent — already-committed rows are no-ops. Exception: `upsert_entities` inflates `mention_count` if re-run after a successful commit, which is why the checkpoint is critical for this step.

#### Pattern B: Batched-Progressive Steps (commit in chunks, resume via dedup)

The step makes multiple store calls, each committing a batch. A crash between batches leaves partial-but-consistent data. Resume uses dedup to skip already-committed items.

| Step | Batch Size | Dedup Mechanism | Resume Cost |
|------|-----------|-----------------|-------------|
| `create_edges` | 10K edges per `store.insert_edges()` | UNIQUE constraint → `INSERT OR IGNORE` | Re-build edge list in memory (~1s), then O(n) no-op inserts for committed batches |
| `embed_chunks` | 1000 points per `qdrant.upsert_batch()` | `qdrant.existing_ids()` check before embedding | At most 1000 items re-embedded (the unflushed tail) |
| `embed_graph` | 1000 points per `qdrant.upsert_batch()` | `qdrant.existing_ids()` check | Same |

**On crash between batch 3 and batch 4:** Batches 1-3 are committed and safe. Batch 4+ items are lost.
**On resume:** Step re-runs. For edges: the full edge list is rebuilt, all batches are re-inserted — batches 1-3 hit `INSERT OR IGNORE` (no-op), batch 4+ inserts normally. For embeddings: `existing_ids()` returns the IDs already in Qdrant, only the remainder gets re-embedded.

#### Pattern C: Cache-First Steps (expensive work, deferred commit to store)

The step performs expensive work (LLM $$) and writes each result to a per-item **disk cache**. The results are NOT written to KnowledgeStore until a later step reads the cache. This is the **only pattern that doesn't commit progressively to the main store** — it intentionally keeps results in a "staging" cache.

| Step | Cache Location | Who Reads the Cache | Why Cache Instead of Direct Commit |
|------|---------------|--------------------|------------------------------------|
| `extraction` (B.1) | `data/extraction_cache/<xx>/<md5>.json` | `build_entities`, `build_facts`, `create_edges` | $$$ LLM calls; cache enables re-running graph build with different logic without re-extracting; per-item granularity means crash loses at most 1 item |
| `disambiguation` | Internal LLM judge results | Entity merge logic | LLM calls; per-pair decisions should be preserved across reruns |

**On crash:** Items cached so far are safe on disk. Un-cached items are retried on the next run.
**On resume:** `_read_cache()` finds existing files → skips those items. Only the un-cached tail hits the LLM.

### When to Use Which Pattern (Rule for Future Steps)

| Condition | Pattern | Example |
|-----------|---------|---------|
| Step output goes directly to KnowledgeStore AND row count fits in one transaction (~50K rows) | **A** (single-transaction) | `build_facts` |
| Step output goes to KnowledgeStore AND row count is large (>50K) or the store call is slow | **B** (batched-progressive) | `create_edges` (73K edges in 10K batches) |
| Step output goes to QdrantStore (vectors) | **B** (batched-progressive with `existing_ids`) | `embed_chunks` |
| Step uses LLM ($$$) AND its output feeds a later pipeline phase | **C** (cache-first) | `extraction`, `disambiguation` |
| Step is fast (<30s) and computes everything in memory before writing | **A** (single-transaction at end) | `community detection → project` |

### Specific Scenarios

**Q: "If we insert 10 chunks and crash, we will re-insert these 10 on restart?"**

A: `persist_chunks` is Pattern A (single-transaction). The 10 chunks are part of a `store.insert_chunks(5000_chunks)` call that wraps all 5000 in one transaction. Either all 5000 commit or none do. On restart, if the transaction didn't commit, the step re-runs and re-inserts all 5000 (which are all new → fast). If it DID commit, the checkpoint marks the step done and it's skipped.

**Q: "What about batched edge insertion? If batch 1-3 committed and batch 4 didn't?"**

A: `create_edges` is Pattern B. On restart, the step re-runs from scratch: rebuilds the full edge list in memory (~1s), then re-inserts all batches. Batches 1-3 hit `INSERT OR IGNORE` (no-op, fast). Batch 4+ inserts normally. Total resume cost: ~2s for the no-op inserts + normal insert time for the remainder.

**Q: "What about partial Qdrant embeddings?"**

A: Embedding steps are Pattern B. On restart, `existing_ids()` queries Qdrant for which point IDs exist. Already-embedded items are skipped. Only the remainder gets re-embedded. Worst case: at most `EMBED_FLUSH_EVERY` (1000) items need re-embedding.

**Q: "Should we wrap the entire graph-build (entities + facts + edges) in one mega-transaction?"**

A: No. These are three separate steps, each with its own checkpoint. A mega-transaction would: (a) hold a write lock for minutes; (b) lose ALL work on any crash during any sub-step; (c) prevent resuming from the middle. The per-step approach means a crash after entities+facts but during edges only re-runs edges, not the whole thing.

**Q: "Is the server harmed by seeing entities without edges?"**

A: No. The retrieval server handles missing neighbors gracefully — graph walks that hit a node with no outgoing edges simply stop there. It returns *fewer* results temporarily, not *wrong* results. This is acceptable during a build that takes a few minutes.

### Cross-Database Consistency (LadybugStore Dual-Write)

The `LadybugStore` backend writes to **two** databases: SQLite (content + FTS) and LadybugDB (graph nodes + edges). There is no distributed transaction between them. A single `store.insert_chunks(chunks)` does:

1. `self._sqlite.insert_chunks(chunks)` — one SQLite transaction (atomic)
2. `for c in chunks: self._graph.upsert_chunk_node(c.id, ...)` — progressive per-item writes to LadybugDB

**Can this diverge?** Yes:
- Crash after SQLite commit but during LadybugDB loop → SQLite has all chunks, LadybugDB has partial nodes
- Crash during SQLite transaction but before commit → neither database has the data

**Is divergence dangerous?** No, for our pipeline:
- **SQLite is authoritative** for content — the retrieval server hydrates chunks/entities/facts from SQLite. LadybugDB only holds graph-traversal nodes (no content blobs).
- **LadybugDB edges `MATCH` both endpoints** — an edge insert fails silently if the target node is missing. So if a chunk node is missing from LadybugDB, its PART_OF/TEMPORAL/REPLY_TO edges simply don't get created. On re-run, the missing nodes are upserted, then edges succeed.
- **All LadybugDB writes are idempotent** — `upsert_*_node()` uses `MERGE` semantics (create-or-update). Re-running with the same data is a no-op.

**On resume after a crash between the two DBs:**
1. The step is NOT checkpointed (it didn't complete)
2. Step re-runs from scratch
3. SQLite hits `INSERT OR IGNORE` for already-committed rows (no-op)
4. LadybugDB receives all upserts again — already-existing nodes are overwritten (same data), missing ones are created
5. Both DBs converge to the correct state

**No additional mechanism needed.** The dual-write pattern + idempotent upserts + "checkpoint only on full completion" guarantee that both databases converge on resume. We do NOT attempt cross-DB transactions (which would require 2PC or a saga pattern — unnecessary complexity for this workload where convergence-on-retry is sufficient).

**KnowledgeStore ABC contract for future backends:** Any new backend implementation MUST ensure that its `insert_*` / `upsert_*` methods are safe to re-call with the same data (idempotent or at-least-once with no corruption). The checkpoint system relies on this property.

| Step | Commits To | Commit Granularity | Checkpoint After | Notes |
|------|-----------|-------------------|------------------|-------|
| `phase_a.persist_chunks` | KnowledgeStore | `insert_chunks_with_units` (one SQLite transaction) | All chunks, unit lineage, and batch workset persisted | `chunks`, `units`, `chunk_units`, and `ingest_batch_chunks` are one commit point; a DB-ready/checkpoint-incomplete retry hydrates the DB workset |
| `phase_a.persist_scopes` | KnowledgeStore | `insert_scopes` (one call) | (bundled with persist_chunks) | Re-run is no-op |
| `phase_a.embed_chunks` | QdrantStore | Every `EMBED_FLUSH_EVERY` points (~1000) | All points flushed | Crash mid-step: Qdrant has partial points; resume skips them via `existing_ids()` |
| `phase_b.extraction` | Filesystem (cache) | Per-chunk JSON file | All chunks cached | Crash mid-step: next run finds existing cache files → skips those chunks |
| `phase_b.build_entities` | KnowledgeStore | `upsert_entities` (one call) | All entities upserted | **Must not re-run without reset** (mention_count inflates per ABC contract) |
| `phase_b.build_facts` | KnowledgeStore | `insert_facts` (one call) | All facts inserted | Re-run is no-op (duplicate-ignore semantics per ABC) |
| `phase_b.embed_graph` | QdrantStore | Every `EMBED_FLUSH_EVERY` points | All entity + fact points flushed | Crash mid-step: resume via `existing_ids()` |
| `phase_b.create_edges` | KnowledgeStore | `insert_edges` per 10K batch | All edges inserted | Re-run is no-op (unique constraint per ABC) |
| `improve.fact_similarity` | KnowledgeStore (edges) | `insert_edges` (one call) | Step returns | Edges are duplicate-ignored; safe to re-run but wasteful |
| `improve.entity_similarity` | KnowledgeStore (edges) | `insert_edges` (one call) | Step returns | Same |
| `improve.disambiguation` | KnowledgeStore (entities + edges) | Per-merge upsert | Step returns | Uses LLM; expensive to re-run |
| `improve.communities` | KnowledgeStore (community columns + nodes + edges) | Bulk at end | All detection + store + project complete | Delete-and-rebuild; entity + fact communities grouped as one unit |
| `ingest.complete` | Checkpoint + KnowledgeStore | Checkpoint first, workset cleanup second | Every requested phase and finalizer succeeded | Failed runs retain `ingest_batch_chunks`; cleanup is idempotently retried after a completion/cleanup crash |

### Which steps keep results in cache vs. writing directly?

| Result Type | Storage Strategy | Why |
|------------|-----------------|-----|
| **LLM extraction results** | Written to **disk cache** only (not SQLite) until Phase B.2 reads them | Extraction is the most expensive step ($$). Keeping it on disk means: (a) you can re-run graph build with different logic without re-extracting; (b) a crash loses at most one chunk's result; (c) the cache is the replayability guarantee. |
| **Entities (in-memory dict)** | Held in `self.all_entities` dict during build, then flushed to SQLite at end of `_build_entities` | Entities are merged in memory (same name → same node). Writing to SQLite per-chunk would require incremental upserts, which is slower and harder to get right. The single bulk `upsert_entities` call is the commit point. |
| **Facts** | Accumulated in `self.all_facts` list, then bulk-inserted to SQLite | Same rationale as entities — bulk is faster and facts use INSERT OR IGNORE. |
| **Edges** | Accumulated in a list inside `_create_edges`, then bulk-inserted in 10K batches | Edges depend on both entities and facts existing. Building them all in memory then flushing guarantees referential consistency within the batch. |
| **Community assignments** | Written to SQLite entity/fact columns directly, then projected to Community nodes + COMM_MEMBER edges | The community step needs the full entity/fact graph to compute clusters. Results are written in bulk at the end. |

### Rule for future steps

When adding a new pipeline step:
1. **If the step produces data consumed only by later pipeline steps** → write to disk cache (like extraction). This maximizes replayability.
2. **If the step produces data consumed by the retrieval server** → write directly to SQLite/Qdrant with progressive commits. Mark checkpoint only after full completion.
3. **If the step uses LLM** → ensure per-item caching so a crash doesn't lose completed LLM calls (like the extraction cache pattern, or the disambiguation cache).
4. **If the step is expensive but has no per-item cache** → it MUST have a checkpoint entry. On re-run, the checkpoint skip avoids repeating the work.

---

## 4. Checkpoint Design

### 4.1 File Location & Format

**Path:** `data/ingest_checkpoint.json` (alongside `knowledge.db`)

```json
{
  "version": 1,
  "source_hash": "sha256:a1b2c3...",
  "created_at": "2026-08-03T10:00:00Z",
  "steps": {
    "phase_a.persist_chunks": {"status": "done", "ts": 1722700010, "count": 5361},
    "phase_a.embed_chunks": {"status": "done", "ts": 1722700120, "count": 5361},
    "phase_b.extraction": {"status": "done", "ts": 1722700500, "count": 5361},
    "phase_b.build_entities": {"status": "done", "ts": 1722700510, "count": 5361},
    "phase_b.build_facts": {"status": "done", "ts": 1722700520, "count": 17000},
    "phase_b.embed_graph": {"status": "done", "ts": 1722700600},
    "phase_b.create_edges": {"status": "done", "ts": 1722700650, "count": 73000},
    "improve.fact_similarity": {"status": "done", "ts": 1722701000, "params": {"threshold": 0.85}},
    "improve.entity_similarity": {"status": "done", "ts": 1722701100, "params": {"embedding_threshold": 0.65, "hybrid_threshold": 0.45}},
    "improve.disambiguation": {"status": "done", "ts": 1722701200, "params": {"skip_llm": false, "llm_max_budget": 500}},
    "improve.communities": {"status": "done", "ts": 1722701500, "params": {"entity_resolution": 2.0, "fact_resolution": 1.5, "fact_min_cluster_size": 5}}
  }
}
```

### 4.2 Source Hash (Invalidation Key)

The `source_hash` is a fast content fingerprint computed from:
- Sorted list of all source file paths (relative to export root) + their byte sizes + mtime (as integer)
- SHA-256 of the concatenated manifest

**Semantics:** If the hash changes, the checkpoint file is discarded and the pipeline starts fresh. This catches file additions, deletions, and modifications.

**Why not hash file contents?** Too slow for large exports. Stat-based fingerprinting is O(n) stat calls which completes in <100ms for our ~20K files. It may false-positive (mtime changed but content didn't), which just means an unnecessary full rebuild — safe, not lossy.

### 4.3 Checkpoint Write Protocol

```
1. Step starts executing
2. Step writes data progressively to SQLite/Qdrant (committed)
3. Step completes successfully
4. Write checkpoint to temp file (data/ingest_checkpoint.json.tmp)
5. Atomic rename: tmp → data/ingest_checkpoint.json
```

If the process dies between step 3 and step 5, the step is NOT marked done and will re-run. This is the intended behavior — the cost of re-running a completed step is minimal (all inserts are idempotent) vs. the cost of marking it done before it finishes (could skip an incomplete step).

**Exception:** `phase_b.build_entities` is NOT fully idempotent (mention_count inflates on re-upsert). The checkpoint prevents this: if entities are done, we skip the step. If the process crashes during entity building (between step 2 and 3), mention counts may be partially inflated. This is acceptable — the counts are approximate anyway and a fresh `--fresh-db` rebuild is the fix for exact counts.

### 4.4 Checkpoint Class API

```python
# kl_graph/ingest/checkpoint.py

class IngestCheckpoint:
    """Step-level checkpoint for resumable ingestion."""
    
    def __init__(self, path: Path, source_dirs: list[Path]):
        """Load or create checkpoint. Invalidates if source_hash changed."""
    
    def is_done(self, step: str, *, params: dict | None = None) -> bool:
        """True if step completed in this checkpoint epoch (with matching params)."""
    
    def mark_done(self, step: str, *, params: dict | None = None, **meta) -> None:
        """Mark step complete. Flushes to disk atomically."""
    
    def clear_prefix(self, prefix: str) -> None:
        """Clear all steps starting with prefix (e.g., 'improve.')."""
    
    def reset(self) -> None:
        """Clear all steps. Used on --fresh-db or source change."""
    
    def delete(self) -> None:
        """Delete the checkpoint file from disk."""
    
    @property
    def source_hash(self) -> str:
        """The computed source fingerprint for this run."""
```

### 4.5 Integration Pattern

Each pipeline method:

```python
def _build_entities(self):
    if self.checkpoint and self.checkpoint.is_done("phase_b.build_entities"):
        self._ensure_entities_loaded()
        print("  [checkpoint] build_entities — skipping (already done)")
        return
    # ... existing logic (build + upsert) ...
    if self.checkpoint:
        self.checkpoint.mark_done("phase_b.build_entities", count=len(self.all_entities))
```

**Critical pattern for steps with in-memory accumulators:** When a step is skipped, the pipeline may still need the step's *output* in memory for downstream steps. For example, `_create_edges` needs `self.all_entities` and `self.extraction_results`. If `build_entities` was checkpointed, we must reload entities from the store. This requires an `_ensure_*_loaded()` helper for each skipped step that has downstream dependents:

| Skipped Step | Downstream Needs | Reload Strategy |
|-------------|-----------------|-----------------|
| `build_entities` | `self.all_entities` dict | `store.iter_all_entities()` → load into dict by id |
| `build_facts` | `self.all_facts` list | `store.iter_all_facts()` → collect into list |
| `extraction` | `self.extraction_results` dict | Load from disk cache (`_load_extraction_cache`) — already exists |
| `persist_chunks` | `self.messages`, `self.extra_chunks` | Already loaded by `_load_sources()` — no store query needed |

**Abstract methods on `KnowledgeStore`:**

```python
@abstractmethod
def iter_all_entities(self) -> Iterator[Entity]:
    """Iterate over all stored entities. Used for checkpoint reload."""

@abstractmethod
def iter_all_facts(self) -> Iterator[Fact]:
    """Iterate over all stored facts. Used for checkpoint reload."""
```

These are simple full-table scans, trivial to implement on both SQLiteStore and LadybugStore (both back entities/facts with the same SQLite tables). They're only called on resume (when a step is skipped), so they're not on the hot path.

---

## 5. Handling the Improve Phase

The improve steps form a dependency chain:

```
fact_similarity ─────────────────┐
entity_similarity ───────────────┤
disambiguation ──────────────────┤→ communities (entity + fact + store + project)
```

**Key behavior:** Improve steps are NOT incremental — they delete old results and rebuild. Specifically:
- `build_fact_similarity_edges` / `build_entity_similarity_edges`: delete old FACT_SIMILAR / ENTITY_SIMILAR edges, then insert new ones.
- `project_community_membership_edges`: deletes all Community nodes + COMM_MEMBER edges, then rebuilds.

**Implication:** If improve steps are checkpointed, re-running with different thresholds requires clearing the improve checkpoints. The `--reset-checkpoint improve` flag handles this.

**Parameter recording:** The checkpoint for improve steps records the parameters used:

```json
"improve.entity_similarity": {
    "status": "done", "ts": ...,
    "params": {"embedding_threshold": 0.65, "hybrid_threshold": 0.45}
}
```

On resume, if the requested parameters differ from what's recorded, the step re-runs (the old checkpoint entry is invalidated).

**Community steps grouping:** Entity communities, fact communities (HDBSCAN + Leiden), store, and project are a single checkpoint unit (`improve.communities`). Since they delete-and-rebuild, partial community state is inconsistent — either all are done or all must re-run.

---

## 6. CLI Integration

| Flag | Effect |
|------|--------|
| `--fresh-db` | Deletes SQLite + Qdrant + checkpoint file (complete restart) |
| `--reset-checkpoint` | Clears all checkpoint entries (re-runs everything with idempotent inserts) |
| `--reset-checkpoint improve` | Clears only `improve.*` steps (re-runs improve with potentially new params) |
| `--no-checkpoint` (improve.py) | Run without checkpoint (ignore and don't update) |

---

## 7. Files Modified

| File | Change |
|------|--------|
| `kl_graph/ingest/checkpoint.py` | **NEW** — `IngestCheckpoint` class + helpers (`checkpointed`, `checkpoint_step`, `run_if_needed`) |
| `kl_graph/storage/base.py` | Added `iter_all_entities()` and `iter_all_facts()` abstract methods |
| `kl_graph/storage/sqlite_store.py` | Implemented `iter_all_entities()` and `iter_all_facts()` |
| `kl_graph/storage/ladybug_store.py` | Delegating `iter_all_entities()` and `iter_all_facts()` to SQLite layer |
| `kl_graph/ingest/pipeline.py` | Checkpoint param, guards + `mark_done` on each step, `_ensure_*_loaded()` helpers |
| `kl_graph/periodic/runner.py` | Accept checkpoint param, `run_if_needed` for similarity/disambiguation, grouped community checkpoint |
| `scripts/ingest.py` | Checkpoint init, `--reset-checkpoint` flag, `--fresh-db` clears checkpoint |
| `scripts/improve.py` | Checkpoint init, `--reset-checkpoint` and `--no-checkpoint` flags |
| `kl_graph/config.py` | Added `CHECKPOINT_PATH = DATA_DIR / "ingest_checkpoint.json"` |

---

## 8. Edge Cases

1. **Crash during embedding flush**: Qdrant has partial points. Step is NOT checkpointed. On resume, `existing_ids()` skips what's already there; only the remaining points get embedded. Checkpoint marks done only after full completion.

2. **Source data changes between runs**: Source hash changes → checkpoint discarded → full rebuild. This is correct: adding/removing source files invalidates all downstream state.

3. **Partial extraction (crash at 2000/5000 chunks)**: Extraction step is NOT checkpointed (didn't finish). On resume, `_read_cache` finds 2000 cache files, skips those, extracts only the remaining 3000. Then marks extraction done.

4. **`upsert_entities` mention_count inflation**: Only happens if the step re-runs after partial completion. The checkpoint prevents normal re-runs. A crash mid-step may cause slight inflation for entities that were upserted before the crash — acceptable since counts are approximate.

5. **Concurrent pipeline instances**: Not supported. SQLite single-writer lock prevents corruption. The checkpoint file is also not safe for concurrent access. Only one pipeline process should run at a time.

6. **Improve with different parameters**: Parameters are recorded in the checkpoint. A mismatch triggers re-execution of that step.

7. **Checkpoint=None (backward compatibility)**: When no checkpoint is passed to the pipeline, all steps run unconditionally — the same behavior as before this feature was added.

---

## 9. Verification Plan

1. Run full ingest, `kill -9` during entity embedding (mid Phase B.2)
2. Re-run → verify `[checkpoint] skipping persist_chunks, embed_chunks, extraction, build_entities, build_facts` and resumes at `embed_graph`
3. Verify final entity/fact/edge counts match a clean build
4. Touch a source file (change mtime) → re-run → verify checkpoint invalidates, full rebuild fires
5. Run with `--fresh-db` → verify checkpoint also cleared
6. Run `--improve-only` with different threshold → verify improve steps re-run
7. Run `--improve-only` with same threshold → verify `[checkpoint] skipping` for all improve steps

---

## 10. Reusable Helpers & Extension Pattern

### Shared Checkpoint Helpers

Rather than manually adding `if checkpoint.is_done(...): return` + `checkpoint.mark_done(...)` in every step, `kl_graph/ingest/checkpoint.py` provides reusable helpers:

```python
@contextmanager
def checkpointed(checkpoint, step, *, skip_msg="", params=None):
    """Context manager: yields False if already done, True if should run.
    Marks done on clean exit from the True branch."""

def checkpoint_step(step, *, skip_msg=""):
    """Decorator for pipeline methods that don't need reload logic on skip."""

def run_if_needed(checkpoint, step, fn, *args, params=None, **kwargs):
    """Run fn only if step isn't checkpointed with matching params."""
```

### Ensure-Loaded Helpers (for steps with downstream dependents)

Steps that produce in-memory state consumed by later steps need a reload helper on `IngestionPipeline`:

```python
def _ensure_entities_loaded(self):
    """Load from store if not already in memory."""
    if self.all_entities:
        return
    self.all_entities = {e.id: e for e in self.store.iter_all_entities()}

def _ensure_facts_loaded(self):
    if self.all_facts:
        return
    self.all_facts = list(self.store.iter_all_facts())

def _ensure_extraction_loaded(self):
    if self.extraction_results:
        return
    self._load_extraction_cache()
```

### Adding a New Step (Checklist)

When adding a new pipeline step, follow this checklist:

1. **Decide the commit pattern** (A/B/C) per the rules in Section 3.
2. **Register the step name** in this design doc (Section 3, Transaction Table).
3. **Implement the step** using either:
   - Manual `is_done` / `mark_done` (steps with reload logic)
   - `@checkpoint_step("name")` decorator (simple steps, no downstream dependents)
   - `run_if_needed()` for standalone functions (periodic runner steps)
4. **If the step has downstream dependents:** add a `_ensure_X_loaded()` helper and document it in Section 4 (Reload Strategy table).
5. **If the step uses LLM:** ensure per-item caching (Pattern C) so crashes don't lose completed LLM calls.
6. **If the step accepts tunable parameters:** use `params` kwarg so parameter changes trigger re-execution.
7. **Wire it into the pipeline orchestrator** (`run_graph_build`, the canonical ingestion runner, or the periodic runner).
8. **Add to `scripts/ingest.py`** if independently runnable.
9. **Update this document** (add to the Transaction Table, Edge Cases if relevant).
