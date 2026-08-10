"""Unit tests for KnowledgeStore ABC and SQLiteStore implementation.

Tests verify:
- SQLiteStore is a concrete KnowledgeStore (isinstance check)
- All ABC methods are implemented (no abstract methods remain)
- create_store('sqlite') returns a working SQLiteStore
- SQLiteStore.find_paths() returns same PathResult as SQLiteGraphDB.find_paths()
- SQLiteStore.scan_entity_edges() yields all edges
- SQLiteStore.delete_edges() removes matching edges
- Community summary CRUD
- upsert_entities (canonical ABC method)
"""

from __future__ import annotations

import pathlib
import sqlite3

import pytest

from kl_graph.models.types import (
    Chunk,
    Community,
    Edge,
    EdgeType,
    Entity,
    EntityType,
    Fact,
    FactType,
    Scope,
    community_id_from,
)
from kl_graph.storage.base import KnowledgeStore, create_store
from kl_graph.storage.sqlite_graph import SQLiteGraphDB
from kl_graph.storage.sqlite_store import SQLiteStore

# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_store(tmp_path: pathlib.Path) -> SQLiteStore:
    """Create a fresh SQLiteStore backed by a temp file."""
    return SQLiteStore(tmp_path / "test.db")


def _add_entity_row(conn: sqlite3.Connection, eid: str, name: str = "") -> None:
    conn.execute(
        "INSERT INTO entities(id, name, entity_type, first_seen, last_seen, mention_count) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (eid, name or eid, "Unknown", 0, 0, 1),
    )


def _add_fact_row(conn: sqlite3.Connection, fid: str, text: str = "") -> None:
    conn.execute(
        "INSERT INTO facts(id, text, fact_type, timestamp, confidence, source_chunk_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (fid, text or fid, "GENERAL", 0, 0.8, "dummy"),
    )


def _add_edge_row(
    conn: sqlite3.Connection,
    src: str,
    src_type: str,
    tgt: str,
    tgt_type: str,
    etype: str,
) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO edges(source_type, source_id, target_type, target_id, edge_type) "
        "VALUES (?, ?, ?, ?, ?)",
        (src_type, src, tgt_type, tgt, etype),
    )


# ── ABC conformance ───────────────────────────────────────────────────────────


def test_sqlite_store_is_knowledge_store(tmp_path: pathlib.Path) -> None:
    """SQLiteStore is an instance of KnowledgeStore."""
    store = _make_store(tmp_path)
    assert isinstance(store, KnowledgeStore)
    store.close()


def test_sqlite_store_no_unimplemented_abstract_methods() -> None:
    """SQLiteStore has no remaining abstract methods."""
    abstract = [
        m
        for m in dir(SQLiteStore)
        if getattr(getattr(SQLiteStore, m, None), "__isabstractmethod__", False)
    ]
    assert abstract == [], f"Unimplemented abstract methods: {abstract}"


def test_create_store_sqlite_returns_sqlite_store(tmp_path: pathlib.Path) -> None:
    """create_store('sqlite') returns a SQLiteStore instance."""
    store = create_store("sqlite", db_path=tmp_path / "ks.db")
    assert isinstance(store, SQLiteStore)
    assert isinstance(store, KnowledgeStore)
    store.close()


def test_create_store_unknown_raises_value_error(tmp_path: pathlib.Path) -> None:
    """create_store with unknown backend raises ValueError."""
    with pytest.raises(ValueError, match="Unknown backend"):
        create_store("nope", db_path=tmp_path / "x.db")


def test_create_store_falkordb_raises_not_implemented(tmp_path: pathlib.Path) -> None:
    """create_store('falkordb') raises NotImplementedError."""
    with pytest.raises(NotImplementedError):
        create_store("falkordb", db_path=tmp_path / "x.db")


# ── Context manager ───────────────────────────────────────────────────────────


def test_context_manager(tmp_path: pathlib.Path) -> None:
    """SQLiteStore works as a context manager."""
    with _make_store(tmp_path) as store:
        assert isinstance(store, SQLiteStore)


# ── sql_conn ──────────────────────────────────────────────────────────────────


def test_sql_conn_returns_connection(tmp_path: pathlib.Path) -> None:
    """sql_conn returns the underlying sqlite3.Connection."""
    store = _make_store(tmp_path)
    conn = store.sql_conn
    assert isinstance(conn, sqlite3.Connection)
    store.close()


# ── upsert_entities ───────────────────────────────────────────────────────────


def test_upsert_entities_inserts(tmp_path: pathlib.Path) -> None:
    """upsert_entities stores entities and count_entities returns correct count."""
    store = _make_store(tmp_path)
    e = Entity(
        id="e1", name="Alice", entity_type=EntityType.PERSON, first_seen=1, last_seen=2
    )
    store.upsert_entities([e])
    assert store.count_entities() == 1
    store.close()


def test_upsert_entities_updates_on_conflict(tmp_path: pathlib.Path) -> None:
    """upsert_entities increments mention_count on duplicate id."""
    store = _make_store(tmp_path)
    e = Entity(id="e1", name="Alice", entity_type=EntityType.PERSON, mention_count=1)
    store.upsert_entities([e])
    store.upsert_entities([e])
    row = store.conn.execute(
        "SELECT mention_count FROM entities WHERE id='e1'"
    ).fetchone()
    assert row[0] == 2  # incremented
    store.close()


def test_upsert_entities_bulk_backward_compat(tmp_path: pathlib.Path) -> None:
    """upsert_entities_bulk still works (backward compat delegating to upsert_entities)."""
    store = _make_store(tmp_path)
    e = Entity(id="e2", name="Bob")
    store.upsert_entities_bulk([e])
    assert store.count_entities() == 1
    store.close()


def test_upsert_entity_backward_compat(tmp_path: pathlib.Path) -> None:
    """upsert_entity still works (backward compat)."""
    store = _make_store(tmp_path)
    e = Entity(id="e3", name="Carol")
    store.upsert_entity(e)
    assert store.count_entities() == 1
    store.close()


# ── insert_edges / delete_edges ───────────────────────────────────────────────


def test_insert_edges_stores_edges(tmp_path: pathlib.Path) -> None:
    """insert_edges writes edges to the edges table."""
    store = _make_store(tmp_path)
    e = Edge(
        source_type="entity",
        source_id="e1",
        target_type="entity",
        target_id="e2",
        edge_type=EdgeType.ENTITY_SIMILAR,
    )
    store.insert_edges([e])
    assert store.count_edges() == 1
    store.close()


def test_delete_edges_removes_by_source_id(tmp_path: pathlib.Path) -> None:
    """delete_edges with source_id removes matching edges."""
    store = _make_store(tmp_path)
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="a",
                target_type="entity",
                target_id="b",
                edge_type=EdgeType.ENTITY_SIMILAR,
            ),
            Edge(
                source_type="entity",
                source_id="c",
                target_type="entity",
                target_id="d",
                edge_type=EdgeType.ENTITY_SIMILAR,
            ),
        ]
    )
    deleted = store.delete_edges(source_id="a")
    assert deleted == 1
    assert store.count_edges() == 1
    store.close()


def test_delete_edges_all_filters_none_raises(tmp_path: pathlib.Path) -> None:
    """delete_edges with no filters raises ValueError."""
    store = _make_store(tmp_path)
    with pytest.raises(ValueError, match="At least one filter"):
        store.delete_edges()
    store.close()


def test_delete_edges_by_edge_type(tmp_path: pathlib.Path) -> None:
    """delete_edges with edge_type filter removes only matching type."""
    store = _make_store(tmp_path)
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="a",
                target_type="entity",
                target_id="b",
                edge_type=EdgeType.ENTITY_SIMILAR,
            ),
            Edge(
                source_type="entity",
                source_id="a",
                target_type="fact",
                target_id="f1",
                edge_type=EdgeType.ABOUT,
            ),
        ]
    )
    deleted = store.delete_edges(edge_type="ENTITY_SIMILAR")
    assert deleted == 1
    assert store.count_edges() == 1
    by_type = store.count_edges_by_type()
    assert "ABOUT" in by_type
    assert "ENTITY_SIMILAR" not in by_type
    store.close()


# ── scan_entity_edges ─────────────────────────────────────────────────────────


def test_scan_entity_edges_yields_all(tmp_path: pathlib.Path) -> None:
    """scan_entity_edges yields all edges with correct tuple shape."""
    store = _make_store(tmp_path)
    edges = [
        Edge(
            source_type="entity",
            source_id="e1",
            target_type="fact",
            target_id="f1",
            edge_type=EdgeType.ABOUT,
        ),
        Edge(
            source_type="entity",
            source_id="e2",
            target_type="entity",
            target_id="e3",
            edge_type=EdgeType.ENTITY_SIMILAR,
        ),
    ]
    store.insert_edges(edges)

    scanned = list(store.scan_entity_edges())
    assert len(scanned) == 2
    # Each row is a 5-tuple
    for row in scanned:
        assert len(row) == 5
        src_type, src_id, tgt_type, _tgt_id, etype = row
        assert isinstance(src_type, str)
        assert isinstance(src_id, str)
        assert isinstance(tgt_type, str)
        assert isinstance(etype, str)
    store.close()


def test_scan_entity_edges_empty_store(tmp_path: pathlib.Path) -> None:
    """scan_entity_edges returns an empty iterator when there are no edges."""
    store = _make_store(tmp_path)
    assert list(store.scan_entity_edges()) == []
    store.close()


# ── scan_edges_by_type / scan_edges_for_nodes ────────────────────────────────


def test_scan_edges_for_nodes_is_abstract() -> None:
    """KnowledgeStore ABC declares scan_edges_for_nodes as an abstract method."""
    assert hasattr(KnowledgeStore, "scan_edges_for_nodes")
    method = getattr(KnowledgeStore, "scan_edges_for_nodes")
    assert getattr(method, "__isabstractmethod__", False)


def test_sqlite_store_implements_scan_edges_for_nodes(tmp_path: pathlib.Path) -> None:
    """SQLiteStore provides a concrete implementation of scan_edges_for_nodes."""
    store = _make_store(tmp_path)
    method = getattr(store, "scan_edges_for_nodes")
    assert not getattr(method, "__isabstractmethod__", False)
    store.close()


def test_scan_edges_for_nodes_returns_only_touching_edges(tmp_path: pathlib.Path) -> None:
    """scan_edges_for_nodes yields only edges where an endpoint is in node_ids."""
    store = _make_store(tmp_path)
    # e1↔e2 (ENTITY_SIMILAR), e3↔e4 (ENTITY_SIMILAR), e1↔e3 (ENTITY_SIMILAR)
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.9},
            ),
            Edge(
                source_type="entity",
                source_id="e3",
                target_type="entity",
                target_id="e4",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.5},
            ),
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="entity",
                target_id="e3",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.7},
            ),
        ]
    )

    # Query for edges touching {e1, e3}
    results = list(
        store.scan_edges_for_nodes(
            ["ENTITY_SIMILAR"], {"e1", "e3"},
            source_type="entity", target_type="entity",
        )
    )
    # Should return e1↔e2, e3↔e4, e1↔e3 (all touch e1 or e3)
    assert len(results) == 3
    pairs = {(src, tgt) for src, tgt, _ in results}
    assert ("e1", "e2") in pairs
    assert ("e3", "e4") in pairs
    assert ("e1", "e3") in pairs

    # Query for edges touching {e2} only
    results2 = list(
        store.scan_edges_for_nodes(
            ["ENTITY_SIMILAR"], {"e2"},
            source_type="entity", target_type="entity",
        )
    )
    assert len(results2) == 1
    assert results2[0][0] == "e1"
    assert results2[0][1] == "e2"
    assert results2[0][2]["hybrid_score"] == 0.9
    store.close()


def test_scan_edges_for_nodes_empty_node_ids(tmp_path: pathlib.Path) -> None:
    """scan_edges_for_nodes with empty node_ids returns nothing."""
    store = _make_store(tmp_path)
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="entity",
                target_id="e2",
                edge_type=EdgeType.ENTITY_SIMILAR,
            ),
        ]
    )
    assert list(store.scan_edges_for_nodes(["ENTITY_SIMILAR"], set())) == []
    store.close()


def test_scan_edges_for_nodes_respects_portable_bind_limit(tmp_path: pathlib.Path) -> None:
    """Large frontiers stay below 999 binds and dedupe cross-batch matches."""
    store = _make_store(tmp_path)
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="n0000",
                target_type="entity",
                target_id="n0999",
                edge_type=EdgeType.ENTITY_SIMILAR,
                properties={"hybrid_score": 0.9},
            )
        ]
    )
    node_ids = {f"n{i:04d}" for i in range(1000)}

    results = list(
        store.scan_edges_for_nodes(
            ["ENTITY_SIMILAR"],
            node_ids,
            source_type="entity",
            target_type="entity",
        )
    )

    assert [(source, target) for source, target, _props in results] == [
        ("n0000", "n0999")
    ]
    store.close()


# ── find_paths parity with SQLiteGraphDB ──────────────────────────────────────


def _populate_triangle(store: SQLiteStore) -> None:
    """Populate triangle graph: A --ENTITY_SIMILAR--> B (1-hop), A --ABOUT--> F1 --ABOUT--> B (2-hop)."""
    store.upsert_entities(
        [
            Entity(id="A", name="A"),
            Entity(id="B", name="B"),
        ]
    )
    store.insert_facts(
        [
            Fact(
                id="F1",
                text="F1",
                fact_type=FactType.GENERAL,
                source_chunk_id="dummy",
            ),
        ]
    )
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="A",
                target_type="entity",
                target_id="B",
                edge_type=EdgeType.ENTITY_SIMILAR,
            ),
            Edge(
                source_type="entity",
                source_id="A",
                target_type="fact",
                target_id="F1",
                edge_type=EdgeType.ABOUT,
            ),
            Edge(
                source_type="fact",
                source_id="F1",
                target_type="entity",
                target_id="B",
                edge_type=EdgeType.ABOUT,
            ),
        ]
    )


def test_find_paths_same_result_as_sqlite_graph_db(tmp_path: pathlib.Path) -> None:
    """SQLiteStore.find_paths returns same PathResult as SQLiteGraphDB.find_paths."""
    store = _make_store(tmp_path)
    _populate_triangle(store)

    # SQLiteStore path
    store_result = store.find_paths("A", "B")
    assert not store_result.exhausted
    assert len(store_result.paths) >= 1

    # Legacy SQLiteGraphDB path (using the same underlying connection)
    graph_db = SQLiteGraphDB(store.conn)
    graph_result = graph_db.find_paths("A", "B")

    # Both should agree on the shortest path length
    store_shortest = min(store_result.paths, key=lambda p: p.hop_count)
    graph_shortest = min(graph_result.paths, key=lambda p: p.hop_count)
    assert store_shortest.hop_count == graph_shortest.hop_count

    store.close()


def test_find_paths_no_path_returns_exhausted(tmp_path: pathlib.Path) -> None:
    """find_paths returns exhausted=True when no path exists."""
    store = _make_store(tmp_path)
    _populate_triangle(store)
    result = store.find_paths("A", "NONEXISTENT")
    assert result.exhausted
    assert result.paths == []
    store.close()


def test_find_paths_self_to_self(tmp_path: pathlib.Path) -> None:
    """find_paths from a node to itself is a zero-hop trivial path."""
    store = _make_store(tmp_path)
    _populate_triangle(store)
    result = store.find_paths("A", "A")
    assert not result.exhausted
    assert result.paths[0].hop_count == 0
    store.close()


def test_find_paths_all_shortest_diamond(tmp_path: pathlib.Path) -> None:
    """all_shortest=True returns both paths in a diamond graph."""
    store = _make_store(tmp_path)
    store.upsert_entities([Entity(id="A", name="A"), Entity(id="B", name="B")])
    store.insert_facts(
        [
            Fact(
                id="F1",
                text="F1",
                fact_type=FactType.GENERAL,
                source_chunk_id="dummy",
            ),
            Fact(
                id="F2",
                text="F2",
                fact_type=FactType.GENERAL,
                source_chunk_id="dummy",
            ),
        ]
    )
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="A",
                target_type="fact",
                target_id="F1",
                edge_type=EdgeType.ABOUT,
            ),
            Edge(
                source_type="fact",
                source_id="F1",
                target_type="entity",
                target_id="B",
                edge_type=EdgeType.ABOUT,
            ),
            Edge(
                source_type="entity",
                source_id="A",
                target_type="fact",
                target_id="F2",
                edge_type=EdgeType.ABOUT,
            ),
            Edge(
                source_type="fact",
                source_id="F2",
                target_type="entity",
                target_id="B",
                edge_type=EdgeType.ABOUT,
            ),
        ]
    )
    result = store.find_paths("A", "B", all_shortest=True)
    assert not result.exhausted
    assert len(result.paths) == 2
    for p in result.paths:
        assert p.hop_count == 2
    store.close()


# ── neighbors_typed ───────────────────────────────────────────────────────────


def test_neighbors_typed_returns_tuples(tmp_path: pathlib.Path) -> None:
    """neighbors_typed returns 4-tuples (id, type, edge_type, props)."""
    store = _make_store(tmp_path)
    _populate_triangle(store)
    nbrs = store.neighbors_typed("A", "entity", direction="out")
    assert len(nbrs) > 0
    for nbr in nbrs:
        assert len(nbr) == 4
        nid, ntype, etype, props = nbr
        assert isinstance(nid, str)
        assert isinstance(ntype, str)
        assert isinstance(etype, str)
        assert isinstance(props, dict)
    store.close()


def test_neighbors_typed_direction_filter(tmp_path: pathlib.Path) -> None:
    """neighbors_typed with direction='out' returns only outgoing neighbors."""
    store = _make_store(tmp_path)
    _populate_triangle(store)
    out_nbrs = store.neighbors_typed("A", "entity", direction="out")
    in_nbrs = store.neighbors_typed("B", "entity", direction="in")
    out_ids = {n[0] for n in out_nbrs}
    in_ids = {n[0] for n in in_nbrs}
    # A has outgoing edges to B and F1
    assert "B" in out_ids or "F1" in out_ids
    # B has incoming edges from A and F1
    assert "A" in in_ids or "F1" in in_ids
    store.close()


# ── community summaries ───────────────────────────────────────────────────────


def test_store_and_list_community_summaries(tmp_path: pathlib.Path) -> None:
    """store_community_summaries persists and list_community_summaries retrieves."""
    store = _make_store(tmp_path)
    summaries = [
        {
            "level": 0,
            "community_id": 0,
            "member_count": 5,
            "entity_count": 3,
            "fact_count": 2,
            "summary": "test",
            "tags": "[]",
            "top_members": "[]",
        },
        {
            "level": 0,
            "community_id": 1,
            "member_count": 3,
            "entity_count": 2,
            "fact_count": 1,
            "summary": "other",
            "tags": "[]",
            "top_members": "[]",
        },
    ]
    store.store_community_summaries(summaries)
    listed = store.list_community_summaries(0)
    assert len(listed) == 2
    store.close()


def test_get_community_summary_returns_none_when_missing(
    tmp_path: pathlib.Path,
) -> None:
    """get_community_summary returns None when not found."""
    store = _make_store(tmp_path)
    result = store.get_community_summary(0, 99)
    assert result is None
    store.close()


def test_get_community_summary_returns_correct(tmp_path: pathlib.Path) -> None:
    """get_community_summary returns the correct summary dict."""
    store = _make_store(tmp_path)
    store.store_community_summaries(
        [
            {
                "level": 1,
                "community_id": 42,
                "member_count": 7,
                "entity_count": 4,
                "fact_count": 3,
                "summary": "hello world",
                "tags": "[]",
                "top_members": "[]",
            },
        ]
    )
    result = store.get_community_summary(1, 42)
    assert result is not None
    assert result["summary"] == "hello world"
    assert result["member_count"] == 7
    store.close()


# ── chunks and messages ───────────────────────────────────────────────────────


def test_insert_and_get_chunk(tmp_path: pathlib.Path) -> None:
    """insert_chunks and get_chunk round-trips a Chunk."""
    store = _make_store(tmp_path)
    chunk = Chunk(id="c1", content="hello", source_type="doc", timestamp=100)
    store.insert_chunks([chunk])
    fetched = store.get_chunk("c1")
    assert fetched is not None
    assert fetched.id == "c1"
    assert fetched.content == "hello"
    store.close()


def test_count_chunks(tmp_path: pathlib.Path) -> None:
    """count_chunks returns the number of chunks inserted."""
    store = _make_store(tmp_path)
    assert store.count_chunks() == 0
    store.insert_chunks([Chunk(id="c1", content="x")])
    assert store.count_chunks() == 1
    store.close()


def test_insert_and_get_message(tmp_path: pathlib.Path) -> None:
    """insert_messages / get_message round-trip a chat Chunk.

    There is no Message type any more: a chat message is a Chunk with
    ``source_type="message"`` whose chat fields live in ``metadata``.
    """
    store = _make_store(tmp_path)
    msg = Chunk(
        id="m1",
        content="hello",
        source_type="message",
        timestamp=999,
        metadata={"conversation_id": "conv1", "sender": "Alice"},
    )
    store.insert_messages([msg])
    fetched = store.get_message("m1")
    assert fetched is not None
    assert fetched.id == "m1"
    assert fetched.source_type == "message"
    assert fetched.metadata["sender"] == "Alice"
    # It is the same row the generic chunk reader sees.
    assert store.count_messages() == 1
    assert store.get_chunk("m1") is not None
    store.close()


# ── scopes + PART_OF (divergence C) ──────────────────────────────────


def test_insert_and_get_scope(tmp_path: pathlib.Path) -> None:
    """insert_scopes and get_scope round-trip through the ABC methods."""
    store = _make_store(tmp_path)
    store.insert_scopes(
        [Scope(id="s1", scope_type="conversation", title="T", metadata={"k": "v"})]
    )
    fetched = store.get_scope("s1")
    assert fetched is not None
    assert fetched.scope_type == "conversation"
    assert fetched.metadata == {"k": "v"}
    store.close()


def test_part_of_edge_stored_to_scope(tmp_path: pathlib.Path) -> None:
    """A chunk→scope PART_OF edge round-trips through the edges table."""
    store = _make_store(tmp_path)
    store.insert_scopes([Scope(id="s1", scope_type="conversation")])
    store.insert_edges(
        [
            Edge(
                source_type="chunk",
                source_id="m1",
                target_type="scope",
                target_id="s1",
                edge_type=EdgeType.PART_OF,
            )
        ]
    )
    assert store.count_edges_by_type() == {"PART_OF": 1}
    nbrs = store.get_neighbors("chunk", "m1", edge_type="PART_OF")
    assert [(n["target_type"], n["target_id"]) for n in nbrs] == [("scope", "s1")]
    store.close()


# ── communities + COMM_MEMBER (divergence E) ─────────────────────────

def test_insert_and_get_community(tmp_path: pathlib.Path) -> None:
    """insert_communities and get_community round-trip through the ABC methods."""
    store = _make_store(tmp_path)
    cid = community_id_from("L1", 7)
    store.insert_communities(
        [
            Community(
                id=cid,
                level="L1",
                node_type="mixed",
                summary="s",
                tags=["a"],
                member_count=3,
            )
        ]
    )
    fetched = store.get_community(cid)
    assert fetched is not None
    assert fetched.level == "L1"
    assert fetched.node_type == "mixed"
    assert fetched.tags == ["a"]
    assert fetched.member_count == 3
    store.close()


def test_comm_member_edge_stored_to_community(tmp_path: pathlib.Path) -> None:
    """An entity→community COMM_MEMBER edge round-trips with its level."""
    store = _make_store(tmp_path)
    cid = community_id_from("L0", 0)
    store.insert_communities([Community(id=cid, level="L0", node_type="mixed")])
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="community",
                target_id=cid,
                edge_type=EdgeType.COMM_MEMBER,
                properties={"level": "L0"},
            )
        ]
    )
    assert store.count_edges_by_type() == {"COMM_MEMBER": 1}
    nbrs = store.get_neighbors("entity", "e1", edge_type="COMM_MEMBER")
    assert [(n["target_type"], n["target_id"]) for n in nbrs] == [("community", cid)]
    store.close()


# ── get_chunks_by_ids ────────────────────────────────────────────────────────


def test_knowledge_store_abc_has_get_chunks_by_ids() -> None:
    """KnowledgeStore ABC includes get_chunks_by_ids as an abstract method."""
    assert hasattr(KnowledgeStore, "get_chunks_by_ids")
    method = getattr(KnowledgeStore, "get_chunks_by_ids")
    assert getattr(method, "__isabstractmethod__", False)


def test_sqlite_store_implements_get_chunks_by_ids(tmp_path: pathlib.Path) -> None:
    """SQLiteStore provides a concrete implementation of get_chunks_by_ids."""
    store = _make_store(tmp_path)
    method = getattr(store, "get_chunks_by_ids")
    assert not getattr(method, "__isabstractmethod__", False)
    store.close()


def test_get_chunks_by_ids_returns_known_chunks(tmp_path: pathlib.Path) -> None:
    """get_chunks_by_ids returns chunks for known IDs, skips unknown."""
    store = _make_store(tmp_path)
    chunks = [
        Chunk(id="c1", content="Chunk 1", source_type="message", timestamp=1000),
        Chunk(id="c2", content="Chunk 2", source_type="document", timestamp=2000),
    ]
    store.insert_chunks(chunks)
    
    result = store.get_chunks_by_ids(["c1", "c2", "unknown"])
    
    assert len(result) == 2
    result_ids = {c.id for c in result}
    assert result_ids == {"c1", "c2"}
    store.close()


def test_get_chunks_by_ids_empty_input(tmp_path: pathlib.Path) -> None:
    """get_chunks_by_ids with empty list returns empty list."""
    store = _make_store(tmp_path)
    result = store.get_chunks_by_ids([])
    assert result == []
    store.close()


def test_get_chunks_by_ids_all_unknown(tmp_path: pathlib.Path) -> None:
    """get_chunks_by_ids with all unknown IDs returns empty list."""
    store = _make_store(tmp_path)
    result = store.get_chunks_by_ids(["x", "y", "z"])
    assert result == []
    store.close()
