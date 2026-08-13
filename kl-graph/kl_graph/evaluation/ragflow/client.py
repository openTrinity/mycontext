"""Thin evaluation adapter over the official ``ragflow-sdk`` package."""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any


class RagflowEvaluationError(RuntimeError):
    """Raised when a RAGFlow evaluation operation cannot complete."""


class RagflowEvaluationClient:
    """Own remote RAGFlow operations without owning benchmark logic.

    The official SDK remains the HTTP client.  This class only adds the two
    pieces an evaluation run needs but the SDK does not provide directly:
    bounded polling and typed helpers for the dataset GraphRAG index API.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "http://127.0.0.1:9380",
        *,
        sdk: Any | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("RAGFLOW_API_KEY is required")
        self.base_url = base_url.rstrip("/")
        if sdk is None:
            try:
                from ragflow_sdk import RAGFlow
            except ModuleNotFoundError as exc:
                raise RagflowEvaluationError(
                    "ragflow-sdk is not installed; v0.26.4 requires Python "
                    "3.13 (install the dedicated .venv-ragflow environment)"
                ) from exc
            sdk = RAGFlow(api_key=api_key, base_url=self.base_url)
        self.sdk = sdk

    def health(self) -> dict[str, Any]:
        return self._payload(self.sdk.get("/system/healthz"), "RAGFlow health")

    def create_dataset(
        self,
        *,
        name: str,
        description: str,
        embedding_model: str | None = None,
        chunk_method: str = "naive",
        parser_config: Mapping[str, Any] | None = None,
    ) -> Any:
        kwargs: dict[str, Any] = {
            "name": name,
            "description": description,
            "embedding_model": embedding_model,
            "chunk_method": chunk_method,
        }
        if parser_config is not None:
            try:
                from ragflow_sdk.modules.dataset import DataSet
            except ModuleNotFoundError as exc:
                raise RagflowEvaluationError(
                    "ragflow-sdk is required to configure dataset chunking"
                ) from exc
            kwargs["parser_config"] = DataSet.ParserConfig(
                self.sdk, dict(parser_config)
            )
        return self.sdk.create_dataset(
            **kwargs,
        )

    def get_dataset(self, dataset_id: str) -> Any:
        datasets = self.sdk.list_datasets(id=dataset_id, page_size=1)
        if not datasets:
            raise RagflowEvaluationError(
                f"RAGFlow dataset no longer exists: {dataset_id}"
            )
        return datasets[0]

    @staticmethod
    def upload_document(dataset: Any, *, name: str, content: bytes) -> Any:
        documents = dataset.upload_documents(
            [{"display_name": name, "blob": content}]
        )
        if len(documents) != 1:
            raise RagflowEvaluationError(
                f"expected one uploaded document, received {len(documents)}"
            )
        return documents[0]

    @staticmethod
    def start_parse(dataset: Any, document_ids: list[str]) -> None:
        dataset.async_parse_documents(document_ids)

    @staticmethod
    def document_state(dataset: Any, document_id: str) -> dict[str, Any]:
        documents = dataset.list_documents(id=document_id, page_size=1)
        if not documents:
            raise RagflowEvaluationError(
                f"RAGFlow document no longer exists: {document_id}"
            )
        document = documents[0]
        run = str(getattr(document, "run", "") or "").upper()
        progress = float(getattr(document, "progress", 0.0) or 0.0)
        if run in {"3", "DONE"} or progress >= 1.0:
            state = "complete"
        elif run in {"4", "FAIL"} or progress < 0:
            state = "failed"
        elif run in {"2", "CANCEL"}:
            state = "cancelled"
        elif run in {"0", "UNSTART", ""}:
            state = "unstarted"
        else:
            state = "running"
        return {
            "state": state,
            "run": run,
            "progress": progress,
            "progress_message": str(
                getattr(document, "progress_msg", "") or ""
            ),
            "chunk_count": int(getattr(document, "chunk_count", 0) or 0),
            "token_count": int(getattr(document, "token_count", 0) or 0),
        }

    def wait_for_document(
        self,
        dataset: Any,
        document_id: str,
        *,
        timeout_seconds: float,
        poll_seconds: float,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        while True:
            state = self.document_state(dataset, document_id)
            if state["state"] == "complete":
                return state
            if state["state"] in {"failed", "cancelled"}:
                raise RagflowEvaluationError(
                    "RAGFlow document parsing "
                    f"{state['state']}: {state['progress_message']}"
                )
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"RAGFlow document parsing timed out after "
                    f"{timeout_seconds:g}s: {document_id}"
                )
            time.sleep(poll_seconds)

    def start_graph(self, dataset_id: str) -> str:
        payload = self._payload(
            self.sdk.post(f"/datasets/{dataset_id}/index?type=graph"),
            "start GraphRAG index",
        )
        task_id = str((payload.get("data") or {}).get("task_id") or "")
        if not task_id:
            raise RagflowEvaluationError(
                "RAGFlow did not return a GraphRAG task_id"
            )
        return task_id

    def graph_state(self, dataset_id: str) -> dict[str, Any]:
        payload = self._payload(
            self.sdk.get(
                f"/datasets/{dataset_id}/index", params={"type": "graph"}
            ),
            "read GraphRAG index state",
        )
        data = payload.get("data") or {}
        if not data:
            return {"state": "missing", "progress": None, "task_id": None}
        progress = float(data.get("progress") or 0.0)
        if progress >= 1.0:
            state = "complete"
        elif progress < 0:
            state = "failed"
        else:
            state = "running"
        return {
            "state": state,
            "progress": progress,
            "task_id": str(data.get("id") or "") or None,
            "progress_message": str(data.get("progress_msg") or ""),
        }

    def wait_for_graph(
        self,
        dataset_id: str,
        *,
        timeout_seconds: float,
        poll_seconds: float,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        while True:
            state = self.graph_state(dataset_id)
            if state["state"] == "complete":
                return state
            if state["state"] == "failed":
                raise RagflowEvaluationError(
                    "RAGFlow GraphRAG build failed: "
                    f"{state.get('progress_message') or 'no error message'}"
                )
            if state["state"] == "missing":
                raise RagflowEvaluationError(
                    f"RAGFlow GraphRAG task is missing for dataset {dataset_id}"
                )
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"RAGFlow GraphRAG build timed out after "
                    f"{timeout_seconds:g}s: {dataset_id}"
                )
            time.sleep(poll_seconds)

    def retrieve(
        self,
        *,
        dataset_id: str,
        question: str,
        result_count: int,
        candidate_count: int,
        similarity_threshold: float,
        vector_similarity_weight: float,
        rerank_id: str | None,
        use_kg: bool,
    ) -> list[dict[str, Any]]:
        chunks = self.sdk.retrieve(
            dataset_ids=[dataset_id],
            question=question,
            page=1,
            page_size=result_count,
            similarity_threshold=similarity_threshold,
            vector_similarity_weight=vector_similarity_weight,
            top_k=candidate_count,
            rerank_id=rerank_id,
            use_kg=use_kg,
        )
        return [
            chunk.to_json() if hasattr(chunk, "to_json") else dict(chunk)
            for chunk in chunks
        ]

    @staticmethod
    def _payload(response: Any, operation: str) -> dict[str, Any]:
        try:
            payload = response.json()
        except Exception as exc:  # requests uses several JSON exception types
            status = getattr(response, "status_code", "unknown")
            raise RagflowEvaluationError(
                f"{operation} returned non-JSON HTTP {status}"
            ) from exc
        if not isinstance(payload, dict):
            raise RagflowEvaluationError(f"{operation} returned non-object JSON")
        if "code" not in payload and payload.get("status") == "ok":
            return payload
        if payload.get("code") != 0:
            raise RagflowEvaluationError(
                f"{operation} failed: {payload.get('message') or payload}"
            )
        return payload
