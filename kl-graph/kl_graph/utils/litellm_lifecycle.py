"""Async entry helpers（原 litellm logging worker 清理已无必要）。

保留 ``run_litellm_coro`` 名字，避免改遍 ingest / periodic 调用点。
"""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any, TypeVar

T = TypeVar("T")


async def stop_litellm_logging_worker() -> None:
    """No-op：HTTP 客户端没有 litellm 后台 logging worker。"""
    return None


def run_litellm_coro(coro: Coroutine[Any, Any, T]) -> T:
    """Run ``coro`` on a fresh event loop（``asyncio.run`` 等价）。"""
    return asyncio.run(coro)
