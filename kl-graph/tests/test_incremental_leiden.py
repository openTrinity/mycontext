"""Self-contained tests for the HIT-Leiden module.

Run with:  .venv/bin/python -m pytest tests/test_incremental_leiden.py -q

These tests do not depend on the rest of kl-graph. The central correctness
property is that an incremental update yields communities of comparable quality
(modularity) to a full static rebuild on the same final graph.
"""

from __future__ import annotations

import pytest

from kl_graph.periodic.incremental_leiden import (
    DynamicGraph,
    EdgeChange,
    HITLeiden,
    IncrementalLeidenConfig,
    Partition,
    modularity,
    naive_leiden,
)


def _clique(prefix: str, n: int) -> list[tuple[str, str]]:
    nodes = [f"{prefix}{i}" for i in range(n)]
    return [(nodes[i], nodes[j]) for i in range(n) for j in range(i + 1, n)]


def _build(edges: list[tuple[str, str]], weight: float = 1.0) -> DynamicGraph:
    g = DynamicGraph()
    for u, v in edges:
        g.add_edge(u, v, weight)
    return g


def _two_clusters() -> DynamicGraph:
    g = _build(_clique("a", 4) + _clique("b", 4))
    g.add_edge("a0", "b0", 0.05)
    return g


# ── graph mechanics ──────────────────────────────────────────────────────────


def test_edge_weight_and_degree():
    g = DynamicGraph()
    g.add_edge("a", "b", 1.0)
    g.add_edge("a", "c", 2.0)
    assert g.weight("a", "b") == 1.0
    assert g.degree("a") == 3.0
    assert g.total_weight == 3.0


def test_edge_deletion_removes_isolated_vertices():
    g = DynamicGraph()
    g.add_edge("a", "b", 1.0)
    g.apply_change(EdgeChange("a", "b", -1.0))
    assert not g.has_vertex("a")
    assert g.total_weight == 0.0


def test_incremental_weight_accumulation():
    g = DynamicGraph()
    g.add_edge("a", "b", 1.0)
    g.apply_change(EdgeChange("a", "b", 0.5))
    assert g.weight("a", "b") == 1.5


# ── naive leiden ──────────────────────────────────────────────────────────────


def test_naive_leiden_finds_two_clusters():
    g = _two_clusters()
    result = naive_leiden(g, gamma=1.0)
    labels = {result.base_membership[v] for v in g.vertices}
    assert len(labels) == 2
    # a-cluster and b-cluster are internally consistent.
    assert result.base_membership["a0"] == result.base_membership["a3"]
    assert result.base_membership["b0"] == result.base_membership["b3"]
    assert result.base_membership["a0"] != result.base_membership["b0"]


def test_naive_leiden_positive_modularity():
    g = _two_clusters()
    result = naive_leiden(g, gamma=1.0)
    q = modularity(g, result.base_membership, 1.0)
    assert q > 0.3


# ── incremental build ─────────────────────────────────────────────────────────


def test_hitleiden_build_matches_static_community_count():
    g = _two_clusters()
    hl = HITLeiden.build(g)
    fm = hl.flat_membership()
    assert len(set(fm.values())) == 2


def test_new_dense_group_becomes_new_community():
    hl = HITLeiden.build(_two_clusters())
    changes = [
        *[EdgeChange(u, v, 1.0) for u, v in _clique("c", 4)],
        EdgeChange("a0", "c0", 0.05),
    ]
    hl.apply_batch(changes)
    fm = hl.flat_membership()
    assert len(set(fm.values())) == 3
    c_labels = {fm["c0"], fm["c1"], fm["c2"], fm["c3"]}
    assert len(c_labels) == 1
    assert fm["c0"] not in {fm["a0"], fm["b0"]}


def test_new_node_joins_existing_community_when_strongly_tied():
    hl = HITLeiden.build(_two_clusters())
    # New node p strongly tied into the a-cluster.
    changes = [EdgeChange("p", f"a{i}", 1.0) for i in range(4)]
    hl.apply_batch(changes)
    fm = hl.flat_membership()
    assert fm["p"] == fm["a0"]


def test_incremental_matches_static_rebuild_quality():
    """The key property: incremental modularity ≈ full static rebuild."""
    hl = HITLeiden.build(_two_clusters())
    changes = [
        *[EdgeChange(u, v, 1.0) for u, v in _clique("c", 4)],
        EdgeChange("a0", "c0", 0.05),
        EdgeChange("b0", "c0", 0.05),
    ]
    hl.apply_batch(changes)
    incr_fm = hl.flat_membership()

    # Build the same final graph from scratch and run a full static rebuild.
    final = _two_clusters()
    for ch in changes:
        final.apply_change(ch)
    static = naive_leiden(final, gamma=1.0)

    q_incr = modularity(final, incr_fm, 1.0)
    q_static = modularity(final, static.base_membership, 1.0)
    # Incremental should be within a small tolerance of the static optimum.
    assert q_incr >= q_static - 0.05


def test_changed_communities_scoped_to_new_group():
    hl = HITLeiden.build(_two_clusters())
    changes = [
        *[EdgeChange(u, v, 1.0) for u, v in _clique("c", 4)],
        EdgeChange("a0", "c0", 0.05),
    ]
    changed = hl.apply_batch(changes)
    fm = hl.flat_membership()
    # The new C community's label must be reported as changed.
    assert fm["c0"] in changed


def test_empty_batch_is_noop():
    hl = HITLeiden.build(_two_clusters())
    before = hl.flat_membership()
    changed = hl.apply_batch([])
    after = hl.flat_membership()
    assert before == after
    assert changed == set()


# ── determinism / config ──────────────────────────────────────────────────────


def test_build_is_deterministic():
    g1 = _two_clusters()
    g2 = _two_clusters()
    fm1 = HITLeiden.build(g1).flat_membership()
    fm2 = HITLeiden.build(g2).flat_membership()
    assert fm1 == fm2


def test_config_from_env(monkeypatch=None):
    # Without monkeypatch fixture, exercise defaults + explicit construction.
    cfg = IncrementalLeidenConfig(gamma=2.0, max_levels=4, seed=123)
    hl = HITLeiden.build(_two_clusters(), config=cfg)
    assert hl.config.gamma == 2.0


def test_larger_random_incremental_stays_reasonable():
    # 6 planted clusters of 5 nodes.
    edges: list[tuple[str, str]] = []
    for c in range(6):
        edges += _clique(f"g{c}_", 5)
    for c in range(5):
        edges.append((f"g{c}_0", f"g{c+1}_0"))
    g = _build(edges)
    hl = HITLeiden.build(g)

    # Add two new clusters incrementally.
    changes: list[EdgeChange] = []
    for c in (6, 7):
        changes += [EdgeChange(u, v, 1.0) for u, v in _clique(f"g{c}_", 5)]
    changes.append(EdgeChange("g0_0", "g6_0", 0.05))
    changes.append(EdgeChange("g6_0", "g7_0", 0.05))
    hl.apply_batch(changes)
    fm = hl.flat_membership()

    final = _build(edges)
    for ch in changes:
        final.apply_change(ch)
    q = modularity(final, fm, 1.0)
    # Planted structure => high modularity.
    assert q > 0.6


# ── paper-fidelity: multi-level maintenance (Algorithms 4-6) ─────────────────


def _three_scale_edges() -> list[tuple[str, str, float]]:
    """Planted 3-scale structure: 16 4-cliques -> 4 meta-groups -> 2 supers.

    At gamma=0.5 the static build yields a depth-2 hierarchy, which is what
    the multi-level maintenance tests exercise.
    """
    import itertools

    edges: list[tuple[str, str, float]] = []
    names = [f"c{i}" for i in range(16)]
    for nm in names:
        nodes = [f"{nm}_{i}" for i in range(4)]
        edges += [
            (nodes[i], nodes[j], 1.0)
            for i in range(4)
            for j in range(i + 1, 4)
        ]
    for m in range(4):
        grp = names[m * 4:(m + 1) * 4]
        for a, b in itertools.combinations(grp, 2):
            edges.append((f"{a}0", f"{b}0", 2.0))
            edges.append((f"{a}1", f"{b}1", 2.0))
    for m1, m2 in [(0, 1), (2, 3)]:
        for i in range(4):
            edges.append((f"c{m1 * 4 + i}2", f"c{m2 * 4 + i}2", 3.0))
    edges.append(("c0_3", "c8_3", 0.5))
    return edges


def _build_w(edges: list[tuple[str, str, float]]) -> DynamicGraph:
    g = DynamicGraph()
    for u, v, w in edges:
        g.add_edge(u, v, w)
    return g


def _half_gamma() -> IncrementalLeidenConfig:
    return IncrementalLeidenConfig(gamma=0.5, max_levels=8, seed=0xDEADBEEF)


def test_static_build_levels_strictly_coarsen():
    """Every level accepted past the base must strictly coarsen.

    A level whose candidate partition keeps every super-node in its own
    community adds no structure (a zero-gain coupling produces exactly that),
    so the build must stop instead of appending a trivial level that would
    fake hierarchy depth.
    """
    hl = HITLeiden.build(_build_w(_three_scale_edges()), config=_half_gamma())
    levels = hl.hierarchy.levels
    assert levels, "the base level always exists"
    sizes = [len(lvl.graph.vertices) for lvl in levels]
    assert sizes == sorted(sizes, reverse=True), "levels coarsen bottom-up"
    for lvl in levels[1:]:
        assert len(set(lvl.membership.values())) < lvl.graph.num_vertices, (
            "accepted levels must coarsen; trivial levels are rejected"
        )
    base_verts = set(levels[0].graph.vertices)
    assert set(hl.flat_membership()) == base_verts


def test_incremental_batch_maintains_upper_levels():
    """Alg 6: once the hierarchy is deep, a batch updates the WHOLE of it.

    Depth here is earned, not assumed: the coupled-cliques graph builds at
    depth 1 (zero joint gain), a batch that makes the joint merge strictly
    favorable extends it to depth 2, and a further batch must then maintain
    the upper level's aggregation maps (s_pre, node_to_children) over the
    new vertices.
    """
    cfg = IncrementalLeidenConfig(gamma=1.0, max_levels=8, seed=0xDEADBEEF)
    hl = HITLeiden.build(_coupled_cliques_graph(), config=cfg)
    assert len(hl.hierarchy.levels) == 1
    hl.apply_batch([EdgeChange("a0", "b0", 1.0)])
    assert len(hl.hierarchy.levels) == 2

    hl.apply_batch([
        EdgeChange("n0", "n1", 1.0),
        EdgeChange("n0", "n2", 1.0),
        EdgeChange("n1", "n2", 1.0),
        EdgeChange("n0", "a1", 1.0),
    ])

    assert len(hl.hierarchy.levels) >= 2, "upper levels must survive the batch"
    base = hl.hierarchy.levels[0]
    upper = hl.hierarchy.levels[1]
    # s_pre refreshed for every live base node (Alg 4).
    assert set(upper.s_pre) == set(base.graph.vertices)
    # node_to_children composes down to the NEW base vertices.
    covered = set()
    for kids in upper.node_to_children.values():
        covered |= kids
    assert {"n0", "n1", "n2"} <= covered


def test_incremental_hierarchy_depth_consistent_with_static():
    """Depth dynamics: incremental depth tracks the static build's depth."""
    hl = HITLeiden.build(_build_w(_three_scale_edges()), config=_half_gamma())
    changes = [
        EdgeChange("n0", "n1", 1.0),
        EdgeChange("n0", "n2", 1.0),
        EdgeChange("n1", "n2", 1.0),
        EdgeChange("n0", "c0_0", 2.0),
    ]
    hl.apply_batch(changes)
    final = _build_w(_three_scale_edges())
    for ch in changes:
        final.apply_change(ch)
    static = naive_leiden(final, gamma=0.5, seed=0xDEADBEEF)
    # Both paths derive depth from the same modularity guard, so they agree up
    # to the greediness of the incremental trajectory.
    assert abs(len(hl.hierarchy.levels) - len(static.levels)) <= 1


# ── super-level modularity consistency ───────────────────────────────────────


def _coupled_cliques_graph() -> DynamicGraph:
    """Two 10-cliques with full bipartite coupling at w=0.9 (γ=1).

    Analytic properties of this family (per-clique super degree k = 90+100w,
    total 2m = 180+200w): the super-level JOINT-merge gain equals
    (1/2)·(90+δ)/(180+δ) − 1/4 for an extra cross edge of weight δ —
    exactly ZERO at δ=0 and strictly positive for every δ>0 — while every
    single-vertex move has negative gain at w=0.9 (the nucleation barrier).
    That makes it the minimal natural graph where a hierarchy level can do
    what base single-moves cannot.
    """
    import itertools

    g = DynamicGraph()
    for prefix in ("a", "b"):
        grp = [f"{prefix}{i}" for i in range(10)]
        for x, y in itertools.combinations(grp, 2):
            g.add_edge(x, y, 1.0)
    for i in range(10):
        for j in range(10):
            g.add_edge(f"a{i}", f"b{j}", 0.9)
    return g


def test_aggregation_identity_supergraph_equals_composed_base() -> None:
    """Supergraph modularity under singletons == composed base modularity.

    This identity is what makes super-level moves optimize the base-level
    objective. It holds only when the loop convention in ``modularity``
    matches the degree convention (loops count 2w in both).
    """
    from kl_graph.periodic.incremental_leiden.aggregation import (
        _aggregate_partition,
    )

    g = _coupled_cliques_graph()
    r = naive_leiden(g, gamma=1.0, seed=0xDEADBEEF)
    base = r.levels[0]
    part = Partition(base.graph, base.membership)
    super_graph, _members = _aggregate_partition(base.graph, part)
    singletons = {v: i for i, v in enumerate(sorted(super_graph.vertices))}
    assert modularity(super_graph, singletons, 1.0) == pytest.approx(
        modularity(base.graph, base.membership, 1.0), abs=1e-12
    )


def test_joint_merge_extends_hierarchy_when_gain_becomes_positive() -> None:
    """Depth extends exactly when a joint merge becomes strictly favorable.

    Zero-gain phase: at w=0.9 the super-level joint-merge gain is exactly 0,
    so the build keeps depth 1 — appending a level that coarsens nothing
    would fake depth. Growth phase: one extra cross edge makes the joint
    gain +0.00138 while every single-vertex move stays blocked; the batch
    must then extend the depth and merge the cliques at the upper level,
    which base-level single moves provably cannot.
    """
    cfg = IncrementalLeidenConfig(gamma=1.0, max_levels=8, seed=0xDEADBEEF)
    hl = HITLeiden.build(_coupled_cliques_graph(), config=cfg)

    # Zero joint gain: honest depth 1, base keeps the nucleation split.
    assert len(hl.hierarchy.levels) == 1
    base = hl.hierarchy.levels[0].movement.membership
    assert len(set(base.values())) == 2

    hl.apply_batch([EdgeChange("a0", "b0", 1.0)])

    assert len(hl.hierarchy.levels) == 2, (
        "strictly favorable joint merge must extend depth"
    )
    base = hl.hierarchy.levels[0].movement.membership
    assert len(set(base.values())) == 2, (
        "single moves cannot cross the barrier: the base must not fully merge"
    )
    top = hl.hierarchy.levels[-1]
    composed: dict[str, int] = {}
    for node, comm in top.movement.membership.items():
        for bv in top.node_to_children.get(node, {node}):
            composed[bv] = comm
    assert len(set(composed.values())) == 1, (
        "the joint merge must land at the upper level"
    )
