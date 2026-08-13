"""Per-level state the maintainer mutates across incremental batches.

Separated from the maintainer so the persisted shape of the hierarchy can be read
(and reconstructed by callers warm-starting from a stored partition) without
importing the algorithm itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from kl_graph.periodic.incremental_leiden.graph import DynamicGraph
from kl_graph.periodic.incremental_leiden.partition import Partition


@dataclass
class Level:
    """Mutable per-level state persisted across incremental batches.

    Attributes:
        graph: The (super)graph ``G^p`` at this level.
        movement: Movement partition ``f^p`` (vertex → community).
        refinement: Refinement partition ``s^p`` (vertex → sub-community).
        node_to_children: Supernode id → set of base-vertex ids it represents.
        s_pre: Node id at the level BELOW → this level's node id, as recorded
            when this level's graph was last aggregated (``s_pre`` in the
            paper's Algorithm 4). Empty at the base level. Needed to lift edge
            deltas from below into this level's supergraph coordinates.
    """

    graph: DynamicGraph
    movement: Partition
    refinement: Partition
    node_to_children: dict[str, set[str]] = field(default_factory=dict)
    s_pre: dict[str, str] = field(default_factory=dict)


@dataclass
class Hierarchy:
    """The full persisted hierarchy the maintainer mutates.

    Attributes:
        levels: Bottom-up list of :class:`Level`; ``levels[0]`` is the base graph.
    """

    levels: list[Level] = field(default_factory=list)
