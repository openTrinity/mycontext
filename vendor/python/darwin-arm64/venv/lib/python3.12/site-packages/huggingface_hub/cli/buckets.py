# Copyright 2025-present, the HuggingFace Inc. team.
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
"""Contains commands to interact with buckets via the CLI."""

from typing import Annotated

import click

from huggingface_hub import logging
from huggingface_hub._buckets import (
    BUCKET_PREFIX,
    BucketFile,
    FilterMatcher,
    _parse_bucket_uri,
)

from ..hf_api import REPO_REGIONS
from ._cli_utils import (
    SearchOpt,
    TokenOpt,
    get_hf_api,
    typer_factory,
)
from ._cp import make_cp
from ._file_listing import format_size, print_file_listing
from ._framework import Argument, Option
from ._output import OutputFormat, out


logger = logging.get_logger(__name__)


buckets_cli = typer_factory(help="Commands to interact with buckets.")


@buckets_cli.command(
    name="create",
    examples=[
        "hf buckets create my-bucket",
        "hf buckets create user/my-bucket",
        "hf buckets create hf://buckets/user/my-bucket",
        "hf buckets create user/my-bucket --private",
        "hf buckets create user/my-bucket --exist-ok",
        "hf buckets create user/my-bucket --region us",
    ],
)
def create(
    bucket_id: Annotated[
        str,
        Argument(
            help="Bucket ID: bucket_name, namespace/bucket_name, or hf://buckets/namespace/bucket_name",
        ),
    ],
    private: Annotated[
        bool,
        Option(
            "--private",
            help="Create a private bucket.",
        ),
    ] = False,
    region: Annotated[
        REPO_REGIONS | None,
        Option(
            "--region",
            help="Cloud region in which to create the bucket. Can be one of 'us' or 'eu'. Requires Team plan or above.",
        ),
    ] = None,
    exist_ok: Annotated[
        bool,
        Option(
            "--exist-ok",
            help="Do not raise an error if the bucket already exists.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Create a new bucket."""
    api = get_hf_api(token=token)

    if bucket_id.startswith(BUCKET_PREFIX):
        parsed = _parse_bucket_uri(bucket_id)
        if parsed.path_in_repo:
            raise click.BadParameter(
                f"Cannot specify a prefix for bucket creation: {bucket_id}."
                f" Use namespace/bucket_name or {BUCKET_PREFIX}namespace/bucket_name."
            )
        bucket_id = parsed.id

    bucket_url = api.create_bucket(
        bucket_id,
        private=private if private else None,
        region=region,
        exist_ok=exist_ok,
    )
    out.result("Bucket created", uri=bucket_url.uri.to_uri(), url=bucket_url.url)


def _is_bucket_id(argument: str) -> bool:
    """Check if argument is a bucket ID (namespace/name) vs just a namespace."""
    if argument.startswith(BUCKET_PREFIX):
        path = argument[len(BUCKET_PREFIX) :]
    else:
        path = argument
    return "/" in path


@buckets_cli.command(
    name="list | ls",
    examples=[
        "hf buckets list",
        "hf buckets list huggingface",
        'hf buckets list --search "my-prefix"',
        "hf buckets list user/my-bucket",
        "hf buckets list user/my-bucket -R",
        "hf buckets list user/my-bucket -h",
        "hf buckets list user/my-bucket --tree",
        "hf buckets list user/my-bucket --tree -h",
        "hf buckets list hf://buckets/user/my-bucket",
        "hf buckets list user/my-bucket/sub -R",
    ],
)
def list_cmd(
    argument: Annotated[
        str | None,
        Argument(
            help=(
                "Namespace (user or org) to list buckets, or bucket ID"
                " (namespace/bucket_name(/prefix) or hf://buckets/...) to list files."
            ),
        ),
    ] = None,
    human_readable: Annotated[
        bool,
        Option(
            "--human-readable",
            "-h",
            help="Show sizes in human readable format.",
        ),
    ] = False,
    as_tree: Annotated[
        bool,
        Option(
            "--tree",
            help="List files in tree format (only for listing files).",
        ),
    ] = False,
    recursive: Annotated[
        bool,
        Option(
            "--recursive",
            "-R",
            help="List files recursively (only for listing files).",
        ),
    ] = False,
    search: SearchOpt = None,
    token: TokenOpt = None,
) -> None:
    """List buckets or files in a bucket.

    When called with no argument or a namespace, lists buckets.
    When called with a bucket ID (namespace/bucket_name), lists files in the bucket.
    """
    # Determine mode: listing buckets or listing files
    is_file_mode = argument is not None and _is_bucket_id(argument)

    if is_file_mode:
        if search is not None:
            raise click.BadParameter("Cannot use --search when listing files.")
        _list_files(
            argument=argument,  # type: ignore
            human_readable=human_readable,
            as_tree=as_tree,
            recursive=recursive,
            token=token,
        )
    else:
        _list_buckets(
            namespace=argument,
            search=search,
            human_readable=human_readable,
            as_tree=as_tree,
            recursive=recursive,
            token=token,
        )


def _list_buckets(
    namespace: str | None,
    search: str | None,
    human_readable: bool,
    as_tree: bool,
    recursive: bool,
    token: str | None,
) -> None:
    """List buckets in a namespace."""
    # Validate incompatible flags
    if as_tree:
        raise click.BadParameter("Cannot use --tree when listing buckets.")
    if recursive:
        raise click.BadParameter("Cannot use --recursive when listing buckets.")

    # Handle hf://buckets/namespace format
    if namespace is not None and namespace.startswith(BUCKET_PREFIX):
        namespace = namespace[len(BUCKET_PREFIX) :]
        # Strip trailing slash if any
        namespace = namespace.rstrip("/")

    api = get_hf_api(token=token)
    items = [
        {
            "id": bucket.id,
            "private": bucket.private,
            "size": format_size(bucket.size, human_readable) if human_readable else bucket.size,
            "total_files": bucket.total_files,
            "created_at": bucket.created_at,
        }
        for bucket in api.list_buckets(namespace=namespace, search=search)
    ]
    out.table(items, alignments={"size": "right"})


def _list_files(
    argument: str,
    human_readable: bool,
    as_tree: bool,
    recursive: bool,
    token: str | None,
) -> None:
    """List files in a bucket."""
    if as_tree and out.mode == OutputFormat.json:
        raise click.BadParameter("Cannot use --tree with --format json.")

    api = get_hf_api(token=token)
    parsed = _parse_bucket_uri(argument)
    items = list(
        api.list_bucket_tree(
            parsed.id,
            prefix=parsed.path_in_repo or None,
            recursive=recursive,
        )
    )

    print_file_listing(items, human_readable=human_readable, as_tree=as_tree, recursive=recursive)


@buckets_cli.command(
    name="info",
    examples=[
        "hf buckets info user/my-bucket",
        "hf buckets info hf://buckets/user/my-bucket",
    ],
)
def info(
    bucket_id: Annotated[
        str,
        Argument(
            help="Bucket ID: namespace/bucket_name or hf://buckets/namespace/bucket_name",
        ),
    ],
    token: TokenOpt = None,
) -> None:
    """Get info about a bucket."""
    api = get_hf_api(token=token)
    parsed = _parse_bucket_uri(bucket_id)
    bucket = api.bucket_info(parsed.id)
    out.dict(bucket, id_key="id")


@buckets_cli.command(
    name="delete",
    examples=[
        "hf buckets delete user/my-bucket",
        "hf buckets delete hf://buckets/user/my-bucket",
        "hf buckets delete user/my-bucket --yes",
        "hf buckets delete user/my-bucket --missing-ok",
    ],
)
def delete(
    bucket_id: Annotated[
        str,
        Argument(
            help="Bucket ID: namespace/bucket_name or hf://buckets/namespace/bucket_name",
        ),
    ],
    yes: Annotated[
        bool,
        Option(
            "--yes",
            "-y",
            help="Skip confirmation prompt.",
        ),
    ] = False,
    missing_ok: Annotated[
        bool,
        Option(
            "--missing-ok",
            help="Do not raise an error if the bucket does not exist.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Delete a bucket.

    This deletes the entire bucket and all its contents. Use `hf buckets rm` to remove individual files.
    """
    if bucket_id.startswith(BUCKET_PREFIX):
        parsed = _parse_bucket_uri(bucket_id)
        if parsed.path_in_repo:
            raise click.BadParameter(
                f"Cannot specify a prefix for bucket deletion: {bucket_id}."
                f" Use namespace/bucket_name or {BUCKET_PREFIX}namespace/bucket_name."
            )
        bucket_id = parsed.id
    elif "/" not in bucket_id:
        raise click.BadParameter(
            f"Invalid bucket ID: {bucket_id}."
            f" Must be in format namespace/bucket_name or {BUCKET_PREFIX}namespace/bucket_name."
        )

    out.confirm(f"Are you sure you want to delete bucket '{bucket_id}'?", yes=yes)

    api = get_hf_api(token=token)
    api.delete_bucket(bucket_id, missing_ok=missing_ok)
    out.result("Bucket deleted", bucket_id=bucket_id)


@buckets_cli.command(
    name="remove | rm",
    examples=[
        "hf buckets remove user/my-bucket/file.txt",
        "hf buckets rm hf://buckets/user/my-bucket/file.txt",
        "hf buckets rm user/my-bucket/logs/ --recursive",
        'hf buckets rm user/my-bucket --recursive --include "*.tmp"',
        "hf buckets rm user/my-bucket/data/ --recursive --dry-run",
    ],
)
def remove(
    argument: Annotated[
        str,
        Argument(
            help=(
                "Bucket path: namespace/bucket_name/path or hf://buckets/namespace/bucket_name/path."
                " With --recursive, namespace/bucket_name is also accepted to target all files."
            ),
        ),
    ],
    recursive: Annotated[
        bool,
        Option(
            "--recursive",
            "-R",
            help="Remove files recursively under the given prefix.",
        ),
    ] = False,
    yes: Annotated[
        bool,
        Option(
            "--yes",
            "-y",
            help="Skip confirmation prompt.",
        ),
    ] = False,
    dry_run: Annotated[
        bool,
        Option(
            "--dry-run",
            help="Preview what would be deleted without actually deleting.",
        ),
    ] = False,
    include: Annotated[
        list[str] | None,
        Option(
            help="Include only files matching pattern (can specify multiple). Requires --recursive.",
        ),
    ] = None,
    exclude: Annotated[
        list[str] | None,
        Option(
            help="Exclude files matching pattern (can specify multiple). Requires --recursive.",
        ),
    ] = None,
    token: TokenOpt = None,
) -> None:
    """Remove files from a bucket.

    To delete an entire bucket, use `hf buckets delete` instead.
    """
    parsed = _parse_bucket_uri(argument)
    bucket_id = parsed.id
    prefix = parsed.path_in_repo

    if prefix == "" and not recursive:
        raise click.BadParameter(
            f"No file path specified. To remove files, provide a path"
            f" (e.g. '{bucket_id}/FILE') or use --recursive to remove all files."
            f" To delete the entire bucket, use `hf buckets delete {bucket_id}`."
        )

    if (include or exclude) and not recursive:
        raise click.BadParameter("--include and --exclude require --recursive.")

    api = get_hf_api(token=token)

    if recursive:
        status = out.status("Listing files from remote")

        all_files: list[BucketFile] = []
        for item in api.list_bucket_tree(
            bucket_id,
            prefix=prefix or None,
            recursive=True,
        ):
            if isinstance(item, BucketFile):
                all_files.append(item)
                status.update(f"Listing files from remote ({len(all_files)} files)")
        status.done(f"Listing files from remote ({len(all_files)} files)")

        if include or exclude:
            matcher = FilterMatcher(include_patterns=include, exclude_patterns=exclude)
            matched_files = [f for f in all_files if matcher.matches(f.path)]
        else:
            matched_files = all_files

        file_paths = [f.path for f in matched_files]
        total_size = sum(f.size for f in matched_files)
        size_str = format_size(total_size, human_readable=True)

        if not file_paths:
            out.text("No files to remove.")
            return

        count_label = f"{len(file_paths)} file(s) totaling {size_str}"

        if not yes and not dry_run:
            out.text("\n".join(f"  {path}" for path in file_paths))
            out.confirm(f"Remove {count_label} from '{bucket_id}'?", yes=False)

        if dry_run:
            out.text("\n".join(f"delete: {BUCKET_PREFIX}{bucket_id}/{path}" for path in file_paths))
            out.text(f"(dry run) {count_label} would be removed.")
            return

        api.batch_bucket_files(bucket_id, delete=file_paths)
        out.result(
            f"Removed {count_label} from '{bucket_id}'",
            bucket_id=bucket_id,
            files_deleted=len(file_paths),
            size=size_str,
        )

    else:
        file_path = prefix
        if not file_path:
            raise click.BadParameter("File path cannot be empty.")

        if dry_run:
            out.text(f"delete: {BUCKET_PREFIX}{bucket_id}/{file_path}")
            out.text("(dry run) 1 file would be removed.")
            return

        out.confirm(f"Remove '{file_path}' from '{bucket_id}'?", yes=yes)

        api.batch_bucket_files(bucket_id, delete=[file_path])
        out.result("File removed", path=file_path, bucket_id=bucket_id)


@buckets_cli.command(
    name="move",
    examples=[
        "hf buckets move user/old-bucket user/new-bucket",
        "hf buckets move user/my-bucket my-org/my-bucket",
        "hf buckets move hf://buckets/user/old-bucket hf://buckets/user/new-bucket",
    ],
)
def move(
    from_id: Annotated[
        str,
        Argument(
            help="Source bucket ID: namespace/bucket_name or hf://buckets/namespace/bucket_name",
        ),
    ],
    to_id: Annotated[
        str,
        Argument(
            help="Destination bucket ID: namespace/bucket_name or hf://buckets/namespace/bucket_name",
        ),
    ],
    token: TokenOpt = None,
) -> None:
    """Move (rename) a bucket to a new name or namespace."""
    # Parse from_id
    parsed_from = _parse_bucket_uri(from_id)
    if parsed_from.path_in_repo:
        raise click.BadParameter(
            f"Cannot specify a prefix for bucket move: {from_id}."
            f" Use namespace/bucket_name or {BUCKET_PREFIX}namespace/bucket_name."
        )

    # Parse to_id
    parsed_to = _parse_bucket_uri(to_id)
    if parsed_to.path_in_repo:
        raise click.BadParameter(
            f"Cannot specify a prefix for bucket move: {to_id}."
            f" Use namespace/bucket_name or {BUCKET_PREFIX}namespace/bucket_name."
        )

    api = get_hf_api(token=token)
    api.move_bucket(from_id=parsed_from.id, to_id=parsed_to.id)
    out.result("Bucket moved", from_id=parsed_from.id, to_id=parsed_to.id)


# =============================================================================
# Sync command
# =============================================================================


@buckets_cli.command(
    name="sync",
    examples=[
        "hf buckets sync ./data hf://buckets/user/my-bucket",
        "hf buckets sync hf://buckets/user/my-bucket ./data",
        "hf buckets sync ./data hf://buckets/user/my-bucket --delete",
        'hf buckets sync hf://buckets/user/my-bucket ./data --include "*.safetensors" --exclude "*.tmp"',
        "hf buckets sync ./data hf://buckets/user/my-bucket --plan sync-plan.jsonl",
        "hf buckets sync --apply sync-plan.jsonl",
        "hf buckets sync ./data hf://buckets/user/my-bucket --dry-run",
        "hf buckets sync ./data hf://buckets/user/my-bucket --dry-run | jq .",
    ],
)
def sync(
    source: Annotated[
        str | None,
        Argument(
            help="Source path: local directory or hf://buckets/namespace/bucket_name(/prefix)",
        ),
    ] = None,
    dest: Annotated[
        str | None,
        Argument(
            help="Destination path: local directory or hf://buckets/namespace/bucket_name(/prefix)",
        ),
    ] = None,
    delete: Annotated[
        bool,
        Option(
            help="Delete destination files not present in source.",
        ),
    ] = False,
    ignore_times: Annotated[
        bool,
        Option(
            "--ignore-times",
            help="Skip files only based on size, ignoring modification times.",
        ),
    ] = False,
    ignore_sizes: Annotated[
        bool,
        Option(
            "--ignore-sizes",
            help="Skip files only based on modification times, ignoring sizes.",
        ),
    ] = False,
    plan: Annotated[
        str | None,
        Option(
            help="Save sync plan to JSONL file for review instead of executing.",
        ),
    ] = None,
    apply: Annotated[
        str | None,
        Option(
            help="Apply a previously saved plan file.",
        ),
    ] = None,
    dry_run: Annotated[
        bool,
        Option(
            "--dry-run",
            help="Print sync plan to stdout as JSONL without executing.",
        ),
    ] = False,
    include: Annotated[
        list[str] | None,
        Option(
            help="Include files matching pattern (can specify multiple).",
        ),
    ] = None,
    exclude: Annotated[
        list[str] | None,
        Option(
            help="Exclude files matching pattern (can specify multiple).",
        ),
    ] = None,
    filter_from: Annotated[
        str | None,
        Option(
            help="Read include/exclude patterns from file.",
        ),
    ] = None,
    existing: Annotated[
        bool,
        Option(
            "--existing",
            help="Skip creating new files on receiver (only update existing files).",
        ),
    ] = False,
    ignore_existing: Annotated[
        bool,
        Option(
            "--ignore-existing",
            help="Skip updating files that exist on receiver (only create new files).",
        ),
    ] = False,
    verbose: Annotated[
        bool,
        Option(
            "--verbose",
            "-v",
            help="Show detailed logging with reasoning.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Sync files between local directory and a bucket."""
    api = get_hf_api(token=token)
    api.sync_bucket(
        source=source,
        dest=dest,
        delete=delete,
        ignore_times=ignore_times,
        ignore_sizes=ignore_sizes,
        existing=existing,
        ignore_existing=ignore_existing,
        include=include,
        exclude=exclude,
        filter_from=filter_from,
        plan=plan,
        apply=apply,
        dry_run=dry_run,
        verbose=verbose,
        quiet=out.is_quiet(),
    )
    if plan and not out.is_quiet():
        out.hint(f"Run `hf buckets sync --apply {plan}` to execute this plan.")


# =============================================================================
# Cp command
# =============================================================================


# `hf buckets cp` is an alias for the top-level `hf cp` command (see `cli/_cp.py`).
buckets_cli.command(
    name="cp",
    examples=[
        # Download (repo or bucket -> local / stdout)
        "hf buckets cp hf://buckets/username/my-bucket/config.json config.json",
        "hf buckets cp hf://buckets/username/my-bucket/data.csv data/",
        "hf buckets cp hf://buckets/username/my-bucket/config.json -",
        # Upload (local / stdin -> bucket)
        "hf buckets cp model.safetensors hf://buckets/username/my-bucket/model.safetensors",
        "hf buckets cp config.json hf://buckets/username/my-bucket/logs/",
        "hf buckets cp - hf://buckets/username/my-bucket/config.json",
        # Remote to remote (repo or bucket -> bucket)
        "hf buckets cp hf://buckets/username/my-bucket/data.csv hf://buckets/username/dest-bucket/",
        "hf buckets cp hf://buckets/username/source-bucket/logs/ hf://buckets/username/dest-bucket/logs/",
    ],
)(make_cp("buckets"))
