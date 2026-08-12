"""Community detection must be a pure function of the stored graph.

``LEIDEN_SEED`` is frozen precisely so that a rebuild over unchanged data
reproduces the same hierarchy.  It does not, on its own, deliver that:
``graspologic_native.hierarchical_leiden`` is sensitive to **edge order**, and
``_build_community_graph`` accumulated edges in graph-scan order — which varies
between runs (set iteration over id sets, backend scan order).  Measured on a
real 792-node graph before the fix, two consecutive builds of the *same*
database produced L1 partitions with ARI 0.75–0.90, and even a different number
of hierarchy levels.

That silently destroys every partition comparison the incremental-community work
depends on: incremental-vs-full agreement, day-over-day stability, and
before/after checks all read detector noise as real community movement.  These
tests pin the ordering guarantee at both boundaries.
"""

from __future__ import annotations

import random

from kl_graph.periodic.community_detection import (
    _build_community_graph,
    detect_communities_hierarchical,
    effective_assignments,
)


class _FakeStore:
    """Minimal store double serving a fixed graph with shuffled scan order.

    Mimics the two access paths ``_build_community_graph`` uses: raw SQL over
    ``entities``/``facts`` and ``scan_edges_by_type``.  Each call re-shuffles, so
    a builder that preserves scan order cannot pass.
    """

    def __init__(self, entity_ids: list[str], fact_ids: list[str], about: list[tuple[str, str]], seed: int) -> None:
        self._entity_ids = entity_ids
        self._fact_ids = fact_ids
        self._about = about
        self._rng = random.Random(seed)
        self.sql_conn = self

    # -- SQL surface -----------------------------------------------------
    def execute(self, sql: str, *args):
        self._last = sql
        return self

    def fetchall(self):
        sql = self._last
        if "FROM entities" in sql:
            rows = [(eid,) for eid in self._entity_ids]
        elif "confidence" in sql:
            rows = [(fid, 0.9) for fid in self._fact_ids]
        elif "FROM facts" in sql:
            rows = [(fid,) for fid in self._fact_ids]
        else:
            rows = []
        self._rng.shuffle(rows)
        return rows

    # -- graph surface ---------------------------------------------------
    def scan_edges_by_type(self, edge_types, *, source_type=None, target_type=None):
        if "ABOUT" in edge_types:
            edges = [(fid, eid, {}) for fid, eid in self._about]
            self._rng.shuffle(edges)
            return iter(edges)
        return iter(())


def _fixture_store(seed: int) -> _FakeStore:
    """A two-cluster fact/entity graph, served in a seed-dependent order."""
    entity_ids = [f"e{i}" for i in range(12)]
    fact_ids = [f"f{i}" for i in range(24)]
    about: list[tuple[str, str]] = []
    # Two dense blocks so a hierarchy actually forms.
    for block, entities in ((0, entity_ids[:6]), (1, entity_ids[6:])):
        for index, fid in enumerate(fact_ids[block * 12 : (block + 1) * 12]):
            about.append((fid, entities[index % len(entities)]))
            about.append((fid, entities[(index + 1) % len(entities)]))
    return _FakeStore(entity_ids, fact_ids, about, seed)


def test_build_community_graph_edge_order_is_independent_of_scan_order() -> None:
    """Different scan orders over the same graph must yield the same edge list."""
    first, _ = _build_community_graph(_fixture_store(1))
    second, _ = _build_community_graph(_fixture_store(999))
    assert first == second, "edge list must be canonically ordered, not scan-ordered"
    assert first == sorted(first)


def test_detect_communities_is_invariant_to_input_edge_order() -> None:
    """A shuffled edge list must produce the identical hierarchy.

    This is the property that makes the frozen seed meaningful: detection depends
    on the graph, never on the order it was handed over.
    """
    edges, label_map = _build_community_graph(_fixture_store(7))
    shuffled = list(edges)
    random.Random(4242).shuffle(shuffled)

    baseline = effective_assignments(detect_communities_hierarchical(edges, label_map))
    reordered = effective_assignments(
        detect_communities_hierarchical(shuffled, label_map)
    )
    assert baseline == reordered


def test_repeated_detection_over_one_graph_is_identical() -> None:
    """Rebuild-over-unchanged-data reproduces the same partition, every level."""
    store = _fixture_store(11)
    edges, label_map = _build_community_graph(store)
    runs = [
        effective_assignments(detect_communities_hierarchical(edges, label_map))
        for _ in range(3)
    ]
    assert runs[0] == runs[1] == runs[2]


def test_effective_assignments_densifies_final_clusters_into_deeper_levels() -> None:
    """The dense expansion the ``community_L*`` columns store is shared, not copied.

    A node final at L0 must resolve at L1 too (repeating its final cluster id),
    otherwise a stored-vs-recomputed comparison reads the missing deep-level rows
    as a disagreement.
    """
    detection = {
        "assignments": {
            0: {("entity", "a"): 5, ("entity", "b"): 6},
            1: {("entity", "b"): 9},
        },
        "native_finality": {("entity", "a"): 0, ("entity", "b"): 1},
    }
    expanded = effective_assignments(detection)
    assert expanded[("entity", "a")] == {0: 5, 1: 5}
    assert expanded[("entity", "b")] == {0: 6, 1: 9}


def test_effective_assignments_on_empty_detection_is_empty() -> None:
    assert effective_assignments({"assignments": {}, "native_finality": {}}) == {}
