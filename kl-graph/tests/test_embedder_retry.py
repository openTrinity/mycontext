"""Tests for the embedder's transient-error retry classification.

The bulk-embed path retries transient failures (429 rate-limit, timeouts, 5xx)
with backoff so one blip doesn't abort a long run, but must NOT spin forever on
a genuine hard stop (bad request, real quota exhaustion). These tests pin that
classification without any network I/O.

Run: ``.venv/bin/python -m pytest tests/test_embedder_retry.py -q``
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.ingest.embedder import Embedder, EmbeddingConfigurationError


class _Exc(Exception):
    """Exception carrying an arbitrary status_code / headers / retry_after."""

    def __init__(self, msg="", *, status_code=None, headers=None, retry_after=None):
        super().__init__(msg)
        if status_code is not None:
            self.status_code = status_code
        if headers is not None:
            self.headers = headers
        if retry_after is not None:
            self.retry_after = retry_after


class RateLimitError(_Exc):
    """Name-matched transient error (mirrors litellm's class name)."""


def test_429_status_is_transient() -> None:
    assert Embedder._is_transient(_Exc("slow down", status_code=429)) is True


def test_5xx_and_timeout_status_are_transient() -> None:
    for code in (500, 502, 503, 504, 408):
        assert Embedder._is_transient(_Exc(status_code=code)) is True


def test_rate_limit_error_by_class_name_is_transient() -> None:
    # litellm raises RateLimitError even when status_code isn't set on the exc.
    assert Embedder._is_transient(RateLimitError("rate limited")) is True


def test_rate_limit_message_is_transient() -> None:
    assert Embedder._is_transient(_Exc("Error code: 429 - rate limit exceeded")) is True


def test_insufficient_quota_is_not_transient() -> None:
    # A genuine quota exhaustion must NOT be retried (would spin uselessly).
    exc = _Exc("You exceeded your current quota ... insufficient_quota")
    assert Embedder._is_transient(exc) is False


def test_bad_request_is_not_transient() -> None:
    assert Embedder._is_transient(_Exc("bad dimensions", status_code=400)) is False


def test_retry_after_attribute_is_read() -> None:
    assert Embedder._retry_after(_Exc(retry_after=7)) == 7.0


def test_retry_after_header_is_read() -> None:
    assert Embedder._retry_after(_Exc(headers={"retry-after": "12"})) == 12.0


def test_retry_after_absent_returns_none() -> None:
    assert Embedder._retry_after(_Exc("no hint")) is None


def test_embed_with_retry_recovers_then_succeeds(monkeypatch) -> None:
    # Two transient 429s then success: _embed_with_retry must return the result
    # without sleeping for real.
    import kl_graph.ingest.embedder as emod

    calls = {"n": 0}

    def fake_embedding(**kwargs):
        calls["n"] += 1
        if calls["n"] < 3:
            raise RateLimitError("Error code: 429 - too many requests")
        return {"ok": True}

    monkeypatch.setattr(emod.litellm, "embedding", fake_embedding)
    monkeypatch.setattr(emod.time, "sleep", lambda *_a, **_k: None)  # no real waits

    e = Embedder.__new__(Embedder)
    e.max_retries = 5
    out = e._embed_with_retry({"model": "x", "input": ["t"]})
    assert out == {"ok": True}
    assert calls["n"] == 3  # failed twice, succeeded on the third


def test_embed_with_retry_gives_up_after_max(monkeypatch) -> None:
    import kl_graph.ingest.embedder as emod

    def always_429(**kwargs):
        raise RateLimitError("Error code: 429 - too many requests")

    monkeypatch.setattr(emod.litellm, "embedding", always_429)
    monkeypatch.setattr(emod.time, "sleep", lambda *_a, **_k: None)

    e = Embedder.__new__(Embedder)
    e.max_retries = 2
    try:
        e._embed_with_retry({"model": "x", "input": ["t"]})
        raise AssertionError("should have raised after exhausting retries")
    except RateLimitError:
        pass


def test_embed_with_retry_does_not_retry_hard_stop(monkeypatch) -> None:
    import kl_graph.ingest.embedder as emod

    calls = {"n": 0}

    def quota(**kwargs):
        calls["n"] += 1
        raise _Exc("insufficient_quota: you exceeded your quota")

    monkeypatch.setattr(emod.litellm, "embedding", quota)
    monkeypatch.setattr(emod.time, "sleep", lambda *_a, **_k: None)

    e = Embedder.__new__(Embedder)
    e.max_retries = 5
    try:
        e._embed_with_retry({"model": "x", "input": ["t"]})
        raise AssertionError("hard stop should raise immediately")
    except _Exc:
        pass
    assert calls["n"] == 1  # no retries on a hard stop


@pytest.mark.parametrize(
    ("status_code", "expected_hint"),
    [
        (400, "向量模型名称、维度配置"),
        (401, "API Key 及网关认证配置"),
        (403, "/v1/embeddings 和所选向量模型"),
        (404, "网关支持 /v1/embeddings"),
    ],
)
def test_deterministic_4xx_has_actionable_embedding_error(
    monkeypatch, status_code: int, expected_hint: str
) -> None:
    import kl_graph.ingest.embedder as emod

    calls = {"n": 0}
    original_detail = f"provider rejected embedding request ({status_code})"

    def reject(**kwargs):
        calls["n"] += 1
        raise _Exc(original_detail, status_code=status_code)

    monkeypatch.setattr(emod.litellm, "embedding", reject)

    embedder = Embedder.__new__(Embedder)
    embedder.max_retries = 5
    with pytest.raises(EmbeddingConfigurationError) as caught:
        embedder._embed_with_retry({"model": "x", "input": ["t"]})

    assert expected_hint in str(caught.value)
    assert original_detail in str(caught.value)
    assert isinstance(caught.value.__cause__, _Exc)
    assert calls["n"] == 1


def test_async_embedding_uses_the_same_configuration_error(monkeypatch) -> None:
    import kl_graph.ingest.embedder as emod

    calls = {"n": 0}

    async def reject(**kwargs):
        calls["n"] += 1
        raise _Exc("async embedding model not found", status_code=404)

    monkeypatch.setattr(emod.litellm, "aembedding", reject)

    embedder = Embedder.__new__(Embedder)
    embedder.model = "openai/x"
    embedder.base_url = "https://gateway.example/v1"
    embedder.api_key = "test-key"
    embedder.timeout = 1.0
    embedder.dimensions = 2048
    embedder.max_retries = 5

    with pytest.raises(EmbeddingConfigurationError) as caught:
        asyncio.run(embedder._aembed(["t"]))

    assert "向量接口或模型不存在（404）" in str(caught.value)
    assert isinstance(caught.value.__cause__, _Exc)
    assert calls["n"] == 1
