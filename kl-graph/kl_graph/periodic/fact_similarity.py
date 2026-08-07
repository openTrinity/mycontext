"""Build FACT_SIMILAR edges between facts using embedding cosine similarity.

Optimized approach: load all fact vectors into memory, use numpy batch
operations to find similar pairs. Much faster than individual ANN queries
for local Qdrant (which doesn't parallelize well).

For 17K facts × 4096 dim: ~1.1GB RAM for vectors, but chunked processing
keeps peak memory manageable.
"""

from __future__ import annotations

import numpy as np
from tqdm import tqdm

from kl_graph.models.types import Edge, EdgeType
from kl_graph.storage.base import KnowledgeStore
from kl_graph.storage.qdrant_store import QdrantStore


def build_fact_similarity_edges(
    qdrant: QdrantStore,
    store: KnowledgeStore,
    threshold: float = 0.85,
    max_neighbors: int = 10,
    chunk_size: int = 500,
) -> int:
    """Find similar fact pairs using chunked cosine similarity.

    Loads all vectors, normalizes, then computes dot products in chunks
    to find pairs above threshold. Much faster than 17K individual ANN queries.

    Args:
        qdrant: Qdrant store with "facts" collection populated
        store: KnowledgeStore with facts and edges tables
        threshold: Minimum cosine similarity to create an edge
        max_neighbors: Max edges per fact (top-K)
        chunk_size: Rows per chunk for matrix multiply

    Returns:
        Number of FACT_SIMILAR edges created
    """
    print("  Loading fact vectors from Qdrant...")
    facts_count = qdrant.count("facts")
    print(f"  Total facts in Qdrant: {facts_count}")

    if facts_count == 0:
        print("  No facts to compare. Skipping.")
        return 0

    # Scroll all facts to get vectors and IDs
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

    print(f"  Retrieved {len(all_points)} fact vectors")

    # Extract fact IDs and build normalized matrix
    fact_ids = [p.payload.get("fact_id") for p in all_points]
    vectors = np.array([p.vector for p in all_points], dtype=np.float32)

    # L2-normalize for cosine similarity via dot product
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vectors_norm = vectors / norms

    # Free raw vectors
    del vectors

    n = len(fact_ids)
    print(f"  Computing pairwise similarities in chunks of {chunk_size}...")

    new_edges = []
    seen_pairs = set()

    # Process in chunks to avoid O(n²) memory
    for i in tqdm(range(0, n, chunk_size), desc="  Fact FACT_SIMILAR"):
        chunk = vectors_norm[i : i + chunk_size]  # (chunk_size, dim)

        # Compute similarities: chunk × all^T → (chunk_size, n)
        sims = chunk @ vectors_norm.T

        # For each row in chunk, find columns above threshold
        for local_idx in range(len(chunk)):
            global_idx = i + local_idx
            row = sims[local_idx]

            # Mask self
            row[global_idx] = 0.0

            # Find indices above threshold
            above = np.where(row >= threshold)[0]

            if len(above) == 0:
                continue

            # Sort by score descending, take top-K
            scores = row[above]
            if len(above) > max_neighbors:
                top_k_local = np.argsort(scores)[-max_neighbors:]
                above = above[top_k_local]
                scores = scores[top_k_local]

            src_id = fact_ids[global_idx]
            if not src_id:
                continue

            for j, score in zip(above, scores):
                tgt_id = fact_ids[j]
                if not tgt_id:
                    continue

                # Deduplicate bidirectional
                pair_key = tuple(sorted([src_id, tgt_id]))
                if pair_key in seen_pairs:
                    continue
                seen_pairs.add(pair_key)

                new_edges.append(
                    Edge(
                        source_type="fact",
                        source_id=src_id,
                        target_type="fact",
                        target_id=tgt_id,
                        edge_type=EdgeType.FACT_SIMILAR,
                        properties={"score": round(float(score), 4)},
                    )
                )

    # Bulk insert
    if new_edges:
        print(f"  Inserting {len(new_edges)} fact FACT_SIMILAR edges...")
        batch_size = 5000
        for i in range(0, len(new_edges), batch_size):
            store.insert_edges(new_edges[i : i + batch_size])

    print(
        f"  Done: {len(new_edges)} fact FACT_SIMILAR edges created (threshold={threshold})"
    )
    return len(new_edges)
