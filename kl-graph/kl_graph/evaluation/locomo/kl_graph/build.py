"""Build one isolated production KL graph per converted LoCoMo conversation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.config import PROJECT_ROOT
from kl_graph.evaluation.build_contract import (
    BUILD_STATUS_SCHEMA_VERSION,
    configuration_fingerprint,
    load_ingest_result,
    production_build_configuration,
    require_successful_ingest,
    validate_production_build_status,
)
from kl_graph.evaluation.io import json_lines
from kl_graph.evaluation.locomo.cases import (
    CASE_DATA_DIRNAME,
    DATASET_NAME,
    load_case_entries,
    resolve_case_root,
    select_cases,
)
from kl_graph.evaluation.locomo.experiment import (
    KLBuildExperiment,
    case_stage_output_dir,
    convert_output_dir,
    load_kl_build_experiment,
)
from kl_graph.evaluation.locomo.source import normalize_sample_id

_OUTPUT_LOCK = threading.Lock()


def case_source_id(conversation_id: str) -> str:
    """Return the stable production-ingest namespace for one conversation."""
    return f"locomo-{conversation_id}"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--case-id")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def _runtime_options(
    experiment: KLBuildExperiment, *, dry_run: bool
) -> argparse.Namespace:
    return argparse.Namespace(
        case_concurrency=experiment.build.case_concurrency,
        concurrency=experiment.build.concurrency,
        dry_run=dry_run,
        fresh=experiment.build.fresh,
        keep_going=experiment.run.keep_going,
        no_keep_cache=not experiment.build.keep_cache,
        with_improve=experiment.build.with_improve,
    )


def case_environment(
    base: dict[str, str],
    case_set_root: Path,
    case: dict[str, Any],
    *,
    build_dir: Path | None = None,
) -> dict[str, str]:
    case_root = resolve_case_root(case_set_root, case)
    dws_root = case_root / "dws"
    data_dir = (build_dir or case_root) / CASE_DATA_DIRNAME
    conversation_id = str(case["conversation_id"])
    env = base.copy()
    env["KL_DWS_EXPORT_DIR"] = str(dws_root)
    env["KL_DATA_DIR"] = str(data_dir)
    env["KL_GRAPH_DB_PATH"] = str(data_dir / "graph.ladybug")
    digest = hashlib.sha256(conversation_id.encode()).hexdigest()[:16]
    env["KL_FALKOR_GRAPH"] = f"locomo_{digest}"
    return env


def validate_built_case(
    case_set_root: Path,
    case: dict[str, Any],
    *,
    build_dir: Path | None = None,
    check_build_status: bool = True,
) -> dict[str, Any] | None:
    """Require one complete physical graph for exactly one conversation."""
    case_root = resolve_case_root(case_set_root, case)
    build_root = build_dir or case_root
    conversation_id = str(case["conversation_id"])
    build_status = None
    if check_build_status:
        build_status = validate_production_build_status(
            build_root / "build_status.json",
            dataset=DATASET_NAME,
            source_id=case_source_id(conversation_id),
        )
    sqlite_path = build_root / CASE_DATA_DIRNAME / "knowledge.db"
    if not sqlite_path.is_file():
        raise FileNotFoundError(sqlite_path)
    uri = f"{sqlite_path.resolve().as_uri()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        tables = {
            str(row[0])
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        required = {"chunks", "facts"}
        if not required.issubset(tables):
            raise RuntimeError(
                f"incomplete production graph {sqlite_path}; "
                f"missing {sorted(required - tables)}"
            )
        conversations: set[str] = set()
        source_ids: set[str] = set()
        for chunk_id, raw_metadata in conn.execute(
            "SELECT id, metadata FROM chunks WHERE source_type = 'message'"
        ):
            try:
                metadata = json.loads(raw_metadata or "{}")
            except (TypeError, json.JSONDecodeError):
                metadata = {}
            value = str(metadata.get("conversation_id") or "")
            if value:
                conversations.add(value)
            members = metadata.get("member_message_ids")
            if isinstance(members, list):
                source_ids.update(str(value) for value in members if value)
            else:
                source_ids.add(str(chunk_id))
        expected_conversation = f"{case_source_id(conversation_id)}:{conversation_id}"
        if conversations != {expected_conversation}:
            raise RuntimeError(
                f"physical graph conversation mismatch: expected "
                f"{conversation_id!r}, found {sorted(conversations)!r}"
            )
        expected_ids = {
            str(row.get("id"))
            for row in json_lines(case_root / "dws" / "chat" / "records.jsonl")
            if row.get("type") == "message" and row.get("id")
        }
        if source_ids != expected_ids:
            raise RuntimeError(
                f"physical graph message mismatch for {conversation_id}: "
                f"expected {len(expected_ids)}, found {len(source_ids)}"
            )
        missing_fact_sources = int(
            conn.execute(
                """SELECT COUNT(*) FROM facts f
                   LEFT JOIN chunks c ON c.id = f.source_chunk_id
                   WHERE c.id IS NULL"""
            ).fetchone()[0]
        )
        if missing_fact_sources:
            raise RuntimeError(
                f"physical graph has {missing_fact_sources} facts without source chunks"
            )
        if any(name.startswith("locomo_") for name in tables):
            raise RuntimeError(
                f"physical graph contains retired LoCoMo scope tables: {sqlite_path}"
            )
    return build_status


def ingest_command(
    args: argparse.Namespace, *, input_dir: Path, conversation_id: str
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "scripts.ingest",
        "--input-dir",
        str(input_dir),
        "--source-id",
        case_source_id(conversation_id),
        "--full",
        "--concurrency",
        str(args.concurrency),
    ]
    command.extend(["--improve-mode", "full" if args.with_improve else "off"])
    if args.fresh:
        command.append("--fresh-db")
    if args.no_keep_cache:
        command.append("--no-keep-cache")
    return command


def _run_case(
    case_set_root: Path,
    case: dict[str, Any],
    build_dir: Path,
    args: argparse.Namespace,
    position: int,
    total: int,
) -> int:
    case_root = resolve_case_root(case_set_root, case)
    conversation_id = str(case["conversation_id"])
    dws_root = case_root / "dws"
    data_dir = build_dir / CASE_DATA_DIRNAME
    status_path = build_dir / "build_status.json"
    log_path = build_dir / "build.log"
    command = ingest_command(args, input_dir=dws_root, conversation_id=conversation_id)
    env = case_environment(os.environ, case_set_root, case, build_dir=build_dir)
    source_id = case_source_id(conversation_id)
    improve_mode = "full" if args.with_improve else "off"
    configuration = production_build_configuration(
        source_id=source_id,
        improve_mode=improve_mode,
    )
    _print(
        f"[{position}/{total}] START {conversation_id}",
        f"  KL_DWS_EXPORT_DIR={dws_root}",
        f"  KL_DATA_DIR={data_dir}",
        f"  command={shlex.join(command)}",
    )
    if args.dry_run:
        return 0
    build_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    status: dict[str, Any] = {
        "schema_version": BUILD_STATUS_SCHEMA_VERSION,
        "dataset": "locomo",
        "conversation_id": conversation_id,
        "source_id": source_id,
        "state": "running",
        "started_at": _utc_now(),
        "finished_at": None,
        "pipeline": "scripts.ingest",
        "production_chunking": True,
        "dws_root": str(dws_root),
        "data_dir": str(data_dir),
        "command": command,
        "configuration": configuration,
        "configuration_sha256": configuration_fingerprint(configuration),
        "ingest": None,
        "exit_code": None,
    }
    _write_status(status_path, status)
    try:
        with log_path.open("w", encoding="utf-8") as log:
            completed = subprocess.run(
                command,
                cwd=PROJECT_ROOT,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
            )
        status["exit_code"] = completed.returncode
        if completed.returncode:
            raise RuntimeError(
                f"production ingestion exited {completed.returncode}; see {log_path}"
            )
        ingest = load_ingest_result(data_dir, source_id)
        status["ingest"] = ingest
        require_successful_ingest(ingest)
        validate_built_case(
            case_set_root,
            case,
            build_dir=build_dir,
            check_build_status=False,
        )
    except BaseException as exc:
        status.update(
            {
                "state": "interrupted"
                if isinstance(exc, KeyboardInterrupt)
                else "failed",
                "finished_at": _utc_now(),
                "elapsed_seconds": round(time.monotonic() - started, 3),
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
        _write_status(status_path, status)
        raise
    status.update(
        {
            "state": "complete",
            "finished_at": _utc_now(),
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "error": None,
        }
    )
    _write_status(status_path, status)
    _print(f"[{position}/{total}] COMPLETE {conversation_id}")
    return 0


def run_cases(
    case_set_root: Path,
    cases: list[dict[str, Any]],
    build_dirs: dict[str, Path],
    args: argparse.Namespace,
) -> list[str]:
    failures: list[str] = []
    workers = min(args.case_concurrency, len(cases))
    futures: dict[Future[int], str] = {}
    with ThreadPoolExecutor(
        max_workers=workers, thread_name_prefix="locomo-build"
    ) as executor:
        for position, case in enumerate(cases, 1):
            future = executor.submit(
                _run_case,
                case_set_root,
                case,
                build_dirs[str(case["conversation_id"])],
                args,
                position,
                len(cases),
            )
            futures[future] = str(case["conversation_id"])
        stop = False
        for future in as_completed(futures):
            conversation_id = futures[future]
            if future.cancelled():
                continue
            try:
                future.result()
            except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                failures.append(conversation_id)
                _print(
                    f"FAILED {conversation_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                if not args.keep_going and not stop:
                    stop = True
                    for pending in futures:
                        pending.cancel()
    return failures


def _write_status(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _print(*lines: str, file=None) -> None:
    with _OUTPUT_LOCK:
        for line in lines:
            print(line, file=file, flush=True)


def main(argv: list[str] | None = None) -> int:
    try:
        cli = parse_args(argv)
        experiment = load_kl_build_experiment(cli.config)
        args = _runtime_options(experiment, dry_run=cli.dry_run)
        case_set = convert_output_dir(experiment)
        root, cases = load_case_entries(case_set)
        selected = select_cases(cases, experiment.selection.conversations)
        if cli.case_id is not None:
            requested = normalize_sample_id(cli.case_id)
            selected = [
                case
                for case in selected
                if normalize_sample_id(str(case["conversation_id"])) == requested
            ]
            if len(selected) != 1:
                raise ValueError(f"case is not selected: {cli.case_id}")
    except (
        OSError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
        OmegaConfBaseException,
    ) as exc:
        print(f"error: invalid experiment configuration: {exc}", file=sys.stderr)
        return 2
    _print(
        f"LoCoMo conversations selected: {len(selected)}",
        f"Build concurrency: {min(args.case_concurrency, len(selected))}",
    )
    build_dirs = {
        str(case["conversation_id"]): case_stage_output_dir(
            experiment, str(case["conversation_id"]), "build"
        )
        for case in selected
    }
    failures = run_cases(root, selected, build_dirs, args)
    if failures:
        print(f"failed conversations: {failures}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
