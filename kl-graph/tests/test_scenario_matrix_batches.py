"""Multi-batch scenario matrix: runner cycles + retrieval consistency.

Complements ``test_scenario_matrix.py`` (component scenarios) by driving the
REAL ``run_periodic_improvement`` repeatedly and asserting the invariants that
must hold across a sequence of production batches:

* the reconciliation run id is fresh per batch but shared with the summarizer;
* repeated batches over an unchanged partition keep uuids and skip the LLM;
* a partition that changes between batches drives regeneration;
* retrieval NEVER serves a summary whose uuid does not resolve in the newest
  run, and never hides one that does (no silent corruption, no silent loss);
* detection failing mid-batch leaves NO partial identity state for that run.

No LLM / network: detection and summarization are patched.
"""

from __future__ import annotations

import sqlite3

import pytest

from kl_graph.models.types import community_id_from
from kl_graph.periodic import runner as R
from kl_graph.periodic.community_identity import CommunityIdentity
from kl_graph.periodic.community_summarizer import _ensure_summary_schema
from kl_graph.query.global_search import GlobalSearch
from kl_graph.storage.sqlite_store import SQLiteStore


class _FakeVector:
    def close(self) -> None:
        pass


def _store() -> SQLiteStore:
    return SQLiteStore(db_path=None, conn=sqlite3.connect(":memory:"))


def _patch(
    monkeypatch: pytest.MonkeyPatch,
    assignments: dict,
    *,
    order: list[str] | None = None,
    detect_raises: bool = False,
) -> None:
    monkeypatch.setattr(R, "build_fact_similarity_edges", lambda *a, **k: 0)
    monkeypatch.setattr(R, "build_entity_similarity_edges", lambda *a, **k: 0)
    monkeypatch.setattr(R, "run_entity_disambiguation", lambda *a, **k: 0)
    monkeypatch.setattr(
        R.cfg.pipelines.experimental.communities, "enabled", True, raising=False
    )
    import kl_graph.periodic.community_detection as cd

    detection = {
        "assignments": assignments,
        "parents": {},
    }

    def fake_detect(edges, label_map):
        if order is not None:
            order.append("detect")
        if detect_raises:
            msg = "detection blew up"
            raise RuntimeError(msg)
        return detection

    monkeypatch.setattr(cd, "_build_community_graph", lambda store: ([], {}))
    monkeypatch.setattr(cd, "detect_communities_hierarchical", fake_detect)
    monkeypatch.setattr(cd, "store_communities", lambda *a, **k: None)
    monkeypatch.setattr(cd, "project_community_membership_edges", lambda *a, **k: None)


def _assign(groups: dict[int, list[str]]) -> dict:
    """Build an assignments dict for level 0 from {cluster_id: [member...]}. """
    out: dict[tuple[str, str], int] = {}
    for cid, members in groups.items():
        for m in members:
            kind, ident = m.split(":", 1)
            out[("entity" if kind == "e" else "fact", ident)] = cid
    return {0: out}


# ---------------------------------------------------------------------------
# Multi-batch runner cycles
# ---------------------------------------------------------------------------


def test_ten_batches_same_partition_keep_uuids_and_fresh_run_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ten identical batches: uuids stay stable and each batch gets a fresh run id.

    Scope note: the gate itself is faked here, so this does NOT assert LLM
    skipping — see ``test_ten_batches_through_real_gate_skips_llm`` for that.
    """
    groups = {0: [f"e:a{i}" for i in range(6)], 1: [f"f:b{i}" for i in range(6)]}
    _patch(monkeypatch, _assign(groups))
    store = _store()

    seen_runs: list[str] = []
    regen_calls: list[int] = []
    first_map: dict | None = None

    real_ci = R.CommunityIdentity

    class _Rec:
        def __init__(self, s) -> None:
            self._i = real_ci(s)

        def reconcile(self, memberships, run_id):
            seen_runs.append(run_id)
            m = self._i.reconcile(memberships, run_id)
            nonlocal first_map
            if first_map is None:
                first_map = dict(m)
            else:
                assert dict(m) == first_map, "uuids drifted across batches"
            return m

        def lineage_events_for(self, run_id):
            return self._i.lineage_events_for(run_id)

        def resolve(self, level, cid):
            return self._i.resolve(level, cid)

    monkeypatch.setattr(R, "CommunityIdentity", _Rec)

    def fake_gated(store, identity, *, run_id=None, levels=None, min_members=10,
                   max_concurrent=None, forced_uuids=None):
        regen_calls.append(1)
        return {"regenerated": 0, "kept": 2, "retired": 0, "failed": 0, "llm_stats": {}}

    monkeypatch.setattr(R, "run_gated_summarization", fake_gated)

    for _ in range(10):
        R.run_periodic_improvement(
            store=store, qdrant=_FakeVector(), run_disambiguation=False
        )

    assert len(seen_runs) == 10
    assert len(set(seen_runs)) == 10, "each batch needs its OWN run id"
    assert len(regen_calls) == 10, "the gate must be consulted every batch"


def test_changing_partition_between_batches_is_reconciled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Batch 2 with a different partition must produce new lineage events."""
    store = _store()
    events: dict[str, list[str]] = {}
    run_order: list[str] = []

    real_ci = R.CommunityIdentity

    class _Rec:
        def __init__(self, s) -> None:
            self._i = real_ci(s)

        def reconcile(self, memberships, run_id):
            m = self._i.reconcile(memberships, run_id)
            run_order.append(run_id)
            events[run_id] = [e.event_type for e in self._i.lineage_events_for(run_id)]
            return m

        def lineage_events_for(self, run_id):
            return self._i.lineage_events_for(run_id)

        def resolve(self, level, cid):
            return self._i.resolve(level, cid)

    monkeypatch.setattr(R, "CommunityIdentity", _Rec)
    monkeypatch.setattr(
        R, "run_gated_summarization",
        lambda *a, **k: {"regenerated": 0, "kept": 0, "retired": 0, "failed": 0,
                         "llm_stats": {}},
    )

    _patch(monkeypatch, _assign({0: [f"e:a{i}" for i in range(6)]}))
    R.run_periodic_improvement(store=store, qdrant=_FakeVector(), run_disambiguation=False)
    # Second batch: completely different members -> birth + death.
    _patch(monkeypatch, _assign({0: [f"e:z{i}" for i in range(6)]}))
    R.run_periodic_improvement(store=store, qdrant=_FakeVector(), run_disambiguation=False)

    # Order by ACTUAL invocation order (run ids are random uuids, not sortable).
    assert len(run_order) == 2, run_order
    second = events[run_order[1]]
    assert "birth" in second, events
    assert "death" in second, events


def test_detection_failure_before_reconcile_adds_no_identity_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Detection raising BEFORE reconciliation must add no identity rows.

    Scope note: this covers the pre-reconcile failure path only. Rollback of a
    failure *during* reconciliation is covered by
    ``tests/test_community_identity.py::test_reconcile_rolls_back_on_failure``
    and ``test_mid_reconcile_failure_leaves_no_partial_rows`` below.
    """
    store = _store()
    _patch(monkeypatch, _assign({0: ["e:a1", "e:a2"]}))
    monkeypatch.setattr(
        R, "run_gated_summarization",
        lambda *a, **k: {"regenerated": 0, "kept": 0, "retired": 0, "failed": 0,
                         "llm_stats": {}},
    )
    R.run_periodic_improvement(store=store, qdrant=_FakeVector(), run_disambiguation=False)
    before = store.sql_conn.execute(
        "SELECT COUNT(*) FROM community_identity_map"
    ).fetchone()[0]

    _patch(monkeypatch, _assign({0: ["e:a1"]}), detect_raises=True)
    with pytest.raises(RuntimeError):
        R.run_periodic_improvement(
            store=store, qdrant=_FakeVector(), run_disambiguation=False
        )
    after = store.sql_conn.execute(
        "SELECT COUNT(*) FROM community_identity_map"
    ).fetchone()[0]
    assert after == before, "failed batch must not add identity rows"


# ---------------------------------------------------------------------------
# Retrieval consistency across batches
# ---------------------------------------------------------------------------


async def _noop(*a, **k):
    return ""


def _seed_report(
    store: SQLiteStore, level: int, cid: int, uuid: str, *, stale: int = 0
) -> None:
    _ensure_summary_schema(store)
    store.sql_conn.execute(
        "INSERT OR REPLACE INTO community_summaries (level, community_id, member_count, "
        "entity_count, fact_count, title, summary, rating, rating_explanation, "
        "findings, tags, top_members, community_uuid, summary_stale) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (level, cid, 10, 5, 5, f"T{cid}", "s", 7.0, "r", "[]", "[]", "[]", uuid, stale),
    )
    store.sql_conn.execute(
        "INSERT OR REPLACE INTO communities (id, level, node_type, member_count) "
        "VALUES (?,?,?,?)",
        (community_id_from(f"L{level}", cid), f"L{level}", "mixed", 10),
    )
    store.sql_conn.commit()


def test_retrieval_serves_exactly_the_resolvable_reports() -> None:
    """Served set == reports whose uuid resolves in the NEWEST run. No more, no less."""
    store = _store()
    conn = store.sql_conn
    ident = CommunityIdentity(conn)
    # Run 1 then run 2 where cluster 1 keeps identity and cluster 2 is replaced.
    keep = {f"e:k{i}" for i in range(8)}
    gone = {f"e:g{i}" for i in range(8)}
    m1 = ident.reconcile({0: {1: keep, 2: gone}}, "r1")
    _seed_report(store, 0, 1, m1[(0, 1)])
    _seed_report(store, 0, 2, m1[(0, 2)])
    served_before = GlobalSearch(conn, acomplete=_noop)._read_all_summaries([0])
    assert len(served_before) == 2

    # Run 2: cluster 2's members are entirely replaced -> new uuid at (0,2).
    ident.reconcile({0: {1: keep, 2: {f"e:n{i}" for i in range(8)}}}, "r2")
    served_after = GlobalSearch(conn, acomplete=_noop)._read_all_summaries([0])
    # (0,1) still resolves to the same uuid; (0,2)'s stored uuid is now stale.
    assert (0, 1) in served_after
    assert (0, 2) not in served_after, "a superseded uuid must not be served"


def test_retrieval_recovers_after_reports_are_refreshed() -> None:
    """Once the new uuid is written, retrieval serves it again (no permanent loss)."""
    store = _store()
    conn = store.sql_conn
    ident = CommunityIdentity(conn)
    old = {f"e:o{i}" for i in range(8)}
    m1 = ident.reconcile({0: {1: old}}, "r1")
    _seed_report(store, 0, 1, m1[(0, 1)])
    m2 = ident.reconcile({0: {1: {f"e:p{i}" for i in range(8)}}}, "r2")
    assert not GlobalSearch(conn, acomplete=_noop)._read_all_summaries([0])
    # Refresh the report under the NEW uuid -> served again.
    _seed_report(store, 0, 1, m2[(0, 1)])
    assert (0, 1) in GlobalSearch(conn, acomplete=_noop)._read_all_summaries([0])


def test_retrieval_stays_consistent_over_many_batches() -> None:
    """Across 8 batches, everything served must always resolve in the newest run."""
    store = _store()
    conn = store.sql_conn
    ident = CommunityIdentity(conn)
    members = {f"e:m{i}" for i in range(10)}
    for b in range(8):
        # drift one member per batch
        members = {f"e:m{i}" for i in range(10 - b)} | {f"e:d{i}" for i in range(b)}
        m = ident.reconcile({0: {1: members}}, f"b{b}")
        _seed_report(store, 0, 1, m[(0, 1)])
        served = GlobalSearch(conn, acomplete=_noop)._read_all_summaries([0])
        for (lv, cid), row in served.items():
            resolved = ident.resolve(lv, cid)
            stored = row.get("community_uuid") if isinstance(row, dict) else None
            if stored is not None:
                assert stored == resolved, (b, lv, cid, stored, resolved)


# ---------------------------------------------------------------------------
# Real-gate batch cycles (no faking of the gate itself)
# ---------------------------------------------------------------------------


def test_ten_batches_through_real_gate_skips_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ten batches through the REAL gate: exactly ONE LLM generation pass.

    Only report *generation* is faked (no network); planning, baselines,
    retirement and relocation are the real implementations. Proves the gate
    actually avoids LLM work on unchanged batches.
    """
    from kl_graph.models.types import community_id_from
    from kl_graph.periodic import community_summarizer as cs

    store = _store()
    conn = store.sql_conn
    _ensure_summary_schema(store)
    members = {f"e:m{i}" for i in range(10)}
    for table in ("entities", "facts"):
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if "community_L0" not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN community_L0 INTEGER")
    for m in members:
        eid = m.split(":", 1)[1]
        conn.execute(
            "INSERT OR IGNORE INTO entities (id,name,entity_type,mention_count,"
            "community_L0) VALUES (?,?,?,1,1)",
            (eid, eid, "person"),
        )
    conn.execute(
        "INSERT OR REPLACE INTO communities (id, level, node_type, member_count) "
        "VALUES (?,?,?,?)",
        (community_id_from("L0", 1), "L0", "mixed", len(members)),
    )
    conn.commit()

    ident = CommunityIdentity(conn)
    gen_passes: list[int] = []

    async def fake_gen(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        sel = sorted(include_only or set())
        gen_passes.append(len(sel))
        reps = [
            cs.CommunityReport(
                level=lv, community_id=cid, member_count=len(members),
                entity_count=len(members), fact_count=0, title="t", summary="s",
                rating=7.0, rating_explanation="r", findings=[], tags=[],
                top_members=[], community_uuid=ident.resolve(lv, cid),
            )
            for (lv, cid) in sel
        ]
        return reps, {"llm_calls": len(reps), "prompt_tokens": 0,
                      "completion_tokens": 0, "total_tokens": 0,
                      "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", fake_gen)

    regenerated_per_batch: list[int] = []
    for b in range(10):
        ident.reconcile({0: {1: set(members)}}, f"rb{b}")
        res = cs.run_gated_summarization(
            store, ident, run_id=f"rb{b}", levels=[0], min_members=5
        )
        regenerated_per_batch.append(res["regenerated"])

    assert regenerated_per_batch[0] == 1, regenerated_per_batch
    assert sum(regenerated_per_batch) == 1, (
        f"unchanged batches must not regenerate: {regenerated_per_batch}"
    )
    # Generation was invoked with a non-empty selection exactly once.
    assert [n for n in gen_passes if n] == [1], gen_passes


def test_mid_reconcile_failure_leaves_no_partial_rows() -> None:
    """A failure PART-WAY through reconciliation must leave no rows for that run."""
    store = _store()
    conn = store.sql_conn
    ident = CommunityIdentity(conn)
    ident.reconcile({0: {1: {f"e:a{i}" for i in range(6)}}}, "ok-1")
    before_map = conn.execute(
        "SELECT COUNT(*) FROM community_identity_map"
    ).fetchone()[0]
    before_ledger = conn.execute(
        "SELECT COUNT(*) FROM community_run_level"
    ).fetchone()[0]

    class _BoomMembers:
        """Level 1 blows up AFTER level 0 has already been written."""

        def items(self):
            msg = "boom mid-reconcile"
            raise RuntimeError(msg)

    with pytest.raises(RuntimeError):
        ident.reconcile(
            {0: {1: {f"e:a{i}" for i in range(6)}}, 1: _BoomMembers()},  # type: ignore[dict-item]
            "bad-2",
        )
    assert conn.execute(
        "SELECT COUNT(*) FROM community_identity_map WHERE run_id='bad-2'"
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM community_run_level WHERE run_id='bad-2'"
    ).fetchone()[0] == 0, "ledger must roll back too"
    assert conn.execute(
        "SELECT COUNT(*) FROM community_identity_map"
    ).fetchone()[0] == before_map
    assert conn.execute(
        "SELECT COUNT(*) FROM community_run_level"
    ).fetchone()[0] == before_ledger


def test_denominator_config_changes_gate_outcome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The CONFIGURED denominator must change plan_resummarization's verdict.

    Same membership drift, two denominators, one threshold: one denominator must
    keep the report while the other regenerates it. Proves the config knob is
    honoured end to end (not just that the formula returns a number).
    """
    from kl_graph.models.types import community_id_from
    from kl_graph.periodic import community_summarizer as cs

    def build() -> tuple[SQLiteStore, object]:
        store = _store()
        conn = store.sql_conn
        _ensure_summary_schema(store)
        for table in ("entities", "facts"):
            cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
            if "community_L0" not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN community_L0 INTEGER")
        # baseline = 10 'a' members; current = 10 'a' + 5 brand-new 'z'
        cur = {f"e:a{i}" for i in range(10)} | {f"e:z{i}" for i in range(5)}
        for m in cur:
            eid = m.split(":", 1)[1]
            conn.execute(
                "INSERT OR IGNORE INTO entities (id,name,entity_type,mention_count,"
                "community_L0) VALUES (?,?,?,1,1)",
                (eid, eid, "person"),
            )
        conn.execute(
            "INSERT OR REPLACE INTO communities (id, level, node_type, member_count) "
            "VALUES (?,?,?,?)",
            (community_id_from("L0", 1), "L0", "mixed", len(cur)),
        )
        conn.execute(
            "INSERT OR REPLACE INTO community_summaries (level, community_id,"
            " member_count, entity_count, fact_count, title, summary, rating,"
            " rating_explanation, findings, tags, top_members, community_uuid,"
            " summary_stale) VALUES (0,1,15,15,0,'t','s',7.0,'r','[]','[]','[]','u1',0)"
        )
        cs._advance_baseline(store, "u1", 0, {f"e:a{i}" for i in range(10)}, "seed")
        conn.commit()

        class _I:
            def resolve(self, level, cid):
                return "u1"

        return store, _I()

    # added_over_current = 5/15 = 0.333 ; one_minus_jaccard = 1 - 10/15 = 0.333
    # added_over_baseline = 5/10 = 0.5 -> with threshold 0.4 these differ.
    outcomes: dict[str, bool] = {}
    for denom in ("added_over_current", "added_over_baseline"):
        store, ident = build()
        monkeypatch.setattr(
            cs, "_gate_config", lambda d=denom: (0.4, d), raising=True
        )
        plan = cs.plan_resummarization(store, ident, levels=[0], min_members=5)
        outcomes[denom] = (0, 1) in plan["regenerate"]
    assert outcomes["added_over_current"] is False, outcomes
    assert outcomes["added_over_baseline"] is True, outcomes


def test_immediate_retry_of_same_run_id_is_authoritative() -> None:
    """Retrying the CURRENT run id re-appends it as newest (documented contract).

    Pins the ordering semantics so a future change cannot silently make a
    superseded run authoritative without failing a test.
    """
    store = _store()
    conn = store.sql_conn
    ident = CommunityIdentity(conn)
    a = {f"e:a{i}" for i in range(8)}
    b = {f"e:b{i}" for i in range(8)}
    ident.reconcile({0: {1: a}}, "run-A")
    ident.reconcile({0: {1: b}}, "run-B")
    seqs = dict(conn.execute("SELECT run_id, seq FROM community_run_level"))
    assert seqs["run-B"] > seqs["run-A"]
    # Immediate retry of run-B keeps it newest (and does not duplicate rows).
    ident.reconcile({0: {1: b}}, "run-B")
    seqs2 = dict(conn.execute("SELECT run_id, seq FROM community_run_level"))
    assert seqs2["run-B"] > seqs2["run-A"]
    assert conn.execute(
        "SELECT COUNT(*) FROM community_run_level WHERE run_id='run-B'"
    ).fetchone()[0] == 1
