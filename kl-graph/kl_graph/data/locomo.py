"""LoCoMo artifact readers.

This module owns benchmark-specific field names. The graph and retrieval code
only see canonical message IDs, conversation IDs, and question records.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable


def json_lines(path: Path) -> Iterable[dict[str, Any]]:
    """Yield JSON objects from a JSONL file with useful parse errors."""
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON in {path}:{line_number}: {exc}") from exc
            if isinstance(value, dict):
                yield value


def load_evaluation(
    dataset_dir: Path,
    limit: int | None = None,
    category: int | None = None,
) -> list[dict[str, Any]]:
    """Load normalized LoCoMo QA rows from ``evaluation.jsonl``."""
    rows = []
    for raw in json_lines(dataset_dir / "evaluation.jsonl"):
        data = raw.get("data") or {}
        if not isinstance(data, dict):
            continue
        rows.append({
            "id": str(raw.get("id") or ""),
            "sample_id": str(raw.get("sample_id") or ""),
            "conversation_id": str(raw.get("chat_scope_id") or ""),
            "question": str(data.get("question") or ""),
            "ground_truth": data.get("answer"),
            "evidence": [str(value) for value in data.get("evidence") or []],
            "category": int(data["category"]),
        })
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("evaluation rows must have unique ids")
    if category is not None:
        rows = [row for row in rows if row["category"] == category]
    return rows[:limit] if limit is not None else rows


def load_dia_id_map(dataset_dir: Path) -> dict[str, str]:
    """Map canonical source-message IDs to LoCoMo dialogue IDs."""
    mapping = {}
    for record in json_lines(dataset_dir / "records.jsonl"):
        if record.get("type") != "message":
            continue
        data = record.get("data") or {}
        if isinstance(data, dict) and data.get("dia_id"):
            mapping[str(record.get("id"))] = str(data["dia_id"])
    return mapping
