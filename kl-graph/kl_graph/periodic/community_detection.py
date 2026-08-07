"""Multi-resolution community detection for entities and facts.

Entity communities: Leiden algorithm on the projected entity graph.
  - Edges: ENTITY_SIMILAR + co-mention (entities appearing in same message)
  - 4 resolution levels for hierarchical drill-down (L0-L3)

Fact communities: Two methods available:
  1. HDBSCAN on fact embeddings (topical clusters)
  2. Multi-resolution Leiden on fact FACT_SIMILAR graph augmented with shared-entity projections

All levels are stored as community_L{0,1,2,3} columns in SQLite. Those columns
are the authoritative assignment storage; :func:`project_community_membership_edges`
derives reified Community rows + ``COMM_MEMBER`` edges from them (never the
reverse).
"""

from __future__ import annotations

import json
from collections import defaultdict

import numpy as np

from kl_graph.models.types import Community, Edge, EdgeType, community_id_from
from kl_graph.storage.qdrant_store import QdrantStore
from kl_graph.storage.sqlite_store import SQLiteStore

# 4-level resolution hierarchy
RESOLUTIONS = {
    "L0": 0.3,   # Domain/org-level (few large communities)
    "L1": 1.0,   # Team/project-level
    "L2": 3.0,   # Feature/topic-level
    "L3": 10.0,  # Conversation/component-level (many small communities)
}


def _build_entity_graph(sqlite: SQLiteStore):
    """Build the entity graph from ENTITY_SIMILAR + co-mention edges.

    Returns:
        (igraph.Graph, entity_ids list, entity_names dict)
    """
    import igraph as ig

    # Get all entities
    rows = sqlite.sql_conn.execute("SELECT id, name FROM entities").fetchall()
    entity_ids = [r[0] for r in rows]
    entity_names = {r[0]: r[1] for r in rows}
    id_to_idx = {eid: i for i, eid in enumerate(entity_ids)}

    print(f"  Building entity graph ({len(entity_ids)} nodes)...")

    edge_list = []
    weights = []

    # Add ENTITY_SIMILAR edges (through the backend-agnostic edge API so this
    # works on both the SQLite and LadybugDB backends).
    for src_id, tgt_id, props in sqlite.scan_edges_by_type(
        ["ENTITY_SIMILAR"], source_type="entity", target_type="entity"
    ):
        src_idx = id_to_idx.get(src_id)
        tgt_idx = id_to_idx.get(tgt_id)
        if src_idx is not None and tgt_idx is not None:
            edge_list.append((src_idx, tgt_idx))
            weights.append(props.get("hybrid_score", props.get("confidence", 0.5)))

    # Add co-mention edges (entities appearing in the same chunk)
    print("  Computing co-mention edges...")
    entity_messages = defaultdict(set)
    for tgt_id, src_id, _props in sqlite.scan_edges_by_type(
        ["MENTIONS", "AUTHORED_BY"], source_type="chunk", target_type="entity"
    ):
        # (chunk=source, entity=target); index by entity → set of chunks
        entity_messages[tgt_id].add(src_id)

    # Build message → entities mapping (inverse)
    message_entities = defaultdict(set)
    for eid, msgs in entity_messages.items():
        for mid in msgs:
            message_entities[mid].add(eid)

    # Co-mention: entities that share messages
    comention_counts = defaultdict(int)
    for mid, entities in message_entities.items():
        ent_list = list(entities)
        for i in range(len(ent_list)):
            for j in range(i + 1, len(ent_list)):
                pair = tuple(sorted([ent_list[i], ent_list[j]]))
                comention_counts[pair] += 1

    # Add co-mention edges (threshold: at least 2 shared messages)
    for (eid_a, eid_b), count in comention_counts.items():
        if count >= 2:
            idx_a = id_to_idx.get(eid_a)
            idx_b = id_to_idx.get(eid_b)
            if idx_a is not None and idx_b is not None:
                edge_list.append((idx_a, idx_b))
                weights.append(min(count / 10.0, 1.0))

    if not edge_list:
        print("  No edges for community detection. Skipping.")
        return None, entity_ids, entity_names

    g = ig.Graph(n=len(entity_ids))
    g.add_edges(edge_list)
    g.es["weight"] = weights
    g.simplify(combine_edges={"weight": "max"})

    print(f"  Graph: {g.vcount()} nodes, {g.ecount()} edges")
    return g, entity_ids, entity_names


def detect_entity_communities_multi(
    sqlite: SQLiteStore,
    min_community_size: int = 2,
) -> dict[str, dict[str, int]]:
    """Run Leiden at 4 resolution levels on entity graph.

    Returns:
        {level_name: {entity_id: community_id}} for L0, L1, L2, L3
    """
    import leidenalg

    g, entity_ids, entity_names = _build_entity_graph(sqlite)  # noqa: RUF059
    if g is None:
        return {level: {} for level in RESOLUTIONS}

    results = {}
    for level_name, resolution in RESOLUTIONS.items():
        print(f"\n  [{level_name}] Running Leiden (resolution={resolution})...")
        partition = leidenalg.find_partition(
            g,
            leidenalg.RBConfigurationVertexPartition,
            weights="weight",
            resolution_parameter=resolution,
            n_iterations=10,
        )

        communities = {}
        valid_communities = 0
        for comm_idx, members in enumerate(partition):
            if len(members) >= min_community_size:
                for node_idx in members:
                    communities[entity_ids[node_idx]] = valid_communities
                valid_communities += 1

        results[level_name] = communities
        print(f"    {valid_communities} communities, "
              f"{len(communities)}/{len(entity_ids)} entities assigned")

        # Print size distribution
        if communities:
            comm_sizes = defaultdict(int)
            for cid in communities.values():
                comm_sizes[cid] += 1
            sizes = sorted(comm_sizes.values(), reverse=True)
            print(f"    Largest: {sizes[0]}, median: {sizes[len(sizes)//2]}, "
                  f"smallest: {sizes[-1]}")

    # Print nesting quality
    _print_nesting_quality(results, "entity")

    return results


def _build_fact_graph(sqlite: SQLiteStore):
    """Build the fact graph from FACT_SIMILAR + shared-entity projection.

    Returns:
        (igraph.Graph, fact_ids list, fact_texts dict)
    """
    import igraph as ig

    rows = sqlite.sql_conn.execute("SELECT id, text FROM facts").fetchall()
    fact_ids = [r[0] for r in rows]
    fact_texts = {r[0]: r[1] for r in rows}
    id_to_idx = {fid: i for i, fid in enumerate(fact_ids)}

    print(f"  Building fact graph ({len(fact_ids)} nodes)...")

    edge_list = []
    weights = []

    # Add FACT_SIMILAR edges between facts (backend-agnostic edge API)
    for src_id, tgt_id, props in sqlite.scan_edges_by_type(
        ["FACT_SIMILAR"], source_type="fact", target_type="fact"
    ):
        src_idx = id_to_idx.get(src_id)
        tgt_idx = id_to_idx.get(tgt_id)
        if src_idx is not None and tgt_idx is not None:
            edge_list.append((src_idx, tgt_idx))
            weights.append(props.get("score", 0.5))

    # Add shared-entity projection edges
    print("  Computing shared-entity projection...")
    entity_to_facts = defaultdict(set)
    fact_to_entities = defaultdict(set)
    for src_id, tgt_id, _props in sqlite.scan_edges_by_type(
        ["ABOUT"], source_type="fact", target_type="entity"
    ):
        # ABOUT is fact→entity: source=fact, target=entity
        entity_to_facts[tgt_id].add(src_id)
        fact_to_entities[src_id].add(tgt_id)

    max_facts_per_entity = 200
    projection_edge_counts = defaultdict(int)

    projected_entities = 0
    skipped_entities = 0
    for entity_id, facts in entity_to_facts.items():  # noqa: PERF102
        fact_list = [f for f in facts if f in id_to_idx]
        if len(fact_list) > max_facts_per_entity:
            skipped_entities += 1
            continue
        if len(fact_list) < 2:
            continue
        projected_entities += 1
        for i in range(len(fact_list)):
            for j in range(i + 1, len(fact_list)):
                pair = tuple(sorted([fact_list[i], fact_list[j]]))
                projection_edge_counts[pair] += 1

    print(f"  Projected through {projected_entities} entities "
          f"(skipped {skipped_entities} high-degree)")
    print(f"  Projected pairs: {len(projection_edge_counts)}")

    # Per-fact top-K filtering
    max_projected_neighbors = 30
    fact_projected_neighbors: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for (fid_a, fid_b), shared_count in projection_edge_counts.items():
        w = min(0.2 + 0.1 * (shared_count - 1), 0.8)
        fact_projected_neighbors[fid_a].append((fid_b, w))
        fact_projected_neighbors[fid_b].append((fid_a, w))

    filtered_projection_edges: dict[tuple[str, str], float] = {}
    for fid, neighbors in fact_projected_neighbors.items():
        neighbors.sort(key=lambda x: -x[1])
        kept = neighbors[:max_projected_neighbors]
        for neighbor_id, w in kept:
            if w < 0.2:
                continue
            pair = tuple(sorted([fid, neighbor_id]))
            if pair not in filtered_projection_edges or w > filtered_projection_edges[pair]:
                filtered_projection_edges[pair] = w

    print(f"  Per-fact top-K filtering: {len(projection_edge_counts)} → "
          f"{len(filtered_projection_edges)} edges")

    for (fid_a, fid_b), w in filtered_projection_edges.items():
        idx_a = id_to_idx.get(fid_a)
        idx_b = id_to_idx.get(fid_b)
        if idx_a is not None and idx_b is not None:
            edge_list.append((idx_a, idx_b))
            weights.append(w)

    if not edge_list:
        print("  No edges for fact community detection. Skipping.")
        return None, fact_ids, fact_texts

    g = ig.Graph(n=len(fact_ids))
    g.add_edges(edge_list)
    g.es["weight"] = weights
    g.simplify(combine_edges={"weight": "max"})

    print(f"  Fact graph: {g.vcount()} nodes, {g.ecount()} edges")
    return g, fact_ids, fact_texts


def detect_fact_communities_multi(
    sqlite: SQLiteStore,
    min_community_size: int = 3,
) -> dict[str, dict[str, int]]:
    """Run Leiden at 4 resolution levels on fact graph.

    Returns:
        {level_name: {fact_id: community_id}} for L0, L1, L2, L3
    """
    import leidenalg

    g, fact_ids, fact_texts = _build_fact_graph(sqlite)  # noqa: RUF059
    if g is None:
        return {level: {} for level in RESOLUTIONS}

    results = {}
    for level_name, resolution in RESOLUTIONS.items():
        print(f"\n  [{level_name}] Running Leiden on facts (resolution={resolution})...")
        partition = leidenalg.find_partition(
            g,
            leidenalg.RBConfigurationVertexPartition,
            weights="weight",
            resolution_parameter=resolution,
            n_iterations=10,
        )

        communities = {}
        valid_communities = 0
        for comm_idx, members in enumerate(partition):
            if len(members) >= min_community_size:
                for node_idx in members:
                    communities[fact_ids[node_idx]] = valid_communities
                valid_communities += 1

        results[level_name] = communities
        print(f"    {valid_communities} communities, "
              f"{len(communities)}/{len(fact_ids)} facts assigned")

        if communities:
            comm_sizes = defaultdict(int)
            for cid in communities.values():
                comm_sizes[cid] += 1
            sizes = sorted(comm_sizes.values(), reverse=True)
            print(f"    Largest: {sizes[0]}, median: {sizes[len(sizes)//2]}, "
                  f"smallest: {sizes[-1]}")

    _print_nesting_quality(results, "fact")

    return results


def _print_nesting_quality(
    results: dict[str, dict[str, int]],
    node_type: str,
):
    """Check and print nesting quality between adjacent resolution levels."""
    levels = list(RESOLUTIONS.keys())
    for i in range(len(levels) - 1):
        coarse = levels[i]
        fine = levels[i + 1]
        coarse_map = results[coarse]
        fine_map = results[fine]

        # For each fine community, check if all its members are in the same coarse community
        fine_to_coarse = defaultdict(lambda: defaultdict(int))
        for node_id, fine_cid in fine_map.items():
            coarse_cid = coarse_map.get(node_id)
            if coarse_cid is not None:
                fine_to_coarse[fine_cid][coarse_cid] += 1

        contained = 0
        total_fine = len(fine_to_coarse)
        for fine_cid, coarse_counts in fine_to_coarse.items():
            total_members = sum(coarse_counts.values())
            max_in_one = max(coarse_counts.values())
            if max_in_one / total_members >= 0.9:  # 90%+ in one coarse community
                contained += 1

        if total_fine > 0:
            pct = contained / total_fine * 100
            print(f"  Nesting {coarse}→{fine}: {pct:.0f}% containment "
                  f"({contained}/{total_fine} {node_type} communities)")


# ── Legacy single-resolution functions (kept for backwards compat) ──────────

def detect_entity_communities(
    sqlite: SQLiteStore,
    resolution: float = 1.0,
    min_community_size: int = 2,
) -> dict[str, int]:
    """Single-resolution entity community detection (legacy wrapper)."""
    import leidenalg

    g, entity_ids, entity_names = _build_entity_graph(sqlite)
    if g is None:
        return {}

    partition = leidenalg.find_partition(
        g,
        leidenalg.RBConfigurationVertexPartition,
        weights="weight",
        resolution_parameter=resolution,
        n_iterations=10,
    )

    communities = {}
    valid_communities = 0
    for comm_idx, members in enumerate(partition):
        if len(members) >= min_community_size:
            for node_idx in members:
                communities[entity_ids[node_idx]] = valid_communities
            valid_communities += 1

    print(f"  Found {valid_communities} communities "
          f"(resolution={resolution}, min_size={min_community_size})")
    print(f"  Entities assigned to communities: {len(communities)}/{len(entity_ids)}")

    # Print top communities
    comm_members = defaultdict(list)
    for eid, cid in communities.items():
        comm_members[cid].append(entity_names.get(eid, eid))
    sorted_comms = sorted(comm_members.items(), key=lambda x: -len(x[1]))
    for cid, members in sorted_comms[:10]:
        sample = members[:5]
        print(f"    Community {cid} ({len(members)} members): {sample}")

    return communities


def detect_fact_communities_hdbscan(
    qdrant: QdrantStore,
    sqlite: SQLiteStore,
    min_cluster_size: int = 3,
    min_samples: int = 2,
) -> dict[str, int]:
    """Cluster facts by embedding similarity using HDBSCAN."""
    from sklearn.cluster import HDBSCAN

    print("  Loading fact embeddings for clustering...")

    all_points = []
    offset = None
    while True:
        points, next_offset = qdrant.client.scroll(
            collection_name="facts",
            limit=256,
            offset=offset,
            with_vectors=True,
            with_payload=True,
        )
        all_points.extend(points)
        if next_offset is None:
            break
        offset = next_offset

    if len(all_points) < min_cluster_size:
        print(f"  Only {len(all_points)} facts — too few for clustering.")
        return {}

    fact_ids = [p.payload.get("fact_id") for p in all_points]
    embeddings = np.array([p.vector for p in all_points])

    print(f"  Clustering {len(embeddings)} fact embeddings with HDBSCAN...")

    clusterer = HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric="cosine",
        cluster_selection_method="eom",
    )
    labels = clusterer.fit_predict(embeddings)

    communities = {}
    n_clusters = 0
    for fact_id, label in zip(fact_ids, labels):
        if label >= 0 and fact_id:
            communities[fact_id] = int(label)
            n_clusters = max(n_clusters, label + 1)

    noise_count = sum(1 for lbl in labels if lbl == -1)
    print(f"  Found {n_clusters} fact clusters")
    print(f"  Facts in clusters: {len(communities)}, noise: {noise_count}")

    return communities


def detect_fact_communities_leiden(
    sqlite: SQLiteStore,
    resolution: float = 1.0,
    min_community_size: int = 3,
) -> dict[str, int]:
    """Single-resolution fact community detection (legacy wrapper)."""
    import leidenalg

    g, fact_ids, fact_texts = _build_fact_graph(sqlite)  # noqa: RUF059
    if g is None:
        return {}

    partition = leidenalg.find_partition(
        g,
        leidenalg.RBConfigurationVertexPartition,
        weights="weight",
        resolution_parameter=resolution,
        n_iterations=10,
    )

    communities = {}
    valid_communities = 0
    for comm_idx, members in enumerate(partition):
        if len(members) >= min_community_size:
            for node_idx in members:
                communities[fact_ids[node_idx]] = valid_communities
            valid_communities += 1

    print(f"  Found {valid_communities} fact communities (Leiden)")
    print(f"  Facts in communities: {len(communities)}/{len(fact_ids)}")

    return communities


# ── Storage ─────────────────────────────────────────────────────────────────

def store_community_assignments(
    sqlite: SQLiteStore,
    entity_communities: dict[str, int],
    fact_topic_clusters: dict[str, int],
    fact_leiden_communities: dict[str, int],
):
    """Store single-resolution community assignments (legacy)."""
    _ensure_legacy_columns(sqlite)

    if entity_communities:
        sqlite.sql_conn.executemany(
            "UPDATE entities SET community_id = ? WHERE id = ?",
            [(cid, eid) for eid, cid in entity_communities.items()]
        )
        sqlite.sql_conn.commit()
        print(f"  Stored {len(entity_communities)} entity community assignments")

    if fact_topic_clusters:
        sqlite.sql_conn.executemany(
            "UPDATE facts SET topic_cluster_id = ? WHERE id = ?",
            [(cid, fid) for fid, cid in fact_topic_clusters.items()]
        )
        sqlite.sql_conn.commit()
        print(f"  Stored {len(fact_topic_clusters)} fact topic cluster assignments")

    if fact_leiden_communities:
        sqlite.sql_conn.executemany(
            "UPDATE facts SET similarity_cluster_id = ? WHERE id = ?",
            [(cid, fid) for fid, cid in fact_leiden_communities.items()]
        )
        sqlite.sql_conn.commit()
        print(f"  Stored {len(fact_leiden_communities)} fact similarity cluster assignments")


def store_multi_resolution_communities(
    sqlite: SQLiteStore,
    entity_communities: dict[str, dict[str, int]],
    fact_communities: dict[str, dict[str, int]],
    fact_topic_clusters: dict[str, int] | None = None,
):
    """Store multi-resolution community assignments.

    Args:
        entity_communities: {L0: {entity_id: cid}, L1: ..., L2: ..., L3: ...}
        fact_communities: {L0: {fact_id: cid}, L1: ..., L2: ..., L3: ...}
        fact_topic_clusters: optional HDBSCAN topic clusters (single level)
    """
    # Ensure all columns exist
    for level in RESOLUTIONS:
        col = f"community_{level}"
        try:
            sqlite.sql_conn.execute(f"ALTER TABLE entities ADD COLUMN {col} INTEGER")
        except Exception:  # noqa: BLE001, S110
            pass
        try:
            sqlite.sql_conn.execute(f"ALTER TABLE facts ADD COLUMN {col} INTEGER")
        except Exception:  # noqa: BLE001, S110
            pass

    # Legacy columns too (backwards compat)
    _ensure_legacy_columns(sqlite)
    sqlite.sql_conn.commit()

    # Clear existing multi-resolution values
    for level in RESOLUTIONS:
        col = f"community_{level}"
        sqlite.sql_conn.execute(f"UPDATE entities SET {col} = NULL")
        sqlite.sql_conn.execute(f"UPDATE facts SET {col} = NULL")
    sqlite.sql_conn.commit()

    # Store entity communities at each level
    total_entity = 0
    for level, mapping in entity_communities.items():
        if mapping:
            col = f"community_{level}"
            sqlite.sql_conn.executemany(
                f"UPDATE entities SET {col} = ? WHERE id = ?",
                [(cid, eid) for eid, cid in mapping.items()]
            )
            total_entity += len(mapping)
    sqlite.sql_conn.commit()
    print(f"  Stored entity community assignments across 4 levels ({total_entity} total)")

    # Store fact communities at each level
    total_fact = 0
    for level, mapping in fact_communities.items():
        if mapping:
            col = f"community_{level}"
            sqlite.sql_conn.executemany(
                f"UPDATE facts SET {col} = ? WHERE id = ?",
                [(cid, fid) for fid, cid in mapping.items()]
            )
            total_fact += len(mapping)
    sqlite.sql_conn.commit()
    print(f"  Stored fact community assignments across 4 levels ({total_fact} total)")

    # Also store L1 as the legacy community_id / similarity_cluster_id
    if entity_communities.get("L1"):
        sqlite.sql_conn.executemany(
            "UPDATE entities SET community_id = ? WHERE id = ?",
            [(cid, eid) for eid, cid in entity_communities["L1"].items()]
        )
        sqlite.sql_conn.commit()

    if fact_communities.get("L1"):
        sqlite.sql_conn.executemany(
            "UPDATE facts SET similarity_cluster_id = ? WHERE id = ?",
            [(cid, fid) for fid, cid in fact_communities["L1"].items()]
        )
        sqlite.sql_conn.commit()

    # Store HDBSCAN topic clusters
    if fact_topic_clusters:
        sqlite.sql_conn.execute("UPDATE facts SET topic_cluster_id = NULL")
        sqlite.sql_conn.executemany(
            "UPDATE facts SET topic_cluster_id = ? WHERE id = ?",
            [(cid, fid) for fid, cid in fact_topic_clusters.items()]
        )
        sqlite.sql_conn.commit()
        print(f"  Stored {len(fact_topic_clusters)} fact topic cluster assignments (HDBSCAN)")


def _existing_community_columns(sqlite, table: str) -> list[str]:
    """Levels whose ``community_{level}`` column exists on ``table``.

    Args:
        sqlite: Store exposing ``sql_conn``.
        table: ``"entities"`` or ``"facts"``.

    Returns:
        Level names (subset of :data:`RESOLUTIONS`) present as columns, in
        L0..L3 order.
    """
    cols = {
        r[1] for r in sqlite.sql_conn.execute(f"PRAGMA table_info({table})").fetchall()
    }
    return [lvl for lvl in RESOLUTIONS if f"community_{lvl}" in cols]


def _summary_lookup(sqlite) -> dict[tuple[str, str, int], tuple[str, list[str]]]:
    """Best-effort (node_type, level, cluster_id) -> (summary, tags) map.

    Reconciles the pre-existing ``community_summaries`` table onto the reified
    Community rows so a summarization run that already happened is not lost when
    the projection rewrites them. Missing/garbled rows are skipped rather than
    failing the projection: summaries are enrichment, memberships are not. That
    includes the row's *identity* — a NULL/non-integer ``community_id`` cannot be
    matched to any assignment cell, so it is dropped instead of aborting the whole
    Community upsert + ``COMM_MEMBER`` rebuild.
    """
    out: dict[tuple[str, str, int], tuple[str, list[str]]] = {}
    rows = sqlite.sql_conn.execute(
        "SELECT node_type, level, community_id, summary, tags FROM community_summaries"
    ).fetchall()
    for r in rows:
        try:
            key = (r[0], r[1], int(r[2]))
        except (TypeError, ValueError):
            continue  # unusable identity: skip this enrichment row
        try:
            tags = json.loads(r[4]) if r[4] else []
        except (TypeError, ValueError):
            tags = []
        out[key] = (
            r[3] or "",
            tags if isinstance(tags, list) else [],
        )
    return out


def project_community_membership_edges(sqlite, *, batch_size: int = 5000):
    """Derive Community rows + ``COMM_MEMBER`` edges from the assignment columns.

    The ``community_L0..L3`` columns on entities/facts stay the source of truth;
    this is their projection into the graph, so node→community traversal has real
    nodes and edges to walk. Runs right after
    :func:`store_multi_resolution_communities`.

    Because re-clustering reshuffles memberships wholesale, the ``COMM_MEMBER``
    edge set is **deleted and rebuilt** (no row-level diffing) scoped to
    ``edge_type = 'COMM_MEMBER'``, so a run never leaves a mix of stale and fresh
    membership and no other edge type is touched. One edge per (node, level)
    assignment carries its level in ``properties["level"]``. On SQLite the rebuild
    is one transaction; on other backends it is best-effort — see
    :func:`_rebuild_comm_member_edges`.

    Args:
        sqlite: Store to read assignments from and write the projection to.
        batch_size: Edge rows per executemany/insert batch.

    Returns:
        ``(n_communities, n_edges)`` actually projected.
    """
    member_counts: dict[tuple[str, str, int], int] = defaultdict(int)
    edges: list[Edge] = []

    for node_type, table in (("entity", "entities"), ("fact", "facts")):
        for level in _existing_community_columns(sqlite, table):
            col = f"community_{level}"
            rows = sqlite.sql_conn.execute(
                f"SELECT id, {col} FROM {table} WHERE {col} IS NOT NULL"
            ).fetchall()
            for node_id, cid in rows:
                cid = int(cid)
                member_counts[(node_type, level, cid)] += 1
                edges.append(
                    Edge(
                        source_type=node_type,
                        source_id=node_id,
                        target_type="community",
                        target_id=community_id_from(node_type, level, cid),
                        edge_type=EdgeType.COMM_MEMBER,
                        properties={"level": level},
                    )
                )

    summaries = _summary_lookup(sqlite)
    communities = [
        Community(
            id=community_id_from(node_type, level, cid),
            level=level,
            node_type=node_type,
            summary=summaries.get((node_type, level, cid), ("", []))[0],
            tags=summaries.get((node_type, level, cid), ("", []))[1],
            member_count=count,
        )
        for (node_type, level, cid), count in member_counts.items()
    ]
    sqlite.insert_communities(communities)

    _rebuild_comm_member_edges(sqlite, edges, batch_size=batch_size)
    print(
        f"  Projected {len(communities)} communities and "
        f"{len(edges)} COMM_MEMBER edges from the assignment columns"
    )
    return len(communities), len(edges)


def _rebuild_comm_member_edges(sqlite, edges: list[Edge], *, batch_size: int) -> None:
    """Delete every ``COMM_MEMBER`` edge and re-insert ``edges``.

    For the SQLite backend the whole delete+rebuild runs as one transaction on the
    raw connection: the store's own ``delete_edges``/``insert_edges`` commit per
    call, which would expose a window with no memberships at all. Other backends
    (LadybugDB keeps edges in the graph, not the ``edges`` table) go through the
    normal dual-write ABC path, which is the only way to reach their edge store.

    Atomicity therefore differs by backend:

    - ``SQLiteStore``: atomic. Delete + all insert batches commit or roll back
      together, so a reader never sees a partial membership projection.
    - generic ABC fallback: **best-effort, not atomic.** ``delete_edges`` commits
      before the inserts, so a crash/failure mid-rebuild can leave the
      ``COMM_MEMBER`` projection empty or partial. It is derived state, so the
      repair is to re-run periodic improvement (rebuild, never migrate). Insert
      failures are deliberately **not** swallowed here: they propagate so the
      operator sees a loud failure instead of a silently half-empty projection.

    Args:
        sqlite: Store to rewrite the projection in.
        edges: The full fresh ``COMM_MEMBER`` edge set.
        batch_size: Rows per batch.

    Raises:
        Exception: Whatever the backend raises on delete/insert, re-raised as-is
            (fallback path) so a partial rebuild is never reported as success.
    """
    if isinstance(sqlite, SQLiteStore):
        conn = sqlite.sql_conn
        with conn:  # single transaction: no window without memberships
            conn.execute("DELETE FROM edges WHERE edge_type = ?", ("COMM_MEMBER",))
            for i in range(0, len(edges), batch_size):
                conn.executemany(
                    """INSERT OR IGNORE INTO edges
                       (source_type, source_id, target_type, target_id, edge_type, properties)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    [
                        (
                            e.source_type,
                            e.source_id,
                            e.target_type,
                            e.target_id,
                            e.edge_type.value,
                            json.dumps(e.properties) if e.properties else None,
                        )
                        for e in edges[i : i + batch_size]
                    ],
                )
        return

    # Non-atomic fallback: the delete is already committed once we get here, so an
    # insert failure leaves a partial projection. Let it propagate — a loud error
    # plus a re-run of improve is safer than pretending the rebuild succeeded.
    sqlite.delete_edges(edge_type=EdgeType.COMM_MEMBER.value)
    for i in range(0, len(edges), batch_size):
        sqlite.insert_edges(edges[i : i + batch_size])


def _ensure_legacy_columns(sqlite: SQLiteStore):
    """Ensure legacy single-resolution columns exist."""
    try:
        sqlite.sql_conn.execute("ALTER TABLE entities ADD COLUMN community_id INTEGER")
    except Exception:  # noqa: BLE001, S110
        pass
    try:
        sqlite.sql_conn.execute("ALTER TABLE facts ADD COLUMN topic_cluster_id INTEGER")
    except Exception:  # noqa: BLE001, S110
        pass
    try:
        sqlite.sql_conn.execute("ALTER TABLE facts ADD COLUMN similarity_cluster_id INTEGER")
    except Exception:  # noqa: BLE001, S110
        pass
    sqlite.sql_conn.commit()
