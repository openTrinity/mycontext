"""Shared helpers for source loaders: the DWS quartet reader + timestamps.

The unified DWS export gives every product the same on-disk shape: a source
directory holding ``manifest.json`` + three JSONL files (``scopes.jsonl``,
``records.jsonl``, ``resources.jsonl``). Every line shares one envelope:

  - scope:    ``{id, type, parent_id, data}``     (containers / hierarchy)
  - record:   ``{id, scope_id, type, data}``       (the content items)
  - resource: ``{id, kind, uri, local_path, refs, data}``  (attachments)

These helpers read that quartet and normalize timestamps so individual loaders
stay focused on mapping their product's ``data`` payload to :class:`Chunk`.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def read_jsonl(path: Path) -> Iterator[dict]:
    """Yield each JSON object from a ``.jsonl`` file; skip blanks/bad lines.

    Never raises on a malformed line: a warning is printed and the line is
    skipped so one bad record can't abort a whole source load.
    """
    if not path.is_file():
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"Warning: bad JSONL line in {path.name}: {e}")
                continue
            if isinstance(obj, dict):
                yield obj


def load_scopes(source_dir: Path) -> dict[str, dict]:
    """Read ``<source_dir>/scopes.jsonl`` into an ``{scope_id: scope}`` map."""
    return {s["id"]: s for s in read_jsonl(source_dir / "scopes.jsonl") if "id" in s}


def iter_records(source_dir: Path, record_type: str | None = None) -> Iterator[dict]:
    """Yield records from ``<source_dir>/records.jsonl``.

    When ``record_type`` is given, only records whose ``type`` matches are
    yielded (e.g. ``"message"``, ``"email"``, ``"document_unit"``).
    """
    for rec in read_jsonl(source_dir / "records.jsonl"):
        if record_type is None or rec.get("type") == record_type:
            yield rec


def scope_title(scope: dict | None) -> str:
    """Best-effort human title for a scope across product shapes.

    Chat scopes carry ``data.title``; wiki ``document`` scopes nest it under
    ``data.node.name``; others may use ``data.name``. Returns ``""`` when none.
    """
    if not isinstance(scope, dict):
        return ""
    data = scope.get("data", {}) or {}
    node = data.get("node", {}) if isinstance(data.get("node"), dict) else {}
    return (data.get("title") or node.get("name") or data.get("name") or "").strip()


# Keys worth surfacing as readable text when flattening an unknown record
# payload, in rough priority order. Anything matching contributes a line.
_TEXT_KEYS = (
    "title", "subject", "name", "summary", "content", "text", "description",
    "value", "formMassage", "note", "remark",
)
_TS_KEYS = (
    "createTime", "createdTime", "gmtCreate", "startTime", "receivedDateTime",
    "processCreateTime", "last_modified_time", "updateTime",
)


def flatten_text(obj: Any, _depth: int = 0) -> str:
    """Collect human-readable strings from an arbitrary record ``data`` blob.

    Used by the generic loader for sources without a bespoke parser (tasks,
    approvals, contacts, attendance, ...). Walks dicts/lists, keeping values of
    known text-ish keys and any reasonably long free strings, deduped in order.
    Bounded in depth so deeply-nested payloads can't recurse without limit.
    """
    lines: list[str] = []

    def visit(o: Any, depth: int) -> None:
        if depth > 6:
            return
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, str):
                    s = v.strip()
                    if s and (k in _TEXT_KEYS or len(s) >= 8):
                        lines.append(s)
                else:
                    visit(v, depth + 1)
        elif isinstance(o, list):
            for v in o:
                visit(v, depth + 1)

    visit(obj, _depth)
    # Dedupe preserving order.
    seen: set[str] = set()
    out = [s for s in lines if not (s in seen or seen.add(s))]
    return "\n".join(out)


def find_timestamp(obj: Any) -> int:
    """Best-effort unix-ms timestamp from an arbitrary record ``data`` blob."""
    def visit(o: Any, depth: int) -> int:
        if depth > 6:
            return 0
        if isinstance(o, dict):
            for k in _TS_KEYS:
                if k in o and o[k] not in (None, ""):
                    ms = to_unix_ms(o[k])
                    if ms:
                        return ms
            for v in o.values():
                ms = visit(v, depth + 1)
                if ms:
                    return ms
        elif isinstance(o, list):
            for v in o:
                ms = visit(v, depth + 1)
                if ms:
                    return ms
        return 0
    return visit(obj, 0)


def unwrap(obj: Any) -> Any:
    """Peel known CLI envelope wrappers to reach the real payload.

    Handles the shapes seen across the export, applied repeatedly until a bare
    payload remains:
      - ``{"arguments": ..., "result": <payload>, "success": ...}``  (calendar)
      - ``{"message": <payload>, "success": ...}``                    (mail)
      - ``{"ok": ..., "data": <payload>, "raw_envelope": ...}``       (minutes)
      - ``{"result": <payload>, "success": ...}``                     (reports)

    Anything that is not a recognized envelope is returned unchanged.
    """
    seen = 0
    while isinstance(obj, dict) and seen < 8:
        if "result" in obj and ("success" in obj or "arguments" in obj):
            obj = obj["result"]
        elif "message" in obj and "success" in obj:
            obj = obj["message"]
        elif "data" in obj and ("ok" in obj or "raw_envelope" in obj):
            obj = obj["data"]
        else:
            break
        seen += 1
    return obj


def to_unix_ms(value: Any) -> int:
    """Best-effort normalization of a source timestamp to unix milliseconds.

    Accepts the formats seen across the export and returns ``0`` when the value
    is missing or unparseable (never raises):
      - int/float epoch seconds *or* milliseconds (auto-detected by magnitude)
      - ``"YYYY-MM-DD HH:MM:SS"`` / ``"YYYY-MM-DD HH:MM"``  (chat, reports)
      - ISO-8601, incl. trailing ``Z`` and ``+08:00`` offsets (calendar, mail)
    """
    if value is None or value == "":
        return 0

    # Numeric epoch (seconds vs milliseconds by magnitude).
    if isinstance(value, (int, float)):
        n = int(value)
        # < ~ year 2001 in ms means it's almost certainly seconds.
        return n if n >= 1_000_000_000_000 else n * 1000

    if isinstance(value, str):
        s = value.strip()
        if not s:
            return 0
        # Pure numeric string epoch.
        if s.lstrip("-").isdigit():
            return to_unix_ms(int(s))
        # ISO-8601 (handle trailing Z which fromisoformat rejects pre-3.11).
        iso = s.replace("Z", "+00:00")
        parsers = (
            lambda x: datetime.fromisoformat(x),
            lambda x: datetime.strptime(x, "%Y-%m-%d %H:%M:%S"),
            lambda x: datetime.strptime(x, "%Y-%m-%d %H:%M"),
            lambda x: datetime.strptime(x, "%Y-%m-%d"),
        )
        for parse in parsers:
            try:
                dt = parse(iso)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return int(dt.timestamp() * 1000)
            except (ValueError, TypeError):
                continue
    return 0
