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

from kl_graph.evaluation.io import json_lines

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CASE_SET = PROJECT_ROOT / "data" / "locomo-v2"
DEFAULT_CASE_CONCURRENCY = 3
CASE_SET_FORMAT = "kl-evaluation-case-set"
DATASET_NAME = "locomo"
CASE_DATA_DIRNAME = "kl_data"
_OUTPUT_LOCK = threading.Lock()


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def case_source_id(conversation_id: str) -> str:
    """Return the stable production-ingest namespace for one conversation."""
    return f"locomo-{conversation_id}"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_set", nargs="?", type=Path, default=DEFAULT_CASE_SET)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--conversation", dest="conversation_ids", action="append", metavar="ID"
    )
    selection.add_argument("--first", type=positive_int, metavar="N")
    selection.add_argument("--all", action="store_true")
    parser.add_argument(
        "--case-concurrency", type=positive_int, default=DEFAULT_CASE_CONCURRENCY
    )
    parser.add_argument("--concurrency", type=positive_int, default=8)
    parser.add_argument("--with-improve", action="store_true")
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument("--no-keep-cache", action="store_true")
    parser.add_argument("--keep-going", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def load_case_entries(path: Path) -> tuple[Path, list[dict[str, Any]]]:
    """Read and validate the converted LoCoMo manifest."""
    root = path.expanduser().resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"LoCoMo case-set manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise TypeError(f"expected JSON object: {manifest_path}")
    if (
        manifest.get("format") != CASE_SET_FORMAT
        or manifest.get("dataset") != DATASET_NAME
    ):
        raise ValueError(f"not a converted LoCoMo case set: {manifest_path}")
    entries = manifest.get("case_entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"manifest has no case_entries: {manifest_path}")

    seen: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise TypeError(f"case_entries[{index}] must be an object")
        conversation_id = entry.get("conversation_id")
        if not isinstance(conversation_id, str) or not conversation_id:
            raise ValueError(
                f"case_entries[{index}].conversation_id must be non-empty text"
            )
        if conversation_id in seen:
            raise ValueError(f"duplicate conversation_id: {conversation_id}")
        seen.add(conversation_id)
        case_root = resolve_case_root(root, entry)
        _validate_dws(conversation_id, case_root / "dws")
        for name in ("evaluation.jsonl", "evidence_map.jsonl"):
            artifact = case_root / name
            if not artifact.is_file():
                raise FileNotFoundError(artifact)
    return root, entries


def resolve_case_root(root: Path, entry: dict[str, Any]) -> Path:
    value = entry.get("path")
    if not isinstance(value, str) or not value:
        raise ValueError("manifest field 'path' must be non-empty text")
    path = (root.resolve() / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("manifest field 'path' escapes case-set root")
    return path


def case_set_fingerprint(path: Path) -> str:
    manifest = path.expanduser().resolve() / "manifest.json"
    return hashlib.sha256(manifest.read_bytes()).hexdigest()


def cases_by_conversation(path: Path) -> dict[str, dict[str, Any]]:
    _, entries = load_case_entries(path)
    return {str(entry["conversation_id"]): entry for entry in entries}


def graph_data_dirs(path: Path) -> dict[str, Path]:
    root, entries = load_case_entries(path)
    return {
        str(entry["conversation_id"]): resolve_case_root(root, entry)
        / CASE_DATA_DIRNAME
        for entry in entries
    }


def resolve_case_set_dir(case_set: Path | None, project_root: Path) -> Path:
    if case_set is not None:
        candidate = case_set.expanduser().resolve()
        load_case_entries(candidate)
        return candidate
    configured = os.environ.get("KL_LOCOMO_CASE_SET")
    candidates = [
        Path(configured).expanduser() if configured else None,
        project_root / "data" / "locomo-v2",
        project_root / "data" / "locomo",
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            load_case_entries(candidate)
        except (FileNotFoundError, TypeError, ValueError, json.JSONDecodeError):
            continue
        return candidate.resolve()
    raise FileNotFoundError(
        "Could not find a converted LoCoMo conversation case set. "
        "Run python -m kl_graph.evaluation.locomo.convert first or pass --dataset."
    )


def select_cases(
    cases: list[dict[str, Any]], args: argparse.Namespace
) -> list[dict[str, Any]]:
    if args.conversation_ids:
        by_id = {str(case["conversation_id"]): case for case in cases}
        unknown = [value for value in args.conversation_ids if value not in by_id]
        if unknown:
            raise ValueError(f"unknown LoCoMo conversation(s): {unknown}")
        if len(set(args.conversation_ids)) != len(args.conversation_ids):
            raise ValueError("--conversation contains a duplicate")
        return [by_id[value] for value in args.conversation_ids]
    if args.first is not None:
        return cases[: args.first]
    return cases


def case_environment(
    base: dict[str, str], case_set_root: Path, case: dict[str, Any]
) -> dict[str, str]:
    case_root = resolve_case_root(case_set_root, case)
    dws_root = case_root / "dws"
    data_dir = case_root / CASE_DATA_DIRNAME
    conversation_id = str(case["conversation_id"])
    env = base.copy()
    env["KL_DWS_EXPORT_DIR"] = str(dws_root)
    env["KL_DATA_DIR"] = str(data_dir)
    env["KL_GRAPH_DB_PATH"] = str(data_dir / "graph.ladybug")
    digest = hashlib.sha256(conversation_id.encode()).hexdigest()[:16]
    env["KL_FALKOR_GRAPH"] = f"locomo_{digest}"
    return env


def validate_built_case(case_set_root: Path, case: dict[str, Any]) -> None:
    """Require one complete physical graph for exactly one conversation."""
    case_root = resolve_case_root(case_set_root, case)
    conversation_id = str(case["conversation_id"])
    sqlite_path = case_root / CASE_DATA_DIRNAME / "knowledge.db"
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
    if not args.with_improve:
        command.append("--no-improve")
    if args.fresh:
        command.append("--fresh-db")
    if args.no_keep_cache:
        command.append("--no-keep-cache")
    return command


def _run_case(
    case_set_root: Path,
    case: dict[str, Any],
    args: argparse.Namespace,
    position: int,
    total: int,
) -> int:
    case_root = resolve_case_root(case_set_root, case)
    conversation_id = str(case["conversation_id"])
    dws_root = case_root / "dws"
    data_dir = case_root / CASE_DATA_DIRNAME
    status_path = case_root / "build_status.json"
    log_path = case_root / "build.log"
    command = ingest_command(
        args, input_dir=dws_root, conversation_id=conversation_id
    )
    env = case_environment(os.environ, case_set_root, case)
    _print(
        f"[{position}/{total}] START {conversation_id}",
        f"  KL_DWS_EXPORT_DIR={dws_root}",
        f"  KL_DATA_DIR={data_dir}",
        f"  command={shlex.join(command)}",
    )
    if args.dry_run:
        return 0
    data_dir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    status: dict[str, Any] = {
        "schema_version": 1,
        "dataset": "locomo",
        "conversation_id": conversation_id,
        "state": "running",
        "started_at": _utc_now(),
        "finished_at": None,
        "pipeline": "scripts.ingest",
        "production_chunking": True,
        "dws_root": str(dws_root),
        "data_dir": str(data_dir),
        "command": command,
        "exit_code": None,
    }
    _write_status(status_path, status)
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
    status.update(
        {
            "state": "complete" if completed.returncode == 0 else "failed",
            "finished_at": _utc_now(),
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "exit_code": completed.returncode,
        }
    )
    _write_status(status_path, status)
    if completed.returncode:
        raise RuntimeError(
            f"production ingestion exited {completed.returncode}; see {log_path}"
        )
    validate_built_case(case_set_root, case)
    _print(f"[{position}/{total}] COMPLETE {conversation_id}")
    return 0


def run_cases(
    case_set_root: Path, cases: list[dict[str, Any]], args: argparse.Namespace
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


def _validate_dws(conversation_id: str, dws_root: Path) -> None:
    chat = dws_root / "chat"
    required = ("manifest.json", "scopes.jsonl", "records.jsonl", "resources.jsonl")
    missing = [name for name in required if not (chat / name).is_file()]
    if missing:
        raise FileNotFoundError(
            f"case {conversation_id}: incomplete DWS chat source; missing {missing}"
        )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _print(*lines: str, file=None) -> None:
    with _OUTPUT_LOCK:
        for line in lines:
            print(line, file=file, flush=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        root, cases = load_case_entries(args.case_set)
        selected = select_cases(cases, args)
    except (FileNotFoundError, ValueError, TypeError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    _print(
        f"LoCoMo conversations selected: {len(selected)}",
        f"Build concurrency: {min(args.case_concurrency, len(selected))}",
    )
    failures = run_cases(root, selected, args)
    if failures:
        print(f"failed conversations: {failures}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
