"""Tests for batch-result alignment in kl_graph/ingest/llm_extractor.py.

The batch extractor labels each input as ``[Message i]`` and asks the LLM to
echo that index back as ``msg_index``. These tests pin the two helpers that map
each returned entry back to the right message slot:

  1. In-order responses map trivially (msg_index == position).
  2. Reordered responses still land correctly, keyed by msg_index.
  3. Responses without msg_index fall back to positional order.
  4. A missing slot yields an empty result and does NOT shift later messages.
  5. Extra / out-of-range / duplicate msg_index values don't corrupt real slots.
  6. bool msg_index (bool subclasses int) is rejected.

Pure-logic, runs anywhere. Run: python3 tests/test_batch_alignment.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from kl_graph.ingest.llm_extractor import LLMExtractor

_failures = []


def check(cond, msg):
    if cond:
        print(f"  ok: {msg}")
    else:
        print(f"  FAIL: {msg}")
        _failures.append(msg)
        # Raise so pytest actually fails on a bad check (the bare accumulator
        # pattern used elsewhere in tests/ is invisible to pytest).
        raise AssertionError(msg)


_EMPTY = {"entities": [], "facts": []}


def _align(n, batch_results):
    """Resolve all n slots the way the extractor's consumers do."""
    by_index = LLMExtractor._index_by_msg_index(batch_results)
    return [
        LLMExtractor._result_for_slot(i, batch_results, by_index) for i in range(n)
    ]


def test_in_order():
    br = [
        {"msg_index": 0, "facts": ["a"]},
        {"msg_index": 1, "facts": ["b"]},
        {"msg_index": 2, "facts": ["c"]},
    ]
    out = [r["facts"] for r in _align(3, br)]
    check(out == [["a"], ["b"], ["c"]], "in-order response maps by position")


def test_reordered():
    br = [
        {"msg_index": 2, "facts": ["c"]},
        {"msg_index": 0, "facts": ["a"]},
        {"msg_index": 1, "facts": ["b"]},
    ]
    out = [r["facts"] for r in _align(3, br)]
    check(out == [["a"], ["b"], ["c"]], "reordered response re-keyed by msg_index")


def test_positional_fallback_when_no_index():
    br = [{"facts": ["a"]}, {"facts": ["b"]}, {"facts": ["c"]}]
    out = [r["facts"] for r in _align(3, br)]
    check(
        out == [["a"], ["b"], ["c"]],
        "no msg_index -> positional fallback (order-preserved)",
    )


def test_dropped_message_does_not_shift():
    # Model omitted the entry for message 1 entirely.
    br = [{"msg_index": 0, "facts": ["a"]}, {"msg_index": 2, "facts": ["c"]}]
    out = _align(3, br)
    check(out[0]["facts"] == ["a"], "slot 0 kept")
    check(out[1] == _EMPTY, "dropped slot 1 is empty, not shifted")
    check(out[2]["facts"] == ["c"], "slot 2 stays attributed to message 2")


def test_out_of_range_index_ignored():
    br = [{"msg_index": 0, "facts": ["a"]}, {"msg_index": 9, "facts": ["oob"]}]
    out = _align(2, br)
    check(out[0]["facts"] == ["a"], "valid slot 0 kept")
    # slot 1 has no valid entry; positional fallback would look at index 1,
    # which is the out-of-range entry -> tolerated, but must not crash.
    check(isinstance(out[1], dict), "out-of-range index does not crash slot 1")


def test_duplicate_index_keeps_first():
    br = [
        {"msg_index": 0, "facts": ["first"]},
        {"msg_index": 0, "facts": ["dup"]},
    ]
    by_index = LLMExtractor._index_by_msg_index(br)
    check(by_index[0]["facts"] == ["first"], "duplicate msg_index keeps first entry")


def test_bool_index_rejected():
    # True == 1, but bool must not be accepted as an index.
    br = [{"msg_index": True, "facts": ["x"]}, {"msg_index": 1, "facts": ["b"]}]
    by_index = LLMExtractor._index_by_msg_index(br)
    check(1 in by_index, "real integer index 1 is indexed")
    check(by_index[1]["facts"] == ["b"], "bool did not hijack slot 1")
    check(
        all(not isinstance(k, bool) for k in by_index),
        "no bool keys in the msg_index map",
    )


def test_short_batch_trailing_empty():
    br = [{"msg_index": 0, "facts": ["a"]}]
    out = _align(3, br)
    check(out[0]["facts"] == ["a"], "slot 0 filled")
    check(out[1] == _EMPTY and out[2] == _EMPTY, "missing tail slots are empty")


def test_non_dict_entries_ignored():
    br = ["garbage", None, {"msg_index": 0, "facts": ["a"]}]
    by_index = LLMExtractor._index_by_msg_index(br)
    check(by_index == {0: br[2]}, "non-dict entries skipped when indexing")


if __name__ == "__main__":
    tests = [
        test_in_order,
        test_reordered,
        test_positional_fallback_when_no_index,
        test_dropped_message_does_not_shift,
        test_out_of_range_index_ignored,
        test_duplicate_index_keeps_first,
        test_bool_index_rejected,
        test_short_batch_trailing_empty,
        test_non_dict_entries_ignored,
    ]
    for t in tests:
        try:
            t()
        except AssertionError:
            pass  # already recorded in _failures; keep running other tests
    print()
    if _failures:
        print(f"FAILED ({len(_failures)}):")
        for m in _failures:
            print(f"  - {m}")
        sys.exit(1)
    print("ALL PASSED")
