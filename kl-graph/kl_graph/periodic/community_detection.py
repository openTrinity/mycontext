"""Multi-resolution community detection for entities and facts.

Entity communities: Leiden algorithm on the projected entity graph.
  - Edges: SIMILAR_TO + co-mention (entities appearing in same message)
  - 4 resolution levels for hierarchical drill-down (L0-L3)

Fact communities: Two methods available:
  1. HDBSCAN on fact embeddings (topical clusters)
  2. Multi-resolution Leiden on fact SIMILAR_TO graph augmented with shared-entity projections

All levels are stored as community_L{0,1,2,3} columns in SQLite.
"""

from __future__ import annotations

import json
from collections import defaultdict

import numpy as np
from tqdm import tqdm

from kl_graph.models.types import EdgeType
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
    """Build the entity graph from SIMILAR_TO + co-mention edges.

    Returns:
        (igraph.Graph, entity_ids list, entity_names dict)
    """
    import igraph as ig

    # Get all entities
    rows = sqlite.conn.execute("SELECT id, name FROM entities").fetchall()
    entity_ids = [r[0] for r in rows]
    entity_names = {r[0]: r[1] for r in rows}
    id_to_idx = {eid: i for i, eid in enumerate(entity_ids)}

    print(f"  Building entity graph ({len(entity_ids)} nodes)...")

    edge_list = []
    weights = []

    # Add SIMILAR_TO edges
    similar_edges = sqlite.conn.execute(
        """SELECT source_id, target_id, properties FROM edges
           WHERE edge_type = 'SIMILAR_TO'
             AND source_type = 'entity' AND target_type = 'entity'"""
    ).fetchall()

    for row in similar_edges:
        src_idx = id_to_idx.get(row[0])
        tgt_idx = id_to_idx.get(row[1])
        if src_idx is not None and tgt_idx is not None:
            edge_list.append((src_idx, tgt_idx))
            props = json.loads(row[2]) if row[2] else {}
            weights.append(props.get("hybrid_score", props.get("confidence", 0.5)))

    # Add co-mention edges (entities appearing in same message)
    print("  Computing co-mention edges...")
    entity_messages = defaultdict(set)
    mention_rows = sqlite.conn.execute(
        """SELECT target_id, source_id FROM edges
           WHERE edge_type IN ('MENTIONS', 'SENT_BY')
             AND source_type = 'message' AND target_type = 'entity'"""
    ).fetchall()
    for row in mention_rows:
        entity_messages[row[0]].add(row[1])

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

    g, entity_ids, entity_names = _build_entity_graph(sqlite)
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
    """Build the fact graph from SIMILAR_TO + shared-entity projection.

    Returns:
        (igraph.Graph, fact_ids list, fact_texts dict)
    """
    import igraph as ig

    rows = sqlite.conn.execute("SELECT id, text FROM facts").fetchall()
    fact_ids = [r[0] for r in rows]
    fact_texts = {r[0]: r[1] for r in rows}
    id_to_idx = {fid: i for i, fid in enumerate(fact_ids)}

    print(f"  Building fact graph ({len(fact_ids)} nodes)...")

    edge_list = []
    weights = []

    # Add SIMILAR_TO edges between facts
    similar_edges = sqlite.conn.execute(
        """SELECT source_id, target_id, properties FROM edges
           WHERE edge_type = 'SIMILAR_TO'
             AND source_type = 'fact' AND target_type = 'fact'"""
    ).fetchall()

    for row in similar_edges:
        src_idx = id_to_idx.get(row[0])
        tgt_idx = id_to_idx.get(row[1])
        if src_idx is not None and tgt_idx is not None:
            edge_list.append((src_idx, tgt_idx))
            props = json.loads(row[2]) if row[2] else {}
            weights.append(props.get("score", 0.5))

    # Add shared-entity projection edges
    print("  Computing shared-entity projection...")
    entity_to_facts = defaultdict(set)
    fact_to_entities = defaultdict(set)
    about_rows = sqlite.conn.execute(
        """SELECT source_id, target_id FROM edges
           WHERE edge_type = 'ABOUT'
             AND source_type = 'fact' AND target_type = 'entity'"""
    ).fetchall()
    for row in about_rows:
        entity_to_facts[row[1]].add(row[0])
        fact_to_entities[row[0]].add(row[1])

    max_facts_per_entity = 200
    projection_edge_counts = defaultdict(int)

    projected_entities = 0
    skipped_entities = 0
    for entity_id, facts in entity_to_facts.items():
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

    g, fact_ids, fact_texts = _build_fact_graph(sqlite)
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

    noise_count = sum(1 for l in labels if l == -1)
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

    g, fact_ids, fact_texts = _build_fact_graph(sqlite)
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
        sqlite.conn.executemany(
            "UPDATE entities SET community_id = ? WHERE id = ?",
            [(cid, eid) for eid, cid in entity_communities.items()]
        )
        sqlite.conn.commit()
        print(f"  Stored {len(entity_communities)} entity community assignments")

    if fact_topic_clusters:
        sqlite.conn.executemany(
            "UPDATE facts SET topic_cluster_id = ? WHERE id = ?",
            [(cid, fid) for fid, cid in fact_topic_clusters.items()]
        )
        sqlite.conn.commit()
        print(f"  Stored {len(fact_topic_clusters)} fact topic cluster assignments")

    if fact_leiden_communities:
        sqlite.conn.executemany(
            "UPDATE facts SET similarity_cluster_id = ? WHERE id = ?",
            [(cid, fid) for fid, cid in fact_leiden_communities.items()]
        )
        sqlite.conn.commit()
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
            sqlite.conn.execute(f"ALTER TABLE entities ADD COLUMN {col} INTEGER")
        except Exception:
            pass
        try:
            sqlite.conn.execute(f"ALTER TABLE facts ADD COLUMN {col} INTEGER")
        except Exception:
            pass

    # Legacy columns too (backwards compat)
    _ensure_legacy_columns(sqlite)
    sqlite.conn.commit()

    # Clear existing multi-resolution values
    for level in RESOLUTIONS:
        col = f"community_{level}"
        sqlite.conn.execute(f"UPDATE entities SET {col} = NULL")
        sqlite.conn.execute(f"UPDATE facts SET {col} = NULL")
    sqlite.conn.commit()

    # Store entity communities at each level
    total_entity = 0
    for level, mapping in entity_communities.items():
        if mapping:
            col = f"community_{level}"
            sqlite.conn.executemany(
                f"UPDATE entities SET {col} = ? WHERE id = ?",
                [(cid, eid) for eid, cid in mapping.items()]
            )
            total_entity += len(mapping)
    sqlite.conn.commit()
    print(f"  Stored entity community assignments across 4 levels ({total_entity} total)")

    # Store fact communities at each level
    total_fact = 0
    for level, mapping in fact_communities.items():
        if mapping:
            col = f"community_{level}"
            sqlite.conn.executemany(
                f"UPDATE facts SET {col} = ? WHERE id = ?",
                [(cid, fid) for fid, cid in mapping.items()]
            )
            total_fact += len(mapping)
    sqlite.conn.commit()
    print(f"  Stored fact community assignments across 4 levels ({total_fact} total)")

    # Also store L1 as the legacy community_id / similarity_cluster_id
    if "L1" in entity_communities and entity_communities["L1"]:
        sqlite.conn.executemany(
            "UPDATE entities SET community_id = ? WHERE id = ?",
            [(cid, eid) for eid, cid in entity_communities["L1"].items()]
        )
        sqlite.conn.commit()

    if "L1" in fact_communities and fact_communities["L1"]:
        sqlite.conn.executemany(
            "UPDATE facts SET similarity_cluster_id = ? WHERE id = ?",
            [(cid, fid) for fid, cid in fact_communities["L1"].items()]
        )
        sqlite.conn.commit()

    # Store HDBSCAN topic clusters
    if fact_topic_clusters:
        sqlite.conn.execute("UPDATE facts SET topic_cluster_id = NULL")
        sqlite.conn.executemany(
            "UPDATE facts SET topic_cluster_id = ? WHERE id = ?",
            [(cid, fid) for fid, cid in fact_topic_clusters.items()]
        )
        sqlite.conn.commit()
        print(f"  Stored {len(fact_topic_clusters)} fact topic cluster assignments (HDBSCAN)")


def _ensure_legacy_columns(sqlite: SQLiteStore):
    """Ensure legacy single-resolution columns exist."""
    try:
        sqlite.conn.execute("ALTER TABLE entities ADD COLUMN community_id INTEGER")
    except Exception:
        pass
    try:
        sqlite.conn.execute("ALTER TABLE facts ADD COLUMN topic_cluster_id INTEGER")
    except Exception:
        pass
    try:
        sqlite.conn.execute("ALTER TABLE facts ADD COLUMN similarity_cluster_id INTEGER")
    except Exception:
        pass
    sqlite.conn.commit()
