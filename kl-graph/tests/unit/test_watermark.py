"""Unit tests for the watermark module (kl_graph/ingest/watermark.py).

Tests verify:
- get_watermark returns None when not set
- get_watermark returns stored value as int after set_watermark
- set_watermark persists the correct key
- get_incremental_run_count returns 0 when unset
- get_incremental_run_count returns stored count
- increment_run_count increments from 0 to 1, then to 2
- reset_run_count sets count to 0 and writes last_full_rebuild_at
- needs_full_rebuild returns False when count < threshold
- needs_full_rebuild returns True when count == threshold
- needs_full_rebuild returns True when count > threshold
"""

from __future__ import annotations

import pathlib

from kl_graph.ingest.watermark import (
    get_incremental_run_count,
    get_watermark,
    increment_run_count,
    needs_full_rebuild,
    reset_run_count,
    set_watermark,
)
from kl_graph.storage.sqlite_store import SQLiteStore


def _make_store(tmp_path: pathlib.Path) -> SQLiteStore:
    """Create a fresh SQLiteStore backed by a temp file."""
    return SQLiteStore(tmp_path / "test.db")


# ── get_watermark / set_watermark ─────────────────────────────────────────────


def test_get_watermark_unset_returns_none(tmp_path: pathlib.Path) -> None:
    """get_watermark returns None when watermark has not been set."""
    store = _make_store(tmp_path)
    result = get_watermark(store, "message")
    assert result is None
    store.close()


def test_set_and_get_watermark_round_trip(tmp_path: pathlib.Path) -> None:
    """set_watermark stores the timestamp; get_watermark retrieves it as int."""
    store = _make_store(tmp_path)
    ts = 1700000000000
    set_watermark(store, "message", ts)
    result = get_watermark(store, "message")
    assert result == ts
    store.close()


def test_set_watermark_uses_correct_key(tmp_path: pathlib.Path) -> None:
    """set_watermark stores under key 'watermark.<source_type>'."""
    store = _make_store(tmp_path)
    set_watermark(store, "wiki", 999)
    assert store.get_meta("watermark.wiki") == "999"
    # Other source types are unaffected.
    assert store.get_meta("watermark.message") is None
    store.close()


def test_watermark_types_are_independent(tmp_path: pathlib.Path) -> None:
    """Watermarks for different source types are stored independently."""
    store = _make_store(tmp_path)
    set_watermark(store, "message", 1000)
    set_watermark(store, "mail", 2000)
    assert get_watermark(store, "message") == 1000
    assert get_watermark(store, "mail") == 2000
    store.close()


def test_set_watermark_overwrites(tmp_path: pathlib.Path) -> None:
    """set_watermark replaces an existing watermark for the same source_type."""
    store = _make_store(tmp_path)
    set_watermark(store, "message", 1000)
    set_watermark(store, "message", 2000)
    assert get_watermark(store, "message") == 2000
    store.close()


# ── get_incremental_run_count ─────────────────────────────────────────────────


def test_incremental_run_count_unset_returns_zero(tmp_path: pathlib.Path) -> None:
    """get_incremental_run_count returns 0 when no count has been persisted."""
    store = _make_store(tmp_path)
    assert get_incremental_run_count(store) == 0
    store.close()


def test_incremental_run_count_returns_stored_value(tmp_path: pathlib.Path) -> None:
    """get_incremental_run_count returns the value stored in ingest_meta."""
    store = _make_store(tmp_path)
    store.set_meta("incremental_run_count", "7")
    assert get_incremental_run_count(store) == 7
    store.close()


# ── increment_run_count ───────────────────────────────────────────────────────


def test_increment_run_count_starts_at_one(tmp_path: pathlib.Path) -> None:
    """increment_run_count from 0 returns 1."""
    store = _make_store(tmp_path)
    result = increment_run_count(store)
    assert result == 1
    assert get_incremental_run_count(store) == 1
    store.close()


def test_increment_run_count_successive_calls(tmp_path: pathlib.Path) -> None:
    """Successive increment_run_count calls count up correctly."""
    store = _make_store(tmp_path)
    assert increment_run_count(store) == 1
    assert increment_run_count(store) == 2
    assert increment_run_count(store) == 3
    store.close()


# ── reset_run_count ───────────────────────────────────────────────────────────


def test_reset_run_count_sets_to_zero(tmp_path: pathlib.Path) -> None:
    """reset_run_count resets incremental_run_count to 0."""
    store = _make_store(tmp_path)
    increment_run_count(store)
    increment_run_count(store)
    reset_run_count(store)
    assert get_incremental_run_count(store) == 0
    store.close()


def test_reset_run_count_writes_rebuild_timestamp(tmp_path: pathlib.Path) -> None:
    """reset_run_count writes last_full_rebuild_at as a non-empty integer string."""
    store = _make_store(tmp_path)
    reset_run_count(store)
    ts_str = store.get_meta("last_full_rebuild_at")
    assert ts_str is not None
    ts = int(ts_str)
    # Should be a reasonable Unix timestamp (after 2020-01-01 = 1577836800).
    assert ts > 1577836800
    store.close()


# ── needs_full_rebuild ────────────────────────────────────────────────────────


def test_needs_full_rebuild_below_threshold(tmp_path: pathlib.Path) -> None:
    """needs_full_rebuild returns False when count < threshold."""
    store = _make_store(tmp_path)
    store.set_meta("incremental_run_count", "5")
    assert needs_full_rebuild(store, 10) is False
    store.close()


def test_needs_full_rebuild_at_threshold(tmp_path: pathlib.Path) -> None:
    """needs_full_rebuild returns True when count == threshold."""
    store = _make_store(tmp_path)
    store.set_meta("incremental_run_count", "10")
    assert needs_full_rebuild(store, 10) is True
    store.close()


def test_needs_full_rebuild_above_threshold(tmp_path: pathlib.Path) -> None:
    """needs_full_rebuild returns True when count > threshold."""
    store = _make_store(tmp_path)
    store.set_meta("incremental_run_count", "15")
    assert needs_full_rebuild(store, 10) is True
    store.close()


def test_needs_full_rebuild_unset_count_is_false(tmp_path: pathlib.Path) -> None:
    """needs_full_rebuild returns False when no count has been persisted (treats as 0)."""
    store = _make_store(tmp_path)
    assert needs_full_rebuild(store, 10) is False
    store.close()
