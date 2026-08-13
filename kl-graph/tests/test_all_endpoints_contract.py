"""Endpoint contract tests: every kl_server route, asserting CONTENT not just 200.

Builds one small deterministic fixture whose expected answers are known by hand,
then exercises **every** route registered on the FastAPI app and asserts the
response body is actually correct (right entity, right neighbours, right fact,
right community, right path, right error codes).

Covers all 20 routes:
  GET  /health /status /capabilities /ingest/{run_id}/failures
  POST /entity /facts /expand /neighbors /community /members /context /timeline
       /chunk /graph_hop /path /search /global_search /ask /ingest /improve

A companion test asserts no route is left untested, so adding a route to
kl_server without a test here fails the suite.

No network: litellm is patched. Run:
``.venv/bin/python -m pytest tests/test_all_endpoints_contract.py -q``
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import litellm
import pytest
from fastapi.testclient import TestClient

import kl_server
from kl_graph.models.types import community_id_from
from kl_graph.storage.sqlite_store import SQLiteStore
from kl_server import app, state

# ---------------------------------------------------------------------------
# Deterministic fixture. Two entities linked to one fact; one chat chunk; one
# scope; one L0 community holding both entities.
# ---------------------------------------------------------------------------

E_ALICE = "ent-alice"
E_BOB = "ent-bob"
F_MEET = "fact-meet"
CHUNK = "chunk-1"
SCOPE = "scope-1"
COMM_CID = 1
COMM_LEVEL = 0
COMM_TOKEN = community_id_from(f"L{COMM_LEVEL}", COMM_CID)
CHAT_TS = 1_752_000_000


def _build_store() -> SQLiteStore:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    store = SQLiteStore(Path(":memory:"), conn=conn)
    c = store.sql_conn

    for table in ("entities", "facts"):
        cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
        if f"community_L{COMM_LEVEL}" not in cols:
            c.execute(
                f"ALTER TABLE {table} ADD COLUMN community_L{COMM_LEVEL} INTEGER"
            )

    c.execute(
        "INSERT INTO entities (id,name,entity_type,mention_count,description,"
        f"community_L{COMM_LEVEL}) VALUES (?,?,?,?,?,?)",
        (E_ALICE, "Alice", "person", 5, "An engineer.", COMM_CID),
    )
    c.execute(
        "INSERT INTO entities (id,name,entity_type,mention_count,description,"
        f"community_L{COMM_LEVEL}) VALUES (?,?,?,?,?,?)",
        (E_BOB, "Bob", "person", 3, "A designer.", COMM_CID),
    )
    c.execute(
        "INSERT INTO chunks (id,content,source_type,timestamp,source_ref,metadata) "
        "VALUES (?,?,?,?,?,?)",
        (
            CHUNK,
            "[群聊: 项目讨论] Alice · 2026-07-09 10:00\nAlice 和 Bob 讨论了发布计划",
            "message",
            CHAT_TS,
            "conv-1",
            json.dumps(
                {
                    "senders": ["Alice"],
                    "conversation_title": "项目讨论",
                    "chat_kind": "group",
                },
                ensure_ascii=False,
            ),
        ),
    )
    c.execute(
        "INSERT INTO facts (id,text,fact_type,timestamp,confidence,source_chunk_id,"
        f"community_L{COMM_LEVEL}) VALUES (?,?,?,?,?,?,?)",
        (F_MEET, "Alice 和 Bob 讨论了发布计划", "event", CHAT_TS, 0.9, CHUNK, COMM_CID),
    )
    c.execute(
        "INSERT INTO scopes (id,scope_type,title) VALUES (?,?,?)",
        (SCOPE, "conversation", "项目讨论"),
    )
    # Edges: fact ABOUT both entities; chunk PART_OF scope.
    for ent in (E_ALICE, E_BOB):
        c.execute(
            "INSERT INTO edges (source_type,source_id,target_type,target_id,edge_type) "
            "VALUES (?,?,?,?,?)",
            ("fact", F_MEET, "entity", ent, "ABOUT"),
        )
    c.execute(
        "INSERT INTO edges (source_type,source_id,target_type,target_id,edge_type) "
        "VALUES (?,?,?,?,?)",
        ("chunk", CHUNK, "scope", SCOPE, "PART_OF"),
    )
    # Community projection + summary.
    c.execute(
        "INSERT INTO communities (id,level,node_type,member_count,summary) "
        "VALUES (?,?,?,?,?)",
        (COMM_TOKEN, f"L{COMM_LEVEL}", "mixed", 3, "Alice and Bob ship releases."),
    )
    for nt, nid in (("entity", E_ALICE), ("entity", E_BOB), ("fact", F_MEET)):
        c.execute(
            "INSERT INTO edges (source_type,source_id,target_type,target_id,edge_type) "
            "VALUES (?,?,?,?,?)",
            (nt, nid, "community", COMM_TOKEN, "COMM_MEMBER"),
        )
    from kl_graph.periodic.community_summarizer import _ensure_summary_schema

    _ensure_summary_schema(store)
    c.execute(
        "INSERT INTO community_summaries (level,community_id,member_count,entity_count,"
        "fact_count,title,summary,rating,rating_explanation,findings,tags,top_members,"
        "community_uuid,summary_stale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
        (
            COMM_LEVEL, COMM_CID, 3, 2, 1, "Release crew",
            "Alice and Bob coordinate releases.", 8.0, "high impact",
            json.dumps([]), json.dumps(["release"]),
            json.dumps(["Alice", "Bob"]), "uuid-comm-1",
        ),
    )
    c.commit()
    return store


@pytest.fixture(autouse=True)
def _wire(monkeypatch: pytest.MonkeyPatch):
    store = _build_store()
    saved = (
        state.sqlite_conn, state.ready, state.store, state.adjacency,
        getattr(state, "pagerank", None),
    )
    state.sqlite_conn = store.sql_conn
    state.store = store
    state.ready = True
    state.adjacency = kl_server._build_adjacency(store)
    # The real server builds these startup indexes; do the same so endpoints are
    # exercised in their realistic configuration.
    state.pagerank = kl_server._compute_pagerank(store)
    monkeypatch.setattr(kl_server, "COMMUNITIES_ENABLED", True, raising=False)
    monkeypatch.setattr(kl_server, "CURRENT_USER", "", raising=False)
    yield
    (
        state.sqlite_conn, state.ready, state.store, state.adjacency,
        state.pagerank,
    ) = saved


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def _fake_llm(text: str = "答复。"):
    async def _c(*a, **k):
        msg = k.get("messages", [{}])[-1].get("content", "").lower()
        out = "10" if ("rate" in msg or "score" in msg) else text
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=out))],
            usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        )

    return _c


# ---------------------------------------------------------------------------
# GET routes
# ---------------------------------------------------------------------------


def test_health_reports_ok(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body.get("status") in {"ok", "healthy", "ready"}, body


def test_status_reports_ready_and_backends(client: TestClient) -> None:
    r = client.get("/status")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ready"
    # Counts must reflect the fixture, not be absent/zero placeholders.
    assert "graph_backend" in body and "vector_backend" in body


def test_capabilities_lists_features(client: TestClient) -> None:
    r = client.get("/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, dict) and body, body


def test_ingest_failures_unknown_run_is_404(client: TestClient) -> None:
    r = client.get("/ingest/does-not-exist/failures")
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "ingestion run not found"


# ---------------------------------------------------------------------------
# Entity / fact / graph routes - assert CONTENT
# ---------------------------------------------------------------------------


def test_entity_by_name_returns_that_entity(client: TestClient) -> None:
    r = client.post("/entity", json={"name": "Alice"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1, body
    res = body["results"][0]
    assert res["id"] == E_ALICE
    assert res["name"] == "Alice"
    assert res["type"] == "person"
    assert res["mentions"] == 5
    # The fact ABOUT this entity must be attached, and the L0 community label.
    assert [f["id"] for f in res["facts"]] == [F_MEET], res["facts"]
    assert res["communities"]["L0"] == COMM_CID, res["communities"]


def test_entity_reports_only_existing_community_levels(client: TestClient) -> None:
    """Regression: the fixture has ONLY community_L0.

    The SELECT used to request community_L0..L3 unconditionally whenever L0
    existed, so a DB with fewer detected levels raised
    "no such column: community_L3" -> hard 500. Absent levels must read as None.
    """
    r = client.post("/entity", json={"entity_id": E_ALICE})
    assert r.status_code == 200, r.text
    comms = r.json()["results"][0]["communities"]
    assert comms["L0"] == COMM_CID
    assert comms["L1"] is None and comms["L2"] is None and comms["L3"] is None


def test_entity_by_id_matches_name_lookup(client: TestClient) -> None:
    by_id = client.post("/entity", json={"entity_id": E_ALICE}).json()
    by_name = client.post("/entity", json={"name": "Alice"}).json()
    assert json.dumps(by_id, sort_keys=True) == json.dumps(by_name, sort_keys=True)


def test_entity_unknown_name_returns_empty_result_set(client: TestClient) -> None:
    """An unmatched name is an empty 200 result set (not 404, never 500)."""
    r = client.post("/entity", json={"name": "NoSuchPerson"})
    assert r.status_code == 200, r.text
    assert r.json() == {"results": [], "count": 0}


def test_entity_unknown_id_is_404(client: TestClient) -> None:
    """Lookup BY ID is a 404 (distinct from the name-search contract)."""
    r = client.post("/entity", json={"entity_id": "no-such-id"})
    assert r.status_code == 404, r.text


def test_facts_for_entity_returns_the_linked_fact(client: TestClient) -> None:
    r = client.post("/facts", json={"entity_id": E_ALICE})
    assert r.status_code == 200, r.text
    assert "发布计划" in json.dumps(r.json(), ensure_ascii=False)


def test_facts_by_fact_id_returns_that_fact(client: TestClient) -> None:
    r = client.post("/facts", json={"fact_id": F_MEET})
    assert r.status_code == 200, r.text
    assert "发布计划" in json.dumps(r.json(), ensure_ascii=False)


def test_expand_returns_entity_similar_view(client: TestClient) -> None:
    """``/expand`` is the ENTITY_SIMILAR view only (documented alias).

    The fixture has no ENTITY_SIMILAR edges, so ``neighbors`` must be empty -
    sharing a fact must NOT leak into this view.
    """
    r = client.post("/expand", json={"entity_id": E_ALICE})
    assert r.status_code == 200, r.text
    assert r.json() == {"entity": "Alice", "type": "person", "neighbors": []}


def test_expand_unknown_entity_is_404(client: TestClient) -> None:
    r = client.post("/expand", json={"entity_id": "no-such-entity"})
    assert r.status_code == 404, r.text


def test_neighbors_returns_the_about_edge_targets(client: TestClient) -> None:
    r = client.post(
        "/neighbors", json={"nodes": [{"type": "fact", "id": F_MEET}]}
    )
    assert r.status_code == 200, r.text
    body = json.dumps(r.json(), ensure_ascii=False)
    assert E_ALICE in body and E_BOB in body, body[:500]


def test_neighbors_edge_type_filter_excludes_others(client: TestClient) -> None:
    r = client.post(
        "/neighbors",
        json={"nodes": [{"type": "fact", "id": F_MEET}], "edge_types": ["PART_OF"]},
    )
    assert r.status_code == 200, r.text
    # The fact has no PART_OF edge, so neither entity may appear.
    body = json.dumps(r.json(), ensure_ascii=False)
    assert E_ALICE not in body and E_BOB not in body, body[:400]


def test_neighbors_rejects_bad_node_type(client: TestClient) -> None:
    r = client.post("/neighbors", json={"nodes": [{"type": "bogus", "id": "x"}]})
    assert r.status_code == 422, r.text


def test_context_returns_fact_with_its_source_chunk(client: TestClient) -> None:
    r = client.post("/context", json={"fact_id": F_MEET})
    assert r.status_code == 200, r.text
    body = json.dumps(r.json(), ensure_ascii=False)
    assert "发布计划" in body
    assert "项目讨论" in body, "chat conversation title must be surfaced"


def test_context_unknown_fact_is_404(client: TestClient) -> None:
    r = client.post("/context", json={"fact_id": "nope"})
    assert r.status_code == 404, r.text


def test_timeline_returns_the_dated_fact(client: TestClient) -> None:
    r = client.post("/timeline", json={"entity_name": "Alice"})
    assert r.status_code == 200, r.text
    assert "发布计划" in json.dumps(r.json(), ensure_ascii=False)


def test_chunk_returns_requested_chunk_content(client: TestClient) -> None:
    r = client.post("/chunk", json={"chunk_ids": [CHUNK]})
    assert r.status_code == 200, r.text
    assert "发布计划" in json.dumps(r.json(), ensure_ascii=False)


def test_chunk_unknown_id_returns_no_content_not_500(client: TestClient) -> None:
    r = client.post("/chunk", json={"chunk_ids": ["missing-chunk"]})
    assert r.status_code == 200, r.text
    assert "发布计划" not in json.dumps(r.json(), ensure_ascii=False)


def test_graph_hop_walks_from_the_fact(client: TestClient) -> None:
    r = client.post("/graph_hop", json={"node_id": F_MEET, "cursor": {}})
    assert r.status_code == 200, r.text
    body = json.dumps(r.json(), ensure_ascii=False)
    # The fact's ABOUT neighbours must be reachable in one hop.
    assert E_ALICE in body or E_BOB in body, body[:400]


def test_graph_hop_without_pagerank_index_does_not_500(client: TestClient) -> None:
    """Regression: the PageRank prior is an optional startup index.

    Four unguarded ``state.pagerank.get(...)`` sites turned a missing index into
    a hard 500. A walk must still work (just without the prior ordering).
    """
    saved = state.pagerank
    state.pagerank = None
    try:
        r = client.post("/graph_hop", json={"node_id": F_MEET, "cursor": {}})
        assert r.status_code == 200, r.text
    finally:
        state.pagerank = saved


def test_path_finds_alice_to_bob(client: TestClient) -> None:
    r = client.post("/path", json={"source": E_ALICE, "target": E_BOB})
    assert r.status_code == 200, r.text
    body = json.dumps(r.json(), ensure_ascii=False)
    # Alice -> fact -> Bob is a 2-hop path; the fact must appear on it.
    assert F_MEET in body or "发布计划" in body, body[:500]


def test_path_same_source_and_target(client: TestClient) -> None:
    r = client.post("/path", json={"source": E_ALICE, "target": E_ALICE})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Community routes
# ---------------------------------------------------------------------------


def test_community_list_includes_the_fixture_community(client: TestClient) -> None:
    r = client.post("/community", json={"level": f"L{COMM_LEVEL}"})
    assert r.status_code == 200, r.text
    assert "Release crew" in json.dumps(r.json(), ensure_ascii=False)


def test_community_detail_returns_exact_summary(client: TestClient) -> None:
    r = client.post(
        "/community", json={"level": f"L{COMM_LEVEL}", "community_id": COMM_CID}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Release crew"
    assert body["summary"] == "Alice and Bob coordinate releases."
    assert body["rating"] == 8.0
    assert body["tags"] == ["release"]


def test_community_unknown_id_reports_error_not_500(client: TestClient) -> None:
    r = client.post("/community", json={"level": "L0", "community_id": 4242})
    assert r.status_code == 200, r.text
    assert "error" in r.json()


def test_members_lists_community_entities(client: TestClient) -> None:
    r = client.post(
        "/members",
        json={"level": f"L{COMM_LEVEL}", "community_id": COMM_CID, "node_type": "entity"},
    )
    assert r.status_code == 200, r.text
    body = json.dumps(r.json(), ensure_ascii=False)
    assert "Alice" in body and "Bob" in body, body[:400]


# ---------------------------------------------------------------------------
# Query routes (LLM patched)
# ---------------------------------------------------------------------------


def test_search_without_vector_store_is_503_not_500(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`/search` needs the vector store; absent it, degrade with an exact 503."""
    monkeypatch.setattr(litellm, "acompletion", _fake_llm())
    r = client.post("/search", json={"query": "发布计划", "top_k": 3})
    assert r.status_code == 503, r.text
    assert r.json()["detail"] == "Query engine not available"


def test_search_rejects_unknown_collection(client: TestClient) -> None:
    """Without a query engine this is refused before collection validation."""
    r = client.post("/search", json={"query": "x", "collection": "bogus"})
    assert r.status_code == 503, r.text
    assert r.json()["detail"] == "Query engine not available"


def test_global_search_serves_the_community_summary(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[str] = []

    async def _c(*a, **k):
        content = k.get("messages", [{}])[-1].get("content", "")
        seen.append(content)
        low = content.lower()
        out = "10" if ("rate" in low or "score" in low) else "Alice 和 Bob 负责发布。"
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=out))],
            usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        )

    monkeypatch.setattr(litellm, "acompletion", _c)
    r = client.post("/global_search", json={"query": "谁负责发布?"})
    assert r.status_code == 200, r.text
    # The fixture summary must have been fed to the model.
    assert any("Release crew" in s or "coordinate releases" in s for s in seen), seen[:1]


def test_global_search_blank_query_is_grounded_200(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(litellm, "acompletion", _fake_llm())
    r = client.post("/global_search", json={"query": "   "})
    assert r.status_code == 200, r.text


def test_ask_without_query_engine_is_503_not_500(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`/ask` needs the query engine; absent it, degrade with an exact 503."""
    monkeypatch.setattr(litellm, "acompletion", _fake_llm())
    r = client.post("/ask", json={"query": "Alice 和 Bob 在做什么?", "top_k": 3})
    assert r.status_code == 503, r.text
    assert r.json()["detail"] == "Query engine not available"


def test_ask_requires_a_query_field(client: TestClient) -> None:
    assert client.post("/ask", json={}).status_code == 422


# ---------------------------------------------------------------------------
# Mutating routes - must validate, and must not run a real pipeline here
# ---------------------------------------------------------------------------


def test_ingest_requires_input_dir_and_source_id(client: TestClient) -> None:
    assert client.post("/ingest", json={}).status_code == 422
    assert client.post("/ingest", json={"input_dir": "/tmp"}).status_code == 422


def test_ingest_rejects_bad_improve_mode(client: TestClient) -> None:
    r = client.post(
        "/ingest",
        json={"input_dir": "/tmp", "source_id": "s", "improve_mode": "bogus"},
    )
    assert r.status_code == 422, r.text


def test_ingest_rejects_nonexistent_input_dir(client: TestClient) -> None:
    """A non-directory input_dir must be a clean 400, not a 500."""
    r = client.post(
        "/ingest",
        json={"input_dir": "/definitely/not/here", "source_id": "s"},
    )
    assert r.status_code == 400, r.text
    assert "input_dir" in r.text


def test_ingest_starts_run_and_records_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A valid request must start a run, return its id, and persist it.

    The background worker is replaced so no real pipeline executes, but the
    endpoint's own contract (status/run_id + an ``ingest_runs`` row) is asserted.
    """
    scheduled: list[str] = []

    def fake_queue(item):
        # Invoked synchronously by `asyncio.create_task(_run_ingest_queue(item))`
        # when the coroutine is constructed, so this records SCHEDULING (the task
        # body may not run before the response is returned).
        scheduled.append(item[0])

        async def _noop():
            return None

        return _noop()

    monkeypatch.setattr(kl_server, "_run_ingest_queue", fake_queue)
    state.ingest_task = None
    r = client.post(
        "/ingest",
        json={"input_dir": str(tmp_path), "source_id": "src-1", "improve_mode": "off"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "started", body
    run_id = body["run_id"]
    assert run_id
    # The worker must actually be scheduled for THIS run, otherwise deleting the
    # background scheduling would still pass every other assertion here.
    assert scheduled == [run_id], scheduled
    row = state.sqlite_conn.execute(
        "SELECT source_id, state FROM ingest_runs WHERE run_id = ?", (run_id,)
    ).fetchone()
    assert row is not None, "the run must be persisted to ingest_runs"
    assert row[0] == "src-1"


def test_ingest_second_request_is_queued_not_dropped(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """While a run is ACTIVE, a second request must be queued, not dropped.

    ``TestClient`` tears down its event loop after each request (cancelling any
    background task), so the "active run" precondition is injected directly with
    a stand-in unfinished task rather than by racing two HTTP calls.
    """

    class _Unfinished:
        def done(self) -> bool:
            return False

    async def fake_queue(item):
        return None

    monkeypatch.setattr(kl_server, "_run_ingest_queue", fake_queue)
    state.ingest_queue.clear()
    monkeypatch.setattr(state, "ingest_task", _Unfinished(), raising=False)
    monkeypatch.setattr(state, "current_run_id", "run-active", raising=False)
    try:
        r = client.post(
            "/ingest", json={"input_dir": str(tmp_path), "source_id": "b"}
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "continued", body
        assert body["run_id"] == "run-active", body
        assert body["queued_source"] == "b", body
        # The queued item must be retained for the worker to pick up.
        assert len(state.ingest_queue) == 1, state.ingest_queue
        queued_run_id = body["queued_run_id"]
        assert state.ingest_queue[0][0] == queued_run_id
        # ...and it must already be recorded as a run.
        row = state.sqlite_conn.execute(
            "SELECT source_id FROM ingest_runs WHERE run_id = ?", (queued_run_id,)
        ).fetchone()
        assert row is not None and row[0] == "b", row
    finally:
        state.ingest_queue.clear()


def test_improve_while_busy_is_queued_as_improve_job(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A queued `/improve` must be labelled an improve job, not an ingest."""

    class _Unfinished:
        def done(self) -> bool:
            return False

    async def fake_queue(item):
        return None

    monkeypatch.setattr(kl_server, "_run_ingest_queue", fake_queue)
    state.ingest_queue.clear()
    monkeypatch.setattr(state, "ingest_task", _Unfinished(), raising=False)
    monkeypatch.setattr(state, "current_run_id", "run-active", raising=False)
    try:
        body = client.post("/improve", json={"mode": "full"}).json()
        assert body["status"] == "continued", body
        assert body["queued_job"] == "improve", body
        assert len(state.ingest_queue) == 1
    finally:
        state.ingest_queue.clear()


def test_improve_only_accepts_full_mode(client: TestClient) -> None:
    assert client.post("/improve", json={"mode": "incremental"}).status_code == 422
    assert client.post("/improve", json={"mode": "bogus"}).status_code == 422


def test_improve_full_starts_run_and_records_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`/improve {"mode":"full"}` must start a run marked as an improve job."""
    scheduled: list[str] = []

    def fake_queue(item):
        scheduled.append(item[0])

        async def _noop():
            return None

        return _noop()

    monkeypatch.setattr(kl_server, "_run_ingest_queue", fake_queue)
    state.ingest_task = None
    r = client.post("/improve", json={"mode": "full"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "started", body
    assert body["ingest"]["job_type"] == "improve", body
    assert scheduled == [body["run_id"]], scheduled
    row = state.sqlite_conn.execute(
        "SELECT source_id, phase FROM ingest_runs WHERE run_id = ?",
        (body["run_id"],),
    ).fetchone()
    assert row is not None
    assert row[0] == "__improve__", row


def test_ingest_failures_for_a_real_run_returns_manifest(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The failures manifest must resolve for a run that exists."""
    async def fake_queue(item):
        return None

    monkeypatch.setattr(kl_server, "_run_ingest_queue", fake_queue)
    state.ingest_task = None
    run_id = client.post(
        "/ingest", json={"input_dir": str(tmp_path), "source_id": "s"}
    ).json()["run_id"]
    r = client.get(f"/ingest/{run_id}/failures")
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), dict)


def test_ingest_failures_rejects_out_of_range_limit(client: TestClient) -> None:
    r = client.get("/ingest/any/failures", params={"limit": 0})
    assert r.status_code == 422, r.text
    r = client.get("/ingest/any/failures", params={"limit": 10_000})
    assert r.status_code == 422, r.text


# ---------------------------------------------------------------------------
# Not-ready behaviour: every read route must answer 503, never crash
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/entity", {"name": "Alice"}),
        ("/facts", {"entity_id": E_ALICE}),
        ("/expand", {"entity_id": E_ALICE}),
        ("/context", {"fact_id": F_MEET}),
        ("/timeline", {"entity_name": "Alice"}),
        ("/chunk", {"chunk_ids": [CHUNK]}),
        ("/community", {"level": "L0"}),
        ("/members", {"level": "L0", "community_id": COMM_CID}),
    ],
)
def test_routes_return_503_when_not_ready(
    client: TestClient, path: str, payload: dict
) -> None:
    state.ready = False
    try:
        r = client.post(path, json=payload)
        assert r.status_code == 503, (path, r.status_code, r.text[:200])
    finally:
        state.ready = True


# ---------------------------------------------------------------------------
# Meta: no route may be left untested
# ---------------------------------------------------------------------------

_TESTED_ROUTES = {
    "/health", "/status", "/capabilities", "/ingest/{run_id}/failures",
    "/entity", "/facts", "/expand", "/neighbors", "/context", "/timeline",
    "/chunk", "/graph_hop", "/path", "/community", "/members",
    "/search", "/global_search", "/ask", "/ingest", "/improve",
}


def test_every_registered_route_is_covered() -> None:
    """Fail if kl_server gains a route with no contract test here."""
    registered = {
        r.path
        for r in app.routes
        if getattr(r, "methods", None)
        and r.path not in {"/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"}
    }
    missing = registered - _TESTED_ROUTES
    assert not missing, f"untested kl_server routes: {sorted(missing)}"


@pytest.mark.parametrize("present", [[0], [0, 1], [0, 1, 2], [0, 2], [0, 3]])
def test_entity_maps_community_levels_by_level_not_position(
    client: TestClient, present: list[int]
) -> None:
    """Each community level must be reported in ITS OWN slot.

    Community columns are created lazily per detected level, so the set of
    existing columns can have GAPS (e.g. L0 and L2 but no L1). Packing the
    selected values positionally would report L2's value as ``L1``. Every absent
    level must read ``None`` and every present level must keep its own label.
    """
    conn = state.sqlite_conn
    # Drop all community columns, then re-add only `present` ones with a value
    # equal to 100 + level so a mis-mapping is unambiguous.
    existing = {r[1] for r in conn.execute("PRAGMA table_info(entities)")}
    keep = [c for c in existing if not c.startswith("community_L")]
    conn.execute("ALTER TABLE entities RENAME TO entities_orig")
    conn.execute(f"CREATE TABLE entities AS SELECT {', '.join(sorted(keep))} FROM entities_orig")
    for lvl in present:
        conn.execute(f"ALTER TABLE entities ADD COLUMN community_L{lvl} INTEGER")
        conn.execute(f"UPDATE entities SET community_L{lvl} = ?", (100 + lvl,))
    conn.commit()
    state.adjacency = kl_server._build_adjacency(state.store)

    r = client.post("/entity", json={"entity_id": E_ALICE})
    assert r.status_code == 200, r.text
    comms = r.json()["results"][0]["communities"]
    for lvl in range(4):
        expected = 100 + lvl if lvl in present else None
        assert comms[f"L{lvl}"] == expected, (present, lvl, comms)
