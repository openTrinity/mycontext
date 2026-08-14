"""Role-aware REQUEST/ACTION_ITEM persistence and current-user query tests."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

import kl_server
from kl_graph.ingest import llm_extractor
from kl_graph.ingest.pipeline import IngestionPipeline, entity_id_from_name
from kl_graph.models.types import (
    Chunk,
    Entity,
    EntityType,
    ExtractionItem,
    Fact,
    FactType,
)
from kl_graph.storage.sqlite_store import SQLiteStore


def _memory_store() -> SQLiteStore:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    return SQLiteStore(Path(":memory:"), conn=conn)


def test_direct_chat_directive_only_applies_grounding_rules() -> None:
    item = ExtractionItem(
        id="item-1",
        source_type="message",
        content="[私聊] 张三 → 李华\n能把报告发我吗？",
        target_chunk_id="chunk-1",
        metadata={
            "extraction_strategy": "chat_message",
            "sender": "张三",
            "chat_kind": "direct",
            "conversation_title": "张三",
        },
    )

    directive = llm_extractor._strategy_directive(item)

    assert "TARGET CONTENT" in directive
    assert "Context is read-only" in directive
    assert "quoted prior text" in directive
    assert "Chat metadata" not in directive
    assert "configured current user" not in directive


def test_build_facts_persists_requester_and_recipient_ids() -> None:
    store = _memory_store()
    requester_id = entity_id_from_name("张三")
    recipient_id = entity_id_from_name("李华")
    entities = {
        requester_id: Entity(
            id=requester_id, name="张三", entity_type=EntityType.PERSON
        ),
        recipient_id: Entity(
            id=recipient_id, name="李华", entity_type=EntityType.PERSON
        ),
    }
    store.insert_chunks([Chunk(id="chunk-1", content="请求", timestamp=1)])
    store.upsert_entities(list(entities.values()))
    item = ExtractionItem(
        id="item-1",
        source_type="message",
        content="请求",
        target_chunk_id="chunk-1",
        source_unit_id="message-1",
    )
    result = {
        "facts": [
            {
                "subject_entity": "@张三",
                "object_entity": "李华",
                "fact_text": "张三询问李华项目报告是否完成",
                "fact_type": "REQUEST",
                "confidence": 0.95,
            }
        ]
    }

    class _Step:
        skip = False

        def done(self, **_kwargs) -> None:
            pass

    @contextmanager
    def _step(*_args, **_kwargs):
        yield _Step()

    pipeline = object.__new__(IngestionPipeline)
    pipeline.store = store
    pipeline.all_entities = entities
    pipeline.all_facts = []
    pipeline.step = _step
    pipeline._extraction_records = lambda: iter(
        [(item, Chunk(id="chunk-1", content="请求", timestamp=1), result)]
    )

    IngestionPipeline._build_facts(pipeline)

    assert len(pipeline.all_facts) == 1
    fact = pipeline.all_facts[0]
    assert fact.fact_type is FactType.REQUEST
    assert fact.subject_entity_id == requester_id
    assert fact.object_entity_id == recipient_id
    stored = store.get_fact(fact.id)
    assert stored is not None
    assert stored.subject_entity_id == requester_id
    assert stored.object_entity_id == recipient_id
    store.close()


def test_old_facts_table_gets_role_columns_and_request_index() -> None:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.execute(
        """CREATE TABLE facts (
               id TEXT PRIMARY KEY,
               text TEXT NOT NULL,
               fact_type TEXT DEFAULT 'GENERAL',
               timestamp INTEGER DEFAULT 0,
               confidence REAL DEFAULT 0.8,
               source_chunk_id TEXT NOT NULL,
               embedding_id TEXT
           )"""
    )

    store = SQLiteStore(Path(":memory:"), conn=conn)

    columns = {row[1] for row in store.conn.execute("PRAGMA table_info(facts)")}
    indexes = {row[1] for row in store.conn.execute("PRAGMA index_list(facts)")}
    assert {"subject_entity_id", "object_entity_id"} <= columns
    assert "idx_facts_request_recipient" in indexes
    store.close()


def test_requests_endpoint_filters_type_recipient_day_and_self(monkeypatch) -> None:
    store = _memory_store()
    current_user = Entity(
        id="person-me", name="李华", entity_type=EntityType.PERSON
    )
    requester = Entity(
        id="person-zhang", name="张三", entity_type=EntityType.PERSON
    )
    other = Entity(id="person-other", name="王五", entity_type=EntityType.PERSON)
    store.upsert_entities([current_user, requester, other])
    store.insert_chunks([Chunk(id="chunk-1", content="source")])

    timezone = ZoneInfo("Asia/Shanghai")
    in_day = int(datetime(2026, 8, 14, 9, tzinfo=timezone).timestamp() * 1000)
    next_day = int(datetime(2026, 8, 15, 0, tzinfo=timezone).timestamp() * 1000)
    store.insert_facts(
        [
            Fact(
                id="request-hit",
                text="张三询问李华报告是否完成",
                fact_type=FactType.REQUEST,
                timestamp=in_day,
                confidence=0.9,
                subject_entity_id=requester.id,
                object_entity_id=current_user.id,
                source_chunk_id="chunk-1",
                source_unit_id="message-1",
                extraction_item_id="item-1",
            ),
            Fact(
                id="todo-hit",
                text="张三要求李华修改代码、跑通并提交",
                fact_type=FactType.ACTION_ITEM,
                timestamp=in_day,
                confidence=0.95,
                subject_entity_id=requester.id,
                object_entity_id=current_user.id,
                source_chunk_id="chunk-1",
                source_unit_id="message-2",
                extraction_item_id="item-2",
            ),
            Fact(
                id="wrong-type",
                text="张三负责报告",
                fact_type=FactType.DELEGATE,
                timestamp=in_day,
                subject_entity_id=requester.id,
                object_entity_id=current_user.id,
                source_chunk_id="chunk-1",
            ),
            Fact(
                id="wrong-recipient",
                text="张三请求王五发送报告",
                fact_type=FactType.REQUEST,
                timestamp=in_day,
                subject_entity_id=requester.id,
                object_entity_id=other.id,
                source_chunk_id="chunk-1",
            ),
            Fact(
                id="self-request",
                text="李华提醒自己发送报告",
                fact_type=FactType.REQUEST,
                timestamp=in_day,
                subject_entity_id=current_user.id,
                object_entity_id=current_user.id,
                source_chunk_id="chunk-1",
            ),
            Fact(
                id="next-day",
                text="张三请求李华明天发送报告",
                fact_type=FactType.REQUEST,
                timestamp=next_day,
                subject_entity_id=requester.id,
                object_entity_id=current_user.id,
                source_chunk_id="chunk-1",
            ),
        ]
    )

    server_state = kl_server.ServerState()
    server_state.sqlite_conn = store.conn
    server_state.ready = True
    monkeypatch.setattr(kl_server, "state", server_state)
    monkeypatch.setattr(kl_server, "CURRENT_USER", "李华")

    response = TestClient(kl_server.app).post(
        "/requests",
        json={"date": "2026-08-14", "timezone": "Asia/Shanghai"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["current_user"] == {
        "id": "person-me",
        "name": "李华",
        "type": "Person",
    }
    assert payload["count"] == 1
    assert [item["id"] for item in payload["requests"]] == ["request-hit"]
    assert payload["requests"][0]["requester"]["id"] == "person-zhang"
    assert payload["requests"][0]["provenance"] == {
        "source_chunk_id": "chunk-1",
        "source_unit_id": "message-1",
        "extraction_item_id": "item-1",
    }

    response = TestClient(kl_server.app).post(
        "/todos",
        json={"date": "2026-08-14", "timezone": "Asia/Shanghai"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 1
    assert [item["id"] for item in payload["todos"]] == ["todo-hit"]
    assert payload["todos"][0]["type"] == "ACTION_ITEM"
    assert payload["todos"][0]["requester"]["id"] == "person-zhang"
    store.close()


def test_requests_endpoint_requires_configured_current_user(monkeypatch) -> None:
    store = _memory_store()
    server_state = kl_server.ServerState()
    server_state.sqlite_conn = store.conn
    server_state.ready = True
    monkeypatch.setattr(kl_server, "state", server_state)
    monkeypatch.setattr(kl_server, "CURRENT_USER", "")

    response = TestClient(kl_server.app).post(
        "/requests", json={"date": "2026-08-14"}
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "KL_CURRENT_USER is not configured"
    store.close()
