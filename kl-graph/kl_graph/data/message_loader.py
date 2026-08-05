"""Load messages from dataset (v4 spec).

The outer Scope + Record format is shared across datasets. Record payloads
remain source-native, so this loader accepts both DingTalk message fields and
the LoCoMo benchmark's message fields.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from kl_graph.models.types import Message


def _parse_timestamp(ts_str: str) -> int:
    """Parse supported source timestamp strings to Unix milliseconds."""
    if not isinstance(ts_str, str):
        return 0
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%I:%M %p on %d %B, %Y",  # LoCoMo session timestamps
        "%I:%M %p on %B %d, %Y",
    ):
        try:
            dt = datetime.strptime(ts_str.strip(), fmt)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    return 0


def _load_scopes(dataset_dir: Path) -> tuple[dict[str, str | None], dict[str, str]]:
    """Return scope parent and timestamp maps when scopes.jsonl is present."""
    path = dataset_dir / "scopes.jsonl"
    parents: dict[str, str | None] = {}
    timestamps: dict[str, str] = {}
    if not path.is_file():
        return parents, timestamps

    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                scope = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"Warning: skipping malformed scope JSONL line {line_number}: {exc}")
                continue
            scope_id = scope.get("id")
            if not isinstance(scope_id, str) or not scope_id:
                continue
            parents[scope_id] = scope.get("parent_id")
            data = scope.get("data") or {}
            if isinstance(data, dict) and data.get("session_datetime_raw"):
                timestamps[scope_id] = str(data["session_datetime_raw"])
    return parents, timestamps


def _root_scope_id(scope_id: str, parents: dict[str, str | None]) -> str:
    """Resolve a nested session scope to its top-level conversation scope."""
    current = scope_id
    visited: set[str] = set()
    while current and current not in visited:
        visited.add(current)
        parent = parents.get(current)
        if not parent:
            break
        current = parent
    return current


def load_all_from_dataset(dataset_dir: Path) -> list[Message]:
    """Load messages from a v4-spec artifacts directory (records.jsonl).

    Expects <dataset_dir>/records.jsonl. Filters records where type=="message"
    and returns a globally timestamp-sorted list[Message]. Source-native field
    aliases are normalized at this boundary; the artifact itself is unchanged.
    """
    records_path = dataset_dir / "records.jsonl"
    messages = []
    scope_parents, scope_timestamps = _load_scopes(dataset_dir)

    with open(records_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue

            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"Warning: skipping malformed JSONL line: {e}")
                continue

            if obj.get("type") != "message":
                continue

            data = obj.get("data") or {}
            if not isinstance(data, dict):
                continue

            content = str(data.get("content") or data.get("text") or "").strip()
            caption = str(data.get("blip_caption") or "").strip()
            if caption and caption not in content:
                content = f"{content}\n[Image: {caption}]" if content else f"[Image: {caption}]"
            if not content:
                continue

            reply_to = None
            if data.get("quotedMessage"):
                reply_to = data["quotedMessage"].get("openMessageId")

            scope_id = str(obj.get("scope_id") or "")
            message_id = str(data.get("openMessageId") or obj.get("id") or "")
            conversation_id = str(
                data.get("openConversationId")
                or _root_scope_id(scope_id, scope_parents)
                or scope_id
            )
            if not message_id or not conversation_id:
                continue

            timestamp = _parse_timestamp(
                data.get("createTime") or scope_timestamps.get(scope_id, "")
            )
            msg = Message(
                id=message_id,
                conversation_id=conversation_id,
                sender=str(data.get("sender") or data.get("speaker") or "unknown"),
                sender_id=data.get("senderOpenDingTalkId"),
                content=content,
                timestamp=timestamp,
                reply_to=reply_to,
            )
            messages.append(msg)

    messages.sort(key=lambda m: m.timestamp)
    return messages
