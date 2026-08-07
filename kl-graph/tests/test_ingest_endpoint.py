"""Local-directory ingest endpoint and persisted status tests."""

from __future__ import annotations

import asyncio
import sqlite3
from unittest.mock import AsyncMock

import kl_server
from kl_graph.storage.sqlite_store import SQLiteStore


class _RunningTask:
    def done(self) -> bool:
        return False


def _state(tmp_path) -> kl_server.ServerState:
    state = kl_server.ServerState()
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    store = SQLiteStore(tmp_path / "unused.db", conn=conn)
    state.sqlite_conn = conn
    state.store = store
    state.ready = True
    state.startup_time = 0
    return state


def test_ingest_accepts_local_path_and_queues_behind_active_run(
    tmp_path, monkeypatch
) -> None:
    state = _state(tmp_path)
    state.ingest_task = _RunningTask()
    state.current_run_id = "active-run"
    monkeypatch.setattr(kl_server, "state", state)

    response = asyncio.run(
        kl_server.ingest(
            kl_server.IngestRequest(input_dir=str(tmp_path), source_id="ding-prod")
        )
    )

    assert response["status"] == "continued"
    assert response["run_id"] == "active-run"
    row = state.sqlite_conn.execute(
        "SELECT source_id, input_dir, state FROM ingest_runs"
    ).fetchone()
    assert tuple(row) == ("ding-prod", str(tmp_path.resolve()), "queued")


def test_status_reads_latest_persisted_ingest_run(tmp_path, monkeypatch) -> None:
    state = _state(tmp_path)
    now = 123
    state.sqlite_conn.execute(
        """INSERT INTO ingest_runs
           (run_id, source_id, input_dir, state, phase, percent, detail,
            started_at, updated_at)
           VALUES ('r1', 'slack', 'D:/exports', 'done', '', 1, 'complete', ?, ?)""",
        (now, now),
    )
    state.sqlite_conn.commit()
    monkeypatch.setattr(kl_server, "state", state)

    response = asyncio.run(kl_server.get_status())

    assert response["ingest"]["run_id"] == "r1"
    assert response["ingest"]["source_id"] == "slack"
    assert response["ingest"]["percent"] == 1


def test_server_ingest_job_delegates_to_shared_runner(tmp_path, monkeypatch) -> None:
    from kl_graph.ingest import runner

    server_state = _state(tmp_path)
    server_state.ingest_progress = {}
    monkeypatch.setattr(kl_server, "state", server_state)
    monkeypatch.setattr(kl_server, "_shared_stores", lambda: ("store", "qdrant"))
    monkeypatch.setattr(kl_server, "_hot_swap_graph", lambda: None)
    shared_run = AsyncMock()
    monkeypatch.setattr(runner, "run_ingestion", shared_run)

    asyncio.run(
        kl_server._run_single_ingest_job(
            kl_server.IngestRequest(
                input_dir=str(tmp_path), source_id="slack-prod", concurrency=12
            )
        )
    )

    options = shared_run.await_args.args[0]
    assert options.input_dir == tmp_path
    assert options.source_id == "slack-prod"
    assert options.concurrency == 12
