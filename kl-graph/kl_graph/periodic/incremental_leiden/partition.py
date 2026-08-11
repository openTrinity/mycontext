"""Community partition with cached aggregates.

A :class:`Partition` wraps a ``vertex -> community`` map plus the per-community
degree mass ``d(C)`` needed for O(1) modularity-gain evaluation. Moving a vertex
updates the caches in O(degree) instead of rescanning the graph, which is what
keeps the incremental inner loops bounded by the affected region.
"""

from __future__ import annotations

from collections import defaultdict

from kl_graph.periodic.incremental_leiden.graph import DynamicGraph


class Partition:
    """A mutable community assignment over a :class:`DynamicGraph`.

    Attributes:
        membership: Map from vertex id to integer community label.

    Example:
        >>> g = DynamicGraph()
        >>> g.add_edge("a", "b", 1.0)
        >>> p = Partition.singletons(g)
        >>> p.num_communities
        2
        >>> p.move("a", p.membership["b"], g)
        >>> p.num_communities
        1
    """

    def __init__(self, graph: DynamicGraph, membership: dict[str, int]) -> None:
        self.membership: dict[str, int] = dict(membership)
        self._community_degree: dict[int, float] = defaultdict(float)
        self._community_members: dict[int, set[str]] = defaultdict(set)
        for v, c in self.membership.items():
            self._community_degree[c] += graph.degree(v)
            self._community_members[c].add(v)

    @classmethod
    def singletons(cls, graph: DynamicGraph) -> Partition:
        """Return the partition where every vertex is its own community."""
        # Deterministic labels: assign by sorted vertex order.
        membership = {v: i for i, v in enumerate(sorted(graph.vertices))}
        return cls(graph, membership)

    # ── queries ─────────────────────────────────────────────────────────────

    def community_of(self, v: str) -> int:
        return self.membership[v]

    def community_degree(self, c: int) -> float:
        """Return ``d(C)`` — total degree mass of community ``c``."""
        return self._community_degree.get(c, 0.0)

    def members(self, c: int) -> set[str]:
        """Return the member set of community ``c`` (live view; do not mutate)."""
        return self._community_members.get(c, set())

    @property
    def num_communities(self) -> int:
        return sum(1 for members in self._community_members.values() if members)

    def next_label(self) -> int:
        """Return an unused community label (max existing + 1, or 0)."""
        return (max(self._community_members) + 1) if self._community_members else 0

    # ── mutation ────────────────────────────────────────────────────────────

    def move(self, v: str, target: int, graph: DynamicGraph) -> None:
        """Move vertex ``v`` into community ``target``, updating caches.

        Args:
            v: Vertex to move.
            target: Destination community label.
            graph: Graph providing ``v``'s degree.
        """
        source = self.membership[v]
        if source == target:
            return
        dv = graph.degree(v)
        self._community_degree[source] -= dv
        self._community_members[source].discard(v)
        if not self._community_members[source]:
            self._community_members.pop(source, None)
            self._community_degree.pop(source, None)
        self.membership[v] = target
        self._community_degree[target] += dv
        self._community_members[target].add(v)

    def add_vertex(self, v: str, community: int, graph: DynamicGraph) -> None:
        """Register a new vertex ``v`` in ``community`` (for dynamic inserts)."""
        if v in self.membership:
            self.move(v, community, graph)
            return
        self.membership[v] = community
        self._community_degree[community] += graph.degree(v)
        self._community_members[community].add(v)

    def relabel_dense(self) -> dict[int, int]:
        """Renumber community labels to a dense ``0..k-1`` range.

        Returns:
            The ``old_label → new_label`` remap applied.
        """
        remap: dict[int, int] = {}
        for c in sorted(self._community_members):
            remap[c] = len(remap)
        self.membership = {v: remap[c] for v, c in self.membership.items()}
        self._community_degree = defaultdict(
            float, {remap[c]: d for c, d in self._community_degree.items()}
        )
        self._community_members = defaultdict(
            set, {remap[c]: members for c, members in self._community_members.items()}
        )
        return remap

    def copy(self) -> Partition:
        """Return an independent copy (shares no mutable state)."""
        p = Partition.__new__(Partition)
        p.membership = dict(self.membership)
        p._community_degree = defaultdict(float, self._community_degree)
        p._community_members = defaultdict(
            set, {c: set(members) for c, members in self._community_members.items()}
        )
        return p
