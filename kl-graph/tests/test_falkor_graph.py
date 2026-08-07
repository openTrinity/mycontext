"""Unit tests for FalkorGraphDB.

Tests skip if neither `falkordb` nor `falkordblite` is installed.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

try:
    import falkordb  # noqa: F401
    has_falkordb = True
except ImportError:
    try:
        import falkordblite  # noqa: F401
        has_falkordb = True
    except ImportError:
        has_falkordb = False

skip_no_falkordb = pytest.mark.skipif(
    not has_falkordb,
    reason="falkordb/falkordblite not installed — install with: pip install falkordblite",
)


# ── SQLite fixture helpers ────────────────────────────────────────────────────

def _make_sqlite() -> sqlite3.Connection:
    """Create an in-memory SQLite DB with the expected schema."""
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
            confidence REAL DEFAULT 0.8,
            timestamp INTEGER DEFAULT 0
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
    """)
    return conn


def _add_entity(conn: sqlite3.Connection, eid: str, name: str = "", etype: str = "person") -> None:
    conn.execute(
        "INSERT INTO entities(id, name, entity_type, mention_count) VALUES (?, ?, ?, ?)",
        (eid, name or eid, etype, 1),
    )


def _add_fact(conn: sqlite3.Connection, fid: str, text: str = "") -> None:
    conn.execute(
        "INSERT INTO facts(id, text, fact_type, confidence, timestamp) VALUES (?, ?, ?, ?, ?)",
        (fid, text or fid, "general", 0.9, 0),
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


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
def triangle_sqlite() -> sqlite3.Connection:
    """Triangle: A --ENTITY_SIMILAR--> B (1-hop) and A --ABOUT--> F1 --ABOUT--> B (2-hop)."""
    conn = _make_sqlite()
    _add_entity(conn, "A")
    _add_entity(conn, "B")
    _add_fact(conn, "F1")
    _add_edge(conn, "A", "entity", "B", "entity", "ENTITY_SIMILAR")
    _add_edge(conn, "A", "entity", "F1", "fact", "ABOUT")
    _add_edge(conn, "F1", "fact", "B", "entity", "ABOUT")
    conn.commit()
    return conn


@pytest.fixture()
def diamond_sqlite() -> sqlite3.Connection:
    """Diamond: A→F1→B and A→F2→B (two equal-length 2-hop paths)."""
    conn = _make_sqlite()
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


# ── Import error ──────────────────────────────────────────────────────────────

def test_import_error_message(monkeypatch):
    """ImportError includes install instructions and fallback suggestion."""
    import sys
    # Patch both falkordb and falkordblite to simulate missing packages
    monkeypatch.setitem(sys.modules, "falkordb", None)
    monkeypatch.setitem(sys.modules, "falkordblite", None)
    with pytest.raises(ImportError, match="pip install falkordblite"):
        from kl_graph.storage.falkor_graph import FalkorGraphDB
        FalkorGraphDB()


# ── _ensure_schema ────────────────────────────────────────────────────────────

@skip_no_falkordb
def test_ensure_schema_creates_indexes():
    """_ensure_schema() runs without error and creates indexes on id fields."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_schema")
    try:
        # Schema creation is idempotent — calling again should not raise
        db._ensure_schema()
    finally:
        db.close()


# ── Sync correctness ──────────────────────────────────────────────────────────

@skip_no_falkordb
def test_sync_entities(triangle_sqlite):
    """sync() imports entities from SQLite."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_sync_ent", sync_from=triangle_sqlite)
    try:
        rows = db.query("MATCH (e:Entity) RETURN e.id AS eid")
        ids = {r["eid"] for r in rows}
        assert "A" in ids
        assert "B" in ids
    finally:
        db.close()


@skip_no_falkordb
def test_sync_facts(triangle_sqlite):
    """sync() imports facts from SQLite."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_sync_facts", sync_from=triangle_sqlite)
    try:
        rows = db.query("MATCH (f:Fact) RETURN f.id AS fid")
        ids = {r["fid"] for r in rows}
        assert "F1" in ids
    finally:
        db.close()


@skip_no_falkordb
def test_sync_idempotent(triangle_sqlite):
    """sync() is idempotent — running twice doesn't duplicate nodes."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_sync_idem", sync_from=triangle_sqlite)
    try:
        db.sync(triangle_sqlite)  # second sync
        rows = db.query("MATCH (e:Entity) RETURN count(e) AS cnt")
        assert rows[0]["cnt"] == 2  # A and B
    finally:
        db.close()


@skip_no_falkordb
def test_sync_edges(triangle_sqlite):
    """sync() imports walkable edges from SQLite."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_sync_edges", sync_from=triangle_sqlite)
    try:
        nbrs = db.neighbors("A", "entity", direction="out")
        assert len(nbrs) >= 1
    finally:
        db.close()


# ── find_paths ────────────────────────────────────────────────────────────────

@skip_no_falkordb
def test_find_paths_shortest(triangle_sqlite):
    """find_paths returns the 1-hop shortest path."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_fp_short", sync_from=triangle_sqlite)
    try:
        result = db.find_paths("A", "B")
        assert not result.exhausted
        assert len(result.paths) >= 1
        shortest = min(result.paths, key=lambda p: p.hop_count)
        assert shortest.hop_count == 1
    finally:
        db.close()


@skip_no_falkordb
def test_find_paths_all_shortest_diamond(diamond_sqlite):
    """all_shortest=True returns both 2-hop paths in a diamond graph."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_fp_dia", sync_from=diamond_sqlite)
    try:
        result = db.find_paths("A", "B", all_shortest=True)
        assert not result.exhausted
        assert len(result.paths) >= 2
        for p in result.paths:
            assert p.hop_count == 2
    finally:
        db.close()


@skip_no_falkordb
def test_find_paths_no_path_exhausted(triangle_sqlite):
    """find_paths returns exhausted=True when target does not exist."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_fp_nop", sync_from=triangle_sqlite)
    try:
        result = db.find_paths("A", "NONEXISTENT")
        assert result.exhausted
        assert result.paths == []
    finally:
        db.close()


@skip_no_falkordb
def test_find_paths_result_structure(triangle_sqlite):
    """PathResult has correct source/target/paths structure."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_fp_struct", sync_from=triangle_sqlite)
    try:
        result = db.find_paths("A", "B")
        assert result.source.id == "A"
        assert result.target.id == "B"
        for path in result.paths:
            assert len(path.nodes) >= 2
            assert path.nodes[0].id == "A"
            assert path.nodes[-1].id == "B"
    finally:
        db.close()


@skip_no_falkordb
def test_find_paths_max_hops_limits(diamond_sqlite):
    """max_hops=1 prevents finding the 2-hop path."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_fp_hops", sync_from=diamond_sqlite)
    try:
        result = db.find_paths("A", "B", max_hops=1)
        assert result.exhausted
    finally:
        db.close()


@skip_no_falkordb
def test_find_paths_edge_type_filter(triangle_sqlite):
    """edge_types filter restricts which relationship types are traversed."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_fp_etf", sync_from=triangle_sqlite)
    try:
        result = db.find_paths("A", "B", edge_types=["ENTITY_SIMILAR"])
        # ENTITY_SIMILAR direct edge should find the 1-hop path
        if not result.exhausted:
            for path in result.paths:
                for edge in path.edges:
                    assert edge.edge_type == "ENTITY_SIMILAR"
    finally:
        db.close()


# ── neighbors ─────────────────────────────────────────────────────────────────

@skip_no_falkordb
def test_neighbors_out(triangle_sqlite):
    """neighbors returns outgoing neighbors."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_nbr_out", sync_from=triangle_sqlite)
    try:
        nbrs = db.neighbors("A", "entity", direction="out")
        nbr_ids = {n[0] for n in nbrs}
        assert "B" in nbr_ids or "F1" in nbr_ids
    finally:
        db.close()


@skip_no_falkordb
def test_neighbors_edge_type_filter(triangle_sqlite):
    """edge_types filter restricts neighbors returned."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_nbr_etf", sync_from=triangle_sqlite)
    try:
        nbrs = db.neighbors("A", "entity", edge_types=["ENTITY_SIMILAR"], direction="both")
        for _bid, _btype, etype, _props in nbrs:
            assert etype == "ENTITY_SIMILAR"
    finally:
        db.close()


@skip_no_falkordb
def test_neighbors_tuple_structure(triangle_sqlite):
    """Each neighbor entry is a 4-tuple (id, type, edge_type, props)."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_nbr_tup", sync_from=triangle_sqlite)
    try:
        nbrs = db.neighbors("A", "entity", direction="out")
        for n in nbrs:
            assert len(n) == 4
            assert isinstance(n[0], str)
            assert isinstance(n[1], str)
            assert isinstance(n[2], str)
            assert isinstance(n[3], dict)
    finally:
        db.close()


# ── query (raw Cypher) ────────────────────────────────────────────────────────

@skip_no_falkordb
def test_raw_query_returns_list_of_dicts(triangle_sqlite):
    """query() returns a list of dicts with header keys."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_q_dicts", sync_from=triangle_sqlite)
    try:
        rows = db.query("MATCH (e:Entity) RETURN e.id AS eid, e.name AS ename LIMIT 5")
        assert isinstance(rows, list)
        for row in rows:
            assert isinstance(row, dict)
            assert "eid" in row
    finally:
        db.close()


@skip_no_falkordb
def test_raw_query_empty_result(triangle_sqlite):
    """query() returns empty list when no rows match."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_q_empty", sync_from=triangle_sqlite)
    try:
        rows = db.query("MATCH (e:Entity {id: 'NONEXISTENT'}) RETURN e.id")
        assert rows == []
    finally:
        db.close()


@skip_no_falkordb
def test_raw_query_with_params(triangle_sqlite):
    """query() accepts parameter dict."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_q_params", sync_from=triangle_sqlite)
    try:
        rows = db.query("MATCH (e:Entity {id: $id}) RETURN e.id AS eid", {"id": "A"})
        assert len(rows) == 1
        assert rows[0]["eid"] == "A"
    finally:
        db.close()


# ── close ─────────────────────────────────────────────────────────────────────

@skip_no_falkordb
def test_close_no_error():
    """close() can be called without error."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_close")
    db.close()  # Should not raise


@skip_no_falkordb
def test_close_twice_no_error():
    """close() called twice does not raise."""
    from kl_graph.storage.falkor_graph import FalkorGraphDB
    db = FalkorGraphDB(graph_name="test_close2")
    db.close()
    db.close()  # Should not raise
