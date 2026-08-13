"""Mutable weighted undirected graph for incremental community maintenance.

The base graph has no self-loops; aggregated supergraphs (see
:mod:`kl_graph.periodic.incremental_leiden.static_build`) may carry self-loops
encoding a community's internal weight. Degrees follow the standard weighted
convention where a self-loop of weight ``w`` contributes ``2w``, so modularity
bookkeeping stays consistent across levels.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass


@dataclass(frozen=True)
class EdgeChange:
    """One weighted edge update in a dynamic batch (``ΔG`` in the paper).

    Attributes:
        u: One endpoint id.
        v: Other endpoint id.
        delta: Signed weight change. ``delta > 0`` inserts/strengthens the edge;
            ``delta < 0`` deletes/weakens it. Deleting more weight than present
            clamps the edge weight at zero and removes it.
    """

    u: str
    v: str
    delta: float


class DynamicGraph:
    """Weighted undirected graph supporting incremental edge updates.

    Vertices are arbitrary hashable ids (we use strings). Edge weights are
    stored once per unordered pair in an adjacency map; self-loops are stored
    under ``adj[v][v]``.

    Example:
        >>> g = DynamicGraph()
        >>> g.add_edge("a", "b", 1.0)
        >>> g.degree("a")
        1.0
        >>> g.apply_change(EdgeChange("a", "b", 0.5))
        >>> g.weight("a", "b")
        1.5
    """

    def __init__(self) -> None:
        self._adj: dict[str, dict[str, float]] = defaultdict(dict)
        self._degree: dict[str, float] = defaultdict(float)
        self._total_weight: float = 0.0

    # ── construction ────────────────────────────────────────────────────────

    def add_edge(self, u: str, v: str, weight: float) -> None:
        """Add ``weight`` to edge (u, v), creating vertices as needed.

        Args:
            u: One endpoint.
            v: Other endpoint.
            weight: Weight to add (may be negative to subtract).
        """
        self.apply_change(EdgeChange(u, v, weight))

    def apply_change(self, change: EdgeChange) -> float:
        """Apply one :class:`EdgeChange`, returning the resulting edge weight.

        Removes the edge (and any now-isolated vertices) when its weight drops
        to zero or below.

        Args:
            change: The signed edge update.

        Returns:
            The edge weight after applying the change (``0.0`` if removed).
        """
        u, v, delta = change.u, change.v, change.delta
        old = self._adj.get(u, {}).get(v, 0.0)
        new = old + delta

        if new <= 0.0:
            self._remove_edge(u, v, old)
            return 0.0

        self._adj[u][v] = new
        self._adj[v][u] = new
        # Degree convention: self-loop contributes 2w.
        contribution = (new - old) * (2.0 if u == v else 1.0)
        self._degree[u] += contribution
        if u != v:
            self._degree[v] += (new - old)
        self._total_weight += new - old
        return new

    def _remove_edge(self, u: str, v: str, old: float) -> None:
        """Remove edge (u, v) whose current weight is ``old`` (may be 0)."""
        if old <= 0.0:
            return
        self._adj[u].pop(v, None)
        if u != v:
            self._adj[v].pop(u, None)
        contribution = old * (2.0 if u == v else 1.0)
        self._degree[u] -= contribution
        if u != v:
            self._degree[v] -= old
        self._total_weight -= old
        # Drop vertices that became isolated.
        for node in (u, v):
            if not self._adj.get(node):
                self._adj.pop(node, None)
                self._degree.pop(node, None)

    # ── queries ─────────────────────────────────────────────────────────────

    def has_vertex(self, v: str) -> bool:
        return v in self._adj

    def ensure_vertex(self, v: str) -> None:
        """Register ``v`` even if it currently has no incident edges.

        State deserialization uses this to restore singleton communities that
        carry no edges yet; ``add_edge`` is the only other vertex creator and
        would keep such vertices out of the graph.
        """
        self._adj.setdefault(v, {})

    @property
    def vertices(self) -> list[str]:
        return list(self._adj.keys())

    @property
    def num_vertices(self) -> int:
        return len(self._adj)

    def neighbors(self, v: str) -> dict[str, float]:
        """Return the ``{neighbor: weight}`` map for ``v`` (empty if absent)."""
        return self._adj.get(v, {})

    def weight(self, u: str, v: str) -> float:
        """Return the weight of edge (u, v), or ``0.0`` if absent."""
        return self._adj.get(u, {}).get(v, 0.0)

    def degree(self, v: str) -> float:
        """Return the weighted degree of ``v`` (self-loops counted twice)."""
        return self._degree.get(v, 0.0)

    @property
    def total_weight(self) -> float:
        """Return ``m`` = total edge weight (each edge counted once)."""
        return self._total_weight

    def edges(self) -> list[tuple[str, str, float]]:
        """Return unique edges as ``(u, v, w)`` triples with ``u <= v``."""
        seen: set[tuple[str, str]] = set()
        out: list[tuple[str, str, float]] = []
        for u, nbrs in self._adj.items():
            for v, w in nbrs.items():
                key = (u, v) if u <= v else (v, u)
                if key in seen:
                    continue
                seen.add(key)
                out.append((key[0], key[1], w))
        return out

    def copy(self) -> DynamicGraph:
        """Return a deep copy of this graph."""
        g = DynamicGraph()
        for u, v, w in self.edges():
            g.add_edge(u, v, w)
        return g
