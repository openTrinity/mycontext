"""Read native LoCoMo data and render backend-owned transcript documents."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from kl_graph.evaluation.io import artifact_stem
from kl_graph.evaluation.locomo.experiment import (
    ConversationSelectionConfig,
    QuestionSelectionConfig,
)

_SESSION_KEY = re.compile(r"^session_(\d+)$")
_DIA_ID = re.compile(r"\bD\d+:\d+\b")


def resolve_source(path: Path) -> Path:
    source = path.expanduser().resolve()
    if source.is_dir():
        source = source / "locomo10.json"
    if not source.is_file():
        raise FileNotFoundError(source)
    return source


def source_fingerprint(path: Path) -> str:
    return hashlib.sha256(resolve_source(path).read_bytes()).hexdigest()


def load_samples(path: Path) -> tuple[Path, list[dict[str, Any]]]:
    source = resolve_source(path)
    value = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(value, list) or not value:
        raise ValueError(f"native LoCoMo source must be a non-empty array: {source}")
    samples: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, sample in enumerate(value):
        if not isinstance(sample, dict):
            raise TypeError(f"LoCoMo sample {index} must be an object")
        sample_id = str(sample.get("sample_id") or "").strip()
        if not sample_id:
            raise ValueError(f"LoCoMo sample {index} has no sample_id")
        if sample_id in seen:
            raise ValueError(f"duplicate LoCoMo sample_id: {sample_id}")
        if not isinstance(sample.get("conversation"), dict) or not isinstance(
            sample.get("qa"), list
        ):
            raise TypeError(f"invalid native LoCoMo sample: {sample_id}")
        seen.add(sample_id)
        samples.append(sample)
    return source, samples


def normalize_sample_id(value: str) -> str:
    return value.strip().removeprefix("chat:")


def select_samples(
    samples: list[dict[str, Any]], selection: ConversationSelectionConfig
) -> list[dict[str, Any]]:
    if selection.cases is not None:
        ids = [normalize_sample_id(value) for value in selection.cases]
        by_id = {str(sample["sample_id"]): sample for sample in samples}
        unknown = [value for value in ids if value not in by_id]
        if unknown:
            raise ValueError(f"unknown LoCoMo conversation(s): {unknown}")
        return [by_id[value] for value in ids]
    if selection.first is not None:
        return samples[: selection.first]
    return samples


def session_keys(conversation: dict[str, Any]) -> list[str]:
    indexed: list[tuple[int, str]] = []
    for key, value in conversation.items():
        match = _SESSION_KEY.fullmatch(key)
        if match and isinstance(value, list):
            indexed.append((int(match.group(1)), key))
    return [key for _, key in sorted(indexed)]


def render_transcript(sample: dict[str, Any]) -> str:
    """Serialize one complete conversation without defining chunk boundaries."""
    sample_id = str(sample["sample_id"])
    conversation = sample["conversation"]
    participants = [
        str(conversation.get("speaker_a") or "").strip(),
        str(conversation.get("speaker_b") or "").strip(),
    ]
    lines = [
        f"LoCoMo conversation: {sample_id}",
        "Participants: " + ", ".join(value for value in participants if value),
        "",
    ]
    for session_key in session_keys(conversation):
        match = _SESSION_KEY.fullmatch(session_key)
        assert match is not None
        session_number = int(match.group(1))
        session_date = str(
            conversation.get(f"{session_key}_date_time") or "unknown"
        ).strip()
        for message in conversation[session_key]:
            if not isinstance(message, dict):
                continue
            dia_id = str(message.get("dia_id") or "").strip()
            speaker = str(message.get("speaker") or "unknown").strip()
            content = str(message.get("text") or "").strip()
            if not dia_id or not content:
                continue
            content = content.replace("\r\n", "\n").replace("\r", "\n")
            content = content.replace("\n", "\n  ")
            lines.append(
                f"[DIA_ID={dia_id}] [SESSION={session_number}] "
                f"[DATE={session_date}] {speaker}: {content}"
            )
    lines.append("")
    return "\n".join(lines)


def transcript_fingerprint(sample: dict[str, Any]) -> str:
    return hashlib.sha256(render_transcript(sample).encode("utf-8")).hexdigest()


def document_name(
    sample_id: str, *, dataset_prefix: str, source_sha256: str
) -> str:
    return (
        f"{artifact_stem(dataset_prefix)}-"
        f"{artifact_stem(normalize_sample_id(sample_id))}-{source_sha256[:8]}.txt"
    )


def question_rows(
    samples: list[dict[str, Any]], selection: QuestionSelectionConfig
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    categories = set(selection.categories or [])
    ids = set(selection.ids or [])
    for sample in samples:
        sample_id = str(sample["sample_id"])
        for index, raw in enumerate(sample["qa"]):
            if not isinstance(raw, dict):
                continue
            row = {
                "id": f"qa:{sample_id}/{index}",
                "sample_id": sample_id,
                "conversation_id": sample_id,
                "question": str(raw.get("question") or ""),
                "ground_truth": raw.get("answer"),
                "evidence": [str(value) for value in raw.get("evidence") or []],
                "category": int(raw["category"]),
            }
            if categories and row["category"] not in categories:
                continue
            if ids and row["id"] not in ids:
                continue
            rows.append(row)
    if ids:
        found = {str(row["id"]) for row in rows}
        unknown = sorted(ids - found)
        if unknown:
            raise ValueError(f"unknown LoCoMo question(s): {unknown}")
    if selection.first is not None:
        rows = rows[: selection.first]
    if not rows:
        raise ValueError("no native LoCoMo questions matched the configured selection")
    return rows


def extract_dia_ids(content: str) -> list[str]:
    return list(dict.fromkeys(_DIA_ID.findall(content)))


def case_root(artifact_root: Path, sample_id: str) -> Path:
    return artifact_root.expanduser().resolve() / "cases" / normalize_sample_id(
        sample_id
    )
