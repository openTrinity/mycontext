"""Wrapped stores must expose db_path, or next-to-database persistence dies.

Regression: the HIT-Leiden incremental strategy resolves its persisted state
file via ``getattr(store, "db_path", None)``. A composite store that hides the
path (LadybugStore used to) silently disables state persistence, and every
batch degrades to a static rebuild — correct results, but incremental
maintenance in name only (observed across days 3-8 of the 8-day experiment:
"no valid persisted state" every day).
"""

from __future__ import annotations

import pytest


def test_ladybug_store_exposes_db_path(tmp_path):
    """LadybugStore.db_path resolves to the knowledge SQLite database."""
    pytest.importorskip("ladybug")
    from kl_graph.storage.ladybug_store import LadybugStore

    store = LadybugStore(
        db_path=tmp_path / "knowledge.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    try:
        assert store.db_path == tmp_path / "knowledge.db"

        from kl_graph.ingest.strategies.community import _state_path

        assert _state_path(store) == tmp_path / "hit_leiden_state.json"
    finally:
        store.close()
