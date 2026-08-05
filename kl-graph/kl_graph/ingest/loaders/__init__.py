"""Per-source loaders that turn the unified DWS export into :class:`Chunk`s.

The DWS export gives every product the same on-disk shape — a source directory
holding ``manifest.json`` + ``scopes.jsonl`` + ``records.jsonl`` +
``resources.jsonl`` (see :mod:`kl_graph.ingest.loaders.base`). Structured
sources get a bespoke mapper that understands their ``data`` payload:

  - :func:`load_all_messages` — chat (``type: message``) → :class:`Message`
  - :func:`load_wiki` — wiki (``type: document_unit``) → doc-section chunks
  - :func:`load_mail` — mail (``type: email``) → subject+body chunks
  - :func:`load_minutes` — minutes (``meeting`` scopes) → summary + transcript

Every other source (work tasks/approvals, contacts, attendance, drive, ...)
flows through :func:`load_generic`, which flattens each record to text — so the
pipeline can ingest all folders without a per-source whitelist.
"""

from __future__ import annotations

from kl_graph.ingest.loaders.generic_loader import load_generic
from kl_graph.ingest.loaders.mail_loader import load_mail
from kl_graph.ingest.loaders.message_loader import load_all_messages
from kl_graph.ingest.loaders.minutes_loader import load_minutes
from kl_graph.ingest.loaders.wiki_loader import load_wiki

__all__ = [
    "load_all_messages",
    "load_wiki",
    "load_mail",
    "load_minutes",
    "load_generic",
]
