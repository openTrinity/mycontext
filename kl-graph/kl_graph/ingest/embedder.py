"""Embedding client (text-embedding-v4 via litellm)."""

from __future__ import annotations

import asyncio
import logging
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from tqdm import tqdm

from kl_graph.config import cfg
from kl_graph.utils.litellm_config import litellm, litellm_base_url

# Service-level constants (endpoint identity, not behavioral params)
EMBED_API_KEY = cfg.services.embedding.api_key or ""
# Embeddings always ride litellm's OpenAI-compatible transport (see Embedder
# below), so the base URL is normalized to the OpenAI contract regardless of
# which provider serves chat completions.
EMBED_BASE_URL = litellm_base_url("openai", cfg.services.embedding.base_url or "")
EMBED_MODEL = cfg.services.embedding.model
EMBED_SEND_DIMENSIONS = bool(cfg.services.embedding.send_dimensions)
EMBEDDING_DIM = int(cfg.services.embedding.dim)

logger = logging.getLogger(__name__)


class EmbeddingConfigurationError(RuntimeError):
    """An embedding request rejected by the configured gateway."""


_EMBEDDING_CONFIGURATION_HINTS = {
    400: (
        "向量请求配置无效（400）：请检查向量模型名称、维度配置，以及网关是否"
        "支持 /v1/embeddings 的请求参数"
    ),
    401: "向量接口认证失败（401）：请检查 API Key 及网关认证配置",
    403: (
        "向量接口无权限（403）：请确认当前 API Key 有权调用 "
        "/v1/embeddings 和所选向量模型"
    ),
    404: (
        "向量接口或模型不存在（404）：请确认网关支持 "
        "/v1/embeddings，且所选向量模型存在"
    ),
}


class Embedder:
    """Synchronous embedding client over an OpenAI-compatible endpoint.

    Routed through litellm (``openai/<model>`` provider prefix). Points at
    whatever OpenAI-compatible embedding server ``KL_EMBED_*`` configures
    (e.g. a self-hosted Qwen3-Embedding-8B at 4096 dims). Anthropic has no
    embedding API,
    so embeddings always use the OpenAI-compatible transport regardless of
    which provider serves chat completions.
    """

    def __init__(
        self,
        base_url: str = EMBED_BASE_URL,
        model: str = EMBED_MODEL,
        batch_size: int = 10,
        dimensions: int = EMBEDDING_DIM,
        concurrency: int = 10,
        max_retries: int = 3,
        timeout: float = 60.0,
    ):
        # litellm selects the OpenAI-compatible transport from the provider
        # prefix; the bare model name is sent on the wire via api_base.
        self.model = f"openai/{model}"
        self.base_url = base_url
        self.api_key = EMBED_API_KEY or "not-needed"
        self.batch_size = batch_size
        self.dimensions = dimensions
        self.concurrency = max(1, concurrency)
        self.max_retries = max_retries
        self.timeout = timeout
        # Embedding token tracking
        self.usage = {
            "prompt_tokens": 0,
            "total_tokens": 0,
            "api_calls": 0,
        }

    def _embed_kwargs(self, texts: list[str]) -> dict:
        """Build the litellm (a)embedding kwargs shared by sync + async paths."""
        # ``dimensions`` is only sent when the server supports matryoshka
        # truncation (text-embedding-v4). The self-hosted
        # Qwen3-Embedding-8B (vLLM) rejects it with a 400, so it is omitted by
        # default (see EMBED_SEND_DIMENSIONS). encoding_format=float keeps strict
        # servers happy.
        kwargs = dict(  # noqa: C408
            model=self.model,
            input=texts,
            api_base=self.base_url,
            api_key=self.api_key,
            encoding_format="float",
            timeout=self.timeout,
        )
        if EMBED_SEND_DIMENSIONS:
            kwargs["extra_body"] = {"dimensions": self.dimensions}
        return kwargs

    def _track_usage(self, resp) -> None:
        """Fold one embedding response's token usage into ``self.usage``."""
        try:
            usage = getattr(resp, "usage", None)
            if usage:
                pt = getattr(usage, "prompt_tokens", 0) or 0
                tt = getattr(usage, "total_tokens", 0) or pt
                self.usage["prompt_tokens"] += pt
                self.usage["total_tokens"] += tt
            self.usage["api_calls"] += 1
        except Exception:  # noqa: BLE001, S110
            pass

    def _embed(self, texts: list[str]) -> list[list[float]]:
        resp = self._embed_with_retry(self._embed_kwargs(texts))
        self._track_usage(resp)
        return [d["embedding"] for d in resp.data]

    @staticmethod
    def _raise_if_configuration_error(exc: Exception) -> None:
        """Translate deterministic gateway rejections into actionable errors."""
        status = getattr(exc, "status_code", None)
        configuration_hint = _EMBEDDING_CONFIGURATION_HINTS.get(status)
        if configuration_hint is not None:
            raise EmbeddingConfigurationError(
                f"{configuration_hint}；原始错误：{exc}"
            ) from exc

    def _embed_with_retry(self, kwargs: dict):
        """Call ``litellm.embedding`` with bounded exponential backoff.

        A bulk embed of tens of thousands of chunks *will* hit transient
        rate-limits (HTTP 429) on a shared gateway; without a retry a single 429
        propagates out of the thread pool and aborts the whole run, wasting every
        embedding paid for so far. Retry rate-limit / transient errors with
        exponential backoff + jitter, honoring a ``Retry-After`` hint when the
        provider sends one. Non-transient errors (e.g. 400 bad dimensions) raise
        immediately — retrying them is pointless.
        """
        attempt = 0
        while True:
            try:
                return litellm.embedding(**kwargs)
            except Exception as exc:
                self._raise_if_configuration_error(exc)
                if not self._is_transient(exc) or attempt >= self.max_retries:
                    raise
                delay = self._retry_after(exc)
                if delay is None:
                    delay = min(2.0 * (2 ** attempt), 30.0) + random.uniform(0, 1)
                attempt += 1
                logger.warning(
                    "embedding retry %d/%d after %.1fs (%s)",
                    attempt, self.max_retries, delay, type(exc).__name__,
                )
                time.sleep(delay)

    @staticmethod
    def _is_transient(exc: Exception) -> bool:
        """True for errors worth retrying (rate limit / timeout / 5xx)."""
        status = getattr(exc, "status_code", None)
        if status in (408, 409, 429, 500, 502, 503, 504):
            return True
        name = type(exc).__name__
        if name in ("RateLimitError", "Timeout", "TimeoutError", "APITimeoutError",
                    "APIConnectionError",
                    "ServiceUnavailableError", "InternalServerError"):
            return True
        msg = str(exc).lower()
        # ``insufficient_quota`` is a hard stop, not a transient rate-limit — do
        # not spin on it.
        if "insufficient_quota" in msg:
            return False
        return "rate limit" in msg or "timeout" in msg or " 429" in msg

    @staticmethod
    def _retry_after(exc: Exception) -> float | None:
        """Extract a ``Retry-After`` seconds hint from the exception, if any."""
        for attr in ("retry_after", "retry_after_seconds"):
            val = getattr(exc, attr, None)
            if isinstance(val, (int, float)) and val > 0:
                return float(val)
        headers = getattr(exc, "headers", None) or {}
        try:
            ra = headers.get("retry-after") or headers.get("Retry-After")
            if ra is not None:
                return float(ra)
        except (TypeError, ValueError):
            pass
        return None

    def embed_one(self, text: str) -> list[float]:
        """Embed a single text."""
        return self._embed([text])[0]

    async def _aembed(self, texts: list[str]) -> list[list[float]]:
        """Async single-request embed with the same retry policy as ``_embed``.

        Uses ``litellm.aembedding`` so the caller (the async query engine) can
        ``await`` the network round-trip and free the event loop while the
        embedding endpoint works. The bounded exponential backoff mirrors
        ``_embed_with_retry`` but ``await``s ``asyncio.sleep`` instead of
        blocking. Only the query path uses this; bulk ingestion keeps the
        synchronous thread-pool path (``_embed_all``).
        """
        import litellm

        kwargs = self._embed_kwargs(texts)
        attempt = 0
        while True:
            try:
                resp = await litellm.aembedding(**kwargs)
                break
            except Exception as exc:  # noqa: BLE001 - inspect + selectively retry
                self._raise_if_configuration_error(exc)
                if not self._is_transient(exc) or attempt >= self.max_retries:
                    raise
                delay = self._retry_after(exc)
                if delay is None:
                    delay = min(2.0 * (2 ** attempt), 30.0) + random.uniform(0, 1)
                attempt += 1
                logger.warning(
                    "async embedding retry %d/%d after %.1fs (%s)",
                    attempt, self.max_retries, delay, type(exc).__name__,
                )
                await asyncio.sleep(delay)
        self._track_usage(resp)
        return [d["embedding"] for d in resp.data]

    async def aembed_one(self, text: str) -> list[float]:
        """Async embed of a single text (query path)."""
        return (await self._aembed([text]))[0]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch of texts (respects batch_size + concurrency)."""
        return self._embed_all(texts)

    def embed_batch_with_progress(
        self, texts: list[str], desc: str = "Embedding"
    ) -> list[list[float]]:
        """Embed with a tqdm progress bar (respects batch_size + concurrency)."""
        return self._embed_all(texts, desc=desc)

    def _embed_all(
        self, texts: list[str], desc: str | None = None
    ) -> list[list[float]]:
        """Embed many texts as concurrent batch requests, preserving input order.

        Splits ``texts`` into ``batch_size`` chunks and dispatches them across a
        thread pool of ``concurrency`` workers. litellm.embedding is synchronous
        and I/O-bound, so threads overlap the network round-trips. Results are
        written back by batch index so the returned order matches ``texts``.
        """
        if not texts:
            return []

        batches = [
            texts[i : i + self.batch_size]
            for i in range(0, len(texts), self.batch_size)
        ]
        results: list[list[list[float]]] = [[] for _ in batches]

        bar = tqdm(total=len(batches), desc=desc) if desc else None
        try:
            if self.concurrency == 1:
                for idx, batch in enumerate(batches):
                    results[idx] = self._embed(batch)
                    if bar:
                        bar.update(1)
            else:
                with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
                    futures = {
                        pool.submit(self._embed, batch): idx
                        for idx, batch in enumerate(batches)
                    }
                    for fut in as_completed(futures):
                        idx = futures[fut]
                        results[idx] = fut.result()
                        if bar:
                            bar.update(1)
        finally:
            if bar:
                bar.close()

        return [emb for batch_result in results for emb in batch_result]

    def print_usage_stats(self, label: str = "Embedding"):
        """Print embedding token usage statistics."""
        u = self.usage
        if u["api_calls"] == 0:
            return
        print(f"  ── {label} Token Usage ──")
        print(f"  API calls:          {u['api_calls']:,}")
        print(f"  Prompt tokens:      {u['prompt_tokens']:,}")
        print(f"  Total tokens:        {u['total_tokens']:,}")
