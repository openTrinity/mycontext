"""Shared text chunker for prose sources (wiki, doc, mail, ...).

A small, dependency-free re-implementation of RAGFlow's ``naive_merge`` idea
(see ``rag/nlp/__init__.py`` in the RAGFlow tree): split text at sentence-ish
*delimiters*, then greedily *re-merge* consecutive pieces up to a size budget
with optional overlap. Delimiters define the cut points; the budget defines the
chunk size. Both together, not either alone.

Differences from RAGFlow, on purpose:

- **Character budget, not token budget.** We have no tokenizer dependency here;
  a character cap is a good-enough proxy and keeps this module pure-python.
- **Heading-aware first pass.** Markdown ``#``/``##`` headings are treated as
  hard section boundaries before delimiter splitting, so a heading stays with
  its section (this preserves the old ``_split_markdown`` behavior).

Structured sources (minutes transcript merge, aitable one-chunk-per-table) keep
their bespoke logic and do **not** use this chunker; their "delimiters" are
structural (speaker turns, table rows), not sentence punctuation.
"""

from __future__ import annotations

import re

# Default cut points: paragraph breaks + Chinese/ASCII sentence enders. Mirrors
# RAGFlow's default ``\n。；！？`` plus the ASCII ``.!?`` and a paragraph break.
DEFAULT_DELIMITERS = ["\n\n", "\n", "。", "；", "！", "？", ".", "!", "?"]
DEFAULT_CHAR_BUDGET = 1200


def _split_on_delimiters(text: str, delimiters: list[str]) -> list[str]:
    """Split ``text`` at any delimiter, keeping the delimiter attached.

    Longer delimiters are matched first (so ``\n\n`` wins over ``\n``). Each
    returned segment includes its trailing delimiter, so re-joining is lossless.
    """
    ordered = sorted({d for d in delimiters if d}, key=len, reverse=True)
    if not ordered:
        return [text] if text.strip() else []
    pattern = "|".join(re.escape(d) for d in ordered)
    # Split but keep delimiters, then re-attach each delimiter to its preceding
    # segment.
    parts = re.split(f"({pattern})", text)
    segments: list[str] = []
    buf = ""
    for i, part in enumerate(parts):
        if i % 2 == 0:
            buf = part
        else:  # delimiter capture group
            segments.append(buf + part)
            buf = ""
    if buf:
        segments.append(buf)
    return [s for s in segments if s.strip()]


def _merge_to_budget(
    segments: list[str], budget: int, overlap: int
) -> list[str]:
    """Greedily pack ``segments`` into <=budget chunks with a char overlap.

    Any single segment larger than ``budget`` is hard-cut by character count so
    no chunk can exceed the budget.
    """
    chunks: list[str] = []
    buf = ""
    for seg in segments:
        # A monster segment (no usable delimiters inside): hard-cut it.
        if len(seg) > budget:
            if buf:
                chunks.append(buf)
                buf = ""
            for i in range(0, len(seg), budget):
                chunks.append(seg[i : i + budget])
            continue
        if buf and len(buf) + len(seg) > budget:
            chunks.append(buf)
            # Carry an overlap tail from the just-emitted chunk for context.
            buf = buf[-overlap:] if overlap else ""
        buf += seg
    if buf.strip():
        chunks.append(buf)
    return [c.strip() for c in chunks if c.strip()]


def chunk_text(
    text: str,
    *,
    budget: int = DEFAULT_CHAR_BUDGET,
    delimiters: list[str] | None = None,
    overlap: int = 0,
    heading_aware: bool = True,
) -> list[str]:
    """Split ``text`` into <=``budget`` character chunks at ``delimiters``.

    Args:
        text: The prose to chunk.
        budget: Max characters per chunk (approximation of a token budget).
        delimiters: Cut points, longest matched first. Defaults to
            :data:`DEFAULT_DELIMITERS` (paragraph + sentence enders).
        overlap: Characters of the previous chunk to prepend to the next, for
            cross-chunk context. ``0`` disables overlap.
        heading_aware: When true, split on markdown ``#``/``##`` headings first
            so a heading stays with its section.

    Returns:
        Non-empty, stripped chunks, each ``<= budget`` characters.
    """
    if not text or not text.strip():
        return []
    delims = delimiters if delimiters is not None else DEFAULT_DELIMITERS

    if heading_aware:
        sections = re.split(r"(?m)^(?=#{1,2}\s)", text)
        sections = [s for s in sections if s.strip()] or [text]
    else:
        sections = [text]

    chunks: list[str] = []
    for sec in sections:
        if len(sec.strip()) <= budget:
            chunks.append(sec.strip())
            continue
        segments = _split_on_delimiters(sec, delims)
        chunks.extend(_merge_to_budget(segments, budget, overlap))
    return [c for c in chunks if c.strip()]
