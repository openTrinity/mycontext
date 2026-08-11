"""Aggregation and cache-maintenance helpers for the incremental maintainer.

Collapsing a partition into supernodes and rebuilding a partition's cached
aggregates are mechanical graph operations with no incremental-algorithm state,
so they live apart from the maintainer that calls them.
"""

from __future__ import annotations

from collections import defaultdict

from kl_graph.periodic.incremental_leiden.graph import DynamicGraph
from kl_graph.periodic.incremental_leiden.partition import Partition


def _aggregate_partition(
    graph: DynamicGraph, part: Partition
) -> tuple[DynamicGraph, dict[str, set[str]]]:
    """Collapse ``part``'s communities into supernodes ``"c{label}"``."""
    super_graph = DynamicGraph()
    supernode_members: dict[str, set[str]] = {}
    for u, v, w in graph.edges():
        super_graph.add_edge(
            f"c{part.community_of(u)}", f"c{part.community_of(v)}", w
        )
    for node in graph.vertices:
        supernode_members.setdefault(f"c{part.community_of(node)}", set()).add(node)
    return super_graph, supernode_members


def _rebuild_partition_caches(part: Partition, graph: DynamicGraph) -> None:
    """Recompute a partition's degree/member caches from scratch."""

    deg: dict[int, float] = defaultdict(float)
    mem: dict[int, set[str]] = defaultdict(set)
    for v, c in part.membership.items():
        deg[c] += graph.degree(v)
        mem[c].add(v)
    part._community_degree = deg
    part._community_members = mem


def _groups_by_label(membership: dict[str, int]) -> dict[int, set[str]]:
    """Invert a ``vertex -> label`` map into ``label -> {vertices}``."""

    groups: dict[int, set[str]] = defaultdict(set)
    for v, c in membership.items():
        groups[c].add(v)
    return dict(groups)
