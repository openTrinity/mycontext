"""Tests for async entry helpers（原 litellm lifecycle）。"""

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


def test_stop_helper_is_safe_with_no_loop_and_no_worker() -> None:
    # No running loop: must not raise.
    asyncio.run(stop_litellm_logging_worker())
