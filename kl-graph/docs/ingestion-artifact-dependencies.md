# Ingestion Artifact Dependencies

This document defines the correctness contracts between artifacts produced by
`POST /ingest`. It is the maintenance guide for producer/consumer relationships,
checkpoint invalidation, deletion semantics, and live-server publication.

For runtime cost and scaling, see
[Ingestion Cost Profile](ingestion-cost-profile.md). For endpoint behavior and
request semantics, see [Ingest API and Cost Guide](ingest-api.md).

## Pipeline boundary

Every server ingestion follows the same orchestration:

```text
Phase A → Phase B → Improvement → Finalization → completion → workset cleanup
```

Initial and incremental loads differ by the admitted durable workset and the
selected improvement mode, not by separate Phase A/Phase B implementations.
Only mutations routed through the server finalizer are published to its live
in-memory indexes; standalone writers require an explicit refresh or restart.

## Artifact dependency registry

This table is the primary dependency index. When changing a producer, artifact
schema, algorithm parameter, or consumer, follow its row through invalidation,
checkpoint, and replacement behavior.

| Artifact | Producer / authoritative input | Consumers | Refresh or invalidation trigger | Checkpoint / version contract | Delete / replacement semantics |
|---|---|---|---|---|---|
| Durable workset | Phase A admission after `(source_id, source_type, unit_id)` deduplication | Extraction, graph build, improvement target recovery, finalization scope | New checkpoint epoch or newly admitted unit | `batch_id` is the stable identity for the complete chain; `ingest.complete` is marked after finalization and before cleanup | Current ingestion is additive. Same-ID/different-content units are skipped. Cleanup is allowed only after every dependent phase succeeds |
| Chunk rows and vectors | Phase A persistence and embedding; inputs include chunk text and embedding generation | Chunk retrieval; Phase B extraction consumes chunk rows | New chunk, or a future text/model/dimension change | `phase_a.persist_chunks` and `phase_a.embed_chunks` do not currently record schema/model revisions | Deterministic Qdrant IDs support retry, but an existing vector is reused. Replacement must define overwrite and deletion behavior |
| Entity/fact rows and vectors | Extraction → entity/fact build → `phase_b.embed_graph` | ANN/full similarity, disambiguation, fact/entity retrieval | New node, or a node-text/model/dimension change | `phase_b.embed_graph` currently checks only its checkpoint and Qdrant point IDs, not an embedding generation | Existing point IDs are skipped. Replacement must update/delete vectors and invalidate similarity and communities downstream |
| Structural edges and `StructuralCache` | `phase_b.create_edges` persists MENTIONS, AUTHORED_BY, and ABOUT, then applies their cache delta | Improvement targets, entity hybrid scoring, community frontier; ABOUT also feeds PageRank | New structural edges or any future update/delete | Edge persistence and `apply_delta` must complete inside the same checkpoint boundary | The cache is append-only today. Deletion/replacement needs old/new deltas or a full cache rebuild |
| Similarity edges | Incremental ANN/intra-batch similarity; full similarity; full disambiguation | Community graphs, graph/query expansion, adjacency | Vector/structural-feature, threshold, weight, ANN policy, algorithm, or model-generation change | Incremental checkpoints record `batch_id` and strategy names; full checkpoints cover only some explicit thresholds | Most paths insert without canonical replacement. Rerunning does not remove every obsolete edge, so it is not a complete reconciliation |
| Community assignment columns | Incremental frontier Leiden or full Leiden over similarity and structural projections | COMM_MEMBER projection, summary generation, global-search membership lookup | Upstream graph, resolution, iteration count, or clustering algorithm change | `improve.incremental_leiden` follows similarity; full assignment and projection share `improve.communities` | Full mode clears and rewrites all assignments; incremental mode changes only the frontier. Changed UUIDs and reversible keys must survive checkpoint resume |
| Community rows and COMM_MEMBER | Assignment columns → scoped/full projection | Adjacency, graph walk, community browse, summary invalidation scope | Changed assignments | `improve.incremental_projection` depends on Leiden checkpoint metadata; full projection belongs to `improve.communities` | SQLite replacement is transactional; generic backends are best-effort. Removed memberships require both community and old-member adjacency buckets to refresh |
| Community summaries and vectors | Separate summarizer writes `community_summaries`; separate embedding tool writes community Qdrant | Global search, `/community`, community vector search | Membership/content or summarizer/embedding-generation change | Not covered by the `POST /ingest` checkpoint; no unified summary/vector generation revision exists | Incremental ingestion sets `communities.summary_stale`, but current consumers and community Qdrant do not honor it end to end |
| In-memory adjacency index | Server-start full build or ingest finalization over committed edges | Graph walk and context/entity/community endpoints | Any indexed edge insert/update/delete or projection-rule change | No durable checkpoint; server startup rebuilds it from the store | Incremental refresh discovers new endpoints from current state. Only COMM_MEMBER deletion recovers old endpoints; other future deletions need explicit old endpoints or a full rebuild |
| In-memory PageRank prior | Facts/confidence plus fact→entity ABOUT projection | Direct `state.pagerank` users and `state.engine.pagerank` | Fact confidence, ABOUT endpoints, PageRank parameters, or any future input change | No durable checkpoint; the dirty contract is currently hard-coded in the ingestion runner | Finalization replaces the dictionary and updates the query-engine handle. Any new cached consumer needs the same publication hook |

## Maintenance rules

1. When an artifact's input definition changes, change its producer generation or
   revision as well.
2. When a producer reruns, invalidate every downstream checkpoint unless its
   output can be proven valid for the new generation.
3. Recalculation is reconciliation only if obsolete output can be removed or
   replaced. Insert-only recomputation is not a full rebuild.
4. For edge deletion, refresh both the known changed endpoint and endpoints that
   existed only in the old generation.
5. A live server sees store mutations only after its publication callback or a
   restart. A successful database write alone does not update in-memory state.

## Critical dependency chains

### Vectors → similarity → communities → adjacency

```text
Phase B entity/fact rows
  → phase_b.embed_graph (Qdrant vectors)
  → improve.incremental_similarity (similarity edges)
  → improve.incremental_leiden (community assignment columns)
  → improve.incremental_projection (community rows + COMM_MEMBER)
  → finalization (adjacency buckets)
```

Changing the embedding generation, similarity thresholds/weights/ANN limit,
community resolutions, or algorithm implementation must invalidate from the
first affected artifact through every downstream step. Current incremental
checkpoint parameters do not include default thresholds, ANN top-K,
`RESOLUTIONS`, Leiden iteration count, embedding model, or implementation
version.

Similarity generation has an additional constraint: full and incremental
similarity primarily insert edges. Until canonical generated-edge ownership and
replacement semantics exist, lowering a threshold or changing a model can leave
old edges available to community detection.

### Community membership → summaries → vectors

```text
community assignment or membership changed
  → mark summary generation dirty
  → regenerate community_summaries
  → regenerate/upsert community vectors
  → publish or reopen the serving view when required
```

The current chain stops after the first step. Incremental projection writes
`communities.summary_stale`, while `GlobalSearch` reads `community_summaries`
directly and community vector search reads a separate Qdrant collection. Neither
uses that flag. It is therefore a rebuild signal, not completed invalidation,
and stale summaries/vectors may continue to be served.

## Adjacency contract

The adjacency index projects all edge schemas registered in `_EDGE_ENDPOINTS`.
Its dirty scope must cover every server-pipeline producer that inserts, updates,
or deletes an indexed edge.

| Producer | Edge types | Finalization signal |
|---|---|---|
| Phase B structural build | MENTIONS, AUTHORED_BY, ABOUT, TEMPORAL, REPLY_TO, STATES, PART_OF | `structural_nodes` seeded with workset chunks and facts; committed incident-edge discovery adds counterpart endpoints |
| Incremental similarity | ENTITY_SIMILAR, FACT_SIMILAR | `similarity_nodes` seeded with affected entities and facts |
| Incremental community projection | COMM_MEMBER | `community_ids` from `ImprovementResult.changed_community_ids` |
| Full improvement | Similarity and COMM_MEMBER changes | `full_adjacency=True`, which reconciles every persisted indexed edge |

When adding an edge type:

1. Declare it in the graph schema and `EdgeType`.
2. Add its typed endpoint schema to `_EDGE_ENDPOINTS`.
3. Make full and incremental adjacency projection agree.
4. Add the producer's dirty seeds to `ServingIndexUpdate`.
5. If it can be deleted, supply old endpoints or force full reconciliation.

Incremental deletion needs special care. Discovery reads committed post-write
state, so an endpoint connected only by a deleted edge is no longer discoverable.
The current implementation explicitly recovers old COMM_MEMBER endpoints from
the prior adjacency snapshot, but does not do so for future structural or
similarity deletion paths.

`AdjacencyIndex` is immutable. `replace_buckets()` returns a new instance and
the server publishes it by reference assignment, allowing in-flight readers to
finish against the old snapshot.

## PageRank contract

The current PageRank prior is a facts-only entity projection:

| Input | Producer | Current dirty signal |
|---|---|---|
| Fact rows and confidence | Phase B fact construction | Workset fact IDs |
| ABOUT endpoints | Phase B structural edge construction | `pagerank_dirty=bool(targets.fact_ids)` |

Similarity and community changes do not affect the current prior, so full
improvement alone does not require PageRank. If PageRank begins consuming
ENTITY_SIMILAR, community structure, or another artifact, the runner's dirty
contract must change with the computation.

On refresh, `_hot_swap_graph` updates both `state.pagerank` and the query
engine's cached `pagerank` handle. Future consumers that retain a reference must
join this publication step.

## StructuralCache contract

`StructuralCache` stores bidirectional mappings for MENTIONS, AUTHORED_BY, and
ABOUT. The `phase_b.create_edges` checkpoint includes both durable edge writes
and `apply_delta`; a failure before the delta completes leaves the checkpoint
incomplete so retry can reconstruct and reapply it.

The cache assumes these structural edges are append-only. Future replacement or
deletion must add removal deltas to all four mappings or rebuild the cache from
the authoritative store before improvement target recovery and scoring.

## Improvement-to-finalization contract

Incremental community scope is propagated through this chain:

```text
communities.assign_communities()
  → CommunityChanges (UUIDs + reversible assignment keys)
  → ImprovementResult.changed_community_ids
  → ServingIndexUpdate.community_ids
  → _hot_swap_graph()
  → scoped COMM_MEMBER adjacency reconciliation
```

A new step that changes membership must emit both community UUIDs and reversible
assignment keys, persist them in checkpoint metadata, and include them in the
finalization update. An empty changed set is intentionally a no-op.

## Checkpoint and workset ordering

The safe completion sequence is:

```text
persist phase outputs
  → finish improvement
  → publish serving indexes
  → mark ingest.complete
  → clean the durable workset
```

Marking completion before cleanup is deliberate. A crash in that small window
enters the completed-run recovery branch and retries cleanup without repeating
expensive phases. Cleaning earlier would destroy the authoritative target scope
needed to recover improvement and finalization.

Checkpoint source identity alone is insufficient for algorithm evolution.
Thresholds, model generations, schema versions, and algorithm versions that
change output should be included in checkpoint parameters or a shared artifact
generation fingerprint.

## Live-server publication boundary

The server endpoint passes `ServingIndexUpdate` to `_hot_swap_graph`; standalone
improvement scripts and other out-of-band store writers do not. If such a writer
runs while the server is live, persisted data and serving indexes can diverge
until an explicit complete refresh or server restart.
