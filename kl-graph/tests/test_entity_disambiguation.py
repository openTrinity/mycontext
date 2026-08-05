"""Tests for the entity disambiguation LLM judge.

Focus: the LLM judge must issue its per-batch completion calls CONCURRENTLY
(async acompletion + asyncio.gather), not sequentially. Sequential blocking
calls made the disambiguation phase slow.

We patch litellm.acompletion with a fake async function that (a) records the
maximum number of overlapping in-flight calls and (b) returns valid verdict
JSON, so we can assert real concurrency behavior without hitting the network.
"""

from __future__ import annotations

import asyncio
import sqlite3
import types

import pytest

from kl_graph.periodic import entity_disambiguation as ed
from kl_graph.periodic.entity_disambiguation import (
    CandidatePair,
    EntityInfo,
    run_llm_judge,
)
from kl_graph.storage.sqlite_store import SQLiteStore


def _make_pair(i: int) -> CandidatePair:
    a = EntityInfo(id=f"a{i}", name=f"nameA{i}", entity_type="person")
    b = EntityInfo(id=f"b{i}", name=f"nameB{i}", entity_type="person")
    return CandidatePair(entity_a=a, entity_b=b, hybrid_score=0.5, decision="judge")


def _memory_store() -> SQLiteStore:
    conn = sqlite3.connect(":memory:")
    return SQLiteStore(db_path=None, conn=conn)


class _ConcurrencyTracker:
    """Fake acompletion recording peak concurrency and returning verdicts."""

    def __init__(self, delay: float = 0.05):
        self.delay = delay
        self.in_flight = 0
        self.max_in_flight = 0
        self.calls = 0

    async def __call__(self, *args, **kwargs):
        self.calls += 1
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.delay)
        finally:
            self.in_flight -= 1
        # One "same_entity: true" verdict per pair in the batch prompt.
        # Batch size defaults to 5; return enough verdicts for any batch.
        verdicts = ", ".join(
            f'{{"pair": {k + 1}, "same_entity": true, "confidence": 0.9}}'
            for k in range(5)
        )
        content = f"[{verdicts}]"
        message = types.SimpleNamespace(content=content)
        choice = types.SimpleNamespace(message=message)
        return types.SimpleNamespace(choices=[choice])


def test_llm_judge_runs_batches_concurrently(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "test-token")
    tracker = _ConcurrencyTracker(delay=0.05)
    monkeypatch.setattr(ed.litellm, "acompletion", tracker)

    sqlite = _memory_store()
    # 20 pairs, batch_size 5 -> 4 batches. If concurrent, they overlap.
    pairs = [_make_pair(i) for i in range(20)]

    run_llm_judge(pairs, sqlite, batch_size=5, max_budget=500)

    assert tracker.calls == 4, "expected 4 batches"
    assert tracker.max_in_flight > 1, (
        "batches ran sequentially (max_in_flight=1); expected concurrent execution"
    )


def test_llm_judge_applies_verdicts(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "test-token")
    tracker = _ConcurrencyTracker(delay=0.0)
    monkeypatch.setattr(ed.litellm, "acompletion", tracker)

    sqlite = _memory_store()
    pairs = [_make_pair(i) for i in range(5)]

    result = run_llm_judge(pairs, sqlite, batch_size=5, max_budget=500)

    # All verdicts were same_entity=true -> every pair should be linked.
    assert all(p.decision == "link" for p in result)
    assert all(p.confidence == pytest.approx(0.9) for p in result)


def test_llm_judge_no_api_key_rejects_all(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    sqlite = _memory_store()
    pairs = [_make_pair(i) for i in range(3)]

    result = run_llm_judge(pairs, sqlite, batch_size=5, max_budget=500)

    assert all(p.decision == "reject" for p in result)
