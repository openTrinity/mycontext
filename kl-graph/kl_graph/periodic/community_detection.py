"""Hierarchical community detection over entities and facts.

Builds a single heterogeneous graph containing both entities and facts as
vertices, with weighted edges from ENTITY_SIMILAR, FACT_SIMILAR, ABOUT, and
synthesized co-mention. Runs the HIT-Leiden static build
(:func:`kl_graph.periodic.incremental_leiden.naive_leiden`) once over that
graph and stores assignments at every level the hierarchy produces.

This is the SAME algorithm the incremental path maintains
(:class:`kl_graph.periodic.incremental_leiden.HITLeiden`), so a full rebuild
and an incremental maintenance pass produce the same hierarchy shape:
level 0 is the finest (base) partition and each higher level is the
modularity-guarded aggregation of the one below.

Assignments are written to ``community_L{i}`` columns (created lazily for
every level i present in the hierarchy). Every node carries its own cluster
id at every level — there is no finality fill, because an aggregation
hierarchy assigns every vertex a community at every level.
:func:`project_community_membership_edges` derives reified Community rows +
``COMM_MEMBER`` edges from those assignments.
"""

from __future__ import annotations

from collections import defaultdict, deque
from typing import TYPE_CHECKING

from kl_graph.models.types import Community, Edge, EdgeType, community_id_from
from kl_graph.periodic.incremental_leiden import (
    DynamicGraph,
    default_config,
    naive_leiden,
)

if TYPE_CHECKING:
    from kl_graph.storage.sqlite_store import SQLiteStore

# Legacy level-name registry kept for call sites that still pass per-level
# resolution dicts around (improvement.py → community strategies). The
# hierarchy is no longer resolution-swept — a single γ from the app config
# drives every level — so only the KEYS (level names) matter here.
RESOLUTIONS = {
    "L0": 1.0,
    "L1": 1.0,
    "L2": 1.0,
    "L3": 1.0,
}

# Scope guard: partition only the largest connected component. Small
# components are left unclustered exactly like the incremental path, so the
# two paths never disagree on scope.
LEIDEN_USE_LCC = True

# Hub guard: entities incident to more than this many facts are dropped from
# the ABOUT edge set; co-mention pairs are dropped when either endpoint's
# partner count exceeds this cap.
HUB_GUARD_THRESHOLD = 200


def _find_lcc(edges: list[tuple[str, str, float]]) -> list[tuple[str, str, float]]:
    """Find the largest connected component in an undirected graph.

    Selects the component with the most vertices (nodes), not edges.

    Args:
        edges: List of (source, target, weight) triples.

    Returns:
        Subset of edges that belong to the largest connected component.
    """
    if not edges:
        return []

    # Build adjacency list.
    adj: dict[str, list[tuple[str, float, int]]] = defaultdict(list)
    for i, (u, v, w) in enumerate(edges):
        adj[u].append((v, w, i))
        adj[v].append((u, w, i))

    # Find connected components using BFS.
    visited: set[str] = set()
    components: list[tuple[set[str], set[int]]] = []

    for start_node in adj:
        if start_node in visited:
            continue

        # BFS to find all nodes and edges in this component.
        component_nodes: set[str] = set()
        component_edges: set[int] = set()
        queue = deque([start_node])
        visited.add(start_node)

        while queue:
            node = queue.popleft()
            component_nodes.add(node)
            for neighbor, _, edge_idx in adj[node]:
                component_edges.add(edge_idx)
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append(neighbor)

        components.append((component_nodes, component_edges))

    # Return edges from the largest component (by vertex count).
    if not components:
        return []

    _, largest_edges = max(components, key=lambda c: len(c[0]))
    return [edges[i] for i in sorted(largest_edges)]


def _make_label(node_type: str, node_id: str) -> str:
    """Create a collision-proof internal label for Leiden.

    Entity and fact ids live in separate tables and can legally collide.
    Prefix with a type tag so the community vertex set is unambiguous.

    Args:
        node_type: "entity" or "fact".
        node_id: The original id from the entities/facts table.

    Returns:
        A qualified label like "e:<id>" or "f:<id>".
    """
    prefix = "e" if node_type == "entity" else "f"
    return f"{prefix}:{node_id}"


def _parse_label(label: str) -> tuple[str, str]:
    """Reverse a collision-proof label back to (node_type, node_id).

    Args:
        label: A qualified label like "e:<id>" or "f:<id>".

    Returns:
        (node_type, node_id) tuple.
    """
    prefix, _, node_id = label.partition(":")
    node_type = "entity" if prefix == "e" else "fact"
    return node_type, node_id


def _build_community_graph(
    sqlite: SQLiteStore,
) -> tuple[list[tuple[str, str, float]], dict[str, tuple[str, str]]]:
    """Build the weighted undirected edge list over entities + facts.

    Vertices are implicit (every id appearing as an edge endpoint). Edges:

    - ENTITY_SIMILAR entity↔entity: weight = stored hybrid_score (no fallback)
    - FACT_SIMILAR fact↔fact: weight = stored score (no fallback)
    - ABOUT fact↔entity: weight = fact.confidence (plain, no fan-out discount)
    - Co-mention entity↔entity: weight = min(shared_chunks/10, 1.0),
      synthesized from MENTIONS + AUTHORED_BY chunk co-membership (≥2 shared
      chunks required)

    Hub guard: entities incident to >HUB_GUARD_THRESHOLD facts are skipped on
    the ABOUT side; co-mention pairs are dropped when either endpoint's
    distinct-partner count exceeds HUB_GUARD_THRESHOLD. Parallel pairs are
    merged by MAX.

    Internal vertex labels use collision-proof prefixes ("e:" / "f:") so
    identical textual ids in entities and facts tables never collapse.

    Args:
        sqlite: Store to read entities, facts, and edges from.

    Returns:
        (edges, label_map) where edges is a list of (label_u, label_v, weight)
        triples using collision-proof labels, and label_map maps each label
        back to (node_type, original_id).
    """
    print("  Building community graph...")

    # Collect all vertex ids (entities + facts).
    entity_ids = {
        r[0] for r in sqlite.sql_conn.execute("SELECT id FROM entities").fetchall()
    }
    fact_ids = {
        r[0] for r in sqlite.sql_conn.execute("SELECT id FROM facts").fetchall()
    }
    print(f"    Entities: {len(entity_ids)}, Facts: {len(fact_ids)}")

    # Build the collision-proof label map.
    label_map: dict[str, tuple[str, str]] = {}
    for eid in entity_ids:
        label_map[_make_label("entity", eid)] = ("entity", eid)
    for fid in fact_ids:
        label_map[_make_label("fact", fid)] = ("fact", fid)

    # Edge accumulator: (u, v) -> max weight, with u < v lexicographically.
    edge_weights: dict[tuple[str, str], float] = {}

    def _add_edge(u: str, v: str, w: float) -> None:
        if u == v:
            return
        key = (u, v) if u < v else (v, u)
        if key in edge_weights:
            edge_weights[key] = max(edge_weights[key], w)
        else:
            edge_weights[key] = w

    # ENTITY_SIMILAR edges (entity↔entity). Weight = stored hybrid_score only.
    n_entity_sim = 0
    n_entity_sim_skipped = 0
    for src_id, tgt_id, props in sqlite.scan_edges_by_type(
        ["ENTITY_SIMILAR"], source_type="entity", target_type="entity"
    ):
        if src_id in entity_ids and tgt_id in entity_ids:
            w = props.get("hybrid_score")
            if w is None or not isinstance(w, (int, float)):
                n_entity_sim_skipped += 1
                continue
            _add_edge(
                _make_label("entity", src_id),
                _make_label("entity", tgt_id),
                float(w),
            )
            n_entity_sim += 1
    print(f"    ENTITY_SIMILAR edges: {n_entity_sim} (skipped {n_entity_sim_skipped} missing/invalid weight)")

    # FACT_SIMILAR edges (fact↔fact). Weight = stored score only.
    n_fact_sim = 0
    n_fact_sim_skipped = 0
    for src_id, tgt_id, props in sqlite.scan_edges_by_type(
        ["FACT_SIMILAR"], source_type="fact", target_type="fact"
    ):
        if src_id in fact_ids and tgt_id in fact_ids:
            w = props.get("score")
            if w is None or not isinstance(w, (int, float)):
                n_fact_sim_skipped += 1
                continue
            _add_edge(
                _make_label("fact", src_id),
                _make_label("fact", tgt_id),
                float(w),
            )
            n_fact_sim += 1
    print(f"    FACT_SIMILAR edges: {n_fact_sim} (skipped {n_fact_sim_skipped} missing/invalid weight)")

    # ABOUT edges (fact↔entity). Weight = fact.confidence.
    # First, load fact confidences.
    fact_confidence = {
        r[0]: r[1]
        for r in sqlite.sql_conn.execute("SELECT id, confidence FROM facts").fetchall()
    }

    # Track entity→fact count for hub guard.
    entity_fact_count: dict[str, int] = defaultdict(int)
    about_edges_raw: list[tuple[str, str, float]] = []

    for src_id, tgt_id, _props in sqlite.scan_edges_by_type(
        ["ABOUT"], source_type="fact", target_type="entity"
    ):
        if src_id in fact_ids and tgt_id in entity_ids:
            entity_fact_count[tgt_id] += 1
            conf = fact_confidence.get(src_id, 0.8)
            about_edges_raw.append((src_id, tgt_id, conf))

    n_about = 0
    n_about_skipped = 0
    for fact_id, entity_id, conf in about_edges_raw:
        if entity_fact_count[entity_id] > HUB_GUARD_THRESHOLD:
            n_about_skipped += 1
            continue
        _add_edge(
            _make_label("fact", fact_id),
            _make_label("entity", entity_id),
            conf,
        )
        n_about += 1
    print(f"    ABOUT edges: {n_about} (skipped {n_about_skipped} hub entities)")

    # Co-mention edges (entity↔entity). Synthesized from MENTIONS + AUTHORED_BY
    # chunk co-membership.
    print("    Computing co-mention edges...")
    entity_chunks: dict[str, set[str]] = defaultdict(set)
    for src_id, tgt_id, _props in sqlite.scan_edges_by_type(
        ["MENTIONS", "AUTHORED_BY"], source_type="chunk", target_type="entity"
    ):
        if tgt_id in entity_ids:
            entity_chunks[tgt_id].add(src_id)

    # Build chunk → entities mapping (inverse).
    chunk_entities: dict[str, set[str]] = defaultdict(set)
    for eid, chunks in entity_chunks.items():
        for cid in chunks:
            chunk_entities[cid].add(eid)

    # Count co-occurrences and track DISTINCT partner sets for hub guard.
    # comention_counts: dict[tuple[str, str], int] = defaultdict(int)
    # entity_partners: dict[str, set[str]] = defaultdict(set)
    #
    # for entities in chunk_entities.values():
    #     ent_list = sorted(entities)
    #     for i in range(len(ent_list)):
    #         for j in range(i + 1, len(ent_list)):
    #             pair = (ent_list[i], ent_list[j])
    #             comention_counts[pair] += 1
    #             entity_partners[ent_list[i]].add(ent_list[j])
    #             entity_partners[ent_list[j]].add(ent_list[i])
    #
    # n_comention = 0
    # n_comention_skipped = 0
    # for (eid_a, eid_b), count in comention_counts.items():
    #     if count >= 2:
    #         # Hub guard: skip if either endpoint has too many distinct partners.
    #         if (
    #             len(entity_partners[eid_a]) > HUB_GUARD_THRESHOLD
    #             or len(entity_partners[eid_b]) > HUB_GUARD_THRESHOLD
    #         ):
    #             n_comention_skipped += 1
    #             continue
    #         w = min(count / 10.0, 1.0)
    #         _add_edge(
    #             _make_label("entity", eid_a),
    #             _make_label("entity", eid_b),
    #             w,
    #         )
    #         n_comention += 1
    # print(f"    Co-mention edges: {n_comention} (skipped {n_comention_skipped} hub pairs)")

    # Convert to a list of triples in a DETERMINISTIC order.
    #
    # ``edge_weights`` is a dict keyed by tuples whose iteration order follows
    # insertion order, and insertion order follows the graph-scan order, which is
    # not stable across runs (set iteration over ``entity_ids``/``fact_ids``, and
    # backend scan order). The Leiden kernels (``graspologic_native.leiden`` at
    # every hierarchy level) are order-SENSITIVE even with a fixed seed: the
    # same graph in a different edge order yields a different hierarchy
    # (measured on the old hierarchical path: L1 ARI 0.75-0.90 between reruns
    # on identical data). That makes every partition comparison -- incremental
    # vs full, day over day, before vs after a change -- read detector noise
    # as if it were a real signal.
    #
    # Sorting here makes the whole detection path a pure function of the stored
    # graph, which is what the frozen seed was always meant to deliver.
    edges = sorted((u, v, w) for (u, v), w in edge_weights.items())
    print(f"    Total edges: {len(edges)}")

    return edges, label_map


def parents_from_levels(
    memberships: list[dict[str, int]],
    upper_s_pre: list[dict[str, str] | None],
) -> dict[tuple[int, int], int | None]:
    """Resolve parent links for a hierarchy from its level maps.

    The aggregation structure, not cluster naming, is authoritative: a
    level-p node reaches level p+1 through ``upper_s_pre[p]``, and its
    movement cluster's parent is the upper community that absorbed it.
    Naming the super-node ``"c{cluster}"`` is only valid while movement and
    refinement coincide (the static build); a maintained hierarchy diverges
    after refinement, so parents must come from the aggregation map.

    Args:
        memberships: Per-level ``node -> cluster`` maps, index 0 = finest.
        upper_s_pre: ``upper_s_pre[p]`` maps level-p nodes to level-(p+1)
            nodes; ``None`` at the top level.

    Returns:
        ``{(level, cluster): parent_cluster or None}`` for every cluster at
        every level.
    """
    parents: dict[tuple[int, int], int | None] = {}
    for level_idx, membership in enumerate(memberships):
        s_pre = upper_s_pre[level_idx] if level_idx < len(upper_s_pre) else None
        clusters = sorted(set(membership.values()))
        if s_pre is None:
            for cluster in clusters:
                parents[(level_idx, cluster)] = None
            continue
        cluster_parents: dict[int, set[int]] = {}
        for node, cluster in membership.items():
            up_node = s_pre.get(node)
            if up_node is None:
                continue
            up_cluster = memberships[level_idx + 1].get(up_node)
            if up_cluster is not None:
                cluster_parents.setdefault(cluster, set()).add(up_cluster)
        for cluster in clusters:
            found = cluster_parents.get(cluster, set())
            # The nesting invariant gives exactly one parent; when it is
            # violated (degenerate state) pick the minimum for determinism.
            parents[(level_idx, cluster)] = min(found) if found else None
    return parents


def _hierarchy_to_detection(
    result,
    label_map: dict[str, tuple[str, str]],
) -> tuple[dict[int, dict[tuple[str, str], int]], dict[tuple[int, int], int | None]]:
    """Convert a :class:`LeidenResult` into the detection dict shape.

    Args:
        result: Static-build output (per-level graphs + memberships).
        label_map: Collision-proof label -> ``(node_type, original_id)``.

    Returns:
        ``(assignments, parents)`` where assignments is dense — every node
        carries its own cluster id at every level — and parents maps each
        ``(level, cluster)`` to its parent cluster one level up (None at the
        top). Parent links come from the aggregation structure: a level-p
        cluster corresponds 1:1 to the super-node ``"c{cluster}"`` at level
        p+1, so its parent is that super-node's upper-level community.
    """
    assignments: dict[int, dict[tuple[str, str], int]] = {}
    for level_idx, lvl in enumerate(result.levels):
        per_level: dict[tuple[str, str], int] = {}
        for node, cluster in lvl.membership.items():
            for base_v in lvl.node_to_children.get(node, {node}):
                node_key = label_map.get(base_v)
                if node_key is not None:
                    per_level[node_key] = int(cluster)
        assignments[level_idx] = per_level

    parents = parents_from_levels(
        [dict(lvl.membership) for lvl in result.levels],
        [
            dict(result.levels[p + 1].s_pre) if p + 1 < len(result.levels) else None
            for p in range(len(result.levels))
        ],
    )
    return assignments, parents


def detect_communities_hierarchical(
    edges: list[tuple[str, str, float]],
    label_map: dict[str, tuple[str, str]],
) -> dict:
    """Run the HIT-Leiden static build over the community edge list.

    Uses :func:`naive_leiden` with γ / seed / max_levels from the app config
    (``pipelines.ingestion.incremental.leiden``) — the SAME parameters the
    incremental maintainer uses, so a full rebuild and incremental maintenance
    of the same graph converge on the same hierarchy shape.

    Normalizes edge pairs lexicographically, deduplicates keeping last, and
    optionally restricts to the largest connected component (LEIDEN_USE_LCC).

    Args:
        edges: List of (label_u, label_v, weight) triples using collision-proof
            labels (e.g., "e:<id>" or "f:<id>").
        label_map: Maps collision-proof labels back to (node_type, original_id).

    Returns:
        A dict with keys:
        - 'assignments': {level: {(node_type, original_id): cluster_id}},
          dense across all levels (level 0 = finest).
        - 'parents': {(level, cluster): parent_cluster at level+1, or None}
    """
    print("  Running HIT-Leiden static build...")

    # Normalize and deduplicate (keep last).
    normalized: dict[tuple[str, str], float] = {}
    for u, v, w in edges:
        key = (u, v) if u < v else (v, u)
        normalized[key] = w

    deduped_edges = sorted((u, v, w) for (u, v), w in normalized.items())
    print(f"    Edges after normalization+dedup: {len(deduped_edges)}")

    empty = {"assignments": {}, "parents": {}}
    if not deduped_edges:
        print("    No edges; skipping Leiden.")
        return empty

    # Optional LCC filter.
    if LEIDEN_USE_LCC:
        lcc_edges = _find_lcc(deduped_edges)
        lcc_nodes = {u for u, v, w in lcc_edges} | {v for u, v, w in lcc_edges}
        print(f"    LCC: {len(lcc_nodes)} nodes, {len(lcc_edges)} edges")
    else:
        lcc_edges = deduped_edges

    if not lcc_edges:
        print("    No edges after LCC filter; skipping Leiden.")
        return empty

    graph = DynamicGraph()
    for u, v, w in lcc_edges:
        graph.add_edge(u, v, w)

    icfg = default_config()
    result = naive_leiden(
        graph,
        gamma=icfg.gamma,
        max_levels=icfg.max_levels,
        seed=icfg.seed,
    )

    assignments, parents = _hierarchy_to_detection(result, label_map)

    for level in sorted(assignments.keys()):
        n_nodes = len(assignments[level])
        n_clusters = len(set(assignments[level].values()))
        print(f"    Level {level}: {n_clusters} clusters, {n_nodes} nodes assigned")

    return {"assignments": assignments, "parents": parents}


def store_communities(
    sqlite: SQLiteStore,
    detection_result: dict,
) -> None:
    """Store hierarchical community assignments in community_L{i} columns.

    Creates columns lazily for every level present in the hierarchy. The
    detection ``assignments`` are dense (every node has its own cluster id at
    every level of the aggregation hierarchy), so they are written as-is — no
    finality fill.

    Clears ALL existing community_L* columns on every run (including empty
    results) before writing, implementing rebuild-not-migrate semantics.

    Args:
        sqlite: Store to write assignments to.
        detection_result: Dict from detect_communities_hierarchical
            with 'assignments' and 'parents' keys.
    """
    assignments = detection_result.get("assignments", {})

    # Enumerate existing community_L* columns per table (they can legitimately
    # differ after external ALTERs, so clearing must be per-table too).
    existing_cols: dict[str, set[int]] = {"entities": set(), "facts": set()}
    for table in ("entities", "facts"):
        cursor = sqlite.sql_conn.execute(f"PRAGMA table_info({table})")
        for row in cursor.fetchall():
            col_name = row[1]
            if col_name.startswith("community_L"):
                try:
                    level = int(col_name.split("L")[1])
                    existing_cols[table].add(level)
                except (ValueError, IndexError):
                    pass

    # Clear ALL existing community_L* columns on every run (rebuild-not-migrate).
    n_existing = len(existing_cols["entities"] | existing_cols["facts"])
    if n_existing:
        print(f"  Clearing {n_existing} existing community_L* columns...")
        for table in ("entities", "facts"):
            for level in sorted(existing_cols[table]):
                col = f"community_L{level}"
                sqlite.sql_conn.execute(f"UPDATE {table} SET {col} = NULL")
        sqlite.sql_conn.commit()

    # If no new assignments, we're done (columns are cleared).
    if not assignments:
        print("  No assignments to store (cleared existing columns).")
        return

    # Determine the set of levels and the max level.
    levels = sorted(assignments.keys())
    max_level = max(levels)
    print(f"  Storing assignments across {len(levels)} levels (max L{max_level})...")

    # Create columns lazily for new levels.
    for level in levels:
        col = f"community_L{level}"
        for table in ("entities", "facts"):
            try:
                sqlite.sql_conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} INTEGER")
            except Exception:  # noqa: BLE001, S110
                pass
    sqlite.sql_conn.commit()

    # Write assignments to the database. node_key is (node_type, original_id).
    total_writes = 0
    for level in levels:
        for node_key, cluster_id in assignments[level].items():
            node_type, original_id = node_key
            table = "entities" if node_type == "entity" else "facts"
            col = f"community_L{level}"
            sqlite.sql_conn.execute(
                f"UPDATE {table} SET {col} = ? WHERE id = ?", (cluster_id, original_id)
            )
            total_writes += 1

    sqlite.sql_conn.commit()
    print(f"    Wrote {total_writes} assignment cells.")


def project_community_membership_edges(
    sqlite: SQLiteStore,
    detection_result: dict,
    *,
    batch_size: int = 5000,
) -> None:
    """Derive Community rows + COMM_MEMBER edges from the detection result.

    Materializes one Community row (plus member counts and COMM_MEMBER edges)
    per genuine cluster at every level of the aggregation hierarchy.

    Reified Community rows use node_type="mixed" and carry level, total
    member_count, and separate entity_member_count / fact_member_count stored
    as additive columns on the communities table. Parent relationships use the
    hierarchy's aggregation records: a level-p cluster's parent is the level
    p+1 cluster that absorbed it (level 0 is the FINEST level here, so parents
    point UP to level+1).

    Deletes ALL existing Community rows and ALL COMM_MEMBER edges before
    inserting the fresh projection (rebuild-not-migrate).

    Args:
        sqlite: Store to read assignments from and write the projection to.
        detection_result: Dict from detect_communities_hierarchical
            with 'assignments' and 'parents' keys.
        batch_size: Edge rows per executemany/insert batch.
    """
    # Wholesale-delete existing Community rows and COMM_MEMBER edges on every
    # run (rebuild-not-migrate), including empty results.
    sqlite.sql_conn.execute("DELETE FROM communities")
    sqlite.sql_conn.commit()
    sqlite.delete_edges(edge_type=EdgeType.COMM_MEMBER.value)

    assignments = detection_result.get("assignments", {})
    parents = detection_result.get("parents", {})

    if not assignments:
        print("  No assignments to project (cleared existing projection).")
        return

    print("  Projecting Community nodes + COMM_MEMBER edges...")

    levels = sorted(assignments.keys())

    # Ensure entity_member_count / fact_member_count columns exist on the
    # communities table (minimal additive option for issue #8).
    for col in ("entity_member_count", "fact_member_count"):
        try:
            sqlite.sql_conn.execute(
                f"ALTER TABLE communities ADD COLUMN {col} INTEGER DEFAULT 0"
            )
        except Exception:  # noqa: BLE001, S110
            pass
    sqlite.sql_conn.commit()

    # Compute member counts per native (level, cluster) — total, entity, fact.
    total_counts: dict[tuple[int, int], int] = defaultdict(int)
    entity_counts: dict[tuple[int, int], int] = defaultdict(int)
    fact_counts: dict[tuple[int, int], int] = defaultdict(int)

    for level in levels:
        for node_key, cid in assignments[level].items():
            # node_key is (node_type, original_id)
            key = (level, cid)
            total_counts[key] += 1
            if node_key[0] == "entity":
                entity_counts[key] += 1
            else:
                fact_counts[key] += 1

    # Parent links come from the aggregation hierarchy (Option B semantics):
    # never re-inferred by majority vote.
    def _get_parent_id(level: int, cid: int) -> tuple[str | None, int | None]:
        """Resolve parent Community id from hierarchy records."""
        parent_cluster = parents.get((level, cid))
        if parent_cluster is not None:
            return (
                community_id_from(f"L{level + 1}", parent_cluster),
                level + 1,
            )
        return (None, None)

    # Build Community rows.
    communities = []
    for (level, cid), count in total_counts.items():
        comm_id = community_id_from(f"L{level}", cid)
        parent_id, parent_level = _get_parent_id(level, cid)

        communities.append(
            Community(
                id=comm_id,
                node_type="mixed",
                level=f"L{level}",
                summary="",
                tags=[],
                member_count=count,
                parent_id=parent_id,
                parent_level=parent_level,
            )
        )

    sqlite.insert_communities(communities)

    # Set entity/fact member counts via follow-up UPDATE (the existing
    # insert_communities API does not know about these additive columns).
    for (level, cid) in total_counts:
        comm_id = community_id_from(f"L{level}", cid)
        sqlite.sql_conn.execute(
            "UPDATE communities SET entity_member_count = ?, fact_member_count = ? WHERE id = ?",
            (entity_counts.get((level, cid), 0), fact_counts.get((level, cid), 0), comm_id),
        )
    sqlite.sql_conn.commit()
    print(f"    Inserted {len(communities)} Community rows (with entity/fact member counts).")

    # Build COMM_MEMBER edges for every membership — assignments are dense
    # across all levels of the aggregation hierarchy.
    edges: list[Edge] = []
    for level in levels:
        for node_key, cid in assignments[level].items():
            # node_key is (node_type, original_id)
            node_type, original_id = node_key
            edges.append(
                Edge(
                    source_type=node_type,
                    source_id=original_id,
                    target_type="community",
                    target_id=community_id_from(f"L{level}", cid),
                    edge_type=EdgeType.COMM_MEMBER,
                    properties={"level": f"L{level}"},
                )
            )

    _rebuild_comm_member_edges(sqlite, edges, batch_size=batch_size)
    print(f"    Rebuilt {len(edges)} COMM_MEMBER edges.")


def _rebuild_comm_member_edges(
    sqlite: SQLiteStore,
    edges: list[Edge],
    *,
    batch_size: int,
) -> None:
    """Delete all COMM_MEMBER edges and re-insert the given list.

    Atomic on SQLiteStore (single transaction); best-effort on other backends.

    Args:
        sqlite: Store to rewrite the projection in.
        edges: Fresh COMM_MEMBER edge set.
        batch_size: Rows per batch.
    """
    sqlite.delete_edges(edge_type=EdgeType.COMM_MEMBER.value)
    for i in range(0, len(edges), batch_size):
        sqlite.insert_edges(edges[i : i + batch_size])
