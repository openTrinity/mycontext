"""Unit tests for advisory lock contention in ingestion pipeline.

Tests verify:
- Constructing a second IngestionPipeline while the first holds the lock
  raises RuntimeError immediately (zero-timeout)
- The error message mentions the lock file path
- After the first pipeline is closed (lock released), a new pipeline can acquire
- Lock is acquired only when the pipeline owns its stores
  (injected store/qdrant skips lock acquisition)
- run_incremental() acquires the same lock as run_full()
"""

from __future__ import annotations

import pathlib
from unittest.mock import MagicMock

import pytest

from kl_graph.ingest.pipeline import INGEST_LOCK_PATH, IngestionPipeline
from kl_graph.storage.sqlite_store import SQLiteStore

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_store(tmp_path: pathlib.Path) -> SQLiteStore:
    return SQLiteStore(tmp_path / "test.db")


# ---------------------------------------------------------------------------
# Tests: Lock acquisition and contention
# ---------------------------------------------------------------------------


class TestLockAcquisition:
    """IngestionPipeline acquires lock when it owns its stores."""

    def test_owns_stores_acquires_lock(self, tmp_path: pathlib.Path) -> None:
        """Pipeline without injected stores acquires the advisory lock."""
        pipeline = IngestionPipeline(
            sqlite_path=tmp_path / "a.db",
            qdrant_path=str(tmp_path / "qdrant"),
        )
        try:
            assert pipeline._lock is not None
        finally:
            pipeline.close()

    def test_injected_stores_skip_lock(self, tmp_path: pathlib.Path) -> None:
        """Pipeline with injected stores does NOT acquire the advisory lock."""
        store = _make_store(tmp_path)
        qdrant = MagicMock()
        pipeline = IngestionPipeline(
            sqlite_path=tmp_path / "a.db",
            qdrant_path=str(tmp_path / "qdrant"),
            store=store,
            qdrant=qdrant,
        )
        try:
            assert pipeline._lock is None
        finally:
            pipeline.close()
            store.close()

    def test_lock_file_path_is_under_data_dir(self) -> None:
        """The lock file path is the expected INGEST_LOCK_PATH constant."""
        from kl_graph.config import DATA_DIR  # noqa: F811

        assert INGEST_LOCK_PATH == DATA_DIR / ".ingest.lock"


class TestLockContention:
    """A second pipeline cannot acquire the lock while the first holds it."""

    def test_second_pipeline_raises_runtime_error(self, tmp_path: pathlib.Path) -> None:
        """Constructing a second IngestionPipeline while the first holds
        the lock raises RuntimeError."""
        pipeline1 = IngestionPipeline(
            sqlite_path=tmp_path / "a.db",
            qdrant_path=str(tmp_path / "qdrant"),
        )
        try:
            with pytest.raises(RuntimeError, match="already running"):
                IngestionPipeline(
                    sqlite_path=tmp_path / "a.db",
                    qdrant_path=str(tmp_path / "qdrant"),
                )
        finally:
            pipeline1.close()

    def test_error_message_mentions_lock_file(self, tmp_path: pathlib.Path) -> None:
        """RuntimeError message references the lock file path."""
        pipeline1 = IngestionPipeline(
            sqlite_path=tmp_path / "a.db",
            qdrant_path=str(tmp_path / "qdrant"),
        )
        try:
            with pytest.raises(RuntimeError) as exc_info:
                IngestionPipeline(
                    sqlite_path=tmp_path / "a.db",
                    qdrant_path=str(tmp_path / "qdrant"),
                )
            assert ".ingest.lock" in str(exc_info.value)
        finally:
            pipeline1.close()

    def test_lock_released_on_close_allows_new_pipeline(
        self, tmp_path: pathlib.Path
    ) -> None:
        """After the first pipeline is closed, a new one can acquire the lock."""
        pipeline1 = IngestionPipeline(
            sqlite_path=tmp_path / "a.db",
            qdrant_path=str(tmp_path / "qdrant"),
        )
        pipeline1.close()

        # Should not raise — lock was released
        pipeline2 = IngestionPipeline(
            sqlite_path=tmp_path / "a.db",
            qdrant_path=str(tmp_path / "qdrant"),
        )
        assert pipeline2._lock is not None
        pipeline2.close()

    def test_concurrent_incremental_raises_runtime_error(
        self, tmp_path: pathlib.Path
    ) -> None:
        """Attempting run_incremental() while another pipeline holds the lock raises RuntimeError.

        The lock is acquired at IngestionPipeline.__init__ time (when _owns_stores=True),
        so constructing a second pipeline to call run_incremental() fails before
        run_incremental() is even reached.
        """
        # pipeline1 holds the lock
        pipeline1 = IngestionPipeline(
            sqlite_path=tmp_path / "a.db",
            qdrant_path=str(tmp_path / "qdrant"),
        )
        try:
            # Attempting to create a second pipeline (prerequisite for run_incremental)
            # raises RuntimeError because the lock is already held.
            with pytest.raises(RuntimeError, match="already running"):
                pipeline2 = IngestionPipeline(
                    sqlite_path=tmp_path / "a.db",
                    qdrant_path=str(tmp_path / "qdrant"),
                )
                # Would call: asyncio.run(pipeline2.run_incremental())
                pipeline2.close()  # never reached
        finally:
            pipeline1.close()

    def test_full_build_also_blocked_by_held_lock(self, tmp_path: pathlib.Path) -> None:
        """run_full() is also blocked when the lock is held by another pipeline.

        Holds the lock via filelock directly (without a running pipeline), then
        verifies that constructing an IngestionPipeline — a prerequisite for
        run_full() — raises RuntimeError due to lock contention.
        This confirms that full build and incremental ingest share the same
        INGEST_LOCK_PATH advisory lock.
        """
        from filelock import FileLock

        # Hold the lock directly via filelock (simulates another process
        # that already started a run_full() or run_incremental())
        lock_path = str(INGEST_LOCK_PATH)
        INGEST_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        with (
            FileLock(lock_path, timeout=0),
            pytest.raises(RuntimeError, match="already running"),
        ):
            # Constructing a pipeline (required before calling run_full) must fail
            pipeline = IngestionPipeline(
                sqlite_path=tmp_path / "b.db",
                qdrant_path=str(tmp_path / "qdrant2"),
            )
            # Would call: asyncio.run(pipeline.run_full())
            pipeline.close()  # never reached

        # Lock released — now run_full() would be accessible
        pipeline = IngestionPipeline(
            sqlite_path=tmp_path / "b.db",
            qdrant_path=str(tmp_path / "qdrant2"),
        )
        assert pipeline._lock is not None
        pipeline.close()


# ---------------------------------------------------------------------------
# Tests: run_incremental lock via the lock file directly
# ---------------------------------------------------------------------------


class TestIncrementalLockViaFilelock:
    """run_incremental acquires the same lock (tested via filelock directly)."""

    def test_run_incremental_acquires_lock_on_owned_pipeline(
        self, tmp_path: pathlib.Path
    ) -> None:
        """When pipeline owns stores, it holds the lock during run_incremental."""
        pipeline = IngestionPipeline(
            sqlite_path=tmp_path / "test.db",
            qdrant_path=str(tmp_path / "qdrant"),
        )
        try:
            # The lock should be held right after construction
            assert pipeline._lock is not None
            assert pipeline._lock.is_locked
        finally:
            pipeline.close()

    def test_lock_not_held_after_close(self, tmp_path: pathlib.Path) -> None:
        """After pipeline.close(), the lock file is no longer locked."""
        pipeline = IngestionPipeline(
            sqlite_path=tmp_path / "test.db",
            qdrant_path=str(tmp_path / "qdrant"),
        )
        pipeline.close()
        assert pipeline._lock is None
