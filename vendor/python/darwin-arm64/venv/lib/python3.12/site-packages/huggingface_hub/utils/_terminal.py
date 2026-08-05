# Copyright 2025 The HuggingFace Team. All rights reserved.
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
"""Contains utilities to print stuff to the terminal (styling, helpers)."""

import ctypes
import os
import shutil
import sys
from contextlib import contextmanager

from ._detect_agent import is_agent


if sys.platform == "win32":
    import msvcrt
else:
    import select
    import termios
    import tty


class StatusLine:
    """Minimal TTY status line for sync progress (stderr, single-line overwrite)."""

    def __init__(self, enabled: bool = True):
        self._active = enabled and sys.stderr.isatty()

    def update(self, msg: str) -> None:
        if not self._active:
            return
        width = shutil.get_terminal_size().columns
        if len(msg) > width - 1:
            msg = msg[: width - 4] + "..."
        sys.stderr.write(f"\r\033[K\033[90m{msg}\033[0m")
        sys.stderr.flush()

    def done(self, msg: str) -> None:
        if not self._active:
            return
        width = shutil.get_terminal_size().columns
        if len(msg) > width - 1:
            msg = msg[: width - 4] + "..."
        sys.stderr.write(f"\r\033[K\033[90m{msg}\033[0m\n")
        sys.stderr.flush()


class ANSI:
    """
    Helper for en.wikipedia.org/wiki/ANSI_escape_code
    """

    _blue = "\u001b[34m"
    _bold = "\u001b[1m"
    _gray = "\u001b[90m"
    _green = "\u001b[32m"
    _red = "\u001b[31m"
    _reset = "\u001b[0m"
    _underline = "\u001b[4m"
    _yellow = "\u001b[33m"

    @classmethod
    def blue(cls, s: str) -> str:
        return cls._format(s, cls._blue)

    @classmethod
    def bold(cls, s: str) -> str:
        return cls._format(s, cls._bold)

    @classmethod
    def gray(cls, s: str) -> str:
        return cls._format(s, cls._gray)

    @classmethod
    def green(cls, s: str) -> str:
        return cls._format(s, cls._green)

    @classmethod
    def red(cls, s: str) -> str:
        return cls._format(s, cls._bold + cls._red)

    @classmethod
    def underline(cls, s: str) -> str:
        return cls._format(s, cls._underline)

    @classmethod
    def yellow(cls, s: str) -> str:
        return cls._format(s, cls._yellow)

    @classmethod
    def _format(cls, s: str, code: str) -> str:
        if os.environ.get("NO_COLOR") or is_agent():
            # See https://no-color.org/
            return s
        return f"{code}{s}{cls._reset}"


def select_choice(prompt: str, choices: list[str]) -> int:
    """Single-choice interactive prompt. Returns the index of the selected choice.

    On a TTY, renders an arrow-key menu (Up/Down to move, Enter to confirm, 1-9 to pick
    directly, Ctrl+C to abort). Falls back to a numbered `input()` prompt when raw
    keyboard input is not available. Callers are responsible for not prompting at all in
    non-interactive contexts.
    """
    if not choices:
        raise ValueError("select_choice() requires at least one choice.")
    if _supports_raw_keyboard():
        return _select_with_arrows(prompt, choices)
    return _select_with_numbers(prompt, choices)


def _supports_raw_keyboard() -> bool:
    if not (sys.stdin and sys.stdin.isatty() and sys.stdout.isatty()):
        return False
    if sys.platform == "win32":
        return _enable_windows_vt_processing()
    return True


def _enable_windows_vt_processing() -> bool:
    """Enable VT escape-sequence processing on the Windows console (off by default in legacy
    cmd.exe/PowerShell windows, where the menu would otherwise render as literal `←[K` garbage)."""
    ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
    STD_OUTPUT_HANDLE = -11
    try:
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.GetStdHandle(STD_OUTPUT_HANDLE)
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel32.SetConsoleMode(handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING))
    except Exception:
        return False


@contextmanager
def _raw_terminal():
    """Put the terminal in cbreak mode (read keypresses without Enter). No-op on Windows."""
    if sys.platform == "win32":
        yield
        return

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        yield
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def _read_key() -> str:
    """Read one keypress, normalizing arrow keys to "up"/"down"."""
    if sys.platform == "win32":
        char = msvcrt.getwch()
        if char in ("\x00", "\xe0"):  # arrow keys come as a two-character sequence
            return {"H": "up", "P": "down"}.get(msvcrt.getwch(), "")
        return char

    # Read the file descriptor directly: `sys.stdin.read(1)` would buffer the whole escape
    # sequence internally, making the fd look empty to `select()` below.
    fd = sys.stdin.fileno()
    char = os.read(fd, 1)
    # Disambiguate a bare Escape from an escape sequence (e.g. "\x1b[A" for Up).
    if char == b"\x1b" and select.select([fd], [], [], 0.05)[0]:
        if os.read(fd, 1) == b"[" and select.select([fd], [], [], 0.05)[0]:
            return {b"A": "up", b"B": "down"}.get(os.read(fd, 1), "")
        return ""
    return char.decode(errors="replace")


def _select_with_arrows(prompt: str, choices: list[str]) -> int:
    selected = 0
    print(ANSI.bold(f"? {prompt}") + ANSI.gray("  [Use arrows, Enter to confirm]"))

    def render() -> None:
        for i, choice in enumerate(choices):
            line = ANSI.green("> ") + ANSI.bold(choice) if i == selected else "  " + choice
            sys.stdout.write(f"\r\x1b[K{line}\n")
        sys.stdout.flush()

    try:
        sys.stdout.write("\x1b[?25l")  # hide cursor
        render()
        with _raw_terminal():
            while True:
                key = _read_key()
                if key == "\x03":
                    # Ctrl+C: POSIX cbreak keeps ISIG so it never reaches here, but on Windows
                    # msvcrt.getwch() returns the raw character instead of raising.
                    raise KeyboardInterrupt
                if key == "up":
                    selected = (selected - 1) % len(choices)
                elif key == "down":
                    selected = (selected + 1) % len(choices)
                elif key.isdecimal() and 1 <= int(key) <= len(choices):
                    selected = int(key) - 1
                    break
                elif key in ("\r", "\n"):
                    break
                else:
                    continue
                sys.stdout.write(f"\x1b[{len(choices)}A")  # move back to the first option line
                render()
    finally:
        sys.stdout.write("\x1b[?25h")  # show cursor
        sys.stdout.flush()

    # Collapse the menu into a single "? prompt answer" summary line, like gh does.
    sys.stdout.write(f"\x1b[{len(choices) + 1}A\r\x1b[J")
    print(ANSI.bold(f"? {prompt} ") + ANSI.green(choices[selected]))
    return selected


def _select_with_numbers(prompt: str, choices: list[str]) -> int:
    print(f"? {prompt}")
    for i, choice in enumerate(choices, start=1):
        print(f"  {i}. {choice}")
    while True:
        raw = input("Choice [1]: ").strip()
        if not raw:
            return 0
        if raw.isdecimal() and 1 <= int(raw) <= len(choices):
            return int(raw) - 1
        print(f"Invalid choice. Enter a number between 1 and {len(choices)}.")


def tabulate(
    rows: list[list[str | int]],
    headers: list[str],
    alignments: dict[str, str] | None = None,
) -> str:
    """
    Inspired by:

    - stackoverflow.com/a/8356620/593036
    - stackoverflow.com/questions/9535954/printing-lists-as-tabular-data
    """
    _ALIGN_MAP = {"left": "<", "right": ">"}
    for row in rows:
        if len(row) < len(headers):
            raise IndexError(f"Row has {len(row)} values but expected {len(headers)} (headers: {headers})")
    col_widths = [max(len(str(x)) for x in col) for col in zip(*rows, headers)]
    col_aligns = [_ALIGN_MAP.get((alignments or {}).get(h, "left"), "<") for h in headers]
    row_format = " ".join(f"{{:{a}{w}}}" for a, w in zip(col_aligns, col_widths))
    lines = []
    lines.append(row_format.format(*headers))
    lines.append(row_format.format(*["-" * w for w in col_widths]))
    for row in rows:
        lines.append(row_format.format(*row))
    return "\n".join(lines)
