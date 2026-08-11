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
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def main() -> int:
    from kl_graph.evaluation.locomo.runners.codex.cli import main as eval_main

    return asyncio.run(eval_main())


if __name__ == "__main__":
    raise SystemExit(main())
