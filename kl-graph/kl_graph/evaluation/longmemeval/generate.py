"""Generate LongMemEval hypotheses from cached KL retrieval.

The prompt follows LongMemEval's direct retrieval-augmented generation format:
each retrieved user-only chunk (or a fact's source chunk) is mapped back to its
original user turns and their immediately following assistant turns, then the
rehydrated history is ordered chronologically. The prompt adds the current
date, question, and a plain ``Answer:`` suffix. Output is the benchmark's native
JSONL contract::

    {"question_id": "...", "hypothesis": "..."}

The output can be passed to LongMemEval's official
``src/evaluation/evaluate_qa.py``. RAGFlow and Khoj prompt adapters remain as
library helpers for their separate runners; this command is the KL YAML stage.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from omegaconf.errors import OmegaConfBaseException

from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl, json_lines
from kl_graph.evaluation.longmemeval.build import (
    CASE_DATA_DIRNAME,
    _load_case_entries,
    _resolve_manifest_path,
)
from kl_graph.evaluation.longmemeval.convert import message_id
from kl_graph.evaluation.longmemeval.experiment import (
    PROMPT_RESERVE_TOKENS,
    GenerateConfig,
    GenerateExperiment,
    load_generate_experiment,
    select_entries,
)
from kl_graph.evaluation.longmemeval.source import (
    cases_by_id,
    load_cases,
    source_fingerprint,
)
from kl_graph.utils.litellm_config import litellm, provider_api_key, provider_model

FACT_CONTEXT_MODE = "none"

PROMPT_TEMPLATE = """I will give you several history chats between you and a user. \
Please answer the question based on the relevant chat history.


History Chats:

{}

Current Date: {}
Question: {}
Answer:"""


@dataclass(frozen=True)
class EvaluationCase:
    """Query data and non-ingested source chats for one benchmark case."""

    question: str
    question_date: str
    sessions: list[list[dict[str, str]]]
    session_dates: list[str]
    message_locations: dict[str, tuple[int, int]]


@dataclass(frozen=True)
class HydratedItem:
    """Original dialogue restored from one or more retrieved KL items."""

    retrieval_rank: int
    session_index: int
    first_turn_index: int
    session_date: str
    turns: list[dict[str, str]]
    source_item_type: str
    source_item_id: str
    source_unit_id: str


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate LongMemEval hypotheses from a KL experiment YAML."
    )
    parser.add_argument(
        "--config", type=Path, required=True, help="LongMemEval experiment YAML"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate inputs and construct prompts without calling the model",
    )
    return parser.parse_args(argv)


def _read_evaluation(case_root: Path, question_id: str) -> EvaluationCase:
    path = case_root / "evaluation.jsonl"
    with path.open("r", encoding="utf-8") as stream:
        rows = [json.loads(line) for line in stream if line.strip()]
    if len(rows) != 1:
        raise ValueError(f"expected one evaluation row: {path}")
    data = rows[0].get("data", {})
    if data.get("question_id") != question_id:
        raise ValueError(f"evaluation question ID mismatch: {question_id}")
    question = data.get("question")
    question_date = data.get("question_date")
    if not isinstance(question, str) or not question.strip():
        raise ValueError(f"case {question_id} has no question")
    if not isinstance(question_date, str) or not question_date.strip():
        raise ValueError(f"case {question_id} has no question date")

    sessions = data.get("haystack_sessions")
    session_ids = data.get("haystack_session_ids")
    session_dates = data.get("haystack_dates")
    source_fields = (sessions, session_ids, session_dates)
    if not all(isinstance(value, list) for value in source_fields):
        raise ValueError(
            f"case {question_id}: evaluation data lacks full source chats; "
            "rerun the user-only converter"
        )
    if not (len(sessions) == len(session_ids) == len(session_dates)):
        raise ValueError(
            f"case {question_id}: source chat fields have different lengths"
        )

    normalized_sessions: list[list[dict[str, str]]] = []
    message_locations: dict[str, tuple[int, int]] = {}
    for session_index, session in enumerate(sessions):
        if not isinstance(session, list) or not session:
            raise ValueError(
                f"case {question_id} session {session_index}: invalid source session"
            )
        normalized_turns: list[dict[str, str]] = []
        for turn_index, turn in enumerate(session):
            if not isinstance(turn, dict):
                raise TypeError(
                    f"case {question_id} session {session_index} "
                    f"turn {turn_index}: invalid source turn"
                )
            role = turn.get("role")
            content = turn.get("content")
            if role not in {"user", "assistant"} or not isinstance(content, str):
                raise ValueError(
                    f"case {question_id} session {session_index} "
                    f"turn {turn_index}: invalid role or content"
                )
            normalized_turns.append({"role": role, "content": content})
            message_locations[message_id(question_id, session_index, turn_index)] = (
                session_index,
                turn_index,
            )
        normalized_sessions.append(normalized_turns)

    if not all(isinstance(value, str) and value for value in session_dates):
        raise ValueError(f"case {question_id}: invalid source session date")
    return EvaluationCase(
        question=question.strip(),
        question_date=question_date.strip(),
        sessions=normalized_sessions,
        session_dates=session_dates,
        message_locations=message_locations,
    )


def _read_ask_items(
    case_root: Path,
    question_id: str,
    top_k: int,
) -> list[dict[str, Any]]:
    path = case_root / "results" / f"ask_top{top_k}.json"
    artifact = json.loads(path.read_text(encoding="utf-8"))
    if artifact.get("question_id") != question_id:
        raise ValueError(f"ask result question ID mismatch: {question_id}")
    if artifact.get("force_phase2") is not False:
        raise ValueError(f"case {question_id}: ask result must have Phase 2 off")
    if artifact.get("top_k") != top_k:
        raise ValueError(f"case {question_id}: ask result Top-K mismatch")
    response = artifact.get("response")
    if not isinstance(response, dict):
        raise TypeError(f"case {question_id}: malformed ask response")
    items = response.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError(f"case {question_id}: ask returned no items")
    if len(items) > top_k:
        raise ValueError(
            f"case {question_id}: expected at most {top_k} ask items"
        )
    if not all(isinstance(item, dict) for item in items):
        raise ValueError(f"case {question_id}: malformed ask items")
    return items


def _read_item_source_units(
    conn: sqlite3.Connection,
    item: dict[str, Any],
    question_id: str,
) -> list[str]:
    """Resolve one item to exact user turns under official ``flat-turn``.

    Facts use their precise ``source_unit_id``. A Fact from an old database
    without that provenance falls back to all members of its source chunk.
    Chunk/Message hits always expand all represented user turns.
    """
    item_id = item.get("id")
    item_type = str(item.get("type") or "").lower()
    if not isinstance(item_id, str) or not item_id:
        raise ValueError(f"case {question_id}: ask item has no ID")

    if item_type == "fact":
        columns = {
            str(row[1]) for row in conn.execute("PRAGMA table_info(facts)").fetchall()
        }
        source_unit_select = (
            "source_unit_id"
            if "source_unit_id" in columns
            else "NULL AS source_unit_id"
        )
        row = conn.execute(
            f"SELECT source_chunk_id, {source_unit_select} FROM facts WHERE id = ?",
            (item_id.removeprefix("fact:"),),
        ).fetchone()
        if row is None:
            raise ValueError(
                f"case {question_id}: fact is absent from knowledge.db: {item_id}"
            )
        chunk_id = row[0]
        source_unit_id = row[1]
        if isinstance(source_unit_id, str) and source_unit_id:
            return [source_unit_id]
    else:
        chunk_id = item_id.removeprefix("cnk:")

    row = conn.execute(
        "SELECT metadata FROM chunks WHERE id = ?", (chunk_id,)
    ).fetchone()
    if row is None:
        raise ValueError(
            f"case {question_id}: source chunk is absent from knowledge.db: {chunk_id}"
        )
    try:
        metadata = json.loads(row[0] or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"case {question_id}: source chunk has invalid metadata: {chunk_id}"
        ) from exc
    member_ids = metadata.get("member_message_ids")
    if not isinstance(member_ids, list) or not member_ids:
        raise ValueError(
            f"case {question_id}: source chunk has no member_message_ids: {chunk_id}"
        )
    if not all(isinstance(member_id, str) and member_id for member_id in member_ids):
        raise ValueError(
            f"case {question_id}: source chunk has invalid member_message_ids: "
            f"{chunk_id}"
        )
    return member_ids


def _hydrate_items(
    case_root: Path,
    question_id: str,
    evaluation: EvaluationCase,
    items: list[dict[str, Any]],
) -> list[HydratedItem]:
    """Restore official flat-turn rounds for user-only Chunk and Fact hits."""
    database = (case_root / CASE_DATA_DIRNAME / "knowledge.db").resolve()
    if not database.is_file():
        raise FileNotFoundError(f"case {question_id} has not been built: {database}")

    hydrated: list[HydratedItem] = []
    seen_user_turns: set[tuple[int, int]] = set()
    with sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as conn:
        for retrieval_rank, item in enumerate(items):
            member_ids = _read_item_source_units(conn, item, question_id)
            locations: list[tuple[int, int]] = []
            for member_id_value in member_ids:
                location = evaluation.message_locations.get(member_id_value)
                if location is None:
                    raise ValueError(
                        f"case {question_id}: chunk member is absent from "
                        "source chats: "
                        f"{member_id_value}"
                    )
                session_index, turn_index = location
                if evaluation.sessions[session_index][turn_index]["role"] != "user":
                    raise ValueError(
                        f"case {question_id}: graph contains an assistant turn; "
                        "reconvert and rebuild with the user-only index"
                    )
                if location not in seen_user_turns:
                    locations.append(location)

            if not locations:
                # A message and a fact derived from it can both be retrieved.
                # Present the source dialogue once rather than duplicating it.
                continue
            item_id = str(item["id"])
            item_type = str(item.get("type") or "message").lower()
            # The official flat-turn generator treats each retrieved user turn
            # as a separate round and appends its immediately following turn.
            # A production chunk can represent several user turns, so emit one
            # HydratedItem per source unit rather than one disjoint pseudo-round.
            for session_index, turn_index in sorted(set(locations)):
                session = evaluation.sessions[session_index]
                turns = [session[turn_index]]
                if turn_index + 1 < len(session):
                    turns.append(session[turn_index + 1])
                seen_user_turns.add((session_index, turn_index))
                hydrated.append(
                    HydratedItem(
                        retrieval_rank=retrieval_rank,
                        session_index=session_index,
                        first_turn_index=turn_index,
                        session_date=evaluation.session_dates[session_index],
                        turns=turns,
                        source_item_type=item_type,
                        source_item_id=item_id,
                        source_unit_id=message_id(
                            question_id, session_index, turn_index
                        ),
                    )
                )

    if not hydrated:
        raise ValueError(f"case {question_id}: Ask produced no source dialogue")
    return hydrated


def _build_prompt(
    question: str,
    question_date: str,
    items: list[HydratedItem],
    *,
    max_retrieval_length: int,
) -> str:
    # The official generator presents retrieved source dialogue chronologically
    # rather than in retrieval-rank order.
    chronological = sorted(
        items,
        key=lambda item: (
            item.session_date,
            item.session_index,
            item.first_turn_index,
            item.retrieval_rank,
        ),
    )
    history: list[str] = []
    for prompt_index, item in enumerate(chronological, start=1):
        history.append(
            "\n".join(
                (
                    f"### Session {prompt_index}:",
                    f"Session Date: {item.session_date}",
                    "Session Content:",
                    json.dumps(item.turns, ensure_ascii=False),
                )
            )
        )
    if not history:
        raise ValueError("retrieved items contain no usable text")
    history_text = _truncate_retrieval_history(
        "\n\n".join(history), max_retrieval_length
    )
    return PROMPT_TEMPLATE.format(history_text, question_date, question)


def _build_retrieved_prompt(
    question: str,
    question_date: str,
    items: list[dict[str, Any]],
    *,
    backend: str,
    max_retrieval_length: int,
) -> str:
    """Use an external retrieval server's content in retrieval-rank order."""
    history: list[str] = []
    for rank, item in enumerate(items, 1):
        if not isinstance(item, dict):
            raise TypeError(f"{backend} item {rank} is not an object")
        content = item.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError(f"{backend} item {rank} has no content")
        item_type = str(item.get("type") or "chunk")
        history.append(
            "\n".join(
                (
                    f"### Retrieved Context {rank} [{item_type}]:",
                    content.strip(),
                )
            )
        )
    if not history:
        raise ValueError(f"{backend} retrieval returned no usable content")
    history_text = _truncate_retrieval_history(
        "\n\n".join(history), max_retrieval_length
    )
    return PROMPT_TEMPLATE.format(history_text, question_date, question)


def _truncate_retrieval_history(history: str, max_retrieval_length: int) -> str:
    """Apply LongMemEval's deterministic prefix truncation to retrieval text."""
    if max_retrieval_length < 1:
        raise ValueError("max_retrieval_length must be positive")
    try:
        import tiktoken

        tokenizer = tiktoken.get_encoding("o200k_base")
        tokens = tokenizer.encode(history, allowed_special={"<|endoftext|>"})
        if len(tokens) <= max_retrieval_length:
            return history
        return tokenizer.decode(tokens[:max_retrieval_length])
    except ImportError:
        # Tiktoken is optional in KL's production environment. Keep a stable
        # prefix with the same char/4 approximation used by ingestion.
        return history[: max_retrieval_length * 4]


def _retrieval_generation_inputs(
    ask_dir: Path,
    *,
    backend: str,
    max_retrieval_length: int,
) -> tuple[Path, list[str], list[tuple[str, str]]]:
    """Validate one ask artifact and construct direct-content prompts."""
    ask_dir = ask_dir.expanduser().resolve()
    run_path = ask_dir / "run.json"
    run = json.loads(run_path.read_text(encoding="utf-8"))
    if run.get("backend") != backend or run.get("benchmark") != "longmemeval":
        raise ValueError(f"not a LongMemEval {backend} ask run: {ask_dir}")
    if run.get("status") != "complete":
        raise ValueError(f"{backend} ask run is not complete: {ask_dir}")

    source = Path(str(run.get("source") or "")).expanduser().resolve()
    resolved_source, cases = load_cases(source)
    if source_fingerprint(resolved_source) != run.get("source_sha256"):
        raise ValueError("native LongMemEval source changed after the ask run")
    question_ids = run.get("question_ids")
    if (
        not isinstance(question_ids, list)
        or not question_ids
        or not all(isinstance(value, str) and value for value in question_ids)
        or len(question_ids) != len(set(question_ids))
    ):
        raise ValueError(f"{backend} ask run has invalid question_ids")

    results = list(json_lines(ask_dir / "results.jsonl"))
    result_ids = [row.get("question_id") for row in results]
    if result_ids != question_ids:
        raise ValueError(f"{backend} result IDs/order do not match run.json")
    by_id = cases_by_id(cases)
    prompts: list[tuple[str, str]] = []
    for result in results:
        question_id = str(result["question_id"])
        if question_id not in by_id:
            raise ValueError(f"{backend} result has unknown question ID: {question_id}")
        if result.get("status") != "completed":
            raise ValueError(f"{backend} retrieval did not complete: {question_id}")
        relative = Path(str(result.get("response_path") or ""))
        response_path = relative if relative.is_absolute() else ask_dir / relative
        response_path = response_path.resolve()
        if not response_path.is_relative_to(ask_dir):
            raise ValueError(
                f"{backend} response path escapes ask directory: {relative}"
            )
        response = json.loads(response_path.read_text(encoding="utf-8"))
        if response.get("question_id") != question_id:
            raise ValueError(f"{backend} response question ID mismatch: {question_id}")
        items = response.get("items")
        if not isinstance(items, list) or not items:
            raise ValueError(f"{backend} retrieval returned no items: {question_id}")
        case = by_id[question_id]
        prompts.append(
            (
                question_id,
                _build_retrieved_prompt(
                    str(case["question"]),
                    str(case["question_date"]),
                    items,
                    backend=backend,
                    max_retrieval_length=max_retrieval_length,
                ),
            )
        )
    return ask_dir, question_ids, prompts


def _ragflow_generation_inputs(
    ask_dir: Path,
    *,
    max_retrieval_length: int,
) -> tuple[Path, list[str], list[tuple[str, str]]]:
    return _retrieval_generation_inputs(
        ask_dir,
        backend="ragflow",
        max_retrieval_length=max_retrieval_length,
    )


def _khoj_generation_inputs(
    ask_dir: Path,
    *,
    max_retrieval_length: int,
) -> tuple[Path, list[str], list[tuple[str, str]]]:
    return _retrieval_generation_inputs(
        ask_dir,
        backend="khoj",
        max_retrieval_length=max_retrieval_length,
    )


async def _generate(prompt: str, config: GenerateConfig) -> str:
    api_key = provider_api_key(config.provider) or ""
    if not api_key:
        raise ValueError(f"API key for {config.provider!r} is required")
    response = await litellm.acompletion(
        model=provider_model(config.provider, config.model),
        messages=[{"role": "user", "content": prompt}],
        api_base=config.base_url,
        api_key=api_key,
        temperature=config.temperature,
        max_tokens=config.max_tokens,
        timeout=config.timeout_seconds,
        num_retries=config.max_retries,
    )
    hypothesis = (response.choices[0].message.content or "").strip()
    if not hypothesis:
        raise RuntimeError("generation model returned an empty response")
    return hypothesis


async def _generate_one(
    question_id: str,
    prompt: str,
    config: GenerateConfig,
    semaphore: asyncio.Semaphore,
    position: int,
    total: int,
) -> tuple[str, str]:
    """Generate one hypothesis while respecting the shared request limit."""
    async with semaphore:
        print(f"[{position}/{total}] generating {question_id}", flush=True)
        hypothesis = await _generate(prompt, config)
    return question_id, hypothesis


def _completed_rows(path: Path) -> dict[str, dict[str, str]]:
    completed: dict[str, dict[str, str]] = {}
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            question_id = row.get("question_id")
            hypothesis = row.get("hypothesis")
            if not isinstance(question_id, str) or not isinstance(hypothesis, str):
                raise TypeError(f"invalid hypothesis row at {path}:{line_number}")
            if question_id in completed:
                raise ValueError(f"duplicate hypothesis ID in {path}: {question_id}")
            completed[question_id] = {
                "question_id": question_id,
                "hypothesis": hypothesis,
            }
    return completed


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _generation_configuration(
    *,
    experiment: GenerateExperiment,
    root: Path,
    output: Path,
    question_ids: list[str],
    max_retrieval_length: int,
) -> dict[str, Any]:
    config = experiment.generate
    return {
        "benchmark": "longmemeval",
        "stage": "generate",
        "backend": "kl",
        "input_root": str(root),
        "output": str(output),
        "question_ids": question_ids,
        "ask_top_k": experiment.ask_top_k,
        **config.model_dump(),
        "prompt_reserve_tokens": PROMPT_RESERVE_TOKENS,
        "max_retrieval_length": max_retrieval_length,
        "fact_context_mode": FACT_CONTEXT_MODE,
    }


def _validate_resume_run(path: Path, expected: dict[str, Any]) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(
            "resume requires a generation run manifest; set run.mode=overwrite: "
            f"{path}"
        )
    existing = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(existing, dict):
        raise TypeError(f"generation run manifest is not an object: {path}")
    actual = existing.get("configuration")
    if actual != expected:
        raise ValueError(
            "generation configuration changed; set run.mode=overwrite"
        )
    return existing


async def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        experiment = load_generate_experiment(args.config)
    except (
        OSError,
        TypeError,
        ValueError,
        OmegaConfBaseException,
    ) as exc:
        print(f"error: invalid experiment configuration: {exc}", file=sys.stderr)
        return 2

    try:
        config = experiment.generate
        max_retrieval_length = (
            config.model_context_tokens - config.max_tokens - PROMPT_RESERVE_TOKENS
        )
        root, entries = _load_case_entries(experiment.case_set)
        selected = select_entries(entries, experiment.selection)
        manifest_order = [str(entry["question_id"]) for entry in selected]
        output = experiment.hypotheses
        run_path = Path(f"{output}.run.json")
        run_configuration = _generation_configuration(
            experiment=experiment,
            root=root,
            output=output,
            question_ids=manifest_order,
            max_retrieval_length=max_retrieval_length,
        )

        persisted: dict[str, dict[str, str]] = {}
        prior_run: dict[str, Any] = {}
        if output.exists() and experiment.run.mode == "resume":
            prior_run = _validate_resume_run(run_path, run_configuration)
            persisted = _completed_rows(output)

        unknown_ids = set(persisted).difference(manifest_order)
        if unknown_ids:
            raise ValueError(
                "output contains question IDs outside this selection: "
                f"{sorted(unknown_ids)[:5]}"
            )

        prompts: list[tuple[str, str]] = []
        for entry in selected:
            question_id = str(entry["question_id"])
            case_root = _resolve_manifest_path(root, entry["path"], "path")
            evaluation = _read_evaluation(case_root, question_id)
            items = _read_ask_items(case_root, question_id, experiment.ask_top_k)
            hydrated_items = _hydrate_items(
                case_root, question_id, evaluation, items
            )
            prompts.append(
                (
                    question_id,
                    _build_prompt(
                        evaluation.question,
                        evaluation.question_date,
                        hydrated_items,
                        max_retrieval_length=max_retrieval_length,
                    ),
                )
            )

        prompt_sha256_by_question = {
            question_id: hashlib.sha256(prompt.encode("utf-8")).hexdigest()
            for question_id, prompt in prompts
        }
        prior_hashes = prior_run.get("prompt_sha256_by_question") or {}
        if not isinstance(prior_hashes, dict):
            raise TypeError("generation run has invalid prompt fingerprints")
        completed = {
            question_id: row
            for question_id, row in persisted.items()
            if prior_hashes.get(question_id)
            == prompt_sha256_by_question.get(question_id)
        }
        pending = [
            (question_id, prompt)
            for question_id, prompt in prompts
            if question_id not in completed
        ]

        if args.dry_run:
            for question_id, prompt in pending:
                print(f"{question_id}: prompt_chars={len(prompt)}", flush=True)
            print(f"pending hypotheses: {len(pending)}", flush=True)
            return 0

        output.parent.mkdir(parents=True, exist_ok=True)
        started_at = (
            str(prior_run.get("started_at") or "")
            or datetime.now().astimezone().isoformat()
        )
        atomic_write_json(
            run_path,
            {
                "status": "running",
                "started_at": started_at,
                "configuration": run_configuration,
                "prompt_sha256_by_question": prompt_sha256_by_question,
                "completed_question_ids": [
                    question_id
                    for question_id in manifest_order
                    if question_id in completed
                ],
            },
        )

        def checkpoint() -> None:
            ordered = (
                completed[question_id]
                for question_id in manifest_order
                if question_id in completed
            )
            atomic_write_jsonl(
                output,
                ordered,
            )

        # Remove stale answers before making requests. In resume mode, only
        # rows whose prompt fingerprint still matches are retained.
        checkpoint()

        semaphore = asyncio.Semaphore(config.concurrency)
        tasks = [
            asyncio.create_task(
                _generate_one(
                    question_id,
                    prompt,
                    config,
                    semaphore,
                    position,
                    len(pending),
                )
            )
            for position, (question_id, prompt) in enumerate(pending, start=1)
        ]
        try:
            for completed_now, task in enumerate(
                asyncio.as_completed(tasks), start=1
            ):
                question_id, hypothesis = await task
                completed[question_id] = {
                    "question_id": question_id,
                    "hypothesis": hypothesis,
                }
                checkpoint()
                print(
                    f"[{completed_now}/{len(pending)}] saved {question_id}",
                    flush=True,
                )
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

        print(f"saved hypotheses: {output}", flush=True)
        atomic_write_json(
            run_path,
            {
                "status": "complete",
                "started_at": started_at,
                "completed_at": datetime.now().astimezone().isoformat(),
                "configuration": run_configuration,
                "prompt_sha256_by_question": prompt_sha256_by_question,
                "completed_question_ids": [
                    question_id
                    for question_id in manifest_order
                    if question_id in completed
                ],
                "hypotheses_sha256": _file_sha256(output),
            },
        )
        print(f"generation run: {run_path}", flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001 - report a resumable batch failure
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
