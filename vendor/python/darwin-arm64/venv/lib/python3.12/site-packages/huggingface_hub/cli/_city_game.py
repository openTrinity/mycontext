"""Interactive isometric city explorer — easter egg for `hf repos ls --explore`."""

import dataclasses
import math
import os
import random
import re
import select
import shutil
import sys
import time

from huggingface_hub.hf_api import RepoStorageInfo

from ._file_listing import format_size


Color = tuple[int, int, int]

# (top_face, left_face, right_face) — lighter to darker for 3D effect
_TYPE_COLORS: dict[str, tuple[Color, Color, Color]] = {
    "model": ((175, 148, 240), (138, 112, 208), (105, 80, 180)),
    "dataset": ((245, 128, 128), (222, 92, 92), (190, 60, 60)),
    "space": ((245, 175, 85), (218, 140, 55), (185, 110, 30)),
    "bucket": ((112, 185, 242), (70, 150, 220), (40, 118, 192)),
}
_EXTRA_COLORS: tuple[Color, Color, Color] = ((168, 176, 188), (128, 136, 148), (90, 98, 110))
_GRID_COLOR: Color = (178, 182, 190)

_DX = 4  # isometric half-width (pixels)
_DY = 2  # isometric half-height (pixels)
_MAX_H = 16  # tallest tile (pixels)
_MIN_H = 1
_COLS = 6
_EXT = 1  # grid extension beyond tiles
_MAX_TILES = 30

# Cursor sprite — pixel art arrow pointer
_OUTLINE: Color = (30, 30, 30)
_FILL: Color = (255, 255, 255)

_CURSOR_GRID = [
    "  X  ",
    " XWX ",
    "XWWWX",
    " XWX ",
    "  X  ",
]
_CURSOR_PALETTE: dict[str, Color] = {
    "X": _OUTLINE,
    "W": _FILL,
}
_CURSOR_H = len(_CURSOR_GRID)

_MOVE_FRAMES = 8
_MOVE_DELAY = 0.03
_CURSOR_PAD = _CURSOR_H + 16
_GAP = 3
_MIN_TERM_W = 100
_MIN_TERM_H = 24
_SUMMARY_W = 24


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class TileInfo:
    grid_row: int
    grid_col: int
    height: int
    top: Color
    left: Color
    right: Color
    repo: RepoStorageInfo | None


@dataclasses.dataclass
class CityData:
    tiles: list[TileInfo]
    rows: int
    cols: int
    x_off: int
    y_off: int
    buf_w: int
    buf_h: int
    total_storage: int
    extra_count: int
    extra_storage: int
    all_repos: list[RepoStorageInfo]


# ---------------------------------------------------------------------------
# City layout
# ---------------------------------------------------------------------------


def _prepare_city_data(repos: list[RepoStorageInfo]) -> CityData:
    sorted_repos = sorted(repos, key=lambda r: r.storage, reverse=True)
    display = sorted_repos[:_MAX_TILES]
    extra_count = max(0, len(sorted_repos) - _MAX_TILES)
    extra_storage = sum(r.storage for r in sorted_repos[_MAX_TILES:])
    total_storage = sum(r.storage for r in repos)
    max_storage = max(1, display[0].storage)

    n = len(display) + (1 if extra_count > 0 else 0)
    cols = min(n, _COLS)
    rows = math.ceil(n / cols) if cols > 0 else 1

    tiles: list[TileInfo] = []
    for i, repo in enumerate(display):
        r, c = divmod(i, cols)
        h = max(_MIN_H, round(math.sqrt(repo.storage / max_storage) * _MAX_H))
        top, left, right = _TYPE_COLORS.get(repo.type, _EXTRA_COLORS)
        tiles.append(TileInfo(r, c, h, top, left, right, repo))
    if extra_count > 0:
        r, c = divmod(len(display), cols)
        h = max(_MIN_H, round(math.sqrt(extra_storage / max_storage) * _MAX_H))
        tiles.append(TileInfo(r, c, h, *_EXTRA_COLORS, None))

    r_lo, r_hi = -_EXT, rows - 1 + _EXT
    c_lo, c_hi = -_EXT, cols - 1 + _EXT

    xs: list[int] = []
    ys: list[int] = []
    for rr in range(r_lo, r_hi + 1):
        for cc in range(c_lo, c_hi + 1):
            cx, cy = (cc - rr) * _DX, (cc + rr) * _DY
            xs.extend([cx - _DX, cx + _DX])
            ys.extend([cy, cy + 2 * _DY])
    for tile in tiles:
        ys.append((tile.grid_col + tile.grid_row) * _DY - tile.height)

    x_off = -min(xs)
    y_off = -min(ys)
    buf_w = max(xs) - min(xs) + 1
    buf_h = max(ys) - min(ys) + 1
    if buf_h % 2:
        buf_h += 1

    return CityData(
        tiles=tiles,
        rows=rows,
        cols=cols,
        x_off=x_off,
        y_off=y_off,
        buf_w=buf_w,
        buf_h=buf_h,
        total_storage=total_storage,
        extra_count=extra_count,
        extra_storage=extra_storage,
        all_repos=repos,
    )


# ---------------------------------------------------------------------------
# Drawing primitives
# ---------------------------------------------------------------------------


def _draw_diamond_outline(buf: list[list[Color | None]], cx: int, cy: int) -> None:
    t = (cx, cy)
    r = (cx + _DX, cy + _DY)
    b = (cx, cy + 2 * _DY)
    ll = (cx - _DX, cy + _DY)
    _draw_line(buf, *t, *r, _GRID_COLOR)
    _draw_line(buf, *r, *b, _GRID_COLOR)
    _draw_line(buf, *b, *ll, _GRID_COLOR)
    _draw_line(buf, *ll, *t, _GRID_COLOR)


def _draw_block(
    buf: list[list[Color | None]],
    cx: int,
    cy: int,
    h: int,
    top: Color,
    left: Color,
    right: Color,
) -> None:
    _fill_poly(
        buf,
        [(cx - _DX, cy + _DY - h), (cx, cy + 2 * _DY - h), (cx, cy + 2 * _DY), (cx - _DX, cy + _DY)],
        left,
    )
    _fill_poly(
        buf,
        [(cx, cy + 2 * _DY - h), (cx + _DX, cy + _DY - h), (cx + _DX, cy + _DY), (cx, cy + 2 * _DY)],
        right,
    )
    _fill_poly(
        buf,
        [(cx, cy - h), (cx + _DX, cy + _DY - h), (cx, cy + 2 * _DY - h), (cx - _DX, cy + _DY - h)],
        top,
    )


def _fill_poly(buf: list[list[Color | None]], verts: list[tuple[int, int]], color: Color) -> None:
    bh = len(buf)
    bw = len(buf[0]) if buf else 0
    all_y = [v[1] for v in verts]
    y0 = max(0, min(all_y))
    y1 = min(bh - 1, max(all_y))
    n = len(verts)
    for y in range(y0, y1 + 1):
        xl: float = float("inf")
        xr: float = float("-inf")
        for i in range(n):
            ax, ay = verts[i]
            bx, by = verts[(i + 1) % n]
            if ay == by:
                if y == ay:
                    xl = min(xl, float(min(ax, bx)))
                    xr = max(xr, float(max(ax, bx)))
                continue
            if not (min(ay, by) <= y <= max(ay, by)):
                continue
            t = (y - ay) / (by - ay)
            ix = ax + t * (bx - ax)
            xl = min(xl, ix)
            xr = max(xr, ix)
        if xl <= xr:
            for x in range(max(0, round(xl)), min(bw, round(xr) + 1)):
                buf[y][x] = color


def _draw_line(buf: list[list[Color | None]], x0: int, y0: int, x1: int, y1: int, color: Color) -> None:
    bh = len(buf)
    bw = len(buf[0]) if buf else 0
    dx = abs(x1 - x0)
    dy = abs(y1 - y0)
    steps = max(dx, dy)
    if steps == 0:
        if 0 <= y0 < bh and 0 <= x0 < bw:
            buf[y0][x0] = color
        return
    xi = (x1 - x0) / steps
    yi = (y1 - y0) / steps
    fx, fy = float(x0), float(y0)
    for _ in range(steps + 1):
        px, py = round(fx), round(fy)
        if 0 <= py < bh and 0 <= px < bw:
            buf[py][px] = color
        fx += xi
        fy += yi


# ---------------------------------------------------------------------------
# Pixel buffer → terminal
# ---------------------------------------------------------------------------

_ANSI_RE = re.compile(r"\033\[[0-9;]*m")


def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


def _visible_len(s: str) -> int:
    return len(_strip_ansi(s))


def _pixels_to_lines(buf: list[list[Color | None]]) -> list[str]:
    height = len(buf)
    width = len(buf[0]) if buf else 0
    lines: list[str] = []
    for row in range(0, height, 2):
        last = -1
        for col in range(width - 1, -1, -1):
            top = buf[row][col]
            bot = buf[row + 1][col] if row + 1 < height else None
            if top or bot:
                last = col
                break
        if last < 0:
            lines.append("")
            continue

        parts: list[str] = []
        cfg: Color | None = None
        cbg: Color | None = None

        for col in range(last + 1):
            top = buf[row][col]
            bot = buf[row + 1][col] if row + 1 < height else None

            if not top and not bot:
                if cfg is not None or cbg is not None:
                    parts.append("\033[0m")
                    cfg = cbg = None
                parts.append(" ")
                continue

            if top and bot and top == bot:
                nfg, nbg, ch = top, None, "█"
            elif top and bot:
                nfg, nbg, ch = bot, top, "▄"
            elif top:
                nfg, nbg, ch = top, None, "▀"
            else:
                nfg, nbg, ch = bot, None, "▄"  # type: ignore[assignment]

            esc = ""
            if nfg != cfg:
                esc += f"\033[38;2;{nfg[0]};{nfg[1]};{nfg[2]}m"
                cfg = nfg
            if nbg != cbg:
                esc += "\033[49m" if nbg is None else f"\033[48;2;{nbg[0]};{nbg[1]};{nbg[2]}m"
                cbg = nbg
            parts.append(esc + ch)

        if cfg is not None or cbg is not None:
            parts.append("\033[0m")
        lines.append("".join(parts))
    return lines


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _render_base_buffer(city: CityData) -> list[list[Color | None]]:
    buf: list[list[Color | None]] = [[None] * city.buf_w for _ in range(city.buf_h)]

    for tile in city.tiles:
        cx = city.x_off + (tile.grid_col - tile.grid_row) * _DX
        cy = city.y_off + (tile.grid_col + tile.grid_row) * _DY
        _draw_diamond_outline(buf, cx, cy)

    sorted_tiles = sorted(city.tiles, key=lambda t: (t.grid_row + t.grid_col, t.grid_col))
    for tile in sorted_tiles:
        cx = city.x_off + (tile.grid_col - tile.grid_row) * _DX
        cy = city.y_off + (tile.grid_col + tile.grid_row) * _DY
        _draw_block(buf, cx, cy, tile.height, tile.top, tile.left, tile.right)

    return buf


# ---------------------------------------------------------------------------
# Summary panel
# ---------------------------------------------------------------------------


def _colored_square(color: Color) -> str:
    return f"\033[38;2;{color[0]};{color[1]};{color[2]}m■\033[0m"


def _build_summary(
    repos: list[RepoStorageInfo],
    total_storage: int,
    extra_count: int,
) -> list[str]:
    lines: list[str] = [""]
    lines.append("  Storage Overview")
    lines.append("  " + "─" * 16)
    lines.append(f"  {format_size(total_storage, human_readable=True)} total")
    lines.append("")

    order = ["model", "dataset", "space", "bucket"]
    labels = {"model": "Models", "dataset": "Datasets", "space": "Spaces", "bucket": "Buckets"}
    for rtype in order:
        group = [r for r in repos if r.type == rtype]
        if not group:
            continue
        storage = sum(r.storage for r in group)
        sq = _colored_square(_TYPE_COLORS[rtype][0])
        lines.append(f"  {sq} {labels[rtype]}")
        lines.append(f"    {len(group)} repos · {format_size(storage, human_readable=True)}")
        lines.append("")

    if extra_count > 0:
        sq = _colored_square(_EXTRA_COLORS[0])
        lines.append(f"  {sq} +{extra_count} more repos")

    return lines


# ---------------------------------------------------------------------------
# Cursor
# ---------------------------------------------------------------------------


def _build_cursor() -> list[tuple[int, int, Color]]:
    pixels: list[tuple[int, int, Color]] = []
    for ri, row in enumerate(_CURSOR_GRID):
        for ci, ch in enumerate(row):
            if ch in _CURSOR_PALETTE:
                pixels.append((ci - len(row) // 2, ri - _CURSOR_H + 1, _CURSOR_PALETTE[ch]))
    return pixels


_CURSOR_PIXELS = _build_cursor()


# ---------------------------------------------------------------------------
# Interactive game
# ---------------------------------------------------------------------------


def run_city_game(repos: list[RepoStorageInfo]) -> None:
    """Launch the interactive city explorer."""
    if not repos:
        print("No repositories found.")
        return

    try:
        import termios
        import tty
    except ImportError:
        print("Interactive mode requires a Unix-like terminal (Linux/macOS).")
        return

    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("Interactive mode requires a terminal.")
        return

    term = shutil.get_terminal_size()
    if term.columns < _MIN_TERM_W or term.lines < _MIN_TERM_H:
        print(f"Your terminal is {term.columns}×{term.lines} characters.")
        print(f"Please resize to at least {_MIN_TERM_W}×{_MIN_TERM_H} to explore the city!")
        return

    city = _prepare_city_data(repos)

    tiles_with_repos = [t for t in city.tiles if t.repo is not None]
    start_tile = random.choice(tiles_with_repos) if tiles_with_repos else city.tiles[0]

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        sys.stdout.write("\033[?1049h\033[?25l\033[2J")
        sys.stdout.flush()
        _game_loop(city, start_tile.grid_row, start_tile.grid_col)
    finally:
        sys.stdout.write("\033[?25h\033[?1049l")
        sys.stdout.flush()
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def _game_loop(city: CityData, cur_row: int, cur_col: int) -> None:
    tile_map: dict[tuple[int, int], TileInfo] = {(t.grid_row, t.grid_col): t for t in city.tiles}
    city = dataclasses.replace(city, buf_h=city.buf_h + _CURSOR_PAD, y_off=city.y_off + _CURSOR_PAD)
    base_buf = _render_base_buffer(city)

    summary = _build_summary(city.all_repos, city.total_storage, city.extra_count)

    # Intro: cursor drops onto starting tile
    tx, ty = _tile_top_center(city, cur_row, cur_col, tile_map)
    for i in range(1, _MOVE_FRAMES + 1):
        t = i / _MOVE_FRAMES
        t = t * t * (3 - 2 * t)
        drop_y = ty - 16 * (1 - t)
        frame = _copy_buf(base_buf)
        _highlight_tile(frame, city, tile_map[(cur_row, cur_col)])
        _draw_cursor(frame, tx, round(drop_y))
        _present(city, frame, tile_map.get((cur_row, cur_col)), summary)
        time.sleep(_MOVE_DELAY)

    while True:
        cx, cy = _tile_top_center(city, cur_row, cur_col, tile_map)
        frame = _copy_buf(base_buf)
        _highlight_tile(frame, city, tile_map[(cur_row, cur_col)])
        _draw_cursor(frame, cx, cy)
        _present(city, frame, tile_map.get((cur_row, cur_col)), summary)

        key = _read_key()
        if key in ("q", "Q", "esc", "\x03"):
            return

        dr, dc = _key_to_direction(key)
        if dr == 0 and dc == 0:
            continue

        nr, nc = cur_row + dr, cur_col + dc
        if (nr, nc) not in tile_map:
            continue

        ex, ey = _tile_top_center(city, nr, nc, tile_map)
        for i in range(1, _MOVE_FRAMES + 1):
            t = i / _MOVE_FRAMES
            t = t * t * (3 - 2 * t)
            bx = cx + (ex - cx) * t
            by = cy + (ey - cy) * t
            frame = _copy_buf(base_buf)
            _highlight_tile(frame, city, tile_map[(nr, nc)])
            _draw_cursor(frame, round(bx), round(by))
            _present(city, frame, tile_map.get((nr, nc)), summary)
            time.sleep(_MOVE_DELAY)

        cur_row, cur_col = nr, nc


def _tile_top_center(city: CityData, row: int, col: int, tile_map: dict[tuple[int, int], TileInfo]) -> tuple[int, int]:
    tile = tile_map.get((row, col))
    h = tile.height if tile else 1
    cx = city.x_off + (col - row) * _DX
    cy = city.y_off + (col + row) * _DY
    return cx, cy + _DY - h


def _key_to_direction(key: str) -> tuple[int, int]:
    match key:
        case "w" | "W" | "\x1b[A":
            return -1, 0
        case "s" | "S" | "\x1b[B":
            return 1, 0
        case "a" | "A" | "\x1b[D":
            return 0, -1
        case "d" | "D" | "\x1b[C":
            return 0, 1
        case _:
            return 0, 0


def _draw_cursor(buf: list[list[Color | None]], cx: int, cy: int) -> None:
    bh = len(buf)
    bw = len(buf[0]) if buf else 0
    for dx, dy, color in _CURSOR_PIXELS:
        px, py = cx + dx, cy + dy
        if 0 <= py < bh and 0 <= px < bw:
            buf[py][px] = color


def _highlight_tile(buf: list[list[Color | None]], city: CityData, tile: TileInfo) -> None:
    cx = city.x_off + (tile.grid_col - tile.grid_row) * _DX
    cy = city.y_off + (tile.grid_col + tile.grid_row) * _DY
    h = tile.height
    _fill_poly(
        buf,
        [(cx, cy - h), (cx + _DX, cy + _DY - h), (cx, cy + 2 * _DY - h), (cx - _DX, cy + _DY - h)],
        _brighten(tile.top, 35),
    )


def _brighten(color: Color, amount: int) -> Color:
    return (min(255, color[0] + amount), min(255, color[1] + amount), min(255, color[2] + amount))


def _present(
    city: CityData,
    buf: list[list[Color | None]],
    tile: TileInfo | None,
    summary: list[str],
) -> None:
    city_lines = _pixels_to_lines(buf)
    while city_lines and not _strip_ansi(city_lines[0]).strip():
        city_lines.pop(0)
    while city_lines and not _strip_ansi(city_lines[-1]).strip():
        city_lines.pop()

    city_w = max((_visible_len(line) for line in city_lines), default=0)
    term = shutil.get_terminal_size()
    panel_max_w = max(20, term.columns - city_w - _SUMMARY_W - 2 * _GAP)

    info = _build_info_panel(tile, city, panel_max_w)

    n = max(len(summary), len(city_lines), len(info))
    summary_lo = max(0, (n - len(summary)) // 2)
    info_lo = max(0, (n - len(info)) // 2)

    lines: list[str] = []
    for i in range(n):
        si = i - summary_lo
        lt = summary[si] if 0 <= si < len(summary) else ""
        lpad = max(0, _SUMMARY_W - _visible_len(lt))

        ct = city_lines[i] if i < len(city_lines) else ""
        cpad = max(0, city_w - _visible_len(ct))

        ri = i - info_lo
        rt = info[ri] if 0 <= ri < len(info) else ""

        lines.append(lt + " " * lpad + " " * _GAP + ct + " " * cpad + " " * _GAP + rt)

    lines.append("")
    lines.append("  \033[90mWASD/Arrows: move · Q/ESC: quit\033[0m")

    while len(lines) < term.lines - 1:
        lines.append("")

    output = "\033[H"
    for line in lines[: term.lines - 1]:
        output += line + "\033[K\r\n"
    sys.stdout.write(output)
    sys.stdout.flush()


def _build_info_panel(tile: TileInfo | None, city: CityData, max_w: int) -> list[str]:
    reset = "\033[0m"
    gray = "\033[90m"
    bold = "\033[1m"
    indent = "  "
    content_w = max_w - len(indent)

    lines: list[str] = [""]
    lines.append(f"{indent}{bold}City Explorer{reset}")
    lines.append(indent + "─" * min(22, content_w))
    lines.append("")

    if tile is None:
        lines.append(f"{indent}{gray}Move to a tile")
        lines.append(f"{indent}to see details.{reset}")
        return lines

    if tile.repo is None:
        lines.append(f"{indent}{gray}+{city.extra_count} more repos{reset}")
        lines.append(f"{indent}{gray}{format_size(city.extra_storage, human_readable=True)} combined{reset}")
        return lines

    repo = tile.repo
    name = repo.id
    if len(name) > content_w:
        name = name[: content_w - 3] + "..."
    lines.append(f"{indent}{bold}{name}{reset}")
    lines.append("")

    type_ansi = {
        "model": "\033[38;2;175;148;240m",
        "dataset": "\033[38;2;245;128;128m",
        "space": "\033[38;2;245;175;85m",
        "bucket": "\033[38;2;112;185;242m",
    }
    tc = type_ansi.get(repo.type, "")

    lines.append(f"{indent}Type       {tc}{repo.type}{reset}")
    lines.append(f"{indent}Visibility {repo.visibility}")
    lines.append(f"{indent}Storage    {format_size(repo.storage, human_readable=True)}")
    lines.append(f"{indent}Usage      {repo.storage_percent:.1f}%")
    lines.append("")

    bar_w = min(18, content_w)
    filled = max(0, min(bar_w, round(repo.storage_percent / 100 * bar_w)))
    lines.append(f"{indent}{tc}{'█' * filled}{gray}{'░' * (bar_w - filled)}{reset}")

    return lines


def _copy_buf(buf: list[list[Color | None]]) -> list[list[Color | None]]:
    return [row[:] for row in buf]


def _read_key() -> str:
    fd = sys.stdin.fileno()
    ch = os.read(fd, 1)
    if ch == b"\x1b":
        if _has_input(fd, 0.05):
            ch2 = os.read(fd, 1)
            if ch2 == b"[" and _has_input(fd, 0.05):
                ch3 = os.read(fd, 1)
                return f"\x1b[{ch3.decode()}"
        return "esc"
    return ch.decode("utf-8", errors="replace")


def _has_input(fd: int, timeout: float) -> bool:
    r, _, _ = select.select([fd], [], [], timeout)
    return bool(r)
