"""Shared text chunker for prose sources (wiki, doc, mail, ...).

A small, dependency-free re-implementation of RAGFlow's ``naive_merge`` idea
(see ``rag/nlp/__init__.py`` in the RAGFlow tree): split text at sentence-ish
*delimiters*, then greedily *re-merge* consecutive pieces up to a size budget
with optional overlap. Delimiters define the cut points; the budget defines the
chunk size. Both together, not either alone.

This module offers two entry points:

- :func:`chunk_text` — the legacy **character-budget** path (heading-aware),
  still used by the wiki and minutes loaders. Pure-python, no tokenizer.
- :func:`naive_merge` — a faithful **token-budget** port of RAGFlow's function
  of the same name, including its delimiter grammar (backtick-wrapped *custom*
  delimiters are hard cuts — each segment becomes its own chunk regardless of
  size — while bare sentence delimiters are soft cuts used only to keep a chunk
  under ``chunk_token_num``). Token counts come from :func:`num_tokens_from_string`
  (tiktoken ``cl100k_base``, matching RAGFlow), with a char/4 fallback so the
  function still runs if tiktoken is unavailable. Use this for chat session
  chunking, where a hard session-break delimiter must always cut and long
  sessions are further split at sentence boundaries.

Differences from RAGFlow, on purpose:

- **No PDF position tags.** RAGFlow threads a ``(text, pos)`` pair and strips
  ``@@`` position tags via ``RAGFlowPdfParser.remove_tag`` during overlap; we
  have no such tags, so ``pos`` is optional and overlap slices the raw text.
- :func:`chunk_text` uses a **character budget** (no tokenizer dependency) and a
  **heading-aware first pass** (markdown ``#``/``##`` are hard boundaries).

Structured sources (minutes transcript merge, aitable one-chunk-per-table) keep
their bespoke logic and do **not** use this chunker; their "delimiters" are
structural (speaker turns, table rows), not sentence punctuation.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

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


# ─── Token-budget path (faithful RAGFlow ``naive_merge`` port) ──────────────

# RAGFlow's default sentence delimiters (rag/nlp/__init__.py). Bare (non-backtick)
# delimiters are *soft* cut points: used only to keep a chunk under the token
# budget. Backtick-wrapped delimiters are *custom* / *hard* cuts (see
# :func:`naive_merge`).
DEFAULT_TOKEN_DELIMITER = "\n。；！？"
DEFAULT_CHUNK_TOKEN_NUM = 1024

_encoder = None


def num_tokens_from_string(text: str) -> int:
    """Return the number of tokens in ``text`` (tiktoken ``cl100k_base``).

    Mirrors RAGFlow's ``num_tokens_from_string``. Falls back to a ``len//4``
    character approximation if tiktoken is unavailable, so chunking still runs
    (slightly less accurately) in a minimal environment.
    """
    global _encoder
    if not text:
        return 0
    if _encoder is None:
        try:
            import tiktoken

            _encoder = tiktoken.get_encoding("cl100k_base")
        except Exception:  # noqa: BLE001 - tiktoken missing/offline
            _encoder = False
            logger.warning(
                "tiktoken unavailable; falling back to char/4 token estimate"
            )
    if _encoder is False:
        return max(1, len(text) // 4)
    try:
        return len(_encoder.encode(text))
    except Exception:  # noqa: BLE001
        return max(1, len(text) // 4)


def get_delimiters(delimiters: str) -> str:
    """Build a regex alternation from a delimiter spec (RAGFlow port).

    Backtick-wrapped runs are treated as single multi-char delimiters; every
    other character is an individual delimiter. Longer delimiters are matched
    first. Returns a regex pattern string (already ``re.escape``-d), or ``""``
    when the spec is empty.

    Example: ``"\n。`SESSION_BREAK`"`` → the literal token ``SESSION_BREAK`` plus
    the single chars ``\n`` and ``。``.
    """
    dels: list[str] = []
    s = 0
    for m in re.finditer(r"`([^`]+)`", delimiters, re.IGNORECASE):
        f, t = m.span()
        dels.append(m.group(1))
        dels.extend(list(delimiters[s:f]))
        s = t
    if s < len(delimiters):
        dels.extend(list(delimiters[s:]))

    dels.sort(key=lambda x: -len(x))
    dels = [re.escape(d) for d in dels if d]
    dels = [d for d in dels if d]
    return "|".join(dels)


def naive_merge(
    sections: str | list,
    chunk_token_num: int = DEFAULT_CHUNK_TOKEN_NUM,
    delimiter: str = DEFAULT_TOKEN_DELIMITER,
    overlapped_percent: float = 0,
) -> list[str]:
    """Token-budget chunker — faithful port of RAGFlow's ``naive_merge``.

    Two delimiter tiers (RAGFlow semantics):

    - **Custom / hard delimiters** — wrapped in backticks in ``delimiter`` (e.g.
      ```"`SESSION_BREAK`"```). Each segment between hard delimiters becomes its
      **own chunk regardless of token count** (``chunk_token_num`` is ignored on
      this path). Use for a chat session break that must always cut.
    - **Soft delimiters** — bare characters (default ``\n。；！？``). Sections are
      split here only to keep merged chunks under ``chunk_token_num``.

    Note: when *any* custom delimiter is present RAGFlow takes the hard-cut
    branch for the whole call and does not additionally token-merge. To both cut
    on session breaks *and* size-bound long sessions, call this once per session
    (soft delimiters only) after splitting on the hard break — see the chat
    session-chunking design.

    Args:
        sections: A string, a list of strings, or a list of ``(text, pos)``
            pairs. ``pos`` is an optional trailing tag kept out of the token
            count when short; kl-graph has no PDF position tags, so it is
            normally ``""``.
        chunk_token_num: Soft token budget per merged chunk.
        delimiter: Delimiter spec (see :func:`get_delimiters`).
        overlapped_percent: Percent of the previous chunk's tail to prepend to
            the next chunk (0 disables). Matches RAGFlow's overlap behavior.

    Returns:
        List of chunk strings (each begins with the ``\n`` RAGFlow prepends to
        every segment; callers typically ``.strip()``).
    """
    if not sections:
        return []
    if isinstance(sections, str):
        sections = [sections]
    if isinstance(sections[0], str):
        sections = [(s, "") for s in sections]
    # Normalize line endings so a ``\n`` delimiter matches ``\r\n`` / ``\r``.
    sections = [(s.replace("\r\n", "\n").replace("\r", "\n"), pos) for s, pos in sections]

    cks = [""]
    tk_nums = [0]

    def add_chunk(t: str, pos: str) -> None:
        nonlocal cks, tk_nums
        tnum = num_tokens_from_string(t)
        if not pos:
            pos = ""
        if tnum < 8:
            pos = ""
        # Start a new chunk once the current one fills the (overlap-adjusted)
        # budget; otherwise append to it.
        if cks[-1] == "" or tk_nums[-1] > chunk_token_num * (100 - overlapped_percent) / 100.0:
            if cks:
                overlapped = cks[-1]
                t = overlapped[int(len(overlapped) * (100 - overlapped_percent) / 100.0):] + t
                tnum = num_tokens_from_string(t)
            if t.find(pos) < 0:
                t += pos
            cks.append(t)
            tk_nums.append(tnum)
        else:
            if cks[-1].find(pos) < 0:
                t += pos
            cks[-1] += t
            tk_nums[-1] += tnum

    custom_delimiters = [m.group(1) for m in re.finditer(r"`([^`]+)`", delimiter)]
    if custom_delimiters:
        # Hard cut: each segment between custom delimiters is its own chunk,
        # regardless of chunk_token_num.
        custom_pattern = "|".join(
            re.escape(t) for t in sorted(set(custom_delimiters), key=len, reverse=True)
        )
        cks, tk_nums = [], []
        for sec, pos in sections:
            for sub_sec in re.split(rf"({custom_pattern})", sec, flags=re.DOTALL):
                if re.fullmatch(custom_pattern, sub_sec or ""):
                    continue
                if not (sub_sec or "").strip():
                    continue
                text = "\n" + sub_sec
                local_pos = pos
                if num_tokens_from_string(text) < 8:
                    local_pos = ""
                if local_pos and text.find(local_pos) < 0:
                    text += local_pos
                cks.append(text)
                tk_nums.append(num_tokens_from_string(text))
        return cks

    # Soft path: split oversized sections at sentence delimiters; add_chunk
    # re-merges to the token budget.
    dels = get_delimiters(delimiter)
    for sec, pos in sections:
        if not dels or num_tokens_from_string(sec) < chunk_token_num:
            add_chunk("\n" + sec, pos)
            continue
        for sub_sec in re.split(rf"({dels})", sec, flags=re.DOTALL):
            if not sub_sec or re.fullmatch(dels, sub_sec):
                continue
            add_chunk("\n" + sub_sec, pos)

    return [c for c in cks if c.strip()]
