"""Integration tests for POST /global_search (kl_server).

Covers the U2 contract in ``docs/todo/global-search.md``:

- identity precedence (request ``user`` → ``KL_CURRENT_USER``);
- every miss is a grounded HTTP 200 no-data answer with ZERO LLM calls
  (never 404, never a corpus-wide fallback — the [!RED] coverage policy);
- graceful degradation when the improve pipeline has not run;
- blank queries and early SQLite failures degrade to grounded 200
  responses (never 500, zero LLM calls);
- happy map-reduce pass-through (answer, citations, communities,
  diagnostics) with a scripted ``litellm.acompletion`` stand-in;
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
from kl_server import app, state


def _build_fixture_store():
    """In-memory SQLiteStore: one user WITH communities, one WITHOUT.

    Alice (ent-alice) → L0/c9 + L1/c3 entity summaries (plus a fact-community
    row that must be ignored). Bob (ent-bob) → all community columns NULL:
    the prominent-but-unassigned coverage-gap case.
    """
    from kl_graph.storage.sqlite_store import SQLiteStore

    conn = sqlite3.connect(":memory:", check_same_thread=False)
    store = SQLiteStore(Path(":memory:"), conn=conn)
    conn = store.conn

    # community_L* columns are added by the improve pipeline (ALTER TABLE),
    # not the base schema — mirror that here.
    for lvl in ("L0", "L1", "L2", "L3"):
        conn.execute(f"ALTER TABLE entities ADD COLUMN community_{lvl} INTEGER")

    conn.executemany(
        "INSERT INTO entities(id, name, entity_type, mention_count, "
        "community_L0, community_L1) VALUES (?,?,?,?,?,?)",
        [
            ("ent-alice", "Alice", "Person", 10, 9, 3),
            ("ent-bob", "Bob", "Person", 5, None, None),
        ],
    )
    conn.executemany(
        "INSERT INTO community_summaries(level, community_id, node_type, "
        "member_count, summary, tags, top_members) VALUES (?,?,?,?,?,?,?)",
        [
            ("L0", 9, "entity", 10, "Alice 负责数据同步项目，推进评审与整改。", "[]", "[]"),
            ("L1", 3, "entity", 5, "Alice 在部署 vLLM 嵌入服务。", "[]", "[]"),
            ("L0", 99, "fact", 7, "fact-community row — must be ignored.", "[]", "[]"),
        ],
    )
    conn.commit()
    return store


class _LLMRecorder:
    """Stand-in for ``litellm.acompletion`` with scripted map/reduce replies."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.map_payload: dict = {"points": []}
        self.reduce_answer = "FINAL ANSWER"
        self.exc: Exception | None = None

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self.exc is not None:
            raise self.exc
        system = kwargs["messages"][0]["content"]
        if "Respond ONLY with JSON" in system:
            content = json.dumps(self.map_payload)
        else:
            content = self.reduce_answer
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        )


@pytest.fixture(autouse=True)
def _patch_state(monkeypatch):
    """Warm fixture state + neutral KL_CURRENT_USER for every test."""
    store = _build_fixture_store()
    orig = (state.sqlite_conn, state.ready, state.store)
    state.sqlite_conn = store.conn
    state.ready = True
    state.store = store
    monkeypatch.setattr(kl_server, "CURRENT_USER", "")
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


def test_no_identity_returns_canned_no_data(client, llm) -> None:
    r = client.post("/global_search", json={"query": "我最近的任务是什么"})
    assert r.status_code == 200
    data = r.json()
    assert data["reason"] == "no_identity"
    assert data["answer"].startswith("I am sorry but I am unable to answer")
    assert data["communities"] == []
    assert llm.calls == []


def test_unknown_identity_zero_llm_calls(client, llm) -> None:
    r = client.post(
        "/global_search", json={"query": "我的任务", "user": "Nobody"}
    )
    assert r.status_code == 200
    data = r.json()
    assert data["reason"] == "identity_unresolved"
    assert data["user"] == "Nobody"
    assert data["entity_id"] is None
    assert llm.calls == []


def test_entity_without_communities_no_data_zero_calls(client, llm) -> None:
    """Coverage-gap policy: unassigned entity → grounded no-data WITH a
    remediation hint, no fallback."""
    r = client.post("/global_search", json={"query": "我的任务", "user": "Bob"})
    assert r.status_code == 200
    data = r.json()
    assert data["reason"] == "no_communities"
    assert data["entity_id"] == "ent-bob"
    assert "hint" in data and "scripts.improve" in data["hint"]
    assert data["diagnostics"]["search_latency_ms"] >= 0
    assert llm.calls == []


def test_missing_summaries_table_hint_zero_calls(client, llm) -> None:
    conn = state.sqlite_conn
    assert conn is not None  # patched by the autouse fixture
    conn.execute("DROP TABLE community_summaries")
    conn.commit()
    r = client.post("/global_search", json={"query": "我的任务", "user": "Alice"})
    assert r.status_code == 200
    data = r.json()
    assert data["reason"] == "no_communities"
    assert "hint" in data and "scripts.improve" in data["hint"]
    assert llm.calls == []


# ── identity precedence ──────────────────────────────────────────────────────


def test_env_default_identity_used(client, llm, monkeypatch) -> None:
    llm.map_payload = {
        "points": [
            {
                "description": "Alice 的任务 [Data: Communities (L0-9)]",
                "score": 70,
                "community_ids": ["L0-9"],
            }
        ]
    }
    monkeypatch.setattr(kl_server, "CURRENT_USER", "Alice")
    r = client.post("/global_search", json={"query": "我最近的任务是什么"})
    assert r.status_code == 200
    data = r.json()
    assert data["reason"] == "ok"
    assert data["user"] == "Alice"
    assert data["entity_id"] == "ent-alice"


def test_request_user_overrides_env_default(client, llm, monkeypatch) -> None:
    llm.map_payload = {
        "points": [
            {
                "description": "Alice 的任务 [Data: Communities (L0-9)]",
                "score": 70,
                "community_ids": ["L0-9"],
            }
        ]
    }
    # Bob (unassigned) as the env default; the request field must win.
    monkeypatch.setattr(kl_server, "CURRENT_USER", "Bob")
    r = client.post(
        "/global_search", json={"query": "我最近的任务是什么", "user": "Alice"}
    )
    assert r.status_code == 200
    data = r.json()
    assert data["entity_id"] == "ent-alice"
    assert data["reason"] == "ok"


# ── happy path: map-reduce pass-through ─────────────────────────────────────


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
    assert data["user"] == "Alice"
    assert data["entity_id"] == "ent-alice"
    # Selected communities: the two entity summaries; the fact-community row
    # is ignored by the U1 selection.
    assert {(c["level"], c["community_id"]) for c in data["communities"]} == {
        ("L0", 9),
        ("L1", 3),
    }
    assert "L0-9" in data["citations"]
    diag = data["diagnostics"]
    assert diag["summaries_selected"] == 2
    assert diag["map_calls"] == 1
    assert diag["points_total"] == 3
    assert diag["points_kept"] == 2  # score-0 dropped
    assert diag["reduce_called"] is True
    assert diag["search_latency_ms"] >= 0  # U1 search latency surfaced
    # One map + one reduce — no extra calls.
    assert len(llm.calls) == 2
    assert data["latency_ms"] >= 0


# ── grounded validation + early-failure boundary ─────────────────────────────


def test_blank_query_rejected_zero_llm_calls(client, llm) -> None:
    """Blank/whitespace-only queries are grounded BEFORE any LLM work."""
    for blank in ("", "   ", "\t\n"):
        r = client.post(
            "/global_search", json={"query": blank, "user": "Alice"}
        )
        assert r.status_code == 200
        data = r.json()
        assert data["reason"] == "empty_query"
        assert data["answer"].startswith("I am sorry but I am unable to answer")
    assert llm.calls == []


def test_early_sqlite_failure_returns_grounded_error(
    client, llm, monkeypatch
) -> None:
    """Identity/prerequisite DB failures stay inside the grounded boundary —
    HTTP 200 'error', never a 500 escape."""

    def _boom(name_or_id):
        raise sqlite3.OperationalError("database disk image is malformed")

    monkeypatch.setattr(kl_server, "_resolve_entity_id", _boom)
    r = client.post(
        "/global_search", json={"query": "我的任务", "user": "Alice"}
    )
    assert r.status_code == 200  # never 500 on early SQLite failures
    data = r.json()
    assert data["reason"] == "error"
    assert "malformed" in data["diagnostics"]["error"]
    assert data["user"] == "Alice"
    assert data["entity_id"] is None
    assert llm.calls == []


# ── failure visibility ([!RED R4]) ───────────────────────────────────────────


def test_llm_transport_failure_visible_not_silent(client, llm) -> None:
    """Acompletion failures are counted + listed in diagnostics; the request
    degrades to a grounded no-data answer — never a fabricated one."""
    llm.exc = RuntimeError("gateway 502")
    r = client.post(
        "/global_search", json={"query": "我的任务", "user": "Alice"}
    )
    assert r.status_code == 200
    data = r.json()
    # All map batches errored → no surviving points → no reduce call.
    assert data["reason"] == "no_points"
    assert data["answer"].startswith("I am sorry but I am unable to answer")
    diag = data["diagnostics"]
    assert diag["map_batches_error"] >= 1
    assert diag["llm_errors"], "transport errors must stay visible"
    assert diag["reduce_called"] is False


def test_unexpected_service_error_returns_grounded_error(
    client, llm, monkeypatch
) -> None:
    async def _boom(self, query, user_entity_id):
        raise RuntimeError("sqlite exploded")

    monkeypatch.setattr(kl_server.GlobalSearch, "search", _boom)
    r = client.post(
        "/global_search", json={"query": "我的任务", "user": "Alice"}
    )
    assert r.status_code == 200  # never 500 on LLM-side failures
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
    r = client.post(
        "/global_search", json={"query": "我的任务", "user": "Alice"}
    )
    assert r.status_code == 200
    assert events == ["acquire", "release"]
