"""Tests for DB-backed checkpoint (ingest_checkpoint table).

Covers:
1. Atomicity: phase_a.persist_chunks done and workset row in same commit
2. JSON migration: imports correctly and deletes the JSON file
3. Wipe-consistency: dropping knowledge.db clears checkpoint too
4. round_started_at survives complete_ingest_batch (parent row kept)
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path

import pytest

from kl_graph.ingest.checkpoint import IngestCheckpoint
from kl_graph.storage.sqlite_store import SQLiteStore

# ─── Helpers ──────────────────────────────────────────────────────────────────


def _store(tmp_path: Path) -> SQLiteStore:
    """Open a fresh in-memory-like SQLite store backed by a temp file."""
    db = tmp_path / "knowledge.db"
    return SQLiteStore(db)


def _checkpoint(store: SQLiteStore, source_id: str = "test-source") -> IngestCheckpoint:
    return IngestCheckpoint(store.conn, source_id, source_dirs=[])


def _fake_chunk():
    """Return a minimal Chunk-like object suitable for insert_chunks_with_units."""
    from kl_graph.models.types import Chunk

    return Chunk(
        id=f"cnk:{uuid.uuid4().hex[:8]}",
        content="test chunk content",
        source_type="document",
        timestamp=int(time.time()),
    )


# ─── 1. Atomicity ─────────────────────────────────────────────────────────────


def test_atomicity_phase_a_done_requires_workset_row(tmp_path: Path) -> None:
    """phase_a.persist_chunks step and workset row land in the same commit.

    If we commit the checkpoint step atomically inside insert_chunks_with_units,
    the two can never diverge: either both exist or neither exists.  We verify
    this by checking that after the call both the checkpoint step is done AND
    the ingest_batches row is present.
    """
    store = _store(tmp_path)
    cp = _checkpoint(store)
    batch_id = cp.batch_id

    chunk = _fake_chunk()

    def _cb(conn: sqlite3.Connection) -> None:
        cp.mark_done_in_transaction(
            "phase_a.persist_chunks",
            conn,
            params={"ingestion_plan_schema": 1},
        )

    store.insert_chunks_with_units(
        [chunk],
        [],
        [],
        batch_id=batch_id,
        batch_source_id="test-source",
        source_hash=cp.source_hash,
        checkpoint_step_callback=_cb,
    )
    # The pipeline calls mark_done() after the atomic write to sync in-memory
    # state; mirror that here.
    cp.mark_done("phase_a.persist_chunks", params={"ingestion_plan_schema": 1})

    # After the single atomic commit: checkpoint step is done
    assert cp.is_done("phase_a.persist_chunks", params={"ingestion_plan_schema": 1})
    # And the ingest_batches row exists
    row = store.get_ingest_batch(batch_id)
    assert row is not None
    assert row["state"] == "ready"

    # Verify the DB row itself contains the step (not just in-memory)
    db_row = store.get_checkpoint(cp.source_id)
    assert db_row is not None
    db_steps = json.loads(db_row["steps"])
    assert db_steps.get("phase_a.persist_chunks", {}).get("status") == "done"
    store.close()


def test_atomicity_no_half_committed_state(tmp_path: Path) -> None:
    """Simulate a crash mid-transaction: no half-state lands in the DB.

    We inject a callback that raises, which causes the ``with self.conn:``
    transaction to roll back.  Neither the workset row nor the checkpoint step
    should be committed.
    """
    store = _store(tmp_path)
    cp = _checkpoint(store)
    batch_id = cp.batch_id
    chunk = _fake_chunk()

    def _failing_cb(conn: sqlite3.Connection) -> None:
        cp.mark_done_in_transaction(
            "phase_a.persist_chunks",
            conn,
            params={"ingestion_plan_schema": 1},
        )
        raise RuntimeError("simulated crash inside transaction")

    with pytest.raises(RuntimeError, match="simulated crash"):
        store.insert_chunks_with_units(
            [chunk],
            [],
            [],
            batch_id=batch_id,
            batch_source_id="test-source",
            source_hash=cp.source_hash,
            checkpoint_step_callback=_failing_cb,
        )

    # Nothing should be committed
    assert not cp.is_done("phase_a.persist_chunks")
    # The batch row was either never inserted or rolled back
    row = store.get_ingest_batch(batch_id)
    assert row is None
    store.close()


# ─── 2. JSON Migration ────────────────────────────────────────────────────────


def test_json_migration_imports_and_deletes(tmp_path: Path) -> None:
    """Legacy JSON checkpoint is imported into the DB and the file is deleted."""
    source_id = "slack_prod"
    batch_id = str(uuid.uuid4())
    fake_steps = {"phase_a.persist_chunks": {"status": "done", "ts": int(time.time())}}

    json_path = tmp_path / f"ingest_checkpoint.{source_id}.json"
    json_path.write_text(
        json.dumps({
            "version": 1,
            "source_hash": "sha256:abc123",
            "batch_id": batch_id,
            "workset_schema": 1,
            "steps": fake_steps,
        }),
        encoding="utf-8",
    )

    # Opening the store should trigger the migration automatically.
    store = SQLiteStore(tmp_path / "knowledge.db")

    row = store.get_checkpoint(source_id)
    assert row is not None, "Migrated checkpoint row should exist in DB"
    assert row["batch_id"] == batch_id
    assert row["source_hash"] == "sha256:abc123"
    # Steps were imported as JSON
    steps = json.loads(row["steps"])
    assert steps["phase_a.persist_chunks"]["status"] == "done"
    # JSON file was deleted after successful import
    assert not json_path.exists(), "JSON file should be deleted after migration"
    store.close()


def test_json_migration_skips_when_row_already_exists(tmp_path: Path) -> None:
    """If a DB row already exists for the source_id, JSON import is skipped."""
    source_id = "slack_prod"
    db_path = tmp_path / "knowledge.db"

    # Pre-populate the DB row before writing the JSON
    store1 = SQLiteStore(db_path)
    store1.upsert_checkpoint(
        source_id,
        version=1,
        source_hash="sha256:existing",
        batch_id="existing-batch",
        workset_schema=1,
        steps={},
        created_at=int(time.time()),
    )
    store1.close()

    # Write a conflicting JSON file
    json_path = tmp_path / f"ingest_checkpoint.{source_id}.json"
    json_path.write_text(
        json.dumps({
            "version": 1,
            "source_hash": "sha256:from-json",
            "batch_id": "json-batch",
            "workset_schema": 1,
            "steps": {},
        }),
        encoding="utf-8",
    )

    # Re-open the store (migration runs again)
    store2 = SQLiteStore(db_path)
    row = store2.get_checkpoint(source_id)
    assert row is not None
    # Existing DB row should NOT be overwritten
    assert row["batch_id"] == "existing-batch"
    # JSON file should still exist (was not deleted)
    assert json_path.exists()
    store2.close()


# ─── 3. Wipe-consistency ──────────────────────────────────────────────────────


def test_dropping_db_clears_checkpoint(tmp_path: Path) -> None:
    """Deleting knowledge.db removes the checkpoint (they share the same file)."""
    db_path = tmp_path / "knowledge.db"
    store = SQLiteStore(db_path)
    cp = _checkpoint(store)
    cp.mark_done("phase_a.persist_chunks")
    store.close()

    assert db_path.exists()

    # Simulate a --fresh-db wipe
    db_path.unlink()
    assert not db_path.exists()

    # Re-open: fresh DB means no checkpoint
    store2 = SQLiteStore(db_path)
    row = store2.get_checkpoint("test-source")
    assert row is None
    store2.close()


# ─── 4. batch_id + round_started_at survive complete_ingest_batch ─────────────


def test_round_started_at_survives_complete_ingest_batch(tmp_path: Path) -> None:
    """complete_ingest_batch deletes child rows but keeps the parent batch row.

    round_started_at is written in the INSERT (first-wins) and is therefore
    stable: it records when the round actually began, not when it ended.
    After complete_ingest_batch the parent row must still exist and
    round_started_at must be non-zero.
    """
    store = _store(tmp_path)
    cp = _checkpoint(store)
    batch_id = cp.batch_id
    chunk = _fake_chunk()

    store.insert_chunks_with_units(
        [chunk],
        [],
        [],
        batch_id=batch_id,
        batch_source_id="test-source",
        source_hash=cp.source_hash,
    )

    row_before = store.get_ingest_batch(batch_id)
    assert row_before is not None
    assert row_before["round_started_at"] > 0

    store.complete_ingest_batch(batch_id)

    # Parent row still present, round_started_at unchanged
    row_after = store.get_ingest_batch(batch_id)
    assert row_after is not None, "Parent batch row must survive complete_ingest_batch"
    assert row_after["round_started_at"] == row_before["round_started_at"]
    assert row_after["state"] == "complete"
    store.close()


def test_batch_id_in_checkpoint_matches_ingest_batches(tmp_path: Path) -> None:
    """The batch_id stored in the checkpoint matches the ingest_batches row."""
    store = _store(tmp_path)
    cp = _checkpoint(store)
    batch_id = cp.batch_id

    assert batch_id, "batch_id must be non-empty"

    chunk = _fake_chunk()
    store.insert_chunks_with_units(
        [chunk],
        [],
        [],
        batch_id=batch_id,
        batch_source_id="test-source",
        source_hash=cp.source_hash,
    )

    row = store.get_ingest_batch(batch_id)
    assert row is not None
    assert row["batch_id"] == batch_id
    store.close()
