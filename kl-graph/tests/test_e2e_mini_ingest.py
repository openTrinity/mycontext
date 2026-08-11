"""Offline ingestion integration tests over a synthetic DWS export.

Exercises loader rendering, session slicing, source lineage, Scope/PART_OF
projection, TEMPORAL/REPLY_TO edges, and AUTHORED_BY participants without an
LLM, embedding endpoint, external fixture, or private workplace data.
"""

from __future__ import annotations

from collections import Counter
import json
from pathlib import Path

import pytest

from kl_graph.ingest.loaders import load_mail, load_wiki
from kl_graph.ingest.loaders.base import SESSION_GAP_MS
from kl_graph.ingest.loaders.message_loader import load_all_messages
from kl_graph.ingest.pipeline import (
    _is_chat,
    _participants_of,
    build_chat_edges,
    build_scopes_and_part_of,
)
from kl_graph.ingest.session_chunker import slice_chat_sessions
from kl_graph.models.types import EdgeType


def _write_source(
    root: Path,
    name: str,
    *,
    records: list[dict],
    scopes: list[dict],
) -> None:
    source = root / name
    source.mkdir(parents=True)
    for filename, rows in (
        ("records.jsonl", records),
        ("scopes.jsonl", scopes),
        ("resources.jsonl", []),
    ):
        (source / filename).write_text(
            "".join(f"{json.dumps(row, ensure_ascii=False)}\n" for row in rows),
            encoding="utf-8",
        )
    (source / "manifest.json").write_text("{}", encoding="utf-8")


@pytest.fixture(scope="module")
def mini_export(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Create an anonymized export with sessions, replies, wiki, and mail."""
    root = tmp_path_factory.mktemp("mini-dws-export")
    base_ts = 1_700_000_000_000
    chat_records: list[dict] = []
    for index in range(8):
        message_id = f"message-{index + 1}"
        chat_records.append(
            {
                "id": f"record-{message_id}",
                "scope_id": "chat:synthetic-team",
                "type": "message",
                "data": {
                    "openMessageId": message_id,
                    "openConversationId": "conversation-synthetic",
                    "sender": "User A" if index % 2 == 0 else "User B",
                    "senderOpenDingTalkId": f"synthetic-user-{index % 2}",
                    "content": f"Synthetic update {index + 1}: " + "detail " * 180,
                    "createTime": base_ts + index * 60_000,
                },
            }
        )
    prior = chat_records[0]["data"]
    chat_records.append(
        {
            "id": "record-message-9",
            "scope_id": "chat:synthetic-team",
            "type": "message",
            "data": {
                "openMessageId": "message-9",
                "openConversationId": "conversation-synthetic",
                "sender": "User C",
                "senderOpenDingTalkId": "synthetic-user-2",
                "content": "Synthetic follow-up after the session break.",
                "createTime": base_ts + 7 * 60_000 + SESSION_GAP_MS,
                "quotedMessage": {
                    "openMessageId": prior["openMessageId"],
                    "sender": prior["sender"],
                    "content": prior["content"],
                },
            },
        }
    )
    _write_source(
        root,
        "chat",
        records=chat_records,
        scopes=[
            {
                "id": "chat:synthetic-team",
                "type": "chat",
                "parent_id": None,
                "data": {"title": "Synthetic Team", "chat_kind": "group"},
            }
        ],
    )
    _write_source(
        root,
        "wiki",
        records=[
            {
                "id": "wiki-unit-1",
                "scope_id": "document:wiki/doc-1",
                "type": "document_unit",
                "data": {
                    "text": "# Synthetic Guide\n\nA deterministic test document.",
                    "docUrl": "https://example.invalid/doc-1",
                },
            }
        ],
        scopes=[
            {
                "id": "document:wiki/doc-1",
                "type": "document",
                "parent_id": None,
                "data": {
                    "node": {"nodeId": "doc-1", "name": "Synthetic Guide"}
                },
            }
        ],
    )
    _write_source(
        root,
        "mail",
        records=[
            {
                "id": "mail-record-1",
                "scope_id": "mail-thread-1",
                "type": "email",
                "data": {
                    "messageId": "mail-1",
                    "body": {
                        "id": "mail-1",
                        "conversationId": "mail-thread-1",
                        "subject": "Synthetic status",
                        "markdownBody": "A deterministic test email.",
                        "from": {
                            "name": "User A",
                            "email": "a@example.invalid",
                        },
                        "toRecipients": [
                            {"name": "User B", "email": "b@example.invalid"}
                        ],
                        "ccRecipients": [
                            {"name": "User C", "email": "c@example.invalid"}
                        ],
                        "receivedDateTime": "2026-01-01T00:00:00+08:00",
                    },
                },
            }
        ],
        scopes=[
            {
                "id": "mail-thread-1",
                "type": "mail_thread",
                "parent_id": None,
                "data": {"title": "Synthetic status"},
            }
        ],
    )
    return root


@pytest.fixture(scope="module")
def slices(mini_export: Path):
    """Return session slices produced from the synthetic chat export."""
    return slice_chat_sessions(load_all_messages(mini_export / "chat"))


def test_loader_renders_headers_and_marks_sessions(mini_export: Path) -> None:
    msgs = load_all_messages(mini_export / "chat")
    assert msgs
    for message in msgs:
        lines = message.content.lstrip().splitlines()
        first = lines[1] if lines and lines[0] == "SESSION_BREAK" else lines[0]
        assert first.startswith(("[群聊", "[私聊")), message.content[:40]
    assert any(message.metadata.get("session_start") for message in msgs)


def test_slices_are_fewer_than_messages_and_traceable(
    slices, mini_export: Path
) -> None:
    msgs = load_all_messages(mini_export / "chat")
    assert 0 < len(slices) <= len(msgs), (len(slices), len(msgs))
    member_ids = {
        member_id
        for session_slice in slices
        for member_id in session_slice.metadata["member_message_ids"]
    }
    assert member_ids == {message.id for message in msgs}


def test_every_slice_starts_with_a_header(slices) -> None:
    for session_slice in slices:
        assert session_slice.content.lstrip().startswith(("[群聊", "[私聊"))


def test_slice_ids_are_deterministic(slices, mini_export: Path) -> None:
    again = slice_chat_sessions(load_all_messages(mini_export / "chat"))
    assert [session_slice.id for session_slice in slices] == [
        session_slice.id for session_slice in again
    ]
    assert len({session_slice.id for session_slice in slices}) == len(slices)


def test_session_marker_stripped_from_content(slices) -> None:
    assert all("SESSION_BREAK" not in session_slice.content for session_slice in slices)


def test_authored_by_participants_are_distinct_senders(slices) -> None:
    for session_slice in slices:
        participants = _participants_of(session_slice)
        assert participants == session_slice.metadata["senders"]
        assert len(participants) == len(set(participants))
        assert _is_chat(session_slice)


def test_temporal_edges_stay_within_sessions(slices) -> None:
    edges = build_chat_edges(slices)
    temporal = [edge for edge in edges if edge.edge_type is EdgeType.TEMPORAL]
    assert temporal, "fixture should produce multiple slices in one session"
    id_to_slice = {session_slice.id: session_slice for session_slice in slices}
    for edge in temporal:
        source = id_to_slice[edge.source_id]
        target = id_to_slice[edge.target_id]
        assert edge.source_type == "chunk" and edge.target_type == "chunk"
        assert source.metadata["session_index"] == target.metadata["session_index"]
        assert not target.metadata.get("session_start")


def test_reply_to_edges_are_cross_slice(slices) -> None:
    reply_edges = [
        edge for edge in build_chat_edges(slices) if edge.edge_type is EdgeType.REPLY_TO
    ]
    assert reply_edges, "fixture should produce a cross-session quoted reply"
    for edge in reply_edges:
        assert edge.source_id != edge.target_id
        assert edge.source_type == "chunk" and edge.target_type == "chunk"


def test_scopes_and_part_of_across_all_sources(
    slices, mini_export: Path
) -> None:
    wiki = load_wiki(mini_export / "wiki")
    mail = load_mail(mini_export / "mail")
    all_chunks = [*slices, *wiki, *mail]
    scopes, part_of = build_scopes_and_part_of(all_chunks)

    assert len(part_of) == len(all_chunks)
    scope_ids = {scope.id for scope in scopes}
    for edge in part_of:
        assert edge.edge_type is EdgeType.PART_OF
        assert edge.source_type == "chunk" and edge.target_type == "scope"
        assert edge.target_id in scope_ids

    kinds = Counter(scope.scope_type for scope in scopes)
    assert kinds["conversation"] >= 1
    assert kinds["document"] >= 1
    assert kinds["mail_thread"] >= 1


def test_non_chat_chunks_are_not_chat(slices, mini_export: Path) -> None:
    wiki = load_wiki(mini_export / "wiki")
    mail = load_mail(mini_export / "mail")
    for chunk in [*wiki, *mail]:
        assert not _is_chat(chunk)
        assert "senders" not in chunk.metadata
