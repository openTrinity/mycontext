# Ingestion Rescue — API & Behavior

> The rescue surface: the localhost endpoints a wrapper calls to inspect and
> quiesce a stuck ingestion round (**API**, below), and **what the pipeline
> itself does** when a resumed round finds its durable state broken
> (**Behavior**, below). This is the operational reference; the *why* (root
> cause, design trade-offs, the round-start identity contract) lives in
> [`ingestion-recovery-design.md`](./ingestion-recovery-design.md). When the
> two disagree, the code wins — re-verify and update this file.

Grounded in `kl_server.py` (`/ingest/recovery-info`, `/ingest/stop`,
`/status`), `kl_graph/ingest/recovery.py`
(`classify_recovery`, `SkipRoundError`), `kl_graph/ingest/pipeline.py`
(`_maybe_heal_missing_workset`, `_load_workset`), and
`kl_graph/ingest/runner.py` (`run_ingestion` skip branch). Verified end-to-end
on a real-data rig (Case B → skip → accumulate).

---

## API

All rescue endpoints are **localhost-only** and intended for the desktop
wrapper. `store_paths` (the store files the wrapper copies/restores as a unit)
are returned only over localhost and never logged (AGENTS.md §1). All return
`503` when the server is not ready.

### `GET /ingest/recovery-info` (read-only)

Reports the current/last round's identity and a coarse recovery tier. Takes no
action.

```json
{
  "ingestion_id": "<batch_id or empty>",
  "round_started_at": 1786635320,
  "store_paths": ["<abs-path to knowledge.db>", "..."],
  "recovery_tier": "ok" | "resume" | "cleanup"
}
```

- `recovery_tier` comes from the A/B/C/D classifier (see **Behavior**): `resume`
  for Cases A/B-with-source, `cleanup` for Cases C/D/B-source-gone, `ok`
  otherwise. It is a **pre-flight hint**, not the final verdict — a `resume`
  round can still turn into a skip once the empty-workset condition is
  discovered at load time (Case B′ below).
- The tier strings are a stable contract with the wrapper; they are not renamed.

### `POST /ingest/stop` (graceful quiesce)

Cancels the running ingest task (waits up to 30 s), then closes all SQLite /
Kuzu / vector handles so the wrapper can copy or restore store files that are
not mid-write. Returns the identity alongside the quiesce result:

```json
{
  "quiesced": true,
  "detail": "all DB handles released",
  "ingestion_id": "<batch_id>",
  "round_started_at": 1786635320,
  "store_paths": ["<abs-path>", "..."]
}
```

`/ingest/stop` is the **only** rescue action endpoint — there is no
`stop-and-cleanup` or any destructive variant. It is reversible: it cancels the
task and releases handles, nothing more. Restarting the server resumes the same
round normally; the round identity and workset are untouched.

Note that stop is rarely needed for *recovery*: the A/B/C/D cases below
**self-heal or skip on their own** on the next round. Its real purpose is to let
the wrapper take control of the store files — quiesce, copy or restore, then
resume — or to halt a wedged/hung job.

### How the wrapper backs up and restores

kl exposes **no** `/backup`, `/snapshot`, or `/restore` endpoint, and does no
file copying, `VACUUM INTO`, or graph-backend `CHECKPOINT`-for-backup itself.
This is deliberate (`ingestion-recovery-design.md` §3.2): kl owns only the
**round identity** (`ingestion_id` + `round_started_at`, minted together at round
start) and a **graceful quiesce**; the **wrapper owns the entire backup/restore
policy** — whether to copy, the copy mechanism, where it lives, retention, and
the actual restore.

kl's implemented contribution to that flow is exactly two things:

1. **`GET /ingest/recovery-info` → `store_paths`** tells the wrapper *what to
   back up* — the store files that must be copied/restored as a unit, keyed to
   the round's `ingestion_id`.
2. **`POST /ingest/stop`** quiesces so the wrapper copies/restores files that are
   not mid-write.

> **Status:** the wrapper-side backup/restore itself is **not yet implemented**.
> So wherever this doc or a skip-round warning says "restore a snapshot", it
> describes the *intended* wrapper action (restore its own pre-round copy filed
> under `ingestion_id`) — a capability that does not exist on either side today.
> Until the wrapper builds it, a skipped round's facts are simply lost (the
> round's units stay marked seen); the graph is preserved but that round is not
> recoverable. This is stated so the advice is not read as a working feature it
> is not (AGENTS.md §4).

### Observing outcomes: `GET /status` and `GET /ingest/{run_id}/failures`

`GET /status` returns an `ingest` object mirroring the latest `ingest_runs` row:

| Field | Meaning |
|-------|---------|
| `state` | `idle` / `running` / `done` / `error` |
| `outcome` | `success` / `partial` / `skipped` |
| `warning` | skip reason or partial-extraction summary; empty on clean success |
| `detail` | human-readable terminal note (e.g. `round skipped: …`) |
| `units_processed`, `chunks_created`, `extraction_*` | per-round counts |
| `failures_url` | `/ingest/{run_id}/failures` when `extraction_failed > 0` |

A **skipped** round always shows `state='done'`, `outcome='skipped'`, a `warning`
containing the skip reason + a snapshot-restore hint, and **never** the string
`--fresh-db`.

`GET /ingest/{run_id}/failures?limit=&cursor=` returns the bounded, cursor-paged
extraction-failure manifest for one run (`extraction_item_id`, `source_unit_id`,
`target_chunk_id`, `error_type`, `message`, `attempts`) with a `next_cursor`.
This covers **partial** outcomes (extraction failures), which are distinct from
**skipped** rounds (unrecoverable workset).

---

## Behavior

What the pipeline does on its own when a resumed round finds its durable state
broken. The API above lets a wrapper observe and quiesce; the logic below is
automatic and needs no wrapper call.

## The one thing to remember

The main deployment is **high-frequency incremental ingestion**, so the graph is
a long-lived accumulation. Rescue is therefore biased toward **protecting the
accumulated graph**, never rebuilding it:

- **Resume** when the interrupted round can be safely reconstructed.
- **Skip the round** (complete-with-warning, graph untouched) when it cannot.
- **Never auto-suggest `--fresh-db`.** It is a real, deliberate manual
  full-database rebuild flag — but as *recovery advice* it would destroy the
  long-lived graph, so recovery advice is always "skip this round; restore a
  snapshot if that round's data is needed."
- **Never silently degrade.** A skipped round is recorded as
  `state='done'` **with a warning** in `ingest_runs`, so the loss is observable
  (AGENTS.md §4), not a silent "0 rows, all good".

---

## Two failure axes

1. **A missing/broken durable workset** (`ingest_batches` row gone or corrupt)
   while the checkpoint still says a chunk-dependent phase is due. This is what
   the A/B/C/D classifier handles. See below.
2. **A phase that died after the workset was committed** (e.g. extraction
   crashed). The workset row is intact and `state='ready'`, so the pipeline just
   hydrates it and resumes from the first unfinished step — this is an ordinary
   resume, not a rescue case.

---

## Case matrix (missing/broken workset)

`classify_recovery(conn, source_id, source_dir)` reads durable state only
(checkpoint row, `ingest_batches`, chunk count, whether the source export is on
disk) and returns a `RecoveryInfo{tier, case, ...}`. The **tier string**
(`resume` / `cleanup` / `ok`) is a contract with the desktop wrapper and does
not change; only behavior and `detail` wording are summarized here.

| Case | Detected signals | `tier` | Runtime behavior | Observable outcome |
|------|------------------|--------|------------------|--------------------|
| **A** — stale checkpoint over wiped DB | `phase_a.persist_chunks` done, no `ingest.complete`, `ingest_batches` row absent, `count_chunks == 0` | `resume` | **Self-heal & resume.** `clear_prefix("phase_a.")` then reload from sources and re-run Phase A. Provably safe — nothing was lost (chunks are gone, units not yet seen). | Round runs normally; `outcome='success'`. |
| **B** — workset row gone, chunks survived, **source on disk, units NOT yet seen** | `count_chunks > 0`, `get_ingest_batch(id)` is `None`, source dir exists, re-parse yields a non-empty workset | `resume` | **Re-run Phase A** from sources (`INSERT OR IGNORE` is idempotent), then continue chunk-dependent phases. | Round runs normally; `outcome='success'`. |
| **B′** — same as B but **units already seen** (dedup ledger marks every unit) | as B, but re-parse yields an **empty** in-memory workset while durable chunks remain | `resume`* | **Skip the round.** Re-parsing rebuilds nothing (all units filtered as seen); extracting zero chunks would be a silent no-op over surviving data. `_maybe_heal_missing_workset` raises `SkipRoundError`. | `state='done'`, `outcome='skipped'`, warning + snapshot advice. Graph untouched. |
| **B″** — workset row gone, chunks survived, **source NOT on disk** | `count_chunks > 0`, `get_ingest_batch(id)` is `None`, source dir absent | `cleanup` | **Skip the round.** Cannot re-parse (no source) and cannot rebuild from the ledger. `SkipRoundError`. | `state='done'`, `outcome='skipped'`, warning + snapshot advice. Graph untouched. |
| **C** — legacy checkpoint | `workset_schema == 0` | `cleanup` | **Skip the round.** No reconstructable workset format. `SkipRoundError` (raised early in `_load_workset` when Phase A was done under a legacy schema). | `state='done'`, `outcome='skipped'`, warning + snapshot advice. Graph untouched. |
| **D** — corrupt workset | `ingest_batches` row exists but `state != 'ready'` (and `!= 'complete'`), **or** recorded chunk-count ≠ actual | `cleanup` | **Skip the round.** Partial-write / damaged intermediate state; `SkipRoundError` from `_load_workset`. | `state='done'`, `outcome='skipped'`, warning + snapshot advice. Graph untouched. |

\* The classifier still returns tier `resume` for B′ (source is on disk); the
*emptiness* is only discovered at load time inside `_maybe_heal_missing_workset`,
which is where the skip decision is made. The tier is a coarse pre-flight hint
for the wrapper, not the final verdict.

### Not a rescue case (normal outcomes)

| Situation | Signals | Behavior |
|-----------|---------|----------|
| Healthy resume | `ingest_batches` row present, `state='ready'`, chunk-count matches | Hydrate workset, resume from first unfinished step. |
| Completed round re-opened | `ingest_batches` `state='complete'` and `ingest.complete` done | Plain **`RuntimeError`** ("workset no longer available"). Re-opening a finished round is a logic error, not a recoverable break — reported honestly, never silently treated as empty. |
| Nothing to recover | no checkpoint row, or Phase A not started, or round completed and cleaned up | `tier='ok'`, no action. |

---

## What "skip the round" does, step by step

When the pipeline raises `SkipRoundError`, `run_ingestion` catches it (it never
escapes to the server's blanket error handler) and:

1. **Logs** the skip (`logger.warning`, workset-unrecoverable).
2. **`checkpoint.reset()`** — mints a fresh `batch_id` and clears the round's
   resume steps. **Touches no graph data.** The next round starts clean and
   keeps accumulating.
3. Builds `IngestResult(0, 0, 0, 0, skipped_reason=str(exc))` →
   `outcome == "skipped"`, `warning == skipped_reason`.
4. Publishes it via `counts_callback` so the warning lands in
   `ingest_progress`, and the terminal `report("done", 1.0, "round skipped: …")`
   persists `state='done'` + warning into `ingest_runs` (surfaced by `/status`).

`SkipRoundError` subclasses `RuntimeError` on purpose: if any call path ever
misses the `except`, it degrades to the old hard-fail behavior rather than
silently swallowing the loss.

### The accepted trade-off

A skipped round's units stay marked **seen** in the dedup ledger (they were
committed atomically in Phase A, before Phase B). So their facts are **not**
re-derived automatically on the next round. Recovering that round's data
requires a **snapshot restore** — the wrapper's pre-round backup keyed on
`ingestion_id` (design §3/§4.3). kl performs no lossy logical deletion and holds
no copy of its own.

---

## Orphan / dangling rows

`PRAGMA foreign_keys` is never enabled, so orphaned rows (e.g. workset children
whose parent batch was deleted) never raise — they only accumulate. Current
policy is **tolerate, don't warn, don't delete**: a skip round leaves the
imperfect DB state in place rather than emitting loud warnings. A dedicated
orphan-sweep (`kl db cleanup`) is deferred to a separate change and is **not**
part of the recovery path today.

---

## Observing a rescue

See **API → Observing outcomes** above for `GET /status` and the failure
manifest. Everything surfaced there is also persisted durably in the
`ingest_runs` table (`state`, `detail`, `warning`, `outcome` per `run_id`), so a
skip is observable even after a restart — never a silent "0 rows, all good".

---

## Related docs

- [`ingestion-recovery-design.md`](./ingestion-recovery-design.md) — full
  rationale, durable-state fix, round-start identity contract, server surface.
- [`checkpoint-design.md`](./checkpoint-design.md) — checkpoint step semantics.
- [`ingestion-artifact-dependencies.md`](./ingestion-artifact-dependencies.md) —
  workset lifecycle.
- [`ingest-api.md`](./ingest-api.md) — server endpoints and status fields.
