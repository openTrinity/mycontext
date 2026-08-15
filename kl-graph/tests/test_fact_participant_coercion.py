"""Off-schema LLM participant fields must be repaired, not crash or vanish.

``ExtractedFact`` contracts ``subject_entity``/``object_entity`` as *single*
names, but real models emit a **list** when one claim has several objects
("A 通知 B、C").  Two failure modes are unacceptable:

* the raw list reaches ``IngestionPipeline._fact_edges``, where
  ``(raw_fact.get("object_entity") or "").strip()`` raises
  ``AttributeError: 'list' object has no attribute 'strip'`` — observed live,
  aborting a whole Phase-B graph build after the LLM spend was already incurred;
* the field is discarded to avoid the crash, silently dropping real participants.

The repair keeps the first name as the scalar and spills the rest into
``involved_entities``, which is exactly where the n-ary ``ABOUT`` fan-out reads
co-equal participants from.  These tests are offline: no LLM, no network, no
stores.
"""

from __future__ import annotations

from kl_graph.ingest.llm_extractor import (
    _validated_result_or_none,
    coerce_fact_participants,
)
from kl_graph.ingest.pipeline import IngestionPipeline, entity_id_from_name
from kl_graph.models.types import Entity, EntityType

FACT_TEXT = "张三通知李四明和王五强风险评估表已更新"


def _entities(*names: str) -> dict[str, Entity]:
    """Build the ``entity_id -> Entity`` map ``_fact_edges`` matches against."""
    return {
        entity_id_from_name(name): Entity(
            id=entity_id_from_name(name), name=name, entity_type=EntityType.PERSON
        )
        for name in names
    }


def test_list_valued_object_entity_is_coerced_and_extras_survive() -> None:
    result = _validated_result_or_none(
        {
            "entities": [
                {"name": "张三", "entity_type": "Person"},
                {"name": "李四明", "entity_type": "Person"},
                {"name": "王五强", "entity_type": "Person"},
            ],
            "facts": [
                {
                    "subject_entity": "张三",
                    "object_entity": ["李四明", "王五强"],
                    "fact_text": FACT_TEXT,
                    "fact_type": "NOTIFY",
                }
            ],
        }
    )
    assert result is not None, "a list-valued object must be repaired, not rejected"
    fact = result["facts"][0]
    assert fact["subject_entity"] == "张三"
    assert fact["object_entity"] == "李四明"
    # The dropped-on-the-floor name must reappear as a co-equal participant.
    assert "王五强" in fact["involved_entities"]


def test_list_valued_subject_entity_is_coerced() -> None:
    result = _validated_result_or_none(
        {
            "entities": [],
            "facts": [
                {
                    "subject_entity": ["李四明", "王五强"],
                    "object_entity": None,
                    "fact_text": FACT_TEXT,
                }
            ],
        }
    )
    assert result is not None
    fact = result["facts"][0]
    assert fact["subject_entity"] == "李四明"
    assert "王五强" in fact["involved_entities"]


def test_compact_chinese_keys_with_list_object_are_coerced() -> None:
    """The repair runs inside compact-key expansion, before validation."""
    result = _validated_result_or_none(
        {
            "实体": [{"名称": "张三", "类型": "Person"}],
            "事实": [{"主体": "张三", "客体": ["李四明", "王五强"], "内容": FACT_TEXT}],
        }
    )
    assert result is not None
    fact = result["facts"][0]
    assert fact["subject_entity"] == "张三"
    assert fact["object_entity"] == "李四明"
    assert "王五强" in fact["involved_entities"]


def test_fact_edges_survives_list_valued_object_from_a_legacy_cache() -> None:
    """A cache row written before the repair must not abort the graph build.

    ``_fact_edges`` also replays the durable extraction cache, so it re-coerces
    rather than trusting its input. Every named participant that became a node
    still gets its ``ABOUT`` edge.
    """
    all_entities = _entities("张三", "李四明", "王五强")
    raw_fact = {
        "fact_text": FACT_TEXT,
        "subject_entity": "张三",
        "object_entity": ["李四明", "王五强"],
    }
    edges = IngestionPipeline._fact_edges("chunk-1", raw_fact, all_entities)
    about_targets = {e.target_id for e in edges if e.target_type == "entity"}
    assert about_targets == set(all_entities), (
        "all three participants must keep an ABOUT edge"
    )


def test_coercion_is_idempotent_on_a_clean_fact() -> None:
    clean = {
        "subject_entity": "张三",
        "object_entity": "李四明",
        "fact_text": FACT_TEXT,
        "involved_entities": ["张三", "李四明"],
    }
    expected = dict(clean)
    coerce_fact_participants(clean)
    coerce_fact_participants(clean)
    assert clean == expected


def test_unusable_participant_values_are_dropped_not_fabricated() -> None:
    """Non-string scalars and empty lists yield no participant, and never crash."""
    fact = {"subject_entity": 123, "object_entity": {"a": 1}, "fact_text": FACT_TEXT}
    coerce_fact_participants(fact)
    assert "subject_entity" not in fact
    assert fact["object_entity"] is None

    empty = {"subject_entity": "张三", "object_entity": [], "fact_text": FACT_TEXT}
    coerce_fact_participants(empty)
    assert empty["object_entity"] is None
    assert empty["subject_entity"] == "张三"
