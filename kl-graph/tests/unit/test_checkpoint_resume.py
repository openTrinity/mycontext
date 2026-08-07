"""Unit tests for checkpoint resume behavior in incremental ingestion.

Tests verify:
- Steps already marked done are skipped on resume (guard.skip = True)
- Only remaining steps execute when resuming from a mid-run checkpoint
- Final summary dict matches expected state after partial resume
- Checkpoint tracks which steps have been completed
"""

from __future__ import annotations

import asyncio
import pathlib
from unittest.mock import AsyncMock, MagicMock, patch

from kl_graph.ingest.checkpoint import IngestCheckpoint
from kl_graph.ingest.incremental import IncrementalIngestion
from kl_graph.models.types import Chunk

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_chunk(chunk_id: str, ts: int = 1_000) -> Chunk:
    return Chunk(
        id=chunk_id,
        content=f"Content of {chunk_id}",
        source_type="message",
        timestamp=ts,
    )


def _make_checkpoint(
    tmp_path: pathlib.Path,
    *,
    pre_done: list[str] | None = None,
) -> IngestCheckpoint:
    """Create a checkpoint with optional pre-completed steps."""
    cp = IngestCheckpoint(tmp_path / "checkpoint.json", source_dirs=[])
    if pre_done:
        for step_name in pre_done:
            cp.mark_done(step_name)
    return cp


def _make_incremental_with_checkpoint(
    checkpoint: IngestCheckpoint | None,
) -> IncrementalIngestion:
    store = MagicMock()
    store.existing_chunk_ids.return_value = set()
    store.sql_conn = MagicMock()
    store.sql_conn.execute.return_value = MagicMock(fetchall=MagicMock(return_value=[]))
    store.get_meta.return_value = None
    store.iter_all_entities.return_value = iter([])
    store.iter_all_facts.return_value = iter([])

    qdrant = MagicMock()
    qdrant.existing_ids.return_value = set()

    sim_strat = MagicMock()
    sim_strat.compute_similarity_edges.return_value = []

    comm_strat = MagicMock()
    comm_strat.assign_communities.return_value = set()

    return IncrementalIngestion(
        store=store,
        qdrant=qdrant,
        checkpoint=checkpoint,
        similarity_strategy=sim_strat,
        community_strategy=comm_strat,
    )


# ---------------------------------------------------------------------------
# Tests: step() guard respects checkpoint state
# ---------------------------------------------------------------------------


class TestStepGuardCheckpoint:
    """step() context manager skips already-done steps."""

    def test_undone_step_runs_normally(self, tmp_path: pathlib.Path) -> None:
        """A step not yet in the checkpoint executes (guard.skip = False)."""
        cp = _make_checkpoint(tmp_path)
        incr = _make_incremental_with_checkpoint(cp)

        executed = []
        with incr.step("incr.persist_chunks") as guard:
            if not guard.skip:
                executed.append("ran")
                guard.done(count=1)

        assert executed == ["ran"]
        assert cp.is_done("incr.persist_chunks")

    def test_already_done_step_is_skipped(self, tmp_path: pathlib.Path) -> None:
        """A step already in the checkpoint is skipped (guard.skip = True)."""
        cp = _make_checkpoint(tmp_path, pre_done=["incr.persist_chunks"])
        incr = _make_incremental_with_checkpoint(cp)

        executed = []
        with incr.step("incr.persist_chunks") as guard:
            if not guard.skip:
                executed.append("ran")

        assert executed == []

    def test_on_skip_callback_called(self, tmp_path: pathlib.Path) -> None:
        """on_skip callback is invoked when a step is already done."""
        cp = _make_checkpoint(tmp_path, pre_done=["incr.embed_chunks"])
        incr = _make_incremental_with_checkpoint(cp)

        on_skip_called = []

        def _on_skip() -> None:
            on_skip_called.append(True)

        with incr.step("incr.embed_chunks", on_skip=_on_skip) as guard:
            if not guard.skip:
                pass  # should not run

        assert on_skip_called == [True]

    def test_on_skip_not_called_for_undone_step(self, tmp_path: pathlib.Path) -> None:
        """on_skip is NOT called when a step has not been done yet."""
        cp = _make_checkpoint(tmp_path)  # no pre-done steps
        incr = _make_incremental_with_checkpoint(cp)

        on_skip_called = []

        def _on_skip() -> None:
            on_skip_called.append(True)

        with incr.step("incr.embed_chunks", on_skip=_on_skip) as guard:
            if not guard.skip:
                guard.done()

        assert on_skip_called == []


# ---------------------------------------------------------------------------
# Tests: resume from partial checkpoint skips completed steps
# ---------------------------------------------------------------------------


class TestCheckpointResume:
    """Run with pre-seeded checkpoint skips already-done steps."""

    def test_resume_after_extract_skips_earlier_steps(
        self, tmp_path: pathlib.Path
    ) -> None:
        """If persist_chunks, embed_chunks, extract are already done,
        they are skipped; load_delta always re-runs to populate new_chunks,
        and build_entities and later still run.

        Note: incr.load_delta is NOT marked done — it always re-runs on resume
        so that new_chunks is repopulated (without it, new_chunks=[] causes
        early return before any downstream steps execute).
        """
        pre_done = [
            "incr.persist_chunks",
            "incr.embed_chunks",
            "incr.extract",
        ]
        cp = _make_checkpoint(tmp_path, pre_done=pre_done)
        incr = _make_incremental_with_checkpoint(cp)

        new_chunks = [_make_chunk("c1", ts=2_000)]
        executed_steps: list[str] = []

        def _track(name: str) -> None:
            executed_steps.append(name)

        with (
            patch.object(
                incr, "_load_delta_chunks", side_effect=lambda _ts: new_chunks
            ),
            patch.object(
                incr,
                "_persist_new_chunks",
                side_effect=lambda _: _track("persist_chunks"),
            ),
            patch.object(
                incr,
                "_embed_new_chunks",
                new_callable=AsyncMock,
                side_effect=lambda _: _track("embed_chunks"),
            ),
            patch.object(
                incr,
                "_extract_new_chunks",
                new_callable=AsyncMock,
                side_effect=lambda _: (  # type: ignore[misc]
                    _track("extract") or {}
                ),
            ),
            patch.object(
                incr,
                "_build_incremental_entities",
                side_effect=lambda *_: _track("build_entities") or ["e1"],
            ),
            patch.object(
                incr,
                "_build_incremental_facts",
                side_effect=lambda *_: _track("build_facts") or ["f1"],
            ),
            patch.object(
                incr,
                "_embed_new_nodes",
                new_callable=AsyncMock,
                side_effect=lambda *_: _track("embed_new"),
            ),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            asyncio.run(incr.run())

        # Steps that were pre-done should NOT be in executed_steps
        assert "persist_chunks" not in executed_steps
        assert "embed_chunks" not in executed_steps
        assert "extract" not in executed_steps
        # Steps after checkpoint should have run
        assert "build_entities" in executed_steps
        assert "build_facts" in executed_steps

    def test_fully_done_checkpoint_skips_all_data_steps(
        self, tmp_path: pathlib.Path
    ) -> None:
        """If all 10 incr.* steps are marked done, run() skips them all."""
        pre_done = [
            "incr.load_delta",
            "incr.persist_chunks",
            "incr.embed_chunks",
            "incr.extract",
            "incr.build_entities",
            "incr.build_facts",
            "incr.embed_new",
            "incr.similarity",
            "incr.communities",
            "incr.invalidate_summaries",
        ]
        cp = _make_checkpoint(tmp_path, pre_done=pre_done)
        incr = _make_incremental_with_checkpoint(cp)

        new_chunks = [_make_chunk("c1", ts=2_000)]

        with (
            patch.object(incr, "_load_delta_chunks", return_value=new_chunks),
            patch.object(incr, "_persist_new_chunks") as mock_persist,
            patch.object(
                incr, "_embed_new_chunks", new_callable=AsyncMock
            ) as mock_embed_chunks,
            patch.object(
                incr,
                "_extract_new_chunks",
                new_callable=AsyncMock,
                return_value={},
            ) as mock_extract,
            patch.object(
                incr, "_build_incremental_entities", return_value=[]
            ) as mock_entities,
            patch.object(
                incr, "_build_incremental_facts", return_value=[]
            ) as mock_facts,
            patch.object(
                incr, "_embed_new_nodes", new_callable=AsyncMock
            ) as mock_embed_new,
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            asyncio.run(incr.run())

        mock_persist.assert_not_called()
        mock_embed_chunks.assert_not_called()
        mock_extract.assert_not_called()
        mock_entities.assert_not_called()
        mock_facts.assert_not_called()
        mock_embed_new.assert_not_called()

    def test_checkpoint_marks_steps_done_as_they_complete(
        self, tmp_path: pathlib.Path
    ) -> None:
        """After a successful run, checkpoint records all steps as done."""
        cp = _make_checkpoint(tmp_path)
        incr = _make_incremental_with_checkpoint(cp)

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
            asyncio.run(incr.run())

        # All incr.* steps should now be marked done
        for step in [
            "incr.load_delta",
            "incr.persist_chunks",
            "incr.embed_chunks",
            "incr.extract",
            "incr.build_entities",
            "incr.build_facts",
            "incr.embed_new",
            "incr.similarity",
            "incr.communities",
            "incr.invalidate_summaries",
        ]:
            assert cp.is_done(step), f"Step {step!r} should be marked done"


# ---------------------------------------------------------------------------
# Tests: no-checkpoint mode (checkpoint=None)
# ---------------------------------------------------------------------------


class TestNoCheckpointMode:
    """When checkpoint=None, all steps run unconditionally."""

    def test_no_checkpoint_all_steps_run(self) -> None:
        """Without a checkpoint, all steps execute on every call."""
        incr = _make_incremental_with_checkpoint(None)

        new_chunks = [_make_chunk("c1", ts=2_000)]
        executed_steps: list[str] = []

        with (
            patch.object(incr, "_load_delta_chunks", return_value=new_chunks),
            patch.object(
                incr,
                "_persist_new_chunks",
                side_effect=lambda _: executed_steps.append("persist"),
            ),
            patch.object(
                incr,
                "_embed_new_chunks",
                new_callable=AsyncMock,
                side_effect=lambda _: executed_steps.append("embed_chunks"),
            ),
            patch.object(
                incr,
                "_extract_new_chunks",
                new_callable=AsyncMock,
                return_value={},
            ),
            patch.object(
                incr,
                "_build_incremental_entities",
                side_effect=lambda *_: executed_steps.append("entities") or [],
            ),
            patch.object(
                incr,
                "_build_incremental_facts",
                side_effect=lambda *_: executed_steps.append("facts") or [],
            ),
            patch.object(
                incr,
                "_embed_new_nodes",
                new_callable=AsyncMock,
                side_effect=lambda *_: executed_steps.append("embed_new"),
            ),
            patch.object(incr, "_invalidate_stale_summaries", return_value=0),
            patch.object(incr, "_update_watermark"),
            patch("kl_graph.ingest.incremental.increment_run_count", return_value=1),
            patch("kl_graph.ingest.incremental.needs_full_rebuild", return_value=False),
        ):
            asyncio.run(incr.run())

        assert "persist" in executed_steps
        assert "embed_chunks" in executed_steps
        assert "entities" in executed_steps
        assert "facts" in executed_steps
        assert "embed_new" in executed_steps
