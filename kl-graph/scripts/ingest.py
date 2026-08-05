#!/usr/bin/env python3
"""Run the v2 ingestion pipeline.

Usage:
    # Full pipeline with smart resume (Phase A if needed, then Phase B)
    python -m scripts.ingest
    python -m scripts.ingest --full        # explicit alias for the default

    # Phase A only: load + chunk + embed every source (no LLM). Usable
    # dense/BM25 RAG at the end; Phase B can be run later to add the graph.
    python -m scripts.ingest --phase-a

    # Advanced cache-replay sub-steps of Phase B (iterate on graph structure
    # without re-billing the LLM). These assume Phase A already ran.
    python -m scripts.ingest --extract-only   # LLM extraction only (cache results)
    python -m scripts.ingest --build-only      # build graph from cached results

    # Adjust concurrency
    python -m scripts.ingest --concurrency 12
"""

import argparse
import asyncio
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from kl_graph.config import CHAT_DIR, QDRANT_PATH, SQLITE_PATH
from kl_graph.ingest.pipeline import IngestionPipeline


async def main():
    parser = argparse.ArgumentParser(description="V2 Ingestion Pipeline")
    parser.add_argument("--full", action="store_true",
                        help="Full pipeline with smart resume (default): run "
                             "Phase A only if chunks aren't already persisted + "
                             "embedded, then Phase B. Phase B alone is not "
                             "offered because a graph with no embedded chunks "
                             "to ground it is not useful.")
    parser.add_argument("--phase-a", action="store_true",
                        help="Phase A only: load + chunk + embed (no LLM). "
                             "Usable vector/BM25 RAG at the end.")
    parser.add_argument("--extract-only", action="store_true",
                        help="Advanced: LLM extraction only (cache results), no "
                             "build. Assumes Phase A already ran.")
    parser.add_argument("--build-only", action="store_true",
                        help="Advanced: build graph from cached results only "
                             "(no LLM). Assumes Phase A already ran.")
    parser.add_argument("--concurrency", type=int, default=8,
                        help="Max concurrent LLM calls (default: 8)")
    parser.add_argument("--fresh-db", action="store_true",
                        help="Delete existing database before building")
    args = parser.parse_args()

    print(f"Chat dir:     {CHAT_DIR}")
    print(f"SQLite path:  {SQLITE_PATH}")
    print(f"Qdrant path:  {QDRANT_PATH}")

    # Ensure data dir exists
    SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)

    if args.fresh_db:
        import shutil
        if SQLITE_PATH.exists():
            SQLITE_PATH.unlink()
            print(f"Deleted {SQLITE_PATH}")
        qdrant_path = Path(QDRANT_PATH)
        if qdrant_path.exists():
            shutil.rmtree(qdrant_path)
            print(f"Deleted {qdrant_path}")

    pipeline = IngestionPipeline(max_concurrent_llm=args.concurrency)

    try:
        if args.phase_a:
            pipeline.run_phase_a()
        elif args.extract_only:
            await pipeline.run_extraction()
        elif args.build_only:
            pipeline.run_graph_build()
        else:
            # default and --full: smart-resume full pipeline
            await pipeline.run_full()
    finally:
        pipeline.close()


if __name__ == "__main__":
    asyncio.run(main())
