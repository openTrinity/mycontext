"""Convert ``locomo10.json`` into one production DWS case per conversation."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from omegaconf.errors import OmegaConfBaseException

from .cases import CASE_SET_FORMAT, DATASET_NAME
from .experiment import convert_output_dir, load_convert_experiment

SCHEMA_VERSION = 1
_SESSION_FORMATS = ("%I:%M %p on %d %B, %Y", "%I:%M %p on %B %d, %Y")
_SESSION_KEY = re.compile(r"^session_(\d+)$")


def convert(
    input_path: Path,
    output_dir: Path,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    raw_input = input_path.expanduser().resolve()
    source = _resolve_source(raw_input)
    target = output_dir.expanduser().resolve()
    if (
        source == target
        or source.is_relative_to(target)
        or (raw_input.is_dir() and target.is_relative_to(raw_input))
    ):
        raise ValueError("input and output must not contain one another")
    if target.exists() and not overwrite:
        raise FileExistsError(f"output exists (pass --overwrite): {target}")

    samples = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(samples, list) or not samples:
        raise ValueError(f"expected a non-empty JSON list: {source}")

    records_by_conversation: dict[str, list[dict[str, Any]]] = defaultdict(list)
    evidence_by_conversation: dict[str, list[dict[str, str]]] = defaultdict(list)
    evaluation_by_conversation: dict[str, list[dict[str, Any]]] = defaultdict(list)
    titles: dict[str, str] = {}
    conversation_ids: list[str] = []
    source_order = 0
    for sample_index, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise TypeError(f"LoCoMo sample {sample_index} must be an object")
        sample_id = str(sample.get("sample_id") or "").strip()
        if not sample_id:
            raise ValueError(f"LoCoMo sample {sample_index} has no sample_id")
        conversation_id = f"chat:{sample_id}"
        if conversation_id in titles:
            raise ValueError(f"duplicate LoCoMo sample_id: {sample_id}")
        conversation = sample.get("conversation") or {}
        if not isinstance(conversation, dict):
            raise TypeError(f"sample {sample_id} conversation must be an object")
        conversation_ids.append(conversation_id)
        titles[conversation_id] = _conversation_title(conversation, conversation_id)

        for session_key in _session_keys(conversation):
            base_timestamp = _session_timestamp(
                conversation.get(f"{session_key}_date_time")
            )
            for message in conversation[session_key]:
                if not isinstance(message, dict):
                    continue
                dia_id = str(message.get("dia_id") or "").strip()
                if not dia_id:
                    continue
                converted, evidence = _convert_message(
                    message,
                    sample_id,
                    conversation_id,
                    base_timestamp,
                    source_order,
                )
                source_order += 1
                if converted is not None:
                    records_by_conversation[conversation_id].append(converted)
                if evidence is not None:
                    evidence_by_conversation[conversation_id].append(evidence)

        qa_rows = sample.get("qa") or []
        if not isinstance(qa_rows, list):
            raise TypeError(f"sample {sample_id} qa must be a list")
        for qa_index, qa in enumerate(qa_rows):
            if not isinstance(qa, dict):
                raise TypeError(f"sample {sample_id} qa[{qa_index}] must be an object")
            evaluation_by_conversation[conversation_id].append(
                {
                    "id": f"qa:{sample_id}/{qa_index}",
                    "sample_id": sample_id,
                    "chat_scope_id": conversation_id,
                    "data": dict(qa),
                }
            )

    for conversation_id in conversation_ids:
        if not records_by_conversation[conversation_id]:
            raise ValueError(f"conversation {conversation_id} has no messages")
        if not evaluation_by_conversation[conversation_id]:
            raise ValueError(f"conversation {conversation_id} has no evaluation rows")

    fingerprints = {source.name: _sha256(source)}
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target.name}.tmp-", dir=target.parent))
    try:
        manifest = _write_case_set(
            staging,
            source,
            titles,
            records_by_conversation,
            evidence_by_conversation,
            evaluation_by_conversation,
            conversation_ids,
            fingerprints,
        )
        if target.exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        staging.replace(target)
        return manifest
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _write_case_set(
    output: Path,
    source: Path,
    titles: dict[str, str],
    records: dict[str, list[dict[str, Any]]],
    evidence: dict[str, list[dict[str, str]]],
    evaluations: dict[str, list[dict[str, Any]]],
    conversation_ids: list[str],
    fingerprints: dict[str, str],
) -> dict[str, Any]:
    cases_root = output / "cases"
    cases_root.mkdir(parents=True)
    entries: list[dict[str, Any]] = []
    totals = Counter()
    seen_dirs: set[str] = set()
    for index, conversation_id in enumerate(conversation_ids):
        directory = quote(conversation_id, safe="-_.")
        key = directory.casefold()
        if key in seen_dirs:
            digest = hashlib.sha256(conversation_id.encode()).hexdigest()[:10]
            directory = f"{directory}-{digest}"
        seen_dirs.add(directory.casefold())
        case_root = cases_root / directory
        counts = _write_case(
            case_root,
            conversation_id,
            titles[conversation_id],
            records[conversation_id],
            evidence[conversation_id],
            evaluations[conversation_id],
            source,
            fingerprints,
            index,
        )
        totals.update(counts)
        entries.append(
            {
                "case_id": conversation_id,
                "conversation_id": conversation_id,
                "path": f"cases/{directory}",
                "dws_root": f"cases/{directory}/dws",
                "evaluation_file": f"cases/{directory}/evaluation.jsonl",
                "evidence_map_file": f"cases/{directory}/evidence_map.jsonl",
                "counts": counts,
            }
        )
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "format": CASE_SET_FORMAT,
        "dataset": DATASET_NAME,
        "graph_policy": "one LoCoMo conversation per isolated production KL_DATA_DIR",
        "ingestion_pipeline": "scripts.ingest",
        "production_chunking": True,
        "source": str(source),
        "source_sha256": fingerprints,
        "counts": {
            "cases": len(entries),
            "graphs": len(entries),
            "records": totals["records"],
            "evaluation_rows": totals["evaluation_rows"],
        },
        "case_entries": entries,
    }
    _write_json(output / "manifest.json", manifest)
    return manifest


def _write_case(
    root: Path,
    conversation_id: str,
    title: str,
    records: list[dict[str, Any]],
    evidence: list[dict[str, str]],
    evaluations: list[dict[str, Any]],
    source: Path,
    fingerprints: dict[str, str],
    index: int,
) -> dict[str, int]:
    chat = root / "dws" / "chat"
    chat.mkdir(parents=True)
    scope = {
        "id": conversation_id,
        "type": "chat",
        "parent_id": None,
        "data": {"title": title, "chat_kind": "direct"},
    }
    _write_jsonl(chat / "scopes.jsonl", [scope])
    _write_jsonl(chat / "records.jsonl", records)
    (chat / "resources.jsonl").write_text("", encoding="utf-8")
    _write_jsonl(root / "evaluation.jsonl", evaluations)
    _write_jsonl(root / "evidence_map.jsonl", evidence)
    counts = {
        "graphs": 1,
        "scopes": 1,
        "records": len(records),
        "evidence_rows": len(evidence),
        "evaluation_rows": len(evaluations),
        "resources": 0,
    }
    _write_json(
        chat / "manifest.json",
        {
            "schema_version": SCHEMA_VERSION,
            "dataset": DATASET_NAME,
            "case_id": conversation_id,
            "scope_types": ["chat"],
            "record_types": ["message"],
            "resource_kinds": [],
            "counts": counts,
        },
    )
    _write_json(
        root / "manifest.json",
        {
            "schema_version": SCHEMA_VERSION,
            "format": "kl-evaluation-case",
            "dataset": DATASET_NAME,
            "case_id": conversation_id,
            "conversation_id": conversation_id,
            "case_index": index,
            "graph_policy": "this conversation requires its own KL_DATA_DIR",
            "ingestion_pipeline": "scripts.ingest",
            "production_chunking": True,
            "source": str(source),
            "source_sha256": fingerprints,
            "dws_root": "dws",
            "evaluation_file": "evaluation.jsonl",
            "evidence_map_file": "evidence_map.jsonl",
            "gold_ingestion_policy": "evaluation and evidence files must not be ingested",
            "counts": counts,
        },
    )
    return counts


def _convert_message(
    data: dict[str, Any],
    sample_id: str,
    conversation_id: str,
    base_timestamp: int,
    source_order: int,
) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
    dia_id = str(data.get("dia_id") or "").strip()
    message_id = f"msg:{sample_id}/{dia_id.replace(':', '-')}"
    body = str(data.get("text") or data.get("content") or "").strip()
    caption = str(data.get("blip_caption") or "").strip()
    if caption and caption not in body:
        body = f"{body}\n[Image: {caption}]" if body else f"[Image: {caption}]"
    if not message_id or not body:
        return None, None
    # Stable source order prevents equal timestamps from changing message order.
    timestamp = base_timestamp + source_order if base_timestamp else source_order
    sender = str(data.get("speaker") or data.get("sender") or "unknown")
    converted = {
        "id": message_id,
        "scope_id": conversation_id,
        "type": "message",
        "data": {
            "content": body,
            "createTime": timestamp,
            "sender": sender,
            "senderOpenDingTalkId": None,
            "openMessageId": message_id,
            "openConversationId": conversation_id,
            "quotedMessage": None,
        },
    }
    evidence = {"source_message_id": message_id, "dia_id": dia_id}
    return converted, evidence


def _resolve_source(path: Path) -> Path:
    source = path / "locomo10.json" if path.is_dir() else path
    if not source.is_file():
        raise FileNotFoundError(f"LoCoMo source not found: {source}")
    return source


def _session_keys(conversation: dict[str, Any]) -> list[str]:
    sessions = []
    for key, value in conversation.items():
        match = _SESSION_KEY.fullmatch(key)
        if match and isinstance(value, list):
            sessions.append((int(match.group(1)), key))
    return [key for _, key in sorted(sessions)]


def _conversation_title(conversation: dict[str, Any], fallback: str) -> str:
    names = [
        str(conversation.get(field) or "").strip()
        for field in ("speaker_a", "speaker_b")
    ]
    names = [name for name in names if name]
    if names:
        return " / ".join(names)
    return fallback


def _session_timestamp(raw: Any) -> int:
    if not isinstance(raw, str):
        return 0
    normalized = raw.strip()
    for fmt in _SESSION_FORMATS:
        try:
            parsed = datetime.strptime(normalized, fmt).replace(tzinfo=timezone.utc)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError(f"invalid LoCoMo session timestamp: {raw!r}")


def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as stream:
        for row in rows:
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
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        experiment = load_convert_experiment(args.config)
        output = convert_output_dir(experiment)
        if args.dry_run:
            print(f"source={_resolve_source(experiment.source)}")
            print(f"case_set={output}")
            return 0
        manifest = convert(
            experiment.source,
            output,
            overwrite=experiment.convert.reconvert,
        )
    except (OSError, TypeError, ValueError, OmegaConfBaseException) as exc:
        print(f"error: invalid experiment configuration: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(manifest["counts"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
