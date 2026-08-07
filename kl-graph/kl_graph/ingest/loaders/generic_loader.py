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

from kl_graph.ingest.chunker import chunk_text
from kl_graph.ingest.loaders.base import (
    find_timestamp,
    flatten_text,
    format_ts,
    iter_records,
    load_scopes,
    scope_title,
)
from kl_graph.models.types import Chunk

# Char budget per generic chunk (~1 char ≈ 1 token for Chinese; matches the
# wiki/minutes/mail loaders). A record whose flattened text exceeds this is
# split into several chunks rather than truncated downstream — nothing is
# discarded (see AGENTS.md "never discard with [:xx]").
_GENERIC_CHAR_BUDGET = 1500


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
        rec_id = rec.get("id", "")
        ts = find_timestamp(data)
        base_meta = {
            "unit_id": rec_id,
            "record_type": rec.get("type"),
            "kind": kind,
            "scope_id": rec.get("scope_id"),
        }

        # A ``title · time`` header line prefixes each part so the record's title
        # and time are embedded + seen by the extractor. Both are optional.
        _ts = format_ts(ts)
        _hdr = " · ".join(p for p in (title, _ts) if p)

        def _decorate(text: str, _hdr=_hdr) -> str:
            return f"{_hdr}\n{text}" if _hdr else text

        # Budget-split so a large record is never truncated downstream; the
        # title is re-emitted on every part so each chunk stands alone.
        parts = chunk_text(content, budget=_GENERIC_CHAR_BUDGET, heading_aware=False)
        if len(parts) <= 1:
            chunks.append(Chunk(
                id=rec_id,
                content=_decorate(content),
                source_type=source_type,
                timestamp=ts,
                source_ref=title or None,
                metadata=base_meta,
            ))
            continue
        for i, part in enumerate(parts):
            chunks.append(Chunk(
                id=f"{rec_id}:{i}",
                content=_decorate(part),
                source_type=source_type,
                timestamp=ts,
                source_ref=title or None,
                metadata={**base_meta, "seg_idx": i, "n_segments": len(parts)},
            ))
    return chunks
