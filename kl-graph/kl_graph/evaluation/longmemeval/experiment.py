"""Load and validate LongMemEval experiment YAML files.

Experiment values live in YAML.  This module owns the single schema used by
all five standalone stages and by the end-to-end pipeline.  Stage
loaders resolve only the sections they consume so, for example, Score does not
require environment interpolation used only by Ask.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal

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
BENCHMARK_NAME = "longmemeval"
PROMPT_RESERVE_TOKENS = 1_000

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


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


class BuildConfig(_StrictModel):
    with_improve: bool
    fresh: bool
    keep_cache: bool
    case_concurrency: PositiveInt
    concurrency: PositiveInt


class AskConfig(_StrictModel):
    case_concurrency: PositiveInt
    rerank_base_url: NonEmptyText
    rerank_model: NonEmptyText
    top_k: PositiveInt
    server_start_timeout_seconds: PositiveFloat
    request_timeout_seconds: PositiveFloat


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


class _IdentityConfig(_StrictModel):
    schema_version: Literal[EXPERIMENT_SCHEMA_VERSION]
    benchmark: Literal[BENCHMARK_NAME]


_ROOT_KEYS = {
    "schema_version",
    "benchmark",
    "source",
    "case_set",
    "hypotheses",
    "selection",
    "run",
    "convert",
    "build",
    "ask",
    "generate",
    "score",
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
    build: BuildConfig


@dataclass(frozen=True)
class AskExperiment:
    config_path: Path
    case_set: Path
    selection: SelectionConfig
    run: RunConfig
    ask: AskConfig


@dataclass(frozen=True)
class GenerateExperiment:
    config_path: Path
    case_set: Path
    hypotheses: Path
    selection: SelectionConfig
    run: RunConfig
    ask_top_k: int
    generate: GenerateConfig


@dataclass(frozen=True)
class ScoreExperiment:
    config_path: Path
    source: Path
    case_set: Path
    hypotheses: Path
    selection: SelectionConfig
    run: RunConfig
    ask_top_k: int | None
    score: ScoreConfig


@dataclass(frozen=True)
class Experiment:
    config_path: Path
    source: Path
    case_set: Path
    hypotheses: Path
    selection: SelectionConfig
    run: RunConfig
    convert: ConvertConfig
    build: BuildConfig
    ask: AskConfig
    generate: GenerateConfig
    score: ScoreConfig


def _load_raw(path: Path) -> tuple[Path, DictConfig]:
    config_path = path.expanduser().resolve()
    if not config_path.is_file():
        raise FileNotFoundError(config_path)
    config = OmegaConf.load(config_path)
    if not isinstance(config, DictConfig):
        raise TypeError("experiment config root must be a mapping")
    unknown = sorted(set(config.keys()).difference(_ROOT_KEYS))
    if unknown:
        raise ValueError(f"unknown experiment config keys: {unknown}")
    identity = {
        "schema_version": OmegaConf.select(config, "schema_version"),
        "benchmark": OmegaConf.select(config, "benchmark"),
    }
    _IdentityConfig.model_validate(identity)
    return config_path, config


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


def _path(config_path: Path, config: DictConfig, key: str) -> Path:
    return _config_path(config_path, _required_text(config, key))


def _section(config: DictConfig, key: str, model: type[_StrictModel]) -> Any:
    value = OmegaConf.select(config, key)
    if value is None:
        raise ValueError(f"experiment config section {key!r} is required")
    data = OmegaConf.to_container(value, resolve=True)
    return model.model_validate(data)


def _ask_top_k(config: DictConfig) -> int:
    value = OmegaConf.select(config, "ask.top_k")
    return _PositiveInteger.model_validate({"value": value}).value


class _PositiveInteger(_StrictModel):
    value: PositiveInt


def _validate_score_top_k(
    score: ScoreConfig,
    *,
    ask_top_k: int,
) -> ScoreConfig:
    turn_recall = score.retrieval.turn_recall
    if turn_recall.enabled and turn_recall.k > ask_top_k:
        raise ValueError(
            f"score.retrieval.turn_recall.k={turn_recall.k} exceeds the "
            f"Ask artifact Top-K ({ask_top_k})"
        )
    return score


def load_convert_experiment(path: Path) -> ConvertExperiment:
    config_path, raw = _load_raw(path)
    return ConvertExperiment(
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        case_set=_path(config_path, raw, "case_set"),
        convert=_section(raw, "convert", ConvertConfig),
    )


def load_build_experiment(path: Path) -> BuildExperiment:
    config_path, raw = _load_raw(path)
    return BuildExperiment(
        config_path=config_path,
        case_set=_path(config_path, raw, "case_set"),
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        build=_section(raw, "build", BuildConfig),
    )


def load_ask_experiment(path: Path) -> AskExperiment:
    config_path, raw = _load_raw(path)
    return AskExperiment(
        config_path=config_path,
        case_set=_path(config_path, raw, "case_set"),
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        ask=_section(raw, "ask", AskConfig),
    )


def load_generate_experiment(path: Path) -> GenerateExperiment:
    config_path, raw = _load_raw(path)
    return GenerateExperiment(
        config_path=config_path,
        case_set=_path(config_path, raw, "case_set"),
        hypotheses=_path(config_path, raw, "hypotheses"),
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        ask_top_k=_ask_top_k(raw),
        generate=_section(raw, "generate", GenerateConfig),
    )


def load_score_experiment(path: Path) -> ScoreExperiment:
    config_path, raw = _load_raw(path)
    score = _section(raw, "score", ScoreConfig)
    ask_top_k = _ask_top_k(raw) if score.retrieval.turn_recall.enabled else None
    if ask_top_k is not None:
        _validate_score_top_k(score, ask_top_k=ask_top_k)
    return ScoreExperiment(
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        case_set=_path(config_path, raw, "case_set"),
        hypotheses=_path(config_path, raw, "hypotheses"),
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        ask_top_k=ask_top_k,
        score=score,
    )


def load_experiment(path: Path) -> Experiment:
    config_path, raw = _load_raw(path)
    ask = _section(raw, "ask", AskConfig)
    return Experiment(
        config_path=config_path,
        source=_path(config_path, raw, "source"),
        case_set=_path(config_path, raw, "case_set"),
        hypotheses=_path(config_path, raw, "hypotheses"),
        selection=_section(raw, "selection", SelectionConfig),
        run=_section(raw, "run", RunConfig),
        convert=_section(raw, "convert", ConvertConfig),
        build=_section(raw, "build", BuildConfig),
        ask=ask,
        generate=_section(raw, "generate", GenerateConfig),
        score=_validate_score_top_k(
            _section(raw, "score", ScoreConfig), ask_top_k=ask.top_k
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
    | GenerateExperiment
    | ScoreExperiment
    | Experiment,
) -> Path:
    return _config_path(experiment.config_path, experiment.run.output_dir)


def score_output(experiment: ScoreExperiment | Experiment) -> Path:
    return _config_path(experiment.config_path, experiment.score.output)


def score_metrics_output(experiment: ScoreExperiment | Experiment) -> Path:
    return _config_path(experiment.config_path, experiment.score.metrics_output)
