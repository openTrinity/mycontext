"""Step-level checkpoint for resumable ingestion.

Records which pipeline steps have completed for the current source data version.
On resume, the pipeline skips steps already marked done. The checkpoint is
versioned by a source hash (stat-based fingerprint of source files), so it
auto-invalidates when the input data changes.

The checkpoint is stored in the ``ingest_checkpoint`` table inside
``knowledge.db`` rather than a sidecar JSON file. This makes "Phase A done"
and "workset exists" a single SQLite commit, eliminating the stale-JSON class
of failures where wiping the DB left an orphaned checkpoint.

See ``docs/checkpoint-design.md`` for the full design rationale, transaction
boundaries, and rules for adding new steps.
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import sqlite3
import time
import uuid
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


# ─── StepGuard ────────────────────────────────────────────────────────────────


class StepGuard:
    """Context-managed checkpoint guard for a single pipeline step.

    Returned by :meth:`IngestCheckpoint.step`. Makes the pipeline read like a
    declarative spec: each method starts with ``with self.checkpoint.step(...)``
    that declares the checkpoint key, the commit pattern, and the reload strategy.

    Usage::

        with self.step("phase_b.build_entities", on_skip=self._ensure_entities_loaded) as s:
            if s.skip:
                return
            # ... do the work ...
            s.done(count=len(self.all_entities))

    Attributes:
        skip: True if the step is already checkpointed (the body should
            early-return). The ``on_skip`` callback has already been invoked.
    """

    __slots__ = ("_checkpoint", "_committed", "_params", "_step", "skip")

    def __init__(
        self,
        checkpoint: IngestCheckpoint | None,
        step: str,
        *,
        params: dict | None = None,
        skip: bool = False,
    ):
        self._checkpoint = checkpoint
        self._step = step
        self._params = params
        self._committed = False
        self.skip = skip

    def done(self, **meta: Any) -> None:
        """Mark the step complete (the checkpoint "commit" point).

        Call this after the step's work is finished — for Pattern A after the
        store write, for Pattern B after all batches flush, for Pattern C after
        all cache files are written.

        Args:
            **meta: Metadata recorded in the checkpoint (e.g., ``count=5000``).
        """
        if self._checkpoint is not None and not self._committed:
            self._checkpoint.mark_done(self._step, params=self._params, **meta)
            self._committed = True


class IngestCheckpoint:
    """Step-level checkpoint for resumable ingestion.

    The checkpoint records which pipeline steps have completed. It is persisted
    as a row in the ``ingest_checkpoint`` table of ``knowledge.db``.  This
    collapses the checkpoint and the workset into the same SQLite file, so they
    can never disagree: dropping/clearing ``knowledge.db`` wipes both at once.

    The checkpoint is keyed by a ``source_id`` (the caller-supplied stable
    namespace, e.g. "default") AND a ``source_hash`` — a stat-based fingerprint
    of the source files. If the source data changes (files added/removed/modified),
    the checkpoint auto-invalidates and the pipeline starts fresh.
    """

    VERSION = 1

    def __init__(
        self,
        conn: sqlite3.Connection,
        source_id: str,
        source_dirs: list[Path],
    ):
        """Load or create checkpoint. Invalidates if source_hash changed.

        Args:
            conn: Open SQLite connection to knowledge.db.
            source_id: Stable source namespace (e.g. "default").
            source_dirs: Directories containing source files to fingerprint.
        """
        self._conn = conn
        self._source_id = source_id
        self._source_dirs = source_dirs
        self._source_hash = self._compute_source_hash(source_dirs)
        # In-memory copy of the checkpoint row; kept in sync with DB on every write.
        self._data: dict[str, Any] = {
            "version": self.VERSION,
            "source_hash": "",
            "batch_id": "",
            "workset_schema": 0,
            "steps": {},
            "created_at": 0,
        }
        self._load_or_reset()

    @property
    def source_id(self) -> str:
        """The source namespace this checkpoint belongs to."""
        return self._source_id

    @property
    def source_hash(self) -> str:
        """The computed source fingerprint for this run."""
        return self._source_hash

    @property
    def batch_id(self) -> str:
        """Stable durable-workset id for this checkpoint epoch."""
        return str(self._data["batch_id"])

    @property
    def workset_schema(self) -> int:
        """Durable-workset schema recorded by this checkpoint."""
        return int(self._data.get("workset_schema", 0))

    # ─── Primary API: step() context manager ──────────────────────────────

    @contextmanager
    def step(
        self,
        name: str,
        *,
        on_skip: Callable[[], Any] | None = None,
        params: dict | None = None,
    ) -> Generator[StepGuard, None, None]:
        """Context-managed guard for a pipeline step.

        The preferred way to integrate checkpointing into pipeline methods.
        Makes the step's checkpoint key, reload strategy, and commit point
        visible at the top of each method.

        Args:
            name: Step identifier (e.g., ``"phase_b.build_entities"``).
            on_skip: Callback invoked when the step is already done. Use for
                reload helpers (e.g., ``self._ensure_entities_loaded``) that
                populate in-memory state for downstream steps.
            params: Optional parameters to match. If the recorded params don't
                match, the step re-runs (used for improve steps with tunable
                thresholds).

        Yields:
            A :class:`StepGuard` instance. Check ``guard.skip`` — if True,
            early-return from the method body. Call ``guard.done(**meta)`` at
            the end of the work to commit the checkpoint. If ``.done()`` is
            not called explicitly and the block exits cleanly (no exception),
            the step is auto-committed (convenient for simple steps).

        Example::

            with self.checkpoint.step("phase_b.build_facts",
                                      on_skip=self._ensure_facts_loaded) as s:
                if s.skip:
                    return
                # ... build facts ...
                s.done(count=len(self.all_facts))
        """
        if self.is_done(name, params=params):
            print(f"  [checkpoint] {name} — skipping (already done)")
            if on_skip is not None:
                on_skip()
            yield StepGuard(self, name, params=params, skip=True)
        else:
            guard = StepGuard(self, name, params=params, skip=False)
            yield guard
            # Auto-commit on clean exit if .done() wasn't called explicitly.
            # If an exception propagates, __exit__ is not reached here (the
            # yield re-raises), so the step stays NOT checkpointed — correct.
            if not guard._committed:
                guard.done()

    # ─── Low-level API (used by run_if_needed and direct callers) ─────────

    def is_done(self, step: str, *, params: dict | None = None) -> bool:
        """True if step completed in this checkpoint epoch.

        If ``params`` is given, also checks that the recorded parameters match.
        A mismatch means the step should re-run with the new params.

        Args:
            step: Step identifier (e.g., "phase_b.build_entities").
            params: Optional parameters to match against recorded ones.

        Returns:
            True if the step is done (and params match, if provided).
        """
        entry = self._data["steps"].get(step)
        if not entry or entry.get("status") != "done":
            return False
        if params is not None:
            recorded_params = entry.get("params")
            if recorded_params != params:
                return False
        return True

    def step_metadata(self, step: str) -> dict[str, Any]:
        """Return a copy of one recorded step entry, or an empty mapping."""
        entry = self._data["steps"].get(step)
        return dict(entry) if isinstance(entry, dict) else {}

    def mark_done(self, step: str, *, params: dict | None = None, **meta) -> None:
        """Mark step complete. Flushes to DB.

        Args:
            step: Step identifier.
            params: Optional parameters to record (for improve steps).
            **meta: Additional metadata (e.g., count=5000).
        """
        entry: dict[str, Any] = {"status": "done", "ts": int(time.time())}
        if params is not None:
            entry["params"] = params
        entry.update(meta)
        self._data["steps"][step] = entry
        self._flush()

    def mark_done_in_transaction(
        self,
        step: str,
        conn: sqlite3.Connection,
        *,
        params: dict | None = None,
        **meta: Any,
    ) -> None:
        """Mark step complete using an already-open transaction.

        Unlike :meth:`mark_done`, this writes directly via ``conn`` without
        calling ``conn.commit()`` — it is the caller's responsibility to commit.
        Use this to atomically co-commit the checkpoint step with other DB
        writes (e.g. the workset INSERT in ``insert_chunks_with_units``).

        This method does **not** update the in-memory ``_data["steps"]`` dict —
        the caller must call :meth:`mark_done` after the enclosing transaction
        commits to keep the in-memory state consistent with the DB.

        Args:
            step: Step identifier.
            conn: The sqlite3 connection that owns the current transaction.
            params: Optional parameters to record.
            **meta: Additional metadata.
        """
        entry: dict[str, Any] = {"status": "done", "ts": int(time.time())}
        if params is not None:
            entry["params"] = params
        entry.update(meta)
        # Compute the merged steps dict for the DB write, but do NOT update
        # self._data yet — the transaction may still roll back.
        merged_steps = dict(self._data["steps"])
        merged_steps[step] = entry
        # Write to DB inside the caller's transaction (no commit here).
        conn.execute(
            """INSERT INTO ingest_checkpoint
               (source_id, version, source_hash, batch_id, workset_schema, steps, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_id) DO UPDATE SET
                 version=excluded.version,
                 source_hash=excluded.source_hash,
                 batch_id=excluded.batch_id,
                 workset_schema=excluded.workset_schema,
                 steps=excluded.steps,
                 created_at=excluded.created_at""",
            (
                self._source_id,
                self._data["version"],
                self._data["source_hash"],
                self._data["batch_id"],
                self._data["workset_schema"],
                json.dumps(merged_steps, ensure_ascii=False),
                self._data["created_at"],
            ),
        )

    def clear_prefix(self, prefix: str) -> None:
        """Clear all steps starting with prefix (e.g., 'improve.').

        Useful for re-running improve steps with different parameters without
        invalidating the entire checkpoint.

        Args:
            prefix: Step name prefix to clear.
        """
        to_remove = [k for k in self._data["steps"] if k.startswith(prefix)]
        for k in to_remove:
            del self._data["steps"][k]
        if to_remove:
            self._flush()
            logger.info("Cleared %d checkpoint entries with prefix %r", len(to_remove), prefix)

    def reset(self) -> None:
        """Clear all steps and mint a new batch_id.

        Used on ``--fresh-db`` or source change, and also to skip a round whose
        workset cannot be rebuilt (see :class:`kl_graph.ingest.recovery.
        SkipRoundError`): minting a fresh ``batch_id`` and dropping the round's
        resume steps lets the next round accumulate cleanly, and touches no
        graph data.
        """
        self._data = {
            "version": self.VERSION,
            "source_hash": self._source_hash,
            "created_at": int(time.time()),
            "batch_id": str(uuid.uuid4()),
            "workset_schema": 1,
            "steps": {},
        }
        self._flush()

    def delete(self) -> None:
        """Delete the checkpoint row from the DB."""
        with self._conn:
            self._conn.execute(
                "DELETE FROM ingest_checkpoint WHERE source_id=?",
                (self._source_id,),
            )
        # Reset in-memory state so subsequent operations start fresh.
        self._data = {
            "version": self.VERSION,
            "source_hash": self._source_hash,
            "batch_id": "",
            "workset_schema": 0,
            "steps": {},
            "created_at": 0,
        }

    # ─── Internal ──────────────────────────────────────────────────────────

    def _load_or_reset(self) -> None:
        """Load existing checkpoint row if source_hash matches, else reset."""
        row = self._conn.execute(
            "SELECT * FROM ingest_checkpoint WHERE source_id=?",
            (self._source_id,),
        ).fetchone()

        if row is None:
            self.reset()
            return

        try:
            data: dict[str, Any] = {
                "version": row["version"],
                "source_hash": row["source_hash"] or "",
                "batch_id": row["batch_id"] or "",
                "workset_schema": row["workset_schema"],
                "steps": json.loads(row["steps"] or "{}"),
                "created_at": row["created_at"],
            }
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            logger.warning("Corrupt checkpoint row, resetting: %s", exc)
            self.reset()
            return

        # Version check
        if data["version"] != self.VERSION:
            logger.info("Checkpoint version mismatch, resetting")
            self.reset()
            return

        # Once Phase A commits, its durable workset is the retry authority even
        # if the local source directory changes while the run is interrupted.
        if data["source_hash"] != self._source_hash:
            persist = data["steps"].get("phase_a.persist_chunks", {})
            complete = data["steps"].get("ingest.complete", {})
            if persist.get("status") == "done" and complete.get("status") != "done":
                logger.warning(
                    "Source changed during interrupted ingest; resuming batch %s",
                    data.get("batch_id", "<legacy>"),
                )
                self._source_hash = str(data["source_hash"])
            else:
                logger.info(
                    "Source data changed (hash mismatch: %s → %s), resetting checkpoint",
                    data["source_hash"][:16],
                    self._source_hash[:16],
                )
                self.reset()
                return

        # A committed legacy checkpoint has no reconstructable workset. Keep an
        # explicit schema marker so resumption fails loudly instead of silently
        # processing zero chunks.
        if not data.get("batch_id"):
            data["batch_id"] = str(uuid.uuid4())
            data["workset_schema"] = 0
            self._data = data
            self._flush()
            return

        self._data = data

    def _flush(self) -> None:
        """Write in-memory checkpoint state to the DB (committing the transaction)."""
        with self._conn:
            self._conn.execute(
                """INSERT INTO ingest_checkpoint
                   (source_id, version, source_hash, batch_id, workset_schema, steps, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(source_id) DO UPDATE SET
                     version=excluded.version,
                     source_hash=excluded.source_hash,
                     batch_id=excluded.batch_id,
                     workset_schema=excluded.workset_schema,
                     steps=excluded.steps,
                     created_at=excluded.created_at""",
                (
                    self._source_id,
                    self._data["version"],
                    self._data["source_hash"],
                    self._data["batch_id"],
                    self._data["workset_schema"],
                    json.dumps(self._data["steps"], ensure_ascii=False),
                    self._data["created_at"],
                ),
            )

    @staticmethod
    def _compute_source_hash(dirs: list[Path]) -> str:
        """Fast fingerprint from file listing (path + size + mtime).

        Walks each directory, collects (relative_path, size, mtime_ns) for all
        regular files, sorts them, and computes SHA-256 of the manifest. This is
        O(n) stat calls (no file reads) and completes in <100ms for ~20K files.

        Args:
            dirs: Source directories to fingerprint.

        Returns:
            "sha256:<hex>" string.
        """
        entries: list[str] = []
        for d in dirs:
            if not d.exists():
                continue
            for f in sorted(d.rglob("*")):
                if not f.is_file():
                    continue
                try:
                    st = f.stat()
                    # Use relative path for portability
                    rel = str(f.relative_to(d))
                    entries.append(f"{rel}:{st.st_size}:{int(st.st_mtime_ns)}")
                except OSError:
                    continue
        manifest = "\n".join(entries)
        h = hashlib.sha256(manifest.encode("utf-8")).hexdigest()
        return f"sha256:{h}"

    @classmethod
    def migrate_from_json(
        cls,
        conn: sqlite3.Connection,
        json_path: Path,
        source_id: str,
    ) -> bool:
        """Import a legacy JSON checkpoint into the ingest_checkpoint table.

        Called at store-open time by
        :meth:`~kl_graph.storage.sqlite_store.SQLiteStore._migrate_checkpoint_json`.
        Idempotent: skips import if a row already exists for source_id.
        Deletes the JSON file after a successful import.

        Args:
            conn: Open SQLite connection (may be inside a transaction).
            json_path: Path to the legacy JSON checkpoint file.
            source_id: The source namespace this checkpoint belongs to.

        Returns:
            True if the JSON was imported (and deleted), False if skipped.
        """
        # Skip if the DB already has a row for this source.
        existing = conn.execute(
            "SELECT 1 FROM ingest_checkpoint WHERE source_id=?", (source_id,)
        ).fetchone()
        if existing is not None:
            return False

        if not json_path.exists():
            return False

        try:
            import json as _json

            with open(json_path, "r", encoding="utf-8") as fh:
                data = _json.load(fh)
        except (OSError, ValueError) as exc:
            logger.warning("Failed to read legacy checkpoint %s: %s", json_path, exc)
            return False

        version = int(data.get("version", 1))
        source_hash = str(data.get("source_hash", ""))
        batch_id = str(data.get("batch_id", ""))
        workset_schema = int(data.get("workset_schema", 0))
        steps_raw = data.get("steps", {})
        steps = steps_raw if isinstance(steps_raw, dict) else {}
        created_at = int(time.time())

        try:
            conn.execute(
                """INSERT OR IGNORE INTO ingest_checkpoint
                   (source_id, version, source_hash, batch_id, workset_schema, steps, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    source_id,
                    version,
                    source_hash,
                    batch_id,
                    workset_schema,
                    _json.dumps(steps, ensure_ascii=False),
                    created_at,
                ),
            )
            conn.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to import legacy checkpoint %s: %s", json_path, exc)
            return False

        # Delete the JSON after successful import.
        try:
            json_path.unlink()
            logger.info("Migrated legacy checkpoint %s → ingest_checkpoint table", json_path)
        except OSError as exc:
            logger.warning("Migrated checkpoint but could not delete %s: %s", json_path, exc)

        return True


# ─── Reusable Helpers ─────────────────────────────────────────────────────


@contextmanager
def checkpointed(
    checkpoint: IngestCheckpoint | None,
    step: str,
    *,
    skip_msg: str = "",
    params: dict | None = None,
) -> Generator[bool, None, None]:
    """Context manager that skips the block if the step is already done.

    .. deprecated:: Use :meth:`IngestCheckpoint.step` instead for new code.
       This helper is retained for backward compatibility.

    Usage in pipeline methods::

        with checkpointed(self.checkpoint, "phase_b.build_facts") as should_run:
            if not should_run:
                return
            # ... do the work ...
        # mark_done is called automatically on clean exit from the block

    Args:
        checkpoint: The checkpoint instance (None disables checkpointing).
        step: Step identifier.
        skip_msg: Human-readable skip message (defaults to step name).
        params: Optional parameters to match (for improve steps).

    Yields:
        True if the step should run, False if already checkpointed.
    """
    if checkpoint is not None and checkpoint.is_done(step, params=params):
        print(f"  [checkpoint] {skip_msg or step} — skipping (already done)")
        yield False
    else:
        yield True
        if checkpoint is not None:
            checkpoint.mark_done(step, params=params)


def checkpoint_step(step: str, *, skip_msg: str = ""):
    """Decorator for pipeline methods that don't need reload logic on skip.

    .. deprecated:: Use :meth:`IngestCheckpoint.step` instead for new code.
       This decorator is retained for backward compatibility.

    The simplest pattern — wrap any method that writes to store and needs no
    in-memory state for downstream steps (e.g., embed_graph, create_edges).

    The decorated method's ``self`` must have a ``checkpoint`` attribute
    (either an ``IngestCheckpoint`` or ``None`` to disable).

    Usage::

        @checkpoint_step("phase_a.embed_chunks", skip_msg="chunk embedding")
        def _embed_chunks(self):
            ...  # only runs if not checkpointed

    Args:
        step: Step identifier.
        skip_msg: Human-readable skip message.
    """

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(self, *args, **kwargs):
            cp = getattr(self, "checkpoint", None)
            if cp is not None and cp.is_done(step):
                print(f"  [checkpoint] {skip_msg or step} — skipping")
                return None
            result = fn(self, *args, **kwargs)
            if cp is not None:
                cp.mark_done(step)
            return result

        return wrapper

    return decorator


def run_if_needed(
    checkpoint: IngestCheckpoint | None,
    step: str,
    fn: Callable[..., T],
    *args: Any,
    params: dict | None = None,
    **kwargs: Any,
) -> T | None:
    """Run fn(*args, **kwargs) only if the step isn't checkpointed with matching params.

    Designed for the periodic runner where steps are standalone functions
    rather than pipeline methods.

    Args:
        checkpoint: The checkpoint instance (None disables).
        step: Step identifier.
        fn: The function to run.
        *args: Positional args for fn.
        params: Parameters to match against recorded checkpoint entry.
        **kwargs: Keyword args for fn.

    Returns:
        The return value of fn(), or None if skipped.
    """
    if checkpoint is not None and checkpoint.is_done(step, params=params):
        print(f"  [checkpoint] {step} — skipping (already done)")
        return None
    result = fn(*args, **kwargs)
    if checkpoint is not None:
        checkpoint.mark_done(step, params=params)
    return result
