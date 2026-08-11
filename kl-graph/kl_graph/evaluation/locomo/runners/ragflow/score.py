"""Score retrieval and generated answers from a RAGFlow LoCoMo run."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl, json_lines
from kl_graph.evaluation.locomo.metrics.benchmark import (
    CATEGORY_NAMES,
    retrieval_scores,
    score_answer_rows,
)

from .source import load_samples, question_rows, source_fingerprint


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ask-dir", type=Path, required=True)
    parser.add_argument("--answers-dir", type=Path, default=None)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--recall-k", type=int, default=5)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)
    if args.recall_k < 1:
        parser.error("--recall-k must be positive")
    return args


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"JSON artifact is not an object: {path}")
    return value


def _load_response(ask_dir: Path, result: dict[str, Any]) -> dict[str, Any]:
    if result.get("status") != "completed":
        return {"items": []}
    path = ask_dir / str(result.get("response_path") or "")
    return _load_json(path)


def _dia_ids(items: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for item in items:
        for value in item.get("dia_ids") or []:
            value = str(value)
            if value and value not in seen:
                seen.add(value)
                values.append(value)
    return values


def _retrieval_row(
    gold: dict[str, Any],
    result: dict[str, Any],
    response: dict[str, Any],
    recall_k: int,
) -> dict[str, Any]:
    items = response.get("items") or []
    if not isinstance(items, list):
        raise TypeError(f"response items is not a list: {gold['id']}")
    items = [item for item in items[:recall_k] if isinstance(item, dict)]
    graph_items = [item for item in items if item.get("type") == "graph"]
    vector_items = [item for item in items if item.get("type") != "graph"]
    all_ids = _dia_ids(items)
    graph_ids = _dia_ids(graph_items)
    vector_ids = _dia_ids(vector_items)
    all_recall, all_complete = retrieval_scores(gold["evidence"], all_ids)
    graph_recall, graph_complete = retrieval_scores(gold["evidence"], graph_ids)
    vector_recall, vector_complete = retrieval_scores(gold["evidence"], vector_ids)
    return {
        **gold,
        **result,
        "retrieval_mode": (
            "ragflow_graph" if result.get("use_kg") else "ragflow_vector"
        ),
        "global_dia_ids": all_ids,
        "graph_dia_ids": graph_ids,
        "vector_dia_ids": vector_ids,
        "global_evidence_recall": all_recall,
        "global_complete_evidence_recall": all_complete,
        "graph_evidence_recall": graph_recall,
        "graph_complete_evidence_recall": graph_complete,
        "vector_evidence_recall": vector_recall,
        "vector_complete_evidence_recall": vector_complete,
    }


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _retrieval_report(
    rows: list[dict[str, Any]], run: dict[str, Any], recall_k: int
) -> dict[str, Any]:
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[int(row["category"])].append(row)

    def aggregate(values: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "questions": len(values),
            "global_evidence_recall": _mean(
                [float(row["global_evidence_recall"]) for row in values]
            ),
            "global_complete_evidence_recall": _mean(
                [float(row["global_complete_evidence_recall"]) for row in values]
            ),
            "graph_evidence_recall": _mean(
                [float(row["graph_evidence_recall"]) for row in values]
            ),
            "vector_evidence_recall": _mean(
                [float(row["vector_evidence_recall"]) for row in values]
            ),
        }

    return {
        "benchmark": "LoCoMo QA — RAGFlow SDK retrieval",
        "backend": "ragflow",
        "retrieval_mode": "graph" if run.get("use_kg") else "vector",
        "metric": f"Gold dia_id evidence Recall@{recall_k}",
        "questions": len(rows),
        "parameters": {
            "top_k": run.get("top_k"),
            "candidate_count": run.get("candidate_count"),
            "rerank_id": run.get("rerank_id"),
            "use_kg": run.get("use_kg"),
        },
        "overall": aggregate(rows),
        "by_category": {
            CATEGORY_NAMES[category]: {
                "category": category,
                **aggregate(grouped.get(category, [])),
            }
            for category in (4, 1, 2, 3, 5)
        },
    }


def _resolve_output_dir(
    args: argparse.Namespace, run: dict[str, Any]
) -> Path:
    if args.output_dir is not None:
        return args.output_dir.expanduser().resolve()
    case = run.get("case_root")
    root = (
        Path(str(case))
        if case
        else Path(str(run["artifact_root"])).expanduser().resolve()
    )
    category = run.get("category")
    category_name = f"category-{category}" if category else "all"
    mode = "graph" if run.get("use_kg") else "vector"
    root = root / "benchmark" / "locomo-ragflow-score" / mode / category_name
    run_id = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    candidate = root / run_id
    suffix = 1
    while candidate.exists():
        candidate = root / f"{run_id}-{suffix:02d}"
        suffix += 1
    return candidate


def _load_answers(
    answers_dir: Path, ask_dir: Path
) -> dict[str, dict[str, Any]]:
    run = _load_json(answers_dir / "run.json")
    recorded = Path(str(run.get("ask_dir") or "")).expanduser().resolve()
    if recorded != ask_dir:
        raise ValueError("answer run does not belong to this RAGFlow ask run")
    return {
        str(row["id"]): row
        for row in json_lines(answers_dir / "answers.jsonl")
        if row.get("generation_status") == "completed"
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    ask_dir = args.ask_dir.expanduser().resolve()
    run = _load_json(ask_dir / "run.json")
    if run.get("backend") != "ragflow" or run.get("benchmark") != "locomo":
        raise ValueError("--ask-dir is not a RAGFlow LoCoMo run")
    if args.recall_k > int(run.get("top_k") or 0):
        raise ValueError("--recall-k exceeds the persisted ask Top-K")
    source = Path(str(run["source"])).expanduser().resolve()
    if source_fingerprint(source) != run.get("source_sha256"):
        raise ValueError("native LoCoMo source changed after the ask run")
    _, samples = load_samples(source)
    selected_ids = set(run.get("conversations") or [])
    gold = {
        row["id"]: row
        for row in question_rows(
            [sample for sample in samples if sample["sample_id"] in selected_ids]
        )
    }
    results = list(json_lines(ask_dir / "results.jsonl"))
    retrieval_rows = []
    for result in results:
        row_id = str(result.get("id") or "")
        if row_id not in gold:
            raise ValueError(f"unknown native LoCoMo question ID: {row_id}")
        retrieval_rows.append(
            _retrieval_row(
                gold[row_id],
                result,
                _load_response(ask_dir, result),
                args.recall_k,
            )
        )

    retrieval_report = _retrieval_report(retrieval_rows, run, args.recall_k)
    output_dir = _resolve_output_dir(args, run)
    if output_dir.exists() and any(output_dir.iterdir()) and not args.overwrite:
        raise FileExistsError(
            f"output directory is not empty: {output_dir}; pass --overwrite"
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_jsonl(output_dir / "retrieval.jsonl", retrieval_rows)

    if args.answers_dir is None:
        scored_rows = retrieval_rows
        report = retrieval_report
    else:
        answers_dir = args.answers_dir.expanduser().resolve()
        answers = _load_answers(answers_dir, ask_dir)
        joined = [
            {**row, **answers[str(row["id"])]}
            for row in retrieval_rows
            if str(row["id"]) in answers
        ]
        scored_rows, report = score_answer_rows(joined)
        report["retrieval"] = retrieval_report
        report["backend"] = "ragflow"

    atomic_write_jsonl(output_dir / "scored.jsonl", scored_rows)
    atomic_write_json(output_dir / "metrics.json", report)
    atomic_write_json(
        output_dir / "run.json",
        {
            "status": "complete",
            "backend": "ragflow",
            "ask_dir": str(ask_dir),
            "answers_dir": (
                str(args.answers_dir.expanduser().resolve())
                if args.answers_dir
                else None
            ),
            "source": str(source),
            "source_sha256": run["source_sha256"],
            "questions": len(scored_rows),
            "recall_k": args.recall_k,
        },
    )
    print(json.dumps(report.get("overall") or {}, ensure_ascii=False))
    print(f"Results: {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
