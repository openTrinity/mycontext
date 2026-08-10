#!/usr/bin/env python3
"""Generate LLM-powered community summaries over mixed (entity + fact) communities.

Wraps kl_graph.periodic.community_summarizer.run_community_summarization()
with CLI argument parsing. Run after community detection (scripts/improve.py)
and before community embedding (scripts/embed_communities.py).
"""

from __future__ import annotations

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate community summaries")
    parser.add_argument(
        "-c", "--config", metavar="PATH",
        help="Path to a YAML config file (merged on top of config.default.yaml)",
    )
    parser.add_argument(
        "--max-concurrent", type=int, default=None,
        help="Max concurrent summarization LLM calls "
             "(default: pipelines.ingestion.community_summarization.max_concurrent)",
    )
    parser.add_argument("--min-members", type=int, default=10)
    args = parser.parse_args()

    if args.config:
        from kl_graph.config import load_config
        load_config(args.config)

    from kl_graph.config import DATA_DIR, cfg
    from kl_graph.periodic.community_summarizer import run_community_summarization
    from kl_graph.storage.sqlite_store import SQLiteStore

    if not bool(cfg.pipelines.experimental.communities.enabled):
        raise SystemExit(
            "Community features are experimental and disabled; set "
            "KL_COMMUNITIES_ENABLED=1 to summarize them."
        )

    sqlite_path = DATA_DIR / "knowledge.db"
    store = SQLiteStore(sqlite_path)
    try:
        n_stored = run_community_summarization(
            store,
            levels=None,
            min_members=args.min_members,
            max_concurrent=args.max_concurrent,
        )
        print(f"\nStored {n_stored} community summaries.")
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
