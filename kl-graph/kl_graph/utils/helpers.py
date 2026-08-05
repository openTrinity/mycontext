"""Shared utilities: RRF fusion, bounded concurrency."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, Coroutine


def rrf(ranked_lists: list[list[tuple[str, float]]], k: int = 60) -> list[tuple[str, float]]:
    """Reciprocal Rank Fusion across multiple retrieval result lists.

    Each ranked_list is [(item_id, score), ...] in descending score order.
    Returns fused ranking as [(item_id, rrf_score), ...] in descending order.
    """
    scores: dict[str, float] = defaultdict(float)
    for ranked in ranked_lists:
        for rank, (item_id, _score) in enumerate(ranked):
            scores[item_id] += 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


async def semaphore_gather(
    tasks: list[Coroutine], max_concurrent: int = 10
) -> list[Any]:
    """Run async tasks with bounded concurrency."""
    semaphore = asyncio.Semaphore(max_concurrent)

    async def bounded(task):
        async with semaphore:
            return await task

    return await asyncio.gather(*[bounded(t) for t in tasks])
