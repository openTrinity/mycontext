"""Periodic improvement phase runner.

Orchestrates:
  1. Fact FACT_SIMILAR edges (embedding similarity)
  2. Entity ENTITY_SIMILAR edges (hybrid metrics)
  3. Entity disambiguation (pinyin + hybrid + LLM judge)
  4. Entity community detection (Leiden)
  5. Fact community detection (HDBSCAN + Leiden)
  6. Community node + COMM_MEMBER projection from the assignment columns

Run this after ingestion (Phase B) completes.
Steps 1-2, 4-5 are O(n) with no LLM calls.
Step 3 uses limited LLM budget (~200-500 calls) for ambiguous pairs.
"""

from __future__ import annotations

import time

from kl_graph.config import cfg, DATA_DIR, GRAPH_DB_PATH, LADYBUG_OPTS
from kl_graph.ingest.checkpoint import IngestCheckpoint, run_if_needed
from kl_graph.periodic.community_detection import (
    detect_entity_communities_multi,
    detect_fact_communities_multi,
    project_community_membership_edges,
    store_multi_resolution_communities,
)
from kl_graph.periodic.entity_disambiguation import run_entity_disambiguation
from kl_graph.periodic.entity_similarity import build_entity_similarity_edges
from kl_graph.periodic.fact_similarity import build_fact_similarity_edges
from kl_graph.storage.base import KnowledgeStore, create_store
from kl_graph.storage.qdrant_store import QdrantStore

SQLITE_PATH = DATA_DIR / "knowledge.db"
QDRANT_PATH = str(DATA_DIR / "qdrant_data")


def run_periodic_improvement(
    sqlite_path=SQLITE_PATH,
    qdrant_path=QDRANT_PATH,
    *,
    store: KnowledgeStore | None = None,
    qdrant: QdrantStore | None = None,
    checkpoint: IngestCheckpoint | None = None,
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

    Args:
        checkpoint: Optional IngestCheckpoint for step-level resume. When
            provided, each step checks if it was already completed (with
            matching parameters) and skips if so.
    """
    t0 = time.time()
    print("=" * 60)
    print("PERIODIC IMPROVEMENT PHASE")
    print("=" * 60)

    # Reuse injected stores (e.g. from kl-server) or open our own.
    _owns_store = store is None
    _owns_qdrant = qdrant is None
    if store is None:
        graph_backend = cfg.storage.graph.backend

        if graph_backend == "ladybug":
            store = create_store(
                backend=graph_backend,
                db_path=sqlite_path,
                ladybug_path=GRAPH_DB_PATH,
                **LADYBUG_OPTS,
            )
        else:
            store = create_store(backend=graph_backend, db_path=sqlite_path)
    if qdrant is None:
        qdrant = QdrantStore(qdrant_path)

    try:
        # Step 1: Fact FACT_SIMILAR edges
        print("\n[1/6] Building fact FACT_SIMILAR edges...")
        fact_sim_params = {"threshold": fact_sim_threshold}
        if checkpoint:
            n_fact_edges = run_if_needed(
                checkpoint,
                "improve.fact_similarity",
                build_fact_similarity_edges,
                qdrant,
                store,
                threshold=fact_sim_threshold,
                params=fact_sim_params,
            )
            if n_fact_edges is None:
                n_fact_edges = 0
        else:
            n_fact_edges = build_fact_similarity_edges(
                qdrant,
                store,
                threshold=fact_sim_threshold,
            )

        # Step 2: Entity ENTITY_SIMILAR edges
        print("\n[2/6] Building entity ENTITY_SIMILAR edges...")
        entity_sim_params = {
            "embedding_threshold": entity_emb_threshold,
            "hybrid_threshold": entity_hybrid_threshold,
        }
        if checkpoint:
            n_entity_edges = run_if_needed(
                checkpoint,
                "improve.entity_similarity",
                build_entity_similarity_edges,
                qdrant,
                store,
                embedding_threshold=entity_emb_threshold,
                hybrid_threshold=entity_hybrid_threshold,
                params=entity_sim_params,
            )
            if n_entity_edges is None:
                n_entity_edges = 0
        else:
            n_entity_edges = build_entity_similarity_edges(
                qdrant,
                store,
                embedding_threshold=entity_emb_threshold,
                hybrid_threshold=entity_hybrid_threshold,
            )

        # Step 3: Entity disambiguation (pinyin + hybrid + LLM judge → ENTITY_SIMILAR edges)
        n_disambig_edges = 0
        if run_disambiguation:
            print("\n[3/6] Running entity disambiguation...")
            disambig_params = {
                "skip_llm": skip_llm_judge,
                "llm_max_budget": llm_max_budget,
            }
            if checkpoint:
                result = run_if_needed(
                    checkpoint,
                    "improve.disambiguation",
                    run_entity_disambiguation,
                    store,
                    qdrant,
                    skip_llm=skip_llm_judge,
                    llm_max_budget=llm_max_budget,
                    params=disambig_params,
                )
                if result is not None:
                    n_disambig_edges = result
            else:
                n_disambig_edges = run_entity_disambiguation(
                    store,
                    qdrant,
                    skip_llm=skip_llm_judge,
                    llm_max_budget=llm_max_budget,
                )
        else:
            print("\n[3/6] Skipping entity disambiguation (disabled)")

        # Step 4-6: Community detection (entity Leiden + fact HDBSCAN + fact Leiden)
        # These form one logical unit: they delete-and-rebuild all community
        # assignments, so either all are done or all must re-run.
        community_params = {
            "entity_resolution": entity_resolution,
            "fact_resolution": fact_resolution,
            "fact_min_cluster_size": fact_min_cluster_size,
        }
        if checkpoint and checkpoint.is_done(
            "improve.communities", params=community_params
        ):
            print("\n[4-6/6] Community detection — skipping (already done)")
            entity_communities_multi = {}
            fact_topic_clusters = {}
            fact_communities_multi = {}
        else:
            # Step 4: Multi-resolution entity community detection
            print("\n[4/6] Detecting entity communities (multi-resolution Leiden)...")
            entity_communities_multi = detect_entity_communities_multi(store)

            # Step 5: Fact community detection (HDBSCAN)
            print("\n[5/6] Detecting fact topic clusters (HDBSCAN)...")
            # fact_topic_clusters = detect_fact_communities_hdbscan(
            #     qdrant,
            #     store,
            #     min_cluster_size=fact_min_cluster_size,
            # )
            fact_topic_clusters = None

            # Step 6: Multi-resolution fact community detection (Leiden)
            print("\n[6/6] Detecting fact communities (multi-resolution Leiden)...")
            fact_communities_multi = detect_fact_communities_multi(store)

            # Store all community assignments
            print("\n[Store] Saving community assignments...")
            store_multi_resolution_communities(
                store,
                entity_communities_multi,
                fact_communities_multi,
                fact_topic_clusters,
            )

            # Project the (now authoritative) assignment columns into reified
            # Community nodes + COMM_MEMBER edges. Delete-and-rebuild, so it must run
            # after the columns are final.
            print("\n[Project] Materializing Community nodes + COMM_MEMBER edges...")
            project_community_membership_edges(store)

            if checkpoint:
                checkpoint.mark_done(
                    "improve.communities", params=community_params
                )

        elapsed = time.time() - t0
        print("\n" + "=" * 60)
        print("PERIODIC IMPROVEMENT COMPLETE")
        print("=" * 60)
        print(f"  Time: {elapsed:.1f}s ({elapsed / 60:.1f} min)")
        print(f"  Fact FACT_SIMILAR edges: {n_fact_edges}")
        print(f"  Entity ENTITY_SIMILAR edges: {n_entity_edges}")
        print(f"  Disambiguation edges: {n_disambig_edges}")
        if entity_communities_multi:
            print("  Entity communities (multi-res):")
            for level, mapping in entity_communities_multi.items():
                n_comms = len(set(mapping.values())) if mapping else 0
                print(f"    {level}: {n_comms} communities, {len(mapping)} entities")
        if fact_topic_clusters:
            print(
                f"  Fact topic clusters (HDBSCAN): {len(set(fact_topic_clusters.values()))}"
            )
        if fact_communities_multi:
            print("  Fact communities (multi-res):")
            for level, mapping in fact_communities_multi.items():
                n_comms = len(set(mapping.values())) if mapping else 0
                print(f"    {level}: {n_comms} communities, {len(mapping)} facts")
        print("=" * 60)

    finally:
        # Only close resources we opened; injected ones belong to the caller.
        if _owns_store:
            store.close()
        if _owns_qdrant:
            qdrant.close()
