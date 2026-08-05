"""Batch orchestration for blind, independent Codex LoCoMo agents."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from kl_graph.data.locomo import json_lines, load_evaluation

from .artifacts import atomic_write_json, atomic_write_jsonl
from .codex_runtime import CodexRuntimePool, RuntimeOptions
from .models import AgentCase, AgentResult, Citation


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
    harness: HarnessOptions,
    runtime_options: RuntimeOptions,
) -> list[AgentResult]:
    """Run all selected Agent threads and return only after every task stops."""
    rows = load_evaluation(harness.dataset_dir, category=harness.category)
    if harness.question_id:
        rows = [row for row in rows if row["id"] == harness.question_id]
    if harness.limit is not None:
        rows = rows[:harness.limit]
    if not rows:
        raise ValueError("no LoCoMo questions matched the requested filters")

    results_path = harness.output_dir / "results.jsonl"
    completed = _load_completed(results_path) if harness.resume else {}
    run_path = harness.output_dir / "run.json"
    started_at = datetime.now().astimezone().isoformat()
    atomic_write_json(run_path, {
        "status": "running",
        "run_id": harness.output_dir.name,
        "started_at": started_at,
        "dataset": str(harness.dataset_dir),
        "category": harness.category,
        "question_id": harness.question_id,
        "limit": harness.limit,
        "questions": len(rows),
        "max_concurrent": harness.max_concurrent,
        "runtime_workers": harness.runtime_workers,
        "model": runtime_options.model,
        "reasoning_effort": runtime_options.reasoning_effort,
        "max_kl_calls": runtime_options.max_kl_calls,
        "skill_path": str(runtime_options.skill_path),
        "codex_config": str(runtime_options.codex_config_path),
        "codex_home_isolated": True,
    })

    semaphore = asyncio.Semaphore(harness.max_concurrent)

    async with CodexRuntimePool(
        runtime_options, workers=harness.runtime_workers
    ) as runtimes:
        pending: list[asyncio.Task[AgentResult]] = []
        for index, row in enumerate(rows):
            if row["id"] in completed:
                continue
            safe_case = AgentCase(id=row["id"], question=row["question"])
            result = AgentResult(
                id=row["id"],
                question=row["question"],
                category=int(row["category"]),
                sample_id=row["sample_id"],
                conversation_id=row["conversation_id"],
                status="pending",
            )

            async def run_one(
                case: AgentCase = safe_case,
                initial: AgentResult = result,
                worker_index: int = index,
            ) -> AgentResult:
                async with semaphore:
                    return await runtimes.run_case(case, initial, worker_index)

            pending.append(asyncio.create_task(run_one()))

        since_checkpoint = 0
        try:
            for task in asyncio.as_completed(pending):
                result = await task
                completed[result.id] = result
                since_checkpoint += 1
                if since_checkpoint >= harness.checkpoint_every:
                    _write_ordered_results(results_path, rows, completed)
                    print({
                        "agents_stopped": len(completed),
                        "total": len(rows),
                    }, flush=True)
                    since_checkpoint = 0
        finally:
            for task in pending:
                if not task.done():
                    task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

    ordered = _write_ordered_results(results_path, rows, completed)
    statuses: dict[str, int] = {}
    for result in ordered:
        statuses[result.status] = statuses.get(result.status, 0) + 1
    atomic_write_json(run_path, {
        "status": "agents_stopped",
        "run_id": harness.output_dir.name,
        "started_at": started_at,
        "completed_at": datetime.now().astimezone().isoformat(),
        "dataset": str(harness.dataset_dir),
        "category": harness.category,
        "question_id": harness.question_id,
        "limit": harness.limit,
        "questions": len(rows),
        "results": len(ordered),
        "statuses": statuses,
        "max_concurrent": harness.max_concurrent,
        "runtime_workers": harness.runtime_workers,
        "model": runtimes.effective_model,
        "reasoning_effort": runtime_options.reasoning_effort,
        "max_kl_calls": runtime_options.max_kl_calls,
        "skill_path": str(runtime_options.skill_path),
        "codex_config": str(runtime_options.codex_config_path),
        "codex_home_isolated": True,
    })
    return ordered


def _load_completed(path: Path) -> dict[str, AgentResult]:
    if not path.is_file():
        return {}
    completed = {}
    for row in json_lines(path):
        if row.get("status") != "completed":
            continue
        result = _result_from_dict(row)
        completed[result.id] = result
    return completed


def _result_from_dict(row: dict[str, Any]) -> AgentResult:
    values = dict(row)
    values["citations"] = [
        Citation(type=str(citation["type"]), id=str(citation["id"]))
        for citation in row.get("citations") or []
    ]
    return AgentResult(**values)


def _write_ordered_results(
    path: Path,
    rows: list[dict[str, Any]],
    completed: dict[str, AgentResult],
) -> list[AgentResult]:
    ordered = [completed[row["id"]] for row in rows if row["id"] in completed]
    atomic_write_jsonl(path, (result.as_dict() for result in ordered))
    return ordered
