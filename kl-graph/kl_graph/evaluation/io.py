"""Small persistence helpers shared by evaluation protocols."""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any


def json_lines(path: Path) -> Iterable[dict[str, Any]]:
    """Yield JSON objects from a JSONL artifact with line-aware errors."""
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"invalid JSON in {path}:{line_number}: {exc}"
                ) from exc
            if isinstance(value, dict):
                yield value


def artifact_stem(case_id: str) -> str:
    """Return a stable filename component for a benchmark case ID."""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", case_id).strip("._")
    return stem or "case"


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def atomic_write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
