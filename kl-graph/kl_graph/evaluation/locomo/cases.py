"""Converted LoCoMo case-set paths, selection, and manifest validation."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from kl_graph.evaluation.locomo.experiment import ConversationSelectionConfig
from kl_graph.evaluation.locomo.source import normalize_sample_id

CASE_SET_FORMAT = "kl-evaluation-case-set"
DATASET_NAME = "locomo"
CASE_DATA_DIRNAME = "kl_data"


def load_case_entries(path: Path) -> tuple[Path, list[dict[str, Any]]]:
    root = path.expanduser().resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"LoCoMo case-set manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise TypeError(f"expected JSON object: {manifest_path}")
    if (
        manifest.get("format") != CASE_SET_FORMAT
        or manifest.get("dataset") != DATASET_NAME
    ):
        raise ValueError(f"not a converted LoCoMo case set: {manifest_path}")
    entries = manifest.get("case_entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"manifest has no case_entries: {manifest_path}")

    seen: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise TypeError(f"case_entries[{index}] must be an object")
        conversation_id = entry.get("conversation_id")
        if not isinstance(conversation_id, str) or not conversation_id:
            raise ValueError(
                f"case_entries[{index}].conversation_id must be non-empty text"
            )
        if conversation_id in seen:
            raise ValueError(f"duplicate conversation_id: {conversation_id}")
        seen.add(conversation_id)
        case_path = resolve_case_root(root, entry)
        _validate_dws(conversation_id, case_path / "dws")
        for name in ("evaluation.jsonl", "evidence_map.jsonl"):
            artifact = case_path / name
            if not artifact.is_file():
                raise FileNotFoundError(artifact)
    return root, entries


def resolve_case_root(root: Path, entry: dict[str, Any]) -> Path:
    value = entry.get("path")
    if not isinstance(value, str) or not value:
        raise ValueError("manifest field 'path' must be non-empty text")
    resolved_root = root.resolve()
    path = (resolved_root / value).resolve()
    if not path.is_relative_to(resolved_root):
        raise ValueError("manifest field 'path' escapes case-set root")
    return path


def case_set_fingerprint(path: Path) -> str:
    manifest = path.expanduser().resolve() / "manifest.json"
    return hashlib.sha256(manifest.read_bytes()).hexdigest()


def cases_by_conversation(path: Path) -> dict[str, dict[str, Any]]:
    _, entries = load_case_entries(path)
    return {str(entry["conversation_id"]): entry for entry in entries}


def graph_data_dirs(path: Path) -> dict[str, Path]:
    root, entries = load_case_entries(path)
    return {
        str(entry["conversation_id"]): resolve_case_root(root, entry)
        / CASE_DATA_DIRNAME
        for entry in entries
    }


def select_cases(
    cases: list[dict[str, Any]], selection: ConversationSelectionConfig
) -> list[dict[str, Any]]:
    if selection.cases is not None:
        requested = [normalize_sample_id(value) for value in selection.cases]
        by_id = {
            normalize_sample_id(str(case["conversation_id"])): case for case in cases
        }
        unknown = [value for value in requested if value not in by_id]
        if unknown:
            raise ValueError(f"unknown LoCoMo conversation(s): {unknown}")
        return [by_id[value] for value in requested]
    if selection.first is not None:
        return cases[: selection.first]
    return cases


def resolve_case_set_dir(case_set: Path | None, project_root: Path) -> Path:
    """Retain Codex runner discovery while configured stages use explicit paths."""
    if case_set is not None:
        candidate = case_set.expanduser().resolve()
        load_case_entries(candidate)
        return candidate
    configured = os.environ.get("KL_LOCOMO_CASE_SET")
    candidates = [
        Path(configured).expanduser() if configured else None,
        project_root / "data" / "locomo-v2",
        project_root / "data" / "locomo",
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            load_case_entries(candidate)
        except (FileNotFoundError, TypeError, ValueError, json.JSONDecodeError):
            continue
        return candidate.resolve()
    raise FileNotFoundError(
        "Could not find a converted LoCoMo conversation case set. "
        "Run the configured convert stage first or pass --dataset."
    )


def _validate_dws(conversation_id: str, dws_root: Path) -> None:
    chat = dws_root / "chat"
    required = ("manifest.json", "scopes.jsonl", "records.jsonl", "resources.jsonl")
    missing = [name for name in required if not (chat / name).is_file()]
    if missing:
        raise FileNotFoundError(
            f"case {conversation_id}: incomplete DWS chat source; missing {missing}"
        )
