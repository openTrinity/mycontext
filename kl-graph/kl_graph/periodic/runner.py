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

from kl_graph.config import DATA_DIR, GRAPH_DB_PATH, LADYBUG_OPTS, cfg
from kl_graph.ingest.checkpoint import IngestCheckpoint, run_if_needed
from kl_graph.periodic.entity_disambiguation import run_entity_disambiguation
from kl_graph.periodic.entity_similarity import build_entity_similarity_edges
from kl_graph.periodic.fact_similarity import build_fact_similarity_edges

# Summarization hook (implemented by Task 2; import guarded for forward compat)
try:
    from kl_graph.periodic.community_summarizer import (
        run_community_summarization,
        run_gated_summarization,
    )
except ImportError:
    run_community_summarization = None  # type: ignore[assignment]
    run_gated_summarization = None  # type: ignore[assignment]
# Stable-identity reconciliation (Task 1; guarded for forward compat)
try:
    from kl_graph.periodic.community_identity import (
        CommunityIdentity,
        invert_assignments,
    )
except ImportError:
    CommunityIdentity = None  # type: ignore[assignment]
    invert_assignments = None  # type: ignore[assignment]
from kl_graph.storage.base import KnowledgeStore, create_store
from kl_graph.storage.vector_store import VectorStore, create_vector_store

SQLITE_PATH = DATA_DIR / "knowledge.db"
QDRANT_PATH = str(DATA_DIR / "qdrant_data")

#: Meta key holding the in-flight full-improve reconciliation run id. It is
#: created once per improve and REUSED across retries (so a crashed+retried run
#: overwrites its own idempotent identity rows rather than appending a second
#: run), then cleared on successful completion.
_RUN_ID_META_KEY = "improve.full.reconcile_run_id"


def _durable_run_id(store: KnowledgeStore) -> str:
    """Return a retry-stable reconciliation run id for the current full improve.

    The id is persisted in ``ingest_meta`` so a re-run of a crashed improve
    reuses the SAME id (reconciliation is idempotent by run id, so the retry
    overwrites its partial rows). A fresh id is minted only when none is
    in-flight. Not derived from wall-clock time, which is neither retry-stable
    nor collision-safe for runs in the same second.
    """
    try:
        existing = store.get_meta(_RUN_ID_META_KEY)
    except Exception:  # noqa: BLE001 - meta store optional; fall back to a fresh id
        existing = None
    if existing:
        return str(existing)
    import uuid as _uuid

    run_id = f"full-{_uuid.uuid4().hex}"
    try:
        store.set_meta(_RUN_ID_META_KEY, run_id)
    except Exception:  # noqa: BLE001, S110 - best-effort persistence; id still usable this run
        pass
    return run_id


def _clear_durable_run_id(store: KnowledgeStore) -> None:
    """Clear the in-flight reconciliation run id after a successful improve."""
    try:
        store.set_meta(_RUN_ID_META_KEY, "")
    except Exception:  # noqa: BLE001, S110 - best-effort; a stale marker only costs one id reuse
        pass


def run_periodic_improvement(
    sqlite_path=SQLITE_PATH,
    qdrant_path=QDRANT_PATH,
    *,
    store: KnowledgeStore | None = None,
    qdrant: VectorStore | None = None,
    checkpoint: IngestCheckpoint | None = None,
    # Fact similarity params
    fact_sim_threshold: float = 0.85,
    # Entity similarity params
    entity_emb_threshold: float = 0.65,
    entity_hybrid_threshold: float = 0.45,
    # Entity disambiguation
    run_disambiguation: bool = True,
    skip_llm_judge: bool = False,
    llm_max_budget: int = 500,
    # Community summarization
    run_summarization: bool = True,
    communities_enabled: bool | None = None,
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
    if communities_enabled is None:
        communities_enabled = bool(cfg.pipelines.experimental.communities.enabled)
    # Per-step wall-clock tracking: _lap() prints the elapsed time since the
    # previous lap, so each improve step's cost is visible in build logs.
    _lap_t = [t0]

    def _lap() -> None:
        now = time.time()
        print(f"  Step time: {now - _lap_t[0]:.1f}s")
        _lap_t[0] = now

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
        vector_backend = str(cfg.storage.vector.backend)
        qdrant = create_vector_store(
            vector_backend,
            data_dir=DATA_DIR,
            embedding_dim=int(cfg.services.embedding.dim),
            path=qdrant_path if vector_backend == "qdrant" else None,
        )

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
        _lap()

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
        _lap()

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
        _lap()

        # Step 4: hierarchical community detection
        # This forms one logical unit: it deletes-and-rebuilds all community
        # assignments, so either all are done or all must re-run.
        community_params = {} if communities_enabled else None
        if community_params is None:
            print("\n[4/6] Skipping communities (feature disabled)")
            assignments = {}
        elif checkpoint and checkpoint.is_done(
            "improve.communities", params=community_params
        ):
            print("\n[4/6] Community detection — skipping (already done)")
            assignments = {}
        else:
            from kl_graph.periodic.community_detection import (
                _build_community_graph,
                detect_communities_hierarchical,
                project_community_membership_edges,
                store_communities,
            )

            # Step 4: hierarchical community detection
            print("\n[4/6] Building community graph for hierarchical Leiden...")
            edges, label_map = _build_community_graph(store)
            _lap()

            print("\n[5/6] Running hierarchical Leiden...")
            detection_result = detect_communities_hierarchical(edges, label_map)
            _lap()

            # Store all community assignments
            print("\n[6/6] Storing community assignments...")
            store_communities(store, detection_result)
            _lap()

            # Project the (now authoritative) assignment columns into reified
            # Community nodes + COMM_MEMBER edges. Delete-and-rebuild, so it must run
            # after the columns are final.
            print("\n[Project] Materializing Community nodes + COMM_MEMBER edges...")
            project_community_membership_edges(store, detection_result)
            _lap()

            # Extract assignments for reporting
            assignments = detection_result.get("assignments", {})

            # Reconcile the full partition into STABLE community identities
            # (Task 1) BEFORE summarizing. MANDATORY on the full path — even for
            # an EMPTY partition, which must still reconcile so every prior
            # community is recorded as a death (otherwise a full rebuild that
            # produced no communities would leave stale identities/reports
            # active). Reconciliation is idempotent by run_id, so a re-run of a
            # completed improve does not duplicate lineage events.
            identity = None
            forced_uuids: set[str] = set()
            reconcile_run_id = _durable_run_id(store)
            if CommunityIdentity is not None and invert_assignments is not None:
                identity = CommunityIdentity(store)
                current_memberships = (
                    invert_assignments(assignments) if assignments else {}
                )
                identity.reconcile(current_memberships, reconcile_run_id)
                # Births / split / merge products are forced to (re)summarize.
                for ev in identity.lineage_events_for(reconcile_run_id):
                    if ev.event_type in ("birth", "split", "merge") and ev.successor_uuid:
                        forced_uuids.add(ev.successor_uuid)
                _lap()

            # Run community summarization if enabled. Prefer the baseline-aware
            # GATED path (Task 2) when both reconciliation and the gated
            # summarizer are available, so unchanged communities keep their
            # reports with zero LLM cost; fall back to the full unconditional
            # summarizer otherwise (backward compatible).
            if (
                run_summarization
                and identity is not None
                and run_gated_summarization is not None
            ):
                print("\n[Summarize] Running gated community summarization...")
                gated = run_gated_summarization(
                    store,
                    identity,
                    run_id=reconcile_run_id,
                    levels=None,
                    min_members=10,
                    forced_uuids=forced_uuids,
                )
                print(
                    f"  Regenerated {gated['regenerated']}, kept {gated['kept']}, "
                    f"retired {gated['retired']}, failed {gated['failed']}"
                )
                _lap()
            elif run_summarization and run_community_summarization is not None:
                print("\n[Summarize] Running community summarization...")
                n_summaries = run_community_summarization(
                    store,
                    levels=None,
                    min_members=10,
                )
                print(f"  Generated {n_summaries} community summaries")
                _lap()
            elif run_summarization:
                print("\n[Summarize] Skipping (community_summarizer not available)")

            if checkpoint:
                checkpoint.mark_done(
                    "improve.communities", params=community_params
                )
            # Full improve committed successfully; release the in-flight run id
            # so the NEXT improve mints a fresh one.
            _clear_durable_run_id(store)

        elapsed = time.time() - t0
        print("\n" + "=" * 60)
        print("PERIODIC IMPROVEMENT COMPLETE")
        print("=" * 60)
        print(f"  Time: {elapsed:.1f}s ({elapsed / 60:.1f} min)")
        print(f"  Fact FACT_SIMILAR edges: {n_fact_edges}")
        print(f"  Entity ENTITY_SIMILAR edges: {n_entity_edges}")
        print(f"  Disambiguation edges: {n_disambig_edges}")
        if assignments:
            print("  Hierarchical communities:")
            for level, mapping in assignments.items():
                n_comms = len(set(mapping.values())) if mapping else 0
                print(f"    Level {level}: {n_comms} communities, {len(mapping)} nodes")
        print("=" * 60)

    finally:
        # Only close resources we opened; injected ones belong to the caller.
        if _owns_store:
            store.close()
        if _owns_qdrant:
            qdrant.close()
