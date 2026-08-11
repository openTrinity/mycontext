"""Resolve KL evidence into LoCoMo source-message and dialogue IDs."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


class CitationLike(Protocol):
    """Structural citation contract accepted from any evaluation runner."""

    type: str
    id: str


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
        if (
            row.get("record_type") != "codex_event"
            or row.get("method") != "item/completed"
        ):
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


def citation_references(
    citations: Iterable[CitationLike],
) -> list[EvidenceReference]:
    return _dedupe_references(
        EvidenceReference(type=citation.type, id=citation.id) for citation in citations
    )


def ask_response_references(
    response: dict[str, Any],
    *,
    include_items: bool = True,
    include_graph: bool = True,
) -> list[EvidenceReference]:
    """Return evidence exposed by one ``kl ask`` response.

    ``items`` are the hybrid retrieval results consumed by KL's optional
    synthesis step. ``nodes`` are the resolved graph-walk results returned by
    the same request. Seeds and expandable nodes are intentionally omitted:
    they are navigation metadata and duplicate nodes already present in the
    resolved graph view.
    """
    sections: list[Any] = []
    if include_items:
        sections.append(response.get("items") or [])
    if include_graph:
        sections.append(response.get("nodes") or [])
    return _dedupe_references(_references_from_value(sections))


class EvidenceResolver:
    """Resolve current-ingest Chunk/Fact IDs to original LoCoMo messages.

    Current LoCoMo ingest stores one *conversation slice* per ``chunks`` row.
    Its deterministic UUID is not a LoCoMo source-message ID; the original
    message IDs live in ``metadata.member_message_ids``.  A Fact points at that
    slice through ``facts.source_chunk_id``.  The evaluator therefore expands
    either a Chunk citation or a Fact citation back to every original member
    message before joining against LoCoMo ``dia_id`` Gold evidence.

    A one-message-per-chunk database remains supported: when
    ``member_message_ids`` is absent, the chunk ID itself is treated as the
    source-message ID.
    """

    def __init__(self, sqlite_path: Path, dia_id_by_message: dict[str, str]):
        uri = f"{sqlite_path.resolve().as_uri()}?mode=ro"
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
        observation_rank_by_chunk: dict[str, int] = {}
        for reference in references:
            chunk_id = self._source_chunk_id(reference)
            if not chunk_id:
                continue
            if chunk_id not in observation_rank_by_chunk:
                observation_rank_by_chunk[chunk_id] = len(observation_rank_by_chunk) + 1
            observation_rank = observation_rank_by_chunk[chunk_id]
            row = self.conn.execute(
                "SELECT metadata, "
                "json_extract(metadata, '$.conversation_id') AS conversation_id "
                "FROM chunks WHERE id = ?",
                (chunk_id,),
            ).fetchone()
            if row is None:
                continue
            conversation_id = str(row["conversation_id"] or "")
            source_ids = _member_message_ids(row["metadata"], chunk_id)
            for source_id in source_ids:
                if source_id in seen_sources:
                    continue
                seen_sources.add(source_id)
                dia_id = None
                if _conversation_matches(conversation_id, evidence_conversation_id):
                    dia_id = self.dia_id_by_message.get(source_id)
                records.append(
                    {
                        "reference_type": reference.type,
                        "reference_id": reference.id,
                        "source_chunk_id": chunk_id,
                        "source_message_id": source_id,
                        "observation_rank": observation_rank,
                        "conversation_id": conversation_id,
                        "dia_id": dia_id,
                    }
                )
        return records

    def _source_chunk_id(self, reference: EvidenceReference) -> str | None:
        value = reference.id
        if reference.type in {"chunk", "message"}:
            return value
        if value.startswith("fact:"):
            value = value.split(":", 1)[1]
        row = self.conn.execute(
            "SELECT source_chunk_id FROM facts WHERE id = ? OR id LIKE ? LIMIT 1",
            (value, f"{value}%"),
        ).fetchone()
        return str(row["source_chunk_id"]) if row else None


class ConversationEvidenceResolver:
    """Open the physical graph selected by each LoCoMo conversation ID."""

    def __init__(
        self,
        graph_data_dirs: dict[str, Path],
        dia_id_by_message: dict[str, str],
    ):
        self.graph_data_dirs = graph_data_dirs
        self.dia_id_by_message = dia_id_by_message
        self._resolvers: dict[str, EvidenceResolver] = {}

    def close(self) -> None:
        for resolver in self._resolvers.values():
            resolver.close()
        self._resolvers.clear()

    def resolve(
        self,
        references: Iterable[EvidenceReference],
        evidence_conversation_id: str,
    ) -> list[dict[str, Any]]:
        resolver = self._resolvers.get(evidence_conversation_id)
        if resolver is None:
            data_dir = self.graph_data_dirs.get(evidence_conversation_id)
            if data_dir is None:
                raise KeyError(
                    f"no physical graph for conversation {evidence_conversation_id}"
                )
            sqlite_path = data_dir / "knowledge.db"
            if not sqlite_path.is_file():
                raise FileNotFoundError(sqlite_path)
            resolver = EvidenceResolver(sqlite_path, self.dia_id_by_message)
            self._resolvers[evidence_conversation_id] = resolver
        return resolver.resolve(references, evidence_conversation_id)


def _conversation_matches(stored: str, expected: str) -> bool:
    """Accept legacy IDs and main's source-namespaced conversation IDs."""
    return stored == expected or stored == f"locomo-{expected}:{expected}"


def _parse_json_output(output: str) -> Any | None:
    if not output:
        return None
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        pass
    start_candidates = [
        position for position in (output.find("{"), output.find("[")) if position >= 0
    ]
    if not start_candidates:
        return None
    start = min(start_candidates)
    for end in range(len(output), start, -1):
        try:
            return json.loads(output[start:end])
        except json.JSONDecodeError:
            continue
    return None


def _references_from_value(
    value: Any, parent_key: str | None = None
) -> list[EvidenceReference]:
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

    for key in ("source_chunk_id", "chunk_id"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            found.append(EvidenceReference("chunk", candidate))

    candidate_id = value.get("id")
    item_type = str(value.get("type") or "").lower()
    if isinstance(candidate_id, str):
        # ``cnk:`` is the current chunk node prefix; ``msg:`` is the retired one
        # kept so previously captured transcripts still resolve.
        if (
            candidate_id.startswith("msg:")
            or item_type == "message"
            or parent_key in {"message", "messages", "source_message"}
        ):
            found.append(EvidenceReference("message", candidate_id))
        elif (
            candidate_id.startswith("cnk:")
            or item_type == "chunk"
            or parent_key
            in {
                "chunk",
                "chunks",
                "source_chunk",
            }
        ):
            found.append(EvidenceReference("chunk", candidate_id))
        elif (
            candidate_id.startswith("fact:")
            or item_type == "fact"
            or parent_key == "facts"
            or {"text", "confidence"}.issubset(value)
        ):
            found.append(EvidenceReference("fact", candidate_id))

    fact_id = value.get("fact_id")
    if isinstance(fact_id, str) and fact_id:
        found.append(EvidenceReference("fact", fact_id))

    for key, nested in value.items():
        found.extend(_references_from_value(nested, key))
    return found


def _member_message_ids(raw_metadata: Any, chunk_id: str) -> list[str]:
    """Return original message IDs represented by one current-ingest chunk."""
    if isinstance(raw_metadata, str) and raw_metadata:
        try:
            metadata = json.loads(raw_metadata)
        except json.JSONDecodeError:
            metadata = {}
    elif isinstance(raw_metadata, dict):
        metadata = raw_metadata
    else:
        metadata = {}
    members = metadata.get("member_message_ids")
    if not isinstance(members, list):
        return [chunk_id]
    result: list[str] = []
    seen: set[str] = set()
    for member in members:
        value = str(member).strip() if member is not None else ""
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result or [chunk_id]


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
