"""Ingestion pipeline — load, extract, embed, and build the knowledge graph."""

from kl_graph.ingest.improvement import (
    ImprovementResult,
    ImprovementTargets,
    run_improvement,
)

__all__ = ["ImprovementResult", "ImprovementTargets", "run_improvement"]
