"""Build SIMILAR_TO edges between entities using hybrid metrics.

Combines:
  1. Embedding similarity (name embeddings)
  2. Structural co-occurrence (Jaccard on shared messages)
  3. Shared fact participation

Optimized: uses numpy batch cosine for embedding pre-filter instead
of individual ANN queries.
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np
from tqdm import tqdm

from kl_graph.models.types import Edge, EdgeType
from kl_graph.storage.qdrant_store import QdrantStore
from kl_graph.storage.sqlite_store import SQLiteStore


def jaccard(set_a: set, set_b: set) -> float:
    """Jaccard similarity between two sets."""
    if not set_a or not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union > 0 else 0.0


def overlap_coefficient(set_a: set, set_b: set) -> float:
    """Overlap coefficient: |A∩B| / min(|A|, |B|)."""
    if not set_a or not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    min_size = min(len(set_a), len(set_b))
    return intersection / min_size if min_size > 0 else 0.0


def build_entity_similarity_edges(
    qdrant: QdrantStore,
    sqlite: SQLiteStore,
    embedding_threshold: float = 0.65,
    hybrid_threshold: float = 0.45,
    max_candidates: int = 20,
    weight_embedding: float = 0.3,
    weight_structural: float = 0.4,
    weight_facts: float = 0.3,
    chunk_size: int = 200,
) -> int:
    """Build entity SIMILAR_TO edges using hybrid metrics.

    Optimized: batch cosine similarity for pre-filter, then hybrid scoring
    on candidates above embedding_threshold.

    Args:
        qdrant: Qdrant store with "entities" collection
        sqlite: SQLite store with entities, edges tables
        embedding_threshold: Minimum embedding score for pre-filter
        hybrid_threshold: Minimum hybrid score for final edge creation
        max_candidates: Number of candidates per entity (top-K from embeddings)
        weight_embedding: Weight for embedding similarity
        weight_structural: Weight for structural co-occurrence
        weight_facts: Weight for shared fact participation
        chunk_size: Rows per chunk for matrix multiply

    Returns:
        Number of SIMILAR_TO edges created
    """
    print("  Loading entity vectors from Qdrant...")
    entities_count = qdrant.count("entities")
    print(f"  Total entities in Qdrant: {entities_count}")

    if entities_count == 0:
        print("  No entities to compare. Skipping.")
        return 0

    # Scroll all entity points
    all_points = []
    offset = None
    while True:
        points, next_offset = qdrant.client.scroll(
            collection_name="entities",
            limit=256,
            offset=offset,
            with_vectors=True,
            with_payload=True,
        )
        all_points.extend(points)
        if next_offset is None:
            break
        offset = next_offset

    print(f"  Retrieved {len(all_points)} entity vectors")

    # Extract IDs and build normalized matrix
    entity_ids = [p.payload.get("entity_id") for p in all_points]
    vectors = np.array([p.vector for p in all_points], dtype=np.float32)

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vectors_norm = vectors / norms
    del vectors

    # Pre-compute message sets and fact sets
    print("  Pre-computing message and fact sets...")
    msg_sets: dict[str, set] = {}
    fact_sets: dict[str, set] = {}

    # Batch load: entity → messages (via MENTIONS/SENT_BY edges)
    mention_rows = sqlite.conn.execute(
        """SELECT target_id, source_id FROM edges
           WHERE target_type = 'entity'
             AND edge_type IN ('MENTIONS', 'SENT_BY')
             AND source_type = 'message'"""
    ).fetchall()
    for row in mention_rows:
        msg_sets.setdefault(row[0], set()).add(row[1])

    # Batch load: entity → facts (via ABOUT edges)
    about_rows = sqlite.conn.execute(
        """SELECT target_id, source_id FROM edges
           WHERE target_type = 'entity'
             AND edge_type = 'ABOUT'
             AND source_type = 'fact'"""
    ).fetchall()
    for row in about_rows:
        fact_sets.setdefault(row[0], set()).add(row[1])

    print(f"  Entities with messages: {len(msg_sets)}, with facts: {len(fact_sets)}")

    # Chunked cosine similarity + hybrid scoring
    n = len(entity_ids)
    new_edges = []
    seen_pairs = set()

    print(f"  Computing hybrid similarity in chunks of {chunk_size}...")

    for i in tqdm(range(0, n, chunk_size), desc="  Entity SIMILAR_TO"):
        chunk = vectors_norm[i:i + chunk_size]

        # Compute similarities: chunk × all^T
        sims = chunk @ vectors_norm.T

        for local_idx in range(len(chunk)):
            global_idx = i + local_idx
            row = sims[local_idx]

            # Mask self
            row[global_idx] = -1.0

            # Find candidates above embedding threshold
            above = np.where(row >= embedding_threshold)[0]

            if len(above) == 0:
                continue

            # Sort by embedding score, take top-K candidates
            scores = row[above]
            if len(above) > max_candidates:
                top_k_local = np.argsort(scores)[-max_candidates:]
                above = above[top_k_local]
                scores = scores[top_k_local]

            src_id = entity_ids[global_idx]
            if not src_id:
                continue

            src_msgs = msg_sets.get(src_id, set())
            src_facts = fact_sets.get(src_id, set())

            for j, emb_score in zip(above, scores):
                tgt_id = entity_ids[j]
                if not tgt_id:
                    continue

                # Deduplicate
                pair_key = tuple(sorted([src_id, tgt_id]))
                if pair_key in seen_pairs:
                    continue

                # Hybrid scoring
                tgt_msgs = msg_sets.get(tgt_id, set())
                tgt_facts = fact_sets.get(tgt_id, set())

                struct_score = jaccard(src_msgs, tgt_msgs)
                fact_score = overlap_coefficient(src_facts, tgt_facts)

                hybrid = (weight_embedding * float(emb_score) +
                          weight_structural * struct_score +
                          weight_facts * fact_score)

                if hybrid >= hybrid_threshold:
                    seen_pairs.add(pair_key)
                    new_edges.append(Edge(
                        source_type="entity",
                        source_id=src_id,
                        target_type="entity",
                        target_id=tgt_id,
                        edge_type=EdgeType.SIMILAR_TO,
                        properties={
                            "embedding_score": round(float(emb_score), 4),
                            "structural_score": round(struct_score, 4),
                            "fact_score": round(fact_score, 4),
                            "hybrid_score": round(hybrid, 4),
                        },
                    ))

    # Bulk insert
    if new_edges:
        print(f"  Inserting {len(new_edges)} entity SIMILAR_TO edges...")
        batch_size = 5000
        for i in range(0, len(new_edges), batch_size):
            sqlite.insert_edges(new_edges[i:i + batch_size])

    print(f"  Done: {len(new_edges)} entity SIMILAR_TO edges created")
    print(f"  (embedding_threshold={embedding_threshold}, hybrid_threshold={hybrid_threshold})")
    return len(new_edges)
