"""Load and validate strict, backend-aware LoCoMo experiment YAML files."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal, TypeAlias

from omegaconf import DictConfig, OmegaConf
from pydantic import (
    BaseModel,
    ConfigDict,
    NonNegativeFloat,
    NonNegativeInt,
    PositiveFloat,
    PositiveInt,
    StringConstraints,
    model_validator,
)

EXPERIMENT_SCHEMA_VERSION = 1
BENCHMARK_NAME = "locomo"

BackendName: TypeAlias = Literal["kl_graph", "khoj", "ragflow"]
Category: TypeAlias = Literal[1, 2, 3, 4, 5]
NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
NonEmptyString = Annotated[str, StringConstraints(min_length=1)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ConversationSelectionConfig(_StrictModel):
    all: Literal[True] | None = None
    first: PositiveInt | None = None
    cases: list[NonEmptyText] | None = None

    @model_validator(mode="after")
    def _require_one_mode(self) -> ConversationSelectionConfig:
        modes = int(self.all is True) + int(self.first is not None) + int(
            self.cases is not None
        )
        if modes != 1:
            raise ValueError("set exactly one of all=true, first, or cases")
        if self.cases is not None:
            if not self.cases:
                raise ValueError("cases must not be empty")
            if len(self.cases) != len(set(self.cases)):
                raise ValueError("cases must not contain duplicates")
        return self


class QuestionSelectionConfig(_StrictModel):
    all: Literal[True] | None = None
    categories: list[Category] | None = None
    ids: list[NonEmptyText] | None = None
    first: PositiveInt | None = None

    @model_validator(mode="after")
    def _validate_filters(self) -> QuestionSelectionConfig:
        filters = self.categories is not None or self.ids is not None
        if self.all is True and (filters or self.first is not None):
            raise ValueError("all=true cannot be combined with question filters")
        if self.all is not True and not filters and self.first is None:
            raise ValueError("set all=true or at least one question filter")
        if self.categories is not None:
            if not self.categories:
                raise ValueError("categories must not be empty")
            if len(self.categories) != len(set(self.categories)):
                raise ValueError("categories must not contain duplicates")
        if self.ids is not None:
            if not self.ids:
                raise ValueError("ids must not be empty")
            if len(self.ids) != len(set(self.ids)):
                raise ValueError("ids must not contain duplicates")
        return self


class SelectionConfig(_StrictModel):
    conversations: ConversationSelectionConfig
    questions: QuestionSelectionConfig


class RunConfig(_StrictModel):
    mode: Literal["resume", "overwrite"]
    output_dir: NonEmptyText
    keep_going: bool


class ConvertConfig(_StrictModel):
    reconvert: bool


class KLBuildConfig(_StrictModel):
    with_improve: bool
    fresh: bool
    keep_cache: bool
    case_concurrency: PositiveInt
    concurrency: PositiveInt


class KLAskConfig(_StrictModel):
    concurrency: PositiveInt
    checkpoint_every: PositiveInt
    top_k: PositiveInt
    timeout_seconds: PositiveFloat


class KhojConnectionConfig(_StrictModel):
    base_url: NonEmptyText


class KhojBuildConfig(_StrictModel):
    dataset_prefix: NonEmptyText
    timeout_seconds: PositiveFloat


class KhojAskConfig(_StrictModel):
    top_k: PositiveInt
    concurrency: PositiveInt
    checkpoint_every: PositiveInt
    timeout_seconds: PositiveFloat

    @model_validator(mode="after")
    def _validate_top_k(self) -> KhojAskConfig:
        if self.top_k > 10:
            raise ValueError("top_k cannot exceed Khoj's server-side limit of 10")
        return self


class RagflowConnectionConfig(_StrictModel):
    python: NonEmptyText
    base_url: NonEmptyText


class RagflowBuildConfig(_StrictModel):
    case_concurrency: PositiveInt
    dataset_prefix: NonEmptyText
    embedding_model: NonEmptyText | None
    graph: bool
    chunk_method: Literal["naive"]
    chunk_token_num: PositiveInt
    delimiter: NonEmptyString
    parse_timeout_seconds: PositiveFloat
    graph_timeout_seconds: PositiveFloat
    poll_seconds: PositiveFloat


class RagflowAskConfig(_StrictModel):
    use_kg: bool
    top_k: PositiveInt
    candidate_count: PositiveInt
    similarity_threshold: NonNegativeFloat
    vector_similarity_weight: NonNegativeFloat
    rerank_id: NonEmptyText | None
    concurrency: PositiveInt
    checkpoint_every: PositiveInt

    @model_validator(mode="after")
    def _validate_retrieval(self) -> RagflowAskConfig:
        if self.candidate_count < self.top_k:
            raise ValueError("candidate_count cannot be smaller than top_k")
        for name in ("similarity_threshold", "vector_similarity_weight"):
            if getattr(self, name) > 1:
                raise ValueError(f"{name} must be between 0 and 1")
        return self


class GenerateConfig(_StrictModel):
    output_dir: NonEmptyText
    top_k: PositiveInt
    concurrency: PositiveInt
    checkpoint_every: PositiveInt
    provider: NonEmptyText
    model: NonEmptyText
    base_url: NonEmptyText
    temperature: NonNegativeFloat
    max_tokens: PositiveInt
    timeout_seconds: PositiveFloat
    max_retries: NonNegativeInt
    include_community_context: bool
    allow_remote_content: bool


class ScoreConfig(_StrictModel):
    output_dir: NonEmptyText
    recall_k: PositiveInt


class TrackingConfig(_StrictModel):
    database: NonEmptyText


class _IdentityConfig(_StrictModel):
    schema_version: Literal[EXPERIMENT_SCHEMA_VERSION]
    benchmark: Literal[BENCHMARK_NAME]
    backend: BackendName


@dataclass(frozen=True)
class ConvertExperiment:
    config_path: Path
    source: Path
    case_set: Path
    convert: ConvertConfig


@dataclass(frozen=True)
class KLBuildExperiment:
    config_path: Path
    case_set: Path
    selection: SelectionConfig
    run: RunConfig
    build: KLBuildConfig


@dataclass(frozen=True)
class KLAskExperiment:
    config_path: Path
    case_set: Path
    selection: SelectionConfig
    run: RunConfig
    ask: KLAskConfig


@dataclass(frozen=True)
class KhojBuildExperiment:
    config_path: Path
    source: Path
    artifact_root: Path
    selection: SelectionConfig
    run: RunConfig
    khoj: KhojConnectionConfig
    build: KhojBuildConfig


@dataclass(frozen=True)
class KhojAskExperiment:
    config_path: Path
    source: Path
    artifact_root: Path
    selection: SelectionConfig
    run: RunConfig
    khoj: KhojConnectionConfig
    ask: KhojAskConfig


@dataclass(frozen=True)
class RagflowBuildExperiment:
    config_path: Path
    source: Path
    artifact_root: Path
    selection: SelectionConfig
    run: RunConfig
    ragflow: RagflowConnectionConfig
    build: RagflowBuildConfig


@dataclass(frozen=True)
class RagflowAskExperiment:
    config_path: Path
    source: Path
    artifact_root: Path
    selection: SelectionConfig
    run: RunConfig
    ragflow: RagflowConnectionConfig
    ask: RagflowAskConfig


@dataclass(frozen=True)
class GenerateExperiment:
    backend: BackendName
    config_path: Path
    source: Path
    case_set: Path | None
    selection: SelectionConfig
    run: RunConfig
    ask_top_k: int
    generate: GenerateConfig


@dataclass(frozen=True)
class ScoreExperiment:
    backend: BackendName
    config_path: Path
    source: Path
    case_set: Path | None
    selection: SelectionConfig
    run: RunConfig
    ask_top_k: int
    generate_output_dir: Path
    score: ScoreConfig
    tracking: TrackingConfig | None


@dataclass(frozen=True)
class KLExperiment:
    backend: Literal["kl_graph"]
    config_path: Path
    source: Path
    case_set: Path
    selection: SelectionConfig
    run: RunConfig
    convert: ConvertConfig
    build: KLBuildConfig
    ask: KLAskConfig
    generate: GenerateConfig
    score: ScoreConfig


@dataclass(frozen=True)
class KhojExperiment:
    backend: Literal["khoj"]
    config_path: Path
    source: Path
    artifact_root: Path
    selection: SelectionConfig
    run: RunConfig
    khoj: KhojConnectionConfig
    build: KhojBuildConfig
    ask: KhojAskConfig
    generate: GenerateConfig
    score: ScoreConfig


@dataclass(frozen=True)
class RagflowExperiment:
    backend: Literal["ragflow"]
    config_path: Path
    source: Path
    artifact_root: Path
    selection: SelectionConfig
    run: RunConfig
    ragflow: RagflowConnectionConfig
    build: RagflowBuildConfig
    ask: RagflowAskConfig
    generate: GenerateConfig
    score: ScoreConfig


Experiment: TypeAlias = KLExperiment | KhojExperiment | RagflowExperiment

_ROOT_KEYS = {
    "schema_version",
    "benchmark",
    "backend",
    "source",
    "case_set",
    "artifact_root",
    "selection",
    "run",
    "convert",
    "khoj",
    "ragflow",
    "build",
    "ask",
    "generate",
    "score",
    "tracking",
}


class _StrictText(_StrictModel):
    value: NonEmptyText


class _PositiveInteger(_StrictModel):
    value: PositiveInt


def _load_raw(path: Path) -> tuple[Path, DictConfig, BackendName]:
    config_path = path.expanduser().resolve()
    if not config_path.is_file():
        raise FileNotFoundError(config_path)
    config = OmegaConf.load(config_path)
    if not isinstance(config, DictConfig):
        raise TypeError("experiment config root must be a mapping")
    unknown = sorted(set(config.keys()).difference(_ROOT_KEYS))
    if unknown:
        raise ValueError(f"unknown experiment config keys: {unknown}")
    identity = _IdentityConfig.model_validate(
        {
            "schema_version": OmegaConf.select(config, "schema_version"),
            "benchmark": OmegaConf.select(config, "benchmark"),
            "backend": OmegaConf.select(config, "backend"),
        }
    )
    return config_path, config, identity.backend


def _require_backend(actual: BackendName, expected: BackendName) -> None:
    if actual != expected:
        raise ValueError(f"expected backend={expected!r}, found {actual!r}")


def _validate_backend_keys(config: DictConfig, backend: BackendName) -> None:
    if backend == "kl_graph":
        rejected = {"artifact_root", "khoj", "ragflow"}
    elif backend == "khoj":
        rejected = {"case_set", "convert", "ragflow"}
    else:
        rejected = {"case_set", "convert", "khoj"}
    present = sorted(key for key in rejected if key in config)
    if present:
        raise ValueError(f"backend={backend!r} does not accept config keys: {present}")


def _required_text(config: DictConfig, key: str) -> str:
    return _StrictText.model_validate(
        {"value": OmegaConf.select(config, key)}
    ).value


def _config_path(config_path: Path, value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = config_path.parent / path
    return path.resolve()


def _executable_path(config_path: Path, value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = config_path.parent / path
    return Path(os.path.abspath(path))


def _path(config_path: Path, config: DictConfig, key: str) -> Path:
    return _config_path(config_path, _required_text(config, key))


def _section(config: DictConfig, key: str, model: type[_StrictModel]) -> Any:
    value = OmegaConf.select(config, key)
    if value is None:
        raise ValueError(f"experiment config section {key!r} is required")
    return model.model_validate(OmegaConf.to_container(value, resolve=True))


def _selection(config: DictConfig) -> SelectionConfig:
    return _section(config, "selection", SelectionConfig)


def _run(config_path: Path, config: DictConfig) -> RunConfig:
    value = _section(config, "run", RunConfig)
    return value.model_copy(
        update={"output_dir": str(_config_path(config_path, value.output_dir))}
    )


def _generate(config_path: Path, config: DictConfig) -> GenerateConfig:
    value = _section(config, "generate", GenerateConfig)
    return value.model_copy(
        update={"output_dir": str(_config_path(config_path, value.output_dir))}
    )


def _score(config_path: Path, config: DictConfig) -> ScoreConfig:
    value = _section(config, "score", ScoreConfig)
    return value.model_copy(
        update={"output_dir": str(_config_path(config_path, value.output_dir))}
    )


def _tracking(config_path: Path, config: DictConfig) -> TrackingConfig | None:
    if OmegaConf.select(config, "tracking") is None:
        return None
    value = _section(config, "tracking", TrackingConfig)
    return value.model_copy(
        update={"database": str(_config_path(config_path, value.database))}
    )


def _ragflow(
    config_path: Path, config: DictConfig
) -> RagflowConnectionConfig:
    value = _section(config, "ragflow", RagflowConnectionConfig)
    return value.model_copy(
        update={"python": str(_executable_path(config_path, value.python))}
    )


def _ask_top_k(config: DictConfig) -> int:
    return _PositiveInteger.model_validate(
        {"value": OmegaConf.select(config, "ask.top_k")}
    ).value


def load_convert_experiment(path: Path) -> ConvertExperiment:
    config_path, raw, backend = _load_raw(path)
    _require_backend(backend, "kl_graph")
    _validate_backend_keys(raw, backend)
    return ConvertExperiment(
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        case_set=_path(config_path, raw, "case_set"),
        convert=_section(raw, "convert", ConvertConfig),
    )


def load_kl_build_experiment(path: Path) -> KLBuildExperiment:
    config_path, raw, backend = _load_raw(path)
    _require_backend(backend, "kl_graph")
    _validate_backend_keys(raw, backend)
    return KLBuildExperiment(
        config_path=config_path,
        case_set=_path(config_path, raw, "case_set"),
        selection=_selection(raw),
        run=_run(config_path, raw),
        build=_section(raw, "build", KLBuildConfig),
    )


def load_kl_ask_experiment(path: Path) -> KLAskExperiment:
    config_path, raw, backend = _load_raw(path)
    _require_backend(backend, "kl_graph")
    _validate_backend_keys(raw, backend)
    return KLAskExperiment(
        config_path=config_path,
        case_set=_path(config_path, raw, "case_set"),
        selection=_selection(raw),
        run=_run(config_path, raw),
        ask=_section(raw, "ask", KLAskConfig),
    )


def load_khoj_build_experiment(path: Path) -> KhojBuildExperiment:
    config_path, raw, backend = _load_raw(path)
    _require_backend(backend, "khoj")
    _validate_backend_keys(raw, backend)
    return KhojBuildExperiment(
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        artifact_root=_path(config_path, raw, "artifact_root"),
        selection=_selection(raw),
        run=_run(config_path, raw),
        khoj=_section(raw, "khoj", KhojConnectionConfig),
        build=_section(raw, "build", KhojBuildConfig),
    )


def load_khoj_ask_experiment(path: Path) -> KhojAskExperiment:
    config_path, raw, backend = _load_raw(path)
    _require_backend(backend, "khoj")
    _validate_backend_keys(raw, backend)
    return KhojAskExperiment(
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        artifact_root=_path(config_path, raw, "artifact_root"),
        selection=_selection(raw),
        run=_run(config_path, raw),
        khoj=_section(raw, "khoj", KhojConnectionConfig),
        ask=_section(raw, "ask", KhojAskConfig),
    )


def load_ragflow_build_experiment(path: Path) -> RagflowBuildExperiment:
    config_path, raw, backend = _load_raw(path)
    _require_backend(backend, "ragflow")
    _validate_backend_keys(raw, backend)
    return RagflowBuildExperiment(
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        artifact_root=_path(config_path, raw, "artifact_root"),
        selection=_selection(raw),
        run=_run(config_path, raw),
        ragflow=_ragflow(config_path, raw),
        build=_section(raw, "build", RagflowBuildConfig),
    )


def load_ragflow_ask_experiment(path: Path) -> RagflowAskExperiment:
    config_path, raw, backend = _load_raw(path)
    _require_backend(backend, "ragflow")
    _validate_backend_keys(raw, backend)
    return RagflowAskExperiment(
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        artifact_root=_path(config_path, raw, "artifact_root"),
        selection=_selection(raw),
        run=_run(config_path, raw),
        ragflow=_ragflow(config_path, raw),
        ask=_section(raw, "ask", RagflowAskConfig),
    )


def load_generate_experiment(path: Path) -> GenerateExperiment:
    config_path, raw, backend = _load_raw(path)
    _validate_backend_keys(raw, backend)
    generate = _generate(config_path, raw)
    ask_top_k = _ask_top_k(raw)
    if generate.top_k > ask_top_k:
        raise ValueError("generate.top_k cannot exceed ask.top_k")
    return GenerateExperiment(
        backend=backend,
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        case_set=(
            _path(config_path, raw, "case_set") if backend == "kl_graph" else None
        ),
        selection=_selection(raw),
        run=_run(config_path, raw),
        ask_top_k=ask_top_k,
        generate=generate,
    )


def load_score_experiment(path: Path) -> ScoreExperiment:
    config_path, raw, backend = _load_raw(path)
    _validate_backend_keys(raw, backend)
    ask_top_k = _ask_top_k(raw)
    generate = _generate(config_path, raw)
    score = _score(config_path, raw)
    if generate.top_k > ask_top_k:
        raise ValueError("generate.top_k cannot exceed ask.top_k")
    if score.recall_k > ask_top_k:
        raise ValueError("score.recall_k cannot exceed ask.top_k")
    return ScoreExperiment(
        backend=backend,
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        case_set=(
            _path(config_path, raw, "case_set") if backend == "kl_graph" else None
        ),
        selection=_selection(raw),
        run=_run(config_path, raw),
        ask_top_k=ask_top_k,
        generate_output_dir=Path(generate.output_dir),
        score=score,
        tracking=_tracking(config_path, raw),
    )


def load_experiment(path: Path) -> Experiment:
    config_path, raw, backend = _load_raw(path)
    _validate_backend_keys(raw, backend)
    generate = _generate(config_path, raw)
    score = _score(config_path, raw)
    ask_top_k = _ask_top_k(raw)
    if generate.top_k > ask_top_k:
        raise ValueError("generate.top_k cannot exceed ask.top_k")
    if score.recall_k > ask_top_k:
        raise ValueError("score.recall_k cannot exceed ask.top_k")
    common = {
        "backend": backend,
        "config_path": config_path,
        "source": _path(config_path, raw, "source"),
        "selection": _selection(raw),
        "run": _run(config_path, raw),
        "generate": generate,
        "score": score,
    }
    if backend == "kl_graph":
        return KLExperiment(
            **common,
            case_set=_path(config_path, raw, "case_set"),
            convert=_section(raw, "convert", ConvertConfig),
            build=_section(raw, "build", KLBuildConfig),
            ask=_section(raw, "ask", KLAskConfig),
        )
    if backend == "khoj":
        return KhojExperiment(
            **common,
            artifact_root=_path(config_path, raw, "artifact_root"),
            khoj=_section(raw, "khoj", KhojConnectionConfig),
            build=_section(raw, "build", KhojBuildConfig),
            ask=_section(raw, "ask", KhojAskConfig),
        )
    return RagflowExperiment(
        **common,
        artifact_root=_path(config_path, raw, "artifact_root"),
        ragflow=_ragflow(config_path, raw),
        build=_section(raw, "build", RagflowBuildConfig),
        ask=_section(raw, "ask", RagflowAskConfig),
    )


def run_output_dir(experiment: Experiment | GenerateExperiment | ScoreExperiment) -> Path:
    return Path(experiment.run.output_dir)


def generate_output_dir(experiment: Experiment | GenerateExperiment) -> Path:
    return Path(experiment.generate.output_dir)


def score_output_dir(experiment: Experiment | ScoreExperiment) -> Path:
    return Path(experiment.score.output_dir)
