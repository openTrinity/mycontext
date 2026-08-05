# Deduplicate & Resume Embedding (skip already-embedded / identical chunks)

**Status:** Not started. Design only.
**Motivation:** Phase A embedding over the full corpus (~69,630 chunks / 6,963
batches) takes ~55 min through the inkflow gateway (~2 s per 10-input request).
A crash or manual restart part-way through re-pays the *entire* embedding cost,
because nothing is persisted until the very end and there is no per-chunk skip.
This wastes time and paid API tokens.

> Annotation tags (see AGENTS.md): `[!RED]` = pay extra attention;
> `[REMARK]` = anticipated approach; `[Q agent]`/`[Q human]` = open question,
> answered on the next line with `[A human]`/`[A agent]`. Answered threads stay.

## Goal

Never embed the same chunk twice:

- **Resume:** a run that dies at N% resumes at N%, not 0% (crash/restart safety).
- **Cross-run:** re-ingesting an export whose chunks are already embedded is a
  no-op for the embedding step.
- **Content-identical:** two chunks with byte-identical text embed once, not
  twice (boilerplate, forwarded messages, repeated headers).

Do the same for **entities** and **facts** (they share the identical latent bug).

## Current behaviour (what the code actually does today)

Grounded in `kl_graph/ingest/pipeline.py` + `kl_graph/storage/`:

- **Chunk IDs are already stable / deterministic.** Loaders assign structured
  ids: `wiki:{node_id}:{i}`, `doc:{doc_id}:{i}`; messages use `openMessageId`.
  SQLite `chunks.id` is `TEXT PRIMARY KEY` and `insert_chunks` uses
  `INSERT OR IGNORE`, so the *row* side is already idempotent.
- **Qdrant points are keyed by list position, not identity.** `_embed_chunks`
  (pipeline L487) builds `PointStruct(id=i, ...)` where `i` is the index into
  `all_chunks()`. `_embed_graph` does the same for entities (L538) and facts
  (L560). The vector store therefore has *no* notion of "which chunk is this."
- **One bulk upsert at the very end.** `_embed_chunks` embeds every chunk into an
  in-memory `points` list, then calls `qdrant.upsert_batch("chunks", points)`
  once. Until that call, Qdrant holds nothing new; a crash at 80% persists 0%.
- **Smart-resume is coarse (all-or-nothing).** `_phase_a_complete()` (L809)
  compares the expected chunk count against `sqlite.count_chunks()` **and**
  `qdrant.count("chunks")`. If Qdrant is short by even one, it returns False and
  `run_full` re-runs Phase A **from the start** — re-embedding everything. This
  is exactly why the progress bar reset to 0 on the earlier restarts.
  [Q agent]: should `_phase_a_complete()` stay as the coarse gate (and rely on
        the new per-chunk skip inside `_embed_chunks` for partial resume), or be
        refined to report "M of N embedded" so `run_full` can resume without
        re-scanning?
- **`embedding_id` column exists but is unused for chunks.** `chunks`,
  `entities`, `facts` all carry an `embedding_id TEXT` column that is currently
  never populated for chunks.

### Latent correctness bug (not just performance)

[!RED] Positional Qdrant IDs are unsafe across runs. If the chunk/entity list
order changes between runs (new source folder, a loader change, a dropped
file), point `i` silently rebinds to a *different* chunk while its payload
disagrees. Deterministic point IDs fix this as a side effect.
[Q human] Yes, This is going to be a problem. Is there a way to make sure the
      ID stay the same even the order changes? E.g. a hash id of the chunk
      text can do it?

## Design

Two independent goals; one enabler unlocks both.

### Enabler — key Qdrant points by content identity, not position

Replace `PointStruct(id=i, ...)` with a deterministic UUID derived from the
stable id: `PointStruct(id=str(uuid.uuid5(uuid.NAMESPACE_DNS, chunk.id)), ...)`.
Qdrant accepts a UUID string as a point id; uuid5 is deterministic, so
re-embedding the same chunk **overwrites the same point** (idempotent, no
duplicate vectors, even across runs). Apply to chunks, entities, facts.

This matches the codebase's existing philosophy: deterministic UUID5 ids +
`INSERT OR IGNORE` + cached extraction. It is the same pattern, extended to the
vector store.

[!RED] Migration: the current `data/qdrant_data` was built with positional ids,
so switching the scheme makes existing points mismatch. Either (a) let the
in-flight ingest finish on the old scheme, then wipe + rebuild Qdrant once under
the new scheme, or (b) gate the change behind a fresh collection. Do **not**
change this mid-run.
[Q human]: acceptable to wipe + rebuild `data/qdrant_data` once after switching
        to deterministic point ids, or must the migration preserve the existing
        store?
[REMARK]  I already stopped the service. If there is a db or qdrant,
        I will delete it when the new code is in effect.

### Goal 1 — Skip already-embedded chunks (resume + cross-run)

[!RED] by skipping already-embedded chunks, it should mean it will skip the already embedded chunks after the new code has taken effect. So you should not worry the current embeddings and chunks, because there might be format mismatches.

With deterministic point ids, "already embedded?" becomes answerable. Preferred
approach (cheapest, no schema churn):

- **Incremental flush.** In `_embed_chunks`, upsert every N chunks (e.g. 2,000)
  instead of once at the end, so a crash keeps everything up to the last flush.
- **Skip-existing on entry.** Before embedding, compute all point ids and ask
  Qdrant which already exist (add a small `qdrant_store` helper over
  `client.retrieve(ids=...)` / scroll), then embed only the missing ones. On
  restart this re-checks and embeds only the tail that never flushed.

Alternatives considered:

- **(B) SQLite `embedding_id` flag.** Set `chunks.embedding_id` after a
  successful flush; resume embeds `WHERE embedding_id IS NULL`. No Qdrant
  round-trip, but the flush + row-mark must be kept transactionally consistent.
- **(C) On-disk embedding cache** mirroring the extraction cache: key =
  md5(chunk.id) (or md5(text) for content-dup), value = vector in `.npy` shards;
  `embed_batch_with_progress` checks it first. Solves resume + cross-run +
  content-dup at once, but costs ~0.5 GB for 69k × 2048 float32.

[REMARK] Recommend **(A) deterministic ids + incremental flush + skip-existing**
as primary; (B)/(C) are fallbacks if we choose not to touch the Qdrant id scheme
(but they don't fix the positional-id correctness bug).
[Q human]: prefer approach (A) deterministic-id + skip-existing, (B) SQLite
        `embedding_id` flag, or (C) on-disk embedding cache — or a combination?
[REMARK] **Option A** looks good, so no need to implement Option B and C, not
        even necessary as a fallback.

### Goal 2 — Skip content-identical chunks (never embed the same text twice)

[!RED][REMARK] This is wrong, never skip the same chunks, because they might have
      different metadata, so if there are duplicated chunks, **reuse the embedding**!!!

[REMARK] [This is not right, if you think it is right, use Q Agent]Independent of resume, and pure client-side (no API/schema change): before
sending, deduplicate identical texts. Build a `unique_text -> vector` map, embed
only the uniques, then fan the vectors back out to every chunk that shares that
text. Repeated boilerplate / forwarded messages / duplicated headers embed once.

## Recommended implementation order

1. **Deterministic Qdrant point ids** for chunks + entities + facts (fixes the
   latent positional-id bug; enables everything else).
2. **Incremental flush + skip-existing** in `_embed_chunks` (Goal 1, option A) —
   the real protection against re-paying on ~55-min inkflow runs.
3. **In-batch content dedup** (Goal 2) — small, cheap, orthogonal token saving.

## Touch points

- `kl_graph/ingest/pipeline.py`: `_embed_chunks` (L487), `_embed_graph` (L527+),
  `_phase_a_complete` (L809), `run_full` (L790).
- `kl_graph/storage/qdrant_store.py`: add `retrieve`/`exists` helper; `count`
  (L173), `upsert_batch` (L81).
- `kl_graph/storage/sqlite_store.py`: `embedding_id` column already present on
  `chunks`/`entities`/`facts` (option B only).
- `kl_graph/models/types.py`: `Chunk.embedding_id` field already present.
