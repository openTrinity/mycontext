"""Checkpoint guard behavior shared by ingestion and improvement steps."""

from __future__ import annotations

from pathlib import Path

from kl_graph.ingest.checkpoint import IngestCheckpoint


def _checkpoint(tmp_path: Path) -> IngestCheckpoint:
    return IngestCheckpoint(tmp_path / "checkpoint.json", source_dirs=[])


def test_undone_step_runs_and_commits(tmp_path: Path) -> None:
    checkpoint = _checkpoint(tmp_path)
    with checkpoint.step("improve.incremental_similarity") as guard:
        assert guard.skip is False
        guard.done(count=3)
    assert checkpoint.is_done("improve.incremental_similarity")


def test_done_step_is_skipped(tmp_path: Path) -> None:
    checkpoint = _checkpoint(tmp_path)
    checkpoint.mark_done("improve.incremental_similarity")
    with checkpoint.step("improve.incremental_similarity") as guard:
        assert guard.skip is True


def test_skip_callback_restores_state(tmp_path: Path) -> None:
    checkpoint = _checkpoint(tmp_path)
    checkpoint.mark_done("phase_b.build_entities")
    restored: list[bool] = []
    with checkpoint.step(
        "phase_b.build_entities", on_skip=lambda: restored.append(True)
    ) as guard:
        assert guard.skip is True
    assert restored == [True]


def test_parameter_change_reruns_step(tmp_path: Path) -> None:
    checkpoint = _checkpoint(tmp_path)
    checkpoint.mark_done("improve.incremental_similarity", params={"batch_id": "a"})
    with checkpoint.step(
        "improve.incremental_similarity", params={"batch_id": "b"}
    ) as guard:
        assert guard.skip is False
