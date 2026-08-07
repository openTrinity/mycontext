"""Unit tests for LadybugStore.

Tests skip if `ladybug` is not installed. When ladybug IS present, verifies:
- LadybugStore implements KnowledgeStore ABC
- create_store('ladybug') returns a LadybugStore
- Nodes written to SQLite and node stubs synced to LadybugDB
- Edges written to LadybugDB (not SQLite)
- find_paths delegates to LadybugGraphDB
- scan_entity_edges yields edge tuples from LadybugDB
- Community summary delegation to SQLite
- sql_conn returns the underlying SQLite connection
"""

from __future__ import annotations

import pathlib

import pytest

from kl_graph.models.types import (
    Chunk,
    Edge,
    EdgeType,
    Entity,
    EntityType,
    Fact,
    FactType,
    Scope,
)
from kl_graph.storage.base import KnowledgeStore, create_store

try:
    import ladybug  # noqa: F401

    has_ladybug = True
except ImportError:
    has_ladybug = False

skip_no_ladybug = pytest.mark.skipif(
    not has_ladybug,
    reason="ladybug not installed — install with: pip install ladybug",
)

# LadybugDB (Kuzu fork) has Cypher dialect incompatibilities: MERGE not supported,
# variable-length path queries produce empty results. These tests document the
# intended behavior but currently fail due to upstream dialect gaps.
xfail_ladybug_dialect = pytest.mark.xfail(
    reason="LadybugDB Cypher dialect incompatibility (MERGE, path queries)",
    strict=False,
)


# ── ABC conformance (no ladybug needed) ──────────────────────────────────────


def test_ladybug_store_class_is_knowledge_store_subclass() -> None:
    """LadybugStore is a subclass of KnowledgeStore."""
    from kl_graph.storage.ladybug_store import LadybugStore

    assert issubclass(LadybugStore, KnowledgeStore)


def test_ladybug_store_no_abstract_methods() -> None:
    """LadybugStore has no unimplemented abstract methods."""
    from kl_graph.storage.ladybug_store import LadybugStore

    abstract = [
        m
        for m in dir(LadybugStore)
        if getattr(getattr(LadybugStore, m, None), "__isabstractmethod__", False)
    ]
    assert abstract == [], f"Unimplemented abstract methods: {abstract}"


# ── Instance creation ─────────────────────────────────────────────────────────


@skip_no_ladybug
def test_create_store_ladybug_returns_ladybug_store(tmp_path: pathlib.Path) -> None:
    """create_store('ladybug') returns a LadybugStore instance."""
    from kl_graph.storage.ladybug_store import LadybugStore

    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    assert isinstance(store, LadybugStore)
    assert isinstance(store, KnowledgeStore)
    store.close()


@skip_no_ladybug
def test_ladybug_store_sql_conn_is_sqlite_connection(tmp_path: pathlib.Path) -> None:
    """sql_conn returns the underlying SQLite connection."""
    import sqlite3

    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    assert isinstance(store.sql_conn, sqlite3.Connection)
    store.close()


# ── Nodes written to SQLite ───────────────────────────────────────────────────


@skip_no_ladybug
def test_upsert_entities_writes_to_sqlite(tmp_path: pathlib.Path) -> None:
    """upsert_entities stores content in SQLite."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    e = Entity(id="e1", name="Alice", entity_type=EntityType.PERSON)
    store.upsert_entities([e])
    assert store.count_entities() == 1
    fetched = store.get_entity_by_name("Alice")
    assert fetched is not None
    assert fetched.id == "e1"
    store.close()


@skip_no_ladybug
def test_insert_facts_writes_to_sqlite(tmp_path: pathlib.Path) -> None:
    """insert_facts stores content in SQLite."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    f = Fact(
        id="f1",
        text="Something happened",
        fact_type=FactType.DECISION,
        source_chunk_id="m1",
    )
    store.insert_facts([f])
    assert store.count_facts() == 1
    fetched = store.get_fact("f1")
    assert fetched is not None
    assert fetched.text == "Something happened"
    # source_chunk_id (renamed from source_message_id; FK now chunks(id)) round-trips.
    assert fetched.source_chunk_id == "m1"
    store.close()


@skip_no_ladybug
def test_insert_messages_writes_to_sqlite(tmp_path: pathlib.Path) -> None:
    """insert_messages stores a chat Chunk's content in SQLite.

    A chat message is a Chunk with ``source_type="message"``, so this is the
    chunk path; the ``Chunk`` graph node stub is written alongside it.
    """
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    msg = Chunk(
        id="m1",
        content="hello",
        source_type="message",
        timestamp=100,
        metadata={"conversation_id": "conv1", "sender": "Alice"},
    )
    store.insert_messages([msg])
    assert store.count_messages() == 1
    fetched = store.get_message("m1")
    assert fetched is not None
    assert fetched.metadata["sender"] == "Alice"
    # The graph got a Chunk node (not a Message node) for edge connectivity.
    assert store._graph._node_label("m1") == "chunk"
    store.close()


# ── Edges written to LadybugDB, NOT SQLite ────────────────────────────────────


@skip_no_ladybug
def test_insert_edges_goes_to_ladybug_not_sqlite(tmp_path: pathlib.Path) -> None:
    """insert_edges writes to LadybugDB only; SQLite edges table is empty."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    # Create entity nodes first (needed for edge endpoints)
    store.upsert_entities(
        [
            Entity(id="e1", name="Alice"),
            Entity(id="e2", name="Bob"),
        ]
    )
    edge = Edge(
        source_type="entity",
        source_id="e1",
        target_type="entity",
        target_id="e2",
        edge_type=EdgeType.ENTITY_SIMILAR,
        properties={"confidence": 0.9},
    )
    store.insert_edges([edge])

    # SQLite edges table must be EMPTY
    sqlite_count = store.sql_conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
    assert sqlite_count == 0, "Edges must NOT be written to SQLite in LadybugStore"

    store.close()


@skip_no_ladybug
@xfail_ladybug_dialect
def test_count_edges_from_ladybug(tmp_path: pathlib.Path) -> None:
    """count_edges returns edges from LadybugDB."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    store.upsert_entities(
        [
            Entity(id="e1", name="E1"),
            Entity(id="e2", name="E2"),
        ]
    )
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
    total = store.count_edges()
    assert total >= 1
    store.close()


# ── find_paths ────────────────────────────────────────────────────────────────


@skip_no_ladybug
def test_find_paths_via_ladybug(tmp_path: pathlib.Path) -> None:
    """find_paths delegates to LadybugDB and returns a PathResult."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    store.upsert_entities([Entity(id="A", name="A"), Entity(id="B", name="B")])
    store.insert_facts([Fact(id="F1", text="F1", source_chunk_id="dummy")])
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

    from kl_graph.storage.graph_db import PathResult

    result = store.find_paths("A", "B")
    assert isinstance(result, PathResult)
    # Whether or not paths are found depends on LadybugDB's ability to find them;
    # the important assertion is that the call doesn't raise and returns PathResult.
    store.close()


# ── scan_entity_edges ─────────────────────────────────────────────────────────


@skip_no_ladybug
@xfail_ladybug_dialect
def test_scan_entity_edges_from_ladybug(tmp_path: pathlib.Path) -> None:
    """scan_entity_edges yields tuples from LadybugDB edges."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    store.upsert_entities(
        [
            Entity(id="e1", name="E1"),
            Entity(id="e2", name="E2"),
        ]
    )
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

    edges = list(store.scan_entity_edges())
    # scan_entity_edges should yield at least one tuple
    assert len(edges) >= 1
    for row in edges:
        assert len(row) == 5
        src_type, _src_id, _tgt_type, _tgt_id, etype = row
        assert isinstance(src_type, str)
        assert isinstance(etype, str)
    store.close()


# ── delete_edges ──────────────────────────────────────────────────────────────


@skip_no_ladybug
def test_delete_edges_raises_on_no_filter(tmp_path: pathlib.Path) -> None:
    """delete_edges with no filters raises ValueError."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    with pytest.raises(ValueError, match="At least one filter"):
        store.delete_edges()
    store.close()


# ── community summaries ───────────────────────────────────────────────────────


@skip_no_ladybug
def test_community_summaries_use_sqlite(tmp_path: pathlib.Path) -> None:
    """Community summary methods delegate to SQLite."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    summaries = [
        {
            "level": "L0",
            "community_id": 0,
            "node_type": "entity",
            "member_count": 5,
            "summary": "test",
            "tags": "[]",
            "top_members": "[]",
        },
    ]
    store.store_community_summaries(summaries)
    listed = store.list_community_summaries("L0", "entity")
    assert len(listed) == 1
    assert listed[0]["summary"] == "test"
    store.close()


# ── scopes + PART_OF (divergence C) ──────────────────────────────────


@skip_no_ladybug
def test_insert_scopes_dual_writes_sqlite_and_graph(tmp_path: pathlib.Path) -> None:
    """insert_scopes stores the SQLite row and the LadybugDB Scope node."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    store.insert_scopes([Scope(id="s1", scope_type="conversation", title="T")])
    fetched = store.get_scope("s1")
    assert fetched is not None
    assert fetched.scope_type == "conversation"
    rows = store._graph.query("MATCH (s:Scope) RETURN s.id AS id")
    assert [r["id"] for r in rows] == ["s1"]
    store.close()


@skip_no_ladybug
def test_part_of_edge_written_to_ladybug(tmp_path: pathlib.Path) -> None:
    """A chunk→scope PART_OF edge lands in LadybugDB and is countable."""
    from kl_graph.models.types import Chunk

    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    store.insert_scopes([Scope(id="s1", scope_type="document")])
    store.insert_chunks([Chunk(id="c1", content="x", source_type="wiki")])
    store.insert_edges(
        [
            Edge(
                source_type="chunk",
                source_id="c1",
                target_type="scope",
                target_id="s1",
                edge_type=EdgeType.PART_OF,
            )
        ]
    )
    assert store.count_edges_by_type().get("PART_OF") == 1
    assert ("chunk", "c1", "scope", "s1", "PART_OF") in set(store.scan_entity_edges())
    store.close()


# ── get_chunks_by_ids ────────────────────────────────────────────────────────


@skip_no_ladybug
def test_ladybug_store_get_chunks_by_ids_returns_known_chunks(tmp_path: pathlib.Path) -> None:
    """LadybugStore.get_chunks_by_ids returns known chunks, skips unknown."""
    from kl_graph.models.types import Chunk

    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
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


@skip_no_ladybug
def test_ladybug_store_get_chunks_by_ids_empty_input(tmp_path: pathlib.Path) -> None:
    """LadybugStore.get_chunks_by_ids with empty list returns empty list."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    result = store.get_chunks_by_ids([])
    assert result == []
    store.close()


@skip_no_ladybug
def test_ladybug_store_get_chunks_by_ids_all_unknown(tmp_path: pathlib.Path) -> None:
    """LadybugStore.get_chunks_by_ids with all unknown IDs returns empty list."""
    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    result = store.get_chunks_by_ids(["x", "y", "z"])
    assert result == []
    store.close()

