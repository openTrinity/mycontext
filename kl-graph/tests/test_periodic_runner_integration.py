"""Runner-level integration tests for periodic improvement wiring (Task 5).

Drives ``run_periodic_improvement`` with fakes for detection + summarization to
verify the mandated ordering (detect -> store -> project -> reconcile -> gated
summarize), that an EMPTY partition still reconciles, that the gated summarizer
is preferred, and that the reconciliation run id is retry-stable. No LLM/network.
"""

from __future__ import annotations

import sqlite3

import pytest

from kl_graph.periodic import runner as R
from kl_graph.storage.sqlite_store import SQLiteStore


class _FakeVector:
    def close(self) -> None:
        pass


def _store() -> SQLiteStore:
    return SQLiteStore(db_path=None, conn=sqlite3.connect(":memory:"))


def _patch_common(monkeypatch: pytest.MonkeyPatch, order: list[str], *, empty: bool) -> None:
    # Similarity / disambiguation steps -> no-ops.
    monkeypatch.setattr(R, "build_fact_similarity_edges", lambda *a, **k: 0)
    monkeypatch.setattr(R, "build_entity_similarity_edges", lambda *a, **k: 0)
    monkeypatch.setattr(R, "run_entity_disambiguation", lambda *a, **k: 0)
    # Feature gate on.
    monkeypatch.setattr(
        R.cfg.pipelines.experimental.communities, "enabled", True, raising=False
    )

    import kl_graph.periodic.community_detection as cd

    assignments = {} if empty else {0: {("entity", "e1"): 0, ("entity", "e2"): 0,
                                         ("fact", "f1"): 0, ("entity", "e3"): 1,
                                         ("fact", "f2"): 1, ("fact", "f3"): 1}}
    detection = {"assignments": assignments, "parents": {}}

    def fake_build(store):
        order.append("build_graph")
        return [], {}

    def fake_detect(edges, label_map):
        order.append("detect")
        return detection

    def fake_store(store, result):
        order.append("store")

    def fake_project(store, result):
        order.append("project")

    monkeypatch.setattr(cd, "_build_community_graph", fake_build)
    monkeypatch.setattr(cd, "detect_communities_hierarchical", fake_detect)
    monkeypatch.setattr(cd, "store_communities", fake_store)
    monkeypatch.setattr(cd, "project_community_membership_edges", fake_project)


def test_runner_orders_detect_store_project_reconcile_then_gated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order: list[str] = []
    _patch_common(monkeypatch, order, empty=False)

    seen: dict[str, object] = {}

    # Patch reconciliation + gated summarizer to record ordering and run_id.
    real_ci = R.CommunityIdentity

    class _RecordingIdentity:
        def __init__(self, store) -> None:
            self._inner = real_ci(store)

        def reconcile(self, memberships, run_id):
            order.append("reconcile")
            seen["run_id"] = run_id
            return self._inner.reconcile(memberships, run_id)

        def lineage_events_for(self, run_id):
            return self._inner.lineage_events_for(run_id)

        def resolve(self, level, cid):
            return self._inner.resolve(level, cid)

    monkeypatch.setattr(R, "CommunityIdentity", _RecordingIdentity)

    def fake_gated(store, identity, *, run_id=None, levels=None, min_members=10,
                   max_concurrent=None, forced_uuids=None):
        order.append("gated")
        seen["gated_run_id"] = run_id
        return {"regenerated": 0, "kept": 0, "retired": 0, "failed": 0,
                "llm_stats": {}}

    monkeypatch.setattr(R, "run_gated_summarization", fake_gated)

    store = _store()
    R.run_periodic_improvement(
        store=store, qdrant=_FakeVector(), run_disambiguation=False,
    )

    # Mandated ordering: detect -> store -> project -> reconcile -> gated.
    assert order == ["build_graph", "detect", "store", "project", "reconcile", "gated"]
    # Gated summarizer received the SAME run id reconciliation used.
    assert seen["run_id"] == seen["gated_run_id"]
    assert str(seen["run_id"]).startswith("full-")


def test_runner_reconciles_empty_partition(monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []
    _patch_common(monkeypatch, order, empty=True)

    real_ci = R.CommunityIdentity

    class _RecordingIdentity:
        def __init__(self, store) -> None:
            self._inner = real_ci(store)

        def reconcile(self, memberships, run_id):
            order.append(f"reconcile(empty={not memberships})")
            return self._inner.reconcile(memberships, run_id)

        def lineage_events_for(self, run_id):
            return self._inner.lineage_events_for(run_id)

        def resolve(self, level, cid):
            return self._inner.resolve(level, cid)

    monkeypatch.setattr(R, "CommunityIdentity", _RecordingIdentity)
    monkeypatch.setattr(
        R, "run_gated_summarization",
        lambda *a, **k: {"regenerated": 0, "kept": 0, "retired": 0, "failed": 0, "llm_stats": {}},
    )

    store = _store()
    R.run_periodic_improvement(store=store, qdrant=_FakeVector(), run_disambiguation=False)

    # Even with an empty partition, reconciliation MUST run (mandatory contract).
    assert "reconcile(empty=True)" in order


def test_durable_run_id_is_retry_stable() -> None:
    store = _store()
    first = R._durable_run_id(store)
    # A retry (before completion) reuses the SAME id.
    again = R._durable_run_id(store)
    assert first == again
    # After completion it is cleared, so the next improve mints a fresh id.
    R._clear_durable_run_id(store)
    third = R._durable_run_id(store)
    assert third != first
