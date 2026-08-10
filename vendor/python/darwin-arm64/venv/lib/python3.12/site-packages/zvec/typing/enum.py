# Copyright 2025-present the zvec project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
from __future__ import annotations

from enum import IntEnum

__all__ = ["LogLevel", "LogType"]


class LogLevel(IntEnum):
    """Enumeration of logging severity levels, ordered from lowest to highest priority.

    Used to control verbosity and filtering of log messages. Higher numeric values
    indicate more severe conditions.

    Note:
        ``WARNING`` is an alias for ``WARN`` to match Python's built-in :mod:`logging`
        module convention.

    Attributes:
        DEBUG (int): Detailed information, typically of interest only when diagnosing problems.
        INFO (int): Confirmation that things are working as expected.
        WARN (int): An indication that something unexpected happened, or indicative of
            potential future problems. (Alias: ``WARNING``)
        WARNING (int): Same as ``WARN``.
        ERROR (int): Due to a more serious problem, the software has not been able
            to perform some function.
        FATAL (int): A serious error, indicating that the program itself may be unable
            to continue running.
    """

    DEBUG = 0
    INFO = 1
    WARN = 2
    WARNING = 2
    ERROR = 3
    FATAL = 4


class LogType(IntEnum):
    """Enumeration of supported log output destinations.

    Specifies where log messages should be written.

    Attributes:
        CONSOLE (int): Output logs to standard output/error (e.g., terminal or IDE console).
        FILE (int): Write logs to a persistent file on disk.
    """

    CONSOLE = 0
    FILE = 1
