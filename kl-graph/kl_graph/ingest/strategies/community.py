"""Incremental community assignment via HIT-Leiden.

Maintains the existing Leiden partition under the graph changes a batch
introduced, instead of rebuilding it. The batch's new entities/facts and their
neighbourhood seed the affected region; HIT-Leiden's incremental movement and
refinement (:mod:`kl_graph.periodic.incremental_leiden`) then re-optimise only
that region.

Relationship to the full path
----------------------------
:mod:`kl_graph.periodic.community_detection` reruns
``graspologic_native.hierarchical_leiden`` over the whole graph and is the
authoritative rebuild. This strategy is its incremental counterpart and shares
the *same* graph construction (:func:`_build_community_graph`) and the same
collision-proof vertex labels, so the two cannot drift apart in what they
consider an edge or a weight.

What this strategy does and does not own
---------------------------------------
It writes the ``community_L*`` columns for the level it maintains and reports the
communities whose membership changed. It deliberately does **not** mint stable
identities, project ``COMM_MEMBER`` edges, or decide re-summarisation: those stay
with the coordinator (``community_identity`` reconciliation and
``community_summarizer.run_gated_summarization``), so identity and gating have a
single owner regardless of which detection path ran.

Scope limits (honest, and enforced by the code below)
-----------------------------------------------------
* Only the **flat** partition is maintained. The multi-level ``L0..L3`` hierarchy
  the full path produces via per-level resolutions is NOT reproduced here; the
  maintained partition is written to the configured single level and the deeper
  levels are left untouched for the next full improve. Writing a partial
  hierarchy would make ``/entity`` and the identity map disagree across levels.
* When no prior partition exists, this falls back to a static build over the
  affected subgraph rather than pretending to be incremental.
"""

from __future__ import annotations

import logging

from kl_graph.periodic.incremental_leiden import (
    DynamicGraph,
    EdgeChange,
    HITLeiden,
    default_config,
)
from kl_graph.storage.base import KnowledgeStore

logger = logging.getLogger(__name__)

#: The hierarchy level this strategy maintains incrementally. L1 is the
#: team/project granularity the retrieval paths read by default.
MAINTAINED_LEVEL = 1


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
    """Incremental community assignment backed by HIT-Leiden.

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
        """Maintain the partition for the region this batch touched.

        Args:
            store: KnowledgeStore whose ``sql_conn`` holds the graph and the
                ``community_L*`` columns.
            new_entity_ids: Entity IDs created in this incremental run.
            new_fact_ids: Fact IDs created in this incremental run.
            entity_resolutions: Per-level resolutions for the entity graph. Only
                the entry for the maintained level is used; the rest belong to
                the full hierarchical path.
            fact_resolutions: Per-level resolutions for the fact graph, same.
            structural_cache: Unused here; accepted for protocol compatibility.

        Returns:
            A :class:`_ChangedCommunities` set of community ids whose membership
            changed, carrying ``community_keys`` for projection scoping. Empty
            when nothing changed or the batch is empty.
        """
        del structural_cache  # protocol compatibility; no structural reads here
        if not new_entity_ids and not new_fact_ids:
            return _ChangedCommunities()

        # Import locally: community_detection imports graspologic and is a
        # heavier module; keeping it out of import time preserves the previous
        # import cost of this strategy.
        from kl_graph.models.types import community_id_from
        from kl_graph.periodic.community_detection import (
            _build_community_graph,
            _make_label,
        )

        sqlite = store
        level_name = f"L{MAINTAINED_LEVEL}"
        gamma = float(entity_resolutions.get(level_name, 1.0))

        # 1) Build the graph with the SAME semantics as the full path, so the
        #    incremental and full detectors never disagree about edges/weights.
        edges, label_map = _build_community_graph(sqlite)
        if not edges:
            logger.info("Incremental Leiden: empty community graph; nothing to do.")
            return _ChangedCommunities()

        graph = DynamicGraph()
        for u, v, w in edges:
            graph.add_edge(u, v, w)

        # 2) Read the prior partition for this level as the warm start.
        prior = _read_prior_partition(sqlite, MAINTAINED_LEVEL, label_map)

        new_labels = {_make_label("entity", eid) for eid in new_entity_ids}
        new_labels |= {_make_label("fact", fid) for fid in new_fact_ids}
        new_labels &= set(graph.vertices)

        config = default_config()
        if gamma != config.gamma:
            config = type(config)(
                gamma=gamma,
                max_levels=config.max_levels,
                seed=config.seed,
                min_gain=config.min_gain,
            )

        if not prior:
            logger.info(
                "Incremental Leiden: no prior %s partition; static build over "
                "%d vertices.",
                level_name,
                graph.num_vertices,
            )
            maintainer = HITLeiden.build(graph, config=config)
            after = maintainer.flat_membership()
            changed_vertices = set(after)
        else:
            # 3) Reconstruct the maintainer from the prior partition, then feed
            #    the batch's edges as changes so only their region is revisited.
            #    The graph is built WITHOUT the batch's incident edges, which are
            #    then applied as real insertions — that is what activates the
            #    affected region (a zero-delta change activates nothing, by
            #    Algorithm 2's own seeding rule).
            changes = _insertions_for_new_vertices(graph, new_labels)
            maintainer, seeded = _maintainer_from_prior(graph, prior, config)
            if not changes and not seeded:
                logger.info(
                    "Incremental Leiden: batch touched no graph edges; "
                    "partition unchanged."
                )
                return _ChangedCommunities()
            before = dict(maintainer.hierarchy.levels[0].movement.membership)
            maintainer.apply_batch(changes, maintain_hierarchy=False)
            after = dict(maintainer.hierarchy.levels[0].movement.membership)
            changed_vertices = {
                v for v, c in after.items() if before.get(v) != c
            } | (set(after) - set(before))

        if not changed_vertices:
            return _ChangedCommunities()

        # 4) Persist the maintained level and report what changed.
        written = _write_partition(
            sqlite, MAINTAINED_LEVEL, after, label_map
        )
        changed_clusters = {after[v] for v in changed_vertices if v in after}
        ids: set[str] = set()
        keys: set[tuple[str, str, int]] = set()
        for cluster in changed_clusters:
            ids.add(community_id_from(level_name, cluster))
            for node_type in ("entity", "fact"):
                keys.add((node_type, level_name, int(cluster)))

        logger.info(
            "Incremental Leiden: %d vertices moved across %d communities "
            "(%d rows written at %s).",
            len(changed_vertices),
            len(changed_clusters),
            written,
            level_name,
        )
        return _ChangedCommunities(ids, keys)


def _read_prior_partition(
    store: KnowledgeStore,
    level: int,
    label_map: dict[str, tuple[str, str]],
) -> dict[str, int]:
    """Read the existing ``community_L{level}`` assignment as vertex → cluster.

    Args:
        store: Store to read from.
        level: Hierarchy level index.
        label_map: Collision-proof label → ``(node_type, id)`` map; only
            vertices present here are returned, so the partition matches the
            graph the caller built.

    Returns:
        ``{label: cluster_id}``, empty when the column does not exist or holds
        no assignments.
    """
    conn = store.sql_conn
    column = f"community_L{level}"
    by_id: dict[tuple[str, str], int] = {}
    for table, node_type in (("entities", "entity"), ("facts", "fact")):
        columns = {
            str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")
        }
        if column not in columns:
            continue
        for node_id, cluster in conn.execute(
            f"SELECT id, {column} FROM {table} WHERE {column} IS NOT NULL"
        ):
            by_id[(node_type, str(node_id))] = int(cluster)

    if not by_id:
        return {}
    return {
        label: by_id[key] for label, key in label_map.items() if key in by_id
    }


def _maintainer_from_prior(
    graph: DynamicGraph,
    prior: dict[str, int],
    config,
) -> tuple[HITLeiden, bool]:
    """Build a maintainer whose base level carries the prior partition.

    Vertices absent from ``prior`` (this batch's new nodes) are registered as
    fresh singleton communities, which is exactly the state HIT-Leiden's
    incremental movement expects before it processes insertions.

    Args:
        graph: The current full graph.
        prior: Previously stored ``label → cluster`` assignment.
        config: Resolved :class:`IncrementalLeidenConfig`.

    Returns:
        ``(maintainer, seeded_new_vertices)`` where the flag reports whether any
        vertex needed a fresh singleton (i.e. the batch really added nodes).
    """
    from kl_graph.periodic.incremental_leiden import Hierarchy, Level, Partition

    membership = dict(prior)
    next_label = (max(membership.values()) + 1) if membership else 0
    seeded = False
    for v in sorted(graph.vertices):
        if v not in membership:
            membership[v] = next_label
            next_label += 1
            seeded = True

    base = Level(
        graph=graph,
        movement=Partition(graph, membership),
        refinement=Partition(graph, membership),
        node_to_children={v: {v} for v in graph.vertices},
    )
    return HITLeiden(Hierarchy(levels=[base]), config), seeded


def _insertions_for_new_vertices(
    graph: DynamicGraph, new_labels: set[str]
) -> list[EdgeChange]:
    """Detach the batch's incident edges and return them as real insertions.

    ``graph`` was built from the current database, so the batch's edges are
    already present. Feeding them as zero-delta changes would activate nothing
    (Algorithm 2 seeds only on cross-community *insertions* and intra-community
    *deletions*), and feeding them as positive deltas would double their weight.

    So we remove each incident edge from the graph and return it as a positive
    insertion of the same weight. Applying the returned changes restores the
    exact original weights while letting HIT-Leiden see them as genuine
    insertions, which is what bounds the work to the affected region.

    Args:
        graph: The current graph. **Mutated**: incident edges are removed.
        new_labels: Labels of this batch's new vertices.

    Returns:
        One positive :class:`EdgeChange` per incident edge, deduplicated.
    """
    incident: dict[tuple[str, str], float] = {}
    for v in sorted(new_labels):
        for nbr, weight in list(graph.neighbors(v).items()):
            key = (v, nbr) if v <= nbr else (nbr, v)
            incident.setdefault(key, weight)
    for (u, v), weight in incident.items():
        graph.apply_change(EdgeChange(u, v, -weight))
    return [EdgeChange(u, v, w) for (u, v), w in sorted(incident.items())]


def _write_partition(
    store: KnowledgeStore,
    level: int,
    membership: dict[str, int],
    label_map: dict[str, tuple[str, str]],
) -> int:
    """Write ``membership`` into ``community_L{level}``, creating it if absent.

    Args:
        store: Store to write to.
        level: Hierarchy level index.
        membership: ``label → cluster_id`` assignment to persist.
        label_map: Label → ``(node_type, id)`` map.

    Returns:
        Number of rows updated.
    """
    conn = store.sql_conn
    column = f"community_L{level}"
    updates: dict[str, list[tuple[int, str]]] = {"entities": [], "facts": []}
    for label, cluster in membership.items():
        key = label_map.get(label)
        if key is None:
            continue
        node_type, node_id = key
        table = "entities" if node_type == "entity" else "facts"
        updates[table].append((int(cluster), node_id))

    written = 0
    for table, rows in updates.items():
        if not rows:
            continue
        columns = {
            str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")
        }
        if column not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} INTEGER")
        conn.executemany(
            f"UPDATE {table} SET {column} = ? WHERE id = ?",
            rows,
        )
        written += len(rows)
    conn.commit()
    return written
