"""Extraction prompts must advertise the graph's actual persisted enums."""

from kl_graph.ingest.llm_extractor import (
    ExtractedEntity,
    ExtractedFact,
    SYSTEM_PROMPT_CN,
    SYSTEM_PROMPT_EN,
)
from kl_graph.ingest.pipeline import map_entity_type, map_fact_type
from kl_graph.models.types import EntityType, FactType


def test_extraction_prompts_and_field_schema_use_canonical_types() -> None:
    entity_types = ", ".join(item.value for item in EntityType)
    fact_types = ", ".join(item.value for item in FactType)

    for prompt in (SYSTEM_PROMPT_EN, SYSTEM_PROMPT_CN):
        assert entity_types in prompt
        assert fact_types in prompt
        assert "Team" not in prompt
        assert "Concept" not in prompt

    entity_description = ExtractedEntity.model_fields["entity_type"].description
    fact_description = ExtractedFact.model_fields["fact_type"].description
    assert entity_types in (entity_description or "")
    assert fact_types in (fact_description or "")


def test_event_and_opinion_are_canonical_but_team_and_concept_are_not() -> None:
    assert map_entity_type("Event") is EntityType.EVENT
    assert map_fact_type("OPINION") is FactType.OPINION
    assert map_entity_type("Team") is EntityType.ORGANIZATION
    assert map_entity_type("Concept") is EntityType.UNKNOWN


def test_extraction_prompts_include_contrastive_quoted_reply_guidance() -> None:
    assert "QUOTED-REPLY RULES:" in SYSTEM_PROMPT_EN
    assert "CORRECT:" in SYSTEM_PROMPT_EN
    assert "INCORRECT:" in SYSTEM_PROMPT_EN
    assert "引用回复规则：" in SYSTEM_PROMPT_CN
    assert "正确：" in SYSTEM_PROMPT_CN
    assert "错误：" in SYSTEM_PROMPT_CN
    for prompt in (SYSTEM_PROMPT_EN, SYSTEM_PROMPT_CN):
        assert "gpt5.6" in prompt
        assert "opus" in prompt
