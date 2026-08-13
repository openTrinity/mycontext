"""Unit tests for GET /ingest/recovery-info and POST /ingest/stop endpoints.

Covers:
- Identity pair (ingestion_id + round_started_at) is stable across
  complete_ingest_batch (parent row survives).
- Endpoint returns all five store paths under data_dir (all fake paths —
  CLAUDE.md §1 fixture rules).
- recovery_tier is determined by the full classifier.
- Quiesce cancels the running task and clears state handles.
- After quiesce, store, qdrant_main, qdrant_communities are None.

All fake IDs use FAKE0001-style values (CLAUDE.md §1).
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import kl_server
from kl_graph.storage.sqlite_store import SQLiteStore

# ─── Helpers ──────────────────────────────────────────────────────────────────


def _state(tmp_path: Path) -> kl_server.ServerState:
    """Build a minimal ServerState backed by an in-memory SQLite DB."""
    state = kl_server.ServerState()
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    SQLiteStore(tmp_path / "unused.db", conn=conn)
    state.sqlite_conn = conn
    store = MagicMock()
    store.close = MagicMock()
    store.count_edges = MagicMock(return_value=0)
    state.store = store
    state.ready = True
    state.startup_time = 0
    return state


def _insert_batch(
    conn: sqlite3.Connection,
    *,
    batch_id: str,
    source_id: str = "default",
    state_str: str = "ready",
    round_started_at: int | None = None,
    chunk_count: int = 0,
) -> None:
    """Insert a minimal ingest_batches row using fake IDs only."""
    now = int(time.time())
    ts = round_started_at if round_started_at is not None else now
    conn.execute(
        """INSERT INTO ingest_batches
           (batch_id, source_id, source_hash, state, created_at, updated_at,
            round_started_at, chunk_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (batch_id, source_id, "sha256:FAKEHASH0001", state_str, now, now, ts, chunk_count),
    )
    conn.commit()


# ─── 1. Identity pair stability ───────────────────────────────────────────────


def test_identity_pair_stable_after_complete_ingest_batch(tmp_path: Path) -> None:
    """round_started_at and batch_id survive complete_ingest_batch.

    The parent row (ingest_batches) must not be deleted on completion —
    only the workset children are removed.  This ensures the wrapper can
    always read the identity pair even after a successful round.
    """
    store = SQLiteStore(tmp_path / "knowledge.db")
    conn = store.conn
    batch_id = f"FAKEBATCH{uuid.uuid4().hex[:8].upper()}"
    round_ts = 1_700_000_000

    _insert_batch(
        conn,
        batch_id=batch_id,
        state_str="ready",
        round_started_at=round_ts,
        chunk_count=0,
    )

    # complete_ingest_batch should keep the parent row.
    store.complete_ingest_batch(batch_id)

    row = conn.execute(
        "SELECT batch_id, round_started_at, state FROM ingest_batches WHERE batch_id=?",
        (batch_id,),
    ).fetchone()
    assert row is not None, "parent row must survive complete_ingest_batch"
    assert row["batch_id"] == batch_id
    assert row["round_started_at"] == round_ts
    assert row["state"] == "complete"
    store.close()


# ─── 2. Endpoint returns correct store paths ──────────────────────────────────


def test_recovery_info_returns_five_store_paths(tmp_path: Path, monkeypatch) -> None:
    """store_paths must include all five stores under data_dir."""
    state = _state(tmp_path)
    fake_data_dir = tmp_path / "data"

    monkeypatch.setattr(kl_server, "state", state)
    monkeypatch.setattr(kl_server, "DATA_DIR", fake_data_dir)

    response = asyncio.run(kl_server.get_recovery_info())

    paths = response["store_paths"]
    assert isinstance(paths, list)
    assert len(paths) >= 5

    # All paths must be under the fake data_dir.
    for p in paths:
        assert str(fake_data_dir) in p, f"path not under DATA_DIR: {p!r}"

    # Required stores present.
    path_names = [Path(p).name for p in paths]
    assert "knowledge.db" in path_names
    assert "graph.ladybug" in path_names
    assert "qdrant_data" in path_names
    assert "extraction_cache.db" in path_names


def test_recovery_info_includes_identity_pair(tmp_path: Path, monkeypatch) -> None:
    """ingestion_id and round_started_at are populated from the DB."""
    state = _state(tmp_path)
    conn = state.sqlite_conn
    fake_data_dir = tmp_path / "data"

    batch_id = "FAKEBATCH0001AABB"
    round_ts = 1_710_000_000
    _insert_batch(
        conn,
        batch_id=batch_id,
        state_str="ready",
        round_started_at=round_ts,
    )

    monkeypatch.setattr(kl_server, "state", state)
    monkeypatch.setattr(kl_server, "DATA_DIR", fake_data_dir)

    response = asyncio.run(kl_server.get_recovery_info())

    assert response["ingestion_id"] == batch_id
    assert response["round_started_at"] == round_ts


def test_recovery_info_ok_when_no_batch(tmp_path: Path, monkeypatch) -> None:
    """recovery_tier is 'ok' when no batch rows exist."""
    state = _state(tmp_path)
    fake_data_dir = tmp_path / "data"

    monkeypatch.setattr(kl_server, "state", state)
    monkeypatch.setattr(kl_server, "DATA_DIR", fake_data_dir)

    response = asyncio.run(kl_server.get_recovery_info())

    assert response["recovery_tier"] in ("ok", "resume", "cleanup")
    # With no batches and no checkpoint, "ok" is expected.
    assert response["recovery_tier"] == "ok"


def test_recovery_info_resume_when_workset_present(tmp_path: Path, monkeypatch) -> None:
    """recovery_tier is 'resume' when a ready workset exists (classifier path)."""
    state = _state(tmp_path)
    conn = state.sqlite_conn
    fake_data_dir = tmp_path / "data"

    batch_id = "FAKEBATCH0002CCDD"
    _insert_batch(
        conn,
        batch_id=batch_id,
        state_str="ready",
        round_started_at=1_720_000_000,
    )
    # Insert a checkpoint row with workset_schema=1 and Phase A done.
    import json
    steps = json.dumps({"phase_a.persist_chunks": {"status": "done"}})
    conn.execute(
        """INSERT INTO ingest_checkpoint
           (source_id, version, source_hash, batch_id, workset_schema, steps, created_at)
           VALUES (?, 1, ?, ?, 1, ?, ?)""",
        ("default", "sha256:FAKEHASH0002", batch_id, steps, int(time.time())),
    )
    conn.commit()

    monkeypatch.setattr(kl_server, "state", state)
    monkeypatch.setattr(kl_server, "DATA_DIR", fake_data_dir)

    # Patch config so classify_recovery picks up 'default' as source_id.
    fake_cfg = SimpleNamespace(application=SimpleNamespace(source_id="default"))
    with patch("kl_graph.ingest.recovery.logger"), patch("kl_server.cfg", fake_cfg):
        response = asyncio.run(kl_server.get_recovery_info())

    # With a ready workset the tier should be "resume".
    assert response["recovery_tier"] == "resume"


# ─── 3. Quiesce releases handles ──────────────────────────────────────────────


def test_quiesce_cancels_running_task(tmp_path: Path, monkeypatch) -> None:
    """_quiesce() cancels state.ingest_task when it is running."""
    state = _state(tmp_path)

    # Create a real coroutine that runs forever.
    async def _forever():
        await asyncio.sleep(9999)

    loop = asyncio.new_event_loop()
    task = loop.create_task(_forever())

    state.ingest_task = task
    monkeypatch.setattr(kl_server, "state", state)

    async def _run():
        return await kl_server._quiesce()

    result = loop.run_until_complete(_run())
    loop.close()

    assert result["quiesced"] is True
    assert task.cancelled() or task.done()


def test_quiesce_closes_all_handles(tmp_path: Path, monkeypatch) -> None:
    """_quiesce() sets state.store, qdrant_main, qdrant_communities to None."""
    state = _state(tmp_path)

    qdrant_main = MagicMock()
    qdrant_comm = MagicMock()
    state.qdrant_main = qdrant_main
    state.qdrant_communities = qdrant_comm

    monkeypatch.setattr(kl_server, "state", state)

    asyncio.run(kl_server._quiesce())

    assert state.store is None
    assert state.qdrant_main is None
    assert state.qdrant_communities is None
    qdrant_main.close.assert_called_once()
    qdrant_comm.close.assert_called_once()


def test_ingest_stop_endpoint_returns_identity_and_paths(
    tmp_path: Path, monkeypatch
) -> None:
    """POST /ingest/stop returns identity pair and store_paths after quiesce."""
    state = _state(tmp_path)
    conn = state.sqlite_conn
    fake_data_dir = tmp_path / "data"

    batch_id = "FAKEBATCH0003EEFF"
    round_ts = 1_730_000_000
    _insert_batch(
        conn,
        batch_id=batch_id,
        state_str="ready",
        round_started_at=round_ts,
    )

    monkeypatch.setattr(kl_server, "state", state)
    monkeypatch.setattr(kl_server, "DATA_DIR", fake_data_dir)

    response = asyncio.run(kl_server.ingest_stop())

    assert response["quiesced"] is True
    assert response["ingestion_id"] == batch_id
    assert response["round_started_at"] == round_ts
    assert isinstance(response["store_paths"], list)
    assert len(response["store_paths"]) >= 5


def test_quiesce_idempotent_when_no_task(tmp_path: Path, monkeypatch) -> None:
    """_quiesce() does not raise when no ingest_task is running."""
    state = _state(tmp_path)
    state.ingest_task = None
    monkeypatch.setattr(kl_server, "state", state)

    result = asyncio.run(kl_server._quiesce())

    assert result["quiesced"] is True


def test_recovery_info_not_ready_raises_503(tmp_path: Path, monkeypatch) -> None:
    """GET /ingest/recovery-info returns 503 when server is not ready."""
    from fastapi import HTTPException

    state = _state(tmp_path)
    state.ready = False
    monkeypatch.setattr(kl_server, "state", state)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(kl_server.get_recovery_info())

    assert exc_info.value.status_code == 503
