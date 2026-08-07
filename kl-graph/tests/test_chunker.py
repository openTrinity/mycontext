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

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from kl_graph.ingest.chunker import (
    chunk_text,
    get_delimiters,
    naive_merge,
    num_tokens_from_string,
)

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


# ─── Token-budget path (RAGFlow ``naive_merge`` port) ──────────────────────


def test_num_tokens():
    check(num_tokens_from_string("") == 0, "empty string -> 0 tokens")
    check(num_tokens_from_string("hello world") > 0, "non-empty -> >0 tokens")
    # Chinese text tokenizes to a positive count under cl100k_base (or char/4 fallback).
    check(num_tokens_from_string("数据同步测试") > 0, "cjk -> >0 tokens")


def test_get_delimiters():
    # Backtick-wrapped run is one multi-char delimiter; bare chars are individual.
    pat = get_delimiters("\n。`SESSION_BREAK`")
    check("SESSION_BREAK" in pat, "custom backtick delimiter kept as a unit")
    # Longer delimiters sort first in the alternation (so they match greedily).
    check(pat.index(re.escape("SESSION_BREAK")) < pat.index(re.escape("。")),
          "longer delimiter ordered before shorter one")
    check(get_delimiters("") == "", "empty spec -> empty pattern")


def test_naive_merge_soft_budget():
    # Many short sentences, soft delimiter only: pieces re-merge up to the budget.
    sentences = "。".join([f"这是第{i}句话内容" for i in range(300)]) + "。"
    out = naive_merge(sentences, chunk_token_num=64, delimiter="\n。；！？")
    check(len(out) > 1, f"long input splits into multiple chunks (got {len(out)})")
    check(all(num_tokens_from_string(c) <= 64 * 2 for c in out),
          "soft-merged chunks stay near the token budget")
    joined = "".join(out)
    check("第0句" in joined and "第299句" in joined, "first/last sentences preserved")


def test_naive_merge_hard_custom_delimiter():
    # Custom (backtick) delimiter: each segment its own chunk, budget ignored.
    text = "a" * 20 + "【SB】" + "b" * 20 + "【SB】" + "c" * 20
    out = naive_merge(text, chunk_token_num=1, delimiter="`【SB】`")
    check(len(out) == 3, f"hard delimiter -> one chunk per segment (got {len(out)})")
    check("【SB】" not in "".join(out), "the delimiter itself is dropped")
    check(all(x in "".join(out) for x in ("a" * 20, "b" * 20, "c" * 20)),
          "segment bodies preserved across hard cuts")


def test_naive_merge_hard_then_soft():
    # The intended chat pattern: split on the hard session break first, then
    # size-bound each session with a soft-delimiter call.
    session_a = "。".join([f"会话A句{i}" for i in range(200)]) + "。"
    session_b = "短会话B。"
    doc = session_a + "【SESSION】" + session_b
    sessions = naive_merge(doc, delimiter="`【SESSION】`")
    check(len(sessions) == 2, f"hard split -> 2 sessions (got {len(sessions)})")
    # The big session further splits under a soft budget; the short one stays whole.
    big = naive_merge(sessions[0], chunk_token_num=64, delimiter="\n。；！？")
    small = naive_merge(sessions[1], chunk_token_num=64, delimiter="\n。；！？")
    check(len(big) > 1, "oversized session is size-bounded into multiple chunks")
    check(len(small) == 1, "short session stays a single chunk")


def test_naive_merge_empty():
    check(naive_merge("") == [], "empty string -> no chunks")
    check(naive_merge([]) == [], "empty list -> no chunks")


if __name__ == "__main__":
    test_empty()
    test_short_passthrough()
    test_budget_hard_cut()
    test_delimiter_split_and_merge()
    test_heading_aware()
    test_overlap()
    test_num_tokens()
    test_get_delimiters()
    test_naive_merge_soft_budget()
    test_naive_merge_hard_custom_delimiter()
    test_naive_merge_hard_then_soft()
    test_naive_merge_empty()
    print()
    if _failures:
        print(f"FAILED ({len(_failures)}):")
        for m in _failures:
            print(f"  - {m}")
        sys.exit(1)
    print("ALL PASSED")
