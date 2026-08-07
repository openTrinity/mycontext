"""Unit tests for delta detection: IngestionPipeline._load_delta().

Tests verify:
- _load_delta returns all chunks when none exist in DB
- _load_delta returns empty list when all chunks already exist
- _load_delta returns only new chunks when some exist
- _load_delta calls store.existing_chunk_ids with all chunk IDs
- _load_delta works with an empty source (no chunks loaded)
"""

from __future__ import annotations

import pathlib
from unittest.mock import patch

from kl_graph.models.types import Chunk
from kl_graph.storage.sqlite_store import SQLiteStore


def _make_chunk(chunk_id: str, source_type: str = "message", ts: int = 0) -> Chunk:
    """Create a minimal Chunk for testing."""
    return Chunk(
        id=chunk_id,
        content=f"Content of {chunk_id}",
        source_type=source_type,
        timestamp=ts,
    )


def _make_pipeline(tmp_path: pathlib.Path):
    """Create an IngestionPipeline with injected SQLiteStore and no lock acquisition."""
    from kl_graph.ingest.pipeline import IngestionPipeline

    store = SQLiteStore(tmp_path / "test.db")
    # Inject store so pipeline doesn't try to acquire the file lock.
    pipeline = IngestionPipeline(store=store)
    return pipeline, store


# ── _load_delta ───────────────────────────────────────────────────────────────


def test_load_delta_all_new(tmp_path: pathlib.Path) -> None:
    """_load_delta returns all chunks when none exist in the DB."""
    pipeline, store = _make_pipeline(tmp_path)
    chunks = [_make_chunk("c1"), _make_chunk("c2"), _make_chunk("c3")]
    # Patch _load_sources so it populates self.messages without touching disk.
    def fake_load():
        pipeline.messages = chunks

    with patch.object(pipeline, "_load_sources", side_effect=fake_load):
        result = pipeline._load_delta()

    assert {c.id for c in result} == {"c1", "c2", "c3"}
    store.close()


def test_load_delta_none_new(tmp_path: pathlib.Path) -> None:
    """_load_delta returns empty list when all chunks already exist in the DB."""
    pipeline, store = _make_pipeline(tmp_path)
    chunks = [_make_chunk("c1"), _make_chunk("c2")]
    # Pre-insert these chunks.
    store.insert_chunks(chunks)

    def fake_load():
        pipeline.messages = chunks

    with patch.object(pipeline, "_load_sources", side_effect=fake_load):
        result = pipeline._load_delta()

    assert result == []
    store.close()


def test_load_delta_partial_new(tmp_path: pathlib.Path) -> None:
    """_load_delta returns only the chunks not already in the DB."""
    pipeline, store = _make_pipeline(tmp_path)
    existing_chunks = [_make_chunk("existing_1"), _make_chunk("existing_2")]
    new_chunks = [_make_chunk("new_1"), _make_chunk("new_2")]
    all_chunks = existing_chunks + new_chunks

    # Pre-insert only the existing chunks.
    store.insert_chunks(existing_chunks)

    def fake_load():
        pipeline.messages = all_chunks

    with patch.object(pipeline, "_load_sources", side_effect=fake_load):
        result = pipeline._load_delta()

    assert {c.id for c in result} == {"new_1", "new_2"}
    store.close()


def test_load_delta_no_sources(tmp_path: pathlib.Path) -> None:
    """_load_delta returns empty list when no chunks are loaded from source."""
    pipeline, store = _make_pipeline(tmp_path)

    def fake_load():
        pipeline.messages = []
        pipeline.extra_chunks = []

    with patch.object(pipeline, "_load_sources", side_effect=fake_load):
        result = pipeline._load_delta()

    assert result == []
    store.close()


def test_load_delta_uses_existing_chunk_ids(tmp_path: pathlib.Path) -> None:
    """_load_delta calls store.existing_chunk_ids with all loaded chunk IDs."""
    pipeline, store = _make_pipeline(tmp_path)
    chunks = [_make_chunk(f"chunk_{i}") for i in range(5)]

    def fake_load():
        pipeline.messages = chunks

    with (
        patch.object(pipeline, "_load_sources", side_effect=fake_load),
        patch.object(
            store, "existing_chunk_ids", wraps=store.existing_chunk_ids
        ) as mock_existing,
    ):
        pipeline._load_delta()

    # existing_chunk_ids should have been called with all 5 IDs.
    mock_existing.assert_called_once()
    call_ids = set(mock_existing.call_args[0][0])
    assert call_ids == {c.id for c in chunks}
    store.close()


def test_load_delta_extra_chunks_included(tmp_path: pathlib.Path) -> None:
    """_load_delta considers both messages and extra_chunks as candidates."""
    pipeline, store = _make_pipeline(tmp_path)
    msg_chunks = [_make_chunk("msg_1", "message")]
    extra_chunks = [_make_chunk("wiki_1", "wiki")]

    def fake_load():
        pipeline.messages = msg_chunks
        pipeline.extra_chunks = extra_chunks

    with patch.object(pipeline, "_load_sources", side_effect=fake_load):
        result = pipeline._load_delta()

    assert {c.id for c in result} == {"msg_1", "wiki_1"}
    store.close()
