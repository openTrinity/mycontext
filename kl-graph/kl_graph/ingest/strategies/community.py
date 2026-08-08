"""Default incremental community strategy — Dynamic Frontier Leiden for assigning
communities to new nodes using existing assignments as initial membership.

Based on Lin et al. 2026 (arXiv:2601.08554): run Leiden with initial_membership
on a frontier subgraph (new nodes + 1-hop neighbors) to minimize perturbation
of stable assignments.
"""

from __future__ import annotations

import logging
from collections import Counter, defaultdict
from collections.abc import Iterable
from typing import TYPE_CHECKING

from kl_graph.models.types import community_id_from
from kl_graph.storage.base import KnowledgeStore

if TYPE_CHECKING:
    import igraph as ig

    from kl_graph.ingest.structural_cache import StructuralCache

logger = logging.getLogger(__name__)

# Leiden iterations for incremental run (fewer than full rebuild for speed).
_N_ITERATIONS = 3
_SQL_IN_BATCH = 500
_COMMUNITY_NEXT_ID_META_PREFIX = "community.next_id"

CommunityKey = tuple[str, str, int]


class CommunityChanges(set[str]):
    """Changed community UUIDs plus their reversible assignment identities."""

    def __init__(self) -> None:
        super().__init__()
        self.community_keys: set[CommunityKey] = set()

    def record(self, node_type: str, level: str, cluster_id: int) -> None:
        key = (node_type, level, cluster_id)
        self.community_keys.add(key)
        self.add(community_id_from(*key))

    def merge(self, other: CommunityChanges) -> None:
        self.update(other)
        self.community_keys.update(other.community_keys)


class DynamicFrontierLeiden:
    """Incremental community assignment using frontier-based Leiden with initial membership.

    Uses same RESOLUTIONS as full rebuild: L0=0.3, L1=1.0, L2=3.0, L3=10.0
    Requires leidenalg >= 0.9 for initial_membership support
    Entity graph construction mirrors community_detection.py:
        ENTITY_SIMILAR edges (weight=hybrid_score) + co-mention edges
        (entities sharing >= 2 chunks, weight=min(count/10, 1.0))
    Fact graph construction mirrors community_detection.py:
        FACT_SIMILAR edges (weight=score) + shared-entity projection
        (facts sharing entity via ABOUT, skip entities with >200 facts)
    """

    def assign_communities(
        self,
        store: KnowledgeStore,
        new_entity_ids: list[str],
        new_fact_ids: list[str],
        *,
        entity_resolutions: dict[str, float],
        fact_resolutions: dict[str, float],
        structural_cache: StructuralCache | None = None,
    ) -> set[str]:
        """Assign community memberships incrementally using frontier Leiden.

        Internal algorithm per (node_type, level):
        1. Discover similarity and structural-projection neighbors of the
           affected node IDs.
        2. Query all similarity edges induced by that complete one-hop frontier.
        3. Build a small igraph from the induced similarity, co-mention, and
           shared-entity edges without loading the whole graph.
        4. Load existing community_L{level} assignments for frontier nodes
           only (WHERE id IN (...) — O(K) via primary-key index).
        5. Run leidenalg.find_partition(graph, RBConfigurationVertexPartition,
           weights="weight", resolution_parameter=resolution, n_iterations=3,
           initial_membership=membership).
        6. Diff: find nodes whose partition assignment differs from initial.
        7. UPDATE entities/facts SET community_L{level} = ? WHERE id = ? for changed.
        8. Compute community UUIDs for changed communities using community_id_from().

        Args:
            store: KnowledgeStore with sql_conn for reading graph and updating columns.
            new_entity_ids: Entity IDs from this incremental run.
            new_fact_ids: Fact IDs from this incremental run.
            entity_resolutions: Dict mapping level name to resolution parameter for entities.
            fact_resolutions: Dict mapping level name to resolution parameter for facts.
            structural_cache: Optional StructuralCache that avoids graph-wide
                structural scans; work remains proportional to incident sets.

        Returns:
            Set of community UUIDs whose membership changed.
        """
        changed_communities = CommunityChanges()

        if new_entity_ids:
            changed_communities.merge(
                self._process_node_type(
                    store, "entity", new_entity_ids, entity_resolutions,
                    structural_cache=structural_cache,
                )
            )

        if new_fact_ids:
            changed_communities.merge(
                self._process_node_type(
                    store, "fact", new_fact_ids, fact_resolutions,
                    structural_cache=structural_cache,
                )
            )

        return changed_communities

    # ── Private helpers ──────────────────────────────────────────────────────

    def _process_node_type(
        self,
        store: KnowledgeStore,
        node_type: str,
        new_ids: list[str],
        resolutions: dict[str, float],
        *,
        structural_cache: StructuralCache | None = None,
    ) -> CommunityChanges:
        """Run frontier Leiden for one node type across all levels.

        Builds an induced one-hop igraph (affected IDs plus similarity and
        structural neighbors) instead of loading all graph nodes and edges.
        This eliminates recurring O(V+E) full-graph construction; legacy
        assignment indexes are built once on first use.

        Args:
            store: KnowledgeStore for graph reads and community column updates.
            node_type: "entity" or "fact".
            new_ids: IDs of newly ingested nodes.
            resolutions: Level-to-resolution parameter mapping.
            structural_cache: Optional StructuralCache for degree-scoped
                structural edge computation among frontier nodes.

        Returns:
            Set of changed community UUIDs across all levels.
        """
        import leidenalg

        changed = CommunityChanges()
        table = "entities" if node_type == "entity" else "facts"
        conn = store.sql_conn

        seed_ids = self._existing_node_ids(conn, table, set(new_ids))
        if not seed_ids:
            return changed

        # 1. Discover similarity neighbors of the affected IDs.
        sim_edge_type = "ENTITY_SIMILAR" if node_type == "entity" else "FACT_SIMILAR"
        seed_sim_edges = list(
            store.scan_edges_for_nodes(
                [sim_edge_type],
                seed_ids,
                source_type=node_type,
                target_type=node_type,
            )
        )

        # 2. Add structural-projection neighbors to complete the one-hop set.
        frontier_set = set(seed_ids)
        for src, tgt, _ in seed_sim_edges:
            frontier_set.add(src)
            frontier_set.add(tgt)
        frontier_set.update(
            self._structural_neighbors(
                store, node_type, seed_ids, structural_cache=structural_cache
            )
        )
        frontier_set = self._existing_node_ids(conn, table, frontier_set)

        # Fetch every similarity edge induced by the completed frontier. The
        # seed query alone omits edges between two discovered neighbors.
        sim_edges = self._dedupe_edges(
            edge
            for edge in store.scan_edges_for_nodes(
                [sim_edge_type],
                frontier_set,
                source_type=node_type,
                target_type=node_type,
            )
            if edge[0] in frontier_set and edge[1] in frontier_set
        )

        # 3. Build the graph induced by the complete frontier.
        frontier_list = sorted(frontier_set)
        id_to_idx: dict[str, int] = {
            nid: i for i, nid in enumerate(frontier_list)
        }

        edge_list, weights = self._build_frontier_edges(
            store,
            node_type,
            frontier_list,
            id_to_idx,
            sim_edges,
            structural_cache,
        )

        if not edge_list:
            return changed

        import igraph as ig

        g = ig.Graph(n=len(frontier_list))
        g.add_edges(edge_list)
        g.es["weight"] = weights
        g.simplify(combine_edges={"weight": "max"})

        # 4. For each level: load assignments for frontier only, run Leiden
        for level, resolution in resolutions.items():
            col = f"community_{level}"

            # Check if column exists
            cols = {
                r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
            }
            if col not in cols:
                logger.debug(
                    "Column %s not found on %s, skipping level %s",
                    col,
                    table,
                    level,
                )
                continue

            self._ensure_community_index(conn, table, col)
            existing_assignment = self._load_assignments(
                conn, table, col, frontier_list
            )

            # ``leidenalg`` requires dense integer membership labels. Persisted
            # community IDs can be sparse, so map them to dense labels and give
            # every unassigned node a temporary singleton cluster.
            persisted_ids = sorted(set(existing_assignment.values()))
            dense_for_persisted = {
                community_id: dense
                for dense, community_id in enumerate(persisted_ids)
            }
            next_cluster = len(dense_for_persisted)
            initial_membership: list[int] = []
            for node_id in frontier_list:
                persisted = existing_assignment.get(node_id)
                if persisted is None:
                    dense_membership = next_cluster
                    next_cluster += 1
                else:
                    dense_membership = dense_for_persisted[persisted]
                initial_membership.append(dense_membership)

            try:
                partition = leidenalg.find_partition(
                    g,
                    leidenalg.RBConfigurationVertexPartition,
                    weights="weight",
                    resolution_parameter=resolution,
                    n_iterations=_N_ITERATIONS,
                    initial_membership=initial_membership,
                )
            except Exception:
                logger.exception(
                    "Leiden failed for node_type=%s level=%s, skipping",
                    node_type,
                    level,
                )
                continue

            # Map dense output labels onto globally unique persisted IDs. An
            # existing ID may be inherited by only one output cluster.
            dense_members: dict[int, list[int]] = defaultdict(list)
            for idx, dense_id in enumerate(partition.membership):
                dense_members[dense_id].append(idx)

            candidate_links: list[tuple[int, int, int]] = []
            for dense_id, indices in dense_members.items():
                candidates = Counter(
                    existing_assignment[frontier_list[idx]]
                    for idx in indices
                    if frontier_list[idx] in existing_assignment
                )
                candidate_links.extend(
                    (-count, community_id, dense_id)
                    for community_id, count in candidates.items()
                )

            persisted_for_dense: dict[int, int] = {}
            claimed_ids: set[int] = set()
            for _negative_count, community_id, dense_id in sorted(candidate_links):
                if dense_id in persisted_for_dense or community_id in claimed_ids:
                    continue
                persisted_for_dense[dense_id] = community_id
                claimed_ids.add(community_id)

            new_dense_ids = sorted(set(dense_members) - set(persisted_for_dense))
            first_reserved = self._reserve_community_ids(
                store,
                conn,
                table,
                col,
                node_type,
                level,
                len(new_dense_ids),
            )
            for offset, dense_id in enumerate(new_dense_ids):
                persisted_for_dense[dense_id] = first_reserved + offset

            new_assignment = [
                persisted_for_dense[dense_id]
                for dense_id in partition.membership
            ]
            changed_updates: list[tuple[int, str]] = []

            for idx, node_id in enumerate(frontier_list):
                old_cid = existing_assignment.get(node_id, -1)
                new_cid = new_assignment[idx]

                if old_cid != new_cid:
                    changed_updates.append((new_cid, node_id))
                    # Record both old and new community as changed
                    if old_cid >= 0:
                        changed.record(node_type, level, old_cid)
                    changed.record(node_type, level, new_cid)

            if changed_updates:
                conn.executemany(
                    f"UPDATE {table} SET {col} = ? WHERE id = ?",
                    changed_updates,
                )
                conn.commit()
                logger.debug(
                    "Updated %d %s community_%s assignments",
                    len(changed_updates),
                    node_type,
                    level,
                )

        return changed

    # ── Frontier-only edge construction ────────────────────────────────────

    @staticmethod
    def _existing_node_ids(conn, table: str, node_ids: set[str]) -> set[str]:
        """Return only requested IDs that exist, using bounded SQL batches."""

        found: set[str] = set()
        ordered = sorted(node_ids)
        for start in range(0, len(ordered), _SQL_IN_BATCH):
            batch = ordered[start : start + _SQL_IN_BATCH]
            placeholders = ",".join("?" for _ in batch)
            rows = conn.execute(
                f"SELECT id FROM {table} WHERE id IN ({placeholders})", batch
            ).fetchall()
            found.update(str(row[0]) for row in rows)
        return found

    @staticmethod
    def _load_assignments(
        conn, table: str, column: str, node_ids: list[str]
    ) -> dict[str, int]:
        """Load frontier assignments without exceeding SQLite bind limits."""

        assignments: dict[str, int] = {}
        for start in range(0, len(node_ids), _SQL_IN_BATCH):
            batch = node_ids[start : start + _SQL_IN_BATCH]
            placeholders = ",".join("?" for _ in batch)
            rows = conn.execute(
                f"SELECT id, {column} FROM {table} WHERE id IN ({placeholders})",
                batch,
            ).fetchall()
            assignments.update(
                (str(node_id), int(cluster_id))
                for node_id, cluster_id in rows
                if cluster_id is not None
            )
        return assignments

    @staticmethod
    def _ensure_community_index(conn, table: str, column: str) -> None:
        """Create the assignment index needed by scoped projection and MAX."""

        conn.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{table}_{column} ON {table}({column})"
        )
        conn.commit()

    @staticmethod
    def _reserve_community_ids(
        store: KnowledgeStore,
        conn,
        table: str,
        column: str,
        node_type: str,
        level: str,
        count: int,
    ) -> int:
        """Reserve globally unused IDs before writing any new assignments."""

        if count <= 0:
            return 0
        meta_key = f"{_COMMUNITY_NEXT_ID_META_PREFIX}.{node_type}.{level}"
        raw_next = store.get_meta(meta_key)
        try:
            next_id = int(raw_next) if raw_next is not None else -1
        except (TypeError, ValueError):
            next_id = -1
        if next_id < 0:
            row = conn.execute(f"SELECT MAX({column}) FROM {table}").fetchone()
            next_id = int(row[0]) + 1 if row and row[0] is not None else 0

        # Reserve first. A crash can leave a harmless gap but cannot cause a
        # retry to reuse an ID that may already have been committed.
        store.set_meta(meta_key, str(next_id + count))
        return next_id

    @staticmethod
    def _dedupe_edges(
        edges: Iterable[tuple[str, str, dict]],
    ) -> list[tuple[str, str, dict]]:
        """Remove duplicates produced when both endpoints match query batches."""

        unique: list[tuple[str, str, dict]] = []
        seen: set[tuple[str, str]] = set()
        for src, tgt, props in edges:
            key = (src, tgt)
            if key in seen:
                continue
            seen.add(key)
            unique.append((src, tgt, props))
        return unique

    def _structural_neighbors(
        self,
        store: KnowledgeStore,
        node_type: str,
        seed_ids: set[str],
        *,
        structural_cache: StructuralCache | None,
    ) -> set[str]:
        """Return structural-projection neighbors of the affected seed nodes."""

        if node_type == "entity":
            entity_chunks: dict[str, set[str]] = defaultdict(set)
            chunk_entities: dict[str, set[str]] = defaultdict(set)
            if structural_cache is not None:
                for entity_id in seed_ids:
                    entity_chunks[entity_id].update(
                        structural_cache.entity_to_chunks.get(entity_id, set())
                    )
                relevant_chunks = (
                    set().union(*entity_chunks.values()) if entity_chunks else set()
                )
                for chunk_id in relevant_chunks:
                    chunk_entities[chunk_id].update(
                        structural_cache.chunk_to_entities.get(chunk_id, set())
                    )
            else:
                for chunk_id, entity_id, _props in store.scan_edges_for_nodes(
                    ["MENTIONS", "AUTHORED_BY"],
                    seed_ids,
                    source_type="chunk",
                    target_type="entity",
                ):
                    if entity_id in seed_ids:
                        entity_chunks[entity_id].add(chunk_id)
                relevant_chunks = (
                    set().union(*entity_chunks.values()) if entity_chunks else set()
                )
                for chunk_id, entity_id, _props in store.scan_edges_for_nodes(
                    ["MENTIONS", "AUTHORED_BY"],
                    relevant_chunks,
                    source_type="chunk",
                    target_type="entity",
                ):
                    if chunk_id in relevant_chunks:
                        chunk_entities[chunk_id].add(entity_id)

            neighbors: set[str] = set()
            for entity_id, chunk_ids in entity_chunks.items():
                counts: Counter[str] = Counter()
                for chunk_id in chunk_ids:
                    counts.update(chunk_entities.get(chunk_id, set()))
                neighbors.update(
                    other_id
                    for other_id, shared_count in counts.items()
                    if other_id != entity_id and shared_count >= 2
                )
            return neighbors

        fact_entities: dict[str, set[str]] = defaultdict(set)
        entity_facts: dict[str, set[str]] = defaultdict(set)
        if structural_cache is not None:
            for fact_id in seed_ids:
                fact_entities[fact_id].update(
                    structural_cache.fact_to_entities.get(fact_id, set())
                )
            relevant_entities = (
                set().union(*fact_entities.values()) if fact_entities else set()
            )
            for entity_id in relevant_entities:
                entity_facts[entity_id].update(
                    structural_cache.entity_to_facts.get(entity_id, set())
                )
        else:
            for fact_id, entity_id, _props in store.scan_edges_for_nodes(
                ["ABOUT"],
                seed_ids,
                source_type="fact",
                target_type="entity",
            ):
                if fact_id in seed_ids:
                    fact_entities[fact_id].add(entity_id)
            relevant_entities = (
                set().union(*fact_entities.values()) if fact_entities else set()
            )
            for fact_id, entity_id, _props in store.scan_edges_for_nodes(
                ["ABOUT"],
                relevant_entities,
                source_type="fact",
                target_type="entity",
            ):
                if entity_id in relevant_entities:
                    entity_facts[entity_id].add(fact_id)

        neighbors: set[str] = set()
        for fact_id, entity_ids in fact_entities.items():
            for entity_id in entity_ids:
                facts = entity_facts.get(entity_id, set())
                if len(facts) <= 200:
                    neighbors.update(facts - {fact_id})
        return neighbors

    def _build_frontier_edges(
        self,
        store: KnowledgeStore,
        node_type: str,
        frontier_ids: list[str],
        id_to_idx: dict[str, int],
        sim_edges: list[tuple[str, str, dict]],
        structural_cache: StructuralCache | None = None,
    ) -> tuple[list[tuple[int, int]], list[float]]:
        """Build edge list and weights for the frontier-only igraph.

        Replaces the old ``_build_graph`` full-graph construction: instead of
        loading all edges and extracting an induced subgraph, this method
        builds edges only among frontier nodes.

        Args:
            store: Backend-agnostic graph store.
            node_type: "entity" or "fact".
            frontier_ids: Sorted list of frontier node IDs.
            id_to_idx: Mapping from frontier node ID to igraph vertex index.
            sim_edges: Pre-queried similarity edges touching the frontier.
            structural_cache: Optional cache for degree-scoped structural work.

        Returns:
            ``(edge_list, weights)`` — may be empty.
        """
        edge_list: list[tuple[int, int]] = []
        weights: list[float] = []

        # Add similarity edges
        weight_key = "hybrid_score" if node_type == "entity" else "score"
        for src, tgt, props in sim_edges:
            si, ti = id_to_idx.get(src), id_to_idx.get(tgt)
            if si is not None and ti is not None:
                edge_list.append((si, ti))
                weights.append(float(props.get(weight_key, 0.5)))

        # Add co-mention (entity) or shared-entity (fact) edges
        if node_type == "entity":
            self._add_frontier_comention(
                store, frontier_ids, id_to_idx, edge_list, weights, structural_cache
            )
        else:
            self._add_frontier_shared_entity(
                store, frontier_ids, id_to_idx, edge_list, weights, structural_cache
            )

        return edge_list, weights

    def _add_frontier_comention(
        self,
        store: KnowledgeStore,
        frontier_ids: list[str],
        id_to_idx: dict[str, int],
        edge_list: list[tuple[int, int]],
        weights: list[float],
        structural_cache: StructuralCache | None = None,
    ) -> None:
        """Add co-mention edges among frontier entities (>= 2 shared chunks).

        If ``structural_cache`` is provided, uses the in-memory entity↔chunk
        mappings for incident-set computation. Otherwise falls back to
        ``scan_edges_for_nodes`` which loads only MENTIONS/AUTHORED_BY edges
        touching frontier entities through indexed endpoint lookups.
        """
        frontier_set = set(frontier_ids)
        chunk_entities: dict[str, set[str]] = defaultdict(set)

        if structural_cache is not None:
            # Walk each frontier entity's incident chunks and collect
            # frontier co-mentioners from the cache.
            for eid in frontier_ids:
                chunks = structural_cache.entity_to_chunks.get(eid, set())
                for cid in chunks:
                    for other_eid in structural_cache.chunk_to_entities.get(
                        cid, set()
                    ):
                        if other_eid in frontier_set:
                            chunk_entities[cid].add(other_eid)
        else:
            # O(frontier): scan only MENTIONS/AUTHORED_BY edges touching
            # frontier entities.
            for chunk_id, entity_id, _props in store.scan_edges_for_nodes(
                ["MENTIONS", "AUTHORED_BY"],
                frontier_set,
                source_type="chunk",
                target_type="entity",
            ):
                if entity_id in frontier_set:
                    chunk_entities[chunk_id].add(entity_id)

        comention_counts: dict[tuple[str, str], int] = defaultdict(int)
        for entities in chunk_entities.values():
            ent_list = sorted(entities)
            for i in range(len(ent_list)):
                for j in range(i + 1, len(ent_list)):
                    comention_counts[(ent_list[i], ent_list[j])] += 1

        for (eid_a, eid_b), count in comention_counts.items():
            if count >= 2:
                idx_a = id_to_idx.get(eid_a)
                idx_b = id_to_idx.get(eid_b)
                if idx_a is not None and idx_b is not None:
                    edge_list.append((idx_a, idx_b))
                    weights.append(min(count / 10.0, 1.0))

    def _add_frontier_shared_entity(
        self,
        store: KnowledgeStore,
        frontier_ids: list[str],
        id_to_idx: dict[str, int],
        edge_list: list[tuple[int, int]],
        weights: list[float],
        structural_cache: StructuralCache | None = None,
    ) -> None:
        """Add shared-entity projection edges among frontier facts.

        If ``structural_cache`` is provided, uses the in-memory fact↔entity
        mappings for incident-set computation, including the >200-facts hub skip.
        Otherwise falls back to ``scan_edges_for_nodes`` which loads only
        ABOUT edges touching frontier facts.
        """
        frontier_set = set(frontier_ids)
        entity_to_facts: dict[str, list[str]] = {}
        max_facts_per_entity = 200

        if structural_cache is not None:
            # Walk each frontier fact's entities and build the
            # entity→frontier-facts map, applying the hub-entity skip using
            # the cache's total fact count per entity.
            for fid in frontier_ids:
                entities = structural_cache.fact_to_entities.get(fid, set())
                for eid in entities:
                    all_facts = structural_cache.entity_to_facts.get(eid, set())
                    if len(all_facts) > max_facts_per_entity:
                        continue
                    entity_to_facts.setdefault(eid, []).append(fid)
        else:
            # First find the entities attached to frontier facts, then query all
            # facts attached to only those entities. This preserves the full
            # projection's >200-fact hub rule without a graph-wide scan.
            relevant_entities: set[str] = set()
            for fact_id, entity_id, _props in store.scan_edges_for_nodes(
                ["ABOUT"],
                frontier_set,
                source_type="fact",
                target_type="entity",
            ):
                if fact_id in frontier_set:
                    relevant_entities.add(entity_id)
            for fact_id, entity_id, _props in store.scan_edges_for_nodes(
                ["ABOUT"],
                relevant_entities,
                source_type="fact",
                target_type="entity",
            ):
                if entity_id in relevant_entities:
                    entity_to_facts.setdefault(entity_id, []).append(fact_id)

        projection_counts: dict[tuple[str, str], int] = defaultdict(int)
        for facts in entity_to_facts.values():
            if len(facts) > max_facts_per_entity:
                continue
            fact_list = sorted(set(f for f in facts if f in frontier_set))
            for i in range(len(fact_list)):
                for j in range(i + 1, len(fact_list)):
                    pair = tuple(sorted([fact_list[i], fact_list[j]]))  # type: ignore[index]
                    projection_counts[pair] += 1

        for (fid_a, fid_b), shared_count in projection_counts.items():
            w = min(0.2 + 0.1 * (shared_count - 1), 0.8)
            idx_a = id_to_idx.get(fid_a)
            idx_b = id_to_idx.get(fid_b)
            if idx_a is not None and idx_b is not None:
                edge_list.append((idx_a, idx_b))
                weights.append(w)

    # ── Legacy full-graph construction (backward compat) ────────────────────

    def _build_graph(
        self,
        store: KnowledgeStore,
        node_type: str,
        all_node_ids: list[str],
        id_to_idx: dict[str, int],
    ) -> ig.Graph | None:
        """Build an igraph Graph for entity or fact nodes.

        Uses ENTITY_SIMILAR + co-mention edges for entities, or
        FACT_SIMILAR + shared-entity projection for facts.

        Args:
            store: Backend-agnostic graph store.
            node_type: "entity" or "fact".
            all_node_ids: All IDs in order.
            id_to_idx: Mapping from node ID to igraph vertex index.

        Returns:
            igraph.Graph or None if no edges found.
        """
        import igraph as ig

        edge_list: list[tuple[int, int]] = []
        weights: list[float] = []

        if node_type == "entity":
            # ENTITY_SIMILAR edges
            for source_id, target_id, props in store.scan_edges_by_type(
                ["ENTITY_SIMILAR"], source_type="entity", target_type="entity"
            ):
                src_idx = id_to_idx.get(source_id)
                tgt_idx = id_to_idx.get(target_id)
                if src_idx is not None and tgt_idx is not None:
                    edge_list.append((src_idx, tgt_idx))
                    weights.append(float(props.get("hybrid_score", 0.5)))

            # Co-mention edges (entities in same chunk, at least 2 shared)
            entity_chunks: dict[str, set[str]] = {}
            for chunk_id, entity_id, _props in store.scan_edges_by_type(
                ["MENTIONS", "AUTHORED_BY"],
                source_type="chunk",
                target_type="entity",
            ):
                entity_chunks.setdefault(entity_id, set()).add(chunk_id)

            chunk_entities: dict[str, set[str]] = defaultdict(set)
            for eid, chunks in entity_chunks.items():
                for cid in chunks:
                    chunk_entities[cid].add(eid)

            comention_counts: dict[tuple[str, str], int] = defaultdict(int)
            for entities in chunk_entities.values():
                ent_list = sorted(entities)
                for i in range(len(ent_list)):
                    for j in range(i + 1, len(ent_list)):
                        comention_counts[(ent_list[i], ent_list[j])] += 1

            for (eid_a, eid_b), count in comention_counts.items():
                if count >= 2:
                    idx_a = id_to_idx.get(eid_a)
                    idx_b = id_to_idx.get(eid_b)
                    if idx_a is not None and idx_b is not None:
                        edge_list.append((idx_a, idx_b))
                        weights.append(min(count / 10.0, 1.0))

        else:  # "fact"
            # FACT_SIMILAR edges
            for source_id, target_id, props in store.scan_edges_by_type(
                ["FACT_SIMILAR"], source_type="fact", target_type="fact"
            ):
                src_idx = id_to_idx.get(source_id)
                tgt_idx = id_to_idx.get(target_id)
                if src_idx is not None and tgt_idx is not None:
                    edge_list.append((src_idx, tgt_idx))
                    weights.append(float(props.get("score", 0.5)))

            # Shared-entity projection
            entity_to_facts: dict[str, list[str]] = {}
            for fact_id, entity_id, _props in store.scan_edges_by_type(
                ["ABOUT"], source_type="fact", target_type="entity"
            ):
                entity_to_facts.setdefault(entity_id, []).append(fact_id)

            max_facts_per_entity = 200
            projection_counts: dict[tuple[str, str], int] = defaultdict(int)
            for facts in entity_to_facts.values():
                if len(facts) > max_facts_per_entity:
                    continue
                fact_list = [f for f in facts if f in id_to_idx]
                for i in range(len(fact_list)):
                    for j in range(i + 1, len(fact_list)):
                        pair = tuple(sorted([fact_list[i], fact_list[j]]))
                        projection_counts[pair] += 1  # type: ignore[index]

            for (fid_a, fid_b), shared_count in projection_counts.items():
                w = min(0.2 + 0.1 * (shared_count - 1), 0.8)
                idx_a = id_to_idx.get(fid_a)
                idx_b = id_to_idx.get(fid_b)
                if idx_a is not None and idx_b is not None:
                    edge_list.append((idx_a, idx_b))
                    weights.append(w)

        if not edge_list:
            return None

        g = ig.Graph(n=len(all_node_ids))
        g.add_edges(edge_list)
        g.es["weight"] = weights
        g.simplify(combine_edges={"weight": "max"})

        return g
