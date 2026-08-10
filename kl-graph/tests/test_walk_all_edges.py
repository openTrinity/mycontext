"""Offline tests for the 'walk all valid-node edge types' behaviour.

Pure / I-O-free (no server, DB, network). Mirrors the harness style of
``tests/test_graph_walk.py``: synthetic adjacency
(``bare_id -> [(edge_type, related_id, related_type, direction)]``) fed straight
into :func:`kl_graph.query.graph_walk.graph_walk`.

Covers the valid-node rule from the walk-all-edge-types TODO:
- ``WALKABLE`` is every ``EdgeType`` value (``COMM_MEMBER`` joined it once
  Community became a reified node with materialized membership edges).
- edges that were previously non-walkable (chunk hops, ``ENTITY_SIMILAR``) are now
  traversed.
- an edge to a non-node target type (a bare conversation id) is skipped by the
  node-type guard and does not crash the walk.
- an edge_type outside ``WALKABLE`` is dropped by the WALKABLE filter.

Run: python tests/test_walk_all_edges.py   (or via pytest)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.models.types import EdgeType
from kl_graph.query import graph_walk as gw


def test_walkable_is_all_valid_node_edge_types():
    """WALKABLE = every EdgeType value; no enum member targets a non-node.

    ``COMM_MEMBER`` used to be excluded because a community was only columns + a
    summaries table. Community is now a reified node and membership edges are
    materialized from the authoritative ``community_L0..L3`` columns, so every
    enum member connects two real nodes.
    """
    all_values = {e.value for e in EdgeType}
    assert gw.WALKABLE == all_values, gw.WALKABLE

    # The node-connecting types are present...
    for name in (
        "ABOUT",
        "MENTIONS",
        "AUTHORED_BY",
        "TEMPORAL",
        "REPLY_TO",
        "STATES",
        "ENTITY_SIMILAR",
        "FACT_SIMILAR",
        "ENTAILS",
        "CONTRADICTS",
        "COMM_MEMBER",
    ):
        assert name in gw.WALKABLE, name
    # ...and the removed dead types are still gone.
    assert "IN_CONV" not in gw.WALKABLE
    assert "INVOLVES" not in gw.WALKABLE
    print("ok  WALKABLE = all valid-node edge types (incl. COMM_MEMBER)")


def _adj():
    """fact:F -STATES- cnk:M, fact:F -ABOUT- ent:A;
    ent:A -ENTITY_SIMILAR- ent:B, ent:A -MENTIONS- cnk:M2."""
    return {
        "F": [
            ("ABOUT", "A", "entity", "out"),
            ("STATES", "M", "chunk", "out"),
        ],
        "A": [
            ("ABOUT", "F", "fact", "in"),
            ("ENTITY_SIMILAR", "B", "entity", "out"),
            ("MENTIONS", "M2", "chunk", "in"),
        ],
        "B": [("ENTITY_SIMILAR", "A", "entity", "out")],
        "M": [("STATES", "F", "fact", "in")],
        "M2": [("MENTIONS", "A", "entity", "out")],
    }


def test_chunk_hop_now_reached():
    """Walking from a fact reaches its STATES chunk; from an entity reaches a
    MENTIONS chunk. Previously both were blocked by the entity/fact-only guard."""
    nodes, edges, _ = gw.graph_walk(
        _adj(), [("fact:F", 1.0)], radius=1, lambda_=0.5, mini_threshold=0.0
    )
    ids = {n["id"] for n in nodes}
    assert "cnk:M" in ids, ("fact should hop onto its STATES chunk", ids)
    assert "ent:A" in ids, ids
    assert any(e["type"] == "STATES" for e in edges), edges
    print("ok  fact -> chunk (STATES) is now walked")


def test_similar_to_and_mentions_now_reached():
    """From an entity seed: ENTITY_SIMILAR reaches another entity and MENTIONS reaches
    a chunk — both previously excluded."""
    nodes, edges, _ = gw.graph_walk(
        _adj(), [("ent:A", 1.0)], radius=1, lambda_=0.5, mini_threshold=0.0
    )
    ids = {n["id"] for n in nodes}
    assert "ent:B" in ids, ("ENTITY_SIMILAR neighbor should be reached", ids)
    assert "cnk:M2" in ids, ("MENTIONS chunk should be reached", ids)
    types = {e["type"] for e in edges}
    assert "ENTITY_SIMILAR" in types, types
    assert "MENTIONS" in types, types
    print("ok  ENTITY_SIMILAR (entity) + MENTIONS (chunk) now walked")


def test_fact_relationships_are_walk_reachable():
    """The complete adjacency cache makes every designed fact edge walkable."""
    adjacency = {
        "F0": [
            ("FACT_SIMILAR", "F1", "fact", "out"),
            ("ENTAILS", "F2", "fact", "out"),
            ("CONTRADICTS", "F3", "fact", "out"),
        ]
    }

    nodes, edges, _ = gw.graph_walk(
        adjacency,
        [("fact:F0", 1.0)],
        radius=1,
        lambda_=0.5,
        mini_threshold=0.0,
    )

    assert {node["id"] for node in nodes} >= {
        "fact:F1",
        "fact:F2",
        "fact:F3",
    }
    assert {edge["type"] for edge in edges} >= {
        "FACT_SIMILAR",
        "ENTAILS",
        "CONTRADICTS",
    }


def test_non_node_target_skipped_by_guard_and_no_crash():
    """An edge whose *edge_type is walkable* but whose *related_type* is not a
    modeled node (a bare conversation id, an unknown type) must be dropped by the
    node-type guard — NOT by the WALKABLE filter. This exercises the guard's
    ``continue`` directly: we use ABOUT/ENTITY_SIMILAR (both in WALKABLE) pointing
    at invalid target types, so the WALKABLE filter passes them through and only
    the node-type guard can stop them. The target must not be materialized or
    scored, the legit neighbour must survive, and the walk must not raise."""
    adj = {
        # ent:A has one legit MENTIONS(chunk) neighbour plus two edges whose
        # edge_type IS walkable but whose target is a non-node — these must be
        # stopped by the node-type guard, not the WALKABLE filter.
        "A": [
            ("MENTIONS", "M", "chunk", "in"),
            ("ABOUT", "CONV1", "conversation", "out"),
            ("ENTITY_SIMILAR", "BOGUS1", "widget", "out"),
        ],
        "M": [("MENTIONS", "A", "entity", "out")],
    }
    # Sanity: the two bad rows use edge types that ARE walkable, so the WALKABLE
    # filter cannot be what removes them — only the node-type guard can.
    assert "ABOUT" in gw.WALKABLE and "ENTITY_SIMILAR" in gw.WALKABLE
    nodes, edges, _ = gw.graph_walk(
        adj, [("ent:A", 1.0)], radius=1, lambda_=0.5, mini_threshold=0.0
    )
    ids = {n["id"] for n in nodes}
    # The legit chunk neighbour is reached.
    assert "cnk:M" in ids, ids
    # No conversation / unknown-type node materialized (guard dropped them).
    assert not any(nid.startswith("conversation:") for nid in ids), ids
    assert not any(nid.startswith("widget:") for nid in ids), ids
    assert "CONV1" not in "".join(ids) and "BOGUS1" not in "".join(ids), ids
    # Every surviving node is a valid modeled type.
    for nid in ids:
        assert gw.node_type_of(nid) in ("entity", "fact", "chunk", "community"), nid
    # No edge to a non-node target was recorded as traversed.
    for e in edges:
        assert not e["to"].startswith(("conversation:", "widget:")), e
    print("ok  walkable-type edge to a non-node target skipped by guard, no crash")


def test_non_walkable_edge_type_not_traversed():
    """Even if an adjacency row carries an edge_type outside WALKABLE, the
    WALKABLE filter drops it before the node-type guard. ``IN_CONV`` is a removed
    dead type that no longer exists in the enum, so it stands in for any edge row
    left over from an older build."""
    assert "IN_CONV" not in gw.WALKABLE
    adj = {
        "A": [
            ("ABOUT", "F", "fact", "out"),
            # IN_CONV is not in WALKABLE, so the filter removes it up front. The
            # target type is a *valid* node here, so only the WALKABLE filter
            # (not the node-type guard) can be what drops this row.
            ("IN_CONV", "M", "chunk", "out"),
        ],
        "F": [("ABOUT", "A", "entity", "in")],
        "M": [],
    }
    nodes, edges, _ = gw.graph_walk(
        adj, [("ent:A", 1.0)], radius=1, lambda_=0.5, mini_threshold=0.0
    )
    ids = {n["id"] for n in nodes}
    assert "fact:F" in ids, ids
    # cnk:M is only reachable via the IN_CONV edge, which is not walkable.
    assert "cnk:M" not in ids, ids
    assert all(e["type"] in gw.WALKABLE for e in edges), edges
    print("ok  edge_type outside WALKABLE (IN_CONV) not traversed")


def test_build_adjacency_indexes_chunk_edges_and_walk_reaches_them():
    """Integration-style but fully offline (in-memory sqlite3, no network/data
    files): a tiny edges table with F1 -STATES-> M1, M1 -TEMPORAL-> M2, and
    M1 -MENTIONS-> E1. ``_build_adjacency`` must key M1 (so a landed-on chunk
    can expand), and a walk from the fact seed must reach M1 (STATES) and then
    M2 (TEMPORAL) — the chunk→chunk hop that was previously un-indexed.

    ``_build_adjacency`` takes a ``KnowledgeStore`` (it scans via
    ``scan_entity_edges``), so the raw connection is wrapped in a ``SQLiteStore``
    exactly as ``tests/test_community_membership.py`` does."""
    import sqlite3

    import kl_server
    from kl_graph.storage.sqlite_store import SQLiteStore

    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE edges (source_type TEXT, source_id TEXT, target_type TEXT, "
        "target_id TEXT, edge_type TEXT)"
    )
    rows = [
        ("fact", "F1", "chunk", "M1", "STATES"),
        ("chunk", "M1", "chunk", "M2", "TEMPORAL"),
        ("chunk", "M1", "entity", "E1", "MENTIONS"),
    ]
    conn.executemany("INSERT INTO edges VALUES (?, ?, ?, ?, ?)", rows)
    conn.commit()
    store = SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]

    adj = kl_server._build_adjacency(store)

    # M1 is keyed and has neighbours (previously M1 was absent entirely).
    assert "M1" in adj, ("chunk key must exist", sorted(adj))
    m1_nbr_types = {(e[0], e[2]) for e in adj["M1"]}
    # M1 reaches M2 (TEMPORAL, out), E1 (MENTIONS, out) and F1 (STATES, in).
    assert ("TEMPORAL", "chunk") in m1_nbr_types, adj["M1"]
    assert ("MENTIONS", "entity") in m1_nbr_types, adj["M1"]
    assert ("STATES", "fact") in m1_nbr_types, adj["M1"]
    # F1 is keyed (fact source) and can reach M1.
    assert "F1" in adj and any(e[1] == "M1" for e in adj["F1"]), adj.get("F1")

    # Walk from the fact seed: radius 2 so F1 -> M1 (hop 1) -> M2 (hop 2).
    nodes, edges, _ = gw.graph_walk(
        adj, [("fact:F1", 1.0)], radius=2, lambda_=0.5, mini_threshold=0.0
    )
    ids = {n["id"] for n in nodes}
    assert "cnk:M1" in ids, ("fact should reach its STATES chunk", ids)
    assert "cnk:M2" in ids, ("chunk->chunk TEMPORAL hop should be reachable", ids)
    assert "ent:E1" in ids, ("chunk->entity MENTIONS hop should be reachable", ids)
    etypes = {e["type"] for e in edges}
    assert {"STATES", "TEMPORAL", "MENTIONS"} <= etypes, etypes
    conn.close()
    print("ok  _build_adjacency indexes chunk edges; walk reaches M1 -> M2")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
    print(f"\n{len(fns)} tests passed.")
