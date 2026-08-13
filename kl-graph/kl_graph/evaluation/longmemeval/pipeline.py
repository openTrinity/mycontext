"""Run a configured LongMemEval evaluation pipeline end to end.

This module is only an orchestrator. Conversion, graph construction,
retrieval, generation, and QA judging remain owned by their existing modules:

    KL Graph: convert -> build -> ask -> generate -> score
    Khoj:             build -> ask -> generate -> score
    RAGFlow:           build -> ask -> generate -> score

Run behavior and every experiment value come from one required YAML file.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.config import PROJECT_ROOT
from kl_graph.evaluation.io import atomic_write_json
from kl_graph.evaluation.longmemeval.experiment import (
    BENCHMARK_NAME,
    EXPERIMENT_SCHEMA_VERSION,
    Experiment,
    KLExperiment,
    load_experiment,
    output_dir,
    score_metrics_output,
    score_output,
    select_entries,
)
from kl_graph.evaluation.longmemeval.kl_graph.build import (
    _load_case_entries,
    validate_built_case,
)
from kl_graph.evaluation.longmemeval.source import (
    load_cases,
    resolve_source,
    source_fingerprint,
)

RESOLVED_EXPERIMENT_NAME = "experiment.resolved.json"


class StageError(RuntimeError):
    """Raised when one pipeline subprocess fails."""

    def __init__(self, stage: str, returncode: int):
        super().__init__(f"{stage} failed with exit code {returncode}")
        self.stage = stage
        self.returncode = returncode


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        required=True,
        help="LongMemEval experiment YAML",
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def _resolved_experiment(
    *,
    experiment: Experiment,
    source: Path,
    output_dir: Path,
    question_ids: list[str],
) -> dict[str, Any]:
    """Return the credential-free configuration that determines this run."""
    score = experiment.score.model_dump()
    score["output"] = str(score_output(experiment))
    score["metrics_output"] = str(score_metrics_output(experiment))
    score["judge"]["label_parser"] = "official_substring_yes"
    resolved = {
        "schema_version": EXPERIMENT_SCHEMA_VERSION,
        "benchmark": BENCHMARK_NAME,
        "backend": experiment.backend,
        "config_file": str(experiment.config_path),
        "source": str(source),
        "source_sha256": source_fingerprint(source),
        "hypotheses": str(experiment.hypotheses),
        "selection": {"question_ids": question_ids},
        "run": {
            **experiment.run.model_dump(),
            "output_dir": str(output_dir),
        },
        "build": experiment.build.model_dump(),
        "generate": experiment.generate.model_dump(),
        "score": score,
    }
    if experiment.backend == "kl_graph":
        resolved.update(
            {
                "case_set": str(experiment.case_set),
                "convert": experiment.convert.model_dump(),
                "ask": {
                    **experiment.ask.model_dump(),
                    "phase2": False,
                },
            }
        )
    elif experiment.backend == "khoj":
        resolved.update(
            {
                "artifact_root": str(experiment.artifact_root),
                "khoj": experiment.khoj.model_dump(),
                "ask": {
                    **experiment.ask.model_dump(),
                    "rerank": True,
                    "dedupe": False,
                    "content_type": "plaintext",
                    "document_filter": "exact_filename",
                    "source_turn_mapping": "uploaded_document_character_spans_v1",
                },
            }
        )
    else:
        resolved.update(
            {
                "artifact_root": str(experiment.artifact_root),
                "ragflow": experiment.ragflow.model_dump(),
                "ask": {
                    **experiment.ask.model_dump(),
                    "requested_result_count": experiment.ask.top_k,
                    "source_turn_mapping": (
                        "uploaded_document_normalized_character_spans_v1"
                    ),
                    "top_k_semantics": "vector_chunks_excluding_graph_items",
                },
            }
        )
    return resolved


def _write_resolved_experiment(
    output_dir: Path,
    experiment: dict[str, Any],
    *,
    resume: bool,
) -> Path:
    path = output_dir / RESOLVED_EXPERIMENT_NAME
    if path.is_file() and resume:
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing != experiment:
            raise ValueError(
                f"resolved experiment configuration changed: {path}; "
                "set run.mode=overwrite or choose a different run.output_dir"
            )
    atomic_write_json(path, experiment)
    return path


def _run_stage(stage: str, command: list[str], *, dry_run: bool) -> None:
    print(f"\n=== {stage.upper()} ===", flush=True)
    print(shlex.join(command), flush=True)
    if dry_run:
        return
    completed = subprocess.run(command, cwd=PROJECT_ROOT, check=False)
    if completed.returncode:
        raise StageError(stage, completed.returncode)


def _conversion_is_compatible(
    source: Path,
    case_set: Path,
    timezone_name: str,
) -> bool:
    manifest_path = case_set / "manifest.json"
    if not manifest_path.is_file():
        return False
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return (
        isinstance(manifest, dict)
        and manifest.get("format") == "kl-evaluation-case-set"
        and manifest.get("dataset") == "longmemeval"
        and manifest.get("source_sha256") == source_fingerprint(source)
        and manifest.get("timezone") == timezone_name
    )


def _stage_command(stage: str, experiment: Experiment) -> list[str]:
    module = stage
    executable = sys.executable
    if stage in {"build", "ask"}:
        module = f"{experiment.backend}.{stage}"
    if experiment.backend == "ragflow" and stage in {"build", "ask"}:
        executable = experiment.ragflow.python
    return [
        executable,
        "-m",
        f"kl_graph.evaluation.longmemeval.{module}",
        "--config",
        str(experiment.config_path),
    ]


def _pending_builds(
    root: Path,
    selected: list[dict[str, Any]],
    experiment: KLExperiment,
) -> list[str]:
    if experiment.build.fresh:
        return [str(entry["question_id"]) for entry in selected]
    pending: list[str] = []
    for entry in selected:
        question_id = str(entry["question_id"])
        try:
            status = validate_built_case(root, entry)
        except (OSError, TypeError, ValueError, RuntimeError):
            pending.append(question_id)
            continue
        if status is None:  # pragma: no cover - default validation returns a status
            pending.append(question_id)
            continue
        recorded_improve = bool(status.get("with_improve"))
        if recorded_improve != experiment.build.with_improve:
            raise ValueError(
                f"case {question_id}: existing build uses with_improve="
                f"{recorded_improve}, requested {experiment.build.with_improve}; "
                "set build.fresh=true to rebuild it"
            )
    return pending


def _print_dry_run(
    experiment: Experiment,
) -> None:
    stages = (
        ("convert", "build", "ask", "generate", "score")
        if experiment.backend == "kl_graph"
        else ("build", "ask", "generate", "score")
    )
    for stage in stages:
        _run_stage(stage, _stage_command(stage, experiment), dry_run=True)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        experiment = load_experiment(args.config)
    except (OSError, TypeError, ValueError, OmegaConfBaseException) as exc:
        print(f"error: invalid experiment configuration: {exc}", file=sys.stderr)
        return 2
    try:
        source = resolve_source(experiment.source)
        run_output_dir = output_dir(experiment)
        if args.dry_run:
            _print_dry_run(experiment)
            return 0

        if experiment.backend == "kl_graph":
            case_set = experiment.case_set
            compatible = _conversion_is_compatible(
                source, case_set, experiment.convert.timezone
            )
            if experiment.convert.reconvert or not compatible:
                if case_set.exists() and not experiment.convert.reconvert:
                    raise ValueError(
                        f"existing case set is incompatible: {case_set}; "
                        "set convert.reconvert=true to replace it"
                    )
                _run_stage(
                    "convert",
                    _stage_command("convert", experiment),
                    dry_run=False,
                )
            else:
                print("\n=== CONVERT ===\nSKIPPED compatible case set", flush=True)
            root, entries = _load_case_entries(case_set)
        else:
            _, entries = load_cases(source)
            root = None

        selected = select_entries(entries, experiment.selection)
        selected_ids = [str(entry["question_id"]) for entry in selected]
        run_output_dir.mkdir(parents=True, exist_ok=True)
        experiment_path = _write_resolved_experiment(
            run_output_dir,
            _resolved_experiment(
                experiment=experiment,
                source=source,
                output_dir=run_output_dir,
                question_ids=selected_ids,
            ),
            resume=experiment.run.mode == "resume",
        )
        print(f"experiment={experiment_path}", flush=True)

        if experiment.backend != "kl_graph":
            _run_stage(
                "build",
                _stage_command("build", experiment),
                dry_run=False,
            )
        else:
            assert root is not None
            pending_builds = _pending_builds(root, selected, experiment)
            if pending_builds:
                _run_stage(
                    "build",
                    _stage_command("build", experiment),
                    dry_run=False,
                )
            else:
                print(
                    "\n=== BUILD ===\nSKIPPED complete compatible builds",
                    flush=True,
                )

        _run_stage("ask", _stage_command("ask", experiment), dry_run=False)
        _run_stage(
            "generate", _stage_command("generate", experiment), dry_run=False
        )

        _run_stage("score", _stage_command("score", experiment), dry_run=False)
        print(f"\nLongMemEval pipeline complete: {run_output_dir}", flush=True)
        return 0
    except KeyboardInterrupt:
        print("\nLongMemEval pipeline interrupted", file=sys.stderr)
        return 130
    except StageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.returncode or 1
    except (OSError, TypeError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
