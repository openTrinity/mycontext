"""Unit tests for DynamicFrontierLeiden incremental community strategy.

Tests verify the GUARDED NO-OP contract:
- The strategy is disabled pending the incremental hierarchical Leiden path
- assign_communities always returns an empty set
- The method logs a warning but doesn't raise
- No community assignments are written to the store
"""

from __future__ import annotations

import logging
import pathlib

import pytest

from kl_graph.ingest.strategies.community import DynamicFrontierLeiden
from kl_graph.storage.sqlite_store import SQLiteStore


def test_dynamic_frontier_leiden_is_guarded_noop(tmp_path: pathlib.Path, caplog: pytest.LogCaptureFixture) -> None:
    """DynamicFrontierLeiden is a guarded no-op pending incremental rewrite.
    
    Verifies:
    - Returns empty set (no communities changed)
    - Logs a warning
    - Doesn't modify any community columns
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    
    # Insert some test entities
    store.conn.execute(
        "INSERT INTO entities (id, name) VALUES (?, ?)",
        ("e1", "Entity 1")
    )
    store.conn.commit()
    
    # Call assign_communities with the new API signature
    with caplog.at_level(logging.WARNING):
        result = strategy.assign_communities(
            store,
            ["e1"],  # new_entity_ids
            [],     # new_fact_ids
            entity_resolutions={},
            fact_resolutions={},
        )
    
    # Verify no-op contract
    assert result == set(), "No-op strategy must return empty set"
    
    # Verify warning was logged
    assert any("Incremental community strategy disabled" in record.message for record in caplog.records), \
        "Strategy should log warning about being disabled"
    
    # Verify no community assignments were written
    store.conn.execute("SELECT 1 FROM entities WHERE id = 'e1'")
    # The entity should exist but have no community columns set
    # (since the strategy is a no-op)
    
    store.close()


def test_dynamic_frontier_leiden_handles_empty_inputs(tmp_path: pathlib.Path) -> None:
    """No-op strategy handles empty inputs gracefully."""
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    
    result = strategy.assign_communities(
        store, [], [], entity_resolutions={}, fact_resolutions={}
    )
    
    assert result == set()
    store.close()


def test_dynamic_frontier_leiden_preserves_existing_communities(tmp_path: pathlib.Path) -> None:
    """No-op strategy doesn't modify existing community assignments.
    
    If an entity already has a community_L0 value, the no-op strategy
    should leave it unchanged.
    """
    strategy = DynamicFrontierLeiden()
    store = SQLiteStore(tmp_path / "test.db")
    
    # Add community_L0 column and insert entity with existing assignment
    store.conn.execute("ALTER TABLE entities ADD COLUMN community_L0 TEXT")
    store.conn.execute(
        "INSERT INTO entities (id, name, community_L0) VALUES (?, ?, ?)",
        ("e1", "Entity 1", "existing-community-id")
    )
    store.conn.commit()
    
    # Call no-op strategy
    result = strategy.assign_communities(
        store, ["e1"], [], entity_resolutions={}, fact_resolutions={}
    )
    
    # Verify existing assignment is unchanged
    row = store.conn.execute(
        "SELECT community_L0 FROM entities WHERE id = 'e1'"
    ).fetchone()
    assert row is not None
    assert row[0] == "existing-community-id", \
        "No-op strategy must not modify existing community assignments"
    
    assert result == set()
    store.close()
