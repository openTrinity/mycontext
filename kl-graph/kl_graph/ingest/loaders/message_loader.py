"""Load DingTalk chat messages from the unified DWS export.

Chat lives in ``<export>/chat/`` as the standard quartet; each line in
``records.jsonl`` with ``type == "message"`` is one message whose payload sits
under ``data`` (``content``, ``createTime``, ``sender``, ``openMessageId``,
``openConversationId``, ``quotedMessage``, ...). One record maps to one
:class:`Message` (a :class:`Chunk`); empty-content records are dropped.
"""

from __future__ import annotations

from pathlib import Path

from kl_graph.ingest.loaders.base import (
    iter_records,
    load_scopes,
    scope_title,
    to_unix_ms,
)
from kl_graph.models.types import Message


def load_all_messages(chat_dir: Path) -> list[Message]:
    """Load all chat messages from a DWS ``chat`` source directory.

    Reads ``<chat_dir>/records.jsonl`` (type ``message``) and links each to its
    conversation scope in ``scopes.jsonl`` for the group/chat title. Returns the
    messages sorted by timestamp. Missing files degrade to an empty list.
    """
    if not chat_dir.is_dir():
        return []

    scopes = load_scopes(chat_dir)
    messages: list[Message] = []
    for rec in iter_records(chat_dir, "message"):
        data = rec.get("data", {})
        if not isinstance(data, dict):
            continue
        content = (data.get("content") or "").strip()
        if not content:
            continue

        reply_to = None
        quoted = data.get("quotedMessage")
        if isinstance(quoted, dict):
            reply_to = quoted.get("openMessageId")

        conv_id = data.get("openConversationId") or rec.get("scope_id", "")
        title = scope_title(scopes.get(rec.get("scope_id")))

        messages.append(Message(
            id=data.get("openMessageId") or rec.get("id", ""),
            conversation_id=conv_id,
            sender=data.get("sender", "unknown"),
            sender_id=data.get("senderOpenDingTalkId"),
            content=content,
            timestamp=to_unix_ms(data.get("createTime")),
            reply_to=reply_to,
            metadata={"conversation_title": title} if title else {},
        ))

    messages.sort(key=lambda m: m.timestamp)
    return messages
