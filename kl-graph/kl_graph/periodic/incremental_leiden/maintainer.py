"""The incremental Leiden maintainer (Algorithms 2, 3, 4, 5, 6).

Maintains a Leiden community hierarchy under batches of edge changes without
full recomputation, following Lin et al., "Efficient Maintenance of Leiden
Communities in Large Dynamic Graphs" (arXiv:2601.08554) and the reference
implementation's ``docs/math/hit_leiden_spec.md``
(github.com/randomvariable/hit-leiden)::

    hl = HITLeiden.build(graph)                  # initial static Leiden
    hl.apply_batch([EdgeChange("a", "z", 1.0)])  # incremental update
    hl.flat_membership()                         # vertex -> community

Per-batch structure (Algorithm 6): for each level ``p`` — apply the level's
edge deltas ``ΔG^p``, run inc-movement (Alg 2) and inc-refinement (Alg 3),
then lift the deltas one level up with inc-aggregation (Alg 4). After the
loop, def-update (Alg 5) propagates coarse-level moves downward. The base
level is the FINEST partition (``levels[0]``); deeper levels are aggregation
supergraphs, exactly as produced by :func:`static_build.naive_leiden`, so the
static and incremental paths maintain the SAME hierarchy object.

Fidelity notes (deliberately explicit):
    * inc-movement (Alg 2) and inc-refinement (Alg 3) are implemented
      directly, including the refinement ``K`` set and the singleton
      sub-community merge-back (Alg 3 lines 5-13). Connectivity is recomputed
      by BFS over the affected sub-community instead of the paper's dynamic
      ``G_Ψ`` index — correctness-first, same outcome, bounded by the region.
    * inc-aggregation (Alg 4) lifts ``ΔG^p`` and the refined set ``R^p`` into
      supergraph deltas ``ΔH`` with old/new sub-community coordinate swaps,
      so upper levels are UPDATED incrementally, never rebuilt wholesale.
    * def-update (Alg 5) runs top-down after the per-level loop.
    * The throughput-mode parallel decoupling (T1) and monotonicity guard
      (T2) are intentionally omitted (single-threaded correctness-first);
      the T3 aggregation skip (empty delta AND empty refined set) is applied.
"""

from __future__ import annotations

from collections import defaultdict, deque

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
    _leiden_flat_moves,
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
                    s_pre=dict(lvl.s_pre),
                )
            )
        return cls(Hierarchy(levels=levels), resolved)

    # ── incremental update (Algorithm 6) ────────────────────────────────────

    def apply_batch(
        self, changes: list[EdgeChange], *, maintain_hierarchy: bool = True
    ) -> set[int]:
        """Apply a batch of edge changes and update affected communities.

        Algorithm 6: for each level, apply ``ΔG^p``, run inc-movement and
        inc-refinement, and lift the deltas upward with inc-aggregation; then
        def-update propagates coarse moves downward. New vertices may appear
        as change endpoints.

        Args:
            changes: Edge changes ``ΔG`` (inserts have ``delta>0``, deletes
                ``delta<0``). Endpoints may be new vertices.
            maintain_hierarchy: When ``True`` (default) the whole hierarchy is
                maintained incrementally (Algorithms 4-6). Set ``False`` to
                update only the base level — for callers that persist a single
                flat partition.

        Returns:
            The set of base-level community labels whose membership changed
            (useful for scoping downstream work such as summary regeneration).
        """
        if not self.hierarchy.levels:
            return set()
        base = self.hierarchy.levels[0]
        if not changes:
            return set()
        before_membership = dict(base.movement.membership)

        # New base vertices start as singletons in movement and refinement,
        # the state the incremental phases expect before processing insertions.
        self._register_new_vertices(base, changes)

        # ── Level 0: seed, apply ΔG, inc-movement, inc-refinement ──────────
        active = self._seed_active_set(base, changes)
        for ch in changes:
            base.graph.apply_change(ch)
        self._resync_degrees(base, changes)
        self._prune_vanished(base)
        moved, affected = self._inc_movement(base, active, changes)
        refined = self._inc_refinement(base, affected, moved)
        moved_per_level: list[set[str]] = [moved]

        if maintain_hierarchy:
            delta: list[EdgeChange] = list(changes)
            refined_prev: set[str] = refined
            for p in range(1, len(self.hierarchy.levels)):
                # T3 skip: nothing propagated this far — upper levels keep
                # their state untouched.
                if not delta and not refined_prev:
                    break
                upper = self.hierarchy.levels[p]
                lower = self.hierarchy.levels[p - 1]
                # Alg 4: lift deltas + refinement moves to this level.
                delta_p = self._inc_aggregation(lower, upper, delta, refined_prev)
                known = set(upper.movement.membership)
                self._register_new_vertices(upper, delta_p)
                # Freshly seeded super-nodes own a NEW community identity:
                # treat them as moved so Algorithm 5 propagates that identity
                # down to their whole subtree — otherwise base vertices that
                # did not move themselves keep stale labels and the nesting
                # invariant (a base community lives under one super-node's
                # community) silently breaks.
                fresh = set(upper.movement.membership) - known
                active_p = self._seed_active_set(upper, delta_p)
                for ch in delta_p:
                    upper.graph.apply_change(ch)
                self._resync_degrees(upper, delta_p)
                self._prune_vanished(upper)
                moved_p, affected_p = self._inc_movement(upper, active_p, delta_p)
                moved_p |= fresh
                refined_p = self._inc_refinement(upper, affected_p, moved_p)
                moved_per_level.append(moved_p)
                delta, refined_prev = delta_p, refined_p

            # Hierarchy depth dynamics: prune collapsed top levels, extend by
            # one aggregation level when coarsening pays off (mirrors the
            # static build's modularity guard).
            self._adjust_depth()
            # Alg 5: deferred update, top-down.
            self._def_update(moved_per_level)

        # Report communities (by post-update label) whose *member set* changed
        # relative to before. Labels are unstable across relabeling, so we
        # compare membership by grouping vertices, not by raw label identity.
        after = dict(base.movement.membership)
        before_groups = _groups_by_label(before_membership)
        after_groups = _groups_by_label(after)
        before_sets = {frozenset(vs) for vs in before_groups.values()}
        return {
            label
            for label, members in after_groups.items()
            if frozenset(members) not in before_sets
        }

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
            if cu is None and cv is None:
                continue
            if ch.delta > 0 and cu != cv or ch.delta < 0 and cu == cv:
                active.add(ch.u)
                active.add(ch.v)
        return active

    def _inc_movement(
        self, level: Level, active: set[str], changes: list[EdgeChange]
    ) -> tuple[set[str], set[str]]:
        """Incremental movement (Algorithm 2 lines 9-19).

        Pops active vertices, moves each to the best community by modularity
        gain (including a fresh singleton), and re-activates neighbors not in
        the new community when a move happens.

        Args:
            level: The level state.
            active: Seed active set from :meth:`_seed_active_set`.
            changes: The level's ``ΔG`` (used for the ``K`` seed, lines 7-8).

        Returns:
            ``(moved, affected)`` — ``B`` (vertices that changed community) and
            ``K`` (vertices whose sub-community connectivity the batch
            touched), which Algorithm 3 consumes.
        """
        graph = level.graph
        part = level.movement
        ref = level.refinement
        gamma = self.config.gamma
        min_gain = self.config.min_gain
        moved: set[str] = set()

        # K seed (lines 7-8): ΔG endpoints sharing a sub-community may have
        # had their connectivity changed.
        affected: set[str] = set()
        for ch in changes:
            cu = ref.membership.get(ch.u)
            cv = ref.membership.get(ch.v)
            if cu is not None and cu == cv:
                affected.add(ch.u)
                affected.add(ch.v)

        queue: deque[str] = deque(sorted(active))
        queued = set(active)
        while queue:
            v = queue.popleft()
            queued.discard(v)
            if not graph.has_vertex(v) or v not in part.membership:
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
                    best_gain = gain
                    best_target = target

            if best_target != source:
                part.move(v, best_target, graph)
                moved.add(v)
                # Re-activate neighbors not already in the target community
                # (lines 14-16), and mark same-sub-community neighbors for
                # refinement (lines 17-19).
                sub_v = ref.membership.get(v)
                for nbr in sorted(graph.neighbors(v)):
                    if nbr == v:
                        continue
                    if sub_v is not None and ref.membership.get(nbr) == sub_v:
                        affected.add(v)
                        affected.add(nbr)
                    if (
                        nbr in part.membership
                        and part.community_of(nbr) != best_target
                        and nbr not in queued
                    ):
                        queue.append(nbr)
                        queued.add(nbr)
        return moved, affected

    # ── Algorithm 3 helper ────────────────────────────────────────────────────

    def _inc_refinement(
        self, level: Level, affected: set[str], moved: set[str]
    ) -> set[str]:
        """Incremental refinement (Algorithm 3): repair sub-community structure.

        Three phases:
        1. Vertices that moved community are reset to singleton sub-communities
           (a move keeps the old sub-label, which would otherwise span two
           movement communities and break the "refinement refines movement"
           invariant).
        2. Lines 2-4: among ``K`` (``affected``), split any sub-community that
           became internally disconnected, largest component keeps the label.
        3. Lines 5-13: singleton sub-communities merge back into the best
           neighbouring sub-community of the SAME movement community, gated by
           the T-filter (only targets whose own split would not improve Q) and
           a positive merge gain.

        Args:
            level: The level state.
            affected: ``K`` from :meth:`_inc_movement`.
            moved: ``B`` from :meth:`_inc_movement`.

        Returns:
            The set of vertices whose sub-community changed (``R``).
        """
        graph = level.graph
        movement = level.movement
        refinement = level.refinement
        refined: set[str] = set()

        # Phase 1: moved vertices reset to singleton subs.
        for v in sorted(moved):
            if not graph.has_vertex(v) or v not in refinement.membership:
                continue
            new_sub = refinement.next_label()
            refinement.move(v, new_sub, graph)
            refined.add(v)

        # Phase 2: split disconnected sub-communities among K.
        examined: set[int] = set()
        for v in sorted(affected):
            if not graph.has_vertex(v) or v not in refinement.membership:
                continue
            sub = refinement.community_of(v)
            if sub in examined:
                continue
            examined.add(sub)
            members = {x for x in refinement.members(sub) if graph.has_vertex(x)}
            if len(members) <= 1:
                continue
            comps = connected_components(graph, members)
            if len(comps) <= 1:
                continue
            # Keep the largest component; split the rest into fresh subs.
            for comp in comps[1:]:
                fresh = refinement.next_label()
                for x in sorted(comp):
                    refinement.move(x, fresh, graph)
                    refined.add(x)

        # Phase 3: singleton merge-back (lines 5-13).
        gamma = self.config.gamma
        min_gain = self.config.min_gain
        for v in sorted(refined):
            if not graph.has_vertex(v) or v not in refinement.membership:
                continue
            sub_v = refinement.community_of(v)
            if len(refinement.members(sub_v)) != 1:
                continue
            if v not in movement.membership:
                continue
            comm_v = movement.community_of(v)
            two_m = 2.0 * graph.total_weight
            if two_m <= 0.0:
                break
            # Candidate sub-communities: neighbours' subs within the same
            # movement community, filtered by the T-rule (a target whose own
            # split WOULD improve Q is too unstable to absorb anyone).
            candidates: set[int] = set()
            for nbr in sorted(graph.neighbors(v)):
                if nbr == v or nbr not in movement.membership:
                    continue
                if movement.community_of(nbr) != comm_v:
                    continue
                if nbr not in refinement.membership:
                    continue
                s_nbr = refinement.community_of(nbr)
                if s_nbr == sub_v or s_nbr in candidates:
                    continue
                if (
                    self._sub_split_gain(graph, refinement, movement, s_nbr, two_m, gamma)
                    <= 0.0
                ):
                    candidates.add(s_nbr)
            if not candidates:
                continue
            k_v = graph.degree(v)
            w_to = edge_weight_to_communities(graph, v, refinement.membership)
            best_sub, best_gain = sub_v, 0.0
            for target in sorted(candidates):
                gain = modularity_gain(
                    k_v=k_v,
                    w_v_to_target=w_to.get(target, 0.0),
                    w_v_to_source=0.0,  # singleton source has no internal weight
                    d_source=k_v,
                    d_target=refinement.community_degree(target),
                    two_m=two_m,
                    gamma=gamma,
                )
                if gain > best_gain + min_gain:
                    best_gain = gain
                    best_sub = target
            if best_sub != sub_v:
                refinement.move(v, best_sub, graph)
        return refined

    def _sub_split_gain(
        self,
        graph: DynamicGraph,
        refinement: Partition,
        movement: Partition,
        sub: int,
        two_m: float,
        gamma: float,
    ) -> float:
        """ΔQ of moving sub-community ``sub`` out to isolation.

        The T-filter term ``ΔQ(s(v) → ∅, γ)`` of Algorithm 3 line 7: the
        modularity gain of the whole sub-community leaving its movement
        community for a fresh singleton community. Non-positive means the
        sub-community is stable enough to serve as a merge target.
        """
        members = sorted(
            x for x in refinement.members(sub) if graph.has_vertex(x)
        )
        if not members:
            return 0.0
        member_set = set(members)
        first = members[0]
        comm = movement.membership.get(first)
        comm_members = movement.members(comm) if comm is not None else set()
        k_s = 0.0
        w_out = 0.0
        for x in members:
            k_s += graph.degree(x)
            for nbr, w in graph.neighbors(x).items():
                if nbr not in member_set and nbr in comm_members:
                    w_out += w
        d_comm = movement.community_degree(comm) if comm is not None else k_s
        return -w_out / two_m + gamma * k_s * (d_comm - k_s) / (two_m * two_m)

    # ── Algorithm 4 helper ────────────────────────────────────────────────────

    def _inc_aggregation(
        self,
        lower: Level,
        upper: Level,
        delta: list[EdgeChange],
        refined: set[str],
    ) -> list[EdgeChange]:
        """Incremental aggregation (Algorithm 4): lift deltas one level up.

        Converts lower-level edge deltas and refinement moves into this
        level's supergraph deltas ``ΔH``: raw deltas are lifted through the
        aggregation map recorded when this level was built (``s_pre``), and
        every refined node swaps its whole edge contribution from its old
        super-coordinates to its new ones. Finishes by recording the current
        aggregation map as ``s_pre`` for the next batch (line 13) and
        refreshing ``node_to_children``.

        Args:
            lower: Level ``p`` (source of the deltas).
            upper: Level ``p+1`` (destination supergraph).
            delta: ``ΔG^p`` already applied to ``lower.graph``.
            refined: ``R^p`` — lower-level nodes whose sub-community changed.

        Returns:
            Compressed ``ΔH`` as edge changes for the upper level.
        """
        ref = lower.refinement
        s_pre = upper.s_pre

        def s_cur(x: str) -> str:
            return f"c{ref.community_of(x)}"

        acc: dict[tuple[str, str], float] = defaultdict(float)

        def bump(a: str, b: str, d: float) -> None:
            key = (a, b) if a <= b else (b, a)
            acc[key] += d

        # Lines 2-4: lift raw deltas. Nodes created after the last aggregation
        # have no s_pre entry — they did not exist, so their coordinates are
        # their current sub-community.
        for ch in delta:
            ru = s_pre.get(ch.u)
            rv = s_pre.get(ch.v)
            if ru is None and ch.u in ref.membership:
                ru = s_cur(ch.u)
            if rv is None and ch.v in ref.membership:
                rv = s_cur(ch.v)
            if ru is None or rv is None:
                continue
            bump(ru, rv, ch.delta)

        # Lines 5-11: refined nodes move their edge contributions.
        for vi in sorted(refined):
            if vi not in ref.membership:
                continue
            cur_i = s_cur(vi)
            pre_i = s_pre.get(vi, cur_i)
            if pre_i == cur_i:
                continue
            for vj in sorted(lower.graph.neighbors(vi)):
                if vj == vi:
                    continue
                # Line 7: when BOTH endpoints are refined, emit the pair once.
                if vj in refined and vj < vi:
                    continue
                w = lower.graph.weight(vi, vj)
                if w <= 0.0:
                    continue
                cur_j = s_cur(vj) if vj in ref.membership else None
                pre_j = s_pre.get(vj) or cur_j
                if pre_j is None:
                    continue
                bump(pre_i, pre_j, -w)
                bump(cur_i, cur_j, w)
            w_self = lower.graph.weight(vi, vi)
            if w_self > 0.0:
                bump(pre_i, pre_i, -w_self)
                bump(cur_i, cur_i, w_self)

        # Line 13: s_pre ← s_cur for every live lower node.
        upper.s_pre = {
            x: s_cur(x) for x in lower.graph.vertices if x in ref.membership
        }

        # Refresh the upper node → base-children composition.
        children: dict[str, set[str]] = defaultdict(set)
        for x, super_id in upper.s_pre.items():
            children[super_id] |= lower.node_to_children.get(x, {x})
        upper.node_to_children = dict(children)

        # Compress: drop negligible residuals.
        return [
            EdgeChange(a, b, d)
            for (a, b), d in sorted(acc.items())
            if abs(d) > 1e-12
        ]

    # ── Algorithm 5 helper ────────────────────────────────────────────────────

    def _def_update(self, moved_per_level: list[set[str]]) -> None:
        """Deferred update (Algorithm 5): propagate coarse moves downward.

        For each level below the top, a node that moved (or sits under a
        super-node that moved above) takes its parent's community label, so a
        coarse-level move redefines the finer-level community identity of the
        affected subtree.
        """
        levels = self.hierarchy.levels
        depth = len(levels)
        if depth < 2:
            return
        changed: list[set[str]] = [
            set(moved_per_level[p]) if p < len(moved_per_level) else set()
            for p in range(depth)
        ]
        for p in range(depth - 1, -1, -1):
            if p != depth - 1:
                upper = levels[p + 1]
                part = levels[p].movement
                for v in sorted(changed[p]):
                    parent = upper.s_pre.get(v)
                    if parent is not None and parent in upper.movement.membership:
                        part.membership[v] = upper.movement.community_of(parent)
            if p != 0:
                # Children of moved level-p nodes join B^{p-1}.
                for child, parent in levels[p].s_pre.items():
                    if parent in changed[p]:
                        changed[p - 1].add(child)
        for level in levels:
            _rebuild_partition_caches(level.movement, level.graph)

    # ── hierarchy depth dynamics ─────────────────────────────────────────────

    def _adjust_depth(self) -> None:
        """Prune collapsed top levels; extend by one when coarsening pays off.

        Mirrors the static build: a new aggregation level is accepted only if
        composing it down to the base graph does not decrease modularity. At
        most one level is added per batch — later batches re-evaluate.
        """
        levels = self.hierarchy.levels
        while len(levels) > 1 and levels[-1].graph.num_vertices <= 1:
            levels.pop()
        if len(levels) >= self.config.max_levels:
            return
        top = levels[-1]
        if top.graph.num_vertices <= 1:
            return
        n_subs = top.refinement.num_communities
        if n_subs <= 1 or n_subs >= top.graph.num_vertices:
            return  # no meaningful coarsening available
        super_graph, supernode_members = _aggregate_partition(
            top.graph, top.refinement
        )
        if super_graph.num_vertices <= 1:
            return

        # Reject a candidate that coarsens nothing (trivial level).
        base = levels[0]
        gamma = self.config.gamma

        def compose_current(top_membership: dict[str, int]) -> dict[str, int]:
            """Push a top-level node→community map down to base vertices."""
            out: dict[str, int] = {}
            for top_node, comm in top_membership.items():
                if not top.graph.has_vertex(top_node):
                    continue
                for base_v in top.node_to_children.get(top_node, {top_node}):
                    out[base_v] = comm
            return out

        def compose_candidate(super_membership: dict[str, int]) -> dict[str, int]:
            """Push a new super-node→community map down to base vertices."""
            out: dict[str, int] = {}
            for super_id, comm in super_membership.items():
                for top_node in supernode_members.get(super_id, ()):
                    for base_v in top.node_to_children.get(top_node, {top_node}):
                        out[base_v] = comm
            return out

        q_before = modularity(base.graph, compose_current(top.movement.membership), gamma)
        # Consistent mover, not graspologic: super-level clustering must
        # optimize COMPOSED base modularity (aggregation identity); the
        # graspologic kernel optimizes its own loop convention and
        # over-merges, which made every depth extension look like a loss.
        candidate = _leiden_flat_moves(super_graph, gamma=gamma)
        if len(set(candidate.values())) == super_graph.num_vertices:
            return  # nothing coarsened: no strictly favorable joint merge
        q_after = modularity(base.graph, compose_candidate(candidate), gamma)
        if q_after < q_before - 1e-12:
            return  # coarsening hurts: keep the current depth

        children: dict[str, set[str]] = defaultdict(set)
        for super_id, members in supernode_members.items():
            for top_node in members:
                children[super_id] |= top.node_to_children.get(top_node, {top_node})
        levels.append(
            Level(
                graph=super_graph,
                movement=Partition(super_graph, candidate),
                refinement=Partition(super_graph, candidate),
                node_to_children=dict(children),
                s_pre={
                    top_node: f"c{top.refinement.community_of(top_node)}"
                    for top_node in top.graph.vertices
                    if top_node in top.refinement.membership
                },
            )
        )

    # ── bookkeeping ───────────────────────────────────────────────────────────

    def _register_new_vertices(self, level: Level, changes: list[EdgeChange]) -> None:
        """Register change endpoints unseen at this level as singleton communities."""
        for ch in changes:
            for endpoint in (ch.u, ch.v):
                if endpoint in level.movement.membership:
                    continue
                label = level.movement.next_label()
                level.movement.membership[endpoint] = label
                level.movement._community_members[label].add(endpoint)
                sub = level.refinement.next_label()
                level.refinement.membership[endpoint] = sub
                level.refinement._community_members[sub].add(endpoint)

    def _prune_vanished(self, level: Level) -> None:
        """Drop membership entries for vertices the graph lost (isolated)."""
        for part in (level.movement, level.refinement):
            stale = [v for v in part.membership if not level.graph.has_vertex(v)]
            for v in stale:
                label = part.membership.pop(v)
                members = part._community_members.get(label)
                if members is not None:
                    members.discard(v)
                    if not members:
                        part._community_members.pop(label, None)
                        part._community_degree.pop(label, None)

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
        """Return the base-level community map ``f^1``.

        Level 0 of the HIT hierarchy is the FINEST partition (paper
        convention), so the flat community assignment is the base-level
        movement partition — the same object the persistence layer stores as
        level 0.
        """
        levels = self.hierarchy.levels
        if not levels:
            return {}
        return dict(levels[0].movement.membership)
