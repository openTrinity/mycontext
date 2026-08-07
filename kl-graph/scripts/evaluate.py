#!/usr/bin/env python3
"""Run the LoCoMo agentic evaluation harness.

Spawns independent Codex KL agents against blind benchmark questions, runs
them against the live KL server, and scores answers against gold references.

Usage:
    python scripts/evaluate.py [options]
    python -m scripts.evaluate [options]
"""

from __future__ import annotations

import asyncio
import sys


def main() -> int:
    from kl_graph.evaluation.agentic.cli import main as eval_main
    return asyncio.run(eval_main())


if __name__ == "__main__":
    raise SystemExit(main())
