#!/usr/bin/env python3
"""Run the v2 ingestion pipeline.

Usage:
    # All invocations require --source-id; --input-dir defaults to the configured
    # application.dws_export_dir.
    # Full pipeline with smart resume (Phase A → Phase B → similarity/communities)
    python -m scripts.ingest --input-dir ./export --source-id dingtalk-prod
    python -m scripts.ingest --input-dir ./export --source-id dingtalk-prod --full

    # Phase A only: load + chunk + embed every source (no LLM). Usable
    # dense/BM25 RAG at the end; Phase B can be run later to add the graph.
    python -m scripts.ingest --phase-a

    # Advanced cache-replay sub-steps of Phase B (iterate on graph structure
    # without re-billing the LLM). These assume Phase A already ran.
    python -m scripts.ingest --extract-only   # LLM extraction only (cache results)
    python -m scripts.ingest --build-only      # build graph from cached results

    # Similarity/community steps only (re-tune without re-extracting)
    python -m scripts.ingest --improve-only

    # Skip similarity/communities for faster iteration
    python -m scripts.ingest --no-improve

    # Adjust concurrency (recommended: 50)
    python -m scripts.ingest --concurrency 50
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

# Configure logging so that warnings/errors from the pipeline are visible
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Parse --config/-c early so load_config() runs before other kl_graph imports
_pre_parser = argparse.ArgumentParser(add_help=False)
_pre_parser.add_argument("-c", "--config", metavar="PATH", default=None)
_pre_args, _ = _pre_parser.parse_known_args()
if _pre_args.config:
    from kl_graph.config import load_config
    load_config(_pre_args.config)

from kl_graph.config import DATA_DIR, GRAPH_DB_PATH, _path, cfg
from kl_graph.ingest.pipeline import IngestionPipeline
from kl_graph.ingest.runner import (
    IngestOptions,
    checkpoint_path,
    make_checkpoint,
    run_ingestion,
)
from kl_graph.storage.vector_store import vector_store_path

# Derived paths / constants from OmegaConf config
DWS_EXPORT_DIR = _path(cfg.application.dws_export_dir)
SQLITE_PATH = DATA_DIR / "knowledge.db"
EXTRACTION_CACHE_PATH = DATA_DIR / "extraction_cache.db"
QDRANT_PATH = str(DATA_DIR / "qdrant_data")
GRAPH_BACKEND = cfg.storage.graph.backend
VECTOR_BACKEND = str(cfg.storage.vector.backend)
KEEP_EXTRACTION_CACHE = bool(cfg.pipelines.ingestion.keep_extraction_cache)


def _vector_path() -> Path:
    # Retain the patchable QDRANT_PATH used by older tests and wrappers.
    if VECTOR_BACKEND == "qdrant":
        return Path(QDRANT_PATH)
    return vector_store_path(VECTOR_BACKEND, DATA_DIR)


def _reset_stores() -> None:
    """Remove rebuildable stores while preserving the extraction cache."""
    import shutil

    if SQLITE_PATH.exists():
        SQLITE_PATH.unlink()
        print(f"Deleted {SQLITE_PATH}")
    vector_path = _vector_path()
    if vector_path.exists():
        shutil.rmtree(vector_path)
        print(f"Deleted {vector_path}")
    if GRAPH_BACKEND == "ladybug":
        # LadybugDB may be a file or a directory, plus WAL/lock/bak siblings;
        # clear all of them so stale nodes from a previous ingest don't linger
        # (edge insertion MATCHes both endpoints, so leftover nodes from an old
        # schema cause silent edge-insertion failures or spurious edges).
        graph_path = Path(GRAPH_DB_PATH)
        for suffix in ("", ".wal", ".lock", ".bak"):
            p = Path(str(graph_path) + suffix)
            if p.is_dir():
                shutil.rmtree(p)
                print(f"Deleted dir {p}")
            elif p.exists():
                p.unlink()
                print(f"Deleted {p}")


async def main():
    parser = argparse.ArgumentParser(description="V2 Ingestion Pipeline")
    parser.add_argument(
        "-c", "--config", metavar="PATH",
        help="Path to a YAML config file (already loaded; shown for --help)",
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=DWS_EXPORT_DIR,
        help="Server-local export directory (default: application.dws_export_dir)",
    )
    parser.add_argument(
        "--source-id",
        required=True,
        help="Stable caller-owned namespace for this input source",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Full pipeline with smart resume (default): run "
        "Phase A only if chunks aren't already persisted + "
        "embedded, then Phase B, then similarity/communities.",
    )
    parser.add_argument(
        "--phase-a",
        action="store_true",
        help="Phase A only: load + chunk + embed (no LLM). "
        "Usable vector/BM25 RAG at the end.",
    )
    parser.add_argument(
        "--extract-only",
        action="store_true",
        help="Advanced: LLM extraction only (cache results), no "
        "build. Assumes Phase A already ran.",
    )
    parser.add_argument(
        "--build-only",
        action="store_true",
        help="Advanced: build graph from cached results only "
        "(no LLM). Assumes Phase A already ran.",
    )
    parser.add_argument(
        "--improve-only",
        action="store_true",
        help="Run similarity/community steps only (steps 1.16–1.23). "
        "Assumes full graph build already done.",
    )
    parser.add_argument(
        "--no-improve",
        action="store_true",
        help="Deprecated alias for --improve-mode off",
    )
    parser.add_argument(
        "--improve-mode",
        choices=("off", "auto", "incremental", "full"),
        default="auto",
        help="Post-build similarity/community policy (default: auto)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=int(cfg.pipelines.ingestion.extraction.concurrency),
        help="Max concurrent LLM calls (default: %(default)s, "
        "override via KL_LLM_CONCURRENCY)",
    )
    parser.add_argument(
        "--fresh-db",
        action="store_true",
        help="Delete graph/content stores before building; preserve extraction cache",
    )
    parser.add_argument(
        "--no-keep-cache",
        action="store_true",
        help="Clear extraction cache after graph build (saves disk)",
    )
    parser.add_argument(
        "--reset-checkpoint",
        nargs="?",
        const="all",
        default=None,
        metavar="PREFIX",
        help="Reset checkpoint (discard progress). Without arg: "
        "reset all. With prefix (e.g. 'improve'): reset "
        "only steps matching that prefix.",
    )
    args = parser.parse_args()

    if args.concurrency <= 0:
        parser.error("--concurrency must be greater than zero")

    input_dir = args.input_dir.expanduser().resolve()
    if not input_dir.is_dir():
        parser.error(f"--input-dir is not a directory: {input_dir}")
    options = IngestOptions(
        input_dir=input_dir,
        source_id=args.source_id,
        concurrency=args.concurrency,
        improve_mode="off" if args.no_improve else args.improve_mode,
        keep_cache=False if args.no_keep_cache else KEEP_EXTRACTION_CACHE,
    )
    checkpoint_file = checkpoint_path(args.source_id)

    print(f"Input dir:    {input_dir}")
    print(f"Source ID:    {args.source_id}")
    print(f"SQLite path:  {SQLITE_PATH}")
    print(f"Extraction cache: {EXTRACTION_CACHE_PATH}")
    print(f"Graph backend: {GRAPH_BACKEND}")
    print(f"Vector backend: {VECTOR_BACKEND}")
    if GRAPH_BACKEND == "ladybug":
        print(f"Ladybug path: {GRAPH_DB_PATH}")

    # Ensure data dir exists
    SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)

    if args.fresh_db:
        import shutil

        if SQLITE_PATH.exists():
            SQLITE_PATH.unlink()
            print(f"Deleted {SQLITE_PATH}")
        vector_path = _vector_path()
        if vector_path.exists():
            shutil.rmtree(vector_path)
            print(f"Deleted {vector_path}")
        # Also clear the graph DB (LadybugDB/FalkorDB) so stale nodes from a
        # previous ingest don't linger. Edge insertion MATCHes both endpoints,
        # so leftover nodes from an old schema cause silent edge-insertion
        # failures or spurious edges.
        if GRAPH_BACKEND == "ladybug":
            graph_path = Path(GRAPH_DB_PATH)
            # LadybugDB may be a file or directory + WAL/lock siblings
            for suffix in ("", ".wal", ".lock", ".bak"):
                p = Path(str(graph_path) + suffix)
                if p.is_dir():
                    shutil.rmtree(p)
                    print(f"Deleted dir {p}")
                elif p.exists():
                    p.unlink()
                    print(f"Deleted {p}")
        # Delete checkpoint file on fresh-db (forces full re-run)
        if checkpoint_file.exists():
            checkpoint_file.unlink()
            print(f"Deleted checkpoint: {checkpoint_file}")

    checkpoint = make_checkpoint(options)
    print(f"Checkpoint:   {checkpoint_file} (hash: {checkpoint.source_hash[:24]}...)")

    # Handle --reset-checkpoint
    if args.reset_checkpoint:
        if args.reset_checkpoint == "all":
            checkpoint.reset()
            print("Checkpoint reset (all steps cleared)")
        else:
            prefix = args.reset_checkpoint
            if not prefix.endswith("."):
                prefix += "."
            checkpoint.clear_prefix(prefix)
            print(f"Checkpoint cleared for prefix: {prefix!r}")

    advanced_mode = any(
        (args.phase_a, args.extract_only, args.build_only, args.improve_only)
    )
    if not advanced_mode:
        await run_ingestion(options, checkpoint=checkpoint)
        return

    pipeline = IngestionPipeline(
        messages_dir=input_dir / "chat",
        max_concurrent_llm=args.concurrency,
        checkpoint=checkpoint,
        keep_cache=options.keep_cache,
        source_id=args.source_id,
        incremental_units=True,
    )

    try:
        if args.phase_a:
            pipeline.run_phase_a()
        elif args.extract_only:
            await pipeline.run_extraction()
        elif args.build_only:
            await pipeline.run_graph_build()
        elif args.improve_only:
            pipeline._init_stores()
            pipeline.run_similarity_and_communities()
    finally:
        pipeline.close()


if __name__ == "__main__":
    asyncio.run(main())
