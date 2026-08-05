"""Embedding client (DashScope text-embedding-v4 via litellm)."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed

import litellm
from tqdm import tqdm

from kl_graph.config import (
    EMBED_API_KEY,
    EMBED_BASE_URL,
    EMBED_BATCH_SIZE,
    EMBED_CONCURRENCY,
    EMBED_MODEL,
    EMBED_SEND_DIMENSIONS,
    EMBEDDING_DIM,
)


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
        batch_size: int = EMBED_BATCH_SIZE,
        dimensions: int = EMBEDDING_DIM,
        concurrency: int = EMBED_CONCURRENCY,
    ):
        # litellm selects the OpenAI-compatible transport from the provider
        # prefix; the bare model name is sent on the wire via api_base.
        self.model = f"openai/{model}"
        self.base_url = base_url
        self.api_key = EMBED_API_KEY or "not-needed"
        self.batch_size = batch_size
        self.dimensions = dimensions
        self.concurrency = max(1, concurrency)
        # Embedding token tracking
        self.usage = {
            "prompt_tokens": 0,
            "total_tokens": 0,
            "api_calls": 0,
        }

    def _embed(self, texts: list[str]) -> list[list[float]]:
        # ``dimensions`` is only sent when the server supports matryoshka
        # truncation (DashScope text-embedding-v4). The self-hosted
        # Qwen3-Embedding-8B (vLLM) rejects it with a 400, so it is omitted by
        # default (see EMBED_SEND_DIMENSIONS). encoding_format=float keeps strict
        # servers happy.
        kwargs = dict(
            model=self.model,
            input=texts,
            api_base=self.base_url,
            api_key=self.api_key,
            encoding_format="float",
        )
        if EMBED_SEND_DIMENSIONS:
            kwargs["extra_body"] = {"dimensions": self.dimensions}
        resp = litellm.embedding(**kwargs)
        # Track embedding token usage
        try:
            usage = getattr(resp, "usage", None)
            if usage:
                pt = getattr(usage, "prompt_tokens", 0) or 0
                tt = getattr(usage, "total_tokens", 0) or pt
                self.usage["prompt_tokens"] += pt
                self.usage["total_tokens"] += tt
            self.usage["api_calls"] += 1
        except Exception:
            pass
        return [d["embedding"] for d in resp.data]

    def embed_one(self, text: str) -> list[float]:
        """Embed a single text."""
        return self._embed([text])[0]

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
