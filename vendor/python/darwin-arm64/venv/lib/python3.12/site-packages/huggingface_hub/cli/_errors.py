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
"""CLI error handling utilities."""

import traceback
from collections.abc import Callable

from huggingface_hub.errors import (
    BucketNotFoundError,
    CLIError,
    CLIExtensionInstallError,
    DeviceCodeError,
    EntryNotFoundError,
    GatedRepoError,
    HfHubHTTPError,
    HfUriError,
    IncompleteSnapshotError,
    LocalEntryNotFoundError,
    LocalTokenNotFoundError,
    OfflineModeIsEnabled,
    OIDCError,
    RemoteEntryNotFoundError,
    RepositoryNotFoundError,
    RevisionNotFoundError,
)


def _format_repo_not_found(error: RepositoryNotFoundError) -> str:
    label = error.repo_type.capitalize() if error.repo_type else "Repository"
    if error.repo_id:
        msg = f"{label} '{error.repo_id}' not found."
    else:
        msg = f"{label} not found."
    msg += "\nIf the repo is private, make sure you are authenticated and your token has the required permissions."

    msg += "\nIf the repo does not exist, create it with: "
    if error.repo_id is not None:
        type_flag = f" --type {error.repo_type}" if error.repo_type and error.repo_type != "model" else ""
        msg += f"hf repos create {error.repo_id}{type_flag}"
    else:
        msg += "hf repos create <repo_id>"

    return msg


def _format_gated_repo(error: GatedRepoError) -> str:
    label = error.repo_type if error.repo_type else "repository"
    if error.repo_id:
        return f"Access denied. {label.capitalize()} '{error.repo_id}' requires approval."
    return f"Access denied. This {label} requires approval."


def _format_bucket_not_found(error: BucketNotFoundError) -> str:
    if error.bucket_id:
        msg = f"Bucket '{error.bucket_id}' not found."
        cmd = f"hf buckets create {error.bucket_id}"
    else:
        msg = "Bucket not found."
        cmd = "hf buckets create <bucket_id>"
    msg += "\nIf the bucket is private, make sure you are authenticated and your token has the required permissions."
    msg += f"\nIf the bucket does not exist, create it with: {cmd}"
    return msg


def _format_entry_not_found(error: RemoteEntryNotFoundError) -> str:
    label = error.repo_type if error.repo_type else "repository"
    url = str(error.response.url) if error.response else None
    if error.repo_id:
        msg = f"File not found in {label} '{error.repo_id}'."
    else:
        msg = f"File not found in {label}."
    if url:
        msg += f"\nURL: {url}"
    return msg


def _format_local_entry_not_found(error: LocalEntryNotFoundError) -> str:
    cause = error.__cause__
    if cause is not None:
        return f"Local entry not found. {cause}"
    return f"Local entry not found. {error}"


def _format_incomplete_snapshot(error: IncompleteSnapshotError) -> str:
    msg = _format_local_entry_not_found(error)
    msg += f"\nIncomplete snapshot available at: {error.snapshot_path}"
    return msg


def _format_revision_not_found(error: RevisionNotFoundError) -> str:
    label = error.repo_type if error.repo_type else "repository"
    if error.repo_id:
        return f"Revision not found in {label} '{error.repo_id}'."
    return f"Revision not found in {label}. Check the revision parameter."


def _format_cli_error(error: CLIError) -> str:
    """No traceback, just the error message."""
    return str(error)


def _format_cli_extension_install_error(error: CLIExtensionInstallError) -> str:
    """Format a CLI extension installation error.

    The error is likely to be a tricky subprocess error to investigate. In this specific case we want to format the
    traceback of the root cause while keeping the "nicely formatted" error message of the CLIExtensionInstallError
    as a 1-line message.
    """
    cause_tb = (
        "".join(traceback.format_exception(type(error.__cause__), error.__cause__, error.__cause__.__traceback__))
        if error.__cause__ is not None
        else ""
    )
    return f"{cause_tb}\n{error}"


CLI_ERROR_MAPPINGS: dict[type[Exception], Callable[..., str]] = {
    OfflineModeIsEnabled: lambda error: str(error),
    # GatedRepoError must come before RepositoryNotFoundError (it's a subclass).
    GatedRepoError: _format_gated_repo,
    BucketNotFoundError: _format_bucket_not_found,
    RepositoryNotFoundError: _format_repo_not_found,
    RevisionNotFoundError: _format_revision_not_found,
    LocalTokenNotFoundError: lambda _: "Not logged in. Run 'hf auth login' first.",
    OIDCError: lambda error: f"OIDC Exchange failed. {error}",
    DeviceCodeError: lambda error: f"Login failed: {error}",
    RemoteEntryNotFoundError: _format_entry_not_found,
    # IncompleteSnapshotError must come before LocalEntryNotFoundError (it's a subclass).
    IncompleteSnapshotError: _format_incomplete_snapshot,
    LocalEntryNotFoundError: _format_local_entry_not_found,
    EntryNotFoundError: lambda error: str(error),
    HfHubHTTPError: lambda error: str(error),
    HfUriError: lambda error: f"Invalid HF URI: {error.uri}. {error.msg}",
    ValueError: lambda error: f"Invalid value. {error}",
    CLIExtensionInstallError: _format_cli_extension_install_error,
    CLIError: _format_cli_error,
}


def format_known_exception(error: Exception) -> str | None:
    for exc_type, formatter in CLI_ERROR_MAPPINGS.items():
        if isinstance(error, exc_type):
            return formatter(error)
    return None
