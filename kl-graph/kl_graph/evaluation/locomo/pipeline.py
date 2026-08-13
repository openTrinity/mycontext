"""Run a configured LoCoMo evaluation pipeline end to end."""

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
from kl_graph.evaluation.locomo.cases import load_case_entries, select_cases
from kl_graph.evaluation.locomo.experiment import (
    BENCHMARK_NAME,
    EXPERIMENT_SCHEMA_VERSION,
    Experiment,
    KLExperiment,
    generate_output_dir,
    load_experiment,
    run_output_dir,
    score_output_dir,
)
from kl_graph.evaluation.locomo.kl_graph.build import validate_built_case
from kl_graph.evaluation.locomo.source import (
    load_samples,
    question_rows,
    select_samples,
    source_fingerprint,
)

RESOLVED_EXPERIMENT_NAME = "experiment.resolved.json"


class StageError(RuntimeError):
    def __init__(self, stage: str, returncode: int):
        super().__init__(f"{stage} failed with exit code {returncode}")
        self.stage = stage
        self.returncode = returncode


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def _stage_command(stage: str, experiment: Experiment) -> list[str]:
    executable = sys.executable
    if stage in {"build", "ask"}:
        module = f"{experiment.backend}.{stage}"
    else:
        module = stage
    if experiment.backend == "ragflow" and stage in {"build", "ask"}:
        executable = experiment.ragflow.python
    return [
        executable,
        "-m",
        f"kl_graph.evaluation.locomo.{module}",
        "--config",
        str(experiment.config_path),
    ]


def _run_stage(stage: str, command: list[str], *, dry_run: bool) -> None:
    print(f"\n=== {stage.upper()} ===", flush=True)
    print(shlex.join(command), flush=True)
    if dry_run:
        return
    completed = subprocess.run(command, cwd=PROJECT_ROOT, check=False)
    if completed.returncode:
        raise StageError(stage, completed.returncode)


def _conversion_is_compatible(source: Path, case_set: Path) -> bool:
    manifest_path = case_set / "manifest.json"
    if not manifest_path.is_file():
        return False
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    fingerprints = manifest.get("source_sha256") if isinstance(manifest, dict) else None
    return (
        isinstance(manifest, dict)
        and manifest.get("format") == "kl-evaluation-case-set"
        and manifest.get("dataset") == BENCHMARK_NAME
        and isinstance(fingerprints, dict)
        and fingerprints.get(source.name) == source_fingerprint(source)
    )


def _pending_builds(
    root: Path,
    selected: list[dict[str, Any]],
    experiment: KLExperiment,
) -> list[str]:
    if experiment.build.fresh:
        return [str(entry["conversation_id"]) for entry in selected]
    pending: list[str] = []
    for entry in selected:
        conversation_id = str(entry["conversation_id"])
        try:
            status = validate_built_case(root, entry)
        except (OSError, TypeError, ValueError, RuntimeError):
            pending.append(conversation_id)
            continue
        if status is None:
            pending.append(conversation_id)
            continue
        recorded = str((status.get("configuration") or {}).get("ingestion", {}).get("improve_mode") or "")
        requested = "full" if experiment.build.with_improve else "off"
        if recorded != requested:
            raise ValueError(
                f"conversation {conversation_id}: existing build uses improve_mode="
                f"{recorded!r}, requested {requested!r}; set build.fresh=true"
            )
    return pending


def _resolved_experiment(
    experiment: Experiment,
    *,
    source: Path,
    conversation_ids: list[str],
    question_ids: list[str],
) -> dict[str, Any]:
    resolved: dict[str, Any] = {
        "schema_version": EXPERIMENT_SCHEMA_VERSION,
        "benchmark": BENCHMARK_NAME,
        "backend": experiment.backend,
        "config_file": str(experiment.config_path),
        "source": str(source),
        "source_sha256": source_fingerprint(source),
        "selection": {
            "conversation_ids": conversation_ids,
            "question_ids": question_ids,
        },
        "run": {
            **experiment.run.model_dump(),
            "output_dir": str(run_output_dir(experiment)),
        },
        "build": experiment.build.model_dump(),
        "ask": experiment.ask.model_dump(),
        "generate": {
            **experiment.generate.model_dump(),
            "output_dir": str(generate_output_dir(experiment)),
        },
        "score": {
            **experiment.score.model_dump(),
            "output_dir": str(score_output_dir(experiment)),
        },
    }
    if experiment.backend == "kl_graph":
        resolved.update(
            {
                "case_set": str(experiment.case_set),
                "convert": experiment.convert.model_dump(),
            }
        )
    else:
        resolved["artifact_root"] = str(experiment.artifact_root)
        if experiment.backend == "khoj":
            resolved["khoj"] = experiment.khoj.model_dump()
        else:
            resolved["ragflow"] = experiment.ragflow.model_dump()
            resolved["ask"]["top_k_semantics"] = (
                "vector_chunks_excluding_graph_items"
            )
    return resolved


def _write_resolved_experiment(
    output_dir: Path, resolved: dict[str, Any], *, resume: bool
) -> Path:
    path = output_dir / RESOLVED_EXPERIMENT_NAME
    if path.is_file() and resume:
        existing = json.loads(path.read_text(encoding="utf-8"))
        if _resume_identity(existing) != _resume_identity(resolved):
            raise ValueError(
                f"resolved experiment configuration changed: {path}; "
                "set run.mode=overwrite or choose different output directories"
            )
    atomic_write_json(path, resolved)
    return path


def _resume_identity(resolved: dict[str, Any]) -> dict[str, Any]:
    """Exclude the execution action when comparing experiment identity."""
    value = json.loads(json.dumps(resolved))
    run = value.get("run")
    if isinstance(run, dict):
        run.pop("mode", None)
    return value


def _print_dry_run(experiment: Experiment) -> None:
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
        source, samples = load_samples(experiment.source)
        selected_samples = select_samples(
            samples, experiment.selection.conversations
        )
        selected_questions = question_rows(
            selected_samples, experiment.selection.questions
        )
        if args.dry_run:
            _print_dry_run(experiment)
            return 0

        if experiment.backend == "kl_graph":
            compatible = _conversion_is_compatible(source, experiment.case_set)
            if experiment.convert.reconvert or not compatible:
                if experiment.case_set.exists() and not experiment.convert.reconvert:
                    raise ValueError(
                        f"existing case set is incompatible: {experiment.case_set}; "
                        "set convert.reconvert=true to replace it"
                    )
                _run_stage(
                    "convert", _stage_command("convert", experiment), dry_run=False
                )
            else:
                print("\n=== CONVERT ===\nSKIPPED compatible case set", flush=True)

        ask_output = run_output_dir(experiment)
        ask_output.mkdir(parents=True, exist_ok=True)
        resolved_path = _write_resolved_experiment(
            ask_output,
            _resolved_experiment(
                experiment,
                source=source,
                conversation_ids=[
                    str(sample["sample_id"]) for sample in selected_samples
                ],
                question_ids=[str(row["id"]) for row in selected_questions],
            ),
            resume=experiment.run.mode == "resume",
        )
        print(f"experiment={resolved_path}", flush=True)

        if experiment.backend == "kl_graph":
            root, entries = load_case_entries(experiment.case_set)
            selected_cases = select_cases(
                entries, experiment.selection.conversations
            )
            pending = _pending_builds(root, selected_cases, experiment)
            if pending:
                _run_stage(
                    "build", _stage_command("build", experiment), dry_run=False
                )
            else:
                print(
                    "\n=== BUILD ===\nSKIPPED complete compatible builds",
                    flush=True,
                )
        else:
            _run_stage("build", _stage_command("build", experiment), dry_run=False)

        for stage in ("ask", "generate", "score"):
            _run_stage(stage, _stage_command(stage, experiment), dry_run=False)
        print(f"\nLoCoMo pipeline complete: {ask_output}", flush=True)
        return 0
    except KeyboardInterrupt:
        print("\nLoCoMo pipeline interrupted", file=sys.stderr)
        return 130
    except StageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.returncode or 1
    except (
        OSError,
        TypeError,
        ValueError,
        RuntimeError,
        json.JSONDecodeError,
        OmegaConfBaseException,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
