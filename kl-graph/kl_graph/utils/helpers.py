"""Shared utilities: RRF fusion, bounded concurrency."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import Coroutine
from typing import Any


def rrf(
    ranked_lists: list[list[tuple[str, float]]], k: int = 60
) -> list[tuple[str, float]]:
    """Reciprocal Rank Fusion across multiple retrieval result lists.

    Each ranked_list is [(item_id, score), ...] in descending score order.
    Returns fused ranking as [(item_id, rrf_score), ...] in descending order.
    """
    scores: dict[str, float] = defaultdict(float)
    for ranked in ranked_lists:
        for rank, (item_id, _score) in enumerate(ranked):
            scores[item_id] += 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


def dedup_ranked(
    ranked: list[tuple[str, float]],
) -> list[tuple[str, float]]:
    """Drop repeat ids within a single ranked list, keeping the first (best rank).

    Intended for use *before* :func:`rrf`: a single retrieval route can surface
    the same id at more than one position (e.g. a chunk that MENTIONS two
    matched entities is emitted once per entity during structural expansion).
    Left unchecked, that one route contributes ``1/(k+rank)`` twice for the same
    item, over-weighting it in the fusion. Deduping *within* the list before it
    reaches ``rrf`` collapses those repeats to the item's best (first) rank.

    This must never be applied *across* lists: an id legitimately present in
    several routes is exactly the multi-route corroboration signal RRF is
    designed to harvest.

    Args:
        ranked: A single route's ``[(item_id, score), ...]`` in rank order
            (best first).

    Returns:
        The same list with later repeats of any id removed; the first
        occurrence (best rank) is kept. Order is otherwise preserved.
    """
    seen: set[str] = set()
    out: list[tuple[str, float]] = []
    for item_id, score in ranked:
        if item_id in seen:
            continue
        seen.add(item_id)
        out.append((item_id, score))
    return out


async def semaphore_gather(
    tasks: list[Coroutine], max_concurrent: int = 10
) -> list[Any]:
    """Run async tasks with bounded concurrency."""
    semaphore = asyncio.Semaphore(max_concurrent)

    async def bounded(task):
        async with semaphore:
            return await task

    return await asyncio.gather(*[bounded(t) for t in tasks])
