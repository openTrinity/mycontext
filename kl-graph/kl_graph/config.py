"""Spatio-Temporal Knowledge Retrieval System configuration.

Configuration is loaded from (in priority order, later overrides earlier):
  1. config.default.yaml  (shipped defaults, in repo root)
  2. config.yaml          (user overrides, gitignored, in repo root)
  3. A custom YAML passed via ``load_config(path)`` (CLI ``-c`` flag)
  4. Environment variables (via OmegaConf ``oc.env`` resolver embedded in YAML)

Access the validated config via the ``cfg`` DictConfig object::

    from kl_graph.config import cfg

    cfg.services.llm_flash.model       # str
    cfg.services.embedding.dim         # int
    cfg.application.data_dir            # empty means PROJECT_ROOT/data

Call ``load_config(path)`` early (before other kl_graph imports) to merge an
additional YAML layer on top of the defaults.  The module-level ``cfg`` and
``DATA_DIR`` are updated in place so subsequent imports see the new values.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from omegaconf import DictConfig, OmegaConf
from pydantic import BaseModel, ConfigDict, Field, model_validator

# ---------------------------------------------------------------------------
# Load structured config
# ---------------------------------------------------------------------------

PROJECT_ROOT = Path(__file__).parent.parent

_default_yaml = PROJECT_ROOT / "config.default.yaml"
_user_yaml = PROJECT_ROOT / "config.yaml"


# ---------------------------------------------------------------------------
# Authoritative typed schema
# ---------------------------------------------------------------------------


class _ConfigModel(BaseModel):
    """Strict base for every configuration section."""

    model_config = ConfigDict(extra="forbid")


class ApplicationConfig(_ConfigModel):
    debug: bool = False
    data_dir: str
    dws_export_dir: str


class ServerConfig(_ConfigModel):
    port: int = Field(ge=1, le=65535)


class EmbeddingServiceConfig(_ConfigModel):
    base_url: str
    model: str
    api_key: str
    dim: int
    send_dimensions: bool


class LLMFlashServiceConfig(_ConfigModel):
    provider: str
    base_url: str
    model: str
    timeout: float


class RerankerServiceConfig(_ConfigModel):
    base_url: str
    model: str
    api_key: str


class ServicesConfig(_ConfigModel):
    embedding: EmbeddingServiceConfig
    llm_flash: LLMFlashServiceConfig
    reranker: RerankerServiceConfig


class FalkorDBConfig(_ConfigModel):
    host: str
    port: int
    graph: str


class LadybugConfig(_ConfigModel):
    # All default to 0/False to match Kuzu auto-detection. Override via
    # config.yaml or KL_LADYBUG_* env vars when the defaults are too
    # aggressive (e.g. buffer_pool_size=0 → ~80% of RAM).
    read_only: bool
    buffer_pool_size: int
    max_num_threads: int


class GraphStorageConfig(_ConfigModel):
    backend: Literal["sqlite", "ladybug", "falkordb"]
    ladybug: LadybugConfig
    falkordb: FalkorDBConfig


class QdrantConfig(_ConfigModel):
    exact_search: bool
    host: str = ""
    port: int = Field(default=6333, ge=1, le=65535)
    api_key: str = ""


class ZvecConfig(_ConfigModel):
    index_type: Literal["hnsw", "flat", "ivf", "diskann"] = "hnsw"
    metric: Literal["cosine", "ip", "l2"] = "cosine"


class VectorStorageConfig(_ConfigModel):
    backend: Literal["qdrant", "zvec"]
    qdrant: QdrantConfig
    zvec: ZvecConfig


class StorageConfig(_ConfigModel):
    graph: GraphStorageConfig
    vector: VectorStorageConfig


class EntityDescriptionConfig(_ConfigModel):
    summarize: bool
    concurrency: int


class IngestionEmbeddingConfig(_ConfigModel):
    flush_every: int
    batch_size: int
    concurrency: int
    max_retries: int
    timeout: float


class FixedSizeChatConfig(_ConfigModel):
    chunk_size_chars: int = Field(gt=0)
    overlap_chars: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_overlap(self) -> "FixedSizeChatConfig":
        if self.overlap_chars >= self.chunk_size_chars:
            raise ValueError("overlap_chars must be smaller than chunk_size_chars")
        return self


class ExtractionConfig(_ConfigModel):
    batch_size: int
    batch_timeout: int
    concurrency: int = Field(gt=0)
    max_retries: int = Field(ge=0)
    cache_max_entries: int = Field(gt=0)
    prompt_language: Literal["zh", "en"] = "zh"
    fixed_size_chat: FixedSizeChatConfig
    strategies: dict[str, str] = Field(default_factory=dict)


class CleanupConfig(_ConfigModel):
    enabled: bool = False
    max_entities: int = Field(default=500, ge=0)
    min_suspicion_score: float = Field(default=5.0, ge=0)
    dry_run: bool = True


#: Supported ways to turn a community's membership change into the fraction the
#: re-summarization gate compares against ``resummarize_threshold``. ``added`` /
#: ``removed`` are measured against the ``baseline`` — the member set captured at
#: the last *successful* summarization — while ``current`` is the member set now.
#:
#: - ``added_over_current``:  ``|added| / |current|``
#: - ``added_over_baseline``: ``|added| / |baseline|``
#: - ``churn_over_baseline``: ``(|added| + |removed|) / |baseline|``
#: - ``one_minus_jaccard``:   ``1 - |baseline ∩ current| / |baseline ∪ current|``
ResummarizeDenominator = Literal[
    "added_over_current",
    "added_over_baseline",
    "churn_over_baseline",
    "one_minus_jaccard",
]


class CommunitySummarizationConfig(_ConfigModel):
    """Community report generation and the re-summarization gate.

    ``resummarize_threshold`` is THE single gate threshold: a community's report
    is regenerated only when its membership change since the last successful
    summarization exceeds this fraction, otherwise the existing report is kept
    with no LLM call.  It replaces (renamed + moved from)
    ``pipelines.ingestion.incremental.community_summary_threshold``, which
    approximated staleness as ``1 / member_count``.  There is deliberately only
    one threshold so the gate cannot be interpreted two different ways, and it
    lives here rather than under ``incremental`` because both the full and the
    incremental path summarize through the same gate.
    """

    max_concurrent: int = Field(gt=0)
    resummarize_threshold: float = Field(ge=0.0, le=1.0)
    resummarize_denominator: ResummarizeDenominator = "churn_over_baseline"


class CommunityIdentityThresholds(_ConfigModel):
    """Member-set overlap thresholds for cross-run community reconciliation.

    A candidate ``old -> new`` pair is only considered when the intersection
    reaches ``identity_min_intersection`` members AND clears the overlap
    thresholds: symmetric Jaccard ``|O∩N| / |O∪N|`` and the directional
    inclusion ratios ``|O∩N| / |O|`` and ``|O∩N| / |N|``.
    """

    identity_min_intersection: int = Field(ge=0)
    identity_jaccard_threshold: float = Field(ge=0.0, le=1.0)
    identity_inclusion_threshold: float = Field(ge=0.0, le=1.0)


class CommunityIdentityLevelThresholds(_ConfigModel):
    """Overrides for one hierarchy level; ``None`` inherits from ``default``."""

    identity_min_intersection: int | None = Field(default=None, ge=0)
    identity_jaccard_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    identity_inclusion_threshold: float | None = Field(default=None, ge=0.0, le=1.0)


class CommunityIdentityLevelsConfig(_ConfigModel):
    """Per-level overrides, keyed by hierarchy level (``L0``…``L3``).

    Only the levels the graph actually has are meaningful; an unknown level key
    is rejected instead of silently ignored.  Levels deeper than ``L3`` (should
    the hierarchy grow) fall back to the global default.
    """

    L0: CommunityIdentityLevelThresholds = CommunityIdentityLevelThresholds()
    L1: CommunityIdentityLevelThresholds = CommunityIdentityLevelThresholds()
    L2: CommunityIdentityLevelThresholds = CommunityIdentityLevelThresholds()
    L3: CommunityIdentityLevelThresholds = CommunityIdentityLevelThresholds()


class CommunityIdentityConfig(_ConfigModel):
    """Identity reconciliation tuning: a global default plus per-level overrides.

    Thresholds are per hierarchy level because coarse levels hold large
    communities (a big stable core masks a small meaningful change) while fine
    levels hold small ones (a single-member change is a large Jaccard swing).
    """

    default: CommunityIdentityThresholds
    levels: CommunityIdentityLevelsConfig = CommunityIdentityLevelsConfig()


class IncrementalLeidenTunables(_ConfigModel):
    """Tunables for incremental Leiden maintenance (HIT-Leiden).

    Consumed by :mod:`kl_graph.periodic.incremental_leiden`. Separate from the
    frozen GraphRAG knobs in :mod:`kl_graph.periodic.community_detection`, which
    govern the full hierarchical rebuild.
    """

    gamma: float = Field(default=1.0, gt=0)
    max_levels: int = Field(default=16, gt=0)
    seed: int = Field(default=0xC0FFEE, ge=0)
    min_gain: float = Field(default=1e-12, ge=0)


class IncrementalConfig(_ConfigModel):
    """Per-batch improvement strategies.

    The former ``community_summary_threshold`` moved to
    ``pipelines.ingestion.community_summarization.resummarize_threshold``.
    """

    similarity_strategy: str
    community_strategy: str
    leiden: IncrementalLeidenTunables = IncrementalLeidenTunables()


class SimilarityConfig(_ConfigModel):
    threshold: float


class IngestionPipelineConfig(_ConfigModel):
    keep_extraction_cache: bool
    v1_entities_path: str
    generic_sources: list[str]
    embedding: IngestionEmbeddingConfig
    extraction: ExtractionConfig
    cleanup: CleanupConfig = CleanupConfig()
    entity_description: EntityDescriptionConfig
    community_summarization: CommunitySummarizationConfig
    community_identity: CommunityIdentityConfig
    incremental: IncrementalConfig
    similarity: SimilarityConfig


class ConfidenceConfig(_ConfigModel):
    high: float
    low: float


class FusionConfig(_ConfigModel):
    rrf_k: int


class RerankingConfig(_ConfigModel):
    window: int
    top_k: int


class GlobalSearchConfig(_ConfigModel):
    current_user: str
    levels: str
    map_budget: int
    reduce_budget: int
    map_max_tokens: int
    reduce_max_tokens: int
    max_communities: int
    map_concurrency: int
    shuffle_seed: int


class QueryEmbeddingConfig(_ConfigModel):
    max_retries: int
    timeout: float


class AskConfig(_ConfigModel):
    """Defaults for the combined retrieval and graph-walk endpoint."""

    synthesize: bool = False


class QueryPipelineConfig(_ConfigModel):
    ask: AskConfig = AskConfig()
    embedding: QueryEmbeddingConfig
    phase1_message_limit: int
    phase1_fact_limit: int
    phase1_entity_expand_limit: int
    phase2_context_limit: int
    max_concurrency: int
    dedup_enabled: bool
    confidence: ConfidenceConfig
    fusion: FusionConfig
    reranking: RerankingConfig
    global_search: GlobalSearchConfig


class CommunitiesPipelineConfig(_ConfigModel):
    """Experimental community build and serving feature gate."""

    enabled: bool = False


class PersonaPipelineConfig(_ConfigModel):
    """Offline persona build and serve-time conditioning settings."""

    enabled: bool = False
    owner_name: str = ""
    owner_sender_id: str = ""
    min_messages: int = Field(default=3, ge=1)


class ExperimentalPipelinesConfig(_ConfigModel):
    """Feature-gated pipeline components that are not enabled by default."""

    communities: CommunitiesPipelineConfig = CommunitiesPipelineConfig()


class PipelinesConfig(_ConfigModel):
    experimental: ExperimentalPipelinesConfig = ExperimentalPipelinesConfig()
    persona: PersonaPipelineConfig = PersonaPipelineConfig()
    ingestion: IngestionPipelineConfig
    query: QueryPipelineConfig


class AppConfig(_ConfigModel):
    """Complete application configuration contract."""

    application: ApplicationConfig
    server: ServerConfig
    services: ServicesConfig
    storage: StorageConfig
    pipelines: PipelinesConfig


def _build_config(extra_yaml: Path | None = None) -> DictConfig:
    """Build the merged OmegaConf config from YAML layers + env overrides."""
    # Base layer: shipped defaults
    if _default_yaml.exists():
        base = OmegaConf.load(_default_yaml)
    else:
        base = OmegaConf.create({})

    # User layer: local overrides (gitignored)
    if _user_yaml.exists():
        user = OmegaConf.load(_user_yaml)
    else:
        user = OmegaConf.create({})

    # Merge: user overrides base
    merged: DictConfig = OmegaConf.merge(base, user)  # type: ignore[assignment]

    # Extra layer: CLI-provided YAML (highest YAML priority, below env vars)
    if extra_yaml is not None:
        extra = OmegaConf.load(extra_yaml)
        merged = OmegaConf.merge(merged, extra)  # type: ignore[assignment]

    # Resolve interpolation, validate/coerce once, then retain DictConfig for the
    # existing ergonomic attribute-access API. Missing and unknown fields fail
    # fast here instead of surfacing later in a pipeline.
    raw = OmegaConf.to_container(merged, resolve=True)
    validated = AppConfig.model_validate(raw)
    return OmegaConf.create(validated.model_dump(mode="python"))


def _derive_data_dir(config: DictConfig) -> Path:
    """Compute DATA_DIR from the resolved config."""
    application = config.application
    return Path(application.data_dir) if application.data_dir else PROJECT_ROOT / "data"


#: Global structured config object.
cfg: DictConfig = _build_config()

# ---------------------------------------------------------------------------
# Public API: reload config with an extra YAML file
# ---------------------------------------------------------------------------


def load_config(path: str | os.PathLike[str]) -> None:
    """Merge an additional YAML config file and update the global ``cfg``.

    Must be called **before** other kl_graph modules are imported, as they
    read from ``cfg`` at import time.  Typical usage in an entry-point script::

        if args.config:
            from kl_graph.config import load_config
            load_config(args.config)

        # Now import the rest of kl_graph
        from kl_graph.ingest.pipeline import run_pipeline
    """
    global cfg, DATA_DIR, GRAPH_DB_PATH, LADYBUG_OPTS  # noqa: PLW0603

    resolved = Path(path).expanduser().resolve()
    if not resolved.exists():
        raise FileNotFoundError(f"Config file not found: {resolved}")

    cfg = _build_config(extra_yaml=resolved)
    DATA_DIR = _derive_data_dir(cfg)
    GRAPH_DB_PATH = str(DATA_DIR / "graph.ladybug")
    LADYBUG_OPTS = {
        "read_only": bool(cfg.storage.graph.ladybug.read_only),
        "buffer_pool_size": int(cfg.storage.graph.ladybug.buffer_pool_size),
        "max_num_threads": int(cfg.storage.graph.ladybug.max_num_threads),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FALSY = {"0", "false", "no", "off", ""}


def _bool(val) -> bool:
    """Coerce a config value to bool (empty / 0 / false / no / off → False)."""
    return str(val).lower().strip() not in _FALSY


def _path(val) -> Path:
    """Coerce a config value to Path (empty string → Path(''))."""
    return Path(str(val)) if val else Path("")


# ---------------------------------------------------------------------------
# Derived path helpers (computed once from cfg at import time)
# ---------------------------------------------------------------------------

DATA_DIR: Path = _derive_data_dir(cfg)

#: LadybugDB graph store path. Always under DATA_DIR; not separately configurable.
GRAPH_DB_PATH: str = str(DATA_DIR / "graph.ladybug")

#: LadybugDB engine options forwarded to ladybug.Database(). All default to
#: 0/False to match Kuzu auto-detection. Override via KL_LADYBUG_* env vars.
LADYBUG_OPTS: dict[str, int | bool] = {
    "read_only": bool(cfg.storage.graph.ladybug.read_only),
    "buffer_pool_size": int(cfg.storage.graph.ladybug.buffer_pool_size),
    "max_num_threads": int(cfg.storage.graph.ladybug.max_num_threads),
}
