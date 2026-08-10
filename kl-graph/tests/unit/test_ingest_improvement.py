"""Policy and orchestration tests for post-ingestion improvement."""

from __future__ import annotations

import sys
from unittest.mock import MagicMock, patch

import pytest

from kl_graph.ingest.improvement import (
    ImprovementTargets,
    has_full_improvement_baseline,
    resolve_improve_mode,
    run_improvement,
)
from kl_graph.storage.sqlite_store import SQLiteStore


def _add_community_columns(store: SQLiteStore) -> None:
    for table in ("entities", "facts"):
        for level in ("L0", "L1", "L2", "L3"):
            store.sql_conn.execute(
                f"ALTER TABLE {table} ADD COLUMN community_{level} INTEGER"
            )
    store.sql_conn.commit()


def test_auto_seeds_missing_baseline_with_full(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    targets = ImprovementTargets(entity_ids=("e1",))
    assert not has_full_improvement_baseline(store)
    assert resolve_improve_mode("auto", store, targets) == "full"
    store.close()


def test_auto_uses_incremental_after_full_baseline(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    _add_community_columns(store)
    targets = ImprovementTargets(fact_ids=("f1",))
    assert has_full_improvement_baseline(store)
    assert resolve_improve_mode("auto", store, targets) == "incremental"
    store.close()


def test_auto_skips_when_batch_has_no_graph_targets(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    assert resolve_improve_mode("auto", store, ImprovementTargets()) == "off"
    store.close()


def test_forced_incremental_requires_baseline(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    with pytest.raises(ValueError, match="requires an existing"):
        resolve_improve_mode(
            "incremental", store, ImprovementTargets(entity_ids=("e1",))
        )
    store.close()


def test_incremental_improvement_calls_batch_strategies(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    _add_community_columns(store)
    similarity = MagicMock()
    similarity.compute_similarity_edges.return_value = []
    communities = MagicMock()
    communities.assign_communities.return_value = set()
    targets = ImprovementTargets(entity_ids=("e1",), fact_ids=("f1",))

    with (
        patch(
            "kl_graph.ingest.improvement.get_similarity_strategy",
            return_value=similarity,
        ),
        patch(
            "kl_graph.ingest.improvement.get_community_strategy",
            return_value=communities,
        ),
        patch(
            "kl_graph.ingest.improvement.cfg.pipelines.communities.enabled",
            True,
        ),
        patch.dict(sys.modules, {"igraph": MagicMock(), "leidenalg": MagicMock()}),
    ):
        result = run_improvement(
            "incremental",
            store=store,
            qdrant=MagicMock(),
            targets=targets,
            batch_id="batch-1",
        )

    assert result.applied_mode == "incremental"
    similarity.compute_similarity_edges.assert_called_once()
    # Incremental community assignment is a guarded no-op after the migration to
    # hierarchical Leiden; the batch strategy is still invoked (and returns an
    # empty change set), but it must NOT receive the removed ``structural_cache``
    # keyword.
    communities.assign_communities.assert_called_once()
    _args, kwargs = communities.assign_communities.call_args
    assert "structural_cache" not in kwargs
    store.close()


def test_incremental_skips_experimental_communities_when_disabled(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    _add_community_columns(store)
    similarity = MagicMock()
    similarity.compute_similarity_edges.return_value = []
    communities = MagicMock()

    with (
        patch(
            "kl_graph.ingest.improvement.get_similarity_strategy",
            return_value=similarity,
        ),
        patch(
            "kl_graph.ingest.improvement.get_community_strategy",
            return_value=communities,
        ),
    ):
        result = run_improvement(
            "incremental",
            store=store,
            qdrant=MagicMock(),
            targets=ImprovementTargets(entity_ids=("e1",)),
            batch_id="batch-disabled",
        )

    assert result.applied_mode == "incremental"
    similarity.compute_similarity_edges.assert_called_once()
    communities.assert_not_called()
    assert result.changed_communities == 0
    store.close()


def test_incremental_invalidates_current_community_summaries(tmp_path) -> None:
    """Even with a no-op community strategy, the touched nodes' current
    communities are collected so their summaries can be invalidated (a member
    changed) — the scoped COMM_MEMBER projection itself is deferred to the next
    full improve/hierarchical rebuild."""
    store = SQLiteStore(tmp_path / "graph.db")
    _add_community_columns(store)
    similarity = MagicMock()
    similarity.compute_similarity_edges.return_value = []
    communities = MagicMock()
    communities.assign_communities.return_value = set()

    with (
        patch(
            "kl_graph.ingest.improvement.get_similarity_strategy",
            return_value=similarity,
        ),
        patch(
            "kl_graph.ingest.improvement.get_community_strategy",
            return_value=communities,
        ),
        patch(
            "kl_graph.ingest.improvement._current_community_ids",
            return_value={"comm-uuid-1"},
        ),
        patch(
            "kl_graph.ingest.improvement._invalidate_summaries",
            return_value=1,
        ) as inval,
        patch(
            "kl_graph.ingest.improvement.cfg.pipelines.communities.enabled",
            True,
        ),
        patch.dict(sys.modules, {"igraph": MagicMock(), "leidenalg": MagicMock()}),
    ):
        result = run_improvement(
            "incremental",
            store=store,
            qdrant=MagicMock(),
            targets=ImprovementTargets(entity_ids=("e1",)),
            batch_id="batch-1",
        )

    inval.assert_called_once()
    assert result.applied_mode == "incremental"
    assert result.stale_summaries == 1
    store.close()


def test_forced_full_marks_baseline(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    with (
        patch("kl_graph.periodic.runner.run_periodic_improvement") as full,
        patch.dict(sys.modules, {"igraph": MagicMock(), "leidenalg": MagicMock()}),
    ):
        result = run_improvement(
            "full",
            store=store,
            qdrant=MagicMock(),
            targets=ImprovementTargets(),
        )
    assert result.applied_mode == "full"
    full.assert_called_once()
    assert store.get_meta("improvement.full.completed_at") is not None
    store.close()
