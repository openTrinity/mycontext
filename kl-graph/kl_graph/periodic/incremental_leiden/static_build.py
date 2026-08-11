"""Static Leiden build, delegating each level's clustering to graspologic.

The initial-build path for :class:`~kl_graph.periodic.incremental_leiden.maintainer.HITLeiden`.
Rather than hand-rolling Leiden's move/refine phases, this calls the mature
Rust-backed ``graspologic_native.leiden`` per level and builds the bottom-up
aggregation hierarchy around it.

Why the package output is a valid aggregation unit:
    ``graspologic_native.leiden`` runs Leiden's movement **and** refinement and
    returns communities with the well-connectedness guarantee. At each level the
    returned partition is therefore a valid refinement (``s^p``); it serves as
    both the movement map ``f^p`` and the sub-community map ``s^p`` (they coincide
    when every community is already internally connected, which graspologic
    guarantees). Aggregation then collapses those connected communities into the
    next level's supernodes.

This module owns the hierarchy scaffolding because ``graspologic_native.leiden``
returns only a flat partition and has no notion of multilevel supergraphs.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import graspologic_native as gn

from kl_graph.periodic.incremental_leiden.graph import DynamicGraph
from kl_graph.periodic.incremental_leiden.modularity import modularity
from kl_graph.periodic.incremental_leiden.partition import Partition

# graspologic_native.leiden parameters (mirror kl-graph's frozen GraphRAG knobs
# where they overlap; randomness/iterations are graspologic-specific).
_RANDOMNESS = 0.001
_ITERATIONS = 1
_TRIALS = 1


@dataclass
class LeidenLevel:
    """One level of the Leiden hierarchy.

    Attributes:
        graph: The (super)graph at this level.
        membership: Community assignment ``f^p`` of this level's nodes.
        sub_membership: Refinement assignment ``s^p`` (well-connected
            sub-communities) of this level's nodes.
        node_to_children: For super-levels, maps each supernode to the set of
            base-level vertex ids it represents.
    """

    graph: DynamicGraph
    membership: dict[str, int]
    sub_membership: dict[str, int]
    node_to_children: dict[str, set[str]] = field(default_factory=dict)


@dataclass
class LeidenResult:
    """Output of :func:`naive_leiden`.

    Attributes:
        levels: Per-level state, index 0 == base graph.
        base_membership: Final ``vertex → community`` map at the base level,
            composed across levels (the flat community assignment).
    """

    levels: list[LeidenLevel]
    base_membership: dict[str, int]


def _aggregate(
    graph: DynamicGraph,
    sub: Partition,
) -> tuple[DynamicGraph, dict[str, set[str]]]:
    """Aggregation phase: collapse each sub-community into one supernode.

    Args:
        graph: The current (super)graph.
        sub: The refinement partition ``s^p`` whose communities become nodes.

    Returns:
        (supergraph, supernode_to_members) where supernode ids are ``"c{label}"``
        and the member map lists the current-level nodes each supernode absorbs.
    """
    super_graph = DynamicGraph()
    supernode_members: dict[str, set[str]] = {}

    def super_id(node: str) -> str:
        return f"c{sub.community_of(node)}"

    # Accumulate superedges (including self-loops for internal weight).
    for u, v, w in graph.edges():
        su = super_id(u)
        sv = super_id(v)
        super_graph.add_edge(su, sv, w)

    for node in graph.vertices:
        sid = super_id(node)
        supernode_members.setdefault(sid, set()).add(node)
    return super_graph, supernode_members


def _compose_base_membership(levels: list[LeidenLevel]) -> dict[str, int]:
    """Compose per-level maps into a flat base-vertex→community map.

    The top level's community label for each supernode is pushed down to all of
    the base vertices that supernode represents.

    Args:
        levels: The hierarchy levels produced during aggregation.

    Returns:
        Map from base vertex id to final community label.
    """
    if not levels:
        return {}
    top = levels[-1]
    base_membership: dict[str, int] = {}
    for node, comm in top.membership.items():
        for base_v in top.node_to_children.get(node, {node}):
            base_membership[base_v] = comm
    return base_membership


def _leiden_flat(
    graph: DynamicGraph,
    *,
    gamma: float,
    seed: int,
    starting_communities: dict[str, int] | None = None,
) -> dict[str, int]:
    """Run one flat ``graspologic_native.leiden`` pass over ``graph``.

    Args:
        graph: The (super)graph to cluster.
        gamma: Resolution parameter.
        seed: PRNG seed (must be a positive uint64 for graspologic; ``0`` is
            accepted here and passed through).
        starting_communities: Optional warm-start partition.

    Returns:
        A dense ``node -> community_label`` map covering every vertex. Vertices
        graspologic drops as isolates are assigned fresh singleton labels so the
        result is total.
    """
    edges = graph.edges()
    if not edges:
        # No edges: every vertex is its own community.
        return {v: i for i, v in enumerate(sorted(graph.vertices))}

    _quality, partition = gn.leiden(
        edges=edges,
        starting_communities=starting_communities,
        resolution=gamma,
        randomness=_RANDOMNESS,
        iterations=_ITERATIONS,
        use_modularity=True,
        seed=seed,
        trials=_TRIALS,
    )

    # graspologic omits isolate nodes; assign them fresh labels so the map is
    # total over the graph's vertices.
    next_label = (max(partition.values()) + 1) if partition else 0
    for v in graph.vertices:
        if v not in partition:
            partition[v] = next_label
            next_label += 1
    return partition


def naive_leiden(
    graph: DynamicGraph,
    *,
    gamma: float = 1.0,
    max_levels: int = 16,
    seed: int = 0xC0FFEE,
    initial_membership: dict[str, int] | None = None,
) -> LeidenResult:
    """Build the Leiden hierarchy using ``graspologic_native`` per level.

    Args:
        graph: Base graph.
        gamma: Resolution parameter.
        max_levels: Maximum number of aggregation levels.
        seed: PRNG seed for reproducible clustering.
        initial_membership: Optional warm-start for the base level.

    Returns:
        A :class:`LeidenResult` with per-level state and the composed flat
        base-level membership.
    """
    levels: list[LeidenLevel] = []
    current_graph = graph
    node_children: dict[str, set[str]] = {v: {v} for v in graph.vertices}
    # Track the best composed modularity seen so far; a coarser level is only
    # accepted if it does not decrease global modularity (standard Leiden
    # termination — otherwise a tiny supergraph can spuriously merge everything).
    prev_modularity = float("-inf")

    for level_idx in range(max_levels):
        warm = initial_membership if (initial_membership is not None and level_idx == 0) else None
        partition_map = _leiden_flat(
            current_graph, gamma=gamma, seed=seed, starting_communities=warm
        )

        candidate_level = LeidenLevel(
            graph=current_graph,
            membership=dict(partition_map),
            sub_membership=dict(partition_map),
            node_to_children=dict(node_children),
        )

        # Guard: a coarser level must not reduce global (base-graph) modularity.
        # Level 0 is always accepted; deeper levels are validated by composing
        # them down to the base graph and comparing Q.
        if level_idx == 0:
            levels.append(candidate_level)
            prev_modularity = modularity(graph, _compose_base_membership(levels), gamma)
        else:
            trial_levels = [*levels, candidate_level]
            trial_q = modularity(graph, _compose_base_membership(trial_levels), gamma)
            if trial_q < prev_modularity - 1e-12:
                # Coarsening hurt modularity; stop and keep the finer hierarchy.
                break
            levels.append(candidate_level)
            prev_modularity = trial_q

        n_comms = len(set(partition_map.values()))
        if n_comms == current_graph.num_vertices or current_graph.num_vertices <= 1:
            # No coarsening possible; hierarchy is complete.
            break

        # Aggregate on this level's (connected) communities to form the next
        # supergraph.
        sub_partition = Partition(current_graph, partition_map)
        super_graph, supernode_members = _aggregate(current_graph, sub_partition)

        new_children: dict[str, set[str]] = {}
        for sid, members in supernode_members.items():
            acc: set[str] = set()
            for node in members:
                acc |= node_children[node]
            new_children[sid] = acc
        node_children = new_children
        current_graph = super_graph
        if super_graph.num_vertices <= 1:
            break

    base_membership = _compose_base_membership(levels)
    return LeidenResult(levels=levels, base_membership=base_membership)
