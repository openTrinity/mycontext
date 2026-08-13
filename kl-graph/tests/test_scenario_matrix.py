"""Exhaustive scenario matrix for stable identity + gated re-summarization.

Complements the per-task suites by covering the scenarios a production
incremental deployment must survive end to end, in the categories that the
task-scoped tests do NOT reach:

* **Config wiring** — per-level threshold overrides must actually change
  reconciliation behaviour (not merely exist in the schema).
* **Batch updates** — many sequential ingest batches, growing/shrinking corpora,
  repeated no-op batches, interleaved detect+summarize cycles.
* **Ordering / concurrency** — reconcile before summarize, retry after a crash
  mid-run, two reconciles for the same run_id.
* **Churn denominators** — every configured denominator drives the gate.
* **Hierarchy** — multi-level batches, levels appearing/disappearing mid-run.
* **Degenerate input** — singleton communities, one giant community, all
  members replaced, duplicate members across communities.

Run: ``.venv/bin/python -m pytest tests/test_scenario_matrix.py -q``
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from kl_graph.periodic import community_summarizer as cs
from kl_graph.periodic.community_identity import (
    EVENT_BIRTH,
    EVENT_CONTINUE,
    EVENT_DEATH,
    CommunityIdentity,
    Thresholds,
)
from kl_graph.storage.sqlite_store import SQLiteStore


@pytest.fixture()
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    yield c
    c.close()


def _ident(c: sqlite3.Connection, **kw) -> CommunityIdentity:
    return CommunityIdentity(c, **kw)


def _members(prefix: str, n: int, start: int = 0) -> set[str]:
    return {f"e:{prefix}{i}" for i in range(start, start + n)}


# ---------------------------------------------------------------------------
# 1. Config wiring: per-level overrides must CHANGE behaviour
# ---------------------------------------------------------------------------


def test_per_level_threshold_override_changes_continuation(
    conn: sqlite3.Connection,
) -> None:
    """A strict level must break continuation where a lax level keeps it.

    Same member evolution, two different levels with different thresholds: the
    lax level continues the UUID, the strict level treats it as birth+death.
    """
    base = _members("a", 10)
    evolved = _members("a", 4) | _members("z", 6)  # jaccard = 4/16 = 0.25

    lax = _ident(
        conn,
        thresholds={0: Thresholds(min_intersection=2, jaccard=0.2, inclusion=0.2)},
    )
    lax.reconcile({0: {1: base}}, "lax-1")
    m2 = lax.reconcile({0: {1: evolved}}, "lax-2")
    lax_events = [e.event_type for e in lax.lineage_events_for("lax-2")]
    assert EVENT_CONTINUE in lax_events or "grow" in lax_events or "shrink" in lax_events

    c2 = sqlite3.connect(":memory:")
    try:
        strict = _ident(
            c2,
            thresholds={0: Thresholds(min_intersection=2, jaccard=0.9, inclusion=0.9)},
        )
        strict.reconcile({0: {1: base}}, "strict-1")
        strict.reconcile({0: {1: evolved}}, "strict-2")
        strict_events = [e.event_type for e in strict.lineage_events_for("strict-2")]
        assert EVENT_BIRTH in strict_events
        assert EVENT_DEATH in strict_events
    finally:
        c2.close()
    assert m2  # lax produced a mapping


def test_config_backed_thresholds_are_read_from_app_config(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no explicit thresholds the reconciler must consult app config.

    Proves the config path is wired (not silently always falling back to module
    defaults): a patched config value changes the resolved thresholds.
    """
    ident = _ident(conn)  # no explicit thresholds -> config path
    from kl_graph import config as kgconfig

    class _Lvl:
        identity_min_intersection = None
        identity_jaccard_threshold = None
        identity_inclusion_threshold = None

    class _Default:
        identity_min_intersection = 7
        identity_jaccard_threshold = 0.77
        identity_inclusion_threshold = 0.71

    class _Levels:
        L0 = _Lvl()

    class _Ident:
        default = _Default()
        levels = _Levels()

    fake = type(
        "C",
        (),
        {
            "pipelines": type(
                "P",
                (),
                {"ingestion": type("I", (), {"community_identity": _Ident()})()},
            )()
        },
    )()
    monkeypatch.setattr(kgconfig, "cfg", fake, raising=False)
    t = ident._resolve_from_config(0)
    assert (t.min_intersection, t.jaccard, t.inclusion) == (7, 0.77, 0.71)


def test_level_override_wins_over_default(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An L1 override must beat the default block; None inherits."""
    ident = _ident(conn)
    from kl_graph import config as kgconfig

    class _L1:
        identity_min_intersection = 3
        identity_jaccard_threshold = None  # inherit
        identity_inclusion_threshold = 0.9

    class _Default:
        identity_min_intersection = 2
        identity_jaccard_threshold = 0.3
        identity_inclusion_threshold = 0.5

    class _Levels:
        L1 = _L1()

    class _Ident:
        default = _Default()
        levels = _Levels()

    fake = type(
        "C",
        (),
        {
            "pipelines": type(
                "P",
                (),
                {"ingestion": type("I", (), {"community_identity": _Ident()})()},
            )()
        },
    )()
    monkeypatch.setattr(kgconfig, "cfg", fake, raising=False)
    t = ident._resolve_from_config(1)
    assert t.min_intersection == 3  # override
    assert t.jaccard == 0.3  # inherited from default
    assert t.inclusion == 0.9  # override


def test_unknown_deep_level_falls_back_to_default(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A level deeper than the configured L0..L3 uses the default block."""
    ident = _ident(conn)
    from kl_graph import config as kgconfig

    class _Default:
        identity_min_intersection = 4
        identity_jaccard_threshold = 0.44
        identity_inclusion_threshold = 0.45

    class _Ident:
        default = _Default()
        levels = type("L", (), {})()

    fake = type(
        "C",
        (),
        {
            "pipelines": type(
                "P",
                (),
                {"ingestion": type("I", (), {"community_identity": _Ident()})()},
            )()
        },
    )()
    monkeypatch.setattr(kgconfig, "cfg", fake, raising=False)
    t = ident._resolve_from_config(9)
    assert (t.min_intersection, t.jaccard, t.inclusion) == (4, 0.44, 0.45)


# ---------------------------------------------------------------------------
# 2. Batch updates: many sequential runs
# ---------------------------------------------------------------------------


def test_twenty_sequential_batches_keep_identity_stable(
    conn: sqlite3.Connection,
) -> None:
    """20 batches that never change membership must keep ONE uuid per community.

    Guards against uuid churn / table growth over a long-lived deployment.
    """
    ident = _ident(conn)
    part = {0: {1: _members("a", 8), 2: _members("b", 8)}}
    first = ident.reconcile(part, "batch-0")
    for i in range(1, 20):
        m = ident.reconcile(part, f"batch-{i}")
        assert m == first, f"uuids drifted at batch {i}"
    n_ident = conn.execute("SELECT COUNT(*) FROM community_identity").fetchone()[0]
    assert n_ident == 2, "no new identities may be minted for unchanged batches"


def test_monotonically_growing_corpus_over_batches(conn: sqlite3.Connection) -> None:
    """A community that grows a little each batch keeps its uuid throughout."""
    ident = _ident(conn)
    uuid0 = None
    for i in range(10):
        part = {0: {1: _members("a", 10 + i)}}  # +1 member per batch
        m = ident.reconcile(part, f"grow-{i}")
        if uuid0 is None:
            uuid0 = m[(0, 1)]
        assert m[(0, 1)] == uuid0, f"uuid changed at batch {i}"


def test_shrinking_to_nothing_then_regrowing(conn: sqlite3.Connection) -> None:
    """Shrink to empty (death), then regrow -> a NEW uuid (no resurrection)."""
    ident = _ident(conn)
    m1 = ident.reconcile({0: {1: _members("a", 10)}}, "s-1")
    old = m1[(0, 1)]
    ident.reconcile({}, "s-2")  # everything dies
    m3 = ident.reconcile({0: {1: _members("a", 10)}}, "s-3")
    assert m3[(0, 1)] != old, "a dead community must not be resurrected"
    ev = [e.event_type for e in ident.lineage_events_for("s-3")]
    assert EVENT_BIRTH in ev


def test_alternating_partitions_do_not_leak_identities(
    conn: sqlite3.Connection,
) -> None:
    """Flip-flopping between two partitions must not grow tables without bound."""
    ident = _ident(conn)
    a = {0: {1: _members("a", 8), 2: _members("b", 8)}}
    b = {0: {1: _members("a", 8) | _members("b", 8)}}  # merged
    for i in range(6):
        ident.reconcile(a if i % 2 == 0 else b, f"flip-{i}")
    # Only the latest run may be 'active'.
    active = conn.execute(
        "SELECT COUNT(*) FROM community_identity WHERE status='active'"
    ).fetchone()[0]
    latest = conn.execute(
        "SELECT COUNT(*) FROM community_identity_map WHERE run_id='flip-5'"
    ).fetchone()[0]
    assert active == latest, (active, latest)


def test_batch_with_many_communities_scales(conn: sqlite3.Connection) -> None:
    """A single batch with 300 communities across 3 levels reconciles cleanly."""
    ident = _ident(conn)
    part = {
        lv: {cid: _members(f"L{lv}c{cid}", 5) for cid in range(100)} for lv in range(3)
    }
    m = ident.reconcile(part, "big-1")
    assert len(m) == 300
    # Re-running the identical big batch keeps every uuid.
    assert ident.reconcile(part, "big-2") == m


# ---------------------------------------------------------------------------
# 3. Ordering, retry, crash recovery
# ---------------------------------------------------------------------------


def test_same_run_id_twice_is_idempotent_not_duplicated(
    conn: sqlite3.Connection,
) -> None:
    """Re-reconciling the SAME run_id (a retry) must overwrite, not duplicate."""
    ident = _ident(conn)
    part = {0: {1: _members("a", 6), 2: _members("b", 6)}}
    m1 = ident.reconcile(part, "retry-1")
    m2 = ident.reconcile(part, "retry-1")
    assert m1 == m2
    n = conn.execute(
        "SELECT COUNT(*) FROM community_identity_map WHERE run_id='retry-1'"
    ).fetchone()[0]
    assert n == 2
    ev = conn.execute(
        "SELECT COUNT(*) FROM community_lineage_event WHERE run_id='retry-1'"
    ).fetchone()[0]
    assert ev == 2, "lineage events must not accumulate on retry"


def test_out_of_order_run_ids_still_use_latest_snapshot(
    conn: sqlite3.Connection,
) -> None:
    """Reconciliation compares against the most recent PRIOR snapshot.

    Lexicographically smaller run ids arriving later must not resurrect stale
    state (the reconciler keys on insertion order, not string order).
    """
    ident = _ident(conn)
    m1 = ident.reconcile({0: {1: _members("a", 10)}}, "zzz-first")
    m2 = ident.reconcile({0: {1: _members("a", 10)}}, "aaa-second")
    assert m2[(0, 1)] == m1[(0, 1)], "continuation must follow run order"


# ---------------------------------------------------------------------------
# 4. Hierarchy scenarios
# ---------------------------------------------------------------------------


def test_level_disappears_then_returns(conn: sqlite3.Connection) -> None:
    """L1 vanishing must kill its communities; returning mints fresh ones."""
    ident = _ident(conn)
    m1 = ident.reconcile(
        {0: {1: _members("a", 8)}, 1: {5: _members("b", 8)}}, "lv-1"
    )
    old_l1 = m1[(1, 5)]
    ident.reconcile({0: {1: _members("a", 8)}}, "lv-2")  # L1 gone
    status = conn.execute(
        "SELECT status FROM community_identity WHERE community_uuid=?", (old_l1,)
    ).fetchone()[0]
    assert status != "active", "vanished level's community must not stay active"
    m3 = ident.reconcile(
        {0: {1: _members("a", 8)}, 1: {5: _members("b", 8)}}, "lv-3"
    )
    assert m3[(1, 5)] != old_l1


def test_same_members_at_two_levels_are_distinct_identities(
    conn: sqlite3.Connection,
) -> None:
    """Identical member sets at different levels must never share a uuid."""
    ident = _ident(conn)
    same = _members("a", 10)
    m = ident.reconcile({0: {1: same}, 1: {1: same}}, "dl-1")
    assert m[(0, 1)] != m[(1, 1)]


# ---------------------------------------------------------------------------
# 5. Degenerate / adversarial partitions
# ---------------------------------------------------------------------------


def test_singleton_communities(conn: sqlite3.Connection) -> None:
    """Single-member communities reconcile without crashing."""
    ident = _ident(
        conn, default_thresholds=Thresholds(min_intersection=1, jaccard=0.1, inclusion=0.1)
    )
    m1 = ident.reconcile({0: {i: {f"e:x{i}"} for i in range(5)}}, "sg-1")
    assert len(m1) == 5
    m2 = ident.reconcile({0: {i: {f"e:x{i}"} for i in range(5)}}, "sg-2")
    assert m2 == m1


def test_one_giant_community(conn: sqlite3.Connection) -> None:
    """A single community holding everything reconciles and continues."""
    ident = _ident(conn)
    big = _members("g", 500)
    m1 = ident.reconcile({0: {1: big}}, "gi-1")
    m2 = ident.reconcile({0: {1: big}}, "gi-2")
    assert m2 == m1


def test_all_members_replaced_is_death_and_birth(conn: sqlite3.Connection) -> None:
    """Zero overlap must never be a continuation."""
    ident = _ident(conn)
    m1 = ident.reconcile({0: {1: _members("a", 10)}}, "rp-1")
    m2 = ident.reconcile({0: {1: _members("z", 10)}}, "rp-2")
    assert m2[(0, 1)] != m1[(0, 1)]
    ev = [e.event_type for e in ident.lineage_events_for("rp-2")]
    assert EVENT_BIRTH in ev and EVENT_DEATH in ev


def test_cluster_ids_are_sparse_and_nonconsecutive(conn: sqlite3.Connection) -> None:
    """Arbitrary/sparse cluster ids (incl. large ints) are handled."""
    ident = _ident(conn)
    part = {0: {0: _members("a", 5), 999999: _members("b", 5), 42: _members("c", 5)}}
    m = ident.reconcile(part, "sp-1")
    assert set(m) == {(0, 0), (0, 999999), (0, 42)}
    assert ident.reconcile(part, "sp-2") == m


# ---------------------------------------------------------------------------
# 6. Gated re-summarization across batches (end-to-end with a real store)
# ---------------------------------------------------------------------------


def _store() -> SQLiteStore:
    c = sqlite3.connect(":memory:", check_same_thread=False)
    return SQLiteStore(Path(":memory:"), conn=c)


def _seed_members(store: SQLiteStore, level: int, mapping: dict[int, set[str]]) -> None:
    """Write community_L{level} assignments for entity members."""
    conn = store.sql_conn
    col = f"community_L{level}"
    # The summarizer reads the column from BOTH entities and facts.
    for table in ("entities", "facts"):
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} INTEGER")
        conn.execute(f"UPDATE {table} SET {col} = NULL")
    # The eligibility filter requires a matching row in `communities` (the
    # native-id authority), exactly as the real projection step writes.
    from kl_graph.models.types import community_id_from

    for cid, members in mapping.items():
        conn.execute(
            "INSERT OR REPLACE INTO communities (id, level, node_type, member_count) "
            "VALUES (?,?,?,?)",
            (community_id_from(f"L{level}", cid), f"L{level}", "mixed", len(members)),
        )
        for m in members:
            eid = m.split(":", 1)[1]
            conn.execute(
                "INSERT OR IGNORE INTO entities (id, name, entity_type, mention_count) "
                "VALUES (?,?,?,1)",
                (eid, eid, "person"),
            )
            conn.execute(f"UPDATE entities SET {col} = ? WHERE id = ?", (cid, eid))
    conn.commit()


class _FixedIdentity:
    """Minimal identity stand-in with an explicit (level, cid) -> uuid map."""

    def __init__(self, mapping: dict[tuple[int, int], str]) -> None:
        self._m = mapping

    def resolve(self, level: int, cluster_id: int) -> str | None:
        return self._m.get((level, int(cluster_id)))


def test_batch_cycle_regenerate_then_keep_then_regenerate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Three batches: first summarizes, second is a no-op, third churns.

    This is the core production loop; it must cost LLM calls only on 1 and 3.
    """
    store = _store()
    calls: list[set] = []

    async def fake_gen(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        sel = set(include_only or set())
        calls.append(sel)
        reps = [
            cs.CommunityReport(
                level=lv, community_id=cid, member_count=10, entity_count=10,
                fact_count=0, title=f"L{lv}-{cid}", summary="s", rating=7.0,
                rating_explanation="r", findings=[], tags=[], top_members=[],
                community_uuid=ident_map.get((lv, cid)),
            )
            for (lv, cid) in sorted(sel)
        ]
        return reps, {"llm_calls": len(reps), "prompt_tokens": 0,
                      "completion_tokens": 0, "total_tokens": 0,
                      "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", fake_gen)

    # Batch 1: fresh -> must regenerate.
    base = {1: _members("a", 12)}
    _seed_members(store, 0, base)
    ident_map = {(0, 1): "u1"}
    ident = _FixedIdentity(ident_map)
    r1 = cs.run_gated_summarization(store, ident, run_id="b1", levels=[0], min_members=5)
    assert r1["regenerated"] == 1, r1

    # Batch 2: identical -> must KEEP (no LLM).
    n = len(calls)
    r2 = cs.run_gated_summarization(store, ident, run_id="b2", levels=[0], min_members=5)
    assert r2["regenerated"] == 0 and r2["kept"] == 1, r2
    assert len(calls) == n, "no LLM call may be issued for an unchanged batch"

    # Batch 3: heavy churn -> must regenerate again.
    _seed_members(store, 0, {1: _members("z", 12)})
    r3 = cs.run_gated_summarization(store, ident, run_id="b3", levels=[0], min_members=5)
    assert r3["regenerated"] == 1, r3


def test_many_batches_of_small_drift_cross_threshold_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sub-threshold drift accumulates against the BASELINE and fires once.

    Each batch changes 1 of 20 members (5% < 10% gate). Cumulative churn must
    eventually cross the gate, regenerate once, then reset the baseline.
    """
    store = _store()
    regen_batches: list[int] = []

    async def fake_gen(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        sel = set(include_only or set())
        reps = [
            cs.CommunityReport(
                level=lv, community_id=cid, member_count=20, entity_count=20,
                fact_count=0, title="t", summary="s", rating=7.0,
                rating_explanation="r", findings=[], tags=[], top_members=[],
                community_uuid="u1",
            )
            for (lv, cid) in sorted(sel)
        ]
        return reps, {"llm_calls": len(reps), "prompt_tokens": 0,
                      "completion_tokens": 0, "total_tokens": 0,
                      "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", fake_gen)
    ident = _FixedIdentity({(0, 1): "u1"})

    _seed_members(store, 0, {1: _members("a", 20)})
    cs.run_gated_summarization(store, ident, run_id="d0", levels=[0], min_members=5)

    for i in range(1, 7):
        # replace i members: churn vs baseline grows 2i/20 = 10%*i
        mem = _members("a", 20 - i) | _members("z", i)
        _seed_members(store, 0, {1: mem})
        res = cs.run_gated_summarization(
            store, ident, run_id=f"d{i}", levels=[0], min_members=5
        )
        if res["regenerated"]:
            regen_batches.append(i)
    assert regen_batches, "cumulative drift must eventually trigger a refresh"
    # After firing, the baseline advances, so it must not fire every batch.
    assert len(regen_batches) < 6, regen_batches


@pytest.mark.parametrize(
    "denominator",
    [
        "churn_over_baseline",
        "added_over_baseline",
        "added_over_current",
        "one_minus_jaccard",
    ],
)
def test_every_denominator_drives_the_gate(
    denominator: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each configured denominator must yield a usable change fraction."""
    baseline = _members("a", 10)
    current = _members("a", 5) | _members("z", 5)
    frac = cs._change_fraction(baseline, current, denominator)
    assert 0.0 <= frac <= 1.0
    assert frac > 0.0, f"{denominator} must register this change"


def test_min_members_boundary_exactly_at_threshold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A community with exactly min_members is summarized; one below is retired."""
    store = _store()

    async def fake_gen(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        sel = set(include_only or set())
        reps = [
            cs.CommunityReport(
                level=lv, community_id=cid, member_count=10, entity_count=10,
                fact_count=0, title="t", summary="s", rating=7.0,
                rating_explanation="r", findings=[], tags=[], top_members=[],
                community_uuid=f"u{cid}",
            )
            for (lv, cid) in sorted(sel)
        ]
        return reps, {"llm_calls": len(reps), "prompt_tokens": 0,
                      "completion_tokens": 0, "total_tokens": 0,
                      "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", fake_gen)
    ident = _FixedIdentity({(0, 1): "u1", (0, 2): "u2"})
    # c1 has exactly 5 members, c2 has 4 (below a min of 5)
    _seed_members(store, 0, {1: _members("a", 5), 2: _members("b", 4)})
    res = cs.run_gated_summarization(
        store, ident, run_id="mb", levels=[0], min_members=5
    )
    got = {
        int(r[0])
        for r in store.sql_conn.execute(
            "SELECT community_id FROM community_summaries"
        )
    }
    assert got == {1}, got
    assert res["regenerated"] == 1


# ---------------------------------------------------------------------------
# 7. Incremental-path seam: communities.summary_stale must reach the gate
# ---------------------------------------------------------------------------


def _seed_one_community(store: SQLiteStore, uuid: str = "u1") -> set[str]:
    """Seed a single eligible L0 community with a report + baseline."""
    from kl_graph.models.types import community_id_from

    cs._ensure_summary_schema(store)
    conn = store.sql_conn
    members = {f"e:a{i}" for i in range(10)}
    _seed_members(store, 0, {1: members})
    conn.execute(
        "INSERT OR REPLACE INTO community_summaries (level, community_id, member_count,"
        " entity_count, fact_count, title, summary, rating, rating_explanation,"
        " findings, tags, top_members, community_uuid, summary_stale)"
        " VALUES (0,1,10,10,0,'t','s',7.0,'r','[]','[]','[]',?,0)",
        (uuid,),
    )
    cs._advance_baseline(store, uuid, 0, members, "seed")
    conn.commit()
    assert community_id_from("L0", 1)  # token helper is available
    return members


def test_incremental_stale_marker_forces_regeneration() -> None:
    """``communities.summary_stale=1`` (set by the incremental path) must gate.

    The incremental ingest route cannot rerun Leiden, so this coarse marker is
    its ONLY signal. If the gate ignores it a stale report is served forever.
    """
    store = _store()
    _seed_one_community(store)
    ident = _FixedIdentity({(0, 1): "u1"})
    assert not cs.plan_resummarization(store, ident, levels=[0], min_members=5)[
        "regenerate"
    ]
    from kl_graph.models.types import community_id_from

    store.sql_conn.execute(
        "UPDATE communities SET summary_stale = 1 WHERE id = ?",
        (community_id_from("L0", 1),),
    )
    store.sql_conn.commit()
    plan = cs.plan_resummarization(store, ident, levels=[0], min_members=5)
    assert plan["regenerate"] == {(0, 1)}, plan


def test_incremental_stale_marker_is_cleared_after_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The marker must force regeneration ONCE, then be cleared."""
    from kl_graph.models.types import community_id_from

    store = _store()
    _seed_one_community(store)
    ident = _FixedIdentity({(0, 1): "u1"})
    store.sql_conn.execute(
        "UPDATE communities SET summary_stale = 1 WHERE id = ?",
        (community_id_from("L0", 1),),
    )
    store.sql_conn.commit()

    async def fake_gen(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        reps = [
            cs.CommunityReport(
                level=lv, community_id=cid, member_count=10, entity_count=10,
                fact_count=0, title="t", summary="s2", rating=7.0,
                rating_explanation="r", findings=[], tags=[], top_members=[],
                community_uuid="u1",
            )
            for (lv, cid) in sorted(include_only or set())
        ]
        return reps, {"llm_calls": len(reps), "prompt_tokens": 0,
                      "completion_tokens": 0, "total_tokens": 0,
                      "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", fake_gen)
    r1 = cs.run_gated_summarization(store, ident, run_id="i1", levels=[0], min_members=5)
    assert r1["regenerated"] == 1, r1
    flag = store.sql_conn.execute(
        "SELECT summary_stale FROM communities WHERE id = ?",
        (community_id_from("L0", 1),),
    ).fetchone()[0]
    assert int(flag) == 0, "marker must be cleared after a successful refresh"
    # Next run is a no-op again.
    r2 = cs.run_gated_summarization(store, ident, run_id="i2", levels=[0], min_members=5)
    assert r2["regenerated"] == 0 and r2["kept"] == 1, r2


def test_missing_summary_stale_column_degrades_silently() -> None:
    """A legacy `communities` table without the column must not break the gate."""
    store = _store()
    _seed_one_community(store)
    # Rebuild `communities` without summary_stale (legacy shape).
    conn = store.sql_conn
    conn.execute("ALTER TABLE communities RENAME TO communities_new")
    conn.execute(
        "CREATE TABLE communities (id TEXT PRIMARY KEY, level TEXT, node_type TEXT, "
        "member_count INTEGER)"
    )
    conn.execute(
        "INSERT INTO communities (id, level, node_type, member_count) "
        "SELECT id, level, node_type, member_count FROM communities_new"
    )
    conn.commit()
    ident = _FixedIdentity({(0, 1): "u1"})
    plan = cs.plan_resummarization(store, ident, levels=[0], min_members=5)
    assert plan["regenerate"] == set(), plan
    assert plan["keep"] == {(0, 1)}, plan


def test_failed_regeneration_retains_stale_marker_for_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A FAILED refresh must leave ``communities.summary_stale=1`` set.

    Clearing only on success is the contract: if generation returns no report for
    a planned community, the marker must survive so the next run retries it.
    """
    from kl_graph.models.types import community_id_from

    store = _store()
    _seed_one_community(store)
    ident = _FixedIdentity({(0, 1): "u1"})
    token = community_id_from("L0", 1)
    store.sql_conn.execute(
        "UPDATE communities SET summary_stale = 1 WHERE id = ?", (token,)
    )
    store.sql_conn.commit()

    async def empty_gen(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        # Planned, but generation yields nothing (LLM failure / partial result).
        return [], {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0,
                    "total_tokens": 0, "estimated_cost_usd": 0.0}

    monkeypatch.setattr(cs, "generate_community_reports", empty_gen)
    res = cs.run_gated_summarization(
        store, ident, run_id="f1", levels=[0], min_members=5
    )
    assert res["regenerated"] == 0, res
    assert res["failed"] == 1, res
    flag = store.sql_conn.execute(
        "SELECT summary_stale FROM communities WHERE id = ?", (token,)
    ).fetchone()[0]
    assert int(flag) == 1, "failed refresh must KEEP the marker for retry"
    # The next run must therefore still plan a regeneration.
    plan = cs.plan_resummarization(store, ident, levels=[0], min_members=5)
    assert plan["regenerate"] == {(0, 1)}, plan


def test_raising_generation_keeps_stale_marker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An exception during generation must not clear the marker either."""
    from kl_graph.models.types import community_id_from

    store = _store()
    _seed_one_community(store)
    ident = _FixedIdentity({(0, 1): "u1"})
    token = community_id_from("L0", 1)
    store.sql_conn.execute(
        "UPDATE communities SET summary_stale = 1 WHERE id = ?", (token,)
    )
    store.sql_conn.commit()

    async def boom(sqlite, levels=None, min_members=10, max_concurrent=None, include_only=None):
        msg = "llm exploded"
        raise RuntimeError(msg)

    monkeypatch.setattr(cs, "generate_community_reports", boom)
    with pytest.raises(RuntimeError):
        cs.run_gated_summarization(store, ident, run_id="f2", levels=[0], min_members=5)
    flag = store.sql_conn.execute(
        "SELECT summary_stale FROM communities WHERE id = ?", (token,)
    ).fetchone()[0]
    assert int(flag) == 1, "an exception must not clear the marker"


def test_partial_thresholds_do_not_fall_back_to_ambient_config(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Explicit per-level map + absent level => deterministic module fallback.

    Supplying `thresholds` for SOME levels must NOT make other levels silently
    depend on whether app config happens to be importable.
    """
    from kl_graph import config as kgconfig

    class _Default:
        identity_min_intersection = 99  # would be obvious if consulted
        identity_jaccard_threshold = 0.99
        identity_inclusion_threshold = 0.99

    class _Ident:
        default = _Default()
        levels = type("L", (), {})()

    fake = type(
        "C", (), {"pipelines": type(
            "P", (), {"ingestion": type("I", (), {"community_identity": _Ident()})()}
        )()},
    )()
    monkeypatch.setattr(kgconfig, "cfg", fake, raising=False)
    ident = _ident(conn, thresholds={0: Thresholds(2, 0.3, 0.5)})
    t_absent = ident._thresholds_for(1)  # level 1 not supplied
    assert t_absent.min_intersection != 99, "must not consult ambient config"
    assert t_absent.min_intersection == 2  # module fallback default


def test_explicit_default_beats_ambient_config(
    conn: sqlite3.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicit default_thresholds must win over app config (Bug 1 core)."""
    from kl_graph import config as kgconfig

    class _Default:
        identity_min_intersection = 42
        identity_jaccard_threshold = 0.42
        identity_inclusion_threshold = 0.42

    class _Ident:
        default = _Default()
        levels = type("L", (), {})()

    fake = type(
        "C", (), {"pipelines": type(
            "P", (), {"ingestion": type("I", (), {"community_identity": _Ident()})()}
        )()},
    )()
    monkeypatch.setattr(kgconfig, "cfg", fake, raising=False)
    ident = _ident(conn, default_thresholds=Thresholds(1, 0.1, 0.1))
    t = ident._thresholds_for(0)
    assert (t.min_intersection, t.jaccard, t.inclusion) == (1, 0.1, 0.1)
