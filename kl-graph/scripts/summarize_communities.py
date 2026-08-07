#!/usr/bin/env python3
"""Generate LLM-powered community summaries.

Wraps kl_graph.periodic.community_summarizer.run_community_summarization()
with CLI argument parsing. Run after community detection (scripts/improve.py)
and before community embedding (scripts/embed_communities.py).
"""

from __future__ import annotations

import argparse
import asyncio
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate community summaries")
    parser.add_argument(
        "-c", "--config", metavar="PATH",
        help="Path to a YAML config file (merged on top of config.default.yaml)",
    )
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--min-members", type=int, default=3)
    args = parser.parse_args()

    if args.config:
        from kl_graph.config import load_config
        load_config(args.config)

    from kl_graph.periodic.community_summarizer import run_community_summarization

    asyncio.run(run_community_summarization(
        concurrency=args.concurrency,
        batch_size=args.batch_size,
        min_members=args.min_members,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
