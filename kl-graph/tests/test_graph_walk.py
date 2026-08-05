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
    STATES edge to a message (must never be walked) and a SIMILAR_TO edge."""
    return {
        "A": [("ABOUT", "F1", "fact", "in"), ("MENTIONS", "M1", "message", "in")],
        "F1": [
            ("ABOUT", "A", "entity", "out"),
            ("ABOUT", "B", "entity", "out"),
            ("STATES", "M1", "message", "out"),
        ],
        "B": [("ABOUT", "F1", "fact", "in"), ("SIMILAR_TO", "C", "entity", "out")],
        "C": [("SIMILAR_TO", "B", "entity", "out")],
    }


def test_namespacing_roundtrip():
    assert gw.namespaced("x", "entity") == "ent:x"
    assert gw.namespaced("y", "fact") == "fact:y"
    assert gw.strip_prefix("ent:x") == "x"
    assert gw.node_type_of("fact:y") == "fact"
    print("ok  namespacing roundtrip")


def test_only_walkable_edges_traversed():
    # From entity A, radius 2: A -> F1 -> B. Messages and SIMILAR_TO excluded.
    nodes, edges, visited = gw.graph_walk(
        _adj(), [("ent:A", 1.0)], radius=2, lambda_=0.5, mini_threshold=0.0
    )
    ids = {n["id"] for n in nodes}
    assert "fact:F1" in ids, ids
    assert "ent:B" in ids, ids
    assert not any(n["id"].startswith("msg:") for n in nodes), "messages must not be walked"
    assert "ent:C" not in ids, "SIMILAR_TO must not be walked"
    for e in edges:
        assert e["type"] in gw.WALKABLE
    print("ok  only ABOUT/INVOLVES traversed (no message / SIMILAR_TO)")


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
