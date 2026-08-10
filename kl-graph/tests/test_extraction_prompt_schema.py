"""Extraction prompts must advertise the graph's actual persisted enums."""

from kl_graph.ingest.llm_extractor import (
    ExtractedEntity,
    ExtractedFact,
    SYSTEM_PROMPT_CN,
    SYSTEM_PROMPT_EN,
)
from kl_graph.models.types import EntityType, FactType


def test_extraction_prompts_and_field_schema_use_canonical_types() -> None:
    entity_types = ", ".join(item.value for item in EntityType)
    fact_types = ", ".join(item.value for item in FactType)

    for prompt in (SYSTEM_PROMPT_EN, SYSTEM_PROMPT_CN):
        assert entity_types in prompt
        assert fact_types in prompt
        assert "Concept" not in prompt
        assert "OPINION" not in prompt

    entity_description = ExtractedEntity.model_fields["entity_type"].description
    fact_description = ExtractedFact.model_fields["fact_type"].description
    assert entity_types in (entity_description or "")
    assert fact_types in (fact_description or "")
