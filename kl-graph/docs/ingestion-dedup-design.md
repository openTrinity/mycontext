# Ingestion Deduplication Design

## Scope

This document defines ingestion-time deduplication: how raw source records are
recognized across runs and how their lineage to retrieval chunks is stored. It
does not cover embedding batching or query-result deduplication.

The central rule is:

> The caller owns stable source-unit identity; the framework owns chunks.

The durable deduplication key is:

```text
(source_id, source_type, unit_id)
```

Timestamps are ordering metadata, not watermarks. The `units` table is the
deduplication ledger. The checkpoint records completed steps and the stable
`batch_id` of the current durable workset.

## Identities and responsibilities

### Caller-owned source unit

A source unit is the smallest input record whose identity the producer can keep
stable. Examples include a chat message, wiki page, email, meeting record, or
generic exported record.

| Field | Owner | Meaning |
|-------|-------|---------|
| `source_id` | Caller | Stable namespace for one producer/feed, such as `dingtalk-prod` or `slack-team-a` |
| `source_type` | Loader/caller contract | Record vocabulary, such as `message`, `wiki`, or `mail` |
| `unit_id` | Caller | Stable native ID within that source and type |
| `content_hash` | Framework | SHA-256 of the normalized unit content, used to detect a changed unit |
| `timestamp` | Caller | Optional event/creation time used for ordering only |

The caller must provide a non-empty, stable ID for every record and must not
reuse an ID for an unrelated record. A single export should contain each
composite identity at most once.

### Framework-owned chunk

A chunk is a retrieval and extraction unit produced after deduplication. Chunk
boundaries may change as chunking evolves, so chunk IDs are not the input
identity contract.

The relationship is many-to-many:

- Several messages may be merged, in order, into one session chunk.
- One large message or document unit may produce several ordered chunks.
- A simple document may produce one chunk from one unit.

Framework-owned chunk IDs are prefixed with `source_id` so independent feeds
can share one index without chunk-ID collisions.

## Storage model

SQLite uses three canonical identity/lineage tables and two temporary workset
tables:

```text
sources
  source_id PK

units
  (source_id, source_type, unit_id) PK
  content_hash, timestamp, metadata, processed_at

chunk_units
  (chunk_id, source_id, source_type, unit_id) PK
  unit_ordinal_in_chunk
  chunk_ordinal_in_unit
  start_offset, end_offset

ingest_batches
  batch_id PK
  source_id, source_hash, state, unit_count, chunk_count

ingest_batch_chunks
  (batch_id, chunk_id) PK
  chunk_ordinal
```

`unit_ordinal_in_chunk` preserves the order of units merged into a chunk.
`chunk_ordinal_in_unit` preserves the order of chunks created from one unit.
The optional offsets reserve a place for exact spans when a chunker can provide
them.

The uniqueness constraints additionally guarantee:

- one unit position per chunk;
- one chunk position per unit; and
- no duplicate membership for the same chunk and unit.

Source units are lineage records, not graph nodes. Chunks remain the graph and
retrieval representation of raw content.

`ingest_batch_chunks` is correctness state, not an optimization cache. It is
the ordered manifest every later chunk-dependent phase consumes. Its rows are
deleted only after the whole ingestion succeeds; the small `ingest_batches`
summary row remains with state `complete`.

## Ingestion algorithm

For each run, the shared server/CLI runner performs the following sequence:

1. Load and normalize records from the local `input_dir`.
2. Construct source units and their content hashes.
3. Query `units` for existing identities under the requested `source_id`.
4. Remove already-seen units before chunking.
5. Chunk only the selected units and build ordered `chunk_units` rows.
6. Atomically insert the chunks, units, mappings, batch record, and ordered
   batch-chunk manifest.
7. Embed, extract, and build the graph using exactly the batch manifest.
8. Mark `ingest.complete`, then delete the batch-chunk manifest.

Initial/full and incremental ingestion share this workflow. They differ only in
admission: an initial empty index admits every unit, while a later run admits
only unseen units. An empty incremental workset is valid and remains
distinguishable from a missing or corrupt workset.

Filtering before chunking is significant for chat. If a delayed message arrives
with an old timestamp but a new `unit_id`, it is selected and placed into a new
chunk. Previously persisted chunks are not rewritten merely to insert the late
message into their historical position.

For documents, all loader-produced chunks sharing a document's `unit_id` are
treated as one unit. Either all chunks for that unseen unit are selected, or
all are skipped.

## Behavior by input state

| Incoming unit | Stored state | Current behavior |
|---------------|--------------|------------------|
| New composite identity | Absent | Process and persist it |
| Same identity, same hash | Present | Skip it |
| Same identity, different hash | Present | Warn and skip; replacement is a TODO |
| Same `unit_id`, different `source_id` | Separate namespace | Process independently |
| Same `unit_id`, different `source_type` | Separate namespace | Process independently |
| New ID with an old or absent timestamp | Absent | Process; timestamp does not affect deduplication |
| No new units in the directory | All present | No new chunks are created |

This makes normal ingestion idempotent without a separate incremental mode or
timestamp cutoff.

## Chunking-strategy changes

The database does not store or compare a chunking-strategy version. A new
strategy therefore applies to new units only. Previously seen units remain
linked to their existing chunks, while unseen units are chunked with the new
strategy.

This is sufficient for forward-only evolution, but it is not a rechunking
operation. To apply a new strategy to every historical unit, perform an
explicit clean rebuild of the isolated index (for the offline CLI,
`--fresh-db`). Resetting only the checkpoint is insufficient because persisted
rows in `units` will still deduplicate the old inputs.

When update support is implemented, a changed unit will need an explicit
replacement transaction that removes or supersedes its old chunk memberships
and invalidates derived chunks, embeddings, facts, edges, and extraction-cache
entries. Until then, changed content is deliberately not mixed into the index.

## Checkpoint and crash semantics

`insert_chunks_with_units()` writes `chunks`, `units`, `chunk_units`,
`ingest_batches`, and `ingest_batch_chunks` in one SQLite transaction. This is
the Phase A commit boundary:

- A crash before commit leaves none of the unit lineage committed.
- A crash after commit leaves a complete dedup record, lineage, and workset.
- The `phase_a.persist_chunks` checkpoint is marked complete only after the
  transaction succeeds.
- The checkpoint carries `unit_lineage_schema=1`, forcing older checkpoints to
  backfill lineage instead of incorrectly skipping the step.

SQLite and the JSON checkpoint cannot commit atomically. If SQLite commits but
the checkpoint mark is interrupted, the retry detects the ready database batch,
hydrates it, and converges the persistence step instead of reparsing the source.
If the source directory changes after Phase A commits, the interrupted batch is
finished from its persisted workset before a new source snapshot is admitted.

Completion uses the opposite safe ordering: first mark `ingest.complete`, then
delete `ingest_batch_chunks`. A crash between those operations is harmless;
the next invocation sees the completion mark and retries cleanup without
running data phases. Failures before completion retain the workset.

A missing workset, a count mismatch, a prematurely cleaned workset, or a legacy
checkpoint that completed Phase A before worksets existed causes an explicit
error. None of these cases is treated as an empty batch.

Later stores cannot share that SQLite transaction. Embedding and graph writes
are idempotent and converge on retry, while their step checkpoints prevent
unnecessary completed work. See [checkpoint-design.md](checkpoint-design.md)
for the full recovery model.

## Source and database isolation

Different `source_id` values isolate logical feeds inside the same knowledge
index. This allows multiple IM systems to contribute to one index even when
their native IDs overlap.

`source_id` does not create a separate database. To keep feeds in physically
separate indexes, run them with different `KL_DATA_DIR` values (and distinct
external graph backend paths/names where configured). This separates SQLite,
Qdrant, checkpoints, and the default graph store.

## Current limitations

- Same-ID content updates are detected but skipped.
- Unit deletion and source reset APIs are not implemented.
- Historical units are not automatically rechunked after a strategy change.
- Completed worksets are intentionally unavailable for ad-hoc phase replay;
  an explicit rebuild must create a new all-chunks workset.
- The caller is responsible for stable, unique unit IDs; content-only
  deduplication is intentionally not used.
- Two different records with identical content remain distinct when their unit
  identities differ.

These constraints keep the initial model small: identity determines whether a
unit was processed, lineage records how it became chunks, and rebuild/reset is
an explicit administrative operation.
