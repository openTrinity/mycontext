"""Integration tests for the POST /path endpoint in kl_server."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# We import the server app; the lifespan initialises state, but we bypass it
# by patching state directly after import.
from kl_server import app, state

# ── Fixture: in-memory SQLiteStore with known entities/facts/edges ────────────


def _build_fixture_store():
    """Build a minimal in-memory SQLiteStore for endpoint tests.

    Graph:
        EntityA --ABOUT--> FactAB --ABOUT--> EntityB   (2-hop)
        EntityA --ENTITY_SIMILAR--> EntityC                (1-hop, different target)
    """
    from kl_graph.storage.sqlite_store import SQLiteStore

    # Open an in-memory connection and pass it so SQLiteStore builds schema on it.
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    store = SQLiteStore(Path(":memory:"), conn=conn)

    # Insert test data directly via sql_conn (uses the full schema from SQLiteStore).
    conn = store.sql_conn
    # Entities
    conn.executemany(
        "INSERT OR IGNORE INTO entities(id, name, entity_type, mention_count) VALUES (?, ?, ?, ?)",
        [
            ("ent-a", "EntityA", "Person", 10),
            ("ent-b", "EntityB", "Project", 5),
            ("ent-c", "EntityC", "Organization", 3),
        ],
    )
    # A placeholder chunk (facts have a FK to chunks)
    conn.execute(
        "INSERT OR IGNORE INTO chunks(id, content, source_type, timestamp, metadata) "
        """VALUES ('msg-0', '', 'message', 0, '{"conversation_id": "conv-1", "sender": "system"}')"""
    )
    # Facts
    conn.execute(
        "INSERT OR IGNORE INTO facts(id, text, fact_type, timestamp, confidence, source_chunk_id) "
        "VALUES ('fact-ab', 'EntityA is related to EntityB via this fact.', 'GENERAL', 0, 0.9, 'msg-0')"
    )
    # Edges: EntityA --ABOUT--> FactAB --ABOUT--> EntityB
    conn.executemany(
        "INSERT OR IGNORE INTO edges(source_type, source_id, target_type, target_id, edge_type, properties) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            ("entity", "ent-a", "fact", "fact-ab", "ABOUT", None),
            ("fact", "fact-ab", "entity", "ent-b", "ABOUT", None),
            ("entity", "ent-a", "entity", "ent-c", "ENTITY_SIMILAR", json.dumps({"confidence": 0.95})),
        ],
    )
    conn.commit()

    return store


@pytest.fixture(autouse=True)
def _patch_server_state():
    """Replace server state with a warm fixture state for all tests in this module."""
    fixture_store = _build_fixture_store()

    # Save originals
    orig_conn = state.sqlite_conn
    orig_ready = state.ready
    orig_store = state.store

    # Patch state — expose the store's underlying connection as sqlite_conn so that
    # any endpoint which reads state.sqlite_conn also uses the fixture data.
    state.sqlite_conn = fixture_store.conn
    state.ready = True
    state.store = fixture_store

    yield

    # Restore originals
    state.sqlite_conn = orig_conn
    state.ready = orig_ready
    state.store = orig_store
    fixture_store.close()


@pytest.fixture()
def client() -> TestClient:
    """Return a TestClient that does NOT run the lifespan (state is already patched)."""
    # Use TestClient with lifespan disabled (app state already patched above)
    return TestClient(app, raise_server_exceptions=True)


# ── Successful path ────────────────────────────────────────────────────────────


def test_path_found_by_name(client: TestClient) -> None:
    """Finding a path using entity names returns structured response."""
    r = client.post("/path", json={"source": "EntityA", "target": "EntityB"})
    assert r.status_code == 200
    data = r.json()
    assert data["exhausted"] is False
    assert data["path_count"] >= 1
    paths = data["paths"]
    assert len(paths) >= 1
    assert paths[0]["hop_count"] == 2


def test_path_found_by_id(client: TestClient) -> None:
    """Finding a path using entity IDs returns structured response."""
    r = client.post("/path", json={"source": "ent-a", "target": "ent-b"})
    assert r.status_code == 200
    data = r.json()
    assert data["exhausted"] is False


def test_path_found_by_substring(client: TestClient) -> None:
    """Entity resolution works via substring match."""
    r = client.post("/path", json={"source": "tityA", "target": "tityB"})
    assert r.status_code == 200
    data = r.json()
    assert data["exhausted"] is False


def test_path_response_structure(client: TestClient) -> None:
    """Response contains source, target, paths, path_count, exhausted fields."""
    r = client.post("/path", json={"source": "EntityA", "target": "EntityB"})
    data = r.json()
    assert "source" in data
    assert "target" in data
    assert "paths" in data
    assert "path_count" in data
    assert "exhausted" in data
    assert "id" in data["source"]
    assert "label" in data["source"]
    assert "id" in data["target"]
    assert "label" in data["target"]


def test_path_nodes_have_labels(client: TestClient) -> None:
    """Path nodes have resolved labels (not just bare IDs)."""
    r = client.post("/path", json={"source": "EntityA", "target": "EntityB"})
    data = r.json()
    p = data["paths"][0]
    for node in p["nodes"]:
        assert node["label"] != ""
        assert "id" in node
        assert "type" in node


def test_path_edges_have_type_and_direction(client: TestClient) -> None:
    """Path edges contain edge_type and direction."""
    r = client.post("/path", json={"source": "EntityA", "target": "EntityB"})
    data = r.json()
    p = data["paths"][0]
    for edge in p["edges"]:
        assert "edge_type" in edge
        assert "direction" in edge
        assert "source_id" in edge
        assert "target_id" in edge


# ── No path found (exhausted) ─────────────────────────────────────────────────


def test_path_exhausted_returns_empty_paths(client: TestClient) -> None:
    """When no path exists within max_hops, exhausted=True and paths=[]."""
    r = client.post(
        "/path",
        json={"source": "EntityA", "target": "EntityB", "max_hops": 1},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["exhausted"] is True
    assert data["path_count"] == 0
    assert data["paths"] == []


# ── Entity not found (404) ────────────────────────────────────────────────────


def test_source_not_found_returns_404(client: TestClient) -> None:
    """Returns 404 when source entity cannot be resolved."""
    r = client.post(
        "/path",
        json={"source": "NonExistentEntity_XYZ", "target": "EntityB"},
    )
    assert r.status_code == 404
    assert "NonExistentEntity_XYZ" in r.json()["detail"]


def test_target_not_found_returns_404(client: TestClient) -> None:
    """Returns 404 when target entity cannot be resolved."""
    r = client.post(
        "/path",
        json={"source": "EntityA", "target": "NonExistentTarget_XYZ"},
    )
    assert r.status_code == 404
    assert "NonExistentTarget_XYZ" in r.json()["detail"]


# ── Server not ready (503) ────────────────────────────────────────────────────


def test_server_not_ready_returns_503(client: TestClient) -> None:
    """Returns 503 when server is not yet ready."""
    state.ready = False
    try:
        r = client.post("/path", json={"source": "EntityA", "target": "EntityB"})
        assert r.status_code == 503
    finally:
        state.ready = True


# ── All paths mode ────────────────────────────────────────────────────────────


def test_path_all_paths_mode(client: TestClient) -> None:
    """all_paths=True returns all shortest paths."""
    r = client.post(
        "/path",
        json={"source": "EntityA", "target": "EntityB", "all_paths": True},
    )
    assert r.status_code == 200
    data = r.json()
    assert not data["exhausted"]
    # In our fixture there's only one 2-hop path, so exactly 1
    assert data["path_count"] == 1


# ── Edge type filtering ───────────────────────────────────────────────────────


def test_path_edge_type_filter(client: TestClient) -> None:
    """Filtering to ABOUT edge type finds the 2-hop path via FactAB."""
    r = client.post(
        "/path",
        json={
            "source": "EntityA",
            "target": "EntityB",
            "edge_types": ["ABOUT"],
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert not data["exhausted"]
    for p in data["paths"]:
        for e in p["edges"]:
            assert e["edge_type"] == "ABOUT"


def test_path_wrong_edge_type_filter_exhausted(client: TestClient) -> None:
    """Filtering to an edge type absent from the graph returns exhausted."""
    r = client.post(
        "/path",
        json={
            "source": "EntityA",
            "target": "EntityB",
            "edge_types": ["FACT_SIMILAR"],
        },
    )
    assert r.status_code == 200
    assert r.json()["exhausted"] is True


# ── Source label in response ──────────────────────────────────────────────────


def test_source_and_target_labels_resolved(client: TestClient) -> None:
    """source.label and target.label are human-readable entity names."""
    r = client.post("/path", json={"source": "EntityA", "target": "EntityB"})
    data = r.json()
    assert data["source"]["label"] == "EntityA"
    assert data["target"]["label"] == "EntityB"


# ── graph_db unavailable ──────────────────────────────────────────────────────


def test_graph_db_none_returns_503(client: TestClient) -> None:
    """Returns 503 when store is not initialized."""
    orig = state.store
    state.store = None
    try:
        r = client.post("/path", json={"source": "EntityA", "target": "EntityB"})
        assert r.status_code == 503
    finally:
        state.store = orig
