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
from kl_graph.ingest.strategies.community import CommunityChanges
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
        patch("kl_graph.ingest.improvement.project_community_membership_edges") as proj_mock,
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
    communities.assign_communities.assert_called_once()
    # No community changes means no projection work, not a full rebuild.
    proj_mock.assert_not_called()
    store.close()


def test_incremental_projection_receives_reversible_community_keys(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    _add_community_columns(store)
    similarity = MagicMock()
    similarity.compute_similarity_edges.return_value = []
    changes = CommunityChanges()
    changes.record("entity", "L0", 7)
    communities = MagicMock()
    communities.assign_communities.return_value = changes

    with (
        patch(
            "kl_graph.ingest.improvement.get_similarity_strategy",
            return_value=similarity,
        ),
        patch(
            "kl_graph.ingest.improvement.get_community_strategy",
            return_value=communities,
        ),
        patch("kl_graph.ingest.improvement.project_community_membership_edges") as proj,
        patch.dict(sys.modules, {"igraph": MagicMock(), "leidenalg": MagicMock()}),
    ):
        run_improvement(
            "incremental",
            store=store,
            qdrant=MagicMock(),
            targets=ImprovementTargets(entity_ids=("e1",)),
            batch_id="batch-1",
        )

    proj.assert_called_once_with(
        store,
        community_ids=set(changes),
        community_keys={("entity", "L0", 7)},
    )
    store.close()


def test_incremental_projection_recovers_keys_from_checkpoint(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    _add_community_columns(store)
    changes = CommunityChanges()
    changes.record("entity", "L0", 7)
    checkpoint = MagicMock()
    checkpoint.is_done.side_effect = lambda step, params=None: step in {
        "improve.incremental_similarity",
        "improve.incremental_leiden",
    }
    checkpoint._data = {
        "steps": {
            "improve.incremental_leiden": {
                "changed_communities": ",".join(changes),
                "changed_community_keys": [["entity", "L0", 7]],
            }
        }
    }

    with (
        patch("kl_graph.ingest.improvement.get_similarity_strategy"),
        patch("kl_graph.ingest.improvement.get_community_strategy"),
        patch("kl_graph.ingest.improvement.project_community_membership_edges") as proj,
        patch.dict(sys.modules, {"igraph": MagicMock(), "leidenalg": MagicMock()}),
    ):
        run_improvement(
            "incremental",
            store=store,
            qdrant=MagicMock(),
            targets=ImprovementTargets(entity_ids=("e1",)),
            checkpoint=checkpoint,
            batch_id="batch-1",
        )

    proj.assert_called_once_with(
        store,
        community_ids=set(changes),
        community_keys={("entity", "L0", 7)},
    )
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
