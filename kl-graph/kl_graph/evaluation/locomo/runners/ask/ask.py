"""Run production ``kl ask`` once for each selected LoCoMo question.

This is a thin process orchestrator. It processes conversation graphs one at a
time: start one production KL server, run that conversation's questions, stop
it, then advance to the next graph. It persists the unmodified Phase-1 response
and does not resolve evidence, score retrieval, or generate answers.

Example::

    python -m kl_graph.evaluation.locomo.runners.ask.ask \
      --dataset data/locomo-v2 --category 1 --limit 10
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from kl_graph.config import PROJECT_ROOT, cfg
from kl_graph.evaluation.io import (
    artifact_stem,
    atomic_write_json,
    atomic_write_jsonl,
    json_lines,
)
from kl_graph.evaluation.locomo.build import (
    case_set_fingerprint,
    cases_by_conversation,
    load_case_entries,
    resolve_case_root,
    resolve_case_set_dir,
    validate_built_case,
)
from kl_graph.evaluation.locomo.runtime.servers import (
    ProductionGraphServers,
    route_port,
)

DEFAULT_TIMEOUT_SECONDS = 180.0
DEFAULT_TOP_K = 5

LLM_BASE_URL = str(cfg.services.llm_flash.base_url or "")
LLM_MODEL = str(cfg.services.llm_flash.model)
EMBED_BASE_URL = str(cfg.services.embedding.base_url or "")
EMBED_MODEL = str(cfg.services.embedding.model)
EMBEDDING_DIM = int(cfg.services.embedding.dim)
RERANK_BASE_URL = str(cfg.services.reranker.base_url or "")
RERANK_MODEL = str(cfg.services.reranker.model or "")
RERANK_TOP_K = int(cfg.pipelines.query.reranking.top_k)
RERANK_WINDOW = int(cfg.pipelines.query.reranking.window)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run production kl ask once per selected LoCoMo question.",
        epilog=(
            "The Codex free-exploration evaluator remains available through "
            "python -m kl_graph.evaluation.locomo."
        ),
    )
    parser.add_argument("--dataset", type=Path, default=None)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help=(
            "override the default benchmark/locomo-ask/CATEGORY/RUN_TIME "
            "directory"
        ),
    )
    parser.add_argument("--run-id", default=None)
    parser.add_argument(
        "--conversation",
        default=None,
        help="run questions for one conversation ID (for example chat:conv-26)",
    )
    parser.add_argument("--category", type=int, choices=range(1, 6))
    parser.add_argument("--question-id", default=None)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--max-concurrent", type=int, default=4)
    parser.add_argument("--checkpoint-every", type=int, default=10)
    parser.add_argument(
        "--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=DEFAULT_TOP_K,
        help=(
            "number of ranked retrieval items returned by kl ask "
            f"(default: {DEFAULT_TOP_K}, max: {RERANK_TOP_K})"
        ),
    )
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args(argv)

    for name in ("max_concurrent", "checkpoint_every", "top_k"):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if args.top_k > RERANK_TOP_K:
        parser.error(f"--top-k cannot exceed the engine result cap ({RERANK_TOP_K})")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")
    if args.run_id is not None and not re.fullmatch(r"[A-Za-z0-9._-]+", args.run_id):
        parser.error(
            "--run-id may contain only letters, digits, dot, underscore, and hyphen"
        )
    if args.output_dir is not None and args.run_id is not None:
        parser.error("--output-dir and --run-id are mutually exclusive")
    return args


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    dataset_dir = resolve_case_set_dir(args.dataset, PROJECT_ROOT)
    args.dataset = dataset_dir
    args.case_set_fingerprint = case_set_fingerprint(dataset_dir)
    output_dir = _resolve_output_dir(args, dataset_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    rows = _select_rows(
        dataset_dir,
        conversation=args.conversation,
        category=args.category,
        question_id=args.question_id,
        limit=args.limit,
    )
    case_by_conversation = cases_by_conversation(dataset_dir)
    selected_conversations = sorted({row["conversation_id"] for row in rows})
    selected_cases = [case_by_conversation[value] for value in selected_conversations]
    _validate_inputs(dataset_dir, selected_cases)
    _validate_resume_configuration(output_dir, args, len(rows))
    _print_plan(args, dataset_dir, output_dir, len(rows), len(selected_cases))
    _log_event(
        output_dir,
        "ask_run_start",
        questions=len(rows),
        graphs=len(selected_cases),
        graph_execution="sequential",
        max_concurrent=args.max_concurrent,
        top_k=args.top_k,
        force_phase2=False,
        resume=args.resume,
    )
    results = await _run_questions(
        args,
        rows,
        output_dir,
        dataset_dir,
        case_by_conversation,
    )
    statuses = _status_counts(results)
    _log_event(
        output_dir,
        "ask_run_complete",
        results=len(results),
        statuses=statuses,
    )
    _print_completion(output_dir, results)
    return 0 if len(results) == len(rows) and statuses.get("failed", 0) == 0 else 1


def _validate_inputs(case_set_root: Path, cases: list[dict[str, Any]]) -> None:
    for case in cases:
        validate_built_case(case_set_root, case)


def _resolve_output_dir(args: argparse.Namespace, case_set_dir: Path) -> Path:
    if args.output_dir is not None:
        candidate = args.output_dir.expanduser().resolve()
    else:
        category_name = f"category-{args.category}" if args.category else "all"
        if args.conversation is None:
            artifact_root = case_set_dir
        else:
            case = cases_by_conversation(case_set_dir).get(args.conversation)
            if case is None:
                raise ValueError(f"unknown LoCoMo conversation: {args.conversation}")
            artifact_root = resolve_case_root(case_set_dir, case)
        root = artifact_root / "benchmark" / "locomo-ask" / category_name
        if args.resume and args.run_id is None:
            candidates = (
                sorted(
                    path
                    for path in root.iterdir()
                    if path.is_dir() and (path / "run.json").is_file()
                )
                if root.is_dir()
                else []
            )
            if not candidates:
                raise FileNotFoundError(f"no run found to resume under {root}")
            candidate = candidates[-1]
        else:
            run_id = args.run_id or datetime.now().astimezone().strftime(
                "%Y%m%d-%H%M%S"
            )
            candidate = root / run_id
        if args.run_id is None and not args.resume:
            suffix = 1
            while candidate.exists():
                candidate = root / f"{run_id}-{suffix:02d}"
                suffix += 1
    if args.resume:
        if not (candidate / "run.json").is_file():
            raise FileNotFoundError(
                f"run does not exist or has no run.json: {candidate}"
            )
    elif candidate.exists():
        raise FileExistsError(
            f"run directory already exists: {candidate}; use --resume or "
            "another --run-id"
        )
    return candidate


def _select_rows(
    dataset_dir: Path,
    *,
    conversation: str | None,
    category: int | None,
    question_id: str | None,
    limit: int | None,
) -> list[dict[str, Any]]:
    rows = _load_questions(dataset_dir)
    if conversation is not None:
        rows = [row for row in rows if row["conversation_id"] == conversation]
    if category is not None:
        rows = [row for row in rows if row["category"] == category]
    if question_id:
        rows = [row for row in rows if row["id"] == question_id]
    if limit is not None:
        rows = rows[:limit]
    if not rows:
        raise ValueError("no LoCoMo questions matched the requested filters")
    return rows


def _load_questions(case_set_dir: Path) -> list[dict[str, Any]]:
    root, cases = load_case_entries(case_set_dir)
    rows: list[dict[str, Any]] = []
    for case in cases:
        conversation_id = str(case["conversation_id"])
        for raw in json_lines(resolve_case_root(root, case) / "evaluation.jsonl"):
            data = raw.get("data") or {}
            if not isinstance(data, dict):
                continue
            rows.append(
                {
                    "id": str(raw.get("id") or ""),
                    "sample_id": str(raw.get("sample_id") or ""),
                    "conversation_id": conversation_id,
                    "question": str(data.get("question") or ""),
                    "category": int(data["category"]),
                }
            )
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("evaluation rows must have unique ids")
    return rows


def _validate_resume_configuration(
    output_dir: Path, args: argparse.Namespace, questions: int
) -> None:
    """Prevent a resumed run from silently mixing retrieval protocols."""
    if not args.resume:
        return
    run = json.loads((output_dir / "run.json").read_text(encoding="utf-8"))
    expected = {
        "dataset": str(args.dataset),
        "case_set_fingerprint": args.case_set_fingerprint,
        "conversation": args.conversation,
        "category": args.category,
        "question_id": args.question_id,
        "limit": args.limit,
        "questions": questions,
        "top_k": args.top_k,
        "force_phase2": False,
        "graph_execution": "sequential",
    }
    mismatches = {
        key: {"recorded": run.get(key), "requested": value}
        for key, value in expected.items()
        if run.get(key) != value
    }
    if mismatches:
        raise ValueError(
            "resume configuration differs from the recorded run: "
            + json.dumps(mismatches, ensure_ascii=False, sort_keys=True)
        )


async def _run_questions(
    args: argparse.Namespace,
    rows: list[dict[str, Any]],
    output_dir: Path,
    dataset_dir: Path,
    case_by_conversation: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    results_path = output_dir / "results.jsonl"
    completed = _load_existing(results_path) if args.resume else {}
    started_at = datetime.now().astimezone().isoformat()
    _write_run(
        output_dir,
        status="running",
        started_at=started_at,
        rows=rows,
        args=args,
        result_count=len(completed),
    )
    if args.resume:
        _log_event(
            output_dir,
            "resume_state_loaded",
            completed=len(completed),
            remaining=len(rows) - len(completed),
        )

    semaphore = asyncio.Semaphore(args.max_concurrent)
    segment_started = time.monotonic()
    segment_completed = 0
    since_checkpoint = 0
    groups = _group_rows_by_conversation(rows)

    async def run_one(row: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            return await _invoke_one_ask(row, output_dir, args)

    for graph_index, (conversation_id, graph_rows) in enumerate(groups.items(), 1):
        pending_rows = [row for row in graph_rows if row["id"] not in completed]
        if not pending_rows:
            _log_event(
                output_dir,
                "graph_skipped",
                conversation_id=conversation_id,
                reason="all_questions_completed",
            )
            continue

        print(
            f"Graph {graph_index}/{len(groups)}: {conversation_id} "
            f"({len(pending_rows)} questions)",
            flush=True,
        )
        graph_started = time.monotonic()
        _log_event(
            output_dir,
            "graph_start",
            conversation_id=conversation_id,
            graph_index=graph_index,
            graphs=len(groups),
            questions=len(pending_rows),
        )
        server_dir = output_dir / "servers" / artifact_stem(conversation_id)
        pending: list[asyncio.Task[dict[str, Any]]] = []
        with ProductionGraphServers(
            dataset_dir,
            [case_by_conversation[conversation_id]],
            server_dir,
        ):
            pending = [asyncio.create_task(run_one(row)) for row in pending_rows]
            try:
                for task in asyncio.as_completed(pending):
                    result = await task
                    completed[result["id"]] = result
                    segment_completed += 1
                    since_checkpoint += 1
                    _log_event(
                        output_dir,
                        "ask_complete",
                        id=result["id"],
                        conversation_id=result["conversation_id"],
                        category=result["category"],
                        status=result["status"],
                        duration_ms=result["duration_ms"],
                        phase=result["phase"],
                        mode=result["mode"],
                        error=result["error"],
                    )
                    if since_checkpoint >= args.checkpoint_every:
                        _write_ordered_results(results_path, rows, completed)
                        progress = _progress(
                            completed=len(completed),
                            total=len(rows),
                            failed=sum(
                                value["status"] != "completed"
                                for value in completed.values()
                            ),
                            segment_completed=segment_completed,
                            segment_elapsed=time.monotonic() - segment_started,
                        )
                        print(progress, flush=True)
                        _log_event(output_dir, "checkpoint", **progress)
                        since_checkpoint = 0
            finally:
                for task in pending:
                    if not task.done():
                        task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)

        _write_ordered_results(results_path, rows, completed)
        graph_results = [
            completed[row["id"]] for row in graph_rows if row["id"] in completed
        ]
        _log_event(
            output_dir,
            "graph_complete",
            conversation_id=conversation_id,
            questions=len(graph_results),
            statuses=_status_counts(graph_results),
            elapsed_s=round(time.monotonic() - graph_started, 1),
        )

    ordered = _write_ordered_results(results_path, rows, completed)
    statuses = _status_counts(ordered)
    final_status = (
        "complete"
        if len(ordered) == len(rows) and statuses.get("failed", 0) == 0
        else "incomplete"
    )
    _write_run(
        output_dir,
        status=final_status,
        started_at=started_at,
        completed_at=datetime.now().astimezone().isoformat(),
        rows=rows,
        args=args,
        result_count=len(ordered),
        statuses=statuses,
    )
    _log_event(
        output_dir,
        "asks_finished",
        results=len(ordered),
        statuses=statuses,
    )
    return ordered


def _group_rows_by_conversation(
    rows: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(str(row["conversation_id"]), []).append(row)
    return groups


async def _invoke_one_ask(
    row: dict[str, Any],
    output_dir: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    command = [
        sys.executable,
        str(PROJECT_ROOT / "kl_cli.py"),
        "ask",
        str(row["question"]),
        "--no-phase2",
        "--top-k",
        str(args.top_k),
        "--json",
    ]

    started = time.monotonic()
    base = {
        "id": row["id"],
        "question": row["question"],
        "category": int(row["category"]),
        "sample_id": row["sample_id"],
        "conversation_id": row["conversation_id"],
        "ask_calls": 1,
        "top_k": args.top_k,
        "force_phase2": False,
    }
    process: asyncio.subprocess.Process | None = None
    try:
        child_env = os.environ.copy()
        child_env["KL_CLI_TIMEOUT"] = str(args.timeout_seconds)
        child_env["KL_SERVER_PORT"] = str(route_port(str(row["conversation_id"])))
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=PROJECT_ROOT,
            env=child_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=args.timeout_seconds
        )
        if process.returncode != 0:
            detail = stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(
                f"kl ask exited {process.returncode}: {_truncate_error(detail)}"
            )
        response = json.loads(stdout.decode("utf-8"))
        if not isinstance(response, dict):
            raise TypeError("kl ask response is not a JSON object")
        if response.get("phase") != 1 or response.get("answer") not in (None, ""):
            raise RuntimeError("kl ask unexpectedly ran Phase 2")
        items = response.get("items")
        if not isinstance(items, list):
            raise TypeError("kl ask response items is not a list")
        if len(items) > args.top_k:
            raise RuntimeError(
                f"kl ask returned {len(items)} items, expected at most {args.top_k}"
            )
        relative_response = Path("responses") / f"{artifact_stem(row['id'])}.json"
        atomic_write_json(output_dir / relative_response, response)
        return {
            **base,
            "status": "completed",
            "duration_ms": round((time.monotonic() - started) * 1000),
            "phase": response.get("phase"),
            "mode": response.get("mode"),
            "response_path": str(relative_response),
            "error": None,
        }
    except asyncio.TimeoutError:
        if process is not None and process.returncode is None:
            process.kill()
            await process.communicate()
        error = f"kl ask timed out after {args.timeout_seconds:g}s"
    except asyncio.CancelledError:
        if process is not None and process.returncode is None:
            process.kill()
            await process.communicate()
        raise
    except (json.JSONDecodeError, OSError, RuntimeError, TypeError) as exc:
        error = str(exc)
    return {
        **base,
        "status": "failed",
        "duration_ms": round((time.monotonic() - started) * 1000),
        "phase": None,
        "mode": None,
        "response_path": None,
        "error": _truncate_error(error),
    }


def _write_run(
    output_dir: Path,
    *,
    status: str,
    started_at: str,
    rows: list[dict[str, Any]],
    args: argparse.Namespace,
    result_count: int,
    completed_at: str | None = None,
    statuses: dict[str, int] | None = None,
) -> None:
    atomic_write_json(
        output_dir / "run.json",
        {
            "status": status,
            "run_id": output_dir.name,
            "started_at": started_at,
            "completed_at": completed_at,
            "dataset": str(args.dataset),
            "case_set_fingerprint": args.case_set_fingerprint,
            "conversation": args.conversation,
            "category": args.category,
            "question_id": args.question_id,
            "limit": args.limit,
            "questions": len(rows),
            "results": result_count,
            "statuses": statuses,
            "protocol": "exactly_one_production_kl_ask_per_question",
            "graph_execution": "sequential",
            "outer_codex_agent": False,
            "max_concurrent": args.max_concurrent,
            "timeout_seconds": args.timeout_seconds,
            "top_k": args.top_k,
            "force_phase2": False,
            "models": _model_metadata(),
        },
    )


def _model_metadata() -> dict[str, Any]:
    """Record the model-backed parts of the single-ask protocol, without keys."""
    return {
        "query_rewrite": {
            "enabled": True,
            "model": LLM_MODEL,
            "base_url": LLM_BASE_URL,
        },
        "phase2_synthesis": {
            "enabled": False,
            "model": None,
            "base_url": None,
        },
        "embedding": {
            "model": EMBED_MODEL,
            "dimensions": EMBEDDING_DIM,
            "base_url": EMBED_BASE_URL,
        },
        "reranker": {
            "enabled": bool(RERANK_BASE_URL and RERANK_MODEL),
            "model": RERANK_MODEL or None,
            "base_url": RERANK_BASE_URL or None,
            "candidate_window": RERANK_WINDOW,
            "engine_top_k": RERANK_TOP_K,
        },
    }


def _load_existing(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    return {
        str(row["id"]): row
        for row in json_lines(path)
        if (
            isinstance(row, dict) and row.get("id") and row.get("status") == "completed"
        )
    }


def _write_ordered_results(
    path: Path,
    rows: list[dict[str, Any]],
    completed: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    ordered = [completed[row["id"]] for row in rows if row["id"] in completed]
    atomic_write_jsonl(path, ordered)
    return ordered


def _status_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        status = str(row.get("status") or "unknown")
        counts[status] = counts.get(status, 0) + 1
    return counts


def _progress(
    *,
    completed: int,
    total: int,
    failed: int,
    segment_completed: int,
    segment_elapsed: float,
) -> dict[str, Any]:
    rate = segment_completed / segment_elapsed if segment_elapsed > 0 else 0.0
    remaining = max(total - completed, 0)
    return {
        "asks_completed": completed,
        "total": total,
        "failed": failed,
        "elapsed_s": round(segment_elapsed, 1),
        "asks_per_minute": round(rate * 60, 2),
        "eta_s": round(remaining / rate) if rate > 0 else None,
    }


def _log_event(output_dir: Path, event: str, **values: Any) -> None:
    """Append machine-readable and human-readable persistent run logs."""
    timestamp = datetime.now().astimezone().isoformat()
    row = {"timestamp": timestamp, "event": event, **values}
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    with (output_dir / "run.log").open("a", encoding="utf-8") as handle:
        handle.write(
            f"{timestamp} {event} "
            f"{json.dumps(values, ensure_ascii=False, sort_keys=True)}\n"
        )


def _truncate_error(value: str, limit: int = 2000) -> str:
    value = value.strip()
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _print_plan(
    args: argparse.Namespace,
    dataset_dir: Path,
    output_dir: Path,
    questions: int,
    graphs: int,
) -> None:
    print("LoCoMo production kl ask", flush=True)
    print(f"  dataset:       {dataset_dir}", flush=True)
    print(f"  physical graphs: {graphs}", flush=True)
    print(f"  output:        {output_dir}", flush=True)
    print(f"  questions:     {questions}", flush=True)
    print(
        f"  protocol:      graphs sequential, one production kl ask/question, "
        f"per-graph concurrent={args.max_concurrent}",
        flush=True,
    )
    print(
        f"  ask:           top-k={args.top_k}, force-phase2=False",
        flush=True,
    )


def _print_completion(output_dir: Path, results: list[dict[str, Any]]) -> None:
    completed = sum(row.get("status") == "completed" for row in results)
    print(f"Completed: {completed}/{len(results)} asks", flush=True)
    print(f"Results: {output_dir}", flush=True)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
