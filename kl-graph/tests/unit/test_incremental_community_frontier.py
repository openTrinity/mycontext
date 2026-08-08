"""Tests for incremental frontier community assignment (Optimization 2).

Verifies that ``DynamicFrontierLeiden.assign_communities`` uses
``scan_edges_for_nodes`` to build a frontier-only igraph instead of loading
all node IDs and edges, and that community assignments propagate correctly.

Since ``igraph`` and ``leidenalg`` may not be installed in the test
environment, both are mocked via ``sys.modules``.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from types import SimpleNamespace
from unittest.mock import patch

from kl_graph.ingest.strategies.community import DynamicFrontierLeiden
from kl_graph.storage.sqlite_store import SQLiteStore


def _add_entity(conn: sqlite3.Connection, eid: str) -> None:
    conn.execute(
        "INSERT INTO entities "
        "(id, name, entity_type, first_seen, last_seen, mention_count, description) "
        "VALUES (?, ?, 'Unknown', 0, 0, 1, '')",
        (eid, eid),
    )


def _add_edge(
    conn: sqlite3.Connection,
    src_type: str,
    src: str,
    tgt_type: str,
    tgt: str,
    etype: str,
    properties: dict | None = None,
) -> None:
    props = json.dumps(properties) if properties else None
    conn.execute(
        "INSERT OR IGNORE INTO edges "
        "(source_type, source_id, target_type, target_id, edge_type, properties) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (src_type, src, tgt_type, tgt, etype, props),
    )


class _FakeEdgeSeq:
    """Minimal stand-in for igraph's EdgeSeq supporting item assignment."""

    def __setitem__(self, key: str, value: list[float]) -> None:
        if key == "weight":
            self._weights = value

    _weights: list[float] = []

    def __init__(self) -> None:
        self._weights: list[float] = []


class _FakeGraph:
    """Minimal stand-in for igraph.Graph used by _process_node_type."""

    def __init__(self, n: int) -> None:
        self._n = n
        self._edges: list[tuple[int, int]] = []
        self._edge_seq = _FakeEdgeSeq()

    def add_edges(self, edges: list[tuple[int, int]]) -> None:
        self._edges.extend(edges)

    @property
    def es(self) -> _FakeEdgeSeq:
        return self._edge_seq

    def simplify(self, **kwargs: object) -> None:
        pass

    def vcount(self) -> int:
        return self._n


class _FakeIgModule:
    """Fake ``igraph`` module providing ``Graph``."""

    Graph = _FakeGraph


def _make_fake_leiden(membership_result: list[int]) -> SimpleNamespace:
    """Create a fake leidenalg module whose find_partition returns the given membership."""

    def _find_partition(graph, _partition_type, **kwargs):
        return SimpleNamespace(membership=list(membership_result))

    return SimpleNamespace(
        RBConfigurationVertexPartition=object(),
        find_partition=_find_partition,
    )


def test_frontier_uses_scan_edges_for_nodes_not_full_load(tmp_path) -> None:
    """assign_communities uses scan_edges_for_nodes, never SELECT id FROM entities."""
    store = SQLiteStore(tmp_path / "graph.db")
    try:
        store.sql_conn.execute("ALTER TABLE entities ADD COLUMN community_L0 INTEGER")
    except sqlite3.OperationalError:
        pass

    _add_entity(store.sql_conn, "existing")
    _add_entity(store.sql_conn, "new")
    _add_entity(store.sql_conn, "isolated")

    # ENTITY_SIMILAR edge between existing and new
    _add_edge(
        store.sql_conn, "entity", "existing", "entity", "new", "ENTITY_SIMILAR",
        {"hybrid_score": 0.9},
    )
    # MENTIONS edges so co-mention can form (shared chunk)
    _add_edge(store.sql_conn, "chunk", "c1", "entity", "existing", "MENTIONS")
    _add_edge(store.sql_conn, "chunk", "c1", "entity", "new", "MENTIONS")
    _add_edge(store.sql_conn, "chunk", "c2", "entity", "existing", "MENTIONS")
    _add_edge(store.sql_conn, "chunk", "c2", "entity", "new", "MENTIONS")

    store.sql_conn.execute("UPDATE entities SET community_L0 = 7 WHERE id = 'existing'")
    store.sql_conn.execute("UPDATE entities SET community_L0 = 99 WHERE id = 'isolated'")
    store.sql_conn.commit()

    scan_called = {"value": False}
    original_scan = store.scan_edges_for_nodes

    def _tracking_scan(edge_types, node_ids, *, source_type=None, target_type=None):
        scan_called["value"] = True
        yield from original_scan(
            edge_types, node_ids, source_type=source_type, target_type=target_type
        )

    strategy = DynamicFrontierLeiden()
    fake_leiden = _make_fake_leiden([0, 0])

    with (
        patch.object(store, "scan_edges_for_nodes", side_effect=_tracking_scan),
        patch.dict(sys.modules, {"leidenalg": fake_leiden, "igraph": _FakeIgModule()}),
    ):
        strategy.assign_communities(
            store,
            ["new"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

    assert scan_called["value"], "scan_edges_for_nodes was never called"
    store.close()


def test_new_node_inherits_frontier_community(tmp_path) -> None:
    """New node placed in same community as frontier neighbor via Leiden."""
    store = SQLiteStore(tmp_path / "graph.db")
    try:
        store.sql_conn.execute("ALTER TABLE entities ADD COLUMN community_L0 INTEGER")
    except sqlite3.OperationalError:
        pass

    _add_entity(store.sql_conn, "existing")
    _add_entity(store.sql_conn, "new")
    _add_entity(store.sql_conn, "isolated")

    _add_edge(
        store.sql_conn, "entity", "existing", "entity", "new", "ENTITY_SIMILAR",
        {"hybrid_score": 0.9},
    )

    store.sql_conn.execute("UPDATE entities SET community_L0 = 7 WHERE id = 'existing'")
    store.sql_conn.execute("UPDATE entities SET community_L0 = 99 WHERE id = 'isolated'")
    store.sql_conn.commit()

    strategy = DynamicFrontierLeiden()
    fake_leiden = _make_fake_leiden([0, 0])

    with patch.dict(sys.modules, {"leidenalg": fake_leiden, "igraph": _FakeIgModule()}):
        strategy.assign_communities(
            store,
            ["new"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

    rows = store.sql_conn.execute("SELECT id, community_L0 FROM entities").fetchall()
    assignments = {row[0]: row[1] for row in rows}
    assert assignments["existing"] == 7
    assert assignments["new"] == 7
    assert assignments["isolated"] == 99
    store.close()


def test_frontier_graph_excludes_non_frontier_nodes(tmp_path) -> None:
    """The frontier igraph must not include isolated/non-frontier nodes."""
    store = SQLiteStore(tmp_path / "graph.db")
    try:
        store.sql_conn.execute("ALTER TABLE entities ADD COLUMN community_L0 INTEGER")
    except sqlite3.OperationalError:
        pass

    _add_entity(store.sql_conn, "existing")
    _add_entity(store.sql_conn, "new")
    _add_entity(store.sql_conn, "isolated")

    # Only existing↔new have similarity edges; isolated has none
    _add_edge(
        store.sql_conn, "entity", "existing", "entity", "new", "ENTITY_SIMILAR",
        {"hybrid_score": 0.9},
    )

    store.sql_conn.execute("UPDATE entities SET community_L0 = 7 WHERE id = 'existing'")
    store.sql_conn.commit()

    strategy = DynamicFrontierLeiden()
    captured_graphs: list = []

    def _find_partition(graph, _partition_type, **kwargs):
        captured_graphs.append(graph)
        return SimpleNamespace(membership=[0, 0])

    fake_leiden = SimpleNamespace(
        RBConfigurationVertexPartition=object(),
        find_partition=_find_partition,
    )

    with patch.dict(sys.modules, {"leidenalg": fake_leiden, "igraph": _FakeIgModule()}):
        strategy.assign_communities(
            store,
            ["new"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

    assert len(captured_graphs) == 1
    g = captured_graphs[0]
    assert g.vcount() == 2, f"Frontier graph should have 2 nodes, got {g.vcount()}"
    store.close()
