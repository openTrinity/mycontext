"""Tests for the LLM extractor's transient-error retry + cache-poisoning guard.

The two bugs a real full-corpus run exposed:
  1. a transient 429/5xx during extraction aborted or (worse) was cached as an
     empty ``{"entities": [], "facts": []}`` result, so a re-run treated it as a
     cache hit and never retried — silently dropping 68% of extractions;
  2. no retry at all around the extraction call.

These tests pin classification, success-only cache writes, extractor-owned
in-step retries, and disabled nested retries in ``litellm.acompletion``. No
network I/O.

Run: ``.venv/bin/python -m pytest tests/test_extractor_retry.py -q``
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import kl_graph.ingest.llm_extractor as lx
from kl_graph.ingest.llm_extractor import LLMExtractor, _is_transient_llm_error
from kl_graph.models.types import Chunk


class _Exc(Exception):
    def __init__(self, msg="", *, status_code=None):
        super().__init__(msg)
        if status_code is not None:
            self.status_code = status_code


class RateLimitError(_Exc):
    pass


# ── classification ───────────────────────────────────────────────────────


def test_429_and_5xx_are_transient() -> None:
    assert _is_transient_llm_error(_Exc(status_code=429))
    for c in (500, 502, 503, 504):
        assert _is_transient_llm_error(_Exc(status_code=c))


def test_cloudflare_and_ratelimit_messages_are_transient() -> None:
    assert _is_transient_llm_error(RateLimitError("rate limited"))
    assert _is_transient_llm_error(_Exc("AnthropicException cloudflare 5xx error"))
    assert _is_transient_llm_error(_Exc("Error code: 429 - too many requests"))


def test_quota_and_badrequest_are_hard_stops() -> None:
    assert _is_transient_llm_error(_Exc("insufficient_quota")) is False
    assert _is_transient_llm_error(_Exc("bad request", status_code=400)) is False


# ── typed-exception classification (proves the isinstance ladder runs) ──────
#
# Each typed exception below is stripped of its status_code and given a
# keyword-free message, so neither the status-code fallback nor the
# message-substring fallback can classify it — only the ``_TRANSIENT_EXC`` /
# ``_PERMANENT_EXC`` isinstance ladder can. If that ladder were removed these
# would flip, unlike the plain-``_Exc`` tests above.


def _typed(exc_cls, msg="xyzzy plugh"):
    exc = exc_cls(msg, llm_provider="anthropic", model="x")
    exc.status_code = None  # force classification through the isinstance ladder
    return exc


def test_typed_transient_exceptions_classified_by_isinstance() -> None:
    import litellm

    for cls in (
        litellm.Timeout,
        litellm.RateLimitError,
        litellm.APIConnectionError,
        litellm.InternalServerError,
        litellm.ServiceUnavailableError,
    ):
        assert _is_transient_llm_error(_typed(cls)) is True, cls.__name__


def test_typed_permanent_exceptions_classified_by_isinstance() -> None:
    import litellm

    # ContextWindowExceededError / ContentPolicyViolationError subclass
    # BadRequestError; the ladder must classify all permanent. (PermissionDenied
    # is omitted only because its constructor requires an httpx response object;
    # AuthenticationError/BadRequestError cover the permanent ladder + ordering.)
    for cls in (
        litellm.ContextWindowExceededError,
        litellm.ContentPolicyViolationError,
        litellm.AuthenticationError,
        litellm.BadRequestError,
    ):
        assert _is_transient_llm_error(_typed(cls)) is False, cls.__name__


def test_typed_ratelimit_without_keywords_is_transient() -> None:
    # A litellm RateLimitError whose message has no classification keyword and
    # whose status_code is stripped can ONLY read transient via the ladder.
    import litellm

    assert _is_transient_llm_error(_typed(litellm.RateLimitError)) is True


# ── _write_cache refuses transient results (the poisoning guard) ────────────


def _extractor(tmp_path) -> LLMExtractor:
    # Most tests exercise one-attempt parsing/cache behavior. Dedicated tests
    # below opt into retry attempts explicitly.
    return LLMExtractor(cache_db=tmp_path / "knowledge.db", max_retries=0)


def _chunk(cid="c1") -> Chunk:
    return Chunk(id=cid, content="hello", source_type="message", metadata={})


def test_write_cache_skips_transient_result(tmp_path) -> None:
    ex = _extractor(tmp_path)
    msg = _chunk()
    ex._write_cache(msg, {"entities": [], "facts": [], "_error": "429", "_transient": True})
    # A failed attempt cannot poison the durable cache.
    assert ex._read_cache(msg) is None


def test_write_cache_skips_any_error_result(tmp_path) -> None:
    # Success-only writes: ANY _error marker (transient or not) is withheld.
    ex = _extractor(tmp_path)
    msg = _chunk()
    ex._write_cache(msg, {"entities": [], "facts": [], "_error": "bad shape"})
    assert ex._read_cache(msg) is None


def test_write_cache_skips_empty_string_error(tmp_path) -> None:
    # Failure is keyed on PRESENCE of _error, not truthiness: an empty-string
    # error (e.g. from ``Exception()``) must still be withheld from the cache.
    ex = _extractor(tmp_path)
    msg = _chunk()
    ex._write_cache(msg, {"entities": [], "facts": [], "_error": "", "_transient": True})
    assert ex._read_cache(msg) is None


def test_write_cache_persists_real_result(tmp_path) -> None:
    ex = _extractor(tmp_path)
    msg = _chunk()
    ex._write_cache(msg, {"entities": [{"name": "X"}], "facts": [], "_msg_id": "c1"})
    got = ex._read_cache(msg)
    assert got is not None and got["entities"] == [{"name": "X"}]


def test_write_cache_persists_nontransient_empty(tmp_path) -> None:
    # A genuinely empty extraction (no error) is a valid cache entry — only
    # transient failures are withheld.
    ex = _extractor(tmp_path)
    msg = _chunk()
    ex._write_cache(msg, {"entities": [], "facts": [], "_msg_id": "c1"})
    assert ex._read_cache(msg) is not None


# ── SDK timeout and disabled nested retries ─────────────────────────────────


class _FakeMessage:
    def __init__(self, content: str):
        self.content = content


class _FakeChoice:
    def __init__(self, content: str):
        self.message = _FakeMessage(content)


class _FakeResp:
    def __init__(self, content: str):
        self.choices = [_FakeChoice(content)]
        self.usage = None


def test_call_llm_disables_sdk_retry_and_sets_timeout(monkeypatch, tmp_path) -> None:
    """The single-message path owns retries and keeps a request timeout."""
    seen = {}

    async def capture(**kwargs):
        seen.update(kwargs)
        return _FakeResp('{"entities": [], "facts": []}')

    monkeypatch.setattr(lx.litellm, "acompletion", capture)
    ex = _extractor(tmp_path)
    asyncio.run(ex._call_llm(_chunk(), "(no context)"))
    assert seen["num_retries"] == 0
    assert seen["timeout"] == 240


def test_call_llm_batch_disables_sdk_retry_and_sets_timeout(monkeypatch, tmp_path) -> None:
    """The batch path owns retries and keeps a request timeout."""
    seen = {}

    async def capture(**kwargs):
        seen.update(kwargs)
        return _FakeResp('{"results": [{"entities": [], "facts": []}]}')

    monkeypatch.setattr(lx.litellm, "acompletion", capture)
    ex = _extractor(tmp_path)
    asyncio.run(ex._call_llm_batch([_chunk()]))
    assert seen["num_retries"] == 0
    assert seen["timeout"] == lx.LLM_BATCH_TIMEOUT


def test_call_llm_batch_marks_transient_failure(monkeypatch, tmp_path) -> None:
    """A transient SDK error produces retryable, non-cacheable batch slots."""

    async def rate_limited(**kwargs):
        raise RateLimitError("Error code: 429 - too many requests")

    monkeypatch.setattr(lx.litellm, "acompletion", rate_limited)
    ex = _extractor(tmp_path)
    results = asyncio.run(ex._call_llm_batch([_chunk(), _chunk("c2")]))
    assert len(results) == 2
    assert all(r["_transient"] is True for r in results)
    assert ex.stats["llm_errors"] == 1


def test_process_batch_retries_only_failed_slots(monkeypatch, tmp_path) -> None:
    calls = []

    async def partial_then_ok(**kwargs):
        calls.append(kwargs["messages"][-1]["content"])
        if len(calls) == 1:
            return _resp(
                '{"results": ['
                '{"msg_index": 0, "entities": [{"name": "A"}], "facts": []}'
                ']}'
            )
        return _resp(
            '{"results": ['
            '{"msg_index": 0, "entities": [{"name": "B"}], "facts": []}'
            ']}'
        )

    monkeypatch.setattr(lx.litellm, "acompletion", partial_then_ok)
    ex = LLMExtractor(cache_db=tmp_path / "cache.db", max_retries=1)
    ex._wait_before_retry = AsyncMock()
    c0, c1 = _chunk("c0"), _chunk("c1")

    asyncio.run(ex._process_batch([c0, c1]))

    assert len(calls) == 2
    assert "[Message 1]" in calls[0]
    assert "[Message 1]" not in calls[1]
    assert ex._read_cache(c0)["entities"] == [{"name": "A"}]
    assert ex._read_cache(c1)["entities"] == [{"name": "B"}]
    assert ex.failures == []


def test_process_batch_records_exhausted_failure(monkeypatch, tmp_path) -> None:
    calls = 0

    async def rate_limited(**kwargs):
        nonlocal calls
        calls += 1
        raise RateLimitError("Error code: 429 - too many requests")

    monkeypatch.setattr(lx.litellm, "acompletion", rate_limited)
    ex = LLMExtractor(cache_db=tmp_path / "cache.db", max_retries=1)
    ex._wait_before_retry = AsyncMock()
    c = _chunk("failed")

    asyncio.run(ex._process_batch([c]))

    assert calls == 2
    assert ex._read_cache(c) is None
    assert len(ex.failures) == 1
    failure = ex.failures[0]
    assert failure.extraction_item_id == "failed"
    assert failure.error_type == "rate_limit"
    assert failure.attempts == 2


def test_process_batch_does_not_retry_local_cache_failure(monkeypatch, tmp_path) -> None:
    calls = 0

    async def successful_response(**kwargs):
        nonlocal calls
        calls += 1
        return _resp('{"results": [{"entities": [], "facts": []}]}')

    monkeypatch.setattr(lx.litellm, "acompletion", successful_response)
    ex = LLMExtractor(cache_db=tmp_path / "cache.db", max_retries=2)
    ex._write_cache = MagicMock(side_effect=RuntimeError("disk unavailable"))

    with pytest.raises(RuntimeError, match="disk unavailable"):
        asyncio.run(ex._process_batch([_chunk()]))

    assert calls == 1


# ── poison-path guards: no failure outcome is ever cached ──────────────────


def _resp(content: str, *, finish_reason="stop", stop_reason=None):
    """Minimal litellm-shaped response with a tunable finish/stop reason."""
    msg = type("M", (), {"content": content})()
    choice = type(
        "C", (), {"message": msg, "finish_reason": finish_reason, "stop_reason": stop_reason}
    )()
    return type("R", (), {"choices": [choice], "usage": None})()


def _run_batch_and_process(ex, chunks):
    """Drive the real production path (_process_batch → _write_cache)."""
    asyncio.run(ex._process_batch(chunks))


def test_batch_json_decode_not_cached(monkeypatch, tmp_path) -> None:
    async def bad_json(**kwargs):
        return _resp("{not valid json")

    monkeypatch.setattr(lx.litellm, "acompletion", bad_json)
    ex = _extractor(tmp_path)
    c = _chunk()
    _run_batch_and_process(ex, [c])
    assert ex._read_cache(c) is None  # poison guard


def test_batch_unrecognized_shape_not_cached(monkeypatch, tmp_path) -> None:
    async def weird(**kwargs):
        return _resp('{"unexpected": "shape"}')

    monkeypatch.setattr(lx.litellm, "acompletion", weird)
    ex = _extractor(tmp_path)
    c = _chunk()
    _run_batch_and_process(ex, [c])
    assert ex._read_cache(c) is None


def test_batch_empty_choices_not_cached(monkeypatch, tmp_path) -> None:
    async def no_choices(**kwargs):
        return type("R", (), {"choices": [], "usage": None})()

    monkeypatch.setattr(lx.litellm, "acompletion", no_choices)
    ex = _extractor(tmp_path)
    c = _chunk()
    _run_batch_and_process(ex, [c])
    assert ex._read_cache(c) is None


def test_batch_truncation_finish_length_not_cached(monkeypatch, tmp_path) -> None:
    async def truncated(**kwargs):
        # Valid JSON, but the response was cut at max_tokens.
        return _resp('{"results": [{"entities": [], "facts": []}]}', finish_reason="length")

    monkeypatch.setattr(lx.litellm, "acompletion", truncated)
    ex = _extractor(tmp_path)
    c = _chunk()
    _run_batch_and_process(ex, [c])
    assert ex._read_cache(c) is None


def test_batch_truncation_stop_reason_max_tokens_not_cached(monkeypatch, tmp_path) -> None:
    async def truncated(**kwargs):
        return _resp(
            '{"results": [{"entities": [], "facts": []}]}',
            finish_reason=None,
            stop_reason="max_tokens",
        )

    monkeypatch.setattr(lx.litellm, "acompletion", truncated)
    ex = _extractor(tmp_path)
    c = _chunk()
    _run_batch_and_process(ex, [c])
    assert ex._read_cache(c) is None


def test_batch_missing_slot_not_cached(monkeypatch, tmp_path) -> None:
    # Model echoes msg_index for slot 0 only; slot 1 is dropped.
    async def one_of_two(**kwargs):
        return _resp('{"results": [{"msg_index": 0, "entities": [], "facts": []}]}')

    monkeypatch.setattr(lx.litellm, "acompletion", one_of_two)
    ex = _extractor(tmp_path)
    c0, c1 = _chunk("c0"), _chunk("c1")
    _run_batch_and_process(ex, [c0, c1])
    assert ex._read_cache(c0) is not None  # present slot cached
    assert ex._read_cache(c1) is None      # dropped slot NOT cached


def test_batch_success_is_cached(monkeypatch, tmp_path) -> None:
    async def ok(**kwargs):
        return _resp(
            '{"results": [{"msg_index": 0, "entities": [{"name": "X"}], "facts": []}]}'
        )

    monkeypatch.setattr(lx.litellm, "acompletion", ok)
    ex = _extractor(tmp_path)
    c = _chunk()
    _run_batch_and_process(ex, [c])
    got = ex._read_cache(c)
    assert got is not None and got["entities"] == [{"name": "X"}]


def test_hard_stop_auth_raises_and_caches_nothing(monkeypatch, tmp_path) -> None:
    async def auth_fail(**kwargs):
        raise lx.litellm.AuthenticationError(
            "invalid api-key", llm_provider="anthropic", model="x"
        )

    monkeypatch.setattr(lx.litellm, "acompletion", auth_fail)
    ex = _extractor(tmp_path)
    c = _chunk()
    try:
        asyncio.run(ex._process_batch([c]))
        raise AssertionError("a hard-stop auth error must propagate loudly")
    except lx.litellm.AuthenticationError:
        pass
    assert ex._read_cache(c) is None


def test_hard_stop_quota_raises(monkeypatch, tmp_path) -> None:
    async def quota(**kwargs):
        raise RateLimitError("Error code: 429 - insufficient_quota: balance depleted")

    monkeypatch.setattr(lx.litellm, "acompletion", quota)
    ex = _extractor(tmp_path)
    c = _chunk()
    try:
        asyncio.run(ex._process_batch([c]))
        raise AssertionError("insufficient_quota is a hard stop; must raise")
    except RateLimitError:
        pass
    assert ex._read_cache(c) is None


def test_single_path_json_decode_not_cached(monkeypatch, tmp_path) -> None:
    async def bad_json(**kwargs):
        return _resp("not json at all")

    monkeypatch.setattr(lx.litellm, "acompletion", bad_json)
    ex = _extractor(tmp_path)
    c = _chunk()
    result = asyncio.run(ex._call_llm(c, "(no context)"))
    assert result.get("_error") and result.get("_transient") is True
    ex._write_cache(c, result)
    assert ex._read_cache(c) is None


# ── F1: a non-dict batch entry must not shift a valid neighbour's result ────


def test_batch_non_dict_entry_preserves_positional_alignment(monkeypatch, tmp_path) -> None:
    # Two inputs, response with a null (non-dict) FIRST entry then a valid
    # UNINDEXED entry. If the null were dropped, the valid result would shift
    # into slot 0 and be cached under c0. It must instead stay in slot 1 (c1),
    # and slot 0 (the bad entry) must be a marked, uncached failure.
    async def shifted(**kwargs):
        return _resp('{"results": [null, {"entities": [{"name": "B"}], "facts": []}]}')

    monkeypatch.setattr(lx.litellm, "acompletion", shifted)
    ex = _extractor(tmp_path)
    c0, c1 = _chunk("c0"), _chunk("c1")
    _run_batch_and_process(ex, [c0, c1])
    assert ex._read_cache(c0) is None  # bad slot: uncached, no misattribution
    got1 = ex._read_cache(c1)
    assert got1 is not None and got1["entities"] == [{"name": "B"}]


def test_batch_call_returns_positional_length_with_bad_entry(monkeypatch, tmp_path) -> None:
    # _call_llm_batch must return one slot per results entry (length preserved),
    # the bad one marked as a failure.
    async def shifted(**kwargs):
        return _resp('{"results": [null, {"entities": [], "facts": []}]}')

    monkeypatch.setattr(lx.litellm, "acompletion", shifted)
    ex = _extractor(tmp_path)
    out = asyncio.run(ex._call_llm_batch([_chunk("c0"), _chunk("c1")]))
    assert len(out) == 2
    assert "_error" in out[0] and out[0]["_transient"] is True
    assert "_error" not in out[1]


# ── F3: structurally unrecognized per-result dicts are not cached as empties ──


def test_single_path_unrecognized_dict_not_cached(monkeypatch, tmp_path) -> None:
    async def weird(**kwargs):
        return _resp('{"unexpected": "shape"}')

    monkeypatch.setattr(lx.litellm, "acompletion", weird)
    ex = _extractor(tmp_path)
    c = _chunk()
    result = asyncio.run(ex._call_llm(c, "(no context)"))
    assert result.get("_error") and result.get("_transient") is True
    ex._write_cache(c, result)
    assert ex._read_cache(c) is None


def test_batch_unrecognized_result_entry_not_cached(monkeypatch, tmp_path) -> None:
    # A recognized envelope whose single results-entry is an arbitrary dict:
    # that slot must be a marked failure, not a cached empty extraction.
    async def weird_entry(**kwargs):
        return _resp('{"results": [{"unexpected": "shape"}]}')

    monkeypatch.setattr(lx.litellm, "acompletion", weird_entry)
    ex = _extractor(tmp_path)
    c = _chunk()
    _run_batch_and_process(ex, [c])
    assert ex._read_cache(c) is None


# ── F7a: content_filter is a hard stop (raise, cache nothing) ───────────────


def test_batch_content_filter_raises_and_caches_nothing(monkeypatch, tmp_path) -> None:
    async def filtered(**kwargs):
        return _resp('{"results": []}', finish_reason="content_filter")

    monkeypatch.setattr(lx.litellm, "acompletion", filtered)
    ex = _extractor(tmp_path)
    c = _chunk()
    try:
        asyncio.run(ex._process_batch([c]))
        raise AssertionError("content_filter is a hard stop; must raise")
    except lx._HardStopResponseError:
        pass
    assert ex._read_cache(c) is None


def test_single_content_filter_raises(monkeypatch, tmp_path) -> None:
    async def filtered(**kwargs):
        return _resp('{"entities": [], "facts": []}', finish_reason="content_filter")

    monkeypatch.setattr(lx.litellm, "acompletion", filtered)
    ex = _extractor(tmp_path)
    try:
        asyncio.run(ex._call_llm(_chunk(), "(no context)"))
        raise AssertionError("content_filter is a hard stop; must raise")
    except lx._HardStopResponseError:
        pass


# ── F7c: hard stops raise on the SINGLE path too, not just batch ────────────


def test_single_path_hard_stop_auth_raises(monkeypatch, tmp_path) -> None:
    async def auth_fail(**kwargs):
        raise lx.litellm.AuthenticationError(
            "invalid api-key", llm_provider="anthropic", model="x"
        )

    monkeypatch.setattr(lx.litellm, "acompletion", auth_fail)
    ex = _extractor(tmp_path)
    c = _chunk()
    try:
        asyncio.run(ex._call_llm(c, "(no context)"))
        raise AssertionError("single-path auth error must propagate loudly")
    except lx.litellm.AuthenticationError:
        pass
    assert ex._read_cache(c) is None


def test_single_path_hard_stop_quota_raises_via_extract_one(monkeypatch, tmp_path) -> None:
    # Drive extract_one (the public single-message entry) to prove the hard
    # stop propagates through it and nothing is cached.
    async def quota(**kwargs):
        raise RateLimitError("Error code: 429 - insufficient_quota")

    monkeypatch.setattr(lx.litellm, "acompletion", quota)
    ex = _extractor(tmp_path)
    c = _chunk()
    try:
        asyncio.run(ex.extract_one(c, [c], 0))
        raise AssertionError("insufficient_quota is a hard stop; must raise")
    except RateLimitError:
        pass
    assert ex._read_cache(c) is None


# ── F7d: single-path empty-choices + truncation coverage ────────────────────


def test_single_path_empty_choices_not_cached(monkeypatch, tmp_path) -> None:
    async def no_choices(**kwargs):
        return type("R", (), {"choices": [], "usage": None})()

    monkeypatch.setattr(lx.litellm, "acompletion", no_choices)
    ex = _extractor(tmp_path)
    c = _chunk()
    result = asyncio.run(ex._call_llm(c, "(no context)"))
    assert result.get("_error") and result.get("_transient") is True
    ex._write_cache(c, result)
    assert ex._read_cache(c) is None


def test_single_path_truncation_not_cached(monkeypatch, tmp_path) -> None:
    async def truncated(**kwargs):
        return _resp('{"entities": [], "facts": []}', finish_reason="length")

    monkeypatch.setattr(lx.litellm, "acompletion", truncated)
    ex = _extractor(tmp_path)
    c = _chunk()
    result = asyncio.run(ex._call_llm(c, "(no context)"))
    assert result.get("_error") and result.get("_transient") is True
    ex._write_cache(c, result)
    assert ex._read_cache(c) is None


def test_single_path_truncation_stop_reason_not_cached(monkeypatch, tmp_path) -> None:
    async def truncated(**kwargs):
        return _resp(
            '{"entities": [], "facts": []}', finish_reason=None, stop_reason="max_tokens"
        )

    monkeypatch.setattr(lx.litellm, "acompletion", truncated)
    ex = _extractor(tmp_path)
    c = _chunk()
    result = asyncio.run(ex._call_llm(c, "(no context)"))
    assert result.get("_error") and result.get("_transient") is True


def test_summarize_bounds_a_hung_async_call(monkeypatch) -> None:
    # The real >1h hang was a wedged read that ignored the client timeout. The
    # async summarizer now wraps litellm.acompletion in asyncio.wait_for, which
    # cancels a stuck coroutine cleanly — no daemon thread. It must degrade to
    # None (keep bullets), fast.
    import time

    async def hang(**kwargs):
        await asyncio.sleep(3600)
        return "never"

    monkeypatch.setattr(lx.litellm, "acompletion", hang)
    monkeypatch.setattr(lx, "LLM_TIMEOUT", 0.05)
    monkeypatch.setattr(lx, "_WAIT_FOR_GRACE", 0.05)
    monkeypatch.setattr(lx, "_summarize_breaker", {"consecutive_failures": 0})
    started = time.time()
    out = asyncio.run(
        lx.summarize_entity_descriptions(
            "张三", ["did a thing", "did another"], base_url="http://x"
        )
    )
    assert out is None
    assert time.time() - started < 30


def test_summarize_entity_descriptions_survives_a_hang(monkeypatch) -> None:
    # End-to-end: a wedged summarizer call must degrade to None (keep bullets),
    # never propagate or block the build.
    import time

    async def hang(**kwargs):
        await asyncio.sleep(3600)
        return "never"

    monkeypatch.setattr(lx.litellm, "acompletion", hang)
    monkeypatch.setattr(lx, "LLM_TIMEOUT", 0.05)
    monkeypatch.setattr(lx, "_WAIT_FOR_GRACE", 0.05)
    monkeypatch.setattr(lx, "_summarize_breaker", {"consecutive_failures": 0})
    started = time.time()
    out = asyncio.run(
        lx.summarize_entity_descriptions(
            "张三", ["did a thing", "did another"], base_url="http://x"
        )
    )
    assert out is None
    assert time.time() - started < 30


def test_summarize_circuit_breaker_opens_after_repeated_failures(monkeypatch) -> None:
    # A dead gateway must not cost LLM_TIMEOUT per gated entity forever: after
    # _SUMMARIZE_BREAKER_THRESHOLD consecutive failures the breaker opens and
    # further calls return immediately without touching litellm.
    calls = {"n": 0}

    async def boom(**kwargs):
        calls["n"] += 1
        raise RuntimeError("gateway down")

    monkeypatch.setattr(lx.litellm, "acompletion", boom)
    monkeypatch.setattr(lx, "LLM_TIMEOUT", 0.05)
    monkeypatch.setattr(lx, "_WAIT_FOR_GRACE", 0.05)
    monkeypatch.setattr(lx, "_SUMMARIZE_BREAKER_THRESHOLD", 3)
    monkeypatch.setattr(lx, "_summarize_breaker", {"consecutive_failures": 0})

    async def _run_ten():
        for _ in range(10):
            assert await lx.summarize_entity_descriptions(
                "e", ["a", "b"], base_url="http://x"
            ) is None

    asyncio.run(_run_ten())
    # Only the first 3 actually hit litellm; the rest short-circuit.
    assert calls["n"] == 3


def test_summarize_circuit_breaker_resets_on_success(monkeypatch) -> None:
    state = {"n": 0}

    class _Resp:
        class _C:
            class _M:
                content = "a paragraph"
            message = _M()
        choices = [_C()]

    async def flaky(**kwargs):
        state["n"] += 1
        if state["n"] <= 2:
            raise RuntimeError("blip")
        return _Resp()

    monkeypatch.setattr(lx.litellm, "acompletion", flaky)
    monkeypatch.setattr(lx, "LLM_TIMEOUT", 0.5)
    monkeypatch.setattr(lx, "_WAIT_FOR_GRACE", 0.5)
    monkeypatch.setattr(lx, "_SUMMARIZE_BREAKER_THRESHOLD", 3)
    monkeypatch.setattr(lx, "_summarize_breaker", {"consecutive_failures": 0})

    async def _run():
        # 2 failures (breaker still closed at threshold 3), then a success resets.
        assert await lx.summarize_entity_descriptions("e", ["a"], base_url="http://x") is None
        assert await lx.summarize_entity_descriptions("e", ["a"], base_url="http://x") is None
        assert await lx.summarize_entity_descriptions("e", ["a"], base_url="http://x") == "a paragraph"

    asyncio.run(_run())
    assert lx._summarize_breaker["consecutive_failures"] == 0
