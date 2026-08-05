"""Join blind Agent outputs with Gold and run LoCoMo scoring."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from kl_graph.data.locomo import load_dia_id_map, load_evaluation

from .locomo_scoring import (
    CATEGORY_NAMES,
    evaluate_answers,
    retrieval_scores,
)

from .artifacts import atomic_write_json, atomic_write_jsonl
from .evidence import EvidenceResolver, citation_references, transcript_references
from .models import AgentResult


def evaluate_agentic_results(
    dataset_dir: Path,
    output_dir: Path,
    results: list[AgentResult],
    retrieval_k: int,
    sqlite_path: Path | None = None,
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
        Retrieval diagnostics over the first k distinct source messages in
        cross-command first-observation order. MRR is 1/rank for the first Gold
        hit, or zero when no Gold evidence occurs in the first k observations.

    ``citation_precision``:
        Gold-matching final citations / all resolved final citations.

    The shared LoCoMo scorer defines Recall as 1.0 when Gold evidence is empty.
    """
    if retrieval_k < 1:
        raise ValueError("retrieval_k must be positive")
    gold_by_id = {row["id"]: row for row in load_evaluation(dataset_dir)}
    resolver = EvidenceResolver(
        sqlite_path=sqlite_path or _sqlite_path(),
        dia_id_by_message=load_dia_id_map(dataset_dir),
    )
    answer_rows = []
    try:
        for result in results:
            gold = gold_by_id.get(result.id)
            if gold is None:
                raise ValueError(f"result ID is not present in LoCoMo Gold: {result.id}")
            transcript_path = output_dir / str(result.transcript_path or "")
            raw_records = resolver.resolve(
                transcript_references(transcript_path), gold["conversation_id"]
            )
            selected_records = resolver.resolve(
                citation_references(result.citations), gold["conversation_id"]
            )
            answer_rows.append({
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
                    record["dia_id"] for record in raw_records if record.get("dia_id")
                ],
                "selected_evidence": selected_records,
                "selected_source_message_ids": [
                    record["source_message_id"] for record in selected_records
                ],
                "selected_dia_ids": [
                    record["dia_id"] for record in selected_records if record.get("dia_id")
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
            })
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


def _sqlite_path() -> Path:
    # Import at scoring time so CLI-loaded environment variables remain the
    # single configuration source for the graph runtime.
    from kl_graph.config import SQLITE_PATH

    return SQLITE_PATH


def _enrich_row(row: dict[str, Any], retrieval_k: int) -> dict[str, Any]:
    # Keep the three evidence sets separate. In particular, never substitute
    # raw transcript observations for final citations in the primary Recall.
    evidence = [str(value) for value in row.get("evidence") or []]
    raw_dia = [str(value) for value in row.get("raw_retrieved_dia_ids") or []]
    selected_dia = [str(value) for value in row.get("selected_dia_ids") or []]
    selected_records = row.get("selected_evidence") or []
    first_observation_dia = [
        str(record["dia_id"])
        for record in (row.get("raw_retrieved_evidence") or [])[:retrieval_k]
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
    for rank, record in enumerate(records[:retrieval_k], 1):
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
        f"first_observation_recall@{retrieval_k}": f"Gold evidence in the first {retrieval_k} distinct source messages observed across KL CLI calls",
        f"first_observation_mrr@{retrieval_k}": "reciprocal rank of the first Gold message in cross-command observation order",
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
        "raw_observed_evidence_recall": _mean([
            float(row["raw_observed_evidence_recall"]) for row in rows
        ]),
        "selected_evidence_recall": _mean([
            float(row["selected_evidence_recall"]) for row in rows
        ]),
        "citation_precision": _mean([
            float(row["citation_precision"])
            for row in rows if row.get("citation_precision") is not None
        ]),
        recall_key: _mean([float(row[recall_key]) for row in rows]),
        key: _mean([
            float(row[key]) for row in rows if row.get(key) is not None
        ]),
    }


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    import json

    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows
