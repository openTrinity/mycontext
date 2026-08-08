"""Default incremental community strategy — Dynamic Frontier Leiden for assigning
communities to new nodes using existing assignments as initial membership.

Based on Lin et al. 2026 (arXiv:2601.08554): run Leiden with initial_membership
on a frontier subgraph (new nodes + 1-hop neighbors) to minimize perturbation
of stable assignments.
"""

from __future__ import annotations

import logging
from collections import Counter, defaultdict
from typing import TYPE_CHECKING

from kl_graph.models.types import community_id_from
from kl_graph.storage.base import KnowledgeStore

if TYPE_CHECKING:
    import igraph as ig

logger = logging.getLogger(__name__)

# Leiden iterations for incremental run (fewer than full rebuild for speed).
_N_ITERATIONS = 3


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
    ) -> set[str]:
        """Assign community memberships incrementally using frontier Leiden.

        Internal algorithm per (node_type, level):
        1. Build igraph from edges table (ENTITY_SIMILAR or FACT_SIMILAR + structural).
        2. Load existing community_L{level} column as initial_membership list.
           New nodes (no assignment) get -1 meaning "free to place".
        3. Compute frontier: new node vertex indices + their 1-hop igraph neighbors.
        4. Run leidenalg.find_partition(graph, RBConfigurationVertexPartition,
           weights="weight", resolution_parameter=resolution, n_iterations=3,
           initial_membership=membership).
        5. Diff: find nodes whose partition assignment differs from initial_membership.
        6. UPDATE entities/facts SET community_L{level} = ? WHERE id = ? for changed.
        7. Compute community UUIDs for changed communities using community_id_from().

        Args:
            store: KnowledgeStore with sql_conn for reading graph and updating columns.
            new_entity_ids: Entity IDs from this incremental run.
            new_fact_ids: Fact IDs from this incremental run.
            entity_resolutions: Dict mapping level name to resolution parameter for entities.
            fact_resolutions: Dict mapping level name to resolution parameter for facts.

        Returns:
            Set of community UUIDs whose membership changed.
        """
        changed_communities: set[str] = set()

        if new_entity_ids:
            changed_communities.update(
                self._process_node_type(
                    store, "entity", new_entity_ids, entity_resolutions
                )
            )

        if new_fact_ids:
            changed_communities.update(
                self._process_node_type(store, "fact", new_fact_ids, fact_resolutions)
            )

        return changed_communities

    # ── Private helpers ──────────────────────────────────────────────────────

    def _process_node_type(
        self,
        store: KnowledgeStore,
        node_type: str,
        new_ids: list[str],
        resolutions: dict[str, float],
    ) -> set[str]:
        """Run frontier Leiden for one node type across all levels.

        Args:
            store: KnowledgeStore for graph reads and community column updates.
            node_type: "entity" or "fact".
            new_ids: IDs of newly ingested nodes.
            resolutions: Level-to-resolution parameter mapping.

        Returns:
            Set of changed community UUIDs across all levels.
        """
        import leidenalg

        changed: set[str] = set()
        table = "entities" if node_type == "entity" else "facts"
        conn = store.sql_conn

        # Load all node IDs and build index
        rows = conn.execute(f"SELECT id FROM {table}").fetchall()
        all_node_ids = [r[0] for r in rows]
        if not all_node_ids:
            return changed

        id_to_idx: dict[str, int] = {nid: i for i, nid in enumerate(all_node_ids)}

        # Build igraph for this node type
        g = self._build_graph(store, node_type, all_node_ids, id_to_idx)
        if g is None:
            return changed

        # Identify frontier: new node indices + 1-hop neighbors
        new_indices: list[int] = [id_to_idx[nid] for nid in new_ids if nid in id_to_idx]
        frontier_set: set[int] = set(new_indices)
        for idx in new_indices:
            for neighbor in g.neighbors(idx):
                frontier_set.add(neighbor)
        if not frontier_set:
            return changed
        frontier_indices = sorted(frontier_set)
        frontier_graph = g.induced_subgraph(frontier_indices)
        frontier_node_ids = [all_node_ids[idx] for idx in frontier_indices]

        for level, resolution in resolutions.items():
            col = f"community_{level}"

            # Check if column exists
            cols = {
                r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
            }
            if col not in cols:
                logger.debug(
                    "Column %s not found on %s, skipping level %s", col, table, level
                )
                continue

            # Load existing assignments as initial_membership
            assign_rows = conn.execute(f"SELECT id, {col} FROM {table}").fetchall()
            existing_assignment: dict[str, int] = {}
            for row in assign_rows:
                if row[1] is not None:
                    existing_assignment[row[0]] = int(row[1])

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
            for node_id in frontier_node_ids:
                persisted = existing_assignment.get(node_id)
                if persisted is None:
                    dense_membership = next_cluster
                    next_cluster += 1
                else:
                    dense_membership = dense_for_persisted[persisted]
                initial_membership.append(dense_membership)

            try:
                partition = leidenalg.find_partition(
                    frontier_graph,
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

            # Map Leiden's dense output labels back onto stable persisted IDs.
            # A cluster containing existing nodes inherits their most common ID;
            # a new-only cluster receives the next unused persisted ID.
            dense_members = defaultdict(list)
            for idx, dense_id in enumerate(partition.membership):
                dense_members[dense_id].append(idx)
            next_persisted = max(persisted_ids, default=-1) + 1
            persisted_for_dense: dict[int, int] = {}
            for dense_id, indices in dense_members.items():
                candidates = Counter(
                    existing_assignment[frontier_node_ids[idx]]
                    for idx in indices
                    if frontier_node_ids[idx] in existing_assignment
                )
                if candidates:
                    persisted_for_dense[dense_id] = min(
                        candidates,
                        key=lambda cid: (-candidates[cid], cid),
                    )
                else:
                    persisted_for_dense[dense_id] = next_persisted
                    next_persisted += 1

            new_assignment = [
                persisted_for_dense[dense_id] for dense_id in partition.membership
            ]
            changed_updates: list[tuple[int, str]] = []

            for idx, node_id in enumerate(frontier_node_ids):
                old_cid = existing_assignment.get(node_id, -1)
                new_cid = new_assignment[idx]

                if old_cid != new_cid:
                    changed_updates.append((new_cid, node_id))
                    # Record both old and new community as changed
                    if old_cid >= 0:
                        changed.add(community_id_from(node_type, level, old_cid))
                    changed.add(community_id_from(node_type, level, new_cid))

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
