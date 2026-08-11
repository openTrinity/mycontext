"""Benchmark-neutral orchestration for independent Codex agents."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl

from .runtime import CodexRuntimePool, RuntimeOptions
from .models import AgentCase, AgentResult, Citation


@dataclass(frozen=True, slots=True)
class HarnessOptions:
    output_dir: Path
    max_concurrent: int
    runtime_workers: int
    checkpoint_every: int
    resume: bool
    run_metadata: dict[str, Any] = field(default_factory=dict)


async def run_agents(
    cases: list[AgentCase],
    harness: HarnessOptions,
    runtime_options: RuntimeOptions,
) -> list[AgentResult]:
    """Run selected cases without loading or scoring a specific benchmark."""
    if not cases:
        raise ValueError("agentic evaluation requires at least one case")
    if len({case.id for case in cases}) != len(cases):
        raise ValueError("agentic case ids must be unique")

    results_path = harness.output_dir / "results.jsonl"
    completed = _load_completed(results_path) if harness.resume else {}
    run_path = harness.output_dir / "run.json"
    started_at = datetime.now().astimezone().isoformat()
    common_run = {
        **harness.run_metadata,
        "run_id": harness.output_dir.name,
        "questions": len(cases),
        "max_concurrent": harness.max_concurrent,
        "runtime_workers": harness.runtime_workers,
        "model": runtime_options.model,
        "reasoning_effort": runtime_options.reasoning_effort,
        "max_kl_calls": runtime_options.max_kl_calls,
        "skill_path": str(runtime_options.skill_path),
        "codex_config": str(runtime_options.codex_config_path),
        "codex_home_isolated": True,
    }
    atomic_write_json(
        run_path,
        {"status": "running", "started_at": started_at, **common_run},
    )

    semaphore = asyncio.Semaphore(harness.max_concurrent)
    effective_model = runtime_options.model
    async with CodexRuntimePool(
        runtime_options, workers=harness.runtime_workers
    ) as runtimes:
        pending: list[asyncio.Task[AgentResult]] = []
        for index, case in enumerate(cases):
            if case.id in completed:
                continue
            result = AgentResult(
                id=case.id,
                question=case.question,
                scope_id=case.scope_id,
                metadata=dict(case.metadata),
                status="pending",
            )

            async def run_one(
                current_case: AgentCase = case,
                initial: AgentResult = result,
                worker_index: int = index,
            ) -> AgentResult:
                async with semaphore:
                    return await runtimes.run_case(
                        current_case, initial, worker_index
                    )

            pending.append(asyncio.create_task(run_one()))

        since_checkpoint = 0
        try:
            for task in asyncio.as_completed(pending):
                result = await task
                completed[result.id] = result
                since_checkpoint += 1
                if since_checkpoint >= harness.checkpoint_every:
                    _write_ordered_results(results_path, cases, completed)
                    print(
                        {"agents_stopped": len(completed), "total": len(cases)},
                        flush=True,
                    )
                    since_checkpoint = 0
        finally:
            for task in pending:
                if not task.done():
                    task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        effective_model = runtimes.effective_model

    ordered = _write_ordered_results(results_path, cases, completed)
    statuses: dict[str, int] = {}
    for result in ordered:
        statuses[result.status] = statuses.get(result.status, 0) + 1
    atomic_write_json(
        run_path,
        {
            "status": "agents_stopped",
            "started_at": started_at,
            "completed_at": datetime.now().astimezone().isoformat(),
            **common_run,
            "results": len(ordered),
            "statuses": statuses,
            "model": effective_model,
        },
    )
    return ordered


def _load_completed(path: Path) -> dict[str, AgentResult]:
    if not path.is_file():
        return {}
    completed: dict[str, AgentResult] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON in {path}:{line_number}: {exc}") from exc
            if isinstance(row, dict) and row.get("status") == "completed":
                result = _result_from_dict(row)
                completed[result.id] = result
    return completed


def _result_from_dict(row: dict[str, Any]) -> AgentResult:
    """Load current artifacts and legacy rows with flattened metadata."""
    metadata = dict(row.get("metadata") or {})
    result_fields = {
        "id",
        "question",
        "status",
        "scope_id",
        "metadata",
        "answer",
        "citations",
        "thread_id",
        "turn_id",
        "model",
        "duration_ms",
        "usage",
        "transcript_path",
        "kl_calls",
        "denied_kl_calls",
        "max_kl_calls",
        "error",
    }
    for key, value in row.items():
        if key not in result_fields:
            metadata.setdefault(key, value)
    scope_id = str(
        row.get("scope_id")
        or metadata.get("scope_id")
        or metadata.get("namespace_id")
        or metadata.get("conversation_id")
        or ""
    )
    return AgentResult(
        id=str(row.get("id") or ""),
        question=str(row.get("question") or ""),
        status=str(row.get("status") or ""),
        scope_id=scope_id,
        metadata=metadata,
        answer=str(row.get("answer") or ""),
        citations=[
            Citation(type=str(value["type"]), id=str(value["id"]))
            for value in row.get("citations") or []
            if isinstance(value, dict) and "type" in value and "id" in value
        ],
        thread_id=row.get("thread_id"),
        turn_id=row.get("turn_id"),
        model=row.get("model"),
        duration_ms=row.get("duration_ms"),
        usage=row.get("usage"),
        transcript_path=row.get("transcript_path"),
        kl_calls=int(row.get("kl_calls") or 0),
        denied_kl_calls=int(row.get("denied_kl_calls") or 0),
        max_kl_calls=row.get("max_kl_calls"),
        error=row.get("error"),
    )


def _write_ordered_results(
    path: Path,
    cases: list[AgentCase],
    completed: dict[str, AgentResult],
) -> list[AgentResult]:
    ordered = [completed[case.id] for case in cases if case.id in completed]
    atomic_write_jsonl(path, (result.as_dict() for result in ordered))
    return ordered
