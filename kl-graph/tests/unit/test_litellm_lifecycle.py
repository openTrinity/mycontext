"""Tests for the litellm logging-worker lifecycle helpers."""

from __future__ import annotations

import asyncio

from kl_graph.utils.litellm_lifecycle import (
    run_litellm_coro,
    stop_litellm_logging_worker,
)


def test_run_litellm_coro_returns_value() -> None:
    async def produce() -> int:
        return 42

    assert run_litellm_coro(produce()) == 42


def test_run_litellm_coro_propagates_exceptions() -> None:
    async def boom() -> None:
        raise ValueError("expected")

    try:
        run_litellm_coro(boom())
    except ValueError as exc:
        assert str(exc) == "expected"
    else:
        raise AssertionError("ValueError did not propagate")


def test_run_litellm_coro_stops_litellm_worker() -> None:
    """After the loop closes, litellm must hold no live worker task.

    A leftover task is exactly what asyncio reports as "Task was destroyed
    but it is pending!" — so asserting the worker is gone is the regression
    this helper exists for.
    """
    from litellm.litellm_core_utils.logging_worker import GLOBAL_LOGGING_WORKER

    async def work() -> None:
        GLOBAL_LOGGING_WORKER.start()
        assert GLOBAL_LOGGING_WORKER._worker_task is not None

    run_litellm_coro(work())
    assert GLOBAL_LOGGING_WORKER._worker_task is None


def test_stop_helper_is_safe_with_no_loop_and_no_worker() -> None:
    # No running loop, worker never started: must not raise.
    asyncio.run(stop_litellm_logging_worker())
