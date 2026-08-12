"""Resolve KL evidence into LoCoMo source-message and dialogue IDs."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol


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
    synthesis step. Graph evidence is read from the current response contract,
    ``graph.components[].nodes``. Seeds and expandable nodes are intentionally
    omitted: they are navigation metadata. Top-level ``recalled_chunks`` are
    also omitted because they are graph-walk hydration, not an independent
    ranked retrieval channel; readable chunks already occur in component
    nodes.
    """
    sections: list[Any] = []
    if include_items:
        sections.append(response.get("items") or [])
    if include_graph:
        graph = response.get("graph")
        if isinstance(graph, dict):
            components = graph.get("components")
            if isinstance(components, list):
                for component in components:
                    if isinstance(component, dict):
                        sections.append(component.get("nodes") or [])
    return _dedupe_references(_references_from_value(sections))


FactResolution = Literal["source_unit", "chunk_members"]


class EvidenceResolver:
    """Resolve current-ingest Chunk/Fact IDs to original LoCoMo messages.

    Current LoCoMo ingest stores one *conversation slice* per ``chunks`` row.
    Its deterministic UUID is not a LoCoMo source-message ID; the original
    message IDs live in ``metadata.member_message_ids``. A Fact points at its
    exact originating message through ``facts.source_unit_id`` and at the
    containing slice through ``facts.source_chunk_id``. Current evaluation uses
    the exact source unit for Facts; whole-chunk Fact expansion remains
    available only for comparison with legacy scores and databases.

    A one-message-per-chunk database remains supported: when
    ``member_message_ids`` is absent, the chunk ID itself is treated as the
    source-message ID.
    """

    def __init__(self, sqlite_path: Path, dia_id_by_message: dict[str, str]):
        uri = f"{sqlite_path.resolve().as_uri()}?mode=ro"
        self.conn = sqlite3.connect(uri, uri=True)
        self.conn.row_factory = sqlite3.Row
        self.dia_id_by_message = dia_id_by_message
        fact_columns = {
            str(row["name"])
            for row in self.conn.execute("PRAGMA table_info(facts)").fetchall()
        }
        self._facts_have_source_unit_id = "source_unit_id" in fact_columns

    def close(self) -> None:
        self.conn.close()

    def resolve(
        self,
        references: Iterable[EvidenceReference],
        evidence_conversation_id: str,
        *,
        fact_resolution: FactResolution = "source_unit",
    ) -> list[dict[str, Any]]:
        if fact_resolution not in {"source_unit", "chunk_members"}:
            raise ValueError(f"unknown Fact resolution mode: {fact_resolution}")
        records: list[dict[str, Any]] = []
        seen_records: set[tuple[str, str, str]] = set()
        for observation_rank, reference in enumerate(references, start=1):
            fact_id: str | None = None
            source_unit_id: str | None = None
            if reference.type in {"chunk", "message"}:
                chunk_id = _strip_node_prefix(reference.id, "cnk")
            else:
                fact = self._fact_source(reference)
                if fact is None:
                    continue
                fact_id = str(fact["id"])
                chunk_id = str(fact["source_chunk_id"] or "")
                if self._facts_have_source_unit_id and fact["source_unit_id"]:
                    source_unit_id = str(fact["source_unit_id"])
            if not chunk_id:
                continue
            row = self.conn.execute(
                "SELECT metadata, "
                "json_extract(metadata, '$.conversation_id') AS conversation_id "
                "FROM chunks WHERE id = ?",
                (chunk_id,),
            ).fetchone()
            if row is None:
                continue
            conversation_id = str(row["conversation_id"] or "")
            use_exact_fact_source = (
                reference.type == "fact"
                and fact_resolution == "source_unit"
                and source_unit_id is not None
            )
            source_ids = (
                [source_unit_id]
                if use_exact_fact_source
                else _member_message_ids(row["metadata"], chunk_id)
            )
            resolution = (
                "fact_source_unit"
                if use_exact_fact_source
                else (
                    "fact_chunk_members_legacy"
                    if reference.type == "fact"
                    else "chunk_members"
                )
            )
            for source_id in source_ids:
                record_key = (reference.type, reference.id, source_id)
                if record_key in seen_records:
                    continue
                seen_records.add(record_key)
                dia_id = None
                if _conversation_matches(conversation_id, evidence_conversation_id):
                    dia_id = self.dia_id_by_message.get(source_id)
                records.append(
                    {
                        "reference_type": reference.type,
                        "reference_id": reference.id,
                        "cited_fact_id": fact_id,
                        "source_chunk_id": chunk_id,
                        "source_unit_id": source_unit_id,
                        "source_message_id": source_id,
                        "resolution": resolution,
                        "observation_rank": observation_rank,
                        "conversation_id": conversation_id,
                        "dia_id": dia_id,
                    }
                )
        return records

    def _fact_source(self, reference: EvidenceReference) -> sqlite3.Row | None:
        """Resolve an exact Fact ID, allowing only an unambiguous old prefix."""
        value = _strip_node_prefix(reference.id, "fact")
        source_unit_select = (
            "source_unit_id"
            if self._facts_have_source_unit_id
            else "NULL AS source_unit_id"
        )
        select = f"SELECT id, source_chunk_id, {source_unit_select} FROM facts"
        row = self.conn.execute(f"{select} WHERE id = ?", (value,)).fetchone()
        if row is not None:
            return row
        escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = self.conn.execute(
            f"{select} WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 2",
            (f"{escaped}%",),
        ).fetchall()
        if len(rows) > 1:
            raise ValueError(f"ambiguous Fact ID prefix: {reference.id}")
        return rows[0] if rows else None


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
        *,
        fact_resolution: FactResolution = "source_unit",
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
        return resolver.resolve(
            references,
            evidence_conversation_id,
            fact_resolution=fact_resolution,
        )


def _conversation_matches(stored: str, expected: str) -> bool:
    """Accept legacy IDs and main's source-namespaced conversation IDs."""
    return stored == expected or stored == f"locomo-{expected}:{expected}"


def _strip_node_prefix(value: str, prefix: str) -> str:
    marker = f"{prefix}:"
    return value.removeprefix(marker)


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
