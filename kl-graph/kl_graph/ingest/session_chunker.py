"""Turn the loader's per-message chat chunks into session-slice chunks.

**No-fragment guarantee:** A single message is never split across multiple
chunks. Each session-slice chunk contains one or more complete messages.
**Oversized messages** (exceeding the token budget on their own) are split into
continuation chunks with an explicit ``CONTINUATION_MARK`` (e.g. ``[续 2/3]``)
so the full content is preserved losslessly; the split happens at paragraph or
line boundaries when possible. Downstream consumers can recover individual
messages from a chunk via :func:`split_messages`.

This is the chat *chunk unit* transform: the loader
(:func:`kl_graph.ingest.loaders.message_loader.load_all_messages`) emits one
rendered :class:`~kl_graph.models.types.Chunk` per message, grouped by
conversation and sorted by time, with a ``SESSION_BREAK`` marker prefixed onto
the first message after a long idle gap. This module consumes that stream and
produces the *new* chat chunk unit: a **session slice**.

The pipeline is deliberately ordered (design decision, R3/R4 + C-series):

1. **Render first** — already done by the loader (direction header + inlined
   quote as the leading line(s), body beneath).
2. **Time-sessionize** — a run of contiguous same-conversation messages with no
   ``session_start`` break is one session (the idle-gap cut is the hard, primary
   boundary).
3. **Greedy no-fragment pack** — messages are packed greedily under the token
   budget. A message is the atomic unit: never split, always complete.

**Message Header Protocol:** Headers are identified by a registered
:class:`HeaderSpec` per source type. This allows future data sources (mail,
WeCom, Slack, etc.) to register their own header format without modifying the
parser. The ``"message"`` source type recognizes DingTalk chat headers
(``[私聊 ...]`` / ``[群聊: ...]``) and the optional reply line (``↳ 回复 ...``).

Pure functions, no I/O, so the whole transform is unit-testable without a
corpus. The emitted ``metadata`` is the provenance/tracing contract the pipeline
consumes to re-key extraction, facts, embeddings, and the chat edges
(``member_message_ids`` for traceback, ``senders`` for ``AUTHORED_BY``,
``reply_to_message_ids`` for ``REPLY_TO``, ``session_start`` for the
``TEMPORAL`` chain that must stop at a session break).
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass

from kl_graph.ingest.chunker import (
    DEFAULT_CHUNK_TOKEN_NUM,
    num_tokens_from_string,
)
from kl_graph.ingest.loaders.base import SESSION_BREAK_MARKER
from kl_graph.models.types import Chunk

# ---------------------------------------------------------------------------
# Message Header Protocol
# ---------------------------------------------------------------------------


@dataclass
class HeaderSpec:
    """Defines how to detect and parse message headers for a source type.

    Attributes:
        start_pattern: Compiled regex that matches the start of a message header
            line. Must match from the beginning of a line.
        continuation_prefix: Optional prefix for continuation header lines (e.g.,
            ``"↳"`` for the reply line in DingTalk chat). Lines after the first
            header line that start with this prefix are also considered header.
        max_header_lines: Maximum number of consecutive header lines (e.g., 2
            for chat: direction line + optional reply line).
    """

    start_pattern: re.Pattern[str]
    continuation_prefix: str = ""
    max_header_lines: int = 2


# Registry: source_type → HeaderSpec (extensible for future loaders)
HEADER_SPECS: dict[str, HeaderSpec] = {
    "message": HeaderSpec(
        start_pattern=re.compile(r"^\[(?:私聊|群聊)"),
        continuation_prefix="↳",
        max_header_lines=2,  # [私聊/群聊...] + optional ↳ 回复
    ),
    # Future: mail, wiki, etc. can register their own patterns
    # "mail": HeaderSpec(start_pattern=re.compile(r"^\[邮件\]"), max_header_lines=3),
}

# Fallback for unknown source types: no header detection (entire content is body)
DEFAULT_HEADER_SPEC = HeaderSpec(
    start_pattern=re.compile(r"(?!x)x"),  # matches nothing
    max_header_lines=0,
)

# A message body is joined to the next member's block with a blank line so the
# packed slice stays readable and the per-message headers keep visual separation.
MESSAGE_JOIN = "\n\n"

# Continuation marker format for oversized messages that are split across chunks.
# "{part}" and "{total}" are filled in. Appears as a leading line on continuation
# chunks so both human readers and LLM extractors know this is a continuation.
CONTINUATION_MARK = "[续 {part}/{total}]"


# ---------------------------------------------------------------------------
# Public API: parsing utilities
# ---------------------------------------------------------------------------


def split_messages(chunk_content: str, source_type: str = "message") -> list[str]:
    """Split a session-slice chunk into individual rendered messages.

    Each returned string is one complete message: header line(s) + body.
    Uses the registered :class:`HeaderSpec` for the *source_type* to identify
    where each message begins (by its header pattern at the start of a line).

    With the no-fragment guarantee, the number of returned messages equals
    ``len(chunk.metadata["member_message_ids"])``.
    """
    spec = HEADER_SPECS.get(source_type, DEFAULT_HEADER_SPEC)
    # Split on zero-width lookahead where a line starts with the header pattern.
    # The (?m) flag makes ^ match at the start of every line.
    parts = re.split(
        f"(?m)(?=^(?:{spec.start_pattern.pattern}))",
        chunk_content,
    )
    return [p.strip() for p in parts if p.strip()]


def split_header_body(content: str, source_type: str = "message") -> tuple[str, str]:
    """Split a rendered message into (header_lines, body).

    Header: leading lines matching the source's :class:`HeaderSpec`.
    Body: everything after (may contain newlines, including blank lines).
    """
    spec = HEADER_SPECS.get(source_type, DEFAULT_HEADER_SPEC)
    lines = content.split("\n")
    header_lines: list[str] = []
    for i, line in enumerate(lines):
        if i >= spec.max_header_lines:
            break
        if spec.start_pattern.match(line) or header_lines and spec.continuation_prefix and line.startswith(spec.continuation_prefix):
            header_lines.append(line)
        else:
            break
    header = "\n".join(header_lines)
    body = "\n".join(lines[len(header_lines):])
    return header, body


def strip_headers(rendered_message: str, source_type: str = "message") -> str:
    """Strip header lines from a rendered message, returning just the body."""
    _, body = split_header_body(rendered_message, source_type)
    return body


# ---------------------------------------------------------------------------
# Core slicing
# ---------------------------------------------------------------------------


def slice_chat_sessions(
    grouped: list[Chunk], *, chunk_token_num: int = DEFAULT_CHUNK_TOKEN_NUM
) -> list[Chunk]:
    """Transform per-message chat chunks into session-slice chunks.

    Args:
        grouped: The loader's output — one rendered :class:`Chunk` per message,
            grouped by ``conversation_id`` (contiguous) and time-sorted within a
            conversation, with ``metadata["session_start"]`` set (and the
            ``SESSION_BREAK`` marker prefixed) on the first message after a gap.
        chunk_token_num: Soft token budget per slice (default
            :data:`~kl_graph.ingest.chunker.DEFAULT_CHUNK_TOKEN_NUM`, 1024).

    Returns:
        Session-slice chunks. Each has a deterministic id (UUID5 of
        ``["chunk", conversation_id, first_member_message_id, slice_index]``),
        the packed slice text with per-message headers intact, and the
        provenance ``metadata`` contract described in the module docstring.

    **No-fragment guarantee:** A single message is never split across multiple
    slices. An oversized message is split into continuation chunks with explicit
    markers (``CONTINUATION_MARK``) preserving full content losslessly.
    """
    if not grouped:
        return []

    slices: list[Chunk] = []
    # Track the session index per conversation so ids/metadata are stable.
    session_index_by_conv: dict[str, int] = {}

    for session in _iter_sessions(grouped):
        conv_id = session[0].metadata.get("conversation_id", "")
        session_index = session_index_by_conv.get(conv_id, 0)
        session_index_by_conv[conv_id] = session_index + 1
        slices.extend(
            _slice_one_session(
                session,
                conv_id=conv_id,
                session_index=session_index,
                chunk_token_num=chunk_token_num,
            )
        )
    return slices


def _iter_sessions(grouped: list[Chunk]) -> list[list[Chunk]]:
    """Split the flat grouped stream into sessions.

    A new session starts when the ``conversation_id`` changes or the current
    message carries a truthy ``session_start`` flag (the loader's idle-gap cut).
    """
    sessions: list[list[Chunk]] = []
    current: list[Chunk] = []
    prev_conv: str | None = None
    for msg in grouped:
        conv_id = msg.metadata.get("conversation_id", "")
        starts = bool(msg.metadata.get("session_start"))
        if current and (conv_id != prev_conv or starts):
            sessions.append(current)
            current = []
        current.append(msg)
        prev_conv = conv_id
    if current:
        sessions.append(current)
    return sessions


def _slice_one_session(
    session: list[Chunk],
    *,
    conv_id: str,
    session_index: int,
    chunk_token_num: int,
) -> list[Chunk]:
    """Pack one session's messages into <=``chunk_token_num`` token slices.

    Messages are the atomic unit: a message is never split across slices
    **unless** it alone far exceeds the budget. In that case the oversized
    message is split into continuation chunks with an explicit marker
    (``CONTINUATION_MARK``) so the full content is preserved losslessly.
    """
    # Conversation display context is constant across a session; read it once
    # from the first member so every emitted slice carries it.
    first_meta = session[0].metadata
    title = first_meta.get("conversation_title")
    chat_kind = first_meta.get("chat_kind")

    # Greedy pack: add messages to the current buffer until the budget is
    # exceeded, then emit the buffer and start fresh.
    packed: list[list[_Block]] = []
    buf: list[_Block] = []
    buf_tokens = 0

    for msg in session:
        content = _strip_session_marker(msg.content)
        msg_tokens = num_tokens_from_string(content)
        sender = msg.metadata.get("sender", "")
        reply_to = msg.metadata.get("reply_to")
        extraction_target = msg.metadata.get("extraction_target_content", "")
        quoted_context = msg.metadata.get("quoted_context", "")

        if msg_tokens <= chunk_token_num:
            # Normal case: fits in a chunk
            block = _Block(
                content,
                msg.id,
                sender,
                reply_to,
                msg.timestamp,
                extraction_target=extraction_target,
                quoted_context=quoted_context,
            )
            if buf and buf_tokens + msg_tokens > chunk_token_num:
                packed.append(buf)
                buf = []
                buf_tokens = 0
            buf.append(block)
            buf_tokens += msg_tokens
        else:
            # Oversized: split into continuation chunks
            if buf:
                packed.append(buf)
                buf = []
                buf_tokens = 0
            # Split and emit each continuation as its own packed group
            for cont_blocks in _split_oversized(
                content, msg.id, sender, reply_to, msg.timestamp,
                chunk_token_num=chunk_token_num,
            ):
                packed.append(cont_blocks)  # noqa: PERF402

    if buf:
        packed.append(buf)

    out: list[Chunk] = []
    for slice_index, slice_blocks in enumerate(packed):
        out.append(
            _emit_slice(
                slice_blocks,
                conv_id=conv_id,
                session_index=session_index,
                slice_index=slice_index,
                is_first_slice=(slice_index == 0),
                title=title,
                chat_kind=chat_kind,
            )
        )
    return out


class _Block:
    """A whole rendered message plus its provenance.

    ``text`` is the full rendered content (header + body). The provenance fields
    propagate to the slice metadata.
    """

    __slots__ = (
        "extraction_target",
        "message_id",
        "quoted_context",
        "reply_to",
        "sender",
        "text",
        "timestamp",
    )

    def __init__(
        self,
        text: str,
        message_id: str,
        sender: str,
        reply_to: str | None,
        timestamp: int,
        extraction_target: str = "",
        quoted_context: str = "",
    ) -> None:
        self.text = text
        self.message_id = message_id
        self.sender = sender
        self.reply_to = reply_to
        self.timestamp = timestamp
        self.extraction_target = extraction_target
        self.quoted_context = quoted_context


def _split_oversized(
    content: str,
    message_id: str,
    sender: str,
    reply_to: str | None,
    timestamp: int,
    *,
    chunk_token_num: int,
) -> list[list[_Block]]:
    """Split an oversized message into multiple continuation _Block groups.

    Each group (a single-element list) becomes its own packed chunk. The first
    group carries the original content header + start of body; subsequent groups
    carry a continuation marker + the next segment of the body.

    Splitting is done on paragraph boundaries (``\\n\\n``) when possible, falling
    back to newline boundaries, then character boundaries.
    """
    # Separate header from body so we can split just the body
    header, body = split_header_body(content)

    # Reserve tokens for the header and continuation mark overhead
    header_tokens = num_tokens_from_string(header + "\n") if header else 0
    mark_overhead = num_tokens_from_string(CONTINUATION_MARK.format(part=99, total=99) + "\n")
    body_budget = chunk_token_num - max(header_tokens, mark_overhead) - 2  # small margin

    if body_budget < 10:
        # Extreme edge case: header is nearly the full budget. Just emit as-is.
        return [[_Block(content, message_id, sender, reply_to, timestamp)]]

    # Split body into segments that each fit in body_budget tokens
    segments = _split_text_to_token_budget(body, body_budget)

    if len(segments) <= 1:
        # Didn't actually need splitting (rounding)
        return [[_Block(content, message_id, sender, reply_to, timestamp)]]

    total = len(segments)
    groups: list[list[_Block]] = []
    for i, seg in enumerate(segments):
        if i == 0:
            # First part: header + first segment
            text = f"{header}\n{seg}" if header else seg
        else:
            # Continuation: marker + segment
            mark = CONTINUATION_MARK.format(part=i + 1, total=total)
            text = f"{mark}\n{seg}"
        groups.append([_Block(text, message_id, sender, reply_to, timestamp)])

    return groups


def _split_text_to_token_budget(text: str, budget: int) -> list[str]:
    """Split text into segments each fitting within a token budget.

    Tries to split on paragraph boundaries (\\n\\n) first, then newlines, then
    by character position as a last resort.
    """
    if num_tokens_from_string(text) <= budget:
        return [text]

    # Try paragraph splits first
    paragraphs = text.split("\n\n")
    if len(paragraphs) > 1:
        segments: list[str] = []
        buf = ""
        for para in paragraphs:
            candidate = f"{buf}\n\n{para}" if buf else para
            if num_tokens_from_string(candidate) <= budget:
                buf = candidate
            else:
                if buf:
                    segments.append(buf)
                # If a single paragraph exceeds budget, split it further
                if num_tokens_from_string(para) > budget:
                    segments.extend(_split_by_lines(para, budget))
                    buf = ""
                else:
                    buf = para
        if buf:
            segments.append(buf)
        return segments

    # No paragraph boundaries — split by lines
    return _split_by_lines(text, budget)


def _split_by_lines(text: str, budget: int) -> list[str]:
    """Split text by newline boundaries to fit token budget."""
    lines = text.split("\n")
    if len(lines) <= 1:
        # Single long line — split by character
        return _split_by_chars(text, budget)

    segments: list[str] = []
    buf = ""
    for line in lines:
        candidate = f"{buf}\n{line}" if buf else line
        if num_tokens_from_string(candidate) <= budget:
            buf = candidate
        else:
            if buf:
                segments.append(buf)
            if num_tokens_from_string(line) > budget:
                segments.extend(_split_by_chars(line, budget))
                buf = ""
            else:
                buf = line
    if buf:
        segments.append(buf)
    return segments


def _split_by_chars(text: str, budget: int) -> list[str]:
    """Last-resort split by character position to fit token budget."""
    # For CJK-heavy text, most chars ≈ 1 token. Use a conservative ratio.
    chars_per_token = 1.5
    initial_chunk_size = int(budget * chars_per_token)

    segments: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + initial_chunk_size, len(text))
        # Shrink until within budget
        while end > start + 1 and num_tokens_from_string(text[start:end]) > budget:
            end -= max(int(initial_chunk_size * 0.1), 10)
            if end <= start:
                end = start + 1
                break
        # Ensure we make progress
        if end <= start:
            end = start + 1
        segments.append(text[start:end])
        start = end
    return segments


def _emit_slice(
    blocks: list[_Block],
    *,
    conv_id: str,
    session_index: int,
    slice_index: int,
    is_first_slice: bool,
    title: str | None,
    chat_kind: str | None,
) -> Chunk:
    """Build one session-slice :class:`Chunk` from its packed blocks."""
    content = MESSAGE_JOIN.join(b.text for b in blocks)

    member_ids = _dedupe_keep_order([b.message_id for b in blocks if b.message_id])
    senders = _dedupe_keep_order([b.sender for b in blocks if b.sender])
    reply_tos = _dedupe_keep_order(
        [b.reply_to for b in blocks if b.reply_to]
    )

    metadata: dict = {
        "conversation_id": conv_id,
        "session_index": session_index,
        "slice_index": slice_index,
        "member_message_ids": member_ids,
        "senders": senders,
        "reply_to_message_ids": reply_tos,
        "extraction_target_contents": [b.extraction_target for b in blocks],
        "quoted_contexts": [b.quoted_context for b in blocks],
    }
    if is_first_slice:
        metadata["session_start"] = True
    if title:
        metadata["conversation_title"] = title
    if chat_kind:
        metadata["chat_kind"] = chat_kind

    return Chunk(
        id=_slice_id(conv_id, member_ids[0] if member_ids else "", slice_index),
        content=content,
        source_type="message",
        timestamp=blocks[0].timestamp,  # first member message's time
        metadata=metadata,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _slice_id(conversation_id: str, first_message_id: str, slice_index: int) -> str:
    """Deterministic session-slice id (UUID5 over a canonical JSON array).

    Mirrors :func:`kl_graph.models.types.scope_id_from` /
    :func:`community_id_from`: the hashed name is a JSON array (not a
    ``:``-joined string) so components containing a colon can't collide, and
    ``separators``/``ensure_ascii`` are pinned for cross-run stability.
    """
    name = json.dumps(
        ["chunk", conversation_id, first_message_id, slice_index],
        ensure_ascii=True,
        separators=(",", ":"),
    )
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, name))


def _strip_session_marker(content: str) -> str:
    """Remove a leading ``SESSION_BREAK`` marker line from rendered content."""
    prefix = f"{SESSION_BREAK_MARKER}\n"
    if content.startswith(prefix):
        return content[len(prefix):]
    if content.strip() == SESSION_BREAK_MARKER:
        return ""
    return content


def _dedupe_keep_order(items: list[str]) -> list[str]:
    """Return ``items`` with duplicates removed, preserving first-seen order."""
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out
