"""End-to-end HTTP tests for the stable-identity + gated-summary feature.

Drives the REAL kl_server endpoints (/health, /status, /community,
/global_search) via FastAPI TestClient against a seeded in-memory store, proving
the feature works through the actual HTTP surface and that the global-search
misattribution guard holds end to end. No network: litellm.acompletion is
monkeypatched.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from types import SimpleNamespace

import litellm
import pytest
from fastapi.testclient import TestClient

import kl_server
from kl_graph.storage.sqlite_store import SQLiteStore
from kl_server import app, state


def _build_store() -> SQLiteStore:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    store = SQLiteStore(Path(":memory:"), conn=conn)
    conn = store.conn
    # community_summaries with the additive stable-identity columns.
    conn.execute("ALTER TABLE community_summaries ADD COLUMN community_uuid TEXT")
    conn.execute(
        "ALTER TABLE community_summaries ADD COLUMN summary_stale INTEGER NOT NULL DEFAULT 0"
    )

    def add(level, cid, title, summary, uuid, stale=0):
        conn.execute(
            "INSERT INTO community_summaries (level, community_id, member_count, "
            "entity_count, fact_count, title, summary, rating, rating_explanation, "
            "findings, tags, top_members, community_uuid, summary_stale) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (level, cid, 10, 6, 4, title, summary, 8.0, "r", "[]", '["t"]', "[]",
             uuid, stale),
        )

    # c0: valid, matches current identity. c1: stale (must be hidden from search).
    # c5: misattributed (stored uuid != current resolution -> hidden from search).
    add(0, 0, "Alpha", "Alpha community summary.", "u0")
    add(0, 1, "Beta", "Beta community summary.", "u1", stale=1)
    add(0, 5, "Gamma", "Gamma community summary.", "old-uuid")

    # communities table for hierarchy (projection-token domain).
    conn.execute(
        "INSERT INTO communities (id, level, node_type, member_count) VALUES "
        "('t0', 'L0', 'mixed', 10)"
    )
    # identity map: latest run resolves (0,0)->u0 (match), (0,5)->new-uuid (mismatch).
    conn.execute(
        """
        CREATE TABLE community_identity_map (
            run_id TEXT NOT NULL, level INTEGER NOT NULL,
            cluster_id INTEGER NOT NULL, community_uuid TEXT NOT NULL,
            PRIMARY KEY (run_id, level, cluster_id)
        )
        """
    )
    conn.executemany(
        "INSERT INTO community_identity_map (run_id, level, cluster_id, community_uuid) VALUES (?,?,?,?)",
        [("run-2", 0, 0, "u0"), ("run-2", 0, 5, "new-uuid")],
    )
    conn.commit()
    return store


@pytest.fixture(autouse=True)
def _patch_state(monkeypatch):
    store = _build_store()
    orig = (state.sqlite_conn, state.ready, state.store)
    state.sqlite_conn = store.conn
    state.ready = True
    state.store = store
    monkeypatch.setattr(kl_server, "CURRENT_USER", "", raising=False)
    monkeypatch.setattr(kl_server, "COMMUNITIES_ENABLED", True, raising=False)
    yield
    state.sqlite_conn, state.ready, state.store = orig


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=True)


def _fake_completion(*args, **kwargs):
    # Rate every community high; produce a deterministic map/reduce answer.
    msg = kwargs.get("messages", [{}])[-1].get("content", "")
    if "问题" in msg or "relevance" in msg.lower() or "rate" in msg.lower():
        text = "10"
    else:
        text = "综合社区报告的答复。"
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2),
    )


def test_health_ok(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200


def test_status_ok(client: TestClient) -> None:
    r = client.get("/status")
    assert r.status_code == 200
    assert r.json().get("status") == "ready"


def test_community_browse_lists_and_fetches(client: TestClient) -> None:
    # List communities.
    r = client.post("/community", json={})
    assert r.status_code == 200
    # Fetch a specific valid community by (level, community_id). The endpoint
    # takes an "L{n}" level label.
    r2 = client.post("/community", json={"level": "L0", "community_id": 0})
    assert r2.status_code == 200
    body = r2.json()
    assert body["title"] == "Alpha"
    assert body["summary"] == "Alpha community summary."


def test_global_search_hides_stale_and_misattributed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The map step should only ever see the VALID community (c0). The stale c1
    # and misattributed c5 must be excluded by _read_all_summaries before the
    # LLM sees them — proving the stable-identity guard holds end to end.
    seen_titles: list[str] = []

    async def _acompletion(*args, **kwargs):
        content = kwargs.get("messages", [{}])[-1].get("content", "")
        for title in ("Alpha", "Beta", "Gamma"):
            if title in content:
                seen_titles.append(title)
        # Rating prompt -> high score; map/reduce -> answer text.
        low = content.lower()
        text = "10" if ("问题" in content or "rate" in low) else "答复。"
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
            usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        )

    monkeypatch.setattr(litellm, "acompletion", _acompletion)

    r = client.post("/global_search", json={"query": "什么是 Alpha?"})
    assert r.status_code == 200  # always a grounded 200
    # Beta (stale) and Gamma (misattributed) must NEVER have reached the LLM.
    assert "Beta" not in seen_titles
    assert "Gamma" not in seen_titles


def test_global_search_degrades_gracefully_without_summaries(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Drop the summaries table -> endpoint still returns grounded 200, no 500.
    state.sqlite_conn.execute("DROP TABLE community_summaries")
    state.sqlite_conn.commit()
    monkeypatch.setattr(litellm, "acompletion", _fake_completion)
    r = client.post("/global_search", json={"query": "anything"})
    assert r.status_code == 200
