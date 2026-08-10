"""`/entity` id-or-name + `/facts` fact-id, and the deprecated `/expand` alias.

These endpoints were extended so callers can pivot purely on ids returned by
other endpoints (``/ask`` graph nodes, ``/search`` hits) instead of round-
tripping through fuzzy name search:

- ``/entity`` now accepts ``entity_id`` (exact, then ``id LIKE '<prefix>%'``) in
  addition to ``name``, and folds the ENTITY_SIMILAR neighbours that ``/expand``
  used to return into each result as ``similar`` (unless ``include_similar`` is
  false).
- ``/expand`` is retained only as a thin backward-compatible alias returning the
  legacy ``{entity, type, neighbors}`` shape; it must stay in parity with
  ``/entity``'s ``similar`` block.
- ``/facts`` now accepts ``fact_id`` (exact, then prefix) for a single fact with
  a deliberately minimal payload (use ``/context`` for full provenance).

Both extended endpoints require *exactly one* selector and 400 otherwise.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kl_server import app, state


def _build_fixture_store():
    """In-memory store: two entities (one ENTITY_SIMILAR pair) + one fact."""
    from kl_graph.storage.sqlite_store import SQLiteStore

    conn = sqlite3.connect(":memory:", check_same_thread=False)
    store = SQLiteStore(Path(":memory:"), conn=conn)
    conn = store.sql_conn
    conn.execute(
        "INSERT OR IGNORE INTO entities(id, name, entity_type, mention_count) "
        "VALUES ('ent-aaaa1111', '悟空', 'Person', 5)"
    )
    conn.execute(
        "INSERT OR IGNORE INTO entities(id, name, entity_type, mention_count) "
        "VALUES ('ent-bbbb2222', '悟空团队', 'Organization', 2)"
    )
    conn.execute(
        "INSERT OR IGNORE INTO chunks(id, content, source_type, timestamp, metadata) "
        "VALUES ('msg-0', '', 'message', 1000, '{}')"
    )
    conn.execute(
        "INSERT OR IGNORE INTO facts(id, text, fact_type, timestamp, confidence, source_chunk_id) "
        "VALUES ('fact-1111aaaa', '悟空负责沙箱', 'GENERAL', 1000, 0.9, 'msg-0')"
    )
    conn.execute(
        "INSERT OR IGNORE INTO edges(source_type, source_id, target_type, target_id, edge_type, properties) "
        "VALUES ('fact', 'fact-1111aaaa', 'entity', 'ent-aaaa1111', 'ABOUT', NULL)"
    )
    conn.execute(
        "INSERT OR IGNORE INTO edges(source_type, source_id, target_type, target_id, edge_type, properties) "
        "VALUES ('entity', 'ent-aaaa1111', 'entity', 'ent-bbbb2222', 'ENTITY_SIMILAR', NULL)"
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
    # ent-a: one incoming ABOUT fact + one ENTITY_SIMILAR neighbour (ent-b).
    state.adjacency = {
        "ent-aaaa1111": [
            ("ABOUT", "fact-1111aaaa", "fact", "in"),
            ("ENTITY_SIMILAR", "ent-bbbb2222", "entity", "out"),
        ],
        "ent-bbbb2222": [
            ("ENTITY_SIMILAR", "ent-aaaa1111", "entity", "in"),
        ],
    }

    yield

    state.sqlite_conn = orig_conn
    state.ready = orig_ready
    state.store = orig_store
    state.adjacency = orig_adj
    fixture_store.close()


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=True)


# --------------------------------------------------------------------------- #
# /entity                                                                     #
# --------------------------------------------------------------------------- #
def test_entity_by_name_includes_similar(client: TestClient) -> None:
    """Name search still works and now carries a ``similar`` list per result."""
    r = client.post("/entity", json={"name": "悟空"})
    assert r.status_code == 200
    data = r.json()
    # Both '悟空' and '悟空团队' match the substring.
    names = {x["name"] for x in data["results"]}
    assert {"悟空", "悟空团队"} <= names
    hit = next(x for x in data["results"] if x["id"] == "ent-aaaa1111")
    assert [s["id"] for s in hit["similar"]] == ["ent-bbbb2222"]
    assert [f["id"] for f in hit["facts"]] == ["fact-1111aaaa"]


def test_entity_by_id_exact(client: TestClient) -> None:
    """Exact id returns exactly that entity."""
    r = client.post("/entity", json={"entity_id": "ent-aaaa1111"})
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 1
    assert data["results"][0]["name"] == "悟空"
    assert [s["id"] for s in data["results"][0]["similar"]] == ["ent-bbbb2222"]


def test_entity_by_id_prefix(client: TestClient) -> None:
    """A prefix falls back to ``id LIKE '<prefix>%'`` (like ``/context``)."""
    r = client.post("/entity", json={"entity_id": "ent-aaaa"})
    assert r.status_code == 200
    assert r.json()["results"][0]["id"] == "ent-aaaa1111"


def test_entity_include_similar_false(client: TestClient) -> None:
    """``include_similar=false`` omits the ``similar`` key entirely."""
    r = client.post(
        "/entity", json={"entity_id": "ent-aaaa1111", "include_similar": False}
    )
    assert r.status_code == 200
    assert "similar" not in r.json()["results"][0]


def test_entity_requires_exactly_one_selector(client: TestClient) -> None:
    assert client.post("/entity", json={}).status_code == 400
    assert (
        client.post(
            "/entity", json={"name": "悟空", "entity_id": "ent-aaaa1111"}
        ).status_code
        == 400
    )


def test_entity_unknown_id_404(client: TestClient) -> None:
    assert client.post("/entity", json={"entity_id": "nope-zzzz"}).status_code == 404


# --------------------------------------------------------------------------- #
# /expand (deprecated alias)                                                  #
# --------------------------------------------------------------------------- #
def test_expand_alias_matches_entity_similar(client: TestClient) -> None:
    """``/expand`` keeps its legacy shape and mirrors ``/entity``'s ``similar``."""
    exp = client.post("/expand", json={"entity_id": "ent-aaaa1111"})
    assert exp.status_code == 200
    exp_data = exp.json()
    assert set(exp_data) == {"entity", "type", "neighbors"}
    assert exp_data["entity"] == "悟空"

    ent = client.post("/entity", json={"entity_id": "ent-aaaa1111"})
    similar = ent.json()["results"][0]["similar"]
    assert [n["id"] for n in exp_data["neighbors"]] == [s["id"] for s in similar]


def test_expand_unknown_id_404(client: TestClient) -> None:
    assert client.post("/expand", json={"entity_id": "nope-zzzz"}).status_code == 404


# --------------------------------------------------------------------------- #
# /facts                                                                      #
# --------------------------------------------------------------------------- #
def test_facts_by_entity_id(client: TestClient) -> None:
    """Entity path unchanged: facts ABOUT the entity, entity fields populated."""
    r = client.post("/facts", json={"entity_id": "ent-aaaa1111"})
    assert r.status_code == 200
    data = r.json()
    assert data["entity"] == "悟空"
    assert data["entity_id"] == "ent-aaaa1111"
    assert [f["id"] for f in data["facts"]] == ["fact-1111aaaa"]


def test_facts_by_fact_id_exact_minimal(client: TestClient) -> None:
    """Fact path returns the single fact with a minimal, entity-less payload."""
    r = client.post("/facts", json={"fact_id": "fact-1111aaaa"})
    assert r.status_code == 200
    data = r.json()
    assert data["entity"] is None
    assert data["entity_id"] is None
    assert data["fact_id"] == "fact-1111aaaa"
    assert [f["id"] for f in data["facts"]] == ["fact-1111aaaa"]
    assert data["facts"][0]["text"] == "悟空负责沙箱"


def test_facts_by_fact_id_prefix(client: TestClient) -> None:
    r = client.post("/facts", json={"fact_id": "fact-1111"})
    assert r.status_code == 200
    assert r.json()["facts"][0]["id"] == "fact-1111aaaa"


def test_facts_requires_exactly_one_selector(client: TestClient) -> None:
    assert client.post("/facts", json={}).status_code == 400
    assert (
        client.post(
            "/facts", json={"entity_id": "ent-aaaa1111", "fact_id": "fact-1111aaaa"}
        ).status_code
        == 400
    )


def test_facts_unknown_fact_id_404(client: TestClient) -> None:
    assert client.post("/facts", json={"fact_id": "nope-zzzz"}).status_code == 404
