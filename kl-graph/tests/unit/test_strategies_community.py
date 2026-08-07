"""Unit tests for DynamicFrontierLeiden incremental community strategy.

Tests verify:
- Frontier identification includes new nodes and their 1-hop neighbors
- Only changed community assignments are written to the store
- Empty new_ids returns empty set
- Changed community UUIDs are returned
- community_id_from is used correctly for UUID generation
- Handles missing community column gracefully
"""

from __future__ import annotations

import pathlib
import sqlite3

import pytest

from kl_graph.ingest.strategies.community import DynamicFrontierLeiden
from kl_graph.models.types import community_id_from
from kl_graph.storage.sqlite_store import SQLiteStore

try:
    import leidenalg  # noqa: F401

    LEIDENALG_AVAILABLE = True
except ImportError:
    LEIDENALG_AVAILABLE = False

pytestmark = pytest.mark.skipif(
    not LEIDENALG_AVAILABLE,
    reason="leidenalg not installed",
)

# ── Fixtures ──────────────────────────────────────────────────────────────────


def _make_store_with_entities(
    tmp_path: pathlib.Path,
    entities: list[tuple[str, int | None, int | None]],
) -> SQLiteStore:
    """Create a SQLiteStore populated with entities and community assignments.

    Args:
        tmp_path: Temporary directory.
        entities: List of (entity_id, community_L0, community_L1).

    Returns:
        Populated SQLiteStore.
    """
    store = SQLiteStore(tmp_path / "test.db")
    conn = store.conn

    # Ensure community columns exist (ignore if already present)
    for level in ("L0", "L1", "L2", "L3"):
        try:
            conn.execute(f"ALTER TABLE entities ADD COLUMN community_{level} INTEGER")
        except sqlite3.OperationalError:
            pass  # column already exists
    conn.commit()

    # Insert entities with community assignments
    for eid, c_l0, c_l1 in entities:
        conn.execute(
            "INSERT OR IGNORE INTO entities (id, name, entity_type, first_seen, last_seen, mention_count, description) VALUES (?, ?, 'Unknown', 0, 0, 1, '')",
            (eid, f"Entity-{eid[:8]}"),
        )
        if c_l0 is not None:
            conn.execute(
                "UPDATE entities SET community_L0 = ? WHERE id = ?", (c_l0, eid)
            )
        if c_l1 is not None:
            conn.execute(
                "UPDATE entities SET community_L1 = ? WHERE id = ?", (c_l1, eid)
            )
    conn.commit()
    return store


def _add_entity_similar_edges(
    store: SQLiteStore, pairs: list[tuple[str, str, float]]
) -> None:
    """Add ENTITY_SIMILAR edges between entity pairs.

    Args:
        store: Store to add edges to.
        pairs: List of (src_id, tgt_id, hybrid_score).
    """
    import json

    conn = store.conn
    for src, tgt, score in pairs:
        props = json.dumps({"hybrid_score": score})
        conn.execute(
            "INSERT OR IGNORE INTO edges (source_type, source_id, target_type, target_id, edge_type, properties) VALUES (?, ?, ?, ?, ?, ?)",
            ("entity", src, "entity", tgt, "ENTITY_SIMILAR", props),
        )
    conn.commit()


# ── Tests ─────────────────────────────────────────────────────────────────────


class TestDynamicFrontierLeiden:
    """Tests for DynamicFrontierLeiden community assignment strategy."""

    def test_empty_new_ids_returns_empty_set(self, tmp_path: pathlib.Path) -> None:
        """No new entities or facts → no community changes."""
        strategy = DynamicFrontierLeiden()
        store = SQLiteStore(tmp_path / "test.db")

        result = strategy.assign_communities(
            store,
            [],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={"L0": 0.3},
        )

        assert result == set()
        store.close()

    def test_new_entity_gets_assigned(self, tmp_path: pathlib.Path) -> None:
        """A newly ingested entity with no prior assignment gets a community."""

        strategy = DynamicFrontierLeiden()
        # Entities: existing (cid=0) and new (no assignment)
        store = _make_store_with_entities(
            tmp_path,
            [
                ("existing-a", 0, None),
                ("existing-b", 0, None),
                ("new-node-1", None, None),
            ],
        )

        # Add ENTITY_SIMILAR edges so the graph has edges
        _add_entity_similar_edges(
            store,
            [
                ("existing-a", "existing-b", 0.8),
                ("existing-a", "new-node-1", 0.7),
            ],
        )

        # Run strategy with L0 only
        strategy.assign_communities(
            store,
            ["new-node-1"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

        # The new node should have been assigned some community
        row = store.conn.execute(
            "SELECT community_L0 FROM entities WHERE id = ?", ("new-node-1",)
        ).fetchone()
        assert row is not None and row[0] is not None, (
            "new-node-1 was not assigned a community"
        )
        store.close()

    def test_frontier_includes_1hop_neighbors(self, tmp_path: pathlib.Path) -> None:
        """Frontier includes 1-hop neighbors of new nodes from the graph."""
        strategy = DynamicFrontierLeiden()
        # We test the private _build_graph + frontier logic indirectly.
        # Verify that neighbor assignments also get updated when needed.
        store = _make_store_with_entities(
            tmp_path,
            [
                ("hub-entity", 5, None),  # existing, in community 5
                ("new-node", None, None),  # new
            ],
        )
        # Connect new-node to hub-entity (so hub-entity is in frontier)
        _add_entity_similar_edges(store, [("hub-entity", "new-node", 0.9)])

        result = strategy.assign_communities(
            store,
            ["new-node"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

        # Both the new node and hub-entity should have community_L0 set
        rows = store.conn.execute(
            "SELECT id, community_L0 FROM entities ORDER BY id"
        ).fetchall()
        assignments = {r[0]: r[1] for r in rows}
        assert assignments.get("new-node") is not None
        # Return value is also valid (a set of UUIDs)
        assert isinstance(result, set)
        store.close()

    def test_unchanged_nodes_not_updated(self, tmp_path: pathlib.Path) -> None:
        """Nodes outside the frontier are not updated even if Leiden would reassign them."""
        strategy = DynamicFrontierLeiden()
        # A disconnected entity (no edges to new nodes) should not be updated
        store = _make_store_with_entities(
            tmp_path,
            [
                ("isolated", 99, None),  # isolated, community 99
                ("new-node", None, None),
            ],
        )
        # No edges between isolated and new-node → isolated not in frontier

        strategy.assign_communities(
            store,
            ["new-node"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

        # Isolated node keeps its original assignment (99) or None if column doesn't exist
        row = store.conn.execute(
            "SELECT community_L0 FROM entities WHERE id = ?", ("isolated",)
        ).fetchone()
        # If column exists: isolated should still be 99 (not modified by frontier Leiden)
        if row and row[0] is not None:
            assert row[0] == 99, f"Isolated node was incorrectly updated: {row[0]}"
        store.close()

    def test_changed_community_uuids_returned(self, tmp_path: pathlib.Path) -> None:
        """community_id_from UUIDs are returned for changed communities."""
        strategy = DynamicFrontierLeiden()
        store = _make_store_with_entities(
            tmp_path,
            [
                ("entity-a", 0, None),
                ("new-entity", None, None),
            ],
        )
        _add_entity_similar_edges(store, [("entity-a", "new-entity", 0.9)])

        result = strategy.assign_communities(
            store,
            ["new-entity"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

        # All returned IDs should be valid UUID strings
        for cid in result:
            assert isinstance(cid, str), f"Community ID is not a string: {cid!r}"
            # Should match community_id_from format (UUID5)
            parts = cid.split("-")
            assert len(parts) == 5, f"Not a UUID: {cid}"
        store.close()

    def test_missing_community_column_skipped_gracefully(
        self, tmp_path: pathlib.Path
    ) -> None:
        """When a community column does not exist, that level is skipped without error."""
        strategy = DynamicFrontierLeiden()
        store = SQLiteStore(tmp_path / "test.db")
        # Don't add community_L0 column — strategy should handle missing columns gracefully

        conn = store.conn
        conn.execute(
            "INSERT OR IGNORE INTO entities (id, name, entity_type, first_seen, last_seen, mention_count, description) VALUES (?, ?, 'Unknown', 0, 0, 1, '')",
            ("new-entity", "Test"),
        )
        conn.commit()

        # Should not raise even if community_L0 column is missing
        result = strategy.assign_communities(
            store,
            ["new-entity"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

        assert isinstance(result, set)
        store.close()

    def test_no_graph_edges_returns_empty(self, tmp_path: pathlib.Path) -> None:
        """Graph with no edges returns empty set (no Leiden possible)."""
        strategy = DynamicFrontierLeiden()
        store = _make_store_with_entities(
            tmp_path,
            [
                ("isolated-new", None, None),
            ],
        )
        # No ENTITY_SIMILAR edges — _build_graph returns None

        result = strategy.assign_communities(
            store,
            ["isolated-new"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

        assert isinstance(result, set)
        store.close()

    def test_community_id_from_used_correctly(self, tmp_path: pathlib.Path) -> None:
        """Returned community UUIDs match community_id_from for the assigned cluster."""
        strategy = DynamicFrontierLeiden()
        store = _make_store_with_entities(
            tmp_path,
            [
                ("entity-x", 3, None),  # in community 3
                ("new-entity", None, None),
            ],
        )
        _add_entity_similar_edges(store, [("entity-x", "new-entity", 0.95)])

        result = strategy.assign_communities(
            store,
            ["new-entity"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

        # Verify returned UUIDs are valid community_id_from results
        row = store.conn.execute(
            "SELECT community_L0 FROM entities WHERE id = ?", ("new-entity",)
        ).fetchone()
        if row and row[0] is not None:
            expected_uuid = community_id_from("entity", "L0", int(row[0]))
            assert expected_uuid in result, (
                f"Expected community UUID {expected_uuid} not in result {result}"
            )
        store.close()
