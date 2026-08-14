"""Run a configured LoCoMo evaluation pipeline end to end."""

from __future__ import annotations

import argparse
import json
import shlex
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.config import PROJECT_ROOT
from kl_graph.evaluation.io import (
    atomic_write_json,
    atomic_write_jsonl,
    json_lines,
)
from kl_graph.evaluation.locomo.cases import load_case_entries, select_cases
from kl_graph.evaluation.locomo.experiment import (
    BENCHMARK_NAME,
    EXPERIMENT_SCHEMA_VERSION,
    Experiment,
    KLExperiment,
    case_stage_output_dir,
    convert_output_dir,
    experiment_output_dir,
    generate_output_dir,
    load_experiment,
    run_output_dir,
    score_output_dir,
)
from kl_graph.evaluation.locomo.kl_graph.build import validate_built_case
from kl_graph.evaluation.locomo.source import (
    load_samples,
    normalize_sample_id,
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


@dataclass(frozen=True)
class CaseArtifacts:
    sample_id: str
    question_ids: tuple[str, ...]
    build: Path
    ask: Path
    generate: Path
    score: Path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def _stage_command(
    stage: str,
    experiment: Experiment,
    *,
    config_path: Path | None = None,
    case_id: str | None = None,
) -> list[str]:
    executable = sys.executable
    if stage in {"build", "ask"}:
        module = f"{experiment.backend}.{stage}"
    else:
        module = stage
    if experiment.backend == "ragflow" and stage in {"build", "ask"}:
        executable = experiment.ragflow.python
    command = [
        executable,
        "-m",
        f"kl_graph.evaluation.locomo.{module}",
        "--config",
        str(config_path or experiment.config_path),
    ]
    if case_id is not None:
        command.extend(["--case-id", case_id])
    return command


def _run_stage(
    stage: str,
    command: list[str],
    *,
    dry_run: bool,
    label: str | None = None,
) -> None:
    print(f"\n=== {(label or stage).upper()} ===", flush=True)
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
            status = validate_built_case(
                root,
                entry,
                build_dir=case_stage_output_dir(experiment, conversation_id, "build"),
            )
        except (OSError, TypeError, ValueError, RuntimeError):
            pending.append(conversation_id)
            continue
        if status is None:
            pending.append(conversation_id)
            continue
        recorded = str(
            (status.get("configuration") or {}).get("ingestion", {}).get("improve_mode")
            or ""
        )
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
                "case_set": str(convert_output_dir(experiment)),
                "convert": experiment.convert.model_dump(),
            }
        )
    else:
        resolved["artifact_root"] = str(experiment_output_dir(experiment))
        if experiment.backend == "khoj":
            resolved["khoj"] = experiment.khoj.model_dump()
        else:
            resolved["ragflow"] = experiment.ragflow.model_dump()
            resolved["ask"]["top_k_semantics"] = "vector_chunks_excluding_graph_items"
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
    """Exclude execution controls that do not change experiment semantics."""
    value = json.loads(json.dumps(resolved))
    run = value.get("run")
    if isinstance(run, dict):
        run.pop("mode", None)
        run.pop("case_concurrency", None)
    for section, keys in {
        "build": ("case_concurrency", "concurrency"),
        "ask": ("concurrency", "checkpoint_every"),
        "generate": ("concurrency", "checkpoint_every"),
    }.items():
        settings = value.get(section)
        if isinstance(settings, dict):
            for key in keys:
                settings.pop(key, None)
    return value


def _case_artifacts(
    experiment: Experiment,
    sample_id: str,
    question_ids: list[str],
) -> CaseArtifacts:
    return CaseArtifacts(
        sample_id=sample_id,
        question_ids=tuple(question_ids),
        build=case_stage_output_dir(experiment, sample_id, "build"),
        ask=case_stage_output_dir(experiment, sample_id, "ask"),
        generate=case_stage_output_dir(experiment, sample_id, "generate"),
        score=case_stage_output_dir(experiment, sample_id, "score"),
    )


def _case_executions(
    experiment: Experiment,
    selected_samples: list[dict[str, Any]],
    selected_questions: list[dict[str, Any]],
) -> list[CaseArtifacts]:
    ids_by_sample: dict[str, list[str]] = defaultdict(list)
    for row in selected_questions:
        ids_by_sample[str(row["sample_id"])].append(str(row["id"]))
    executions = [
        _case_artifacts(experiment, sample_id, ids_by_sample[sample_id])
        for sample in selected_samples
        if (sample_id := str(sample["sample_id"])) in ids_by_sample
    ]
    stems = [execution.ask.parent.name for execution in executions]
    if len(stems) != len(set(stems)):
        raise ValueError("selected LoCoMo conversation IDs collide as artifact paths")
    return executions


def _load_json_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"expected JSON object: {path}")
    return value


def _collect_case_rows(
    executions: list[CaseArtifacts],
    *,
    stage: str,
    filename: str,
    expected_ids: list[str],
) -> tuple[list[dict[str, Any]], dict[str, CaseArtifacts]]:
    by_id: dict[str, dict[str, Any]] = {}
    origins: dict[str, CaseArtifacts] = {}
    for execution in executions:
        directory = getattr(execution, stage)
        for row in json_lines(directory / filename):
            row_id = str(row.get("id") or "")
            if not row_id:
                raise ValueError(f"row has no id: {directory / filename}")
            if row_id in by_id:
                raise ValueError(f"duplicate aggregated question ID: {row_id}")
            by_id[row_id] = row
            origins[row_id] = execution
    missing = [row_id for row_id in expected_ids if row_id not in by_id]
    unknown = sorted(set(by_id).difference(expected_ids))
    if missing or unknown:
        raise ValueError(
            "case artifacts do not match the experiment selection: "
            f"missing={missing[:5]}, unknown={unknown[:5]}"
        )
    return [by_id[row_id] for row_id in expected_ids], origins


def _copy_ask_responses(
    ask_output: Path,
    results: list[dict[str, Any]],
    origins: dict[str, CaseArtifacts],
) -> None:
    for row in results:
        relative_text = str(row.get("response_path") or "")
        if not relative_text:
            raise ValueError(f"completed Ask row has no response_path: {row['id']}")
        relative = Path(relative_text)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"invalid Ask response path: {relative}")
        execution = origins[str(row["id"])]
        source = (execution.ask / relative).resolve()
        if not source.is_relative_to(execution.ask.resolve()) or not source.is_file():
            raise FileNotFoundError(source)
        destination = ask_output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def _aggregate_case_artifacts(
    experiment: Experiment,
    executions: list[CaseArtifacts],
    *,
    conversation_ids: list[str],
    selected_questions: list[dict[str, Any]],
) -> None:
    expected_ids = [str(row["id"]) for row in selected_questions]
    ask_runs = [
        _load_json_object(execution.ask / "run.json") for execution in executions
    ]
    if any(run.get("status") != "complete" for run in ask_runs):
        raise RuntimeError("cannot aggregate incomplete case Ask runs")
    results, origins = _collect_case_rows(
        executions,
        stage="ask",
        filename="results.jsonl",
        expected_ids=expected_ids,
    )
    ask_output = run_output_dir(experiment)
    _copy_ask_responses(ask_output, results, origins)
    questions = experiment.selection.questions
    ask_run = dict(ask_runs[0])
    ask_run.update(
        {
            "status": "complete",
            "run_id": ask_output.name,
            "completed_at": datetime.now().astimezone().isoformat(),
            "conversation": conversation_ids[0] if len(conversation_ids) == 1 else None,
            "conversations": conversation_ids,
            "case_root": None,
            "category": (
                questions.categories[0]
                if questions.categories is not None and len(questions.categories) == 1
                else None
            ),
            "categories": questions.categories,
            "question_id": (
                questions.ids[0]
                if questions.ids is not None and len(questions.ids) == 1
                else None
            ),
            "question_ids": questions.ids,
            "limit": questions.first,
            "questions": len(results),
            "results": len(results),
            "statuses": dict(Counter(str(row.get("status")) for row in results)),
            "case_runs": [str(execution.ask) for execution in executions],
            "execution_order": "case",
        }
    )
    for key in ("build_configuration_sha256", "documents"):
        merged: dict[str, Any] = {}
        for run in ask_runs:
            current = run.get(key)
            if isinstance(current, dict):
                merged.update(current)
        if merged:
            ask_run[key] = merged
    atomic_write_jsonl(ask_output / "results.jsonl", results)
    atomic_write_json(ask_output / "run.json", ask_run)

    generate_runs = [
        _load_json_object(execution.generate / "run.json") for execution in executions
    ]
    if any(run.get("status") != "complete" for run in generate_runs):
        raise RuntimeError("cannot aggregate incomplete case Generate runs")
    answers, _ = _collect_case_rows(
        executions,
        stage="generate",
        filename="answers.jsonl",
        expected_ids=expected_ids,
    )
    generate_output = generate_output_dir(experiment)
    generate_run = dict(generate_runs[0])
    usage_keys = {key for run in generate_runs for key in (run.get("usage") or {})}
    configuration = dict(generate_run.get("configuration") or {})
    configuration.update(
        {
            "ask_dir": str(ask_output),
            "conversations": conversation_ids,
            "questions": len(answers),
        }
    )
    failures = sum(row.get("generation_status") != "completed" for row in answers)
    generate_run.update(
        {
            "status": "complete" if not failures else "incomplete",
            "completed_at": datetime.now().astimezone().isoformat(),
            "ask_dir": str(ask_output),
            "conversation": conversation_ids[0] if len(conversation_ids) == 1 else None,
            "conversations": conversation_ids,
            "questions": len(answers),
            "answers": len(answers),
            "successful_answers": len(answers) - failures,
            "failed_answers": failures,
            "usage": {
                key: sum(
                    int((run.get("usage") or {}).get(key) or 0) for run in generate_runs
                )
                for key in sorted(usage_keys)
            },
            "configuration": configuration,
            "case_runs": [str(execution.generate) for execution in executions],
            "execution_order": "case",
        }
    )
    if failures:
        raise RuntimeError(f"cannot aggregate {failures} failed generated answers")
    atomic_write_jsonl(generate_output / "answers.jsonl", answers)
    atomic_write_json(generate_output / "run.json", generate_run)


def _print_dry_run(
    experiment: Experiment,
    executions: list[CaseArtifacts],
) -> None:
    if experiment.backend == "kl_graph":
        _run_stage("convert", _stage_command("convert", experiment), dry_run=True)
    print(
        f"\nCase workers: {min(experiment.run.case_concurrency, len(executions))}",
        flush=True,
    )
    for position, execution in enumerate(executions, 1):
        print(
            f"\n##### CASE {position}/{len(executions)}: {execution.sample_id} #####",
            flush=True,
        )
        for stage in ("build", "ask", "generate", "score"):
            _run_stage(
                stage,
                _stage_command(stage, experiment, case_id=execution.sample_id),
                dry_run=True,
            )
    print("\n=== AGGREGATE CASE ARTIFACTS ===", flush=True)
    _run_stage("score", _stage_command("score", experiment), dry_run=True)


def _run_case(
    experiment: Experiment,
    execution: CaseArtifacts,
    *,
    position: int,
    total: int,
    converted_root: Path | None,
    converted_by_sample: dict[str, dict[str, Any]],
) -> None:
    print(
        f"\n##### CASE {position}/{total}: {execution.sample_id} #####",
        flush=True,
    )
    if experiment.backend == "kl_graph":
        assert converted_root is not None
        case = converted_by_sample[normalize_sample_id(execution.sample_id)]
        if _pending_builds(converted_root, [case], experiment):
            _run_stage(
                "build",
                _stage_command("build", experiment, case_id=execution.sample_id),
                dry_run=False,
            )
        else:
            print(
                f"\n=== BUILD [{execution.sample_id}] ===\n"
                "SKIPPED complete compatible case",
                flush=True,
            )
    else:
        _run_stage(
            "build",
            _stage_command("build", experiment, case_id=execution.sample_id),
            dry_run=False,
        )
    for stage in ("ask", "generate", "score"):
        _run_stage(
            stage,
            _stage_command(stage, experiment, case_id=execution.sample_id),
            dry_run=False,
        )


def _run_case_workers(
    experiment: Experiment,
    executions: list[CaseArtifacts],
    *,
    converted_root: Path | None,
    converted_by_sample: dict[str, dict[str, Any]],
) -> None:
    workers = min(experiment.run.case_concurrency, len(executions))
    print(f"\nCase workers: {workers}", flush=True)
    failures: list[tuple[str, Exception]] = []
    futures: dict[Future[None], CaseArtifacts] = {}
    pending_executions = iter(enumerate(executions, 1))
    executor = ThreadPoolExecutor(
        max_workers=workers,
        thread_name_prefix="locomo-case",
    )

    def submit_next() -> bool:
        try:
            position, execution = next(pending_executions)
        except StopIteration:
            return False
        future = executor.submit(
            _run_case,
            experiment,
            execution,
            position=position,
            total=len(executions),
            converted_root=converted_root,
            converted_by_sample=converted_by_sample,
        )
        futures[future] = execution
        return True

    try:
        for _ in range(workers):
            submit_next()

        while futures:
            completed, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in completed:
                execution = futures.pop(future)
                try:
                    future.result()
                except Exception as exc:
                    failures.append((execution.sample_id, exc))
                    print(
                        f"error: case {execution.sample_id} failed: {exc}",
                        file=sys.stderr,
                        flush=True,
                    )
                    if not experiment.run.keep_going:
                        raise
                submit_next()
    except BaseException:
        for pending in futures:
            pending.cancel()
        executor.shutdown(wait=True, cancel_futures=True)
        raise
    else:
        executor.shutdown(wait=True)

    if failures:
        summary = ", ".join(
            f"{sample_id} ({type(exc).__name__})" for sample_id, exc in failures
        )
        raise RuntimeError(f"{len(failures)} case pipeline(s) failed: {summary}")


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        experiment = load_experiment(args.config)
        source, samples = load_samples(experiment.source)
        selected_samples = select_samples(samples, experiment.selection.conversations)
        selected_questions = question_rows(
            selected_samples, experiment.selection.questions
        )
        executions = _case_executions(experiment, selected_samples, selected_questions)
        if args.dry_run:
            _print_dry_run(experiment, executions)
            return 0

        output_root = experiment_output_dir(experiment)
        output_root.mkdir(parents=True, exist_ok=True)
        converted_root: Path | None = None
        converted_by_sample: dict[str, dict[str, Any]] = {}
        if experiment.backend == "kl_graph":
            converted = convert_output_dir(experiment)
            compatible = _conversion_is_compatible(source, converted)
            if experiment.convert.reconvert or not compatible:
                if converted.exists() and not experiment.convert.reconvert:
                    raise ValueError(
                        f"existing converted dataset is incompatible: {converted}; "
                        "set convert.reconvert=true to replace it"
                    )
                _run_stage(
                    "convert", _stage_command("convert", experiment), dry_run=False
                )
            else:
                print(
                    "\n=== CONVERT ===\nSKIPPED compatible converted dataset",
                    flush=True,
                )
            converted_root, entries = load_case_entries(converted)
            selected_cases = select_cases(entries, experiment.selection.conversations)
            converted_by_sample = {
                normalize_sample_id(str(entry["conversation_id"])): entry
                for entry in selected_cases
            }
            conversation_ids = [
                str(entry["conversation_id"]) for entry in selected_cases
            ]
        else:
            conversation_ids = [str(sample["sample_id"]) for sample in selected_samples]
        resolved_path = _write_resolved_experiment(
            output_root,
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

        _run_case_workers(
            experiment,
            executions,
            converted_root=converted_root,
            converted_by_sample=converted_by_sample,
        )

        print("\n=== AGGREGATE CASE ARTIFACTS ===", flush=True)
        _aggregate_case_artifacts(
            experiment,
            executions,
            conversation_ids=conversation_ids,
            selected_questions=selected_questions,
        )
        _run_stage("score", _stage_command("score", experiment), dry_run=False)
        print(f"\nLoCoMo pipeline complete: {output_root}", flush=True)
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
