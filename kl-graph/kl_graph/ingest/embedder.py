"""Embedding client（OpenAI 兼容 HTTP，经 http_llm）。"""

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
# Embeddings always ride the OpenAI-compatible transport (see Embedder
# below), so the base URL is normalized to the OpenAI contract regardless of
# which provider serves chat completions.
EMBED_BASE_URL = litellm_base_url("openai", cfg.services.embedding.base_url or "")
EMBED_MODEL = cfg.services.embedding.model
EMBED_SEND_DIMENSIONS = bool(cfg.services.embedding.send_dimensions)
EMBEDDING_DIM = int(cfg.services.embedding.dim)

logger = logging.getLogger(__name__)


class Embedder:
    """Synchronous embedding client over an OpenAI-compatible endpoint.

    Points at whatever OpenAI-compatible embedding server ``KL_EMBED_*``
    configures (e.g. a self-hosted Qwen3-Embedding-8B at 4096 dims). Anthropic
    has no embedding API, so embeddings always use the OpenAI-compatible
    transport regardless of which provider serves chat completions.
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
        *,
        max_input_tokens: int | None = None,
    ):
        # Bare model name on the wire; ``openai/`` prefix is for our client routing.
        self.model = f"openai/{model}" if not str(model).startswith("openai/") else str(model)
        self.base_url = base_url
        self.api_key = EMBED_API_KEY or "not-needed"
        self.batch_size = batch_size
        self.dimensions = dimensions
        self.concurrency = max(1, concurrency)
        self.max_retries = max_retries
        self.timeout = timeout
        # Soft budget for packing / pre-split. None = only react when the server
        # returns exceed_context_size (self-hosted llama.cpp often ~8k).
        self.max_input_tokens = (
            int(max_input_tokens) if max_input_tokens is not None and max_input_tokens > 0 else None
        )
        # Embedding token tracking
        self.usage = {
            "prompt_tokens": 0,
            "total_tokens": 0,
            "api_calls": 0,
        }

    def _embed_kwargs(self, texts: list[str]) -> dict:
        """Build (a)embedding kwargs shared by sync + async paths."""
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
        """Embed one wire batch; split on context-window errors instead of aborting."""
        if not texts:
            return []
        # 主动拆：中文会话块常按 ≈1 token/字，不能等 400 再拆（旧进程/异常包装会漏捕）。
        budget = self.max_input_tokens
        if budget is not None and len(texts) == 1 and self._estimate_tokens(texts[0]) > budget:
            return [self._embed_long_text(texts[0])]
        try:
            return self._embed_raw(texts)
        except Exception as exc:
            if not self._is_context_overflow(exc):
                raise
            if len(texts) > 1:
                mid = max(1, len(texts) // 2)
                logger.warning(
                    "embedding context overflow on batch of %d; splitting %d+%d",
                    len(texts),
                    mid,
                    len(texts) - mid,
                )
                return self._embed(texts[:mid]) + self._embed(texts[mid:])
            return [self._embed_long_text(texts[0])]

    def _embed_raw(self, texts: list[str]) -> list[list[float]]:
        """Single HTTP embedding call (no proactive split)."""
        resp = self._embed_with_retry(self._embed_kwargs(texts))
        self._track_usage(resp)
        return [d["embedding"] for d in resp.data]

    @staticmethod
    def _is_context_overflow(exc: BaseException) -> bool:
        name = type(exc).__name__
        if name in {"ContextWindowExceededError", "BadRequestError"}:
            msg = str(exc).lower()
            if (
                "exceed_context_size" in msg
                or "exceeds the available context" in msg
                or "context size" in msg
            ):
                return True
            if name == "ContextWindowExceededError":
                return True
        msg = str(exc).lower()
        return "exceed_context_size" in msg or "exceeds the available context" in msg

    def _embed_long_text(self, text: str) -> list[float]:
        """Split to ≤8192-token windows and mean-pool (no content dropped).

        Self-hosted llama often runs ``-c 8192`` (n_ctx≈8704). Oversized chat
        slices (~15k tokens) must be windowed on the client; truncating is wrong.
        """
        text = text or ""
        budget = int(self.max_input_tokens or 8192)
        budget = max(512, min(budget, 8192))
        # estimate = len(text)（见下），所以 char 窗宽 = token 预算。
        char_budget = budget
        if len(text) <= char_budget:
            return self._embed_raw([text])[0]

        parts: list[str] = []
        i = 0
        n = len(text)
        while i < n:
            j = min(n, i + char_budget)
            if j < n:
                # 尽量在换行处切开，避免把一行汉字从中间撕开
                window = text[i:j]
                cut = window.rfind("\n")
                if cut >= max(64, char_budget // 4):
                    j = i + cut + 1
            piece = text[i:j]
            if not piece:
                piece = text[i : i + 1]
                j = i + 1
            parts.append(piece)
            i = j

        logger.warning(
            "embedding long text chars=%d budget=%d → %d windows (mean-pool)",
            len(text),
            budget,
            len(parts),
        )
        vectors = [self._embed_raw([p])[0] for p in parts]
        dim = len(vectors[0])
        scale = 1.0 / len(vectors)
        return [sum(v[d] for v in vectors) * scale for d in range(dim)]

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        # Qwen 中文会话实测常接近 1 token/字；用 len 做上界，宁可多拆。
        return max(1, len(text or ""))

    def _pack_batches(self, texts: list[str]) -> list[list[str]]:
        """Pack by count and optional token budget so wire batches fit n_ctx."""
        if self.max_input_tokens is None:
            return [
                texts[i : i + self.batch_size]
                for i in range(0, len(texts), self.batch_size)
            ]
        batches: list[list[str]] = []
        cur: list[str] = []
        cur_tok = 0
        budget = self.max_input_tokens
        for text in texts:
            est = self._estimate_tokens(text)
            if est > budget:
                if cur:
                    batches.append(cur)
                    cur, cur_tok = [], 0
                batches.append([text])
                continue
            if cur and (
                len(cur) >= self.batch_size or cur_tok + est > budget
            ):
                batches.append(cur)
                cur, cur_tok = [], 0
            cur.append(text)
            cur_tok += est
        if cur:
            batches.append(cur)
        return batches

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

        Uses ``litellm.aembedding``（http_llm）so the caller (the async query
        engine) can ``await`` the network round-trip and free the event loop
        while the embedding endpoint works. The bounded exponential backoff
        mirrors ``_embed_with_retry`` but ``await``s ``asyncio.sleep`` instead of
        blocking. Only the query path uses this; bulk ingestion keeps the
        synchronous thread-pool path (``_embed_all``).
        """
        kwargs = self._embed_kwargs(texts)
        attempt = 0
        while True:
            try:
                resp = await litellm.aembedding(**kwargs)
                break
            except Exception as exc:  # noqa: BLE001 - inspect + selectively retry
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

        batches = self._pack_batches(texts)
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
