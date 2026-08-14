"""Prepare one independent DWS chat input for each LongMemEval case.

The output is a case set, not one shared corpus::

    OUTPUT/
      manifest.json
      cases/
        QUESTION_ID/
          manifest.json
          evaluation.jsonl       # Gold + full source chats; never ingested
          dws/
            chat/
              manifest.json
              scopes.jsonl
              records.jsonl
              resources.jsonl

Each case directory is intended to use its own ``KL_DATA_DIR`` and therefore
its own SQLite, Qdrant, and graph stores. Within a case, every authoritative
LongMemEval session becomes a separate chat conversation/scope. This preserves
session boundaries using the production DWS contract without adding benchmark-
specific ``namespace_id`` or ``session_id`` fields to the ingestion pipeline.

To match the official LongMemEval retrieval protocol, only ``role=user`` turns
are written to DWS and indexed. The complete source chats, including assistant
turns, stay in ``evaluation.jsonl`` so generation can restore the assistant
reply following a retrieved user turn. Only ``CASE/dws`` is passed as
``KL_DWS_EXPORT_DIR``; questions, answers, and assistant turns therefore cannot
enter chunks, embeddings, extraction, or the graph.

Usage::

    python -m kl_graph.evaluation.longmemeval.convert \
      --config /path/to/experiment.yaml
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from kl_graph.evaluation.longmemeval.experiment import (
    convert_output_dir,
    load_convert_experiment,
)

DATASET_NAME = "longmemeval"
SCHEMA_VERSION = 3
DEFAULT_TIMEZONE = "Asia/Shanghai"

_DATE_RE = re.compile(
    r"^(?P<date>\d{4}/\d{2}/\d{2})\s+"
    r"\((?P<weekday>[A-Za-z]{3})\)\s+"
    r"(?P<time>\d{2}:\d{2})$"
)


@dataclass(frozen=True)
class CaseRows:
    """DWS and evaluation rows produced from one LongMemEval case."""

    scopes: list[dict[str, Any]]
    records: list[dict[str, Any]]
    evaluation: dict[str, Any]
    session_count: int
    source_turn_count: int
    excluded_assistant_turns: int
    empty_content_records: int


def case_dir_name(question_id: str) -> str:
    """Return a reversible path-safe directory component for a case ID."""
    return quote(question_id, safe="-_.")


def conversation_id(question_id: str, session_index: int) -> str:
    """Return the production chat boundary for one source session."""
    return f"conversation:longmemeval/{_id_component(question_id)}/{session_index:04d}"


def conversation_scope_id(question_id: str, session_index: int) -> str:
    return f"chat:longmemeval/{_id_component(question_id)}/{session_index:04d}"


def message_id(question_id: str, session_index: int, turn_index: int) -> str:
    return (
        f"msg:longmemeval/{_id_component(question_id)}/"
        f"{session_index:04d}/{turn_index:04d}"
    )


def evaluation_id(question_id: str) -> str:
    return f"qa:longmemeval/{_id_component(question_id)}"


def parse_longmemeval_date(value: str, timezone: ZoneInfo) -> int:
    """Parse ``YYYY/MM/DD (Day) HH:MM`` into epoch milliseconds.

    LongMemEval records wall-clock values without a timezone. The selected
    timezone is recorded in every manifest. The weekday token is intentionally
    not trusted, avoiding locale-dependent ``%a`` parsing.
    """
    if not isinstance(value, str):
        raise TypeError(
            f"LongMemEval date must be a string, got {type(value).__name__}"
        )
    match = _DATE_RE.fullmatch(value.strip())
    if match is None:
        raise ValueError(
            f"invalid LongMemEval date {value!r}; expected YYYY/MM/DD (Day) HH:MM"
        )
    parsed = datetime.strptime(
        f"{match.group('date')} {match.group('time')}", "%Y/%m/%d %H:%M"
    ).replace(tzinfo=timezone)
    return int(parsed.timestamp() * 1000)


def build_case_rows(case: dict[str, Any], timezone: ZoneInfo) -> CaseRows:
    """Validate and convert one case into isolated production-readable rows."""
    if not isinstance(case, dict):
        raise TypeError("each LongMemEval case must be a JSON object")

    question_id = _required_text(case, "question_id")
    question = _required_text(case, "question")
    question_type = _required_text(case, "question_type")
    question_date = _required_text(case, "question_date")
    question_timestamp = parse_longmemeval_date(question_date, timezone)

    sessions = _required_list(case, "haystack_sessions")
    source_session_ids = _required_list(case, "haystack_session_ids")
    source_dates = _required_list(case, "haystack_dates")
    answer_session_ids = _required_list(case, "answer_session_ids")
    if not (len(sessions) == len(source_session_ids) == len(source_dates)):
        raise ValueError(
            f"case {question_id}: haystack_sessions/session_ids/dates length mismatch "
            f"({len(sessions)}/{len(source_session_ids)}/{len(source_dates)})"
        )

    scopes: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    source_to_conversations: dict[str, list[str]] = defaultdict(list)
    session_rows: list[dict[str, Any]] = []
    source_turn_count = 0
    excluded_assistant_turns = 0
    empty_content_records = 0

    for session_index, (session, raw_session_id, raw_date) in enumerate(
        zip(sessions, source_session_ids, source_dates, strict=True)
    ):
        if not isinstance(session, list) or not session:
            raise ValueError(
                f"case {question_id} session {session_index}: "
                "expected non-empty turn list"
            )
        if not isinstance(raw_session_id, str) or not raw_session_id.strip():
            raise ValueError(
                f"case {question_id} session {session_index}: invalid source session id"
            )
        if not isinstance(raw_date, str) or not raw_date.strip():
            raise ValueError(
                f"case {question_id} session {session_index}: "
                "session date must be non-empty text"
            )

        raw_session_id = raw_session_id.strip()
        raw_date = raw_date.strip()
        base_timestamp = parse_longmemeval_date(raw_date, timezone)
        conv_id = conversation_id(question_id, session_index)
        scope_id = conversation_scope_id(question_id, session_index)
        source_to_conversations[raw_session_id].append(conv_id)
        session_rows.append(
            {
                "session_index": session_index,
                "source_session_id": raw_session_id,
                "source_session_date": raw_date,
                "conversation_id": conv_id,
                "scope_id": scope_id,
            }
        )

        # A separate scope/conversation is the session boundary. The production
        # loader groups messages by conversation before applying its idle-gap
        # heuristic, so equal timestamps in two source sessions cannot merge or
        # interleave them.
        scopes.append(
            {
                "id": scope_id,
                "type": "chat",
                "parent_id": None,
                "data": {
                    "chat_kind": "group",
                    "title": (
                        f"LongMemEval case {question_id} session {session_index:04d}"
                    ),
                    "openConversationId": conv_id,
                    "benchmark": DATASET_NAME,
                    "case_id": question_id,
                    "source_session_id": raw_session_id,
                    "source_session_index": session_index,
                    "source_session_date": raw_date,
                },
            }
        )

        for turn_index, turn in enumerate(session):
            source_turn_count += 1
            if not isinstance(turn, dict):
                raise TypeError(
                    f"case {question_id} session {session_index} "
                    f"turn {turn_index}: turn must be an object"
                )
            role = turn.get("role")
            content = turn.get("content")
            if role not in {"user", "assistant"}:
                raise ValueError(
                    f"case {question_id} session {session_index} "
                    f"turn {turn_index}: unsupported role {role!r}"
                )
            if not isinstance(content, str):
                raise TypeError(
                    f"case {question_id} session {session_index} "
                    f"turn {turn_index}: content must be text"
                )

            # Official LongMemEval retrieval indexes only user messages. Keep
            # validating assistant turns, but retain them solely in the full
            # source chats stored outside DWS for generation-time rehydration.
            if role == "assistant":
                excluded_assistant_turns += 1
                continue

            if not content:
                # Preserve the source row. The production loader applies its
                # normal empty-content rule when the case is ingested.
                empty_content_records += 1

            record_id = message_id(question_id, session_index, turn_index)
            records.append(
                {
                    "id": record_id,
                    "scope_id": scope_id,
                    "type": "message",
                    "data": {
                        "content": content,
                        "createTime": base_timestamp + turn_index,
                        "sender": role,
                        "senderOpenDingTalkId": (f"longmemeval:{question_id}:{role}"),
                        "openMessageId": record_id,
                        "openConversationId": conv_id,
                        "quotedMessage": None,
                        "source_session_id": raw_session_id,
                        "source_session_date": raw_date,
                        "turn_index": turn_index,
                        "role": role,
                    },
                }
            )

    answer_conversation_ids: list[str] = []
    for raw_answer_session_id in answer_session_ids:
        if not isinstance(raw_answer_session_id, str) or not raw_answer_session_id:
            raise ValueError(
                f"case {question_id}: answer_session_ids must contain non-empty strings"
            )
        matches = source_to_conversations.get(raw_answer_session_id, [])
        if not matches:
            raise ValueError(
                f"case {question_id}: answer session {raw_answer_session_id!r} "
                "is absent from the haystack"
            )
        answer_conversation_ids.extend(matches)

    evaluation = {
        "id": evaluation_id(question_id),
        "type": "benchmark_question",
        "data": {
            "question_id": question_id,
            "question": question,
            "answer": case.get("answer"),
            "question_type": question_type,
            "question_date": question_date,
            "question_timestamp": question_timestamp,
            "answer_session_ids": list(answer_session_ids),
            # Retrieval returns chunks/facts whose source chunk retains the
            # generated conversation id, so this is the Gold join boundary.
            "answer_conversation_ids": answer_conversation_ids,
            "sessions": session_rows,
            # These fields mirror the official retrieval artifact. They remain
            # outside the DWS root and let generation restore the assistant
            # turn following a user-only retrieval hit.
            "haystack_sessions": sessions,
            "haystack_session_ids": list(source_session_ids),
            "haystack_dates": list(source_dates),
            "is_abstention": question_id.endswith("_abs"),
        },
    }
    return CaseRows(
        scopes=scopes,
        records=records,
        evaluation=evaluation,
        session_count=len(sessions),
        source_turn_count=source_turn_count,
        excluded_assistant_turns=excluded_assistant_turns,
        empty_content_records=empty_content_records,
    )


def convert(
    input_path: Path,
    output_dir: Path,
    *,
    overwrite: bool,
    timezone_name: str,
) -> dict[str, Any]:
    """Convert a LongMemEval JSON array into independent per-case bundles."""
    input_path = input_path.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"LongMemEval input not found: {input_path}")
    if input_path == output_dir or _is_relative_to(input_path, output_dir):
        raise ValueError("output directory cannot be the input file or contain it")
    if output_dir.exists() and not overwrite:
        raise FileExistsError(f"output exists (pass --overwrite): {output_dir}")
    try:
        timezone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"unknown timezone: {timezone_name}") from exc

    with input_path.open("r", encoding="utf-8") as stream:
        cases = json.load(stream)
    if not isinstance(cases, list):
        raise TypeError(f"expected a top-level JSON array in {input_path}")

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output_dir.name}.tmp-", dir=output_dir.parent)
    )
    try:
        manifest = _write_case_set(
            cases,
            input_path=input_path,
            output_dir=staging,
            timezone=timezone,
            timezone_name=timezone_name,
        )
        if output_dir.exists():
            if output_dir.is_dir():
                shutil.rmtree(output_dir)
            else:
                output_dir.unlink()
        staging.replace(output_dir)
        return manifest
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _write_case_set(
    cases: list[Any],
    *,
    input_path: Path,
    output_dir: Path,
    timezone: ZoneInfo,
    timezone_name: str,
) -> dict[str, Any]:
    cases_root = output_dir / "cases"
    cases_root.mkdir(parents=True)

    source_sha256 = _sha256(input_path)
    question_ids: set[str] = set()
    case_dir_keys: set[str] = set()
    case_entries: list[dict[str, Any]] = []
    totals = Counter()
    question_types: Counter[str] = Counter()

    for case_index, case in enumerate(cases):
        rows = build_case_rows(case, timezone)
        data = rows.evaluation["data"]
        question_id = data["question_id"]
        if question_id in question_ids:
            raise ValueError(f"duplicate LongMemEval question_id: {question_id}")
        question_ids.add(question_id)

        directory_name = case_dir_name(question_id)
        directory_key = directory_name.casefold()
        if directory_key in case_dir_keys:
            raise ValueError(
                f"case directory collision after path encoding: {question_id}"
            )
        case_dir_keys.add(directory_key)

        case_root = cases_root / directory_name
        counts = _write_case_bundle(
            case_root,
            rows,
            input_path=input_path,
            source_sha256=source_sha256,
            timezone_name=timezone_name,
            case_index=case_index,
        )
        case_entries.append(
            {
                "question_id": question_id,
                "path": f"cases/{directory_name}",
                "dws_root": f"cases/{directory_name}/dws",
                "evaluation_file": f"cases/{directory_name}/evaluation.jsonl",
                "counts": counts,
            }
        )
        totals.update(counts)
        question_types[data["question_type"]] += 1

    counts = {
        "cases": len(case_entries),
        "graphs": len(case_entries),
        "scopes": totals["scopes"],
        "sessions": totals["sessions"],
        "source_turns": totals["source_turns"],
        "records": totals["records"],
        "excluded_assistant_turns": totals["excluded_assistant_turns"],
        "resources": totals["resources"],
        "evaluation_rows": totals["evaluation_rows"],
        "empty_content_records": totals["empty_content_records"],
        "abstention_cases": totals["abstention_cases"],
    }
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "format": "kl-evaluation-case-set",
        "dataset": DATASET_NAME,
        "graph_policy": "one LongMemEval case per isolated KL_DATA_DIR",
        "retrieval_index_policy": "DWS contains role=user turns only",
        "source": str(input_path),
        "source_sha256": source_sha256,
        "timezone": timezone_name,
        "counts": counts,
        "question_types": dict(sorted(question_types.items())),
        "case_entries": case_entries,
    }
    _write_json(output_dir / "manifest.json", manifest)
    return manifest


def _write_case_bundle(
    case_root: Path,
    rows: CaseRows,
    *,
    input_path: Path,
    source_sha256: str,
    timezone_name: str,
    case_index: int,
) -> dict[str, int]:
    question_id = rows.evaluation["data"]["question_id"]
    chat_dir = case_root / "dws" / "chat"
    chat_dir.mkdir(parents=True)

    record_ids: set[str] = set()
    with (chat_dir / "scopes.jsonl").open("w", encoding="utf-8") as stream:
        for scope in rows.scopes:
            _write_jsonl_row(stream, scope)
    with (chat_dir / "records.jsonl").open("w", encoding="utf-8") as stream:
        for record in rows.records:
            record_id = str(record["id"])
            if record_id in record_ids:
                raise ValueError(
                    f"case {question_id}: duplicate generated record id {record_id}"
                )
            record_ids.add(record_id)
            _write_jsonl_row(stream, record)
    (chat_dir / "resources.jsonl").write_text("", encoding="utf-8")
    with (case_root / "evaluation.jsonl").open("w", encoding="utf-8") as stream:
        _write_jsonl_row(stream, rows.evaluation)

    counts = {
        "graphs": 1,
        "scopes": len(rows.scopes),
        "sessions": rows.session_count,
        "source_turns": rows.source_turn_count,
        "records": len(rows.records),
        "excluded_assistant_turns": rows.excluded_assistant_turns,
        "resources": 0,
        "evaluation_rows": 1,
        "empty_content_records": rows.empty_content_records,
        "abstention_cases": int(rows.evaluation["data"]["is_abstention"]),
    }
    chat_manifest = {
        "schema_version": SCHEMA_VERSION,
        "source": str(input_path),
        "source_sha256": source_sha256,
        "dataset": DATASET_NAME,
        "case_id": question_id,
        "timezone": timezone_name,
        "retrieval_index_policy": "DWS contains role=user turns only",
        "scope_types": ["chat"],
        "record_types": ["message"],
        "resource_kinds": [],
        "counts": {
            key: counts[key]
            for key in (
                "scopes",
                "sessions",
                "source_turns",
                "records",
                "excluded_assistant_turns",
                "resources",
                "empty_content_records",
            )
        },
    }
    _write_json(chat_dir / "manifest.json", chat_manifest)

    case_manifest = {
        "schema_version": SCHEMA_VERSION,
        "format": "kl-evaluation-case",
        "dataset": DATASET_NAME,
        "case_id": question_id,
        "case_index": case_index,
        "graph_policy": "this case requires its own isolated KL_DATA_DIR",
        "retrieval_index_policy": "DWS contains role=user turns only",
        "source": str(input_path),
        "source_sha256": source_sha256,
        "timezone": timezone_name,
        "dws_root": "dws",
        "dws_sources": ["chat"],
        "evaluation_file": "evaluation.jsonl",
        "gold_ingestion_policy": (
            "evaluation.jsonl is query-time only and must not be ingested"
        ),
        "counts": counts,
    }
    _write_json(case_root / "manifest.json", case_manifest)
    return counts


def _required_text(row: dict[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"LongMemEval field {key!r} must be non-empty text")
    return value.strip()


def _required_list(row: dict[str, Any], key: str) -> list[Any]:
    value = row.get(key)
    if not isinstance(value, list):
        raise TypeError(f"LongMemEval field {key!r} must be a list")
    return value


def _id_component(value: str) -> str:
    return quote(value, safe="-_.")


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _write_jsonl_row(stream, row: dict[str, Any]) -> None:
    stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
    stream.write("\n")


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        required=True,
        help="LongMemEval experiment YAML",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    experiment = load_convert_experiment(args.config)
    manifest = convert(
        experiment.source,
        convert_output_dir(experiment),
        overwrite=experiment.convert.reconvert,
        timezone_name=experiment.convert.timezone,
    )
    json.dump(manifest["counts"], sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
