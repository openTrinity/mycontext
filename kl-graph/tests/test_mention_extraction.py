"""Offline unit tests for the @-mention / entity-name sanitizer.

Exercises the pure helpers ``_clean_mention`` and ``_normalize_result`` in
``kl_graph.ingest.llm_extractor`` with synthetic data only. No network, no LLM,
no API key required — these must run hermetically and fast.
"""

from __future__ import annotations

from kl_graph.ingest.llm_extractor import (
    _clean_mention,
    _expand_compact_result,
    _normalize_result,
)

# ─── _clean_mention ──────────────────────────────────────────────────────


def test_strips_leading_at():
    assert _clean_mention("@李娜") == "李娜"


def test_strips_trailing_punctuation():
    assert _clean_mention("@李强，") == "李强"
    assert _clean_mention("李强。") == "李强"
    assert _clean_mention("@李娜，。") == "李娜"
    # Mixed ASCII/CJK trailing punctuation.
    assert _clean_mention("InkFlow!") == "InkFlow"


def test_broadcast_tokens_dropped():
    for tok in ("@所有人", "@全体成员", "@全体", "@all", "@here", "@everyone", "@channel"):
        assert _clean_mention(tok) is None, tok
    # Bare (no @) broadcast tokens are dropped too.
    assert _clean_mention("所有人") is None
    # ASCII broadcast tokens are case-insensitive.
    assert _clean_mention("@ALL") is None
    assert _clean_mention("Everyone") is None


def test_media_id_shapes_dropped():
    # Realistic DingTalk media tokens are long opaque base64-ish blobs. They
    # either start with the known ``lQ``/``lA`` prefix or have the random-blob
    # signature (>=20 chars, no separators, upper+lower+digit mix).
    assert _clean_mention("@lQLPKGS2kqdzkgtaVLCpORJ") is None
    # Another realistic long opaque DingTalk media token (contains ``_``, but
    # the ``lQ`` prefix rule still catches it).
    assert _clean_mention("@lQLPJv_W66p1KbvNBuDNBRywrcsK") is None
    # ``lA``-prefixed media token, realistically long (>= 20 chars).
    assert _clean_mention("lADPabc123DEF456ghiJKL789") is None
    # Prefix-less random blob (>= 20 chars, upper+lower+digit, no separators).
    assert _clean_mention("aB3xY9zQ1wE7rT5uI2oP8kL") is None


def test_legit_long_ascii_handles_survive():
    # Ordinary long ASCII names/handles must NOT be mistaken for media ids:
    #  - ``Engineering_Team`` has a ``_`` separator (blob rule needs none).
    #  - ``ChristopherLee`` has no digit (blob rule needs upper+lower+digit).
    # Neither starts with the ``lQ``/``lA`` media prefix.
    assert _clean_mention("Engineering_Team") == "Engineering_Team"
    assert _clean_mention("ChristopherLee") == "ChristopherLee"
    # A hyphenated handle over the old 12-char threshold also survives.
    assert _clean_mention("data-platform-team") == "data-platform-team"
    # An all-lower long word (no upper, no digit) survives.
    assert _clean_mention("reinforcementlearning") == "reinforcementlearning"


def test_normal_names_unchanged():
    assert _clean_mention("张伟") == "张伟"
    assert _clean_mention("InkFlow") == "InkFlow"
    assert _clean_mention("@张伟") == "张伟"


def test_alias_form_retained():
    # Parens + CJK present → not a media shape, must be retained (not dropped).
    assert _clean_mention("刘洋(刘洋)") == "刘洋(刘洋)"
    assert _clean_mention("@陈静(小刘)") == "陈静(小刘)"


def test_short_ascii_name_not_media():
    # Under the 12-char media threshold → kept even though ASCII-only.
    assert _clean_mention("Bob") == "Bob"
    assert _clean_mention("Qwen") == "Qwen"


def test_non_string_and_empty_dropped():
    assert _clean_mention("") is None
    assert _clean_mention("@") is None
    assert _clean_mention("，。") is None
    assert _clean_mention(None) is None  # type: ignore[arg-type]
    assert _clean_mention(123) is None  # type: ignore[arg-type]


# ─── _normalize_result ─────────────────────────────────────────────────────


def test_normalize_scrubs_entities_and_involved():
    raw = {
        "entities": [
            {"name": "@李娜", "entity_type": "Person"},
            {"name": "@所有人", "entity_type": "Person"},  # broadcast → dropped
            {"name": "@lQLPKGS2kqdzkgtaVLCpORJ", "entity_type": "Person"},  # media id → dropped
            {"name": "李强。", "entity_type": "Person"},  # trailing punct
        ],
        "facts": [
            {
                "subject_entity": "李娜",
                "object_entity": None,
                "involved_entities": [
                    "@李娜",
                    "@李强",
                    "@所有人",  # broadcast → dropped
                    "李娜",  # duplicate of cleaned "@李娜" → deduped
                ],
                "fact_text": "李娜和李强两人负责测评任务",
            }
        ],
    }

    _normalize_result(raw)

    # Entities: broadcast + media dropped, names cleaned.
    names = [e["name"] for e in raw["entities"]]
    assert names == ["李娜", "李强"]

    # involved_entities: cleaned, broadcast dropped, deduped, order-preserving.
    involved = raw["facts"][0]["involved_entities"]
    assert involved == ["李娜", "李强"]


def test_normalize_defensive_on_malformed():
    # Missing keys, None, and non-dict members must not crash.
    assert _normalize_result({}) == {}
    assert _normalize_result({"entities": None, "facts": None}) == {
        "entities": None,
        "facts": None,
    }

    raw = {
        "entities": [None, "not-a-dict", {"name": "@张伟", "entity_type": "Person"}],
        "facts": [
            None,
            {"fact_text": "no involved_entities key here"},
            {"involved_entities": "not-a-list"},
            {"involved_entities": [None, 123, "@李娜"]},
        ],
    }
    _normalize_result(raw)
    # The valid entity dict survives (cleaned). No closure from involved_entities
    # anymore — involved_entities is now reconstructed from entity names.
    assert raw["entities"] == [
        {"name": "张伟", "entity_type": "Person"},
    ]
    # All facts get involved_entities reconstructed from entity names list
    assert raw["facts"][1]["involved_entities"] == ["张伟"]
    assert raw["facts"][3]["involved_entities"] == ["张伟"]


def test_involved_entities_reconstructed_from_entity_names():
    # involved_entities is now set to ALL entity names from the same message,
    # regardless of what the LLM originally put there.
    raw = {
        "entities": [
            {"name": "Alice", "entity_type": "Person"},
            {"name": "Bob", "entity_type": "Person"},
        ],
        "facts": [{"subject_entity": "Alice", "fact_text": "Alice did something"}],
    }
    _normalize_result(raw)
    # Every entity is included in involved_entities for every fact
    assert raw["facts"][0]["involved_entities"] == ["Alice", "Bob"]


def test_involved_entities_reconstruction_with_multiple_facts():
    # All facts get the same full entity names list.
    raw = {
        "entities": [
            {"name": "Alice", "entity_type": "Person"},
            {"name": "@Bob", "entity_type": "Person"},
            {"name": "Carol", "entity_type": "Person"},
        ],
        "facts": [
            {"subject_entity": "Alice"},
            {"subject_entity": "Bob"},
        ],
    }
    _normalize_result(raw)
    # @Bob is cleaned to Bob in entities
    names = [e["name"] for e in raw["entities"]]
    assert names == ["Alice", "Bob", "Carol"]
    # Both facts get the full cleaned entity names
    assert raw["facts"][0]["involved_entities"] == ["Alice", "Bob", "Carol"]
    assert raw["facts"][1]["involved_entities"] == ["Alice", "Bob", "Carol"]


def test_involved_entities_noop_when_entities_absent():
    # If 'entities' is absent/non-list, involved_entities is not reconstructed.
    raw = {"facts": [{"involved_entities": ["@Bob"]}]}
    _normalize_result(raw)
    assert "entities" not in raw
    # Without entities list, facts are left untouched (no reconstruction source)
    assert raw["facts"][0]["involved_entities"] == ["@Bob"]


def test_normalize_returns_same_object():
    raw = {"entities": [], "facts": []}
    assert _normalize_result(raw) is raw


def test_normalize_non_dict_passthrough():
    # A non-dict is returned unchanged, no crash.
    assert _normalize_result([]) == []  # type: ignore[arg-type]
    assert _normalize_result("x") == "x"  # type: ignore[arg-type]


# ─── _expand_compact_result ─────────────────────────────────────────────


def test_expand_compact_result_full_expansion():
    """Compact Chinese-key result is expanded to canonical English keys."""
    compact = {
        "序号": 3,
        "实体": [
            {"名称": "张伟", "类型": "Person", "描述": "负责网关调试"},
            {"名称": "sandbox", "类型": "System"},
        ],
        "事实": [
            {
                "主体": "张伟",
                "客体": "sandbox",
                "内容": "张伟负责网关的调试工作",
                "事类": "STATUS",
                "置信": 0.95,
            }
        ],
    }
    expanded = _expand_compact_result(compact)
    assert expanded["msg_index"] == 3
    assert expanded["entities"][0] == {
        "name": "张伟",
        "entity_type": "Person",
        "description": "负责网关调试",
    }
    # Missing description gets default ""
    assert expanded["entities"][1]["description"] == ""
    fact = expanded["facts"][0]
    assert fact["subject_entity"] == "张伟"
    assert fact["object_entity"] == "sandbox"
    assert fact["fact_text"] == "张伟负责网关的调试工作"
    assert fact["fact_type"] == "STATUS"
    assert fact["confidence"] == 0.95
    # Omitted nullable fields get defaults
    assert fact["valid_at"] is None
    assert fact["invalid_at"] is None


def test_expand_compact_result_passthrough_full_keys():
    """Already-expanded results (old cache format) pass through unchanged."""
    full = {
        "msg_index": 0,
        "entities": [{"name": "Alice", "entity_type": "Person", "description": ""}],
        "facts": [
            {
                "subject_entity": "Alice",
                "object_entity": None,
                "relation_type": "STATUS",
                "fact_text": "Alice is here",
                "fact_type": "GENERAL",
                "confidence": 0.9,
                "valid_at": None,
                "invalid_at": None,
            }
        ],
    }
    result = _expand_compact_result(full)
    assert result == full  # unchanged (old cache with relation_type passes through)


def test_expand_compact_result_omitted_optional_fields():
    """Omitted nullable fields (客体, 生效, 失效, 描述) get proper defaults."""
    compact = {
        "序号": 0,
        "实体": [{"名称": "X", "类型": "Person"}],
        "事实": [{"主体": "X", "关系": "EXISTS", "内容": "X exists", "事类": "GENERAL", "置信": 0.8}],
    }
    expanded = _expand_compact_result(compact)
    assert expanded["entities"][0]["description"] == ""
    fact = expanded["facts"][0]
    assert fact["object_entity"] is None
    assert fact["confidence"] == 0.8
    assert fact["valid_at"] is None
    assert fact["invalid_at"] is None

