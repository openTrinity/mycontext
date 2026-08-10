"""Serving-index finalization updates only committed graph deltas."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import kl_server
from kl_graph.ingest.runner import ServingIndexUpdate
from kl_graph.models.types import Edge, EdgeType
from kl_graph.storage.sqlite_store import SQLiteStore


def _edge(
    source_type: str,
    source_id: str,
    target_type: str,
    target_id: str,
    edge_type: EdgeType,
) -> Edge:
    return Edge(
        source_type=source_type,
        source_id=source_id,
        target_type=target_type,
        target_id=target_id,
        edge_type=edge_type,
    )


def test_incremental_adjacency_reconciles_inserts_and_membership_deletes(
    tmp_path, monkeypatch,
) -> None:
    monkeypatch.setattr(kl_server, "COMMUNITIES_ENABLED", True)
    store = SQLiteStore(tmp_path / "graph.db")
    store.insert_edges(
        [
            _edge("chunk", "untouched", "entity", "e0", EdgeType.MENTIONS),
            _edge("entity", "e1", "community", "old", EdgeType.COMM_MEMBER),
        ]
    )
    original = kl_server._build_adjacency(store)

    store.insert_edges(
        [
            _edge("chunk", "new", "entity", "e1", EdgeType.MENTIONS),
            _edge("entity", "e1", "community", "new-comm", EdgeType.COMM_MEMBER),
        ]
    )
    store.delete_edges(edge_type="COMM_MEMBER", target_id="old")

    refreshed = kl_server._incremental_adjacency(
        store,
        original,
        ServingIndexUpdate(
            structural_nodes=(("chunk", "new"),),
            community_ids=("old", "new-comm"),
        ),
    )

    assert "old" not in refreshed
    assert ("COMM_MEMBER", "old", "community", "out") not in refreshed["e1"]
    assert ("COMM_MEMBER", "new-comm", "community", "out") in refreshed["e1"]
    assert ("MENTIONS", "e1", "entity", "out") in refreshed["new"]
    assert ("MENTIONS", "new", "chunk", "in") in refreshed["e1"]
    rebuilt = kl_server._build_adjacency(store)
    for node_id in ("old", "new-comm", "new", "e1"):
        assert refreshed.get(node_id, ()) == rebuilt.get(node_id, ())
    # Published immutable buckets outside the dirty shards remain reusable.
    assert refreshed["untouched"] is original["untouched"]
    store.close()


def test_disabled_communities_are_hidden_without_deleting_edges(
    tmp_path, monkeypatch,
) -> None:
    monkeypatch.setattr(kl_server, "COMMUNITIES_ENABLED", False)
    store = SQLiteStore(tmp_path / "graph.db")
    store.insert_edges(
        [_edge("entity", "e1", "community", "retained", EdgeType.COMM_MEMBER)]
    )

    adjacency = kl_server._build_adjacency(store)

    assert "e1" not in adjacency
    assert "retained" not in adjacency
    assert any(
        edge[4] == "COMM_MEMBER" for edge in store.scan_entity_edges()
    )
    store.close()


def test_hot_swap_reuses_pagerank_when_only_adjacency_changed(monkeypatch) -> None:
    server_state = kl_server.ServerState()
    server_state.store = MagicMock()
    server_state.adjacency = kl_server.AdjacencyIndex.from_mapping({"e1": ()})
    server_state.pagerank = {"e1": 0.75}
    server_state.engine = SimpleNamespace(pagerank=server_state.pagerank)
    server_state.qdrant_communities = object()
    monkeypatch.setattr(kl_server, "state", server_state)

    incremental = MagicMock(return_value=server_state.adjacency)
    compute_pagerank = MagicMock(return_value={"e1": 1.0})
    monkeypatch.setattr(kl_server, "_incremental_adjacency", incremental)
    monkeypatch.setattr(kl_server, "_compute_pagerank", compute_pagerank)

    kl_server._hot_swap_graph(ServingIndexUpdate(structural_nodes=(("chunk", "c1"),)))

    incremental.assert_called_once()
    compute_pagerank.assert_not_called()
    assert server_state.pagerank == {"e1": 0.75}
    assert server_state.engine.pagerank is server_state.pagerank


def test_hot_swap_refreshes_pagerank_when_about_inputs_are_dirty(monkeypatch) -> None:
    server_state = kl_server.ServerState()
    server_state.store = MagicMock()
    server_state.adjacency = kl_server.AdjacencyIndex()
    server_state.pagerank = {"old": 1.0}
    server_state.engine = SimpleNamespace(pagerank=server_state.pagerank)
    server_state.qdrant_communities = object()
    monkeypatch.setattr(kl_server, "state", server_state)
    compute_pagerank = MagicMock(return_value={"new": 1.0})
    monkeypatch.setattr(kl_server, "_compute_pagerank", compute_pagerank)

    kl_server._hot_swap_graph(ServingIndexUpdate(pagerank_dirty=True))

    compute_pagerank.assert_called_once_with(server_state.store)
    assert server_state.pagerank == {"new": 1.0}
    assert server_state.engine.pagerank is server_state.pagerank
