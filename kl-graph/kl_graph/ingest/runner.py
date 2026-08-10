"""Shared orchestration for local-directory ingestion.

Both the HTTP endpoint and ``python -m scripts.ingest`` call this module so
checkpointing, unit deduplication, and phase ordering cannot drift apart.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from kl_graph.config import DATA_DIR, cfg
from kl_graph.ingest.checkpoint import IngestCheckpoint
from kl_graph.ingest.improvement import (
    ImprovementResult,
    ImprovementTargets,
    ImproveMode,
    has_full_improvement_baseline,
    run_improvement,
    validate_improve_mode,
)
from kl_graph.ingest.pipeline import KEEP_EXTRACTION_CACHE, IngestionPipeline
from kl_graph.ingest.llm_extractor import ExtractionFailure

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str, float, str], None]
NodeRef = tuple[str, str]


@dataclass(frozen=True)
class IngestOptions:
    """Caller-owned inputs for one local-directory ingestion run."""

    input_dir: Path
    source_id: str
    concurrency: int = int(cfg.pipelines.ingestion.extraction.concurrency)
    improve_mode: ImproveMode = "auto"
    keep_cache: bool = KEEP_EXTRACTION_CACHE

    def __post_init__(self) -> None:
        if self.concurrency <= 0:
            raise ValueError("concurrency must be greater than zero")


@dataclass(frozen=True)
class IngestResult:
    units_discovered: int
    units_skipped: int
    units_processed: int
    chunks_created: int
    extraction_total: int = 0
    extraction_succeeded: int = 0
    extraction_failed: int = 0
    failures: tuple[ExtractionFailure, ...] = ()

    @property
    def outcome(self) -> str:
        return "partial" if self.extraction_failed else "success"

    @property
    def warning(self) -> str:
        if not self.extraction_failed:
            return ""
        return (
            f"{self.extraction_failed} extraction item(s) failed after "
            "in-step retries"
        )

    def as_checkpoint_dict(self) -> dict:
        """Serialize the public run outcome into JSON-compatible metadata."""
        return {
            "units_discovered": self.units_discovered,
            "units_skipped": self.units_skipped,
            "units_processed": self.units_processed,
            "chunks_created": self.chunks_created,
            "extraction_total": self.extraction_total,
            "extraction_succeeded": self.extraction_succeeded,
            "extraction_failed": self.extraction_failed,
            "failures": [failure.as_dict() for failure in self.failures],
        }

    @classmethod
    def from_checkpoint_dict(cls, raw: dict) -> "IngestResult":
        """Restore an outcome saved with :meth:`as_checkpoint_dict`."""
        failures = tuple(
            ExtractionFailure(**failure)
            for failure in raw.get("failures", [])
            if isinstance(failure, dict)
        )
        return cls(
            units_discovered=int(raw.get("units_discovered", 0)),
            units_skipped=int(raw.get("units_skipped", 0)),
            units_processed=int(raw.get("units_processed", 0)),
            chunks_created=int(raw.get("chunks_created", 0)),
            extraction_total=int(raw.get("extraction_total", 0)),
            extraction_succeeded=int(raw.get("extraction_succeeded", 0)),
            extraction_failed=int(raw.get("extraction_failed", len(failures))),
            failures=failures,
        )


@dataclass(frozen=True)
class ServingIndexUpdate:
    """Authoritative-store scopes needed to refresh server-side query indexes.

    These are dirty *seeds*, not a replay log.  The server rereads their
    committed incident edges before publishing new adjacency buckets, which is
    safe across duplicate-ignore writes and checkpoint resumes.
    """

    structural_nodes: tuple[NodeRef, ...] = ()
    similarity_nodes: tuple[NodeRef, ...] = ()
    community_ids: tuple[str, ...] = ()
    full_adjacency: bool = False
    pagerank_dirty: bool = False

    @property
    def adjacency_dirty(self) -> bool:
        return bool(
            self.full_adjacency
            or self.structural_nodes
            or self.similarity_nodes
            or self.community_ids
        )

    @property
    def required(self) -> bool:
        return self.adjacency_dirty or self.pagerank_dirty


FinalizeCallback = Callable[[ServingIndexUpdate], None]


def checkpoint_path(source_id: str, data_dir: Path = DATA_DIR) -> Path:
    """Return the stable, filesystem-safe checkpoint path for a source."""

    safe_source = "".join(
        char if char.isalnum() or char in "-_" else "_" for char in source_id
    )
    return Path(data_dir) / f"ingest_checkpoint.{safe_source}.json"


def make_checkpoint(options: IngestOptions, data_dir: Path = DATA_DIR) -> IngestCheckpoint:
    return IngestCheckpoint(
        checkpoint_path(options.source_id, data_dir), [Path(options.input_dir)]
    )


async def run_ingestion(
    options: IngestOptions,
    *,
    store=None,
    qdrant=None,
    checkpoint: IngestCheckpoint | None = None,
    progress_callback: ProgressCallback | None = None,
    counts_callback: Callable[[IngestResult], None] | None = None,
    finalize_callback: FinalizeCallback | None = None,
    structural_cache=None,
) -> IngestResult:
    """Run the canonical unit-incremental ingestion workflow."""

    input_dir = Path(options.input_dir).expanduser().resolve()
    if not input_dir.is_dir():
        raise ValueError(f"input_dir is not a directory: {input_dir}")
    if not options.source_id.strip():
        raise ValueError("source_id must not be empty")
    if options.concurrency < 1:
        raise ValueError("concurrency must be at least 1")
    improve_mode = validate_improve_mode(options.improve_mode)

    checkpoint = checkpoint or make_checkpoint(
        IngestOptions(
            input_dir=input_dir,
            source_id=options.source_id,
            concurrency=options.concurrency,
            improve_mode=improve_mode,
            keep_cache=options.keep_cache,
        )
    )

    def report(phase: str, percent: float, detail: str) -> None:
        if progress_callback is not None:
            progress_callback(phase, percent, detail)

    pipeline = IngestionPipeline(
        messages_dir=input_dir / "chat",
        max_concurrent_llm=options.concurrency,
        store=store,
        qdrant=qdrant,
        checkpoint=checkpoint,
        keep_cache=options.keep_cache,
        source_id=options.source_id,
        incremental_units=True,
        structural_cache=structural_cache,
    )
    try:
        completion_params = {
            "workset_schema": 1,
            "batch_id": checkpoint.batch_id,
        }
        if checkpoint.is_done("ingest.complete", params=completion_params):
            # Completion is checkpointed before cleanup. Repeating cleanup makes
            # a crash in that tiny window converge without re-running any phase.
            # A forced global improvement remains useful after the workset has
            # been cleaned, while auto/incremental correctly have no delta left.
            recover_missing_baseline = False
            if improve_mode == "auto":
                pipeline._init_stores()
                has_graph_nodes = bool(
                    pipeline.store.count_entities() or pipeline.store.count_facts()
                )
                recover_missing_baseline = (
                    has_graph_nodes and not has_full_improvement_baseline(pipeline.store)
                )
            if improve_mode == "full" or recover_missing_baseline:
                pipeline._init_stores()
                if improve_mode == "full":
                    checkpoint.clear_prefix("improve.")
                detail = (
                    "forced full improvement"
                    if improve_mode == "full"
                    else "seeding missing improvement baseline"
                )
                report("improve", 0.85, detail)
                try:
                    await asyncio.to_thread(
                        run_improvement,
                        "full",
                        store=pipeline.store,
                        qdrant=pipeline.qdrant,
                        targets=ImprovementTargets(),
                        checkpoint=checkpoint,
                        batch_id=checkpoint.batch_id,
                        structural_cache=structural_cache,
                    )
                    if finalize_callback is not None:
                        report("finalize", 0.95, "refreshing indexes")
                        await asyncio.to_thread(
                            finalize_callback,
                            ServingIndexUpdate(full_adjacency=True),
                        )
                except ImportError as exc:
                    if improve_mode == "full":
                        raise
                    logger.warning("Automatic improvement skipped: %s", exc)
            await asyncio.to_thread(pipeline.complete_workset)
            report("done", 1.0, "ingest already complete")
            saved_result = checkpoint.step_metadata("ingest.complete").get("result")
            if isinstance(saved_result, dict):
                return IngestResult.from_checkpoint_dict(saved_result)
            return IngestResult(0, 0, 0, 0)

        report("phase_a", 0.0, "starting")

        def phase_a() -> None:
            if pipeline._phase_a_complete() and checkpoint.is_done(
                "phase_a.persist_chunks", params={"unit_lineage_schema": 1}
            ):
                report("phase_a", 0.4, "Phase A already complete; resuming at Phase B")
                return
            pipeline.run_phase_a(
                progress_callback=lambda phase, percent: report(
                    phase, percent * 0.4, "chunking + embedding"
                )
            )

        await asyncio.to_thread(phase_a)
        result = IngestResult(
            units_discovered=pipeline.units_discovered,
            units_skipped=pipeline.units_skipped,
            units_processed=pipeline.workset_unit_count,
            chunks_created=pipeline.workset_chunk_count,
        )
        if counts_callback is not None:
            counts_callback(result)

        report("phase_b", 0.4, "extraction + graph build")

        def extraction_progress(done: int, total: int) -> None:
            fraction = done / total if total else 1.0
            report("phase_b", 0.4 + 0.3 * fraction, f"extracting: {done}/{total} batches")

        failures = await pipeline.run_extraction(
            progress_callback=extraction_progress
        )
        failures = tuple(failures or ())
        extraction_total = len(pipeline.extraction_items)
        result = IngestResult(
            units_discovered=result.units_discovered,
            units_skipped=result.units_skipped,
            units_processed=result.units_processed,
            chunks_created=result.chunks_created,
            extraction_total=extraction_total,
            extraction_succeeded=max(0, extraction_total - len(failures)),
            extraction_failed=len(failures),
            failures=failures,
        )
        if counts_callback is not None:
            counts_callback(result)
        report("phase_b", 0.7, "building graph")

        def graph_progress(fraction: float) -> None:
            report("phase_b", 0.7 + 0.15 * fraction, "building graph")

        # The coroutine contains long synchronous SQLite/embedding/graph blocks.
        # Give it a worker-owned event loop so the server loop remains responsive;
        # SQLiteStore supplies per-thread handles, and _init_stores deliberately
        # does not move the extraction-cache connection across this boundary.
        await asyncio.to_thread(
            lambda: asyncio.run(
                pipeline.run_graph_build(progress_callback=graph_progress)
            )
        )

        targets = ImprovementTargets()
        if improve_mode != "off" or finalize_callback is not None:
            targets = pipeline.improvement_targets()

        improvement = ImprovementResult(
            requested_mode=improve_mode,
            applied_mode="off",
        )
        if improve_mode != "off":
            report(
                "improve",
                0.85,
                f"{improve_mode}: {len(targets.entity_ids)} entities, "
                f"{len(targets.fact_ids)} facts",
            )
            try:
                improvement = await asyncio.to_thread(
                    run_improvement,
                    improve_mode,
                    store=pipeline.store,
                    qdrant=pipeline.qdrant,
                    targets=targets,
                    checkpoint=checkpoint,
                    batch_id=checkpoint.batch_id,
                    structural_cache=structural_cache,
                )
                report(
                    "improve",
                    0.95,
                    f"applied {improvement.applied_mode} improvement",
                )
            except ImportError as exc:
                if improve_mode in ("incremental", "full"):
                    raise
                logger.warning("Automatic improvement skipped: %s", exc)

        if finalize_callback is not None:
            structural_nodes: set[NodeRef] = {
                ("chunk", chunk.id) for chunk in pipeline.all_chunks()
            }
            structural_nodes.update(("fact", fact_id) for fact_id in targets.fact_ids)

            similarity_nodes: set[NodeRef] = set()
            community_ids: tuple[str, ...] = ()
            full_adjacency = improvement.applied_mode == "full"
            if improvement.applied_mode == "incremental":
                similarity_nodes.update(
                    ("entity", entity_id) for entity_id in targets.entity_ids
                )
                similarity_nodes.update(
                    ("fact", fact_id) for fact_id in targets.fact_ids
                )
                community_ids = improvement.changed_community_ids

            index_update = ServingIndexUpdate(
                structural_nodes=tuple(sorted(structural_nodes)),
                similarity_nodes=tuple(sorted(similarity_nodes)),
                community_ids=tuple(sorted(set(community_ids))),
                full_adjacency=full_adjacency,
                # The current prior depends only on facts/confidence and ABOUT.
                # Every workset fact is a conservative signal that those inputs
                # may have changed; similarity/community-only work is not.
                pagerank_dirty=bool(targets.fact_ids),
            )
            if index_update.required:
                report("finalize", 0.95, "refreshing changed indexes")
                await asyncio.to_thread(finalize_callback, index_update)

        # Safe ordering: a crash before this point retains the workset; a crash
        # after the checkpoint but before cleanup is handled by the idempotent
        # early-completion branch above.
        checkpoint.mark_done(
            "ingest.complete",
            params=completion_params,
            result=result.as_checkpoint_dict(),
        )
        await asyncio.to_thread(pipeline.complete_workset)
        detail = "ingest complete"
        if result.extraction_failed:
            detail = f"ingest complete with warning: {result.warning}"
        report("done", 1.0, detail)
        return result
    finally:
        pipeline.close()
