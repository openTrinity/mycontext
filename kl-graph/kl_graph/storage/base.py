"""Unified storage abstraction (ABC) for the knowledge graph.

All backends implement this interface; callers program against the ABC only.
"""

from __future__ import annotations

import sqlite3
from abc import ABC, abstractmethod
from collections.abc import Iterator
from typing import Any, Self

from kl_graph.models.types import (
    Chunk,
    ChunkUnit,
    Community,
    Edge,
    Entity,
    Fact,
    Scope,
    SourceUnit,
)
from kl_graph.storage.graph_db import PathResult


class KnowledgeStore(ABC):
    """Unified storage abstraction for the knowledge graph."""

    @property
    @abstractmethod
    def sql_conn(self) -> sqlite3.Connection:
        """Raw SQLite connection escape hatch for FTS5, PageRank, community detection, and ad-hoc queries.

        Migration guidance: callers using sql_conn directly should migrate to abstract
        methods as they become available (e.g. get_timeline_facts, scan_edges_for_pagerank).
        This property exists as a pragmatic bridge for the 40+ call sites that use raw SQL.
        """
        ...

    @abstractmethod
    def close(self) -> None:
        """Release all resources (connections, file handles)."""
        raise NotImplementedError

    def __enter__(self) -> Self:
        """Enter context manager, returning self."""
        return self

    def __exit__(self, *_: object) -> None:
        """Exit context manager, calling close()."""
        self.close()

    @abstractmethod
    def insert_chunks(self, chunks: list[Chunk]) -> None:
        """Bulk insert retrieval-unit chunks. Duplicates (by id) are silently ignored.

        Args:
            chunks: Chunk instances to store. Each must have a unique `id`.
        """
        raise NotImplementedError

    def insert_chunks_with_units(
        self,
        chunks: list[Chunk],
        units: list[SourceUnit],
        memberships: list[ChunkUnit],
        *,
        batch_id: str | None = None,
        batch_source_id: str | None = None,
        source_hash: str | None = None,
    ) -> None:
        """Atomically persist chunks and their ordered source-unit mappings.

        Backends used for ingestion must override this method.  It is deliberately
        part of the chunk commit point so a completed checkpoint can never refer
        to chunks whose lineage rows were not committed.
        """
        raise NotImplementedError

    def get_ingest_batch(self, batch_id: str) -> dict[str, Any] | None:
        """Return durable workset metadata, or ``None`` if it does not exist."""

        raise NotImplementedError

    def get_ingest_batch_chunks(self, batch_id: str) -> list[Chunk]:
        """Hydrate the ordered chunks admitted by one ingestion batch."""

        raise NotImplementedError

    def complete_ingest_batch(self, batch_id: str) -> None:
        """Mark a batch complete and remove its no-longer-needed workset."""

        raise NotImplementedError

    def existing_unit_ids(
        self, source_id: str, keys: list[tuple[str, str]]
    ) -> set[tuple[str, str]]:
        """Return existing ``(source_type, unit_id)`` keys for one source."""
        raise NotImplementedError

    def existing_unit_hashes(
        self, source_id: str, keys: list[tuple[str, str]]
    ) -> dict[tuple[str, str], str]:
        """Return stored hashes for unit keys, used to flag pending updates."""
        raise NotImplementedError

    @abstractmethod
    def get_chunk(self, chunk_id: str) -> Chunk | None:
        """Retrieve a single chunk by its id.

        Args:
            chunk_id: The unique chunk identifier.

        Returns:
            The Chunk if found, else None.
        """
        raise NotImplementedError

    @abstractmethod
    def get_chunks_by_ids(self, chunk_ids: list[str]) -> list[Chunk]:
        """Retrieve multiple chunks by their ids in a single batch.

        Unknown ids are silently skipped; the result may contain fewer
        chunks than requested. Order is not guaranteed.

        Args:
            chunk_ids: The unique chunk identifiers to look up.

        Returns:
            List of found Chunk instances (may be shorter than the input).
        """
        raise NotImplementedError

    @abstractmethod
    def count_chunks(self) -> int:
        """Return total number of chunks stored."""
        raise NotImplementedError

    @abstractmethod
    def count_chunks_by_source(self) -> dict[str, int]:
        """Return chunk counts grouped by source_type.

        Returns:
            Dict mapping source_type string to count.
        """
        raise NotImplementedError

    @abstractmethod
    def insert_scopes(self, scopes: list[Scope]) -> None:
        """Bulk insert source-container scopes. Duplicates (by id) are silently ignored.

        A Scope is the container a chunk belongs to (chat conversation, wiki
        document, mail thread, meeting). Chunk membership is expressed as a
        ``PART_OF`` edge to the scope, so both backends must expose Scope storage.

        Args:
            scopes: Scope instances to store. Each must have a unique `id`.
        """
        raise NotImplementedError

    @abstractmethod
    def get_scope(self, scope_id: str) -> Scope | None:
        """Retrieve a single scope by its id.

        Args:
            scope_id: The unique scope identifier.

        Returns:
            The Scope if found, else None.
        """
        raise NotImplementedError

    @abstractmethod
    def insert_communities(self, communities: list[Community]) -> None:
        """Upsert reified community rows. Existing rows with the same id are replaced.

        A Community reifies one ``(node_type, level, cluster_id)`` cluster so
        ``COMM_MEMBER`` edges have a real endpoint. The ``community_L0..L3``
        columns on entities/facts remain the authoritative assignment storage;
        these rows (and the edges) are the derived projection, so re-clustering
        must overwrite them.

        Args:
            communities: Community instances to store.
        """
        raise NotImplementedError

    @abstractmethod
    def get_community(self, community_id: str) -> Community | None:
        """Retrieve a single reified community by its deterministic id.

        Args:
            community_id: The deterministic community identifier.

        Returns:
            The Community if found, else None.
        """
        raise NotImplementedError

    @abstractmethod
    def insert_messages(self, chunks: list[Chunk]) -> None:
        """Bulk insert chat chunks (``source_type == "message"``).

        A chat message *is* a :class:`Chunk`, so this is the chat-named entry
        point onto the unified chunk store. Duplicates (by id) are silently
        ignored.

        Args:
            chunks: Chunk instances. Each must have a unique `id`.
        """
        raise NotImplementedError

    @abstractmethod
    def get_message(self, msg_id: str) -> Chunk | None:
        """Retrieve a single chat chunk by its id.

        Args:
            msg_id: The unique chunk identifier (openMessageId for chat).

        Returns:
            The Chunk if found, else None.
        """
        raise NotImplementedError

    @abstractmethod
    def get_messages_for_entity(self, entity_id: str, limit: int = 50) -> list[Chunk]:
        """Get chunks that mention an entity (via MENTIONS edges).

        Args:
            entity_id: The entity to look up.
            limit: Maximum chunks to return (default 50).

        Returns:
            Chunks ordered by timestamp descending.
        """
        raise NotImplementedError

    @abstractmethod
    def count_messages(self) -> int:
        """Return total number of chat chunks stored."""
        raise NotImplementedError

    @abstractmethod
    def upsert_entities(self, entities: list[Entity]) -> None:
        """Bulk upsert entities. On conflict (same id), updates last_seen, increments mention_count, and overwrites description.

        The ``description`` is accumulated by the caller (ingestion merges each
        chunk's contribution), so backends persist it verbatim rather than
        merging it in the storage layer.

        Args:
            entities: Entity instances to upsert.
        """
        raise NotImplementedError

    @abstractmethod
    def get_entity_by_name(self, name: str) -> Entity | None:
        """Look up an entity by exact name match.

        Args:
            name: The entity name to match.

        Returns:
            The Entity if found, else None.
        """
        raise NotImplementedError

    @abstractmethod
    def search_entities_by_name(self, query: str, limit: int = 10) -> list[Entity]:
        """Substring search on entity names, ordered by mention_count descending.

        Args:
            query: Substring to search for.
            limit: Maximum results (default 10).

        Returns:
            Matching entities, most-mentioned first.
        """
        raise NotImplementedError

    @abstractmethod
    def search_entities(self, query: str, limit: int = 10) -> list[Entity]:
        """Keyword search over entity name **and** description.

        The entity dense vector is name-only by design, so the accumulated
        ``description`` is reachable only through this keyword path.

        Args:
            query: Free-text keyword query.
            limit: Maximum results (default 10).

        Returns:
            Matching entities, best keyword match first.
        """
        raise NotImplementedError

    @abstractmethod
    def count_entities(self) -> int:
        """Return total number of entities stored."""
        raise NotImplementedError

    @abstractmethod
    def iter_all_entities(self) -> Iterator[Entity]:
        """Iterate over all stored entities.

        Used for checkpoint-resume reload: when the ``build_entities`` step is
        skipped (already checkpointed), downstream steps call this to populate
        the in-memory entity dict from the store.

        Returns:
            Iterator of Entity objects.
        """
        raise NotImplementedError

    @abstractmethod
    def insert_facts(self, facts: list[Fact]) -> None:
        """Bulk insert facts. Duplicates (by id) are silently ignored.

        Args:
            facts: Fact instances to store.
        """
        raise NotImplementedError

    @abstractmethod
    def get_fact(self, fact_id: str) -> Fact | None:
        """Retrieve a single fact by its id.

        Args:
            fact_id: The unique fact identifier.

        Returns:
            The Fact if found, else None.
        """
        raise NotImplementedError

    @abstractmethod
    def get_facts_for_entity(self, entity_id: str, limit: int = 20) -> list[Fact]:
        """Get facts related to an entity via ABOUT edges.

        Args:
            entity_id: The entity to look up.
            limit: Maximum facts to return (default 20).

        Returns:
            Facts ordered by timestamp descending.
        """
        raise NotImplementedError

    @abstractmethod
    def count_facts(self) -> int:
        """Return total number of facts stored."""
        raise NotImplementedError

    @abstractmethod
    def iter_all_facts(self) -> Iterator[Fact]:
        """Iterate over all stored facts.

        Used for checkpoint-resume reload: when the ``build_facts`` step is
        skipped (already checkpointed), downstream steps call this to populate
        the in-memory facts list from the store.

        Returns:
            Iterator of Fact objects.
        """
        raise NotImplementedError

    @abstractmethod
    def insert_edges(self, edges: list[Edge]) -> None:
        """Bulk insert edges. Duplicates (same source+target+type) are silently ignored.

        Args:
            edges: Edge instances to store.
        """
        raise NotImplementedError

    @abstractmethod
    def delete_edges(
        self,
        *,
        source_id: str | None = None,
        target_id: str | None = None,
        edge_type: str | None = None,
        where_properties: dict | None = None,
    ) -> int:
        """Delete edges matching the given filters. At least one filter must be specified.

        Args:
            source_id: If set, restrict to edges from this source.
            target_id: If set, restrict to edges pointing to this target.
            edge_type: If set, restrict to edges of this type.
            where_properties: If set, filter on properties JSON content.

        Returns:
            Number of edges deleted.
        """
        raise NotImplementedError

    @abstractmethod
    def get_neighbors(
        self,
        node_type: str,
        node_id: str,
        edge_type: str | None = None,
        direction: str = "both",
    ) -> list[dict]:
        """Get neighboring nodes via edges.

        Args:
            node_type: Type of the query node ("entity", "fact", "chunk").
            node_id: ID of the query node.
            edge_type: If set, filter to this edge type only.
            direction: "outgoing" (source=this), "incoming" (target=this), or "both".

        Returns:
            List of edge dicts with source_type, source_id, target_type, target_id, edge_type, properties.
        """
        raise NotImplementedError

    @abstractmethod
    def count_edges(self) -> int:
        """Return total number of edges stored."""
        raise NotImplementedError

    @abstractmethod
    def count_edges_by_type(self) -> dict[str, int]:
        """Return edge counts grouped by edge_type.

        Returns:
            Dict mapping edge_type string to count.
        """
        raise NotImplementedError

    @abstractmethod
    def scan_edges_by_type(
        self,
        edge_types: list[str],
        *,
        source_type: str | None = None,
        target_type: str | None = None,
    ) -> Iterator[tuple[str, str, dict]]:
        """Stream ``(source_id, target_id, properties)`` for edges of given type(s).

        Backend-agnostic edge-read primitive for the periodic-improvement stages
        (community detection, entity similarity, disambiguation, summarizer).
        They must read edges through this method rather than the SQLite ``edges``
        table directly, because on the ladybug backend edges live in LadybugDB
        and the SQLite ``edges`` table is empty. Properties round-trip in full
        (weights/flags like ``hybrid_score``/``score``/``source``).

        Args:
            edge_types: Edge type names to scan (e.g. ``["MENTIONS", "AUTHORED_BY"]``).
            source_type: If set, restrict to edges from this source node type.
            target_type: If set, restrict to edges to this target node type.

        Returns:
            Iterator of ``(source_id, target_id, properties_dict)`` tuples.
        """
        raise NotImplementedError

    @abstractmethod
    def scan_edges_for_nodes(
        self,
        edge_types: list[str],
        node_ids: set[str],
        *,
        source_type: str | None = None,
        target_type: str | None = None,
    ) -> Iterator[tuple[str, str, dict]]:
        """Stream ``(source_id, target_id, properties)`` for edges touching ``node_ids``.

        Frontier-scoped edge scan: returns only edges where the source_id OR
        target_id is in ``node_ids``. This lets the incremental community
        strategy build a frontier-only subgraph without loading all edges.
        Indexed implementations scale with requested IDs plus incident output
        edges rather than total graph edges.

        Args:
            edge_types: Edge type names to scan (e.g. ``["ENTITY_SIMILAR"]``).
            node_ids: Set of node IDs to filter on (either endpoint).
            source_type: If set, restrict to edges from this source node type.
            target_type: If set, restrict to edges to this target node type.

        Returns:
            Iterator of ``(source_id, target_id, properties_dict)`` tuples.
        """
        raise NotImplementedError

    @abstractmethod
    def find_paths(
        self,
        source_id: str,
        target_id: str,
        *,
        max_hops: int = 4,
        all_shortest: bool = False,
        edge_types: list[str] | None = None,
    ) -> PathResult:
        """Find shortest path(s) between two nodes.

        Args:
            source_id: Start node id.
            target_id: End node id.
            max_hops: Maximum path length in edges (default 4).
            all_shortest: If True return all shortest paths; if False return just one.
            edge_types: Restrict traversal to these edge types. None = default walkable set.

        Returns:
            PathResult containing found paths.
        """
        raise NotImplementedError

    @abstractmethod
    def neighbors_typed(
        self,
        node_id: str,
        node_type: str,
        *,
        edge_types: list[str] | None = None,
        direction: str = "both",
        limit: int = 50,
    ) -> list[tuple[str, str, str, dict]]:
        """Return immediate neighbors with typed results. Absorbs the old GraphDB.neighbors interface.

        Args:
            node_id: The node to find neighbors of.
            node_type: Type of the query node ("entity" or "fact").
            edge_types: If set, restrict to these edge types.
            direction: "out", "in", or "both" (default).
            limit: Maximum neighbors to return (default 50).

        Returns:
            List of (neighbor_id, neighbor_type, edge_type, properties) tuples.
        """
        raise NotImplementedError

    @abstractmethod
    def scan_entity_edges(self) -> Iterator[tuple[str, str, str, str, str]]:
        """Bulk-scan all edges for building the in-memory adjacency index at startup.

        Returns:
            Iterator yielding (source_type, source_id, target_type, target_id, edge_type) tuples.
        """
        raise NotImplementedError

    @abstractmethod
    def get_community_summary(
        self, level: str, community_id: int, node_type: str
    ) -> dict | None:
        """Retrieve a single community summary.

        Args:
            level: Resolution level string (e.g. "L0", "L1", "L2", "L3").
            community_id: Numeric community identifier at that level.
            node_type: "entity" or "fact".

        Returns:
            Dict with summary data if found, else None.
        """
        raise NotImplementedError

    @abstractmethod
    def list_community_summaries(self, level: str, node_type: str) -> list[dict]:
        """List all community summaries at a given level and node type.

        Args:
            level: Resolution level string (e.g. "L0").
            node_type: "entity" or "fact".

        Returns:
            List of summary dicts.
        """
        raise NotImplementedError

    @abstractmethod
    def store_community_summaries(self, summaries: list[dict]) -> None:
        """Bulk upsert community summaries. Replaces existing summaries with same (level, community_id, node_type).

        Args:
            summaries: List of dicts with keys: level, community_id, node_type, summary, member_count, tags, top_members.
        """
        raise NotImplementedError

    @abstractmethod
    def get_meta(self, key: str) -> str | None:
        """Retrieve a value from the ingest_meta key-value table.

        Args:
            key: The metadata key to look up.

        Returns:
            The stored value as string, or None if not found.
        """
        raise NotImplementedError

    @abstractmethod
    def set_meta(self, key: str, value: str) -> None:
        """Insert or update a value in the ingest_meta key-value table.

        Args:
            key: The metadata key to set.
            value: The value to store (always stored as TEXT).
        """
        raise NotImplementedError

    @abstractmethod
    def existing_chunk_ids(self, ids: list[str]) -> set[str]:
        """Batch-check which chunk IDs already exist in the chunks table.

        Uses chunked IN queries to stay within the SQLite variable limit (999).

        Args:
            ids: List of chunk IDs to check for existence.

        Returns:
            Set of IDs that already exist in the chunks table.
        """
        raise NotImplementedError


def create_store(backend: str = "sqlite", **kwargs: Any) -> KnowledgeStore:
    """Factory function replacing create_graph_db(). Returns a fully initialized KnowledgeStore implementation.

    Args:
        backend: One of "sqlite" (default), "ladybug", or "falkordb".
        kwargs: Backend-specific options passed to the constructor.
        sqlite: db_path (Path), conn (sqlite3.Connection | None)
        ladybug: db_path (Path), ladybug_path (str), conn (sqlite3.Connection | None),
                 read_only (bool), buffer_pool_size (int), max_num_threads (int)
        falkordb: db_path (Path), graph_name (str), host (str), port (int)

    Returns:
        A fully initialized KnowledgeStore.
    """
    match backend:
        case "sqlite":
            from kl_graph.storage.sqlite_store import SQLiteStore

            return SQLiteStore(**kwargs)
        case "ladybug":
            from kl_graph.storage.ladybug_store import LadybugStore

            return LadybugStore(**kwargs)
        case "falkordb":
            raise NotImplementedError("FalkorDB KnowledgeStore is not yet implemented")
        case _:
            raise ValueError(
                f"Unknown backend: {backend!r}. Choose 'sqlite', 'ladybug', or 'falkordb'"
            )
