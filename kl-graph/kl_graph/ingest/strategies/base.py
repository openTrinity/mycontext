"""Protocol definitions for incremental ingestion strategies — pluggable algorithms for similarity computation and community assignment during incremental runs."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from kl_graph.models.types import Edge
from kl_graph.storage.base import KnowledgeStore
from kl_graph.storage.qdrant_store import QdrantStore


@runtime_checkable
class IncrementalSimilarityStrategy(Protocol):
    """Protocol for computing ENTITY_SIMILAR and FACT_SIMILAR edges incrementally."""

    def compute_similarity_edges(
        self,
        new_entity_ids: list[str],
        new_fact_ids: list[str],
        qdrant: QdrantStore,
        store: KnowledgeStore,
        *,
        entity_threshold: float = 0.45,
        fact_threshold: float = 0.85,
        cached_msg_sets: dict[str, set[str]] | None = None,
        cached_fact_sets: dict[str, set[str]] | None = None,
    ) -> list[Edge]:
        """Compute similarity edges for newly ingested nodes.

        Args:
            new_entity_ids: IDs of entities created in this incremental run.
            new_fact_ids: IDs of facts created in this incremental run.
            qdrant: QdrantStore for vector similarity lookups.
            store: KnowledgeStore for structural data (co-occurrence, ABOUT edges).
            entity_threshold: Minimum hybrid score to emit ENTITY_SIMILAR edge (default 0.45).
            fact_threshold: Minimum cosine score to emit FACT_SIMILAR edge (default 0.85).
            cached_msg_sets: Optional pre-loaded entity→chunk sets; avoids O(E) store scan.
            cached_fact_sets: Optional pre-loaded entity→fact sets; avoids O(E) store scan.

        Returns:
            List of Edge objects (ENTITY_SIMILAR and/or FACT_SIMILAR).
        """
        ...


@runtime_checkable
class IncrementalCommunityStrategy(Protocol):
    """Protocol for assigning community memberships to newly ingested nodes incrementally."""

    def assign_communities(
        self,
        store: KnowledgeStore,
        new_entity_ids: list[str],
        new_fact_ids: list[str],
        *,
        entity_resolutions: dict[str, float],
        fact_resolutions: dict[str, float],
        structural_cache: object | None = None,
    ) -> set[str]:
        """Assign community memberships to new and affected existing nodes.

        Args:
            store: KnowledgeStore with sql_conn for direct community column updates.
            new_entity_ids: Entity IDs from the current incremental run.
            new_fact_ids: Fact IDs from the current incremental run.
            entity_resolutions: Resolution parameters per level for entity graph.
                Example: {"L0": 0.3, "L1": 1.0, "L2": 3.0, "L3": 10.0}
            fact_resolutions: Resolution parameters per level for fact graph.
                Example: {"L0": 0.3, "L1": 1.0, "L2": 3.0, "L3": 10.0}
            structural_cache: Optional StructuralCache for degree-scoped
                co-mention/shared-entity computation without graph-wide scans.
                Typed as ``object`` here to avoid importing the concrete class.

        Returns:
            Set of community UUIDs whose membership changed. Implementations
            should expose a ``community_keys`` set of reversible
            ``(node_type, level, cluster_id)`` tuples when available so
            projection reads can remain scoped.
        """
        ...
