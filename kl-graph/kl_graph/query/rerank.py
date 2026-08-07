"""Opt-in cross-encoder reranker over fused candidates (RAGFlow's model rerank).

RRF (in engine.py) is the always-on "mechanical" fusion stage: it merges the
dense/sparse/structural ranked lists by rank position. This module adds the
*optional* second stage RAGFlow calls ``rerank_by_model`` — a cross-encoder that
re-scores each candidate directly against the query text on one common scale.

Mirroring RAGFlow, the reranker is engaged only when the user configures one
(``KL_RERANK_BASE_URL`` + ``KL_RERANK_MODEL``). Callers gate on
:attr:`Reranker.enabled` (RAGFlow-style ``if rerank_mdl: ...``); the engine
keeps the RRF order when it is disabled. The model is reached over HTTP (like
the embedding server), so the served reranker is swappable without code changes.

Targets the common ``POST /rerank`` shape used by TEI / vLLM / Cohere-style
rerankers:

    request : {"model": ..., "query": <str>, "documents": [<str>, ...]}
    response: {"results": [{"index": i, "relevance_score": s}, ...]}   # TEI/Cohere
              or {"results": [{"index": i, "score": s}, ...]}          # some vLLM
              or {"scores": [s, ...]}                                  # bare scores
"""

from __future__ import annotations

import logging

import httpx

from kl_graph.config import cfg

logger = logging.getLogger(__name__)

# Derived constants from OmegaConf config
RERANK_API_KEY = cfg.services.reranker.api_key or ""
RERANK_BASE_URL = cfg.services.reranker.base_url or ""
RERANK_MODEL = cfg.services.reranker.model or ""
RERANK_TOP_K = int(cfg.pipelines.query.reranking.top_k)


class Reranker:
    """Cross-encoder reranker client; call :meth:`rerank` only when enabled.

    Example:
        reranker = Reranker()
        if reranker.enabled:
            items = reranker.rerank(query, items, top_k=30)
    """

    def __init__(
        self,
        base_url: str = RERANK_BASE_URL,
        model: str = RERANK_MODEL,
        api_key: str = RERANK_API_KEY,
        timeout: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.enabled = bool(self.base_url and self.model)
        if self.enabled:
            logger.info("Reranker enabled: model=%s @ %s", self.model, self.base_url)

    def rerank(
        self, query: str, items: list[dict], top_k: int = RERANK_TOP_K
    ) -> list[dict]:
        """Re-score ``items`` against ``query`` and return the top_k.

        Callers should gate this on :attr:`enabled` (RAGFlow-style
        ``if reranker.enabled: ...``). Each item must carry a ``content``
        string (already resolved by the engine). On any network/API/parse error
        or score-count mismatch the incoming order is preserved (RRF order) and
        truncated to ``top_k`` — the pipeline never fails because of the
        optional reranker.

        Args:
            query: The user query text.
            items: Candidate dicts (must contain ``content``), in RRF order.
            top_k: Number of items to return after reranking.

        Returns:
            The reranked (or, on error, passthrough) items, truncated to ``top_k``.
        """
        if not items:
            return items[:top_k]

        documents = [it.get("content", "") or "" for it in items]
        try:
            scores = self._score(query, documents)
        except Exception as e:  # noqa: BLE001  # network / API / parse — degrade gracefully
            logger.warning(f"Rerank failed, falling back to RRF order: {e}")
            return items[:top_k]

        if len(scores) != len(items):
            logger.warning(
                f"Rerank score count {len(scores)} != {len(items)} items; "
                "falling back to RRF order"
            )
            return items[:top_k]

        # Attach the rerank score (overwriting the RRF score) and sort desc.
        for it, sc in zip(items, scores):
            it["score"] = sc
        ranked = sorted(items, key=lambda it: it["score"], reverse=True)
        return ranked[:top_k]

    def _score(self, query: str, documents: list[str]) -> list[float]:
        """Call the rerank endpoint and return per-document scores in input order."""
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {"model": self.model, "query": query, "documents": documents}

        resp = httpx.post(
            f"{self.base_url}/rerank",
            json=payload,
            headers=headers,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        return self._parse_scores(data, len(documents))

    @staticmethod
    def _parse_scores(data: dict, n: int) -> list[float]:
        """Extract scores in original document order across known response shapes.

        Handles ``{"results": [{"index", "relevance_score"|"score"}]}`` (TEI /
        Cohere / vLLM) and the bare ``{"scores": [...]}`` shape.
        """
        if isinstance(data, dict) and "results" in data:
            scores = [0.0] * n
            for r in data["results"]:
                idx = r.get("index")
                sc = r.get("relevance_score", r.get("score", 0.0))
                if isinstance(idx, int) and 0 <= idx < n:
                    scores[idx] = float(sc)
            return scores
        if isinstance(data, dict) and "scores" in data:
            return [float(s) for s in data["scores"]]
        raise ValueError(f"unrecognized rerank response shape: {list(data)[:5]}")
