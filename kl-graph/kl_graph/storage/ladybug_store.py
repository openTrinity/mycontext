"""Hybrid KnowledgeStore: LadybugDB for edges/graph, SQLite for content/FTS.

Dual-write pattern syncs entity/fact nodes to LadybugDB for Cypher queries.
"""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Iterator
from pathlib import Path

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
from kl_graph.storage.base import KnowledgeStore
from kl_graph.storage.graph_db import PathResult
from kl_graph.storage.ladybug_graph import LadybugGraphDB
from kl_graph.storage.sqlite_store import SQLiteStore

logger = logging.getLogger(__name__)


class LadybugStore(KnowledgeStore):
    """Hybrid store: LadybugDB for edges and graph traversal, SQLite for content and FTS.

    Routing table:
    - Nodes (entities, facts, chunks): write to self._sqlite (primary).
      Additionally syncs entity/fact nodes to LadybugDB for Cypher property access.
    - Edges (insert/delete/count): delegate to self._graph (LadybugDB only).
      Edges are NOT written to SQLite — LadybugDB is the single edge authority.
    - Graph traversal (find_paths, neighbors_typed): delegate to self._graph.
    - FTS, community summaries, counts of non-edge data: delegate to self._sqlite.
    - sql_conn: returns self._sqlite.conn.
    - scan_entity_edges: delegate to self._graph (scans LadybugDB edges via Cypher).

    Edge schema in LadybugDB uses typed REL TABLE GROUPs:
    - ABOUT(FROM Fact TO Entity, confidence DOUBLE)
    - ENTITY_SIMILAR(FROM Entity TO Entity, confidence DOUBLE,
      hybrid_score DOUBLE, source STRING)
    - FACT_SIMILAR(FROM Fact TO Fact, confidence DOUBLE,
      hybrid_score DOUBLE, source STRING)
    - MENTIONS(FROM Chunk TO Entity)
    - AUTHORED_BY(FROM Chunk TO Entity)
    - STATES(FROM Fact TO Chunk)
    - TEMPORAL(FROM Chunk TO Chunk)
    - REPLY_TO(FROM Chunk TO Chunk)
    - PART_OF(FROM Chunk TO Scope)
    - COMM_MEMBER(FROM Entity TO Community, FROM Fact TO Community)
    """

    def __init__(
        self,
        db_path: Path,
        ladybug_path: str,
        conn: sqlite3.Connection | None = None,
        *,
        read_only: bool = False,
        buffer_pool_size: int = 0,
        max_num_threads: int = 0,
    ):
        """Initialize with paths for both SQLite and LadybugDB.

        Creates the internal SQLiteStore (for content/FTS) and LadybugGraphDB
        (for edges/traversal). LadybugDB is populated incrementally via
        dual-write (insert_edges, upsert_entities, insert_facts) — there is
        no bulk sync step.

        Args:
            db_path: Path to the SQLite database file.
            ladybug_path: Path to the LadybugDB database directory.
            conn: Optional pre-opened SQLite connection to inject.
            read_only: Open LadybugDB in read-only mode (for query-only paths).
            buffer_pool_size: LadybugDB buffer pool size in bytes (0 = auto).
            max_num_threads: Max threads for LadybugDB queries (0 = auto).
        """
        self._sqlite = SQLiteStore(db_path, conn=conn)
        self._graph = LadybugGraphDB(
            db_path=ladybug_path,
            read_only=read_only,
            buffer_pool_size=buffer_pool_size,
            max_num_threads=max_num_threads,
        )

    @property
    def sql_conn(self) -> sqlite3.Connection:
        """Escape hatch: returns the underlying SQLite connection."""
        return self._sqlite.conn

    def close(self) -> None:
        """Close both the SQLite and LadybugDB connections."""
        self._graph.close()
        self._sqlite.close()

    # ─── Ingest metadata (key-value store for watermarks/run counts) ──────

    def get_meta(self, key: str) -> str | None:
        """Delegate to SQLite (ingest_meta lives in SQLite only).

        Args:
            key: The metadata key to look up.

        Returns:
            The stored value as string, or None if not found.
        """
        return self._sqlite.get_meta(key)

    def set_meta(self, key: str, value: str) -> None:
        """Delegate to SQLite (ingest_meta lives in SQLite only).

        Args:
            key: The metadata key to set.
            value: The value to store.
        """
        self._sqlite.set_meta(key, value)

    def existing_chunk_ids(self, ids: list[str]) -> set[str]:
        """Delegate to SQLite (chunks live in SQLite as primary store).

        Args:
            ids: List of chunk IDs to check for existence.

        Returns:
            Set of IDs that already exist in the chunks table.
        """
        return self._sqlite.existing_chunk_ids(ids)

    # ─── Chunks ─────────────────────────────────────────────────

    def insert_chunks(self, chunks: list[Chunk]) -> None:
        """Write content to SQLite, then upsert a light ``Chunk`` node per chunk.

        The graph node carries only the trace key plus the properties a traversal
        filters on (``source_type``/``timestamp``/``source_ref``) — the ``content``
        blob and FTS stay in SQLite. The node has to exist for a chunk's
        ``PART_OF`` edge to its Scope to be insertable, since LadybugDB edge
        writes ``MATCH`` both endpoints.
        """
        self._sqlite.insert_chunks(chunks)
        for c in chunks:
            self._graph.upsert_chunk_node(
                c.id, c.source_type, c.timestamp, c.source_ref or ""
            )

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
        """Atomically commit SQLite lineage, then converge graph chunk nodes."""
        self._sqlite.insert_chunks_with_units(
            chunks,
            units,
            memberships,
            batch_id=batch_id,
            batch_source_id=batch_source_id,
            source_hash=source_hash,
        )
        for chunk in chunks:
            self._graph.upsert_chunk_node(
                chunk.id,
                chunk.source_type,
                chunk.timestamp,
                chunk.source_ref or "",
            )

    def get_ingest_batch(self, batch_id: str) -> dict | None:
        return self._sqlite.get_ingest_batch(batch_id)

    def get_ingest_batch_chunks(self, batch_id: str) -> list[Chunk]:
        return self._sqlite.get_ingest_batch_chunks(batch_id)

    def complete_ingest_batch(self, batch_id: str) -> None:
        self._sqlite.complete_ingest_batch(batch_id)

    def existing_unit_ids(
        self, source_id: str, keys: list[tuple[str, str]]
    ) -> set[tuple[str, str]]:
        return self._sqlite.existing_unit_ids(source_id, keys)

    def existing_unit_hashes(
        self, source_id: str, keys: list[tuple[str, str]]
    ) -> dict[tuple[str, str], str]:
        return self._sqlite.existing_unit_hashes(source_id, keys)

    def get_chunk(self, chunk_id: str) -> Chunk | None:
        """Delegate to SQLite."""
        return self._sqlite.get_chunk(chunk_id)

    def get_chunks_by_ids(self, chunk_ids: list[str]) -> list[Chunk]:
        """Retrieve multiple chunks by id.

        # TODO: batch — delegate to a batched SQLite path once available.

        Args:
            chunk_ids: The unique chunk identifiers to look up.

        Returns:
            List of found Chunk instances (may be shorter than the input).
        """
        results: list[Chunk] = []
        for cid in chunk_ids:
            c = self.get_chunk(cid)
            if c is not None:
                results.append(c)
        return results

    def count_chunks(self) -> int:
        """Delegate to SQLite."""
        return self._sqlite.count_chunks()

    def count_chunks_by_source(self) -> dict[str, int]:
        """Delegate to SQLite."""
        return self._sqlite.count_chunks_by_source()

    # ─── Scopes ─────────────────────────────────────────────────

    def insert_scopes(self, scopes: list[Scope]) -> None:
        """Dual-write: rows into SQLite, ``Scope`` nodes into LadybugDB.

        SQLite keeps the scope rows (incl. ``metadata``) for human review and
        backfills; LadybugDB gets the node so chunk→scope ``PART_OF`` edges are
        traversable.

        Args:
            scopes: Scope instances to store.
        """
        self._sqlite.insert_scopes(scopes)
        for s in scopes:
            self._graph.upsert_scope_node(s.id, s.scope_type, s.title)

    def get_scope(self, scope_id: str) -> Scope | None:
        """Delegate to SQLite (scope rows incl. metadata live there)."""
        return self._sqlite.get_scope(scope_id)

    # ─── Communities ───────────────────────────────

    def insert_communities(self, communities: list[Community]) -> None:
        """Dual-write: rows into SQLite, ``Community`` nodes into LadybugDB.

        SQLite keeps the full row (incl. ``tags``); LadybugDB gets the node so
        node→community ``COMM_MEMBER`` edges have a MATCH-able endpoint.

        Args:
            communities: Community instances to store.
        """
        self._sqlite.insert_communities(communities)
        for c in communities:
            self._graph.upsert_community_node(
                c.id, c.level, c.node_type, c.summary, c.member_count
            )

    def get_community(self, community_id: str) -> Community | None:
        """Delegate to SQLite (community rows incl. tags live there)."""
        return self._sqlite.get_community(community_id)

    # ─── Chat chunks (source_type == "message") ─────────────────

    def insert_messages(self, chunks: list[Chunk]) -> None:
        """Chat-named entry point onto the chunk path (content + ``Chunk`` node).

        Chat chunks are ordinary chunks, so this is :meth:`insert_chunks`; their
        edges (MENTIONS, AUTHORED_BY, …) flow through ``insert_edges`` separately.
        """
        self.insert_chunks(chunks)

    def get_message(self, msg_id: str) -> Chunk | None:
        """Delegate to SQLite (content hydration by id)."""
        return self._sqlite.get_message(msg_id)

    def get_messages_for_entity(self, entity_id: str, limit: int = 50) -> list[Chunk]:
        """Uses LadybugDB to find MENTIONS edges, then hydrates chunks from SQLite.

        Args:
            entity_id: Entity to look up.
            limit: Max chunks.

        Returns:
            Chunks mentioning this entity, ordered by timestamp desc.
        """
        # Find chunks via LadybugDB MENTIONS edges
        nbrs = self._graph.get_neighbors(
            entity_id, "entity", edge_types=["MENTIONS"], direction="in", limit=limit
        )
        # nbrs are (chunk_id, node_type, edge_type, props) — filter to chunk type
        chunk_ids = [nid for nid, ntype, _, _ in nbrs if ntype == "chunk"]
        if not chunk_ids:
            return []
        # Hydrate full chunk objects from SQLite
        chunks = []
        for cid in chunk_ids[:limit]:
            c = self._sqlite.get_chunk(cid)
            if c is not None:
                chunks.append(c)
        # Sort by timestamp descending (SQLite doesn't sort the lookups)
        chunks.sort(key=lambda c: c.timestamp, reverse=True)
        return chunks

    def count_messages(self) -> int:
        """Delegate to SQLite."""
        return self._sqlite.count_messages()

    # ─── Entities ───────────────────────────────────────────────

    def upsert_entities(self, entities: list[Entity]) -> None:
        """Dual-write: upsert to SQLite first, then sync entity nodes to LadybugDB.

        The accumulated ``description`` is carried into the in-graph Entity node
        (short by construction, so it stays a real node property like ``name``).

        Args:
            entities: Entities to upsert.
        """
        self._sqlite.upsert_entities(entities)
        for e in entities:
            self._graph.upsert_entity_node(
                e.id,
                e.name,
                e.entity_type.value,
                e.mention_count,
                e.description,
            )

    def get_entity_by_name(self, name: str) -> Entity | None:
        """Delegate to SQLite (content query, not graph traversal)."""
        return self._sqlite.get_entity_by_name(name)

    def search_entities_by_name(self, query: str, limit: int = 10) -> list[Entity]:
        """Delegate to SQLite (LIKE search on content)."""
        return self._sqlite.search_entities_by_name(query, limit)

    def search_entities(self, query: str, limit: int = 10) -> list[Entity]:
        """Delegate to SQLite (FTS5 keyword search over name + description)."""
        return self._sqlite.search_entities(query, limit)

    def count_entities(self) -> int:
        """Delegate to SQLite (authoritative node count)."""
        return self._sqlite.count_entities()

    def iter_all_entities(self):
        """Delegate to SQLite (entities live in SQLite as primary store)."""
        return self._sqlite.iter_all_entities()

    # ─── Facts ──────────────────────────────────────────────────

    def insert_facts(self, facts: list[Fact]) -> None:
        """Dual-write: insert into SQLite first, then sync fact nodes to LadybugDB.

        Args:
            facts: Facts to insert.
        """
        self._sqlite.insert_facts(facts)
        for f in facts:
            self._graph.upsert_fact_node(
                f.id, f.text, f.fact_type.value, f.confidence, f.timestamp
            )

    def get_fact(self, fact_id: str) -> Fact | None:
        """Delegate to SQLite."""
        return self._sqlite.get_fact(fact_id)

    def get_facts_for_entity(self, entity_id: str, limit: int = 20) -> list[Fact]:
        """Uses LadybugDB to find ABOUT edges, then fetches facts from SQLite.

        Args:
            entity_id: Entity to look up.
            limit: Max facts.

        Returns:
            Facts related to this entity, ordered by timestamp desc.
        """
        nbrs = self._graph.get_neighbors(
            entity_id,
            "entity",
            edge_types=["ABOUT"],
            direction="in",
            limit=limit,
        )
        fact_ids = [nid for nid, ntype, _, _ in nbrs if ntype == "fact"]
        if not fact_ids:
            return []
        facts = []
        for fid in fact_ids[:limit]:
            f = self._sqlite.get_fact(fid)
            if f is not None:
                facts.append(f)
        facts.sort(key=lambda f: f.timestamp, reverse=True)
        return facts

    def count_facts(self) -> int:
        """Delegate to SQLite."""
        return self._sqlite.count_facts()

    def iter_all_facts(self):
        """Delegate to SQLite (facts live in SQLite as primary store)."""
        return self._sqlite.iter_all_facts()

    # ─── Edges ──────────────────────────────────────────────────

    def insert_edges(self, edges: list[Edge]) -> None:
        """Write edges to LadybugDB only (NOT to SQLite). LadybugDB is the single edge authority.

        Args:
            edges: Edge instances to store.
        """
        for e in edges:
            self._graph.insert_edges(
                source_type=e.source_type,
                source_id=e.source_id,
                target_type=e.target_type,
                target_id=e.target_id,
                edge_type=e.edge_type.value,
                properties=e.properties,
            )

    def delete_edges(
        self,
        *,
        source_id: str | None = None,
        target_id: str | None = None,
        edge_type: str | None = None,
        where_properties: dict | None = None,
    ) -> int:
        """Delete edges from LadybugDB matching filters.

        Args:
            source_id: Filter by source node id.
            target_id: Filter by target node id.
            edge_type: Filter by relationship type.
            where_properties: Filter on relationship properties (not supported in Cypher path; ignored).

        Returns:
            Number of edges deleted (0 — LadybugDB doesn't expose rowcount).
        """
        if (
            source_id is None
            and target_id is None
            and edge_type is None
            and where_properties is None
        ):
            raise ValueError("At least one filter must be specified for delete_edges()")
        return self._graph.delete_edges(
            source_id=source_id,
            target_id=target_id,
            edge_type=edge_type,
            where_properties=where_properties,
        )

    def get_neighbors(
        self,
        node_type: str,
        node_id: str,
        edge_type: str | None = None,
        direction: str = "both",
    ) -> list[dict]:
        """Query LadybugDB for neighbors, format as edge dicts for compatibility.

        Args:
            node_type: Type of the query node.
            node_id: ID of the query node.
            edge_type: Optional type filter.
            direction: "out", "in", or "both".

        Returns:
            List of edge dicts.
        """
        edge_types = [edge_type] if edge_type else None
        nbrs = self._graph.get_neighbors(
            node_id, node_type, edge_types=edge_types, direction=direction
        )
        # Reformat 4-tuples into dict schema matching SQLiteStore.get_neighbors
        results = []
        for nbr_id, nbr_type, etype, props in nbrs:
            results.append(
                {
                    "source_type": node_type,
                    "source_id": node_id,
                    "target_type": nbr_type,
                    "target_id": nbr_id,
                    "edge_type": etype,
                    "properties": props,
                }
            )
        return results

    def count_edges(self) -> int:
        """Count edges in LadybugDB."""
        return self._graph.count_edges()

    def scan_edges_by_type(
        self,
        edge_types: list[str],
        *,
        source_type: str | None = None,
        target_type: str | None = None,
    ) -> Iterator[tuple[str, str, dict]]:
        """Stream ``(source_id, target_id, properties)`` from LadybugDB edges.

        Delegates to the graph's typed scan so the periodic stages read edges
        from LadybugDB (the edge authority here) instead of the empty SQLite
        ``edges`` table. See the ABC for the contract.
        """
        yield from self._graph.scan_edges_typed(
            edge_types, source_type=source_type, target_type=target_type
        )

    def scan_edges_for_nodes(
        self,
        edge_types: list[str],
        node_ids: set[str],
        *,
        source_type: str | None = None,
        target_type: str | None = None,
    ) -> Iterator[tuple[str, str, dict]]:
        """Stream ``(source_id, target_id, properties)`` from LadybugDB edges touching ``node_ids``.

        Delegates to the graph's indexed per-endpoint lookups. See the ABC for
        the contract and :meth:`LadybugGraphDB.scan_edges_for_nodes` for the
        equality-query implementation.
        """
        yield from self._graph.scan_edges_for_nodes(
            edge_types, node_ids, source_type=source_type, target_type=target_type
        )

    def count_edges_by_type(self) -> dict[str, int]:
        """Count edges grouped by type in LadybugDB."""
        return self._graph.count_edges_by_type()

    # ─── Graph traversal ────────────────────────────────────────

    def find_paths(
        self,
        source_id: str,
        target_id: str,
        *,
        max_hops: int = 4,
        all_shortest: bool = False,
        edge_types: list[str] | None = None,
    ) -> PathResult:
        """Delegate to LadybugGraphDB's Cypher TRAIL path finding."""
        return self._graph.find_paths(
            source_id,
            target_id,
            max_hops=max_hops,
            all_shortest=all_shortest,
            edge_types=edge_types,
        )

    def neighbors_typed(
        self,
        node_id: str,
        node_type: str,
        *,
        edge_types: list[str] | None = None,
        direction: str = "both",
        limit: int = 50,
    ) -> list[tuple[str, str, str, dict]]:
        """Delegate to LadybugGraphDB.get_neighbors()."""
        return self._graph.get_neighbors(
            node_id, node_type, edge_types=edge_types, direction=direction, limit=limit
        )

    # ─── Adjacency scan ─────────────────────────────────────────

    def scan_entity_edges(self) -> Iterator[tuple[str, str, str, str, str]]:
        """Scan all edges from LadybugDB for adjacency index build.

        Returns:
            Iterator of edge tuples.
        """
        yield from self._graph.scan_edges()

    # ─── Community summaries ─────────────────────────────────────

    def get_community_summary(self, level: int, community_id: int) -> dict | None:
        """Delegate to SQLite (community data lives in SQLite only)."""
        return self._sqlite.get_community_summary(level, community_id)

    def list_community_summaries(self, level: int) -> list[dict]:
        """Delegate to SQLite."""
        return self._sqlite.list_community_summaries(level)

    def store_community_summaries(self, summaries: list[dict]) -> None:
        """Delegate to SQLite."""
        self._sqlite.store_community_summaries(summaries)
