"""Integration tests for the incremental detection + gated-summary contract (Task 5).

Exercises the full delivered path (v1 = full rerun + reconciliation + gated
summaries) end to end with fakes for the LLM: detect → store columns →
reconcile identities → gated summarize → global-search retrieval, then a second
"reingest" round proving unchanged communities keep their reports and a
renumbered cluster is never misattributed.

No network / LLM.
"""

from __future__ import annotations

import sqlite3

import pytest

from kl_graph.models.types import community_id_from
from kl_graph.periodic import community_summarizer as cs
from kl_graph.periodic.community_identity import CommunityIdentity
from kl_graph.periodic.community_summarizer import (
    CommunityReport,
    run_gated_summarization,
)
from kl_graph.query.global_search import GlobalSearch
from kl_graph.storage.sqlite_store import SQLiteStore


def _store() -> SQLiteStore:
    return SQLiteStore(db_path=None, conn=sqlite3.connect(":memory:"))


def _seed(store: SQLiteStore, assignments: dict[int, int]) -> None:
    """Seed entities+facts+communities for one L0 partition.

    ``assignments`` maps member index -> cluster id. Members 0..9 are entities,
    10..19 are facts (so each community can clear a min_members floor).
    """
    conn = store.sql_conn
    cols = {r[1] for r in conn.execute("PRAGMA table_info(entities)").fetchall()}
    if "community_L0" not in cols:
        conn.execute("ALTER TABLE entities ADD COLUMN community_L0 INTEGER")
        conn.execute("ALTER TABLE facts ADD COLUMN community_L0 INTEGER")
    conn.execute("DELETE FROM entities")
    conn.execute("DELETE FROM facts")
    conn.execute("DELETE FROM communities")
    for idx, cid in assignments.items():
        if idx < 10:
            conn.execute(
                "INSERT INTO entities (id, name, description, mention_count, community_L0) "
                "VALUES (?,?,?,?,?)",
                (f"e{idx}", f"N{idx}", "d", 1, cid),
            )
        else:
            conn.execute(
                "INSERT INTO facts (id, text, confidence, source_chunk_id, community_L0) "
                "VALUES (?,?,?,?,?)",
                (f"f{idx}", f"t{idx}", 0.9, "c", cid),
            )
    for cid in sorted(set(assignments.values())):
        conn.execute(
            "INSERT OR REPLACE INTO communities (id, level, node_type, member_count) "
            "VALUES (?, ?, 'mixed', ?)",
            (community_id_from("L0", cid), "L0", sum(1 for v in assignments.values() if v == cid)),
        )
    conn.commit()


def _current_partition(store: SQLiteStore) -> dict[int, dict[int, set[str]]]:
    """Read the L0 partition as {level: {cid: member_set}} for reconciliation."""
    conn = store.sql_conn
    per_cluster: dict[int, set[str]] = {}
    for eid, cid in conn.execute(
        "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
    ).fetchall():
        per_cluster.setdefault(int(cid), set()).add(f"e:{eid}")
    for fid, cid in conn.execute(
        "SELECT id, community_L0 FROM facts WHERE community_L0 IS NOT NULL"
    ).fetchall():
        per_cluster.setdefault(int(cid), set()).add(f"f:{fid}")
    return {0: per_cluster}


def _fake_generate_factory(counter: list[int]):
    async def fake_generate(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        subset = include_only or set()
        counter.append(len(subset))
        reports = [
            CommunityReport(
                level=lvl, community_id=cid, member_count=20, entity_count=10,
                fact_count=10, title=f"C{cid}", summary=f"summary for {cid}",
                rating=5.0, rating_explanation="r",
                findings=[{"summary": "f", "explanation": "e"}], tags=["t"],
                top_members=["m"],
            )
            for (lvl, cid) in subset
        ]
        return reports, {"llm_calls": len(reports), "prompt_tokens": 0,
                         "completion_tokens": 0, "total_tokens": 0, "estimated_cost_usd": 0.0}

    return fake_generate


def test_full_then_reingest_keeps_unchanged_reports(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _store()
    # Round 1: two communities of 10 members each (entities 0-9 -> c0? split below).
    # cluster 0 = idx 0..4 + 10..14 ; cluster 1 = idx 5..9 + 15..19
    assign = {i: (0 if (i % 10) < 5 else 1) for i in range(20)}
    _seed(store, assign)

    calls: list[int] = []
    monkeypatch.setattr(cs, "generate_community_reports", _fake_generate_factory(calls))

    ident = CommunityIdentity(store)
    ident.reconcile(_current_partition(store), "run-1")
    res1 = run_gated_summarization(store, ident, run_id="run-1", levels=[0], min_members=1)
    assert res1["regenerated"] == 2  # both fresh
    assert calls[-1] == 2

    # Round 2: identical membership, but reconcile a NEW run id (as a full rerun
    # would). Unchanged communities must keep reports -> zero regenerations.
    ident2 = CommunityIdentity(store)
    ident2.reconcile(_current_partition(store), "run-2")
    n_before = len(calls)
    res2 = run_gated_summarization(store, ident2, run_id="run-2", levels=[0], min_members=1)
    assert res2["regenerated"] == 0
    assert res2["kept"] == 2
    assert len(calls) == n_before  # generation never invoked


def test_renumber_does_not_misattribute(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _store()
    assign = {i: (0 if (i % 10) < 5 else 1) for i in range(20)}
    _seed(store, assign)
    calls: list[int] = []
    monkeypatch.setattr(cs, "generate_community_reports", _fake_generate_factory(calls))

    ident = CommunityIdentity(store)
    ident.reconcile(_current_partition(store), "run-1")
    run_gated_summarization(store, ident, run_id="run-1", levels=[0], min_members=1)

    # Now RENUMBER: swap the integer labels (0<->1) but keep identical member
    # sets. Reconciliation must keep the SAME uuids bound to the same members.
    conn = store.sql_conn
    conn.execute("UPDATE entities SET community_L0 = 9 WHERE community_L0 = 0")
    conn.execute("UPDATE facts SET community_L0 = 9 WHERE community_L0 = 0")
    conn.execute("UPDATE entities SET community_L0 = 0 WHERE community_L0 = 1")
    conn.execute("UPDATE facts SET community_L0 = 0 WHERE community_L0 = 1")
    conn.execute("UPDATE entities SET community_L0 = 1 WHERE community_L0 = 9")
    conn.execute("UPDATE facts SET community_L0 = 1 WHERE community_L0 = 9")
    # Refresh communities rows for the renumbered ids.
    conn.execute("DELETE FROM communities")
    for cid in (0, 1):
        conn.execute(
            "INSERT INTO communities (id, level, node_type, member_count) VALUES (?,?,'mixed',10)",
            (community_id_from("L0", cid), "L0"),
        )
    conn.commit()

    ident2 = CommunityIdentity(store)
    mapping = ident2.reconcile(_current_partition(store), "run-2")

    # The member set that was cluster 0 is now cluster 1 -> must carry the SAME uuid.
    # Global search must never serve a report bound to the other community.
    async def _stub(system: str, user: str) -> str:
        return "0"

    search = GlobalSearch(conn=conn, acomplete=_stub)
    summaries = search._read_all_summaries([0])
    # Every served summary's stored uuid must equal the CURRENT resolution for
    # its (level, cid) — i.e. no misattribution survived the renumber.
    for (level, cid), summ in summaries.items():
        assert summ["community_uuid"] == mapping[(level, cid)]


def test_gated_summarization_is_idempotent_on_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    # Re-running the same run_id (a crashed+retried improve) must not duplicate
    # reports or advance baselines twice.
    store = _store()
    assign = {i: (0 if (i % 10) < 5 else 1) for i in range(20)}
    _seed(store, assign)
    calls: list[int] = []
    monkeypatch.setattr(cs, "generate_community_reports", _fake_generate_factory(calls))

    ident = CommunityIdentity(store)
    ident.reconcile(_current_partition(store), "run-1")
    run_gated_summarization(store, ident, run_id="run-1", levels=[0], min_members=1)

    # Retry: reconcile SAME run id again (idempotent), then gate again.
    ident.reconcile(_current_partition(store), "run-1")
    run_gated_summarization(store, ident, run_id="run-1", levels=[0], min_members=1)

    n_rows = store.sql_conn.execute(
        "SELECT COUNT(*) FROM community_summaries"
    ).fetchone()[0]
    assert n_rows == 2  # no duplicate rows
    n_map = store.sql_conn.execute(
        "SELECT COUNT(*) FROM community_identity_map WHERE run_id='run-1'"
    ).fetchone()[0]
    assert n_map == 2  # idempotent identity map
