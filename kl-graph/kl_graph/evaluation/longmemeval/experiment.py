"""Load and validate LongMemEval experiment YAML files.

Experiment values live in YAML. This module owns the strict, backend-aware
schema used by standalone stages and by the end-to-end pipeline. Stage loaders
resolve only the sections they consume, so Score does not require environment
interpolation used only by Generate or Ask.
"""

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

EXPERIMENT_SCHEMA_VERSION = 2
BENCHMARK_NAME = "longmemeval"
PROMPT_RESERVE_TOKENS = 1_000

BackendName: TypeAlias = Literal["kl_graph", "khoj", "ragflow"]
NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
NonEmptyString = Annotated[str, StringConstraints(min_length=1)]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class SelectionConfig(_StrictModel):
    all: Literal[True] | None = None
    first: PositiveInt | None = None
    cases: list[NonEmptyText] | None = None

    @model_validator(mode="after")
    def _require_one_mode(self) -> SelectionConfig:
        modes = int(self.all is True) + int(self.first is not None) + int(
            self.cases is not None
        )
        if modes != 1:
            raise ValueError("set exactly one of all=true, first, or cases")
        if self.cases is not None:
            if not self.cases:
                raise ValueError("cases must not be empty")
            if len(self.cases) != len(set(self.cases)):
                raise ValueError("cases must not contain duplicate question IDs")
        return self


class RunConfig(_StrictModel):
    mode: Literal["resume", "overwrite"]
    output_dir: NonEmptyText
    keep_going: bool


class ConvertConfig(_StrictModel):
    timezone: NonEmptyText
    reconvert: bool


class KLBuildConfig(_StrictModel):
    with_improve: bool
    fresh: bool
    keep_cache: bool
    case_concurrency: PositiveInt
    concurrency: PositiveInt


class KLAskConfig(_StrictModel):
    case_concurrency: PositiveInt
    rerank_base_url: NonEmptyText
    rerank_model: NonEmptyText
    top_k: PositiveInt
    server_start_timeout_seconds: PositiveFloat
    request_timeout_seconds: PositiveFloat


class KhojConnectionConfig(_StrictModel):
    base_url: NonEmptyText
    max_retries: NonNegativeInt


class KhojBuildConfig(_StrictModel):
    case_concurrency: PositiveInt
    document_prefix: NonEmptyText
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
    concurrency: PositiveInt
    provider: NonEmptyText
    model: NonEmptyText
    base_url: NonEmptyText
    temperature: NonNegativeFloat
    max_tokens: PositiveInt
    model_context_tokens: PositiveInt
    timeout_seconds: PositiveFloat
    max_retries: NonNegativeInt

    @model_validator(mode="after")
    def _validate_context_window(self) -> GenerateConfig:
        if self.model_context_tokens <= self.max_tokens + PROMPT_RESERVE_TOKENS:
            raise ValueError(
                "model_context_tokens must exceed max_tokens plus the "
                f"{PROMPT_RESERVE_TOKENS}-token prompt reserve"
            )
        return self


class JudgeConfig(_StrictModel):
    model: NonEmptyText
    base_url: NonEmptyText
    temperature: NonNegativeFloat
    max_tokens: PositiveInt
    timeout_seconds: PositiveFloat
    max_retries: NonNegativeInt


class TurnRecallConfig(_StrictModel):
    enabled: bool
    k: PositiveInt


class RetrievalConfig(_StrictModel):
    turn_recall: TurnRecallConfig


class ScoreConfig(_StrictModel):
    output: NonEmptyText
    metrics_output: NonEmptyText
    concurrency: PositiveInt
    judge: JudgeConfig
    retrieval: RetrievalConfig


class TrackingConfig(_StrictModel):
    database: NonEmptyText


class _IdentityConfig(_StrictModel):
    schema_version: Literal[EXPERIMENT_SCHEMA_VERSION]
    benchmark: Literal[BENCHMARK_NAME]
    backend: BackendName


_ROOT_KEYS = {
    "schema_version",
    "benchmark",
    "backend",
    "source",
    "case_set",
    "artifact_root",
    "hypotheses",
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


@dataclass(frozen=True)
class ConvertExperiment:
    config_path: Path
    source: Path
    case_set: Path
    convert: ConvertConfig


@dataclass(frozen=True)
class BuildExperiment:
    config_path: Path
    case_set: Path
    selection: SelectionConfig
    run: RunConfig
    build: KLBuildConfig


@dataclass(frozen=True)
class AskExperiment:
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
    hypotheses: Path
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
    hypotheses: Path
    selection: SelectionConfig
    run: RunConfig
    ask_top_k: int | None
    score: ScoreConfig
    tracking: TrackingConfig | None


@dataclass(frozen=True)
class KLExperiment:
    backend: Literal["kl_graph"]
    config_path: Path
    source: Path
    case_set: Path
    hypotheses: Path
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
    hypotheses: Path
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
    hypotheses: Path
    selection: SelectionConfig
    run: RunConfig
    ragflow: RagflowConnectionConfig
    build: RagflowBuildConfig
    ask: RagflowAskConfig
    generate: GenerateConfig
    score: ScoreConfig


Experiment: TypeAlias = KLExperiment | KhojExperiment | RagflowExperiment


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


def _reject_keys(config: DictConfig, backend: BackendName, keys: set[str]) -> None:
    present = sorted(key for key in keys if key in config)
    if present:
        raise ValueError(f"backend={backend!r} does not accept config keys: {present}")


def _validate_backend_keys(config: DictConfig, backend: BackendName) -> None:
    if backend == "kl_graph":
        _reject_keys(config, backend, {"artifact_root", "khoj", "ragflow"})
    elif backend == "khoj":
        _reject_keys(config, backend, {"case_set", "convert", "ragflow"})
    else:
        _reject_keys(config, backend, {"case_set", "convert", "khoj"})


def _required_text(config: DictConfig, key: str) -> str:
    value = OmegaConf.select(config, key)
    return _StrictText.model_validate({"value": value}).value


class _StrictText(_StrictModel):
    value: NonEmptyText


def _config_path(config_path: Path, value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = config_path.parent / path
    return path.resolve()


def _executable_path(config_path: Path, value: str) -> Path:
    """Resolve a configured executable without dereferencing its venv symlink."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = config_path.parent / path
    return Path(os.path.abspath(path))


def _path(config_path: Path, config: DictConfig, key: str) -> Path:
    return _config_path(config_path, _required_text(config, key))


def _optional_path(config_path: Path, config: DictConfig, key: str) -> Path | None:
    if OmegaConf.select(config, key) is None:
        return None
    return _path(config_path, config, key)


def _section(config: DictConfig, key: str, model: type[_StrictModel]) -> Any:
    value = OmegaConf.select(config, key)
    if value is None:
        raise ValueError(f"experiment config section {key!r} is required")
    data = OmegaConf.to_container(value, resolve=True)
    return model.model_validate(data)


def _tracking(config_path: Path, config: DictConfig) -> TrackingConfig | None:
    if OmegaConf.select(config, "tracking") is None:
        return None
    value = _section(config, "tracking", TrackingConfig)
    return value.model_copy(
        update={"database": str(_config_path(config_path, value.database))}
    )


def _ragflow_connection(
    config_path: Path, config: DictConfig
) -> RagflowConnectionConfig:
    value = _section(config, "ragflow", RagflowConnectionConfig)
    return value.model_copy(
        update={"python": str(_executable_path(config_path, value.python))}
    )


def _ask_top_k(config: DictConfig) -> int:
    value = OmegaConf.select(config, "ask.top_k")
    return _PositiveInteger.model_validate({"value": value}).value


class _PositiveInteger(_StrictModel):
    value: PositiveInt


def _validate_score_top_k(score: ScoreConfig, *, ask_top_k: int) -> ScoreConfig:
    turn_recall = score.retrieval.turn_recall
    if turn_recall.enabled and turn_recall.k > ask_top_k:
        raise ValueError(
            f"score.retrieval.turn_recall.k={turn_recall.k} exceeds the "
            f"Ask artifact Top-K ({ask_top_k})"
        )
    return score


def _validate_score_config(
    score: ScoreConfig,
    *,
    ask_top_k: int | None,
) -> ScoreConfig:
    if ask_top_k is not None:
        return _validate_score_top_k(score, ask_top_k=ask_top_k)
    return score


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


def load_build_experiment(path: Path) -> BuildExperiment:
    config_path, raw, backend = _load_raw(path)
    _require_backend(backend, "kl_graph")
    _validate_backend_keys(raw, backend)
    return BuildExperiment(
        config_path=config_path,
        case_set=_path(config_path, raw, "case_set"),
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        build=_section(raw, "build", KLBuildConfig),
    )


def load_ask_experiment(path: Path) -> AskExperiment:
    config_path, raw, backend = _load_raw(path)
    _require_backend(backend, "kl_graph")
    _validate_backend_keys(raw, backend)
    return AskExperiment(
        config_path=config_path,
        case_set=_path(config_path, raw, "case_set"),
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
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
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
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
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
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
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        ragflow=_ragflow_connection(config_path, raw),
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
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        ragflow=_ragflow_connection(config_path, raw),
        ask=_section(raw, "ask", RagflowAskConfig),
    )


def load_generate_experiment(path: Path) -> GenerateExperiment:
    config_path, raw, backend = _load_raw(path)
    _validate_backend_keys(raw, backend)
    return GenerateExperiment(
        backend=backend,
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        case_set=_optional_path(config_path, raw, "case_set"),
        hypotheses=_path(config_path, raw, "hypotheses"),
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        ask_top_k=_ask_top_k(raw),
        generate=_section(raw, "generate", GenerateConfig),
    )


def load_score_experiment(path: Path) -> ScoreExperiment:
    config_path, raw, backend = _load_raw(path)
    _validate_backend_keys(raw, backend)
    score = _section(raw, "score", ScoreConfig)
    turn_recall = score.retrieval.turn_recall
    ask_top_k = _ask_top_k(raw) if turn_recall.enabled else None
    return ScoreExperiment(
        backend=backend,
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        case_set=_optional_path(config_path, raw, "case_set"),
        hypotheses=_path(config_path, raw, "hypotheses"),
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        ask_top_k=ask_top_k,
        score=_validate_score_config(
            score,
            ask_top_k=ask_top_k,
        ),
        tracking=_tracking(config_path, raw),
    )


def load_experiment(path: Path) -> Experiment:
    config_path, raw, backend = _load_raw(path)
    _validate_backend_keys(raw, backend)
    source = _path(config_path, raw, "source")
    hypotheses = _path(config_path, raw, "hypotheses")
    selection = _section(raw, "selection", SelectionConfig)
    run = _section(raw, "run", RunConfig)
    generate = _section(raw, "generate", GenerateConfig)
    score = _section(raw, "score", ScoreConfig)

    if backend == "kl_graph":
        ask = _section(raw, "ask", KLAskConfig)
        return KLExperiment(
            backend="kl_graph",
            config_path=config_path,
            source=source,
            case_set=_path(config_path, raw, "case_set"),
            hypotheses=hypotheses,
            selection=selection,
            run=run,
            convert=_section(raw, "convert", ConvertConfig),
            build=_section(raw, "build", KLBuildConfig),
            ask=ask,
            generate=generate,
            score=_validate_score_config(
                score,
                ask_top_k=ask.top_k,
            ),
        )

    if backend == "khoj":
        ask = _section(raw, "ask", KhojAskConfig)
        return KhojExperiment(
            backend="khoj",
            config_path=config_path,
            source=source,
            artifact_root=_path(config_path, raw, "artifact_root"),
            hypotheses=hypotheses,
            selection=selection,
            run=run,
            khoj=_section(raw, "khoj", KhojConnectionConfig),
            build=_section(raw, "build", KhojBuildConfig),
            ask=ask,
            generate=generate,
            score=_validate_score_config(
                score,
                ask_top_k=ask.top_k,
            ),
        )

    ask = _section(raw, "ask", RagflowAskConfig)
    build = _section(raw, "build", RagflowBuildConfig)
    if ask.use_kg and not build.graph:
        raise ValueError("ask.use_kg=true requires build.graph=true")
    return RagflowExperiment(
        backend="ragflow",
        config_path=config_path,
        source=source,
        artifact_root=_path(config_path, raw, "artifact_root"),
        hypotheses=hypotheses,
        selection=selection,
        run=run,
        ragflow=_ragflow_connection(config_path, raw),
        build=build,
        ask=ask,
        generate=generate,
        score=_validate_score_config(
            score,
            ask_top_k=ask.top_k,
        ),
    )


def select_entries(
    entries: list[dict[str, Any]], selection: SelectionConfig
) -> list[dict[str, Any]]:
    if selection.cases is not None:
        by_id = {str(entry["question_id"]): entry for entry in entries}
        unknown = [value for value in selection.cases if value not in by_id]
        if unknown:
            raise ValueError(f"unknown LongMemEval question ID(s): {unknown}")
        return [by_id[value] for value in selection.cases]
    if selection.first is not None:
        return entries[: selection.first]
    return entries


def output_dir(
    experiment: BuildExperiment
    | AskExperiment
    | KhojBuildExperiment
    | KhojAskExperiment
    | RagflowBuildExperiment
    | RagflowAskExperiment
    | GenerateExperiment
    | ScoreExperiment
    | Experiment,
) -> Path:
    return _config_path(experiment.config_path, experiment.run.output_dir)


def score_output(experiment: ScoreExperiment | Experiment) -> Path:
    return _config_path(experiment.config_path, experiment.score.output)


def score_metrics_output(experiment: ScoreExperiment | Experiment) -> Path:
    return _config_path(experiment.config_path, experiment.score.metrics_output)
