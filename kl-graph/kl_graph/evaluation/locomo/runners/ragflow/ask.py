"""Run RAGFlow retrieval for questions in the native LoCoMo dataset."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

from kl_graph.config import PROJECT_ROOT
from kl_graph.evaluation.io import (
    artifact_stem,
    atomic_write_json,
    atomic_write_jsonl,
    json_lines,
)
from kl_graph.evaluation.ragflow import RagflowEvaluationClient

from .build import DEFAULT_BASE_URL, load_state
from .source import (
    DEFAULT_ARTIFACT_ROOT,
    DEFAULT_SOURCE,
    case_root,
    extract_dia_ids,
    load_samples,
    question_rows,
    select_samples,
    source_fingerprint,
)

DEFAULT_TOP_K = 5
DEFAULT_CANDIDATE_COUNT = 1024


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def _unit_float(value: str) -> float:
    parsed = float(value)
    if not 0 <= parsed <= 1:
        raise argparse.ArgumentTypeError("must be between 0 and 1")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument(
        "--artifact-root", type=Path, default=DEFAULT_ARTIFACT_ROOT
    )
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--conversation", dest="conversation_ids", action="append", metavar="ID"
    )
    selection.add_argument("--first", type=_positive_int, metavar="N")
    selection.add_argument("--all", action="store_true")
    parser.add_argument("--category", type=int, choices=range(1, 6))
    parser.add_argument("--question-id", default=None)
    parser.add_argument("--limit", type=_positive_int, default=None)
    parser.add_argument("--use-kg", action="store_true")
    parser.add_argument("--top-k", type=_positive_int, default=DEFAULT_TOP_K)
    parser.add_argument(
        "--candidate-count",
        type=_positive_int,
        default=DEFAULT_CANDIDATE_COUNT,
    )
    parser.add_argument("--similarity-threshold", type=_unit_float, default=0.2)
    parser.add_argument(
        "--vector-similarity-weight", type=_unit_float, default=0.3
    )
    parser.add_argument(
        "--rerank-id", default=os.environ.get("RAGFLOW_RERANK_ID") or None
    )
    parser.add_argument("--max-concurrent", type=_positive_int, default=4)
    parser.add_argument("--checkpoint-every", type=_positive_int, default=10)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument(
        "--base-url", default=os.environ.get("RAGFLOW_BASE_URL", DEFAULT_BASE_URL)
    )
    args = parser.parse_args(argv)
    if args.run_id and not re.fullmatch(r"[A-Za-z0-9._-]+", args.run_id):
        parser.error(
            "--run-id may contain only letters, digits, dot, underscore, and hyphen"
        )
    if args.output_dir is not None and args.run_id is not None:
        parser.error("--output-dir and --run-id are mutually exclusive")
    if args.candidate_count < args.top_k:
        parser.error("--candidate-count cannot be smaller than --top-k")
    return args


def _resolve_output_dir(
    args: argparse.Namespace, selected: list[dict[str, Any]]
) -> Path:
    if args.output_dir is not None:
        candidate = args.output_dir.expanduser().resolve()
    else:
        mode = "graph" if args.use_kg else "vector"
        category = f"category-{args.category}" if args.category else "all"
        if len(selected) == 1:
            root = case_root(
                args.artifact_root, str(selected[0]["sample_id"])
            )
        else:
            root = args.artifact_root.expanduser().resolve()
        root = root / "benchmark" / "locomo-ragflow-ask" / mode / category
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
                raise FileNotFoundError(f"no RAGFlow ask run to resume under {root}")
            return candidates[-1]
        run_id = args.run_id or datetime.now().astimezone().strftime(
            "%Y%m%d-%H%M%S"
        )
        candidate = root / run_id
        if not args.resume and args.run_id is None:
            suffix = 1
            while candidate.exists():
                candidate = root / f"{run_id}-{suffix:02d}"
                suffix += 1
    if args.resume:
        if not (candidate / "run.json").is_file():
            raise FileNotFoundError(f"RAGFlow ask run does not exist: {candidate}")
    elif candidate.exists():
        raise FileExistsError(
            f"output directory exists: {candidate}; use --resume"
        )
    return candidate


def _validate_states(
    args: argparse.Namespace,
    source_sha256: str,
    samples: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    states: dict[str, dict[str, Any]] = {}
    for sample in samples:
        sample_id = str(sample["sample_id"])
        state = load_state(args.artifact_root, sample_id)
        if state.get("source_sha256") != source_sha256:
            raise ValueError(f"RAGFlow build source changed for {sample_id}")
        if state.get("status") != "complete":
            raise RuntimeError(f"RAGFlow build is not complete for {sample_id}")
        if (state.get("parse") or {}).get("state") != "complete":
            raise RuntimeError(f"RAGFlow parse is not complete for {sample_id}")
        if args.use_kg and (state.get("graph") or {}).get("state") != "complete":
            raise RuntimeError(f"RAGFlow GraphRAG is not complete for {sample_id}")
        if state.get("config", {}).get("base_url") != args.base_url.rstrip("/"):
            raise ValueError(f"RAGFlow base URL differs from build for {sample_id}")
        states[sample_id] = state
    return states


def _normalise_items(
    chunks: list[dict[str, Any]], *, top_k: int
) -> tuple[list[dict[str, Any]], int]:
    items: list[dict[str, Any]] = []
    graph_count = 0
    for rank, chunk in enumerate(chunks, 1):
        content = str(chunk.get("content") or "").strip()
        if not content:
            continue
        document_id = str(chunk.get("document_id") or "")
        document_name = str(
            chunk.get("document_name") or chunk.get("document_keyword") or ""
        )
        is_graph = not document_id and document_name == (
            "Related content in Knowledge Graph"
        )
        if is_graph:
            graph_count += 1
        items.append(
            {
                "id": str(chunk.get("id") or f"ragflow-rank-{rank}"),
                "type": "graph" if is_graph else "chunk",
                "content": content,
                "timestamp": 0,
                "score": float(chunk.get("similarity") or 0.0),
                "vector_score": float(chunk.get("vector_similarity") or 0.0),
                "term_score": float(chunk.get("term_similarity") or 0.0),
                "document_id": document_id or None,
                "document_name": document_name or None,
                "dia_ids": extract_dia_ids(content),
            }
        )
        if len(items) >= top_k:
            break
    return items, graph_count


def _ask_one(
    client: RagflowEvaluationClient,
    row: dict[str, Any],
    state: dict[str, Any],
    args: argparse.Namespace,
    output_dir: Path,
) -> dict[str, Any]:
    started = time.monotonic()
    base = {
        "id": row["id"],
        "sample_id": row["sample_id"],
        "conversation_id": row["conversation_id"],
        "question": row["question"],
        "category": row["category"],
        "ask_calls": 1,
        "top_k": args.top_k,
        "use_kg": args.use_kg,
    }
    try:
        chunks = client.retrieve(
            dataset_id=str(state["dataset_id"]),
            question=str(row["question"]),
            result_count=args.top_k,
            candidate_count=args.candidate_count,
            similarity_threshold=args.similarity_threshold,
            vector_similarity_weight=args.vector_similarity_weight,
            rerank_id=args.rerank_id,
            use_kg=args.use_kg,
        )
        items, graph_count = _normalise_items(chunks, top_k=args.top_k)
        relative = Path("responses") / f"{artifact_stem(str(row['id']))}.json"
        atomic_write_json(
            output_dir / relative,
            {
                "phase": 1,
                "answer": None,
                "mode": "ragflow_graph" if args.use_kg else "ragflow_vector",
                "items": items,
                "retrieval": {
                    "returned_by_sdk": len(chunks),
                    "persisted_top_k": len(items),
                    "graph_items_returned": graph_count,
                    "candidate_count": args.candidate_count,
                    "rerank_id": args.rerank_id,
                },
            },
        )
        return {
            **base,
            "status": "completed",
            "duration_ms": round((time.monotonic() - started) * 1000),
            "response_path": str(relative),
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - persist per-question SDK failures
        return {
            **base,
            "status": "failed",
            "duration_ms": round((time.monotonic() - started) * 1000),
            "response_path": None,
            "error": f"{type(exc).__name__}: {exc}"[:2000],
        }


def _load_completed(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    return {
        str(row["id"]): row
        for row in json_lines(path)
        if row.get("status") == "completed"
    }


def _ordered(
    rows: list[dict[str, Any]], completed: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    return [completed[row["id"]] for row in rows if row["id"] in completed]


def _write_run(
    output_dir: Path,
    *,
    args: argparse.Namespace,
    source: Path,
    source_sha256: str,
    selected: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    result_count: int,
    status: str,
) -> None:
    atomic_write_json(
        output_dir / "run.json",
        {
            "status": status,
            "backend": "ragflow",
            "benchmark": "locomo",
            "started_at": datetime.now().astimezone().isoformat(),
            "source": str(source),
            "source_sha256": source_sha256,
            "dataset": str(source),
            "artifact_root": str(args.artifact_root.expanduser().resolve()),
            "conversation": (
                str(selected[0]["sample_id"]) if len(selected) == 1 else None
            ),
            "conversations": [str(sample["sample_id"]) for sample in selected],
            "case_root": (
                str(case_root(args.artifact_root, str(selected[0]["sample_id"])))
                if len(selected) == 1
                else None
            ),
            "category": args.category,
            "question_id": args.question_id,
            "limit": args.limit,
            "questions": len(rows),
            "results": result_count,
            "top_k": args.top_k,
            "candidate_count": args.candidate_count,
            "similarity_threshold": args.similarity_threshold,
            "vector_similarity_weight": args.vector_similarity_weight,
            "rerank_id": args.rerank_id,
            "use_kg": args.use_kg,
            "max_concurrent": args.max_concurrent,
            "protocol": "one_ragflow_sdk_retrieve_per_question",
            "top_k_policy": (
                "truncate_sdk_response_after_graph_prepend_to_exactly_top_k"
            ),
        },
    )


def _validate_resume(
    output_dir: Path,
    args: argparse.Namespace,
    source_sha256: str,
    selected: list[dict[str, Any]],
    rows: list[dict[str, Any]],
) -> None:
    if not args.resume:
        return
    run = json.loads((output_dir / "run.json").read_text(encoding="utf-8"))
    expected = {
        "source_sha256": source_sha256,
        "conversations": [str(sample["sample_id"]) for sample in selected],
        "category": args.category,
        "question_id": args.question_id,
        "limit": args.limit,
        "questions": len(rows),
        "top_k": args.top_k,
        "candidate_count": args.candidate_count,
        "similarity_threshold": args.similarity_threshold,
        "vector_similarity_weight": args.vector_similarity_weight,
        "rerank_id": args.rerank_id,
        "use_kg": args.use_kg,
    }
    mismatch = {
        key: {"recorded": run.get(key), "requested": value}
        for key, value in expected.items()
        if run.get(key) != value
    }
    if mismatch:
        raise ValueError(
            "resume configuration differs: "
            + json.dumps(mismatch, ensure_ascii=False, sort_keys=True)
        )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        source, samples = load_samples(args.source)
        selected = select_samples(
            samples,
            conversation_ids=args.conversation_ids,
            first=args.first,
        )
        source_sha256 = source_fingerprint(source)
        states = _validate_states(args, source_sha256, selected)
        rows = question_rows(
            selected,
            category=args.category,
            question_id=args.question_id,
            limit=args.limit,
        )
        output_dir = _resolve_output_dir(args, selected)
        _validate_resume(
            output_dir, args, source_sha256, selected, rows
        )
        client = RagflowEvaluationClient(
            os.environ.get("RAGFLOW_API_KEY", ""), args.base_url
        )
    except (OSError, TypeError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)
    results_path = output_dir / "results.jsonl"
    completed = _load_completed(results_path) if args.resume else {}
    _write_run(
        output_dir,
        args=args,
        source=source,
        source_sha256=source_sha256,
        selected=selected,
        rows=rows,
        result_count=len(completed),
        status="running",
    )
    print(
        f"RAGFlow questions: {len(rows)}; concurrency={args.max_concurrent}; "
        f"use_kg={args.use_kg}",
        flush=True,
    )
    futures: dict[Future[dict[str, Any]], str] = {}
    with ThreadPoolExecutor(
        max_workers=min(args.max_concurrent, len(rows)),
        thread_name_prefix="locomo-ragflow-ask",
    ) as executor:
        for row in rows:
            if row["id"] in completed:
                continue
            futures[
                executor.submit(
                    _ask_one,
                    client,
                    row,
                    states[str(row["sample_id"])],
                    args,
                    output_dir,
                )
            ] = str(row["id"])
        since_checkpoint = 0
        for future in as_completed(futures):
            result = future.result()
            completed[str(result["id"])] = result
            since_checkpoint += 1
            if result["status"] != "completed":
                print(f"FAILED {result['id']}: {result['error']}", file=sys.stderr)
            if since_checkpoint >= args.checkpoint_every:
                atomic_write_jsonl(results_path, _ordered(rows, completed))
                print(f"completed {len(completed)}/{len(rows)}", flush=True)
                since_checkpoint = 0

    ordered = _ordered(rows, completed)
    atomic_write_jsonl(results_path, ordered)
    failures = sum(row["status"] != "completed" for row in ordered)
    status = (
        "complete" if len(ordered) == len(rows) and failures == 0 else "incomplete"
    )
    _write_run(
        output_dir,
        args=args,
        source=source,
        source_sha256=source_sha256,
        selected=selected,
        rows=rows,
        result_count=len(ordered),
        status=status,
    )
    print(f"Results: {output_dir}", flush=True)
    return 0 if status == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
