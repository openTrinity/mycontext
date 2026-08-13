"""Unit tests for stable community identity + lineage reconciliation.

Memberships are modelled as sets; assertions target stable UUIDs and lineage
state, never the ephemeral integer cluster labels. No network / LLM.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from kl_graph.periodic.community_identity import (
    EVENT_BIRTH,
    EVENT_DEATH,
    EVENT_GROW,
    EVENT_MERGE,
    EVENT_SHRINK,
    EVENT_SPLIT,
    CommunityIdentity,
    Thresholds,
    _connected_components,
    _hungarian_max_weight,
    invert_assignments,
)


@pytest.fixture
def conn() -> sqlite3.Connection:
    return sqlite3.connect(":memory:")


def _ident(conn: sqlite3.Connection) -> CommunityIdentity:
    # Explicit thresholds so the test does not depend on application config.
    default = Thresholds(min_intersection=1, jaccard=0.3, inclusion=0.5)
    return CommunityIdentity(conn, thresholds={}, default_thresholds=default)


def _event_types(events: list) -> set[str]:
    return {e.event_type for e in events}


def test_first_run_all_births(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    mapping = ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c", "e:d"}}}, "run-1")
    assert set(mapping) == {(0, 1), (0, 2)}
    assert len(set(mapping.values())) == 2  # distinct UUIDs
    assert _event_types(ident.lineage_events_for("run-1")) == {EVENT_BIRTH}


def test_renumber_identical_keeps_uuids(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    m1 = ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c", "e:d"}}}, "run-1")
    # Same member sets, DIFFERENT cluster integers (renumbered).
    m2 = ident.reconcile({0: {7: {"e:a", "e:b"}, 9: {"e:c", "e:d"}}}, "run-2")
    assert m1[(0, 1)] == m2[(0, 7)]
    assert m1[(0, 2)] == m2[(0, 9)]


def test_grow_and_shrink(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    ident.reconcile({0: {1: {"e:a", "e:b", "e:c"}}}, "run-1")
    # grow
    m2 = ident.reconcile({0: {1: {"e:a", "e:b", "e:c", "e:d"}}}, "run-2")
    assert EVENT_GROW in _event_types(ident.lineage_events_for("run-2"))
    # shrink
    ident.reconcile({0: {1: {"e:a", "e:b"}}}, "run-3")
    assert EVENT_SHRINK in _event_types(ident.lineage_events_for("run-3"))
    # UUID preserved across grow/shrink
    assert ident.resolve(0, 1) == m2[(0, 1)]


def test_split_retires_and_mints_fresh(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    m1 = ident.reconcile({0: {1: {"e:a", "e:b", "e:c", "e:d"}}}, "run-1")
    old_uuid = m1[(0, 1)]
    # One old cluster splits into two.
    m2 = ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c", "e:d"}}}, "run-2")
    events = ident.lineage_events_for("run-2")
    assert EVENT_SPLIT in _event_types(events)
    # Retire-all + mint-fresh: neither product keeps the old UUID.
    assert old_uuid not in set(m2.values())
    assert len(set(m2.values())) == 2


def test_merge_retires_and_mints_fresh(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    m1 = ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c", "e:d"}}}, "run-1")
    old_uuids = set(m1.values())
    # Two old clusters merge into one.
    m2 = ident.reconcile({0: {5: {"e:a", "e:b", "e:c", "e:d"}}}, "run-2")
    events = ident.lineage_events_for("run-2")
    assert EVENT_MERGE in _event_types(events)
    # Product is a fresh UUID, neither predecessor's.
    assert m2[(0, 5)] not in old_uuids


def test_birth_and_death(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    ident.reconcile({0: {1: {"e:a", "e:b"}}}, "run-1")
    # Cluster 1 disappears entirely (death); a brand-new community appears (birth).
    ident.reconcile({0: {2: {"e:x", "e:y"}}}, "run-2")
    types = _event_types(ident.lineage_events_for("run-2"))
    assert EVENT_DEATH in types
    assert EVENT_BIRTH in types


def test_one_old_cannot_continue_into_many(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    m1 = ident.reconcile({0: {1: {"e:a", "e:b", "e:c", "e:d"}}}, "run-1")
    old_uuid = m1[(0, 1)]
    # Old overlaps two successors -> must be a split, NOT two continuations.
    m2 = ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c", "e:d"}}}, "run-2")
    # The old UUID must not be assigned to more than one successor.
    assignees = [cid for cid, u in m2.items() if u == old_uuid]
    assert len(assignees) <= 1
    # And in retire-all policy it is assigned to none.
    assert len(assignees) == 0


def test_deterministic_tie_break(conn: sqlite3.Connection) -> None:
    # Two runs with an equal-overlap ambiguity must resolve identically.
    def run() -> dict:
        c = sqlite3.connect(":memory:")
        ident = _ident(c)
        ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c", "e:d"}}}, "run-1")
        return ident.reconcile(
            {0: {1: {"e:a", "e:c"}, 2: {"e:b", "e:d"}}}, "run-2"
        )

    r1 = run()
    r2 = run()
    # Same structural outcome (which clusters share which UUIDs) both times.
    def shape(m: dict) -> list:
        return sorted((k, sorted(v2 for k2, v2 in m.items() if v2 == v)) for k, v in m.items())

    assert shape(r1) == shape(r2)


def test_idempotent_by_run_id(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c"}}}, "run-1")
    m_first = ident.reconcile({0: {1: {"e:a", "e:b", "e:c"}}}, "run-2")
    ev_first = ident.lineage_events_for("run-2")
    # Re-run the SAME run_id: must overwrite, not append.
    m_again = ident.reconcile({0: {1: {"e:a", "e:b", "e:c"}}}, "run-2")
    ev_again = ident.lineage_events_for("run-2")
    assert m_first == m_again
    assert len(ev_first) == len(ev_again)
    # No duplicate map rows for the run.
    n = conn.execute(
        "SELECT COUNT(*) FROM community_identity_map WHERE run_id='run-2'"
    ).fetchone()[0]
    assert n == len(m_again)


def test_resolve_and_members_roundtrip(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    m = ident.reconcile({0: {3: {"e:a", "e:b"}}}, "run-1")
    u = m[(0, 3)]
    assert ident.resolve(0, 3) == u
    assert ident.current_members(u) == {"e:a", "e:b"}
    assert ident.baseline_members(u) == {"e:a", "e:b"}


def test_fingerprint_is_not_identity(conn: sqlite3.Connection) -> None:
    # A one-member change must NOT create a new identity (identity survives drift).
    ident = _ident(conn)
    m1 = ident.reconcile({0: {1: {"e:a", "e:b", "e:c"}}}, "run-1")
    m2 = ident.reconcile({0: {1: {"e:a", "e:b", "e:d"}}}, "run-2")  # swap one member
    # 2/4 Jaccard = 0.5 >= 0.3 and inclusion high -> continuation, same UUID.
    assert m1[(0, 1)] == m2[(0, 1)]


def test_invert_assignments() -> None:
    assignments = {
        0: {("entity", "a"): 1, ("entity", "b"): 1, ("fact", "a"): 2},
    }
    inv = invert_assignments(assignments)
    assert inv[0][1] == {"entity:a", "entity:b"}
    assert inv[0][2] == {"fact:a"}


def test_rejects_empty_run_id(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    with pytest.raises(ValueError):
        ident.reconcile({0: {1: {"e:a"}}}, "")


def test_run_id_with_punctuation_and_whitespace(conn: sqlite3.Connection) -> None:
    # A run_id containing whitespace / punctuation must NOT break the SAVEPOINT
    # identifier (it is a fixed name, run_id is only ever a bound parameter).
    ident = _ident(conn)
    m = ident.reconcile({0: {1: {"e:a", "e:b"}}}, "run id/1'2-\"x")
    assert m[(0, 1)]
    assert ident.resolve(0, 1) == m[(0, 1)]


def test_rejects_bad_store() -> None:
    with pytest.raises(TypeError):
        CommunityIdentity(object())


def test_per_level_reconciliation_independent(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    m1 = ident.reconcile(
        {0: {1: {"e:a", "e:b"}}, 1: {1: {"e:a"}}}, "run-1"
    )
    # Same cluster integer at different levels must be distinct identities.
    assert m1[(0, 1)] != m1[(1, 1)]


# ── review round 1: added coverage ───────────────────────────────────────────


def test_hungarian_beats_greedy_on_adversarial_weights() -> None:
    # Greedy-by-descending-weight would pick A-X (.9) then be unable to use the
    # globally better A-Y(.8)+B-X(.8)=1.6. The exact matcher must choose the
    # optimum. Profits scaled to integers.
    # rows = old {A=0, B=1}; cols = new {X=0, Y=1}
    profit = [
        [900, 800],  # A-X=.9, A-Y=.8
        [800, 0],    # B-X=.8, B-Y=none
    ]
    assignment = _hungarian_max_weight(profit)
    total = sum(profit[i][assignment[i]] for i in range(2))
    assert total == 1600  # 800 + 800, not 900 + 0


def test_connected_components_groups_many_to_many() -> None:
    # edges: old0-new0, old0-new1, old1-new1  => one component {0,1}x{0,1}
    comps = _connected_components([(0, 0), (0, 1), (1, 1)])
    assert len(comps) == 1
    assert comps[0] == ([0, 1], [0, 1])
    # disjoint edges -> two components
    comps2 = _connected_components([(0, 0), (5, 7)])
    assert len(comps2) == 2


def test_split_products_emit_birth_events(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    ident.reconcile({0: {1: {"e:a", "e:b", "e:c", "e:d"}}}, "run-1")
    ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c", "e:d"}}}, "run-2")
    events = ident.lineage_events_for("run-2")
    types = [e.event_type for e in events]
    # Every structural product is a birth: exactly two birth events here.
    assert types.count(EVENT_BIRTH) == 2
    assert EVENT_SPLIT in types


def test_merge_products_emit_birth_events(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c", "e:d"}}}, "run-1")
    ident.reconcile({0: {5: {"e:a", "e:b", "e:c", "e:d"}}}, "run-2")
    events = ident.lineage_events_for("run-2")
    types = [e.event_type for e in events]
    assert types.count(EVENT_BIRTH) == 1  # single merge product is one birth
    assert EVENT_MERGE in types


def test_many_to_many_preserves_full_predecessor_lineage(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    # old1 = {a,b,c,d}, old2 = {e,f,g,h}
    ident.reconcile(
        {0: {1: {"e:a", "e:b", "e:c", "e:d"}, 2: {"e:e", "e:f", "e:g", "e:h"}}},
        "run-1",
    )
    # Products each mix members from BOTH predecessors so all four cross-edges
    # qualify -> one connected many-to-many component.
    m2 = ident.reconcile(
        {0: {10: {"e:a", "e:b", "e:e", "e:f"}, 11: {"e:c", "e:d", "e:g", "e:h"}}},
        "run-2",
    )
    # Each product records BOTH predecessors in split_from (full lineage).
    for cid in (10, 11):
        u = m2[(0, cid)]
        row = conn.execute(
            "SELECT split_from FROM community_identity WHERE community_uuid = ?", (u,)
        ).fetchone()
        preds = json.loads(row[0]) if row[0] else []
        assert len(preds) == 2  # both predecessors preserved


def test_reconcile_rolls_back_on_failure(conn: sqlite3.Connection) -> None:
    ident = _ident(conn)
    ident.reconcile({0: {1: {"e:a", "e:b"}}}, "run-1")
    # Force a failure midway through run-2 by passing a members object that
    # blows up during iteration AFTER purge would have run.
    class _Boom:
        def items(self):
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        ident.reconcile({0: _Boom()}, "run-2")  # type: ignore[dict-item]
    # run-1 data must be fully intact (no partial residue from the failed run-2).
    n_map = conn.execute(
        "SELECT COUNT(*) FROM community_identity_map WHERE run_id='run-1'"
    ).fetchone()[0]
    assert n_map == 1
    n_run2 = conn.execute(
        "SELECT COUNT(*) FROM community_identity_map WHERE run_id='run-2'"
    ).fetchone()[0]
    assert n_run2 == 0


def test_empty_partition_kills_prior_communities(conn: sqlite3.Connection) -> None:
    # A subsequent run with an EMPTY partition must reconcile prior communities
    # into DEATHS (not leave them active), even though no level is supplied.
    ident = _ident(conn)
    m1 = ident.reconcile({0: {1: {"e:a", "e:b"}, 2: {"e:c", "e:d"}}}, "run-1")
    ident.reconcile({}, "run-2")  # empty partition
    events = ident.lineage_events_for("run-2")
    types = [e.event_type for e in events]
    assert types.count(EVENT_DEATH) == 2  # both prior communities died
    # Their identity rows are now dead/retired, not active.
    for u in m1.values():
        status = conn.execute(
            "SELECT status FROM community_identity WHERE community_uuid = ?", (u,)
        ).fetchone()[0]
        assert status != "active"


def test_reconcile_savepoint_preserves_enclosing_transaction(
    conn: sqlite3.Connection,
) -> None:
    # When the caller already holds a transaction, reconcile must use a
    # savepoint and neither commit nor roll back the caller's work.
    ident = _ident(conn)
    conn.execute("BEGIN")
    conn.execute(
        "CREATE TABLE caller_marker (x INTEGER)"
    )
    conn.execute("INSERT INTO caller_marker VALUES (42)")
    ident.reconcile({0: {1: {"e:a", "e:b"}}}, "run-1")  # nested savepoint
    # Caller's uncommitted work is still present (reconcile did not commit it
    # away or roll it back).
    assert conn.execute("SELECT x FROM caller_marker").fetchone()[0] == 42
    conn.rollback()  # caller aborts -> BOTH caller marker and run-1 vanish
    assert conn.execute(
        "SELECT COUNT(*) FROM community_identity_map"
    ).fetchone()[0] == 0
