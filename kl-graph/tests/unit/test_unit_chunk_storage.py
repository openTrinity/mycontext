"""Unit lineage persistence tests."""

from __future__ import annotations

import sqlite3

import pytest

from kl_graph.models.types import Chunk, ChunkUnit, SourceUnit
from kl_graph.storage.sqlite_store import SQLiteStore


def test_chunks_units_and_ordered_memberships_commit_together(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "knowledge.db")
    units = [
        SourceUnit("ding", "message", "m1", "h1", timestamp=1),
        SourceUnit("ding", "message", "m2", "h2", timestamp=2),
    ]
    chunk = Chunk(id="ding:c1", content="one\ntwo", source_type="message")
    memberships = [
        ChunkUnit("ding:c1", "ding", "message", "m1", 0, 0),
        ChunkUnit("ding:c1", "ding", "message", "m2", 1, 0),
    ]

    store.insert_chunks_with_units([chunk], units, memberships)

    assert store.existing_unit_ids("ding", [("message", "m1"), ("message", "m2")]) == {
        ("message", "m1"),
        ("message", "m2"),
    }
    rows = store.sql_conn.execute(
        """SELECT unit_id, unit_ordinal_in_chunk, chunk_ordinal_in_unit
           FROM chunk_units ORDER BY unit_ordinal_in_chunk"""
    ).fetchall()
    assert [tuple(row) for row in rows] == [("m1", 0, 0), ("m2", 1, 0)]


def test_same_unit_id_is_isolated_by_source(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "knowledge.db")
    for source_id in ("ding", "slack"):
        chunk_id = f"{source_id}:c1"
        store.insert_chunks_with_units(
            [Chunk(id=chunk_id, content=source_id)],
            [SourceUnit(source_id, "message", "same", source_id)],
            [ChunkUnit(chunk_id, source_id, "message", "same", 0, 0)],
        )

    count = store.sql_conn.execute("SELECT COUNT(*) FROM units").fetchone()[0]
    assert count == 2


def test_chunk_insert_rolls_back_when_unit_insert_fails(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "knowledge.db")
    invalid = SourceUnit("ding", "message", "m1", None)  # type: ignore[arg-type]

    with pytest.raises(sqlite3.IntegrityError):
        store.insert_chunks_with_units(
            [Chunk(id="ding:c1", content="content")], [invalid], []
        )

    assert store.count_chunks() == 0
    assert store.sql_conn.execute("SELECT COUNT(*) FROM units").fetchone()[0] == 0


def test_batch_workset_commits_and_cleans_up_with_lineage(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "knowledge.db")
    chunk = Chunk(id="ding:c1", content="one", source_type="message")
    unit = SourceUnit("ding", "message", "m1", "h1")
    membership = ChunkUnit("ding:c1", "ding", "message", "m1", 0, 0)

    store.insert_chunks_with_units(
        [chunk],
        [unit],
        [membership],
        batch_id="batch-1",
        batch_source_id="ding",
        source_hash="sha256:one",
    )

    batch = store.get_ingest_batch("batch-1")
    assert batch is not None
    assert (batch["state"], batch["unit_count"], batch["chunk_count"]) == (
        "ready",
        1,
        1,
    )
    assert [c.id for c in store.get_ingest_batch_chunks("batch-1")] == ["ding:c1"]

    store.complete_ingest_batch("batch-1")

    assert store.get_ingest_batch("batch-1")["state"] == "complete"
    assert store.get_ingest_batch_chunks("batch-1") == []
    assert store.get_chunk("ding:c1") is not None
    assert store.existing_unit_ids("ding", [("message", "m1")]) == {
        ("message", "m1")
    }


def test_empty_batch_is_a_valid_durable_workset(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "knowledge.db")

    store.insert_chunks_with_units(
        [],
        [],
        [],
        batch_id="empty",
        batch_source_id="ding",
        source_hash="sha256:empty",
    )

    batch = store.get_ingest_batch("empty")
    assert batch is not None
    assert batch["state"] == "ready"
    assert batch["unit_count"] == batch["chunk_count"] == 0
