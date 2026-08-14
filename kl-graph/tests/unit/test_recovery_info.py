"""Unit tests for GET /ingest/recovery-info and POST /ingest/stop endpoints.

Covers:
- Identity pair (ingestion_id + round_started_at) is stable across
  complete_ingest_batch (parent row survives).
- Endpoint returns all five store paths under data_dir (all fake paths —
  AGENTS.md §1 fixture rules).
- recovery_tier is determined by the full classifier.
- Quiesce cancels the running task and clears state handles.
- After quiesce, store, qdrant_main, qdrant_communities are None.

All fake IDs use FAKE0001-style values (AGENTS.md §1).
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
    """store_paths must include all stores under data_dir.

    向量目录名跟随实际生效的后端（默认 zvec → zvec_data），不写死 qdrant_data：
    _store_paths 用启动时同源的 VECTOR_PATH / COMMUNITY_VECTOR_PATH 派生，
    桌面端才能删到/恢复到真正的向量目录（AGENTS.md §4 静默降级回归）。
    """
    state = _state(tmp_path)
    fake_data_dir = tmp_path / "data"

    monkeypatch.setattr(kl_server, "state", state)
    monkeypatch.setattr(kl_server, "DATA_DIR", fake_data_dir)

    response = asyncio.run(kl_server.get_recovery_info())

    paths = response["store_paths"]
    assert isinstance(paths, list)
    assert len(paths) >= 5

    # 除向量目录外，其余路径都在 fake data_dir 下；向量目录取自 VECTOR_PATH /
    # COMMUNITY_VECTOR_PATH（模块级常量，绑定的是进程启动时的 DATA_DIR），
    # monkeypatch DATA_DIR 不会改到它们，所以单独按名字断言即可。
    vector_names = {kl_server.VECTOR_PATH.name, kl_server.COMMUNITY_VECTOR_PATH.name}
    for p in paths:
        if Path(p).name in vector_names:
            continue
        assert str(fake_data_dir) in p, f"path not under DATA_DIR: {p!r}"

    # Required stores present.
    path_names = [Path(p).name for p in paths]
    assert "knowledge.db" in path_names
    assert "graph.ladybug" in path_names
    assert "extraction_cache.db" in path_names
    # 向量主目录必须出现，且名字与实际后端一致（不再写死 qdrant_data）。
    assert kl_server.VECTOR_PATH.name in path_names


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


def test_recovery_info_case_a_resume_when_only_checkpoint_survives(
    tmp_path: Path, monkeypatch
) -> None:
    """Case A：图数据被清空、ingest_batches 整表没了，仅 ingest_checkpoint 幸存。

    回归用例：服务端取 source_id 曾只查 ingest_batches，Case A 下该表为空 →
    回退到 "default" → 分类器按 "default" 查不到检查点 → tier 恒为 "ok"，
    把需要 resume 的“清空图谱 + 陈旧检查点”场景静默判成健康（AGENTS.md §4）。
    修复后 ingest_batches 为空时改从幸存的 ingest_checkpoint 取真实 source_id，
    分类器命中 Case A → tier=resume。这里故意用非 default 的 source_id 才能暴露 bug。
    """
    import json

    state = _state(tmp_path)
    conn = state.sqlite_conn
    fake_data_dir = tmp_path / "data"

    # 仅检查点幸存：source_id 非 default，Phase A done，ingest.complete 未 done。
    steps = json.dumps({"phase_a.persist_chunks": {"status": "done"}})
    conn.execute(
        """INSERT INTO ingest_checkpoint
           (source_id, version, source_hash, batch_id, workset_schema, steps, created_at)
           VALUES (?, 1, ?, ?, 1, ?, ?)""",
        ("dingtalk", "sha256:FAKEHASH000A", "FAKEBATCH000A0001", steps, int(time.time())),
    )
    conn.commit()
    # ingest_batches 与 chunks 都为空（被清空），恰好构成 Case A。
    assert conn.execute("SELECT COUNT(*) FROM ingest_batches").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0

    monkeypatch.setattr(kl_server, "state", state)
    monkeypatch.setattr(kl_server, "DATA_DIR", fake_data_dir)

    response = asyncio.run(kl_server.get_recovery_info())

    assert response["recovery_tier"] == "resume"


def test_recovery_info_case_a_ingestion_id_falls_back_to_checkpoint(
    tmp_path: Path, monkeypatch
) -> None:
    """Case A：ingest_batches 被清空时，ingestion_id 仍取自幸存的 checkpoint。

    回归用例：_current_ingestion_identity 曾只查 ingest_batches，Case A 下该表为空
    → 返回 ("", 0)。桌面端按 ingestion_id 归档轮前备份，空串会让它找不到该恢复
    哪一份备份，恢复链路静默断掉（AGENTS.md §4）。修复后回退到
    ingest_checkpoint.batch_id 取真实 id；round_started_at 未存于 checkpoint，
    诚实保持 0，不臆造。
    """
    import json

    state = _state(tmp_path)
    conn = state.sqlite_conn
    fake_data_dir = tmp_path / "data"

    steps = json.dumps({"phase_a.persist_chunks": {"status": "done"}})
    conn.execute(
        """INSERT INTO ingest_checkpoint
           (source_id, version, source_hash, batch_id, workset_schema, steps, created_at)
           VALUES (?, 1, ?, ?, 1, ?, ?)""",
        ("dingtalk", "sha256:FAKEHASH000A", "FAKEBATCH000A0001", steps, int(time.time())),
    )
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM ingest_batches").fetchone()[0] == 0

    monkeypatch.setattr(kl_server, "state", state)
    monkeypatch.setattr(kl_server, "DATA_DIR", fake_data_dir)

    ingestion_id, round_started_at = kl_server._current_ingestion_identity()

    assert ingestion_id == "FAKEBATCH000A0001"
    assert round_started_at == 0


def test_recovery_info_lazy_conn_has_row_factory_for_classifier(
    tmp_path: Path, monkeypatch
) -> None:
    """懒开的 per-thread 连接必须带 row_factory=Row，否则分类器静默降级。

    回归用例：quiesce（stop）清空线程本地句柄后，下一次
    recovery-info 在工作线程上经 _open_sqlite 懒开一条新连接。该连接不经过
    SQLiteStore（后者才设 row_factory），若漏设，classify_recovery 按列名取值
    （cp_row["batch_id"]）会抛 TypeError，被 _recovery_tier_from_db 吞掉后退回
    粗粒度启发式——把 chunk_count 失配的 Case D（应 cleanup）静默误报成 resume
    （AGENTS.md §4）。这里构造一个 file-backed 的 Case D，只设 _sqlite_path 让
    端点走懒开路径，断言 tier 仍为 cleanup。
    """
    import json

    db_path = tmp_path / "knowledge.db"
    # 先用 SQLiteStore 建表，再直接写入一个 Case D：batch 行在、state='ready'、
    # 记录的 chunk_count 与实际不符（99 vs 0）→ 分类器判 D → tier=cleanup。
    seed = SQLiteStore(db_path)
    seed_conn = seed.conn
    steps = json.dumps({"phase_a.persist_chunks": {"status": "done"}})
    seed_conn.execute(
        """INSERT INTO ingest_checkpoint
           (source_id, version, source_hash, batch_id, workset_schema, steps, created_at)
           VALUES (?, 1, ?, ?, 1, ?, ?)""",
        ("dingtalk", "sha256:FAKEHASH000D", "FAKEBATCH000D0001", steps, int(time.time())),
    )
    _insert_batch(
        seed_conn,
        batch_id="FAKEBATCH000D0001",
        source_id="dingtalk",
        state_str="ready",
        chunk_count=99,
    )
    seed_conn.commit()
    seed.close()

    # 全新 ServerState，只给它文件路径 → sqlite_conn 走 _open_sqlite 懒开。
    state = kl_server.ServerState()
    state._sqlite_path = str(db_path)
    store = MagicMock()
    store.close = MagicMock()
    store.count_edges = MagicMock(return_value=0)
    state.store = store
    state.ready = True
    state.startup_time = 0

    monkeypatch.setattr(kl_server, "state", state)
    monkeypatch.setattr(kl_server, "DATA_DIR", tmp_path / "data")

    # 分类器需要按真实 source_id 命中检查点。
    fake_cfg = SimpleNamespace(application=SimpleNamespace(source_id="dingtalk"))
    with patch("kl_graph.ingest.recovery.logger"), patch("kl_server.cfg", fake_cfg):
        response = asyncio.run(kl_server.get_recovery_info())

    assert response["recovery_tier"] == "cleanup"


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
