"""Backend-neutral batch exact-neighbor API."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kl_graph.storage.sqlite_store import SQLiteStore
from kl_server import GraphHopRequest, _adjacency_buckets, app, state


@pytest.fixture()
def client():
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    store = SQLiteStore(Path(":memory:"), conn=conn)
    conn = store.sql_conn
    conn.execute(
        "INSERT INTO chunks(id, content, source_type) VALUES ('c1', '', 'message')"
    )
    conn.executemany(
        "INSERT INTO facts(id, text, source_chunk_id) VALUES (?, ?, 'c1')",
        [("f1", "fact one"), ("f2", "fact two"), ("f3", "hidden participant")],
    )
    conn.executemany(
        """INSERT INTO entities(id, name, entity_type, quality_status)
           VALUES (?, ?, ?, ?)""",
        [
            ("e1", "Alice", "Person", "active"),
            ("e2", "System X", "System", "active"),
            ("e3", "Hidden", "Unknown", "quarantined"),
        ],
    )
    conn.commit()

    original = (
        state.sqlite_conn,
        state.store,
        state.adjacency,
        state.pagerank,
        state.ready,
        state.query_sema,
    )
    state.sqlite_conn = conn
    state.store = store
    # Deliberately leave SQLite edges empty. This models the default Ladybug
    # deployment, where the serving index comes from the graph authority.
    state.adjacency = {
        "f1": (
            ("ABOUT", "e2", "entity", "out"),
            ("ABOUT", "e1", "entity", "out"),
            ("ABOUT", "e1", "entity", "out"),
        ),
        "f2": (("ABOUT", "e2", "entity", "out"),),
        "f3": (("ABOUT", "e3", "entity", "out"),),
    }
    state.pagerank = {"e1": 1.0, "e2": 0.5}
    state.ready = True
    state.query_sema = None

    try:
        yield TestClient(app, raise_server_exceptions=True)
    finally:
        (
            state.sqlite_conn,
            state.store,
            state.adjacency,
            state.pagerank,
            state.ready,
            state.query_sema,
        ) = original
        store.close()


def _request(nodes: list[dict], **overrides) -> dict:
    return {
        "nodes": nodes,
        "edge_types": ["ABOUT"],
        "direction": "out",
        "target_types": ["entity"],
        **overrides,
    }


def test_adjacency_cache_indexes_every_edge_endpoint():
    adjacency = _adjacency_buckets(
        [
            ("fact", "f1", "fact", "f2", "FACT_SIMILAR"),
            ("chunk", "c1", "scope", "s1", "PART_OF"),
        ]
    )
    assert adjacency["f1"] == [("FACT_SIMILAR", "f2", "fact", "out")]
    assert adjacency["f2"] == [("FACT_SIMILAR", "f1", "fact", "in")]
    assert adjacency["s1"] == [("PART_OF", "c1", "chunk", "in")]


def test_neighbors_is_input_aligned_filtered_and_backend_neutral(client: TestClient):
    response = client.post(
        "/neighbors",
        json=_request(
            [
                {"type": "fact", "id": "fact:f1"},
                {"type": "fact", "id": "f2"},
                {"type": "fact", "id": "missing"},
                {"type": "fact", "id": "f1"},
                {"type": "fact", "id": "f3"},
            ]
        ),
    )
    assert response.status_code == 200
    data = response.json()
    assert data["count"] == 5
    assert [item["found"] for item in data["results"]] == [
        True,
        True,
        False,
        True,
        True,
    ]
    assert [edge["node"]["id"] for edge in data["results"][0]["edges"]] == [
        "e1",
        "e2",
    ]
    assert data["results"][1]["edges"][0]["node"]["name"] == "System X"
    assert data["results"][2]["edges"] == []
    assert data["results"][3]["edges"] == data["results"][0]["edges"]
    assert data["results"][4]["edges"] == []
    assert state.sqlite_conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0] == 0


def test_neighbors_paginates_without_restarting_exhausted_nodes(client: TestClient):
    body = _request(
        [{"type": "fact", "id": "f1"}, {"type": "fact", "id": "f2"}],
        limit_per_node=1,
    )
    first = client.post("/neighbors", json=body).json()
    assert [edge["node"]["id"] for edge in first["results"][0]["edges"]] == ["e1"]
    assert first["results"][0]["has_more"] is True
    assert first["results"][1]["has_more"] is False

    second = client.post(
        "/neighbors", json={**body, "cursor": first["cursor"]}
    ).json()
    assert [edge["node"]["id"] for edge in second["results"][0]["edges"]] == ["e2"]
    assert second["results"][1]["edges"] == []
    assert second["has_more"] is False

    exhausted = client.post(
        "/neighbors", json={**body, "cursor": second["cursor"]}
    ).json()
    assert all(not result["edges"] for result in exhausted["results"])


def test_neighbors_can_skip_hydrated_payloads(client: TestClient):
    data = client.post(
        "/neighbors",
        json=_request([{"type": "fact", "id": "f1"}], hydrate=False),
    ).json()
    assert data["results"][0]["node"] == {"type": "fact", "id": "f1"}
    assert data["results"][0]["edges"][0]["node"] == {
        "type": "entity",
        "id": "e1",
    }


def test_neighbors_empty_batch(client: TestClient):
    response = client.post("/neighbors", json={"nodes": []})
    assert response.status_code == 200
    assert response.json() == {
        "results": [],
        "count": 0,
        "cursor": {},
        "has_more": False,
    }


def test_graph_hop_cursor_defaults_to_empty_object(client: TestClient):
    assert GraphHopRequest(node_id="fact:f1").cursor == {}
    response = client.post("/graph_hop", json={"node_id": "fact:f1"})
    assert response.status_code == 200
    assert response.json()["node_id"] == "fact:f1"
