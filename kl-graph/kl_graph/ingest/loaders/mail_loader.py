"""Load exported mail from the unified DWS export.

Mail lives in ``<export>/mail/`` as the standard quartet. Each ``records.jsonl``
line with ``type == "email"`` carries the message under ``data``: list metadata
under ``data.list_metadata`` and the full body under ``data.body`` (with
``markdownBody``). The chunk content is ``subject`` + ``markdownBody``; sender /
recipients are kept in metadata for downstream entity extraction.
"""

from __future__ import annotations

from pathlib import Path

from kl_graph.ingest.loaders.base import iter_records, to_unix_ms
from kl_graph.models.types import Chunk


def _addr(a: dict) -> str:
    if not isinstance(a, dict):
        return str(a)
    name = a.get("name") or ""
    email = a.get("email") or ""
    return f"{name} <{email}>".strip() if (name or email) else ""


def _names(recipients: list) -> list[str]:
    out = []
    for r in recipients or []:
        n = _addr(r)
        if n:
            out.append(n)
    return out


def _email_to_chunk(rec: dict) -> list[Chunk]:
    data = rec.get("data", {})
    if not isinstance(data, dict):
        return []
    body = data.get("body", {}) if isinstance(data.get("body"), dict) else {}
    meta = data.get("list_metadata", {}) if isinstance(data.get("list_metadata"), dict) else {}

    subject = (body.get("subject") or meta.get("subject") or "").strip()
    md_body = (body.get("markdownBody") or "").strip()
    content = (f"{subject}\n\n{md_body}" if subject else md_body).strip()
    if not content:
        return []

    sender = _addr(body.get("from") or meta.get("from") or {})
    to = _names(body.get("toRecipients") or meta.get("toRecipients") or [])
    cc = _names(body.get("ccRecipients") or meta.get("ccRecipients") or [])
    msg_id = data.get("messageId") or body.get("id") or rec.get("id")

    return [Chunk(
        id=f"mail:{msg_id}",
        content=content,
        source_type="mail",
        timestamp=to_unix_ms(body.get("receivedDateTime") or meta.get("receivedDateTime")),
        source_ref=sender or None,
        metadata={
            "subject": subject,
            "from": sender,
            "to": to,
            "cc": cc,
            "conversation_id": body.get("conversationId") or meta.get("conversationId"),
            "truncated": bool(body.get("bodyHasMore")),
            "body_total_length": body.get("bodyTotalLength"),
        },
    )]


def load_mail(mail_dir: Path) -> list[Chunk]:
    """Load all mail from a DWS ``mail`` source directory."""
    if not mail_dir.is_dir():
        return []
    chunks: list[Chunk] = []
    for rec in iter_records(mail_dir, "email"):
        chunks.extend(_email_to_chunk(rec))
    return chunks
