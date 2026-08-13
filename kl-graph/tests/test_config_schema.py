"""Configuration schema completeness and validation tests."""

from __future__ import annotations

from copy import deepcopy

import pytest
from omegaconf import OmegaConf
from pydantic import ValidationError

from kl_graph import config as config_module
from kl_graph.config import PROJECT_ROOT, AppConfig, cfg, load_config

EXPECTED_LEAVES = {
    "application.debug",
    "application.current_user",
    "application.data_dir",
    "application.dws_export_dir",
    "server.port",
    "services.embedding.base_url",
    "services.embedding.model",
    "services.embedding.api_key",
    "services.embedding.dim",
    "services.embedding.send_dimensions",
    "services.llm_flash.provider",
    "services.llm_flash.base_url",
    "services.llm_flash.model",
    "services.llm_flash.timeout",
    "services.reranker.base_url",
    "services.reranker.model",
    "services.reranker.api_key",
    "storage.graph.backend",
    "storage.graph.ladybug.read_only",
    "storage.graph.ladybug.buffer_pool_size",
    "storage.graph.ladybug.max_num_threads",
    "storage.graph.falkordb.host",
    "storage.graph.falkordb.port",
    "storage.graph.falkordb.graph",
    "storage.vector.backend",
    "storage.vector.qdrant.exact_search",
    "storage.vector.qdrant.host",
    "storage.vector.qdrant.port",
    "storage.vector.qdrant.api_key",
    "storage.vector.zvec.index_type",
    "storage.vector.zvec.metric",
    "pipelines.experimental.communities.enabled",
    "pipelines.persona.enabled",
    "pipelines.persona.owner_name",
    "pipelines.persona.owner_sender_id",
    "pipelines.persona.min_messages",
    "pipelines.ingestion.keep_extraction_cache",
    "pipelines.ingestion.v1_entities_path",
    "pipelines.ingestion.generic_sources",
    "pipelines.ingestion.embedding.flush_every",
    "pipelines.ingestion.embedding.batch_size",
    "pipelines.ingestion.embedding.concurrency",
    "pipelines.ingestion.embedding.max_retries",
    "pipelines.ingestion.embedding.timeout",
    "pipelines.ingestion.extraction.batch_size",
    "pipelines.ingestion.extraction.batch_timeout",
    "pipelines.ingestion.extraction.concurrency",
    "pipelines.ingestion.extraction.max_retries",
    "pipelines.ingestion.extraction.cache_max_entries",
    "pipelines.ingestion.extraction.prompt_language",
    "pipelines.ingestion.extraction.fixed_size_chat.chunk_size_chars",
    "pipelines.ingestion.extraction.fixed_size_chat.overlap_chars",
    "pipelines.ingestion.extraction.strategies.message",
    "pipelines.ingestion.extraction.strategies.wiki",
    "pipelines.ingestion.extraction.strategies.mail",
    "pipelines.ingestion.extraction.strategies.minutes",
    "pipelines.ingestion.extraction.strategies.work",
    "pipelines.ingestion.extraction.strategies.drive",
    "pipelines.ingestion.extraction.strategies.calendar",
    "pipelines.ingestion.extraction.strategies.contacts",
    "pipelines.ingestion.extraction.strategies.attendance",
    "pipelines.ingestion.extraction.strategies.default",
    "pipelines.ingestion.cleanup.enabled",
    "pipelines.ingestion.cleanup.max_entities",
    "pipelines.ingestion.cleanup.min_suspicion_score",
    "pipelines.ingestion.cleanup.dry_run",
    "pipelines.ingestion.entity_description.summarize",
    "pipelines.ingestion.entity_description.concurrency",
    "pipelines.ingestion.community_summarization.max_concurrent",
    "pipelines.ingestion.community_summarization.resummarize_threshold",
    "pipelines.ingestion.community_summarization.resummarize_denominator",
    "pipelines.ingestion.community_identity.default.identity_min_intersection",
    "pipelines.ingestion.community_identity.default.identity_jaccard_threshold",
    "pipelines.ingestion.community_identity.default.identity_inclusion_threshold",
    "pipelines.ingestion.community_identity.levels.L0.identity_min_intersection",
    "pipelines.ingestion.community_identity.levels.L0.identity_jaccard_threshold",
    "pipelines.ingestion.community_identity.levels.L0.identity_inclusion_threshold",
    "pipelines.ingestion.community_identity.levels.L1.identity_min_intersection",
    "pipelines.ingestion.community_identity.levels.L1.identity_jaccard_threshold",
    "pipelines.ingestion.community_identity.levels.L1.identity_inclusion_threshold",
    "pipelines.ingestion.community_identity.levels.L2.identity_min_intersection",
    "pipelines.ingestion.community_identity.levels.L2.identity_jaccard_threshold",
    "pipelines.ingestion.community_identity.levels.L2.identity_inclusion_threshold",
    "pipelines.ingestion.community_identity.levels.L3.identity_min_intersection",
    "pipelines.ingestion.community_identity.levels.L3.identity_jaccard_threshold",
    "pipelines.ingestion.community_identity.levels.L3.identity_inclusion_threshold",
    "pipelines.ingestion.incremental.similarity_strategy",
    "pipelines.ingestion.incremental.community_strategy",
    "pipelines.ingestion.incremental.leiden.gamma",
    "pipelines.ingestion.incremental.leiden.max_levels",
    "pipelines.ingestion.incremental.leiden.seed",
    "pipelines.ingestion.incremental.leiden.min_gain",
    "pipelines.ingestion.similarity.threshold",
    "pipelines.query.ask.synthesize",
    "pipelines.query.embedding.max_retries",
    "pipelines.query.embedding.timeout",
    "pipelines.query.phase1_message_limit",
    "pipelines.query.phase1_fact_limit",
    "pipelines.query.phase1_entity_expand_limit",
    "pipelines.query.phase2_context_limit",
    "pipelines.query.max_concurrency",
    "pipelines.query.dedup_enabled",
    "pipelines.query.fact_near_dup_threshold",
    "pipelines.query.confidence.high",
    "pipelines.query.confidence.low",
    "pipelines.query.fusion.rrf_k",
    "pipelines.query.reranking.window",
    "pipelines.query.reranking.top_k",
    "pipelines.query.global_search.levels",
    "pipelines.query.global_search.map_budget",
    "pipelines.query.global_search.reduce_budget",
    "pipelines.query.global_search.map_max_tokens",
    "pipelines.query.global_search.reduce_max_tokens",
    "pipelines.query.global_search.max_communities",
    "pipelines.query.global_search.map_concurrency",
    "pipelines.query.global_search.shuffle_seed",
}


def _leaf_paths(value: object, prefix: str = "") -> set[str]:
    if isinstance(value, dict):
        return {
            leaf
            for key, child in value.items()
            for leaf in _leaf_paths(child, f"{prefix}.{key}" if prefix else key)
        }
    return {prefix}


def _config_dict() -> dict:
    value = OmegaConf.to_container(cfg, resolve=True)
    assert isinstance(value, dict)
    return value


def test_default_config_contains_every_documented_field() -> None:
    assert _leaf_paths(_config_dict()) == EXPECTED_LEAVES


def test_default_extraction_batch_size_is_five() -> None:
    assert cfg.pipelines.ingestion.extraction.batch_size == 5


def test_debug_integrity_checks_are_disabled_by_default() -> None:
    assert cfg.application.debug is False


def test_default_extraction_retries_are_step_scoped() -> None:
    assert cfg.pipelines.ingestion.extraction.max_retries == 2
    assert "max_retries" not in cfg.services.llm_flash


def test_schema_rejects_missing_fields() -> None:
    value = deepcopy(_config_dict())
    del value["pipelines"]["query"]["reranking"]["top_k"]

    with pytest.raises(ValidationError, match="top_k"):
        AppConfig.model_validate(value)


def test_schema_rejects_unknown_fields() -> None:
    value = deepcopy(_config_dict())
    value["storage"]["vector"]["mystery_backend"] = {}

    with pytest.raises(ValidationError, match="mystery_backend"):
        AppConfig.model_validate(value)


def test_schema_rejects_nonpositive_extraction_concurrency() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["extraction"]["concurrency"] = 0

    with pytest.raises(ValidationError, match="concurrency"):
        AppConfig.model_validate(value)


def test_schema_rejects_negative_extraction_retries() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["extraction"]["max_retries"] = -1

    with pytest.raises(ValidationError, match="max_retries"):
        AppConfig.model_validate(value)


def test_schema_rejects_invalid_fixed_size_overlap() -> None:
    value = deepcopy(_config_dict())
    fixed = value["pipelines"]["ingestion"]["extraction"]["fixed_size_chat"]
    fixed["overlap_chars"] = fixed["chunk_size_chars"]

    with pytest.raises(ValidationError, match="overlap_chars"):
        AppConfig.model_validate(value)


# ---------------------------------------------------------------------------
# Community re-summarization gate + identity reconciliation knobs
# ---------------------------------------------------------------------------


def test_default_resummarization_gate_is_churn_over_baseline() -> None:
    """The shipped default must reproduce the decided gate policy: a single 0.1
    threshold compared against ``(|added| + |removed|) / |baseline|``."""
    summarization = cfg.pipelines.ingestion.community_summarization

    assert summarization.resummarize_threshold == 0.1
    assert summarization.resummarize_denominator == "churn_over_baseline"


def test_resummarize_threshold_is_the_only_gate_threshold() -> None:
    """The former ``incremental.community_summary_threshold`` was renamed, not
    duplicated — two independently-interpreted thresholds is the trap."""
    assert "community_summary_threshold" not in cfg.pipelines.ingestion.incremental
    gate_leaves = {
        leaf for leaf in EXPECTED_LEAVES if leaf.endswith("resummarize_threshold")
    }
    assert gate_leaves == {
        "pipelines.ingestion.community_summarization.resummarize_threshold"
    }


@pytest.mark.parametrize("bad", [1.5, -0.1])
def test_schema_rejects_out_of_range_resummarize_threshold(bad: float) -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["community_summarization"][
        "resummarize_threshold"
    ] = bad

    with pytest.raises(ValidationError, match="resummarize_threshold"):
        AppConfig.model_validate(value)


def test_schema_rejects_unsupported_resummarize_denominator() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["community_summarization"][
        "resummarize_denominator"
    ] = "added_over_moon_phase"

    with pytest.raises(ValidationError, match="resummarize_denominator"):
        AppConfig.model_validate(value)


@pytest.mark.parametrize(
    "denominator",
    [
        "added_over_current",
        "added_over_baseline",
        "churn_over_baseline",
        "one_minus_jaccard",
    ],
)
def test_schema_accepts_every_supported_denominator(denominator: str) -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["community_summarization"][
        "resummarize_denominator"
    ] = denominator

    validated = AppConfig.model_validate(value)

    assert (
        validated.pipelines.ingestion.community_summarization.resummarize_denominator
        == denominator
    )


def test_default_identity_thresholds_are_per_level_with_a_global_default() -> None:
    """Identity overlap thresholds are configured per hierarchy level: a global
    default plus an override slot for every level the hierarchy has."""
    identity = cfg.pipelines.ingestion.community_identity

    assert identity.default.identity_min_intersection == 2
    assert identity.default.identity_jaccard_threshold == 0.3
    assert identity.default.identity_inclusion_threshold == 0.5
    assert set(identity.levels) == {"L0", "L1", "L2", "L3"}
    # Shipped defaults override nothing; every level inherits ``default``.
    for level in ("L0", "L1", "L2", "L3"):
        overrides = identity.levels[level]
        assert overrides.identity_min_intersection is None
        assert overrides.identity_jaccard_threshold is None
        assert overrides.identity_inclusion_threshold is None


def test_schema_accepts_per_level_identity_overrides() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["community_identity"]["levels"]["L3"] = {
        "identity_min_intersection": 1,
        "identity_jaccard_threshold": 0.6,
        "identity_inclusion_threshold": 0.8,
    }

    identity = AppConfig.model_validate(value).pipelines.ingestion.community_identity

    assert identity.levels.L3.identity_jaccard_threshold == 0.6
    # An override on one level must not leak into the others.
    assert identity.levels.L0.identity_jaccard_threshold is None
    assert identity.default.identity_jaccard_threshold == 0.3


@pytest.mark.parametrize("bad", [1.5, -0.1])
def test_schema_rejects_out_of_range_per_level_identity_jaccard(bad: float) -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["community_identity"]["levels"]["L1"][
        "identity_jaccard_threshold"
    ] = bad

    with pytest.raises(ValidationError, match="identity_jaccard_threshold"):
        AppConfig.model_validate(value)


def test_schema_rejects_out_of_range_per_level_identity_inclusion() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["community_identity"]["levels"]["L2"][
        "identity_inclusion_threshold"
    ] = 1.5

    with pytest.raises(ValidationError, match="identity_inclusion_threshold"):
        AppConfig.model_validate(value)


def test_schema_rejects_negative_identity_min_intersection() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["community_identity"]["default"][
        "identity_min_intersection"
    ] = -1

    with pytest.raises(ValidationError, match="identity_min_intersection"):
        AppConfig.model_validate(value)


def test_schema_rejects_unknown_identity_level() -> None:
    """A typo'd level (or a level the hierarchy does not have) must fail loudly
    rather than be silently dropped along with its thresholds."""
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["community_identity"]["levels"]["L9"] = {
        "identity_jaccard_threshold": 0.4
    }

    with pytest.raises(ValidationError, match="L9"):
        AppConfig.model_validate(value)


def test_schema_rejects_unknown_community_summarization_field() -> None:
    """Regression guard for the new sections: extras are still forbidden, so a
    YAML key without a typed field cannot slip through unvalidated."""
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["community_summarization"][
        "resummarise_threshold"
    ] = 0.2

    with pytest.raises(ValidationError, match="resummarise_threshold"):
        AppConfig.model_validate(value)


def test_default_yaml_loads_end_to_end() -> None:
    """``config.default.yaml`` and the typed schema must stay in lockstep: the
    shipped YAML has to validate on its own, or the app will not start.

    Re-merging the default layer onto itself is idempotent, so this does not
    disturb the global ``cfg`` other tests read.
    """
    before = _config_dict()

    load_config(PROJECT_ROOT / "config.default.yaml")

    reloaded = config_module.cfg.pipelines.ingestion
    assert reloaded.community_summarization.resummarize_threshold == 0.1
    assert reloaded.community_summarization.resummarize_denominator == (
        "churn_over_baseline"
    )
    assert reloaded.community_identity.default.identity_min_intersection == 2
    assert OmegaConf.to_container(config_module.cfg, resolve=True) == before


def test_strategies_accepts_nested_spec() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["extraction"]["strategies"]["message"] = {
        "name": "chat_processing",
        "chunking": "session",
        "extraction": "chunk",
    }

    validated = AppConfig.model_validate(value)
    spec = validated.pipelines.ingestion.extraction.strategies["message"]
    assert spec.name == "chat_processing"
    assert spec.chunking == "session"
    assert spec.extraction == "chunk"


def test_strategies_keeps_legacy_string_values() -> None:
    strategies = cfg.pipelines.ingestion.extraction.strategies
    assert strategies["message"] == "chat_message"
    assert strategies["default"] == "stored_chunk"


def test_strategies_accepts_preset_dict_form() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["extraction"]["strategies"]["default"] = {
        "name": "stored_chunk",
    }

    validated = AppConfig.model_validate(value)
    spec = validated.pipelines.ingestion.extraction.strategies["default"]
    assert spec.name == "stored_chunk"


def test_strategies_rejects_axes_on_a_preset_arm() -> None:
    # Presets take no params; axes belong to chat_processing only.
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["extraction"]["strategies"]["default"] = {
        "name": "stored_chunk",
        "chunking": "none",
    }

    with pytest.raises(ValidationError, match="chunking"):
        AppConfig.model_validate(value)


def test_strategies_rejects_unknown_registry_name() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["extraction"]["strategies"]["message"] = {
        "name": "mystery_strategy",
    }

    with pytest.raises(ValidationError):
        AppConfig.model_validate(value)


def test_strategies_rejects_invalid_axis_value() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["extraction"]["strategies"]["message"] = {
        "name": "chat_processing",
        "chunking": "bogus",
        "extraction": "chunk",
    }

    with pytest.raises(ValidationError, match="chunking"):
        AppConfig.model_validate(value)


def test_strategies_rejects_unknown_spec_key() -> None:
    value = deepcopy(_config_dict())
    value["pipelines"]["ingestion"]["extraction"]["strategies"]["message"] = {
        "name": "chat_processing",
        "chunking": "session",
        "extraction": "chunk",
        "mystery": True,
    }

    with pytest.raises(ValidationError, match="mystery"):
        AppConfig.model_validate(value)


def test_nested_spec_survives_omegaconf_resolve_and_validate(tmp_path) -> None:
    from kl_graph.config import _build_config

    extra = tmp_path / "config.yaml"
    extra.write_text(
        "pipelines:\n"
        "  ingestion:\n"
        "    extraction:\n"
        "      strategies:\n"
        "        message:\n"
        "          name: chat_processing\n"
        "          chunking: session\n"
        "          extraction: chunk\n",
        encoding="utf-8",
    )

    built = _build_config(extra_yaml=extra)
    message = built.pipelines.ingestion.extraction.strategies.message
    assert message.name == "chat_processing"
    assert message.chunking == "session"
    assert message.extraction == "chunk"
