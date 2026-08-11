"""Configuration schema completeness and validation tests."""

from __future__ import annotations

from copy import deepcopy

import pytest
from omegaconf import OmegaConf
from pydantic import ValidationError

from kl_graph.config import AppConfig, cfg

EXPECTED_LEAVES = {
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
    "pipelines.ingestion.incremental.community_summary_threshold",
    "pipelines.ingestion.incremental.similarity_strategy",
    "pipelines.ingestion.incremental.community_strategy",
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
    "pipelines.query.confidence.high",
    "pipelines.query.confidence.low",
    "pipelines.query.fusion.rrf_k",
    "pipelines.query.reranking.window",
    "pipelines.query.reranking.top_k",
    "pipelines.query.global_search.current_user",
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
