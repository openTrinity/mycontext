"""Lifecycle glue for litellm's background logging worker.

litellm lazily spawns a ``LoggingWorker`` task on whatever event loop is
current when a completion is logged. Short-lived loops (``asyncio.run`` in
the batch pipeline) then close with that task still pending, and loop
switches drop the task reference without cancelling it — both surface as
``ERROR Task was destroyed but it is pending!`` noise even though nothing
failed. Stopping the worker on the loop that owns it, before the loop
closes or another loop takes over, keeps batch runs quiet while leaving a
long-running server loop free to keep the worker.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Coroutine
from typing import Any, TypeVar

T = TypeVar("T")


async def stop_litellm_logging_worker() -> None:
    """Stop litellm's logging worker on the current event loop.

    Safe to call when litellm never started a worker (no-op) and never
    raises: a failure to stop a best-effort logging task must not break the
    pipeline that triggered it.
    """
    try:
        from litellm.litellm_core_utils.logging_worker import (
            GLOBAL_LOGGING_WORKER,
        )
    except ImportError:
        return
    # Deliberate: failing to stop a best-effort logging task must not break
    # the pipeline that triggered it.
    with contextlib.suppress(Exception):
        await GLOBAL_LOGGING_WORKER.stop()


def run_litellm_coro(coro: Coroutine[Any, Any, T]) -> T:
    """Run ``coro`` on a fresh event loop, then stop litellm's worker.

    Drop-in replacement for ``asyncio.run`` at entry points whose loop will
    close right after (batch ingest, summarization, disambiguation judges).
    The worker stop runs inside the loop so litellm never has to abandon a
    pending task, which is what logs the destroyed-but-pending error.

    Args:
        coro: The coroutine to run to completion.

    Returns:
        Whatever ``coro`` returns.
    """

    async def _wrapped() -> T:
        try:
            return await coro
        finally:
            await stop_litellm_logging_worker()

    return asyncio.run(_wrapped())
