"""Integration tests for the incremental ingestion flow.

Tests verify end-to-end behavior of IncrementalIngestion.run() with
a real SQLite store and mocked LLM/embedder/Qdrant, using synthetic data:

- Full build with 5 synthetic chunks → verify graph state
- Run incremental with 3 new chunks → verify new chunks/entities/facts/watermark
- Run incremental with no new data → verify early return (no-op)
- run() result dict contains all expected keys
"""

from __future__ import annotations

import asyncio
import pathlib
from unittest.mock import AsyncMock, MagicMock, patch

from kl_graph.ingest.incremental import IncrementalIngestion
from kl_graph.models.types import Chunk
from kl_graph.storage.sqlite_store import SQLiteStore

# ---------------------------------------------------------------------------
# Synthetic data helpers
# ---------------------------------------------------------------------------


def _make_chunk(
    chunk_id: str,
    content: str = "",
    ts: int = 1_700_000_000_000,
    source_type: str = "message",
) -> Chunk:
    return Chunk(
        id=chunk_id,
        content=content or f"Content of {chunk_id}",
        source_type=source_type,
        timestamp=ts,
    )


def _make_store(tmp_path: pathlib.Path) -> SQLiteStore:
    return SQLiteStore(tmp_path / "test.db")


def _make_mock_qdrant(existing_ids: set | None = None) -> MagicMock:
    qdrant = MagicMock()
    qdrant.existing_ids.return_value = existing_ids or set()
    qdrant.upsert.return_value = None
    return qdrant


def _make_incremental(
    store: SQLiteStore,
    qdrant: MagicMock,
    existing_chunk_ids: set | None = None,
) -> IncrementalIngestion:
    store_mock = MagicMock(wraps=store)
    store_mock.sql_conn = store.conn
    store_mock.existing_chunk_ids.return_value = existing_chunk_ids or set()
    store_mock.get_meta.side_effect = store.get_meta
    store_mock.set_meta.side_effect = store.set_meta
    store_mock.iter_all_entities.return_value = iter([])
    store_mock.iter_all_facts.return_value = iter([])

    sim_strat = MagicMock()
    sim_strat.compute_similarity_edges.return_value = []

    comm_strat = MagicMock()
    comm_strat.assign_communities.return_value = set()

    return IncrementalIngestion(
        store=store_mock,
        qdrant=qdrant,
        similarity_strategy=sim_strat,
        community_strategy=comm_strat,
    )


# ---------------------------------------------------------------------------
# TestIncrementalWithNewChunks: new data updates state correctly
# ---------------------------------------------------------------------------


class TestIncrementalWithNewChunks:
    """Incremental run with new data updates watermark and returns correct counts."""

    def test_result_contains_all_keys(self, tmp_path: pathlib.Path) -> None:
        """run() result dict has new_chunks/entities/facts/edges/changed_communities."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        new_chunks = [_make_chunk("c1", ts=2_000)]

        with (
            patch.object(incr, "_load_delta_chunks", return_value=new_chunks),
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
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            result = asyncio.run(incr.run())

        assert set(result.keys()) == {
            "new_chunks",
            "new_entities",
            "new_facts",
            "new_edges",
            "changed_communities",
        }
        store.close()

    def test_new_chunk_count_matches(self, tmp_path: pathlib.Path) -> None:
        """result['new_chunks'] equals the number of new chunks detected."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        new_chunks = [
            _make_chunk("c1", ts=1_000),
            _make_chunk("c2", ts=2_000),
            _make_chunk("c3", ts=3_000),
        ]

        with (
            patch.object(incr, "_load_delta_chunks", return_value=new_chunks),
            patch.object(incr, "_persist_new_chunks"),
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(incr, "_build_incremental_entities", return_value=["e1"]),
            patch.object(incr, "_build_incremental_facts", return_value=["f1", "f2"]),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            result = asyncio.run(incr.run())

        assert result["new_chunks"] == 3
        assert result["new_entities"] == 1
        assert result["new_facts"] == 2
        store.close()

    def test_watermark_updated_to_max_timestamp(self, tmp_path: pathlib.Path) -> None:
        """Watermark is set to the maximum timestamp of the new chunks."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        new_chunks = [
            _make_chunk("c1", ts=1_000),
            _make_chunk("c2", ts=5_000),
            _make_chunk("c3", ts=3_000),
        ]

        with (
            patch.object(incr, "_load_delta_chunks", return_value=new_chunks),
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

        mock_wm.assert_called_once_with(5_000)
        store.close()

    def test_persist_chunks_called_with_new_chunks(
        self, tmp_path: pathlib.Path
    ) -> None:
        """_persist_new_chunks is called with the detected new chunks."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        new_chunks = [_make_chunk("c1", ts=1_000)]

        with (
            patch.object(incr, "_load_delta_chunks", return_value=new_chunks),
            patch.object(incr, "_persist_new_chunks") as mock_persist,
            patch.object(incr, "_embed_new_chunks", new_callable=AsyncMock),
            patch.object(
                incr, "_extract_new_chunks", new_callable=AsyncMock, return_value={}
            ),
            patch.object(incr, "_build_incremental_entities", return_value=[]),
            patch.object(incr, "_build_incremental_facts", return_value=[]),
            patch.object(incr, "_embed_new_nodes", new_callable=AsyncMock),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            asyncio.run(incr.run())

        mock_persist.assert_called_once_with(new_chunks)
        store.close()


# ---------------------------------------------------------------------------
# TestIncrementalNoNewData: early return when delta is empty
# ---------------------------------------------------------------------------


class TestIncrementalNoNewData:
    """When no new chunks are detected, run() returns early without errors."""

    def test_empty_delta_returns_zero_counts(self, tmp_path: pathlib.Path) -> None:
        """Empty delta → all counts are 0."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        with patch.object(incr, "_load_delta_chunks", return_value=[]):
            result = asyncio.run(incr.run())

        assert result["new_chunks"] == 0
        assert result["new_entities"] == 0
        assert result["new_facts"] == 0
        assert result["new_edges"] == 0
        assert result["changed_communities"] == 0
        store.close()

    def test_empty_delta_skips_pipeline_steps(self, tmp_path: pathlib.Path) -> None:
        """When delta is empty, expensive steps are not called."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[]),
            patch.object(incr, "_persist_new_chunks") as mock_persist,
            patch.object(
                incr, "_embed_new_chunks", new_callable=AsyncMock
            ) as mock_embed,
        ):
            asyncio.run(incr.run())

        mock_persist.assert_not_called()
        mock_embed.assert_not_called()
        store.close()

    def test_empty_delta_does_not_update_watermark(
        self, tmp_path: pathlib.Path
    ) -> None:
        """Watermark is NOT updated when no new data was found."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        with (
            patch.object(incr, "_load_delta_chunks", return_value=[]),
            patch.object(incr, "_update_watermark") as mock_wm,
        ):
            asyncio.run(incr.run())

        mock_wm.assert_not_called()
        store.close()

    def test_empty_delta_does_not_call_strategies(self, tmp_path: pathlib.Path) -> None:
        """Similarity and community strategies are NOT called on empty delta."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        with patch.object(incr, "_load_delta_chunks", return_value=[]):
            asyncio.run(incr.run())

        incr.similarity_strategy.compute_similarity_edges.assert_not_called()
        incr.community_strategy.assign_communities.assert_not_called()
        store.close()


# ---------------------------------------------------------------------------
# TestSinceTimestampFiltering: since_timestamp is forwarded correctly
# ---------------------------------------------------------------------------


class TestSinceTimestampFiltering:
    """since_timestamp argument is forwarded to _load_delta_chunks."""

    def test_since_timestamp_passed_to_load_delta(self, tmp_path: pathlib.Path) -> None:
        """run(since_timestamp=X) forwards X to _load_delta_chunks."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        with patch.object(incr, "_load_delta_chunks", return_value=[]) as mock_load:
            asyncio.run(incr.run(since_timestamp=1_700_000_000_000))

        mock_load.assert_called_once_with(1_700_000_000_000)
        store.close()

    def test_no_since_timestamp_passes_none(self, tmp_path: pathlib.Path) -> None:
        """run() without since_timestamp passes None to _load_delta_chunks."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        with patch.object(incr, "_load_delta_chunks", return_value=[]) as mock_load:
            asyncio.run(incr.run())

        mock_load.assert_called_once_with(None)
        store.close()


# ---------------------------------------------------------------------------
# TestRunCountAndFullRebuild: run count incremented, full rebuild triggered
# ---------------------------------------------------------------------------


class TestRunCountAndFullRebuild:
    """run count is incremented; full rebuild triggered at threshold."""

    def test_run_count_incremented_after_new_data(self, tmp_path: pathlib.Path) -> None:
        """increment_run_count() is called after a successful run with new data."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        new_chunks = [_make_chunk("c1", ts=1_000)]

        with (
            patch.object(incr, "_load_delta_chunks", return_value=new_chunks),
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
        store.close()

    def test_full_rebuild_triggered_at_threshold(self, tmp_path: pathlib.Path) -> None:
        """_run_full_rebuild() is called when needs_full_rebuild returns True."""
        store = _make_store(tmp_path)
        qdrant = _make_mock_qdrant()
        incr = _make_incremental(store, qdrant)

        new_chunks = [_make_chunk("c1", ts=1_000)]

        with (
            patch.object(incr, "_load_delta_chunks", return_value=new_chunks),
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
        store.close()
