"""Extraction prompts must advertise the graph's actual persisted enums."""

from kl_graph.ingest.llm_extractor import (
    SYSTEM_PROMPT_CN,
    SYSTEM_PROMPT_EN,
    ExtractedEntity,
    ExtractedFact,
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
    assert map_fact_type("ACTION_ITEM") is FactType.ACTION_ITEM
    assert map_fact_type("TASK") is FactType.ACTION_ITEM
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


def test_extraction_prompts_use_action_item_hard_gates() -> None:
    english = " ".join(SYSTEM_PROMPT_EN.split())
    chinese = "".join(SYSTEM_PROMPT_CN.split())
    assert "resolved by a simple reply" in english
    assert "explicitly asks or assigns" in english
    assert "actual actor" in english
    assert "still outstanding" in english
    assert "observable completion result" in english
    assert "I'll check/chase it" in english
    assert "通过简单回复结束" in chinese
    assert "明确要求或指派" in chinese
    assert "实际执行人" in chinese
    assert "动作尚未完成" in chinese
    assert "可观察的完成结果" in chinese
    assert "我催一下" in chinese
    assert "sending a file or key" not in english
    assert "发送文件或密钥" not in chinese
