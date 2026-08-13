"""Checkpoint guard behavior shared by ingestion and improvement steps."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from kl_graph.ingest.checkpoint import IngestCheckpoint


def _checkpoint(tmp_path: Path) -> IngestCheckpoint:
    conn = sqlite3.connect(str(tmp_path / "checkpoint.db"))
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ingest_checkpoint (
            source_id TEXT PRIMARY KEY,
            version INTEGER NOT NULL DEFAULT 1,
            source_hash TEXT NOT NULL DEFAULT '',
            batch_id TEXT NOT NULL DEFAULT '',
            workset_schema INTEGER NOT NULL DEFAULT 0,
            steps TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.commit()
    return IngestCheckpoint(conn, "test-source", source_dirs=[])


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
