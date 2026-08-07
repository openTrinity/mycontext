"""Unit tests for the pure GraphRAG walk + mermaid renderer (Part B: V2, V10).

I/O-free — runs anywhere (no SQLite/Qdrant/GPU). Mirrors the Phase-0 pagerank
synthetic-graph test style. Run: python3 tests/test_graph_walk.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.query import graph_walk as gw


def _adj():
    """Synthetic adjacency: ent:A -ABOUT- fact:F1 -ABOUT- ent:B, plus a
    STATES/MENTIONS edge to a chunk and an ENTITY_SIMILAR edge — all walkable,
    since every endpoint is a modeled node type."""
    return {
        "A": [("ABOUT", "F1", "fact", "in"), ("MENTIONS", "M1", "chunk", "in")],
        "F1": [
            ("ABOUT", "A", "entity", "out"),
            ("ABOUT", "B", "entity", "out"),
            ("STATES", "M1", "chunk", "out"),
        ],
        "B": [("ABOUT", "F1", "fact", "in"), ("ENTITY_SIMILAR", "C", "entity", "out")],
        "C": [("ENTITY_SIMILAR", "B", "entity", "out")],
    }


def test_namespacing_roundtrip():
    assert gw.namespaced("x", "entity") == "ent:x"
    assert gw.namespaced("y", "fact") == "fact:y"
    assert gw.namespaced("z", "chunk") == "cnk:z"
    assert gw.strip_prefix("ent:x") == "x"
    assert gw.node_type_of("fact:y") == "fact"
    assert gw.node_type_of("cnk:z") == "chunk"
    print("ok  namespacing roundtrip")


def test_valid_node_edges_traversed_and_others_dropped():
    """The two gates: WALKABLE filters edge *types*, the node-type guard filters
    endpoint *types*. Every edge whose both endpoints are modeled nodes
    (entity/fact/chunk/community) is traversed — chunks included, since a chunk is
    a first-class node (there is no Message concept any more).

    From entity A, radius 2: A -> F1 -> B via ABOUT, and A -> cnk:M1 via MENTIONS.
    ENTITY_SIMILAR sits at hop 3 (A->F1->B->C) so a radius-3 walk proves it too.
    """
    nodes, edges, _visited = gw.graph_walk(
        _adj(), [("ent:A", 1.0)], radius=2, lambda_=0.5, mini_threshold=0.0
    )
    ids = {n["id"] for n in nodes}
    assert "fact:F1" in ids, ids
    assert "ent:B" in ids, ids
    # A chunk is a modeled node, so the MENTIONS hop onto it IS walked.
    assert "cnk:M1" in ids, ("entity -> chunk (MENTIONS) must be walked", ids)
    # The retired "msg" prefix must not reappear anywhere.
    assert not any(n["id"].startswith("msg:") for n in nodes), ids
    for e in edges:
        assert e["type"] in gw.WALKABLE
    for nid in ids:
        assert gw.node_type_of(nid) in ("entity", "fact", "chunk", "community"), nid

    # radius=3 reaches ent:C via B -ENTITY_SIMILAR-> C.
    nodes3, _, _ = gw.graph_walk(
        _adj(), [("ent:A", 1.0)], radius=3, lambda_=0.5, mini_threshold=0.0
    )
    assert "ent:C" in {n["id"] for n in nodes3}, [n["id"] for n in nodes3]

    # A non-walkable edge type is dropped by the WALKABLE filter even when its
    # endpoint IS a valid node. ``IN_CONV`` is a removed dead type, standing in
    # for any stale edge row from an older build.
    assert "IN_CONV" not in gw.WALKABLE
    stale = {
        "A": [("ABOUT", "F1", "fact", "out"), ("IN_CONV", "M9", "chunk", "out")],
        "F1": [("ABOUT", "A", "entity", "in")],
        "M9": [],
    }
    nodes4, _, _ = gw.graph_walk(
        stale, [("ent:A", 1.0)], radius=1, lambda_=0.5, mini_threshold=0.0
    )
    ids4 = {n["id"] for n in nodes4}
    assert "fact:F1" in ids4, ids4
    assert "cnk:M9" not in ids4, ("non-walkable edge type must not be traversed", ids4)
    print("ok  all valid-node edge types traversed (incl. chunk + ENTITY_SIMILAR)")


def test_monotonic_decay():
    nodes, _, _ = gw.graph_walk(
        _adj(), [("ent:A", 1.0)], radius=2, lambda_=0.5, mini_threshold=0.0
    )
    by_id = {n["id"]: n for n in nodes}
    # A(1.0) -> F1(0.5) -> B(0.25): each hop strictly smaller than its parent.
    assert by_id["ent:A"]["score"] == 1.0
    assert by_id["fact:F1"]["score"] == 0.5
    assert by_id["ent:B"]["score"] == 0.25
    assert by_id["fact:F1"]["score"] < by_id["ent:A"]["score"]
    assert by_id["ent:B"]["score"] < by_id["fact:F1"]["score"]
    print("ok  monotonic decay (further = more penalty)")


def test_best_path_wins():
    # Diamond: two entity seeds both reach fact:F1. F1 keeps the max score.
    adj = {
        "A": [("ABOUT", "F1", "fact", "in")],
        "B": [("ABOUT", "F1", "fact", "in")],
        "F1": [("ABOUT", "A", "entity", "out"), ("ABOUT", "B", "entity", "out")],
    }
    nodes, _, _ = gw.graph_walk(
        adj, [("ent:A", 1.0), ("ent:B", 0.4)], radius=1, lambda_=0.5, mini_threshold=0.0
    )
    f1 = next(n for n in nodes if n["id"] == "fact:F1")
    assert f1["score"] == 0.5, f1  # via A (1.0*0.5), not B (0.4*0.5=0.2)
    print("ok  best-path wins (max over paths)")


def test_cycle_safe():
    adj = {
        "A": [("ABOUT", "F1", "fact", "in")],
        "F1": [("ABOUT", "A", "entity", "out")],  # cycle A<->F1
    }
    nodes, _, _ = gw.graph_walk(adj, [("ent:A", 1.0)], radius=10, mini_threshold=0.0)
    assert len(nodes) == 2  # terminates, no infinite loop
    print("ok  cycle terminates")


def test_fanout_and_node_caps():
    adj = {"A": [("ABOUT", f"F{i}", "fact", "in") for i in range(100)]}
    for i in range(100):
        adj[f"F{i}"] = []
    nodes, _, _ = gw.graph_walk(
        adj, [("ent:A", 1.0)], radius=1, max_fanout=5, mini_threshold=0.0
    )
    # seed + at most 5 expanded neighbors
    assert len([n for n in nodes if n["hop"] == 1]) <= 5
    nodes2, _, _ = gw.graph_walk(
        adj, [("ent:A", 1.0)], radius=1, max_fanout=100, max_nodes=10, mini_threshold=0.0
    )
    assert len(nodes2) <= 10
    print("ok  max_fanout + max_nodes enforced")


def test_mini_threshold_prunes():
    # lambda 0.5, threshold 0.3: hop-1 = 0.5 (kept), hop-2 = 0.25 (< 0.3, pruned)
    nodes, _, _ = gw.graph_walk(
        _adj(), [("ent:A", 1.0)], radius=2, lambda_=0.5, mini_threshold=0.3
    )
    ids = {n["id"] for n in nodes}
    assert "fact:F1" in ids
    assert "ent:B" not in ids, "hop-2 node below mini_threshold should be pruned"
    print("ok  mini_threshold prunes low branches")


def test_initial_best_cursor_prune():
    # A node already visited with a better score is not re-added (stateless hop).
    nodes, _, visited = gw.graph_walk(
        _adj(), [("ent:A", 1.0)], radius=1, lambda_=0.5, mini_threshold=0.0,
        initial_best={"fact:F1": 0.9},
    )
    f1 = next((n for n in nodes if n["id"] == "fact:F1"), None)
    # 0.5 (new path) <= 0.9 (prior best) -> not advanced as a fresh discovery
    assert f1 is None, "cheaper prior path should prune the new one"
    assert visited["fact:F1"] == 0.9
    print("ok  initial_best cursor prunes costlier re-reach")


def test_mermaid_valid_and_escaped():
    nodes = [
        {"id": "ent:A", "type": "entity", "name": "张[伟] #1", "score": 0.71, "hop": 0},
        {"id": "fact:F1", "type": "fact",
         "text": 'decided "sandbox" (v2)\nwith newline ' + "x" * 80,
         "score": 0.38, "hop": 1},
    ]
    edges = [{"from": "fact:F1", "to": "ent:A", "type": "ABOUT", "weight": 1.0}]
    mm = gw.to_mermaid(nodes, edges)
    assert mm.startswith("graph TD")
    # No structural chars leaked into labels (only in the wrapping syntax).
    for line in mm.splitlines()[1:]:
        # node ids must be mermaid-safe (no colon/unicode)
        assert ":" not in line.split("[")[0].split("(")[0]
    # long fact text truncated
    assert "x" * 80 not in mm
    # newline stripped
    assert "\n" not in nodes[1]["text"] or "with newline" in mm
    assert "-->|ABOUT|" in mm
    print("ok  mermaid renders valid + escaped + truncated")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
    print(f"\n{len(fns)} tests passed.")
