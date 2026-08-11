from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from kl_graph.evaluation.khoj import KhojEvaluationClient
from kl_graph.evaluation.locomo.runners.ask.generate import _resolve_output_dir
from kl_graph.evaluation.locomo.runners.khoj.ask import _normalise_items
from kl_graph.evaluation.locomo.runners.khoj.build import _build_one, load_state
from kl_graph.evaluation.locomo.runners.khoj.score import _retrieval_row
from kl_graph.evaluation.locomo.runners.khoj.source import (
    extract_dia_ids,
    question_rows,
    render_transcript,
)


def _native_sample(sample_id: str = "conv-test") -> dict:
    return {
        "sample_id": sample_id,
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


def test_source_serializes_one_complete_ordered_conversation() -> None:
    transcript = render_transcript(_native_sample())

    assert transcript.index("D1:1") < transcript.index("D2:1")
    assert "[DATE=1 pm on 1 May, 2023] A: First" in transcript
    assert extract_dia_ids(transcript) == ["D1:1", "D2:1"]
    assert question_rows([_native_sample()])[0]["id"] == "qa:conv-test/0"


def test_client_search_requests_plaintext_chunks_without_deduplication() -> None:
    observed: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        observed["authorization"] = request.headers.get("authorization")
        observed["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json=[
                {
                    "entry": "chunk",
                    "score": 0.2,
                    "cross_score": 0.1,
                    "corpus_id": "shared",
                    "additional": {
                        "compiled": "[DIA_ID=D1:1] chunk",
                        "file": "locomo-conv-test-source.txt",
                    },
                }
            ],
        )

    http = httpx.Client(
        base_url="http://127.0.0.1:42112",
        transport=httpx.MockTransport(handler),
    )
    client = KhojEvaluationClient("secret", http_client=http)

    results = client.search(
        "What happened?",
        filename="locomo-conv-test-source.txt",
        result_count=5,
    )

    assert len(results) == 1
    assert observed["authorization"] == "Bearer secret"
    assert observed["params"]["q"] == (
        'file:"locomo-conv-test-source.txt" What happened?'
    )
    assert observed["params"]["t"] == "plaintext"
    assert observed["params"]["dedupe"] == "false"
    assert observed["params"]["r"] == "true"
    assert observed["params"]["n"] == "5"
    assert "candidate_n" not in observed["params"]
    assert "strict_rerank" not in observed["params"]
    http.close()


def test_client_uploads_one_complete_plaintext_document() -> None:
    observed: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        observed["method"] = request.method
        observed["path"] = request.url.path
        observed["content_type"] = request.headers.get("content-type")
        observed["body"] = request.read()
        return httpx.Response(200, text="locomo-conv-test-source.txt")

    http = httpx.Client(
        base_url="http://127.0.0.1:42112",
        transport=httpx.MockTransport(handler),
    )
    client = KhojEvaluationClient(http_client=http)
    transcript = render_transcript(_native_sample()).encode()

    client.upload_document("locomo-conv-test-source.txt", transcript)

    assert observed["method"] == "PATCH"
    assert observed["path"] == "/api/content"
    assert observed["content_type"].startswith("multipart/form-data;")
    assert b"locomo-conv-test-source.txt" in observed["body"]
    assert transcript in observed["body"]
    http.close()


class _BuildClient:
    def __init__(self) -> None:
        self.documents: dict[str, str] = {}
        self.uploads: list[tuple[str, bytes]] = []

    def list_documents(self) -> set[str]:
        return set(self.documents)

    def get_document(self, filename: str) -> dict:
        return {"id": "document-1", "file_name": filename, "raw_text": self.documents[filename]}

    def upload_document(self, filename: str, content: bytes) -> None:
        self.uploads.append((filename, content))
        self.documents[filename] = content.decode()


def test_build_uploads_whole_transcript_and_records_server_chunking(tmp_path: Path) -> None:
    sample = _native_sample()
    source = tmp_path / "locomo10.json"
    source.write_text("[]", encoding="utf-8")
    client = _BuildClient()
    args = SimpleNamespace(
        artifact_root=tmp_path / "artifacts",
        dataset_prefix="locomo",
        base_url="http://127.0.0.1:42112",
        dry_run=False,
        resume=False,
    )

    _build_one(
        client,
        source,
        "a" * 64,
        sample,
        {"email": "default@example.com", "khoj_version": "test"},
        args,
        1,
        1,
    )

    assert len(client.uploads) == 1
    filename, content = client.uploads[0]
    assert filename.endswith(".txt")
    assert content.decode() == render_transcript(sample)
    state = load_state(args.artifact_root, "conv-test")
    assert state["config"]["chunking_owner"] == "khoj_server"
    assert state["config"]["client_chunking"] is False
    assert state["remote_raw_text_sha256"] == hashlib.sha256(content).hexdigest()


def test_normalise_keeps_chunks_that_share_a_corpus_id() -> None:
    results = [
        {
            "entry": "wrong fallback",
            "score": 0.2,
            "cross_score": 0.1,
            "corpus_id": "shared",
            "additional": {
                "compiled": "[DIA_ID=D1:1] first chunk",
                "file": "locomo-conv-test-source.txt",
            },
        },
        {
            "entry": "wrong fallback",
            "score": 0.3,
            "cross_score": 0.2,
            "corpus_id": "shared",
            "additional": {
                "compiled": "[DIA_ID=D1:2] second chunk",
                "file": "locomo-conv-test-source.txt",
            },
        },
    ]

    items = _normalise_items(
        results,
        top_k=5,
        expected_filename="locomo-conv-test-source.txt",
        document_owners={"locomo-conv-test-source.txt": "conv-test"},
    )

    assert len(items) == 2
    assert items[0]["id"] != items[1]["id"]
    assert items[0]["content"] == "[DIA_ID=D1:1] first chunk"
    assert items[0]["dia_ids"] == ["D1:1"]
    assert items[1]["dia_ids"] == ["D1:2"]


def test_normalise_rejects_a_different_document() -> None:
    with pytest.raises(ValueError, match="crossed the requested document"):
        _normalise_items(
            [
                {
                    "score": 0.2,
                    "additional": {
                        "compiled": "[DIA_ID=D1:1] wrong conversation",
                        "file": "locomo-other-source.txt",
                    },
                }
            ],
            top_k=5,
            expected_filename="locomo-conv-test-source.txt",
            document_owners={},
        )


def test_recall_ignores_repeated_dia_ids_from_another_conversation() -> None:
    gold = question_rows([_native_sample()])[0]
    result = {
        "id": gold["id"],
        "status": "completed",
    }
    response = {
        "items": [
            {
                "source_sample_id": "other",
                "dia_ids": ["D1:1"],
            },
            {
                "source_sample_id": "conv-test",
                "dia_ids": ["D2:1"],
            },
        ]
    }

    row = _retrieval_row(gold, result, response, 5)

    assert row["global_dia_ids"] == ["D2:1"]
    assert row["global_evidence_recall"] == 0.0


def test_shared_generator_uses_khoj_native_output_tree(tmp_path: Path) -> None:
    args = SimpleNamespace(output_dir=None, resume=False)

    output = _resolve_output_dir(
        args,
        tmp_path / "locomo10.json",
        "conv-test",
        None,
        {
            "backend": "khoj",
            "case_root": str(tmp_path / "cases" / "conv-test"),
        },
    )

    assert "locomo-khoj-generate/all" in output.as_posix()
