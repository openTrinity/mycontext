"""Budgeted LLM review for suspicious extracted entities.

Heuristics only rank candidates. They never mutate an entity; every applied
RETYPE or QUARANTINE action comes from a validated LLM decision.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import asdict, dataclass
from typing import Literal

from pydantic import BaseModel

from kl_graph.config import cfg
from kl_graph.models.types import Entity, EntityType, Fact
from kl_graph.utils.litellm_config import connection_from_service, litellm

_GENERIC = re.compile(
    r"^(unknown|none|n/?a|it|this|that|he|she|they|thing|问题|事情|这个|那个|他|她|它)$",
    re.IGNORECASE,
)
_SHAPED = re.compile(r"[/\\]|\.(?:json|yaml|yml|txt|md|py|js|ts|log)$", re.I)
_VALID_ACTIONS = {"KEEP", "RETYPE", "QUARANTINE"}


class CleanupReview(BaseModel):
    """Strict response contract; canonical renaming/merging is not enabled."""

    action: Literal["KEEP", "RETYPE", "QUARANTINE"]
    entity_type: str
    canonical_name: None
    reason: str


@dataclass(frozen=True)
class CleanupCandidate:
    entity_id: str
    name: str
    entity_type: str
    suspicion_score: float
    impact_score: float
    priority: float
    signals: tuple[str, ...]
    evidence: tuple[str, ...]


def rank_cleanup_candidates(
    entities: list[Entity],
    facts: list[Fact],
    *,
    min_score: float = 5.0,
    mention_contexts: dict[str, list[str]] | None = None,
    type_votes: dict[str, set[str]] | None = None,
) -> list[CleanupCandidate]:
    """Rank suspicious entities without making cleanup decisions."""
    fact_text = tuple(f.text[:400] for f in facts)
    candidates: list[CleanupCandidate] = []
    mention_contexts = mention_contexts or {}
    type_votes = type_votes or {}
    for entity in entities:
        score = 0.0
        signals: list[str] = []
        if entity.entity_type is EntityType.UNKNOWN:
            score += 2
            signals.append("fallback_unknown_type")
        if len(type_votes.get(entity.id, set())) > 1:
            score += 3
            signals.append("conflicting_extracted_types")
        if _GENERIC.match(entity.name.strip()):
            score += 3
            signals.append("generic_or_pronoun_name")
        if _SHAPED.search(entity.name) or len(entity.name) > 35:
            score += 2
            signals.append("path_file_or_sentence_shape")
        if entity.mention_count <= 1:
            score += 1
            signals.append("single_occurrence")
        contexts = tuple(mention_contexts.get(entity.id, ()))[:5]
        related_facts = tuple(text for text in fact_text if entity.name in text)[:5]
        evidence = (contexts + related_facts)[:5]
        grounded_contexts = sum(entity.name in context for context in contexts)
        if contexts and grounded_contexts * 2 < len(contexts):
            score += 3
            signals.append("absent_from_most_source_contexts")
        elif not contexts and not related_facts:
            score += 3
            signals.append("absent_from_fact_contexts")
        if score < min_score:
            continue
        impact = float(max(1, entity.mention_count) + len(evidence))
        candidates.append(
            CleanupCandidate(
                entity_id=entity.id,
                name=entity.name,
                entity_type=entity.entity_type.value,
                suspicion_score=score,
                impact_score=impact,
                priority=score * (1 + math.log1p(impact)),
                signals=tuple(signals),
                evidence=evidence,
            )
        )
    return sorted(candidates, key=lambda item: (-item.priority, item.entity_id))


async def review_cleanup_candidates(
    candidates: list[CleanupCandidate], *, budget: int, dry_run: bool
) -> list[dict]:
    """Ask the LLM for one constrained decision per budgeted candidate."""
    connection = connection_from_service(cfg.services.llm_flash)
    decisions: list[dict] = []
    for candidate in candidates[: max(0, budget)]:
        try:
            response = await litellm.acompletion(
                model=connection.model,
                api_base=connection.base_url,
                api_key=connection.api_key,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Review one extracted knowledge-graph entity using only "
                            "the supplied evidence. Return JSON with action KEEP, "
                            "RETYPE, or QUARANTINE; entity_type; canonical_name null; "
                            "and a short grounded reason. Never merge entities."
                        ),
                    },
                    {
                        "role": "user",
                        "content": json.dumps(asdict(candidate), ensure_ascii=False),
                    },
                ],
                response_format={"type": "json_object"},
                temperature=0,
                max_tokens=400,
                timeout=connection.timeout,
            )
            content = (response.choices[0].message.content or "{}").strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[-1]
                content = content.rsplit("```", 1)[0]
            review = CleanupReview.model_validate(json.loads(content))
            raw = review.model_dump()
        except Exception as exc:  # cleanup is optional; fail closed to KEEP
            raw = {
                "action": "KEEP",
                "entity_type": candidate.entity_type,
                "canonical_name": None,
                "reason": f"cleanup review failed: {type(exc).__name__}",
            }
        action = str(raw.get("action", "")).upper()
        if action not in _VALID_ACTIONS:
            action = "KEEP"
        entity_type = str(raw.get("entity_type") or candidate.entity_type)
        if action == "RETYPE" and entity_type not in {t.value for t in EntityType}:
            action = "KEEP"
            entity_type = candidate.entity_type
        decisions.append(
            {
                "entity_id": candidate.entity_id,
                "action": action,
                "entity_type": entity_type,
                "reason": str(raw.get("reason") or ""),
                "dry_run": dry_run,
                "signals": list(candidate.signals),
                "priority": candidate.priority,
                "impact_score": candidate.impact_score,
            }
        )
    return decisions


def apply_cleanup_decisions(
    entities: dict[str, Entity], decisions: list[dict], *, dry_run: bool
) -> None:
    """Apply only validated LLM decisions; dry runs are mutation-free."""
    if dry_run:
        return
    for decision in decisions:
        entity = entities.get(decision["entity_id"])
        if entity is None:
            continue
        if decision["action"] == "RETYPE":
            entity.entity_type = EntityType(decision["entity_type"])
        elif decision["action"] == "QUARANTINE":
            entity.quality_status = "quarantined"
