"""Load DingTalk chat messages from the unified DWS export.

Chat lives in ``<export>/chat/`` as the standard quartet; each line in
``records.jsonl`` with ``type == "message"`` is one message whose payload sits
under ``data`` (``content``, ``createTime``, ``sender``, ``openMessageId``,
``openConversationId``, ``quotedMessage``, ...). One record maps to one
:class:`Chunk` with ``source_type="message"``, whose chat-only fields
(``conversation_id`` / ``sender`` / ``sender_id`` / ``reply_to``) live in
``metadata``; empty-content records are dropped.

Each message's ``content`` is **rendered** rather than raw: a direction header
(who is talking to whom) plus the inlined quoted message when the record is a
reply, so the extractor/embedder sees the conversational context instead of a
context-free fragment (``loader-context-rendering.md`` R1). Messages are
returned **grouped by conversation** (not globally interleaved), and a literal
session-break marker is emitted on a long idle gap so a later chunker can cut a
conversation into topical sessions (R0).
"""

from __future__ import annotations

from pathlib import Path

from kl_graph.ingest.loaders.base import (
    SESSION_BREAK_MARKER,
    SESSION_GAP_MS,
    format_ts,
    iter_records,
    load_scopes,
    scope_chat_kind,
    scope_title,
    to_unix_ms,
)
from kl_graph.models.types import Chunk


def _stamp(header: str, timestamp: int) -> str:
    """Append ``· YYYY-MM-DD HH:MM`` to a header line when the time is known.

    Time is rendered into the content so it is embedded + visible to the LLM
    extractor for every message, replacing the extractor's separate time field.
    A missing time leaves the header untouched.
    """
    ts = format_ts(timestamp)
    return f"{header} · {ts}" if ts else header


def _render_content(
    body: str,
    sender: str,
    chat_kind: str,
    title: str,
    quoted: dict | None,
    timestamp: int = 0,
    *,
    current_user: str = "",
) -> str:
    """Render a chat message's chunk text with direction + inlined reply.

    Pure function (no I/O) so it is directly unit-testable. Shapes::

        [私聊] 孙亮 → 小周
        <body>

        [私聊] 小周 → 孙亮
        ↳ 回复 孙亮：<quoted body>
        <body>

        [群聊: 项目进度讨论] 赵辰
        <body>

    Args:
        body: The raw message body (already stripped, non-empty).
        sender: Sender display name as it appears in the data.
        chat_kind: ``"direct"`` | ``"group"`` (``""`` when unknown → group-ish
            header without a receiver, since we cannot claim a counterparty).
        title: Scope title. For a direct chat this is the counterparty's display
            name; for a group it is the group name.
        quoted: The record's ``quotedMessage`` dict, or ``None``.
        current_user: Current user's display name. Direct-chat scopes identify
            the counterparty but carry no recipient field, so this is required
            to render incoming-message direction without guessing.

    Returns:
        The rendered chunk text. The body is always the final line(s), so the
        original message stays readable verbatim beneath its header.

    Notes:
        - No ``(本人)``/owner tagging: sender and receiver are rendered exactly
          as they appear in the data (human decision).
        - The quoted body is inlined **verbatim** — no truncation, no
          media/``@``-noise stripping and no whitespace trimming (human
          decision).
        - A direct scope's title is the current user's counterparty, not the
          recipient of every message. When the sender is that counterparty,
          ``current_user`` supplies the missing recipient.
        - If a direct message's direction cannot be resolved, the header keeps
          the conversation title and sender but deliberately omits an arrow.
    """
    lines: list[str] = []

    if chat_kind == "direct":
        # A 1:1 scope title is the current user's counterparty; it is not a
        # per-message receiver. DWS does not export a receiver field, so use the
        # configured current user to resolve incoming messages. Outgoing
        # direction remains inferable without it because sender != counterparty.
        current_user = current_user.strip()
        receiver = ""
        if title and current_user and sender == current_user:
            receiver = title
        elif title and current_user and sender == title:
            receiver = current_user
        elif title and not current_user and sender != title:
            receiver = title

        if receiver:
            header = f"[私聊] {sender} → {receiver}"
        elif title:
            header = f"[私聊: {title}] {sender}"
        else:
            header = f"[私聊] {sender}"
        lines.append(_stamp(header, timestamp))
    elif title:
        lines.append(_stamp(f"[群聊: {title}] {sender}", timestamp))
    else:
        # Unknown chat kind and no title: still name the speaker.
        lines.append(_stamp(f"[群聊] {sender}", timestamp))

    if isinstance(quoted, dict):
        # Only the sender (a display name) is normalized; the body is inlined
        # exactly as stored so the quote stays verbatim, whitespace included.
        q_sender = (quoted.get("sender") or "").strip()
        q_body = quoted.get("content") or ""
        # Render the reply line when there is anything usable to show. Media-only
        # quotes (sender but no content) still record who is being replied to;
        # a whitespace-only body counts as "nothing to show" for that decision
        # even though it is rendered untouched when the line is emitted.
        if q_sender or q_body.strip():
            lines.append(f"↳ 回复 {q_sender}：{q_body}")

    lines.append(body)
    return "\n".join(lines)


def load_all_messages(chat_dir: Path, *, current_user: str = "") -> list[Chunk]:
    """Load all chat messages from a DWS ``chat`` source directory.

    Reads ``<chat_dir>/records.jsonl`` (type ``message``) and links each to its
    conversation scope in ``scopes.jsonl`` for the chat title + kind. Each
    message's ``content`` is rendered with a direction header and the inlined
    quoted message (:func:`_render_content`). ``current_user`` resolves the
    otherwise absent recipient for incoming direct messages.

    Messages are returned **grouped by conversation** — a concatenation of
    per-conversation runs, each sorted by timestamp — rather than one global
    timeline, so consecutive list neighbours belong to the same conversation.
    Within a conversation, when the idle gap between two messages is at least
    ``SESSION_GAP_MS``, a literal :data:`SESSION_BREAK_MARKER` line is prefixed
    onto the later message's ``content``; the chat chunker treats it as a hard
    delimiter and strips it while slicing. ``metadata["session_start"]`` is also
    set on that message so non-text consumers can see the boundary without
    parsing the text. A gap is only measured between two *known* timestamps —
    records whose time is missing/unparseable normalize to ``0`` (and sort
    first), so they never fabricate a session break.

    Missing files degrade to an empty list.
    """
    if not chat_dir.is_dir():
        return []

    scopes = load_scopes(chat_dir)
    messages: list[Chunk] = []
    for rec in iter_records(chat_dir, "message"):
        data = rec.get("data", {})
        if not isinstance(data, dict):
            continue
        content = (data.get("content") or "").strip()
        if not content:
            continue

        quoted = data.get("quotedMessage")
        reply_to = quoted.get("openMessageId") if isinstance(quoted, dict) else None

        conv_id = data.get("openConversationId") or rec.get("scope_id", "")
        scope = scopes.get(rec.get("scope_id"))
        title = scope_title(scope)
        chat_kind = scope_chat_kind(scope)
        sender = data.get("sender", "unknown")

        # Chat-only fields live in ``metadata``: a chat message is a Chunk with
        # ``source_type="message"``, not its own type.
        metadata: dict = {
            "conversation_id": conv_id,
            "sender": sender,
            "sender_id": data.get("senderOpenDingTalkId"),
            "reply_to": reply_to,
        }
        if title:
            metadata["conversation_title"] = title
        if chat_kind:
            metadata["chat_kind"] = chat_kind
        # Extraction targets exclude the inlined quote so a reply does not
        # restate the quoted message as a new fact. The quote remains in the
        # stored retrieval chunk and is supplied separately as read-only context.
        metadata["extraction_target_content"] = _render_content(
            content,
            sender,
            chat_kind,
            title,
            None,
            timestamp=to_unix_ms(data.get("createTime")),
            current_user=current_user,
        )
        if isinstance(quoted, dict):
            q_sender = (quoted.get("sender") or "").strip()
            q_body = quoted.get("content") or ""
            if q_sender or q_body.strip():
                metadata["quoted_context"] = f"↳ 回复 {q_sender}：{q_body}"

        messages.append(Chunk(
            id=data.get("openMessageId") or rec.get("id", ""),
            content=_render_content(
                content, sender, chat_kind, title, quoted,
                timestamp=to_unix_ms(data.get("createTime")),
                current_user=current_user,
            ),
            source_type="message",
            timestamp=to_unix_ms(data.get("createTime")),
            metadata=metadata,
        ))

    # Group by conversation (stable: first-appearance order), sorted by time
    # within each conversation, instead of one global timestamp sort.
    by_conv: dict[str, list[Chunk]] = {}
    for m in messages:
        by_conv.setdefault(m.metadata["conversation_id"], []).append(m)

    grouped: list[Chunk] = []
    for conv_msgs in by_conv.values():
        conv_msgs.sort(key=lambda m: m.timestamp)
        prev_ts = 0  # 0 also means "no usable previous timestamp" (see below)
        for m in conv_msgs:
            # A long silence ends the previous session: mark the first message
            # after the gap with the hard-break marker the chunker cuts on.
            # Both sides must carry a real timestamp: ``to_unix_ms`` maps a
            # missing/unparseable time to 0, and those sort first, so measuring
            # a gap against 0 would fake a decades-long silence and break the
            # first properly-timed message of the conversation.
            if prev_ts > 0 and m.timestamp > 0 and m.timestamp - prev_ts >= SESSION_GAP_MS:
                m.content = f"{SESSION_BREAK_MARKER}\n{m.content}"
                m.metadata["session_start"] = True
            prev_ts = m.timestamp
        grouped.extend(conv_msgs)

    return grouped
