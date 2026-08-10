# KL-Graph: Grand Design

A spatio-temporal knowledge graph for workplace communication and documents.

---

## Philosophy

1. **Rich nodes, simple edges.** Nodes carry all semantic weight (text, embeddings, metadata, community membership). Edges are typed pointers — cheap to create, traverse, and reason over.
2. **Allow conflicts.** The graph tolerates contradictory facts. Resolution is a query-time concern, not an ingestion-time one. Contradictions are explicitly marked, not silently merged.
3. **Improvement on the fly.** The graph grows richer over time. Periodic and query-time processes add edges, refine communities, and disambiguate entities without re-ingesting raw data.
4. **Units for ingestion; chunks for retrieval.** A source unit is the smallest caller-owned identity used for deduplication (for example a message or document). The framework maps units into retrieval chunks: many messages may share a chunk, and one large unit may span several chunks. There is no separate "message" graph node; chat content is represented by chunks with `source_type=message`.

---

## Source Units and Chunk Lineage

Source units are ingestion records, not graph nodes. Their stable identity is
the composite `(source_id, source_type, unit_id)`:

- `source_id` namespaces a producer inside one index, such as `dingtalk-prod`
  or `slack-team-a`.
- `source_type` describes the source vocabulary (`message`, `wiki`, `mail`, …).
- `unit_id` is the native caller-owned id.

The `chunk_units` table records the ordered many-to-many mapping. The
`unit_ordinal_in_chunk` field preserves the order of messages merged into a
chunk; `chunk_ordinal_in_unit` preserves the order of chunks produced from one
large message or document. Framework-owned chunk ids are namespaced by
`source_id` to prevent collisions when sources share an index.

Normal ingestion deduplicates solely by the composite unit identity. A repeated
id with the same content is skipped. A repeated id with a different content
hash is detected and warned about; replacement processing is intentionally a
TODO in the current version. Timestamps remain ordering metadata and are never
used as ingestion watermarks.

### Extraction Items

An **Extraction Item** is an ephemeral LLM work unit, not a graph node. It is
derived from a source unit or stored chunk and records its target stored chunk,
optional source-unit identity, source-specific strategy version, and read-only
context. Extraction granularity is independent from retrieval granularity:

- chat session slices remain stored/retrieval Chunks, while each member message
  is an extraction target and nearby messages are context only; an inlined
  quoted reply remains in the stored Chunk but is moved to read-only extraction
  context so it is not asserted again as a new claim;
- wiki, mail, and other document sources initially extract one semantic stored
  Chunk at a time with source-appropriate context and rules;
- unknown source types extract the stored Chunk itself.

Entities and facts produced from an Extraction Item are projected onto its
target Chunk. Facts retain extraction-item/source-unit provenance, and fact
identity is derived from extraction-item identity plus fact text. Extraction
items never appear as edge endpoints.

Extraction strategy selection is explicit configuration keyed by `source_type`.
The current strategy vocabulary is `chat_message`, `document_chunk`, and
`stored_chunk`, with a configured default for unknown sources. Each item records
its prompt and strategy versions. Prompt language is also explicit (`zh` or
`en`); the configured language selects the matching system prompt and forms
part of the prompt version used for cache identity.

The extraction output contract uses canonical nested entity/fact field names.
Compatibility aliases may be accepted at the parser boundary, but each result
is canonicalized and validated before slot alignment or caching. `ABOUT` edges
come only from validated participants on that fact, never from every entity in
the containing extraction item.

---

## Node Types

| Node | Description | Key Fields |
|------|-------------|------------|
| **Chunk** | The framework-owned retrieval unit. It can contain several small source units or one ordered segment of a large unit. | `id`, `content`, `content_hash`, `source_type`, `timestamp`, `source_ref`, `metadata` |
| **Entity** | A named thing extracted from chunks. Typed by `entity_type` (open vocabulary). Carries a short accumulated `description` and reversible cleanup state. Quarantined entities retain provenance but are excluded from retrieval, embedding, new edges, and improvement. | `id`, `name`, `entity_type`, `first_seen`, `last_seen`, `mention_count`, `description`, `quality_status` |
| **Fact** | A reified claim/event extracted from an extraction item and projected onto its target chunk. Typed by `fact_type` (open vocabulary). Carries confidence and fine-grained provenance. | `id`, `text`, `fact_type`, `timestamp`, `confidence`, `source_chunk_id`, `source_unit_id`, `extraction_item_id` |
| **Scope** | A container that groups related chunks: a conversation, a document, a meeting, a mail thread. Typed by `scope_type` (open vocabulary). | `id`, `scope_type`, `title`, `metadata` |
| **Community** | A cluster of entities or facts at a given resolution level. Generated by periodic detection. | `id`, `level`, `node_type`, `summary`, `tags`, `member_count` |

### Type Vocabularies

Node sub-types are **open vocabularies** — the values below are existing examples, not a closed enum. New source types, entity types, fact types, and scope types may be added as the data grows.

| Node | Type Field | Current Examples |
|------|-----------|-----------------|
| Chunk | `source_type` | `message`, `wiki`, `mail`, `minutes`, `drive`, `calendar`, `work` |
| Entity | `entity_type` | `Person`, `System`, `Project`, `Organization`, `Location`, `Document` |
| Fact | `fact_type` | `DECISION`, `DELEGATE`, `STATUS`, `CAUSAL`, `GENERAL` |
| Scope | `scope_type` | `conversation`, `document`, `mail_thread`, `meeting`, `calendar_event` |

---

## Edge Types

Edges connect any two nodes where the semantics permit. Each edge stores `(source_type, source_id, target_type, target_id, edge_type, properties)`.

### Structural Edges (created at ingestion)

| Edge | Source → Target | Semantics |
|------|----------------|-----------|
| **MENTIONS** | chunk → entity | The chunk's text mentions this entity. |
| **AUTHORED_BY** | chunk → entity | The chunk was produced by this person (chat sender, mail author, report creator, meeting speaker). |
| **REPLY_TO** | chunk → chunk | At least one message within the source chunk quotes/replies to a message within the target chunk. |
| **TEMPORAL** | chunk → chunk | Consecutive chunks within the same scope, ordered by timestamp. |
| **STATES** | fact → chunk | Provenance — this fact was extracted from this chunk. |
| **ABOUT** | fact → entity | The fact concerns this entity (subject or object). |
| **PART_OF** | chunk → scope | This chunk belongs to this scope (conversation, document, etc.). |

### Similarity Edges (created by periodic improvement)

| Edge | Source → Target | Semantics |
|------|----------------|-----------|
| **ENTITY_SIMILAR** | entity → entity | High hybrid similarity (embedding + phonetic + co-occurrence). |
| **FACT_SIMILAR** | fact → fact | High semantic similarity between fact texts. |

> **Design note:** We use distinct edge types for entity-entity vs. fact-fact similarity rather than a generic `SIMILAR_TO`. Rationale: in knowledge graph practice, typed edges enable targeted traversal (e.g. "expand to similar entities" vs. "find corroborating facts") and allow different threshold/weight policies per type. A generic `SIMILAR_TO` would require a runtime filter on node types, adding complexity without benefit.

### Logical Edges (created by periodic improvement)

| Edge | Source → Target | Semantics |
|------|----------------|-----------|
| **ENTAILS** | fact → fact | The source fact logically entails the target fact (temporal supersession, generalization, or direct implication). |
| **CONTRADICTS** | fact → fact | The two facts are in logical conflict. Both are retained; resolution is query-time. |

### Community Edges (created by periodic improvement)

| Edge | Source → Target | Semantics |
|------|----------------|-----------|
| **COMM_MEMBER** | entity/fact → community | This entity or fact belongs to this community at a given resolution level. |

---

## Pipeline Phases

### Phase 1: Ingestion (initial build and normal updates)

Scans a caller-selected local export, normalizes its records into source units,
filters units already present in the index, and extends the graph from the
remaining delta. The same workflow handles the initial build and later updates.

#### Instant Operations (no LLM, O(n) I/O)

| Step | Operation | Produces |
|------|-----------|----------|
| 1.1 | **Load and deduplicate units** — parse local artifacts, identify `(source_id, source_type, unit_id)`, and filter previously processed units | New source-unit list |
| 1.2 | **Create scopes** — one Scope node per conversation / document / meeting | Scope nodes |
| 1.3 | **Chunk + persist workset** — create retrieval chunks and atomically write `chunks`, `units`, ordered `chunk_units`, and the batch's `ingest_batch_chunks` manifest | Chunk nodes + resumable unit lineage |
| 1.4 | **Embed chunks** — batch embed all chunks into vector store | Chunk vectors |
| 1.5 | **PART_OF edges** — link each chunk to its scope | PART_OF edges |
| 1.6 | **TEMPORAL edges** — link consecutive chunks within each scope | TEMPORAL edges |
| 1.7 | **REPLY_TO edges** — from source threading metadata (e.g. DingTalk quotedMessage) | REPLY_TO edges |

##### Improve (requires all entities/facts/embeddings to exist)

| Step | Operation | Produces |
|------|-----------|----------|
| 1.16 | **Fact similarity** — cosine similarity on fact vectors above threshold | FACT_SIMILAR edges |
| 1.17 | **Entity similarity** — hybrid (embedding + pinyin + Jaccard co-occurrence) | ENTITY_SIMILAR edges |
| 1.18 | **Entity community detection** — multi-resolution Leiden (L0-L3) | Community nodes + COMM_MEMBER edges |
| 1.19 | **Fact community detection** — multi-resolution Leiden (the HDBSCAN topic path is currently disabled) | Community nodes + COMM_MEMBER edges |

#### Sophisticated Operations (LLM, cached + replayable)

| Step | Operation | Produces |
|------|-----------|----------|
| 1.8 | **Source-aware LLM extraction** — strategy-selected extraction items (one target message with context for chat; semantic chunks for document sources), cached in separate bounded `extraction_cache.db` | Extraction cache |
| 1.9 | **Build entities** — merge by normalized name, create Person entities from chunk authors | Entity nodes |
| 1.10 | **Build facts** — create Fact nodes from extraction results | Fact nodes |
| 1.10a | **Optional entity cleanup** — rank suspicious entities and spend a configured LLM budget on KEEP/RETYPE/QUARANTINE decisions; disabled by default | Quality decisions / reversible quarantine |
| 1.11 | **Embed entities + facts** — into vector store | Entity/Fact vectors |
| 1.12 | **MENTIONS edges** — chunk → entity from extraction results | MENTIONS edges |
| 1.13 | **AUTHORED_BY edges** — chunk → Person entity from sender/author metadata | AUTHORED_BY edges |
| 1.14 | **STATES edges** — fact → source chunk | STATES edges |
| 1.15 | **ABOUT edges** — fact → subject/object entity | ABOUT edges |

##### Improve (requires full graph)

| Step | Operation | Produces |
|------|-----------|----------|
| 1.20 | **Entity disambiguation** — pinyin + hybrid + LLM judge for ambiguous pairs | Merged entities, ENTITY_SIMILAR edges |
| 1.21 | **Community summarization** — LLM generates summary + tags per community | Community summary text + tags |
| 1.22 | **Embed communities** — community summaries into vector store | Community vectors |
| 1.23 | **Logical relation detection** — LLM identifies entailment/contradiction between related facts | ENTAILS / CONTRADICTS edges |

> **Execution order.** Steps 1.1–1.7 run first (instant structural build), then 1.8–1.15 (LLM extraction + graph build), then 1.16–1.23 (improve). The improve steps depend on the full entity/fact/edge set existing, but are part of the same pipeline invocation.

> **Re-runnability.** The improve sub-phase (1.16–1.23) can be re-run independently with different parameters (similarity thresholds, Leiden resolution, disambiguation budget) without re-running extraction. This is the role of `scripts/improve.py` — it runs the improve steps standalone for tuning.

> **Build vs. Improve boundary.** The Phase 1 pipeline splits into two conceptual halves:
>
> - **Build** (steps 1.1–1.15): everything derived from one extraction item and its target chunk. Each extraction item can be processed independently — entity extraction, fact creation, structural edge wiring. Context is read-only and never becomes another target's output.
> - **Improve** (steps 1.16–1.23): semantic relationships derived after Build. The initial/full pass uses the graph as a whole; later server runs can use ANN similarity plus one-hop frontier communities for the affected batch. These steps cannot run until Build is complete.
>
> The boundary criterion: **"Can this be derived independently from one extraction item and its target chunk?"** If yes, it is Build. Cross-target semantic relationships are Improve, even when their incremental implementation limits writes to an affected frontier.

#### Extraction batching and cache identity

LLM request batch size is a user control and defaults to `5`; the pipeline does
not automatically alter it for RPM limits. Values greater than one must retain
strict per-slot alignment and validation. Cache identity includes extraction
item ID, model, prompt version, strategy version, and schema version so results
from incompatible extraction contracts cannot be replayed silently.

#### Optional budgeted LLM entity cleanup

After entities and facts are built, and before entity/fact embedding, structural
edges, or similarity/community projection,
an optional LLM cleanup phase may review a bounded set of suspicious entities.
Deterministic signals rank candidates but never mutate an entity without an LLM
decision. Candidate priority is
`suspicion_score * (1 + log1p(impact_score))`. Suspicion evidence includes
conflicting extracted types, names absent from source contexts, generic or
pronoun-like names, path/file/sentence-shaped names, fallback `Unknown` types,
broken participant references, and single occurrence. Impact considers mention
count, graph degree, source count, and available retrieval evidence. `Unknown`
alone is not sufficient to change an entity.

The LLM receives the current name/type, type votes, representative source
snippets and facts, and the deterministic signals. Its validated response is
limited to KEEP, RETYPE, or reversible QUARANTINE; `canonical_name` must be
null. Automatic rename/merge is deferred until transactional rewrites for IDs,
facts, edges, vectors, cache references, and communities are designed.
Cleanup-only persistence updates `entity_type`/`quality_status` without changing
mention counts or timestamps. Cleanup applied to an already-built index reports
stale vector/graph projections explicitly; those projections must be rebuilt
before serving the modified index.

---

### Phase 2: Incremental Ingestion Semantics

Incremental ingestion is the normal server workflow rather than a separate
mode. `POST /ingest` receives only a server-local `input_dir`, a stable
`source_id`, and runtime controls such as concurrency. Source content remains on
disk and is never uploaded in the request body.

An unseen composite unit id is processed with the current chunker. A seen id
with the same hash is skipped. A seen id with different content is warned and
skipped for now; replacement is a TODO. Absence from a later directory scan
does not imply deletion.

#### Instant Operations (no LLM)

| Step | Operation | Produces |
|------|-----------|----------|
| 2.1 | **Load new units** — deduplicate by `(source_id, source_type, unit_id)` before chunking | New unit list |
| 2.2 | **Chunk + embed new content** — same as 1.3–1.4 but only for new chunks | New chunk nodes + vectors |
| 2.3 | **Structural edges for new chunks** — PART_OF plus TEMPORAL/REPLY_TO relationships available inside the selected batch; historical chunks are not rewritten | Structural edges |
| 2.4 | **Post-build improvement** — `auto` by default; ANN update after a baseline, graph-wide when explicitly forced | ENTITY_SIMILAR / FACT_SIMILAR edges |
| 2.5 | **Communities** — one-hop frontier update after a baseline; graph-wide initialization/rebuild otherwise | Community nodes + COMM_MEMBER edges |

#### Sophisticated Operations (LLM)

| Step | Operation | Produces |
|------|-----------|----------|
| 2.6 | **LLM extraction** — entity + fact extraction for new chunks only (cached) | Extraction cache (delta) |
| 2.7 | **Build + embed new entities/facts** — merge new entities with existing (by normalized name), create fact nodes, embed | New/updated entity + fact nodes + vectors |
| 2.8 | **Structural edges** — MENTIONS, AUTHORED_BY, STATES, ABOUT for new content | Structural edges |
| 2.9 | **Optional disambiguation** — the improve path can reconsider ambiguous entities over the updated corpus | Merged entities, ENTITY_SIMILAR edges |
| 2.10 | **Community summaries** — refreshed separately by the community summarizer after community changes | Updated summary text |

> **Community behavior.** `POST /ingest` defaults to `improve_mode=auto`: seed a
> missing full baseline, then update similarity and communities incrementally.
> Callers may choose `off`, force `incremental` (baseline required), or force
> `full`. Improvement remains separate from unit delta detection.

> **Periodic full improvement.** `POST /improve` runs the graph-wide Improve
> phase without scanning or ingesting source data. It is serialized with
> ingestion jobs, rebuilds the derived similarity layer (and the experimental
> community layer when enabled) from the current authoritative graph, and
> refreshes the server's adjacency index after committing. This is the normal
> periodic maintenance path for an incremental-first deployment; `POST /ingest`
> with `improve_mode=full` remains
> available when a source batch and a full rebuild intentionally belong to the
> same job.

> **Community feature gate.** Community detection, summarization, projection,
> and community-based query behavior are controlled together by
> `pipelines.experimental.communities.enabled` (`KL_COMMUNITIES_ENABLED`). The default is
> disabled until a cost-efficient incremental hierarchy is validated. When
> disabled, improvement still builds similarity relationships and may run
> disambiguation, but it neither rebuilds nor deletes existing community data;
> serving ignores any retained community assignments, summaries, vectors, and
> `COMM_MEMBER` edges. Re-enabling the gate followed by a full improvement
> refreshes the retained derived layer.

> **No watermark.** Timestamps are ordering metadata only. Re-running ingestion
> is idempotent because committed composite unit ids are skipped. A late message
> with an old timestamp but an unseen id is therefore processed normally.

> **Checkpoint and status.** Chunk, unit, and ordered membership rows commit in
> one `phase_a.persist_chunks` transaction before its checkpoint is marked done.
> Embedding, extraction, and graph construction consume that exact persisted
> batch workset. Failed runs retain it; successful runs checkpoint
> `ingest.complete` before deleting the temporary manifest.
> Additional requests queue behind the active worker, and `GET /status` reads
> persisted run state and counters from `ingest_runs`.

---

### Phase 3: Query-Time Improvement

Operations that fire during retrieval and **persist results back** to the graph, so future queries benefit. Distinct from pure query operations (which only read).

#### Instant Operations (sub-50ms, no LLM)

| Step | Operation | Effect |
|------|-----------|--------|
| 3.1 | **On-the-fly edge caching** — frequently-traversed multi-hop paths get materialized as direct edges | Faster future traversals |
| 3.2 | **Entity mention count updates** — increment counters on accessed entities | Keeps popularity scores current |

#### Sophisticated Operations (LLM, per-query)

| Step | Operation | Effect |
|------|-----------|--------|
| 3.3 | **On-the-fly fact extraction** — if a retrieved chunk has no cached extraction, run it now and persist | Graph grows with usage |
| 3.4 | **Missing-link inference** — suggest new edges based on query context (persist if confident) | Graph self-improves |

---

### Query Operations (read-only, not persisted)

Pure retrieval logic that reads the graph but does not mutate it. Separated from Phase 3 because these have no side effects.

#### Instant Operations (sub-50ms, no LLM)

| Step | Operation | Effect |
|------|-----------|--------|
| Q.1 | **FTS + dense hybrid** — BM25 + vector fusion (RRF) over chunks | Base retrieval |
| Q.2 | **Graph walk expansion** — BFS/DFS from seed nodes along typed edges | Expands context window |
| Q.3 | **Community-guided retrieval** — use community membership to pull related content | Thematic expansion |
| Q.4 | **PageRank / personalized scoring** — weight nodes by structural importance | Relevance ranking |
| Q.5 | **Batch exact-neighbor lookup** — filter incident edges for typed nodes by edge type, direction, and neighbor type through the in-memory adjacency index built from the configured graph authority; preserve input order and paginate per node | Backend-neutral graph primitive |

#### Sophisticated Operations (LLM, per-query)

| Step | Operation | Effect |
|------|-----------|--------|
| Q.6 | **Query rewrite** — decompose complex queries into sub-queries | Better recall |
| Q.7 | **LLM rerank** — rerank candidate set using LLM scoring | Precision boost |
| Q.8 | **Global search** — GraphRAG-style map-reduce over the current user's community summaries for conceptual questions | Aggregated, grounded answer (read-only) |

---

## Current Implementation Baseline

| Feature | Current State | Gap |
|---------|--------------|-----|
| **ENTAILS / CONTRADICTS** | Edge types defined but never populated | Need LLM detection step (1.23) |
| **Incremental ingestion** (Phase 2) | Implemented for unseen immutable units with ordered unit/chunk lineage, queued runs, checkpoints, and persisted status | Same-id content replacement and explicit deletion/reset remain TODOs |
