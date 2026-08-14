"""Tests for the native LongMemEval RAGFlow evaluation boundary."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from kl_graph.evaluation.io import atomic_write_json, atomic_write_jsonl
from kl_graph.evaluation.longmemeval import score
from kl_graph.evaluation.longmemeval.generate import _ragflow_generation_inputs
from kl_graph.evaluation.longmemeval.ragflow.ask import (
    _normalise_items,
    _source_turn_ids,
)
from kl_graph.evaluation.longmemeval.ragflow.build import _build_one
from kl_graph.evaluation.longmemeval.source import (
    load_cases,
    render_document,
    render_document_turns,
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


def test_native_document_contains_only_marked_user_turns(tmp_path: Path) -> None:
    source = tmp_path / "native.json"
    _write_source(source)
    _, cases = load_cases(source)

    document = render_document(cases[0])

    assert "[SESSION=0000]" in document
    assert "[SESSION_ID=session-1]" in document
    assert "[TURN=0000] USER: first user turn" in document
    assert "[TURN=0002] USER: second user turn" in document
    assert "QUESTION_MUST_NOT_BE_UPLOADED" not in document
    assert "ANSWER_MUST_NOT_BE_UPLOADED" not in document
    assert "ASSISTANT_MUST_NOT_BE_UPLOADED" not in document


class _BuildClient:
    def __init__(self) -> None:
        self.create_kwargs = None
        self.uploaded = b""

    def create_dataset(self, **kwargs):
        self.create_kwargs = kwargs
        return SimpleNamespace(id="dataset-1")

    def upload_document(self, _dataset, *, name: str, content: bytes):
        assert name == "q-example.txt"
        self.uploaded = content
        return SimpleNamespace(id="document-1")

    def document_state(self, _dataset, _document_id: str) -> dict:
        return {
            "state": "complete",
            "run": "DONE",
            "progress": 1.0,
            "progress_message": "",
            "chunk_count": 2,
            "token_count": 20,
        }


def test_build_configures_naive_512_newline_chunking(tmp_path: Path) -> None:
    source = tmp_path / "native.json"
    _write_source(source)
    client = _BuildClient()
    args = argparse.Namespace(
        artifact_root=tmp_path / "artifacts",
        base_url="http://127.0.0.1:9380",
        embedding_model="embedding-model",
        graph=False,
        dataset_prefix="longmemeval",
        chunk_method="naive",
        chunk_token_num=512,
        delimiter="\n",
        dry_run=False,
        resume=False,
        parse_timeout=1.0,
        graph_timeout=1.0,
        poll_seconds=0.01,
    )

    _build_one(client, source, "source-sha", _case(), args, 1, 1)

    assert client.create_kwargs["chunk_method"] == "naive"
    assert client.create_kwargs["parser_config"] == {
        "chunk_token_num": 512,
        "delimiter": "\n",
    }
    assert b"first user turn" in client.uploaded
    assert b"ASSISTANT_MUST_NOT_BE_UPLOADED" not in client.uploaded
    state = json.loads(
        (args.artifact_root / "q_example" / "build" / "ragflow.json").read_text(
            encoding="utf-8"
        )
    )
    assert state["status"] == "complete"
    assert state["parse"]["chunk_count"] == 2


def test_vector_chunks_map_to_turns_while_graph_does_not_consume_top_k() -> None:
    rendered = render_document_turns(_case())
    chunks = [
        {
            "id": "graph",
            "content": "synthesized graph context",
            "document_id": "",
            "document_name": "Related content in Knowledge Graph",
        },
        {
            "id": "chunk-1",
            "content": rendered[0][1].strip(),
            "document_id": "doc-1",
            "document_name": "q-example.txt",
        },
        {
            "id": "chunk-2",
            "content": rendered[1][1].strip(),
            "document_id": "doc-1",
            "document_name": "q-example.txt",
        },
        {
            "id": "chunk-3",
            "content": "not persisted",
            "document_id": "doc-1",
            "document_name": "q-example.txt",
        },
    ]

    items, graph_count = _normalise_items(chunks, top_k=2)

    assert graph_count == 1
    assert [item["type"] for item in items] == ["graph", "chunk", "chunk"]
    assert _source_turn_ids(_case(), items[1]["content"]) == [rendered[0][0]]
    assert _source_turn_ids(_case(), items[2]["content"]) == [rendered[1][0]]


def test_generate_uses_ragflow_item_content_directly(tmp_path: Path) -> None:
    source = tmp_path / "native.json"
    _write_source(source)
    ask_dir = tmp_path / "ask"
    atomic_write_json(
        ask_dir / "run.json",
        {
            "status": "complete",
            "backend": "ragflow",
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
    raw_content = "[DATE=2025/01/01] USER: exact RAGFlow chunk text"
    atomic_write_json(
        ask_dir / "responses" / "q_example.json",
        {
            "question_id": QUESTION_ID,
            "items": [{"type": "chunk", "content": raw_content}],
        },
    )

    root, question_ids, prompts = _ragflow_generation_inputs(
        ask_dir, max_retrieval_length=126_500
    )

    assert root == ask_dir.resolve()
    assert question_ids == [QUESTION_ID]
    assert prompts[0][0] == QUESTION_ID
    assert raw_content in prompts[0][1]
    assert "QUESTION_MUST_NOT_BE_UPLOADED" in prompts[0][1]
    assert "ASSISTANT_MUST_NOT_BE_UPLOADED" not in prompts[0][1]


def test_score_accepts_configured_native_subset_without_case_set(
    tmp_path: Path,
) -> None:
    source = tmp_path / "native.json"
    _write_source(source)
    hypotheses = tmp_path / "generate" / "hypotheses.jsonl"
    atomic_write_jsonl(
        hypotheses,
        [{"question_id": QUESTION_ID, "hypothesis": "candidate answer"}],
    )
    config = tmp_path / "experiment.yaml"
    config.write_text(
        f"""schema_version: 3
benchmark: longmemeval
backend: ragflow
source: {source}
selection:
  cases: ["{QUESTION_ID}"]
run:
  mode: overwrite
  output_dir: {tmp_path / "ask"}
  keep_going: false
  case_concurrency: 1
score:
  output_dir: {tmp_path / "score"}
  concurrency: 1
  judge:
    model: judge
    base_url: https://judge.example/v1
    temperature: 0
    max_tokens: 10
    timeout_seconds: 120
    max_retries: 5
  retrieval:
    turn_recall:
      enabled: false
      k: 5
""",
        encoding="utf-8",
    )

    result = asyncio.run(score.main(["--config", str(config), "--dry-run"]))

    assert result == 0
