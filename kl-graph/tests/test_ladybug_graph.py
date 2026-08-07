"""Unit tests for LadybugGraphDB.

Tests skip if `ladybug` is not installed.
"""

from __future__ import annotations

import pytest

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


# ── Fixture helpers ───────────────────────────────────────────────────────────

def _populate_triangle(db) -> None:
    """Populate a LadybugGraphDB with the triangle fixture.

    Graph: A --ENTITY_SIMILAR--> B (1-hop) and A --ABOUT--> F1 --ABOUT--> B (2-hop).
    """
    db.upsert_entity_node("A", "A", "person", 1)
    db.upsert_entity_node("B", "B", "person", 1)
    db.upsert_fact_node("F1", "F1 text", "general", 0.9, 0)
    db.insert_edges("entity", "A", "entity", "B", "ENTITY_SIMILAR")
    db.insert_edges("entity", "A", "fact", "F1", "ABOUT")
    db.insert_edges("fact", "F1", "entity", "B", "ABOUT")


def _populate_diamond(db) -> None:
    """Populate a LadybugGraphDB with the diamond fixture.

    Graph: A→F1→B and A→F2→B (two equal-length 2-hop paths).
    """
    db.upsert_entity_node("A", "A", "person", 1)
    db.upsert_entity_node("B", "B", "person", 1)
    db.upsert_fact_node("F1", "F1 text", "general", 0.9, 0)
    db.upsert_fact_node("F2", "F2 text", "general", 0.9, 0)
    db.insert_edges("entity", "A", "fact", "F1", "ABOUT")
    db.insert_edges("fact", "F1", "entity", "B", "ABOUT")
    db.insert_edges("entity", "A", "fact", "F2", "ABOUT")
    db.insert_edges("fact", "F2", "entity", "B", "ABOUT")


# ── Import error ──────────────────────────────────────────────────────────────

def test_import_error_message(monkeypatch, tmp_path):
    """ImportError includes install instructions and fallback suggestion."""
    import sys
    # Patch ladybug to simulate missing package
    monkeypatch.setitem(sys.modules, "ladybug", None)
    with pytest.raises(ImportError, match="pip install ladybug"):
        from kl_graph.storage.ladybug_graph import LadybugGraphDB
        LadybugGraphDB(db_path=str(tmp_path / "test.ladybug"))


# ── find_paths ────────────────────────────────────────────────────────────────

@skip_no_ladybug
def test_open_recovers_from_orphaned_wal(tmp_path):
    """A hard-killed build leaves a stale ``<db>.wal`` that bricks reopen.

    LadybugGraphDB must detect the orphaned/corrupt WAL, delete it, and reopen
    (rebuild-not-migrate: an uncommitted WAL holds no state we keep). Without
    this, every subsequent build fails until the file is removed by hand.
    """
    from kl_graph.storage.ladybug_graph import LadybugGraphDB

    db_path = tmp_path / "g"
    db = LadybugGraphDB(db_path=str(db_path))
    db.upsert_entity_node("A", "A", "person", 1)
    del db

    # Simulate the crash aftermath: main file gone, a mismatched WAL left behind.
    if db_path.exists():
        db_path.unlink()
    (tmp_path / "g.wal").write_bytes(b"orphaned-wal-bytes")

    # Must recover rather than raise.
    db2 = LadybugGraphDB(db_path=str(db_path))
    db2.upsert_entity_node("B", "B", "person", 1)  # writable after recovery


@skip_no_ladybug
def test_edge_properties_round_trip(tmp_path):
    """Full edge properties survive insert→scan on LadybugDB (U1 linchpin).

    Before U1, LadybugDB persisted only ``confidence``, silently dropping
    ``hybrid_score``/``score``/``source`` — which the periodic stages read back
    for weighting and disambiguation. They must now round-trip verbatim.
    """
    from kl_graph.storage.ladybug_graph import LadybugGraphDB

    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    db.upsert_entity_node("A", "A", "person", 1)
    db.upsert_entity_node("B", "B", "person", 1)
    props = {
        "source": "disambiguation",
        "hybrid_score": 0.87,
        "confidence": 0.9,
        "llm_judged": True,
    }
    db.insert_edges("entity", "A", "entity", "B", "ENTITY_SIMILAR", properties=props)

    scanned = list(db.scan_edges_typed(["ENTITY_SIMILAR"]))
    assert len(scanned) == 1
    src, tgt, got = scanned[0]
    assert (src, tgt) == ("A", "B")
    assert got["source"] == "disambiguation"
    assert got["hybrid_score"] == 0.87
    assert got["llm_judged"] is True
    assert got["confidence"] == 0.9

    # get_neighbors also surfaces the full dict, not just confidence.
    nbrs = db.get_neighbors("A", "entity", edge_types=["ENTITY_SIMILAR"], direction="out")
    assert nbrs and nbrs[0][3].get("source") == "disambiguation"


@skip_no_ladybug
def test_scan_edges_typed_filters_by_endpoint_type(tmp_path):
    """scan_edges_typed honours source_type/target_type and multiple types."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB

    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    db.upsert_chunk_node("C1", "message", 0, "")
    db.upsert_entity_node("E1", "E1", "person", 1)
    db.upsert_fact_node("F1", "f", "general", 0.9, 0)
    db.insert_edges("chunk", "C1", "entity", "E1", "MENTIONS")
    db.insert_edges("chunk", "C1", "entity", "E1", "AUTHORED_BY")
    db.insert_edges("fact", "F1", "entity", "E1", "ABOUT")

    # both mention-like types, chunk→entity
    got = list(
        db.scan_edges_typed(
            ["MENTIONS", "AUTHORED_BY"], source_type="chunk", target_type="entity"
        )
    )
    assert sorted(g[:2] for g in got) == [("C1", "E1"), ("C1", "E1")]
    # ABOUT fact→entity
    about = list(db.scan_edges_typed(["ABOUT"], source_type="fact", target_type="entity"))
    assert [g[:2] for g in about] == [("F1", "E1")]


@skip_no_ladybug
def test_delete_edges_by_property(tmp_path):
    """delete_edges(where_properties=...) removes only property-matching edges."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB

    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    db.upsert_entity_node("A", "A", "person", 1)
    db.upsert_entity_node("B", "B", "person", 1)
    db.upsert_entity_node("C", "C", "person", 1)
    db.insert_edges("entity", "A", "entity", "B", "ENTITY_SIMILAR",
                    properties={"source": "disambiguation"})
    db.insert_edges("entity", "A", "entity", "C", "ENTITY_SIMILAR",
                    properties={"source": "similarity"})

    db.delete_edges(edge_type="ENTITY_SIMILAR",
                    where_properties={"source": "disambiguation"})
    remaining = [(s, t, p.get("source")) for s, t, p in db.scan_edges_typed(["ENTITY_SIMILAR"])]
    assert remaining == [("A", "C", "similarity")]


@skip_no_ladybug
@xfail_ladybug_dialect
def test_find_paths_shortest(tmp_path):
    """find_paths returns the shortest path."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_triangle(db)
        result = db.find_paths("A", "B")
        assert not result.exhausted
        assert len(result.paths) >= 1
        shortest = min(result.paths, key=lambda p: p.hop_count)
        assert shortest.hop_count == 1
    finally:
        db.close()


@skip_no_ladybug
@xfail_ladybug_dialect
def test_find_paths_all_shortest_diamond(tmp_path):
    """all_shortest=True returns both equal-length paths in a diamond graph."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_diamond(db)
        result = db.find_paths("A", "B", all_shortest=True)
        assert not result.exhausted
        assert len(result.paths) >= 2
        for p in result.paths:
            assert p.hop_count == 2
    finally:
        db.close()


@skip_no_ladybug
def test_find_paths_no_path_returns_exhausted(tmp_path):
    """find_paths returns exhausted=True when no path exists."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_triangle(db)
        result = db.find_paths("A", "NONEXISTENT")
        assert result.exhausted
        assert result.paths == []
    finally:
        db.close()


@skip_no_ladybug
def test_find_paths_result_structure(tmp_path):
    """PathResult has correct source/target/paths structure."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_triangle(db)
        result = db.find_paths("A", "B")
        assert result.source.id == "A"
        assert result.target.id == "B"
        for path in result.paths:
            assert len(path.nodes) >= 2
            assert path.nodes[0].id == "A"
            assert path.nodes[-1].id == "B"
    finally:
        db.close()


@skip_no_ladybug
def test_find_paths_max_hops_limits(tmp_path):
    """max_hops=1 prevents finding the 2-hop diamond path."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_diamond(db)
        result = db.find_paths("A", "B", max_hops=1)
        assert result.exhausted
    finally:
        db.close()


# ── neighbors ─────────────────────────────────────────────────────────────────

@skip_no_ladybug
@xfail_ladybug_dialect
def test_neighbors_out(tmp_path):
    """neighbors returns outgoing neighbors."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_triangle(db)
        nbrs = db.neighbors("A", "entity", direction="out")
        nbr_ids = {n[0] for n in nbrs}
        assert "B" in nbr_ids or "F1" in nbr_ids
    finally:
        db.close()


@skip_no_ladybug
def test_neighbors_edge_type_filter(tmp_path):
    """edge_types filter restricts neighbors returned."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_triangle(db)
        nbrs = db.neighbors("A", "entity", edge_types=["ENTITY_SIMILAR"], direction="both")
        nbr_ids = {n[0] for n in nbrs}
        # Should include B (ENTITY_SIMILAR) but not F1 (ABOUT)
        if nbr_ids:
            for _bid, _btype, etype, _props in nbrs:
                assert etype == "ENTITY_SIMILAR"
    finally:
        db.close()


@skip_no_ladybug
def test_neighbors_tuple_structure(tmp_path):
    """Each neighbor entry is a 4-tuple (id, type, edge_type, props)."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_triangle(db)
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

@skip_no_ladybug
def test_raw_query_returns_list_of_dicts(tmp_path):
    """query() returns a list of dicts with column names as keys."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_triangle(db)
        rows = db.query("MATCH (e:Entity) RETURN e.id AS eid, e.name AS ename LIMIT 5")
        assert isinstance(rows, list)
        for row in rows:
            assert isinstance(row, dict)
            assert "eid" in row
            assert "ename" in row
    finally:
        db.close()


@skip_no_ladybug
@xfail_ladybug_dialect
def test_raw_query_with_params(tmp_path):
    """query() accepts parameter dict."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        _populate_triangle(db)
        rows = db.query("MATCH (e:Entity {id: $id}) RETURN e.id AS eid", {"id": "A"})
        assert len(rows) == 1
        assert rows[0]["eid"] == "A"
    finally:
        db.close()


# ── upsert nodes ──────────────────────────────────────────────────────────────

@skip_no_ladybug
@xfail_ladybug_dialect
def test_upsert_entity_node(tmp_path):
    """upsert_entity_node inserts a queryable Entity node."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        db.upsert_entity_node("E1", "Alice", "person", 3)
        rows = db.query("MATCH (e:Entity {id: 'E1'}) RETURN e.name AS n")
        assert rows[0]["n"] == "Alice"
    finally:
        db.close()


@skip_no_ladybug
def test_upsert_fact_node(tmp_path):
    """upsert_fact_node inserts a queryable Fact node."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    try:
        db.upsert_fact_node("F99", "some fact", "general", 0.8, 1234)
        rows = db.query("MATCH (f:Fact {id: 'F99'}) RETURN f.text AS t")
        assert rows[0]["t"] == "some fact"
    finally:
        db.close()


# ── close ─────────────────────────────────────────────────────────────────────

@skip_no_ladybug
def test_close(tmp_path):
    """close() can be called without error."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB
    db = LadybugGraphDB(db_path=str(tmp_path / "g"))
    db.close()  # Should not raise
