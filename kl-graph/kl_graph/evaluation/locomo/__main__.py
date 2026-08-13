from __future__ import annotations

import asyncio

from .codex.cli import main

if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
