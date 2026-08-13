"""Ingestion failure classifier and recovery tier logic.

Reads durable state (ingest_checkpoint, ingest_batches, chunk counts, source
export presence) and classifies the current ingestion state into one of four
cases.  The caller (server endpoint or the pipeline's resume path) uses the
returned :class:`RecoveryInfo` to decide whether to resume, clean up, or report
"ok".

Case definitions (from design §5.1):

  A  checkpoint says Phase A done, ingest_batches has no 'ready' row,
     count_chunks == 0 → stale checkpoint over a wiped DB, nothing lost.
  B  count_chunks > 0 but get_ingest_batch(batch_id) is None → chunks
     survived, workset row gone or drifted.
  C  workset_schema == 0 (legacy checkpoint) → no reconstructable workset.
  D  batch row exists but state != 'ready' or chunk-count mismatch →
     genuinely corrupt workset.

Recovery tiers returned by the endpoint:
  "resume"  → Cases A or B (and source still on disk for B)
  "cleanup" → Cases C, D, or B with source gone
  "ok"      → No anomaly detected
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

# ─── Public types ─────────────────────────────────────────────────────────────


class FailureCase(str, Enum):
    """One of the four classifier outcomes, or None when everything is normal."""

    A = "A"
    B = "B"
    C = "C"
    D = "D"
    NONE = "none"


RecoveryTier = Literal["resume", "cleanup", "ok"]


@dataclass
class RecoveryInfo:
    """Result of :func:`classify_recovery`.

    Attributes:
        tier: "ok" / "resume" / "cleanup"
        case: Which failure case was detected (FailureCase.NONE when tier=="ok")
        ingestion_id: The batch_id for the current/last round (may be empty)
        round_started_at: Epoch seconds of round start (0 if unknown)
        workset_present: True when the ingest_batches row with state='ready' exists
        source_present: True when the source export directory is on disk
        count_chunks: Current count of rows in the chunks table
        detail: Human-readable diagnostic detail (no sensitive paths/ids)
    """

    tier: RecoveryTier
    case: FailureCase
    ingestion_id: str
    round_started_at: int
    workset_present: bool
    source_present: bool
    count_chunks: int
    detail: str = field(default="")


# ─── Classifier ───────────────────────────────────────────────────────────────


def classify_recovery(
    conn: sqlite3.Connection,
    source_id: str,
    source_dir: Path | None = None,
) -> RecoveryInfo:
    """Classify current ingestion state from durable DB state.

    Args:
        conn: Open SQLite connection to knowledge.db (read-only; no writes).
        source_id: The source namespace to check (e.g. "default").
        source_dir: Optional path to the source export directory.  When
            provided, Case-B tier depends on whether this path exists on disk.
            When None, source_present defaults to False.

    Returns:
        A :class:`RecoveryInfo` describing the detected case and tier.
    """
    # ── 1. Read checkpoint row ─────────────────────────────────────────────
    cp_row = conn.execute(
        "SELECT batch_id, workset_schema, steps FROM ingest_checkpoint WHERE source_id=?",
        (source_id,),
    ).fetchone()

    if cp_row is None:
        # No checkpoint at all — nothing to recover.
        return RecoveryInfo(
            tier="ok",
            case=FailureCase.NONE,
            ingestion_id="",
            round_started_at=0,
            workset_present=False,
            source_present=_source_exists(source_dir),
            count_chunks=_count_chunks(conn),
            detail="no checkpoint row found",
        )

    batch_id: str = str(cp_row["batch_id"] or "")
    workset_schema: int = int(cp_row["workset_schema"] or 0)

    steps_raw = cp_row["steps"] or "{}"
    try:
        steps: dict = json.loads(steps_raw)
    except (ValueError, TypeError):
        steps = {}

    phase_a_done = steps.get("phase_a.persist_chunks", {}).get("status") == "done"
    ingest_complete = steps.get("ingest.complete", {}).get("status") == "done"

    # ── 2. Read ingest_batches row ─────────────────────────────────────────
    batch_row = None
    round_started_at = 0
    if batch_id:
        batch_row = conn.execute(
            "SELECT state, chunk_count, round_started_at FROM ingest_batches WHERE batch_id=?",
            (batch_id,),
        ).fetchone()
        if batch_row is not None:
            round_started_at = int(batch_row["round_started_at"] or 0)

    # ── 3. Chunk count ─────────────────────────────────────────────────────
    count_chunks = _count_chunks(conn)

    # ── 4. Source on disk ─────────────────────────────────────────────────
    source_present = _source_exists(source_dir)

    # ── 5. Classify ───────────────────────────────────────────────────────

    # Case C: legacy checkpoint — no reconstructable workset.
    if workset_schema == 0:
        return RecoveryInfo(
            tier="cleanup",
            case=FailureCase.C,
            ingestion_id=batch_id,
            round_started_at=round_started_at,
            workset_present=False,
            source_present=source_present,
            count_chunks=count_chunks,
            detail="legacy checkpoint (workset_schema==0); workset not reconstructable",
        )

    # Case A: Phase A is marked done, no ingest_batches row (batch gone/empty),
    # and count_chunks == 0 → stale checkpoint over a wiped DB.
    if (
        phase_a_done
        and not ingest_complete
        and batch_row is None
        and count_chunks == 0
    ):
        return RecoveryInfo(
            tier="resume",
            case=FailureCase.A,
            ingestion_id=batch_id,
            round_started_at=round_started_at,
            workset_present=False,
            source_present=source_present,
            count_chunks=0,
            detail="stale checkpoint over wiped DB; Phase A can be safely re-run",
        )

    # Case B: chunks exist but get_ingest_batch returned None → workset row gone.
    if count_chunks > 0 and batch_row is None:
        tier: RecoveryTier = "resume" if source_present else "cleanup"
        return RecoveryInfo(
            tier=tier,
            case=FailureCase.B,
            ingestion_id=batch_id,
            round_started_at=round_started_at,
            workset_present=False,
            source_present=source_present,
            count_chunks=count_chunks,
            detail=(
                "chunks present but workset row missing; "
                + ("source on disk, Phase A re-run is safe" if source_present
                   else "source not on disk, cannot reconstruct workset")
            ),
        )

    # Case D: batch row exists but state != 'ready' or chunk-count mismatch.
    if batch_row is not None:
        batch_state = str(batch_row["state"] or "")
        recorded_chunk_count = int(batch_row["chunk_count"] or 0)

        # A 'complete' batch is normal — the round finished successfully.
        if batch_state == "complete" and ingest_complete:
            return RecoveryInfo(
                tier="ok",
                case=FailureCase.NONE,
                ingestion_id=batch_id,
                round_started_at=round_started_at,
                workset_present=False,  # workset deleted after completion
                source_present=source_present,
                count_chunks=count_chunks,
                detail="last round completed normally",
            )

        workset_ready = batch_state == "ready"
        chunk_count_ok = recorded_chunk_count == count_chunks or recorded_chunk_count == 0

        if not workset_ready or not chunk_count_ok:
            return RecoveryInfo(
                tier="cleanup",
                case=FailureCase.D,
                ingestion_id=batch_id,
                round_started_at=round_started_at,
                workset_present=workset_ready,
                source_present=source_present,
                count_chunks=count_chunks,
                detail=(
                    f"batch state={batch_state!r}, "
                    f"recorded_chunks={recorded_chunk_count}, "
                    f"actual_chunks={count_chunks}; workset corrupt"
                ),
            )

        # Workset is present and ready — a later phase may have died.
        return RecoveryInfo(
            tier="resume",
            case=FailureCase.NONE,
            ingestion_id=batch_id,
            round_started_at=round_started_at,
            workset_present=True,
            source_present=source_present,
            count_chunks=count_chunks,
            detail="workset present and ready; resume from first unfinished step",
        )

    # No batch row and no chunks — check whether the round completed normally.
    if ingest_complete:
        return RecoveryInfo(
            tier="ok",
            case=FailureCase.NONE,
            ingestion_id=batch_id,
            round_started_at=round_started_at,
            workset_present=False,
            source_present=source_present,
            count_chunks=count_chunks,
            detail="last round completed normally (batch cleaned up, ingest.complete set)",
        )

    if not phase_a_done:
        return RecoveryInfo(
            tier="ok",
            case=FailureCase.NONE,
            ingestion_id=batch_id,
            round_started_at=round_started_at,
            workset_present=False,
            source_present=source_present,
            count_chunks=count_chunks,
            detail="checkpoint present but Phase A not yet started",
        )

    # Phase A done, batch gone, but chunks also gone — same as Case A.
    return RecoveryInfo(
        tier="resume",
        case=FailureCase.A,
        ingestion_id=batch_id,
        round_started_at=round_started_at,
        workset_present=False,
        source_present=source_present,
        count_chunks=0,
        detail="stale checkpoint; batch and chunks gone; Phase A re-run is safe",
    )


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _count_chunks(conn: sqlite3.Connection) -> int:
    """Return the current count of rows in the chunks table."""
    try:
        row = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()
        return int(row[0]) if row else 0
    except Exception:  # noqa: BLE001 - table may not exist yet
        return 0


def _source_exists(source_dir: Path | None) -> bool:
    """True when source_dir is a valid existing directory."""
    if source_dir is None:
        return False
    try:
        return source_dir.is_dir()
    except Exception:  # noqa: BLE001 - OS errors → treat as absent
        return False
