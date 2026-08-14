# Ingestion Recovery & Rescue Design

> **This document is the source of truth** for how a stuck or half-finished
> ingestion round is diagnosed, resumed, or — when its workset cannot be
> rebuilt — skipped while the accumulated graph is preserved (with an explicit
> snapshot restore available as a separate, user-driven action). It also fixes
> the durable-state boundary that made the
> "no durable workset" failure permanent. Update this document first when
> changing recovery behavior, the checkpoint's storage location, or the
> round-start identity/timestamp contract.

Related: `docs/checkpoint-design.md` (checkpoint step semantics),
`docs/ingestion-artifact-dependencies.md` (workset lifecycle),
`docs/ingest-api.md` (server endpoints),
`docs/rescue-api.md` (rescue endpoints + per-case behavior reference).

---

## 1. The failure we are fixing

Observed symptom (real field incident, desktop side documented at
`apps/desktop/src/main/services/kl-server.service.ts` around the
`wipeGraphData` block):

```
建图失败：Checkpoint batch '<uuid>' has no durable workset;
run Phase A before any chunk-dependent phase
```

Raised at `kl_graph/ingest/pipeline.py` in `_load_workset()` when
`store.get_ingest_batch(self.batch_id)` returns `None` on a resumed
chunk-dependent phase.

### 1.1 Root cause: two files with independent lifetimes

The resume state is split across two artifacts that can be mutated
independently:

- **The checkpoint** — today `ingest_checkpoint.<source_id>.json` on disk.
  It records `batch_id` (a uuid4 minted at checkpoint init, in
  `checkpoint.py:reset()`) and which steps completed
  (`phase_a.persist_chunks` = done).
- **The durable workset** — a row in the `ingest_batches` table (plus its
  `ingest_batch_chunks` / `_extraction_items` / `_extraction_projections`
  children) inside `knowledge.db`.

Delete the DB but leave the checkpoint JSON (exactly what a "clear graph and
rebuild" flow used to do) and the next run reads "Phase A already done", skips
Phase A, jumps to a chunk-dependent phase, calls `_load_workset()`, finds no
row, and raises. Clearing the DB *again* does not help, because the checkpoint
survives every time. The error asserts one cause ("run Phase A") but the code
path is reached by several distinct situations, so the message alone cannot
tell "stale file" from "genuinely broken ingestion".

### 1.2 Why kl's single-run ordering is already sound

Within one process there is no window that leaves "Phase A done" pointing at a
missing workset:

- `_persist_chunks()` (`pipeline.py`) marks the step done (`s.done()`, in the
  `step()` context `__exit__`) **only after** `insert_chunks_with_units(...)`
  returns.
- That store call commits the whole workset in one `with self.conn:`
  transaction (`sqlite_store.py:656-819`): `INSERT ingest_batches state='preparing'`
  → chunks → `ingest_batch_chunks` + items/projections →
  `UPDATE ingest_batches SET state='ready'`.
- A crash between the two → batch committed but the checkpoint step not marked
  → the next run simply re-runs Phase A. No corruption.

So a `None` workset with `phase_a.persist_chunks=done` is almost always
**external mutation** (DB wiped/swapped, rows deleted, a checkpoint/DB pair that
do not belong together), not kl breaking mid-flight. "Almost always" is not
"provably", which is why recovery must **read durable state and classify**,
never guess.

### 1.3 What cannot be undone logically (the reason a snapshot must exist)

Ingestion mutates existing rows and does not keep the old values, so a
"delete everything newer than round start" logical undo is inherently partial:

- **`entities` are merged, not just inserted** (`sqlite_store.py:165-174`):
  a pre-existing entity touched by a round gets `mention_count` bumped,
  `last_seen` advanced, `description` regenerated. No `run_id`, no pre-merge
  copy — unrecoverable by any timestamp filter.
- **Timestamps are content time, not ingest time**: `facts.timestamp` /
  `chunks.timestamp` are the message date, not when we ingested. A wall-clock
  "later than round start" filter deletes by when the conversation happened —
  the wrong axis.
- **Edges live in `graph.ladybug`** (Kuzu) under the default backend; the
  SQLite `edges` table is empty by design. Similarity edges, communities and
  PageRank are global recomputes with no per-round provenance.

Conclusion: the only thing that can truly restore "the state before this round"
is a **pre-round backup**. Logical deletion can never fully reverse a round.
kl therefore does not attempt lossy logical undo; it guarantees a **restore
point identity** and leaves the copy to the wrapper (see §3).

---

## 2. Durable-state fix: fold the checkpoint into `knowledge.db`

Move the checkpoint out of the sidecar JSON and into an `ingest_checkpoint`
table in `knowledge.db`.

- New table `ingest_checkpoint`, keyed by `source_id`, mirroring today's JSON
  fields: `version`, `source_hash`, `batch_id`, `workset_schema`, `steps`
  (JSON), `created_at`.
- **Atomicity is the whole point.** `phase_a.persist_chunks` is marked done in
  the **same transaction** as the workset write (`insert_chunks_with_units`,
  `sqlite_store.py:656-819`). "Phase A done" and "the workset exists" become a
  single commit and can no longer disagree. The `_flush()` write-tmp+rename
  dance in `checkpoint.py` goes away.
- **Wipe consistency for free.** Dropping/clearing `knowledge.db` takes the
  checkpoint with it. The "stale JSON over a wiped DB" class becomes
  structurally impossible; the desktop `wipeGraphData` no longer has to keep a
  file-deletion list in sync.
- **Migration**: on open, if a legacy `ingest_checkpoint.<source_id>.json`
  exists and the table has no row for that `source_id`, import it, then delete
  the JSON. Idempotent and one-way.
- **Operator access**: a `kl checkpoint show|reset` subcommand replaces
  hand-editing the file (the JSON is no longer there to edit).

Scope note: this collapses **checkpoint ↔ `knowledge.db`** disagreement only.
It does not make `knowledge.db` consistent with `graph.ladybug` / `qdrant_data`
— those are separate engines. Cross-engine consistency is what the snapshot
identity in §3 and the restore path in §5 cover.

---

## 3. The round-start identity contract (kl's non-negotiable scalar)

kl owns exactly one durable fact per ingestion round, and nothing about the
copy itself:

- **`ingestion_id`** — the round's unique id. This is the existing `batch_id`
  (uuid4, PK of `ingest_batches`, minted at round start; carried by the
  `ingest_checkpoint` table after §2). Unique per round, durable.
- **`round_started_at`** — the round-start timestamp scalar, persisted on a
  **durable parent row**, not in the torn-down workset.

Both are written together in the **same round-start transaction** that inserts
the `ingest_batches` row (`sqlite_store.py:662-668`), so the id and its
timestamp cannot diverge.

### 3.1 Persistence (constraint: not in the temporary workset)

`complete_ingest_batch` (`sqlite_store.py:867-891`) deletes only the workset
*children* (`ingest_batch_chunks`, `_extraction_items`, `_extraction_projections`)
and flips the parent `ingest_batches` row to `state='complete'`. The **parent
row survives**. Therefore:

- Add `round_started_at INTEGER NOT NULL` to `ingest_batches`, set once in the
  round-start INSERT. It is deliberately distinct from `created_at` (whose
  semantics could drift) and lives on the row that outlives the workset, so it
  is readable for the entire life of the round — before and after success.
- `ingest_runs.started_at` (`sqlite_store.py:328`, `run_id` PK, never deleted)
  is the run-level durable mirror already surfaced by `/status`.

### 3.2 Ownership split

- **kl owns the identity**: `{ingestion_id, round_started_at}`, minted together
  at round start, on a row that outlives the workset, returned together by the
  recovery endpoints (§4).
- **The wrapper owns the full backup policy**: whether to copy, the copy
  mechanism, where it lives, retention/rotation, disk budget, and the actual
  restore. It keys every backup on `ingestion_id` and labels it with
  `round_started_at`.

kl does **no** file copying, `VACUUM INTO`, Kuzu `CHECKPOINT`-for-backup, or
retention. Its only contribution to *consistency of the wrapper's copy* is a
graceful quiesce (§4.2) so the wrapper copies/restores files that are not
mid-write.

---

## 4. Server surface

### 4.1 Recovery info (read-only)

A read endpoint returns, for the current/last round:

```
{
  "ingestion_id": "<batch_id>",
  "round_started_at": <epoch_seconds>,
  "store_paths": [ "<abs path to knowledge.db>", "graph.ladybug", ... ],
  "recovery_tier": "resume" | "cleanup" | "ok"
}
```

`store_paths` are the five stores under `data_dir` (`knowledge.db` (+`-shm`,
`-wal`), `graph.ladybug` (+`.wal`), `qdrant_data/`, `extraction_cache.db`).
Paths are returned only to the local wrapper over localhost and never logged or
echoed elsewhere (AGENTS.md §1). The wrapper uses these to copy/restore against
`ingestion_id`.

### 4.2 Graceful stop / quiesce

Stopping the running or stuck job must release DB handles so the wrapper can
copy or restore files that are not mid-write. The desktop already relies on
"stop the server before touching files"; this formalizes it: stop the job →
close SQLite / Kuzu / Qdrant connections → report done. This quiesce is kl's
only correctness contribution to the wrapper's copy being consistent.

### 4.3 One stop endpoint, no cleanup variant

`POST /ingest/stop` (§4.2) is the **only** rescue action endpoint. There is no
`stop-and-cleanup` or destructive variant — an earlier draft had one, but its
only behavior beyond `stop` was writing a durable "no deletion happened" warning,
and once the A/B/C/D cases self-heal or skip automatically (§5) that endpoint had
no distinct job left. It was removed to keep the surface minimal.

kl therefore never restores anything (it holds no copy) and never does lossy
logical deletion. Rolling back a round is entirely the wrapper's job: it restores
the backup it filed under `ingestion_id` (identity from §4.1, quiesce from §4.2).
If the wrapper never took a backup at that identity there is nothing to restore
to — and, as of today, **the wrapper-side backup/restore is not yet
implemented**, so a skipped round's facts are simply lost until it is (stated per
AGENTS.md §4 so the "restore a snapshot" advice is not read as a working
feature). kl's implemented half of the contract is the identity + `store_paths`
(what to back up) and the graceful quiesce (a safe moment to copy/restore).

---

## 5. Recovery flow (priority order)

**diagnose → resume → skip the round (keep the accumulated graph).** The main
deployment is high-frequency incremental ingestion, so the graph is a long-lived
accumulation. When a single round's workset cannot be reconstructed, the default
is to *skip that one round* — not to stop the service and not to rebuild the
whole database. A full wrapper-restore (§4.3) is the intended explicit,
user-driven fallback, but it is not the automatic recovery path (and is not yet
implemented on the wrapper).

### 5.1 Diagnose — classify from durable state

Read the checkpoint row (`ingest_checkpoint`), `ingest_batches`, content counts
(`count_chunks` / `count_messages` / entity / fact / edge counts), and whether
the source export is still on disk. Classify:

| Case | Signals | Meaning |
|------|---------|---------|
| **A** | checkpoint says Phase A done, `ingest_batches` empty, `count_chunks==0` | stale checkpoint over a wiped DB — nothing was lost |
| **B** | `count_chunks>0` but `get_ingest_batch(id)` is `None` | chunks survived, workset row gone/drifted |
| **C** | `workset_schema==0` (legacy checkpoint) | no reconstructable workset |
| **D** | batch row exists but `state!='ready'` or chunk-count mismatch | genuinely corrupt workset |

### 5.2 Resume — the default outcome when a workset can be rebuilt

- **Case A**: reset the checkpoint's Phase-A steps and re-run Phase A. Provably
  safe (nothing to lose).
- **Case B, source still on disk, units not yet seen**: Phase A is idempotent
  (`INSERT OR IGNORE` on chunks, `sqlite_store.py:688-692`), so re-running it
  re-commits a workset for the current `ingestion_id`, then chunk-dependent
  phases continue.
- **Workset present, a later phase died**: hydrate the workset (`_load_workset`)
  and continue from the first unfinished step.

The recovery-info endpoint reports `recovery_tier: "resume"` **before** any
irreversible stop, so the wrapper prefers resume over cleanup.

Note that Phase A marks a round's units as *seen* in the dedup ledger atomically
(`sqlite_store.py:793-813`), strictly before Phase B. So a Case B round whose
units were already committed as seen cannot rebuild a non-empty workset by
re-running Phase A — the re-run produces an empty workset. That is not a resume;
it is handled by §5.3.

### 5.3 Skip the round — keep the accumulated graph

Reached when the interrupted round's workset cannot be reconstructed: Case C;
Case D; Case B with the source gone; and Case B where the source is present but
its units are already seen (so a Phase-A re-run rebuilds nothing). Rather than
fail loudly or rebuild the whole database, the pipeline raises `SkipRoundError`
and the runner:

1. logs the skip and calls `checkpoint.reset()` — mints a fresh `batch_id` and
   clears the round's resume steps **without touching any graph data**;
2. returns an `IngestResult` with `outcome == "skipped"`, so the server records
   the run as `state='done'` with a warning (not `state='error'`);
3. writes the skip reason into `ingest_runs.warning` (surfaced by `/status`,
   `kl_server.py:1080`) so the loss is observable, never silent (AGENTS.md §4).

The interrupted round's units stay marked as seen, so their facts are **not**
re-derived automatically on the next round. If that round's data matters, the
operator restores a snapshot (the wrapper's pre-round backup for `ingestion_id`,
§4.3); kl itself performs no lossy deletion and holds no copy. The next round
starts from the clean new `batch_id` and continues accumulating normally.

kl does **not** suggest `--fresh-db` here. `--fresh-db` is a deliberate,
manual full-database rebuild; using it as automatic recovery advice would
destroy the long-lived accumulated graph, which is exactly what this high-
frequency incremental deployment must protect. The recovery advice is always
"skip this round; restore a snapshot if the round's data is needed."

---

## 6. Implementation plan (commits)

### Commit A — Fold checkpoint into `knowledge.db`
- Add `ingest_checkpoint` table; move `IngestCheckpoint` reads/writes onto it
  (constructed today at `runner.py:148`).
- Add `round_started_at` to `ingest_batches`; write `batch_id` +
  `round_started_at` in the same round-start transaction.
- Mark `phase_a.persist_chunks` done in the same txn as the workset write.
- One-way JSON→table migration on open; delete the JSON after import.
- `kl checkpoint show|reset` subcommand.
- Tests: atomicity (no "Phase A done" without a workset row), migration import,
  wipe-consistency (dropping `knowledge.db` removes the checkpoint),
  round-start identity survives `complete_ingest_batch`.

### Commit B — Round-start identity + quiesce surface
- Recovery-info read endpoint returning `{ingestion_id, round_started_at,
  store_paths, recovery_tier}` (§4.1).
- Graceful stop/quiesce that releases DB handles (§4.2).
- Tests: identity pair is stable and durable across completion; endpoint
  returns localhost-only paths; quiesce releases handles.

### Commit C — Diagnose + resume
- A/B/C/D classifier over durable state (§5.1).
- Self-heal Case A and Case B-with-source; hydrate-and-continue for a
  later-phase death (§5.2).
- Tests: each case classified correctly; Case A/B resume end-to-end on synthetic
  fake data; resume is chosen ahead of cleanup.

### Commit D — (superseded) stop-and-cleanup endpoint

Originally planned as `POST /ingest/stop-and-cleanup` (stop → quiesce → return
identity, plus a durable no-deletion warning). **Removed** (§4.3): once Cases
A/B/C/D self-heal or skip automatically, its only behavior beyond `/ingest/stop`
was the warning write, which did not justify a second endpoint. `/ingest/stop`
(Commit B) is the sole rescue action endpoint. Wrapper-side backup/restore
remains unimplemented and is tracked separately.

---

## 7. Guardrails

- All fixtures/examples use fake values (`张三` / `Alice` / `cidFAKE0001==` /
  `msgFAKE0001==`); never real chat data, ids, names, or local paths
  (AGENTS.md §1). Store paths are returned to the local wrapper only, not logged.
- Report facts with real evidence; the cleanup path states exactly what it did
  and did not do — no silent "recovered" when only the job was stopped
  (AGENTS.md §4).
- No `as any` / type-escape hatch to pass typechecks (AGENTS.md §6).
- Snapshot/quiesce happens at round boundaries where kl owns the connections;
  kl never mid-run copies another engine's live files.
- `pnpm run verify` (or at least `pnpm run typecheck && pnpm run check:all`,
  plus `check:no-local-data` / `check:trademarks`) before any commit, and only
  commit/push when explicitly asked (AGENTS.md §3).
