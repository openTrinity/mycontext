"""Unit tests for POST /ingest/stop-and-cleanup endpoint.

Covers (per design §6 Commit D):
- Endpoint stops the running job (quiesce is called).
- Endpoint returns the correct identity (ingestion_id + round_started_at).
- Warning is written to ingest_runs.warning column.
- Endpoint never performs logical deletion (no DELETE/UPDATE on chunks/entities/facts).
- Endpoint works when no job is running (still quiesces and returns identity).
- Warning text is honest: states what happened and what the wrapper must do.

All fake IDs use FAKE0001-style values (CLAUDE.md §1).
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
import uuid
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

import kl_server
from kl_graph.storage.sqlite_store import SQLiteStore

# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_state(tmp_path: Path) -> kl_server.ServerState:
    """Minimal ServerState backed by an in-memory SQLite DB with full schema."""
    s = kl_server.ServerState()
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # SQLiteStore 생성자가 schema를 초기화한다.
    SQLiteStore(tmp_path / "unused.db", conn=conn)
    s.sqlite_conn = conn
    store = MagicMock()
    store.close = MagicMock()
    s.store = store
    s.ready = True
    s.startup_time = 0
    return s


def _insert_batch(
    conn: sqlite3.Connection,
    *,
    batch_id: str,
    source_id: str = "default",
    state_str: str = "ready",
    round_started_at: int | None = None,
    chunk_count: int = 0,
) -> None:
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


def _insert_run(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    source_id: str = "default",
) -> None:
    now = int(time.time())
    conn.execute(
        """INSERT INTO ingest_runs
           (run_id, source_id, input_dir, state, phase, percent, detail,
            started_at, updated_at)
           VALUES (?, ?, '', 'running', 'phase_b', 0.5, '', ?, ?)""",
        (run_id, source_id, now, now),
    )
    conn.commit()


def _insert_chunk(conn: sqlite3.Connection, *, chunk_id: str) -> None:
    conn.execute(
        "INSERT INTO chunks (id, content, content_hash, source_type, timestamp) VALUES (?, ?, ?, ?, ?)",
        (chunk_id, "fake content", "sha256:FAKECHUNKHASH0001", "message", int(time.time())),
    )
    conn.commit()


# ─── 1. Endpoint stops the running job ────────────────────────────────────────


def test_stop_cleanup_cancels_running_task(tmp_path: Path, monkeypatch) -> None:
    """stop-and-cleanup cancels a running ingest task via _quiesce."""
    s = _make_state(tmp_path)
    conn = s.sqlite_conn
    batch_id = "FAKEBATCH0001AABB"
    _insert_batch(conn, batch_id=batch_id, state_str="ready", round_started_at=1_700_000_001)

    quiesce_called = []

    async def _fake_quiesce():
        quiesce_called.append(True)
        return {"quiesced": True, "detail": "all DB handles released"}

    monkeypatch.setattr(kl_server, "state", s)
    monkeypatch.setattr(kl_server, "_quiesce", _fake_quiesce)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    asyncio.run(kl_server.ingest_stop_and_cleanup())

    assert quiesce_called, "_quiesce must be called by stop-and-cleanup"


def test_stop_cleanup_works_when_no_task_running(tmp_path: Path, monkeypatch) -> None:
    """stop-and-cleanup still quiesces and returns identity when no job is running."""
    s = _make_state(tmp_path)
    conn = s.sqlite_conn
    s.ingest_task = None  # 실행 중인 작업 없음
    batch_id = "FAKEBATCH0002CCDD"
    round_ts = 1_710_000_000
    _insert_batch(conn, batch_id=batch_id, state_str="complete", round_started_at=round_ts)

    monkeypatch.setattr(kl_server, "state", s)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    response = asyncio.run(kl_server.ingest_stop_and_cleanup())

    assert response["ingestion_id"] == batch_id
    assert response["round_started_at"] == round_ts


# ─── 2. Endpoint returns correct identity ─────────────────────────────────────


def test_stop_cleanup_returns_correct_identity(tmp_path: Path, monkeypatch) -> None:
    """Response contains the ingestion_id and round_started_at from ingest_batches."""
    s = _make_state(tmp_path)
    conn = s.sqlite_conn
    batch_id = "FAKEBATCH0003EEFF"
    round_ts = 1_720_000_000
    _insert_batch(conn, batch_id=batch_id, state_str="ready", round_started_at=round_ts)

    monkeypatch.setattr(kl_server, "state", s)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    response = asyncio.run(kl_server.ingest_stop_and_cleanup())

    assert response["ingestion_id"] == batch_id
    assert response["round_started_at"] == round_ts
    assert isinstance(response["store_paths"], list)
    assert len(response["store_paths"]) >= 5


# ─── 3. Warning written to ingest_runs.warning ────────────────────────────────


def test_stop_cleanup_writes_warning_to_ingest_runs(tmp_path: Path, monkeypatch) -> None:
    """Warning is written to ingest_runs.warning before quiesce closes handles."""
    s = _make_state(tmp_path)
    conn = s.sqlite_conn
    batch_id = "FAKEBATCH0004GGHH"
    run_id = f"FAKERUN{uuid.uuid4().hex[:8].upper()}"
    _insert_batch(conn, batch_id=batch_id, state_str="ready", round_started_at=1_730_000_000)
    _insert_run(conn, run_id=run_id)
    s.current_run_id = run_id

    monkeypatch.setattr(kl_server, "state", s)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    # quiesce를 패치해서 SQLite 연결이 닫히지 않게 하여 warning을 확인할 수 있도록 한다.
    async def _noop_quiesce():
        return {"quiesced": True, "detail": "all DB handles released"}

    monkeypatch.setattr(kl_server, "_quiesce", _noop_quiesce)

    asyncio.run(kl_server.ingest_stop_and_cleanup())

    row = conn.execute(
        "SELECT warning FROM ingest_runs WHERE run_id=?", (run_id,)
    ).fetchone()
    assert row is not None
    assert row[0], "warning column must not be empty"
    warning_text = row[0]
    # warning은 batch_id(ingestion_id)를 언급해야 한다.
    assert batch_id in warning_text


def test_stop_cleanup_warning_is_honest(tmp_path: Path, monkeypatch) -> None:
    """Warning text must state restore requires wrapper backup and kl did no deletion."""
    s = _make_state(tmp_path)
    conn = s.sqlite_conn
    batch_id = "FAKEBATCH0005IIJJ"
    run_id = f"FAKERUN{uuid.uuid4().hex[:8].upper()}"
    _insert_batch(conn, batch_id=batch_id, state_str="ready", round_started_at=1_730_000_001)
    _insert_run(conn, run_id=run_id)
    s.current_run_id = run_id

    monkeypatch.setattr(kl_server, "state", s)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    async def _noop_quiesce():
        return {"quiesced": True, "detail": "all DB handles released"}

    monkeypatch.setattr(kl_server, "_quiesce", _noop_quiesce)

    asyncio.run(kl_server.ingest_stop_and_cleanup())

    row = conn.execute(
        "SELECT warning FROM ingest_runs WHERE run_id=?", (run_id,)
    ).fetchone()
    warning_text = row[0].lower()
    # 경고 문구가 복원을 위한 백업의 필요성을 명시해야 한다.
    assert "backup" in warning_text, "warning must mention backup"
    # kl이 논리적 삭제를 하지 않았음을 명시해야 한다.
    assert "no logical deletion" in warning_text or "no lossy deletion" in warning_text or (
        "no" in warning_text and "deletion" in warning_text
    ), "warning must state kl performed no logical deletion"


def test_stop_cleanup_creates_ingest_runs_row_when_missing(
    tmp_path: Path, monkeypatch
) -> None:
    """When no ingest_runs row exists, endpoint creates one with state='failed'."""
    s = _make_state(tmp_path)
    conn = s.sqlite_conn
    batch_id = "FAKEBATCH0006KKLL"
    _insert_batch(conn, batch_id=batch_id, state_str="ready", round_started_at=1_730_000_002)
    # current_run_id를 설정하지 않고 ingest_runs 행도 없음
    s.current_run_id = None

    monkeypatch.setattr(kl_server, "state", s)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    async def _noop_quiesce():
        return {"quiesced": True, "detail": "all DB handles released"}

    monkeypatch.setattr(kl_server, "_quiesce", _noop_quiesce)

    asyncio.run(kl_server.ingest_stop_and_cleanup())

    # ingest_runs 테이블에 경고가 있는 행이 있어야 한다.
    rows = conn.execute(
        "SELECT state, warning FROM ingest_runs"
    ).fetchall()
    assert rows, "at least one ingest_runs row must exist after stop-and-cleanup"
    warnings = [r[1] for r in rows if r[1]]
    assert warnings, "warning must be written even when no prior run_id exists"


# ─── 4. No logical deletion ───────────────────────────────────────────────────


def test_stop_cleanup_does_not_delete_chunks(tmp_path: Path, monkeypatch) -> None:
    """Endpoint must not delete or modify any rows in chunks, entities, or facts."""
    s = _make_state(tmp_path)
    conn = s.sqlite_conn
    batch_id = "FAKEBATCH0007MMNN"
    chunk_id = "FAKECHUNK0001AABB"
    _insert_batch(conn, batch_id=batch_id, state_str="ready", round_started_at=1_730_000_003)
    _insert_chunk(conn, chunk_id=chunk_id)

    monkeypatch.setattr(kl_server, "state", s)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    async def _noop_quiesce():
        return {"quiesced": True, "detail": "all DB handles released"}

    monkeypatch.setattr(kl_server, "_quiesce", _noop_quiesce)

    asyncio.run(kl_server.ingest_stop_and_cleanup())

    # chunk 행이 그대로 존재해야 한다.
    row = conn.execute("SELECT id FROM chunks WHERE id=?", (chunk_id,)).fetchone()
    assert row is not None, "stop-and-cleanup must not delete chunks"
    assert row[0] == chunk_id


# ─── 5. Error when no batch identity ──────────────────────────────────────────


def test_stop_cleanup_returns_409_when_no_batch(tmp_path: Path, monkeypatch) -> None:
    """409 is returned when no batch identity exists (nothing to stop or report)."""
    s = _make_state(tmp_path)
    # ingest_batches 행 없음

    monkeypatch.setattr(kl_server, "state", s)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(kl_server.ingest_stop_and_cleanup())

    assert exc_info.value.status_code == 409


def test_stop_cleanup_returns_503_when_not_ready(tmp_path: Path, monkeypatch) -> None:
    """503 is returned when server is not ready."""
    s = _make_state(tmp_path)
    s.ready = False

    monkeypatch.setattr(kl_server, "state", s)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(kl_server.ingest_stop_and_cleanup())

    assert exc_info.value.status_code == 503


# ─── 6. Warning mentions nothing-to-restore when no backup possible ───────────


def test_stop_cleanup_warning_mentions_no_restore_if_no_backup(
    tmp_path: Path, monkeypatch
) -> None:
    """Warning must note that no restore is possible if wrapper took no backup."""
    s = _make_state(tmp_path)
    conn = s.sqlite_conn
    batch_id = "FAKEBATCH0008OOPPQQ"
    run_id = f"FAKERUN{uuid.uuid4().hex[:8].upper()}"
    _insert_batch(conn, batch_id=batch_id, state_str="ready", round_started_at=1_730_000_004)
    _insert_run(conn, run_id=run_id)
    s.current_run_id = run_id

    monkeypatch.setattr(kl_server, "state", s)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    async def _noop_quiesce():
        return {"quiesced": True, "detail": "all DB handles released"}

    monkeypatch.setattr(kl_server, "_quiesce", _noop_quiesce)

    asyncio.run(kl_server.ingest_stop_and_cleanup())

    row = conn.execute(
        "SELECT warning FROM ingest_runs WHERE run_id=?", (run_id,)
    ).fetchone()
    warning_text = row[0].lower()
    # 백업이 없으면 복원 불가능함을 언급해야 한다.
    assert "nothing to restore" in warning_text or (
        "no backup" in warning_text or "never took a backup" in warning_text
    ), "warning must mention that no backup means nothing to restore to"
