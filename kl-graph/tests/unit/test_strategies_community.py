"""Unit tests for the HIT-Leiden-backed incremental community strategy.

The strategy maintains the WHOLE hierarchy (every ``community_L*`` level) and
persists the maintainer state next to the database. The contract under test:

- an empty batch changes nothing,
- a batch with no graph edges changes nothing (nothing to cluster),
- a real graph produces dense assignments written to every produced level,
- the returned object behaves as a ``set[str]`` of community ids AND carries
  ``community_keys`` for projection scoping,
- stale deeper columns from previous (possibly different) hierarchies are
  cleared — rebuild-not-migrate for the columns the strategy owns,
- a second batch warm-starts from persisted state instead of rebuilding,
- unreadable persisted state falls back to a static build,
- scope matches the full path: only the largest connected component,
- a graph whose hierarchy is genuinely deeper than one level writes every
  level's columns.
"""

from __future__ import annotations

import json
import pathlib

from kl_graph.ingest.strategies import community as community_module
from kl_graph.ingest.strategies.community import DynamicFrontierLeiden
from kl_graph.storage.sqlite_store import SQLiteStore


def _link(store: SQLiteStore, u: str, v: str, score: float) -> None:
    store.conn.execute(
        "INSERT OR IGNORE INTO edges (source_type, source_id, target_type, "
        "target_id, edge_type, properties) VALUES ('entity', ?, 'entity', ?, "
        "'ENTITY_SIMILAR', ?)",
        (u, v, json.dumps({"hybrid_score": score})),
    )


def _add_entity(store: SQLiteStore, eid: str) -> None:
    store.conn.execute(
        "INSERT INTO entities (id, name, quality_status) VALUES (?, ?, 'active')",
        (eid, f"Entity {eid}"),
    )


def _seed_two_triangles(store: SQLiteStore) -> list[str]:
    """Create two entity triangles joined by one weak edge.

    Returns:
        The entity ids, ``a0..a2`` then ``b0..b2``.
    """
    ids = [f"a{i}" for i in range(3)] + [f"b{i}" for i in range(3)]
    for eid in ids:
        _add_entity(store, eid)
    for group in ("a", "b"):
        _link(store, f"{group}0", f"{group}1", 0.95)
        _link(store, f"{group}1", f"{group}2", 0.95)
        _link(store, f"{group}0", f"{group}2", 0.95)
    _link(store, "a0", "b0", 0.05)  # weak bridge
    store.conn.commit()
    return ids


def _levels_with_columns(store: SQLiteStore) -> list[int]:
    """Discover which community_L* columns exist on the entities table."""
    levels = []
    for row in store.conn.execute("PRAGMA table_info(entities)").fetchall():
        name = row[1]
        if name.startswith("community_L"):
            levels.append(int(name.removeprefix("community_L")))
    return sorted(levels)


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
    _add_entity(store, "e1")
    store.conn.commit()
    result = strategy.assign_communities(
        store, ["e1"], [], entity_resolutions={}, fact_resolutions={}
    )
    assert result == set()
    store.close()


def test_assigns_and_writes_every_level(tmp_path: pathlib.Path) -> None:
    """A real graph is clustered and persisted, densely, at every level."""
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    result = strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )

    levels = _levels_with_columns(store)
    assert 0 in levels, "the base level must always be written"
    for level in levels:
        column = f"community_L{level}"
        rows = dict(
            store.conn.execute(
                f"SELECT id, {column} FROM entities WHERE {column} IS NOT NULL"
            ).fetchall()
        )
        assert len(rows) == len(ids), (
            f"level {level}: every clustered entity must be persisted"
        )

    # The two triangles are far more densely linked internally than across the
    # weak bridge, so they must not all collapse into one community.
    base_rows = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )
    assert len({base_rows[i] for i in ids}) >= 2

    assert result, "a first assignment must report changed communities"
    assert all(isinstance(cid, str) for cid in result)
    reported_levels = {key[1] for key in result.community_keys}
    assert reported_levels == {f"L{level}" for level in levels}
    store.close()


def test_reports_community_ids_and_keys(tmp_path: pathlib.Path) -> None:
    """The result is a set of ids that also exposes typed community keys."""
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    result = strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )

    levels = {f"L{level}" for level in _levels_with_columns(store)}
    # `improvement.py` consumes both shapes off the same object.
    assert set(result) == result
    for node_type, level_name, cluster in result.community_keys:
        assert node_type in {"entity", "fact"}
        assert level_name in levels
        assert isinstance(cluster, int)
    store.close()


def test_stale_deeper_columns_are_cleared(tmp_path: pathlib.Path) -> None:
    """The strategy owns ALL community_L* columns (rebuild-not-migrate).

    Columns deeper than the current hierarchy — e.g. leftovers from an older
    detector that produced more levels — must be cleared, or reconcile would
    keep seeing phantom levels.
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)
    store.conn.execute("ALTER TABLE entities ADD COLUMN community_L7 INTEGER")
    store.conn.execute(
        "UPDATE entities SET community_L7 = 77 WHERE id = ?", (ids[0],)
    )
    store.conn.commit()

    strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )

    kept = store.conn.execute(
        "SELECT community_L7 FROM entities WHERE id = ?", (ids[0],)
    ).fetchone()
    assert kept[0] is None, "stale deeper columns must be cleared"
    store.close()


def test_batch_with_no_new_edges_keeps_partition(tmp_path: pathlib.Path) -> None:
    """A batch that adds no graph edges must not churn the assignment.

    The second pass loads the persisted hierarchy, sees no changes to apply,
    and leaves every column exactly as it was.
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )
    first = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )

    # New entity with no edges: it never joins the LCC, so the batch touches
    # no graph edges at all.
    _add_entity(store, "z0")
    store.conn.commit()
    result = strategy.assign_communities(
        store, ["z0"], [], entity_resolutions={}, fact_resolutions={}
    )
    assert result == set(), "no graph change means no community change"

    second = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )
    assert first == second
    store.close()


def test_incremental_batch_extends_partition(tmp_path: pathlib.Path) -> None:
    """A real second batch warm-starts from state and folds in the new nodes."""
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )
    before = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )

    # A third triangle coupled firmly into triangle a.
    _add_entity(store, "c0")
    _add_entity(store, "c1")
    _add_entity(store, "c2")
    _link(store, "c0", "c1", 0.95)
    _link(store, "c1", "c2", 0.95)
    _link(store, "c0", "c2", 0.95)
    _link(store, "c0", "a1", 0.9)
    _link(store, "c1", "a2", 0.9)
    store.conn.commit()

    result = strategy.assign_communities(
        store, ["c0", "c1", "c2"], [], entity_resolutions={}, fact_resolutions={}
    )

    after = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )
    assert set(after) == set(ids) | {"c0", "c1", "c2"}
    # Warm-start keeps the original cluster LABELS stable (no renumbering of
    # untouched regions) — this is what keeps reports following communities.
    for eid in ids:
        assert after[eid] == before[eid], f"{eid} churned under warm start"
    assert result, "the new triangle must report changed communities"
    store.close()


def test_absorbed_small_component_joins_via_delta(tmp_path: pathlib.Path) -> None:
    """A small component bridged into the LCC is folded in without a rebuild.

    Regression: the original state validation demanded exact vertex-set
    equality between state and the pre-batch graph, so a new vertex bridging
    a previously-disconnected component into the LCC forced a static rebuild
    every day (observed across the 8-day experiment). The state-delta path
    instead replays the absorbed component's internal edges as insertions.
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    # An isolated pair OUTSIDE the LCC.
    _add_entity(store, "s0")
    _add_entity(store, "s1")
    _link(store, "s0", "s1", 0.95)
    store.conn.commit()

    strategy.assign_communities(
        store, ids + ["s0", "s1"], [], entity_resolutions={}, fact_resolutions={}
    )
    first = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )
    assert set(first) == set(ids), "the small component must stay out of scope"

    # New vertex bridging the pair into the LCC.
    _add_entity(store, "bridge")
    _link(store, "bridge", "s0", 0.9)
    _link(store, "bridge", "a0", 0.9)
    store.conn.commit()

    result = strategy.assign_communities(
        store, ["bridge"], [], entity_resolutions={}, fact_resolutions={}
    )

    after = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )
    assert set(after) == set(ids) | {"s0", "s1", "bridge"}, (
        "the absorbed component must now be assigned"
    )
    for eid in ids:
        assert after[eid] == first[eid], f"{eid} churned during absorption"
    assert result
    store.close()


def test_deleted_edges_replay_as_deletions(tmp_path: pathlib.Path) -> None:
    """Edge loss between batches (entity merges) replays without a rebuild.

    Entity disambiguation merges duplicates and deletes their edges from the
    community graph. Observed in the 8-day experiment: the LCC dropped from
    1094 to 543 nodes between days. Treating that as drift forced a rebuild;
    the paper's Algorithm 2 maintains deletions natively, so the delta feeds
    them back as negative changes instead.
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )
    first = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )

    # Simulate a merge: one intra-triangle edge disappears (the graph stays
    # connected, so scope does not change), and one new entity joins triangle
    # a (a genuine batch so the guard lets the run through).
    store.conn.execute(
        "DELETE FROM edges WHERE (source_id = 'a1' AND target_id = 'a2') "
        "OR (source_id = 'a2' AND target_id = 'a1')"
    )
    _add_entity(store, "a3")
    _link(store, "a3", "a0", 0.95)
    _link(store, "a3", "a1", 0.95)
    store.conn.commit()

    result = strategy.assign_communities(
        store, ["a3"], [], entity_resolutions={}, fact_resolutions={}
    )

    after = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )
    assert set(after) == set(ids) | {"a3"}
    # The single-edge deletion must not churn the two triangles: same
    # grouping (labels may renumber, so compare the partition shape).
    def grouping(m: dict[str, int]) -> set[frozenset[str]]:
        out: dict[int, set[str]] = {}
        for node, cluster in m.items():
            out.setdefault(cluster, set()).add(node)
        return {frozenset(v) for v in out.values()}

    before_shape = grouping({k: v for k, v in first.items()})
    after_shape = grouping({k: v for k, v in after.items() if k in first})
    assert after_shape == before_shape, "deletion must not churn the grouping"
    assert result
    store.close()


def test_state_file_created_next_to_database(tmp_path: pathlib.Path) -> None:
    """The maintainer state persists next to the database file."""
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )

    state_path = tmp_path / community_module.STATE_FILE_NAME
    assert state_path.exists(), "state must be persisted for the next batch"
    data = json.loads(state_path.read_text(encoding="utf-8"))
    assert data["schema"]
    assert data["levels"], "state must carry at least the base level"
    store.close()


def test_corrupt_state_falls_back_to_static_build(tmp_path: pathlib.Path) -> None:
    """Unreadable state degrades to a rebuild, never to a failure."""
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_two_triangles(store)

    strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )
    (tmp_path / community_module.STATE_FILE_NAME).write_text(
        "{ not json", encoding="utf-8"
    )

    # Add one edge; the strategy must rebuild and still produce a partition.
    _link(store, "a1", "b1", 0.5)
    store.conn.commit()
    strategy.assign_communities(
        store, ["a1"], [], entity_resolutions={}, fact_resolutions={}
    )
    rows = store.conn.execute(
        "SELECT COUNT(*) FROM entities WHERE community_L0 IS NOT NULL"
    ).fetchone()
    assert rows[0] == len(ids), "rebuild must cover every LCC node"
    store.close()


def _seed_coupled_cliques(store: SQLiteStore) -> list[str]:
    """Two 10-cliques with full bipartite coupling (weight 0.9).

    At γ=1 this family sits at EXACTLY ZERO super-level joint-merge gain
    (per-clique super degree k = 180, 2m = 360 ⇒ gain = 90/360 − 180²/360²
    = 0), while every single-vertex move has negative gain (the nucleation
    barrier). The honest static hierarchy is therefore depth 1; strengthening
    any cross edge makes the joint gain strictly positive and only then may
    the depth extend. See test_multi_level_hierarchy_writes_every_level.
    """
    ids: list[str] = []
    for prefix in ("a", "b"):
        grp = [f"{prefix}{i}" for i in range(10)]
        ids += grp
        for eid in grp:
            _add_entity(store, eid)
        for x in range(10):
            for y in range(x + 1, 10):
                _link(store, grp[x], grp[y], 1.0)
    for i in range(10):
        for j in range(10):
            _link(store, f"a{i}", f"b{j}", 0.9)
    store.conn.commit()
    return ids


def test_multi_level_hierarchy_writes_every_level(tmp_path: pathlib.Path) -> None:
    """Every level's columns are written once the hierarchy is genuinely deep.

    Phase 1 (w=0.9 coupling): the joint-merge gain is exactly zero, so the
    honest hierarchy is depth 1 and only L0 may exist — asserting this pins
    the no-fake-depth rule. Phase 2: a later batch strengthens one cross
    edge (+1.0 weight), making the joint gain strictly positive while every
    single-vertex move stays blocked; the maintainer must extend the depth
    and the strategy must persist the new level's columns densely.
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    ids = _seed_coupled_cliques(store)

    first = strategy.assign_communities(
        store, ids, [], entity_resolutions={}, fact_resolutions={}
    )
    assert first, "the first build must report changed communities"
    assert _levels_with_columns(store) == [0], (
        "zero joint gain: only the base level may exist (no faked depth)"
    )

    # Batch 2: strengthen ONE cross edge (joint gain becomes strictly
    # positive) and add one new entity so this is a genuine batch.
    store.conn.execute(
        "UPDATE edges SET properties = ? WHERE source_type = 'entity' "
        "AND target_type = 'entity' AND edge_type = 'ENTITY_SIMILAR' "
        "AND ((source_id = 'a0' AND target_id = 'b0') "
        "OR (source_id = 'b0' AND target_id = 'a0'))",
        (json.dumps({"hybrid_score": 1.9}),),
    )
    _add_entity(store, "z0")
    _link(store, "z0", "a1", 0.95)
    store.conn.commit()

    result = strategy.assign_communities(
        store, ["z0"], [], entity_resolutions={}, fact_resolutions={}
    )

    levels = _levels_with_columns(store)
    assert levels == [0, 1], (
        f"the favorable joint merge must add exactly L1, got {levels}"
    )
    for level in levels:
        column = f"community_L{level}"
        rows = dict(
            store.conn.execute(
                f"SELECT id, {column} FROM entities WHERE {column} IS NOT NULL"
            ).fetchall()
        )
        assert len(rows) == len(ids) + 1, (
            f"level {level} must be dense, including the new entity"
        )
    l0 = dict(
        store.conn.execute(
            "SELECT id, community_L0 FROM entities WHERE community_L0 IS NOT NULL"
        ).fetchall()
    )
    l1 = dict(
        store.conn.execute(
            "SELECT id, community_L1 FROM entities WHERE community_L1 IS NOT NULL"
        ).fetchall()
    )
    assert len(set(l1.values())) < len(set(l0.values())), (
        "L1 must be a genuine coarsening of L0, not a copy"
    )
    reported_levels = {key[1] for key in result.community_keys}
    assert "L1" in reported_levels

    # The reified projection must be maintained by the strategy itself:
    # without communities-table rows the gated summarizer can never
    # summarise deeper-level (or newly born) communities on days where no
    # separate full improve runs.
    comm_levels = {
        row[0]
        for row in store.conn.execute(
            "SELECT level FROM communities"
        ).fetchall()
    }
    assert comm_levels == {"L0", "L1"}
    edge_levels = {
        row[0]
        for row in store.conn.execute(
            "SELECT json_extract(properties, '$.level') FROM edges "
            "WHERE edge_type = 'COMM_MEMBER'"
        ).fetchall()
    }
    assert edge_levels == {"L0", "L1"}
    # L0 clusters carry parent links into L1.
    with_parents = store.conn.execute(
        "SELECT COUNT(*) FROM communities "
        "WHERE level = 'L0' AND parent_id IS NOT NULL"
    ).fetchone()[0]
    assert with_parents > 0
    store.close()


def _seed_disconnected_components(store: SQLiteStore) -> tuple[list[str], list[str]]:
    """Create a 4-node component and a disconnected 2-node component.

    Returns:
        ``(big_ids, small_ids)`` — the largest connected component first.
    """
    big = ["g0", "g1", "g2", "g3"]
    small = ["s0", "s1"]
    for eid in big + small:
        _add_entity(store, eid)
    _link(store, "g0", "g1", 0.95)
    _link(store, "g1", "g2", 0.95)
    _link(store, "g2", "g0", 0.95)
    _link(store, "g2", "g3", 0.9)  # tail on the triangle
    _link(store, "s0", "s1", 0.95)  # isolated pair — a smaller component
    store.conn.commit()
    return big, small


def test_assigns_only_largest_connected_component(tmp_path: pathlib.Path) -> None:
    """Scope matches the full path: only LCC nodes are assigned.

    The full path partitions the largest connected component only
    (LEIDEN_USE_LCC). The incremental strategy must agree, or its partition
    drifts from every full rebuild on scope alone (small components inflate
    the cluster count).
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    big, small = _seed_disconnected_components(store)

    strategy.assign_communities(
        store, big + small, [], entity_resolutions={}, fact_resolutions={}
    )

    big_rows = store.conn.execute(
        "SELECT id, community_L0 FROM entities WHERE id IN ('g0','g1','g2','g3')"
    ).fetchall()
    small_rows = store.conn.execute(
        "SELECT id, community_L0 FROM entities WHERE id IN ('s0','s1')"
    ).fetchall()
    assert all(cluster is not None for _, cluster in big_rows), (
        "every LCC node must be assigned"
    )
    assert all(cluster is None for _, cluster in small_rows), (
        "non-LCC nodes must stay unassigned, like on the full path"
    )
    store.close()
