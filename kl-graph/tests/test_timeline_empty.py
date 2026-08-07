"""`/timeline` missing-entity convention: empty-200, not 404.

Maintainer decision: name-**search** endpoints treat a zero-hit search as a
successful empty result (like `/entity`), not a missing resource. `/timeline`
used to raise 404 when no entity matched the name; it now returns 200 with a
null ``entity`` and an empty ``facts`` list. Id-addressed endpoints (`/expand`,
`/facts`, `/path`) keep their 404-on-missing-id behaviour and are unaffected.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kl_server import app, state


def _build_fixture_store():
    """In-memory SQLiteStore with a single entity + one fact ABOUT it."""
    from kl_graph.storage.sqlite_store import SQLiteStore

    conn = sqlite3.connect(":memory:", check_same_thread=False)
    store = SQLiteStore(Path(":memory:"), conn=conn)
    conn = store.sql_conn
    conn.execute(
        "INSERT OR IGNORE INTO entities(id, name, entity_type, mention_count) "
        "VALUES ('ent-a', '悟空', 'Person', 3)"
    )
    conn.execute(
        "INSERT OR IGNORE INTO chunks(id, content, source_type, timestamp, metadata) "
        "VALUES ('msg-0', '', 'message', 1000, '{}')"
    )
    conn.execute(
        "INSERT OR IGNORE INTO facts(id, text, fact_type, timestamp, confidence, source_chunk_id) "
        "VALUES ('fact-1', '悟空负责沙箱', 'GENERAL', 1000, 0.9, 'msg-0')"
    )
    conn.execute(
        "INSERT OR IGNORE INTO edges(source_type, source_id, target_type, target_id, edge_type, properties) "
        "VALUES ('fact', 'fact-1', 'entity', 'ent-a', 'ABOUT', NULL)"
    )
    conn.commit()
    return store


@pytest.fixture(autouse=True)
def _patch_server_state():
    fixture_store = _build_fixture_store()
    orig_conn = state.sqlite_conn
    orig_ready = state.ready
    orig_store = state.store
    orig_adj = state.adjacency

    state.sqlite_conn = fixture_store.conn
    state.ready = True
    state.store = fixture_store
    # Adjacency: entity ent-a has one incoming ABOUT edge from fact-1.
    state.adjacency = {"ent-a": [("ABOUT", "fact-1", "fact", "in")]}

    yield

    state.sqlite_conn = orig_conn
    state.ready = orig_ready
    state.store = orig_store
    state.adjacency = orig_adj
    fixture_store.close()


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=True)


def test_timeline_missing_entity_returns_empty_200(client: TestClient) -> None:
    """No entity matches the name -> 200 with null entity + empty facts (not 404)."""
    r = client.post("/timeline", json={"entity_name": "不存在的实体"})
    assert r.status_code == 200
    data = r.json()
    assert data["entity"] is None
    assert data["entity_id"] is None
    assert data["facts"] == []
    assert data["degree"] == 0
    assert data["auto_filtered"] is False


def test_timeline_present_entity_returns_facts(client: TestClient) -> None:
    """A matching entity still returns its populated timeline (regression guard)."""
    r = client.post("/timeline", json={"entity_name": "悟空"})
    assert r.status_code == 200
    data = r.json()
    assert data["entity"] == "悟空"
    assert data["entity_id"] == "ent-a"
    assert [f["id"] for f in data["facts"]] == ["fact-1"]
