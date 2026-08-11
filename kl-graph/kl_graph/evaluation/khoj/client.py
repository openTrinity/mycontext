"""Thin HTTP adapter over Khoj's production content and search APIs."""

from __future__ import annotations

import time
from collections.abc import Mapping
from pathlib import PurePath
from typing import Any, ClassVar, Self

import httpx


class KhojEvaluationError(RuntimeError):
    """Raised when a Khoj evaluation operation cannot complete."""


class KhojEvaluationClient:
    """Own Khoj HTTP operations without owning benchmark or chunking logic.

    Complete source documents are sent to ``/api/content``.  Parsing, chunking,
    embedding, persistence, candidate retrieval, and reranking remain entirely
    inside the Khoj server.
    """

    RETRYABLE_STATUS_CODES: ClassVar[frozenset[int]] = frozenset(
        {408, 409, 429, 500, 502, 503, 504}
    )

    def __init__(
        self,
        api_token: str = "",
        base_url: str = "http://127.0.0.1:42112",
        *,
        timeout_seconds: float = 120.0,
        max_retries: int = 2,
        http_client: httpx.Client | None = None,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if max_retries < 0:
            raise ValueError("max_retries must be non-negative")
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self._owns_client = http_client is None
        headers = {"Authorization": f"Bearer {api_token}"} if api_token else {}
        if http_client is None:
            self.http = httpx.Client(
                base_url=self.base_url,
                headers=headers,
                timeout=timeout_seconds,
            )
        else:
            self.http = http_client
            self.http.headers.update(headers)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self.http.close()

    def health(self) -> dict[str, Any]:
        return self._object(self._request("GET", "/api/health"), "Khoj health")

    def server_info(self) -> dict[str, Any]:
        return self._object(
            self._request("GET", "/api/settings"), "Khoj settings"
        )

    def list_documents(self) -> set[str]:
        value = self._json(
            self._request("GET", "/api/content/computer"),
            "list Khoj computer documents",
        )
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            raise KhojEvaluationError(
                "list Khoj computer documents returned non-string items"
            )
        return {PurePath(item).name for item in value}

    def get_document(self, filename: str) -> dict[str, Any]:
        self._validate_filename(filename)
        return self._object(
            self._request(
                "GET",
                "/api/content/file",
                params={"file_name": filename, "client": "locomo-khoj-eval"},
            ),
            f"read Khoj document {filename}",
        )

    def upload_document(self, filename: str, content: bytes) -> None:
        self.upload_documents({filename: content})

    def upload_documents(self, documents: Mapping[str, bytes]) -> None:
        if not documents:
            return
        files: list[tuple[str, tuple[str, bytes, str]]] = []
        for filename, content in documents.items():
            self._validate_filename(filename)
            if not isinstance(content, bytes):
                raise TypeError(f"Khoj document content must be bytes: {filename}")
            files.append(("files", (filename, content, "text/plain")))
        self._request(
            "PATCH",
            "/api/content",
            params={"client": "locomo-khoj-eval"},
            files=files,
        )

    def delete_documents(self, filenames: list[str]) -> int:
        if not filenames:
            return 0
        for filename in filenames:
            self._validate_filename(filename)
        value = self._object(
            self._request(
                "DELETE",
                "/api/content/files",
                params={"client": "locomo-khoj-eval"},
                json={"files": filenames},
            ),
            "delete Khoj documents",
        )
        return int(value.get("deleted_count") or 0)

    def search(
        self,
        question: str,
        *,
        filename: str | None,
        result_count: int,
        rerank: bool = True,
    ) -> list[dict[str, Any]]:
        question = question.strip()
        if not question:
            raise ValueError("question must be non-empty")
        if not 1 <= result_count <= 10:
            raise ValueError("result_count must be between 1 and 10")
        query = question
        if filename is not None:
            self._validate_filename(filename)
            query = f'file:"{filename}" {question}'
        value = self._json(
            self._request(
                "GET",
                "/api/search",
                params={
                    "q": query,
                    "n": result_count,
                    "t": "plaintext",
                    "r": str(rerank).lower(),
                    # One plaintext document is split into multiple database
                    # entries that share a corpus_id.  The benchmark needs
                    # Top-K chunks, not one representative per source entry.
                    "dedupe": "false",
                },
            ),
            "search Khoj",
        )
        if not isinstance(value, list) or not all(
            isinstance(item, dict) for item in value
        ):
            raise KhojEvaluationError("search Khoj returned a non-object list")
        return value

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = self.http.request(method, path, **kwargs)
            except httpx.TransportError as exc:
                last_error = exc
                if attempt >= self.max_retries:
                    break
            else:
                if response.is_success:
                    return response
                if (
                    response.status_code not in self.RETRYABLE_STATUS_CODES
                    or attempt >= self.max_retries
                ):
                    detail = response.text[-1000:]
                    raise KhojEvaluationError(
                        f"{method} {path} failed with HTTP "
                        f"{response.status_code}: {detail}"
                    )
                last_error = KhojEvaluationError(
                    f"{method} {path} returned HTTP {response.status_code}"
                )
            time.sleep(min(2**attempt, 4))
        raise KhojEvaluationError(
            f"{method} {path} failed after {self.max_retries + 1} attempts"
        ) from last_error

    @staticmethod
    def _json(response: httpx.Response, operation: str) -> Any:
        try:
            return response.json()
        except ValueError as exc:
            raise KhojEvaluationError(
                f"{operation} returned non-JSON HTTP {response.status_code}"
            ) from exc

    @classmethod
    def _object(cls, response: httpx.Response, operation: str) -> dict[str, Any]:
        value = cls._json(response, operation)
        if not isinstance(value, dict):
            raise KhojEvaluationError(f"{operation} returned non-object JSON")
        return value

    @staticmethod
    def _validate_filename(filename: str) -> None:
        if (
            not filename
            or PurePath(filename).name != filename
            or '"' in filename
            or "\\" in filename
            or not filename.endswith(".txt")
        ):
            raise ValueError(f"unsafe Khoj plaintext filename: {filename!r}")
