"""Run a configured LongMemEval evaluation case by case."""

from __future__ import annotations

import argparse
import json
import shlex
import shutil
import subprocess
import sys
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.config import PROJECT_ROOT
from kl_graph.evaluation.io import (
    artifact_stem,
    atomic_write_json,
    atomic_write_jsonl,
    json_lines,
)
from kl_graph.evaluation.longmemeval.experiment import (
    BENCHMARK_NAME,
    EXPERIMENT_SCHEMA_VERSION,
    Experiment,
    KLExperiment,
    case_stage_output_dir,
    convert_output_dir,
    experiment_output_dir,
    generate_output_dir,
    hypotheses_output,
    load_experiment,
    output_dir,
    score_output_dir,
    select_entries,
)
from kl_graph.evaluation.longmemeval.kl_graph.build import (
    _load_case_entries,
    validate_built_case,
)
from kl_graph.evaluation.longmemeval.source import (
    load_cases,
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
    question_id: str
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
    case_id: str | None = None,
    aggregate_cases: bool = False,
) -> list[str]:
    executable = sys.executable
    module = stage
    if stage in {"build", "ask"}:
        module = f"{experiment.backend}.{stage}"
    if experiment.backend == "ragflow" and stage in {"build", "ask"}:
        executable = experiment.ragflow.python
    command = [
        executable,
        "-m",
        f"kl_graph.evaluation.longmemeval.{module}",
        "--config",
        str(experiment.config_path),
    ]
    if case_id is not None:
        command.extend(["--case-id", case_id])
    if aggregate_cases:
        command.append("--aggregate-cases")
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
        and manifest.get("dataset") == BENCHMARK_NAME
        and manifest.get("source_sha256") == source_fingerprint(source)
        and manifest.get("timezone") == timezone_name
    )


def _build_is_pending(
    root: Path,
    entry: dict[str, Any],
    experiment: KLExperiment,
) -> bool:
    if experiment.build.fresh:
        return True
    question_id = str(entry["question_id"])
    try:
        status = validate_built_case(
            root,
            entry,
            build_dir=case_stage_output_dir(experiment, question_id, "build"),
        )
    except (OSError, TypeError, ValueError, RuntimeError):
        return True
    if status is None:
        return True
    recorded = bool(status.get("with_improve"))
    if recorded != experiment.build.with_improve:
        raise ValueError(
            f"case {question_id}: existing build uses with_improve={recorded}, "
            f"requested {experiment.build.with_improve}; set build.fresh=true"
        )
    return False


def _resolved_experiment(
    experiment: Experiment,
    *,
    source: Path,
    question_ids: list[str],
) -> dict[str, Any]:
    resolved: dict[str, Any] = {
        "schema_version": EXPERIMENT_SCHEMA_VERSION,
        "benchmark": BENCHMARK_NAME,
        "backend": experiment.backend,
        "config_file": str(experiment.config_path),
        "source": str(source),
        "source_sha256": source_fingerprint(source),
        "selection": {"question_ids": question_ids},
        "run": {
            **experiment.run.model_dump(),
            "output_dir": str(output_dir(experiment)),
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
            "judge_label_parser": "official_substring_yes",
        },
    }
    if experiment.backend == "kl_graph":
        resolved.update(
            {
                "convert": experiment.convert.model_dump(),
                "converted_dataset": str(convert_output_dir(experiment)),
                "ask_protocol": {"phase2": False},
            }
        )
    elif experiment.backend == "khoj":
        resolved.update(
            {
                "artifact_root": str(experiment_output_dir(experiment)),
                "khoj": experiment.khoj.model_dump(),
                "ask_protocol": {
                    "rerank": True,
                    "dedupe": False,
                    "source_turn_mapping": "uploaded_document_character_spans_v1",
                },
            }
        )
    else:
        resolved.update(
            {
                "artifact_root": str(experiment_output_dir(experiment)),
                "ragflow": experiment.ragflow.model_dump(),
                "ask_protocol": {
                    "source_turn_mapping": (
                        "uploaded_document_normalized_character_spans_v1"
                    ),
                    "top_k_semantics": "vector_chunks_excluding_graph_items",
                },
            }
        )
    return resolved


def _resume_identity(value: dict[str, Any]) -> dict[str, Any]:
    identity = json.loads(json.dumps(value))
    run = identity.get("run")
    if isinstance(run, dict):
        run.pop("mode", None)
        run.pop("case_concurrency", None)
    for section, keys in {
        # Accept resolved files written before case concurrency moved to run.
        "build": ("case_concurrency", "concurrency"),
        "ask": ("case_concurrency", "concurrency", "checkpoint_every"),
        "generate": ("concurrency",),
        "score": ("concurrency",),
    }.items():
        settings = identity.get(section)
        if isinstance(settings, dict):
            for key in keys:
                settings.pop(key, None)
    return identity


def _write_resolved_experiment(
    root: Path,
    resolved: dict[str, Any],
    *,
    resume: bool,
) -> Path:
    path = root / RESOLVED_EXPERIMENT_NAME
    if path.is_file() and resume:
        existing = json.loads(path.read_text(encoding="utf-8"))
        if _resume_identity(existing) != _resume_identity(resolved):
            raise ValueError(
                f"resolved experiment configuration changed: {path}; "
                "set run.mode=overwrite or choose different output directories"
            )
    atomic_write_json(path, resolved)
    return path


def _case_artifacts(experiment: Experiment, question_id: str) -> CaseArtifacts:
    return CaseArtifacts(
        question_id=question_id,
        build=case_stage_output_dir(experiment, question_id, "build"),
        ask=case_stage_output_dir(experiment, question_id, "ask"),
        generate=case_stage_output_dir(experiment, question_id, "generate"),
        score=case_stage_output_dir(experiment, question_id, "score"),
    )


def _case_executions(
    experiment: Experiment, question_ids: list[str]
) -> list[CaseArtifacts]:
    executions = [_case_artifacts(experiment, value) for value in question_ids]
    stems = [execution.build.parent.name for execution in executions]
    if len(stems) != len(set(stems)):
        raise ValueError("selected LongMemEval question IDs collide as artifact paths")
    return executions


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"expected JSON object: {path}")
    return value


def _copy_response(
    source_root: Path,
    relative_text: str,
    destination_root: Path,
    question_id: str,
) -> str:
    relative = Path(relative_text)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"invalid Ask response path: {relative}")
    source = (source_root / relative).resolve()
    if not source.is_relative_to(source_root.resolve()) or not source.is_file():
        raise FileNotFoundError(source)
    destination_relative = Path("responses") / f"{artifact_stem(question_id)}.json"
    destination = destination_root / destination_relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return str(destination_relative)


def _aggregate_ask(
    experiment: Experiment,
    executions: list[CaseArtifacts],
    source: Path,
) -> None:
    destination = output_dir(experiment)
    rows: list[dict[str, Any]] = []
    for execution in executions:
        if experiment.backend == "kl_graph":
            source_path = execution.ask / "result.json"
            artifact = _load_json(source_path)
            if artifact.get("question_id") != execution.question_id:
                raise ValueError(f"Ask result ID mismatch: {source_path}")
            relative = (
                Path("responses") / f"{artifact_stem(execution.question_id)}.json"
            )
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, target)
            rows.append(
                {
                    "question_id": execution.question_id,
                    "status": "completed",
                    "response_path": str(relative),
                }
            )
            continue
        run = _load_json(execution.ask / "run.json")
        if run.get("status") != "complete":
            raise RuntimeError(f"case Ask is incomplete: {execution.ask}")
        case_rows = list(json_lines(execution.ask / "results.jsonl"))
        if (
            len(case_rows) != 1
            or case_rows[0].get("question_id") != execution.question_id
        ):
            raise RuntimeError(f"case Ask row mismatch: {execution.ask}")
        row = dict(case_rows[0])
        row["response_path"] = _copy_response(
            execution.ask,
            str(row.get("response_path") or ""),
            destination,
            execution.question_id,
        )
        rows.append(row)

    question_ids = [execution.question_id for execution in executions]
    run: dict[str, Any] = {
        "status": "complete",
        "backend": experiment.backend,
        "benchmark": BENCHMARK_NAME,
        "completed_at": datetime.now().astimezone().isoformat(),
        "source": str(source),
        "source_sha256": source_fingerprint(source),
        "question_ids": question_ids,
        "questions": len(rows),
        "results": len(rows),
        "top_k": experiment.ask.top_k,
        "case_runs": [str(execution.ask) for execution in executions],
        "execution_order": "case",
    }
    if experiment.backend == "khoj":
        run["source_turn_mapping"] = "uploaded_document_character_spans_v1"
    elif experiment.backend == "ragflow":
        run.update(
            {
                "source_turn_mapping": (
                    "uploaded_document_normalized_character_spans_v1"
                ),
                "top_k_semantics": "vector_chunks_excluding_graph_items",
            }
        )
    atomic_write_jsonl(destination / "results.jsonl", rows)
    atomic_write_json(destination / "run.json", run)


def _aggregate_generate(
    experiment: Experiment,
    executions: list[CaseArtifacts],
) -> None:
    rows: list[dict[str, Any]] = []
    for execution in executions:
        run = _load_json(execution.generate / "run.json")
        if run.get("status") != "complete":
            raise RuntimeError(f"case Generate is incomplete: {execution.generate}")
        case_rows = list(json_lines(execution.generate / "hypotheses.jsonl"))
        if (
            len(case_rows) != 1
            or case_rows[0].get("question_id") != execution.question_id
        ):
            raise RuntimeError(f"case Generate row mismatch: {execution.generate}")
        rows.extend(case_rows)
    output = hypotheses_output(experiment)
    atomic_write_jsonl(output, rows)
    atomic_write_json(
        generate_output_dir(experiment) / "run.json",
        {
            "status": "complete",
            "completed_at": datetime.now().astimezone().isoformat(),
            "question_ids": [execution.question_id for execution in executions],
            "questions": len(rows),
            "case_runs": [str(execution.generate) for execution in executions],
            "execution_order": "case",
        },
    )


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
            f"\n##### CASE {position}/{len(executions)}: {execution.question_id} #####",
            flush=True,
        )
        for stage in ("build", "ask", "generate", "score"):
            _run_stage(
                stage,
                _stage_command(stage, experiment, case_id=execution.question_id),
                dry_run=True,
            )
    print("\n=== AGGREGATE CASE ARTIFACTS ===", flush=True)
    _run_stage(
        "score",
        _stage_command("score", experiment, aggregate_cases=True),
        dry_run=True,
        label="aggregate score",
    )


def _run_case(
    experiment: Experiment,
    execution: CaseArtifacts,
    *,
    position: int,
    total: int,
    converted_root: Path | None,
    converted_by_id: dict[str, dict[str, Any]],
) -> None:
    print(
        f"\n##### CASE {position}/{total}: {execution.question_id} #####",
        flush=True,
    )
    if experiment.backend == "kl_graph":
        assert converted_root is not None
        entry = converted_by_id[execution.question_id]
        if _build_is_pending(converted_root, entry, experiment):
            _run_stage(
                "build",
                _stage_command("build", experiment, case_id=execution.question_id),
                dry_run=False,
            )
        else:
            print(
                f"\n=== BUILD [{execution.question_id}] ===\n"
                "SKIPPED complete compatible case",
                flush=True,
            )
    else:
        _run_stage(
            "build",
            _stage_command("build", experiment, case_id=execution.question_id),
            dry_run=False,
        )
    for stage in ("ask", "generate", "score"):
        _run_stage(
            stage,
            _stage_command(stage, experiment, case_id=execution.question_id),
            dry_run=False,
        )


def _run_case_workers(
    experiment: Experiment,
    executions: list[CaseArtifacts],
    *,
    converted_root: Path | None,
    converted_by_id: dict[str, dict[str, Any]],
) -> None:
    workers = min(experiment.run.case_concurrency, len(executions))
    print(f"\nCase workers: {workers}", flush=True)
    failures: list[tuple[str, Exception]] = []
    futures: dict[Future[None], CaseArtifacts] = {}
    pending_executions = iter(enumerate(executions, 1))
    executor = ThreadPoolExecutor(
        max_workers=workers,
        thread_name_prefix="longmemeval-case",
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
            converted_by_id=converted_by_id,
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
                    failures.append((execution.question_id, exc))
                    print(
                        f"error: case {execution.question_id} failed: {exc}",
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
            f"{question_id} ({type(exc).__name__})"
            for question_id, exc in failures
        )
        raise RuntimeError(f"{len(failures)} case pipeline(s) failed: {summary}")


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        experiment = load_experiment(args.config)
        source, entries = load_cases(experiment.source)
        selected = select_entries(entries, experiment.selection)
        question_ids = [str(entry["question_id"]) for entry in selected]
        executions = _case_executions(experiment, question_ids)
        if args.dry_run:
            _print_dry_run(experiment, executions)
            return 0

        root_dir = experiment_output_dir(experiment)
        root_dir.mkdir(parents=True, exist_ok=True)
        converted_root: Path | None = None
        converted_by_id: dict[str, dict[str, Any]] = {}
        if experiment.backend == "kl_graph":
            converted = convert_output_dir(experiment)
            compatible = _conversion_is_compatible(
                source, converted, experiment.convert.timezone
            )
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
            converted_root, converted_entries = _load_case_entries(converted)
            converted_by_id = {
                str(entry["question_id"]): entry for entry in converted_entries
            }

        resolved_path = _write_resolved_experiment(
            root_dir,
            _resolved_experiment(
                experiment,
                source=source,
                question_ids=question_ids,
            ),
            resume=experiment.run.mode == "resume",
        )
        print(f"experiment={resolved_path}", flush=True)

        _run_case_workers(
            experiment,
            executions,
            converted_root=converted_root,
            converted_by_id=converted_by_id,
        )

        print("\n=== AGGREGATE CASE ARTIFACTS ===", flush=True)
        _aggregate_ask(experiment, executions, source)
        _aggregate_generate(experiment, executions)
        _run_stage(
            "score",
            _stage_command("score", experiment, aggregate_cases=True),
            dry_run=False,
            label="aggregate score",
        )
        print(f"\nLongMemEval pipeline complete: {root_dir}", flush=True)
        return 0
    except KeyboardInterrupt:
        print("\nLongMemEval pipeline interrupted", file=sys.stderr)
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
