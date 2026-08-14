"""Run the production ``kl ask`` once for each selected LongMemEval case.

This is intentionally a thin process orchestrator. It does not implement
retrieval, RRF, reranking, graph walk, or answer generation. Each case gets a
short-lived production KL server pointed at its own ``kl_data``; the runner then
executes the existing CLI with the configured Top-K and without ``--phase2``.
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
from omegaconf.errors import OmegaConfBaseException

from kl_graph.config import PROJECT_ROOT
from kl_graph.evaluation.build_contract import retrieval_configuration
from kl_graph.evaluation.io import atomic_write_json
from kl_graph.evaluation.longmemeval.experiment import (
    AskExperiment,
    case_stage_output_dir,
    convert_output_dir,
    load_ask_experiment,
    select_entries,
)
from kl_graph.evaluation.longmemeval.kl_graph.build import (
    CASE_DATA_DIRNAME,
    _case_environment,
    _load_case_entries,
    _resolve_manifest_path,
    validate_built_case,
)

_OUTPUT_LOCK = threading.Lock()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run production kl ask from a LongMemEval experiment YAML."
    )
    parser.add_argument(
        "--config", type=Path, required=True, help="LongMemEval experiment YAML"
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--case-id")
    return parser.parse_args(argv)


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


def _wait_for_server(
    process: subprocess.Popen,
    port: int,
    log_path: Path,
    timeout_seconds: float,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"KL server exited {process.returncode}; see {log_path}")
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
    top_k: int,
    build_configuration_sha256: str,
    retrieval_config: dict[str, Any],
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
        and artifact.get("top_k") == top_k
        and artifact.get("force_phase2") is False
        and reranker.get("base_url") == rerank_base_url
        and reranker.get("model") == rerank_model
        and artifact.get("build_configuration_sha256") == build_configuration_sha256
        and artifact.get("retrieval_configuration") == retrieval_config
        and response.get("phase") == 1
        and response.get("answer") in (None, "")
        and isinstance(items, list)
        and len(items) <= top_k
    )


def _run_case(
    root: Path,
    entry: dict[str, Any],
    build_dir: Path,
    ask_dir: Path,
    experiment: AskExperiment,
    position: int,
    total: int,
    *,
    dry_run: bool,
) -> None:
    config = experiment.ask
    question_id = entry["question_id"]
    case_root = _resolve_manifest_path(root, entry["path"], "path")
    dws_root = _resolve_manifest_path(root, entry["dws_root"], "dws_root")
    data_dir = build_dir / CASE_DATA_DIRNAME
    build_status = validate_built_case(root, entry, build_dir=build_dir)
    if build_status is None:  # pragma: no cover - guarded by default validation
        raise RuntimeError(f"case {question_id} has no build status")
    build_configuration_sha256 = str(build_status["configuration_sha256"])
    retrieval_config = retrieval_configuration()

    question = _question(case_root, question_id)
    result_path = ask_dir / "result.json"
    log_path = ask_dir / "ask_server.log"
    if result_path.exists():
        if experiment.run.mode == "resume" and _result_is_complete(
            result_path,
            question_id=question_id,
            rerank_base_url=config.rerank_base_url,
            rerank_model=config.rerank_model,
            top_k=config.top_k,
            build_configuration_sha256=build_configuration_sha256,
            retrieval_config=retrieval_config,
        ):
            _print_block(f"[{position}/{total}] SKIPPED {question_id} (complete)")
            return
        if experiment.run.mode == "resume":
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
    env["KL_RERANK_BASE_URL"] = config.rerank_base_url
    env["KL_RERANK_MODEL"] = config.rerank_model
    env["KL_CLI_TIMEOUT"] = str(config.request_timeout_seconds)

    _print_block(
        f"[{position}/{total}] START {question_id}",
        f"  KL_DATA_DIR={data_dir}",
        f"  reranker={config.rerank_model} @ {config.rerank_base_url}",
        f"  kl ask <question> --no-phase2 --top-k {config.top_k} --json",
    )
    if dry_run:
        return

    ask_dir.mkdir(parents=True, exist_ok=True)
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
        str(config.top_k),
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
            _wait_for_server(
                server,
                port,
                log_path,
                config.server_start_timeout_seconds,
            )
            completed = subprocess.run(
                ask_command,
                cwd=PROJECT_ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=config.request_timeout_seconds,
                check=False,
            )
        if completed.returncode:
            detail = completed.stderr.strip() or completed.stdout.strip()
            raise RuntimeError(f"kl ask failed: {detail[-1000:]}")
        response = json.loads(completed.stdout)
        if response.get("phase") != 1 or response.get("answer") not in (None, ""):
            raise RuntimeError("kl ask unexpectedly ran Phase 2")
        if len(response.get("items", [])) > config.top_k:
            raise RuntimeError(f"kl ask returned more than {config.top_k} items")
        atomic_write_json(
            result_path,
            {
                "question_id": question_id,
                "reranker": {
                    "base_url": config.rerank_base_url,
                    "model": config.rerank_model,
                },
                "top_k": config.top_k,
                "force_phase2": False,
                "build_configuration_sha256": build_configuration_sha256,
                "retrieval_configuration": retrieval_config,
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
    build_dirs: dict[str, Path],
    ask_dirs: dict[str, Path],
    experiment: AskExperiment,
    *,
    dry_run: bool,
) -> list[str]:
    """Run isolated case queries in a bounded thread pool."""
    total = len(selected)
    workers = min(experiment.ask.case_concurrency, total)
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
                build_dirs[str(entry["question_id"])],
                ask_dirs[str(entry["question_id"])],
                experiment,
                position,
                total,
                dry_run=dry_run,
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
                TypeError,
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
                if not experiment.run.keep_going and not stop_after_failure:
                    stop_after_failure = True
                    for pending in futures:
                        pending.cancel()
    finally:
        executor.shutdown(wait=True, cancel_futures=stop_after_failure)
    return failures


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        experiment = load_ask_experiment(args.config)
        root, entries = _load_case_entries(convert_output_dir(experiment))
        selected = select_entries(entries, experiment.selection)
        if args.case_id is not None:
            selected = [
                entry for entry in selected if str(entry["question_id"]) == args.case_id
            ]
            if len(selected) != 1:
                raise ValueError(f"case is not selected: {args.case_id}")
    except (
        OSError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
        OmegaConfBaseException,
    ) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    _print_block(
        f"LongMemEval cases selected: {len(selected)}",
        f"Case concurrency: {min(experiment.ask.case_concurrency, len(selected))}",
    )
    build_dirs = {
        str(entry["question_id"]): case_stage_output_dir(
            experiment, str(entry["question_id"]), "build"
        )
        for entry in selected
    }
    ask_dirs = {
        str(entry["question_id"]): case_stage_output_dir(
            experiment, str(entry["question_id"]), "ask"
        )
        for entry in selected
    }
    failures = _run_cases(
        root,
        selected,
        build_dirs,
        ask_dirs,
        experiment,
        dry_run=args.dry_run,
    )
    if failures:
        print(f"failed cases: {failures}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
