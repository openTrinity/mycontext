"""Run one RAGFlow retrieval call for each native LongMemEval question case."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import unicodedata
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.evaluation.io import (
    artifact_stem,
    atomic_write_json,
    atomic_write_jsonl,
    json_lines,
)
from kl_graph.evaluation.longmemeval.experiment import (
    RagflowAskExperiment,
    case_stage_output_dir,
    experiment_output_dir,
    load_ragflow_ask_experiment,
    output_dir,
    select_entries,
)
from kl_graph.evaluation.longmemeval.source import (
    case_root,
    load_cases,
    render_document_turns,
    source_fingerprint,
)
from kl_graph.evaluation.ragflow import RagflowEvaluationClient

from .build import load_state


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, required=True, help="LongMemEval RAGFlow experiment YAML"
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--case-id")
    return parser.parse_args(argv)


def _runtime_options(
    experiment: RagflowAskExperiment, *, case_id: str | None
) -> argparse.Namespace:
    """Adapt typed YAML values to the existing ask worker boundary."""
    return argparse.Namespace(
        artifact_root=experiment_output_dir(experiment),
        base_url=experiment.ragflow.base_url,
        candidate_count=experiment.ask.candidate_count,
        checkpoint_every=experiment.ask.checkpoint_every,
        max_concurrent=experiment.ask.concurrency,
        output_dir=(
            case_stage_output_dir(experiment, case_id, "ask")
            if case_id is not None
            else output_dir(experiment)
        ),
        overwrite=experiment.run.mode == "overwrite",
        rerank_id=experiment.ask.rerank_id,
        resume=experiment.run.mode == "resume",
        similarity_threshold=experiment.ask.similarity_threshold,
        top_k=experiment.ask.top_k,
        use_kg=experiment.ask.use_kg,
        vector_similarity_weight=experiment.ask.vector_similarity_weight,
    )


def _resolve_output_dir(
    args: argparse.Namespace, selected: list[dict[str, Any]]
) -> Path:
    del selected  # the YAML output directory is explicit for every selection
    candidate = args.output_dir.expanduser().resolve()
    if args.resume:
        run_path = candidate / "run.json"
        if candidate.exists() and not run_path.is_file():
            unexpected = [
                path.name
                for path in candidate.iterdir()
                if path.name != "experiment.resolved.json"
            ]
            if unexpected:
                raise FileNotFoundError(
                    f"RAGFlow ask run is incomplete at {candidate}: {unexpected}"
                )
    elif candidate.exists() and not args.overwrite:
        raise FileExistsError(f"output directory exists: {candidate}")
    return candidate


def _validate_states(
    args: argparse.Namespace,
    source_sha256: str,
    cases: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    states: dict[str, dict[str, Any]] = {}
    for case in cases:
        question_id = str(case["question_id"])
        state = load_state(args.artifact_root, question_id)
        if state.get("source_sha256") != source_sha256:
            raise ValueError(f"RAGFlow build source changed for {question_id}")
        if state.get("status") != "complete":
            raise RuntimeError(f"RAGFlow build is not complete for {question_id}")
        if (state.get("parse") or {}).get("state") != "complete":
            raise RuntimeError(f"RAGFlow parse is not complete for {question_id}")
        if args.use_kg and (state.get("graph") or {}).get("state") != "complete":
            raise RuntimeError(f"RAGFlow GraphRAG is not complete for {question_id}")
        if state.get("config", {}).get("base_url") != args.base_url.rstrip("/"):
            raise ValueError(f"RAGFlow base URL differs from build for {question_id}")
        states[question_id] = state
    return states


def _normalise_items(
    chunks: list[dict[str, Any]], *, top_k: int
) -> tuple[list[dict[str, Any]], int]:
    items: list[dict[str, Any]] = []
    graph_count = 0
    chunk_count = 0
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
        graph_count += int(is_graph)
        if not is_graph:
            if chunk_count >= top_k:
                continue
            chunk_count += 1
        items.append(
            {
                "id": str(chunk.get("id") or f"ragflow-rank-{rank}"),
                "type": "graph" if is_graph else "chunk",
                "content": content,
                "score": float(chunk.get("similarity") or 0.0),
                "vector_score": float(chunk.get("vector_similarity") or 0.0),
                "term_score": float(chunk.get("term_similarity") or 0.0),
                "document_id": document_id or None,
                "document_name": document_name or None,
            }
        )
    return items, graph_count


def _source_turn_ids(case: dict[str, Any], content: str) -> list[str]:
    """Map one RAGFlow vector chunk back to contributing native user turns."""

    def normalise(value: str) -> str:
        return " ".join(unicodedata.normalize("NFKC", value).split())

    body = normalise(content)
    if not body:
        raise ValueError("RAGFlow chunk contains no document text")

    rendered_turns = render_document_turns(case)
    normalised_turns = [(turn_id, normalise(text)) for turn_id, text in rendered_turns]
    document = " ".join(text for _, text in normalised_turns)
    starts: list[int] = []
    offset = 0
    for _, text in normalised_turns:
        starts.append(offset)
        offset += len(text) + 1

    matches: list[int] = []
    start = document.find(body)
    while start >= 0:
        matches.append(start)
        start = document.find(body, start + 1)
    if not matches:
        raise ValueError("RAGFlow chunk cannot be located in the uploaded document")

    candidates: list[list[str]] = []
    for chunk_start in matches:
        chunk_end = chunk_start + len(body)
        ids = [
            turn_id
            for (turn_id, text), turn_start in zip(
                normalised_turns, starts, strict=True
            )
            if turn_start < chunk_end and turn_start + len(text) > chunk_start
        ]
        if ids and ids not in candidates:
            candidates.append(ids)
    if len(candidates) != 1:
        raise ValueError(
            "RAGFlow chunk has an ambiguous source-turn mapping: "
            f"candidates={candidates}"
        )
    return candidates[0]


def _ask_one(
    client: RagflowEvaluationClient,
    case: dict[str, Any],
    state: dict[str, Any],
    args: argparse.Namespace,
    output_dir: Path,
) -> dict[str, Any]:
    started = time.monotonic()
    question_id = str(case["question_id"])
    base = {
        "id": question_id,
        "question_id": question_id,
        "question": str(case["question"]),
        "question_type": str(case["question_type"]),
        "ask_calls": 1,
        "top_k": args.top_k,
        "use_kg": args.use_kg,
    }
    try:
        chunks = client.retrieve(
            dataset_id=str(state["dataset_id"]),
            question=str(case["question"]),
            # RAGFlow returns the synthesized GraphRAG item in addition to the
            # requested page size, so Ask Top-K remains the vector chunk count.
            result_count=args.top_k,
            candidate_count=args.candidate_count,
            similarity_threshold=args.similarity_threshold,
            vector_similarity_weight=args.vector_similarity_weight,
            rerank_id=args.rerank_id,
            use_kg=args.use_kg,
        )
        items, graph_count = _normalise_items(chunks, top_k=args.top_k)
        if not items:
            raise RuntimeError(f"RAGFlow returned no usable items for {question_id}")
        for item in items:
            if item["type"] == "chunk":
                item["source_turn_ids"] = _source_turn_ids(case, str(item["content"]))
        relative = Path("responses") / f"{artifact_stem(question_id)}.json"
        atomic_write_json(
            output_dir / relative,
            {
                "question_id": question_id,
                "answer": None,
                "mode": "ragflow_graph" if args.use_kg else "ragflow_vector",
                "items": items,
                "retrieval": {
                    "returned_by_sdk": len(chunks),
                    "persisted_items": len(items),
                    "persisted_vector_top_k": sum(
                        item["type"] == "chunk" for item in items
                    ),
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
    except Exception as exc:  # noqa: BLE001 - persist per-case SDK failure
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
        str(row["question_id"]): row
        for row in json_lines(path)
        if row.get("status") == "completed"
    }


def _ordered(
    cases: list[dict[str, Any]], completed: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    return [
        completed[str(case["question_id"])]
        for case in cases
        if str(case["question_id"]) in completed
    ]


def _write_run(
    output_dir: Path,
    *,
    args: argparse.Namespace,
    source: Path,
    source_sha256: str,
    selected: list[dict[str, Any]],
    result_count: int,
    status: str,
) -> None:
    atomic_write_json(
        output_dir / "run.json",
        {
            "status": status,
            "backend": "ragflow",
            "benchmark": "longmemeval",
            "started_at": datetime.now().astimezone().isoformat(),
            "source": str(source),
            "source_sha256": source_sha256,
            "artifact_root": str(args.artifact_root.expanduser().resolve()),
            "question_id": (
                str(selected[0]["question_id"]) if len(selected) == 1 else None
            ),
            "question_ids": [str(case["question_id"]) for case in selected],
            "case_root": (
                str(case_root(args.artifact_root, str(selected[0]["question_id"])))
                if len(selected) == 1
                else None
            ),
            "questions": len(selected),
            "results": result_count,
            "top_k": args.top_k,
            "candidate_count": args.candidate_count,
            "similarity_threshold": args.similarity_threshold,
            "vector_similarity_weight": args.vector_similarity_weight,
            "rerank_id": args.rerank_id,
            "use_kg": args.use_kg,
            "max_concurrent": args.max_concurrent,
            "base_url": args.base_url.rstrip("/"),
            "source_turn_mapping": "uploaded_document_normalized_character_spans_v1",
            "top_k_semantics": "vector_chunks_excluding_graph_items",
            "protocol": "one_ragflow_sdk_retrieve_per_question_case",
        },
    )


def _validate_resume(
    output_dir: Path,
    args: argparse.Namespace,
    source_sha256: str,
    selected: list[dict[str, Any]],
) -> None:
    if not args.resume:
        return
    run_path = output_dir / "run.json"
    if not run_path.is_file():
        return
    run = json.loads(run_path.read_text(encoding="utf-8"))
    expected = {
        "source_sha256": source_sha256,
        "question_ids": [str(case["question_id"]) for case in selected],
        "questions": len(selected),
        "top_k": args.top_k,
        "candidate_count": args.candidate_count,
        "similarity_threshold": args.similarity_threshold,
        "vector_similarity_weight": args.vector_similarity_weight,
        "rerank_id": args.rerank_id,
        "use_kg": args.use_kg,
        "base_url": args.base_url.rstrip("/"),
        "source_turn_mapping": "uploaded_document_normalized_character_spans_v1",
        "top_k_semantics": "vector_chunks_excluding_graph_items",
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
    try:
        cli = parse_args(argv)
        experiment = load_ragflow_ask_experiment(cli.config)
        args = _runtime_options(experiment, case_id=cli.case_id)
    except (OSError, TypeError, ValueError, OmegaConfBaseException) as exc:
        print(f"error: invalid experiment configuration: {exc}", file=sys.stderr)
        return 2
    try:
        source, cases = load_cases(experiment.source)
        selected = select_entries(cases, experiment.selection)
        if cli.case_id is not None:
            selected = [
                case for case in selected if str(case["question_id"]) == cli.case_id
            ]
            if len(selected) != 1:
                raise ValueError(f"case is not selected: {cli.case_id}")
        source_sha256 = source_fingerprint(source)
        output_dir = _resolve_output_dir(args, selected)
        if cli.dry_run:
            print(
                f"RAGFlow questions: {len(selected)}; "
                f"concurrency={args.max_concurrent}; use_kg={args.use_kg}; "
                f"vector_top_k={args.top_k}; output={output_dir}",
                flush=True,
            )
            return 0
        states = _validate_states(args, source_sha256, selected)
        _validate_resume(output_dir, args, source_sha256, selected)
        client = RagflowEvaluationClient(
            os.environ.get("RAGFLOW_API_KEY", ""), args.base_url
        )
    except (OSError, TypeError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)
    results_path = output_dir / "results.jsonl"
    if not args.resume:
        atomic_write_jsonl(results_path, [])
    completed = _load_completed(results_path) if args.resume else {}
    _write_run(
        output_dir,
        args=args,
        source=source,
        source_sha256=source_sha256,
        selected=selected,
        result_count=len(completed),
        status="running",
    )
    print(
        f"RAGFlow questions: {len(selected)}; concurrency={args.max_concurrent}; "
        f"use_kg={args.use_kg}",
        flush=True,
    )
    futures: dict[Future[dict[str, Any]], str] = {}
    with ThreadPoolExecutor(
        max_workers=min(args.max_concurrent, len(selected)),
        thread_name_prefix="longmemeval-ragflow-ask",
    ) as executor:
        for case in selected:
            question_id = str(case["question_id"])
            if question_id in completed:
                continue
            futures[
                executor.submit(
                    _ask_one,
                    client,
                    case,
                    states[question_id],
                    args,
                    output_dir,
                )
            ] = question_id
        since_checkpoint = 0
        for future in as_completed(futures):
            result = future.result()
            completed[str(result["question_id"])] = result
            since_checkpoint += 1
            if result["status"] != "completed":
                print(
                    f"FAILED {result['question_id']}: {result['error']}",
                    file=sys.stderr,
                )
            if since_checkpoint >= args.checkpoint_every:
                atomic_write_jsonl(results_path, _ordered(selected, completed))
                print(f"completed {len(completed)}/{len(selected)}", flush=True)
                since_checkpoint = 0

    ordered = _ordered(selected, completed)
    atomic_write_jsonl(results_path, ordered)
    failures = sum(row["status"] != "completed" for row in ordered)
    status = (
        "complete" if len(ordered) == len(selected) and failures == 0 else "incomplete"
    )
    _write_run(
        output_dir,
        args=args,
        source=source,
        source_sha256=source_sha256,
        selected=selected,
        result_count=len(ordered),
        status=status,
    )
    print(f"Results: {output_dir}", flush=True)
    return 0 if status == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
