"""The endpoint and CLI share the unit-incremental ingestion runner."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kl_graph.ingest.improvement import ImprovementResult, ImprovementTargets
from kl_graph.ingest.runner import IngestOptions, IngestResult, run_ingestion


def test_ingest_options_reject_nonpositive_concurrency(tmp_path) -> None:
    with pytest.raises(ValueError, match="greater than zero"):
        IngestOptions(tmp_path, "slack-prod", concurrency=0)


def test_runner_constructs_unit_incremental_pipeline(tmp_path) -> None:
    pipeline = MagicMock()
    pipeline._phase_a_complete.return_value = False
    pipeline.units_discovered = 2
    pipeline.units_skipped = 1
    pipeline.workset_unit_count = 1
    pipeline.workset_chunk_count = 1
    pipeline.source_units = [object()]
    pipeline.all_chunks.return_value = [object()]
    pipeline.run_extraction = AsyncMock()
    pipeline.run_graph_build = AsyncMock()
    checkpoint = MagicMock()
    checkpoint.is_done.return_value = False
    checkpoint.batch_id = "batch-1"

    with patch(
        "kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline
    ) as pipeline_class:
        result = asyncio.run(
            run_ingestion(
                IngestOptions(
                    input_dir=tmp_path,
                    source_id="slack-prod",
                    improve_mode="off",
                ),
                checkpoint=checkpoint,
            )
        )

    assert pipeline_class.call_args.kwargs["messages_dir"] == tmp_path / "chat"
    assert pipeline_class.call_args.kwargs["source_id"] == "slack-prod"
    assert pipeline_class.call_args.kwargs["incremental_units"] is True
    assert result.units_processed == 1
    pipeline.run_phase_a.assert_called_once()
    pipeline.complete_workset.assert_called_once()
    checkpoint.mark_done.assert_called_once_with(
        "ingest.complete",
        params={"workset_schema": 1, "batch_id": "batch-1"},
    )
    pipeline.close.assert_called_once()


def test_runner_retains_workset_when_graph_build_fails(tmp_path) -> None:
    pipeline = MagicMock()
    pipeline._phase_a_complete.return_value = False
    pipeline.run_extraction = AsyncMock()
    pipeline.run_graph_build = AsyncMock(side_effect=RuntimeError("graph failed"))
    checkpoint = MagicMock(batch_id="batch-failed")
    checkpoint.is_done.return_value = False

    with patch("kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline):
        try:
            asyncio.run(
                run_ingestion(
                    IngestOptions(tmp_path, "slack-prod", improve_mode="off"),
                    checkpoint=checkpoint,
                )
            )
        except RuntimeError as exc:
            assert str(exc) == "graph failed"
        else:
            raise AssertionError("graph failure did not propagate")

    pipeline.complete_workset.assert_not_called()
    checkpoint.mark_done.assert_not_called()
    pipeline.close.assert_called_once()


def test_completed_checkpoint_only_retries_workset_cleanup(tmp_path) -> None:
    pipeline = MagicMock()
    checkpoint = MagicMock(batch_id="batch-complete")
    checkpoint.is_done.side_effect = lambda step, **_: step == "ingest.complete"

    with patch("kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline):
        result = asyncio.run(
            run_ingestion(
                IngestOptions(tmp_path, "slack-prod"), checkpoint=checkpoint
            )
        )

    assert result == IngestResult(0, 0, 0, 0)
    pipeline.complete_workset.assert_called_once()
    pipeline.run_phase_a.assert_not_called()
    pipeline.run_extraction.assert_not_called()
    pipeline.run_graph_build.assert_not_called()


def test_completed_auto_run_can_seed_missing_improvement_baseline(tmp_path) -> None:
    pipeline = MagicMock()
    pipeline.store.count_entities.return_value = 1
    pipeline.store.count_facts.return_value = 0
    checkpoint = MagicMock(batch_id="batch-complete")
    checkpoint.is_done.side_effect = lambda step, **_: step == "ingest.complete"

    with (
        patch("kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline),
        patch(
            "kl_graph.ingest.runner.has_full_improvement_baseline",
            return_value=False,
        ),
        patch("kl_graph.ingest.runner.run_improvement") as improve,
    ):
        asyncio.run(
            run_ingestion(
                IngestOptions(tmp_path, "slack-prod", improve_mode="auto"),
                checkpoint=checkpoint,
            )
        )

    improve.assert_called_once()
    assert improve.call_args.args[0] == "full"


def test_runner_applies_incremental_improvement_targets(tmp_path) -> None:
    pipeline = MagicMock()
    pipeline._phase_a_complete.return_value = False
    pipeline.units_discovered = 1
    pipeline.units_skipped = 0
    pipeline.workset_unit_count = 1
    pipeline.workset_chunk_count = 1
    pipeline.run_extraction = AsyncMock()
    pipeline.run_graph_build = AsyncMock()
    pipeline.improvement_targets.return_value = ImprovementTargets(
        entity_ids=("e1",), fact_ids=("f1",)
    )
    checkpoint = MagicMock(batch_id="batch-improve")
    checkpoint.is_done.return_value = False
    pipeline.all_chunks.return_value = [SimpleNamespace(id="c1")]
    applied = ImprovementResult(
        requested_mode="auto",
        applied_mode="incremental",
        changed_community_ids=("comm-new", "comm-old"),
    )
    finalize = MagicMock()

    with (
        patch("kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline),
        patch("kl_graph.ingest.runner.run_improvement", return_value=applied) as improve,
    ):
        asyncio.run(
            run_ingestion(
                IngestOptions(tmp_path, "slack-prod", improve_mode="auto"),
                checkpoint=checkpoint,
                finalize_callback=finalize,
            )
        )

    improve.assert_called_once()
    assert improve.call_args.args[0] == "auto"
    assert improve.call_args.kwargs["targets"].fact_ids == ("f1",)
    update = finalize.call_args.args[0]
    assert update.similarity_nodes == (("entity", "e1"), ("fact", "f1"))
    assert update.community_ids == ("comm-new", "comm-old")


def test_runner_sends_dirty_serving_index_scopes_to_finalizer(tmp_path) -> None:
    pipeline = MagicMock()
    pipeline._phase_a_complete.return_value = False
    pipeline.units_discovered = 1
    pipeline.units_skipped = 0
    pipeline.workset_unit_count = 1
    pipeline.workset_chunk_count = 1
    pipeline.run_extraction = AsyncMock()
    pipeline.run_graph_build = AsyncMock()
    pipeline.all_chunks.return_value = [SimpleNamespace(id="c1")]
    pipeline.improvement_targets.return_value = ImprovementTargets(
        entity_ids=("e1",), fact_ids=("f1",)
    )
    checkpoint = MagicMock(batch_id="batch-finalize")
    checkpoint.is_done.return_value = False
    finalize = MagicMock()

    with patch("kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline):
        asyncio.run(
            run_ingestion(
                IngestOptions(tmp_path, "slack-prod", improve_mode="off"),
                checkpoint=checkpoint,
                finalize_callback=finalize,
            )
        )

    update = finalize.call_args.args[0]
    assert update.structural_nodes == (("chunk", "c1"), ("fact", "f1"))
    assert update.similarity_nodes == ()
    assert update.community_ids == ()
    assert update.pagerank_dirty is True
    assert update.full_adjacency is False


def test_runner_skips_finalizer_for_empty_mutation_free_run(tmp_path) -> None:
    pipeline = MagicMock()
    pipeline._phase_a_complete.return_value = False
    pipeline.units_discovered = 0
    pipeline.units_skipped = 0
    pipeline.workset_unit_count = 0
    pipeline.workset_chunk_count = 0
    pipeline.run_extraction = AsyncMock()
    pipeline.run_graph_build = AsyncMock()
    pipeline.all_chunks.return_value = []
    pipeline.improvement_targets.return_value = ImprovementTargets()
    checkpoint = MagicMock(batch_id="batch-empty")
    checkpoint.is_done.return_value = False
    finalize = MagicMock()

    with patch("kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline):
        asyncio.run(
            run_ingestion(
                IngestOptions(tmp_path, "slack-prod", improve_mode="off"),
                checkpoint=checkpoint,
                finalize_callback=finalize,
            )
        )

    finalize.assert_not_called()


def test_cli_default_path_delegates_to_shared_runner(tmp_path) -> None:
    from scripts import ingest

    checkpoint = MagicMock(source_hash="abc")
    shared_run = AsyncMock()
    argv = [
        "scripts/ingest.py",
        "--input-dir",
        str(tmp_path),
        "--source-id",
        "teams-prod",
        "--no-improve",
    ]
    with (
        patch("sys.argv", argv),
        patch.object(ingest, "make_checkpoint", return_value=checkpoint),
        patch.object(ingest, "run_ingestion", shared_run),
    ):
        asyncio.run(ingest.main())

    options = shared_run.await_args.args[0]
    assert options.input_dir == tmp_path.resolve()
    assert options.source_id == "teams-prod"
    assert options.improve_mode == "off"
