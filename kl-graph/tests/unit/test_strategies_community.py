"""Unit tests for the HIT-Leiden-backed incremental community strategy.

These replace the former "guarded no-op" contract tests: ``assign_communities``
now really maintains the partition, so the contract under test is

- an empty batch changes nothing,
- a batch with no graph edges changes nothing (nothing to cluster),
- a real graph produces an assignment written to the maintained level,
- the returned object behaves as a ``set[str]`` of community ids AND carries
  ``community_keys`` for projection scoping,
- deeper levels the full hierarchical path owns are left untouched.
"""

from __future__ import annotations

import json
import pathlib

from kl_graph.ingest.strategies.community import (
    MAINTAINED_LEVEL,
    DynamicFrontierLeiden,
)
from kl_graph.storage.sqlite_store import SQLiteStore


def _seed_two_triangles(store: SQLiteStore) -> list[str]:
    """Create two entity triangles joined by one weak edge.

    Returns:
        The entity ids, ``a0..a2`` then ``b0..b2``.
    """
    ids = [f"a{i}" for i in range(3)] + [f"b{i}" for i in range(3)]
    for eid in ids:
        store.conn.execute(
            "INSERT INTO entities (id, name, quality_status) VALUES (?, ?, 'active')",
            (eid, f"Entity {eid}"),
        )

    def link(u: str, v: str, score: float) -> None:
        store.conn.execute(
            "INSERT OR IGNORE INTO edges (source_type, source_id, target_type, "
            "target_id, edge_type, properties) VALUES ('entity', ?, 'entity', ?, "
            "'ENTITY_SIMILAR', ?)",
            (u, v, json.dumps({"hybrid_score": score})),
        )

    for group in ("a", "b"):
        link(f"{group}0", f"{group}1", 0.95)
        link(f"{group}1", f"{group}2", 0.95)
        link(f"{group}0", f"{group}2", 0.95)
    link("a0", "b0", 0.05)  # weak bridge
    store.conn.commit()
    return ids


def test_empty_batch_changes_nothing(tmp_path: pathlib.Path) -> None:
    """An empty batch must short-circuit without touching the store."""
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    result = strategy.assign_communities(
        store, [], [], entity_resolutions={}, fact_resolutions={}
    )
    assert result == set()
    assert result.community_keys == set()
    store.close()


def test_batch_with_no_edges_changes_nothing(tmp_path: pathlib.Path) -> None:
    """An entity with no community edges yields no assignment.

    The community graph is built from ENTITY_SIMILAR / FACT_SIMILAR / ABOUT /
    co-mention edges, so an isolated entity produces an empty graph.
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    store.conn.execute(
        "INSERT INTO entities (id, name, quality_status) VALUES ('e1', 'E1', 'active')"
    )
    store.conn.commit()
    result = strategy.assign_communities(
        store, ["e1"], [], entity_resolutions={}, fact_resolutions={}
    )
    assert result == set()
    store.close()


def test_assigns_and_writes_maintained_level(tmp_path: pathlib.Path) -> None:
    """A real graph is clustered and persisted to the maintained level."""
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    result = strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )

    column = f"community_L{MAINTAINED_LEVEL}"
    rows = dict(
        store.conn.execute(
            f"SELECT id, {column} FROM entities WHERE {column} IS NOT NULL"
        ).fetchall()
    )
    assert len(rows) == len(ids), "every clustered entity must be persisted"
    # The two triangles are far more densely linked internally than across the
    # weak bridge, so they must not all collapse into one community.
    assert len({rows[i] for i in ids}) >= 2

    assert result, "a first assignment must report changed communities"
    assert all(isinstance(cid, str) for cid in result)
    levels = {key[1] for key in result.community_keys}
    assert levels == {f"L{MAINTAINED_LEVEL}"}
    store.close()


def test_reports_community_ids_and_keys(tmp_path: pathlib.Path) -> None:
    """The result is a set of ids that also exposes typed community keys."""
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    result = strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )

    # `improvement.py` consumes both shapes off the same object.
    assert set(result) == result
    for node_type, level_name, cluster in result.community_keys:
        assert node_type in {"entity", "fact"}
        assert level_name == f"L{MAINTAINED_LEVEL}"
        assert isinstance(cluster, int)
    store.close()


def test_does_not_touch_other_levels(tmp_path: pathlib.Path) -> None:
    """Levels owned by the full hierarchical path are left alone.

    The incremental path maintains one level; writing a partial hierarchy would
    desynchronise the remaining levels from the identity map.
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)
    other = 0 if MAINTAINED_LEVEL != 0 else 3
    store.conn.execute(f"ALTER TABLE entities ADD COLUMN community_L{other} INTEGER")
    store.conn.execute(
        f"UPDATE entities SET community_L{other} = 77 WHERE id = ?",
        (ids[0],),
    )
    store.conn.commit()

    strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )

    kept = store.conn.execute(
        f"SELECT community_L{other} FROM entities WHERE id = ?",
        (ids[0],),
    ).fetchone()
    assert kept[0] == 77, "the incremental path must not rewrite other levels"
    store.close()


def test_rerun_on_unchanged_graph_is_stable(tmp_path: pathlib.Path) -> None:
    """Re-running over an unchanged graph must not churn the assignment.

    The second pass warm-starts from the persisted partition, so it should keep
    the same grouping rather than re-minting labels.
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)
    column = f"community_L{MAINTAINED_LEVEL}"

    strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )
    first = dict(
        store.conn.execute(
            f"SELECT id, {column} FROM entities WHERE {column} IS NOT NULL"
        ).fetchall()
    )

    strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )
    second = dict(
        store.conn.execute(
            f"SELECT id, {column} FROM entities WHERE {column} IS NOT NULL"
        ).fetchall()
    )

    def grouping(m: dict[str, int]) -> set[frozenset[str]]:
        out: dict[int, set[str]] = {}
        for node, cluster in m.items():
            out.setdefault(cluster, set()).add(node)
        return {frozenset(v) for v in out.values()}

    assert grouping(first) == grouping(second), (
        "a rerun over an unchanged graph must preserve the grouping"
    )
    store.close()
