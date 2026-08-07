"""Watermark and ingest metadata helpers — read/write the `ingest_meta` key-value table for tracking incremental ingestion state (watermarks, run counts, rebuild timestamps)."""

from __future__ import annotations

import time

from kl_graph.storage.base import KnowledgeStore


def get_watermark(store: KnowledgeStore, source_type: str) -> int | None:
    """Retrieve the last-ingested timestamp watermark for a given source type.

    Args:
        store: The KnowledgeStore instance with get_meta support.
        source_type: Source type key (e.g. "message", "wiki", "mail").

    Returns:
        Unix millisecond timestamp of the last ingested item, or None if unset.
    """
    value = store.get_meta(f"watermark.{source_type}")
    if value is None:
        return None
    return int(value)


def set_watermark(store: KnowledgeStore, source_type: str, timestamp: int) -> None:
    """Persist the watermark timestamp for a given source type.

    Args:
        store: The KnowledgeStore instance with set_meta support.
        source_type: Source type key (e.g. "message", "wiki", "mail").
        timestamp: Unix millisecond timestamp to persist.
    """
    store.set_meta(f"watermark.{source_type}", str(timestamp))


def get_incremental_run_count(store: KnowledgeStore) -> int:
    """Return the number of incremental runs since the last full rebuild.

    Args:
        store: The KnowledgeStore instance.

    Returns:
        Number of incremental runs since last full rebuild.
    """
    value = store.get_meta("incremental_run_count")
    if value is None:
        return 0
    return int(value)


def increment_run_count(store: KnowledgeStore) -> int:
    """Increment the incremental run count by 1 and return the new value.

    Args:
        store: The KnowledgeStore instance.

    Returns:
        The new (incremented) run count.
    """
    current = get_incremental_run_count(store)
    new_count = current + 1
    store.set_meta("incremental_run_count", str(new_count))
    return new_count


def reset_run_count(store: KnowledgeStore) -> None:
    """Reset the incremental run count to 0 and record the current time as last full rebuild.

    Args:
        store: The KnowledgeStore instance.
    """
    store.set_meta("incremental_run_count", "0")
    store.set_meta("last_full_rebuild_at", str(int(time.time())))


def needs_full_rebuild(store: KnowledgeStore, threshold: int) -> bool:
    """Check whether the incremental run count has reached the full rebuild threshold.

    Args:
        store: The KnowledgeStore instance.
        threshold: Maximum incremental runs before forced full rebuild (from KL_FULL_REBUILD_EVERY).

    Returns:
        True if a full rebuild should be triggered.
    """
    return get_incremental_run_count(store) >= threshold
