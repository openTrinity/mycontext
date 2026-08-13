"""Read native LongMemEval cases and render backend-owned source documents."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from kl_graph.config import PROJECT_ROOT
from kl_graph.evaluation.longmemeval.convert import (
    DEFAULT_TIMEZONE,
    _required_list,
    _required_text,
    case_dir_name,
    message_id,
    parse_longmemeval_date,
)

DEFAULT_SOURCE = (
    PROJECT_ROOT.parents[1]
    / "benchmark"
    / "LongMemEval"
    / "data"
    / "longmemeval_s_sample100.json"
)


def resolve_source(path: Path) -> Path:
    source = path.expanduser().resolve()
    if source.is_dir():
        candidates = sorted(source.glob("*.json"))
        if len(candidates) != 1:
            raise ValueError(
                "LongMemEval source directory must contain exactly one JSON file: "
                f"{source}"
            )
        source = candidates[0]
    if not source.is_file():
        raise FileNotFoundError(source)
    return source


def source_fingerprint(path: Path) -> str:
    return hashlib.sha256(resolve_source(path).read_bytes()).hexdigest()


def load_cases(path: Path) -> tuple[Path, list[dict[str, Any]]]:
    """Load and validate the native array while preserving its original rows."""
    source = resolve_source(path)
    value = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(value, list) or not value:
        raise ValueError(
            f"native LongMemEval source must be a non-empty array: {source}"
        )

    timezone = ZoneInfo(DEFAULT_TIMEZONE)
    cases: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, case in enumerate(value):
        if not isinstance(case, dict):
            raise TypeError(f"LongMemEval case {index} must be an object")
        question_id = _required_text(case, "question_id")
        if question_id in seen:
            raise ValueError(f"duplicate LongMemEval question_id: {question_id}")
        _required_text(case, "question")
        _required_text(case, "question_type")
        question_date = _required_text(case, "question_date")
        parse_longmemeval_date(question_date, timezone)

        sessions = _required_list(case, "haystack_sessions")
        session_ids = _required_list(case, "haystack_session_ids")
        dates = _required_list(case, "haystack_dates")
        _required_list(case, "answer_session_ids")
        if not sessions:
            raise ValueError(f"case {question_id}: haystack is empty")
        if not (len(sessions) == len(session_ids) == len(dates)):
            raise ValueError(
                f"case {question_id}: haystack_sessions/session_ids/dates "
                "length mismatch"
            )

        for session_index, (session, session_id, date) in enumerate(
            zip(sessions, session_ids, dates, strict=True)
        ):
            if not isinstance(session_id, str) or not session_id.strip():
                raise ValueError(
                    f"case {question_id} session {session_index}: invalid session id"
                )
            if not isinstance(date, str) or not date.strip():
                raise ValueError(
                    f"case {question_id} session {session_index}: invalid date"
                )
            parse_longmemeval_date(date, timezone)
            if not isinstance(session, list) or not session:
                raise ValueError(
                    f"case {question_id} session {session_index}: "
                    "expected non-empty turn list"
                )
            for turn_index, turn in enumerate(session):
                if not isinstance(turn, dict):
                    raise TypeError(
                        f"case {question_id} session {session_index} turn "
                        f"{turn_index}: turn must be an object"
                    )
                if turn.get("role") not in {"user", "assistant"}:
                    raise ValueError(
                        f"case {question_id} session {session_index} turn "
                        f"{turn_index}: unsupported role {turn.get('role')!r}"
                    )
                if not isinstance(turn.get("content"), str):
                    raise TypeError(
                        f"case {question_id} session {session_index} turn "
                        f"{turn_index}: content must be text"
                    )
        seen.add(question_id)
        cases.append(case)
    return source, cases


def cases_by_id(cases: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(case["question_id"]): case for case in cases}


def select_cases(
    cases: list[dict[str, Any]],
    *,
    case_ids: list[str] | None,
    first: int | None,
) -> list[dict[str, Any]]:
    if case_ids:
        if len(case_ids) != len(set(case_ids)):
            raise ValueError("--case contains a duplicate question ID")
        by_id = cases_by_id(cases)
        unknown = [value for value in case_ids if value not in by_id]
        if unknown:
            raise ValueError(f"unknown LongMemEval question ID(s): {unknown}")
        return [by_id[value] for value in case_ids]
    if first is not None:
        return cases[:first]
    return cases


def render_document_turns(case: dict[str, Any]) -> list[tuple[str, str]]:
    """Render addressable user turns before a backend applies chunking."""
    question_id = str(case["question_id"])
    sessions = case["haystack_sessions"]
    session_ids = case["haystack_session_ids"]
    dates = case["haystack_dates"]
    rendered: list[tuple[str, str]] = []
    for session_index, (session, session_id, date) in enumerate(
        zip(sessions, session_ids, dates, strict=True)
    ):
        for turn_index, turn in enumerate(session):
            if turn["role"] != "user":
                continue
            content = str(turn["content"]).replace("\r\n", "\n").replace("\r", "\n")
            rendered.append(
                (
                    message_id(question_id, session_index, turn_index),
                    (
                        f"[SESSION={session_index:04d}] [SESSION_ID={session_id}] "
                        f"[DATE={date}] [TURN={turn_index:04d}] USER: {content}\n"
                    ),
                )
            )
    if not rendered:
        raise ValueError(f"case {question_id}: no user turns to upload")
    return rendered


def render_document(case: dict[str, Any]) -> str:
    """Join native user turns while leaving chunking to the target server."""
    return "".join(text for _, text in render_document_turns(case))


def document_fingerprint(case: dict[str, Any]) -> str:
    return hashlib.sha256(render_document(case).encode("utf-8")).hexdigest()


def case_root(artifact_root: Path, question_id: str) -> Path:
    return artifact_root.expanduser().resolve() / "cases" / case_dir_name(question_id)
