"""Integration tests for POST /global_search (kl_server).

Covers the corpus-wide U2 contract after the migration to hierarchical
communities + rate-then-descend global search:

- selection is query-driven over ALL community summaries (no identity gating);
  the request ``user`` field is accepted-but-ignored for response-shape
  stability;
- every miss is a grounded HTTP 200 no-data answer with ZERO LLM calls
  (never 404, never 500);
- graceful degradation when the improve pipeline has not run (no
  ``community_summaries`` table);
- blank queries and early SQLite failures degrade to grounded 200 responses;
- happy rate-then-descend → map-reduce pass-through (answer, citations,
  communities, diagnostics) with a scripted ``litellm.acompletion`` stand-in;
- [!RED R4]: transport/LLM failures stay VISIBLE in diagnostics and never
  silently turn into a fabricated answer.

No network: ``litellm.acompletion`` is monkeypatched. Run:
``.venv/bin/python -m pytest tests/test_global_search_server.py -q``
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
from kl_graph.models.types import Community, community_id_from
from kl_server import app, state


def _build_fixture_store():
    """In-memory SQLiteStore with a small hierarchical community set.

    Two level-0 root communities and one level-1 child (parent = L0/9), stored
    in the new integer-level ``community_summaries`` schema plus matching
    reified ``communities`` rows (with parent links) so rate-then-descend can
    enumerate levels and descend through the hierarchy.
    """
    from kl_graph.storage.sqlite_store import SQLiteStore

    conn = sqlite3.connect(":memory:", check_same_thread=False)
    store = SQLiteStore(Path(":memory:"), conn=conn)
    conn = store.conn

    store.store_community_summaries(
        [
            {
                "level": 0,
                "community_id": 9,
                "member_count": 10,
                "entity_count": 6,
                "fact_count": 4,
                "title": "数据同步项目",
                "summary": "Alice 负责数据同步项目，推进评审与整改。",
                "rating": 8.0,
                "rating_explanation": "high impact",
                "findings": "[]",
                "tags": "[]",
                "top_members": "[]",
            },
            {
                "level": 0,
                "community_id": 7,
                "member_count": 8,
                "entity_count": 5,
                "fact_count": 3,
                "title": "无关主题",
                "summary": "与查询无关的另一个社区。",
                "rating": 3.0,
                "rating_explanation": "low",
                "findings": "[]",
                "tags": "[]",
                "top_members": "[]",
            },
            {
                "level": 1,
                "community_id": 3,
                "member_count": 5,
                "entity_count": 3,
                "fact_count": 2,
                "title": "vLLM 部署",
                "summary": "Alice 在部署 vLLM 嵌入服务。",
                "rating": 7.0,
                "rating_explanation": "impactful",
                "findings": "[]",
                "tags": "[]",
                "top_members": "[]",
            },
        ]
    )
    # Reified community rows with native parent links: L1/3 is a child of L0/9.
    store.insert_communities(
        [
            Community(
                id=community_id_from("L0", 9),
                level="L0",
                node_type="mixed",
                member_count=10,
            ),
            Community(
                id=community_id_from("L0", 7),
                level="L0",
                node_type="mixed",
                member_count=8,
            ),
            Community(
                id=community_id_from("L1", 3),
                level="L1",
                node_type="mixed",
                member_count=5,
                parent_id=community_id_from("L0", 9),
                parent_level=0,
            ),
        ]
    )
    conn.commit()
    return store


class _LLMRecorder:
    """Stand-in for ``litellm.acompletion`` with scripted rate/map/reduce."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.map_payload: dict = {"points": []}
        self.reduce_answer = "FINAL ANSWER"
        self.rating = "8"  # default: keep every rated community
        self.exc: Exception | None = None

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.exc is not None:
            raise self.exc
        system = kwargs["messages"][0]["content"]
        if "相关性评分员" in system:
            content = self.rating
        elif "Respond ONLY with JSON" in system:
            content = json.dumps(self.map_payload)
        else:
            content = self.reduce_answer
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        )


@pytest.fixture(autouse=True)
def _patch_state(monkeypatch):
    """Warm fixture state for every test."""
    store = _build_fixture_store()
    orig = (state.sqlite_conn, state.ready, state.store)
    state.sqlite_conn = store.conn
    state.ready = True
    state.store = store
    monkeypatch.setattr(kl_server, "CURRENT_USER", "")
    # This module tests the experimental community feature itself; production
    # defaults it off.
    monkeypatch.setattr(kl_server, "COMMUNITIES_ENABLED", True)
    yield store
    state.sqlite_conn, state.ready, state.store = orig
    store.close()


@pytest.fixture()
def llm(monkeypatch) -> _LLMRecorder:
    rec = _LLMRecorder()
    monkeypatch.setattr(litellm, "acompletion", rec)
    return rec


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=True)


# ── grounded no-data paths (zero LLM calls) ──────────────────────────────────


def test_disabled_feature_returns_grounded_no_data(client, llm, monkeypatch) -> None:
    monkeypatch.setattr(kl_server, "COMMUNITIES_ENABLED", False)

    response = client.post("/global_search", json={"query": "我的任务"})

    assert response.status_code == 200
    assert response.json()["reason"] == "communities_disabled"
    assert llm.calls == []


def test_missing_summaries_table_hint_zero_calls(client, llm) -> None:
    conn = state.sqlite_conn
    assert conn is not None  # patched by the autouse fixture
    conn.execute("DROP TABLE community_summaries")
    conn.commit()
    r = client.post("/global_search", json={"query": "我的任务"})
    assert r.status_code == 200
    data = r.json()
    assert data["reason"] == "no_communities"
    assert "hint" in data and "scripts.improve" in data["hint"]
    assert llm.calls == []


def test_blank_query_rejected_zero_llm_calls(client, llm) -> None:
    """Blank/whitespace-only queries are grounded BEFORE any LLM work."""
    for blank in ("", "   ", "\t\n"):
        r = client.post("/global_search", json={"query": blank, "user": "Alice"})
        assert r.status_code == 200
        data = r.json()
        assert data["reason"] == "empty_query"
        assert data["answer"].startswith("I am sorry but I am unable to answer")
    assert llm.calls == []


def test_user_field_accepted_but_ignored(client, llm) -> None:
    """The ``user`` field is echoed back but does not gate selection."""
    llm.map_payload = {
        "points": [
            {
                "description": "Alice 的任务 [Data: Communities (L0-9)]",
                "score": 70,
                "community_ids": ["L0-9"],
            }
        ]
    }
    r = client.post(
        "/global_search", json={"query": "我最近的任务是什么", "user": "Whoever"}
    )
    assert r.status_code == 200
    data = r.json()
    assert data["reason"] == "ok"
    assert data["user"] == "Whoever"  # echoed
    assert data["entity_id"] is None  # identity resolution deleted


# ── happy path: rate-then-descend → map-reduce pass-through ──────────────────


def test_happy_path_passes_answer_citations_diagnostics(client, llm) -> None:
    llm.map_payload = {
        "points": [
            {
                "description": "Alice 最近在做数据同步评审 [Data: Communities (L0-9)]",
                "score": 80,
                "community_ids": ["L0-9"],
            },
            {"description": "irrelevant filler", "score": 0, "community_ids": ["L1-3"]},
            {
                "description": "Alice 部署 vLLM [Data: Communities (L1-3)]",
                "score": 65,
                "community_ids": ["L1-3"],
            },
        ]
    }
    llm.reduce_answer = "最终答案 [Data: Communities (L0-9, L1-3)]"

    r = client.post(
        "/global_search",
        json={"query": "我最近的任务是什么", "user": "Alice"},
    )
    assert r.status_code == 200
    data = r.json()

    assert data["reason"] == "ok"
    assert data["answer"] == llm.reduce_answer
    # Rate-then-descend keeps high-rated roots + descends into their children.
    selected = {(c["level"], c["community_id"]) for c in data["communities"]}
    assert (0, 9) in selected
    assert "L0-9" in data["citations"]
    diag = data["diagnostics"]
    assert diag["ratings_kept"] >= 1
    assert diag["map_calls"] >= 1
    assert diag["points_total"] >= 1
    assert diag["points_kept"] >= 1  # score-0 dropped
    assert diag["reduce_called"] is True
    assert diag["search_latency_ms"] >= 0
    assert data["latency_ms"] >= 0


# ── grounded validation + early-failure boundary ─────────────────────────────


def test_early_sqlite_failure_returns_grounded_error(
    client, llm, monkeypatch
) -> None:
    """Prerequisite DB failures stay inside the grounded boundary — HTTP 200
    'error', never a 500 escape."""

    class _BoomConn:
        def execute(self, *a, **k):
            raise sqlite3.OperationalError("database disk image is malformed")

    monkeypatch.setattr(state, "sqlite_conn", _BoomConn())
    r = client.post("/global_search", json={"query": "我的任务", "user": "Alice"})
    assert r.status_code == 200  # never 500 on early SQLite failures
    data = r.json()
    assert data["reason"] == "error"
    assert "malformed" in data["diagnostics"]["error"]
    assert llm.calls == []


# ── failure visibility ([!RED R4]) ───────────────────────────────────────────


def test_llm_transport_failure_visible_not_silent(client, llm) -> None:
    """Acompletion failures are counted + listed in diagnostics; the request
    degrades to a grounded no-data answer — never a fabricated one."""
    llm.exc = RuntimeError("gateway 502")
    r = client.post("/global_search", json={"query": "我的任务", "user": "Alice"})
    assert r.status_code == 200
    data = r.json()
    # Rating calls all error → no communities selected → grounded no-data.
    assert data["reason"] in {"no_communities", "no_points"}
    assert data["answer"].startswith("I am sorry but I am unable to answer")
    diag = data["diagnostics"]
    assert diag["llm_errors"], "transport errors must stay visible"
    assert diag["reduce_called"] is False


def test_unexpected_service_error_returns_grounded_error(
    client, llm, monkeypatch
) -> None:
    async def _boom(self, query, user_entity_id=""):
        raise RuntimeError("sqlite exploded")

    monkeypatch.setattr(kl_server.GlobalSearch, "search", _boom)
    r = client.post("/global_search", json={"query": "我的任务", "user": "Alice"})
    assert r.status_code == 200  # never 500 on search-side failures
    data = r.json()
    assert data["reason"] == "error"
    assert "sqlite exploded" in data["diagnostics"]["error"]


# ── concurrency gating ───────────────────────────────────────────────────────


def test_endpoint_is_semaphore_gated(client, llm, monkeypatch) -> None:
    llm.map_payload = {
        "points": [
            {"description": "x [Data: Communities (L0-9)]", "score": 50, "community_ids": ["L0-9"]}
        ]
    }
    events: list[str] = []
    real = kl_server._query_sema

    def _recording():
        sema = real()

        class _Wrap:
            async def __aenter__(self):
                events.append("acquire")
                return await sema.__aenter__()

            async def __aexit__(self, *exc):
                events.append("release")
                return await sema.__aexit__(*exc)

        return _Wrap()

    monkeypatch.setattr(kl_server, "_query_sema", _recording)
    r = client.post("/global_search", json={"query": "我的任务", "user": "Alice"})
    assert r.status_code == 200
    assert events == ["acquire", "release"]
