"""Persistence for :class:`HITLeiden` state across incremental batches.

The maintainer's whole hierarchy (per-level supergraphs, movement and
refinement partitions, aggregation maps) must survive between batches, or the
next batch cannot continue maintaining incrementally and must fall back to a
static rebuild. This module is the single owner of that on-disk shape.

The serialized form is plain JSON-friendly data (no pickle): graphs as
``(u, v, w)`` edge lists plus explicit vertex lists, partitions as plain
``node -> cluster`` maps. Vertex lists matter because refinement may leave
isolated singletons that carry no edges but still own a community.
"""

from __future__ import annotations

from kl_graph.periodic.incremental_leiden.config import IncrementalLeidenConfig
from kl_graph.periodic.incremental_leiden.graph import DynamicGraph
from kl_graph.periodic.incremental_leiden.hierarchy import Hierarchy, Level
from kl_graph.periodic.incremental_leiden.maintainer import HITLeiden
from kl_graph.periodic.incremental_leiden.partition import Partition

#: Bump when the serialized shape changes incompatibly. A mismatched schema is
#: a load error, which callers treat as "no state" and rebuild statically.
SCHEMA = "hit-leiden-state-v1"


def serialize_maintainer(maintainer: HITLeiden) -> dict:
    """Snapshot a maintainer's full hierarchy into plain data.

    Args:
        maintainer: The maintainer to snapshot.

    Returns:
        A JSON-serializable dict with schema tag, config, and per-level state.
    """
    levels = []
    for lvl in maintainer.hierarchy.levels:
        levels.append(
            {
                "vertices": sorted(lvl.graph.vertices),
                "edges": sorted(lvl.graph.edges()),
                "movement": {k: int(v) for k, v in lvl.movement.membership.items()},
                "refinement": {
                    k: int(v) for k, v in lvl.refinement.membership.items()
                },
                "node_to_children": {
                    k: sorted(v) for k, v in lvl.node_to_children.items()
                },
                "s_pre": dict(lvl.s_pre),
            }
        )
    cfg = maintainer.config
    return {
        "schema": SCHEMA,
        "config": {
            "gamma": cfg.gamma,
            "max_levels": cfg.max_levels,
            "seed": cfg.seed,
            "min_gain": cfg.min_gain,
        },
        "levels": levels,
    }


def deserialize_maintainer(data: dict) -> HITLeiden:
    """Rebuild a maintainer from :func:`serialize_maintainer` output.

    Args:
        data: Previously serialized state.

    Returns:
        A maintainer whose hierarchy matches the snapshot, ready for
        ``apply_batch``.

    Raises:
        ValueError: When the schema tag is missing or unknown.
    """
    if data.get("schema") != SCHEMA:
        raise ValueError(f"unknown HIT-Leiden state schema: {data.get('schema')!r}")

    cfg_raw = data.get("config", {})
    config = IncrementalLeidenConfig(
        gamma=float(cfg_raw.get("gamma", 1.0)),
        max_levels=int(cfg_raw.get("max_levels", 16)),
        seed=int(cfg_raw.get("seed", 0xC0FFEE)),
        min_gain=float(cfg_raw.get("min_gain", 1e-12)),
    )

    levels: list[Level] = []
    for raw in data.get("levels", []):
        graph = DynamicGraph()
        for u, v, w in raw.get("edges", []):
            graph.add_edge(str(u), str(v), float(w))
        for vertex in raw.get("vertices", []):
            graph.ensure_vertex(str(vertex))
        movement = Partition(graph, {str(k): int(v) for k, v in raw.get("movement", {}).items()})
        refinement = Partition(
            graph, {str(k): int(v) for k, v in raw.get("refinement", {}).items()}
        )
        levels.append(
            Level(
                graph=graph,
                movement=movement,
                refinement=refinement,
                node_to_children={
                    str(k): {str(x) for x in v}
                    for k, v in raw.get("node_to_children", {}).items()
                },
                s_pre={str(k): str(v) for k, v in raw.get("s_pre", {}).items()},
            )
        )

    if not levels:
        raise ValueError("HIT-Leiden state has no levels")
    return HITLeiden(Hierarchy(levels=levels), config)
