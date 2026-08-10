from __future__ import annotations

import asyncio
from types import SimpleNamespace

from kl_graph.ingest import entity_cleanup as cleanup_module
from kl_graph.ingest import extraction_strategy as strategy_module
from kl_graph.ingest.entity_cleanup import (
    apply_cleanup_decisions,
    rank_cleanup_candidates,
    review_cleanup_candidates,
)
from kl_graph.ingest.llm_extractor import _expand_compact_result
from kl_graph.ingest.extraction_cache import ExtractionCacheStore
from kl_graph.ingest.extraction_strategy import ChatMessageExtractionStrategy
from kl_graph.ingest.session_chunker import slice_chat_sessions
from kl_graph.models.types import Chunk, Entity, EntityType, Fact
from kl_graph.storage.sqlite_store import SQLiteStore


def test_chat_items_target_stored_chunk_with_read_only_context(monkeypatch):
    monkeypatch.setattr(
        strategy_module, "split_messages", lambda content, source_type: ["first", "second"]
    )
    chunk = Chunk(
        id="session-1",
        content="rendered session",
        source_type="message",
        metadata={"member_message_ids": ["m1", "m2"]},
    )
    items = ChatMessageExtractionStrategy().build(chunk)
    assert [item.source_unit_id for item in items] == ["m1", "m2"]
    assert {item.target_chunk_id for item in items} == {"session-1"}
    assert items[0].content == "first"
    assert "second" in items[0].context


def test_chat_item_excludes_inlined_quote_from_target(monkeypatch):
    rendered = "[私聊] A → B\n↳ 回复 B：old claim\nI agree"
    target = "[私聊] A → B\nI agree"
    monkeypatch.setattr(
        strategy_module, "split_messages", lambda content, source_type: [rendered]
    )
    chunk = Chunk(
        id="session-quote",
        content=rendered,
        source_type="message",
        metadata={
            "member_message_ids": ["m1"],
            "extraction_target_contents": [target],
            "quoted_contexts": ["↳ 回复 B：old claim"],
        },
    )
    item = ChatMessageExtractionStrategy().build(chunk)[0]
    assert item.content == target
    assert "old claim" not in item.content
    assert "DO NOT RE-EXTRACT" in item.context
    assert "old claim" in item.context


def test_quote_target_metadata_survives_session_chunking():
    rendered = "[私聊] A → B\n↳ 回复 B：old claim\nI agree"
    target = "[私聊] A → B\nI agree"
    message = Chunk(
        id="m1",
        content=rendered,
        source_type="message",
        timestamp=1,
        metadata={
            "conversation_id": "c1",
            "sender": "A",
            "reply_to": "m0",
            "session_start": True,
            "extraction_target_content": target,
            "quoted_context": "↳ 回复 B：old claim",
        },
    )
    stored_chunk = slice_chat_sessions([message])[0]
    item = ChatMessageExtractionStrategy().build(stored_chunk)[0]
    assert stored_chunk.content == rendered
    assert item.content == target
    assert "old claim" in item.context


def test_cache_fingerprint_invalidates_prompt_or_strategy(tmp_path):
    store = ExtractionCacheStore(tmp_path / "cache.db")
    try:
        payload = {"entities": [], "facts": []}
        store.put(payload, "item-1", "model", "prompt-a|strategy-a|schema-1")
        assert store.get("item-1", "model", "prompt-a|strategy-a|schema-1") == payload
        assert store.get("item-1", "model", "prompt-b|strategy-a|schema-1") is None
        assert store.get("item-1", "model", "prompt-a|strategy-b|schema-1") is None
    finally:
        store.close()


def test_mixed_nested_aliases_are_canonicalized_with_english_top_level():
    result = _expand_compact_result(
        {
            "entities": [{"name": "A", "type": "System"}],
            "facts": [{"subject": "A", "content": "A is available", "type": "STATUS"}],
        }
    )
    assert result["entities"][0]["entity_type"] == "System"
    assert result["facts"][0]["subject_entity"] == "A"
    assert result["facts"][0]["fact_text"] == "A is available"


def test_cleanup_heuristics_rank_but_do_not_mutate_without_llm():
    entity = Entity(
        id="e1", name="unknown", entity_type=EntityType.UNKNOWN, mention_count=1
    )
    candidates = rank_cleanup_candidates([entity], [], min_score=0)
    assert candidates and candidates[0].entity_id == "e1"
    assert entity.quality_status == "active"
    apply_cleanup_decisions(
        {entity.id: entity},
        [{"entity_id": "e1", "action": "QUARANTINE", "entity_type": "Unknown"}],
        dry_run=True,
    )
    assert entity.quality_status == "active"
    apply_cleanup_decisions(
        {entity.id: entity},
        [{"entity_id": "e1", "action": "QUARANTINE", "entity_type": "Unknown"}],
        dry_run=False,
    )
    assert entity.quality_status == "quarantined"


def test_cleanup_llm_budget_is_enforced(monkeypatch):
    calls = 0

    async def review(**kwargs):
        nonlocal calls
        calls += 1
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=(
                '{"action":"KEEP","entity_type":"Unknown",'
                '"canonical_name":null,"reason":"grounded"}'
            )))]
        )

    monkeypatch.setattr(cleanup_module.litellm, "acompletion", review)
    entities = [
        Entity(id=f"e{i}", name=f"unknown-{i}", entity_type=EntityType.UNKNOWN)
        for i in range(3)
    ]
    candidates = rank_cleanup_candidates(entities, [], min_score=0)
    decisions = asyncio.run(
        review_cleanup_candidates(candidates, budget=2, dry_run=True)
    )
    assert calls == 2
    assert len(decisions) == 2


def test_cleanup_rejects_non_null_canonical_name(monkeypatch):
    async def invalid_review(**kwargs):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=(
                '{"action":"QUARANTINE","entity_type":"Unknown",'
                '"canonical_name":"renamed","reason":"unsupported rename"}'
            )))]
        )

    monkeypatch.setattr(cleanup_module.litellm, "acompletion", invalid_review)
    candidate = rank_cleanup_candidates(
        [Entity(id="e1", name="unknown", entity_type=EntityType.UNKNOWN)],
        [],
        min_score=0,
    )
    decision = asyncio.run(
        review_cleanup_candidates(candidate, budget=1, dry_run=True)
    )[0]
    assert decision["action"] == "KEEP"
    assert "failed" in decision["reason"]


def test_fact_provenance_and_quarantine_storage(tmp_path):
    store = SQLiteStore(tmp_path / "knowledge.db")
    try:
        entity = Entity(id="e1", name="suspicious", quality_status="quarantined")
        store.upsert_entities([entity])
        assert list(store.iter_all_entities()) == []
        fact = Fact(
            id="f1",
            text="grounded fact",
            source_chunk_id="c1",
            source_unit_id="m1",
            extraction_item_id="c1::message::m1",
        )
        # The FK is not enforced by default, matching existing store behavior.
        store.insert_facts([fact])
        loaded = store.get_fact("f1")
        assert loaded is not None
        assert loaded.source_unit_id == "m1"
        assert loaded.extraction_item_id == "c1::message::m1"
    finally:
        store.close()


def test_cleanup_persistence_does_not_increment_mentions(tmp_path):
    store = SQLiteStore(tmp_path / "knowledge.db")
    try:
        entity = Entity(id="e1", name="entity", mention_count=7)
        store.upsert_entities([entity])
        entity.entity_type = EntityType.SYSTEM
        entity.quality_status = "quarantined"
        store.apply_entity_cleanup([entity])
        row = store.conn.execute(
            "SELECT entity_type, quality_status, mention_count FROM entities WHERE id='e1'"
        ).fetchone()
        assert tuple(row) == ("System", "quarantined", 7)
        store.apply_entity_cleanup([entity])
        count = store.conn.execute(
            "SELECT mention_count FROM entities WHERE id='e1'"
        ).fetchone()[0]
        assert count == 7
    finally:
        store.close()
