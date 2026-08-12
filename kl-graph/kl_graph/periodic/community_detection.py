"""Hierarchical community detection over entities and facts.

Builds a single heterogeneous graph containing both entities and facts as
vertices, with weighted edges from ENTITY_SIMILAR, FACT_SIMILAR, ABOUT, and
synthesized co-mention. Runs GraphRAG-style hierarchical Leiden (via
graspologic_native) once over that graph and stores assignments at
every level produced.

Assignments are written to ``community_L{i}`` columns (created lazily for
every level i present in the hierarchy). A node final at level ℓ carries its
level-i cluster id in every column i ≤ ℓ and repeats the level-ℓ id into
every deeper column that exists. :func:`project_community_membership_edges`
derives reified Community rows + ``COMM_MEMBER`` edges from those columns.
"""

from __future__ import annotations

from collections import defaultdict, deque
from typing import TYPE_CHECKING

import graspologic_native as gn

from kl_graph.models.types import Community, Edge, EdgeType, community_id_from

if TYPE_CHECKING:
    from kl_graph.storage.sqlite_store import SQLiteStore

# Legacy constant for backward compatibility with incremental.py
# DEPRECATED: The hierarchical Leiden implementation uses
# LEIDEN_RESOLUTION and other specific constants below. This is kept only
# to avoid breaking imports in incremental.py (which we don't own).
RESOLUTIONS = {
    "L0": 0.3,   # Domain/org-level (few large communities)
    "L1": 1.0,   # Team/project-level
    "L2": 3.0,   # Feature/topic-level
    "L3": 10.0,  # Conversation/component-level (many small communities)
}

# GraphRAG hierarchical Leiden parameters (frozen; do not tune without
# updating the design doc and regenerating baselines).
LEIDEN_RESOLUTION = 1.0
LEIDEN_RANDOMNESS = 0.001
LEIDEN_ITERATIONS = 1
LEIDEN_USE_MODULARITY = True
LEIDEN_MAX_CLUSTER_SIZE = 10
LEIDEN_SEED = 0xDEADBEEF
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
    # backend scan order). ``hierarchical_leiden`` is order-SENSITIVE even with a
    # fixed seed: the same graph in a different edge order yields a different
    # hierarchy (measured: L1 ARI 0.75-0.90 between reruns on identical data, and
    # even a different number of levels). That makes every partition comparison
    # -- incremental vs full, day over day, before vs after a change -- read
    # detector noise as if it were a real signal.
    #
    # Sorting here makes the whole detection path a pure function of the stored
    # graph, which is what the frozen seed was always meant to deliver.
    edges = sorted((u, v, w) for (u, v), w in edge_weights.items())
    print(f"    Total edges: {len(edges)}")

    return edges, label_map


def detect_communities_hierarchical(
    edges: list[tuple[str, str, float]],
    label_map: dict[str, tuple[str, str]],
) -> dict:
    """Run hierarchical Leiden over the community edge list.

    Calls graspologic_native.hierarchical_leiden with GraphRAG parameters:
    resolution=1.0, randomness=0.001, iterations=1, use_modularity=True,
    max_cluster_size=10, seed=0xDEADBEEF, starting_communities=None.

    Normalizes edge pairs lexicographically, deduplicates keeping last, and
    optionally restricts to the largest connected component (use_lcc=True).

    Preserves native parent_cluster and is_final_cluster from the Leiden output
    rather than re-inferring them.

    Args:
        edges: List of (label_u, label_v, weight) triples using collision-proof
            labels (e.g., "e:<id>" or "f:<id>").
        label_map: Maps collision-proof labels back to (node_type, original_id).

    Returns:
        A dict with keys:
        - 'assignments': {level: {(node_type, original_id): cluster_id}}
        - 'native_parents': {(level, cluster): parent_cluster or None}
        - 'native_finality': {(node_type, original_id): final_level}
    """
    print("  Running hierarchical Leiden...")

    # Normalize and deduplicate (keep last).
    normalized: dict[tuple[str, str], float] = {}
    for u, v, w in edges:
        key = (u, v) if u < v else (v, u)
        normalized[key] = w

    deduped_edges = sorted((u, v, w) for (u, v), w in normalized.items())
    print(f"    Edges after normalization+dedup: {len(deduped_edges)}")

    if not deduped_edges:
        print("    No edges; skipping Leiden.")
        return {
            "assignments": {},
            "native_parents": {},
            "native_finality": {},
        }

    # Optional LCC filter.
    if LEIDEN_USE_LCC:
        lcc_edges = _find_lcc(deduped_edges)
        print(f"    LCC: {len({u for u, v, w in lcc_edges} | {v for u, v, w in lcc_edges})} nodes, {len(lcc_edges)} edges")
    else:
        lcc_edges = deduped_edges

    if not lcc_edges:
        print("    No edges after LCC filter; skipping Leiden.")
        return {
            "assignments": {},
            "native_parents": {},
            "native_finality": {},
        }

    # Call graspologic_native.
    clusters = gn.hierarchical_leiden(
        edges=lcc_edges,
        starting_communities=None,
        resolution=LEIDEN_RESOLUTION,
        randomness=LEIDEN_RANDOMNESS,
        iterations=LEIDEN_ITERATIONS,
        use_modularity=LEIDEN_USE_MODULARITY,
        max_cluster_size=LEIDEN_MAX_CLUSTER_SIZE,
        seed=LEIDEN_SEED,
    )

    # Map records to {level: {(node_type, original_id): cluster_id}} and preserve
    # native parent_cluster and is_final_cluster.
    # Using (node_type, original_id) tuples as keys prevents collision when an
    # entity and fact share the same textual id.
    assignments: dict[int, dict[tuple[str, str], int]] = {}
    native_parents: dict[tuple[int, int], int | None] = {}
    native_finality: dict[tuple[str, str], int] = {}

    for record in clusters:
        level = record.level
        cluster = record.cluster
        label = record.node
        parent_cluster = record.parent_cluster
        is_final = record.is_final_cluster

        # Map label back to (node_type, original_id) tuple.
        if label not in label_map:
            continue
        node_key = label_map[label]  # (node_type, original_id)

        if level not in assignments:
            assignments[level] = {}
        assignments[level][node_key] = cluster

        # Store native parent link (once per cluster).
        parent_key = (level, cluster)
        if parent_key not in native_parents:
            native_parents[parent_key] = parent_cluster

        # Track finality: the deepest level where this node is marked final.
        if is_final:
            native_finality[node_key] = level

    for level in sorted(assignments.keys()):
        n_nodes = len(assignments[level])
        n_clusters = len(set(assignments[level].values()))
        print(f"    Level {level}: {n_clusters} clusters, {n_nodes} nodes assigned")

    return {
        "assignments": assignments,
        "native_parents": native_parents,
        "native_finality": native_finality,
    }


def effective_assignments(detection_result: dict) -> dict[tuple[str, str], dict[int, int]]:
    """Expand raw detection output into the per-level cells actually persisted.

    ``hierarchical_leiden`` only reports a node at the levels where it was still
    being subdivided: a node whose cluster is final at L1 simply does not appear
    at L2/L3.  The ``community_L*`` columns, however, are dense — a node's final
    cluster id is repeated into every deeper column so a query at any level
    always resolves a community.  Anything that compares stored columns against
    fresh detection output must apply this same expansion, or it will read the
    absence of deep-level rows as a disagreement that does not exist.

    This is the single source of truth for that rule, shared by
    :func:`store_communities` (which writes the cells) and by any analysis that
    reconstructs what a rerun would store.

    Args:
        detection_result: Dict from :func:`detect_communities_hierarchical` with
            ``assignments`` and ``native_finality`` keys.

    Returns:
        ``{(node_type, original_id): {level: cluster_id}}`` covering every level
        present in the result, or an empty dict when there are no assignments.
    """
    assignments = detection_result.get("assignments", {})
    native_finality = detection_result.get("native_finality", {})
    if not assignments:
        return {}

    levels = sorted(assignments.keys())
    expanded: dict[tuple[str, str], dict[int, int]] = {}
    for node_key in set().union(*[assignments[level].keys() for level in levels]):
        # Prefer the native is_final_cluster record; fall back to the deepest
        # level the node actually appears at.
        final_level = native_finality.get(node_key)
        if final_level is None:
            final_level = max(
                level for level in levels if node_key in assignments[level]
            )
        final_cid = assignments[final_level][node_key]
        expanded[node_key] = {
            level: (
                assignments[level][node_key] if level <= final_level else final_cid
            )
            for level in levels
        }
    return expanded


def store_communities(
    sqlite: SQLiteStore,
    detection_result: dict,
) -> None:
    """Store hierarchical community assignments in community_L{i} columns.

    Creates columns lazily for every level present in the hierarchy. Builds a
    canonical "effective assignments" map that includes repeated final cluster
    ids into deeper columns, then uses it as the single source for all writes.

    Clears ALL existing community_L* columns on every run (including empty
    results) before writing, implementing rebuild-not-migrate semantics.

    Args:
        sqlite: Store to write assignments to.
        detection_result: Dict from detect_communities_hierarchical
            with 'assignments', 'native_parents', 'native_finality' keys.
    """
    assignments = detection_result.get("assignments", {})

    # Enumerate ALL existing community_L* columns dynamically.
    existing_cols: set[int] = set()
    for table in ("entities", "facts"):
        cursor = sqlite.sql_conn.execute(f"PRAGMA table_info({table})")
        for row in cursor.fetchall():
            col_name = row[1]
            if col_name.startswith("community_L"):
                try:
                    level = int(col_name.split("L")[1])
                    existing_cols.add(level)
                except (ValueError, IndexError):
                    pass

    # Clear ALL existing community_L* columns on every run (rebuild-not-migrate).
    if existing_cols:
        print(f"  Clearing {len(existing_cols)} existing community_L* columns...")
        for level in sorted(existing_cols):
            col = f"community_L{level}"
            sqlite.sql_conn.execute(f"UPDATE entities SET {col} = NULL")
            sqlite.sql_conn.execute(f"UPDATE facts SET {col} = NULL")
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

    # Build canonical "effective assignments" map: for each node, determine its
    # final level (from native is_final_cluster, or deepest appearance), then
    # fill every level column with the appropriate cluster id (repeating the
    # final-level id into deeper columns).
    #
    # This is the SINGLE SOURCE for column writes, Community rows, and
    # COMM_MEMBER edges.
    # node_key is (node_type, original_id) tuple to prevent collision.
    effective = effective_assignments(detection_result)

    # Write assignments to the database.
    total_writes = 0
    for node_key, node_assignments in effective.items():
        # node_key is (node_type, original_id) tuple.
        node_type, original_id = node_key
        table = "entities" if node_type == "entity" else "facts"

        # Write cluster ids for each level.
        for level, cluster_id in node_assignments.items():
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

    Materializes NATIVE clusters only [A human 2026-08-09]: one Community row
    (plus member counts and COMM_MEMBER edges) per genuine Leiden cluster.
    The repeated-final-id fill stays in the community_L* columns for query
    convenience but gets no rows/edges/reports — copies carry identical
    member sets to their origin cluster and would only duplicate reports.

    Reified Community rows use node_type="mixed" and carry level, total
    member_count, and separate entity_member_count / fact_member_count stored
    as additive columns on the communities table. Parent relationships use the
    native parent_cluster records from hierarchical Leiden (Option B semantics)
    rather than re-inferring by majority vote.

    Deletes ALL existing Community rows and ALL COMM_MEMBER edges before
    inserting the fresh projection (rebuild-not-migrate).

    Args:
        sqlite: Store to read assignments from and write the projection to.
        detection_result: Dict from detect_communities_hierarchical
            with 'assignments', 'native_parents', 'native_finality' keys.
        batch_size: Edge rows per executemany/insert batch.
    """
    # Wholesale-delete existing Community rows and COMM_MEMBER edges on every
    # run (rebuild-not-migrate), including empty results.
    sqlite.sql_conn.execute("DELETE FROM communities")
    sqlite.sql_conn.commit()
    sqlite.delete_edges(edge_type=EdgeType.COMM_MEMBER.value)

    assignments = detection_result.get("assignments", {})
    native_parents = detection_result.get("native_parents", {})

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

    # Use native parent_cluster records (Option B semantics) rather than
    # re-inferring by majority vote.
    def _get_parent_id(level: int, cid: int) -> tuple[str | None, int | None]:
        """Resolve parent Community id from native records."""
        parent_cluster = native_parents.get((level, cid))
        if parent_cluster is not None and level > 0:
            return (
                community_id_from(f"L{level - 1}", parent_cluster),
                level - 1,
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

    # Build COMM_MEMBER edges for genuine memberships only — exactly what
    # `assignments` holds (levels up to and including each node's final level).
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
