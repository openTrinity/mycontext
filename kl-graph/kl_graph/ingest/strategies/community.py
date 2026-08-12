"""Default incremental community strategy — GUARDED NO-OP (detection only).

The incremental community *detection* path (per-batch local relabeling) is
deferred to phase 2 (wiring ``kl_graph/hit_leiden/`` HIT-Leiden behind a
backward-compatible adapter). For v1 the delivery decision is a FULL
``hierarchical_leiden`` rerun on the periodic path, followed by stable-identity
reconciliation (``community_identity``) and baseline-aware gated
re-summarization (``community_summarizer.run_gated_summarization``). That full
path makes *summaries* incremental (unchanged communities keep their reports)
without a new detector.

This strategy therefore still returns a no-change result on the incremental
ingest path: it does not itself relabel communities. Identity reconciliation and
summary gating are performed by the coordinator/periodic runner, not here. The
class and public entry signature are preserved so incremental ingestion does not
crash.

Future work (phase 2): port incremental community assignment to HIT-Leiden and
emit the changed partition scope for the coordinator to reconcile.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from kl_graph.storage.base import KnowledgeStore

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class DynamicFrontierLeiden:
    """Incremental community assignment — GUARDED NO-OP.

    This strategy is disabled pending the incremental hierarchical Leiden path.
    The class and public entry signature are preserved so incremental ingestion
    does not crash, but the run path logs a warning and returns an empty result
    without touching communities.
    """

    def assign_communities(
        self,
        store: KnowledgeStore,
        new_entity_ids: list[str],
        new_fact_ids: list[str],
        *,
        entity_resolutions: dict[str, float],
        fact_resolutions: dict[str, float],
    ) -> set[str]:
        """Assign community memberships incrementally — GUARDED NO-OP.

        This method is disabled pending the incremental hierarchical Leiden path.
        It logs a warning and returns an empty set without touching communities.

        Args:
            store: KnowledgeStore with sql_conn for reading graph and updating columns.
            new_entity_ids: Entity IDs from this incremental run.
            new_fact_ids: Fact IDs from this incremental run.
            entity_resolutions: Dict mapping level name to resolution parameter for entities.
            fact_resolutions: Dict mapping level name to resolution parameter for facts.

        Returns:
            Empty set (no communities changed).
        """
        logger.warning(
            "Incremental community strategy disabled pending incremental rewrite. "
            "Skipping community assignment for %d entities and %d facts.",
            len(new_entity_ids),
            len(new_fact_ids),
        )
        return set()
