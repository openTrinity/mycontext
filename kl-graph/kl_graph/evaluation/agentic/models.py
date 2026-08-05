"""Data contracts shared by the Codex harness and scorer."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any


FINAL_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "citations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["fact", "message"]},
                    "id": {"type": "string"},
                },
                "required": ["type", "id"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["answer", "citations"],
    "additionalProperties": False,
}


@dataclass(frozen=True, slots=True)
class AgentCase:
    """The only benchmark fields exposed to a Codex agent."""

    id: str
    question: str


@dataclass(frozen=True, slots=True)
class Citation:
    type: str
    id: str


@dataclass(slots=True)
class AgentResult:
    id: str
    question: str
    category: int
    sample_id: str
    conversation_id: str
    status: str
    answer: str = ""
    citations: list[Citation] = field(default_factory=list)
    thread_id: str | None = None
    turn_id: str | None = None
    model: str | None = None
    duration_ms: int | None = None
    usage: dict[str, Any] | None = None
    transcript_path: str | None = None
    kl_calls: int = 0
    denied_kl_calls: int = 0
    max_kl_calls: int | None = None
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_agent_output(text: str | None) -> tuple[str, list[Citation]]:
    """Parse the SDK's schema-constrained final response defensively."""
    if not text:
        raise ValueError("Codex returned no final response")
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Codex final response is not JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("Codex final response must be a JSON object")
    answer = value.get("answer")
    raw_citations = value.get("citations")
    if not isinstance(answer, str) or not isinstance(raw_citations, list):
        raise ValueError("Codex final response does not match the answer schema")
    citations: list[Citation] = []
    for raw in raw_citations:
        if not isinstance(raw, dict):
            raise ValueError("each citation must be an object")
        citation_type = raw.get("type")
        citation_id = raw.get("id")
        if citation_type not in {"fact", "message"} or not isinstance(citation_id, str):
            raise ValueError("citation type/id is invalid")
        citation_id = citation_id.strip()
        if citation_id:
            citations.append(Citation(type=citation_type, id=citation_id))
    return answer.strip(), citations


def artifact_stem(case_id: str) -> str:
    """Return a stable filename component for a LoCoMo question ID."""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", case_id).strip("._")
    return stem or "case"
