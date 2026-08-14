"""The endpoint and CLI share the unit-incremental ingestion runner."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from kl_graph.ingest.improvement import ImprovementResult, ImprovementTargets
from kl_graph.ingest.llm_extractor import ExtractionFailure
from kl_graph.ingest.runner import IngestOptions, IngestResult, run_ingestion


def test_ingest_options_reject_nonpositive_concurrency(tmp_path) -> None:
    with pytest.raises(ValueError, match="greater than zero"):
        IngestOptions(tmp_path, "slack-prod", concurrency=0)


def test_make_checkpoint_uses_portable_sql_conn(tmp_path) -> None:
    """make_checkpoint 必须走两种后端都实现的 sql_conn 访问器。

    回归用例：服务端复用图后端（LadybugStore），它只暴露 sql_conn，没有
    裸 SQLiteStore 那个 conn 属性。此前误用 store.conn，导致真实服务器上
    Phase A 一建检查点就抛 AttributeError；而单测把 make_checkpoint 整个
    mock 掉了，从没真跑过这条路径，故静默漏过（AGENTS.md §4）。
    这里用一个只提供 sql_conn 的假 store 驱动真正的 make_checkpoint。
    """
    import sqlite3

    from kl_graph.ingest.runner import make_checkpoint
    from kl_graph.storage.sqlite_store import SQLiteStore

    # 用真正的 SQLiteStore 建库以获得 ingest_checkpoint 等表结构，
    # 再把它的连接藏在一个只暴露 sql_conn 的壳里，模拟图后端。
    backing = SQLiteStore(tmp_path / "knowledge.db")

    class _LadybugLikeStore:
        """模拟图后端：只暴露 sql_conn，故意不提供 .conn。"""

        @property
        def sql_conn(self) -> sqlite3.Connection:
            return backing.conn

    options = IngestOptions(tmp_path, "slack-prod")
    checkpoint = make_checkpoint(options, data_dir=tmp_path, store=_LadybugLikeStore())
    assert checkpoint.source_id == "slack-prod"
    backing.close()


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
        result={
            "units_discovered": 2,
            "units_skipped": 1,
            "units_processed": 1,
            "chunks_created": 1,
            "extraction_total": 0,
            "extraction_succeeded": 0,
            "extraction_failed": 0,
            "failures": [],
            "skipped_reason": "",
        },
    )
    pipeline.close.assert_called_once()


def test_runner_reports_partial_extraction_outcome(tmp_path) -> None:
    failure = ExtractionFailure(
        extraction_item_id="item-2",
        source_unit_id="unit-2",
        target_chunk_id="chunk-1",
        error_type="rate_limit",
        message="throttled",
        attempts=3,
    )
    pipeline = MagicMock()
    pipeline._phase_a_complete.return_value = False
    pipeline.units_discovered = 2
    pipeline.units_skipped = 0
    pipeline.workset_unit_count = 2
    pipeline.workset_chunk_count = 1
    pipeline.extraction_items = [SimpleNamespace(id="item-1"), SimpleNamespace(id="item-2")]
    pipeline.run_extraction = AsyncMock(return_value=(failure,))
    pipeline.run_graph_build = AsyncMock()
    checkpoint = MagicMock(batch_id="batch-partial")
    checkpoint.is_done.return_value = False
    seen = []

    with patch("kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline):
        result = asyncio.run(
            run_ingestion(
                IngestOptions(tmp_path, "slack-prod", improve_mode="off"),
                checkpoint=checkpoint,
                counts_callback=seen.append,
            )
        )

    assert result.outcome == "partial"
    assert result.extraction_total == 2
    assert result.extraction_succeeded == 1
    assert result.extraction_failed == 1
    assert result.failures == (failure,)
    assert seen[-1] == result


def test_runner_skips_round_when_workset_unrecoverable(tmp_path) -> None:
    """SkipRoundError 从 pipeline 冒出时，runner 不硬失败：reset 检查点、
    标记 outcome='skipped'（完成带告警），counts_callback 收到 skip 结果，
    图谱不动。回归 AGENTS.md §4/§5：可容忍的“本轮不可续”不该报成崩溃。"""
    from kl_graph.ingest.recovery import SkipRoundError

    pipeline = MagicMock()
    pipeline._phase_a_complete.return_value = False
    # Phase A 触发 _load_workset → 工作集不可重建 → 抛 SkipRoundError。
    pipeline.run_phase_a.side_effect = SkipRoundError(
        "workset unavailable; skipping this round and keeping the accumulated "
        "graph; restore a snapshot if needed."
    )
    checkpoint = MagicMock(batch_id="batch-skip")
    checkpoint.is_done.return_value = False
    seen: list[IngestResult] = []

    with patch("kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline):
        result = asyncio.run(
            run_ingestion(
                IngestOptions(tmp_path, "slack-prod", improve_mode="off"),
                checkpoint=checkpoint,
                counts_callback=seen.append,
            )
        )

    assert result.outcome == "skipped"
    assert "--fresh-db" not in result.warning
    assert "snapshot" in result.warning.lower()
    # 丢弃坏轮次的续跑状态，让下一轮从干净 batch 继续累积。
    checkpoint.reset.assert_called_once()
    # 图谱不动：既没标记完成，也没清理工作集。
    checkpoint.mark_done.assert_not_called()
    pipeline.complete_workset.assert_not_called()
    # skip 结果通过 counts_callback 写进 ingest_progress（→ ingest_runs.warning）。
    assert seen and seen[-1].outcome == "skipped"
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


def test_completed_checkpoint_restores_partial_outcome(tmp_path) -> None:
    pipeline = MagicMock()
    checkpoint = MagicMock(batch_id="batch-complete")
    checkpoint.is_done.side_effect = lambda step, **_: step == "ingest.complete"
    failure = ExtractionFailure(
        extraction_item_id="item-2",
        source_unit_id="unit-2",
        target_chunk_id="chunk-1",
        error_type="timeout",
        message="timed out",
        attempts=3,
    )
    expected = IngestResult(
        2,
        0,
        2,
        1,
        extraction_total=2,
        extraction_succeeded=1,
        extraction_failed=1,
        failures=(failure,),
    )
    checkpoint.step_metadata.return_value = {
        "result": expected.as_checkpoint_dict()
    }

    with patch("kl_graph.ingest.runner.IngestionPipeline", return_value=pipeline):
        result = asyncio.run(
            run_ingestion(
                IngestOptions(tmp_path, "slack-prod", improve_mode="off"),
                checkpoint=checkpoint,
            )
        )

    assert result == expected
    assert result.outcome == "partial"
    pipeline.complete_workset.assert_called_once()


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
