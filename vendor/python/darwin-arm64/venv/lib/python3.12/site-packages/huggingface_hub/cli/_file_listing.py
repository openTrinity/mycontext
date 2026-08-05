# Copyright 2026-present, the HuggingFace Inc. team.
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
"""Shared helpers for listing files in buckets and repos (tree view, flat view, formatting)."""

import json
from datetime import datetime
from typing import Sequence

import click

from huggingface_hub._buckets import BucketFile, BucketFolder
from huggingface_hub.hf_api import RepoFile, RepoFolder

from ._cli_utils import get_hf_api
from ._output import OutputFormat, _ascii_safe, _dataclass_to_dict, out


BucketItem = BucketFile | BucketFolder
RepoItem = RepoFile | RepoFolder
ListingItem = BucketItem | RepoItem


def get_item_date(item: ListingItem) -> datetime | None:
    """Extract date from an item, supporting both repo items (last_commit.date) and bucket items (mtime/uploaded_at)."""
    match item:
        case BucketFile(mtime=mtime) if mtime is not None:
            return mtime
        case BucketFile(uploaded_at=uploaded_at) | BucketFolder(uploaded_at=uploaded_at) if uploaded_at is not None:
            return uploaded_at
        case RepoFile(last_commit=last_commit) | RepoFolder(last_commit=last_commit) if last_commit is not None:
            return last_commit.date
        case _:
            return None


def format_size(size: int | float, human_readable: bool = False) -> str:
    """Format a size in bytes."""
    if not human_readable:
        return str(size)

    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size < 1000:
            if unit == "B":
                return f"{size} {unit}"
            return f"{size:.1f} {unit}"
        size /= 1000
    return f"{size:.1f} PB"


def format_date(dt: datetime | None, human_readable: bool = False) -> str:
    """Format a datetime to a readable date string."""
    if dt is None:
        return ""
    if human_readable:
        return dt.strftime("%b %d %H:%M")
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def build_tree(
    items: Sequence[BucketItem] | Sequence[RepoItem],
    human_readable: bool = False,
    quiet: bool = False,
) -> list[str]:
    """Build a tree representation of files and directories.

    Produces ASCII tree with size and date columns before the tree connector.
    When quiet=True, only the tree structure is shown (no size/date).
    """
    tree: dict = {}

    for item in items:
        parts = item.path.split("/")
        current = tree
        for part in parts[:-1]:
            if part not in current:
                current[part] = {"__children__": {}}
            current = current[part]["__children__"]

        final_part = parts[-1]
        if isinstance(item, BucketFolder | RepoFolder):
            if final_part not in current:
                current[final_part] = {"__children__": {}}
        else:
            current[final_part] = {"__item__": item}

    prefix_width = 0
    max_size_width = 0
    max_date_width = 0
    if not quiet:
        for item in items:
            if isinstance(item, BucketFile | RepoFile):
                size_str = format_size(item.size, human_readable)
                max_size_width = max(max_size_width, len(size_str))
                date_str = format_date(get_item_date(item), human_readable)
                max_date_width = max(max_date_width, len(date_str))
        if max_size_width > 0:
            prefix_width = max_size_width + 2 + max_date_width

    lines: list[str] = []
    _render_tree(
        tree,
        lines,
        "",
        prefix_width=prefix_width,
        max_size_width=max_size_width,
        human_readable=human_readable,
    )
    return lines


def _render_tree(
    node: dict,
    lines: list[str],
    indent: str,
    prefix_width: int = 0,
    max_size_width: int = 0,
    human_readable: bool = False,
) -> None:
    """Recursively render a tree structure with size+date prefix."""
    sorted_items = sorted(node.items())
    for i, (name, value) in enumerate(sorted_items):
        is_last = i == len(sorted_items) - 1
        connector = _ascii_safe("└── ", "`-- ") if is_last else _ascii_safe("├── ", "|-- ")

        is_dir = "__children__" in value
        children = value.get("__children__", {})

        if prefix_width > 0:
            if is_dir:
                prefix = " " * prefix_width
            else:
                item = value.get("__item__")
                if item is not None:
                    size_str = format_size(item.size, human_readable)
                    date_str = format_date(get_item_date(item), human_readable)
                    prefix = f"{size_str:>{max_size_width}}  {date_str}"
                else:
                    prefix = " " * prefix_width
            lines.append(f"{prefix}  {indent}{connector}{name}{'/' if is_dir else ''}")
        else:
            lines.append(f"{indent}{connector}{name}{'/' if is_dir else ''}")

        if children:
            child_indent = indent + ("    " if is_last else _ascii_safe("│   ", "|   "))
            _render_tree(
                children,
                lines,
                child_indent,
                prefix_width=prefix_width,
                max_size_width=max_size_width,
                human_readable=human_readable,
            )


def list_repo_files_cmd(
    repo_id: str,
    repo_type: str,
    human_readable: bool,
    as_tree: bool,
    recursive: bool,
    revision: str | None,
    token: str | None,
) -> None:
    """List files in a repo on the Hub. Used by models/datasets/spaces ls commands."""
    if as_tree and out.mode == OutputFormat.json:
        raise click.BadParameter("Cannot use --tree with --format json.")

    api = get_hf_api(token=token)
    items = list(api.list_repo_tree(repo_id, recursive=recursive, revision=revision, repo_type=repo_type, expand=True))
    print_file_listing(items, human_readable=human_readable, as_tree=as_tree, recursive=recursive)


def print_file_listing(
    items: Sequence[BucketItem] | Sequence[RepoItem],
    *,
    human_readable: bool = False,
    as_tree: bool = False,
    recursive: bool = False,
) -> None:
    """Print a file listing in the appropriate format based on the current output mode.

    Supports tree, json, quiet, and flat human-readable views. Works with both
    BucketFile/BucketFolder and RepoFile/RepoFolder items.
    """
    if not items:
        out.text("(empty)")
        return

    has_directories = any(isinstance(item, BucketFolder | RepoFolder) for item in items)

    if as_tree:
        quiet = out.mode == OutputFormat.quiet
        for line in build_tree(items, human_readable=human_readable, quiet=quiet):
            print(line)
    elif out.mode == OutputFormat.json:
        print(json.dumps([_dataclass_to_dict(item) for item in items], indent=2))
    elif out.mode == OutputFormat.quiet:
        for item in items:
            if isinstance(item, BucketFolder | RepoFolder):
                print(f"{item.path}/")
            else:
                print(item.path)
    else:
        for item in items:
            if isinstance(item, BucketFolder | RepoFolder):
                date_str = format_date(get_item_date(item), human_readable)
                print(f"{'':>12}  {date_str:>19}  {item.path}/")
            else:
                size_str = format_size(item.size, human_readable)
                date_str = format_date(get_item_date(item), human_readable)
                print(f"{size_str:>12}  {date_str:>19}  {item.path}")

    if not recursive and has_directories:
        out.hint("Use -R to list files recursively.")
