"""Unit tests for ingest_meta table methods: get_meta, set_meta, existing_chunk_ids.

Tests verify:
- get_meta returns None when key is absent
- get_meta returns the correct stored value after set_meta
- set_meta overwrites an existing key (REPLACE semantics)
- existing_chunk_ids returns empty set for an empty list
- existing_chunk_ids returns only the IDs that exist in chunks table
- existing_chunk_ids handles a list larger than the batch size (500) correctly
- summary_stale column exists on communities table after store init
"""

from __future__ import annotations

import pathlib

from kl_graph.storage.sqlite_store import SQLiteStore


def _make_store(tmp_path: pathlib.Path) -> SQLiteStore:
    """Create a fresh SQLiteStore backed by a temp file."""
    return SQLiteStore(tmp_path / "test.db")


def _insert_chunk(store: SQLiteStore, chunk_id: str) -> None:
    """Insert a minimal chunk row directly."""
    store.conn.execute(
        "INSERT OR IGNORE INTO chunks (id, content, source_type, timestamp) "
        "VALUES (?, ?, ?, ?)",
        (chunk_id, "content", "message", 0),
    )
    store.conn.commit()


# ── get_meta / set_meta ───────────────────────────────────────────────────────


def test_get_meta_missing_key_returns_none(tmp_path: pathlib.Path) -> None:
    """get_meta returns None when the key has never been set."""
    store = _make_store(tmp_path)
    assert store.get_meta("nonexistent_key") is None
    store.close()


def test_get_meta_returns_set_value(tmp_path: pathlib.Path) -> None:
    """get_meta returns the value stored by set_meta."""
    store = _make_store(tmp_path)
    store.set_meta("watermark.message", "1700000000000")
    result = store.get_meta("watermark.message")
    assert result == "1700000000000"
    store.close()


def test_set_meta_overwrites_existing(tmp_path: pathlib.Path) -> None:
    """set_meta replaces an existing value (INSERT OR REPLACE semantics)."""
    store = _make_store(tmp_path)
    store.set_meta("incremental_run_count", "3")
    store.set_meta("incremental_run_count", "5")
    assert store.get_meta("incremental_run_count") == "5"
    store.close()


def test_set_meta_multiple_keys(tmp_path: pathlib.Path) -> None:
    """Different keys are stored and retrieved independently."""
    store = _make_store(tmp_path)
    store.set_meta("key_a", "value_a")
    store.set_meta("key_b", "value_b")
    assert store.get_meta("key_a") == "value_a"
    assert store.get_meta("key_b") == "value_b"
    store.close()


def test_set_meta_empty_value(tmp_path: pathlib.Path) -> None:
    """set_meta accepts an empty string value."""
    store = _make_store(tmp_path)
    store.set_meta("some_key", "")
    result = store.get_meta("some_key")
    assert result == ""
    store.close()


# ── existing_chunk_ids ────────────────────────────────────────────────────────


def test_existing_chunk_ids_empty_list(tmp_path: pathlib.Path) -> None:
    """existing_chunk_ids returns empty set for an empty input."""
    store = _make_store(tmp_path)
    result = store.existing_chunk_ids([])
    assert result == set()
    store.close()


def test_existing_chunk_ids_none_exist(tmp_path: pathlib.Path) -> None:
    """existing_chunk_ids returns empty set when none of the IDs are in the DB."""
    store = _make_store(tmp_path)
    result = store.existing_chunk_ids(["id1", "id2", "id3"])
    assert result == set()
    store.close()


def test_existing_chunk_ids_all_exist(tmp_path: pathlib.Path) -> None:
    """existing_chunk_ids returns all IDs when all exist."""
    store = _make_store(tmp_path)
    _insert_chunk(store, "id_a")
    _insert_chunk(store, "id_b")
    result = store.existing_chunk_ids(["id_a", "id_b"])
    assert result == {"id_a", "id_b"}
    store.close()


def test_existing_chunk_ids_partial_match(tmp_path: pathlib.Path) -> None:
    """existing_chunk_ids returns only the IDs that exist."""
    store = _make_store(tmp_path)
    _insert_chunk(store, "exists_1")
    _insert_chunk(store, "exists_2")
    result = store.existing_chunk_ids(["exists_1", "missing_1", "exists_2", "missing_2"])
    assert result == {"exists_1", "exists_2"}
    store.close()


def test_existing_chunk_ids_large_batch(tmp_path: pathlib.Path) -> None:
    """existing_chunk_ids handles more than 500 IDs (crosses batch boundary)."""
    store = _make_store(tmp_path)
    # Insert 300 chunks
    existing = [f"chunk_{i}" for i in range(300)]
    for cid in existing:
        _insert_chunk(store, cid)
    # Query 600 IDs: 300 existing + 300 non-existing
    query_ids = existing + [f"missing_{i}" for i in range(300)]
    result = store.existing_chunk_ids(query_ids)
    assert result == set(existing)
    store.close()


# ── summary_stale column ──────────────────────────────────────────────────────


def test_communities_has_summary_stale_column(tmp_path: pathlib.Path) -> None:
    """summary_stale column exists on communities table after store init."""
    store = _make_store(tmp_path)
    cols = {r[1] for r in store.conn.execute("PRAGMA table_info(communities)").fetchall()}
    assert "summary_stale" in cols, "summary_stale column missing from communities table"
    store.close()


def test_summary_stale_default_value(tmp_path: pathlib.Path) -> None:
    """Newly inserted community rows have summary_stale = 0 by default."""
    store = _make_store(tmp_path)
    store.conn.execute(
        "INSERT INTO communities (id, level, node_type) VALUES (?, ?, ?)",
        ("comm-001", "L0", "entity"),
    )
    store.conn.commit()
    row = store.conn.execute(
        "SELECT summary_stale FROM communities WHERE id = ?", ("comm-001",)
    ).fetchone()
    assert row is not None
    assert row[0] == 0
    store.close()


def test_ingest_meta_table_exists(tmp_path: pathlib.Path) -> None:
    """ingest_meta table is created on store init."""
    store = _make_store(tmp_path)
    tables = {
        r[0]
        for r in store.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert "ingest_meta" in tables
    store.close()
