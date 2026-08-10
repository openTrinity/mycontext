"""Local-directory ingest endpoint and persisted status tests."""

from __future__ import annotations

import asyncio
import sqlite3
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

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
    assert response["knowledge"] == {
        "messages": 0,
        "entities": 0,
        "facts": 0,
        "edges": 0,
    }
    assert "sqlite" not in response
    assert response["vectors"] == {"chunks": 0, "entities": 0, "facts": 0}
    assert "qdrant" not in response


def test_status_recovers_persisted_improve_job_type(tmp_path, monkeypatch) -> None:
    server_state = _state(tmp_path)
    server_state.sqlite_conn.execute(
        """INSERT INTO ingest_runs
           (run_id, source_id, input_dir, state, phase, started_at, updated_at)
           VALUES ('r-improve', '__improve__', '', 'done', '', 123, 123)"""
    )
    server_state.sqlite_conn.commit()
    monkeypatch.setattr(kl_server, "state", server_state)

    response = asyncio.run(kl_server.get_status())

    assert response["ingest"]["job_type"] == "improve"
    assert response["ingest"]["source_id"] is None
    assert response["ingest"]["improve_mode"] == "full"


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
    assert options.improve_mode == "auto"


def test_ingest_request_accepts_improvement_override(tmp_path) -> None:
    request = kl_server.IngestRequest(
        input_dir=str(tmp_path),
        source_id="slack-prod",
        improve_mode="full",
    )
    assert request.improve_mode == "full"


def test_improve_request_is_full_only() -> None:
    assert kl_server.ImproveRequest().mode == "full"
    with pytest.raises(ValidationError):
        kl_server.ImproveRequest(mode="incremental")


def test_improve_queues_behind_active_ingestion(tmp_path, monkeypatch) -> None:
    server_state = _state(tmp_path)
    server_state.ingest_task = _RunningTask()
    server_state.current_run_id = "active-run"
    monkeypatch.setattr(kl_server, "state", server_state)

    response = asyncio.run(kl_server.improve(kl_server.ImproveRequest()))

    assert response == {
        "status": "continued",
        "run_id": "active-run",
        "queued_run_id": response["queued_run_id"],
        "queued_job": "improve",
    }
    assert isinstance(server_state.ingest_queue[0][1], kl_server.ImproveRequest)
    row = server_state.sqlite_conn.execute(
        "SELECT source_id, input_dir, state, phase FROM ingest_runs"
    ).fetchone()
    assert tuple(row) == ("__improve__", "", "queued", "improve")


def test_improve_job_runs_full_pass_and_refreshes_adjacency(
    tmp_path, monkeypatch
) -> None:
    server_state = _state(tmp_path)
    server_state.qdrant_main = MagicMock()
    server_state.current_run_id = "improve-run"
    server_state.ingest_progress = {
        "job_type": "improve",
        "source_id": None,
        "improve_mode": "full",
    }
    monkeypatch.setattr(kl_server, "state", server_state)

    with (
        patch("kl_graph.ingest.improvement.run_improvement") as run_improvement,
        patch.object(kl_server, "_hot_swap_graph") as hot_swap,
    ):
        asyncio.run(kl_server._run_single_improve_job(kl_server.ImproveRequest()))

    run_improvement.assert_called_once()
    assert run_improvement.call_args.args == ("full",)
    assert run_improvement.call_args.kwargs["targets"].empty
    update = hot_swap.call_args.args[0]
    assert update.full_adjacency is True
    assert update.pagerank_dirty is False
    assert server_state.ingest_progress["state"] == "done"
    assert server_state.ingest_progress["job_type"] == "improve"


def test_ingest_request_rejects_removed_run_improve_field(tmp_path) -> None:
    with pytest.raises(ValidationError):
        kl_server.IngestRequest(
            input_dir=str(tmp_path),
            source_id="slack-prod",
            run_improve=False,
        )


def test_ingest_request_rejects_nonpositive_concurrency(tmp_path) -> None:
    with pytest.raises(ValidationError):
        kl_server.IngestRequest(
            input_dir=str(tmp_path),
            source_id="slack-prod",
            concurrency=0,
        )
