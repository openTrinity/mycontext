"""Tests for the chat session-slice chunker (kl_graph/ingest/session_chunker.py).

Pure-logic: build ``Chunk`` objects mimicking the loader output and assert the
session/slice transform, the no-fragment guarantee, the HeaderSpec protocol,
the provenance metadata contract the pipeline consumes, and deterministic ids.

Run: python3 -m pytest tests/test_session_chunker.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from kl_graph.ingest.loaders.base import SESSION_BREAK_MARKER
from kl_graph.ingest.pipeline import build_chat_edges
from kl_graph.ingest.session_chunker import (
    slice_chat_sessions,
    split_header_body,
    split_messages,
    strip_headers,
)
from kl_graph.models.types import Chunk, EdgeType


def _msg(
    mid: str,
    body: str,
    *,
    conv: str,
    sender: str,
    ts: int,
    kind: str = "group",
    title: str = "群A",
    reply_to: str | None = None,
    session_start: bool = False,
) -> Chunk:
    """Build a loader-style rendered chat Chunk (header line + body)."""
    header = f"[群聊: {title}] {sender}" if kind == "group" else f"[私聊] {sender} → {title}"
    content = f"{header}\n{body}"
    if session_start:
        content = f"{SESSION_BREAK_MARKER}\n{content}"
    meta = {
        "conversation_id": conv,
        "sender": sender,
        "sender_id": f"{sender}-id",
        "reply_to": reply_to,
        "conversation_title": title,
        "chat_kind": kind,
    }
    if session_start:
        meta["session_start"] = True
    return Chunk(id=mid, content=content, source_type="message", timestamp=ts, metadata=meta)


def test_empty() -> None:
    assert slice_chat_sessions([]) == []


def test_two_conversations_split_into_separate_sessions() -> None:
    msgs = [
        _msg("a1", "hi", conv="A", sender="X", ts=1),
        _msg("a2", "there", conv="A", sender="Y", ts=2),
        _msg("b1", "other", conv="B", sender="Z", ts=3),
    ]
    slices = slice_chat_sessions(msgs)
    # Two conversations -> at least two slices, none mixing conversations.
    convs = {s.metadata["conversation_id"] for s in slices}
    assert convs == {"A", "B"}
    for s in slices:
        # every member id belongs to one conversation's messages
        assert s.metadata["member_message_ids"]


def test_session_start_flag_splits_one_conversation() -> None:
    msgs = [
        _msg("a1", "morning", conv="A", sender="X", ts=1),
        _msg("a2", "afternoon", conv="A", sender="X", ts=2, session_start=True),
    ]
    slices = slice_chat_sessions(msgs)
    assert len(slices) == 2, [s.metadata for s in slices]
    assert slices[0].metadata["session_index"] == 0
    assert slices[1].metadata["session_index"] == 1
    # session_start marks the first slice of each session
    assert slices[0].metadata.get("session_start") is True
    assert slices[1].metadata.get("session_start") is True


def test_short_session_is_one_slice_with_all_provenance() -> None:
    msgs = [
        _msg("a1", "hello", conv="A", sender="X", ts=1),
        _msg("a2", "hi", conv="A", sender="Y", ts=2, reply_to="a1"),
        _msg("a3", "yo", conv="A", sender="X", ts=3),
    ]
    slices = slice_chat_sessions(msgs, chunk_token_num=1024)
    assert len(slices) == 1
    s = slices[0]
    assert s.metadata["member_message_ids"] == ["a1", "a2", "a3"]
    # distinct senders in first-seen order
    assert s.metadata["senders"] == ["X", "Y"]
    assert s.metadata["reply_to_message_ids"] == ["a1"]
    # first member's timestamp
    assert s.timestamp == 1
    # conversation display context carried through
    assert s.metadata["conversation_title"] == "群A"
    assert s.metadata["chat_kind"] == "group"


def test_oversized_session_splits_into_multiple_slices() -> None:
    # Many small messages whose combined tokens exceed a tiny budget.
    msgs = [
        _msg(f"m{i}", f"这是第{i}条消息的内容。", conv="A", sender="X", ts=i)
        for i in range(40)
    ]
    slices = slice_chat_sessions(msgs, chunk_token_num=32)
    assert len(slices) > 1, "oversized session must split into multiple slices"
    # every slice still starts with a header line
    for s in slices:
        assert s.content.startswith("[群聊"), s.content[:40]
    # slice_index is 0-based and contiguous within the (single) session
    idxs = [s.metadata["slice_index"] for s in slices]
    assert idxs == list(range(len(slices)))


def test_oversized_single_message_becomes_continuation_chunks() -> None:
    """A single message exceeding the token budget is split into continuations.

    The content is preserved losslessly across continuation chunks, each
    marked with CONTINUATION_MARK (e.g. [续 2/N]).
    """
    big_body = "。".join(f"句子{i}内容较长需要切分" for i in range(200)) + "。"
    msgs = [_msg("big", big_body, conv="A", sender="讲者", ts=1, title="风险群")]
    slices = slice_chat_sessions(msgs, chunk_token_num=48)
    # Should produce multiple continuation chunks
    assert len(slices) > 1, f"expected multiple continuation chunks, got {len(slices)}"
    # All slices share the same message_id
    for s in slices:
        assert s.metadata["member_message_ids"] == ["big"]
        assert s.metadata["senders"] == ["讲者"]
    # First slice has the original header, subsequent ones have continuation mark
    assert slices[0].content.startswith("[群聊:")
    assert slices[1].content.startswith("[续 2/")
    # Full body is recoverable by concatenating all slices' bodies
    assert any("[续" in s.content for s in slices[1:])


def test_oversized_message_does_not_block_subsequent_packing() -> None:
    """An oversized message emits continuation chunks, then packing resumes."""
    big_body = "。".join(f"句子{i}内容较长" for i in range(200)) + "。"
    msgs = [
        _msg("m1", "small msg before", conv="A", sender="X", ts=1),
        _msg("big", big_body, conv="A", sender="Y", ts=2),
        _msg("m3", "small msg after", conv="A", sender="X", ts=3),
    ]
    slices = slice_chat_sessions(msgs, chunk_token_num=48)
    # The big message produces multiple continuation chunks
    big_slices = [s for s in slices if "big" in s.metadata["member_message_ids"]]
    assert len(big_slices) > 1, "oversized message should produce continuation chunks"
    # All continuation chunks reference the same original message
    for s in big_slices:
        assert s.metadata["member_message_ids"] == ["big"]
    # Small messages before/after are packed separately
    m1_slices = [s for s in slices if "m1" in s.metadata["member_message_ids"]]
    m3_slices = [s for s in slices if "m3" in s.metadata["member_message_ids"]]
    assert len(m1_slices) >= 1
    assert len(m3_slices) >= 1
    # No slice mixes big with small messages
    for s in big_slices:
        assert s.metadata["member_message_ids"] == ["big"]


def test_split_messages_round_trip() -> None:
    """split_messages(chunk.content) recovers the same number of messages."""
    msgs = [
        _msg("a1", "hello world", conv="A", sender="X", ts=1),
        _msg("a2", "how are you?", conv="A", sender="Y", ts=2, reply_to="a1"),
        _msg("a3", "fine thanks", conv="A", sender="X", ts=3),
    ]
    slices = slice_chat_sessions(msgs, chunk_token_num=1024)
    assert len(slices) == 1
    s = slices[0]
    recovered = split_messages(s.content)
    assert len(recovered) == len(s.metadata["member_message_ids"])
    # Each recovered message starts with its header
    for msg in recovered:
        assert msg.startswith("[群聊"), msg[:40]


def test_split_messages_with_blank_lines_in_body() -> None:
    """Messages containing internal blank lines are recovered correctly."""
    body_with_blanks = "first paragraph\n\nsecond paragraph\n\nthird"
    msgs = [
        _msg("a1", body_with_blanks, conv="A", sender="X", ts=1),
        _msg("a2", "simple", conv="A", sender="Y", ts=2),
    ]
    slices = slice_chat_sessions(msgs, chunk_token_num=1024)
    assert len(slices) == 1
    recovered = split_messages(slices[0].content)
    assert len(recovered) == 2
    # The first message's body contains the blank lines
    assert "first paragraph\n\nsecond paragraph" in recovered[0]


def test_split_header_body_group_chat() -> None:
    content = "[群聊: 群A] X\nhello world"
    header, body = split_header_body(content)
    assert header == "[群聊: 群A] X"
    assert body == "hello world"


def test_split_header_body_private_chat() -> None:
    content = "[私聊] 甲 → 乙\nhello"
    header, body = split_header_body(content)
    assert header == "[私聊] 甲 → 乙"
    assert body == "hello"


def test_split_header_body_with_reply() -> None:
    content = "[私聊] 甲 → 乙\n↳ 回复 乙：之前的话\n实际消息内容"
    header, body = split_header_body(content)
    assert header == "[私聊] 甲 → 乙\n↳ 回复 乙：之前的话"
    assert body == "实际消息内容"


def test_split_header_body_no_header() -> None:
    """Content without recognized header pattern returns empty header."""
    content = "just plain text"
    header, body = split_header_body(content)
    assert header == ""
    assert body == "just plain text"


def test_strip_headers() -> None:
    content = "[群聊: 群A] X\nhello world"
    assert strip_headers(content) == "hello world"


def test_strip_headers_with_reply() -> None:
    content = "[私聊] 甲 → 乙\n↳ 回复 乙：之前的话\n实际消息内容"
    assert strip_headers(content) == "实际消息内容"


def test_strip_headers_multiline_body() -> None:
    content = "[群聊: 群A] X\nline1\nline2\nline3"
    assert strip_headers(content) == "line1\nline2\nline3"


def test_deterministic_ids() -> None:
    msgs = [
        _msg("a1", "hello", conv="A", sender="X", ts=1),
        _msg("a2", "world", conv="A", sender="Y", ts=2),
    ]
    first = slice_chat_sessions(msgs)
    second = slice_chat_sessions(msgs)
    assert [s.id for s in first] == [s.id for s in second]


def test_different_inputs_yield_different_ids() -> None:
    a = slice_chat_sessions([_msg("a1", "hi", conv="A", sender="X", ts=1)])
    b = slice_chat_sessions([_msg("b1", "hi", conv="B", sender="X", ts=1)])
    assert a[0].id != b[0].id


def test_session_break_marker_is_stripped() -> None:
    msgs = [
        _msg("a1", "first", conv="A", sender="X", ts=1),
        _msg("a2", "second", conv="A", sender="X", ts=2, session_start=True),
    ]
    slices = slice_chat_sessions(msgs)
    for s in slices:
        assert SESSION_BREAK_MARKER not in s.content, s.content


def test_media_placeholder_preserved_verbatim() -> None:
    msgs = [_msg("a1", "[图片消息]", conv="A", sender="X", ts=1)]
    slices = slice_chat_sessions(msgs)
    assert "[图片消息]" in slices[0].content


def test_at_least_one_message_per_chunk() -> None:
    """Every chunk contains at least one message (no empty chunks)."""
    msgs = [
        _msg(f"m{i}", f"msg content {i}", conv="A", sender="X", ts=i)
        for i in range(20)
    ]
    slices = slice_chat_sessions(msgs, chunk_token_num=32)
    for s in slices:
        assert len(s.metadata["member_message_ids"]) >= 1
        recovered = split_messages(s.content)
        assert len(recovered) >= 1


def test_message_count_matches_member_ids() -> None:
    """split_messages count == member_message_ids count for all slices."""
    msgs = [
        _msg(f"m{i}", f"内容消息 {i} 一些文本", conv="A", sender=f"S{i%3}", ts=i)
        for i in range(15)
    ]
    slices = slice_chat_sessions(msgs, chunk_token_num=64)
    for s in slices:
        recovered = split_messages(s.content)
        assert len(recovered) == len(s.metadata["member_message_ids"]), (
            f"slice {s.id}: {len(recovered)} messages recovered vs "
            f"{len(s.metadata['member_message_ids'])} member_message_ids"
        )


# ─── build_chat_edges: TEMPORAL (C4) + REPLY_TO (C3) over slices ────────────


def _slice(
    sid: str,
    *,
    conv: str,
    session_index: int,
    slice_index: int,
    members: list[str],
    ts: int = 0,
    session_start: bool = False,
    reply_tos: list[str] | None = None,
) -> Chunk:
    """A minimal session-slice chunk (only the metadata build_chat_edges reads)."""
    meta = {
        "conversation_id": conv,
        "session_index": session_index,
        "slice_index": slice_index,
        "member_message_ids": members,
        "reply_to_message_ids": reply_tos or [],
    }
    if session_start:
        meta["session_start"] = True
    return Chunk(id=sid, content="x", source_type="message", timestamp=ts, metadata=meta)


def test_temporal_chains_slices_within_a_session() -> None:
    slices = [
        _slice("s0", conv="A", session_index=0, slice_index=0, members=["m0"], ts=1),
        _slice("s1", conv="A", session_index=0, slice_index=1, members=["m1"], ts=2),
        _slice("s2", conv="A", session_index=0, slice_index=2, members=["m2"], ts=3),
    ]
    edges = build_chat_edges(slices)
    temporal = [(e.source_id, e.target_id) for e in edges if e.edge_type is EdgeType.TEMPORAL]
    assert temporal == [("s0", "s1"), ("s1", "s2")]


def test_temporal_stops_at_session_break() -> None:
    # Two sessions in one conversation: no TEMPORAL edge bridges the break.
    slices = [
        _slice("s0", conv="A", session_index=0, slice_index=0, members=["m0"], ts=1),
        _slice("s1", conv="A", session_index=0, slice_index=1, members=["m1"], ts=2),
        _slice(
            "s2", conv="A", session_index=1, slice_index=0, members=["m2"], ts=9,
            session_start=True,
        ),
        _slice("s3", conv="A", session_index=1, slice_index=1, members=["m3"], ts=10),
    ]
    edges = build_chat_edges(slices)
    temporal = {(e.source_id, e.target_id) for e in edges if e.edge_type is EdgeType.TEMPORAL}
    assert ("s0", "s1") in temporal
    assert ("s2", "s3") in temporal
    # the break: s1 -> s2 must NOT exist
    assert ("s1", "s2") not in temporal


def test_temporal_does_not_cross_conversations() -> None:
    slices = [
        _slice("a0", conv="A", session_index=0, slice_index=0, members=["m0"], ts=1),
        _slice("b0", conv="B", session_index=0, slice_index=0, members=["m1"], ts=2),
    ]
    edges = build_chat_edges(slices)
    assert not [e for e in edges if e.edge_type is EdgeType.TEMPORAL]


def test_reply_to_resolves_quote_to_containing_slice() -> None:
    # s1 quotes m0, which lives in s0 -> REPLY_TO s1 -> s0.
    slices = [
        _slice("s0", conv="A", session_index=0, slice_index=0, members=["m0"], ts=1),
        _slice(
            "s1", conv="A", session_index=0, slice_index=1, members=["m1"], ts=2,
            reply_tos=["m0"],
        ),
    ]
    edges = build_chat_edges(slices)
    reply = [(e.source_id, e.target_id) for e in edges if e.edge_type is EdgeType.REPLY_TO]
    assert reply == [("s1", "s0")]
    for e in edges:
        if e.edge_type is EdgeType.REPLY_TO:
            assert e.source_type == "chunk" and e.target_type == "chunk"


def test_reply_to_dropped_when_quote_not_ingested() -> None:
    # s0 quotes m_missing, absent from the corpus -> no REPLY_TO edge.
    slices = [
        _slice(
            "s0", conv="A", session_index=0, slice_index=0, members=["m0"], ts=1,
            reply_tos=["m_missing"],
        ),
    ]
    edges = build_chat_edges(slices)
    assert not [e for e in edges if e.edge_type is EdgeType.REPLY_TO]


def test_reply_to_self_slice_is_dropped() -> None:
    # A slice that quotes a message it itself contains must not self-edge.
    slices = [
        _slice(
            "s0", conv="A", session_index=0, slice_index=0, members=["m0", "m1"], ts=1,
            reply_tos=["m0"],
        ),
    ]
    edges = build_chat_edges(slices)
    assert not [e for e in edges if e.edge_type is EdgeType.REPLY_TO]
