"""Tests for the lineage-aware first persona migration milestone."""

from __future__ import annotations

import pytest

from kl_graph.models.types import (
    Chunk,
    ChunkUnit,
    Edge,
    EdgeType,
    Entity,
    EntityType,
    Fact,
    FactType,
    SourceUnit,
)
from kl_graph.persona.cache import PersonaStore
from kl_graph.persona.config import PersonaSettings
from kl_graph.persona.corpus import PersonaCorpusReader
from kl_graph.persona.features import build_all_features
from kl_graph.storage.sqlite_store import SQLiteStore


def _settings(tmp_path) -> PersonaSettings:
    return PersonaSettings(
        enabled=True,
        owner_name="Ego",
        owner_sender_id="ego-id",
        min_messages=2,
        db_path=tmp_path / "persona.db",
    )


def _message_unit(unit_id: str, sender: str, sender_id: str, timestamp: int) -> SourceUnit:
    return SourceUnit(
        "ding",
        "message",
        unit_id,
        f"hash-{unit_id}",
        timestamp=timestamp,
        metadata={
            "sender": sender,
            "sender_id": sender_id,
            "conversation_id": "conversation-1",
        },
    )


def _build_graph(tmp_path) -> SQLiteStore:
    store = SQLiteStore(tmp_path / "knowledge.db")
    units = [
        _message_unit("m1", "Ego", "ego-id", 1_000),
        _message_unit("m2", "Alice", "alice-id", 2_000),
        _message_unit("m3", "Ego", "ego-id", 3_000),
    ]
    targets = [
        "[私聊] Ego → Alice · 2026-01-01 10:00\n你好，可能明天处理。",
        "[私聊] Alice → Ego · 2026-01-01 10:01\n收到",
        "[私聊] Ego → Alice · 2026-01-01 10:02\n请帮我确认 API！",
    ]
    metadata = {
        "member_message_ids": ["m1", "m2", "m3"],
        "extraction_target_contents": targets,
        "conversation_id": "conversation-1",
    }
    chunk = Chunk(
        id="chunk-1",
        content="\n\n".join(targets),
        source_type="message",
        metadata=metadata,
    )
    memberships = [
        ChunkUnit("chunk-1", "ding", "message", unit.unit_id, index, 0)
        for index, unit in enumerate(units)
    ]
    store.insert_chunks_with_units([chunk], units, memberships)
    store.upsert_entities(
        [
            Entity(id="person-alice", name="Alice", entity_type=EntityType.PERSON),
            Entity(id="topic-api", name="API", entity_type=EntityType.SYSTEM),
        ]
    )
    store.insert_facts(
        [
            Fact(
                id="fact-ego",
                text="Ego thinks the API should be checked tomorrow.",
                fact_type=FactType.OPINION,
                timestamp=3_000,
                confidence=0.9,
                source_chunk_id="chunk-1",
                source_unit_id="m3",
            ),
            Fact(
                id="fact-alice",
                text="Alice acknowledged the API work.",
                fact_type=FactType.DECISION,
                timestamp=2_000,
                confidence=0.8,
                source_chunk_id="chunk-1",
                source_unit_id="m2",
            ),
        ]
    )
    store.insert_edges(
        [
            Edge("fact", "fact-ego", "entity", "topic-api", EdgeType.ABOUT),
            Edge("fact", "fact-alice", "entity", "topic-api", EdgeType.ABOUT),
        ]
    )
    return store


def test_reader_reconstructs_units_and_attributes_stance_to_owner(tmp_path) -> None:
    store = _build_graph(tmp_path)
    reader = PersonaCorpusReader(store, _settings(tmp_path))

    messages = reader.messages()
    assert [message.unit_id for message in messages] == ["m1", "m2", "m3"]
    assert messages[0].text == "你好，可能明天处理。"

    corpora = reader.interlocutor_corpora()
    assert len(corpora) == 1
    assert corpora[0].entity_id == "person-alice"
    assert [message.unit_id for message in corpora[0].ego_messages] == ["m1", "m3"]

    facts = reader.stance_facts()
    assert [fact.fact_id for fact in facts] == ["fact-ego"]


def test_reader_deduplicates_a_unit_projected_to_overlapping_chunks(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "knowledge.db")
    unit = _message_unit("m1", "Ego", "ego-id", 1_000)
    target = "[群聊: Test] Ego · 2026-01-01 10:00\n完整消息"
    chunks = [
        Chunk(
            id=f"chunk-{index}",
            content=target,
            metadata={
                "member_message_ids": ["m1"],
                "extraction_target_contents": [target],
            },
        )
        for index in (1, 2)
    ]
    memberships = [
        ChunkUnit(chunk.id, "ding", "message", "m1", 0, index)
        for index, chunk in enumerate(chunks)
    ]
    store.insert_chunks_with_units(chunks, [unit], memberships)

    messages = PersonaCorpusReader(store, _settings(tmp_path)).messages()
    assert len(messages) == 1
    assert messages[0].text == "完整消息"
    assert messages[0].chunk_ids == ("chunk-1", "chunk-2")


def test_layer_a_persists_person_and_topic_features(tmp_path) -> None:
    store = _build_graph(tmp_path)
    settings = _settings(tmp_path)
    reader = PersonaCorpusReader(store, settings)

    with PersonaStore(settings.db_path) as persona_db:
        report = build_all_features(
            reader, persona_db, min_messages=settings.min_messages
        )
        person = persona_db.get_features("person-alice", "person")
        topic = persona_db.get_features("topic-api", "topic")

    assert report == {"interlocutors": 1, "topics": 1}
    assert person is not None
    assert len(person) == 21
    assert person["avg_msg_length"] > 0
    assert topic == {
        "evidence_count": 1,
        "opinion_recency": 3_000,
        "opinion_strength": 0.9,
        "stance_fact_ids": ["fact-ego"],
    }


def test_persona_cache_rejects_a_different_owner(tmp_path) -> None:
    settings = _settings(tmp_path)
    with PersonaStore(settings.db_path) as persona_db:
        persona_db.bind_owner(settings)
        with pytest.raises(ValueError, match="different owner"):
            persona_db.bind_owner(
                PersonaSettings(
                    enabled=True,
                    owner_name="Someone Else",
                    owner_sender_id="other-id",
                    min_messages=2,
                    db_path=settings.db_path,
                )
            )
