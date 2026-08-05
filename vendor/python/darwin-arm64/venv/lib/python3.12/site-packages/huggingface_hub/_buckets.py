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
"""Shared logic for bucket operations.

This module contains the core buckets logic used by both the CLI and the Python API.
"""

import fnmatch
import json
import mimetypes
import os
import stat
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from . import constants, logging
from .errors import BucketNotFoundError
from .utils import (
    HfUri,
    StatusLine,
    XetFileData,
    disable_progress_bars,
    enable_progress_bars,
    parse_datetime,
    parse_hf_uri,
)
from .utils._hf_uris import _looks_like_hf_url


if TYPE_CHECKING:
    from .hf_api import HfApi


logger = logging.get_logger(__name__)


BUCKET_PREFIX = "hf://buckets/"
_SYNC_TIME_WINDOW_MS = 1000  # 1s safety-window for file modification time comparisons


# =============================================================================
# Bucket data structures
# =============================================================================


@dataclass
class BucketInfo:
    """
    Contains information about a bucket on the Hub. This object is returned by [`bucket_info`] and [`list_buckets`].

    Attributes:
        id (`str`):
            ID of the bucket.
        private (`bool`):
            Is the bucket private.
        created_at (`datetime`):
            Date of creation of the bucket on the Hub.
        size (`int`):
            Size of the bucket in bytes.
        total_files (`int`):
            Total number of files in the bucket.
    """

    id: str
    private: bool
    created_at: datetime
    size: int
    total_files: int

    def __init__(self, **kwargs):
        self.id = kwargs.pop("id")
        self.private = kwargs.pop("private")
        self.created_at = parse_datetime(kwargs.pop("createdAt"))
        self.size = kwargs.pop("size")
        self.total_files = kwargs.pop("totalFiles")
        self.__dict__.update(**kwargs)


@dataclass
class _BucketAddFile:
    source: str | Path | bytes
    destination: str

    xet_hash: str | None = field(default=None)
    size: int | None = field(default=None)
    mtime: int = field(init=False)
    content_type: str | None = field(init=False)

    def __post_init__(self) -> None:
        self.content_type = None
        if isinstance(self.source, (str, Path)):  # guess content type from source path
            self.content_type = mimetypes.guess_type(self.source)[0]
        if self.content_type is None:  # or default to destination path content type
            self.content_type = mimetypes.guess_type(self.destination)[0]

        self.mtime = int(
            os.path.getmtime(self.source) * 1000 if not isinstance(self.source, bytes) else time.time() * 1000
        )


@dataclass
class _BucketCopyFile:
    destination: str
    xet_hash: str
    source_repo_type: str  # "model", "dataset", "space", "bucket"
    source_repo_id: str
    size: int | None = field(default=None)
    mtime: int = field(init=False)
    content_type: str | None = field(init=False)

    def __post_init__(self) -> None:
        self.content_type = mimetypes.guess_type(self.destination)[0]
        self.mtime = int(time.time() * 1000)


@dataclass
class _BucketDeleteFile:
    path: str


@dataclass(frozen=True)
class BucketFileMetadata:
    """Data structure containing information about a file in a bucket.

    Returned by [`get_bucket_file_metadata`].

    Args:
        size (`int`):
            Size of the file in bytes.
        xet_file_data (`XetFileData`):
            Xet information for the file (hash and refresh route).
    """

    size: int
    xet_file_data: XetFileData


@dataclass
class BucketUrl:
    """Describes a bucket URL on the Hub.

    `BucketUrl` is returned by [`create_bucket`]. At initialization, the URL is parsed to populate properties:
    - endpoint (`str`)
    - namespace (`str`)
    - bucket_id (`str`)
    - url (`str`)
    - uri (`HfUri`)

    Args:
        url (`str`):
            String value of the bucket url.
        endpoint (`str`, *optional*):
            Endpoint of the Hub. Defaults to <https://huggingface.co>.
    """

    url: str
    endpoint: str = ""
    namespace: str = field(init=False)
    bucket_id: str = field(init=False)
    uri: HfUri = field(init=False)

    def __post_init__(self) -> None:
        self.endpoint = self.endpoint or constants.ENDPOINT

        # Parse URL: expected format is `{endpoint}/buckets/{namespace}/{bucket_name}`
        url_path = self.url.replace(self.endpoint, "").strip("/")
        # Remove leading "buckets/" prefix
        if url_path.startswith("buckets/"):
            url_path = url_path[len("buckets/") :]
        parsed = _parse_bucket_uri(url_path)
        if parsed.path_in_repo:
            raise ValueError(f"Unable to parse bucket URL: {self.url}")
        self.namespace = parsed.id.split("/")[0]
        self.bucket_id = parsed.id
        self.uri = parsed


@dataclass
class BucketFile:
    """
    Contains information about a file in a bucket on the Hub. This object is returned by [`list_bucket_tree`].

    Similar to [`RepoFile`] but for files in buckets.
    """

    type: Literal["file"]
    path: str
    size: int
    xet_hash: str
    mtime: datetime | None
    uploaded_at: datetime | None

    def __init__(self, **kwargs):
        self.type = kwargs.pop("type")
        self.path = kwargs.pop("path")
        self.size = kwargs.pop("size")
        self.xet_hash = kwargs.pop("xetHash")
        mtime = kwargs.pop("mtime", None)
        self.mtime = parse_datetime(mtime) if mtime else None
        uploaded_at = kwargs.pop("uploadedAt", None)
        self.uploaded_at = parse_datetime(uploaded_at) if uploaded_at else None


@dataclass
class BucketFolder:
    """
    Contains information about a directory in a bucket on the Hub. This object is returned by [`list_bucket_tree`].

    Similar to [`RepoFolder`] but for directories in buckets.
    """

    type: Literal["directory"]
    path: str
    uploaded_at: datetime | None

    def __init__(self, **kwargs):
        self.type = kwargs.pop("type")
        self.path = kwargs.pop("path")
        uploaded_at = kwargs.pop("uploadedAt", None) or kwargs.pop("uploaded_at", None)
        self.uploaded_at = (
            (uploaded_at if isinstance(uploaded_at, datetime) else parse_datetime(uploaded_at))
            if uploaded_at
            else None
        )


# =============================================================================
# Bucket path parsing
# =============================================================================


def _parse_bucket_uri(path: str) -> HfUri:
    """Parse a bucket path into a HfUri.

    Accepts:
    - `hf://buckets/namespace/name(/path/in/repo)` URIs,
    - Hugging Face web URLs such as `https://huggingface.co/buckets/namespace/name(/tree/path)`,
    - plain `namespace/name(/path/in/repo)` paths.
    """
    if path.startswith(constants.HF_PROTOCOL) or _looks_like_hf_url(path):
        # Don't use 'if is_hf_uri(...)' here as we prefer 'parse_hf_uri(...)' to raise the exact error message.
        parsed = parse_hf_uri(path)
        if not parsed.is_bucket:
            raise ValueError(f"Invalid bucket path: {path}. Must be a bucket URI (hf://buckets/...).")
        return parsed
    parts = path.split("/", 2)
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise ValueError(f"Invalid bucket path: '{path}'. Expected format: namespace/bucket_name")
    bucket_id = f"{parts[0]}/{parts[1]}"
    prefix = "/".join(parts[2:])
    return HfUri(type="bucket", id=bucket_id, path_in_repo=prefix)


def _is_bucket_path(path: str) -> bool:
    """Check if a path is a bucket path.

    Do not raise if the path is not a hf:// URI.
    Raise if the path is a hf:// URI but with an incorrect format.
    """
    if not path.startswith(constants.HF_PROTOCOL):
        return False
    return parse_hf_uri(path).is_bucket


# =============================================================================
# Sync data structures
# =============================================================================


@dataclass
class SyncOperation:
    """Represents a sync operation to be performed."""

    action: Literal["upload", "download", "delete", "skip"]
    path: str
    size: int | None = None
    reason: str = ""
    local_mtime: str | None = None
    remote_mtime: str | None = None
    bucket_file: BucketFile | None = None  # BucketFile when available (not serialized to plan file)


@dataclass
class SyncPlan:
    """Represents a complete sync plan."""

    source: str
    dest: str
    timestamp: str
    operations: list[SyncOperation] = field(default_factory=list)

    def summary(self) -> dict[str, int | str]:
        uploads = sum(1 for op in self.operations if op.action == "upload")
        downloads = sum(1 for op in self.operations if op.action == "download")
        deletes = sum(1 for op in self.operations if op.action == "delete")
        skips = sum(1 for op in self.operations if op.action == "skip")
        total_size = sum(op.size or 0 for op in self.operations if op.action in ("upload", "download"))
        return {
            "uploads": uploads,
            "downloads": downloads,
            "deletes": deletes,
            "skips": skips,
            "total_size": total_size,
        }


# =============================================================================
# Filter matching
# =============================================================================


class FilterMatcher:
    """Matches file paths against include/exclude patterns."""

    def __init__(
        self,
        include_patterns: list[str] | None = None,
        exclude_patterns: list[str] | None = None,
        filter_rules: list[tuple[str, str]] | None = None,
    ):
        """Initialize the filter matcher.

        Args:
            include_patterns: Patterns to include (from --include)
            exclude_patterns: Patterns to exclude (from --exclude)
            filter_rules: Rules from filter file as list of ("+"/"-", pattern) tuples
        """
        self.include_patterns = include_patterns or []
        self.exclude_patterns = exclude_patterns or []
        self.filter_rules = filter_rules or []

    def matches(self, path: str) -> bool:
        """Check if a path should be included based on the filter rules.

        Filtering rules:
        - Filters are evaluated in order, first matching rule decides
        - If no rules match, include by default (unless include patterns are specified)
        """
        # First check filter rules from file (in order)
        for sign, pattern in self.filter_rules:
            if fnmatch.fnmatch(path, pattern):
                return sign == "+"

        # Then check CLI patterns
        for pattern in self.exclude_patterns:
            if fnmatch.fnmatch(path, pattern):
                return False

        for pattern in self.include_patterns:
            if fnmatch.fnmatch(path, pattern):
                return True

        # If include patterns were specified but none matched, exclude
        if self.include_patterns:
            return False

        # Default: include
        return True


def _parse_filter_file(filter_file: str) -> list[tuple[str, str]]:
    """Parse a filter file and return a list of (sign, pattern) tuples.

    Filter file format:
    - Lines starting with "+" are include patterns
    - Lines starting with "-" are exclude patterns
    - Empty lines and lines starting with "#" are ignored
    """
    rules = []
    with open(filter_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("+"):
                rules.append(("+", line[1:].strip()))
            elif line.startswith("-"):
                rules.append(("-", line[1:].strip()))
            else:
                # Default to include if no prefix
                rules.append(("+", line))
    return rules


# =============================================================================
# File listing
# =============================================================================


def _stat_local(path: str) -> tuple[int, float] | None:
    """Stat a local file and return (size, mtime_ms).

    Returns None if the path is missing or is a directory. Uses a single
    ``os.stat`` call so callers don't pay for multiple syscalls per file.
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    if stat.S_ISDIR(st.st_mode):
        return None
    return st.st_size, st.st_mtime * 1000


def _list_local_files(local_path: str) -> Iterator[tuple[str, int, float]]:
    """List all files in a local directory.

    Yields:
        tuple: (relative_path, size, mtime_ms) for each file
    """
    local_path = os.path.abspath(local_path)
    if not os.path.isdir(local_path):
        raise ValueError(f"Local path must be a directory: {local_path}")

    for root, _, files in os.walk(local_path):
        for filename in files:
            full_path = os.path.join(root, filename)
            stat_info = _stat_local(full_path)
            if stat_info is None:
                continue
            rel_path = os.path.relpath(full_path, local_path)
            # Normalize to forward slashes for consistency
            rel_path = rel_path.replace(os.sep, "/")
            yield rel_path, stat_info[0], stat_info[1]


def _list_remote_files(api: "HfApi", bucket_id: str, prefix: str) -> Iterator[tuple[str, int, float, Any]]:
    """List all files in a bucket with a given prefix.

    Yields:
        tuple: (relative_path, size, mtime_ms, bucket_file) for each file.
            bucket_file is the BucketFile object from list_bucket_tree.
    """
    for item in api.list_bucket_tree(bucket_id, prefix=prefix or None, recursive=True):
        if isinstance(item, BucketFolder):
            continue
        path = item.path
        # Remove prefix from path to get relative path
        # Only strip prefix if it's followed by "/" (directory boundary) or is exact match
        if prefix:
            if path.startswith(prefix + "/"):
                rel_path = path[len(prefix) + 1 :]
            elif path == prefix:
                # Exact match: the file IS the prefix (e.g., single file download)
                rel_path = path.rsplit("/", 1)[-1] if "/" in path else path
            else:
                # Path doesn't match prefix pattern (e.g., "submarine.txt" for prefix "sub")
                # Skip this file - it was returned by the API but doesn't belong to this prefix
                continue
        else:
            rel_path = path
        mtime_ms = item.mtime.timestamp() * 1000 if item.mtime else 0
        yield rel_path, item.size, mtime_ms, item


# =============================================================================
# Sync plan computation
# =============================================================================


def _mtime_to_iso(mtime_ms: float) -> str:
    """Convert mtime in milliseconds to ISO format string."""
    return datetime.fromtimestamp(mtime_ms / 1000, tz=timezone.utc).isoformat()


def _compare_files_for_sync(
    *,
    path: str,
    action: Literal["upload", "download"],
    source_size: int,
    source_mtime: float,
    dest_size: int,
    dest_mtime: float,
    source_newer_label: str,
    dest_newer_label: str,
    ignore_sizes: bool,
    ignore_times: bool,
    ignore_existing: bool,
    bucket_file: Any | None = None,
) -> SyncOperation:
    """Compare source and dest files and return the appropriate sync operation.

    This is a unified helper for both upload and download directions.

    Args:
        path: Relative file path
        action: "upload" or "download"
        source_size: Size of the source file (bytes)
        source_mtime: Mtime of the source file (milliseconds)
        dest_size: Size of the destination file (bytes)
        dest_mtime: Mtime of the destination file (milliseconds)
        source_newer_label: Label when source is newer (e.g., "local newer" or "remote newer")
        dest_newer_label: Label when dest is newer (e.g., "remote newer" or "local newer")
        ignore_sizes: Only compare mtime
        ignore_times: Only compare size
        ignore_existing: Skip files that exist on receiver
        bucket_file: BucketFile object (for downloads only)

    Returns:
        SyncOperation describing the action to take
    """
    local_mtime_iso = _mtime_to_iso(source_mtime if action == "upload" else dest_mtime)
    remote_mtime_iso = _mtime_to_iso(dest_mtime if action == "upload" else source_mtime)

    base_kwargs: dict[str, Any] = {
        "path": path,
        "size": source_size,
        "local_mtime": local_mtime_iso,
        "remote_mtime": remote_mtime_iso,
    }

    if ignore_existing:
        return SyncOperation(action="skip", reason="exists on receiver (--ignore-existing)", **base_kwargs)

    size_differs = source_size != dest_size
    source_newer = (source_mtime - dest_mtime) > _SYNC_TIME_WINDOW_MS

    if ignore_sizes:
        if source_newer:
            return SyncOperation(action=action, reason=source_newer_label, bucket_file=bucket_file, **base_kwargs)
        else:
            dest_newer = (dest_mtime - source_mtime) > _SYNC_TIME_WINDOW_MS
            skip_reason = dest_newer_label if dest_newer else "same mtime"
            return SyncOperation(action="skip", reason=skip_reason, **base_kwargs)
    elif ignore_times:
        if size_differs:
            return SyncOperation(action=action, reason="size differs", bucket_file=bucket_file, **base_kwargs)
        else:
            return SyncOperation(action="skip", reason="same size", **base_kwargs)
    else:
        if size_differs or source_newer:
            reason = "size differs" if size_differs else source_newer_label
            return SyncOperation(action=action, reason=reason, bucket_file=bucket_file, **base_kwargs)
        else:
            return SyncOperation(action="skip", reason="identical", **base_kwargs)


def _compute_sync_plan(
    source: str,
    dest: str,
    api: "HfApi",
    delete: bool = False,
    ignore_times: bool = False,
    ignore_sizes: bool = False,
    existing: bool = False,
    ignore_existing: bool = False,
    filter_matcher: FilterMatcher | None = None,
    status: Any | None = None,
) -> SyncPlan:
    """Compute the sync plan by comparing source and destination.

    Returns:
        SyncPlan with all operations to be performed
    """
    filter_matcher = filter_matcher or FilterMatcher()
    is_upload = not _is_bucket_path(source) and _is_bucket_path(dest)
    is_download = _is_bucket_path(source) and not _is_bucket_path(dest)

    if not is_upload and not is_download:
        raise ValueError("One of source or dest must be a bucket path (hf://buckets/...) and the other must be local.")

    plan = SyncPlan(
        source=source,
        dest=dest,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )

    remote_total: int | None = None
    if is_upload:
        # Local -> Remote
        local_path = os.path.abspath(source)
        parsed = _parse_bucket_uri(dest)
        bucket_id, prefix = parsed.id, parsed.path_in_repo

        if not os.path.isdir(local_path):
            raise ValueError(f"Source must be a directory: {local_path}")

        # Get local and remote file lists
        local_files = {}
        for rel_path, size, mtime_ms in _list_local_files(local_path):
            if filter_matcher.matches(rel_path):
                local_files[rel_path] = (size, mtime_ms)
            if status:
                status.update(f"Scanning local directory ({len(local_files)} files)")
        if status:
            status.done(f"Scanning local directory ({len(local_files)} files)")

        remote_files = {}
        if status:
            try:
                remote_total = api.bucket_info(bucket_id).total_files
            except Exception:
                pass
        try:
            for rel_path, size, mtime_ms, _ in _list_remote_files(api, bucket_id, prefix):
                if filter_matcher.matches(rel_path):
                    remote_files[rel_path] = (size, mtime_ms)
                if status:
                    total_str = f"/{remote_total}" if remote_total is not None else ""
                    status.update(f"Scanning remote bucket ({len(remote_files)}{total_str} files)")
        except BucketNotFoundError:
            # Bucket doesn't exist yet - this is expected for new uploads
            logger.debug(f"Bucket '{bucket_id}' not found, treating as empty.")
        if status:
            status.done(f"Scanning remote bucket ({len(remote_files)} files)")

        # Compare files
        all_paths = set(local_files.keys()) | set(remote_files.keys())
        if status:
            status.done(f"Comparing files ({len(all_paths)} paths)")
        for path in sorted(all_paths):
            local_info = local_files.get(path)
            remote_info = remote_files.get(path)

            if local_info and not remote_info:
                # New file
                if existing:
                    # --existing: skip new files
                    plan.operations.append(
                        SyncOperation(
                            action="skip",
                            path=path,
                            size=local_info[0],
                            reason="new file (--existing)",
                            local_mtime=_mtime_to_iso(local_info[1]),
                        )
                    )
                else:
                    plan.operations.append(
                        SyncOperation(
                            action="upload",
                            path=path,
                            size=local_info[0],
                            reason="new file",
                            local_mtime=_mtime_to_iso(local_info[1]),
                        )
                    )
            elif local_info and remote_info:
                # File exists in both - use helper to determine action
                local_size, local_mtime = local_info
                remote_size, remote_mtime = remote_info
                plan.operations.append(
                    _compare_files_for_sync(
                        path=path,
                        action="upload",
                        source_size=local_size,
                        source_mtime=local_mtime,
                        dest_size=remote_size,
                        dest_mtime=remote_mtime,
                        source_newer_label="local newer",
                        dest_newer_label="remote newer",
                        ignore_sizes=ignore_sizes,
                        ignore_times=ignore_times,
                        ignore_existing=ignore_existing,
                    )
                )
            elif not local_info and remote_info and delete:
                # File only in remote and --delete mode
                plan.operations.append(
                    SyncOperation(
                        action="delete",
                        path=path,
                        size=remote_info[0],
                        reason="not in source (--delete)",
                        remote_mtime=_mtime_to_iso(remote_info[1]),
                    )
                )

    else:
        # Remote -> Local (download)
        parsed = _parse_bucket_uri(source)
        bucket_id, prefix = parsed.id, parsed.path_in_repo
        local_path = os.path.abspath(dest)

        # Get remote and local file lists
        remote_files = {}
        bucket_file_map: dict[str, Any] = {}
        if status:
            try:
                remote_total = api.bucket_info(bucket_id).total_files
            except Exception:
                pass
        for rel_path, size, mtime_ms, bucket_file in _list_remote_files(api, bucket_id, prefix):
            if filter_matcher.matches(rel_path):
                remote_files[rel_path] = (size, mtime_ms)
                bucket_file_map[rel_path] = bucket_file
            if status:
                total_str = f"/{remote_total}" if remote_total is not None else ""
                status.update(f"Scanning remote bucket ({len(remote_files)}{total_str} files)")
        if status:
            status.done(f"Scanning remote bucket ({len(remote_files)} files)")

        local_files = {}
        if os.path.isdir(local_path):
            if delete:
                # Full walk needed to discover local-only files for deletion.
                for rel_path, size, mtime_ms in _list_local_files(local_path):
                    if filter_matcher.matches(rel_path):
                        local_files[rel_path] = (size, mtime_ms)
                    if status:
                        status.update(f"Scanning local directory ({len(local_files)} files)")
            else:
                # Without --delete, the plan only depends on paths that exist
                # remotely. Stat just those instead of walking the whole tree,
                # which can take minutes when dest sits in a large directory
                # like ~/.cache/huggingface/.
                for rel_path in remote_files:
                    local_file = os.path.join(local_path, rel_path)
                    stat_info = _stat_local(local_file)
                    if stat_info is None:
                        continue
                    local_files[rel_path] = stat_info
                    if status:
                        status.update(f"Scanning local directory ({len(local_files)} files)")
        if status:
            status.done(f"Scanning local directory ({len(local_files)} files)")

        # Compare files
        all_paths = set(remote_files.keys()) | set(local_files.keys())
        if status:
            status.done(f"Comparing files ({len(all_paths)} paths)")
        for path in sorted(all_paths):
            remote_info = remote_files.get(path)
            local_info = local_files.get(path)

            if remote_info and not local_info:
                # New file
                if existing:
                    # --existing: skip new files
                    plan.operations.append(
                        SyncOperation(
                            action="skip",
                            path=path,
                            size=remote_info[0],
                            reason="new file (--existing)",
                            remote_mtime=_mtime_to_iso(remote_info[1]),
                        )
                    )
                else:
                    plan.operations.append(
                        SyncOperation(
                            action="download",
                            path=path,
                            size=remote_info[0],
                            reason="new file",
                            remote_mtime=_mtime_to_iso(remote_info[1]),
                            bucket_file=bucket_file_map.get(path),
                        )
                    )
            elif remote_info and local_info:
                # File exists in both - use helper to determine action
                remote_size, remote_mtime = remote_info
                local_size, local_mtime = local_info
                plan.operations.append(
                    _compare_files_for_sync(
                        path=path,
                        action="download",
                        source_size=remote_size,
                        source_mtime=remote_mtime,
                        dest_size=local_size,
                        dest_mtime=local_mtime,
                        source_newer_label="remote newer",
                        dest_newer_label="local newer",
                        ignore_sizes=ignore_sizes,
                        ignore_times=ignore_times,
                        ignore_existing=ignore_existing,
                        bucket_file=bucket_file_map.get(path),
                    )
                )
            elif not remote_info and local_info and delete:
                # File only in local and --delete mode
                plan.operations.append(
                    SyncOperation(
                        action="delete",
                        path=path,
                        size=local_info[0],
                        reason="not in source (--delete)",
                        local_mtime=_mtime_to_iso(local_info[1]),
                    )
                )

    return plan


# =============================================================================
# Plan serialization
# =============================================================================


def _write_plan(plan: SyncPlan, f) -> None:
    """Write a sync plan as JSONL to a file-like object."""
    # Write header
    header = {
        "type": "header",
        "source": plan.source,
        "dest": plan.dest,
        "timestamp": plan.timestamp,
        "summary": plan.summary(),
    }
    f.write(json.dumps(header) + "\n")

    # Write operations
    for op in plan.operations:
        op_dict: dict[str, Any] = {
            "type": "operation",
            "action": op.action,
            "path": op.path,
            "reason": op.reason,
        }
        if op.size is not None:
            op_dict["size"] = op.size
        if op.local_mtime is not None:
            op_dict["local_mtime"] = op.local_mtime
        if op.remote_mtime is not None:
            op_dict["remote_mtime"] = op.remote_mtime
        f.write(json.dumps(op_dict) + "\n")


def _save_plan(plan: SyncPlan, plan_file: str) -> None:
    """Save a sync plan to a JSONL file."""
    with open(plan_file, "w") as f:
        _write_plan(plan, f)


def _load_plan(plan_file: str) -> SyncPlan:
    """Load a sync plan from a JSONL file."""
    with open(plan_file) as f:
        lines = f.readlines()

    if not lines:
        raise ValueError(f"Empty plan file: {plan_file}")

    # Parse header
    header = json.loads(lines[0])
    if header.get("type") != "header":
        raise ValueError("Invalid plan file: expected header as first line")

    plan = SyncPlan(
        source=header["source"],
        dest=header["dest"],
        timestamp=header["timestamp"],
    )

    # Parse operations
    for line in lines[1:]:
        op_dict = json.loads(line)
        if op_dict.get("type") != "operation":
            continue
        plan.operations.append(
            SyncOperation(
                action=op_dict["action"],
                path=op_dict["path"],
                size=op_dict.get("size"),
                reason=op_dict.get("reason", ""),
                local_mtime=op_dict.get("local_mtime"),
                remote_mtime=op_dict.get("remote_mtime"),
            )
        )

    return plan


# =============================================================================
# Plan execution
# =============================================================================


def _execute_plan(plan: SyncPlan, api: "HfApi", verbose: bool = False, status: Any | None = None) -> None:
    """Execute a sync plan."""
    is_upload = not _is_bucket_path(plan.source) and _is_bucket_path(plan.dest)
    is_download = _is_bucket_path(plan.source) and not _is_bucket_path(plan.dest)

    if is_upload:
        local_path = os.path.abspath(plan.source)
        parsed = _parse_bucket_uri(plan.dest)
        bucket_id, prefix = parsed.id, parsed.path_in_repo

        # Collect operations
        add_files: list[tuple[str | Path | bytes, str]] = []
        delete_paths: list[str] = []

        for op in plan.operations:
            match op.action:
                case "upload":
                    local_file = os.path.join(local_path, op.path)
                    remote_path = f"{prefix}/{op.path}" if prefix else op.path
                    if verbose:
                        print(f"  Uploading: {op.path} ({op.reason})")
                    add_files.append((local_file, remote_path))
                case "delete":
                    remote_path = f"{prefix}/{op.path}" if prefix else op.path
                    if verbose:
                        print(f"  Deleting: {op.path} ({op.reason})")
                    delete_paths.append(remote_path)
                case "skip" if verbose:
                    print(f"  Skipping: {op.path} ({op.reason})")

        # Execute batch operations
        if add_files or delete_paths:
            if status:
                parts = []
                if add_files:
                    parts.append(f"uploading {len(add_files)} files")
                if delete_paths:
                    parts.append(f"deleting {len(delete_paths)} files")
                status.done(", ".join(parts).capitalize())
            api.batch_bucket_files(
                bucket_id,
                add=add_files or None,
                delete=delete_paths or None,
            )

    elif is_download:
        parsed = _parse_bucket_uri(plan.source)
        bucket_id, prefix = parsed.id, parsed.path_in_repo
        local_path = os.path.abspath(plan.dest)

        # Ensure local directory exists
        os.makedirs(local_path, exist_ok=True)

        # Collect download operations
        download_files: list[tuple[str | BucketFile, str | Path]] = []
        delete_files: list[str] = []

        for op in plan.operations:
            if op.action == "download":
                local_file = os.path.join(local_path, op.path)
                # Ensure parent directory exists
                os.makedirs(os.path.dirname(local_file), exist_ok=True)
                if verbose:
                    print(f"  Downloading: {op.path} ({op.reason})")
                # Use BucketFile when available (avoids extra metadata fetch per file)
                if op.bucket_file is not None:
                    download_files.append((op.bucket_file, local_file))
                else:
                    remote_path = f"{prefix}/{op.path}" if prefix else op.path
                    download_files.append((remote_path, local_file))
            elif op.action == "delete":
                local_file = os.path.join(local_path, op.path)
                if verbose:
                    print(f"  Deleting: {op.path} ({op.reason})")
                delete_files.append(local_file)
            elif op.action == "skip" and verbose:
                print(f"  Skipping: {op.path} ({op.reason})")

        # Execute downloads
        if len(download_files) > 0:
            if status:
                status.done(f"Downloading {len(download_files)} files")
            api.download_bucket_files(bucket_id, download_files)

        # Execute deletes
        if status and delete_files:
            status.done(f"Deleting {len(delete_files)} local files")
        for file_path in delete_files:
            if os.path.exists(file_path):
                os.remove(file_path)
                # Remove empty parent directories
                parent = os.path.dirname(file_path)
                while parent != local_path:
                    try:
                        os.rmdir(parent)
                        parent = os.path.dirname(parent)
                    except OSError:
                        break


def _print_plan_summary(plan: SyncPlan) -> None:
    """Print a summary of the sync plan."""
    summary = plan.summary()
    print(f"Sync plan: {plan.source} -> {plan.dest}")
    print(f"  Uploads: {summary['uploads']}")
    print(f"  Downloads: {summary['downloads']}")
    print(f"  Deletes: {summary['deletes']}")
    print(f"  Skips: {summary['skips']}")


# =============================================================================
# Public sync function (Python API)
# =============================================================================


def sync_bucket_internal(
    source: str | None = None,
    dest: str | None = None,
    *,
    api: "HfApi",
    delete: bool = False,
    ignore_times: bool = False,
    ignore_sizes: bool = False,
    existing: bool = False,
    ignore_existing: bool = False,
    include: list[str] | None = None,
    exclude: list[str] | None = None,
    filter_from: str | None = None,
    plan: str | None = None,
    apply: str | None = None,
    dry_run: bool = False,
    verbose: bool = False,
    quiet: bool = False,
    token: bool | str | None = None,
) -> SyncPlan:
    """Sync files between a local directory and a bucket.

    This is equivalent to the ``hf buckets sync`` CLI command. One of ``source`` or ``dest`` must be a bucket path
    (``hf://buckets/...``) and the other must be a local directory path.

    Args:
        source (`str`, *optional*):
            Source path: local directory or ``hf://buckets/namespace/bucket_name(/prefix)``.
            Required unless using ``apply``.
        dest (`str`, *optional*):
            Destination path: local directory or ``hf://buckets/namespace/bucket_name(/prefix)``.
            Required unless using ``apply``.
        api ([`HfApi`]):
            The HfApi instance to use for API calls.
        delete (`bool`, *optional*, defaults to `False`):
            Delete destination files not present in source.
        ignore_times (`bool`, *optional*, defaults to `False`):
            Skip files only based on size, ignoring modification times.
        ignore_sizes (`bool`, *optional*, defaults to `False`):
            Skip files only based on modification times, ignoring sizes.
        existing (`bool`, *optional*, defaults to `False`):
            Skip creating new files on receiver (only update existing files).
        ignore_existing (`bool`, *optional*, defaults to `False`):
            Skip updating files that exist on receiver (only create new files).
        include (`list[str]`, *optional*):
            Include files matching patterns (fnmatch-style).
        exclude (`list[str]`, *optional*):
            Exclude files matching patterns (fnmatch-style).
        filter_from (`str`, *optional*):
            Path to a filter file with include/exclude rules.
        plan (`str`, *optional*):
            Save sync plan to this JSONL file instead of executing.
        apply (`str`, *optional*):
            Apply a previously saved plan file. When set, ``source`` and ``dest`` are not needed.
        dry_run (`bool`, *optional*, defaults to `False`):
            Print sync plan to stdout as JSONL without executing.
        verbose (`bool`, *optional*, defaults to `False`):
            Show detailed per-file operations.
        quiet (`bool`, *optional*, defaults to `False`):
            Suppress all output and progress bars.
        token (Union[bool, str, None], optional):
            A valid user access token. If not provided, the locally saved token will be used.

    Returns:
        [`SyncPlan`]: The computed (or loaded) sync plan.

    Raises:
        `ValueError`: If arguments are invalid (e.g., both paths are remote, conflicting options).

    Example:
        ```python
        >>> from huggingface_hub import HfApi
        >>> api = HfApi()

        # Upload local directory to bucket
        >>> api.sync_bucket("./data", "hf://buckets/username/my-bucket")

        # Download bucket to local directory
        >>> api.sync_bucket("hf://buckets/username/my-bucket", "./data")

        # Sync with delete and filtering
        >>> api.sync_bucket(
        ...     "./data",
        ...     "hf://buckets/username/my-bucket",
        ...     delete=True,
        ...     include=["*.safetensors"],
        ... )

        # Dry run: preview what would be synced
        >>> plan = api.sync_bucket("./data", "hf://buckets/username/my-bucket", dry_run=True)
        >>> plan.summary()
        {'uploads': 3, 'downloads': 0, 'deletes': 0, 'skips': 1, 'total_size': 4096}

        # Save plan for review, then apply
        >>> api.sync_bucket("./data", "hf://buckets/username/my-bucket", plan="sync-plan.jsonl")
        >>> api.sync_bucket(apply="sync-plan.jsonl")
        ```
    """
    # Build API with token if needed
    if token is not None:
        from .hf_api import HfApi

        api = HfApi(
            endpoint=api.endpoint,
            token=token,
            library_name=api.library_name,
            library_version=api.library_version,
            user_agent=api.user_agent,
            headers=api.headers,
        )
    # --- Apply mode ---
    if apply:
        if source or dest:
            raise ValueError("Cannot specify source/dest when using apply.")
        if plan is not None:
            raise ValueError("Cannot specify both plan and apply.")
        if delete:
            raise ValueError("Cannot specify delete when using apply.")
        if ignore_times:
            raise ValueError("Cannot specify ignore_times when using apply.")
        if ignore_sizes:
            raise ValueError("Cannot specify ignore_sizes when using apply.")
        if include:
            raise ValueError("Cannot specify include when using apply.")
        if exclude:
            raise ValueError("Cannot specify exclude when using apply.")
        if filter_from:
            raise ValueError("Cannot specify filter_from when using apply.")
        if existing:
            raise ValueError("Cannot specify existing when using apply.")
        if ignore_existing:
            raise ValueError("Cannot specify ignore_existing when using apply.")
        if dry_run:
            raise ValueError("Cannot specify dry_run when using apply.")

        sync_plan = _load_plan(apply)
        status = StatusLine(enabled=not quiet)
        if not quiet:
            _print_plan_summary(sync_plan)
            print("Executing plan...")

        if quiet:
            disable_progress_bars()
        try:
            _execute_plan(sync_plan, api, verbose=verbose, status=status)
        finally:
            if quiet:
                enable_progress_bars()

        if not quiet:
            print("Sync completed.")

        return sync_plan

    # --- Normal mode ---
    if not source or not dest:
        raise ValueError("Both source and dest are required (unless using apply).")

    source_is_bucket = _is_bucket_path(source)
    dest_is_bucket = _is_bucket_path(dest)

    if source_is_bucket and dest_is_bucket:
        raise ValueError("Remote to remote sync is not supported. One path must be local.")

    if not source_is_bucket and not dest_is_bucket:
        raise ValueError("One of source or dest must be a bucket path (hf://buckets/...).")

    if ignore_times and ignore_sizes:
        raise ValueError("Cannot specify both ignore_times and ignore_sizes.")

    if existing and ignore_existing:
        raise ValueError("Cannot specify both existing and ignore_existing.")

    if dry_run and plan:
        raise ValueError("Cannot specify both dry_run and plan.")

    # Validate local path
    if source_is_bucket:
        if os.path.exists(dest) and not os.path.isdir(dest):
            raise ValueError(f"Destination must be a directory: {dest}")
    else:
        if not os.path.isdir(source):
            raise ValueError(f"Source must be an existing directory: {source}")

    # Build filter matcher
    filter_rules = None
    if filter_from:
        filter_rules = _parse_filter_file(filter_from)

    filter_matcher = FilterMatcher(
        include_patterns=include,
        exclude_patterns=exclude,
        filter_rules=filter_rules,
    )

    # Compute sync plan
    status = StatusLine(enabled=not quiet and not dry_run)
    sync_plan = _compute_sync_plan(
        source=source,
        dest=dest,
        api=api,
        delete=delete,
        ignore_times=ignore_times,
        ignore_sizes=ignore_sizes,
        existing=existing,
        ignore_existing=ignore_existing,
        filter_matcher=filter_matcher,
        status=status,
    )

    if dry_run:
        _write_plan(sync_plan, sys.stdout)
        return sync_plan

    if plan:
        _save_plan(sync_plan, plan)
        if not quiet:
            _print_plan_summary(sync_plan)
            print(f"Plan saved to: {plan}")
        return sync_plan

    # Execute plan
    if not quiet:
        _print_plan_summary(sync_plan)

    summary = sync_plan.summary()
    if summary["uploads"] == 0 and summary["downloads"] == 0 and summary["deletes"] == 0:
        if not quiet:
            print("Nothing to sync.")
        return sync_plan

    if not quiet:
        print("Syncing...")

    if quiet:
        disable_progress_bars()
    try:
        _execute_plan(sync_plan, api, verbose=verbose, status=status)
    finally:
        if quiet:
            enable_progress_bars()

    if not quiet:
        print("Sync completed.")

    return sync_plan
