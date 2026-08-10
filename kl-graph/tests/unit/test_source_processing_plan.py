"""Extensibility and durability tests for source-processing plans."""

from __future__ import annotations

import hashlib
from unittest.mock import MagicMock

from kl_graph.ingest.pipeline import IngestionPipeline
from kl_graph.ingest.source_strategy import SessionChatProcessingStrategy
from kl_graph.models.types import (
    Chunk,
    ChunkUnit,
    EdgeType,
    ExtractionProjection,
    SourceUnit,
)
from kl_graph.storage.sqlite_store import SQLiteStore


class FixedSizeChatStrategy(SessionChatProcessingStrategy):
    """Tiny test policy: split storage while inheriting complete extraction."""

    version = "fixed-size-test-v1"

    def build_stored_chunks(self, records, units):
        record = records[0]
        midpoint = len(record.content) // 2
        return [
            Chunk(
                id=f"fixed-{index}",
                content=content,
                source_type="message",
                timestamp=record.timestamp,
                metadata={
                    "member_message_ids": [record.id],
                    "conversation_id": record.metadata["conversation_id"],
                },
            )
            for index, content in enumerate(
                (record.content[:midpoint], record.content[midpoint:])
            )
        ]

    def build_chunk_units(self, chunks, units, *, source_id):
        split = len(chunks[0].content)
        return [
            ChunkUnit(
                chunk_id=chunk.id,
                source_id=source_id,
                source_type="message",
                unit_id=units[0].unit_id,
                unit_ordinal_in_chunk=0,
                chunk_ordinal_in_unit=index,
                start_offset=0 if index == 0 else split,
                end_offset=split if index == 0 else split + len(chunk.content),
            )
            for index, chunk in enumerate(chunks)
        ]


def _message_and_unit():
    message = Chunk(
        id="m1",
        content="[private] Alice -> Bob\nA complete claim spanning a boundary",
        source_type="message",
        timestamp=42,
        metadata={"conversation_id": "conv", "sender": "Alice"},
    )
    unit = SourceUnit(
        source_id="ding",
        source_type="message",
        unit_id="m1",
        content_hash=hashlib.sha256(message.content.encode()).hexdigest(),
        timestamp=42,
    )
    return message, unit


def test_fixed_storage_inherits_complete_message_extraction_and_projection():
    message, unit = _message_and_unit()
    plan = FixedSizeChatStrategy().plan([message], [unit], source_id="ding")

    assert len(plan.chunks) == 2
    assert len(plan.extraction_items) == 1
    assert plan.extraction_items[0].content == message.content
    assert plan.extraction_items[0].source_unit_id == "m1"
    assert [row.chunk_ordinal_in_unit for row in plan.chunk_units] == [0, 1]
    assert [row.role for row in plan.projections] == ["primary", "supporting"]
    assert {row.chunk_id for row in plan.projections} == {
        "ding:fixed-0",
        "ding:fixed-1",
    }


def test_oversized_quote_is_stored_in_slices_but_never_becomes_target():
    target = "[group] Alice\nThe claimed default-model change is incorrect."
    quote = "[quoted release note]\n" + ("A historical release detail. " * 800)
    message = Chunk(
        id="reply-1",
        content=f"{target}\n{quote}",
        source_type="message",
        timestamp=42,
        metadata={
            "conversation_id": "conv",
            "sender": "Alice",
            "extraction_target_content": target,
            "quoted_context": quote,
        },
    )
    unit = SourceUnit(
        source_id="ding",
        source_type="message",
        unit_id=message.id,
        content_hash=hashlib.sha256(message.content.encode()).hexdigest(),
        timestamp=message.timestamp,
    )

    plan = SessionChatProcessingStrategy().plan(
        [message], [unit], source_id="ding"
    )

    assert len(plan.chunks) > 1
    assert len(plan.extraction_items) == 1
    item = plan.extraction_items[0]
    assert item.content == target
    assert quote not in item.content
    assert quote in item.context
    assert len(plan.projections) == len(plan.chunks)
    assert plan.projections[0].role == "primary"
    assert all(row.extraction_item_id == item.id for row in plan.projections)


def test_extraction_identity_does_not_depend_on_storage_chunk_ids():
    message, unit = _message_and_unit()
    first = FixedSizeChatStrategy().plan([message], [unit], source_id="ding")
    second = FixedSizeChatStrategy().plan([message], [unit], source_id="ding")
    second.chunks[0].id = "different-storage-id"

    assert first.extraction_items[0].id == second.extraction_items[0].id


def test_active_batch_round_trips_complete_extraction_plan(tmp_path):
    message, unit = _message_and_unit()
    plan = FixedSizeChatStrategy().plan([message], [unit], source_id="ding")
    store = SQLiteStore(tmp_path / "knowledge.db")
    try:
        store.insert_chunks_with_units(
            plan.chunks,
            [unit],
            plan.chunk_units,
            plan.extraction_items,
            plan.projections,
            batch_id="batch",
            batch_source_id="ding",
            source_hash="source-hash",
        )
        items, projections = store.get_ingest_batch_extraction_plan("batch")
        assert [item.content for item in items] == [message.content]
        assert projections == plan.projections
    finally:
        store.close()


def test_one_fact_can_state_multiple_chunks_without_duplicate_fact_identity():
    edges = IngestionPipeline._fact_edges(
        "primary",
        {"fact_text": "Alice approved the complete proposal"},
        {},
        extraction_item_id="item-1",
        state_chunk_ids=["primary", "supporting"],
    )
    states = [edge for edge in edges if edge.edge_type == EdgeType.STATES]
    assert len({edge.source_id for edge in states}) == 1
    assert [edge.target_id for edge in states] == ["primary", "supporting"]


def test_mentions_prefer_the_projected_chunk_containing_name(tmp_path):
    store = SQLiteStore(tmp_path / "knowledge.db")
    pipeline = IngestionPipeline(store=store, qdrant=MagicMock())
    pipeline.messages = [
        Chunk(id="c1", content="Alice approved it"),
        Chunk(id="c2", content="the remaining details"),
    ]
    pipeline.extraction_projections = [
        ExtractionProjection(
            extraction_item_id="item", chunk_id="c1", role="primary"
        ),
        ExtractionProjection(extraction_item_id="item", chunk_id="c2"),
    ]
    try:
        assert [
            row.chunk_id for row in pipeline._mention_projections_for("item", "Alice")
        ] == ["c1"]
    finally:
        store.close()
