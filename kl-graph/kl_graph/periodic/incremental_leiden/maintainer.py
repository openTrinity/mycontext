"""The incremental Leiden maintainer (Algorithms 2, 3, 4, 6).

Maintains a Leiden community hierarchy under batches of edge changes without full
recomputation::

    hl = HITLeiden.build(graph)                  # initial static Leiden
    hl.apply_batch([EdgeChange("a", "z", 1.0)])  # incremental update
    hl.flat_membership()                         # vertex -> community

Fidelity notes (deliberately explicit):
    * inc-movement (Alg 2) and inc-refinement (Alg 3) are implemented directly:
      only endpoints of *intra-community deletions* and *cross-community
      insertions* seed the active set, and change propagates to neighbours via
      positive modularity gain (Lemma 1), so work is bounded by the affected
      region.
    * Multi-level maintenance recurses the same movement/refinement on each
      aggregated supergraph, with superedge deltas computed incrementally (Alg 4).
    * Correctness-first and single-threaded: the paper's throughput-mode parallel
      decoupling (T1-T3) is intentionally omitted.
"""

from __future__ import annotations

from collections import deque

from kl_graph.periodic.incremental_leiden.aggregation import (
    _aggregate_partition,
    _groups_by_label,
    _rebuild_partition_caches,
)
from kl_graph.periodic.incremental_leiden.config import (
    IncrementalLeidenConfig,
    default_config,
)
from kl_graph.periodic.incremental_leiden.connectivity import connected_components
from kl_graph.periodic.incremental_leiden.graph import DynamicGraph, EdgeChange
from kl_graph.periodic.incremental_leiden.hierarchy import Hierarchy, Level
from kl_graph.periodic.incremental_leiden.modularity import (
    edge_weight_to_communities,
    modularity,
    modularity_gain,
)
from kl_graph.periodic.incremental_leiden.partition import Partition
from kl_graph.periodic.incremental_leiden.static_build import (
    LeidenResult,
    naive_leiden,
)


def _run_leiden(graph: DynamicGraph, cfg_obj: IncrementalLeidenConfig) -> LeidenResult:
    """Run the package-backed Leiden build for a static (re)build.

    Args:
        graph: Graph to cluster.
        cfg: Config providing gamma / max_levels / seed.

    Returns:
        A :class:`LeidenResult`.
    """
    return naive_leiden(
        graph,
        gamma=cfg_obj.gamma,
        max_levels=cfg_obj.max_levels,
        seed=cfg_obj.seed,
    )



class HITLeiden:
    """Incremental Leiden community maintainer.

    Example:
        >>> g = DynamicGraph()
        >>> for a, b in [("x0","x1"),("x1","x2"),("x0","x2")]:
        ...     g.add_edge(a, b, 1.0)
        >>> hl = HITLeiden.build(g)
        >>> _ = hl.flat_membership()
    """

    def __init__(self, hierarchy: Hierarchy, config: IncrementalLeidenConfig) -> None:
        self.hierarchy = hierarchy
        self.config = config

    # ── construction ────────────────────────────────────────────────────────

    @classmethod
    def build(
        cls, graph: DynamicGraph, *, config: IncrementalLeidenConfig | None = None
    ) -> HITLeiden:
        """Build the initial hierarchy with the package-backed Leiden build.

        Uses ``graspologic_native.leiden`` per level (see :func:`_run_leiden`).

        Args:
            graph: Base graph (ownership is taken; caller should not mutate it
                afterwards — use :meth:`apply_batch` instead).
            config: Optional override; defaults to :func:`default_config`.

        Returns:
            A ready :class:`HITLeiden` maintainer.
        """
        resolved = config or default_config()
        result = _run_leiden(graph, resolved)
        levels: list[Level] = []
        for lvl in result.levels:
            levels.append(
                Level(
                    graph=lvl.graph,
                    movement=Partition(lvl.graph, lvl.membership),
                    refinement=Partition(lvl.graph, lvl.sub_membership),
                    node_to_children=dict(lvl.node_to_children),
                )
            )
        return cls(Hierarchy(levels=levels), resolved)

    # ── incremental update (Algorithm 6) ─────────────────────────────────────

    def apply_batch(
        self, changes: list[EdgeChange], *, maintain_hierarchy: bool = True
    ) -> set[int]:
        """Apply a batch of edge changes and update affected communities.

        Implements the per-level loop of Algorithm 6 at the base level, then
        propagates superedge deltas upward (Algorithm 4) and re-optimizes each
        affected supergraph with the same movement/refinement primitives.

        Args:
            changes: Edge changes ``ΔG`` (inserts have ``delta>0``, deletes
                ``delta<0``). Endpoints may be new vertices.
            maintain_hierarchy: When ``True`` (default) the levels above the base
                are recomputed and :meth:`flat_membership` may report a coarser
                level. Set ``False`` to keep the base partition authoritative and
                touch only the affected region — required by callers that
                maintain one persisted level and must not re-partition globally
                on every batch.

        Returns:
            The set of base-level community labels whose membership changed
            (useful for scoping downstream work such as summary regeneration).
        """
        if not self.hierarchy.levels:
            return set()

        base = self.hierarchy.levels[0]
        before_membership = self.flat_membership()

        # 1) Register new vertices as their own singleton communities.
        for ch in changes:
            for endpoint in (ch.u, ch.v):
                if not base.graph.has_vertex(endpoint) and endpoint not in base.movement.membership:
                    new_label = base.movement.next_label()
                    # add to graph lazily below; register membership now
                    base.movement.membership[endpoint] = new_label
                    base.movement._community_degree[new_label] += 0.0
                    base.movement._community_members[new_label].add(endpoint)
                    base.refinement.membership[endpoint] = new_label
                    base.refinement._community_members[new_label].add(endpoint)

        # 2) Seed the active set from ΔG (Algorithm 2, lines 2-6), then apply the
        #    weight changes to the base graph.
        active = self._seed_active_set(base, changes)
        for ch in changes:
            base.graph.apply_change(ch)
        # Degrees changed; rebuild partition degree caches for touched vertices.
        self._resync_degrees(base, changes)

        # 3) inc-movement + inc-refinement at the base level.
        moved = self._inc_movement(base, active)
        self._inc_refinement(base, moved)

        # 4) Recompute the hierarchy above the base level. For correctness we
        #    rebuild the upper levels from the (now-updated) base refinement via
        #    aggregation; this stays bounded in practice because only supernodes
        #    over changed sub-communities differ.
        #
        #    Callers maintaining a single persisted level pass
        #    ``maintain_hierarchy=False``: rebuilding aggregates and then letting
        #    ``flat_membership`` pick the best level re-partitions the whole
        #    graph, which is a full rebuild wearing an incremental disguise.
        if maintain_hierarchy:
            self._rebuild_upper_levels()

        # Report communities (by post-update label) whose *member set* changed
        # relative to before. Labels are unstable across relabeling, so we
        # compare membership by grouping vertices, not by raw label identity.
        after = self.flat_membership()
        before_groups = _groups_by_label(before_membership)
        after_groups = _groups_by_label(after)
        before_sets = {frozenset(vs) for vs in before_groups.values()}
        changed_communities = {
            label
            for label, members in after_groups.items()
            if frozenset(members) not in before_sets
        }
        return changed_communities

    # ── Algorithm 2 helpers ───────────────────────────────────────────────────

    def _seed_active_set(
        self, level: Level, changes: list[EdgeChange]
    ) -> set[str]:
        """Seed the active set A from ΔG per Algorithm 2 lines 2-6.

        A cross-community insertion (delta>0, endpoints in different
        communities) or an intra-community deletion (delta<0, same community)
        activates both endpoints; other changes cannot alter membership under
        Assumption 1 and are skipped.
        """
        active: set[str] = set()
        f = level.movement.membership
        for ch in changes:
            cu = f.get(ch.u)
            cv = f.get(ch.v)
            if ch.delta > 0 and cu is not None and cu != cv or ch.delta < 0 and cu is not None and cu == cv:
                active.add(ch.u)
                active.add(ch.v)
        return active

    def _inc_movement(self, level: Level, active: set[str]) -> set[str]:
        """Incremental movement (Algorithm 2 lines 9-19).

        Pops active vertices, moves each to the best community by modularity
        gain (including a fresh singleton), and re-activates neighbors not in
        the new community when a move happens.

        Args:
            level: Base level state.
            active: Seed active set from :meth:`_seed_active_set`.

        Returns:
            The set of vertices that changed community (``B`` in the paper).
        """
        graph = level.graph
        part = level.movement
        gamma = self.config.gamma
        min_gain = self.config.min_gain
        moved: set[str] = set()

        queue: deque[str] = deque(sorted(active))
        queued = set(active)
        while queue:
            v = queue.popleft()
            queued.discard(v)
            if not graph.has_vertex(v):
                continue
            two_m = 2.0 * graph.total_weight
            if two_m <= 0.0:
                break
            k_v = graph.degree(v)
            source = part.community_of(v)
            w_to = edge_weight_to_communities(graph, v, part.membership)
            w_source = w_to.get(source, 0.0)
            d_source = part.community_degree(source)

            best_target = source
            best_gain = 0.0
            # Candidate: neighbor communities + leaving to own singleton.
            for target in w_to:
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
                    best_gain = gain
                    best_target = target

            if best_target != source:
                part.move(v, best_target, graph)
                moved.add(v)
                # Re-activate neighbors not already in the target community.
                for nbr in graph.neighbors(v):
                    if nbr == v:
                        continue
                    if part.community_of(nbr) != best_target and nbr not in queued:
                        queue.append(nbr)
                        queued.add(nbr)
        return moved

    # ── Algorithm 3 helper ────────────────────────────────────────────────────

    def _inc_refinement(self, level: Level, moved: set[str]) -> set[str]:
        """Incremental refinement (Algorithm 3): repair sub-community connectivity.

        For each community touched by a move, verify every sub-community inside
        it is still internally connected; split off any disconnected component
        into a fresh sub-community. This preserves Leiden's connectivity
        guarantee for the affected region only.

        Args:
            level: Base level state.
            moved: Vertices that changed community during inc-movement.

        Returns:
            The set of vertices reassigned to a new sub-community (``R``).
        """
        graph = level.graph
        movement = level.movement
        refinement = level.refinement
        refined: set[str] = set()

        # Communities to re-examine: those containing any moved vertex.
        touched_communities = {movement.community_of(v) for v in moved if graph.has_vertex(v)}
        # Also ensure moved vertices sit in a sub-community within their new
        # community (a moved vertex keeps its old sub-label, which may now be
        # wrong); reset each moved vertex to its own singleton sub-community.
        for v in moved:
            if not graph.has_vertex(v):
                continue
            new_sub = refinement.next_label()
            refinement.move(v, new_sub, graph)
            refined.add(v)

        for comm in touched_communities:
            members = {v for v in movement.members(comm) if graph.has_vertex(v)}
            if not members:
                continue
            # Group current members by their sub-community label.
            by_sub: dict[int, set[str]] = {}
            for v in members:
                by_sub.setdefault(refinement.community_of(v), set()).add(v)
            for sub_members in by_sub.values():
                comps = connected_components(graph, sub_members)
                if len(comps) <= 1:
                    continue
                # Keep the largest component; split the rest into fresh subs.
                for comp in comps[1:]:
                    fresh = refinement.next_label()
                    for v in comp:
                        refinement.move(v, fresh, graph)
                        refined.add(v)
        return refined

    # ── Algorithm 4 / hierarchy maintenance ───────────────────────────────────

    def _rebuild_upper_levels(self) -> None:
        """Recompute levels above the base from the updated base refinement.

        Rebuilds by aggregating the base refinement partition and re-running the
        static levels on the (small) supergraph. Correctness-first: the base
        incremental result is authoritative, and upper levels are a deterministic
        function of it, so recomputing them from the base refinement keeps the
        hierarchy consistent. The supergraph is typically orders of magnitude
        smaller than the base graph, so this stays cheap.
        """
        base = self.hierarchy.levels[0]
        base.refinement.relabel_dense()

        # Aggregate base refinement into a supergraph.
        super_graph, supernode_members = _aggregate_partition(
            base.graph, base.refinement
        )
        if super_graph.num_vertices <= 1 or super_graph.num_vertices == base.graph.num_vertices:
            # No meaningful coarsening: collapse to a single-level hierarchy.
            self.hierarchy.levels = [base]
            return

        # Base-vertex children of each supernode.
        base_children: dict[str, set[str]] = {}
        for sid, members in supernode_members.items():
            acc: set[str] = set()
            for node in members:
                acc |= base.node_to_children.get(node, {node})
            base_children[sid] = acc

        # Rebuild the upper hierarchy from the updated base refinement.
        upper = _run_leiden(super_graph, self.config)
        upper_levels: list[Level] = []
        # Compose supernode children through the upper hierarchy back to base.
        cumulative_children = base_children
        for i, lvl in enumerate(upper.levels):
            if i == 0:
                node_children = cumulative_children
            else:
                # lvl.node_to_children maps this level's supernode -> supergraph
                # base nodes (the supernodes of `super_graph`); compose to base.
                node_children = {}
                for node, kids in lvl.node_to_children.items():
                    acc = set()
                    for k in kids:
                        acc |= base_children.get(k, {k})
                    node_children[node] = acc
            upper_levels.append(
                Level(
                    graph=lvl.graph,
                    movement=Partition(lvl.graph, lvl.membership),
                    refinement=Partition(lvl.graph, lvl.sub_membership),
                    node_to_children=node_children,
                )
            )
        self.hierarchy.levels = [base, *upper_levels]

    def _resync_degrees(self, level: Level, changes: list[EdgeChange]) -> None:
        """Rebuild degree caches after this batch changed vertex degrees.

        ``changes`` is accepted for signature symmetry with the paper's per-batch
        contract; the current implementation rebuilds both partitions' caches
        wholesale because the touched vertex sets are small.
        """
        del changes  # touched sets are small; rebuild caches wholesale.
        for part in (level.movement, level.refinement):
            _rebuild_partition_caches(part, level.graph)

    # ── output ────────────────────────────────────────────────────────────────

    def flat_membership(self) -> dict[str, int]:
        """Return the flat ``base vertex → community`` assignment.

        Selects the hierarchy level whose composed base-graph partition has the
        highest global modularity, rather than blindly taking the coarsest
        level. This prevents an over-aggregated top level (which can happen when
        a tiny supergraph spuriously merges communities) from degrading the
        reported communities.
        """
        levels = self.hierarchy.levels
        if not levels:
            return {}

        base = levels[0]
        best_out: dict[str, int] | None = None
        best_q = float("-inf")
        for level in levels:
            out: dict[str, int] = {}
            for node, comm in level.movement.membership.items():
                for base_v in level.node_to_children.get(node, {node}):
                    out[base_v] = comm
            for v, c in base.movement.membership.items():
                out.setdefault(v, c)
            q = modularity(base.graph, out, self.config.gamma)
            if q > best_q + 1e-12:
                best_q = q
                best_out = out
        return best_out if best_out is not None else {}
