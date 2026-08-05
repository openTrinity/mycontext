"""Load AI meeting-minutes (钉钉闪记) from the unified DWS export.

Minutes live in ``<export>/minutes/`` as the standard quartet. Each meeting is a
``meeting`` scope in ``scopes.jsonl`` (title / start_time / share_url), and its
content is spread across several records in ``records.jsonl``:

  - ``document_unit`` / ``minutes_summary`` — a clean markdown recap (high
    signal): background, decisions, per-topic discussion.
  - ``document_unit`` / ``minutes_transcription_page`` — a page of the raw
    transcript. NOTE: the flattened ``data.text`` for these is broken (only
    ``[<ms>]`` markers with blank speaker lines), so we rebuild the transcript
    from the structured ``data.segments`` (each ``{nickName, paragraph}``),
    ordered by ``data.page_index``.
  - ``generic_record`` / ``minutes_keywords`` — meeting keyword set.
  - ``generic_record`` / ``minutes_todos`` — extracted action items (under
    ``data.raw.actions`` / ``data.raw.dingtalkTodoList``).

Each meeting yields: one summary chunk (+ keywords/todos folded in), plus one
or more transcript chunks (token-budgeted, speaker-prefixed so attribution
survives), all tagged with the meeting title + timestamp for the graph.
"""

from __future__ import annotations

import json
from pathlib import Path

from kl_graph.ingest.chunker import chunk_text
from kl_graph.ingest.loaders.base import (
    iter_records,
    load_scopes,
    scope_title,
    to_unix_ms,
)
from kl_graph.models.types import Chunk

# Char budget per transcript chunk (~1 char ≈ 1 token for Chinese); summaries
# are usually short enough to stay whole but are windowed if oversized.
_MINUTES_CHAR_BUDGET = 1500


def _meeting_ts(scope: dict | None) -> int:
    """Unix-ms start time for a meeting scope (ISO ``start_time`` preferred)."""
    if not isinstance(scope, dict):
        return 0
    data = scope.get("data", {}) or {}
    ms = to_unix_ms(data.get("start_time"))
    if ms:
        return ms
    # Fallback to the raw list payload's epoch-ms startTime.
    raw_list = (data.get("raw", {}) or {}).get("list", {}) or {}
    return to_unix_ms(raw_list.get("startTime"))


def _meeting_url(scope: dict | None) -> str | None:
    if not isinstance(scope, dict):
        return None
    return (scope.get("data", {}) or {}).get("share_url") or None


def _transcript_lines(segments: list) -> list[str]:
    """Render structured transcript segments to ``speaker: text`` lines."""
    lines: list[str] = []
    for seg in segments or []:
        if not isinstance(seg, dict):
            continue
        speaker = (seg.get("nickName") or "").strip()
        text = (seg.get("paragraph") or "").strip()
        if not text:
            continue
        lines.append(f"{speaker}: {text}" if speaker else text)
    return lines


def _todos_text(data: dict) -> list[str]:
    """Extract action-item strings from a ``minutes_todos`` record payload."""
    raw = data.get("raw", {}) if isinstance(data.get("raw"), dict) else {}
    out: list[str] = []
    # Preferred: structured dingtalk todo list (title per item).
    for item in raw.get("dingtalkTodoList") or []:
        if isinstance(item, dict):
            title = (item.get("title") or "").strip()
            if title:
                out.append(title)
    # Fallback: the ``actions`` array holds JSON strings with a ``value`` field.
    if not out:
        for action in raw.get("actions") or []:
            try:
                obj = json.loads(action) if isinstance(action, str) else action
            except json.JSONDecodeError:
                obj = None
            if isinstance(obj, dict) and obj.get("value"):
                out.append(str(obj["value"]).strip())
            elif isinstance(action, str) and action.strip():
                out.append(action.strip())
    # Dedupe preserving order.
    seen: set[str] = set()
    return [s for s in out if s and not (s in seen or seen.add(s))]


def load_minutes(minutes_dir: Path) -> list[Chunk]:
    """Load all meeting minutes from a DWS ``minutes`` source directory.

    Groups records by their ``meeting`` scope, then emits a summary chunk (with
    keywords + action items appended) and token-budgeted transcript chunks per
    meeting. No-ops (returns ``[]``) when the directory is absent.
    """
    if not minutes_dir.is_dir():
        return []
    scopes = load_scopes(minutes_dir)

    # Bucket every record by its meeting scope so a meeting's summary,
    # transcript pages, keywords and todos are assembled together.
    summaries: dict[str, str] = {}
    pages: dict[str, list[tuple[int, list[str]]]] = {}
    keywords: dict[str, list[str]] = {}
    todos: dict[str, list[str]] = {}

    for rec in iter_records(minutes_dir):
        data = rec.get("data", {})
        if not isinstance(data, dict):
            continue
        scope_id = rec.get("scope_id", "")
        kind = data.get("unit_kind") or data.get("kind") or data.get("record_kind")
        if kind == "minutes_summary":
            body = (data.get("text") or "").strip()
            if body:
                summaries[scope_id] = body
        elif kind == "minutes_transcription_page":
            lines = _transcript_lines(data.get("segments") or [])
            if lines:
                page_idx = data.get("page_index") or 0
                pages.setdefault(scope_id, []).append((int(page_idx), lines))
        elif kind == "minutes_keywords":
            kws = [k for k in (data.get("keywords") or []) if isinstance(k, str)]
            if kws:
                keywords[scope_id] = kws
        elif kind == "minutes_todos":
            items = _todos_text(data)
            if items:
                todos[scope_id] = items

    chunks: list[Chunk] = []
    meeting_ids = set(summaries) | set(pages)
    for scope_id in meeting_ids:
        scope = scopes.get(scope_id)
        title = scope_title(scope) or "会议纪要"
        ts = _meeting_ts(scope)
        url = _meeting_url(scope)
        # Trailing scope-id segment is the meeting task uuid; use as stable key.
        mid = scope_id.split(":", 1)[-1] if ":" in scope_id else scope_id
        base_meta = {"title": title, "meeting_id": mid}

        # ── Summary chunk (fold in keywords + action items) ──────────────
        summary = summaries.get(scope_id, "")
        kws = keywords.get(scope_id, [])
        acts = todos.get(scope_id, [])
        if summary or kws or acts:
            parts = [summary] if summary else [f"# {title}"]
            if kws:
                parts.append("**关键词**: " + "、".join(kws))
            if acts:
                parts.append("**待办事项**:\n" + "\n".join(f"- {a}" for a in acts))
            content = "\n\n".join(p for p in parts if p).strip()
            chunks.append(Chunk(
                id=f"minutes:{mid}:summary",
                content=content,
                source_type="minutes",
                timestamp=ts,
                source_ref=url,
                metadata={**base_meta, "part": "summary", "keywords": kws},
            ))

        # ── Transcript chunks (ordered pages → speaker-prefixed lines) ────
        page_list = sorted(pages.get(scope_id, []), key=lambda p: p[0])
        transcript = "\n".join(line for _, lines in page_list for line in lines)
        if transcript.strip():
            # Split on line boundaries so a speaker turn is never cut mid-word.
            segments = chunk_text(
                transcript,
                budget=_MINUTES_CHAR_BUDGET,
                delimiters=["\n"],
                heading_aware=False,
            )
            for i, seg in enumerate(segments):
                chunks.append(Chunk(
                    id=f"minutes:{mid}:transcript:{i}",
                    content=f"【{title} 转写】\n{seg}",
                    source_type="minutes",
                    timestamp=ts,
                    source_ref=url,
                    metadata={
                        **base_meta,
                        "part": "transcript",
                        "seg_idx": i,
                        "n_segments": len(segments),
                    },
                ))

    return chunks
