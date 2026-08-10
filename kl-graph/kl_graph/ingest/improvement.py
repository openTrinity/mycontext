"""Post-ingestion improvement selection and incremental execution.

Normal ingestion is incremental by immutable source-unit identity.  This module
decides whether the derived similarity/community layer needs a one-time global
seed or can be updated from the current ingestion batch.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass
from typing import Literal

from kl_graph.config import cfg
from kl_graph.ingest.checkpoint import IngestCheckpoint
from kl_graph.ingest.strategies import get_community_strategy, get_similarity_strategy
from kl_graph.periodic.community_detection import (
    RESOLUTIONS,
)
from kl_graph.storage.base import KnowledgeStore
from kl_graph.storage.vector_store import VectorStore

logger = logging.getLogger(__name__)

ImproveMode = Literal["off", "auto", "incremental", "full"]
VALID_IMPROVE_MODES = frozenset(("off", "auto", "incremental", "full"))


@dataclass(frozen=True)
class ImprovementTargets:
    """Graph nodes affected by the current durable ingestion workset."""

    entity_ids: tuple[str, ...] = ()
    fact_ids: tuple[str, ...] = ()

    @property
    def empty(self) -> bool:
        return not self.entity_ids and not self.fact_ids


@dataclass(frozen=True)
class ImprovementResult:
    """Outcome of one requested post-ingestion improvement."""

    requested_mode: ImproveMode
    applied_mode: Literal["off", "incremental", "full"]
    similarity_edges: int = 0
    changed_communities: int = 0
    stale_summaries: int = 0
    changed_community_ids: tuple[str, ...] = ()


def validate_improve_mode(mode: str) -> ImproveMode:
    if mode not in VALID_IMPROVE_MODES:
        choices = ", ".join(sorted(VALID_IMPROVE_MODES))
        raise ValueError(f"Unknown improve mode {mode!r}; expected one of: {choices}")
    return mode  # type: ignore[return-value]


def has_full_improvement_baseline(store: KnowledgeStore) -> bool:
    """Return whether global improvement has initialized community columns.

    The metadata marker is written by new runs.  The schema check recognizes
    databases improved before the marker was introduced.
    """

    if store.get_meta("improvement.full.completed_at") is not None:
        return True

    conn = store.sql_conn
    required = {f"community_{level}" for level in RESOLUTIONS}
    for table in ("entities", "facts"):
        columns = {
            str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if not required.issubset(columns):
            return False
    return True


def resolve_improve_mode(
    requested_mode: ImproveMode,
    store: KnowledgeStore,
    targets: ImprovementTargets,
) -> Literal["off", "incremental", "full"]:
    """Resolve ``auto`` from durable graph state, not run counts or timestamps."""

    if requested_mode == "off":
        return "off"
    if requested_mode == "full":
        return "full"
    if targets.empty:
        return "off"
    if requested_mode == "incremental":
        if not has_full_improvement_baseline(store):
            raise ValueError(
                "incremental improvement requires an existing full-improvement "
                "baseline; use improve_mode='auto' or 'full'"
            )
        return "incremental"
    return "incremental" if has_full_improvement_baseline(store) else "full"


def _current_community_ids(
    store: KnowledgeStore, targets: ImprovementTargets
) -> set[str]:
    """Return current community UUIDs touched by the target nodes."""

    from kl_graph.models.types import community_id_from

    touched: set[str] = set()
    conn = store.sql_conn
    for node_type, table, ids in (
        ("entity", "entities", targets.entity_ids),
        ("fact", "facts", targets.fact_ids),
    ):
        if not ids:
            continue
        columns = {
            str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        levels = [level for level in RESOLUTIONS if f"community_{level}" in columns]
        if not levels:
            continue
        selected = ", ".join(f"community_{level}" for level in levels)
        for start in range(0, len(ids), 500):
            batch = ids[start : start + 500]
            placeholders = ",".join("?" for _ in batch)
            rows = conn.execute(
                f"SELECT {selected} FROM {table} WHERE id IN ({placeholders})",
                batch,
            ).fetchall()
            for row in rows:
                for level, cluster_id in zip(levels, row):
                    if cluster_id is not None:
                        touched.add(
                            community_id_from(level, int(cluster_id))
                        )
    return touched


def _invalidate_summaries(
    store: KnowledgeStore, community_ids: set[str], *, threshold: float
) -> int:
    """Mark summaries stale when at least one changed member exceeds the ratio."""

    if not community_ids:
        return 0
    conn = store.sql_conn
    try:
        columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(communities)").fetchall()
        }
        if "summary_stale" not in columns:
            return 0
        rows = []
        ordered = sorted(community_ids)
        for start in range(0, len(ordered), 500):
            batch = ordered[start : start + 500]
            placeholders = ",".join("?" for _ in batch)
            rows.extend(
                conn.execute(
                    "SELECT id, member_count FROM communities "
                    f"WHERE id IN ({placeholders})",
                    batch,
                ).fetchall()
            )
        stale_ids = [
            str(row[0])
            for row in rows
            if 1.0 / max(1, int(row[1] or 1)) > threshold
        ]
        for start in range(0, len(stale_ids), 500):
            batch = stale_ids[start : start + 500]
            placeholders = ",".join("?" for _ in batch)
            conn.execute(
                f"UPDATE communities SET summary_stale = 1 WHERE id IN ({placeholders})",
                batch,
            )
        conn.commit()
        return len(stale_ids)
    except sqlite3.DatabaseError:
        logger.exception("Failed to invalidate incremental community summaries")
        return 0


def run_incremental_improvement(
    *,
    store: KnowledgeStore,
    qdrant: VectorStore,
    targets: ImprovementTargets,
    checkpoint: IngestCheckpoint | None = None,
    batch_id: str | None = None,
    structural_cache=None,
) -> ImprovementResult:
    """Update similarities and communities for nodes affected by one batch."""

    similarity_name = str(cfg.pipelines.ingestion.incremental.similarity_strategy)
    communities_enabled = bool(cfg.pipelines.communities.enabled)
    community_name = (
        str(cfg.pipelines.ingestion.incremental.community_strategy)
        if communities_enabled
        else "disabled"
    )
    similarity = get_similarity_strategy(similarity_name)
    params = {
        "batch_id": batch_id,
        "similarity_strategy": similarity_name,
        "community_strategy": community_name,
    }

    similarity_edges = 0
    similarity_done = checkpoint is not None and checkpoint.is_done(
        "improve.incremental_similarity", params=params
    )
    if not similarity_done:
        cached_kwargs: dict = {}
        if structural_cache is not None:
            cached_kwargs["cached_msg_sets"] = structural_cache.entity_to_chunks
            cached_kwargs["cached_fact_sets"] = structural_cache.entity_to_facts
        edges = similarity.compute_similarity_edges(
            list(targets.entity_ids), list(targets.fact_ids), qdrant, store,
            **cached_kwargs,
        )
        if edges:
            store.insert_edges(edges)
        similarity_edges = len(edges)
        if checkpoint is not None:
            checkpoint.mark_done(
                "improve.incremental_similarity",
                params=params,
                count=similarity_edges,
            )

    if not communities_enabled:
        return ImprovementResult(
            requested_mode="incremental",
            applied_mode="incremental",
            similarity_edges=similarity_edges,
        )

    communities = get_community_strategy(community_name)

    changed: set[str] = set()
    changed_keys: set[tuple[str, str, int]] = set()
    stale_count = 0

    # Step 2a: Leiden — assign_communities, checkpoint the changed set.
    leiden_done = checkpoint is not None and checkpoint.is_done(
        "improve.incremental_leiden", params=params
    )
    if not leiden_done:
        community_changes = communities.assign_communities(
            store,
            list(targets.entity_ids),
            list(targets.fact_ids),
            entity_resolutions=RESOLUTIONS,
            fact_resolutions=RESOLUTIONS,
        )
        changed = set(community_changes)
        changed_keys = set(getattr(community_changes, "community_keys", set()))
        if checkpoint is not None:
            checkpoint.mark_done(
                "improve.incremental_leiden",
                params=params,
                changed_communities=",".join(sorted(changed)),
                changed_community_keys=[list(key) for key in sorted(changed_keys)],
            )
    else:
        # Recover the changed-community set from the checkpoint meta so the
        # projection step can be scoped even when Leiden was already done.
        if checkpoint is not None:
            entry = checkpoint._data.get("steps", {}).get(
                "improve.incremental_leiden", {}
            )
            changed_str = entry.get("changed_communities", "")
            changed = set(changed_str.split(",")) if changed_str else set()
            for raw_key in entry.get("changed_community_keys", []):
                if not isinstance(raw_key, list) or len(raw_key) != 3:
                    continue
                try:
                    changed_keys.add(
                        (str(raw_key[0]), str(raw_key[1]), int(raw_key[2]))
                    )
                except (TypeError, ValueError):
                    continue

    # Step 2b: Summary invalidation. Incremental community *assignment* and the
    # scoped COMM_MEMBER projection are deferred to the next full improve
    # (hierarchical Leiden rebuilds the whole projection); the incremental
    # strategy is a guarded no-op, so ``changed`` stays empty here. We still
    # invalidate the summaries of the communities the touched nodes already
    # belong to, so a stale report is not served for a community whose members
    # changed.
    projection_done = checkpoint is not None and checkpoint.is_done(
        "improve.incremental_projection", params=params
    )
    if not projection_done:
        changed.update(_current_community_ids(store, targets))
        stale_count = _invalidate_summaries(
            store,
            changed,
            threshold=float(
                cfg.pipelines.ingestion.incremental.community_summary_threshold
            ),
        )
        if checkpoint is not None:
            checkpoint.mark_done(
                "improve.incremental_projection",
                params=params,
                changed=len(changed),
                stale=stale_count,
            )

    return ImprovementResult(
        requested_mode="incremental",
        applied_mode="incremental",
        similarity_edges=similarity_edges,
        changed_communities=len(changed),
        stale_summaries=stale_count,
        changed_community_ids=tuple(sorted(changed)),
    )


def run_improvement(
    requested_mode: str,
    *,
    store: KnowledgeStore,
    qdrant: VectorStore,
    targets: ImprovementTargets,
    checkpoint: IngestCheckpoint | None = None,
    batch_id: str | None = None,
    structural_cache=None,
) -> ImprovementResult:
    """Resolve and execute post-ingestion improvement."""

    requested = validate_improve_mode(requested_mode)
    applied = resolve_improve_mode(requested, store, targets)
    if applied == "off":
        return ImprovementResult(requested, "off")

    # Only the experimental full community path requires hierarchical Leiden.
    # Check before similarity writes so an explicitly enabled but incomplete
    # installation cannot leave a half-improved run.
    if applied == "full" and bool(cfg.pipelines.communities.enabled):
        try:
            import graspologic_native  # noqa: F401
        except ImportError as exc:
            raise ImportError(
                "community improvement requires graspologic-native"
            ) from exc

    if applied == "incremental":
        result = run_incremental_improvement(
            store=store,
            qdrant=qdrant,
            targets=targets,
            checkpoint=checkpoint,
            batch_id=batch_id,
            structural_cache=structural_cache,
        )
        return ImprovementResult(
            requested_mode=requested,
            applied_mode="incremental",
            similarity_edges=result.similarity_edges,
            changed_communities=result.changed_communities,
            stale_summaries=result.stale_summaries,
            changed_community_ids=result.changed_community_ids,
        )

    from kl_graph.periodic.runner import run_periodic_improvement

    run_periodic_improvement(store=store, qdrant=qdrant, checkpoint=checkpoint)
    store.set_meta("improvement.full.completed_at", str(int(time.time())))
    return ImprovementResult(requested, "full")
