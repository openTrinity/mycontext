"""Server-level concurrency: a slow /ask must not block the event loop.

This is the end-to-end proof of the Goal in docs/todo/async-ask.md: one in-flight
``/ask`` (seconds of LLM latency) must NOT stall other requests. We stub the
engine so ``aquery`` awaits a slow event (simulating LLM latency) and assert that
``/status`` still returns promptly while the ask is parked — i.e. the loop stayed
free. A regression to a synchronous inline ``engine.query()`` would pin the loop
and make ``/status`` wait behind the ask.

Also checks the request-admission semaphore serializes past its limit
(queue-and-wait, not error).

Run: ``.venv/bin/python -m pytest tests/test_server_concurrency.py -q``
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.query.engine import QueryResult
from kl_server import app, state


class _SlowEngine:
    """Engine stub whose aquery awaits a release event (simulates LLM latency)."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        self.concurrent = 0
        self.max_concurrent = 0

    async def aquery(self, text: str, force_phase2: bool = False) -> QueryResult:
        self.concurrent += 1
        self.max_concurrent = max(self.max_concurrent, self.concurrent)
        self.started.set()
        try:
            await self.release.wait()  # park here until the test releases us
        finally:
            self.concurrent -= 1
        return QueryResult(items=[], phase=1, entities_found=[])


class _ZeroConn:
    """Minimal sqlite_conn stub: every COUNT(*) returns 0 (graph 'not built').

    Lets ``/ask`` reach its ``chunks_only`` return without a real DB, so these
    tests isolate the async/concurrency behavior from graph-walk machinery.
    """

    def execute(self, *_a, **_k):
        class _Cur:
            def fetchone(self):
                return (0,)

        return _Cur()


@pytest.fixture(autouse=True)
def _patch_state():
    orig_engine = state.engine
    orig_ready = state.ready
    orig_adj = state.adjacency
    orig_sema = state.query_sema
    orig_conn = state.sqlite_conn
    # Graph "not built" so /ask returns after aquery without a graph walk.
    state.adjacency = {}
    state.ready = True
    state.query_sema = None  # force a fresh semaphore on the test loop
    state.sqlite_conn = _ZeroConn()
    yield
    state.engine = orig_engine
    state.ready = orig_ready
    state.adjacency = orig_adj
    state.query_sema = orig_sema
    state.sqlite_conn = orig_conn


async def _run_loop_free_check_health() -> tuple[float, bool]:
    """Fire a slow /ask, then time a concurrent dependency-free /health.

    /health needs no DB, so it isolates the one thing under test: whether the
    event loop is free while an ask is parked. A synchronous inline query would
    pin the loop and /health would not return until the ask finished.
    """
    engine = _SlowEngine()
    state.engine = engine

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
        ask_task = asyncio.create_task(ac.post("/ask", json={"query": "hi"}))
        await asyncio.wait_for(engine.started.wait(), timeout=5)

        loop = asyncio.get_event_loop()
        t0 = loop.time()
        health = await asyncio.wait_for(ac.get("/health"), timeout=5)
        elapsed = loop.time() - t0

        # The ask must still be parked (not yet released) when /health returned —
        # otherwise a fast /health could just mean the ask already finished. This
        # confirms /health overtook a genuinely in-flight ask.
        assert not ask_task.done(), "ask completed before /health; not a real test"
        assert engine.concurrent == 1, "ask should be parked inside aquery"

        engine.release.set()
        ask_resp = await asyncio.wait_for(ask_task, timeout=5)

    ok = health.status_code == 200 and ask_resp.status_code == 200
    return elapsed, ok


def test_status_not_blocked_by_inflight_ask() -> None:
    """The core Goal: an in-flight /ask must not pin the loop."""
    elapsed, ok = asyncio.run(_run_loop_free_check_health())
    assert ok, "both /health and /ask should succeed"
    # If the loop were pinned by the ask, /health would wait for the full ask
    # (which only completes after we release it AFTER timing), hanging until the
    # 5s timeout. Assert it returned effectively immediately.
    assert elapsed < 1.0, f"/health blocked by in-flight ask ({elapsed:.2f}s)"


def test_semaphore_serializes_beyond_limit(monkeypatch) -> None:
    """With the gate set to 2, a 3rd concurrent ask waits until one frees.

    Proves queue-and-wait admission: max in-flight aquery == the semaphore limit,
    and every request still completes (no rejection).
    """
    import kl_server

    monkeypatch.setattr(kl_server, "QUERY_MAX_CONCURRENCY", 2)
    state.query_sema = None  # rebuild at the patched limit

    engine = _SlowEngine()
    state.engine = engine

    async def run() -> tuple[int, list[int]]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as ac:
            tasks = [
                asyncio.create_task(ac.post("/ask", json={"query": f"q{i}"}))
                for i in range(5)
            ]
            # Let admitted asks enter aquery.
            await asyncio.sleep(0.1)
            peak = engine.max_concurrent
            engine.release.set()
            resps = await asyncio.gather(*tasks)
            return peak, [r.status_code for r in resps]

    peak, codes = asyncio.run(run())
    assert peak <= 2, f"semaphore breached: {peak} concurrent asks (limit 2)"
    assert all(c == 200 for c in codes), f"all asks must succeed, got {codes}"
