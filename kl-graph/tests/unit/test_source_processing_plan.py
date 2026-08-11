"""Extensibility and durability tests for source-processing plans."""

from __future__ import annotations

import hashlib
from unittest.mock import MagicMock

from kl_graph.ingest.loaders.base import SESSION_BREAK_MARKER
from kl_graph.ingest.pipeline import IngestionPipeline
from kl_graph.ingest.source_strategy import (
    FixedSizeChatProcessingStrategy,
    SessionChatProcessingStrategy,
    source_strategy_for,
)
from kl_graph.models.types import (
    Chunk,
    EdgeType,
    ExtractionProjection,
    SourceUnit,
)
from kl_graph.storage.sqlite_store import SQLiteStore


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


def _two_window_strategy(message: Chunk) -> FixedSizeChatProcessingStrategy:
    return FixedSizeChatProcessingStrategy(
        chunk_size_chars=(len(message.content) + 1) // 2,
        overlap_chars=0,
    )


def test_fixed_storage_inherits_complete_message_extraction_and_projection():
    message, unit = _message_and_unit()
    plan = _two_window_strategy(message).plan([message], [unit], source_id="ding")

    assert len(plan.chunks) == 2
    assert len(plan.extraction_items) == 1
    assert plan.extraction_items[0].content == message.content
    assert plan.extraction_items[0].source_unit_id == "m1"
    assert [row.chunk_ordinal_in_unit for row in plan.chunk_units] == [0, 1]
    assert [row.role for row in plan.projections] == ["primary", "supporting"]
    assert {row.chunk_id for row in plan.projections} == {
        chunk.id for chunk in plan.chunks
    }
    assert [(row.start_offset, row.end_offset) for row in plan.chunk_units] == [
        (0, len(plan.chunks[0].content)),
        (len(plan.chunks[0].content), len(message.content)),
    ]


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
    strategy = _two_window_strategy(message)
    first = strategy.plan([message], [unit], source_id="ding")
    second = strategy.plan([message], [unit], source_id="ding")
    second.chunks[0].id = "different-storage-id"

    assert first.extraction_items[0].id == second.extraction_items[0].id


def test_active_batch_round_trips_complete_extraction_plan(tmp_path):
    message, unit = _message_and_unit()
    plan = _two_window_strategy(message).plan([message], [unit], source_id="ding")
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


def test_fixed_size_overlap_tracks_exact_spans_across_message_boundaries():
    messages = [
        Chunk(
            id="m1",
            content="abcdefghij",
            source_type="message",
            timestamp=1,
            metadata={"conversation_id": "conv", "sender": "User A"},
        ),
        Chunk(
            id="m2",
            content="KLMNOPQRST",
            source_type="message",
            timestamp=2,
            metadata={"conversation_id": "conv", "sender": "User B"},
        ),
    ]
    units = [
        SourceUnit("ding", "message", message.id, f"hash-{message.id}")
        for message in messages
    ]
    strategy = FixedSizeChatProcessingStrategy(
        chunk_size_chars=8, overlap_chars=2
    )

    plan = strategy.plan(messages, units, source_id="ding")

    assert [len(chunk.content) for chunk in plan.chunks] == [8, 8, 8, 4]
    assert plan.chunks[1].metadata["member_message_ids"] == ["m1", "m2"]
    spans = [
        (row.unit_id, row.start_offset, row.end_offset)
        for row in plan.chunk_units
    ]
    assert spans == [
        ("m1", 0, 8),
        ("m1", 6, 10),
        ("m2", 0, 2),
        ("m2", 0, 8),
        ("m2", 6, 10),
    ]
    assert len(plan.extraction_items) == 2
    assert [item.content for item in plan.extraction_items] == [
        "abcdefghij",
        "KLMNOPQRST",
    ]
    projections_by_item = {
        item.source_unit_id: [
            row for row in plan.projections if row.extraction_item_id == item.id
        ]
        for item in plan.extraction_items
    }
    assert len(projections_by_item["m1"]) == 2
    assert len(projections_by_item["m2"]) == 3


def test_fixed_size_windows_never_cross_session_breaks():
    messages = [
        Chunk(
            id="m1",
            content="first",
            metadata={"conversation_id": "conv", "sender": "User A"},
        ),
        Chunk(
            id="m2",
            content="second",
            metadata={
                "conversation_id": "conv",
                "sender": "User B",
                "session_start": True,
            },
        ),
    ]
    units = [
        SourceUnit("ding", "message", message.id, f"hash-{message.id}")
        for message in messages
    ]

    plan = FixedSizeChatProcessingStrategy(100, 10).plan(
        messages, units, source_id="ding"
    )

    assert [chunk.content for chunk in plan.chunks] == ["first", "second"]
    assert [chunk.metadata["session_index"] for chunk in plan.chunks] == [0, 1]
    assert all(chunk.metadata["session_start"] for chunk in plan.chunks)


def test_fixed_size_lineage_offsets_account_for_removed_session_marker():
    prefix = f"{SESSION_BREAK_MARKER}\n"
    message = Chunk(
        id="m1",
        content=f"{prefix}abcdef",
        metadata={"conversation_id": "conv", "session_start": True},
    )
    unit = SourceUnit("ding", "message", "m1", "hash-m1")

    plan = FixedSizeChatProcessingStrategy(3, 0).plan(
        [message], [unit], source_id="ding"
    )

    assert [chunk.content for chunk in plan.chunks] == ["abc", "def"]
    assert [(row.start_offset, row.end_offset) for row in plan.chunk_units] == [
        (len(prefix), len(prefix) + 3),
        (len(prefix) + 3, len(prefix) + 6),
    ]


def test_fixed_size_chunk_ids_are_deterministic_and_budget_specific():
    message, unit = _message_and_unit()
    first = FixedSizeChatProcessingStrategy(30, 5).plan(
        [message], [unit], source_id="ding"
    )
    second = FixedSizeChatProcessingStrategy(30, 5).plan(
        [message], [unit], source_id="ding"
    )
    changed_budget = FixedSizeChatProcessingStrategy(31, 5).plan(
        [message], [unit], source_id="ding"
    )

    assert [chunk.id for chunk in first.chunks] == [
        chunk.id for chunk in second.chunks
    ]
    assert [chunk.id for chunk in first.chunks] != [
        chunk.id for chunk in changed_budget.chunks
    ]


def test_fixed_size_rejects_invalid_budgets():
    for size, overlap in ((0, 0), (10, -1), (10, 10), (10, 11)):
        try:
            FixedSizeChatProcessingStrategy(size, overlap)
        except ValueError:
            pass
        else:
            raise AssertionError(f"accepted invalid fixed-size budget {size}/{overlap}")


def test_fixed_size_strategy_is_selectable_from_source_configuration(monkeypatch):
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies,
        "message",
        "fixed_size_chat",
    )

    strategy = source_strategy_for("message")
    assert isinstance(strategy, FixedSizeChatProcessingStrategy)
    assert strategy.chunk_size_chars == int(
        cfg.pipelines.ingestion.extraction.fixed_size_chat.chunk_size_chars
    )
    assert strategy.overlap_chars == int(
        cfg.pipelines.ingestion.extraction.fixed_size_chat.overlap_chars
    )


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
