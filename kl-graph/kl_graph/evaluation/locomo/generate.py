"""Generate LoCoMo answers from cached backend Ask items.

This stage does not call KL, repeat retrieval, resolve Gold evidence, or score
answers. Each answer is generated from the first K items in a persisted Phase-1
response and can optionally include the response's cached community context.
Scoring is owned by :mod:`kl_graph.evaluation.locomo.score`.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import random
import sys
import time
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.evaluation.io import (
    atomic_write_json,
    atomic_write_jsonl,
    json_lines,
)
from kl_graph.evaluation.locomo.cases import (
    case_set_fingerprint,
    load_case_entries,
    select_cases,
)
from kl_graph.evaluation.locomo.experiment import (
    GenerateExperiment,
    load_generate_experiment,
)
from kl_graph.evaluation.locomo.source import (
    load_samples,
    select_samples,
    source_fingerprint,
)
from kl_graph.utils.litellm_config import litellm, provider_api_key, provider_model

SYSTEM_PROMPT = """You answer questions about long-running conversations.
Use only the supplied retrieved evidence. Return one short phrase and no explanation.
Always answer in English, even when some or all of the evidence is written in another language.
Translate relevant evidence into English while preserving names, titles, and other proper nouns.
When the evidence is already in English, use its exact words whenever possible.
If the question cannot be answered, answer exactly: Not mentioned"""

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def _runtime_options(experiment: GenerateExperiment) -> argparse.Namespace:
    config = experiment.generate
    return argparse.Namespace(
        allow_remote_content=config.allow_remote_content,
        ask_dir=Path(experiment.run.output_dir),
        base_url=config.base_url,
        checkpoint_every=config.checkpoint_every,
        include_community_context=config.include_community_context,
        max_concurrent=config.concurrency,
        max_retries=config.max_retries,
        max_tokens=config.max_tokens,
        model=config.model,
        output_dir=Path(config.output_dir),
        provider=config.provider,
        resume=experiment.run.mode == "resume",
        temperature=config.temperature,
        timeout_seconds=config.timeout_seconds,
        top_k=config.top_k,
    )


def _format_timestamp(timestamp_ms: int) -> str:
    if timestamp_ms <= 0:
        return "unknown"
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC).strftime(
        "%d %B %Y, %H:%M UTC"
    )


def _context_from_response(
    response: dict[str, Any],
    top_k: int,
    *,
    include_community_context: bool = False,
) -> tuple[str, list[dict[str, Any]]]:
    """Build generation context directly from a cached production response."""
    items = response.get("items")
    if not isinstance(items, list):
        raise TypeError("cached response items are not a list")
    context_parts: list[str] = []
    summaries: list[dict[str, Any]] = []
    selected: list[dict[str, Any]] = []
    vector_count = 0
    for item in items:
        if not isinstance(item, dict):
            raise TypeError("cached response item is not an object")
        if str(item.get("type") or "").lower() == "graph":
            selected.append(item)
            continue
        if vector_count < top_k:
            selected.append(item)
            vector_count += 1
    for rank, item in enumerate(selected, 1):
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
    if include_community_context:
        community_parts, community_summaries = _community_context_from_response(
            response, start_rank=len(summaries) + 1
        )
        context_parts.extend(community_parts)
        summaries.extend(community_summaries)
    return "\n\n---\n\n".join(context_parts), summaries


def _community_context_from_response(
    response: dict[str, Any], *, start_rank: int
) -> tuple[list[str], list[dict[str, Any]]]:
    raw_communities = response.get("community_context", [])
    if raw_communities is None:
        raw_communities = []
    if not isinstance(raw_communities, list):
        raise TypeError("cached response community_context is not a list")

    context_parts: list[str] = []
    summaries: list[dict[str, Any]] = []
    for community_rank, community in enumerate(raw_communities, 1):
        if not isinstance(community, dict):
            raise TypeError(
                f"cached community context {community_rank} is not an object"
            )
        summary = str(community.get("summary") or "").strip()
        if not summary:
            continue
        title = str(community.get("title") or "").strip()
        level = community.get("level")
        community_id = community.get("community_id")
        tags = community.get("tags")
        if not isinstance(tags, list):
            tags = []

        rendered = (
            f"Community context {community_rank} "
            f"[level={level}; id={community_id}; "
            f"members={int(community.get('member_count') or 0)}]\n"
            f"Title: {title or 'Untitled'}\n"
            f"Summary: {summary}"
        )
        if tags:
            rendered += "\nTags: " + ", ".join(str(tag) for tag in tags)
        context_parts.append(rendered)
        summaries.append(
            {
                "rank": start_rank + len(summaries),
                "community_rank": community_rank,
                "type": "community",
                "id": f"community:L{level}:{community_id}",
                "level": level,
                "member_count": int(community.get("member_count") or 0),
                "content_chars": len(rendered),
                "content_sha256": hashlib.sha256(rendered.encode()).hexdigest(),
            }
        )
    return context_parts, summaries


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
                    model=provider_model(args.provider, args.model),
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {
                            "role": "user",
                            "content": _question_prompt(row, context),
                        },
                    ],
                    api_base=args.base_url,
                    api_key=api_key,
                    temperature=args.temperature,
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
                "generator_model": str(getattr(response, "model", None) or args.model),
                "generation_context_items": context_items,
                "generation_includes_community_context": (
                    args.include_community_context
                ),
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
        "generator_model": args.model,
        "generation_context_items": context_items,
        "generation_includes_community_context": args.include_community_context,
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
    conversation_ids: list[str],
    category: int | None,
    input_run: dict[str, Any],
) -> Path:
    del dataset_dir, conversation_ids, category, input_run
    output_dir = args.output_dir.expanduser().resolve()
    if args.resume and not (output_dir / "run.json").is_file():
        raise FileNotFoundError(f"generation run does not exist: {output_dir}")
    return output_dir


def _generation_configuration(
    args: argparse.Namespace,
    *,
    ask_dir: Path,
    backend: str,
    dataset_dir: Path,
    conversation_ids: list[str],
    questions: int,
) -> dict[str, Any]:
    return {
        "ask_dir": str(ask_dir),
        "backend": backend,
        "dataset": str(dataset_dir),
        "conversations": conversation_ids,
        "questions": questions,
        "top_k": args.top_k,
        "concurrency": args.max_concurrent,
        "checkpoint_every": args.checkpoint_every,
        "provider": args.provider,
        "model": args.model,
        "base_url": args.base_url,
        "temperature": args.temperature,
        "max_tokens": args.max_tokens,
        "timeout_seconds": args.timeout_seconds,
        "max_retries": args.max_retries,
        "include_community_context": args.include_community_context,
        "allow_remote_content": args.allow_remote_content,
        "system_prompt": SYSTEM_PROMPT,
    }


def _validate_resume_run(
    output_dir: Path, expected: dict[str, Any]
) -> dict[str, Any]:
    path = output_dir / "run.json"
    existing = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(existing, dict):
        raise TypeError(f"generation run manifest is not an object: {path}")
    if existing.get("configuration") != expected:
        raise ValueError(
            "generation configuration changed; set run.mode=overwrite or "
            "choose a different generate.output_dir"
        )
    return existing


def _validate_configured_ask_run(
    experiment: GenerateExperiment,
    input_run: dict[str, Any],
    dataset_dir: Path,
) -> None:
    if experiment.backend == "kl_graph":
        if experiment.case_set is None or dataset_dir != experiment.case_set.resolve():
            raise ValueError("Ask run case set differs from the configured case_set")
        _, entries = load_case_entries(dataset_dir)
        selected = select_cases(entries, experiment.selection.conversations)
        conversations = [str(entry["conversation_id"]) for entry in selected]
    else:
        if dataset_dir != experiment.source.resolve():
            raise ValueError("Ask run source differs from the configured source")
        _, samples = load_samples(dataset_dir)
        selected = select_samples(samples, experiment.selection.conversations)
        conversations = [str(sample["sample_id"]) for sample in selected]
    questions = experiment.selection.questions
    expected = {
        "conversations": conversations,
        "categories": questions.categories,
        "question_ids": questions.ids,
        "limit": questions.first,
    }
    mismatches = {
        key: {"recorded": input_run.get(key), "configured": value}
        for key, value in expected.items()
        if input_run.get(key) != value
    }
    if mismatches:
        raise ValueError(
            "Ask run selection differs from the configured selection: "
            + json.dumps(mismatches, ensure_ascii=False, sort_keys=True)
        )


async def main(argv: list[str] | None = None) -> int:
    try:
        cli = parse_args(argv)
        experiment = load_generate_experiment(cli.config)
        args = _runtime_options(experiment)
    except (OSError, TypeError, ValueError, OmegaConfBaseException) as exc:
        print(f"error: invalid experiment configuration: {exc}", file=sys.stderr)
        return 2
    if cli.dry_run:
        print(f"Generate input={args.ask_dir} output={args.output_dir}")
        return 0
    ask_dir = args.ask_dir.expanduser().resolve()
    results_path = ask_dir / "results.jsonl"
    input_run = json.loads((ask_dir / "run.json").read_text(encoding="utf-8"))
    if input_run.get("status") != "complete":
        raise RuntimeError(f"ask run is not complete: {ask_dir}")
    dataset_dir = Path(str(input_run["dataset"])).expanduser().resolve()
    backend = str(input_run.get("backend") or "")
    if backend != experiment.backend or input_run.get("benchmark") != "locomo":
        raise ValueError(
            f"configured Ask directory is not a {experiment.backend} LoCoMo run"
        )
    _validate_configured_ask_run(experiment, input_run, dataset_dir)
    if backend in {"ragflow", "khoj"}:
        if input_run.get("source_sha256") != source_fingerprint(dataset_dir):
            raise ValueError("native LoCoMo source has changed on disk")
    elif input_run.get("case_set_fingerprint") != case_set_fingerprint(dataset_dir):
        raise ValueError("input run case set has changed on disk")
    conversation_ids = [
        str(value) for value in input_run.get("conversations") or [] if value
    ]
    if not conversation_ids:
        single = str(input_run.get("conversation") or "").strip()
        conversation_ids = [single] if single else []
    if not conversation_ids:
        raise ValueError("ask run has no selected conversations")
    category = input_run.get("category")
    category = int(category) if category is not None else None
    output_dir = _resolve_output_dir(
        args, dataset_dir, conversation_ids, category, input_run
    )
    if output_dir == ask_dir:
        raise ValueError("--output-dir must differ from --ask-dir")
    if not results_path.is_file():
        raise FileNotFoundError(results_path)
    if args.top_k > int(input_run.get("top_k") or 0):
        raise ValueError(
            f"answer Top-{args.top_k} exceeds ask Top-{input_run.get('top_k')}"
        )
    api_key = provider_api_key(args.provider) or ""
    if not api_key:
        raise ValueError(f"API key for {args.provider!r} is not configured")
    hostname = urllib.parse.urlparse(args.base_url).hostname
    if (
        hostname not in {"127.0.0.1", "localhost", "::1"}
        and not args.allow_remote_content
    ):
        raise ValueError("pass --allow-remote-content to use a remote answer model")
    output_dir.mkdir(parents=True, exist_ok=True)

    rows = list(json_lines(results_path))
    if len(rows) != int(input_run.get("questions") or 0):
        raise RuntimeError("ask results are incomplete")
    selected_conversations = set(conversation_ids)
    unexpected_conversations = {
        str(row.get("conversation_id") or "")
        for row in rows
        if str(row.get("conversation_id") or "") not in selected_conversations
    }
    if unexpected_conversations:
        raise ValueError(
            "ask results contain conversations outside "
            f"{sorted(unexpected_conversations)}"
        )
    run_configuration = _generation_configuration(
        args,
        ask_dir=ask_dir,
        backend=backend,
        dataset_dir=dataset_dir,
        conversation_ids=conversation_ids,
        questions=len(rows),
    )
    prior_run = (
        _validate_resume_run(output_dir, run_configuration) if args.resume else {}
    )
    answers_path = output_dir / "answers.jsonl"
    completed = _load_resumable(answers_path) if args.resume else {}
    row_ids = {str(row["id"]) for row in rows}
    unknown_ids = sorted(set(completed).difference(row_ids))
    if unknown_ids:
        raise ValueError(
            f"generation output contains IDs outside the Ask run: {unknown_ids[0]}"
        )
    run = {
        "status": "running",
        "started_at": str(prior_run.get("started_at") or "")
        or datetime.now().astimezone().isoformat(),
        "ask_dir": str(ask_dir),
        "backend": backend,
        "dataset": str(dataset_dir),
        "case_set_fingerprint": input_run.get("case_set_fingerprint"),
        "source_sha256": input_run.get("source_sha256"),
        "conversation": conversation_ids[0] if len(conversation_ids) == 1 else None,
        "conversations": conversation_ids,
        "questions": len(rows),
        "top_k": args.top_k,
        "max_concurrent": args.max_concurrent,
        "checkpoint_every": args.checkpoint_every,
        "model": args.model,
        "base_url": args.base_url,
        "system_prompt": SYSTEM_PROMPT,
        "include_community_context": args.include_community_context,
        "resume": args.resume,
        "repeats_retrieval": False,
        "configuration": run_configuration,
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
            context, context_items = _context_from_response(
                response,
                args.top_k,
                include_community_context=args.include_community_context,
            )
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
