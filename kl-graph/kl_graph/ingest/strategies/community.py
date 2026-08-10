"""Default incremental community strategy — GUARDED NO-OP pending incremental rewrite.

This strategy is disabled pending the completion of the incremental
hierarchical Leiden path. The batch full-rebuild already runs hierarchical
Leiden; only the incremental assignment path is deferred. The class and public
entry signature are preserved so incremental ingestion does not crash, but the
run path logs a clear warning and returns an empty/no-change result without
touching communities.

Future work: port incremental community assignment to the hierarchical
Leiden framework once the full rebuild path is stable.
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
