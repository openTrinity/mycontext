import argparse
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from kl_graph.evaluation.locomo.runners.ragflow.ask import _normalise_items
from kl_graph.evaluation.locomo.runners.ragflow.build import _build_one
from kl_graph.evaluation.locomo.runners.ragflow.source import (
    extract_dia_ids,
    question_rows,
    render_transcript,
)
from kl_graph.evaluation.ragflow.client import RagflowEvaluationClient


def _native_sample() -> dict:
    return {
        "sample_id": "conv-test",
        "conversation": {
            "speaker_a": "A",
            "speaker_b": "B",
            "session_2_date_time": "2 pm on 2 May, 2023",
            "session_2": [
                {"speaker": "B", "dia_id": "D2:1", "text": "Second"}
            ],
            "session_1_date_time": "1 pm on 1 May, 2023",
            "session_1": [
                {"speaker": "A", "dia_id": "D1:1", "text": "First"}
            ],
        },
        "qa": [
            {
                "question": "What happened first?",
                "answer": "First",
                "evidence": ["D1:1"],
                "category": 4,
            }
        ],
    }


def test_transcript_is_one_ordered_native_conversation() -> None:
    transcript = render_transcript(_native_sample())

    assert transcript.index("D1:1") < transcript.index("D2:1")
    assert "[DATE=1 pm on 1 May, 2023] A: First" in transcript
    assert extract_dia_ids(transcript) == ["D1:1", "D2:1"]
    assert question_rows([_native_sample()])[0]["id"] == "qa:conv-test/0"


def test_items_prepend_graph_and_keep_exact_top_k() -> None:
    chunks = [
        {
            "id": "g",
            "content": "Graph evidence D1:1",
            "document_id": "",
            "document_name": "Related content in Knowledge Graph",
            "similarity": 1,
        },
        {
            "id": "c1",
            "content": "Chunk D2:1",
            "document_id": "doc",
            "document_name": "conv-test.txt",
            "similarity": 0.8,
        },
        {
            "id": "c2",
            "content": "Chunk D2:2",
            "document_id": "doc",
            "document_name": "conv-test.txt",
            "similarity": 0.7,
        },
    ]

    items, graph_count = _normalise_items(chunks, top_k=2)

    assert graph_count == 1
    assert [item["id"] for item in items] == ["g", "c1"]
    assert items[0]["type"] == "graph"
    assert items[0]["dia_ids"] == ["D1:1"]


class _Response:
    def __init__(self, value: dict):
        self.value = value

    def json(self) -> dict:
        return self.value


class _SDK:
    def post(self, path: str):
        assert path.endswith("/index?type=graph")
        return _Response({"code": 0, "data": {"task_id": "task-1"}})

    def get(self, path: str, params=None):
        assert params == {"type": "graph"}
        return _Response(
            {"code": 0, "data": {"id": "task-1", "progress": 1.0}}
        )


def test_client_wraps_untyped_graph_api() -> None:
    client = RagflowEvaluationClient("key", sdk=_SDK())

    assert client.start_graph("dataset-1") == "task-1"
    assert client.graph_state("dataset-1")["state"] == "complete"


class _FailedParseClient:
    def create_dataset(self, **_kwargs):
        return SimpleNamespace(id="dataset-1")

    def upload_document(self, _dataset, *, name: str, content: bytes):
        assert name == "conv-test.txt"
        assert b"DIA_ID=D1:1" in content
        return SimpleNamespace(id="document-1")

    def document_state(self, _dataset, _document_id: str) -> dict:
        return {
            "state": "failed" if getattr(self, "started", False) else "unstarted",
            "run": "FAIL" if getattr(self, "started", False) else "UNSTART",
            "progress": -1.0 if getattr(self, "started", False) else 0.0,
            "progress_message": "embedding unavailable",
            "chunk_count": 0,
            "token_count": 0,
        }

    def start_parse(self, _dataset, _document_ids: list[str]) -> None:
        self.started = True

    def wait_for_document(self, *_args, **_kwargs):
        raise RuntimeError("parse failed")

    def graph_state(self, _dataset_id: str) -> dict:
        return {"state": "missing", "progress": None, "task_id": None}


def test_failed_build_persists_remote_terminal_state(tmp_path: Path) -> None:
    source = tmp_path / "locomo10.json"
    source.write_text(json.dumps([_native_sample()]), encoding="utf-8")
    args = argparse.Namespace(
        artifact_root=tmp_path / "artifacts",
        base_url="http://127.0.0.1:9380",
        embedding_model=None,
        graph=True,
        dataset_prefix="locomo",
        dry_run=False,
        parse_timeout=1.0,
        graph_timeout=1.0,
        poll_seconds=0.01,
    )

    with pytest.raises(RuntimeError, match="parse failed"):
        _build_one(
            _FailedParseClient(),
            source,
            "source-sha",
            _native_sample(),
            args,
            1,
            1,
        )

    state_path = args.artifact_root / "cases" / "conv-test" / "ragflow.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "failed"
    assert state["parse"]["state"] == "failed"
    assert state["graph"]["state"] == "missing"
    assert state["error"] == "RuntimeError: parse failed"
