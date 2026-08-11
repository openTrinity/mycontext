"""Tests for the native LongMemEval Khoj evaluation boundary."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl
from kl_graph.evaluation.longmemeval.generate import _khoj_generation_inputs
from kl_graph.evaluation.longmemeval.khoj.ask import _normalise_items
from kl_graph.evaluation.longmemeval.khoj.build import _build_one, load_state
from kl_graph.evaluation.longmemeval.source import (
    render_document,
    source_fingerprint,
)

QUESTION_ID = "q/example"


def _case() -> dict:
    return {
        "question_id": QUESTION_ID,
        "question_type": "single-session-assistant",
        "question": "QUESTION_MUST_NOT_BE_UPLOADED",
        "question_date": "2025/01/03 (Fri) 12:00",
        "answer": "ANSWER_MUST_NOT_BE_UPLOADED",
        "answer_session_ids": ["session-1"],
        "haystack_sessions": [
            [
                {"role": "user", "content": "first user turn"},
                {
                    "role": "assistant",
                    "content": "ASSISTANT_MUST_NOT_BE_UPLOADED",
                },
                {"role": "user", "content": "second user turn"},
            ]
        ],
        "haystack_session_ids": ["session-1"],
        "haystack_dates": ["2025/01/01 (Wed) 10:00"],
    }


def _write_source(path: Path) -> None:
    path.write_text(json.dumps([_case()]), encoding="utf-8")


class _BuildClient:
    def __init__(self) -> None:
        self.documents: dict[str, str] = {}
        self.uploads: list[tuple[str, bytes]] = []

    def list_documents(self) -> set[str]:
        return set(self.documents)

    def get_document(self, filename: str) -> dict:
        return {
            "id": "document-1",
            "file_name": filename,
            "raw_text": self.documents[filename],
        }

    def upload_document(self, filename: str, content: bytes) -> None:
        self.uploads.append((filename, content))
        self.documents[filename] = content.decode()


def test_build_uploads_one_user_only_document_and_records_server_chunking(
    tmp_path: Path,
) -> None:
    source = tmp_path / "native.json"
    _write_source(source)
    client = _BuildClient()
    args = argparse.Namespace(
        artifact_root=tmp_path / "artifacts",
        document_prefix="longmemeval",
        base_url="http://127.0.0.1:42112",
        dry_run=False,
        resume=False,
    )

    _build_one(
        client,
        source,
        source_fingerprint(source),
        _case(),
        {"email": "default@example.com", "khoj_version": "test"},
        args,
        1,
        1,
    )

    assert len(client.uploads) == 1
    filename, content = client.uploads[0]
    assert filename.startswith("longmemeval-q_example-")
    assert content.decode() == render_document(_case())
    assert b"QUESTION_MUST_NOT_BE_UPLOADED" not in content
    assert b"ANSWER_MUST_NOT_BE_UPLOADED" not in content
    assert b"ASSISTANT_MUST_NOT_BE_UPLOADED" not in content
    state = load_state(args.artifact_root, QUESTION_ID)
    assert state["config"]["chunking_owner"] == "khoj_server"
    assert state["config"]["client_chunking"] is False
    assert state["remote_raw_text_sha256"] == hashlib.sha256(content).hexdigest()


def test_normalise_keeps_server_chunks_and_enforces_document_boundary() -> None:
    filename = "longmemeval-q_example-source.txt"
    items = _normalise_items(
        [
            {
                "entry": "fallback",
                "score": 0.2,
                "cross_score": 0.1,
                "corpus_id": "shared",
                "additional": {
                    "compiled": "[SESSION=0000] first chunk",
                    "file": filename,
                },
            },
            {
                "entry": "fallback",
                "score": 0.3,
                "cross_score": 0.2,
                "corpus_id": "shared",
                "additional": {
                    "compiled": "[SESSION=0001] second chunk",
                    "file": filename,
                },
            },
        ],
        top_k=5,
        expected_filename=filename,
    )

    assert [item["content"] for item in items] == [
        "[SESSION=0000] first chunk",
        "[SESSION=0001] second chunk",
    ]
    assert items[0]["rerank_distance"] == 0.1
    assert items[0]["document_name"] == filename


def test_generate_uses_khoj_chunk_content_directly(tmp_path: Path) -> None:
    source = tmp_path / "native.json"
    _write_source(source)
    ask_dir = tmp_path / "ask"
    atomic_write_json(
        ask_dir / "run.json",
        {
            "status": "complete",
            "backend": "khoj",
            "benchmark": "longmemeval",
            "source": str(source),
            "source_sha256": source_fingerprint(source),
            "question_ids": [QUESTION_ID],
        },
    )
    atomic_write_jsonl(
        ask_dir / "results.jsonl",
        [
            {
                "question_id": QUESTION_ID,
                "status": "completed",
                "response_path": "responses/q_example.json",
            }
        ],
    )
    raw_content = "[DATE=2025/01/01] USER: exact Khoj chunk text"
    atomic_write_json(
        ask_dir / "responses" / "q_example.json",
        {
            "question_id": QUESTION_ID,
            "items": [{"type": "chunk", "content": raw_content}],
        },
    )

    root, question_ids, prompts = _khoj_generation_inputs(ask_dir)

    assert root == ask_dir.resolve()
    assert question_ids == [QUESTION_ID]
    assert prompts[0][0] == QUESTION_ID
    assert raw_content in prompts[0][1]
    assert "QUESTION_MUST_NOT_BE_UPLOADED" in prompts[0][1]
    assert "ASSISTANT_MUST_NOT_BE_UPLOADED" not in prompts[0][1]
