"""Recover evidence IDs from Codex citations and KL command transcripts."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .models import Citation


@dataclass(frozen=True, slots=True)
class EvidenceReference:
    type: str
    id: str


def transcript_references(path: Path) -> list[EvidenceReference]:
    """Return message/fact references in first-observation order."""
    references: list[EvidenceReference] = []
    if not path.is_file():
        return references
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("record_type") != "codex_event" or row.get("method") != "item/completed":
            continue
        payload = row.get("payload") or {}
        item = payload.get("item") or {}
        if isinstance(item, dict) and "root" in item:
            item = item["root"]
        if not isinstance(item, dict) or item.get("type") != "commandExecution":
            continue
        command = str(item.get("command") or "")
        if "./kl" not in command:
            continue
        output = str(item.get("aggregatedOutput") or "").strip()
        value = _parse_json_output(output)
        if value is not None:
            references.extend(_references_from_value(value))
    return _dedupe_references(references)


def citation_references(citations: Iterable[Citation]) -> list[EvidenceReference]:
    return _dedupe_references(
        EvidenceReference(type=citation.type, id=citation.id) for citation in citations
    )


class EvidenceResolver:
    """Resolve Fact IDs to source messages without exposing the DB to agents."""

    def __init__(self, sqlite_path: Path, dia_id_by_message: dict[str, str]):
        uri = f"file:{sqlite_path.resolve()}?mode=ro"
        self.conn = sqlite3.connect(uri, uri=True)
        self.conn.row_factory = sqlite3.Row
        self.dia_id_by_message = dia_id_by_message

    def close(self) -> None:
        self.conn.close()

    def resolve(
        self,
        references: Iterable[EvidenceReference],
        evidence_conversation_id: str,
    ) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        seen_sources: set[str] = set()
        for reference in references:
            source_id = self._source_message_id(reference)
            if not source_id or source_id in seen_sources:
                continue
            row = self.conn.execute(
                "SELECT conversation_id FROM messages WHERE id = ?", (source_id,)
            ).fetchone()
            if row is None:
                continue
            seen_sources.add(source_id)
            conversation_id = str(row["conversation_id"])
            dia_id = None
            if conversation_id == evidence_conversation_id:
                dia_id = self.dia_id_by_message.get(source_id)
            records.append({
                "reference_type": reference.type,
                "reference_id": reference.id,
                "source_message_id": source_id,
                "conversation_id": conversation_id,
                "dia_id": dia_id,
            })
        return records

    def _source_message_id(self, reference: EvidenceReference) -> str | None:
        value = reference.id
        if reference.type == "message":
            return value
        if value.startswith("fact:"):
            value = value.split(":", 1)[1]
        row = self.conn.execute(
            "SELECT source_message_id FROM facts WHERE id = ? OR id LIKE ? LIMIT 1",
            (value, f"{value}%"),
        ).fetchone()
        return str(row["source_message_id"]) if row else None


def _parse_json_output(output: str) -> Any | None:
    if not output:
        return None
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        pass
    start_candidates = [position for position in (output.find("{"), output.find("[")) if position >= 0]
    if not start_candidates:
        return None
    start = min(start_candidates)
    for end in range(len(output), start, -1):
        try:
            return json.loads(output[start:end])
        except json.JSONDecodeError:
            continue
    return None


def _references_from_value(value: Any, parent_key: str | None = None) -> list[EvidenceReference]:
    found: list[EvidenceReference] = []
    if isinstance(value, list):
        for item in value:
            found.extend(_references_from_value(item, parent_key))
        return found
    if not isinstance(value, dict):
        return found

    for key in ("source_message_id", "message_id", "msg_id"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            found.append(EvidenceReference("message", candidate))

    candidate_id = value.get("id")
    item_type = str(value.get("type") or "").lower()
    if isinstance(candidate_id, str):
        if candidate_id.startswith("msg:") or item_type == "message":
            found.append(EvidenceReference("message", candidate_id))
        elif candidate_id.startswith("fact:") or item_type == "fact":
            found.append(EvidenceReference("fact", candidate_id))
        elif parent_key == "facts" or {"text", "confidence"}.issubset(value):
            found.append(EvidenceReference("fact", candidate_id))

    fact_id = value.get("fact_id")
    if isinstance(fact_id, str) and fact_id:
        found.append(EvidenceReference("fact", fact_id))

    for key, nested in value.items():
        found.extend(_references_from_value(nested, key))
    return found


def _dedupe_references(
    references: Iterable[EvidenceReference],
) -> list[EvidenceReference]:
    result: list[EvidenceReference] = []
    seen: set[tuple[str, str]] = set()
    for reference in references:
        key = (reference.type, reference.id)
        if not reference.id or key in seen:
            continue
        seen.add(key)
        result.append(reference)
    return result
