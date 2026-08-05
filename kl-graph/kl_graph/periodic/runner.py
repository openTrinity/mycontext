"""Periodic improvement phase runner.

Orchestrates:
  1. Fact SIMILAR_TO edges (embedding similarity)
  2. Entity SIMILAR_TO edges (hybrid metrics)
  3. Entity disambiguation (pinyin + hybrid + LLM judge)
  4. Entity community detection (Leiden)
  5. Fact community detection (HDBSCAN + Leiden)

Run this after ingestion (Phase B) completes.
Steps 1-2, 4-5 are O(n) with no LLM calls.
Step 3 uses limited LLM budget (~200-500 calls) for ambiguous pairs.
"""

from __future__ import annotations

import time

from kl_graph.config import QDRANT_PATH, SQLITE_PATH
from kl_graph.storage.qdrant_store import QdrantStore
from kl_graph.storage.sqlite_store import SQLiteStore

from kl_graph.periodic.community_detection import (
    detect_entity_communities,
    detect_entity_communities_multi,
    detect_fact_communities_hdbscan,
    detect_fact_communities_leiden,
    detect_fact_communities_multi,
    store_community_assignments,
    store_multi_resolution_communities,
)
from kl_graph.periodic.entity_disambiguation import run_entity_disambiguation
from kl_graph.periodic.entity_similarity import build_entity_similarity_edges
from kl_graph.periodic.fact_similarity import build_fact_similarity_edges


def run_periodic_improvement(
    sqlite_path=SQLITE_PATH,
    qdrant_path=QDRANT_PATH,
    *,
    sqlite: "SQLiteStore | None" = None,
    qdrant: "QdrantStore | None" = None,
    # Fact similarity params
    fact_sim_threshold: float = 0.85,
    # Entity similarity params
    entity_emb_threshold: float = 0.65,
    entity_hybrid_threshold: float = 0.45,
    # Community params
    entity_resolution: float = 2.0,
    fact_resolution: float = 1.5,
    fact_min_cluster_size: int = 5,
    # Entity disambiguation
    run_disambiguation: bool = True,
    skip_llm_judge: bool = False,
    llm_max_budget: int = 500,
):
    """Run the full periodic improvement phase.

    This should be run after ingestion completes. It can also be re-run
    with different parameters to experiment with graph configurations.
    """
    t0 = time.time()
    print("=" * 60)
    print("PERIODIC IMPROVEMENT PHASE")
    print("=" * 60)

    # Reuse injected stores (e.g. from kl-server) or open our own.
    _owns_stores = sqlite is None and qdrant is None
    if sqlite is None:
        sqlite = SQLiteStore(sqlite_path)
    if qdrant is None:
        qdrant = QdrantStore(qdrant_path)

    try:
        # Step 1: Fact SIMILAR_TO edges
        print("\n[1/6] Building fact SIMILAR_TO edges...")
        n_fact_edges = build_fact_similarity_edges(
            qdrant, sqlite,
            threshold=fact_sim_threshold,
        )

        # Step 2: Entity SIMILAR_TO edges
        print("\n[2/6] Building entity SIMILAR_TO edges...")
        n_entity_edges = build_entity_similarity_edges(
            qdrant, sqlite,
            embedding_threshold=entity_emb_threshold,
            hybrid_threshold=entity_hybrid_threshold,
        )

        # Step 3: Entity disambiguation (pinyin + hybrid + LLM judge → SIMILAR_TO edges)
        n_disambig_edges = 0
        if run_disambiguation:
            print("\n[3/6] Running entity disambiguation...")
            n_disambig_edges = run_entity_disambiguation(
                sqlite, qdrant,
                skip_llm=skip_llm_judge,
                llm_max_budget=llm_max_budget,
            )
        else:
            print("\n[3/6] Skipping entity disambiguation (disabled)")

        # Step 4: Multi-resolution entity community detection
        print("\n[4/6] Detecting entity communities (multi-resolution Leiden)...")
        entity_communities_multi = detect_entity_communities_multi(sqlite)

        # Step 5: Fact community detection (HDBSCAN)
        print("\n[5/6] Detecting fact topic clusters (HDBSCAN)...")
        fact_topic_clusters = detect_fact_communities_hdbscan(
            qdrant, sqlite,
            min_cluster_size=fact_min_cluster_size,
        )

        # Step 6: Multi-resolution fact community detection (Leiden)
        print("\n[6/6] Detecting fact communities (multi-resolution Leiden)...")
        fact_communities_multi = detect_fact_communities_multi(sqlite)

        # Store all community assignments
        print("\n[Store] Saving community assignments...")
        store_multi_resolution_communities(
            sqlite,
            entity_communities_multi,
            fact_communities_multi,
            fact_topic_clusters,
        )

        elapsed = time.time() - t0
        print("\n" + "=" * 60)
        print("PERIODIC IMPROVEMENT COMPLETE")
        print("=" * 60)
        print(f"  Time: {elapsed:.1f}s ({elapsed/60:.1f} min)")
        print(f"  Fact SIMILAR_TO edges: {n_fact_edges}")
        print(f"  Entity SIMILAR_TO edges: {n_entity_edges}")
        print(f"  Disambiguation edges: {n_disambig_edges}")
        print(f"  Entity communities (multi-res):")
        for level, mapping in entity_communities_multi.items():
            n_comms = len(set(mapping.values())) if mapping else 0
            print(f"    {level}: {n_comms} communities, {len(mapping)} entities")
        print(f"  Fact topic clusters (HDBSCAN): {len(set(fact_topic_clusters.values())) if fact_topic_clusters else 0}")
        print(f"  Fact communities (multi-res):")
        for level, mapping in fact_communities_multi.items():
            n_comms = len(set(mapping.values())) if mapping else 0
            print(f"    {level}: {n_comms} communities, {len(mapping)} facts")
        print("=" * 60)

    finally:
        # Only close stores we opened; injected ones belong to the caller.
        if _owns_stores:
            sqlite.close()
            qdrant.close()
