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
        s_pre: Node id at the level below → this level's node id, as recorded
            when this level was aggregated. Empty at the base level.
    """

    graph: DynamicGraph
    membership: dict[str, int]
    sub_membership: dict[str, int]
    node_to_children: dict[str, set[str]] = field(default_factory=dict)
    s_pre: dict[str, str] = field(default_factory=dict)


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
    edges = sorted(graph.edges(), key=lambda e: (e[0], e[1]))
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


def _leiden_flat_moves(
    graph: DynamicGraph,
    *,
    gamma: float,
    starting_communities: dict[str, int] | None = None,
    max_passes: int = 20,
) -> dict[str, int]:
    """Movement-phase Leiden using the package's own gain formula.

    Super-level clustering MUST optimize composed base modularity. The
    aggregation identity guarantees that: with loops carrying internal
    weights (degree convention 2w), the supergraph's modularity under any
    super-partition equals the base modularity of the composed partition.
    ``graspologic_native.leiden`` optimizes its own loop convention instead,
    which measurably over-merged real supergraphs (composed Q 0.766 vs the
    0.838 of the state it was asked to coarsen) and thereby blocked every
    hierarchy extension — so super levels are clustered here, with moves
    driven by :func:`modularity_gain`.

    Deterministic: sorted vertex order, repeated passes until no improving
    move remains (movement phase only; refinement at these levels happens
    incrementally during maintenance).

    Args:
        graph: The (super)graph to cluster.
        gamma: Resolution parameter.
        starting_communities: Optional warm-start partition.
        max_passes: Safety cap on full passes over the vertex set.

    Returns:
        A dense ``node -> community_label`` map covering every vertex.
    """
    from kl_graph.periodic.incremental_leiden.modularity import (
        edge_weight_to_communities,
        modularity_gain,
    )

    membership = (
        dict(starting_communities)
        if starting_communities
        else {v: i for i, v in enumerate(sorted(graph.vertices))}
    )
    # Ensure totality for vertices absent from a warm start.
    next_label = (max(membership.values()) + 1) if membership else 0
    for v in sorted(graph.vertices):
        if v not in membership:
            membership[v] = next_label
            next_label += 1

    part = Partition(graph, membership)
    min_gain = 1e-12
    for _ in range(max_passes):
        two_m = 2.0 * graph.total_weight
        if two_m <= 0.0:
            break
        moved = False
        for v in sorted(graph.vertices):
            if v not in part.membership or not graph.has_vertex(v):
                continue
            k_v = graph.degree(v)
            source = part.community_of(v)
            w_to = edge_weight_to_communities(graph, v, part.membership)
            w_source = w_to.get(source, 0.0)
            d_source = part.community_degree(source)
            best_target, best_gain = source, 0.0
            for target in sorted(w_to):
                if target == source:
                    continue
                gain = modularity_gain(
                    k_v=k_v,
                    w_v_to_target=w_to[target],
                    w_v_to_source=w_source,
                    d_source=d_source,
                    d_target=part.community_degree(target),
                    two_m=two_m,
                    gamma=gamma,
                )
                if gain > best_gain + min_gain:
                    best_gain, best_target = gain, target
            if best_target != source:
                part.move(v, best_target, graph)
                moved = True
        if not moved:
            break
    return dict(part.membership)


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
    pending_s_pre: dict[str, str] = {}
    # Track the best composed modularity seen so far; a coarser level is only
    # accepted if it does not decrease global modularity (standard Leiden
    # termination — otherwise a tiny supergraph can spuriously merge everything).
    prev_modularity = float("-inf")

    for level_idx in range(max_levels):
        if level_idx == 0:
            # Base level: mature graspologic kernel (graph has no self-loops,
            # so its objective coincides with ours).
            partition_map = _leiden_flat(
                current_graph, gamma=gamma, seed=seed,
                starting_communities=initial_membership,
            )
        else:
            # Super levels: the consistent mover (see its docstring — the
            # graspologic kernel is not modularity-consistent with the base
            # once aggregation self-loops appear).
            partition_map = _leiden_flat_moves(current_graph, gamma=gamma)

        n_cand_comms = len(set(partition_map.values()))
        if level_idx > 0 and n_cand_comms == current_graph.num_vertices:
            # The candidate coarsened nothing (every super-node kept its own
            # community). Appending it would create a trivial level that adds
            # no structure — this happens exactly when no joint merge has
            # strictly positive gain, e.g. at a zero-gain coupling. Honest
            # depth stops here instead of padding a fake level.
            break

        candidate_level = LeidenLevel(
            graph=current_graph,
            membership=dict(partition_map),
            sub_membership=dict(partition_map),
            node_to_children=dict(node_children),
            s_pre=dict(pending_s_pre),
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
        # Record the aggregation map for the next level (Alg 4's ``s_pre``).
        pending_s_pre = {
            node: f"c{sub_partition.community_of(node)}"
            for node in current_graph.vertices
        }

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
