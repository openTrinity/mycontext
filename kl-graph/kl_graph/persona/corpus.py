"""Lineage-aware read model for deterministic persona construction.

Persona attribution is source-unit based. Chunk-level ``AUTHORED_BY`` cannot
identify the author of one fact because a session slice can contain messages
from several people.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from kl_graph.persona.config import PersonaSettings
from kl_graph.storage.base import KnowledgeStore

_MESSAGE_HEADER = re.compile(r"(?m)(?=^\[(?:私聊|群聊)(?::[^\]]*)?\])")
_CONTINUATION = re.compile(r"^\[消息续段\s+\d+/\d+\]\s*", re.MULTILINE)


@dataclass(frozen=True)
class PersonaMessage:
    """One deduplicated source message used for persona measurements."""

    source_id: str
    unit_id: str
    text: str
    timestamp: int
    sender_name: str
    sender_id: str
    conversation_id: str
    chunk_ids: tuple[str, ...] = ()

    @property
    def key(self) -> tuple[str, str]:
        return self.source_id, self.unit_id


@dataclass
class InterlocutorCorpus:
    """Messages used to model ego's register with one graph Person entity."""

    entity_id: str
    entity_name: str
    ego_messages: list[PersonaMessage] = field(default_factory=list)
    interlocutor_messages: list[PersonaMessage] = field(default_factory=list)


@dataclass(frozen=True)
class StanceFact:
    fact_id: str
    topic_entity_id: str
    text: str
    fact_type: str
    timestamp: int
    confidence: float
    source_unit_id: str


def _json_object(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _message_body(rendered: str) -> str:
    """Remove the retrieval header and quoted-reply context from one message."""

    rendered = rendered.removeprefix("SESSION_BREAK\n").strip()
    rendered = _CONTINUATION.sub("", rendered).strip()
    lines = rendered.splitlines()
    if lines and re.match(r"^\[(?:私聊|群聊)(?::[^\]]*)?\]", lines[0]):
        lines = lines[1:]
    if lines and lines[0].startswith("↳ 回复"):
        lines = lines[1:]
    return "\n".join(lines).strip()


def _segment_for_membership(
    content: str, member_ordinal: int, member_count: int
) -> str:
    """Best-effort fallback when a stored extraction target is unavailable."""

    parts = [part.strip() for part in _MESSAGE_HEADER.split(content) if part.strip()]
    if len(parts) == member_count and member_ordinal < len(parts):
        return _message_body(parts[member_ordinal])
    if member_count == 1:
        return _message_body(content)
    return ""


class PersonaCorpusReader:
    """Read persona evidence without extending the shared storage interface."""

    def __init__(self, store: KnowledgeStore, settings: PersonaSettings) -> None:
        settings.validate_owner()
        self.store = store
        self.settings = settings

    def _is_owner(self, sender_name: str, sender_id: str) -> bool:
        if self.settings.owner_sender_id:
            return sender_id == self.settings.owner_sender_id
        return sender_name == self.settings.owner_name

    def messages(self) -> list[PersonaMessage]:
        """Reconstruct each chat source unit once, even across overlapping chunks."""

        rows = self.store.sql_conn.execute(
            """
            SELECT u.source_id, u.unit_id, u.timestamp, u.metadata AS unit_metadata,
                   cu.chunk_id, cu.unit_ordinal_in_chunk, cu.chunk_ordinal_in_unit,
                   c.content, c.metadata AS chunk_metadata
            FROM units u
            JOIN chunk_units cu
              ON cu.source_id=u.source_id
             AND cu.source_type=u.source_type
             AND cu.unit_id=u.unit_id
            JOIN chunks c ON c.id=cu.chunk_id
            WHERE u.source_type='message'
            ORDER BY u.source_id, u.unit_id, cu.chunk_ordinal_in_unit
            """
        ).fetchall()

        grouped: dict[tuple[str, str], list[Any]] = {}
        for row in rows:
            grouped.setdefault((str(row["source_id"]), str(row["unit_id"])), []).append(row)

        messages: list[PersonaMessage] = []
        for (source_id, unit_id), memberships in grouped.items():
            unit_meta = _json_object(memberships[0]["unit_metadata"])
            full_candidates: list[str] = []
            fragments: list[str] = []
            chunk_ids: list[str] = []
            for row in memberships:
                chunk_ids.append(str(row["chunk_id"]))
                chunk_meta = _json_object(row["chunk_metadata"])
                member_ids = [str(value) for value in chunk_meta.get("member_message_ids", [])]
                targets = chunk_meta.get("extraction_target_contents", [])
                if unit_id in member_ids:
                    index = member_ids.index(unit_id)
                    if isinstance(targets, list) and index < len(targets) and targets[index]:
                        full_candidates.append(_message_body(str(targets[index])))
                        continue
                fragment = _segment_for_membership(
                    str(row["content"]),
                    int(row["unit_ordinal_in_chunk"]),
                    max(len(member_ids), 1),
                )
                if fragment:
                    fragments.append(fragment)

            text = max(full_candidates, key=len, default="")
            if not text:
                text = "\n".join(dict.fromkeys(fragments)).strip()
            if not text:
                continue
            messages.append(
                PersonaMessage(
                    source_id=source_id,
                    unit_id=unit_id,
                    text=text,
                    timestamp=int(memberships[0]["timestamp"] or 0),
                    sender_name=str(unit_meta.get("sender") or ""),
                    sender_id=str(unit_meta.get("sender_id") or ""),
                    conversation_id=str(unit_meta.get("conversation_id") or ""),
                    chunk_ids=tuple(dict.fromkeys(chunk_ids)),
                )
            )
        return messages

    def _person_entity(self, sender_name: str) -> tuple[str, str] | None:
        if not sender_name:
            return None
        row = self.store.sql_conn.execute(
            """SELECT id, name FROM entities
               WHERE name=? COLLATE NOCASE AND entity_type='Person'
                 AND quality_status='active'
               ORDER BY mention_count DESC LIMIT 1""",
            (sender_name,),
        ).fetchone()
        return (str(row["id"]), str(row["name"])) if row else None

    def interlocutor_corpora(self) -> list[InterlocutorCorpus]:
        """Build private-scope and group-window corpora for every interlocutor."""

        all_messages = self.messages()
        by_conversation: dict[str, list[PersonaMessage]] = {}
        for message in all_messages:
            by_conversation.setdefault(message.conversation_id, []).append(message)

        accumulated: dict[str, InterlocutorCorpus] = {}
        ego_seen: dict[str, set[tuple[str, str]]] = {}
        other_seen: dict[str, set[tuple[str, str]]] = {}
        for conversation in by_conversation.values():
            ego = [message for message in conversation if self._is_owner(message.sender_name, message.sender_id)]
            others = [message for message in conversation if not self._is_owner(message.sender_name, message.sender_id)]
            participant_names = {message.sender_name for message in conversation if message.sender_name}
            is_private = len(participant_names) == 2
            for sender_name in {message.sender_name for message in others if message.sender_name}:
                entity = self._person_entity(sender_name)
                if entity is None:
                    continue
                entity_id, entity_name = entity
                other_messages = [message for message in others if message.sender_name == sender_name]
                if is_private:
                    relevant_ego = ego
                else:
                    other_chunks = {chunk_id for message in other_messages for chunk_id in message.chunk_ids}
                    relevant_ego = [
                        message for message in ego if other_chunks.intersection(message.chunk_ids)
                    ]
                corpus = accumulated.setdefault(
                    entity_id, InterlocutorCorpus(entity_id, entity_name)
                )
                ego_keys = ego_seen.setdefault(entity_id, set())
                other_keys = other_seen.setdefault(entity_id, set())
                for message in relevant_ego:
                    if message.key not in ego_keys:
                        corpus.ego_messages.append(message)
                        ego_keys.add(message.key)
                for message in other_messages:
                    if message.key not in other_keys:
                        corpus.interlocutor_messages.append(message)
                        other_keys.add(message.key)
        return list(accumulated.values())

    def stance_facts(self) -> list[StanceFact]:
        """Return ego-authored stance facts using fact-to-source-unit lineage.

        NOTE (refactor requested): this join treats ``f.source_unit_id`` as
        precise per-message attribution, but that is a best-effort, non-interface
        signal — under whole-chunk extraction (chunking × extraction = *×chunk)
        a fact spans a session slice and ``source_unit_id`` is NULL, so the
        ``IS NOT NULL`` filter below silently drops every chunk-extracted fact.
        Do not build new behavior on this column as an interface. Persona should
        derive topic/stance evidence from raw ego messages (``self.messages()``)
        rather than from fact lineage; rework this query accordingly.
        """

        rows = self.store.sql_conn.execute(
            """
            SELECT DISTINCT f.id, f.text, f.fact_type, f.timestamp, f.confidence,
                   f.source_unit_id, u.metadata AS unit_metadata,
                   about.target_id AS topic_entity_id
            FROM facts f
            JOIN chunk_units cu
              ON cu.chunk_id=f.source_chunk_id
             AND cu.source_type='message'
             AND cu.unit_id=f.source_unit_id
            JOIN units u
              ON u.source_id=cu.source_id
             AND u.source_type=cu.source_type
             AND u.unit_id=cu.unit_id
            JOIN edges about
              ON about.source_type='fact' AND about.source_id=f.id
             AND about.edge_type='ABOUT' AND about.target_type='entity'
            JOIN entities topic ON topic.id=about.target_id
            WHERE f.fact_type IN ('DECISION', 'CAUSAL', 'OPINION')
              AND f.source_unit_id IS NOT NULL
              AND topic.quality_status='active'
            ORDER BY f.timestamp DESC
            """
        ).fetchall()
        facts: list[StanceFact] = []
        seen: set[tuple[str, str]] = set()
        for row in rows:
            metadata = _json_object(row["unit_metadata"])
            if not self._is_owner(
                str(metadata.get("sender") or ""),
                str(metadata.get("sender_id") or ""),
            ):
                continue
            key = (str(row["id"]), str(row["topic_entity_id"]))
            if key in seen:
                continue
            seen.add(key)
            facts.append(
                StanceFact(
                    fact_id=key[0],
                    topic_entity_id=key[1],
                    text=str(row["text"]),
                    fact_type=str(row["fact_type"]),
                    timestamp=int(row["timestamp"] or 0),
                    confidence=float(row["confidence"] or 0.0),
                    source_unit_id=str(row["source_unit_id"]),
                )
            )
        return facts
