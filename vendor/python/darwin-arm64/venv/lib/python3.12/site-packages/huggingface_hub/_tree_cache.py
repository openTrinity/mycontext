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
"""On-disk cache for repository tree listings.

A tree listing is the set of files (with their download metadata) contained in a repo at a given commit. Because a
commit hash is immutable, its tree listing never changes and can be cached forever without any invalidation logic.

The listing is stored as a human-readable JSON file under `<tree_cache_folder>/trees/<commit_hash>.json`. The
folder depends on the download target: the per-repo `storage_folder` for `cache_dir` downloads, or
`local_dir/.cache/huggingface/` for `local_dir` downloads (see `tree_cache_folder_for_local_dir`).

```json
{
  "format_version": 1,
  "files": {
    "config.json": {"size": 519, "blob_id": "<git sha1>"},
    "model.safetensors": {"size": 1234, "blob_id": "...", "lfs_sha256": "<sha256>", "lfs_size": 1234, "xet_hash": "..."}
  }
}
```
"""

import json
import os
import tempfile
import threading
from dataclasses import dataclass

from .utils import logging
from .utils._xet import is_valid_xet_hash


logger = logging.get_logger(__name__)

TREE_CACHE_FORMAT_VERSION = 1

# In-memory cache of parsed tree listings, keyed by absolute file path.
_IN_MEMORY_TREE_CACHE: dict[str, "dict[str, TreeCacheEntry]"] = {}
_IN_MEMORY_TREE_CACHE_LOCK = threading.Lock()


@dataclass(frozen=True)
class TreeCacheEntry:
    """Raw metadata of a single file in a cached tree listing, mirroring the `/tree` endpoint fields."""

    size: int
    blob_id: str
    lfs_sha256: str | None = None
    lfs_size: int | None = None
    xet_hash: str | None = None

    def to_json(self) -> dict:
        info: dict = {"size": self.size, "blob_id": self.blob_id}
        if self.lfs_sha256 is not None:
            info["lfs_sha256"] = self.lfs_sha256
            info["lfs_size"] = self.lfs_size
        if self.xet_hash is not None:
            info["xet_hash"] = self.xet_hash
        return info

    @classmethod
    def from_json(cls, info: dict) -> "TreeCacheEntry":
        return cls(
            size=info["size"],
            blob_id=info["blob_id"],
            lfs_sha256=info.get("lfs_sha256"),
            lfs_size=info.get("lfs_size"),
            xet_hash=info.get("xet_hash"),
        )


def is_valid_tree_entries(entries: dict[str, TreeCacheEntry]) -> bool:
    """Return whether all Xet hashes in the tree listing are valid."""
    return all(entry.xet_hash is None or is_valid_xet_hash(entry.xet_hash) for entry in entries.values())


def _tree_cache_path(tree_cache_folder: str, commit_hash: str) -> str:
    return os.path.join(tree_cache_folder, "trees", f"{commit_hash}.json")


def tree_cache_folder_for_local_dir(local_dir: str) -> str:
    """Folder under which the `trees/` cache lives for a `local_dir` download."""
    return os.path.join(local_dir, ".cache", "huggingface")


def read_tree_cache(tree_cache_folder: str, commit_hash: str) -> dict[str, TreeCacheEntry] | None:
    """Return the cached tree listing for a commit hash, or `None` if not cached, invalid, or unreadable."""
    path = _tree_cache_path(tree_cache_folder, commit_hash)
    with _IN_MEMORY_TREE_CACHE_LOCK:
        if path in _IN_MEMORY_TREE_CACHE:
            cached_entries = _IN_MEMORY_TREE_CACHE[path]
            return cached_entries if is_valid_tree_entries(cached_entries) else None
    entries = _read_tree_cache_from_disk(path)
    if entries is None or not is_valid_tree_entries(entries):
        return None
    with _IN_MEMORY_TREE_CACHE_LOCK:
        _IN_MEMORY_TREE_CACHE[path] = entries
    return entries


def _read_tree_cache_from_disk(path: str) -> dict[str, TreeCacheEntry] | None:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("format_version") != TREE_CACHE_FORMAT_VERSION:
            # Unknown format (e.g. written by a newer version) => ignore and re-fetch.
            return None
        return {file_path: TreeCacheEntry.from_json(info) for file_path, info in data["files"].items()}
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError) as e:
        logger.warning(f"Ignoring corrupted tree cache file {path}: {e}")
        return None


def write_tree_cache(tree_cache_folder: str, commit_hash: str, entries: dict[str, TreeCacheEntry]) -> None:
    """Write a valid tree listing to the cache (ignoring invalid entries and any failures)."""
    if not is_valid_tree_entries(entries):
        return

    path = _tree_cache_path(tree_cache_folder, commit_hash)
    data = {
        "format_version": TREE_CACHE_FORMAT_VERSION,
        "files": {file_path: entries[file_path].to_json() for file_path in sorted(entries)},
    }
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)
        os.replace(tmp_path, path)
    except OSError as e:
        logger.warning(f"Ignored error while writing tree cache file {path}: {e}")
        return

    # Seed the in-memory cache so later readers of this commit skip re-reading and re-parsing the file.
    with _IN_MEMORY_TREE_CACHE_LOCK:
        _IN_MEMORY_TREE_CACHE[path] = dict(entries)
