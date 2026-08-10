"""Experimental community feature-gate behavior."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from kl_graph.models.types import Community
from kl_graph.periodic.runner import run_periodic_improvement
from kl_graph.storage.sqlite_store import SQLiteStore


def test_disabled_full_improve_preserves_existing_community_artifacts(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    community = Community(
        id="community-existing",
        level="L0",
        node_type="mixed",
        member_count=3,
        summary="retained summary",
    )
    store.insert_communities([community])
    store.store_community_summaries(
        [
            {
                "level": 0,
                "community_id": 7,
                "member_count": 3,
                "summary": "retained report",
            }
        ]
    )

    with (
        patch(
            "kl_graph.periodic.runner.build_fact_similarity_edges",
            return_value=0,
        ),
        patch(
            "kl_graph.periodic.runner.build_entity_similarity_edges",
            return_value=0,
        ),
    ):
        run_periodic_improvement(
            store=store,
            qdrant=MagicMock(),
            run_disambiguation=False,
            communities_enabled=False,
        )

    assert store.get_community("community-existing") is not None
    assert store.get_community_summary(0, 7)["summary"] == "retained report"
    store.close()
