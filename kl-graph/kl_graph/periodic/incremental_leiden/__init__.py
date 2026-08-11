"""Incremental Leiden community maintenance (HIT-Leiden) for dynamic graphs.

Implements *Hierarchical Incremental Tracking Leiden* (HIT-Leiden) from Lin et
al., "Maintaining Leiden Communities in Large Dynamic Graphs", arXiv:2601.08554
(2026), following the reference Rust implementation's
``docs/math/hit_leiden_spec.md`` (github.com/randomvariable/hit-leiden). No
public Python package exists, so the algorithm is implemented here directly.

This is the incremental twin of :mod:`kl_graph.periodic.community_detection`.
That module reruns ``graspologic_native.hierarchical_leiden`` over the whole
graph; this one maintains an existing partition under a batch of edge changes,
touching only the affected region. Both express the graph with the same
collision-proof vertex labels (``e:<id>`` / ``f:<id>``), so a partition produced
by either is readable by the other.

Layout (one concern per module, dependencies strictly one-directional):
    :mod:`~kl_graph.periodic.incremental_leiden.config`
        Tunables, read from the app config.
    :mod:`~kl_graph.periodic.incremental_leiden.graph`
        :class:`DynamicGraph` / :class:`EdgeChange` — mutable weighted graph.
    :mod:`~kl_graph.periodic.incremental_leiden.partition`
        :class:`Partition` — assignment with cached degree aggregates.
    :mod:`~kl_graph.periodic.incremental_leiden.modularity`
        Quality functions. Local because ``graspologic_native`` exposes neither
        a reusable modularity nor an incremental move-gain.
    :mod:`~kl_graph.periodic.incremental_leiden.connectivity`
        Scoped connectivity used by refinement.
    :mod:`~kl_graph.periodic.incremental_leiden.static_build`
        :func:`naive_leiden` — static build, delegating each level's clustering
        to ``graspologic_native.leiden``.
    :mod:`~kl_graph.periodic.incremental_leiden.hierarchy`
        :class:`Level` / :class:`Hierarchy` — the persisted per-level state.
    :mod:`~kl_graph.periodic.incremental_leiden.aggregation`
        Supernode collapsing and partition-cache rebuilding.
    :mod:`~kl_graph.periodic.incremental_leiden.maintainer`
        :class:`HITLeiden` — the incremental maintainer (Algorithms 2, 3, 4, 6).

Everything below is re-exported here, so
``from kl_graph.periodic.incremental_leiden import HITLeiden`` keeps working and
callers need not know which submodule a symbol lives in.
"""

from __future__ import annotations

from kl_graph.periodic.incremental_leiden.config import (
    IncrementalLeidenConfig,
    default_config,
)
from kl_graph.periodic.incremental_leiden.connectivity import (
    connected_components,
    largest_component,
)
from kl_graph.periodic.incremental_leiden.graph import DynamicGraph, EdgeChange
from kl_graph.periodic.incremental_leiden.hierarchy import Hierarchy, Level
from kl_graph.periodic.incremental_leiden.maintainer import HITLeiden
from kl_graph.periodic.incremental_leiden.modularity import (
    edge_weight_to_communities,
    modularity,
    modularity_gain,
)
from kl_graph.periodic.incremental_leiden.partition import Partition
from kl_graph.periodic.incremental_leiden.static_build import (
    LeidenLevel,
    LeidenResult,
    naive_leiden,
)

__all__ = [
    "DynamicGraph",
    "EdgeChange",
    "HITLeiden",
    "Hierarchy",
    "IncrementalLeidenConfig",
    "LeidenLevel",
    "LeidenResult",
    "Level",
    "Partition",
    "connected_components",
    "default_config",
    "edge_weight_to_communities",
    "largest_component",
    "modularity",
    "modularity_gain",
    "naive_leiden",
]
