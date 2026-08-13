"""LoCoMo case selection for the shared Codex harness."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from kl_graph.evaluation.agentic.codex.harness import (
    HarnessOptions as AgenticHarnessOptions,
)
from kl_graph.evaluation.agentic.codex.harness import (
    run_agents as run_agentic_cases,
)
from kl_graph.evaluation.agentic.codex.models import AgentCase, AgentResult
from kl_graph.evaluation.agentic.codex.runtime import RuntimeOptions
from kl_graph.evaluation.io import json_lines
from kl_graph.evaluation.locomo.cases import (
    case_set_fingerprint,
    load_case_entries,
    resolve_case_root,
)


@dataclass(frozen=True, slots=True)
class HarnessOptions:
    dataset_dir: Path
    output_dir: Path
    category: int | None
    question_id: str | None
    limit: int | None
    max_concurrent: int
    runtime_workers: int
    checkpoint_every: int
    resume: bool


async def run_agents(
    harness: HarnessOptions, runtime_options: RuntimeOptions
) -> list[AgentResult]:
    """Load LoCoMo cases, then delegate execution to the shared harness."""
    rows = load_questions(harness.dataset_dir, category=harness.category)
    if harness.question_id:
        rows = [row for row in rows if row["id"] == harness.question_id]
    if harness.limit is not None:
        rows = rows[: harness.limit]
    if not rows:
        raise ValueError("no LoCoMo questions matched the requested filters")

    cases = [
        AgentCase(
            id=row["id"],
            question=row["question"],
            scope_id=row["conversation_id"],
            metadata={
                "benchmark": "locomo",
                "category": int(row["category"]),
                "sample_id": row["sample_id"],
                "conversation_id": row["conversation_id"],
            },
        )
        for row in rows
    ]
    shared_options = AgenticHarnessOptions(
        output_dir=harness.output_dir,
        max_concurrent=harness.max_concurrent,
        runtime_workers=harness.runtime_workers,
        checkpoint_every=harness.checkpoint_every,
        resume=harness.resume,
        run_metadata={
            "benchmark": "locomo",
            "dataset": str(harness.dataset_dir),
            "case_set_fingerprint": case_set_fingerprint(harness.dataset_dir),
            "category": harness.category,
            "question_id": harness.question_id,
            "limit": harness.limit,
        },
    )
    return await run_agentic_cases(cases, shared_options, runtime_options)


def load_questions(
    dataset_dir: Path, category: int | None = None
) -> list[dict[str, object]]:
    root, cases = load_case_entries(dataset_dir)
    rows: list[dict[str, object]] = []
    for case in cases:
        conversation_id = str(case["conversation_id"])
        for raw in json_lines(resolve_case_root(root, case) / "evaluation.jsonl"):
            data = raw.get("data") or {}
            if not isinstance(data, dict):
                continue
            row: dict[str, object] = {
                "id": str(raw.get("id") or ""),
                "sample_id": str(raw.get("sample_id") or ""),
                "conversation_id": conversation_id,
                "question": str(data.get("question") or ""),
                "category": int(data["category"]),
            }
            if category is None or row["category"] == category:
                rows.append(row)
    if len({str(row["id"]) for row in rows}) != len(rows):
        raise ValueError("evaluation rows must have unique ids")
    return rows
