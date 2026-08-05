"""Tests for the shared prose chunker (kl_graph/ingest/chunker.py).

Verifies the RAGFlow-style ``naive_merge`` invariants we rely on for Phase A:
  1. Every chunk respects the character budget (even monster inputs — hard cut).
  2. Delimiters are used as cut points and pieces re-merge up to the budget.
  3. Markdown headings start new sections (heading-aware first pass).
  4. Overlap carries trailing context into the next chunk.
  5. Empty / whitespace input yields no chunks.

Pure-logic, runs anywhere. Run: python3 tests/test_chunker.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from kl_graph.ingest.chunker import chunk_text

_failures = []


def check(cond, msg):
    if cond:
        print(f"  ok: {msg}")
    else:
        print(f"  FAIL: {msg}")
        _failures.append(msg)


def test_empty():
    check(chunk_text("") == [], "empty string -> no chunks")
    check(chunk_text("   \n  ") == [], "whitespace -> no chunks")


def test_short_passthrough():
    check(chunk_text("hello world") == ["hello world"], "short text -> one chunk")


def test_budget_hard_cut():
    mono = "x" * 5000
    out = chunk_text(mono, budget=1000)
    check(all(len(c) <= 1000 for c in out), "monster no-delimiter input hard-cut to budget")
    check(len(out) == 5, f"5000/1000 -> 5 chunks (got {len(out)})")


def test_delimiter_split_and_merge():
    sentences = "。".join([f"这是第{i}句话内容" for i in range(200)])
    out = chunk_text(sentences, budget=300)
    check(all(len(c) <= 300 for c in out), "sentence-split chunks respect budget")
    check("第0句" in out[0] and "第199句" in out[-1], "first/last sentences preserved")
    check(len(out) > 1, f"long input splits into multiple chunks (got {len(out)})")


def test_heading_aware():
    md = "# Title A\npara a text\n\n## Title B\npara b text"
    out = chunk_text(md, budget=10000)
    check(out[0].startswith("# Title A"), "first chunk keeps its H1 heading")
    check(any(c.startswith("## Title B") for c in out), "H2 starts a new section")


def test_overlap():
    long = "\n\n".join([f"paragraph number {i} with some filler words" for i in range(50)])
    o0 = chunk_text(long, budget=200, overlap=0)
    o1 = chunk_text(long, budget=200, overlap=50)
    check(all(len(c) <= 200 for c in o1), "overlap chunks still respect budget")
    check(len(o1) >= len(o0), "overlap produces >= as many chunks (repeats context)")


if __name__ == "__main__":
    test_empty()
    test_short_passthrough()
    test_budget_hard_cut()
    test_delimiter_split_and_merge()
    test_heading_aware()
    test_overlap()
    print()
    if _failures:
        print(f"FAILED ({len(_failures)}):")
        for m in _failures:
            print(f"  - {m}")
        sys.exit(1)
    print("ALL PASSED")
