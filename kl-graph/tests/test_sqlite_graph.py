"""Unit tests for SQLiteGraphDB BFS path finding."""

from __future__ import annotations

import json
import sqlite3

import pytest

from kl_graph.storage.graph_db import create_graph_db
from kl_graph.storage.sqlite_graph import SQLiteGraphDB

# ── Fixture helpers ──────────────────────────────────────────────────────────


def _make_db() -> sqlite3.Connection:
    """Create an in-memory SQLite DB with entities, facts, and edges tables."""
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE entities (
            id TEXT PRIMARY KEY,
            name TEXT,
            entity_type TEXT,
            mention_count INTEGER DEFAULT 0
        );
        CREATE TABLE facts (
            id TEXT PRIMARY KEY,
            text TEXT,
            fact_type TEXT,
            confidence REAL DEFAULT 0.8
        );
        CREATE TABLE edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id TEXT,
            source_type TEXT,
            target_id TEXT,
            target_type TEXT,
            edge_type TEXT,
            properties TEXT
        );
        CREATE INDEX idx_edges_source ON edges(source_id, source_type);
        CREATE INDEX idx_edges_target ON edges(target_id, target_type);
    """)
    return conn


def _add_entity(conn: sqlite3.Connection, eid: str, name: str = "") -> None:
    conn.execute(
        "INSERT INTO entities(id, name) VALUES (?, ?)",
        (eid, name or eid),
    )


def _add_fact(conn: sqlite3.Connection, fid: str, text: str = "") -> None:
    conn.execute(
        "INSERT INTO facts(id, text) VALUES (?, ?)",
        (fid, text or fid),
    )


def _add_edge(
    conn: sqlite3.Connection,
    src: str,
    src_type: str,
    tgt: str,
    tgt_type: str,
    etype: str,
    props: dict | None = None,
) -> None:
    conn.execute(
        "INSERT INTO edges(source_id, source_type, target_id, target_type, edge_type, properties) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (src, src_type, tgt, tgt_type, etype, json.dumps(props) if props else None),
    )


# ── Triangle graph ────────────────────────────────────────────────────────────
#
#  A --ABOUT--> F1 --ABOUT--> B
#  A --ENTITY_SIMILAR--> B  (direct, 1 hop)
#
# Shortest path A→B = 1 hop (ENTITY_SIMILAR edge).
# All shortest paths include just the 1-hop ENTITY_SIMILAR.
# 2-hop path via F1 is also reachable when all_shortest=True only for
# equal-length sets; here the 2-hop path is longer so it won't appear.


@pytest.fixture()
def triangle_db() -> sqlite3.Connection:
    """Triangle graph: A --1-hop--> B (direct) and A --2-hop--> B (via F1)."""
    conn = _make_db()
    _add_entity(conn, "A")
    _add_entity(conn, "B")
    _add_fact(conn, "F1")
    # direct edge: 1 hop
    _add_edge(conn, "A", "entity", "B", "entity", "ENTITY_SIMILAR")
    # indirect path: 2 hops through fact F1
    _add_edge(conn, "A", "entity", "F1", "fact", "ABOUT")
    _add_edge(conn, "F1", "fact", "B", "entity", "ABOUT")
    conn.commit()
    return conn


def test_triangle_shortest_path(triangle_db: sqlite3.Connection) -> None:
    """Finds the 1-hop direct path first."""
    db = SQLiteGraphDB(triangle_db)
    result = db.find_paths("A", "B")
    assert not result.exhausted
    assert len(result.paths) >= 1
    # Shortest path should be 1 hop
    shortest = min(result.paths, key=lambda p: p.hop_count)
    assert shortest.hop_count == 1
    assert shortest.edges[0].edge_type == "ENTITY_SIMILAR"


def test_triangle_single_path_returned_by_default(triangle_db: sqlite3.Connection) -> None:
    """Without all_shortest, only the first shortest path is returned."""
    db = SQLiteGraphDB(triangle_db)
    result = db.find_paths("A", "B", all_shortest=False)
    assert not result.exhausted
    assert len(result.paths) == 1


def test_triangle_source_equals_target(triangle_db: sqlite3.Connection) -> None:
    """Path from a node to itself is a zero-hop trivial path."""
    db = SQLiteGraphDB(triangle_db)
    result = db.find_paths("A", "A")
    assert not result.exhausted
    assert len(result.paths) == 1
    assert result.paths[0].hop_count == 0
    assert result.paths[0].length == 0


def test_triangle_no_path_exhausted(triangle_db: sqlite3.Connection) -> None:
    """When target is unreachable, exhausted=True and paths=[]."""
    db = SQLiteGraphDB(triangle_db)
    result = db.find_paths("A", "NONEXISTENT", max_hops=4)
    assert result.exhausted
    assert result.paths == []


def test_triangle_max_hops_limits_search(triangle_db: sqlite3.Connection) -> None:
    """With max_hops=0 (no hops allowed), path not found (except self→self)."""
    db = SQLiteGraphDB(triangle_db)
    result = db.find_paths("A", "B", max_hops=0)
    assert result.exhausted


# ── Diamond graph ─────────────────────────────────────────────────────────────
#
#         F1
#        /  \
#  A ──▶      ──▶ B    (2-hop paths: A→F1→B, A→F2→B)
#        \  /
#         F2
#
# Two equal-length shortest paths: A→F1→B and A→F2→B.


@pytest.fixture()
def diamond_db() -> sqlite3.Connection:
    """Diamond graph: A→F1→B and A→F2→B (two equal-length paths)."""
    conn = _make_db()
    _add_entity(conn, "A")
    _add_entity(conn, "B")
    _add_fact(conn, "F1")
    _add_fact(conn, "F2")
    _add_edge(conn, "A", "entity", "F1", "fact", "ABOUT")
    _add_edge(conn, "F1", "fact", "B", "entity", "ABOUT")
    _add_edge(conn, "A", "entity", "F2", "fact", "ABOUT")
    _add_edge(conn, "F2", "fact", "B", "entity", "ABOUT")
    conn.commit()
    return conn


def test_diamond_all_shortest_returns_two_paths(diamond_db: sqlite3.Connection) -> None:
    """all_shortest=True returns both 2-hop paths."""
    db = SQLiteGraphDB(diamond_db)
    result = db.find_paths("A", "B", all_shortest=True)
    assert not result.exhausted
    assert len(result.paths) == 2
    for p in result.paths:
        assert p.hop_count == 2


def test_diamond_single_path_returns_one(diamond_db: sqlite3.Connection) -> None:
    """Without all_shortest only one path is returned."""
    db = SQLiteGraphDB(diamond_db)
    result = db.find_paths("A", "B", all_shortest=False)
    assert not result.exhausted
    assert len(result.paths) == 1
    assert result.paths[0].hop_count == 2


def test_diamond_path_nodes_and_edges_structure(diamond_db: sqlite3.Connection) -> None:
    """Each path has 3 nodes and 2 edges."""
    db = SQLiteGraphDB(diamond_db)
    result = db.find_paths("A", "B", all_shortest=True)
    for p in result.paths:
        assert len(p.nodes) == 3
        assert len(p.edges) == 2
        assert p.nodes[0].id == "A"
        assert p.nodes[-1].id == "B"


def test_diamond_max_hops_1_no_path(diamond_db: sqlite3.Connection) -> None:
    """max_hops=1 prevents finding the 2-hop path."""
    db = SQLiteGraphDB(diamond_db)
    result = db.find_paths("A", "B", max_hops=1)
    assert result.exhausted


# ── Edge type filtering ───────────────────────────────────────────────────────


@pytest.fixture()
def filtered_db() -> sqlite3.Connection:
    """Graph with mixed edge types: A→B via ABOUT facts, A→B via ENTITY_SIMILAR."""
    conn = _make_db()
    _add_entity(conn, "A")
    _add_entity(conn, "B")
    _add_entity(conn, "C")
    _add_fact(conn, "F_about")
    _add_edge(conn, "A", "entity", "F_about", "fact", "ABOUT")
    _add_edge(conn, "F_about", "fact", "B", "entity", "ABOUT")
    # Parallel 2-hop route over a different edge type (entity↔entity similarity).
    _add_edge(conn, "A", "entity", "C", "entity", "ENTITY_SIMILAR")
    _add_edge(conn, "C", "entity", "B", "entity", "ENTITY_SIMILAR")
    conn.commit()
    return conn


def test_edge_type_filter_about_only(filtered_db: sqlite3.Connection) -> None:
    """Filtering to ABOUT only returns path via F_about."""
    db = SQLiteGraphDB(filtered_db)
    result = db.find_paths("A", "B", edge_types=["ABOUT"], all_shortest=True)
    assert not result.exhausted
    for p in result.paths:
        for e in p.edges:
            assert e.edge_type == "ABOUT"
    # Intermediate node must be F_about, never the ENTITY_SIMILAR hop
    intermediate_ids = {n.id for p in result.paths for n in p.nodes[1:-1]}
    assert "F_about" in intermediate_ids
    assert "C" not in intermediate_ids


def test_edge_type_filter_excludes_all_returns_exhausted(
    filtered_db: sqlite3.Connection,
) -> None:
    """Filtering to an edge type not present means no path found."""
    db = SQLiteGraphDB(filtered_db)
    result = db.find_paths("A", "B", edge_types=["FACT_SIMILAR"])
    assert result.exhausted


# ── Undirected traversal (reverse edges) ─────────────────────────────────────


def test_reverse_edge_traversal() -> None:
    """BFS should traverse incoming edges too (undirected behaviour)."""
    conn = _make_db()
    _add_entity(conn, "A")
    _add_entity(conn, "B")
    _add_fact(conn, "F1")
    # Only edge: F1 --ABOUT--> A (incoming to A)
    # B --ABOUT--> F1 (incoming to F1)
    _add_edge(conn, "F1", "fact", "A", "entity", "ABOUT")
    _add_edge(conn, "B", "entity", "F1", "fact", "ABOUT")
    conn.commit()

    db = SQLiteGraphDB(conn)
    # A→B via A←F1←B (2 hops, both incoming relative to search direction)
    result = db.find_paths("A", "B", max_hops=4)
    assert not result.exhausted
    assert result.paths[0].hop_count == 2


# ── neighbors() method ────────────────────────────────────────────────────────


@pytest.fixture()
def neighbors_db() -> sqlite3.Connection:
    """Simple graph for testing neighbors()."""
    conn = _make_db()
    _add_entity(conn, "E1")
    _add_entity(conn, "E2")
    _add_fact(conn, "F1")
    _add_fact(conn, "F2")
    # E1 --ABOUT--> F1 (outgoing from E1)
    # F2 --ABOUT--> E1 (incoming to E1)
    # E1 --ENTITY_SIMILAR--> E2 (outgoing)
    _add_edge(conn, "E1", "entity", "F1", "fact", "ABOUT")
    _add_edge(conn, "F2", "fact", "E1", "entity", "ABOUT")
    _add_edge(conn, "E1", "entity", "E2", "entity", "ENTITY_SIMILAR")
    conn.commit()
    return conn


def test_neighbors_both_directions(neighbors_db: sqlite3.Connection) -> None:
    """direction='both' returns outgoing and incoming neighbors."""
    db = SQLiteGraphDB(neighbors_db)
    nbrs = db.neighbors("E1", "entity", direction="both")
    nbr_ids = {n[0] for n in nbrs}
    assert "F1" in nbr_ids  # outgoing ABOUT
    assert "F2" in nbr_ids  # incoming ABOUT
    assert "E2" in nbr_ids  # outgoing ENTITY_SIMILAR


def test_neighbors_out_only(neighbors_db: sqlite3.Connection) -> None:
    """direction='out' returns only outgoing neighbors."""
    db = SQLiteGraphDB(neighbors_db)
    nbrs = db.neighbors("E1", "entity", direction="out")
    nbr_ids = {n[0] for n in nbrs}
    assert "F1" in nbr_ids
    assert "E2" in nbr_ids
    assert "F2" not in nbr_ids  # incoming only


def test_neighbors_in_only(neighbors_db: sqlite3.Connection) -> None:
    """direction='in' returns only incoming neighbors."""
    db = SQLiteGraphDB(neighbors_db)
    nbrs = db.neighbors("E1", "entity", direction="in")
    nbr_ids = {n[0] for n in nbrs}
    assert "F2" in nbr_ids
    assert "F1" not in nbr_ids
    assert "E2" not in nbr_ids


def test_neighbors_edge_type_filter(neighbors_db: sqlite3.Connection) -> None:
    """Edge type filter restricts which neighbors are returned."""
    db = SQLiteGraphDB(neighbors_db)
    nbrs = db.neighbors("E1", "entity", edge_types=["ENTITY_SIMILAR"], direction="both")
    nbr_ids = {n[0] for n in nbrs}
    assert "E2" in nbr_ids
    assert "F1" not in nbr_ids
    assert "F2" not in nbr_ids


def test_neighbors_limit(neighbors_db: sqlite3.Connection) -> None:
    """limit parameter caps the total number of neighbors returned."""
    db = SQLiteGraphDB(neighbors_db)
    nbrs = db.neighbors("E1", "entity", direction="both", limit=1)
    assert len(nbrs) == 1


def test_neighbors_return_tuple_structure(neighbors_db: sqlite3.Connection) -> None:
    """Each neighbor entry is a 4-tuple (id, type, edge_type, props)."""
    db = SQLiteGraphDB(neighbors_db)
    nbrs = db.neighbors("E1", "entity", direction="out")
    assert len(nbrs) > 0
    for nbr in nbrs:
        assert len(nbr) == 4
        assert isinstance(nbr[0], str)
        assert isinstance(nbr[1], str)
        assert isinstance(nbr[2], str)
        assert isinstance(nbr[3], dict)


# ── close() ──────────────────────────────────────────────────────────────────


def test_close_is_noop(triangle_db: sqlite3.Connection) -> None:
    """close() does not close the connection (server manages lifecycle)."""
    db = SQLiteGraphDB(triangle_db)
    db.close()
    # Connection should still be functional
    count = triangle_db.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
    assert count > 0


# ── factory ──────────────────────────────────────────────────────────────────


def test_factory_sqlite(triangle_db: sqlite3.Connection) -> None:
    """create_graph_db('sqlite', conn=...) returns SQLiteGraphDB."""
    db = create_graph_db("sqlite", conn=triangle_db)
    assert isinstance(db, SQLiteGraphDB)


def test_factory_sqlite_ignores_extra_kwargs(triangle_db: sqlite3.Connection) -> None:
    """create_graph_db passes all kwargs to backend; SQLiteGraphDB ignores non-conn ones."""
    db = create_graph_db(
        "sqlite",
        conn=triangle_db,
        db_path="/data/graph.ladybug",
        sync_from=triangle_db,
        graph_name="kl_graph",
        host="localhost",
        port=6379,
    )
    assert isinstance(db, SQLiteGraphDB)


def test_factory_unknown_backend(triangle_db: sqlite3.Connection) -> None:
    """create_graph_db raises ValueError for unknown backends."""
    with pytest.raises(ValueError, match="Unknown graph backend"):
        create_graph_db("unknown_backend", conn=triangle_db)


# ── PathResult and Path structure ─────────────────────────────────────────────


def test_path_result_source_target_nodes(triangle_db: sqlite3.Connection) -> None:
    """PathResult.source and .target are PathNode with correct types."""
    db = SQLiteGraphDB(triangle_db)
    result = db.find_paths("A", "B")
    assert result.source.id == "A"
    assert result.source.node_type == "entity"
    assert result.target.id == "B"
    assert result.target.node_type == "entity"


def test_path_edge_direction_out(triangle_db: sqlite3.Connection) -> None:
    """Outgoing edges have direction='out'."""
    db = SQLiteGraphDB(triangle_db)
    result = db.find_paths("A", "B")
    # 1-hop ENTITY_SIMILAR direct edge should be 'out'
    direct = next(p for p in result.paths if p.hop_count == 1)
    assert direct.edges[0].direction == "out"
    assert direct.edges[0].source_id == "A"
    assert direct.edges[0].target_id == "B"


def test_path_node_types_resolved(diamond_db: sqlite3.Connection) -> None:
    """Intermediate fact nodes have node_type='fact'."""
    db = SQLiteGraphDB(diamond_db)
    result = db.find_paths("A", "B")
    path = result.paths[0]
    assert path.nodes[0].node_type == "entity"
    assert path.nodes[1].node_type == "fact"
    assert path.nodes[2].node_type == "entity"


# ── Chain graph (longer path) ─────────────────────────────────────────────────


def test_chain_path_length() -> None:
    """A long chain A→F1→E1→F2→B should be found with sufficient max_hops."""
    conn = _make_db()
    _add_entity(conn, "A")
    _add_entity(conn, "E1")
    _add_entity(conn, "B")
    _add_fact(conn, "F1")
    _add_fact(conn, "F2")
    _add_edge(conn, "A", "entity", "F1", "fact", "ABOUT")
    _add_edge(conn, "F1", "fact", "E1", "entity", "ABOUT")
    _add_edge(conn, "E1", "entity", "F2", "fact", "ABOUT")
    _add_edge(conn, "F2", "fact", "B", "entity", "ABOUT")
    conn.commit()

    db = SQLiteGraphDB(conn)
    result = db.find_paths("A", "B", max_hops=4)
    assert not result.exhausted
    assert result.paths[0].hop_count == 4


def test_chain_max_hops_too_small() -> None:
    """A 4-hop path is not found with max_hops=3."""
    conn = _make_db()
    _add_entity(conn, "A")
    _add_entity(conn, "E1")
    _add_entity(conn, "B")
    _add_fact(conn, "F1")
    _add_fact(conn, "F2")
    _add_edge(conn, "A", "entity", "F1", "fact", "ABOUT")
    _add_edge(conn, "F1", "fact", "E1", "entity", "ABOUT")
    _add_edge(conn, "E1", "entity", "F2", "fact", "ABOUT")
    _add_edge(conn, "F2", "fact", "B", "entity", "ABOUT")
    conn.commit()

    db = SQLiteGraphDB(conn)
    result = db.find_paths("A", "B", max_hops=3)
    assert result.exhausted


def test_fact_source_chunk_id_roundtrip() -> None:
    """Facts persist and read back via the renamed source_chunk_id column.

    Divergence F/C rename: Fact.source_message_id -> source_chunk_id, and the
    facts FK now references chunks(id) rather than the (to-be-removed) messages
    table. This asserts the column round-trips through the real store schema.
    """
    from kl_graph.models.types import Fact
    from kl_graph.storage.sqlite_store import SQLiteStore

    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]
    store.insert_facts([Fact(id="F1", text="a claim", source_chunk_id="chunk-42")])
    got = store.get_fact("F1")
    assert got is not None
    assert got.source_chunk_id == "chunk-42"


def test_scopes_table_and_part_of_edge_in_real_schema() -> None:
    """Divergence C: the store schema owns a ``scopes`` table and PART_OF edges.

    Asserts against the real ``_create_tables`` schema (not the trimmed fixture
    DB above) so a missing table/column fails here rather than at ingest time.
    """
    from kl_graph.models.types import Edge, EdgeType, Scope
    from kl_graph.storage.sqlite_store import SQLiteStore

    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]
    cols = {r[1] for r in conn.execute("PRAGMA table_info(scopes)").fetchall()}
    assert cols == {"id", "scope_type", "title", "metadata"}

    store.insert_scopes([Scope(id="s1", scope_type="conversation", title="T")])
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
    assert store.get_scope("s1") is not None
    assert store.count_edges_by_type() == {"PART_OF": 1}


def test_communities_table_and_comm_member_edge_in_real_schema() -> None:
    """Divergence E: the store schema owns a ``communities`` table + COMM_MEMBER.

    Asserts against the real ``_create_tables`` schema (not the trimmed fixture
    DB above) so a missing table/column fails here rather than at improve time.
    """
    from kl_graph.models.types import Community, Edge, EdgeType, community_id_from
    from kl_graph.storage.sqlite_store import SQLiteStore

    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]
    cols = {r[1] for r in conn.execute("PRAGMA table_info(communities)").fetchall()}
    assert cols == {
        "id",
        "level",
        "node_type",
        "summary",
        "tags",
        "member_count",
        "summary_stale",
        "parent_id",
        "parent_level",
    }

    cid = community_id_from("L2", 5)
    store.insert_communities(
        [Community(id=cid, level="L2", node_type="mixed", member_count=4)]
    )
    store.insert_edges(
        [
            Edge(
                source_type="fact",
                source_id="f1",
                target_type="community",
                target_id=cid,
                edge_type=EdgeType.COMM_MEMBER,
                properties={"level": "L2"},
            )
        ]
    )
    assert store.get_community(cid) is not None
    assert store.count_edges_by_type() == {"COMM_MEMBER": 1}
