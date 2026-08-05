"""
h2/_typing
~~~~~~~~~~

Shared typing helpers.
"""
from __future__ import annotations

from typing import Protocol


class Buffer(Protocol):
    """
    An object implementing the PEP 688 buffer protocol.
    """

    def __buffer__(self, flags: int, /) -> memoryview:
        """
        Return a memoryview over this object's bytes.
        """
        ...
