"""Backend parity for periodic improvement's edge access.

The periodic stages used to read/write the SQLite ``edges`` table directly,
which is empty on the ladybug backend — so ``run_periodic_improvement`` raised
rather than silently build empty communities. Now every stage reads edges via
``KnowledgeStore.scan_edges_by_type`` and writes via ``insert_edges`` /
``delete_edges``, so both backends behave identically.

These tests build the *same* tiny graph on each backend and assert the edge
reads that feed community detection + disambiguation are equivalent. No Qdrant,
no LLM, no clustering deps required.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from kl_graph.ingest.strategies.similarity import AnnPlusIntraBatch
from kl_graph.models.types import Edge, EdgeType, Entity, EntityType, Fact, FactType
from kl_graph.storage.base import create_store

has_ladybug = True
try:
    import ladybug  # noqa: F401
except ImportError:
    has_ladybug = False

skip_no_ladybug = pytest.mark.skipif(
    not has_ladybug, reason="ladybug not installed"
)


def _seed(store) -> None:
    """Seed a tiny graph: 2 chunks, 2 entities, 1 fact, and every read-path edge type."""
    store.insert_chunks(
        [
            _chunk("c1", "第一条消息 关于 悟空"),
            _chunk("c2", "第二条消息 关于 新悟空"),
        ]
    )
    store.upsert_entities(
        [
            Entity(id="e1", name="悟空", entity_type=EntityType.PROJECT, mention_count=2),
            Entity(id="e2", name="新悟空", entity_type=EntityType.PROJECT, mention_count=1),
        ]
    )
    store.insert_facts(
        [Fact(id="f1", text="悟空项目上线", fact_type=FactType.GENERAL, confidence=0.9)]
    )
    store.insert_edges(
        [
            # MENTIONS / AUTHORED_BY: chunk -> entity
            _edge("chunk", "c1", "entity", "e1", EdgeType.MENTIONS),
            _edge("chunk", "c2", "entity", "e1", EdgeType.MENTIONS),
            _edge("chunk", "c2", "entity", "e2", EdgeType.MENTIONS),
            _edge("chunk", "c1", "entity", "e1", EdgeType.AUTHORED_BY),
            # ABOUT: fact -> entity
            _edge("fact", "f1", "entity", "e1", EdgeType.ABOUT),
            # ENTITY_SIMILAR with rich properties (must round-trip on both backends)
            _edge(
                "entity", "e1", "entity", "e2", EdgeType.ENTITY_SIMILAR,
                {"hybrid_score": 0.82, "source": "similarity", "confidence": 0.8},
            ),
        ]
    )


def _chunk(cid: str, content: str):
    from kl_graph.models.types import Chunk

    return Chunk(id=cid, content=content, source_type="message", timestamp=1)


def _edge(st, sid, tt, tid, et, props=None):
    return Edge(
        source_type=st, source_id=sid, target_type=tt, target_id=tid,
        edge_type=et, properties=props or {},
    )


def _read_edge_sets(store):
    """Return the exact edge projections the periodic stages consume."""
    mentions = sorted(
        (s, t)
        for s, t, _ in store.scan_edges_by_type(
            ["MENTIONS", "AUTHORED_BY"], source_type="chunk", target_type="entity"
        )
    )
    about = sorted(
        (s, t)
        for s, t, _ in store.scan_edges_by_type(
            ["ABOUT"], source_type="fact", target_type="entity"
        )
    )
    similar = sorted(
        (s, t, round(p.get("hybrid_score", 0.0), 3), p.get("source"))
        for s, t, p in store.scan_edges_by_type(
            ["ENTITY_SIMILAR"], source_type="entity", target_type="entity"
        )
    )
    return mentions, about, similar


def _read_incremental_structural_sets(store):
    return AnnPlusIntraBatch()._load_structural_data(store)


def _sqlite_store(tmp_path: Path):
    return create_store(backend="sqlite", db_path=tmp_path / "knowledge.db")


def _ladybug_store(tmp_path: Path):
    return create_store(
        backend="ladybug",
        db_path=tmp_path / "knowledge.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )


def test_sqlite_edge_reads(tmp_path: Path) -> None:
    store = _sqlite_store(tmp_path)
    try:
        _seed(store)
        mentions, about, similar = _read_edge_sets(store)
        assert mentions == [("c1", "e1"), ("c1", "e1"), ("c2", "e1"), ("c2", "e2")]
        assert about == [("f1", "e1")]
        assert similar == [("e1", "e2", 0.82, "similarity")]
        msg_sets, fact_sets = _read_incremental_structural_sets(store)
        assert msg_sets["e1"] == {"c1", "c2"}
        assert fact_sets["e1"] == {"f1"}
    finally:
        store.close()


@skip_no_ladybug
def test_ladybug_edge_reads_match_sqlite(tmp_path: Path) -> None:
    """The ladybug backend yields the same edge projections as SQLite.

    This is the core guarantee: every edge type the periodic stages read is now
    reachable through the KnowledgeStore API on LadybugDB, with properties
    (hybrid_score/source) intact — so community detection + disambiguation see a
    real graph, not an empty SQLite edges table.
    """
    sq = _sqlite_store(tmp_path / "sq")
    lb = _ladybug_store(tmp_path / "lb")
    try:
        _seed(sq)
        _seed(lb)
        assert _read_edge_sets(lb) == _read_edge_sets(sq)
        assert _read_incremental_structural_sets(lb) == _read_incremental_structural_sets(sq)
    finally:
        sq.close()
        lb.close()


@skip_no_ladybug
def test_ladybug_property_delete_matches_sqlite(tmp_path: Path) -> None:
    """delete_edges(where_properties=...) behaves the same on both backends.

    Mirrors how disambiguation clears a prior run: delete only the edges whose
    ``source`` property matches, leaving other-sourced edges untouched.
    """
    sq = _sqlite_store(tmp_path / "sq")
    lb = _ladybug_store(tmp_path / "lb")
    try:
        for store in (sq, lb):
            _seed(store)  # one ENTITY_SIMILAR e1->e2 with source="similarity"
            # deleting a non-matching source is a no-op on both backends
            store.delete_edges(
                edge_type=EdgeType.ENTITY_SIMILAR.value,
                where_properties={"source": "disambiguation"},
            )
            still = sorted(
                p.get("source")
                for _, _, p in store.scan_edges_by_type(["ENTITY_SIMILAR"])
            )
            assert still == ["similarity"]
            # deleting the matching source removes it on both backends
            store.delete_edges(
                edge_type=EdgeType.ENTITY_SIMILAR.value,
                where_properties={"source": "similarity"},
            )
            gone = list(store.scan_edges_by_type(["ENTITY_SIMILAR"]))
            assert gone == []
    finally:
        sq.close()
        lb.close()
