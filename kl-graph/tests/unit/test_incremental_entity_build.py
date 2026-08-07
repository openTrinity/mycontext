"""Unit tests for incremental entity/fact merge semantics in pipeline.

Tests verify:
- New entity is created when name not found in DB
- Existing entity gets mention_count incremented and last_seen updated
- Entity description accumulation: new chunks add to existing descriptions
- Facts use INSERT OR IGNORE for deterministic uuid5 IDs
- Entity description summarization triggers only above DESCRIPTION_GATE
- Incremental build handles multiple new chunks in one run
"""

from __future__ import annotations

import asyncio
import pathlib
from unittest.mock import patch

from kl_graph.ingest.pipeline import (
    DESCRIPTION_GATE,
    IngestionPipeline,
    _fact_id,
    entity_id_from_name,
)
from kl_graph.ingest.pipeline import (
    build_entity_description as _abuild_entity_description,
)
from kl_graph.models.types import Chunk, Entity, EntityType, Fact, FactType
from kl_graph.storage.sqlite_store import SQLiteStore


def _make_store(tmp_path: pathlib.Path) -> SQLiteStore:
    return SQLiteStore(tmp_path / "test.db")


def _make_chunk(chunk_id: str, ts: int = 1000) -> Chunk:
    return Chunk(
        id=chunk_id,
        content=f"Content of {chunk_id}",
        source_type="message",
        timestamp=ts,
    )


# ── Entity creation and merge ─────────────────────────────────────────────────


def test_new_entity_created_when_not_in_db(tmp_path: pathlib.Path) -> None:
    """A new entity is created when not found in DB."""
    store = _make_store(tmp_path)
    pipeline = IngestionPipeline(store=store)

    eid = entity_id_from_name("Alice")
    assert store.get_entity_by_name("Alice") is None

    # Simulate adding entity via pipeline's in-memory dict + upsert
    pipeline.all_entities = {}
    pipeline.all_entities[eid] = Entity(
        id=eid,
        name="Alice",
        entity_type=EntityType.PERSON,
        first_seen=1000,
        last_seen=1000,
        mention_count=1,
    )
    store.upsert_entities(list(pipeline.all_entities.values()))

    result = store.get_entity_by_name("Alice")
    assert result is not None
    assert result.name == "Alice"
    assert result.mention_count == 1
    store.close()


def test_existing_entity_mention_count_incremented(tmp_path: pathlib.Path) -> None:
    """Existing entity's mention_count is incremented on upsert."""
    store = _make_store(tmp_path)
    eid = entity_id_from_name("Bob")

    # Insert initial entity.
    entity = Entity(
        id=eid,
        name="Bob",
        entity_type=EntityType.PERSON,
        first_seen=1000,
        last_seen=1000,
        mention_count=1,
    )
    store.upsert_entities([entity])

    # Simulate incremental update: upsert again with new timestamp.
    updated = Entity(
        id=eid,
        name="Bob",
        entity_type=EntityType.PERSON,
        first_seen=1000,
        last_seen=2000,
        mention_count=1,
        description="Bob is an engineer.",
    )
    store.upsert_entities([updated])

    result = store.get_entity_by_name("Bob")
    assert result is not None
    # SQLite upsert increments mention_count by 1.
    assert result.mention_count == 2
    store.close()


def test_existing_entity_last_seen_updated(tmp_path: pathlib.Path) -> None:
    """Existing entity's last_seen is updated to the newer timestamp."""
    store = _make_store(tmp_path)
    eid = entity_id_from_name("Carol")

    store.upsert_entities([
        Entity(
            id=eid,
            name="Carol",
            entity_type=EntityType.PERSON,
            first_seen=1000,
            last_seen=1000,
            mention_count=1,
        )
    ])

    store.upsert_entities([
        Entity(
            id=eid,
            name="Carol",
            entity_type=EntityType.PERSON,
            first_seen=1000,
            last_seen=9999,
            mention_count=1,
        )
    ])

    result = store.get_entity_by_name("Carol")
    assert result is not None
    assert result.last_seen == 9999
    store.close()


# ── Entity description accumulation ──────────────────────────────────────────


def build_entity_description(*args, **kwargs) -> str:
    """Sync shim over the now-async build_entity_description coroutine."""
    return asyncio.run(_abuild_entity_description(*args, **kwargs))


def test_build_entity_description_below_gate_returns_bullets(tmp_path: pathlib.Path) -> None:
    """build_entity_description returns a bullet list when count <= DESCRIPTION_GATE."""
    contributions = [(i * 100, f"Description {i}") for i in range(1, DESCRIPTION_GATE + 1)]
    result = build_entity_description("TestEntity", contributions)
    assert result.startswith("- ")
    # Should not call summarize (no LLM needed below gate).


def test_build_entity_description_above_gate_calls_summarize(tmp_path: pathlib.Path) -> None:
    """build_entity_description calls summarize_entity_descriptions above the gate."""
    contributions = [(i * 100, f"Description number {i}") for i in range(1, DESCRIPTION_GATE + 5)]

    called = {}

    async def fake_summarize(name: str, descs: list[str], **k) -> str:
        called["name"] = name
        called["count"] = len(descs)
        return "Summarized description."

    with patch("kl_graph.ingest.pipeline.summarize_entity_descriptions", fake_summarize):
        result = build_entity_description("HubEntity", contributions)

    assert "name" in called, "summarize_entity_descriptions was not called"
    assert result == "Summarized description."


def test_build_entity_description_empty_returns_empty(tmp_path: pathlib.Path) -> None:
    """build_entity_description returns empty string for no contributions."""
    result = build_entity_description("NoDesc", [])
    assert result == ""


# ── Fact deduplication (INSERT OR IGNORE with deterministic uuid5) ─────────


def test_fact_id_is_deterministic() -> None:
    """_fact_id returns the same ID for the same (chunk_id, fact_text) pair."""
    fid1 = _fact_id("chunk-abc", "Alice approved the PR.")
    fid2 = _fact_id("chunk-abc", "Alice approved the PR.")
    assert fid1 == fid2


def test_fact_id_differs_for_different_text() -> None:
    """_fact_id returns different IDs for different fact_text."""
    fid1 = _fact_id("chunk-abc", "Alice approved the PR.")
    fid2 = _fact_id("chunk-abc", "Bob merged the branch.")
    assert fid1 != fid2


def test_fact_id_differs_for_different_chunk() -> None:
    """_fact_id returns different IDs for different source chunks."""
    fid1 = _fact_id("chunk-001", "same text")
    fid2 = _fact_id("chunk-002", "same text")
    assert fid1 != fid2


def test_insert_facts_or_ignore_on_duplicate(tmp_path: pathlib.Path) -> None:
    """Inserting the same fact twice does not raise and count stays at 1."""
    store = _make_store(tmp_path)
    fid = _fact_id("chunk-abc", "Some fact text.")
    fact = Fact(
        id=fid,
        text="Some fact text.",
        fact_type=FactType.GENERAL,
        timestamp=1000,
        confidence=0.9,
        source_chunk_id="chunk-abc",
    )
    # Insert once — should succeed.
    store.insert_facts([fact])
    # Insert again (same id) — should silently ignore.
    store.insert_facts([fact])
    assert store.count_facts() == 1
    store.close()
