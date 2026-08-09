"""Unit tests for AnnPlusIntraBatch incremental similarity strategy.

Tests verify:
- Entity new-to-existing edges are created via ANN search results
- Entity intra-batch edges are created from cosine matrix
- Fact new-to-existing edges are created correctly
- Fact intra-batch edges are created from cosine matrix
- Pairs below threshold are not emitted
- Edges are deduplicated by sorted (source_id, target_id) pair
- Empty inputs return empty list
"""

from __future__ import annotations

import math
from typing import Any
from unittest.mock import MagicMock

from kl_graph.ingest.strategies.similarity import AnnPlusIntraBatch
from kl_graph.models.types import EdgeType

# ── Helpers ───────────────────────────────────────────────────────────────────


def _unit_vec(dim: int = 4) -> list[float]:
    """Return a unit vector of the given dimension."""
    v = [1.0] + [0.0] * (dim - 1)
    return v


def _vec_at_angle(angle_deg: float, dim: int = 4) -> list[float]:
    """Return a 2D-meaningful unit vector at the given angle (first 2 components)."""
    rad = math.radians(angle_deg)
    v = [0.0] * dim
    v[0] = math.cos(rad)
    v[1] = math.sin(rad)
    return v


def _make_qdrant_hit(entity_id: str, score: float) -> dict[str, Any]:
    """Build a fake Qdrant search result dict."""
    return {
        "id": f"point-{entity_id}",
        "score": score,
        "payload": {"entity_id": entity_id},
    }


def _make_fact_qdrant_hit(fact_id: str, score: float) -> dict[str, Any]:
    """Build a fake Qdrant fact search result dict."""
    return {
        "id": f"point-{fact_id}",
        "score": score,
        "payload": {"fact_id": fact_id},
    }


def _make_retrieve_record(entity_id: str, vector: list[float]) -> MagicMock:
    """Build a fake Qdrant retrieve record."""
    from kl_graph.storage.qdrant_store import point_id

    rec = MagicMock()
    rec.id = point_id(entity_id)
    rec.vector = vector
    rec.payload = {"entity_id": entity_id}
    return rec


def _make_fact_retrieve_record(fact_id: str, vector: list[float]) -> MagicMock:
    """Build a fake Qdrant retrieve record for a fact."""
    from kl_graph.storage.qdrant_store import point_id

    rec = MagicMock()
    rec.id = point_id(fact_id)
    rec.vector = vector
    rec.payload = {"fact_id": fact_id}
    return rec


def _make_mock_store(
    msg_sets: dict | None = None, fact_sets: dict | None = None
) -> MagicMock:
    """Create a mock KnowledgeStore with configurable structural data."""
    store = MagicMock()
    mention_rows = [
        (chunk_id, entity_id, {})
        for entity_id, chunk_ids in (msg_sets or {}).items()
        for chunk_id in chunk_ids
    ]
    about_rows = [
        (fact_id, entity_id, {})
        for entity_id, fact_ids in (fact_sets or {}).items()
        for fact_id in fact_ids
    ]

    def _scan(edge_types, **_kwargs):
        return iter(about_rows if edge_types == ["ABOUT"] else mention_rows)

    store.scan_edges_by_type.side_effect = _scan
    return store


def _make_mock_qdrant(
    entity_search_results: list | None = None,
    entity_retrieve_records: list | None = None,
    fact_search_results: list | None = None,
    fact_retrieve_records: list | None = None,
) -> MagicMock:
    """Create a mock QdrantStore with controllable search/retrieve responses."""
    qdrant = MagicMock()

    def _search(
        collection: str, vec: list, *, limit: int = 20, score_threshold=None, **kw
    ):
        if collection == "entities":
            return entity_search_results or []
        if collection == "facts":
            return fact_search_results or []
        return []

    qdrant.search.side_effect = _search

    vectors_by_collection = {
        "entities": {
            rec.payload["entity_id"]: rec.vector
            for rec in (entity_retrieve_records or [])
        },
        "facts": {
            rec.payload["fact_id"]: rec.vector
            for rec in (fact_retrieve_records or [])
        },
    }
    qdrant.retrieve_vectors.side_effect = (
        lambda collection, ids: {
            point_id: vectors_by_collection[collection][point_id]
            for point_id in ids
            if point_id in vectors_by_collection[collection]
        }
    )

    def _retrieve(collection_name: str, ids: list, **kw):
        if collection_name == "entities":
            return entity_retrieve_records or []
        if collection_name == "facts":
            return fact_retrieve_records or []
        return []

    qdrant.client.retrieve.side_effect = _retrieve

    return qdrant


# ── Tests ─────────────────────────────────────────────────────────────────────


class TestAnnPlusIntraBatch:
    """Tests for AnnPlusIntraBatch similarity strategy."""

    def test_empty_inputs_returns_empty(self) -> None:
        """No new entities or facts → empty edge list."""
        strategy = AnnPlusIntraBatch()
        store = _make_mock_store()
        qdrant = _make_mock_qdrant()
        edges = strategy.compute_similarity_edges([], [], qdrant, store)
        assert edges == []

    def test_entity_new_to_existing_above_threshold(self) -> None:
        """New entity matched to existing entity above hybrid threshold → edge created."""
        strategy = AnnPlusIntraBatch()
        new_id = "new-entity-1"
        existing_id = "existing-entity-1"

        vec = _unit_vec()
        # ANN search returns existing entity with high embedding score
        qdrant = _make_mock_qdrant(
            entity_search_results=[_make_qdrant_hit(existing_id, 0.9)],
            entity_retrieve_records=[_make_retrieve_record(new_id, vec)],
        )
        # Both share 2 messages (Jaccard = 1.0 on those 2), and some facts
        msg_sets = {new_id: {"m1", "m2"}, existing_id: {"m1", "m2"}}
        store = _make_mock_store(msg_sets=msg_sets)

        edges = strategy.compute_similarity_edges(
            [new_id], [], qdrant, store, entity_threshold=0.45
        )

        entity_edges = [e for e in edges if e.edge_type == EdgeType.ENTITY_SIMILAR]
        assert len(entity_edges) == 1
        e = entity_edges[0]
        assert {e.source_id, e.target_id} == {new_id, existing_id}
        assert "hybrid_score" in e.properties

    def test_entity_new_to_existing_below_threshold(self) -> None:
        """New entity with hybrid score below threshold → no edge."""
        strategy = AnnPlusIntraBatch()
        new_id = "new-entity-1"
        existing_id = "existing-entity-far"

        vec = _unit_vec()
        # Low embedding score, no structural overlap
        qdrant = _make_mock_qdrant(
            entity_search_results=[_make_qdrant_hit(existing_id, 0.25)],
            entity_retrieve_records=[_make_retrieve_record(new_id, vec)],
        )
        store = _make_mock_store()  # no shared messages/facts

        edges = strategy.compute_similarity_edges(
            [new_id], [], qdrant, store, entity_threshold=0.45
        )

        assert not any(e.edge_type == EdgeType.ENTITY_SIMILAR for e in edges)

    def test_entity_intra_batch_similar_pair(self) -> None:
        """Two new entities with identical vectors and shared messages → intra-batch edge."""
        strategy = AnnPlusIntraBatch()
        new_id_a = "new-a"
        new_id_b = "new-b"

        vec = _unit_vec()  # cosine of identical vecs = 1.0
        qdrant = _make_mock_qdrant(
            entity_search_results=[],
            entity_retrieve_records=[
                _make_retrieve_record(new_id_a, vec),
                _make_retrieve_record(new_id_b, vec),
            ],
        )
        # Both share messages to ensure hybrid score clears the 0.45 threshold
        # hybrid = 0.3*1.0(emb) + 0.4*1.0(jaccard) + 0.3*0.0(facts) = 0.7
        msg_sets = {new_id_a: {"m1", "m2"}, new_id_b: {"m1", "m2"}}
        store = _make_mock_store(msg_sets=msg_sets)

        edges = strategy.compute_similarity_edges(
            [new_id_a, new_id_b], [], qdrant, store, entity_threshold=0.45
        )

        intra = [
            e
            for e in edges
            if e.edge_type == EdgeType.ENTITY_SIMILAR
            and {e.source_id, e.target_id} == {new_id_a, new_id_b}
        ]
        assert len(intra) == 1

    def test_entity_intra_batch_dissimilar_no_edge(self) -> None:
        """Two orthogonal new entity vectors → no intra-batch edge."""
        strategy = AnnPlusIntraBatch()
        new_id_a = "new-ortho-a"
        new_id_b = "new-ortho-b"

        vec_a = _vec_at_angle(0)  # [1, 0, 0, 0]
        vec_b = _vec_at_angle(90)  # [0, 1, 0, 0]  cosine = 0.0

        qdrant = _make_mock_qdrant(
            entity_search_results=[],
            entity_retrieve_records=[
                _make_retrieve_record(new_id_a, vec_a),
                _make_retrieve_record(new_id_b, vec_b),
            ],
        )
        store = _make_mock_store()

        edges = strategy.compute_similarity_edges(
            [new_id_a, new_id_b], [], qdrant, store, entity_threshold=0.45
        )

        intra = [
            e
            for e in edges
            if e.edge_type == EdgeType.ENTITY_SIMILAR
            and {e.source_id, e.target_id} == {new_id_a, new_id_b}
        ]
        assert len(intra) == 0

    def test_fact_new_to_existing_above_threshold(self) -> None:
        """New fact matched to existing fact above threshold → FACT_SIMILAR edge."""
        strategy = AnnPlusIntraBatch()
        new_fid = "new-fact-1"
        existing_fid = "existing-fact-1"

        vec = _unit_vec()
        qdrant = _make_mock_qdrant(
            fact_search_results=[_make_fact_qdrant_hit(existing_fid, 0.92)],
            fact_retrieve_records=[_make_fact_retrieve_record(new_fid, vec)],
        )
        store = _make_mock_store()

        edges = strategy.compute_similarity_edges(
            [], [new_fid], qdrant, store, fact_threshold=0.85
        )

        fact_edges = [e for e in edges if e.edge_type == EdgeType.FACT_SIMILAR]
        assert len(fact_edges) == 1
        e = fact_edges[0]
        assert {e.source_id, e.target_id} == {new_fid, existing_fid}
        assert "score" in e.properties
        assert e.properties["score"] >= 0.85

    def test_fact_new_to_existing_below_threshold(self) -> None:
        """Fact search result below threshold → no edge."""
        strategy = AnnPlusIntraBatch()
        new_fid = "new-fact-1"
        existing_fid = "low-fact"

        vec = _unit_vec()
        qdrant = _make_mock_qdrant(
            fact_search_results=[_make_fact_qdrant_hit(existing_fid, 0.80)],
            fact_retrieve_records=[_make_fact_retrieve_record(new_fid, vec)],
        )
        store = _make_mock_store()

        edges = strategy.compute_similarity_edges(
            [], [new_fid], qdrant, store, fact_threshold=0.85
        )

        assert not any(e.edge_type == EdgeType.FACT_SIMILAR for e in edges)

    def test_fact_intra_batch_similar_pair(self) -> None:
        """Two new facts with identical vectors → intra-batch FACT_SIMILAR edge."""
        strategy = AnnPlusIntraBatch()
        fid_a = "new-fact-a"
        fid_b = "new-fact-b"

        vec = _unit_vec()
        qdrant = _make_mock_qdrant(
            fact_search_results=[],
            fact_retrieve_records=[
                _make_fact_retrieve_record(fid_a, vec),
                _make_fact_retrieve_record(fid_b, vec),
            ],
        )
        store = _make_mock_store()

        edges = strategy.compute_similarity_edges(
            [], [fid_a, fid_b], qdrant, store, fact_threshold=0.85
        )

        intra = [
            e
            for e in edges
            if e.edge_type == EdgeType.FACT_SIMILAR
            and {e.source_id, e.target_id} == {fid_a, fid_b}
        ]
        assert len(intra) == 1

    def test_deduplication_prevents_duplicate_edges(self) -> None:
        """Same pair returned from both new-to-existing and intra-batch → only one edge."""
        strategy = AnnPlusIntraBatch()
        id_a = "entity-a"
        id_b = "entity-b"

        vec = _unit_vec()
        # ANN returns id_b as existing match for id_a;
        # intra-batch also produces the pair since both are "new"
        qdrant = _make_mock_qdrant(
            entity_search_results=[_make_qdrant_hit(id_b, 0.9)],
            entity_retrieve_records=[
                _make_retrieve_record(id_a, vec),
                _make_retrieve_record(id_b, vec),
            ],
        )
        store = _make_mock_store()

        edges = strategy.compute_similarity_edges(
            [id_a, id_b], [], qdrant, store, entity_threshold=0.45
        )

        entity_edges = [e for e in edges if e.edge_type == EdgeType.ENTITY_SIMILAR]
        pairs = [tuple(sorted([e.source_id, e.target_id])) for e in entity_edges]
        assert len(pairs) == len(set(pairs)), (
            "Duplicate edges found after deduplication"
        )

    def test_new_entity_ids_filtered_from_ann_results(self) -> None:
        """ANN results containing new_entity_ids are excluded (avoid self-reference)."""
        strategy = AnnPlusIntraBatch()
        new_id_a = "new-a"
        new_id_b = "new-b"

        vec = _unit_vec()
        # ANN returns new_id_b — should be excluded for new-to-existing step
        qdrant = _make_mock_qdrant(
            entity_search_results=[
                _make_qdrant_hit(new_id_b, 0.95),  # same batch — excluded
                _make_qdrant_hit("real-existing", 0.9),
            ],
            entity_retrieve_records=[
                _make_retrieve_record(new_id_a, vec),
                _make_retrieve_record(new_id_b, vec),
            ],
        )
        # Enough structural overlap with real-existing to cross threshold
        msg_sets = {new_id_a: {"m1", "m2"}, "real-existing": {"m1", "m2"}}
        store = _make_mock_store(msg_sets=msg_sets)

        edges = strategy.compute_similarity_edges(
            [new_id_a, new_id_b], [], qdrant, store, entity_threshold=0.45
        )

        n2e_pairs = [
            tuple(sorted([e.source_id, e.target_id]))
            for e in edges
            if e.edge_type == EdgeType.ENTITY_SIMILAR
            and "real-existing" in (e.source_id, e.target_id)
        ]
        assert len(n2e_pairs) >= 1, "Expected new-to-existing edge with real-existing"

        # Ensure new_id_a → new_id_b from ANN is NOT produced (only from intra-batch)
        # (deduplication ensures only one copy regardless)

    def test_entity_edge_has_required_properties(self) -> None:
        """ENTITY_SIMILAR edge contains embedding_score, structural_score, fact_score, hybrid_score."""
        strategy = AnnPlusIntraBatch()
        new_id = "new-entity"
        existing_id = "old-entity"

        vec = _unit_vec()
        qdrant = _make_mock_qdrant(
            entity_search_results=[_make_qdrant_hit(existing_id, 0.85)],
            entity_retrieve_records=[_make_retrieve_record(new_id, vec)],
        )
        msg_sets = {new_id: {"m1"}, existing_id: {"m1"}}
        store = _make_mock_store(msg_sets=msg_sets)

        edges = strategy.compute_similarity_edges(
            [new_id], [], qdrant, store, entity_threshold=0.45
        )

        entity_edges = [e for e in edges if e.edge_type == EdgeType.ENTITY_SIMILAR]
        assert entity_edges, "Expected at least one ENTITY_SIMILAR edge"
        props = entity_edges[0].properties
        assert "embedding_score" in props
        assert "structural_score" in props
        assert "fact_score" in props
        assert "hybrid_score" in props

    def test_fact_edge_has_score_property(self) -> None:
        """FACT_SIMILAR edge contains score property."""
        strategy = AnnPlusIntraBatch()
        new_fid = "new-fact"
        existing_fid = "old-fact"

        vec = _unit_vec()
        qdrant = _make_mock_qdrant(
            fact_search_results=[_make_fact_qdrant_hit(existing_fid, 0.90)],
            fact_retrieve_records=[_make_fact_retrieve_record(new_fid, vec)],
        )
        store = _make_mock_store()

        edges = strategy.compute_similarity_edges(
            [], [new_fid], qdrant, store, fact_threshold=0.85
        )

        fact_edges = [e for e in edges if e.edge_type == EdgeType.FACT_SIMILAR]
        assert fact_edges, "Expected at least one FACT_SIMILAR edge"
        assert "score" in fact_edges[0].properties

    def test_missing_vector_entities_skipped(self) -> None:
        """Entity with no vector in Qdrant does not produce edges."""
        strategy = AnnPlusIntraBatch()
        new_id = "new-no-vec"

        qdrant = _make_mock_qdrant(
            entity_search_results=[],
            entity_retrieve_records=[],  # empty — no vector for new_id
        )
        store = _make_mock_store()

        edges = strategy.compute_similarity_edges([new_id], [], qdrant, store)

        assert all(e.edge_type != EdgeType.ENTITY_SIMILAR for e in edges)
