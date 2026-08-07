"""Unit deduplication and ordered chunk-lineage construction."""

from __future__ import annotations

import hashlib
from unittest.mock import MagicMock

from kl_graph.ingest.pipeline import IngestionPipeline
from kl_graph.ingest.session_chunker import slice_chat_sessions
from kl_graph.models.types import Chunk, SourceUnit
from kl_graph.storage.sqlite_store import SQLiteStore


def _unit(source_id: str, chunk: Chunk) -> SourceUnit:
    return SourceUnit(
        source_id,
        chunk.source_type,
        chunk.id,
        hashlib.sha256(chunk.content.encode()).hexdigest(),
        chunk.timestamp,
        chunk.metadata,
    )


def test_seen_messages_are_removed_before_session_chunking(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "knowledge.db")
    old = Chunk(
        id="m1",
        content="old",
        metadata={"conversation_id": "c", "sender": "a"},
    )
    store.insert_chunks_with_units(
        [Chunk(id="ding:old", content="old")],
        [_unit("ding", old)],
        [],
    )
    new = Chunk(
        id="m2",
        content="new",
        metadata={"conversation_id": "c", "sender": "b"},
    )
    pipeline = IngestionPipeline(
        store=store,
        qdrant=MagicMock(),
        source_id="ding",
        incremental_units=True,
    )

    filtered = pipeline._filter_unseen_chunks(
        [old, new], [_unit("ding", old), _unit("ding", new)]
    )
    pipeline.messages = slice_chat_sessions(filtered)
    pipeline._namespace_chunk_ids()
    pipeline._build_chunk_unit_memberships()

    assert [unit.unit_id for unit in pipeline.source_units] == ["m2"]
    assert len(pipeline.messages) == 1
    assert pipeline.messages[0].id.startswith("ding:")
    assert [
        (row.unit_id, row.unit_ordinal_in_chunk) for row in pipeline.chunk_units
    ] == [("m2", 0)]


def test_document_chunk_order_is_recorded(tmp_path) -> None:
    pipeline = IngestionPipeline(
        store=SQLiteStore(tmp_path / "knowledge.db"),
        qdrant=MagicMock(),
        source_id="wiki-prod",
    )
    pipeline.source_units = [SourceUnit("wiki-prod", "wiki", "doc", "hash")]
    pipeline.extra_chunks = [
        Chunk(
            id="wiki:doc:0",
            content="a",
            source_type="wiki",
            metadata={"unit_id": "doc"},
        ),
        Chunk(
            id="wiki:doc:1",
            content="b",
            source_type="wiki",
            metadata={"unit_id": "doc"},
        ),
    ]

    pipeline._namespace_chunk_ids()
    pipeline._build_chunk_unit_memberships()

    assert [row.chunk_ordinal_in_unit for row in pipeline.chunk_units] == [0, 1]
