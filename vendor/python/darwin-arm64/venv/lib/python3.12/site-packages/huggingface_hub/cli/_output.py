# Copyright 2026 The HuggingFace Team. All rights reserved.
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
"""Output framework for the `hf` CLI."""

import dataclasses
import datetime
import json
import re
import shutil
import sys
from collections.abc import Sequence
from enum import Enum
from functools import cache
from typing import Any, cast

import click

from huggingface_hub.errors import ConfirmationError
from huggingface_hub.utils import ANSI, StatusLine, disable_progress_bars, is_agent, tabulate


class OutputFormat(str, Enum):
    """Output format for CLI commands with auto detection of agent/human mode."""

    agent = "agent"
    auto = "auto"
    human = "human"
    json = "json"
    quiet = "quiet"


def _print_flush(*values: Any, **kwargs: Any) -> None:
    """Like `print`, but always flushed: some CLI flows block on user action right after
    printing (e.g. the device-code login), so output must not stay buffered."""
    print(*values, **kwargs, flush=True)


class Output:
    """Output sink for the `hf` CLI.

    Mode is resolved once at init time based on `is_agent()` auto-detection
    and can be overridden per-command via `set_mode()`.
    """

    mode: OutputFormat
    no_truncate: bool

    def __init__(self) -> None:
        self.no_truncate = False
        self.set_mode()

    def set_mode(self, mode: OutputFormat = OutputFormat.auto) -> None:
        """Override the output mode (called once at startup and again per '--format' flag)."""
        if mode == OutputFormat.auto:
            mode = OutputFormat.agent if is_agent() else OutputFormat.human
        self.mode = mode
        if mode != OutputFormat.human:
            disable_progress_bars()

    def set_no_truncate(self, no_truncate: bool) -> None:
        """Toggle off cell truncation for human table output."""
        self.no_truncate = no_truncate

    def is_quiet(self) -> bool:
        return self.mode == OutputFormat.quiet

    def text(self, msg: str | None = None, *, human: str | None = None, agent: str | None = None) -> None:
        """Print a free-form text message to stdout."""
        if msg is not None:
            if human is not None or agent is not None:
                raise ValueError("Cannot mix 'msg' with 'human'/'agent'.")
            human = msg
            agent = _strip_ansi(msg)

        match self.mode:
            case OutputFormat.human:
                if human is not None:
                    _print_flush(human)
            case OutputFormat.agent:
                if agent is not None:
                    _print_flush(agent)
            # json/quiet: no-op

    def table(
        self,
        items: Sequence[dict[str, Any]],
        *,
        headers: list[str] | None = None,
        id_key: str | None = None,
        alignments: dict[str, str] | None = None,
    ) -> None:
        """Print tabular data to stdout.

        Args:
            items: List of dicts. Headers are auto-detected from keys if not provided.
            headers: Explicit column names. If None, derived from dict keys (all-None columns filtered).
            id_key: Key to print in quiet mode. If None, uses the first header.
            alignments: Optional mapping of header name to "left" or "right". Defaults to "left".
        """
        if not items:
            match self.mode:
                case OutputFormat.agent | OutputFormat.human:
                    _print_flush("No results found.")
                case OutputFormat.json:
                    _print_flush("[]")
            return

        if headers is None:
            all_columns = list(items[0].keys())
            headers = [col for col in all_columns if any(item.get(col) is not None for item in items)]
        rows = [[item.get(h) for h in headers] for item in items]

        match self.mode:
            case OutputFormat.human:  # padded table, adaptive truncation, SCREAMING_SNAKE headers
                screaming_headers = [_to_header(h) for h in headers]
                formatted_rows: list[list[str]] = [[_format_table_value_human(v) for v in row] for row in rows]

                is_truncated = _truncate_columns(screaming_headers, formatted_rows, no_truncate=self.no_truncate)

                inferred = {**_infer_alignments(headers, rows), **(alignments or {})}
                screaming_alignments = {_to_header(k): v for k, v in inferred.items()}
                _print_flush(
                    tabulate(
                        cast("list[list[str | int]]", formatted_rows),
                        headers=screaming_headers,
                        alignments=screaming_alignments,
                    ),
                )
                if is_truncated:
                    self.hint("Use `--no-truncate` or `--format json` to display full values.")
            case OutputFormat.agent:  # TSV, no truncation, full timestamps
                _print_flush("\t".join(headers))
                for row in rows:
                    _print_flush("\t".join(_format_table_cell_agent(v) for v in row))
            case OutputFormat.json:  # compact JSON array
                _print_flush(json.dumps(list(items), default=str))
            case OutputFormat.quiet:  # id_key column (or first column), one per line
                quiet_key = id_key or headers[0]
                for item in items:
                    _print_flush(item.get(quiet_key, ""))

    def dict(self, data: Any, *, id_key: str | None = None) -> None:
        """Print structured data as JSON in all modes (indented for human, compact otherwise).

        Accepts a dict or a dataclass.
        """
        if dataclasses.is_dataclass(data) and not isinstance(data, type):
            data = _dataclass_to_dict(data)
        if self.mode == OutputFormat.quiet and id_key is not None:
            _print_flush(data.get(id_key, ""))
            return
        indent = 2 if self.mode == OutputFormat.human else None
        _print_flush(json.dumps(data, indent=indent, default=str))

    def result(self, message: str, **data: Any) -> None:
        """Print a success summary to stdout."""
        match self.mode:
            case OutputFormat.human:  # ✓ message + key: value lines
                parts = [ANSI.green(f"{_ascii_safe('✓', '[OK]')} {message}")]
                for k, v in data.items():
                    if v is not None:
                        parts.append(f"  {k}: {v}")
                _print_flush("\n".join(parts))
            case OutputFormat.agent:  # key=val pairs, space-separated
                parts = [f"{k}={v}" for k, v in data.items() if v is not None]
                _print_flush(" ".join(parts) if parts else message)
            case OutputFormat.json:  # json.dumps(data), message ignored
                _print_flush(json.dumps(data, default=str) if data else "")
            case OutputFormat.quiet:  # first value only
                values = list(data.values())
                if values:
                    _print_flush(values[0])

    def confirm(self, message: str, *, default: bool = False, yes: bool = False, confirm_param: str = "--yes") -> None:
        """
        Ask for confirmation. Raises `ConfirmationError` in non-human modes.
        """
        if yes:
            return
        if self.mode != OutputFormat.human:
            raise ConfirmationError(f"{message} Use {confirm_param} to skip confirmation.")
        click.confirm(message, default=default, abort=True)

    def status(self, message: str | None = None) -> StatusLine:
        """Return a status line that emits only in human mode (no-op otherwise)."""
        status = StatusLine(enabled=self.mode == OutputFormat.human)
        if message is not None:
            status.update(message)
        return status

    def warning(self, message: str) -> None:
        """Print a non-fatal warning to stderr (all modes)."""
        if self.mode == OutputFormat.human:
            _print_flush(ANSI.yellow(f"Warning: {message}"), file=sys.stderr)
        else:
            _print_flush(f"Warning: {message}", file=sys.stderr)

    def error(self, message: str) -> None:
        """Print an error to stderr (all modes)."""
        if self.mode == OutputFormat.human:
            _print_flush(ANSI.red(f"Error: {message}"), file=sys.stderr)
        else:
            _print_flush(f"Error: {message}", file=sys.stderr)

    def log(self, message: str) -> None:
        """Print a text message to stderr (human: gray, json/agent: plain text).

        Suppressed in quiet mode. Kept in json mode (like agent) since agents
        commonly run with ``--format json`` and the message goes to stderr so
        it never pollutes the parsed stdout.
        """
        if self.mode == OutputFormat.quiet:
            return
        if self.mode == OutputFormat.human:
            _print_flush(ANSI.gray(message), file=sys.stderr)
        else:
            _print_flush(message, file=sys.stderr)

    def hint(self, message: str) -> None:
        """Print a helpful hint to stderr (human: gray, json/agent: plain text).

        Suppressed in quiet mode. Kept in json mode (like agent) since agents
        commonly run with ``--format json`` and the next-command hints are useful
        there; hints go to stderr so they never pollute the parsed stdout.
        """
        self.log(f"Hint: {message}")


# HELPERS


@cache
def _ascii_safe(char: str, fallback: str) -> str:
    """Return `char`, or `fallback` if stdout cannot encode it.

    On Windows, `sys.stdout` uses the ANSI code page (e.g. cp1252) instead of the console
    encoding whenever it is not attached to a console (output redirected, piped, captured by
    a CI step). Printing a decoration like "✓" then raises `UnicodeEncodeError` - a
    `ValueError` subclass, so it surfaces as a confusing "Invalid value." error and aborts
    the command. Cached since the stream encoding is fixed for the lifetime of the process.
    """
    encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        char.encode(encoding)
    except (LookupError, UnicodeEncodeError):
        return fallback
    return char


def _serialize_value(v: object) -> object:
    """Recursively serialize a value to be JSON-compatible."""
    if isinstance(v, datetime.datetime):
        return v.isoformat()
    elif isinstance(v, dict):
        return {key: _serialize_value(val) for key, val in v.items() if val is not None}
    elif isinstance(v, list):
        return [_serialize_value(item) for item in v]
    return v


def _dataclass_to_dict(info: Any) -> dict[str, Any]:
    """Convert a dataclass to a json-serializable dict."""
    return {k: _serialize_value(v) for k, v in dataclasses.asdict(info).items() if v is not None}


_ANSI_RE = re.compile(r"\033\[[0-9;]*m")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _single_line(text: str) -> str:
    return " ".join(text.split())


def _to_header(name: str) -> str:
    """Convert a camelCase or PascalCase string to SCREAMING_SNAKE_CASE."""
    s = re.sub(r"([a-z])([A-Z])", r"\1_\2", name)
    return s.upper()


def _infer_alignments(headers: list[str], rows: list[list[Any]]) -> dict[str, str]:
    """Return ``{"col": "right"}`` for columns where every non-None value is numeric."""
    result: dict[str, str] = {}
    for c, h in enumerate(headers):
        if all(row[c] is None or (isinstance(row[c], (int, float)) and not isinstance(row[c], bool)) for row in rows):
            result[h] = "right"
    return result


def _format_table_value_human(value: Any) -> str:
    """Convert a value to string for terminal display."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return _ascii_safe("✔", "yes") if value else ""
    if isinstance(value, datetime.datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}T", value):
        return value[:10]
    if isinstance(value, str):
        return _single_line(value)
    if isinstance(value, list):
        return ", ".join(_format_table_value_human(v) for v in value)
    elif isinstance(value, dict):
        if "name" in value:  # Likely to be a user or org => print name
            return _single_line(str(value["name"]))
        return _single_line(json.dumps(value))
    return _single_line(str(value))


def _truncate_columns(
    headers: list[str],
    rows: list[list[str]],
    *,
    no_truncate: bool,
) -> bool:
    """Truncate cells in-place to fit the current terminal width.

    Returns `True` if any cell was truncated, so the caller can emit a hint.
    `shutil.get_terminal_size` is cross-platform: it honors `$COLUMNS`, then
    queries the OS-native API, then falls back to `(80, 24)`.
    """
    if no_truncate or not rows:
        return False

    n = len(headers)
    # Per-column natural width: longest of header label and cell values.
    natural = [max(len(headers[c]), *(len(rows[r][c]) for r in range(len(rows)))) for c in range(n)]

    # `max(0, n - 1)` accounts for the single-space separator between columns.
    budget = shutil.get_terminal_size().columns - max(0, n - 1)
    if sum(natural) <= budget:
        return False

    # Shrink the widest column 1 char at a time. Floors keep the header label
    # visible; the `4` is the smallest cap that still shows "x..." (one content
    # char plus the "..." marker).
    caps = natural.copy()
    min_widths = [max(len(h), 4) for h in headers]
    while sum(caps) > budget:
        widest = max(
            (i for i, w in enumerate(caps) if w > min_widths[i]),
            key=lambda i: caps[i],
            default=-1,
        )
        if widest < 0:
            break  # everything at floor — table wraps slightly
        caps[widest] -= 1

    truncated = False
    for row in rows:
        for c, cell in enumerate(row):
            if len(cell) > caps[c]:
                truncated = True
                row[c] = cell[: caps[c] - 3] + "..."
    return truncated


def _format_table_cell_agent(value: Any) -> str:
    """Format a cell value for agent TSV output (ISO timestamps, tabs escaped)."""
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    return _single_line(str(value))


out = Output()
