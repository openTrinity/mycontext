"""Modularity and modularity-gain for incremental maintenance.

Formulas follow ``docs/math/hit_leiden_spec.md`` from the reference Rust
implementation (github.com/randomvariable/hit-leiden), which follows Lin et al.
(arXiv:2601.08554).

Global modularity (undirected, weighted)::

    Q = (1/2m) sum_ij [ A_ij - gamma k_i k_j / 2m ] delta(c_i, c_j)

Kept local rather than delegated to ``graspologic_native``, which exposes neither
a reusable modularity nor an incremental move-gain.
"""

from __future__ import annotations

from collections import defaultdict

from kl_graph.periodic.incremental_leiden.graph import DynamicGraph


def modularity(graph: DynamicGraph, membership: dict[str, int], gamma: float) -> float:
    """Compute global modularity ``Q`` of ``membership`` on ``graph``.

    Args:
        graph: The graph.
        membership: Map from vertex id to community label.
        gamma: Resolution parameter (higher → smaller communities).

    Returns:
        Modularity ``Q``. Returns ``0.0`` for an empty graph.
    """
    m = graph.total_weight
    if m <= 0.0:
        return 0.0
    two_m = 2.0 * m

    # Internal weight per community: Σ A_ij over i,j in same community.
    # Each undirected edge (u,v,w) with u≠v in the same community contributes
    # 2w to the i,j double sum; a self-loop contributes 2w as well, matching
    # the degree convention (apply_change counts a loop as 2w in k_v). With
    # this convention the aggregation identity holds EXACTLY: the modularity
    # of the aggregated supergraph (loops = internal weights) under the
    # singleton partition equals the modularity of the base partition, so
    # optimizing super-level moves optimizes composed base modularity.
    internal: dict[int, float] = defaultdict(float)
    degree_sum: dict[int, float] = defaultdict(float)

    for v in graph.vertices:
        degree_sum[membership[v]] += graph.degree(v)

    for u, v, w in graph.edges():
        cu = membership[u]
        cv = membership[v]
        if cu != cv:
            continue
        internal[cu] += 2.0 * w  # both (u,v) and (v,u); loops included

    q = 0.0
    for c, deg in degree_sum.items():
        q += internal.get(c, 0.0) / two_m - gamma * (deg / two_m) ** 2
    return q


def edge_weight_to_communities(
    graph: DynamicGraph, v: str, membership: dict[str, int]
) -> dict[int, float]:
    """Return ``{community: w(v, community)}`` over ``v``'s neighbors.

    Excludes ``v``'s self-loop; only true neighbors contribute. ``w(v, C)`` is
    the summed weight of edges from ``v`` to members of ``C``.

    Args:
        graph: The graph.
        v: The vertex.
        membership: Vertex→community map.

    Returns:
        Map from community label to total incident weight from ``v``.
    """
    out: dict[int, float] = defaultdict(float)
    for nbr, w in graph.neighbors(v).items():
        if nbr == v:
            continue
        out[membership[nbr]] += w
    return dict(out)


def modularity_gain(
    *,
    k_v: float,
    w_v_to_target: float,
    w_v_to_source: float,
    d_source: float,
    d_target: float,
    two_m: float,
    gamma: float,
) -> float:
    """Modularity gain of moving ``v`` from its source community to a target.

    Implements the spec's local move-gain form (Algorithm 2)::

        ΔQ = [w(v,C') - w(v,C)] / 2m + γ·k_v·(d(C) - k_v - d(C')) / (2m)²

    Args:
        k_v: Degree of ``v`` (``k_v = d(v)``).
        w_v_to_target: ``w(v, C')`` — weight from ``v`` into the target community.
        w_v_to_source: ``w(v, C)`` — weight from ``v`` into its current community.
        d_source: ``d(C)`` — total degree mass of the source community
            (``v`` still counted in it).
        d_target: ``d(C')`` — total degree mass of the target community.
        two_m: ``2m``.
        gamma: Resolution parameter.

    Returns:
        The modularity gain (positive means the move improves ``Q``).
    """
    if two_m <= 0.0:
        return 0.0
    linear = (w_v_to_target - w_v_to_source) / two_m
    penalty = gamma * k_v * (d_source - k_v - d_target) / (two_m * two_m)
    return linear + penalty
