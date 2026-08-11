#!/usr/bin/env python3
"""Run the production ``kl ask`` once for each selected LongMemEval case.

This is intentionally a thin process orchestrator. It does not implement
retrieval, RRF, reranking, graph walk, or answer generation. Each case gets a
short-lived production KL server pointed at its own ``kl_data``; the runner then
executes the existing CLI with ``--top-k 5`` and without ``--phase2``.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import httpx

from kl_graph.evaluation.io import atomic_write_json
from kl_graph.evaluation.longmemeval.build import (
    CASE_DATA_DIRNAME,
    DEFAULT_CASE_SET,
    PROJECT_ROOT,
    _case_environment,
    _load_case_entries,
    _resolve_manifest_path,
    _select_entries,
)

TOP_K = 5
SERVER_START_TIMEOUT = 60.0
ASK_TIMEOUT = 180.0
DEFAULT_CASE_CONCURRENCY = 1

_OUTPUT_LOCK = threading.Lock()


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run production kl ask with reranking, Top-5, and Phase 2 off."
    )
    parser.add_argument(
        "case_set",
        nargs="?",
        type=Path,
        default=DEFAULT_CASE_SET,
        help=f"converted LongMemEval root (default: {DEFAULT_CASE_SET})",
    )
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--case", dest="case_ids", action="append", metavar="QUESTION_ID"
    )
    selection.add_argument("--first", type=_positive_int, metavar="N")
    selection.add_argument("--all", action="store_true")
    parser.add_argument(
        "--rerank-base-url",
        default=os.environ.get("KL_RERANK_BASE_URL", ""),
    )
    parser.add_argument(
        "--rerank-model",
        default=os.environ.get("KL_RERANK_MODEL", ""),
    )
    parser.add_argument(
        "--case-concurrency",
        type=_positive_int,
        default=DEFAULT_CASE_CONCURRENCY,
        help=(
            "independent case-level ask subprocesses "
            f"(default: {DEFAULT_CASE_CONCURRENCY})"
        ),
    )
    existing = parser.add_mutually_exclusive_group()
    existing.add_argument(
        "--overwrite",
        action="store_true",
        help="rerun selected cases and replace existing ask results",
    )
    existing.add_argument(
        "--resume",
        action="store_true",
        help="skip complete matching results and rerun missing or invalid ones",
    )
    parser.add_argument("--keep-going", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if not args.rerank_base_url or not args.rerank_model:
        parser.error(
            "configure KL_RERANK_BASE_URL and KL_RERANK_MODEL, or pass both "
            "reranker options"
        )
    return args


def _question(case_root: Path, question_id: str) -> str:
    evaluation_path = case_root / "evaluation.jsonl"
    with evaluation_path.open("r", encoding="utf-8") as stream:
        rows = [json.loads(line) for line in stream if line.strip()]
    if len(rows) != 1:
        raise ValueError(f"expected one evaluation row: {evaluation_path}")
    data = rows[0].get("data", {})
    if data.get("question_id") != question_id:
        raise ValueError(f"evaluation question ID mismatch: {question_id}")
    question = data.get("question")
    if not isinstance(question, str) or not question.strip():
        raise ValueError(f"case {question_id} has no question")
    return question.strip()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_server(process: subprocess.Popen, port: int, log_path: Path) -> None:
    deadline = time.monotonic() + SERVER_START_TIMEOUT
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"KL server exited {process.returncode}; see {log_path}"
            )
        try:
            response = httpx.get(f"http://127.0.0.1:{port}/health", timeout=1)
            if response.json().get("status") == "ok":
                return
        except (httpx.HTTPError, json.JSONDecodeError):
            pass
        time.sleep(0.25)
    raise TimeoutError(f"KL server startup timed out; see {log_path}")


def _stop_server(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _print_block(*lines: str, file=None) -> None:
    """Print one case's progress without interleaving worker output."""
    with _OUTPUT_LOCK:
        for line in lines:
            print(line, file=file, flush=True)


def _result_is_complete(
    path: Path,
    *,
    question_id: str,
    rerank_base_url: str,
    rerank_model: str,
) -> bool:
    """Return whether an ask artifact is safe to reuse for this run."""
    try:
        artifact = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(artifact, dict):
        return False

    response = artifact.get("response")
    reranker = artifact.get("reranker")
    if not isinstance(response, dict) or not isinstance(reranker, dict):
        return False
    items = response.get("items")
    return (
        artifact.get("question_id") == question_id
        and artifact.get("top_k") == TOP_K
        and artifact.get("force_phase2") is False
        and reranker.get("base_url") == rerank_base_url
        and reranker.get("model") == rerank_model
        and response.get("phase") == 1
        and response.get("answer") in (None, "")
        and isinstance(items, list)
        and len(items) <= TOP_K
    )


def _run_case(
    root: Path,
    entry: dict[str, Any],
    args: argparse.Namespace,
    position: int,
    total: int,
) -> None:
    question_id = entry["question_id"]
    case_root = _resolve_manifest_path(root, entry["path"], "path")
    dws_root = _resolve_manifest_path(root, entry["dws_root"], "dws_root")
    data_dir = case_root / CASE_DATA_DIRNAME
    if not (data_dir / "knowledge.db").is_file():
        raise FileNotFoundError(f"case {question_id} has not been built")

    question = _question(case_root, question_id)
    results_dir = case_root / "results"
    result_path = results_dir / "ask_top5.json"
    log_path = results_dir / "ask_server.log"
    if result_path.exists():
        if args.resume and _result_is_complete(
            result_path,
            question_id=question_id,
            rerank_base_url=args.rerank_base_url,
            rerank_model=args.rerank_model,
        ):
            _print_block(f"[{position}/{total}] SKIPPED {question_id} (complete)")
            return
        if not args.overwrite and not args.resume:
            raise FileExistsError(
                f"response exists; pass --overwrite or --resume: {result_path}"
            )
        if args.resume:
            _print_block(
                f"[{position}/{total}] RETRY {question_id} "
                "(existing result is invalid or does not match this run)"
            )

    env = _case_environment(
        os.environ,
        question_id=question_id,
        dws_root=dws_root,
        data_dir=data_dir,
    )
    env["KL_RERANK_BASE_URL"] = args.rerank_base_url
    env["KL_RERANK_MODEL"] = args.rerank_model
    env["KL_CLI_TIMEOUT"] = str(ASK_TIMEOUT)

    _print_block(
        f"[{position}/{total}] START {question_id}",
        f"  KL_DATA_DIR={data_dir}",
        f"  reranker={args.rerank_model} @ {args.rerank_base_url}",
        "  kl ask <question> --no-phase2 --top-k 5 --json",
    )
    if args.dry_run:
        return

    results_dir.mkdir(parents=True, exist_ok=True)
    port = _free_port()
    env["KL_SERVER_PORT"] = str(port)
    server_command = [sys.executable, str(PROJECT_ROOT / "kl_server.py")]
    ask_command = [
        sys.executable,
        str(PROJECT_ROOT / "kl_cli.py"),
        "ask",
        question,
        "--no-phase2",
        "--top-k",
        str(TOP_K),
        "--json",
    ]

    server: subprocess.Popen | None = None
    try:
        with log_path.open("w", encoding="utf-8") as log_stream:
            server = subprocess.Popen(
                server_command,
                cwd=PROJECT_ROOT,
                env=env,
                stdout=log_stream,
                stderr=subprocess.STDOUT,
                text=True,
            )
            _wait_for_server(server, port, log_path)
            completed = subprocess.run(
                ask_command,
                cwd=PROJECT_ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=ASK_TIMEOUT,
                check=False,
            )
        if completed.returncode:
            detail = completed.stderr.strip() or completed.stdout.strip()
            raise RuntimeError(f"kl ask failed: {detail[-1000:]}")
        response = json.loads(completed.stdout)
        if response.get("phase") != 1 or response.get("answer") not in (None, ""):
            raise RuntimeError("kl ask unexpectedly ran Phase 2")
        if len(response.get("items", [])) > TOP_K:
            raise RuntimeError("kl ask returned more than five items")
        atomic_write_json(
            result_path,
            {
                "question_id": question_id,
                "reranker": {
                    "base_url": args.rerank_base_url,
                    "model": args.rerank_model,
                },
                "top_k": TOP_K,
                "force_phase2": False,
                "response": response,
            },
        )
        _print_block(
            f"[{position}/{total}] SUCCEEDED {question_id}",
            f"  saved={result_path}",
        )
    finally:
        if server is not None:
            _stop_server(server)


def _run_cases(
    root: Path,
    selected: list[dict[str, Any]],
    args: argparse.Namespace,
) -> list[str]:
    """Run isolated case queries in a bounded thread pool."""
    total = len(selected)
    workers = min(args.case_concurrency, total)
    failures: list[str] = []
    futures: dict[Future[None], str] = {}
    executor = ThreadPoolExecutor(
        max_workers=workers,
        thread_name_prefix="longmemeval-ask",
    )
    stop_after_failure = False
    try:
        for position, entry in enumerate(selected, start=1):
            future = executor.submit(
                _run_case,
                root,
                entry,
                args,
                position,
                total,
            )
            futures[future] = entry["question_id"]

        for future in as_completed(futures):
            question_id = futures[future]
            if future.cancelled():
                continue
            try:
                future.result()
            except (
                OSError,
                ValueError,
                RuntimeError,
                TimeoutError,
                subprocess.SubprocessError,
            ) as exc:
                failures.append(question_id)
                _print_block(
                    f"FAILED {question_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                if not args.keep_going and not stop_after_failure:
                    stop_after_failure = True
                    for pending in futures:
                        pending.cancel()
    finally:
        executor.shutdown(wait=True, cancel_futures=stop_after_failure)
    return failures


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        root, entries = _load_case_entries(args.case_set)
        selected = _select_entries(entries, args)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    _print_block(
        f"LongMemEval cases selected: {len(selected)}",
        f"Case concurrency: {min(args.case_concurrency, len(selected))}",
    )
    failures = _run_cases(root, selected, args)
    if failures:
        print(f"failed cases: {failures}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
