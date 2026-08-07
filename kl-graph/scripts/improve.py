#!/usr/bin/env python3
"""Run the periodic improvement phase (similarity + disambiguation + communities).

Usage:
    python -m scripts.improve
    python -m scripts.improve --entity-resolution 2.0 --fact-resolution 1.5
    python -m scripts.improve --skip-disambiguation
    python -m scripts.improve --skip-llm-judge  # dry-run disambiguation without LLM
    python -m scripts.improve --reset-checkpoint  # force re-run all improve steps
"""  # noqa: EXE001

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# Parse --config/-c early so load_config() runs before other kl_graph imports
_pre_parser = argparse.ArgumentParser(add_help=False)
_pre_parser.add_argument("-c", "--config", metavar="PATH", default=None)
_pre_args, _ = _pre_parser.parse_known_args()
if _pre_args.config:
    from kl_graph.config import load_config
    load_config(_pre_args.config)

from kl_graph.config import cfg, DATA_DIR, _path
from kl_graph.periodic.runner import run_periodic_improvement

# Derived paths / constants from OmegaConf config
DWS_EXPORT_DIR = _path(cfg.application.dws_export_dir)
CHAT_DIR = DWS_EXPORT_DIR / "chat"
WIKI_DIR = DWS_EXPORT_DIR / "wiki"
MAIL_DIR = DWS_EXPORT_DIR / "mail"
MINUTES_DIR = DWS_EXPORT_DIR / "minutes"
GENERIC_SOURCES = tuple(cfg.pipelines.ingestion.generic_sources)
CHECKPOINT_PATH = DATA_DIR / "ingest_checkpoint.json"


def main():
    parser = argparse.ArgumentParser(description="Periodic Improvement Phase")
    parser.add_argument(
        "-c", "--config", metavar="PATH",
        help="Path to a YAML config file (already loaded; shown for --help)",
    )
    parser.add_argument("--fact-threshold", type=float, default=0.85,
                        help="Cosine threshold for fact FACT_SIMILAR (default: 0.85)")
    parser.add_argument("--entity-emb-threshold", type=float, default=0.65,
                        help="Embedding threshold for entity ANN pre-filter (default: 0.65)")
    parser.add_argument("--entity-hybrid-threshold", type=float, default=0.45,
                        help="Hybrid score threshold for entity ENTITY_SIMILAR (default: 0.45)")
    parser.add_argument("--entity-resolution", type=float, default=2.0,
                        help="Leiden resolution for entity communities (default: 2.0)")
    parser.add_argument("--fact-resolution", type=float, default=1.5,
                        help="Leiden resolution for fact communities (default: 1.5)")
    parser.add_argument("--fact-min-cluster", type=int, default=5,
                        help="HDBSCAN min_cluster_size for facts (default: 5)")
    # Disambiguation options
    parser.add_argument("--skip-disambiguation", action="store_true",
                        help="Skip entity disambiguation entirely")
    parser.add_argument("--skip-llm-judge", action="store_true",
                        help="Skip LLM judge (auto-reject ambiguous pairs)")
    parser.add_argument("--llm-budget", type=int, default=500,
                        help="Max LLM calls for disambiguation judge (default: 500)")
    # Checkpoint options
    parser.add_argument("--reset-checkpoint", action="store_true",
                        help="Clear improve.* checkpoint entries before running")
    parser.add_argument("--no-checkpoint", action="store_true",
                        help="Run without checkpoint (ignore and don't update)")
    args = parser.parse_args()

    # Initialize checkpoint
    checkpoint = None
    if not args.no_checkpoint:
        from kl_graph.ingest.checkpoint import IngestCheckpoint

        source_dirs = [
            d for d in [
                CHAT_DIR, WIKI_DIR, MAIL_DIR, MINUTES_DIR,
                *(DWS_EXPORT_DIR / name for name in GENERIC_SOURCES),
            ]
            if d.exists()
        ]
        checkpoint = IngestCheckpoint(CHECKPOINT_PATH, source_dirs)
        print(f"Checkpoint: {CHECKPOINT_PATH} (hash: {checkpoint.source_hash[:24]}...)")

        if args.reset_checkpoint:
            checkpoint.clear_prefix("improve.")
            print("  Cleared improve.* checkpoint entries")

    run_periodic_improvement(
        checkpoint=checkpoint,
        fact_sim_threshold=args.fact_threshold,
        entity_emb_threshold=args.entity_emb_threshold,
        entity_hybrid_threshold=args.entity_hybrid_threshold,
        entity_resolution=args.entity_resolution,
        fact_resolution=args.fact_resolution,
        fact_min_cluster_size=args.fact_min_cluster,
        run_disambiguation=not args.skip_disambiguation,
        skip_llm_judge=args.skip_llm_judge,
        llm_max_budget=args.llm_budget,
    )


if __name__ == "__main__":
    main()
