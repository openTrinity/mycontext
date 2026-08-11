"""Build one RAGFlow Dataset from each native LongMemEval question case."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kl_graph.config import PROJECT_ROOT
from kl_graph.evaluation.io import atomic_write_json
from kl_graph.evaluation.longmemeval.source import (
    DEFAULT_SOURCE,
    case_root,
    document_fingerprint,
    load_cases,
    render_document,
    select_cases,
    source_fingerprint,
)
from kl_graph.evaluation.ragflow import RagflowEvaluationClient

DEFAULT_BASE_URL = "http://127.0.0.1:9380"
DEFAULT_ARTIFACT_ROOT = PROJECT_ROOT / "data" / "longmemeval-ragflow"
DEFAULT_PARSE_TIMEOUT = 3600.0
DEFAULT_GRAPH_TIMEOUT = 10800.0
CHUNK_METHOD = "naive"
CHUNK_TOKEN_NUM = 512
CHUNK_DELIMITER = "\n"
_OUTPUT_LOCK = threading.Lock()


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def _positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--artifact-root", type=Path, default=DEFAULT_ARTIFACT_ROOT)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--case", dest="case_ids", action="append", metavar="QUESTION_ID"
    )
    selection.add_argument("--first", type=_positive_int, metavar="N")
    selection.add_argument("--all", action="store_true")
    parser.add_argument("--graph", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--keep-going", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--case-concurrency", type=_positive_int, default=1)
    parser.add_argument("--dataset-prefix", default="longmemeval")
    parser.add_argument(
        "--embedding-model",
        default=os.environ.get("RAGFLOW_EMBEDDING_MODEL") or None,
    )
    parser.add_argument(
        "--base-url", default=os.environ.get("RAGFLOW_BASE_URL", DEFAULT_BASE_URL)
    )
    parser.add_argument(
        "--parse-timeout", type=_positive_float, default=DEFAULT_PARSE_TIMEOUT
    )
    parser.add_argument(
        "--graph-timeout", type=_positive_float, default=DEFAULT_GRAPH_TIMEOUT
    )
    parser.add_argument("--poll-seconds", type=_positive_float, default=2.0)
    args = parser.parse_args(argv)
    if not args.dataset_prefix.strip():
        parser.error("--dataset-prefix must be non-empty")
    return args


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _state_path(artifact_root: Path, question_id: str) -> Path:
    return case_root(artifact_root, question_id) / "ragflow.json"


def load_state(artifact_root: Path, question_id: str) -> dict[str, Any]:
    path = _state_path(artifact_root, question_id)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"RAGFlow state is not an object: {path}")
    return value


def _write_state(artifact_root: Path, question_id: str, state: dict[str, Any]) -> None:
    state["updated_at"] = _utc_now()
    atomic_write_json(_state_path(artifact_root, question_id), state)


def _dataset_name(prefix: str, question_id: str, source_sha256: str) -> str:
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "-", question_id).strip(".-_")
    safe_id = safe_id or "case"
    return f"{prefix.strip()}-{safe_id}-{source_sha256[:8]}"


def _new_state(
    case: dict[str, Any],
    source: Path,
    source_sha256: str,
    args: argparse.Namespace,
) -> dict[str, Any]:
    question_id = str(case["question_id"])
    return {
        "schema_version": 1,
        "benchmark": "longmemeval",
        "backend": "ragflow",
        "question_id": question_id,
        "source": str(source),
        "source_sha256": source_sha256,
        "document_sha256": document_fingerprint(case),
        "status": "starting",
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "config": {
            "base_url": args.base_url.rstrip("/"),
            "embedding_model": args.embedding_model,
            "chunk_method": CHUNK_METHOD,
            "chunk_token_num": CHUNK_TOKEN_NUM,
            "delimiter": CHUNK_DELIMITER,
            "graph": bool(args.graph),
            "document_policy": "one_user_only_transcript_per_question_case",
        },
        "dataset_id": None,
        "dataset_name": _dataset_name(args.dataset_prefix, question_id, source_sha256),
        "document_id": None,
        "document_name": f"{re.sub(r'[^A-Za-z0-9._-]+', '-', question_id)}.txt",
        "parse": None,
        "graph": None,
        "error": None,
    }


def _validate_resume(
    state: dict[str, Any], expected: dict[str, Any], path: Path
) -> None:
    keys = ("question_id", "source_sha256", "document_sha256", "config")
    mismatch = {
        key: {"recorded": state.get(key), "requested": expected.get(key)}
        for key in keys
        if state.get(key) != expected.get(key)
    }
    if mismatch:
        raise ValueError(
            f"cannot resume incompatible RAGFlow state {path}: "
            + json.dumps(mismatch, ensure_ascii=False, sort_keys=True)
        )


def _ensure_document(
    client: RagflowEvaluationClient,
    dataset: Any,
    case: dict[str, Any],
    state: dict[str, Any],
    args: argparse.Namespace,
) -> None:
    question_id = str(case["question_id"])
    document_id = str(state.get("document_id") or "")
    if not document_id:
        document = client.upload_document(
            dataset,
            name=str(state["document_name"]),
            content=render_document(case).encode("utf-8"),
        )
        document_id = str(document.id)
        state["document_id"] = document_id
        state["status"] = "uploaded"
        _write_state(args.artifact_root, question_id, state)

    parse_state = client.document_state(dataset, document_id)
    if parse_state["state"] != "complete":
        if parse_state["state"] != "running":
            client.start_parse(dataset, [document_id])
        state["status"] = "parsing"
        state["parse"] = parse_state
        _write_state(args.artifact_root, question_id, state)
        parse_state = client.wait_for_document(
            dataset,
            document_id,
            timeout_seconds=args.parse_timeout,
            poll_seconds=args.poll_seconds,
        )
    state["parse"] = parse_state
    state["status"] = "parsed"
    _write_state(args.artifact_root, question_id, state)


def _ensure_graph(
    client: RagflowEvaluationClient,
    state: dict[str, Any],
    args: argparse.Namespace,
) -> None:
    question_id = str(state["question_id"])
    dataset_id = str(state["dataset_id"])
    graph_state = client.graph_state(dataset_id)
    if graph_state["state"] == "complete":
        state["graph"] = graph_state
        return
    if graph_state["state"] != "running":
        graph_state = {
            "state": "running",
            "progress": 0.0,
            "task_id": client.start_graph(dataset_id),
        }
    state["status"] = "building_graph"
    state["graph"] = graph_state
    _write_state(args.artifact_root, question_id, state)
    state["graph"] = client.wait_for_graph(
        dataset_id,
        timeout_seconds=args.graph_timeout,
        poll_seconds=args.poll_seconds,
    )


def _refresh_failed_remote_state(
    client: RagflowEvaluationClient,
    dataset: Any | None,
    state: dict[str, Any],
    args: argparse.Namespace,
) -> None:
    question_id = str(state["question_id"])
    document_id = str(state.get("document_id") or "")
    if dataset is not None and document_id:
        try:
            state["parse"] = client.document_state(dataset, document_id)
        except Exception as exc:  # noqa: BLE001 - preserve original error
            state.setdefault("remote_refresh_errors", {})["parse"] = (
                f"{type(exc).__name__}: {exc}"
            )
    dataset_id = str(state.get("dataset_id") or "")
    if args.graph and dataset_id:
        try:
            state["graph"] = client.graph_state(dataset_id)
        except Exception as exc:  # noqa: BLE001 - preserve original error
            state.setdefault("remote_refresh_errors", {})["graph"] = (
                f"{type(exc).__name__}: {exc}"
            )
    _write_state(args.artifact_root, question_id, state)


def _build_one(
    client: RagflowEvaluationClient | None,
    source: Path,
    source_sha256: str,
    case: dict[str, Any],
    args: argparse.Namespace,
    position: int,
    total: int,
) -> None:
    question_id = str(case["question_id"])
    state_path = _state_path(args.artifact_root, question_id)
    expected = _new_state(case, source, source_sha256, args)
    dataset: Any | None = None
    _print(f"[{position}/{total}] START {question_id}")
    if args.dry_run:
        _print(
            f"  dataset={expected['dataset_name']}",
            f"  document={expected['document_name']}",
            f"  chunking={CHUNK_METHOD}/{CHUNK_TOKEN_NUM}/newline",
            f"  graph={args.graph}",
        )
        return
    if client is None:
        raise RuntimeError("RAGFlow client is required outside --dry-run")

    if state_path.exists():
        if not args.resume:
            raise FileExistsError(
                f"RAGFlow state already exists: {state_path}; pass --resume"
            )
        state = load_state(args.artifact_root, question_id)
        _validate_resume(state, expected, state_path)
    else:
        state = expected
        _write_state(args.artifact_root, question_id, state)

    started = time.monotonic()
    try:
        dataset_id = str(state.get("dataset_id") or "")
        if dataset_id:
            dataset = client.get_dataset(dataset_id)
        else:
            dataset = client.create_dataset(
                name=str(state["dataset_name"]),
                description=(
                    f"Native LongMemEval question case {question_id}; "
                    "one document containing only user turns"
                ),
                embedding_model=args.embedding_model,
                chunk_method=CHUNK_METHOD,
                parser_config={
                    "chunk_token_num": CHUNK_TOKEN_NUM,
                    "delimiter": CHUNK_DELIMITER,
                },
            )
            state["dataset_id"] = str(dataset.id)
            state["status"] = "dataset_created"
            _write_state(args.artifact_root, question_id, state)

        _ensure_document(client, dataset, case, state, args)
        if args.graph:
            _ensure_graph(client, state, args)
        state["status"] = "complete"
        state["finished_at"] = _utc_now()
        state["elapsed_seconds"] = round(time.monotonic() - started, 3)
        state["error"] = None
        _write_state(args.artifact_root, question_id, state)
        _print(
            f"[{position}/{total}] COMPLETE {question_id}",
            f"  dataset_id={state['dataset_id']}",
            f"  chunks={(state.get('parse') or {}).get('chunk_count')}",
            f"  graph={(state.get('graph') or {}).get('state', 'disabled')}",
        )
    except Exception as exc:
        state["status"] = "failed"
        state["error"] = f"{type(exc).__name__}: {exc}"
        _refresh_failed_remote_state(client, dataset, state, args)
        raise


def _run(
    client: RagflowEvaluationClient,
    source: Path,
    source_sha256: str,
    cases: list[dict[str, Any]],
    args: argparse.Namespace,
) -> list[str]:
    failures: list[str] = []
    futures: dict[Future[None], str] = {}
    with ThreadPoolExecutor(
        max_workers=min(args.case_concurrency, len(cases)),
        thread_name_prefix="longmemeval-ragflow-build",
    ) as executor:
        for position, case in enumerate(cases, 1):
            future = executor.submit(
                _build_one,
                client,
                source,
                source_sha256,
                case,
                args,
                position,
                len(cases),
            )
            futures[future] = str(case["question_id"])
        stop = False
        for future in as_completed(futures):
            question_id = futures[future]
            if future.cancelled():
                continue
            try:
                future.result()
            except Exception as exc:  # noqa: BLE001 - report remote failures
                failures.append(question_id)
                _print(
                    f"FAILED {question_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                if not args.keep_going and not stop:
                    stop = True
                    for pending in futures:
                        pending.cancel()
    return failures


def _print(*lines: str, file=None) -> None:
    with _OUTPUT_LOCK:
        for line in lines:
            print(line, file=file, flush=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        source, cases = load_cases(args.source)
        selected = select_cases(cases, case_ids=args.case_ids, first=args.first)
        source_sha256 = source_fingerprint(source)
        client = (
            None
            if args.dry_run
            else RagflowEvaluationClient(
                os.environ.get("RAGFLOW_API_KEY", ""), args.base_url
            )
        )
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    _print(
        f"Native LongMemEval cases selected: {len(selected)}",
        f"RAGFlow build concurrency: {min(args.case_concurrency, len(selected))}",
        f"GraphRAG: {'enabled' if args.graph else 'disabled'}",
        f"Artifacts: {args.artifact_root.expanduser().resolve()}",
    )
    if args.dry_run:
        for position, case in enumerate(selected, 1):
            _build_one(
                None,
                source,
                source_sha256,
                case,
                args,
                position,
                len(selected),
            )
        return 0
    failures = _run(client, source, source_sha256, selected, args)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
