"""Load exported mail from the unified DWS export.

Mail lives in ``<export>/mail/`` as the standard quartet. Each ``records.jsonl``
line with ``type == "email"`` carries the message under ``data``: list metadata
under ``data.list_metadata`` and the full body under ``data.body`` (with
``markdownBody``). The chunk content is a rendered direction header
(``发件人 → 收件人``; ``loader-context-rendering.md`` R2) + ``subject`` +
``markdownBody``; sender / recipients are also kept in metadata for downstream
entity extraction.
"""

from __future__ import annotations

from pathlib import Path

from kl_graph.ingest.chunker import chunk_text
from kl_graph.ingest.loaders.base import format_ts, iter_records, to_unix_ms
from kl_graph.models.types import Chunk

# Char budget per mail body chunk (~1 char ≈ 1 token for Chinese; matches the
# wiki/minutes loaders). A long email is split into several budgeted chunks
# rather than truncated — nothing is discarded (see AGENTS.md "never discard
# with [:xx]"). The direction header is re-emitted on every chunk so each one is
# self-describing for retrieval + extraction.
_MAIL_CHAR_BUDGET = 1500


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


def _render_header(sender: str, to: list[str], cc: list[str], timestamp: int = 0) -> str:
    """Render the mail direction header line.

    Shape: ``[邮件] 发件人 <from> → 收件人 <to; to> ; 抄送 <cc; cc> · <time>``. The
    full cc list is included (human decision — no cap). Absent parts are omitted,
    so a mail with no recipients still renders its sender. The received time is
    appended when known so it is embedded + seen by the extractor.
    """
    parts: list[str] = []
    if sender:
        parts.append(f"发件人 {sender}")
    if to:
        parts.append(f"收件人 {'; '.join(to)}")
    header = " → ".join(parts)
    if cc:
        cc_text = f"抄送 {'; '.join(cc)}"
        header = f"{header}; {cc_text}" if header else cc_text
    if not header:
        return ""
    ts = format_ts(timestamp)
    return f"[邮件] {header} · {ts}" if ts else f"[邮件] {header}"


def _email_to_chunk(rec: dict) -> list[Chunk]:
    data = rec.get("data", {})
    if not isinstance(data, dict):
        return []
    body = data.get("body", {}) if isinstance(data.get("body"), dict) else {}
    meta = data.get("list_metadata", {}) if isinstance(data.get("list_metadata"), dict) else {}

    subject = (body.get("subject") or meta.get("subject") or "").strip()
    md_body = (body.get("markdownBody") or "").strip()
    body_text = (f"主题：{subject}\n\n{md_body}" if subject else md_body).strip()
    if not body_text:
        return []

    sender = _addr(body.get("from") or meta.get("from") or {})
    to = _names(body.get("toRecipients") or meta.get("toRecipients") or [])
    cc = _names(body.get("ccRecipients") or meta.get("ccRecipients") or [])
    msg_id = data.get("messageId") or body.get("id") or rec.get("id")
    ts = to_unix_ms(body.get("receivedDateTime") or meta.get("receivedDateTime"))

    # Prepend the direction header (with received time) so the model sees who
    # wrote to whom and when (R2).
    header = _render_header(sender, to, cc, ts)
    conversation_id = body.get("conversationId") or meta.get("conversationId")
    base_meta = {
        "unit_id": str(msg_id or ""),
        "subject": subject,
        "from": sender,
        "to": to,
        "cc": cc,
        "conversation_id": conversation_id,
        "truncated": bool(body.get("bodyHasMore")),
        "body_total_length": body.get("bodyTotalLength"),
    }

    # Split a long body into budgeted parts instead of truncating. Short mails
    # yield exactly one part (identical id ``mail:{msg_id}``); long mails yield
    # ``mail:{msg_id}:0``, ``:1``, ... each carrying the header so it stands
    # alone. Never slice content away.
    parts = chunk_text(body_text, budget=_MAIL_CHAR_BUDGET, heading_aware=False)
    if len(parts) <= 1:
        content = f"{header}\n{body_text}" if header else body_text
        return [Chunk(
            id=f"mail:{msg_id}",
            content=content,
            source_type="mail",
            timestamp=ts,
            source_ref=sender or None,
            metadata=base_meta,
        )]

    chunks: list[Chunk] = []
    for i, part in enumerate(parts):
        content = f"{header}\n{part}" if header else part
        chunks.append(Chunk(
            id=f"mail:{msg_id}:{i}",
            content=content,
            source_type="mail",
            timestamp=ts,
            source_ref=sender or None,
            metadata={**base_meta, "seg_idx": i, "n_segments": len(parts)},
        ))
    return chunks


def load_mail(mail_dir: Path) -> list[Chunk]:
    """Load all mail from a DWS ``mail`` source directory."""
    if not mail_dir.is_dir():
        return []
    chunks: list[Chunk] = []
    for rec in iter_records(mail_dir, "email"):
        chunks.extend(_email_to_chunk(rec))
    return chunks
