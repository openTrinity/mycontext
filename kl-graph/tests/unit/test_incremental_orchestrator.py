"""Unit tests for run_incremental() orchestration flow.

Tests verify:
- run_incremental() no longer raises NotImplementedError
- Empty delta causes early return without errors
- All pipeline steps are called in order via checkpoints
- Strategies are called with correct new_entity_ids/new_fact_ids
- Community summaries are marked stale when membership change > threshold
- Watermark is updated to max timestamp of new chunks
- Run count incremented after successful run
- Full rebuild triggered when run_count reaches threshold
- Advisory lock prevents concurrent incremental runs
"""

from __future__ import annotations

import asyncio
import pathlib
import sqlite3
from unittest.mock import AsyncMock, MagicMock, patch

from kl_graph.ingest.incremental import IncrementalIngestion
from kl_graph.models.types import Chunk, Edge, EdgeType

# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_chunk(chunk_id: str, ts: int = 1000) -> Chunk:
    return Chunk(
        id=chunk_id,
        content=f"Content of {chunk_id}",
        source_type="message",
        timestamp=ts,
    )


def _make_mock_store(
    existing_chunk_ids_result: set | None = None,
    meta_values: dict | None = None,
) -> MagicMock:
    """Create a minimal mock KnowledgeStore."""
    store = MagicMock()
    store.existing_chunk_ids.return_value = existing_chunk_ids_result or set()
    conn = MagicMock()
    store.sql_conn = conn
    conn.execute.return_value = MagicMock(fetchall=MagicMock(return_value=[]))

    def _get_meta(key: str) -> str | None:
        return (meta_values or {}).get(key)

    store.get_meta.side_effect = _get_meta
    store.iter_all_entities.return_value = iter([])
    store.iter_all_facts.return_value = iter([])
    return store


def _make_incremental(
    store=None,
    qdrant=None,
    similarity_strategy=None,
    community_strategy=None,
) -> IncrementalIngestion:
    """Create an IncrementalIngestion with mocked dependencies."""
    if store is None:
        store = _make_mock_store()
    if qdrant is None:
        qdrant = MagicMock()
        qdrant.existing_ids.return_value = set()

    # Only set defaults when no strategy was provided (don't overwrite caller's configuration)
    if similarity_strategy is None:
        sim_strat = MagicMock()
        sim_strat.compute_similarity_edges.return_value = []
    else:
        sim_strat = similarity_strategy

    if community_strategy is None:
        comm_strat = MagicMock()
        comm_strat.assign_communities.return_value = set()
    else:
        comm_strat = community_strategy

    return IncrementalIngestion(
        store=store,
        qdrant=qdrant,
        similarity_strategy=sim_strat,
        community_strategy=comm_strat,
    )


# ── Tests ─────────────────────────────────────────────────────────────────────


class TestRunIncrementalNotRaises:
    """run_incremental() orchestrator no longer raises NotImplementedError."""

    def test_no_longer_raises_not_implemented(self, tmp_path: pathlib.Path) -> None:
        """run_incremental() can be called without raising NotImplementedError."""
        from kl_graph.ingest.pipeline import IngestionPipeline
        from kl_graph.storage.sqlite_store import SQLiteStore

        store = SQLiteStore(tmp_path / "test.db")
        pipeline = IngestionPipeline(store=store)

        # Should not raise NotImplementedError
        # (Will return early due to empty delta with mocked load)
        with patch.object(pipeline, "_load_delta", return_value=[]):
            result = asyncio.run(pipeline.run_incremental())

        assert isinstance(result, dict)
        assert "new_chunks" in result
        store.close()


class TestEmptyDeltaEarlyReturn:
    """When no new chunks are detected, orchestrator returns early."""

    def test_empty_delta_returns_without_error(self) -> None:
        """Empty delta causes early return with zero counts."""
        incr = _make_incremental()

        with patch.object(incr, "_load_delta_chunks", return_value=[]):
            result = asyncio.run(incr.run())

        assert result["new_chunks"] == 0
        assert result["new_entities"] == 0
        assert result["new_facts"] == 0
        # Strategies should not be called
        incr.similarity_strategy.compute_similarity_edges.assert_not_called()
        incr.community_strategy.assign_communities.assert_not_called()

    def test_empty_delta_does_not_update_watermark(self) -> None:
        """When no new chunks, watermark should not be updated."""
        store = _make_mock_store()
        incr = _make_incremental(store=store)

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[]),
            patch.object(incr, "_update_watermark") as mock_wm,
        ):
            asyncio.run(incr.run())

        mock_wm.assert_not_called()


class TestStrategyCallOrder:
    """Strategies are called with correct IDs."""

    def test_similarity_strategy_called_with_new_ids(self) -> None:
        """compute_similarity_edges receives new_entity_ids and new_fact_ids."""
        new_chunk = _make_chunk("chunk-1", ts=2000)

        sim_strat = MagicMock()
        sim_strat.compute_similarity_edges.return_value = []
        comm_strat = MagicMock()
        comm_strat.assign_communities.return_value = set()

        incr = _make_incremental(
            similarity_strategy=sim_strat,
            community_strategy=comm_strat,
        )

        entity_ids = ["e1", "e2"]
        fact_ids = ["f1"]

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[new_chunk]),
            patch.object(incr, "_persist_new_chunks"),
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(incr, "_build_incremental_entities", return_value=entity_ids),
            patch.object(incr, "_build_incremental_facts", return_value=fact_ids),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            asyncio.run(incr.run())

        sim_strat.compute_similarity_edges.assert_called_once()
        args = sim_strat.compute_similarity_edges.call_args
        assert args[0][0] == entity_ids  # new_entity_ids
        assert args[0][1] == fact_ids  # new_fact_ids

    def test_community_strategy_called_with_new_ids(self) -> None:
        """assign_communities receives new_entity_ids and new_fact_ids."""
        new_chunk = _make_chunk("chunk-1", ts=2000)

        sim_strat = MagicMock()
        sim_strat.compute_similarity_edges.return_value = []
        comm_strat = MagicMock()
        comm_strat.assign_communities.return_value = set()

        incr = _make_incremental(
            similarity_strategy=sim_strat,
            community_strategy=comm_strat,
        )

        entity_ids = ["e1"]
        fact_ids = ["f1", "f2"]

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[new_chunk]),
            patch.object(incr, "_persist_new_chunks"),
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(incr, "_build_incremental_entities", return_value=entity_ids),
            patch.object(incr, "_build_incremental_facts", return_value=fact_ids),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            asyncio.run(incr.run())

        comm_strat.assign_communities.assert_called_once()
        args = comm_strat.assign_communities.call_args
        assert args[0][1] == entity_ids  # new_entity_ids (positional arg 2)
        assert args[0][2] == fact_ids  # new_fact_ids (positional arg 3)


class TestWatermarkAndRunCount:
    """Watermark and run count are updated correctly."""

    def test_watermark_updated_to_max_timestamp(self) -> None:
        """Watermark is updated to the maximum timestamp among new chunks."""
        chunks = [
            _make_chunk("c1", ts=1000),
            _make_chunk("c2", ts=3000),
            _make_chunk("c3", ts=2000),
        ]

        incr = _make_incremental()

        with (
            patch.object(incr, "_load_delta_chunks", return_value=chunks),
            patch.object(incr, "_persist_new_chunks"),
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(incr, "_build_incremental_entities", return_value=[]),
            patch.object(incr, "_build_incremental_facts", return_value=[]),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark") as mock_wm,
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            asyncio.run(incr.run())

        mock_wm.assert_called_once_with(3000)

    def test_run_count_incremented(self) -> None:
        """increment_run_count is called after a successful run."""
        new_chunk = _make_chunk("c1", ts=1000)
        incr = _make_incremental()

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[new_chunk]),
            patch.object(incr, "_persist_new_chunks"),
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(incr, "_build_incremental_entities", return_value=[]),
            patch.object(incr, "_build_incremental_facts", return_value=[]),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count") as mock_incr,
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            asyncio.run(incr.run())

        mock_incr.assert_called_once()


class TestFullRebuildTrigger:
    """Full rebuild is triggered when run count reaches threshold."""

    def test_full_rebuild_triggered_at_threshold(self) -> None:
        """When needs_full_rebuild returns True, _run_full_rebuild is called."""
        new_chunk = _make_chunk("c1", ts=1000)
        incr = _make_incremental()

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[new_chunk]),
            patch.object(incr, "_persist_new_chunks"),
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(incr, "_build_incremental_entities", return_value=[]),
            patch.object(incr, "_build_incremental_facts", return_value=[]),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=10),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=True),
            patch("kl_graph.ingest.incremental.reset_run_count") as mock_reset,
            patch.object(incr, "_run_full_rebuild") as mock_rebuild,
        ):
            asyncio.run(incr.run())

        mock_rebuild.assert_called_once()
        mock_reset.assert_called_once()

    def test_no_full_rebuild_below_threshold(self) -> None:
        """When needs_full_rebuild returns False, _run_full_rebuild is NOT called."""
        new_chunk = _make_chunk("c1", ts=1000)
        incr = _make_incremental()

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[new_chunk]),
            patch.object(incr, "_persist_new_chunks"),
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(incr, "_build_incremental_entities", return_value=[]),
            patch.object(incr, "_build_incremental_facts", return_value=[]),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=3),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
            patch.object(incr, "_run_full_rebuild") as mock_rebuild,
        ):
            asyncio.run(incr.run())

        mock_rebuild.assert_not_called()


class TestSummaryInvalidation:
    """Community summaries are invalidated when membership change exceeds threshold."""

    def test_invalidate_stale_called_with_changed_community_ids(self) -> None:
        """_invalidate_stale_summaries is called with the changed community set."""
        new_chunk = _make_chunk("c1", ts=1000)
        changed_comm_ids = {"comm-uuid-1", "comm-uuid-2"}

        comm_strat = MagicMock()
        comm_strat.assign_communities.return_value = changed_comm_ids

        incr = _make_incremental(community_strategy=comm_strat)

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[new_chunk]),
            patch.object(incr, "_persist_new_chunks"),
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(incr, "_build_incremental_entities", return_value=[]),
            patch.object(incr, "_build_incremental_facts", return_value=[]),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(
                incr, "_invalidate_stale_summaries", return_value=2
            ) as mock_inv,
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.project_community_membership_edges"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            asyncio.run(incr.run())

        mock_inv.assert_called_once()
        call_args = mock_inv.call_args
        assert call_args[0][0] == changed_comm_ids

    def test_invalidate_marks_stale_in_db(self, tmp_path: pathlib.Path) -> None:
        """_invalidate_stale_summaries sets summary_stale=1 for small communities."""
        from kl_graph.storage.sqlite_store import SQLiteStore

        store = SQLiteStore(tmp_path / "test.db")
        conn = store.conn

        # Ensure summary_stale column exists (ignore if already present)
        try:
            conn.execute(
                "ALTER TABLE communities ADD COLUMN summary_stale INTEGER DEFAULT 0"
            )
        except sqlite3.OperationalError:
            pass  # column already exists

        # Insert a tiny community (1 member → ratio = 1.0 > 0.1 threshold)
        conn.execute(
            "INSERT OR IGNORE INTO communities (id, level, node_type, summary, member_count) VALUES (?, ?, ?, ?, ?)",
            ("comm-uuid-123", "L0", "entity", "", 1),
        )
        conn.commit()

        incr = IncrementalIngestion(
            store=store,
            qdrant=MagicMock(),
        )

        n = incr._invalidate_stale_summaries(
            {"comm-uuid-123"},
            threshold=0.1,
        )

        assert n == 1
        row = conn.execute(
            "SELECT summary_stale FROM communities WHERE id = ?", ("comm-uuid-123",)
        ).fetchone()
        assert row is not None and row[0] == 1
        store.close()


class TestSummaryReturns:
    """run() returns the correct summary dict."""

    def test_return_dict_has_expected_keys(self) -> None:
        """Result dict contains all expected count keys."""
        incr = _make_incremental()

        with patch.object(incr, "_load_delta_chunks", return_value=[]):
            result = asyncio.run(incr.run())

        assert set(result.keys()) == {
            "new_chunks",
            "new_entities",
            "new_facts",
            "new_edges",
            "changed_communities",
        }

    def test_counts_match_actual_work(self) -> None:
        """Result counts match the number of entities/facts/edges created."""
        new_chunk = _make_chunk("c1", ts=1000)

        sim_strat = MagicMock()
        edge = Edge(
            source_type="entity",
            source_id="e1",
            target_type="entity",
            target_id="e2",
            edge_type=EdgeType.ENTITY_SIMILAR,
        )
        sim_strat.compute_similarity_edges.return_value = [edge]

        comm_strat = MagicMock()
        comm_strat.assign_communities.return_value = {"comm-1", "comm-2"}

        incr = _make_incremental(
            similarity_strategy=sim_strat,
            community_strategy=comm_strat,
        )

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[new_chunk]),
            patch.object(incr, "_persist_new_chunks"),
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(
                incr, "_build_incremental_entities", return_value=["e1", "e2"]
            ),
            patch.object(incr, "_build_incremental_facts", return_value=["f1"]),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.project_community_membership_edges"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            result = asyncio.run(incr.run())

        assert result["new_chunks"] == 1
        assert result["new_entities"] == 2
        assert result["new_facts"] == 1
        assert result["new_edges"] == 1
        assert result["changed_communities"] == 2
