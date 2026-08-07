"""Backend parity for the query engine's structural recall + PageRank prior.

Regression guard for the bug where the engine read edge-derived data from the
SQLite ``edges`` table directly. That table is empty on the ladybug backend
(LadybugDB is the edge authority), so on ladybug the engine's two structural RRF
channels (entity->messages, entity->facts) and its ``compute_entity_pagerank``
prior silently produced nothing — recall degraded to dense+sparse only, with no
error. The engine now reads these through the backend-agnostic ``KnowledgeStore``
API, so both backends must behave identically.

These tests build the *same* tiny graph on each backend and assert the exact
reads the engine's Phase-1 structural expansion + PageRank consume. No Qdrant,
no LLM, no embedder required.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from kl_graph.models.types import (
    Chunk,
    Edge,
    EdgeType,
    Entity,
    EntityType,
    Fact,
    FactType,
)
from kl_graph.query.pagerank import compute_entity_pagerank
from kl_graph.storage.base import create_store

has_ladybug = True
try:
    import ladybug  # noqa: F401
except ImportError:
    has_ladybug = False

skip_no_ladybug = pytest.mark.skipif(not has_ladybug, reason="ladybug not installed")


def _chunk(cid: str, content: str) -> Chunk:
    return Chunk(id=cid, content=content, source_type="message", timestamp=1)


def _edge(st, sid, tt, tid, et, props=None) -> Edge:
    return Edge(
        source_type=st,
        source_id=sid,
        target_type=tt,
        target_id=tid,
        edge_type=et,
        properties=props or {},
    )


def _seed(store) -> None:
    """Seed a tiny graph exercising both structural channels + the PR projection.

    Two facts link the entity pair (e1,e2) so the facts-only PageRank projection
    has a real edge; e3 mentions/participates but shares no fact edge, so it is a
    genuine off-graph entity (its PageRank fallback is what Issue B pins down).
    """
    store.insert_chunks(
        [
            _chunk("c1", "第一条消息 关于 悟空 和 八戒"),
            _chunk("c2", "第二条消息 关于 悟空"),
            _chunk("c3", "第三条消息 关于 沙僧"),
        ]
    )
    store.upsert_entities(
        [
            Entity(id="e1", name="悟空", entity_type=EntityType.PROJECT, mention_count=2),
            Entity(id="e2", name="八戒", entity_type=EntityType.PERSON, mention_count=1),
            Entity(id="e3", name="沙僧", entity_type=EntityType.PERSON, mention_count=1),
        ]
    )
    store.insert_facts(
        [
            Fact(id="f1", text="悟空与八戒同组", fact_type=FactType.GENERAL, confidence=0.9),
            Fact(id="f2", text="悟空负责八戒模块", fact_type=FactType.GENERAL, confidence=0.5),
            Fact(id="f3", text="沙僧待定", fact_type=FactType.GENERAL, confidence=0.7),
        ]
    )
    store.insert_edges(
        [
            # MENTIONS: chunk -> entity (entity->messages structural channel)
            _edge("chunk", "c1", "entity", "e1", EdgeType.MENTIONS),
            _edge("chunk", "c1", "entity", "e2", EdgeType.MENTIONS),
            _edge("chunk", "c2", "entity", "e1", EdgeType.MENTIONS),
            _edge("chunk", "c3", "entity", "e3", EdgeType.MENTIONS),
            # ABOUT: fact -> entity (entity->facts structural channel + PR proj.)
            _edge("fact", "f1", "entity", "e1", EdgeType.ABOUT),
            _edge("fact", "f1", "entity", "e2", EdgeType.ABOUT),
            _edge("fact", "f2", "entity", "e1", EdgeType.ABOUT),
            _edge("fact", "f2", "entity", "e2", EdgeType.ABOUT),
            _edge("fact", "f3", "entity", "e3", EdgeType.ABOUT),
        ]
    )


def _messages_for(store, eid: str) -> list[str]:
    return sorted(c.id for c in store.get_messages_for_entity(eid, limit=50))


def _facts_for(store, eid: str) -> list[str]:
    return sorted(f.id for f in store.get_facts_for_entity(eid, limit=50))


def _sqlite_store(tmp_path: Path):
    return create_store(backend="sqlite", db_path=tmp_path / "knowledge.db")


def _ladybug_store(tmp_path: Path):
    return create_store(
        backend="ladybug",
        db_path=tmp_path / "knowledge.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )


def test_sqlite_structural_reads(tmp_path: Path) -> None:
    """Baseline: on SQLite the structural reads + PR projection are non-empty."""
    store = _sqlite_store(tmp_path)
    try:
        _seed(store)
        assert _messages_for(store, "e1") == ["c1", "c2"]
        assert _messages_for(store, "e3") == ["c3"]
        assert _facts_for(store, "e1") == ["f1", "f2"]
        assert _facts_for(store, "e2") == ["f1", "f2"]

        pr = compute_entity_pagerank(store)
        # e1 and e2 share fact edges -> both in the projection; e3 shares no
        # multi-entity fact (f3 has a single endpoint) -> off-graph, absent.
        assert "e1" in pr and "e2" in pr
        assert "e3" not in pr
    finally:
        store.close()


@skip_no_ladybug
def test_ladybug_structural_reads_match_sqlite(tmp_path: Path) -> None:
    """The core guard: identical structural recall + PR on ladybug and SQLite.

    Before the fix, every assertion on ``lb`` below would collapse to empty
    (empty SQLite ``edges`` table), while ``sq`` stayed populated — the silent
    recall regression. They must now match exactly.
    """
    sq = _sqlite_store(tmp_path / "sq")
    lb = _ladybug_store(tmp_path / "lb")
    try:
        _seed(sq)
        _seed(lb)

        for eid in ("e1", "e2", "e3"):
            assert _messages_for(lb, eid) == _messages_for(sq, eid)
            assert _facts_for(lb, eid) == _facts_for(sq, eid)

        # ladybug structural reads must be genuinely non-empty (not "equal
        # because both empty").
        assert _messages_for(lb, "e1") == ["c1", "c2"]
        assert _facts_for(lb, "e1") == ["f1", "f2"]

        pr_sq = compute_entity_pagerank(sq)
        pr_lb = compute_entity_pagerank(lb)
        assert pr_lb.keys() == pr_sq.keys()
        for k in pr_sq:
            assert pr_lb[k] == pytest.approx(pr_sq[k])
        # Non-empty prior on ladybug (the whole point).
        assert pr_lb, "ladybug PageRank prior must not be empty"
        assert "e3" not in pr_lb
    finally:
        sq.close()
        lb.close()


def test_build_type_pool_works_on_both_backends(tmp_path: Path) -> None:
    """``build_type_pool`` must read content via the backend-agnostic ``sql_conn``.

    Regression guard: it used to hardcode ``sqlite.conn``, which only exists on a
    raw SQLiteStore. On the ladybug backend (a ``LadybugStore``, the default) the
    attribute is ``sql_conn``, so the old code raised ``AttributeError`` during
    ``QueryEngine.__init__`` -> the server logged "Query engine init failed" and
    left ``state.engine = None``, breaking /ask and /search entirely. Both
    backends must now build an identical, non-empty type pool.
    """
    from kl_graph.query.query_rewrite import build_type_pool

    sq = _sqlite_store(tmp_path / "sq")
    try:
        _seed(sq)
        pool_sq = build_type_pool(sq)
    finally:
        sq.close()

    # Seeded entities (PERSON/PROJECT) + GENERAL facts must surface.
    assert pool_sq["entity_pool"], "sqlite type pool must not be empty"
    assert "GENERAL" in pool_sq["fact_pool"]

    if not has_ladybug:
        pytest.skip("ladybug not installed")
    lb = _ladybug_store(tmp_path / "lb")
    try:
        _seed(lb)
        pool_lb = build_type_pool(lb)  # must NOT raise AttributeError
    finally:
        lb.close()

    assert pool_lb == pool_sq, "type pool must be identical across backends"
