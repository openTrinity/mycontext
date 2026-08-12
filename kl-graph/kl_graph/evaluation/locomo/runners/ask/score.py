"""Score LoCoMo production-ask retrieval and optional generated answers.

This stage is evaluation-only. It never starts KL, performs retrieval, or calls
an answer model. Gold data and evidence resolution enter the pipeline here.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl, json_lines
from kl_graph.evaluation.locomo.build import (
    case_set_fingerprint,
    cases_by_conversation,
    graph_data_dirs,
    load_case_entries,
    resolve_case_root,
)
from kl_graph.evaluation.locomo.metrics.benchmark import (
    CATEGORY_NAMES,
    retrieval_scores,
    score_answer_rows,
)
from kl_graph.evaluation.locomo.metrics.evidence import (
    ConversationEvidenceResolver,
    ask_response_references,
)

DEFAULT_RECALL_K = 5


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Score a completed LoCoMo production kl ask run."
    )
    parser.add_argument("--ask-dir", type=Path, required=True)
    parser.add_argument("--answers-dir", type=Path, default=None)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help=(
            "override the default case-local "
            "benchmark/locomo-score/CATEGORY/RUN_TIME directory"
        ),
    )
    parser.add_argument("--recall-k", type=int, default=DEFAULT_RECALL_K)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)
    if args.recall_k < 1:
        parser.error("--recall-k must be positive")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    ask_dir = args.ask_dir.expanduser().resolve()
    answers_dir = args.answers_dir.expanduser().resolve() if args.answers_dir else None
    ask_run = _load_json(ask_dir / "run.json")
    dataset_dir = Path(str(ask_run["dataset"])).expanduser().resolve()
    output_dir = _resolve_output_dir(args, dataset_dir, ask_run)
    if output_dir == ask_dir or output_dir == answers_dir:
        raise ValueError("--output-dir must differ from input run directories")
    fingerprint = case_set_fingerprint(dataset_dir)
    if ask_run.get("case_set_fingerprint") != fingerprint:
        raise ValueError("ask run case set has changed on disk")
    if int(ask_run.get("top_k") or 0) < args.recall_k:
        raise ValueError(
            f"ask run Top-{ask_run.get('top_k')} cannot be scored at "
            f"Recall@{args.recall_k}"
        )
    results_path = ask_dir / "results.jsonl"
    if not results_path.is_file():
        raise FileNotFoundError(results_path)
    _prepare_output_dir(output_dir, args.overwrite)

    results = list(json_lines(results_path))
    retrieval_rows = _resolve_retrieval(
        ask_dir,
        results,
        dataset_dir,
        args.recall_k,
    )
    retrieval_scored = [
        _score_retrieval_row(row, args.recall_k) for row in retrieval_rows
    ]
    retrieval_report = _retrieval_report(
        retrieval_scored,
        ask_run,
        args.recall_k,
    )
    atomic_write_jsonl(output_dir / "retrieval.jsonl", retrieval_rows)

    if answers_dir is None:
        scored_rows = retrieval_scored
        report = retrieval_report
    else:
        answer_rows, answer_run = _load_answers(
            answers_dir,
            ask_dir,
            fingerprint,
            args.recall_k,
        )
        combined = _join_answers(
            retrieval_rows,
            answer_rows,
            args.recall_k,
        )
        scored_rows, report = score_answer_rows(combined)
        report["retrieval"] = retrieval_report
        report["answer_run"] = {
            "directory": str(answers_dir),
            "model": answer_run.get("model"),
        }

    atomic_write_jsonl(output_dir / "scored.jsonl", scored_rows)
    atomic_write_json(output_dir / "metrics.json", report)
    atomic_write_json(
        output_dir / "run.json",
        {
            "status": "complete",
            "completed_at": datetime.now().astimezone().isoformat(),
            "ask_dir": str(ask_dir),
            "answers_dir": str(answers_dir) if answers_dir else None,
            "dataset": str(dataset_dir),
            "case_set_fingerprint": fingerprint,
            "questions": len(retrieval_rows),
            "recall_k": args.recall_k,
            "metrics_path": "metrics.json",
        },
    )
    print(json.dumps(report.get("overall") or {}, ensure_ascii=False, sort_keys=True))
    print(f"Results: {output_dir}")
    return 0


def _resolve_output_dir(
    args: argparse.Namespace,
    dataset_dir: Path,
    ask_run: dict[str, Any],
) -> Path:
    if args.output_dir is not None:
        return args.output_dir.expanduser().resolve()
    conversation_id = str(ask_run.get("conversation") or "").strip()
    if not conversation_id:
        raise ValueError("ask run must select exactly one conversation")
    case = cases_by_conversation(dataset_dir).get(conversation_id)
    if case is None:
        raise ValueError(f"unknown LoCoMo conversation: {conversation_id}")
    category = ask_run.get("category")
    category_name = f"category-{int(category)}" if category is not None else "all"
    root = (
        resolve_case_root(dataset_dir, case)
        / "benchmark"
        / "locomo-score"
        / category_name
    )
    run_id = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    candidate = root / run_id
    suffix = 1
    while candidate.exists():
        candidate = root / f"{run_id}-{suffix:02d}"
        suffix += 1
    return candidate


def _prepare_output_dir(output_dir: Path, overwrite: bool) -> None:
    if output_dir.exists() and any(output_dir.iterdir()) and not overwrite:
        raise FileExistsError(
            f"output directory is not empty: {output_dir}; pass --overwrite"
        )
    output_dir.mkdir(parents=True, exist_ok=True)


def _resolve_retrieval(
    ask_dir: Path,
    results: list[dict[str, Any]],
    dataset_dir: Path,
    recall_k: int,
) -> list[dict[str, Any]]:
    gold_by_id = {row["id"]: row for row in _load_gold(dataset_dir)}
    resolver = ConversationEvidenceResolver(
        graph_data_dirs=graph_data_dirs(dataset_dir),
        dia_id_by_message=_load_dia_id_map(dataset_dir),
    )
    rows: list[dict[str, Any]] = []
    try:
        for result in results:
            gold = gold_by_id.get(str(result.get("id") or ""))
            if gold is None:
                raise ValueError(
                    f"result ID is not present in LoCoMo Gold: {result.get('id')}"
                )
            response = _load_response(ask_dir, result)
            conversation_id = gold["conversation_id"]
            item_references = ask_response_references(
                response,
                include_items=True,
                include_graph=False,
            )
            item_at_k_references = ask_response_references(
                _item_prefix(response, recall_k),
                include_items=True,
                include_graph=False,
            )
            graph_references = ask_response_references(
                response,
                include_items=False,
                include_graph=True,
            )
            ask_references = ask_response_references(response)
            items = resolver.resolve(
                item_references,
                conversation_id,
            )
            items_at_k = resolver.resolve(
                item_at_k_references,
                conversation_id,
            )
            graph = resolver.resolve(
                graph_references,
                conversation_id,
            )
            ask = resolver.resolve(
                ask_references,
                conversation_id,
            )
            # Keep the former Fact -> source chunk -> every member expansion as
            # an explicitly named comparison metric during the transition to
            # exact source-unit evidence.
            legacy_items = resolver.resolve(
                item_references,
                conversation_id,
                fact_resolution="chunk_members",
            )
            legacy_items_at_k = resolver.resolve(
                item_at_k_references,
                conversation_id,
                fact_resolution="chunk_members",
            )
            legacy_graph = resolver.resolve(
                graph_references,
                conversation_id,
                fact_resolution="chunk_members",
            )
            legacy_ask = resolver.resolve(
                ask_references,
                conversation_id,
                fact_resolution="chunk_members",
            )
            rows.append(
                {
                    **gold,
                    **result,
                    "retrieval_mode": "single_production_kl_ask",
                    "item_evidence": items,
                    "item_dia_ids": _dia_ids(items),
                    f"item_evidence_at_{recall_k}": items_at_k,
                    f"item_dia_ids_at_{recall_k}": _dia_ids(items_at_k),
                    "graph_evidence": graph,
                    "graph_dia_ids": _dia_ids(graph),
                    "ask_evidence": ask,
                    "ask_dia_ids": _dia_ids(ask),
                    "legacy_chunk_expanded_item_evidence": legacy_items,
                    "legacy_chunk_expanded_item_dia_ids": _dia_ids(legacy_items),
                    (
                        f"legacy_chunk_expanded_item_evidence_at_{recall_k}"
                    ): legacy_items_at_k,
                    (f"legacy_chunk_expanded_item_dia_ids_at_{recall_k}"): _dia_ids(
                        legacy_items_at_k
                    ),
                    "legacy_chunk_expanded_graph_evidence": legacy_graph,
                    "legacy_chunk_expanded_graph_dia_ids": _dia_ids(legacy_graph),
                    "legacy_chunk_expanded_ask_evidence": legacy_ask,
                    "legacy_chunk_expanded_ask_dia_ids": _dia_ids(legacy_ask),
                }
            )
    finally:
        resolver.close()
    return rows


def _load_gold(dataset_dir: Path) -> list[dict[str, Any]]:
    root, cases = load_case_entries(dataset_dir)
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
                    "ground_truth": data.get("answer"),
                    "evidence": [str(value) for value in data.get("evidence") or []],
                    "category": int(data["category"]),
                }
            )
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("evaluation rows must have unique ids")
    return rows


def _load_dia_id_map(dataset_dir: Path) -> dict[str, str]:
    root, cases = load_case_entries(dataset_dir)
    mapping: dict[str, str] = {}
    for case in cases:
        evidence_map = resolve_case_root(root, case) / "evidence_map.jsonl"
        for record in json_lines(evidence_map):
            source_id = str(record.get("source_message_id") or "")
            dia_id = str(record.get("dia_id") or "")
            if source_id and dia_id:
                mapping[source_id] = dia_id
    return mapping


def _load_response(ask_dir: Path, result: dict[str, Any]) -> dict[str, Any]:
    relative = result.get("response_path")
    if result.get("status") != "completed":
        return {}
    if not relative:
        raise ValueError(
            f"completed ask result has no response_path: {result.get('id')}"
        )
    value = _load_json(ask_dir / str(relative))
    return value


def _item_prefix(response: dict[str, Any], recall_k: int) -> dict[str, Any]:
    items = response.get("items") or []
    if not isinstance(items, list):
        raise TypeError("ask response items is not a list")
    return {"items": items[:recall_k]}


def _score_retrieval_row(row: dict[str, Any], recall_k: int) -> dict[str, Any]:
    evidence = [str(value) for value in row.get("evidence") or []]
    ask_recall, ask_complete = retrieval_scores(evidence, row["ask_dia_ids"])
    item_recall, item_complete = retrieval_scores(evidence, row["item_dia_ids"])
    graph_recall, graph_complete = retrieval_scores(evidence, row["graph_dia_ids"])
    item_at_k_recall: float | None = None
    item_at_k_complete: float | None = None
    if evidence:
        item_at_k_recall, item_at_k_complete = retrieval_scores(
            evidence,
            row[f"item_dia_ids_at_{recall_k}"],
        )
    legacy_ask_recall, legacy_ask_complete = retrieval_scores(
        evidence, row["legacy_chunk_expanded_ask_dia_ids"]
    )
    legacy_item_recall, legacy_item_complete = retrieval_scores(
        evidence, row["legacy_chunk_expanded_item_dia_ids"]
    )
    legacy_graph_recall, legacy_graph_complete = retrieval_scores(
        evidence, row["legacy_chunk_expanded_graph_dia_ids"]
    )
    legacy_item_at_k_recall: float | None = None
    legacy_item_at_k_complete: float | None = None
    if evidence:
        legacy_item_at_k_recall, legacy_item_at_k_complete = retrieval_scores(
            evidence,
            row[f"legacy_chunk_expanded_item_dia_ids_at_{recall_k}"],
        )
    return {
        **row,
        "global_evidence_recall": ask_recall,
        "global_complete_evidence_recall": ask_complete,
        "ask_evidence_recall": ask_recall,
        "ask_complete_evidence_recall": ask_complete,
        "item_evidence_recall": item_recall,
        "item_complete_evidence_recall": item_complete,
        f"item_evidence_recall_at_{recall_k}": item_at_k_recall,
        f"item_complete_evidence_recall_at_{recall_k}": item_at_k_complete,
        "graph_evidence_recall": graph_recall,
        "graph_complete_evidence_recall": graph_complete,
        "legacy_chunk_expanded_ask_evidence_recall": legacy_ask_recall,
        "legacy_chunk_expanded_ask_complete_evidence_recall": legacy_ask_complete,
        "legacy_chunk_expanded_item_evidence_recall": legacy_item_recall,
        "legacy_chunk_expanded_item_complete_evidence_recall": (legacy_item_complete),
        f"legacy_chunk_expanded_item_evidence_recall_at_{recall_k}": (
            legacy_item_at_k_recall
        ),
        f"legacy_chunk_expanded_item_complete_evidence_recall_at_{recall_k}": (
            legacy_item_at_k_complete
        ),
        "legacy_chunk_expanded_graph_evidence_recall": legacy_graph_recall,
        "legacy_chunk_expanded_graph_complete_evidence_recall": (legacy_graph_complete),
    }


def _retrieval_report(
    rows: list[dict[str, Any]],
    ask_run: dict[str, Any],
    recall_k: int,
) -> dict[str, Any]:
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[int(row["category"])].append(row)
    return {
        "benchmark": "LoCoMo QA — one production KL ask per question",
        "retrieval_mode": "single_production_kl_ask",
        "metric": f"Gold dia_id evidence Recall@{recall_k}",
        "questions": len(rows),
        "retrieval_unit": "ranked /ask item (conversation-slice chunk)",
        "evidence_unit": "original LoCoMo message dia_id",
        "fact_evidence_resolution": "facts.source_unit_id",
        "comparison_metric": "legacy Fact whole-chunk expansion",
        "parameters": {
            "top_k": ask_run.get("top_k"),
            "recall_k": recall_k,
            "force_phase2": ask_run.get("force_phase2"),
            "models": ask_run.get("models"),
        },
        "protocol": _protocol_summary(rows),
        "overall": _aggregate(rows, recall_k),
        "by_category": {
            CATEGORY_NAMES[category]: {
                "category": category,
                **_aggregate(grouped.get(category, []), recall_k),
            }
            for category in (4, 1, 2, 3, 5)
        },
    }


def _aggregate(rows: list[dict[str, Any]], recall_k: int) -> dict[str, Any]:
    nonempty = [row for row in rows if row.get("evidence")]
    recall_at_k = f"item_evidence_recall_at_{recall_k}"
    complete_at_k = f"item_complete_evidence_recall_at_{recall_k}"
    legacy_recall_at_k = f"legacy_chunk_expanded_item_evidence_recall_at_{recall_k}"
    legacy_complete_at_k = (
        f"legacy_chunk_expanded_item_complete_evidence_recall_at_{recall_k}"
    )
    return {
        "questions": len(rows),
        "questions_with_gold_evidence": len(nonempty),
        "ask_evidence_recall": _mean(
            [float(row["ask_evidence_recall"]) for row in rows]
        ),
        "ask_evidence_recall_nonempty_gold": _mean(
            [float(row["ask_evidence_recall"]) for row in nonempty]
        ),
        "ask_complete_evidence_recall": _mean(
            [float(row["ask_complete_evidence_recall"]) for row in rows]
        ),
        "item_evidence_recall": _mean(
            [float(row["item_evidence_recall"]) for row in rows]
        ),
        "item_complete_evidence_recall": _mean(
            [float(row["item_complete_evidence_recall"]) for row in rows]
        ),
        recall_at_k: _mean([float(row[recall_at_k]) for row in nonempty]),
        complete_at_k: _mean([float(row[complete_at_k]) for row in nonempty]),
        "graph_evidence_recall": _mean(
            [float(row["graph_evidence_recall"]) for row in rows]
        ),
        "graph_complete_evidence_recall": _mean(
            [float(row["graph_complete_evidence_recall"]) for row in rows]
        ),
        "legacy_chunk_expanded_ask_evidence_recall": _mean(
            [float(row["legacy_chunk_expanded_ask_evidence_recall"]) for row in rows]
        ),
        "legacy_chunk_expanded_ask_complete_evidence_recall": _mean(
            [
                float(row["legacy_chunk_expanded_ask_complete_evidence_recall"])
                for row in rows
            ]
        ),
        "legacy_chunk_expanded_item_evidence_recall": _mean(
            [float(row["legacy_chunk_expanded_item_evidence_recall"]) for row in rows]
        ),
        "legacy_chunk_expanded_item_complete_evidence_recall": _mean(
            [
                float(row["legacy_chunk_expanded_item_complete_evidence_recall"])
                for row in rows
            ]
        ),
        legacy_recall_at_k: _mean([float(row[legacy_recall_at_k]) for row in nonempty]),
        legacy_complete_at_k: _mean(
            [float(row[legacy_complete_at_k]) for row in nonempty]
        ),
        "legacy_chunk_expanded_graph_evidence_recall": _mean(
            [float(row["legacy_chunk_expanded_graph_evidence_recall"]) for row in rows]
        ),
        "legacy_chunk_expanded_graph_complete_evidence_recall": _mean(
            [
                float(row["legacy_chunk_expanded_graph_complete_evidence_recall"])
                for row in rows
            ]
        ),
    }


def _protocol_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total_calls = sum(int(row.get("ask_calls") or 0) for row in rows)
    completed = sum(row.get("status") == "completed" for row in rows)
    return {
        "required_asks_per_question": 1,
        "recorded_ask_calls": total_calls,
        "successful_asks": completed,
        "failed_asks": len(rows) - completed,
        "exactly_one_ask_per_result": all(
            int(row.get("ask_calls") or 0) == 1 for row in rows
        ),
        "outer_codex_agent": False,
    }


def _load_answers(
    answers_dir: Path,
    ask_dir: Path,
    fingerprint: str,
    recall_k: int,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    run = _load_json(answers_dir / "run.json")
    source = Path(str(run.get("ask_dir") or run.get("input_dir") or ""))
    if source.expanduser().resolve() != ask_dir:
        raise ValueError(f"answer source {source} does not match ask run {ask_dir}")
    if run.get("case_set_fingerprint") != fingerprint:
        raise ValueError("answer run case set does not match ask run")
    if int(run.get("top_k") or 0) != recall_k:
        raise ValueError(
            f"answer generation Top-{run.get('top_k')} does not match Recall@{recall_k}"
        )
    rows = {
        str(row["id"]): row
        for row in json_lines(answers_dir / "answers.jsonl")
        if row.get("id")
    }
    return rows, run


def _join_answers(
    retrieval_rows: list[dict[str, Any]],
    answers: dict[str, dict[str, Any]],
    recall_k: int,
) -> list[dict[str, Any]]:
    retrieval_ids = {str(row["id"]) for row in retrieval_rows}
    unknown = sorted(set(answers) - retrieval_ids)
    if unknown:
        raise ValueError(f"answer ID is not present in ask run: {unknown[0]}")
    joined = []
    for retrieval in retrieval_rows:
        row_id = str(retrieval["id"])
        answer = answers.get(row_id)
        if answer is None:
            continue
        joined.append(
            {
                **retrieval,
                **answer,
                "retrieval_mode": (f"single_production_kl_ask_items_at_{recall_k}"),
                "generation_top_k": recall_k,
                "global_dia_ids": retrieval[f"item_dia_ids_at_{recall_k}"],
            }
        )
    return joined


def _dia_ids(records: list[dict[str, Any]]) -> list[str]:
    return [str(record["dia_id"]) for record in records if record.get("dia_id")]


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"JSON artifact is not an object: {path}")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
