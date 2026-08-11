"""Scoped connected components for incremental refinement.

The paper keeps a dynamic connected-components structure per sub-community so an
intra-sub-community deletion can be checked cheaply for "did this split it?".
This is the correctness-first version: connectivity is recomputed by BFS over the
subgraph induced by that sub-community's members only. Because the maintainer
calls it exclusively on sub-communities inside the affected region, work stays
bounded by that region rather than the whole graph.

Swappable for a true dynamic-connectivity index (Euler-tour / link-cut trees)
without changing callers.
"""

from __future__ import annotations

from collections import deque

from kl_graph.periodic.incremental_leiden.graph import DynamicGraph


def connected_components(
    graph: DynamicGraph, members: set[str]
) -> list[set[str]]:
    """Return the connected components of the subgraph induced by ``members``.

    Only edges with **both** endpoints in ``members`` are traversed, so this
    measures internal connectivity of a single sub-community.

    Args:
        graph: The (super)graph.
        members: Vertex ids forming the sub-community.

    Returns:
        A list of vertex sets, one per connected component. Ordered by
        descending size (largest component first), ties broken by min member id
        for determinism.
    """
    remaining = set(members)
    components: list[set[str]] = []
    while remaining:
        start = min(remaining)
        comp: set[str] = set()
        queue: deque[str] = deque([start])
        remaining.discard(start)
        while queue:
            node = queue.popleft()
            comp.add(node)
            for nbr in graph.neighbors(node):
                if nbr in remaining:
                    remaining.discard(nbr)
                    queue.append(nbr)
        components.append(comp)
    components.sort(key=lambda c: (-len(c), min(c) if c else ""))
    return components


def largest_component(graph: DynamicGraph, members: set[str]) -> set[str]:
    """Return the largest connected component within ``members`` (or empty set)."""
    comps = connected_components(graph, members)
    return comps[0] if comps else set()
