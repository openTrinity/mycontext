#!/usr/bin/env python3
"""Build one isolated production KL graph for each selected LongMemEval case.

This module is deliberately only an orchestrator. It does not load messages,
create chunks, embed content, extract facts, or write graph nodes itself. For
each case it starts a fresh Python process running :mod:`scripts.ingest`, after
setting that process's ``KL_DWS_EXPORT_DIR`` and ``KL_DATA_DIR``.

Consequently chat data follows the same production path as normal DingTalk
data::

    load_all_messages -> slice_chat_sessions -> IngestionPipeline

A fresh process per case is important because :mod:`kl_graph.config` resolves
its paths at import time. It also prevents SQLite, Qdrant, LadybugDB, checkpoint,
or in-memory pipeline state from leaking from one benchmark case into another.

The converted case directory becomes::

    cases/QUESTION_ID/
      dws/                  # converter output; ingestion input
      evaluation.jsonl      # Gold + full source chats; never passed to ingestion
      kl_data/              # this case's independent production stores
      build.log             # stdout/stderr from this case's ingest subprocess
      build_status.json     # orchestration status; outside the DWS root

Examples::

    # Inspect the first case without starting ingestion.
    python -m kl_graph.evaluation.longmemeval.build --first 1 --dry-run

    # Smoke-test one case using the full production pipeline.
    python -m kl_graph.evaluation.longmemeval.build --case 00ca467f

    # Build every case with four independent ingest subprocesses (the default).
    python -m kl_graph.evaluation.longmemeval.build --all --keep-going
"""

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

from kl_graph.evaluation.build_contract import (
    BUILD_STATUS_SCHEMA_VERSION,
    configuration_fingerprint,
    load_ingest_result,
    production_build_configuration,
    require_successful_ingest,
    validate_production_build_status,
)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CASE_SET = PROJECT_ROOT / "data" / "longmemeval"
EXPECTED_FORMAT = "kl-evaluation-case-set"
CASE_DATA_DIRNAME = "kl_data"
BUILD_STATUS_FILENAME = "build_status.json"
BUILD_LOG_FILENAME = "build.log"
DEFAULT_CASE_CONCURRENCY = 4

_OUTPUT_LOCK = threading.Lock()
_ACTIVE_PROCESS_LOCK = threading.Lock()
_ACTIVE_PROCESSES: dict[str, subprocess.Popen] = {}
_STOP_REQUESTED = threading.Event()


def case_source_id(question_id: str) -> str:
    return f"longmemeval-{question_id}"


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build isolated LongMemEval case graphs through the production "
            "scripts.ingest pipeline."
        ),
    )
    parser.add_argument(
        "case_set",
        nargs="?",
        type=Path,
        default=DEFAULT_CASE_SET,
        help=(f"converted LongMemEval case-set root (default: {DEFAULT_CASE_SET})"),
    )

    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--case",
        dest="case_ids",
        action="append",
        metavar="QUESTION_ID",
        help="build one question ID; repeat to select multiple cases",
    )
    selection.add_argument(
        "--first",
        type=_positive_int,
        metavar="N",
        help="build the first N manifest entries (useful for smoke tests)",
    )
    selection.add_argument(
        "--all",
        action="store_true",
        help="build all cases in manifest order",
    )

    parser.add_argument(
        "--case-concurrency",
        type=_positive_int,
        default=DEFAULT_CASE_CONCURRENCY,
        help=(
            "independent case-level ingest subprocesses "
            f"(default: {DEFAULT_CASE_CONCURRENCY})"
        ),
    )
    parser.add_argument(
        "--concurrency",
        type=_positive_int,
        default=8,
        help="production extraction concurrency passed to scripts.ingest",
    )
    parser.add_argument(
        "--with-improve",
        action="store_true",
        help=(
            "also run production similarity/community improvement; by default "
            "the core graph is built with --improve-mode off"
        ),
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help=(
            "pass --fresh-db to production ingestion for each selected case; "
            "this replaces only that case's kl_data stores"
        ),
    )
    parser.add_argument(
        "--no-keep-cache",
        action="store_true",
        help="discard each case's production extraction cache after graph build",
    )
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="continue with later cases after a build subprocess fails",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print resolved case paths, environment, and commands without writing",
    )
    return parser.parse_args(argv)


def _load_case_entries(case_set: Path) -> tuple[Path, list[dict[str, Any]]]:
    root = case_set.expanduser().resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"LongMemEval manifest not found: {manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("format") != EXPECTED_FORMAT:
        raise ValueError(f"expected {EXPECTED_FORMAT!r} manifest at {manifest_path}")
    entries = manifest.get("case_entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"manifest has no case_entries: {manifest_path}")

    validated: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"case_entries[{index}] must be an object")
        question_id = entry.get("question_id")
        if not isinstance(question_id, str) or not question_id:
            raise ValueError(
                f"case_entries[{index}].question_id must be non-empty text"
            )
        if question_id in seen_ids:
            raise ValueError(f"duplicate question_id in manifest: {question_id}")
        seen_ids.add(question_id)

        case_root = _resolve_manifest_path(root, entry.get("path"), "path")
        dws_root = _resolve_manifest_path(root, entry.get("dws_root"), "dws_root")
        if not dws_root.is_relative_to(case_root):
            raise ValueError(
                f"case {question_id}: dws_root must be inside the case directory"
            )
        _validate_dws_root(question_id, dws_root)
        validated.append(entry)

    return root, validated


def _resolve_manifest_path(root: Path, value: Any, field: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f"manifest field {field!r} must be non-empty text")
    path = (root / value).resolve()
    if not path.is_relative_to(root):
        raise ValueError(f"manifest field {field!r} escapes the case-set root")
    return path


def _validate_dws_root(question_id: str, dws_root: Path) -> None:
    chat_dir = dws_root / "chat"
    required = (
        "manifest.json",
        "scopes.jsonl",
        "records.jsonl",
        "resources.jsonl",
    )
    missing = [name for name in required if not (chat_dir / name).is_file()]
    if missing:
        raise FileNotFoundError(
            f"case {question_id}: incomplete DWS chat source; missing {missing}"
        )
    if (dws_root / "evaluation.jsonl").exists():
        raise ValueError(
            f"case {question_id}: evaluation.jsonl must remain outside dws_root"
        )


def _select_entries(
    entries: list[dict[str, Any]], args: argparse.Namespace
) -> list[dict[str, Any]]:
    if args.case_ids:
        by_id = {entry["question_id"]: entry for entry in entries}
        unknown = [
            question_id for question_id in args.case_ids if question_id not in by_id
        ]
        if unknown:
            raise ValueError(f"unknown LongMemEval question ID(s): {unknown}")
        if len(set(args.case_ids)) != len(args.case_ids):
            raise ValueError("--case contains a duplicate question ID")
        return [by_id[question_id] for question_id in args.case_ids]
    if args.first is not None:
        return entries[: args.first]
    return entries


def _ingest_command(
    args: argparse.Namespace, *, input_dir: Path, question_id: str
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "scripts.ingest",
        "--input-dir",
        str(input_dir),
        "--source-id",
        case_source_id(question_id),
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


def _case_environment(
    base: dict[str, str], *, question_id: str, dws_root: Path, data_dir: Path
) -> dict[str, str]:
    env = base.copy()
    env["KL_DWS_EXPORT_DIR"] = str(dws_root)
    env["KL_DATA_DIR"] = str(data_dir)

    # Override a possibly exported global path so LadybugDB cannot accidentally
    # be shared even when the caller's shell sourced a production .env file.
    env["KL_GRAPH_DB_PATH"] = str(data_dir / "graph.ladybug")

    # Harmless for local Ladybug/SQLite; necessary for isolation if a caller
    # deliberately selects the remote FalkorDB backend.
    case_key = hashlib.sha256(question_id.encode("utf-8")).hexdigest()[:16]
    env["KL_FALKOR_GRAPH"] = f"longmemeval_{case_key}"
    return env


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_status(path: Path, status: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(status, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def validate_built_case(
    case_set: Path,
    entry: dict[str, Any],
    *,
    check_build_status: bool = True,
) -> dict[str, Any] | None:
    """Require a complete production build for one LongMemEval case."""
    question_id = str(entry["question_id"])
    case_root = _resolve_manifest_path(case_set, entry["path"], "path")
    data_dir = case_root / CASE_DATA_DIRNAME
    build_status = None
    if check_build_status:
        build_status = validate_production_build_status(
            case_root / BUILD_STATUS_FILENAME,
            dataset="longmemeval",
            source_id=case_source_id(question_id),
        )

    sqlite_path = data_dir / "knowledge.db"
    if not sqlite_path.is_file():
        raise FileNotFoundError(sqlite_path)
    uri = f"{sqlite_path.resolve().as_uri()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        required = {"chunks", "facts"}
        if not required.issubset(tables):
            raise RuntimeError(
                f"incomplete production graph {sqlite_path}; "
                f"missing {sorted(required - tables)}"
            )
        if int(connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]) < 1:
            raise RuntimeError(f"production graph has no chunks: {sqlite_path}")
    return build_status


def _print_block(*lines: str, file=None) -> None:
    """Print related progress lines atomically across case worker threads."""
    with _OUTPUT_LOCK:
        for line in lines:
            print(line, file=file, flush=True)


def _register_process(question_id: str, process: subprocess.Popen) -> None:
    with _ACTIVE_PROCESS_LOCK:
        _ACTIVE_PROCESSES[question_id] = process


def _unregister_process(question_id: str, process: subprocess.Popen) -> None:
    with _ACTIVE_PROCESS_LOCK:
        if _ACTIVE_PROCESSES.get(question_id) is process:
            _ACTIVE_PROCESSES.pop(question_id, None)


def _terminate_active_processes() -> None:
    """Terminate every ingest child when the parent receives an interrupt."""
    with _ACTIVE_PROCESS_LOCK:
        processes = list(_ACTIVE_PROCESSES.values())
    for process in processes:
        if process.poll() is None:
            process.terminate()

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if all(process.poll() is not None for process in processes):
            return
        time.sleep(0.1)
    for process in processes:
        if process.poll() is None:
            process.kill()


def _build_case(
    case_set: Path,
    entry: dict[str, Any],
    args: argparse.Namespace,
    *,
    position: int,
    total: int,
) -> int:
    question_id = entry["question_id"]
    case_root = _resolve_manifest_path(case_set, entry["path"], "path")
    dws_root = _resolve_manifest_path(case_set, entry["dws_root"], "dws_root")
    data_dir = case_root / CASE_DATA_DIRNAME
    status_path = case_root / BUILD_STATUS_FILENAME
    log_path = case_root / BUILD_LOG_FILENAME
    command = _ingest_command(args, input_dir=dws_root, question_id=question_id)
    env = _case_environment(
        os.environ,
        question_id=question_id,
        dws_root=dws_root,
        data_dir=data_dir,
    )
    source_id = case_source_id(question_id)
    improve_mode = "full" if args.with_improve else "off"
    configuration = production_build_configuration(
        source_id=source_id,
        improve_mode=improve_mode,
    )

    _print_block(
        f"[{position}/{total}] START {question_id}",
        f"  KL_DWS_EXPORT_DIR={dws_root}",
        f"  KL_DATA_DIR={data_dir}",
        f"  log={log_path}",
        f"  command={shlex.join(command)}",
    )
    if args.dry_run:
        return 0

    data_dir.mkdir(parents=True, exist_ok=True)
    started_at = _utc_now()
    status: dict[str, Any] = {
        "schema_version": BUILD_STATUS_SCHEMA_VERSION,
        "dataset": "longmemeval",
        "question_id": question_id,
        "source_id": source_id,
        "state": "running",
        "started_at": started_at,
        "finished_at": None,
        "elapsed_seconds": None,
        "dws_root": str(dws_root),
        "data_dir": str(data_dir),
        "log_path": str(log_path),
        "pipeline": "scripts.ingest",
        "production_chunking": True,
        "with_improve": args.with_improve,
        "command": command,
        "configuration": configuration,
        "configuration_sha256": configuration_fingerprint(configuration),
        "ingest": None,
        "exit_code": None,
    }
    _write_status(status_path, status)

    started = time.monotonic()
    try:
        with log_path.open("w", encoding="utf-8") as log_stream:
            process = subprocess.Popen(
                command,
                cwd=PROJECT_ROOT,
                env=env,
                stdout=log_stream,
                stderr=subprocess.STDOUT,
            )
            _register_process(question_id, process)
            try:
                returncode = process.wait()
            finally:
                _unregister_process(question_id, process)
    except BaseException as exc:
        status.update(
            state="interrupted" if isinstance(exc, KeyboardInterrupt) else "failed",
            finished_at=_utc_now(),
            elapsed_seconds=round(time.monotonic() - started, 3),
            error=f"{type(exc).__name__}: {exc}",
        )
        _write_status(status_path, status)
        raise

    status["exit_code"] = returncode
    if returncode:
        status.update(
            state="interrupted" if _STOP_REQUESTED.is_set() else "failed",
            finished_at=_utc_now(),
            elapsed_seconds=round(time.monotonic() - started, 3),
            error=f"production ingestion exited {returncode}; see {log_path}",
        )
        _write_status(status_path, status)
        return returncode

    try:
        ingest = load_ingest_result(data_dir, source_id)
        status["ingest"] = ingest
        require_successful_ingest(ingest)
        validate_built_case(case_set, entry, check_build_status=False)
    except Exception as exc:
        status.update(
            state="failed",
            finished_at=_utc_now(),
            elapsed_seconds=round(time.monotonic() - started, 3),
            error=f"{type(exc).__name__}: {exc}",
        )
        _write_status(status_path, status)
        raise

    status.update(
        state="complete",
        finished_at=_utc_now(),
        elapsed_seconds=round(time.monotonic() - started, 3),
        error=None,
    )
    _write_status(status_path, status)
    return 0


def _run_builds(
    case_set: Path,
    selected: list[dict[str, Any]],
    args: argparse.Namespace,
) -> list[tuple[str, int]]:
    """Run case builds in a bounded thread pool of isolated subprocesses."""
    total = len(selected)
    workers = min(args.case_concurrency, total)
    failures: list[tuple[str, int]] = []
    futures: dict[Future[int], tuple[int, str]] = {}
    executor = ThreadPoolExecutor(
        max_workers=workers,
        thread_name_prefix="longmemeval-build",
    )
    stop_after_failure = False
    try:
        for position, entry in enumerate(selected, start=1):
            future = executor.submit(
                _build_case,
                case_set,
                entry,
                args,
                position=position,
                total=total,
            )
            futures[future] = (position, entry["question_id"])

        completed_count = 0
        for future in as_completed(futures):
            _position, question_id = futures[future]
            if future.cancelled():
                continue
            completed_count += 1
            try:
                returncode = future.result()
            except Exception as exc:  # status was already written by the worker
                returncode = 1
                _print_block(
                    f"[{completed_count}/{total}] FAILED {question_id}: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
            else:
                state = "SUCCEEDED" if returncode == 0 else "FAILED"
                _print_block(
                    f"[{completed_count}/{total}] {state} {question_id} "
                    f"(exit={returncode})"
                )

            if returncode:
                failures.append((question_id, returncode))
                if not args.keep_going and not stop_after_failure:
                    stop_after_failure = True
                    for pending in futures:
                        pending.cancel()
    except KeyboardInterrupt:
        _STOP_REQUESTED.set()
        for future in futures:
            future.cancel()
        _terminate_active_processes()
        _print_block("LongMemEval build interrupted", file=sys.stderr)
        raise
    finally:
        executor.shutdown(wait=True, cancel_futures=stop_after_failure)
    return failures


def main(argv: list[str] | None = None) -> int:
    _STOP_REQUESTED.clear()
    args = parse_args(argv)
    try:
        case_set, entries = _load_case_entries(args.case_set)
        selected = _select_entries(entries, args)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    _print_block(
        f"LongMemEval cases selected: {len(selected)}",
        f"Case concurrency: {min(args.case_concurrency, len(selected))}",
        f"Per-ingest extraction concurrency: {args.concurrency}",
    )
    try:
        failures = _run_builds(case_set, selected, args)
    except KeyboardInterrupt:
        return 130

    if failures:
        _print_block(
            f"LongMemEval build failures: {failures}",
            file=sys.stderr,
        )
        return 1
    _print_block(f"LongMemEval cases completed: {len(selected)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
