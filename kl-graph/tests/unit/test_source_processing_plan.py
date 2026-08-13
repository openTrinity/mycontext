"""Extensibility and durability tests for source-processing plans."""

from __future__ import annotations

import hashlib
from unittest.mock import MagicMock

import pytest

from kl_graph.ingest.loaders.base import SESSION_BREAK_MARKER
from kl_graph.ingest.pipeline import IngestionPipeline
from kl_graph.ingest.source_strategy import (
    ComposedStrategy,
    DocumentChunkExtraction,
    FixedSizeChatProcessingStrategy,
    FixedSizeChunking,
    MessageExtraction,
    NoneChunking,
    SessionChatProcessingStrategy,
    SessionChunking,
    StoredChunkExtraction,
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

    plan = SessionChatProcessingStrategy().plan([message], [unit], source_id="ding")

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
    strategy = FixedSizeChatProcessingStrategy(chunk_size_chars=8, overlap_chars=2)

    plan = strategy.plan(messages, units, source_id="ding")

    assert [len(chunk.content) for chunk in plan.chunks] == [8, 8, 8, 4]
    assert plan.chunks[1].metadata["member_message_ids"] == ["m1", "m2"]
    spans = [
        (row.unit_id, row.start_offset, row.end_offset) for row in plan.chunk_units
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

    assert [chunk.id for chunk in first.chunks] == [chunk.id for chunk in second.chunks]
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
    assert isinstance(strategy, ComposedStrategy)
    assert isinstance(strategy.chunker, FixedSizeChunking)
    assert isinstance(strategy.extractor, MessageExtraction)
    assert strategy.chunker.chunk_size_chars == int(
        cfg.pipelines.ingestion.extraction.fixed_size_chat.chunk_size_chars
    )
    assert strategy.chunker.overlap_chars == int(
        cfg.pipelines.ingestion.extraction.fixed_size_chat.overlap_chars
    )
    # The composed fixed-size version must stay byte-identical to the legacy
    # string so stored chunk ids (which hash it) do not re-key.
    fixed = cfg.pipelines.ingestion.extraction.fixed_size_chat
    assert strategy.chunker.version == (
        f"fixed-size-chat-v1:{int(fixed.chunk_size_chars)}:{int(fixed.overlap_chars)}"
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
        ExtractionProjection(extraction_item_id="item", chunk_id="c1", role="primary"),
        ExtractionProjection(extraction_item_id="item", chunk_id="c2"),
    ]
    try:
        assert [
            row.chunk_id for row in pipeline._mention_projections_for("item", "Alice")
        ] == ["c1"]
    finally:
        store.close()


def _session_messages_and_units():
    """Two messages that fall into one session slice, plus their units."""
    messages = [
        Chunk(
            id="m1",
            content="[群聊] 张三\nThe launch date is confirmed",
            source_type="message",
            timestamp=1,
            metadata={"conversation_id": "conv", "sender": "张三"},
        ),
        Chunk(
            id="m2",
            content="[群聊] Alice\nWe should double-check the budget",
            source_type="message",
            timestamp=2,
            metadata={"conversation_id": "conv", "sender": "Alice"},
        ),
    ]
    units = [
        SourceUnit(
            source_id="ding",
            source_type="message",
            unit_id=message.id,
            content_hash=hashlib.sha256(message.content.encode()).hexdigest(),
            timestamp=message.timestamp,
        )
        for message in messages
    ]
    return messages, units


def test_session_chunk_combo_extracts_whole_slices_and_validates():
    messages, units = _session_messages_and_units()
    strategy = ComposedStrategy(SessionChunking(), StoredChunkExtraction())

    plan = strategy.plan(messages, units, source_id="ding")

    # One extraction item per stored session slice, not per message.
    assert len(plan.extraction_items) == len(plan.chunks)
    # Whole-chunk extraction leaves per-unit attribution undefined.
    assert all(item.source_unit_id is None for item in plan.extraction_items)
    # Exactly one primary projection per item; validate() already ran in plan().
    for item in plan.extraction_items:
        primaries = [
            row
            for row in plan.projections
            if row.extraction_item_id == item.id and row.role == "primary"
        ]
        assert len(primaries) == 1
    # chunk_units still carry per-message memberships (the recall unit is stable).
    membership_units = {row.unit_id for row in plan.chunk_units}
    assert membership_units == {"m1", "m2"}


def test_session_chunk_uses_stored_chunk_extractor_for_chat():
    messages, units = _session_messages_and_units()
    strategy = ComposedStrategy(SessionChunking(), StoredChunkExtraction())

    plan = strategy.plan(messages, units, source_id="ding")

    for item in plan.extraction_items:
        assert item.strategy_version.startswith("stored-chunk-v1:")
        assert item.metadata.get("extraction_strategy") == "stored_chunk"


def test_forbidden_combos_fail_fast(monkeypatch):
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies,
        "message",
        {"name": "chat_processing", "chunking": "fixed_size", "extraction": "chunk"},
    )
    with pytest.raises(ValueError, match="fixed_size"):
        source_strategy_for("message")


@pytest.mark.parametrize(
    ("legacy_name", "chunker_type", "extractor_type"),
    [
        ("chat_message", SessionChunking, MessageExtraction),
        ("fixed_size_chat", FixedSizeChunking, MessageExtraction),
        ("document_chunk", NoneChunking, DocumentChunkExtraction),
        ("stored_chunk", NoneChunking, StoredChunkExtraction),
    ],
)
def test_legacy_string_resolution(
    monkeypatch, legacy_name, chunker_type, extractor_type
):
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies, "message", legacy_name
    )
    strategy = source_strategy_for("message")
    assert isinstance(strategy, ComposedStrategy)
    assert isinstance(strategy.chunker, chunker_type)
    assert isinstance(strategy.extractor, extractor_type)


def test_nested_spec_selects_session_chunk_combo(monkeypatch):
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies,
        "message",
        {"name": "chat_processing", "chunking": "session", "extraction": "chunk"},
    )
    strategy = source_strategy_for("message")
    assert isinstance(strategy.chunker, SessionChunking)
    assert isinstance(strategy.extractor, StoredChunkExtraction)


def test_preset_dict_form_resolves_like_bare_string(monkeypatch):
    """``{name: <preset>}`` is equivalent to the bare preset string."""
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies,
        "wiki",
        {"name": "stored_chunk"},
    )
    strategy = source_strategy_for("wiki")
    assert isinstance(strategy.chunker, NoneChunking)
    assert isinstance(strategy.extractor, StoredChunkExtraction)


def test_default_chat_resolution_preserves_message_cache_version(monkeypatch):
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies, "message", "chat_message"
    )
    strategy = source_strategy_for("message")
    # The per-item strategy_version stamp is the extraction-cache key. Keeping it
    # equal to the historical constant means no forced LLM re-extraction.
    assert strategy.extractor.version == "session-chat-v3"


def _document_record_and_unit(source_type: str = "wiki"):
    record = Chunk(
        id="w1",
        content="The migration plan ships in Q3 with a staged rollout.",
        source_type=source_type,
        timestamp=7,
        metadata={"title": "Migration plan", "conversation_id": "doc"},
    )
    unit = SourceUnit(
        source_id="ding",
        source_type=source_type,
        unit_id="w1",
        content_hash=hashlib.sha256(record.content.encode()).hexdigest(),
        timestamp=7,
    )
    return record, unit


def test_document_chunk_golden_plan_is_byte_stable():
    """Whole legacy ``document_chunk`` plan, not just its version string.

    Locks the complete shape a document source produced before the two-axis
    refactor: one stored chunk, one extraction item with the deterministic id,
    the title-context wrapper, the ``document-chunk-v1:<source_type>`` stamp,
    ``source_unit_id`` NULL, and a single primary projection onto the chunk.
    """
    from kl_graph.ingest.source_strategy import _stable_item_id

    record, unit = _document_record_and_unit("wiki")
    strategy = ComposedStrategy(NoneChunking(), DocumentChunkExtraction())

    plan = strategy.plan([record], [unit], source_id="ding")

    assert [chunk.id for chunk in plan.chunks] == ["ding:w1"]
    assert len(plan.extraction_items) == 1
    item = plan.extraction_items[0]
    assert item.id == _stable_item_id("ding", "wiki", "stored-chunk", "ding:w1")
    assert item.content == record.content
    assert item.context == "Document title: Migration plan"
    assert item.strategy_version == "document-chunk-v1:wiki"
    assert item.source_unit_id is None
    assert item.metadata.get("extraction_strategy") == "document_chunk"
    assert [(row.chunk_id, row.role) for row in plan.projections] == [
        ("ding:w1", "primary")
    ]
    # Plan-level strategy_version now records the composed pair. It is stored for
    # provenance only and is NEVER a cache key (the per-item strategy_version
    # above is), so this string may change without forcing re-extraction; lock it
    # here so any change is a deliberate, reviewed edit rather than a silent drift.
    assert (
        plan.strategy_version
        == "composed-v1:stored-source-v1+chunk-extraction-document-v1"
    )


def test_stored_chunk_golden_plan_differs_from_document():
    """Legacy ``stored_chunk`` keeps the verbatim body and the stored fingerprint."""
    record, unit = _document_record_and_unit("wiki")
    strategy = ComposedStrategy(NoneChunking(), StoredChunkExtraction())

    plan = strategy.plan([record], [unit], source_id="ding")

    item = plan.extraction_items[0]
    assert item.content == record.content
    assert item.context == ""  # no title wrapper
    assert item.strategy_version == "stored-chunk-v1:wiki"
    assert item.source_unit_id is None
    assert item.metadata.get("extraction_strategy") == "stored_chunk"


def test_custom_stored_chunk_mapping_does_not_regress_to_document(monkeypatch):
    """Regression guard: ``wiki: stored_chunk`` must stay stored, not document.

    Before the fix, ChunkExtraction dispatched on a hard-coded source-type set,
    so a wiki override to ``stored_chunk`` silently used document extraction —
    re-keying the cache and changing context. The extractor is now chosen from
    the configured name.
    """
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies, "wiki", "stored_chunk"
    )
    strategy = source_strategy_for("wiki")
    assert isinstance(strategy.extractor, StoredChunkExtraction)

    record, unit = _document_record_and_unit("wiki")
    item = strategy.plan([record], [unit], source_id="ding").extraction_items[0]
    assert item.strategy_version == "stored-chunk-v1:wiki"
    assert item.context == ""


def test_custom_document_chunk_mapping_uses_document_extraction(monkeypatch):
    """Regression guard: a non-listed source mapped to ``document_chunk`` must
    use document extraction (title context + ``document-chunk-v1:*``)."""
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies, "custom", "document_chunk"
    )
    strategy = source_strategy_for("custom")
    assert isinstance(strategy.extractor, DocumentChunkExtraction)

    record, unit = _document_record_and_unit("custom")
    item = strategy.plan([record], [unit], source_id="ding").extraction_items[0]
    assert item.strategy_version == "document-chunk-v1:custom"
    assert item.context == "Document title: Migration plan"


@pytest.mark.parametrize("chunking", ["session", "fixed_size"])
def test_chat_chunker_rejected_for_non_message_source(monkeypatch, chunking):
    """A chat chunker on a document source would silently extract nothing."""
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies,
        "wiki",
        {"name": "chat_processing", "chunking": chunking, "extraction": "chunk"},
    )
    with pytest.raises(ValueError, match="requires chat messages"):
        source_strategy_for("wiki")


def test_none_message_on_chat_source_extracts_every_message():
    """``none`` + ``message`` is valid on a chat source (regression).

    ``NoneChunking`` stores each record as a retrievable chunk and builds a
    per-message membership, so ``MessageExtraction`` can project message items
    onto those chunks. The stored-chunk id namespacing must not alias the source
    records, or extraction (which reads the original records) would silently
    match nothing.
    """
    messages, units = _session_messages_and_units()
    strategy = ComposedStrategy(NoneChunking(), MessageExtraction())

    plan = strategy.plan(messages, units, source_id="ding")

    # One item per message, each attributed to its source unit and projected.
    assert len(plan.extraction_items) == len(messages)
    assert {item.source_unit_id for item in plan.extraction_items} == {"m1", "m2"}
    assert len(plan.projections) == len(messages)
    assert all(row.role == "primary" for row in plan.projections)
    # Source records keep their un-namespaced ids; only stored chunks are prefixed.
    assert [message.id for message in messages] == ["m1", "m2"]
    assert {chunk.id for chunk in plan.chunks} == {"ding:m1", "ding:m2"}
    # The per-item cache key stays the historical chat constant.
    assert all(
        item.strategy_version == "session-chat-v3" for item in plan.extraction_items
    )


def test_none_message_is_selectable_from_nested_config(monkeypatch):
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies,
        "message",
        {"name": "chat_processing", "chunking": "none", "extraction": "message"},
    )
    strategy = source_strategy_for("message")
    assert isinstance(strategy.chunker, NoneChunking)
    assert isinstance(strategy.extractor, MessageExtraction)


def test_message_extraction_rejected_for_non_message_source(monkeypatch):
    """``message`` extraction on a document source would drop every item."""
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies,
        "wiki",
        {"name": "chat_processing", "chunking": "none", "extraction": "message"},
    )
    with pytest.raises(ValueError, match="message extraction requires chat messages"):
        source_strategy_for("wiki")


def test_document_extraction_reaches_document_extractor_via_preset(monkeypatch):
    """Title-context document extraction is reachable only through the
    ``document_chunk`` preset.

    ``chat_processing`` deliberately exposes just ``message`` | ``chunk`` (the
    latter → plain stored extractor); ``document`` is not one of its axes because
    documents do not route through the chat family. A source mapped to the
    ``document_chunk`` preset (bare string or ``{name: document_chunk}``) gets the
    title wrapper and the ``document-chunk-v1:*`` stamp.
    """
    from kl_graph.config import cfg

    monkeypatch.setitem(
        cfg.pipelines.ingestion.extraction.strategies,
        "custom",
        {"name": "document_chunk"},
    )
    strategy = source_strategy_for("custom")
    assert isinstance(strategy.extractor, DocumentChunkExtraction)

    record, unit = _document_record_and_unit("custom")
    item = strategy.plan([record], [unit], source_id="ding").extraction_items[0]
    assert item.strategy_version == "document-chunk-v1:custom"
    assert item.context == "Document title: Migration plan"


def _multi_session_messages_and_units():
    """Four messages across two sessions of one conversation, plus units.

    The third message carries ``session_start`` (the loader's idle-gap cut), so
    ``SessionChunking`` produces two slices even though the conversation id is
    constant.
    """
    messages = [
        Chunk(
            id="m1",
            content="[群聊] 张三\nThe launch date is confirmed",
            source_type="message",
            timestamp=1,
            metadata={"conversation_id": "conv", "sender": "张三"},
        ),
        Chunk(
            id="m2",
            content="[群聊] Alice\nWe should double-check the budget",
            source_type="message",
            timestamp=2,
            metadata={"conversation_id": "conv", "sender": "Alice"},
        ),
        Chunk(
            id="m3",
            content="[群聊] 张三\nRollout starts next Monday",
            source_type="message",
            timestamp=5000,
            metadata={
                "conversation_id": "conv",
                "sender": "张三",
                "session_start": True,
            },
        ),
        Chunk(
            id="m4",
            content="[群聊] Alice\nI will prepare the checklist",
            source_type="message",
            timestamp=5001,
            metadata={"conversation_id": "conv", "sender": "Alice"},
        ),
    ]
    units = [
        SourceUnit(
            source_id="ding",
            source_type="message",
            unit_id=message.id,
            content_hash=hashlib.sha256(message.content.encode()).hexdigest(),
            timestamp=message.timestamp,
        )
        for message in messages
    ]
    return messages, units


def test_session_chunk_combo_spans_multiple_slices_across_a_session_break():
    """session + chunk over two sessions: one whole-slice item per slice."""
    messages, units = _multi_session_messages_and_units()
    strategy = ComposedStrategy(SessionChunking(), StoredChunkExtraction())

    plan = strategy.plan(messages, units, source_id="ding")

    # Two session slices -> two whole-chunk extraction items.
    assert len(plan.chunks) == 2
    assert [chunk.metadata["session_index"] for chunk in plan.chunks] == [0, 1]
    assert len(plan.extraction_items) == 2
    assert all(item.source_unit_id is None for item in plan.extraction_items)
    # Every message still has a membership row (the recall unit stays stable).
    assert {row.unit_id for row in plan.chunk_units} == {"m1", "m2", "m3", "m4"}
    # Each slice's members map to that slice's chunk only (no cross-session leak).
    memberships_by_chunk: dict[str, set[str]] = {}
    for row in plan.chunk_units:
        memberships_by_chunk.setdefault(row.chunk_id, set()).add(row.unit_id)
    assert sorted(sorted(v) for v in memberships_by_chunk.values()) == [
        ["m1", "m2"],
        ["m3", "m4"],
    ]
    # Exactly one primary projection per item.
    for item in plan.extraction_items:
        primaries = [
            row
            for row in plan.projections
            if row.extraction_item_id == item.id and row.role == "primary"
        ]
        assert len(primaries) == 1


def test_session_chunk_plan_is_deterministic_for_cache_replay():
    """Re-planning the same input yields identical ids + cache fingerprints.

    The extraction cache is keyed on ``(item.id, model|prompt_version|
    strategy_version|schema_version)``. Stable item ids and per-item
    ``strategy_version`` across re-plans mean a resume / re-ingest replays cached
    LLM results instead of forcing re-extraction.
    """
    messages, units = _multi_session_messages_and_units()
    strategy = ComposedStrategy(SessionChunking(), StoredChunkExtraction())

    first = strategy.plan(messages, units, source_id="ding")
    # Fresh records (a second ingest pass sees new Chunk objects) must not change ids.
    messages2, units2 = _multi_session_messages_and_units()
    second = strategy.plan(messages2, units2, source_id="ding")

    assert [chunk.id for chunk in first.chunks] == [chunk.id for chunk in second.chunks]
    assert [item.id for item in first.extraction_items] == [
        item.id for item in second.extraction_items
    ]
    assert [
        (item.strategy_version, item.prompt_version) for item in first.extraction_items
    ] == [
        (item.strategy_version, item.prompt_version) for item in second.extraction_items
    ]


def test_session_chunk_plan_round_trips_through_the_store(tmp_path):
    """session + chunk plan persists and reloads the same items/projections.

    Exercises the resume path: persist the plan, then read the batch's
    extraction plan back and confirm the whole-slice items and their primary
    projections survive intact.
    """
    messages, units = _multi_session_messages_and_units()
    strategy = ComposedStrategy(SessionChunking(), StoredChunkExtraction())
    plan = strategy.plan(messages, units, source_id="ding")

    store = SQLiteStore(tmp_path / "knowledge.db")
    try:
        store.insert_chunks_with_units(
            plan.chunks,
            units,
            plan.chunk_units,
            plan.extraction_items,
            plan.projections,
            batch_id="batch",
            batch_source_id="ding",
            source_hash="source-hash",
        )
        items, projections = store.get_ingest_batch_extraction_plan("batch")
        assert len(items) == len(plan.extraction_items)
        assert {item.id for item in items} == {
            item.id for item in plan.extraction_items
        }
        assert all(item.source_unit_id is None for item in items)
        assert projections == plan.projections
    finally:
        store.close()
