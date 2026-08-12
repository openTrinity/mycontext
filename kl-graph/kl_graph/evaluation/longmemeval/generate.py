#!/usr/bin/env python3
"""Generate LongMemEval hypotheses from cached KL, RAGFlow, or Khoj retrieval.

The prompt follows LongMemEval's direct retrieval-augmented generation format:
each retrieved user-only chunk (or a fact's source chunk) is mapped back to its
original user turns and their immediately following assistant turns, then the
rehydrated history is ordered chronologically. The prompt adds the current
date, question, and a plain ``Answer:`` suffix. Output is the benchmark's native
JSONL contract::

    {"question_id": "...", "hypothesis": "..."}

For RAGFlow and Khoj, the persisted server-owned chunk content is used directly
because it does not retain KL message IDs. The output can be passed to LongMemEval's official
``src/evaluation/evaluate_qa.py``. This module does not contain scoring logic.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from kl_graph.config import cfg
from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl, json_lines
from kl_graph.evaluation.longmemeval.build import (
    CASE_DATA_DIRNAME,
    DEFAULT_CASE_SET,
    _load_case_entries,
    _resolve_manifest_path,
    _select_entries,
)
from kl_graph.evaluation.longmemeval.convert import message_id
from kl_graph.evaluation.longmemeval.source import (
    cases_by_id,
    load_cases,
    source_fingerprint,
)
from kl_graph.utils.litellm_config import litellm, provider_api_key, provider_model

DEFAULT_OUTPUT_NAME = "hypotheses.jsonl"
DEFAULT_MAX_TOKENS = 500
DEFAULT_CONCURRENCY = 5
DEFAULT_MODEL_CONTEXT_TOKENS = 128_000
PROMPT_RESERVE_TOKENS = 1_000
DEFAULT_MAX_RETRIEVAL_LENGTH = (
    DEFAULT_MODEL_CONTEXT_TOKENS - DEFAULT_MAX_TOKENS - PROMPT_RESERVE_TOKENS
)
FACT_CONTEXT_MODE = "none"

LLM_PROVIDER = str(cfg.services.llm_flash.provider)
LLM_BASE_URL = str(cfg.services.llm_flash.base_url or "")
LLM_MAX_RETRIES = int(os.environ.get("KL_LLM_MAX_RETRIES", "2"))
LLM_MODEL = str(cfg.services.llm_flash.model)
LLM_TIMEOUT = float(cfg.services.llm_flash.timeout)

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


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate official-format LongMemEval hypotheses from cached "
            "KL, RAGFlow, or Khoj retrieval."
        )
    )
    parser.add_argument(
        "case_set",
        nargs="?",
        type=Path,
        default=DEFAULT_CASE_SET,
        help=f"converted LongMemEval root (default: {DEFAULT_CASE_SET})",
    )
    retrieval = parser.add_mutually_exclusive_group()
    retrieval.add_argument(
        "--ragflow-ask-dir",
        type=Path,
        default=None,
        help=(
            "completed LongMemEval RAGFlow ask run; its native source and "
            "selected cases replace the converted case set"
        ),
    )
    retrieval.add_argument(
        "--khoj-ask-dir",
        type=Path,
        default=None,
        help=(
            "completed LongMemEval Khoj ask run; its native source and "
            "selected cases replace the converted case set"
        ),
    )
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument(
        "--case", dest="case_ids", action="append", metavar="QUESTION_ID"
    )
    selection.add_argument("--first", type=_positive_int, metavar="N")
    selection.add_argument("--all", action="store_true")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help=(
            "hypothesis JSONL path (default: CASE_SET/hypotheses.jsonl, or "
            "the selected external ASK_DIR/hypotheses.jsonl)"
        ),
    )
    parser.add_argument("--model", default=LLM_MODEL)
    parser.add_argument("--base-url", default=LLM_BASE_URL)
    parser.add_argument(
        "--max-tokens",
        type=_positive_int,
        default=DEFAULT_MAX_TOKENS,
    )
    parser.add_argument(
        "--model-context-tokens",
        type=_positive_int,
        default=DEFAULT_MODEL_CONTEXT_TOKENS,
        help=(
            "model context-window size used to derive LongMemEval's retrieval "
            f"limit (default: {DEFAULT_MODEL_CONTEXT_TOKENS})"
        ),
    )
    parser.add_argument(
        "--concurrency",
        type=_positive_int,
        default=DEFAULT_CONCURRENCY,
        help=f"maximum concurrent generation calls (default: {DEFAULT_CONCURRENCY})",
    )
    output_mode = parser.add_mutually_exclusive_group()
    output_mode.add_argument("--overwrite", action="store_true")
    output_mode.add_argument(
        "--resume",
        action="store_true",
        help="append only cases not already present in the output JSONL",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate inputs and construct prompts without calling the model",
    )
    args = parser.parse_args(argv)
    has_selection = bool(args.case_ids or args.first is not None or args.all)
    external_ask_dir = args.ragflow_ask_dir or args.khoj_ask_dir
    if external_ask_dir is not None and has_selection:
        parser.error(
            "--case/--first/--all are not used with an external ask directory; "
            "the ask run already defines the subset"
        )
    if external_ask_dir is None and not has_selection:
        parser.error("one of --case, --first, or --all is required")
    if args.model_context_tokens <= args.max_tokens + PROMPT_RESERVE_TOKENS:
        parser.error(
            "--model-context-tokens must exceed --max-tokens plus the "
            f"{PROMPT_RESERVE_TOKENS}-token prompt reserve"
        )
    return args


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
                raise ValueError(
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


def _read_ask_items(case_root: Path, question_id: str) -> list[dict[str, Any]]:
    path = case_root / "results" / "ask_top5.json"
    artifact = json.loads(path.read_text(encoding="utf-8"))
    if artifact.get("question_id") != question_id:
        raise ValueError(f"ask result question ID mismatch: {question_id}")
    if artifact.get("force_phase2") is not False:
        raise ValueError(f"case {question_id}: ask result must have Phase 2 off")
    response = artifact.get("response")
    if not isinstance(response, dict):
        raise ValueError(f"case {question_id}: malformed ask response")
    items = response.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError(f"case {question_id}: ask returned no items")
    if len(items) > 5:
        raise ValueError(f"case {question_id}: expected at most five ask items")
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
                # A message and a fact derived from it can both reach Top-5.
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
        raise ValueError(f"case {question_id}: Top-5 produced no source dialogue")
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
    max_retrieval_length: int = DEFAULT_MAX_RETRIEVAL_LENGTH,
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
    max_retrieval_length: int = DEFAULT_MAX_RETRIEVAL_LENGTH,
) -> tuple[Path, list[str], list[tuple[str, str]]]:
    return _retrieval_generation_inputs(
        ask_dir,
        backend="ragflow",
        max_retrieval_length=max_retrieval_length,
    )


def _khoj_generation_inputs(
    ask_dir: Path,
    *,
    max_retrieval_length: int = DEFAULT_MAX_RETRIEVAL_LENGTH,
) -> tuple[Path, list[str], list[tuple[str, str]]]:
    return _retrieval_generation_inputs(
        ask_dir,
        backend="khoj",
        max_retrieval_length=max_retrieval_length,
    )


async def _generate(prompt: str, args: argparse.Namespace) -> str:
    if not args.base_url:
        raise ValueError("KL_LLM_BASE_URL or --base-url is required")
    api_key = provider_api_key(LLM_PROVIDER) or ""
    if not api_key:
        raise ValueError(f"API key for {LLM_PROVIDER!r} is required")
    response = await litellm.acompletion(
        model=provider_model(LLM_PROVIDER, args.model),
        messages=[{"role": "user", "content": prompt}],
        api_base=args.base_url,
        api_key=api_key,
        temperature=0,
        max_tokens=args.max_tokens,
        timeout=LLM_TIMEOUT,
        num_retries=LLM_MAX_RETRIES,
    )
    hypothesis = (response.choices[0].message.content or "").strip()
    if not hypothesis:
        raise RuntimeError("generation model returned an empty response")
    return hypothesis


async def _generate_one(
    question_id: str,
    prompt: str,
    args: argparse.Namespace,
    semaphore: asyncio.Semaphore,
    position: int,
    total: int,
) -> tuple[str, str]:
    """Generate one hypothesis while respecting the shared request limit."""
    async with semaphore:
        print(f"[{position}/{total}] generating {question_id}", flush=True)
        hypothesis = await _generate(prompt, args)
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
                raise ValueError(f"invalid hypothesis row at {path}:{line_number}")
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
    args: argparse.Namespace,
    backend: str,
    root: Path,
    output: Path,
    max_retrieval_length: int,
) -> dict[str, Any]:
    return {
        "benchmark": "longmemeval",
        "stage": "generate",
        "backend": backend,
        "input_root": str(root),
        "output": str(output),
        "model": args.model,
        "base_url": args.base_url,
        "max_tokens": args.max_tokens,
        "model_context_tokens": args.model_context_tokens,
        "prompt_reserve_tokens": PROMPT_RESERVE_TOKENS,
        "max_retrieval_length": max_retrieval_length,
        "fact_context_mode": FACT_CONTEXT_MODE if backend == "kl" else None,
    }


def _validate_resume_run(path: Path, expected: dict[str, Any]) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(
            f"resume requires a generation run manifest; use --overwrite: {path}"
        )
    existing = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(existing, dict):
        raise TypeError(f"generation run manifest is not an object: {path}")
    actual = existing.get("configuration")
    if actual != expected:
        raise ValueError(
            "generation configuration changed; use --overwrite instead of --resume"
        )
    return existing


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        max_retrieval_length = (
            args.model_context_tokens - args.max_tokens - PROMPT_RESERVE_TOKENS
        )
        retrieval_prompts: list[tuple[str, str]] | None = None
        selected: list[dict[str, Any]] = []
        if args.ragflow_ask_dir is not None:
            backend = "ragflow"
            root, manifest_order, retrieval_prompts = _ragflow_generation_inputs(
                args.ragflow_ask_dir,
                max_retrieval_length=max_retrieval_length,
            )
        elif args.khoj_ask_dir is not None:
            backend = "khoj"
            root, manifest_order, retrieval_prompts = _khoj_generation_inputs(
                args.khoj_ask_dir,
                max_retrieval_length=max_retrieval_length,
            )
        else:
            backend = "kl"
            root, entries = _load_case_entries(args.case_set)
            selected = _select_entries(entries, args)
            manifest_order = [entry["question_id"] for entry in entries]
        output = (
            args.output.expanduser().resolve()
            if args.output is not None
            else root / DEFAULT_OUTPUT_NAME
        )
        run_path = Path(f"{output}.run.json")
        run_configuration = _generation_configuration(
            args=args,
            backend=backend,
            root=root,
            output=output,
            max_retrieval_length=max_retrieval_length,
        )

        completed: dict[str, dict[str, str]] = {}
        prior_run: dict[str, Any] = {}
        if output.exists():
            if args.resume:
                prior_run = _validate_resume_run(run_path, run_configuration)
                completed = _completed_rows(output)
            elif not args.overwrite and not args.dry_run:
                raise FileExistsError(
                    f"output exists; pass --overwrite or --resume: {output}"
                )

        pending: list[tuple[str, str]] = []
        if retrieval_prompts is not None:
            pending = [
                (question_id, prompt)
                for question_id, prompt in retrieval_prompts
                if question_id not in completed
            ]
        else:
            for entry in selected:
                question_id = entry["question_id"]
                if question_id in completed:
                    continue
                case_root = _resolve_manifest_path(root, entry["path"], "path")
                evaluation = _read_evaluation(case_root, question_id)
                items = _read_ask_items(case_root, question_id)
                hydrated_items = _hydrate_items(
                    case_root, question_id, evaluation, items
                )
                pending.append(
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

        if args.dry_run:
            for question_id, prompt in pending:
                print(f"{question_id}: prompt_chars={len(prompt)}", flush=True)
            print(f"pending hypotheses: {len(pending)}", flush=True)
            return 0

        output.parent.mkdir(parents=True, exist_ok=True)
        unknown_ids = set(completed).difference(manifest_order)
        if unknown_ids:
            raise ValueError(
                f"output contains question IDs outside this case set: "
                f"{sorted(unknown_ids)[:5]}"
            )

        prompt_sha256_by_question = {
            str(key): str(value)
            for key, value in (prior_run.get("prompt_sha256_by_question") or {}).items()
        }
        prompt_sha256_by_question.update(
            {
                question_id: hashlib.sha256(prompt.encode("utf-8")).hexdigest()
                for question_id, prompt in pending
            }
        )
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

        # Preserve the old --overwrite contract: clear an existing output
        # before the first model call. An empty file is also a valid resume
        # checkpoint if the process is interrupted before any request finishes.
        if not args.resume or not output.exists():
            checkpoint()

        semaphore = asyncio.Semaphore(args.concurrency)
        tasks = [
            asyncio.create_task(
                _generate_one(
                    question_id,
                    prompt,
                    args,
                    semaphore,
                    position,
                    len(pending),
                )
            )
            for position, (question_id, prompt) in enumerate(pending, start=1)
        ]
        try:
            completed_now = 0
            for task in asyncio.as_completed(tasks):
                question_id, hypothesis = await task
                completed[question_id] = {
                    "question_id": question_id,
                    "hypothesis": hypothesis,
                }
                checkpoint()
                completed_now += 1
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
