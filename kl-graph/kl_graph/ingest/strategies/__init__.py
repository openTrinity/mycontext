"""Pluggable strategies for incremental ingestion — similarity and community assignment."""

import os

from kl_graph.ingest.strategies.base import (
    IncrementalCommunityStrategy,
    IncrementalSimilarityStrategy,
)
from kl_graph.ingest.strategies.community import DynamicFrontierLeiden
from kl_graph.ingest.strategies.similarity import AnnPlusIntraBatch

__all__ = [
    "AnnPlusIntraBatch",
    "DynamicFrontierLeiden",
    "IncrementalCommunityStrategy",
    "IncrementalSimilarityStrategy",
    "get_community_strategy",
    "get_similarity_strategy",
]

# Config env vars with defaults matching the design doc.
_DEFAULT_SIMILARITY_STRATEGY = "ann_intra_batch"
_DEFAULT_COMMUNITY_STRATEGY = "dynamic_frontier_leiden"

_SIMILARITY_REGISTRY: dict[str, type] = {
    "ann_intra_batch": AnnPlusIntraBatch,
}

_COMMUNITY_REGISTRY: dict[str, type] = {
    "dynamic_frontier_leiden": DynamicFrontierLeiden,
}


def get_similarity_strategy(name: str | None = None) -> IncrementalSimilarityStrategy:
    """Return an IncrementalSimilarityStrategy instance by name.

    Reads KL_INCR_SIMILARITY_STRATEGY env var when name is None. Falls back to
    "ann_intra_batch" when neither is set.

    Args:
        name: Strategy registry key. If None, reads from config env var.

    Returns:
        Instantiated strategy object.

    Raises:
        ValueError: Unknown strategy name.
    """
    resolved = name or os.environ.get(
        "KL_INCR_SIMILARITY_STRATEGY", _DEFAULT_SIMILARITY_STRATEGY
    )
    cls = _SIMILARITY_REGISTRY.get(resolved)
    if cls is None:
        known = ", ".join(sorted(_SIMILARITY_REGISTRY))
        raise ValueError(
            f"Unknown similarity strategy {resolved!r}. Known strategies: {known}"
        )
    return cls()


def get_community_strategy(name: str | None = None) -> IncrementalCommunityStrategy:
    """Return an IncrementalCommunityStrategy instance by name.

    Reads KL_INCR_COMMUNITY_STRATEGY env var when name is None. Falls back to
    "dynamic_frontier_leiden" when neither is set.

    Args:
        name: Strategy registry key. If None, reads from config env var.

    Returns:
        Instantiated strategy object.

    Raises:
        ValueError: Unknown strategy name.
    """
    resolved = name or os.environ.get(
        "KL_INCR_COMMUNITY_STRATEGY", _DEFAULT_COMMUNITY_STRATEGY
    )
    cls = _COMMUNITY_REGISTRY.get(resolved)
    if cls is None:
        known = ", ".join(sorted(_COMMUNITY_REGISTRY))
        raise ValueError(
            f"Unknown community strategy {resolved!r}. Known strategies: {known}"
        )
    return cls()
