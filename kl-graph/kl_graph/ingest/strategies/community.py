"""Incremental community maintenance via HIT-Leiden.

Maintains the FULL Leiden hierarchy under the graph changes since the last
batch, instead of rebuilding it. The whole hierarchy state (per-level
supergraphs, movement/refinement partitions, aggregation maps) is persisted
next to the database between batches; the next batch loads it, derives its
work as the DELTA between the persisted base graph and the current graph
(every edge the state does not have yet is replayed as a real insertion),
and HIT-Leiden's incremental movement, refinement, aggregation and top-down
update (Algorithms 2-6 of Lin et al., arXiv:2601.08554) re-optimise only
the affected region at every level.

Relationship to the full path
----------------------------
:mod:`kl_graph.periodic.community_detection` runs the SAME algorithm's static
build (``naive_leiden``) with the SAME γ/seed from the app config, and shares
the graph construction (:func:`_build_community_graph`) and collision-proof
vertex labels. Full rebuild and incremental maintenance therefore produce the
same hierarchy shape: level 0 is the finest (base) partition, higher levels
are modularity-guarded aggregations.

What this strategy does and does not own
---------------------------------------
It writes the ``community_L*`` columns for EVERY level it maintains, persists
the maintainer state, re-materializes the reified projection (Community rows
+ ``COMM_MEMBER`` edges, rebuild-not-migrate like the full path), and reports
the communities whose membership changed at any level. It deliberately does
**not** mint stable identities or decide re-summarisation: those stay with
the coordinator (``community_identity`` reconciliation and
``community_summarizer.run_gated_summarization``), so identity and gating
have a single owner regardless of which detection path ran.

Scope and fallback rules (honest, and enforced by the code below)
-----------------------------------------------------------------
* Scope matches the full path: only the **largest connected component** is
  partitioned (``LEIDEN_USE_LCC``). When new vertices bridge a small
  component into the LCC, that component's internal edges simply join the
  next batch's delta and its vertices are registered on the fly.
* When no persisted state exists, the state is unreadable, or the config
  changed, this falls back to a static build over the current graph rather
  than maintaining a stale hierarchy. That fallback is exactly the full
  path, so it cannot drift. Graph shrinkage is NOT a fallback case: entity
  merges delete edges between batches and the delta replays them as
  deletions, which Algorithm 2 maintains natively.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from kl_graph.periodic.incremental_leiden import (
    DynamicGraph,
    EdgeChange,
    HITLeiden,
    default_config,
    deserialize_maintainer,
    serialize_maintainer,
)
from kl_graph.storage.base import KnowledgeStore

logger = logging.getLogger(__name__)

#: File name of the persisted maintainer state, stored next to the database.
STATE_FILE_NAME = "hit_leiden_state.json"


class _ChangedCommunities(set):
    """A ``set[str]`` of community ids that also carries typed community keys.

    ``improvement.py`` reads ``.community_keys`` off the returned object when
    present (``getattr(..., "community_keys", set())``) to scope the projection,
    and treats the object itself as a set of community ids. Subclassing ``set``
    satisfies both without changing the strategy protocol.

    Attributes:
        community_keys: ``(node_type, level_name, cluster_id)`` triples for the
            changed communities.
    """

    def __init__(self, ids=(), community_keys=()):
        super().__init__(ids)
        self.community_keys: set[tuple[str, str, int]] = set(community_keys)


class DynamicFrontierLeiden:
    """Incremental community maintenance backed by HIT-Leiden.

    Example:
        >>> strategy = DynamicFrontierLeiden()
        >>> changed = strategy.assign_communities(  # doctest: +SKIP
        ...     store, new_entity_ids, new_fact_ids,
        ...     entity_resolutions=RESOLUTIONS, fact_resolutions=RESOLUTIONS,
        ... )
    """

    def assign_communities(
        self,
        store: KnowledgeStore,
        new_entity_ids: list[str],
        new_fact_ids: list[str],
        *,
        entity_resolutions: dict[str, float],
        fact_resolutions: dict[str, float],
        structural_cache: object | None = None,
    ) -> set[str]:
        """Maintain the whole hierarchy for the region this batch touched.

        Args:
            store: KnowledgeStore whose ``sql_conn`` holds the graph and the
                ``community_L*`` columns.
            new_entity_ids: Entity IDs created in this incremental run.
            new_fact_ids: Fact IDs created in this incremental run.
            entity_resolutions: Accepted for protocol compatibility only. The
                hierarchy uses a single γ from the app config at every level.
            fact_resolutions: Same as ``entity_resolutions``.
            structural_cache: Unused here; accepted for protocol compatibility.

        Returns:
            A :class:`_ChangedCommunities` set of community ids whose membership
            changed at any level, carrying ``community_keys`` for projection
            scoping. Empty when nothing changed or the batch is empty.
        """
        del entity_resolutions, fact_resolutions, structural_cache
        if not new_entity_ids and not new_fact_ids:
            return _ChangedCommunities()
        del new_entity_ids, new_fact_ids  # work scope comes from the state delta

        # Import locally: community_detection is a heavier module; keeping it
        # out of import time preserves the previous import cost of this module.
        from kl_graph.models.types import community_id_from
        from kl_graph.periodic.community_detection import (
            LEIDEN_USE_LCC,
            _build_community_graph,
            _find_lcc,
            parents_from_levels,
            project_community_membership_edges,
            store_communities,
        )

        sqlite = store
        config = default_config()

        # 1) Build the graph with the SAME semantics as the full path, so the
        #    incremental and full detectors never disagree about edges/weights.
        edges, label_map = _build_community_graph(sqlite)
        if not edges:
            logger.info("HIT-Leiden: empty community graph; nothing to do.")
            return _ChangedCommunities()

        # Scope the graph to the largest connected component exactly like the
        # full path (LEIDEN_USE_LCC). Without this the incremental hierarchy
        # also clusters every small component, inflating the community count
        # and diverging from the full rebuild on scope alone.
        if LEIDEN_USE_LCC:
            edges = _find_lcc(edges)
            if not edges:
                logger.info("HIT-Leiden: no LCC edges; nothing to do.")
                return _ChangedCommunities()
            lcc_vertices = {u for u, _, _ in edges} | {v for _, v, _ in edges}
            label_map = {
                label: key
                for label, key in label_map.items()
                if label in lcc_vertices
            }

        graph = DynamicGraph()
        for u, v, w in edges:
            graph.add_edge(u, v, w)

        # 2) Load the persisted hierarchy and derive the batch as the DELTA
        #    between the state's base graph and the current graph: edges the
        #    state lacks are replayed as real insertions, re-scored edges as
        #    signed weight deltas, and edges the state has but the graph lost
        #    (entity disambiguation merges duplicates between batches) as
        #    deletions. Genuine deltas are what activate exactly the affected
        #    region (Algorithm 2 seeds on both cross-community insertions and
        #    intra-community deletions). This also absorbs small components
        #    that new vertices bridged into the LCC: their internal edges
        #    simply join the delta.
        state_path = _state_path(sqlite)
        maintainer = _load_readable_maintainer(state_path, config)
        changes: list[EdgeChange] = []
        if maintainer is not None:
            changes = _changes_since_state(
                maintainer.hierarchy.levels[0].graph, graph
            )

        if maintainer is None:
            logger.info(
                "HIT-Leiden: no valid persisted state; static build over "
                "%d vertices.",
                graph.num_vertices,
            )
            maintainer = HITLeiden.build(graph, config=config)
            before: dict[int, dict[str, int]] | None = None
        else:
            before = _composed_levels(maintainer)
            if not changes:
                logger.info(
                    "HIT-Leiden: no graph changes since state; "
                    "hierarchy unchanged."
                )
                return _ChangedCommunities()
            maintainer.apply_batch(changes)

        after = _composed_levels(maintainer)

        # 4) Persist state + every level's partition, then report changes.
        if state_path is not None:
            _save_state(state_path, maintainer)
        detection_result = {
            "assignments": {
                level: {
                    label_map[label]: cluster
                    for label, cluster in membership.items()
                    if label in label_map
                }
                for level, membership in after.items()
            },
            "parents": {},
        }
        store_communities(sqlite, detection_result)

        # Maintain the reified projection (Community rows + COMM_MEMBER edges)
        # too: on incremental-only days there is no separate full improve to
        # rebuild it, and the gated summarizer only summarises communities
        # that exist in the communities table. Rebuild-not-migrate, exactly
        # like the full path's project_community_membership_edges.
        levels = maintainer.hierarchy.levels
        detection_result["parents"] = parents_from_levels(
            [dict(lvl.movement.membership) for lvl in levels],
            [
                dict(levels[p + 1].s_pre) if p + 1 < len(levels) else None
                for p in range(len(levels))
            ],
        )
        project_community_membership_edges(sqlite, detection_result)

        ids, keys = _changed_communities(before, after, community_id_from)
        if ids:
            logger.info(
                "HIT-Leiden: %d communities changed across %d level(s).",
                len(ids),
                len(after),
            )
        return _ChangedCommunities(ids, keys)


def _state_path(store: KnowledgeStore) -> Path | None:
    """Resolve the state file path next to the database, when available.

    Args:
        store: Store whose ``db_path`` (SQLiteStore) anchors the file.

    Returns:
        Path for the state file, or None for stores without a file path
        (state persistence is skipped there; every batch rebuilds statically).
    """
    db_path = getattr(store, "db_path", None)
    if db_path is None:
        return None
    return Path(db_path).parent / STATE_FILE_NAME


def _load_readable_maintainer(
    state_path: Path | None,
    config,
) -> HITLeiden | None:
    """Load persisted state when it is readable and matches the current config.

    Graph-shape validation happens later via :func:`_changes_since_state`:
    forward growth (new edges/vertices) is replayed as deltas, only genuine
    backwards drift forces a rebuild.

    Args:
        state_path: Where the state file lives, or None.
        config: Resolved config; a config change invalidates the state.

    Returns:
        A ready-to-update maintainer, or None when no usable state exists.
    """
    if state_path is None or not state_path.exists():
        return None
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        maintainer = deserialize_maintainer(data)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        logger.info("HIT-Leiden: persisted state unreadable (%s); rebuilding.", exc)
        return None

    cfg = maintainer.config
    if (cfg.gamma, cfg.seed, cfg.max_levels) != (
        config.gamma,
        config.seed,
        config.max_levels,
    ):
        logger.info("HIT-Leiden: config changed; rebuilding.")
        return None
    return maintainer


def _changes_since_state(
    state_graph: DynamicGraph,
    current_graph: DynamicGraph,
) -> list[EdgeChange]:
    """Derive the edge deltas that take ``state_graph`` to ``current_graph``.

    Covers all three mutation kinds a real ingest batch produces:

    - insertions: new similarity/ABOUT edges (batch growth);
    - weight deltas: an existing edge re-scored;
    - deletions: entity disambiguation MERGES duplicates, which deletes
      vertices and their edges from the community graph between batches.
      Algorithm 2 seeds on deletions exactly as on insertions, so they are
      replayed as negative changes rather than forcing a rebuild.

    Args:
        state_graph: The persisted base-level graph (post previous batch).
        current_graph: The graph built from the current database.

    Returns:
        Deterministically ordered changes: deletions, then weight deltas,
        then insertions.
    """
    now: dict[tuple[str, str], float] = {
        (u, v): w for u, v, w in current_graph.edges()
    }
    then: dict[tuple[str, str], float] = {
        (u, v): w for u, v, w in state_graph.edges()
    }

    deletions: list[EdgeChange] = []
    deltas: list[EdgeChange] = []
    for (u, v), weight in sorted(then.items()):
        new = now.get((u, v))
        if new is None:
            deletions.append(EdgeChange(u, v, -weight))
        elif abs(new - weight) > 1e-12:
            deltas.append(EdgeChange(u, v, new - weight))

    insertions = [
        EdgeChange(u, v, w) for (u, v), w in sorted(now.items()) if (u, v) not in then
    ]
    return deletions + deltas + insertions


def _composed_levels(maintainer: HITLeiden) -> dict[int, dict[str, int]]:
    """Compose every level's movement partition down to base vertices.

    Args:
        maintainer: The maintainer whose hierarchy to compose.

    Returns:
        ``{level: {base_label: cluster}}``. Level 0 is the base partition
        itself; deeper levels push each super-node's cluster down to the base
        vertices it represents.
    """
    composed: dict[int, dict[str, int]] = {}
    for level_idx, lvl in enumerate(maintainer.hierarchy.levels):
        per_level: dict[str, int] = {}
        for node, cluster in lvl.movement.membership.items():
            for base_v in lvl.node_to_children.get(node, {node}):
                per_level[base_v] = int(cluster)
        composed[level_idx] = per_level
    return composed


def _changed_communities(
    before: dict[int, dict[str, int]] | None,
    after: dict[int, dict[str, int]],
    community_id_from,
) -> tuple[set[str], set[tuple[str, str, int]]]:
    """Diff composed hierarchies and collect changed community ids/keys.

    On a static build (``before is None``) every community counts as changed,
    which is what the coordinator needs to reconcile the whole partition.

    Args:
        before: Pre-batch composed levels, or None after a static build.
        after: Post-batch composed levels.
        community_id_from: Id formatter ``(level_name, cluster) -> str``.

    Returns:
        ``(changed_ids, changed_keys)`` across all levels.
    """
    ids: set[str] = set()
    keys: set[tuple[str, str, int]] = set()

    def _report(level: int, cluster: int) -> None:
        level_name = f"L{level}"
        ids.add(community_id_from(level_name, cluster))
        for node_type in ("entity", "fact"):
            keys.add((node_type, level_name, int(cluster)))

    for level, after_map in after.items():
        if before is None or level not in before:
            for cluster in set(after_map.values()):
                _report(level, cluster)
            continue
        before_map = before[level]
        moved_clusters = {
            after_map[v]
            for v in after_map
            if before_map.get(v) != after_map[v]
        }
        # Vanished clusters: present before, empty after. Reporting them lets
        # the coordinator retire their summaries even though no vertex moved
        # INTO anything.
        vanished = set(before_map.values()) - set(after_map.values())
        for cluster in moved_clusters | vanished:
            _report(level, cluster)
    return ids, keys


def _save_state(state_path: Path, maintainer: HITLeiden) -> None:
    """Persist the maintainer's hierarchy as JSON next to the database.

    Writes atomically (tmp file + rename) so a crash mid-write never leaves a
    truncated state file; the loader treats anything unreadable as "no state".

    Args:
        state_path: Destination file.
        maintainer: Maintainer to persist.
    """
    data = serialize_maintainer(maintainer)
    tmp = state_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(state_path)
