"""Generate LoCoMo answers from cached production ``kl ask`` items.

This stage does not call KL, repeat retrieval, resolve Gold evidence, or score
answers. Each answer is generated from the first K items in a persisted Phase-1
response. Scoring is owned by :mod:`kl_graph.evaluation.locomo.runners.ask.score`.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import random
import time
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kl_graph.config import cfg
from kl_graph.utils.litellm_config import litellm, provider_api_key, provider_model
from kl_graph.evaluation.io import (
    atomic_write_json,
    atomic_write_jsonl,
    json_lines,
)
from kl_graph.evaluation.locomo.build import (
    case_set_fingerprint,
    cases_by_conversation,
    resolve_case_root,
)

SYSTEM_PROMPT = """You answer questions about long-running conversations.
Use only the supplied retrieved evidence. Return one short phrase and no explanation.
Use exact words from the evidence whenever possible.
If the question cannot be answered, answer exactly: Not mentioned"""

LLM_PROVIDER = str(cfg.services.llm_flash.provider)
LLM_BASE_URL = str(cfg.services.llm_flash.base_url or "")
LLM_MODEL = str(cfg.services.llm_flash.model)
LLM_TIMEOUT = float(cfg.services.llm_flash.timeout)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate LoCoMo short answers from cached /ask Top-K items."
    )
    parser.add_argument(
        "--ask-dir",
        type=Path,
        required=True,
        help="completed ask directory containing results.jsonl and responses",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help=(
            "override the default case-local "
            "benchmark/locomo-generate/CATEGORY/RUN_TIME directory"
        ),
    )
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--max-concurrent", type=int, default=20)
    parser.add_argument("--checkpoint-every", type=int, default=10)
    parser.add_argument("--max-tokens", type=int, default=128)
    parser.add_argument("--timeout-seconds", type=float, default=LLM_TIMEOUT)
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument(
        "--allow-remote-content",
        action="store_true",
        help="allow sending cached LoCoMo evidence to a non-local answer model",
    )
    args = parser.parse_args(argv)
    for name in ("top_k", "max_concurrent", "checkpoint_every", "max_tokens"):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")
    if args.max_retries < 0:
        parser.error("--max-retries must be non-negative")
    return args


def _format_timestamp(timestamp_ms: int) -> str:
    if timestamp_ms <= 0:
        return "unknown"
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC).strftime(
        "%d %B %Y, %H:%M UTC"
    )


def _context_from_response(
    response: dict[str, Any], top_k: int
) -> tuple[str, list[dict[str, Any]]]:
    """Build generation context directly from production ``kl ask`` items."""
    items = response.get("items")
    if not isinstance(items, list):
        raise TypeError("cached response items are not a list")
    context_parts: list[str] = []
    summaries: list[dict[str, Any]] = []
    for rank, item in enumerate(items[:top_k], 1):
        if not isinstance(item, dict):
            raise TypeError(f"cached response item {rank} is not an object")
        item_id = str(item.get("id") or "").strip()
        item_type = str(item.get("type") or "").strip().lower()
        content = str(item.get("content") or "").strip()
        if not item_id or not item_type or not content:
            raise ValueError(f"cached response item {rank} is incomplete")
        date = _format_timestamp(int(item.get("timestamp") or 0))
        context_parts.append(
            f"Evidence {rank} [type={item_type}; DATE={date}]\n{content}"
        )
        summaries.append(
            {
                "rank": rank,
                "type": item_type,
                "id": item_id,
                "date": date,
                "content_chars": len(content),
                "content_sha256": hashlib.sha256(content.encode()).hexdigest(),
            }
        )
    return "\n\n---\n\n".join(context_parts), summaries


def _question_prompt(row: dict[str, Any], context: str) -> str:
    question = str(row["question"])
    if int(row["category"]) == 2:
        question += (
            " Use the DATE fields to answer with an approximate date when needed."
        )
    return f"Retrieved evidence:\n{context}\n\nQuestion:\n{question}\n\nShort answer:"


def _response_path(ask_dir: Path, row: dict[str, Any]) -> Path:
    value = Path(str(row.get("response_path") or ""))
    return value if value.is_absolute() else ask_dir / value


def _read_response(ask_dir: Path, row: dict[str, Any]) -> dict[str, Any]:
    path = _response_path(ask_dir, row)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"cached response is not an object: {path}")
    return value


def _retryable(exc: Exception) -> bool:
    message = str(exc).lower()
    if any(
        value in message
        for value in (
            "authentication",
            "invalid_api_key",
            "insufficient_quota",
            "context_length",
            "content_filter",
        )
    ):
        return False
    status = getattr(exc, "status_code", None)
    if status in {408, 409, 429, 500, 502, 503, 504}:
        return True
    return not (status and 400 <= status < 500)


async def _generate_one(
    row: dict[str, Any],
    context: str,
    context_items: list[dict[str, Any]],
    args: argparse.Namespace,
    semaphore: asyncio.Semaphore,
    api_key: str,
) -> dict[str, Any]:
    started = time.monotonic()
    error: str | None = None
    for attempt in range(args.max_retries + 1):
        try:
            async with semaphore:
                response = await litellm.acompletion(
                    model=provider_model(LLM_PROVIDER, LLM_MODEL),
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": _question_prompt(row, context),
                        },
                    ],
                    api_base=LLM_BASE_URL,
                    api_key=api_key,
                    temperature=0,
                    max_tokens=args.max_tokens,
                    timeout=args.timeout_seconds,
                )
            answer = str(response.choices[0].message.content or "").strip()
            if not answer:
                raise ValueError("answer model returned empty content")
            usage = getattr(response, "usage", None)
            return {
                **_answer_base(row, args.top_k),
                "generated_answer": answer,
                "generator_model": str(getattr(response, "model", None) or LLM_MODEL),
                "generation_context_items": context_items,
                "generation_status": "completed",
                "generation_attempts": attempt + 1,
                "generation_duration_ms": round((time.monotonic() - started) * 1000),
                "generation_usage": _usage_dict(usage),
                "generation_error": None,
            }
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"
            if attempt >= args.max_retries or not _retryable(exc):
                break
            await asyncio.sleep(min(2**attempt, 20) + random.uniform(0, 0.5))
    return {
        **_answer_base(row, args.top_k),
        "generated_answer": "",
        "generator_model": LLM_MODEL,
        "generation_context_items": context_items,
        "generation_status": "failed",
        "generation_attempts": args.max_retries + 1,
        "generation_duration_ms": round((time.monotonic() - started) * 1000),
        "generation_usage": None,
        "generation_error": error,
    }


def _answer_base(row: dict[str, Any], top_k: int) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "sample_id": str(row["sample_id"]),
        "conversation_id": str(row["conversation_id"]),
        "question": str(row["question"]),
        "category": int(row["category"]),
        "generation_top_k": top_k,
    }


def _usage_dict(usage: Any) -> dict[str, int] | None:
    if usage is None:
        return None
    result = {}
    for name in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = getattr(usage, name, None)
        if value is not None:
            result[name] = int(value)
    return result or None


def _load_resumable(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    return {
        str(row["id"]): row
        for row in json_lines(path)
        if row.get("generation_status") == "completed"
        and str(row.get("generated_answer") or "").strip()
    }


def _ordered(
    source_rows: list[dict[str, Any]], completed: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    return [
        completed[str(row["id"])] for row in source_rows if str(row["id"]) in completed
    ]


def _log(output_dir: Path, event: str, **values: Any) -> None:
    row = {
        "timestamp": datetime.now().astimezone().isoformat(),
        "event": event,
        **values,
    }
    with (output_dir / "generation-events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def _resolve_output_dir(
    args: argparse.Namespace,
    dataset_dir: Path,
    conversation_id: str,
    category: int | None,
    input_run: dict[str, Any],
) -> Path:
    if args.output_dir is not None:
        return args.output_dir.expanduser().resolve()
    category_name = f"category-{category}" if category else "all"
    backend = str(input_run.get("backend") or "kl")
    if backend in {"ragflow", "khoj"}:
        case_root = input_run.get("case_root")
        if not case_root:
            raise ValueError(
                f"{backend} answer generation requires a one-conversation ask run"
            )
        if backend == "ragflow":
            root = (
                Path(str(case_root)).expanduser().resolve()
                / "benchmark"
                / "locomo-ragflow-generate"
                / ("graph" if input_run.get("use_kg") else "vector")
            )
        else:
            root = (
                Path(str(case_root)).expanduser().resolve()
                / "benchmark"
                / "locomo-khoj-generate"
            )
        root /= category_name
    else:
        case = cases_by_conversation(dataset_dir).get(conversation_id)
        if case is None:
            raise ValueError(f"unknown LoCoMo conversation: {conversation_id}")
        root = (
            resolve_case_root(dataset_dir, case)
            / "benchmark"
            / "locomo-generate"
            / category_name
        )
    if args.resume:
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
        return candidates[-1]
    run_id = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    candidate = root / run_id
    suffix = 1
    while candidate.exists():
        candidate = root / f"{run_id}-{suffix:02d}"
        suffix += 1
    return candidate


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    ask_dir = args.ask_dir.expanduser().resolve()
    results_path = ask_dir / "results.jsonl"
    input_run = json.loads((ask_dir / "run.json").read_text(encoding="utf-8"))
    if input_run.get("status") != "complete":
        raise RuntimeError(f"ask run is not complete: {ask_dir}")
    dataset_dir = Path(str(input_run["dataset"])).expanduser().resolve()
    backend = str(input_run.get("backend") or "kl")
    if backend in {"ragflow", "khoj"}:
        if backend == "ragflow":
            from kl_graph.evaluation.locomo.runners.ragflow.source import (
                source_fingerprint,
            )
        else:
            from kl_graph.evaluation.locomo.runners.khoj.source import (
                source_fingerprint,
            )

        if input_run.get("source_sha256") != source_fingerprint(dataset_dir):
            raise ValueError("native LoCoMo source has changed on disk")
    elif input_run.get("case_set_fingerprint") != case_set_fingerprint(dataset_dir):
        raise ValueError("input run case set has changed on disk")
    conversation_id = str(input_run.get("conversation") or "").strip()
    if not conversation_id:
        raise ValueError("ask run must select exactly one conversation")
    category = input_run.get("category")
    category = int(category) if category is not None else None
    output_dir = _resolve_output_dir(
        args, dataset_dir, conversation_id, category, input_run
    )
    if output_dir == ask_dir:
        raise ValueError("--output-dir must differ from --ask-dir")
    if not results_path.is_file():
        raise FileNotFoundError(results_path)
    if args.top_k > int(input_run.get("top_k") or 0):
        raise ValueError(
            f"answer Top-{args.top_k} exceeds ask Top-{input_run.get('top_k')}"
        )
    if not LLM_BASE_URL:
        raise ValueError("KL_LLM_BASE_URL is not configured")
    api_key = provider_api_key(LLM_PROVIDER) or ""
    if not api_key:
        raise ValueError(f"API key for {LLM_PROVIDER!r} is not configured")
    hostname = urllib.parse.urlparse(LLM_BASE_URL).hostname
    if (
        hostname not in {"127.0.0.1", "localhost", "::1"}
        and not args.allow_remote_content
    ):
        raise ValueError("pass --allow-remote-content to use a remote answer model")
    if output_dir.exists() and not args.resume:
        raise FileExistsError(f"output directory already exists: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    rows = list(json_lines(results_path))
    if len(rows) != int(input_run.get("questions") or 0):
        raise RuntimeError("ask results are incomplete")
    unexpected_conversations = {
        str(row.get("conversation_id") or "")
        for row in rows
        if str(row.get("conversation_id") or "") != conversation_id
    }
    if unexpected_conversations:
        raise ValueError(
            "ask results contain conversations outside "
            f"{conversation_id}: {sorted(unexpected_conversations)}"
        )
    if args.limit is not None:
        rows = rows[: args.limit]
    answers_path = output_dir / "answers.jsonl"
    completed = _load_resumable(answers_path) if args.resume else {}
    run = {
        "status": "running",
        "started_at": datetime.now().astimezone().isoformat(),
        "ask_dir": str(ask_dir),
        "backend": input_run.get("backend", "kl"),
        "dataset": str(dataset_dir),
        "case_set_fingerprint": input_run.get("case_set_fingerprint"),
        "source_sha256": input_run.get("source_sha256"),
        "conversation": conversation_id,
        "questions": len(rows),
        "top_k": args.top_k,
        "max_concurrent": args.max_concurrent,
        "checkpoint_every": args.checkpoint_every,
        "model": LLM_MODEL,
        "base_url": LLM_BASE_URL,
        "system_prompt": SYSTEM_PROMPT,
        "resume": args.resume,
        "repeats_retrieval": False,
    }
    atomic_write_json(output_dir / "run.json", run)
    _log(output_dir, "generation_start", questions=len(rows), resumed=len(completed))

    semaphore = asyncio.Semaphore(args.max_concurrent)
    tasks: list[asyncio.Task[dict[str, Any]]] = []
    try:
        for row in rows:
            if str(row["id"]) in completed:
                continue
            response = _read_response(ask_dir, row)
            context, context_items = _context_from_response(response, args.top_k)
            tasks.append(
                asyncio.create_task(
                    _generate_one(
                        row,
                        context,
                        context_items,
                        args,
                        semaphore,
                        api_key,
                    )
                )
            )
        since_checkpoint = 0
        for task in asyncio.as_completed(tasks):
            answer = await task
            completed[str(answer["id"])] = answer
            since_checkpoint += 1
            _log(
                output_dir,
                "answer_complete",
                id=answer["id"],
                status=answer["generation_status"],
                duration_ms=answer["generation_duration_ms"],
                error=answer["generation_error"],
            )
            if since_checkpoint >= args.checkpoint_every:
                ordered = _ordered(rows, completed)
                atomic_write_jsonl(answers_path, ordered)
                print(
                    json.dumps(
                        {
                            "answers_stopped": len(ordered),
                            "total": len(rows),
                            "failed": sum(
                                row.get("generation_status") != "completed"
                                for row in ordered
                            ),
                        }
                    ),
                    flush=True,
                )
                since_checkpoint = 0
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    ordered = _ordered(rows, completed)
    atomic_write_jsonl(answers_path, ordered)
    failed = sum(row.get("generation_status") != "completed" for row in ordered)
    usage = {
        name: sum(
            int((row.get("generation_usage") or {}).get(name) or 0) for row in ordered
        )
        for name in ("prompt_tokens", "completion_tokens", "total_tokens")
    }
    run.update(
        {
            "status": "complete"
            if not failed and len(ordered) == len(rows)
            else "incomplete",
            "completed_at": datetime.now().astimezone().isoformat(),
            "answers": len(ordered),
            "successful_answers": len(ordered) - failed,
            "failed_answers": failed,
            "usage": usage,
        }
    )
    atomic_write_json(output_dir / "run.json", run)
    _log(output_dir, "generation_complete", **run)
    print(
        json.dumps(
            {
                "answers": len(ordered),
                "failed": failed,
                "usage": usage,
            }
        ),
        flush=True,
    )
    return 0 if run["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
