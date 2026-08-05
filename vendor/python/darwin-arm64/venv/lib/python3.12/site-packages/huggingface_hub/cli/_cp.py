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
"""Shared ``cp`` command to copy files between local paths, repositories and buckets.

This single command backs three identical CLI entry points: ``hf cp`` (top-level),
``hf repos cp`` and ``hf buckets cp``. It supports any source/destination combination
of local file, repo/bucket ``hf://`` URI, and ``-`` (stdin/stdout), with two exceptions:
- bucket-to-repo copies are not supported (server limitation), and
- local-to-local copies (use a regular ``cp`` for that).
"""

import os
import sys
from dataclasses import replace
from typing import Annotated, Literal

import click

from huggingface_hub import HfApi
from huggingface_hub.errors import CLIError
from huggingface_hub.utils import HfUri, SoftTemporaryDirectory, disable_progress_bars, is_hf_uri, parse_hf_uri

from ._cli_utils import TokenOpt, get_hf_api
from ._framework import Argument
from ._output import out


CP_EXAMPLES = [
    # Download (repo or bucket -> local / stdout)
    "hf cp hf://username/my-model/config.json",
    "hf cp hf://username/my-model/config.json ./config.json",
    "hf cp hf://datasets/username/my-dataset/data.csv ./data/",
    "hf cp hf://buckets/username/my-bucket/config.json -",
    # Upload (local / stdin -> repo or bucket)
    "hf cp ./model.safetensors hf://username/my-model/model.safetensors",
    "hf cp ./config.json hf://buckets/username/my-bucket/logs/",
    "hf cp - hf://buckets/username/my-bucket/config.json",
    # Remote to remote (repo/bucket -> repo/bucket, server-side when possible)
    "hf cp hf://username/source-model/ hf://username/dest-model/",
    "hf cp hf://datasets/username/my-dataset/processed/ hf://buckets/username/my-bucket/processed/",
    "hf cp hf://buckets/username/my-bucket/logs/ hf://buckets/username/archive-bucket/  # copies contents only",
]


# Which alias registered the command, used to restrict the remote endpoint type (see `_enforce_context`).
CpContext = Literal["repos", "buckets"]


def make_cp(context: CpContext | None = None):
    """Build the ``cp`` command function for a given alias.

    The three entry points (`hf cp`, `hf repos cp`, `hf buckets cp`) share the exact same logic;
    'context' only adds a guardrail on the remote endpoint type (see `_enforce_context`).
    """

    def cp(
        src: Annotated[
            str,
            Argument(help="Source: local file, hf:// URI (repo or bucket), or - for stdin."),
        ],
        dst: Annotated[
            str | None,
            Argument(help="Destination: local path, hf:// URI (repo or bucket), or - for stdout."),
        ] = None,
        token: TokenOpt = None,
    ) -> None:
        """Copy files between local paths, repositories, and buckets.

        Handles uploads (local/stdin -> repo/bucket), downloads (repo/bucket -> local/stdout) and
        remote-to-remote copies (repo/bucket -> repo/bucket). Bucket-to-repo and local-to-local
        copies are not supported. For directories, use `hf upload`/`hf download` (repos) or
        `hf buckets sync` (buckets). Remote-to-remote copies only work within the same storage
        region (https://huggingface.co/docs/hub/storage-regions).
        """
        _enforce_context(context, src, dst)
        _run_cp(src, dst, token)

    return cp


def _enforce_context(context: CpContext | None, src: str, dst: str | None) -> None:
    """Guardrail for the `hf repos cp` / `hf buckets cp` aliases.

    These aliases are exact duplicates of `hf cp`, so a bare `hf repos cp` could otherwise touch a
    bucket (and vice versa). We validate the type of the remote side: the destination for uploads and
    remote-to-remote copies, or the source when downloading to a local path / stdout. The top-level
    `hf cp` (i.e. 'context' is None) accepts any combination.
    """
    if context is None:
        return
    # The remote endpoint is the destination when it is an hf:// URI, otherwise the source (download).
    remote = dst if (dst is not None and is_hf_uri(dst)) else src
    if not is_hf_uri(remote):
        return
    if context == "repos" and parse_hf_uri(remote).is_bucket:
        raise CLIError("`hf repos cp` only works with repositories. Use `hf cp` or `hf buckets cp` for buckets.")
    if context == "buckets" and not parse_hf_uri(remote).is_bucket:
        raise CLIError("`hf buckets cp` only works with buckets. Use `hf cp` or `hf repos cp` for repositories.")


def _run_cp(src: str, dst: str | None, token: str | None) -> None:
    api = get_hf_api(token=token)

    src_is_stdin = src == "-"
    dst_is_stdout = dst == "-"
    src_is_hf = is_hf_uri(src)
    dst_is_hf = dst is not None and is_hf_uri(dst)

    # --- Remote to remote: delegate to copy_files (repo/bucket -> repo/bucket) ---
    if src_is_hf and dst_is_hf:
        assert dst is not None  # guaranteed by dst_is_hf
        api.copy_files(src, dst)
        out.result("Copied", src=src, dst=dst)
        return

    # --- At least one side must be a remote hf:// URI (rules out local->local, stdin->local, etc.) ---
    if not src_is_hf and not dst_is_hf:
        if dst is None:
            raise click.BadParameter("Missing destination. Provide a repo or bucket hf:// URI as DST.")
        raise click.BadParameter(
            "One of SRC or DST must be a repo (hf://username/...) or bucket (hf://buckets/...) URI."
        )

    # --- Download: repo/bucket -> local file or stdout ---
    if src_is_hf:
        if dst_is_stdout:
            _download_file_to_stdout(api, src)
            return
        _download_file_to_local(api, src, dst)
        return

    # --- Upload: local file or stdin -> repo/bucket ---
    assert dst is not None  # guaranteed: reaching here means dst_is_hf is True
    _upload_file_to_remote(api, src, dst, src_is_stdin=src_is_stdin)


def _download_file_to_stdout(api: HfApi, src: str) -> None:
    uri = parse_hf_uri(src)
    filename = _source_filename(uri, src)
    # Suppress progress bars to avoid polluting the piped output.
    with disable_progress_bars():
        with SoftTemporaryDirectory() as tmp_dir:
            tmp_path = os.path.join(tmp_dir, filename)
            _download_single(api, uri, tmp_path)
            with open(tmp_path, "rb") as f:
                while chunk := f.read(32_000_000):  # 32MB chunks
                    sys.stdout.buffer.write(chunk)


def _download_file_to_local(api: HfApi, src: str, dst: str | None) -> None:
    uri = parse_hf_uri(src)
    filename = _source_filename(uri, src)

    if dst is None:
        local_path = filename
    elif os.path.isdir(dst) or dst.endswith(os.sep) or dst.endswith("/"):
        local_path = os.path.join(dst, filename)
    else:
        local_path = dst

    parent_dir = os.path.dirname(local_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)

    _download_single(api, uri, local_path)
    out.result("Downloaded", src=src, dst=local_path)


def _download_single(api: HfApi, uri: HfUri, local_path: str) -> None:
    """Download a single file (repo or bucket) to ``local_path``.

    Used by `_download_file_to_local` and `_download_file_to_stdout`.
    """
    if uri.is_bucket:
        api.download_bucket_files(uri.id, [(uri.path_in_repo, local_path)], raise_on_missing_files=True)
    else:
        # Download into a temporary folder next to the destination (rather than the shared cache)
        # so the final move stays on the same filesystem and is instant. The temp folder is
        # cleaned up automatically once the move is complete.
        parent_dir = os.path.dirname(local_path) or "."
        with SoftTemporaryDirectory(prefix=".tmp", dir=parent_dir) as tmp_dir:
            downloaded_path = api.hf_hub_download(
                repo_id=uri.id,
                repo_type=uri.type,
                filename=uri.path_in_repo,
                revision=uri.revision,
                local_dir=tmp_dir,
            )
            os.replace(downloaded_path, local_path)


def _source_filename(uri: HfUri, src: str) -> str:
    if uri.path_in_repo == "" or src.endswith("/"):
        raise click.BadParameter(
            "Source path must include a file name, not just a repo/bucket or directory path."
            " Use `hf download` or `hf buckets sync` to copy directories."
        )
    return uri.path_in_repo.rsplit("/", 1)[-1]


def _upload_file_to_remote(api: HfApi, src: str, dst: str, *, src_is_stdin: bool) -> None:
    uri = parse_hf_uri(dst)

    if src_is_stdin:
        if uri.path_in_repo == "" or dst.endswith("/"):
            raise click.BadParameter("Stdin upload requires a full destination path including filename.")
        data = sys.stdin.buffer.read()
        _upload_single(api, uri, data, uri.path_in_repo)
        out.result("Uploaded", src="stdin", dst=uri.to_uri())
        return

    if os.path.isdir(src):
        raise click.BadParameter(
            "Source must be a file, not a directory. Use `hf upload` or `hf buckets sync` for directories."
        )
    if not os.path.isfile(src):
        raise click.BadParameter(f"Source file not found: {src}")

    prefix = uri.path_in_repo
    if prefix == "":
        remote_path = os.path.basename(src)
    elif dst.endswith("/"):
        remote_path = prefix + "/" + os.path.basename(src)
    else:
        remote_path = prefix

    _upload_single(api, uri, src, remote_path)
    out.result("Uploaded", src=src, dst=replace(uri, path_in_repo=remote_path).to_uri())


def _upload_single(api: HfApi, uri: HfUri, source: str | bytes, remote_path: str) -> None:
    """Upload a single file or bytes (to a repo or bucket)."""
    if uri.is_bucket:
        api.batch_bucket_files(uri.id, add=[(source, remote_path)])
    else:
        api.upload_file(
            path_or_fileobj=source,
            path_in_repo=remote_path,
            repo_id=uri.id,
            repo_type=uri.type,
            revision=uri.revision,
        )
