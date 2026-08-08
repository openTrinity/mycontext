"""In-memory structural relationship cache for incremental improvement.

Eliminates repeated O(E) scans of MENTIONS/AUTHORED_BY/ABOUT edges by
caching entity↔chunk and entity↔fact mappings in server memory.
Structural edges are append-only, so deltas are well-defined.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from kl_graph.models.types import EdgeType

if TYPE_CHECKING:
    from kl_graph.models.types import Edge
    from kl_graph.storage.base import KnowledgeStore

logger = logging.getLogger(__name__)

_STRUCTURAL_EDGE_TYPES = {EdgeType.MENTIONS.value, EdgeType.AUTHORED_BY.value, EdgeType.ABOUT.value}


class StructuralCache:
    """Bidirectional cache of entity↔chunk and entity↔fact structural edges.

    Loaded once from the store at server startup (O(E) one-time cost), then
    kept fresh via per-batch delta application from newly created edges.
    """

    def __init__(self) -> None:
        self.entity_to_chunks: dict[str, set[str]] = {}
        self.entity_to_facts: dict[str, set[str]] = {}
        self.chunk_to_entities: dict[str, set[str]] = {}
        self.fact_to_entities: dict[str, set[str]] = {}

    @classmethod
    def from_store(cls, store: KnowledgeStore) -> StructuralCache:
        """Full load: scan MENTIONS/AUTHORED_BY/ABOUT edges once.

        This is the O(E) startup cost. After this, deltas keep the cache fresh.
        """
        cache = cls()
        for chunk_id, entity_id, _ in store.scan_edges_by_type(
            [EdgeType.MENTIONS.value, EdgeType.AUTHORED_BY.value],
            source_type="chunk", target_type="entity",
        ):
            cache.entity_to_chunks.setdefault(entity_id, set()).add(chunk_id)
            cache.chunk_to_entities.setdefault(chunk_id, set()).add(entity_id)

        for fact_id, entity_id, _ in store.scan_edges_by_type(
            [EdgeType.ABOUT.value], source_type="fact", target_type="entity",
        ):
            cache.entity_to_facts.setdefault(entity_id, set()).add(fact_id)
            cache.fact_to_entities.setdefault(fact_id, set()).add(entity_id)

        logger.info(
            "StructuralCache loaded: %d entities, %d chunks, %d facts",
            len(cache.entity_to_chunks), len(cache.chunk_to_entities),
            len(cache.fact_to_entities),
        )
        return cache

    def apply_delta(self, edges: list[Edge]) -> None:
        """Apply newly created edges to update the four mappings (O(K)).

        Only processes MENTIONS, AUTHORED_BY, and ABOUT edges; other edge
        types (ENTITY_SIMILAR, etc.) are ignored.
        """
        for edge in edges:
            etype = edge.edge_type.value if hasattr(edge.edge_type, 'value') else str(edge.edge_type)
            if etype not in _STRUCTURAL_EDGE_TYPES:
                continue
            if etype in (EdgeType.MENTIONS.value, EdgeType.AUTHORED_BY.value):
                self.entity_to_chunks.setdefault(edge.target_id, set()).add(edge.source_id)
                self.chunk_to_entities.setdefault(edge.source_id, set()).add(edge.target_id)
            elif etype == EdgeType.ABOUT.value:
                self.entity_to_facts.setdefault(edge.target_id, set()).add(edge.source_id)
                self.fact_to_entities.setdefault(edge.source_id, set()).add(edge.target_id)

    def entities_for_chunks(self, chunk_ids: set[str]) -> set[str]:
        """Reverse lookup: entities mentioned in the given chunks (O(K))."""
        result: set[str] = set()
        for chunk_id in chunk_ids:
            result.update(self.chunk_to_entities.get(chunk_id, set()))
        return result

    def entities_for_facts(self, fact_ids: set[str]) -> set[str]:
        """Reverse lookup: entities related to the given facts (O(K))."""
        result: set[str] = set()
        for fact_id in fact_ids:
            result.update(self.fact_to_entities.get(fact_id, set()))
        return result
