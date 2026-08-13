"""Unit tests for baseline-aware gated re-summarization (Task 2).

No network / LLM: the LLM generation pass is monkeypatched. Tests target the
gate math, the scoped (non-destructive) upsert, baseline advance-on-success,
below-min retirement, and stable-UUID binding.
"""

from __future__ import annotations

import sqlite3

import pytest

from kl_graph.models.types import community_id_from
from kl_graph.periodic import community_summarizer as cs
from kl_graph.periodic.community_summarizer import (
    CommunityReport,
    _change_fraction,
    plan_resummarization,
    run_gated_summarization,
    store_community_reports,
)
from kl_graph.storage.sqlite_store import SQLiteStore

# ── gate math ────────────────────────────────────────────────────────────────


def test_change_fraction_churn_over_baseline() -> None:
    base = {"e:1", "e:2", "e:3", "e:4"}
    # add 1, remove 0 -> 1/4 = 0.25
    assert _change_fraction(base, base | {"e:5"}, "churn_over_baseline") == 0.25
    # remove 2 -> churn 2/4 = 0.5 (removals count)
    assert _change_fraction(base, {"e:1", "e:2"}, "churn_over_baseline") == 0.5


def test_change_fraction_empty_baseline_is_full() -> None:
    assert _change_fraction(set(), {"e:1"}, "churn_over_baseline") == 1.0
    assert _change_fraction(set(), {"e:1"}, "added_over_baseline") == 1.0


def test_change_fraction_added_over_current() -> None:
    base = {"e:1", "e:2"}
    curr = {"e:1", "e:2", "e:3", "e:4"}
    assert _change_fraction(base, curr, "added_over_current") == 0.5  # 2 added / 4 current


def test_change_fraction_one_minus_jaccard() -> None:
    base = {"e:1", "e:2"}
    curr = {"e:2", "e:3"}
    # |inter|=1 |union|=3 -> 1 - 1/3
    assert abs(_change_fraction(base, curr, "one_minus_jaccard") - (1 - 1 / 3)) < 1e-9


def test_change_fraction_rejects_bad_denominator() -> None:
    with pytest.raises(ValueError):
        _change_fraction({"e:1"}, {"e:1"}, "nonsense")


# ── scoped upsert: no table-wide wipe ────────────────────────────────────────


def _store() -> SQLiteStore:
    conn = sqlite3.connect(":memory:")
    return SQLiteStore(db_path=None, conn=conn)


def _report(level: int, cid: int, uuid: str | None = None) -> CommunityReport:
    return CommunityReport(
        level=level, community_id=cid, member_count=10, entity_count=6, fact_count=4,
        title=f"C{cid}", summary="s", rating=5.0, rating_explanation="r",
        findings=[{"summary": "f", "explanation": "e"}], tags=["t"],
        top_members=["m"], community_uuid=uuid,
    )


def test_scoped_upsert_retains_siblings() -> None:
    store = _store()
    store_community_reports(store, [_report(0, 0, "uuid-0"), _report(0, 1, "uuid-1")])
    # A later run rewrites ONLY community 0; community 1 must survive.
    store_community_reports(store, [_report(0, 0, "uuid-0")])
    rows = store.sql_conn.execute(
        "SELECT community_id FROM community_summaries ORDER BY community_id"
    ).fetchall()
    assert [r[0] for r in rows] == [0, 1]  # sibling retained


def test_upsert_writes_community_uuid() -> None:
    store = _store()
    store_community_reports(store, [_report(0, 5, "uuid-xyz")])
    row = store.sql_conn.execute(
        "SELECT community_uuid FROM community_summaries WHERE level=0 AND community_id=5"
    ).fetchone()
    assert row[0] == "uuid-xyz"


def test_legacy_report_without_uuid_still_stores() -> None:
    # Backward compat: a report built the old way (no community_uuid) still stores.
    store = _store()
    n = store_community_reports(store, [_report(0, 9, None)])
    assert n == 1
    row = store.sql_conn.execute(
        "SELECT community_uuid FROM community_summaries WHERE community_id=9"
    ).fetchone()
    assert row[0] is None


# ── the gate plan (no LLM) ───────────────────────────────────────────────────


class _FakeIdentity:
    """Minimal CommunityIdentity stand-in: fixed (level, cid) -> uuid mapping."""

    def __init__(self, mapping: dict[tuple[int, int], str]) -> None:
        self._m = mapping

    def resolve(self, level: int, cluster_id: int) -> str | None:
        return self._m.get((level, cluster_id))


def _seed_store_with_two_communities(store: SQLiteStore) -> None:
    conn = store.sql_conn
    conn.execute("ALTER TABLE entities ADD COLUMN community_L0 INTEGER")
    conn.execute("ALTER TABLE facts ADD COLUMN community_L0 INTEGER")
    # community 0: 10 members (6 entities + 4 facts); community 1: 10 members
    ents = [(f"e{i}", f"N{i}", "d", 1, 0) for i in range(6)]
    ents += [(f"e{i}", f"N{i}", "d", 1, 1) for i in range(6, 12)]
    conn.executemany(
        "INSERT INTO entities (id, name, description, mention_count, community_L0) VALUES (?,?,?,?,?)",
        ents,
    )
    facts = [(f"f{i}", f"t{i}", 0.9, "c", 0) for i in range(4)]
    facts += [(f"f{i}", f"t{i}", 0.9, "c", 1) for i in range(4, 8)]
    conn.executemany(
        "INSERT INTO facts (id, text, confidence, source_chunk_id, community_L0) VALUES (?,?,?,?,?)",
        facts,
    )
    conn.executemany(
        "INSERT INTO communities (id, level, node_type, member_count) VALUES (?, ?, 'mixed', ?)",
        [(community_id_from("L0", 0), "L0", 10), (community_id_from("L0", 1), "L0", 10)],
    )
    conn.commit()


def test_plan_first_run_regenerates_all() -> None:
    store = _store()
    _seed_store_with_two_communities(store)
    ident = _FakeIdentity({(0, 0): "u0", (0, 1): "u1"})
    plan = plan_resummarization(store, ident, levels=[0], min_members=1)
    assert plan["regenerate"] == {(0, 0), (0, 1)}  # no baseline yet
    assert plan["keep"] == set()


def test_plan_unchanged_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _store()
    _seed_store_with_two_communities(store)
    ident = _FakeIdentity({(0, 0): "u0", (0, 1): "u1"})
    # Seed baselines AND report rows (a real 'kept' state requires both: a
    # baseline without a bound report now correctly forces regeneration).
    cs._ensure_summary_schema(store)
    store_community_reports(store, [_report(0, 0, "u0"), _report(0, 1, "u1")])
    for cid, uuid in ((0, "u0"), (1, "u1")):
        plan = plan_resummarization(store, ident, levels=[0], min_members=1)
        members = plan["members_of"][(0, cid)]
        cs._advance_baseline(store, uuid, 0, members, "run-seed")
    store.sql_conn.commit()
    plan = plan_resummarization(store, ident, levels=[0], min_members=1)
    assert plan["regenerate"] == set()
    assert plan["keep"] == {(0, 0), (0, 1)}


def test_baseline_without_report_regenerates(monkeypatch: pytest.MonkeyPatch) -> None:
    # fix-now: a baseline present but the bound report missing (crash/manual
    # cleanup) must regenerate, not be silently kept.
    store = _store()
    _seed_store_with_two_communities(store)
    ident = _FakeIdentity({(0, 0): "u0", (0, 1): "u1"})
    cs._ensure_summary_schema(store)
    # Advance baselines but store NO report rows.
    for cid, uuid in ((0, "u0"), (1, "u1")):
        plan = plan_resummarization(store, ident, levels=[0], min_members=1)
        cs._advance_baseline(store, uuid, 0, plan["members_of"][(0, cid)], "seed")
    store.sql_conn.commit()
    plan = plan_resummarization(store, ident, levels=[0], min_members=1)
    assert plan["regenerate"] == {(0, 0), (0, 1)}  # missing report -> regenerate


def test_unresolved_identity_is_skipped_not_unbound() -> None:
    # fix-now: a community whose UUID cannot be resolved must NOT be summarized
    # into a UUID-less row; it is skipped.
    store = _store()
    _seed_store_with_two_communities(store)
    ident = _FakeIdentity({(0, 0): "u0"})  # (0,1) is unresolved
    plan = plan_resummarization(store, ident, levels=[0], min_members=1)
    assert (0, 1) in plan["skipped_unresolved"]
    assert (0, 1) not in plan["regenerate"]
    assert (0, 1) not in plan["keep"]


def test_renumber_keeps_report_via_uuid(monkeypatch: pytest.MonkeyPatch) -> None:
    # blocker regression: a pure integer renumber (UUID unchanged) must NOT
    # destroy the report/baseline. The report relocates to the new label.
    store = _store()
    _seed_store_with_two_communities(store)
    # Round 1: communities 0 and 1 bound to u0/u1, summarized + baselined.
    ident1 = _FakeIdentity({(0, 0): "u0", (0, 1): "u1"})
    calls: list[set] = []

    async def fake_generate(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        subset = include_only or set()
        calls.append(set(subset))
        return [_report(lvl, cid, None) for (lvl, cid) in subset], {
            "llm_calls": len(subset), "prompt_tokens": 0, "completion_tokens": 0,
            "total_tokens": 0, "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", fake_generate)
    run_gated_summarization(store, ident1, run_id="run-1", levels=[0], min_members=1)

    # Round 2: a PURE renumber. The same member sets move to new integer labels
    # (cluster 0 -> 9, cluster 1 -> 8) and identity resolves each member set to
    # its ORIGINAL uuid. Membership per UUID is unchanged => keep, no LLM, and
    # reports relocate to follow their UUIDs to the new labels.
    conn = store.sql_conn
    conn.execute("UPDATE entities SET community_L0 = 9 WHERE community_L0 = 0")
    conn.execute("UPDATE facts SET community_L0 = 9 WHERE community_L0 = 0")
    conn.execute("UPDATE entities SET community_L0 = 8 WHERE community_L0 = 1")
    conn.execute("UPDATE facts SET community_L0 = 8 WHERE community_L0 = 1")
    conn.execute("DELETE FROM communities")
    conn.executemany(
        "INSERT INTO communities (id, level, node_type, member_count) VALUES (?, ?, 'mixed', 10)",
        [(community_id_from("L0", 9), "L0"), (community_id_from("L0", 8), "L0")],
    )
    conn.commit()
    ident2 = _FakeIdentity({(0, 9): "u0", (0, 8): "u1"})
    n_before = len(calls)
    res = run_gated_summarization(store, ident2, run_id="run-2", levels=[0], min_members=1)
    assert res["regenerated"] == 0
    assert res["retired"] == 0            # nothing wrongly retired on renumber
    assert len(calls) == n_before          # no LLM call
    # Both reports survive, relocated to follow their UUIDs to new labels.
    rows = dict(conn.execute(
        "SELECT community_id, community_uuid FROM community_summaries"
    ).fetchall())
    assert rows == {9: "u0", 8: "u1"}


def test_duplicate_uuid_rows_are_collapsed_not_crashed() -> None:
    # Regression (found on the FULL new_format_data corpus): historical runs can
    # leave the SAME community_uuid at two different (level, cid) rows. Parking
    # both at one staging key used to violate the (level, community_id) UNIQUE
    # constraint and abort the whole summarization run.
    store = _store()
    conn = store.sql_conn
    cs._ensure_summary_schema(store)
    for lv, cid in ((2, 93), (2, 137)):
        conn.execute(
            "INSERT INTO community_summaries (level, community_id, member_count, "
            "entity_count, fact_count, title, summary, rating, rating_explanation, "
            "findings, tags, top_members, community_uuid, summary_stale) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
            (lv, cid, 10, 5, 5, f"t{cid}", "s", 7.0, "r", "[]", "[]", "[]", "dup-uuid"),
        )
    conn.commit()
    assert conn.execute(
        "SELECT COUNT(*) FROM community_summaries WHERE community_uuid='dup-uuid'"
    ).fetchone()[0] == 2
    # Relocating the UUID must collapse the duplicates instead of raising.
    cs._relocate_kept_reports(store, [("dup-uuid", 2, 137)])
    rows = [
        (int(r[0]), int(r[1]))
        for r in conn.execute(
            "SELECT level, community_id FROM community_summaries "
            "WHERE community_uuid='dup-uuid'"
        )
    ]
    assert rows == [(2, 137)], rows


def test_upsert_moves_uuid_row_instead_of_duplicating() -> None:
    # A kept UUID that is renumbered must end up with exactly ONE row, at the new
    # label — never one row at the old label plus one at the new.
    store = _store()
    cs._ensure_summary_schema(store)
    r_old = cs.CommunityReport(
        level=0, community_id=3, member_count=10, entity_count=5, fact_count=5,
        title="t", summary="s", rating=7.0, rating_explanation="r", findings=[],
        tags=[], top_members=[], community_uuid="u-move",
    )
    cs.store_community_reports(store, [r_old])
    r_new = cs.CommunityReport(
        level=0, community_id=8, member_count=10, entity_count=5, fact_count=5,
        title="t", summary="s2", rating=7.0, rating_explanation="r", findings=[],
        tags=[], top_members=[], community_uuid="u-move",
    )
    cs.store_community_reports(store, [r_new])
    rows = [
        (int(r[0]), int(r[1]))
        for r in store.sql_conn.execute(
            "SELECT level, community_id FROM community_summaries "
            "WHERE community_uuid='u-move'"
        )
    ]
    assert rows == [(0, 8)], rows


def test_renumber_label_swap_keeps_both_reports(monkeypatch: pytest.MonkeyPatch) -> None:
    # blocker round-2 regression: a pure label SWAP (0<->1) must keep BOTH
    # reports (two-phase relocation must not clobber a live destination row).
    store = _store()
    _seed_store_with_two_communities(store)
    ident1 = _FakeIdentity({(0, 0): "u0", (0, 1): "u1"})
    calls: list[set] = []

    async def fake_generate(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        subset = include_only or set()
        calls.append(set(subset))
        return [_report(lvl, cid, None) for (lvl, cid) in subset], {
            "llm_calls": len(subset), "prompt_tokens": 0, "completion_tokens": 0,
            "total_tokens": 0, "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", fake_generate)
    run_gated_summarization(store, ident1, run_id="run-1", levels=[0], min_members=1)

    # SWAP the integer labels in the DB: cluster 0's members become label 1 and
    # vice-versa; identity resolves (0,0)->u1 and (0,1)->u0 accordingly.
    conn = store.sql_conn
    conn.execute("UPDATE entities SET community_L0 = 99 WHERE community_L0 = 0")
    conn.execute("UPDATE facts SET community_L0 = 99 WHERE community_L0 = 0")
    conn.execute("UPDATE entities SET community_L0 = 0 WHERE community_L0 = 1")
    conn.execute("UPDATE facts SET community_L0 = 0 WHERE community_L0 = 1")
    conn.execute("UPDATE entities SET community_L0 = 1 WHERE community_L0 = 99")
    conn.execute("UPDATE facts SET community_L0 = 1 WHERE community_L0 = 99")
    conn.commit()
    # After swap: label 0 holds original cluster-1 members (u1), label 1 holds
    # original cluster-0 members (u0).
    ident2 = _FakeIdentity({(0, 0): "u1", (0, 1): "u0"})
    n_before = len(calls)
    res = run_gated_summarization(store, ident2, run_id="run-2", levels=[0], min_members=1)
    assert res["regenerated"] == 0
    assert res["retired"] == 0
    assert len(calls) == n_before  # no LLM call
    rows = dict(conn.execute(
        "SELECT community_id, community_uuid FROM community_summaries"
    ).fetchall())
    # BOTH reports survive the swap, each following its UUID to the new label.
    assert rows == {0: "u1", 1: "u0"}


def test_cumulative_baseline_crosses_once() -> None:
    # baseline of 100 members; threshold 0.1 (churn). Add 8 (0.08) -> keep,
    # add 4 more cumulatively (12/100=0.12) -> regenerate ONCE at crossing.
    base = {f"e:{i}" for i in range(100)}
    t = 0.1
    after1 = base | {f"e:{i}" for i in range(100, 108)}   # +8 => 0.08
    after2 = base | {f"e:{i}" for i in range(100, 112)}   # +12 => 0.12 (cumulative vs same baseline)
    assert _change_fraction(base, after1, "churn_over_baseline") <= t
    assert _change_fraction(base, after2, "churn_over_baseline") > t


def test_below_min_is_retired() -> None:
    store = _store()
    _seed_store_with_two_communities(store)
    ident = _FakeIdentity({(0, 0): "u0", (0, 1): "u1"})
    # Pretend both were summarized before (rows exist).
    store_community_reports(store, [_report(0, 0, "u0"), _report(0, 1, "u1")])
    # Now community 1 drops below min_members (raise floor to 11 so both are
    # ineligible; but community 0 is still a summary row -> both retired).
    plan = plan_resummarization(store, ident, levels=[0], min_members=11)
    assert (0, 0) in plan["retire"]
    assert (0, 1) in plan["retire"]


# ── executor: gated run with monkeypatched generation ────────────────────────


def test_gated_run_regenerates_only_planned(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _store()
    _seed_store_with_two_communities(store)
    ident = _FakeIdentity({(0, 0): "u0", (0, 1): "u1"})

    calls: list[set] = []

    async def fake_generate(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        calls.append(set(include_only) if include_only else set())
        reports = [
            _report(0, cid, None) for (lvl, cid) in (include_only or set())
        ]
        return reports, {"llm_calls": len(reports), "prompt_tokens": 0,
                         "completion_tokens": 0, "total_tokens": 0, "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", fake_generate)

    # First run: no baselines -> both regenerate.
    res1 = run_gated_summarization(store, ident, run_id="run-1", levels=[0], min_members=1)
    assert res1["regenerated"] == 2
    assert calls[-1] == {(0, 0), (0, 1)}
    # Reports bound to UUID.
    rows = dict(store.sql_conn.execute(
        "SELECT community_id, community_uuid FROM community_summaries"
    ).fetchall())
    assert rows == {0: "u0", 1: "u1"}

    # Second run: membership unchanged -> zero regenerations (kept).
    n_calls_before = len(calls)
    res2 = run_gated_summarization(store, ident, run_id="run-2", levels=[0], min_members=1)
    assert res2["regenerated"] == 0
    assert res2["kept"] == 2
    assert len(calls) == n_calls_before  # generation was NOT invoked at all


def test_failure_keeps_old_report_and_baseline(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _store()
    _seed_store_with_two_communities(store)
    ident = _FakeIdentity({(0, 0): "u0", (0, 1): "u1"})

    # Seed an existing good report + baseline for community 0.
    good = _report(0, 0, "u0")
    good.summary = "GOOD"
    store_community_reports(store, [good])
    plan = plan_resummarization(store, ident, levels=[0], min_members=1)
    cs._advance_baseline(store, "u0", 0, plan["members_of"][(0, 0)], "run-seed")
    store.sql_conn.commit()

    # Force a big change so community 0 is planned for regeneration, but make
    # generation FAIL to produce a report for it (returns nothing).
    store.sql_conn.execute("UPDATE entities SET community_L0=0 WHERE id='e6'")  # grow c0
    store.sql_conn.commit()

    async def failing_generate(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        # Simulate every planned community failing (LLM error -> skipped).
        return [], {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0,
                    "total_tokens": 0, "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", failing_generate)
    res = run_gated_summarization(store, ident, run_id="run-2", levels=[0], min_members=1)

    # Old report survives (not wiped by the failed run).
    row = store.sql_conn.execute(
        "SELECT summary FROM community_summaries WHERE level=0 AND community_id=0"
    ).fetchone()
    assert row is not None
    assert row[0] == "GOOD"
    assert res["failed"] >= 1
    # Baseline did NOT advance (still the seeded set without e6).
    base = cs._baseline_members(store, "u0")
    assert "e:e6" not in base
