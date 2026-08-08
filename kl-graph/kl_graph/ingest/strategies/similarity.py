"""Default incremental similarity strategy — ANN + intra-batch cosine for computing
ENTITY_SIMILAR and FACT_SIMILAR edges between new and existing nodes.
"""

from __future__ import annotations

import logging
from typing import NamedTuple

import numpy as np

from kl_graph.models.types import Edge, EdgeType
from kl_graph.periodic.entity_similarity import jaccard, overlap_coefficient
from kl_graph.storage.base import KnowledgeStore
from kl_graph.storage.qdrant_store import QdrantStore, point_id

logger = logging.getLogger(__name__)

# Weights for entity hybrid score — must match full-rebuild weights in entity_similarity.py.
_W_EMBEDDING = 0.3
_W_STRUCTURAL = 0.4
_W_FACTS = 0.3

# ANN pre-filter: fetch top-K neighbors per new node.
_ANN_TOP_K = 50


class _HybridResult(NamedTuple):
    """Components of the entity hybrid similarity score."""

    struct_score: float
    fact_score: float
    hybrid: float


class AnnPlusIntraBatch:
    """Incremental similarity using Qdrant ANN for new-to-existing and direct cosine for new-to-new.

    Hybrid score for entities uses same weights as full rebuild:
    0.3 * embedding + 0.4 * structural (Jaccard co-occurrence) + 0.3 * fact_overlap
    Structural data (msg_sets, fact_sets) loaded through the graph-store API:
    entity_id -> set of chunk_ids (MENTIONS/AUTHORED_BY edges),
    entity_id -> set of fact_ids (ABOUT edges)
    """

    def compute_similarity_edges(
        self,
        new_entity_ids: list[str],
        new_fact_ids: list[str],
        qdrant: QdrantStore,
        store: KnowledgeStore,
        *,
        entity_threshold: float = 0.45,
        fact_threshold: float = 0.85,
        cached_msg_sets: dict[str, set[str]] | None = None,
        cached_fact_sets: dict[str, set[str]] | None = None,
    ) -> list[Edge]:
        """Compute similarity edges for the incremental batch.

        Internal steps (implemented as private helper methods):
        1. Entity new-to-existing: for each new entity, qdrant.search("entities",
           vector, limit=50, score_threshold=entity_threshold-0.05), filter out
           new_entity_ids from results, compute hybrid score, keep >= entity_threshold.
        2. Entity intra-batch: retrieve vectors for all new_entity_ids from qdrant
           via client.retrieve(with_vectors=True), compute pairwise cosine matrix
           (numpy: normalize then matmul), apply hybrid scoring, filter at threshold.
        3. Fact new-to-existing: for each new fact, qdrant.search("facts", vector,
           limit=50, score_threshold=fact_threshold-0.05), filter out new_fact_ids,
           keep score >= fact_threshold.
        4. Fact intra-batch: retrieve vectors for all new_fact_ids, compute pairwise
           cosine, create edges for pairs >= fact_threshold.
        5. Deduplicate all edges by tuple(sorted([source_id, target_id])).

        Args:
            new_entity_ids: Entity IDs from this incremental run.
            new_fact_ids: Fact IDs from this incremental run.
            qdrant: QdrantStore for ANN search against existing vectors.
            store: KnowledgeStore for structural co-occurrence data.
            entity_threshold: Minimum hybrid score for ENTITY_SIMILAR (default 0.45).
            fact_threshold: Minimum cosine for FACT_SIMILAR (default 0.85).

        Returns:
            Deduplicated list of ENTITY_SIMILAR and FACT_SIMILAR edges.
        """
        edges: list[Edge] = []

        if new_entity_ids:
            if cached_msg_sets is not None and cached_fact_sets is not None:
                msg_sets = cached_msg_sets
                fact_sets = cached_fact_sets
            else:
                msg_sets, fact_sets = self._load_structural_data(store)
            entity_vecs = self._retrieve_vectors(qdrant, "entities", new_entity_ids)

            edges.extend(
                self._entity_new_to_existing(
                    new_entity_ids,
                    entity_vecs,
                    qdrant,
                    msg_sets,
                    fact_sets,
                    entity_threshold=entity_threshold,
                )
            )
            edges.extend(
                self._entity_intra_batch(
                    new_entity_ids,
                    entity_vecs,
                    msg_sets,
                    fact_sets,
                    entity_threshold=entity_threshold,
                )
            )

        if new_fact_ids:
            fact_vecs = self._retrieve_vectors(qdrant, "facts", new_fact_ids)

            edges.extend(
                self._fact_new_to_existing(
                    new_fact_ids,
                    fact_vecs,
                    qdrant,
                    fact_threshold=fact_threshold,
                )
            )
            edges.extend(
                self._fact_intra_batch(
                    new_fact_ids,
                    fact_vecs,
                    fact_threshold=fact_threshold,
                )
            )

        return self._deduplicate(edges)

    # ── Private helpers ──────────────────────────────────────────────────────

    def _load_structural_data(
        self, store: KnowledgeStore
    ) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
        """Load msg_sets and fact_sets for all entities from the store.

        Returns:
            Tuple of (msg_sets, fact_sets) mapping entity_id to sets of IDs.
        """
        msg_sets: dict[str, set[str]] = {}
        fact_sets: dict[str, set[str]] = {}

        for chunk_id, entity_id, _props in store.scan_edges_by_type(
            ["MENTIONS", "AUTHORED_BY"],
            source_type="chunk",
            target_type="entity",
        ):
            msg_sets.setdefault(entity_id, set()).add(chunk_id)

        for fact_id, entity_id, _props in store.scan_edges_by_type(
            ["ABOUT"], source_type="fact", target_type="entity"
        ):
            fact_sets.setdefault(entity_id, set()).add(fact_id)

        return msg_sets, fact_sets

    def _retrieve_vectors(
        self, qdrant: QdrantStore, collection: str, ids: list[str]
    ) -> dict[str, list[float]]:
        """Retrieve stored vectors for a list of entity/fact IDs.

        Args:
            qdrant: QdrantStore to retrieve from.
            collection: "entities" or "facts".
            ids: Entity or fact IDs whose vectors to fetch.

        Returns:
            Dict mapping entity/fact ID to its vector (missing IDs are omitted).
        """
        result: dict[str, list[float]] = {}
        batch_size = 256
        for i in range(0, len(ids), batch_size):
            batch = ids[i : i + batch_size]
            pids = [point_id(eid) for eid in batch]
            records = qdrant.client.retrieve(
                collection_name=collection,
                ids=pids,
                with_payload=True,
                with_vectors=True,
            )
            pid_to_id = {point_id(eid): eid for eid in batch}
            for rec in records:
                orig_id = pid_to_id.get(str(rec.id))
                if orig_id and rec.vector is not None:
                    result[orig_id] = rec.vector
        return result

    def _hybrid_score(
        self,
        src_id: str,
        tgt_id: str,
        emb_score: float,
        msg_sets: dict[str, set[str]],
        fact_sets: dict[str, set[str]],
    ) -> _HybridResult:
        """Compute hybrid similarity score components for an entity pair.

        Args:
            src_id: Source entity ID.
            tgt_id: Target entity ID.
            emb_score: Cosine embedding similarity.
            msg_sets: Mapping of entity_id to chunk ID sets.
            fact_sets: Mapping of entity_id to fact ID sets.

        Returns:
            _HybridResult with struct_score, fact_score, and hybrid (weighted sum).
        """
        src_msgs = msg_sets.get(src_id, set())
        tgt_msgs = msg_sets.get(tgt_id, set())
        struct_score = jaccard(src_msgs, tgt_msgs)

        src_facts = fact_sets.get(src_id, set())
        tgt_facts = fact_sets.get(tgt_id, set())
        fact_score = overlap_coefficient(src_facts, tgt_facts)

        hybrid = (
            _W_EMBEDDING * emb_score
            + _W_STRUCTURAL * struct_score
            + _W_FACTS * fact_score
        )
        return _HybridResult(
            struct_score=struct_score, fact_score=fact_score, hybrid=hybrid
        )

    def _entity_new_to_existing(
        self,
        new_entity_ids: list[str],
        entity_vecs: dict[str, list[float]],
        qdrant: QdrantStore,
        msg_sets: dict[str, set[str]],
        fact_sets: dict[str, set[str]],
        *,
        entity_threshold: float,
    ) -> list[Edge]:
        """Compute ENTITY_SIMILAR edges from new entities to existing entities via ANN.

        Args:
            new_entity_ids: IDs of new entities.
            entity_vecs: Vectors keyed by entity ID.
            qdrant: QdrantStore for ANN search.
            msg_sets: Co-occurrence message sets per entity.
            fact_sets: Fact participation sets per entity.
            entity_threshold: Minimum hybrid score to emit edge.

        Returns:
            List of ENTITY_SIMILAR edges.
        """
        edges: list[Edge] = []
        new_id_set = set(new_entity_ids)
        ann_threshold = max(0.0, entity_threshold - 0.05)

        for src_id in new_entity_ids:
            vec = entity_vecs.get(src_id)
            if vec is None:
                continue

            results = qdrant.search(
                "entities",
                vec,
                limit=_ANN_TOP_K,
                score_threshold=ann_threshold,
            )
            for hit in results:
                tgt_id = hit["payload"].get("entity_id")
                if not tgt_id or tgt_id == src_id or tgt_id in new_id_set:
                    continue

                emb_score = float(hit["score"])
                result = self._hybrid_score(
                    src_id, tgt_id, emb_score, msg_sets, fact_sets
                )
                if result.hybrid >= entity_threshold:
                    edges.append(
                        Edge(
                            source_type="entity",
                            source_id=src_id,
                            target_type="entity",
                            target_id=tgt_id,
                            edge_type=EdgeType.ENTITY_SIMILAR,
                            properties={
                                "embedding_score": round(emb_score, 4),
                                "structural_score": round(result.struct_score, 4),
                                "fact_score": round(result.fact_score, 4),
                                "hybrid_score": round(result.hybrid, 4),
                            },
                        )
                    )
        return edges

    def _entity_intra_batch(
        self,
        new_entity_ids: list[str],
        entity_vecs: dict[str, list[float]],
        msg_sets: dict[str, set[str]],
        fact_sets: dict[str, set[str]],
        *,
        entity_threshold: float,
    ) -> list[Edge]:
        """Compute ENTITY_SIMILAR edges within the batch of new entities.

        Args:
            new_entity_ids: IDs of new entities.
            entity_vecs: Vectors keyed by entity ID.
            msg_sets: Co-occurrence message sets per entity.
            fact_sets: Fact participation sets per entity.
            entity_threshold: Minimum hybrid score to emit edge.

        Returns:
            List of ENTITY_SIMILAR edges within the batch.
        """
        edges: list[Edge] = []
        ids_with_vecs = [eid for eid in new_entity_ids if eid in entity_vecs]
        if len(ids_with_vecs) < 2:
            return edges

        vecs = np.array([entity_vecs[eid] for eid in ids_with_vecs], dtype=np.float32)
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        vecs_norm = vecs / norms

        # Pairwise cosine similarity matrix
        sims = vecs_norm @ vecs_norm.T
        n = len(ids_with_vecs)

        for i in range(n):
            for j in range(i + 1, n):
                emb_score = float(sims[i, j])
                src_id = ids_with_vecs[i]
                tgt_id = ids_with_vecs[j]

                result = self._hybrid_score(
                    src_id, tgt_id, emb_score, msg_sets, fact_sets
                )
                if result.hybrid >= entity_threshold:
                    edges.append(
                        Edge(
                            source_type="entity",
                            source_id=src_id,
                            target_type="entity",
                            target_id=tgt_id,
                            edge_type=EdgeType.ENTITY_SIMILAR,
                            properties={
                                "embedding_score": round(emb_score, 4),
                                "structural_score": round(result.struct_score, 4),
                                "fact_score": round(result.fact_score, 4),
                                "hybrid_score": round(result.hybrid, 4),
                            },
                        )
                    )
        return edges

    def _fact_new_to_existing(
        self,
        new_fact_ids: list[str],
        fact_vecs: dict[str, list[float]],
        qdrant: QdrantStore,
        *,
        fact_threshold: float,
    ) -> list[Edge]:
        """Compute FACT_SIMILAR edges from new facts to existing facts via ANN.

        Args:
            new_fact_ids: IDs of new facts.
            fact_vecs: Vectors keyed by fact ID.
            qdrant: QdrantStore for ANN search.
            fact_threshold: Minimum cosine score to emit edge.

        Returns:
            List of FACT_SIMILAR edges.
        """
        edges: list[Edge] = []
        new_id_set = set(new_fact_ids)
        ann_threshold = max(0.0, fact_threshold - 0.05)

        for src_id in new_fact_ids:
            vec = fact_vecs.get(src_id)
            if vec is None:
                continue

            results = qdrant.search(
                "facts",
                vec,
                limit=_ANN_TOP_K,
                score_threshold=ann_threshold,
            )
            for hit in results:
                tgt_id = hit["payload"].get("fact_id")
                if not tgt_id or tgt_id == src_id or tgt_id in new_id_set:
                    continue

                score = float(hit["score"])
                if score >= fact_threshold:
                    edges.append(
                        Edge(
                            source_type="fact",
                            source_id=src_id,
                            target_type="fact",
                            target_id=tgt_id,
                            edge_type=EdgeType.FACT_SIMILAR,
                            properties={"score": round(score, 4)},
                        )
                    )
        return edges

    def _fact_intra_batch(
        self,
        new_fact_ids: list[str],
        fact_vecs: dict[str, list[float]],
        *,
        fact_threshold: float,
    ) -> list[Edge]:
        """Compute FACT_SIMILAR edges within the batch of new facts.

        Args:
            new_fact_ids: IDs of new facts.
            fact_vecs: Vectors keyed by fact ID.
            fact_threshold: Minimum cosine score to emit edge.

        Returns:
            List of FACT_SIMILAR edges within the batch.
        """
        edges: list[Edge] = []
        ids_with_vecs = [fid for fid in new_fact_ids if fid in fact_vecs]
        if len(ids_with_vecs) < 2:
            return edges

        vecs = np.array([fact_vecs[fid] for fid in ids_with_vecs], dtype=np.float32)
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        vecs_norm = vecs / norms

        sims = vecs_norm @ vecs_norm.T
        n = len(ids_with_vecs)

        for i in range(n):
            for j in range(i + 1, n):
                score = float(sims[i, j])
                if score >= fact_threshold:
                    edges.append(
                        Edge(
                            source_type="fact",
                            source_id=ids_with_vecs[i],
                            target_type="fact",
                            target_id=ids_with_vecs[j],
                            edge_type=EdgeType.FACT_SIMILAR,
                            properties={"score": round(score, 4)},
                        )
                    )
        return edges

    def _deduplicate(self, edges: list[Edge]) -> list[Edge]:
        """Remove duplicate edges by (sorted source_id, target_id) pair.

        Args:
            edges: All candidate edges (may contain duplicates).

        Returns:
            Deduplicated edge list preserving first-seen order.
        """
        seen: set[tuple[str, str, str]] = set()
        result: list[Edge] = []
        for edge in edges:
            key = (edge.edge_type.value, *sorted([edge.source_id, edge.target_id]))
            if key not in seen:
                seen.add(key)
                result.append(edge)
        return result
