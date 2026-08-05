"""Generic DWS quartet loader: one record → one chunk for any source.

Sources without a bespoke parser (work tasks/approvals, contacts, attendance,
drive, and any future product) still follow the uniform DWS shape, so their
``records.jsonl`` can be flattened to text generically: each record's ``data``
blob is reduced to its human-readable strings via :func:`flatten_text`, keyed
by record ``type``/``kind``, with a best-effort timestamp. Records that yield no
text are skipped (keeping the "content is always non-empty" invariant).
"""

from __future__ import annotations

from pathlib import Path

from kl_graph.ingest.loaders.base import (
    find_timestamp,
    flatten_text,
    iter_records,
    load_scopes,
    scope_title,
)
from kl_graph.models.types import Chunk


def load_generic(source_dir: Path, source_type: str) -> list[Chunk]:
    """Load every record in a DWS source dir into one chunk each.

    Args:
        source_dir: A DWS source directory (holds ``records.jsonl`` etc.).
        source_type: The ``Chunk.source_type`` to stamp (e.g. ``"work"``,
            ``"contacts"``, ``"attendance"``).

    Returns:
        One :class:`Chunk` per record with non-empty flattened text.
    """
    if not source_dir.is_dir():
        return []
    scopes = load_scopes(source_dir)
    chunks: list[Chunk] = []
    for rec in iter_records(source_dir):
        data = rec.get("data", {})
        content = flatten_text(data)
        if not content.strip():
            continue
        kind = data.get("kind") if isinstance(data, dict) else None
        title = scope_title(scopes.get(rec.get("scope_id")))
        if title:
            content = f"{title}\n{content}"
        chunks.append(Chunk(
            id=rec.get("id", ""),
            content=content,
            source_type=source_type,
            timestamp=find_timestamp(data),
            source_ref=title or None,
            metadata={
                "record_type": rec.get("type"),
                "kind": kind,
                "scope_id": rec.get("scope_id"),
            },
        ))
    return chunks
