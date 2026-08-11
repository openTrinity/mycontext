"""Join blind Codex outputs with Gold and run LoCoMo scoring."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from kl_graph.evaluation.agentic.codex.models import AgentResult
from kl_graph.evaluation.io import (
    atomic_write_json,
    atomic_write_jsonl,
    json_lines,
)
from kl_graph.evaluation.locomo.build import (
    load_case_entries,
    resolve_case_root,
)
from kl_graph.evaluation.locomo.metrics.benchmark import (
    CATEGORY_NAMES,
    evaluate_answers,
    retrieval_scores,
)
from kl_graph.evaluation.locomo.metrics.evidence import (
    ConversationEvidenceResolver,
    citation_references,
    transcript_references,
)


def evaluate_agentic_results(
    dataset_dir: Path,
    output_dir: Path,
    results: list[AgentResult],
    retrieval_k: int,
    graph_data_dirs: dict[str, Path],
) -> dict[str, Any]:
    """Score answers, observed evidence, and Agent-selected citations.

    Agentic evidence metric contract
    ----------------------------------
    Primary Recall (reported as ``global_evidence_recall`` for compatibility):
        |Gold dia_ids intersect final Codex citation dia_ids| / |Gold dia_ids|.
        It uses only citations in the Agent's schema-constrained final output;
        transcript observations and ``retrieval_k`` do not affect this metric.

    ``raw_observed_evidence_recall``:
        The same formula using every distinct source message returned by every
        KL CLI call in the turn. This is diagnostic and is not primary Recall.

    ``first_observation_recall@k`` and ``first_observation_mrr@k``:
        Retrieval diagnostics over the first k distinct source chunks in
        cross-command first-observation order. Every original message inside a
        conversation-slice chunk shares that chunk's observation rank. MRR is
        1/rank for the first Gold-containing chunk, or zero when no Gold
        evidence occurs in the first k observed chunks.

    ``citation_precision``:
        Gold-matching final citations / all resolved final citations.

    The shared LoCoMo scorer defines Recall as 1.0 when Gold evidence is empty.
    """
    if retrieval_k < 1:
        raise ValueError("retrieval_k must be positive")
    gold_by_id = {row["id"]: row for row in _load_gold(dataset_dir)}
    resolver = ConversationEvidenceResolver(
        graph_data_dirs=graph_data_dirs,
        dia_id_by_message=_load_dia_id_map(dataset_dir),
    )
    answer_rows = []
    try:
        for result in results:
            gold = gold_by_id.get(result.id)
            if gold is None:
                raise ValueError(
                    f"result ID is not present in LoCoMo Gold: {result.id}"
                )
            transcript_path = output_dir / str(result.transcript_path or "")
            raw_records = resolver.resolve(
                transcript_references(transcript_path), gold["conversation_id"]
            )
            selected_records = resolver.resolve(
                citation_references(result.citations), gold["conversation_id"]
            )
            answer_rows.append(
                {
                    **gold,
                    "retrieval_mode": "codex_agentic",
                    "generated_answer": result.answer,
                    "generator_model": result.model,
                    "agent_status": result.status,
                    "agent_thread_id": result.thread_id,
                    "agent_turn_id": result.turn_id,
                    "agent_duration_ms": result.duration_ms,
                    "agent_usage": result.usage,
                    "agent_error": result.error,
                    "kl_calls": result.kl_calls,
                    "denied_kl_calls": result.denied_kl_calls,
                    "max_kl_calls": result.max_kl_calls,
                    "transcript_path": result.transcript_path,
                    "raw_retrieved_evidence": raw_records,
                    "raw_retrieved_source_message_ids": [
                        record["source_message_id"] for record in raw_records
                    ],
                    "raw_retrieved_dia_ids": [
                        record["dia_id"]
                        for record in raw_records
                        if record.get("dia_id")
                    ],
                    "selected_evidence": selected_records,
                    "selected_source_message_ids": [
                        record["source_message_id"] for record in selected_records
                    ],
                    "selected_dia_ids": [
                        record["dia_id"]
                        for record in selected_records
                        if record.get("dia_id")
                    ],
                    # The existing evaluator reads these compatibility fields as
                    # its primary Recall. For agentic runs, primary Recall is the
                    # evidence explicitly selected in the final Codex citations.
                    "global_source_message_ids": [
                        record["source_message_id"] for record in selected_records
                    ],
                    "global_dia_ids": [
                        record["dia_id"]
                        for record in selected_records
                        if record.get("dia_id")
                    ],
                }
            )
    finally:
        resolver.close()

    answers_path = output_dir / "answers.jsonl"
    scored_path = output_dir / "scored.jsonl"
    metrics_path = output_dir / "metrics.json"
    atomic_write_jsonl(answers_path, answer_rows)
    report = evaluate_answers(answers_path, metrics_path, scored_path)

    scored_rows = _read_jsonl(scored_path)
    enriched = [_enrich_row(row, retrieval_k) for row in scored_rows]
    atomic_write_jsonl(scored_path, enriched)
    _augment_report(report, enriched, retrieval_k)
    atomic_write_json(metrics_path, report)
    return report


def _enrich_row(row: dict[str, Any], retrieval_k: int) -> dict[str, Any]:
    # Keep the three evidence sets separate. In particular, never substitute
    # raw transcript observations for final citations in the primary Recall.
    evidence = [str(value) for value in row.get("evidence") or []]
    raw_dia = [str(value) for value in row.get("raw_retrieved_dia_ids") or []]
    selected_dia = [str(value) for value in row.get("selected_dia_ids") or []]
    selected_records = row.get("selected_evidence") or []
    first_observation_records = [
        record
        for index, record in enumerate(row.get("raw_retrieved_evidence") or [], 1)
        if int(record.get("observation_rank") or index) <= retrieval_k
    ]
    first_observation_dia = [
        str(record["dia_id"])
        for record in first_observation_records
        if record.get("dia_id")
    ]
    raw_recall, raw_complete = retrieval_scores(evidence, raw_dia)
    selected_recall, selected_complete = retrieval_scores(evidence, selected_dia)
    first_recall, first_complete = retrieval_scores(evidence, first_observation_dia)
    selected_hits = len(set(evidence) & set(selected_dia))
    citation_precision = (
        selected_hits / len(selected_records) if selected_records else None
    )
    mrr = _first_observation_mrr(
        evidence, row.get("raw_retrieved_evidence") or [], retrieval_k
    )
    return {
        **row,
        "raw_observed_evidence_recall": raw_recall,
        "raw_observed_complete_evidence_recall": raw_complete,
        "selected_evidence_recall": selected_recall,
        "selected_complete_evidence_recall": selected_complete,
        f"first_observation_recall@{retrieval_k}": first_recall,
        f"first_observation_complete_recall@{retrieval_k}": first_complete,
        "citation_precision": citation_precision,
        f"first_observation_mrr@{retrieval_k}": mrr,
    }


def _first_observation_mrr(
    evidence: list[str], records: list[dict[str, Any]], retrieval_k: int
) -> float | None:
    if not evidence:
        return None
    gold = set(evidence)
    for index, record in enumerate(records, 1):
        rank = int(record.get("observation_rank") or index)
        if rank > retrieval_k:
            continue
        if record.get("dia_id") in gold:
            return 1.0 / rank
    return 0.0


def _augment_report(
    report: dict[str, Any], rows: list[dict[str, Any]], retrieval_k: int
) -> None:
    report["benchmark"] = "LoCoMo QA — Codex agentic KL workflow"
    report["agentic_metric_notes"] = {
        "global_evidence_recall": "Gold evidence covered by the final Codex citations (primary Recall)",
        "raw_observed_evidence_recall": "all distinct source messages observed across KL CLI calls",
        "selected_evidence_recall": "source messages explicitly cited by the Agent",
        f"first_observation_recall@{retrieval_k}": (
            f"Gold evidence in the first {retrieval_k} distinct source chunks "
            "observed across KL CLI calls"
        ),
        f"first_observation_mrr@{retrieval_k}": (
            "reciprocal rank of the first Gold-containing source chunk in "
            "cross-command observation order"
        ),
    }
    report["agentic"] = _aggregate(rows, retrieval_k)
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[int(row["category"])].append(row)
    for category, name in CATEGORY_NAMES.items():
        if name in report.get("by_category", {}):
            report["by_category"][name]["agentic"] = _aggregate(
                grouped.get(category, []), retrieval_k
            )


def _aggregate(rows: list[dict[str, Any]], retrieval_k: int) -> dict[str, Any]:
    key = f"first_observation_mrr@{retrieval_k}"
    recall_key = f"first_observation_recall@{retrieval_k}"
    return {
        "completed_agents": sum(row.get("agent_status") == "completed" for row in rows),
        "failed_agents": sum(row.get("agent_status") != "completed" for row in rows),
        "mean_kl_calls": _mean([float(row.get("kl_calls") or 0) for row in rows]),
        "raw_observed_evidence_recall": _mean(
            [float(row["raw_observed_evidence_recall"]) for row in rows]
        ),
        "selected_evidence_recall": _mean(
            [float(row["selected_evidence_recall"]) for row in rows]
        ),
        "citation_precision": _mean(
            [
                float(row["citation_precision"])
                for row in rows
                if row.get("citation_precision") is not None
            ]
        ),
        recall_key: _mean([float(row[recall_key]) for row in rows]),
        key: _mean([float(row[key]) for row in rows if row.get(key) is not None]),
    }


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return list(json_lines(path))


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
