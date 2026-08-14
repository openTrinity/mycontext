"""Unit tests for the A/B/C/D recovery classifier (kl_graph.ingest.recovery).

Each test builds a synthetic durable state (ingest_checkpoint + ingest_batches
+ chunks table) and asserts the correct :class:`FailureCase` and
:data:`RecoveryTier`.

All fake IDs/hashes use FAKE-prefixed values (AGENTS.md §1).
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from kl_graph.ingest.recovery import FailureCase, classify_recovery
from kl_graph.models.types import Chunk
from kl_graph.storage.sqlite_store import SQLiteStore

# ─── Helpers ──────────────────────────────────────────────────────────────────


def _fresh_conn(tmp_path: Path) -> sqlite3.Connection:
    """Return a SQLite connection with the full schema applied via SQLiteStore."""
    db_path = tmp_path / "knowledge.db"
    store = SQLiteStore(db_path)
    conn = store.conn
    conn.row_factory = sqlite3.Row
    return conn


def _insert_checkpoint(
    conn: sqlite3.Connection,
    *,
    source_id: str = "default",
    batch_id: str = "FAKEBATCH0001",
    workset_schema: int = 1,
    phase_a_done: bool = False,
    ingest_complete: bool = False,
) -> None:
    """Insert a synthetic ingest_checkpoint row."""
    steps: dict = {}
    if phase_a_done:
        steps["phase_a.persist_chunks"] = {"status": "done", "ts": int(time.time())}
    if ingest_complete:
        steps["ingest.complete"] = {"status": "done", "ts": int(time.time())}

    conn.execute(
        """INSERT OR REPLACE INTO ingest_checkpoint
           (source_id, version, source_hash, batch_id, workset_schema, steps, created_at)
           VALUES (?, 1, ?, ?, ?, ?, ?)""",
        (
            source_id,
            "sha256:FAKEHASH0001",
            batch_id,
            workset_schema,
            json.dumps(steps),
            int(time.time()),
        ),
    )
    conn.commit()


def _insert_batch(
    conn: sqlite3.Connection,
    *,
    batch_id: str,
    source_id: str = "default",
    state_str: str = "ready",
    chunk_count: int = 2,
    round_started_at: int | None = None,
) -> None:
    """Insert a synthetic ingest_batches row."""
    now = int(time.time())
    ts = round_started_at if round_started_at is not None else now
    conn.execute(
        """INSERT OR IGNORE INTO ingest_batches
           (batch_id, source_id, source_hash, state, created_at, updated_at,
            round_started_at, chunk_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (batch_id, source_id, "sha256:FAKEHASH0002", state_str, now, now, ts, chunk_count),
    )
    conn.commit()


def _insert_chunks(conn: sqlite3.Connection, n: int = 2) -> None:
    """Insert n fake chunk rows so count_chunks > 0."""
    now = int(time.time())
    for i in range(n):
        conn.execute(
            """INSERT OR IGNORE INTO chunks
               (id, content, content_hash, source_type, timestamp, source_ref)
               VALUES (?, ?, ?, 'document', ?, NULL)""",
            (
                f"cnkFAKE{i:04d}",
                f"fake chunk content {i}",
                f"FAKEHASH{i:06d}",
                now,
            ),
        )
    conn.commit()


# ─── Case A ───────────────────────────────────────────────────────────────────


def test_case_a_stale_checkpoint_wiped_db(tmp_path: Path) -> None:
    """Case A: Phase A done, ingest_batches empty, count_chunks == 0.

    Signals a stale checkpoint over a wiped DB — nothing was lost.
    tier should be 'resume'.
    """
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-CASE-A"

    _insert_checkpoint(conn, batch_id=batch_id, workset_schema=1, phase_a_done=True)
    # No ingest_batches row, no chunks.

    info = classify_recovery(conn, "default")

    assert info.case == FailureCase.A
    assert info.tier == "resume"
    assert info.ingestion_id == batch_id
    assert info.count_chunks == 0
    assert info.workset_present is False


def test_case_a_ingest_complete_is_not_case_a(tmp_path: Path) -> None:
    """If ingest.complete is also done, it is a normal completed round, not Case A."""
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-CASE-A2"

    _insert_checkpoint(
        conn,
        batch_id=batch_id,
        workset_schema=1,
        phase_a_done=True,
        ingest_complete=True,
    )
    # No ingest_batches row (deleted after completion).

    info = classify_recovery(conn, "default")

    # With ingest.complete=done it should NOT be Case A resume.
    # The tier may be "ok" or "resume" but not FailureCase.A.
    assert info.case != FailureCase.A


# ─── Case B ───────────────────────────────────────────────────────────────────


def test_case_b_chunks_present_batch_gone_source_present(tmp_path: Path) -> None:
    """Case B (resume): count_chunks>0 but no ingest_batches row, source on disk."""
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-CASE-B"
    source_dir = tmp_path / "source_export"
    source_dir.mkdir()

    _insert_checkpoint(conn, batch_id=batch_id, workset_schema=1, phase_a_done=True)
    _insert_chunks(conn, n=3)
    # No ingest_batches row.

    info = classify_recovery(conn, "default", source_dir=source_dir)

    assert info.case == FailureCase.B
    assert info.tier == "resume"
    assert info.source_present is True
    assert info.count_chunks == 3


def test_case_b_chunks_present_batch_gone_source_missing(tmp_path: Path) -> None:
    """Case B (cleanup): source not on disk → cannot reconstruct workset."""
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-CASE-B2"
    source_dir = tmp_path / "source_export_missing"
    # Do NOT create source_dir.

    _insert_checkpoint(conn, batch_id=batch_id, workset_schema=1, phase_a_done=True)
    _insert_chunks(conn, n=2)

    info = classify_recovery(conn, "default", source_dir=source_dir)

    assert info.case == FailureCase.B
    assert info.tier == "cleanup"
    assert info.source_present is False


# ─── Case C ───────────────────────────────────────────────────────────────────


def test_case_c_legacy_checkpoint_no_workset_schema(tmp_path: Path) -> None:
    """Case C: workset_schema==0 → legacy checkpoint, cannot reconstruct."""
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-CASE-C"

    _insert_checkpoint(
        conn, batch_id=batch_id, workset_schema=0, phase_a_done=True
    )

    info = classify_recovery(conn, "default")

    assert info.case == FailureCase.C
    assert info.tier == "cleanup"


# ─── Case D ───────────────────────────────────────────────────────────────────


def test_case_d_batch_state_not_ready(tmp_path: Path) -> None:
    """Case D: batch row exists but state is 'preparing' (not 'ready')."""
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-CASE-D"

    _insert_checkpoint(conn, batch_id=batch_id, workset_schema=1, phase_a_done=True)
    _insert_batch(conn, batch_id=batch_id, state_str="preparing", chunk_count=0)
    _insert_chunks(conn, n=2)

    info = classify_recovery(conn, "default")

    assert info.case == FailureCase.D
    assert info.tier == "cleanup"


def test_case_d_chunk_count_mismatch(tmp_path: Path) -> None:
    """Case D: batch row is 'ready' but chunk_count doesn't match actual chunks."""
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-CASE-D2"

    _insert_checkpoint(conn, batch_id=batch_id, workset_schema=1, phase_a_done=True)
    # Record chunk_count=10 in the batch, but only 2 actual chunks.
    _insert_batch(conn, batch_id=batch_id, state_str="ready", chunk_count=10)
    _insert_chunks(conn, n=2)

    info = classify_recovery(conn, "default")

    assert info.case == FailureCase.D
    assert info.tier == "cleanup"


# ─── Tier priority: resume preferred over cleanup ────────────────────────────


def test_resume_preferred_over_cleanup_when_workset_present(tmp_path: Path) -> None:
    """Workset present and ready → resume, not cleanup."""
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-RESUME"

    _insert_checkpoint(conn, batch_id=batch_id, workset_schema=1, phase_a_done=True)
    _insert_batch(conn, batch_id=batch_id, state_str="ready", chunk_count=2)
    _insert_chunks(conn, n=2)

    info = classify_recovery(conn, "default")

    assert info.tier == "resume"
    assert info.workset_present is True


# ─── Later-phase death: workset present, continue from unfinished step ───────


def test_later_phase_death_workset_ready_is_resumable(tmp_path: Path) -> None:
    """Workset present (state='ready'), no later phase steps done → resume."""
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-LATEPHASE"

    # Phase A done, but no Phase B steps.
    _insert_checkpoint(conn, batch_id=batch_id, workset_schema=1, phase_a_done=True)
    _insert_batch(conn, batch_id=batch_id, state_str="ready", chunk_count=2)
    _insert_chunks(conn, n=2)

    info = classify_recovery(conn, "default")

    assert info.tier == "resume"
    assert info.workset_present is True
    assert info.case == FailureCase.NONE  # no anomaly, just continue


# ─── OK path ─────────────────────────────────────────────────────────────────


def test_ok_when_no_checkpoint_exists(tmp_path: Path) -> None:
    """No checkpoint row → tier is 'ok'."""
    conn = _fresh_conn(tmp_path)

    info = classify_recovery(conn, "default")

    assert info.tier == "ok"
    assert info.case == FailureCase.NONE


def test_ok_after_normal_completion(tmp_path: Path) -> None:
    """Completed round (ingest.complete=done, batch state=complete) → tier 'ok'."""
    conn = _fresh_conn(tmp_path)
    batch_id = "FAKEBATCH-COMPLETE"

    _insert_checkpoint(
        conn,
        batch_id=batch_id,
        workset_schema=1,
        phase_a_done=True,
        ingest_complete=True,
    )
    _insert_batch(conn, batch_id=batch_id, state_str="complete", chunk_count=2)
    _insert_chunks(conn, n=2)

    info = classify_recovery(conn, "default")

    assert info.tier == "ok"
    assert info.case == FailureCase.NONE


# ─── Execution tests: self-healing via _maybe_heal_missing_workset ────────────


def _make_pipeline_with_checkpoint(
    tmp_path: Path,
    *,
    batch_id: str,
    phase_a_done: bool = True,
    source_dir_exists: bool = True,
):
    """Build a minimal IngestionPipeline + SQLiteStore + IngestCheckpoint.

    Returns (pipeline, store, checkpoint, conn).  All stores are injected so
    the pipeline never opens real Qdrant or Ladybug connections.
    """
    from kl_graph.ingest.checkpoint import IngestCheckpoint
    from kl_graph.ingest.pipeline import IngestionPipeline

    db_path = tmp_path / "knowledge.db"
    store = SQLiteStore(db_path)
    conn = store.conn

    # Build an in-memory checkpoint that matches the given batch state.
    checkpoint = IngestCheckpoint(conn, "default", [])
    checkpoint._data["batch_id"] = batch_id
    checkpoint._data["workset_schema"] = 1
    if phase_a_done:
        checkpoint._data["steps"]["phase_a.persist_chunks"] = {
            "status": "done",
            "ts": int(time.time()),
        }
    checkpoint._flush()

    messages_dir = tmp_path / "export" / "chat"
    if source_dir_exists:
        # The parent of messages_dir is the export root checked by the classifier.
        messages_dir.parent.mkdir(parents=True, exist_ok=True)

    pipeline = IngestionPipeline(
        sqlite_path=db_path,
        messages_dir=messages_dir,
        store=store,
        checkpoint=checkpoint,
        batch_id=batch_id,
        source_id="default",
    )
    return pipeline, store, checkpoint, conn


def test_case_a_execution_clears_phase_a_checkpoint(tmp_path: Path) -> None:
    """Case A execution: phase_a.* checkpoint steps are cleared before re-run.

    After _maybe_heal_missing_workset returns True, phase_a.persist_chunks must
    no longer be marked done so Phase A can re-run unconditionally.
    """
    batch_id = "FAKEBATCH-EXEC-A01"
    pipeline, _store, checkpoint, _conn = _make_pipeline_with_checkpoint(
        tmp_path, batch_id=batch_id, phase_a_done=True, source_dir_exists=True
    )
    # No ingest_batches row, no chunks → Case A: stale checkpoint over wiped DB.

    sources_called: list[bool] = []

    def _fake_load_sources() -> None:
        sources_called.append(True)
        pipeline._sources_loaded = True

    pipeline._load_sources = _fake_load_sources

    healed = pipeline._maybe_heal_missing_workset()

    assert healed is True, "Case A must be auto-healed"
    assert sources_called == [True], "_load_sources must be called once"
    # Key invariant: the Phase A checkpoint step must be gone so it re-runs.
    assert not checkpoint.is_done("phase_a.persist_chunks"), (
        "phase_a.persist_chunks must be cleared so Phase A can re-run"
    )


def test_case_a_execution_loads_sources(tmp_path: Path) -> None:
    """Case A execution: _load_sources is invoked after clearing the checkpoint.

    Confirms the pipeline will actually re-run Phase A from the source files.
    """
    batch_id = "FAKEBATCH-EXEC-A02"
    pipeline, _store, _checkpoint, _conn = _make_pipeline_with_checkpoint(
        tmp_path, batch_id=batch_id, phase_a_done=True, source_dir_exists=True
    )

    sources_loaded: list[bool] = []

    def _fake_load_sources() -> None:
        sources_loaded.append(True)
        pipeline._sources_loaded = True

    pipeline._load_sources = _fake_load_sources

    pipeline._maybe_heal_missing_workset()

    assert sources_loaded == [True]
    assert pipeline._sources_loaded is True


def test_case_b_execution_loads_sources_idempotent(tmp_path: Path) -> None:
    """Case B (source present): healing re-parses sources via _load_sources.

    When the re-parse actually yields chunks (some units were still unseen),
    the heal succeeds and marks the workset loaded.
    """
    batch_id = "FAKEBATCH-EXEC-B01"
    pipeline, _store, _checkpoint, conn = _make_pipeline_with_checkpoint(
        tmp_path,
        batch_id=batch_id,
        phase_a_done=True,
        source_dir_exists=True,
    )
    # Insert chunks → count_chunks > 0 → Case B: workset row gone, chunks ok.
    _insert_chunks(conn, n=3)

    sources_loaded: list[bool] = []

    def _fake_load_sources() -> None:
        sources_loaded.append(True)
        pipeline._sources_loaded = True
        # Re-parse produced a non-empty workset (units were unseen) → healable.
        pipeline.messages = [Chunk(id="ding:re", content="x", source_type="message")]

    pipeline._load_sources = _fake_load_sources

    healed = pipeline._maybe_heal_missing_workset()

    assert healed is True, "Case B with a non-empty re-parse must be auto-healed"
    assert sources_loaded == [True], "_load_sources must be called for Case B"


def test_case_b_empty_reparse_skips_round(tmp_path: Path) -> None:
    """Case B where the dedup ledger collapses the re-parse to an empty workset.

    The incremental units ledger already marks every unit as seen, so
    _load_sources yields zero chunks while durable chunks survive in the DB.
    Returning True here would make Phase B extract nothing — a silent data
    loss (AGENTS.md §4).  The heal must raise SkipRoundError (skip the round,
    keep the accumulated graph, advise a snapshot restore) — never --fresh-db,
    which would destroy the long-lived graph.
    """
    from kl_graph.ingest.recovery import SkipRoundError

    batch_id = "FAKEBATCH-EXEC-B03"
    pipeline, _store, _checkpoint, conn = _make_pipeline_with_checkpoint(
        tmp_path,
        batch_id=batch_id,
        phase_a_done=True,
        source_dir_exists=True,
    )
    _insert_chunks(conn, n=3)

    def _fake_load_sources() -> None:
        # Models the dedup collapse: flag set, but no chunks materialized.
        pipeline._sources_loaded = True

    pipeline._load_sources = _fake_load_sources

    try:
        pipeline._maybe_heal_missing_workset()
    except SkipRoundError as exc:
        message = str(exc)
        assert "--fresh-db" not in message
        assert "snapshot" in message.lower()
    else:
        raise AssertionError("empty re-parse must skip the round, not silently 'heal'")
    assert pipeline._sources_loaded is False


def test_case_b_no_source_skips_round(tmp_path: Path) -> None:
    """Case B (source absent): _maybe_heal_missing_workset skips the round.

    Without the source export on disk Phase A cannot re-run, so the workset
    cannot be rebuilt from the surviving ledger.  Rather than force a full
    rebuild, the healer raises SkipRoundError: skip the round, keep the
    accumulated graph, advise a snapshot restore (never --fresh-db).
    """
    from kl_graph.ingest.recovery import SkipRoundError

    batch_id = "FAKEBATCH-EXEC-B02"
    pipeline, _store, _checkpoint, conn = _make_pipeline_with_checkpoint(
        tmp_path,
        batch_id=batch_id,
        phase_a_done=True,
        source_dir_exists=False,  # export root does not exist
    )
    _insert_chunks(conn, n=2)
    # No ingest_batches row → Case B (source absent).

    try:
        pipeline._maybe_heal_missing_workset()
    except SkipRoundError as exc:
        message = str(exc)
        assert "--fresh-db" not in message
        assert "snapshot" in message.lower()
    else:
        raise AssertionError("Case B without source must skip the round")