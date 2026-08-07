"""Ingestion pipeline — load, extract, embed, and build the knowledge graph."""

from kl_graph.ingest.incremental import IncrementalIngestion
from kl_graph.ingest.watermark import (
    get_incremental_run_count,
    get_watermark,
    increment_run_count,
    needs_full_rebuild,
    reset_run_count,
    set_watermark,
)

__all__ = [
    "IncrementalIngestion",
    "get_incremental_run_count",
    "get_watermark",
    "increment_run_count",
    "needs_full_rebuild",
    "reset_run_count",
    "set_watermark",
]
