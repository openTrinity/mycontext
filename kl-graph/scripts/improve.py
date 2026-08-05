#!/usr/bin/env python3
"""Run the periodic improvement phase (SIMILAR_TO + disambiguation + communities).

Usage:
    python -m scripts.improve
    python -m scripts.improve --entity-resolution 2.0 --fact-resolution 1.5
    python -m scripts.improve --skip-disambiguation
    python -m scripts.improve --skip-llm-judge  # dry-run disambiguation without LLM
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from kl_graph.periodic.runner import run_periodic_improvement


def main():
    parser = argparse.ArgumentParser(description="Periodic Improvement Phase")
    parser.add_argument("--fact-threshold", type=float, default=0.85,
                        help="Cosine threshold for fact SIMILAR_TO (default: 0.85)")
    parser.add_argument("--entity-emb-threshold", type=float, default=0.65,
                        help="Embedding threshold for entity ANN pre-filter (default: 0.65)")
    parser.add_argument("--entity-hybrid-threshold", type=float, default=0.45,
                        help="Hybrid score threshold for entity SIMILAR_TO (default: 0.45)")
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
    args = parser.parse_args()

    run_periodic_improvement(
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
