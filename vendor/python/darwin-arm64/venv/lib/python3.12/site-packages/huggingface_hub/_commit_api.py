"""
Type definitions and utilities for the `create_commit` API
"""

import base64
import io
import json
import os
import warnings
from collections import defaultdict
from collections.abc import Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from itertools import groupby
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, BinaryIO, Literal, NamedTuple, Union

from . import constants
from .errors import EntryNotFoundError
from .file_download import hf_hub_url
from .lfs import UploadInfo, lfs_upload, post_lfs_batch_info
from .utils import (
    FORBIDDEN_FOLDERS,
    are_progress_bars_disabled,
    chunk_iterable,
    get_session,
    hf_raise_for_status,
    hf_thread_map,
    http_backoff,
    logging,
    sha,
    tqdm_stream_file,
    validate_hf_hub_args,
)
from .utils import tqdm as hf_tqdm
from .utils._runtime import is_xet_available


if TYPE_CHECKING:
    from .hf_api import CommitInfo, RepoFile


logger = logging.get_logger(__name__)


UploadMode = Literal["lfs", "regular"]

# Max is 1,000 per request on the Hub for HfApi.get_paths_info
# Otherwise we get:
# HfHubHTTPError: 413 Client Error: Payload Too Large for url: https://huggingface.co/api/datasets/xxx (Request ID: xxx)\n\ntoo many parameters
# See https://github.com/huggingface/huggingface_hub/issues/1503
FETCH_LFS_BATCH_SIZE = 500
DUPLICATE_LFS_BATCH_SIZE = 500

UPLOAD_BATCH_MAX_NUM_FILES = 256


@dataclass
class CommitOperationDelete:
    """
    Data structure holding necessary info to delete a file or a folder from a repository
    on the Hub.

    Args:
        path_in_repo (`str`):
            Relative filepath in the repo, for example: `"checkpoints/1fec34a/weights.bin"`
            for a file or `"checkpoints/1fec34a/"` for a folder.
        is_folder (`bool` or `Literal["auto"]`, *optional*)
            Whether the Delete Operation applies to a folder or not. If "auto", the path
            type (file or folder) is guessed automatically by looking if path ends with
            a "/" (folder) or not (file). To explicitly set the path type, you can set
            `is_folder=True` or `is_folder=False`.
    """

    path_in_repo: str
    is_folder: bool | Literal["auto"] = "auto"

    def __post_init__(self):
        self.path_in_repo = _validate_path_in_repo(self.path_in_repo)

        if self.is_folder == "auto":
            self.is_folder = self.path_in_repo.endswith("/")
        if not isinstance(self.is_folder, bool):
            raise ValueError(
                f"Wrong value for `is_folder`. Must be one of [`True`, `False`, `'auto'`]. Got '{self.is_folder}'."
            )


@dataclass
class CommitOperationCopy:
    """
    Data structure holding necessary info to copy a file in a repository on the Hub.

    Both LFS files and regular files are supported. LFS files are copied server-side while regular files are
    downloaded and re-uploaded as part of the commit.

    Cross-repository copies are supported by setting `src_repo_id` and `src_repo_type`. For cross-repo LFS copies,
    the LFS objects are duplicated to the destination repository before the commit is created. This is handled
    automatically by [`create_commit`]. Note that cross-repository copies only work within the same
    [storage region](https://huggingface.co/docs/hub/storage-regions); copying across regions is not supported.

    Note: you can combine a [`CommitOperationCopy`] and a [`CommitOperationDelete`] to rename an LFS file on the Hub.

    Args:
        src_path_in_repo (`str`):
            Relative filepath in the repo of the file to be copied, e.g. `"checkpoints/1fec34a/weights.bin"`.
        path_in_repo (`str`):
            Relative filepath in the repo where to copy the file, e.g. `"checkpoints/1fec34a/weights_copy.bin"`.
        src_revision (`str`, *optional*):
            The git revision of the file to be copied. Can be any valid git revision.
            Default to the target commit revision.
        src_repo_id (`str`, *optional*):
            The source repository to copy from (e.g. `"username/source-model"`).
            Default to the destination repository (intra-repo copy).
        src_repo_type (`str`, *optional*):
            The type of the source repository (`"model"`, `"dataset"` or `"space"`).
            Required when `src_repo_id` is set.
    """

    src_path_in_repo: str
    path_in_repo: str
    src_revision: str | None = None
    src_repo_id: str | None = None
    src_repo_type: str | None = None
    # set to the OID of the file to be copied if it has already been uploaded
    # useful to determine if a commit will be empty or not.
    _src_oid: str | None = None
    # set to the OID of the file to copy to if it has already been uploaded
    # useful to determine if a commit will be empty or not.
    _dest_oid: str | None = None
    # set to True once cross-repo LFS files have been duplicated to the destination repo
    _is_duplicated: bool = False

    def __post_init__(self):
        self.src_path_in_repo = _validate_path_in_repo(self.src_path_in_repo)
        self.path_in_repo = _validate_path_in_repo(self.path_in_repo)
        if self.src_repo_id is not None and self.src_repo_type is None:
            raise ValueError("`src_repo_type` is required when `src_repo_id` is set.")
        if self.src_repo_type is not None and self.src_repo_id is None:
            raise ValueError("`src_repo_id` is required when `src_repo_type` is set.")


@dataclass
class CommitOperationAdd:
    """
    Data structure holding necessary info to upload a file to a repository on the Hub.

    Args:
        path_in_repo (`str`):
            Relative filepath in the repo, for example: `"checkpoints/1fec34a/weights.bin"`
        path_or_fileobj (`str`, `Path`, `bytes`, or `BinaryIO`):
            Either:
            - a path to a local file (as `str` or `pathlib.Path`) to upload
            - a buffer of bytes (`bytes`) holding the content of the file to upload
            - a "file object" (subclass of `io.BufferedIOBase`), typically obtained
                with `open(path, "rb")`. It must support `seek()` and `tell()` methods.

    Raises:
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If `path_or_fileobj` is not one of `str`, `Path`, `bytes` or `io.BufferedIOBase`.
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If `path_or_fileobj` is a `str` or `Path` but not a path to an existing file.
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If `path_or_fileobj` is a `io.BufferedIOBase` but it doesn't support both
            `seek()` and `tell()`.
    """

    path_in_repo: str
    path_or_fileobj: str | Path | bytes | BinaryIO
    upload_info: UploadInfo = field(init=False, repr=False)

    # Internal attributes

    # set to "lfs" or "regular" once known
    _upload_mode: UploadMode | None = field(init=False, repr=False, default=None)

    # set to True if .gitignore rules prevent the file from being uploaded as LFS
    # (server-side check)
    _should_ignore: bool | None = field(init=False, repr=False, default=None)

    # set to the remote OID of the file if it has already been uploaded
    # useful to determine if a commit will be empty or not
    _remote_oid: str | None = field(init=False, repr=False, default=None)

    # set to True once the file has been uploaded as LFS
    _is_uploaded: bool = field(init=False, repr=False, default=False)

    # set to True once the file has been committed
    _is_committed: bool = field(init=False, repr=False, default=False)

    def __post_init__(self) -> None:
        """Validates `path_or_fileobj` and compute `upload_info`."""
        self.path_in_repo = _validate_path_in_repo(self.path_in_repo)

        # Validate `path_or_fileobj` value
        if isinstance(self.path_or_fileobj, Path):
            self.path_or_fileobj = str(self.path_or_fileobj)
        if isinstance(self.path_or_fileobj, str):
            self.path_or_fileobj = os.path.normpath(os.path.expanduser(self.path_or_fileobj))
            if not os.path.isfile(self.path_or_fileobj):
                raise ValueError(f"Provided path: '{self.path_or_fileobj}' is not a file on the local file system")
        elif not isinstance(self.path_or_fileobj, (io.BufferedIOBase, bytes)):
            # ^^ Inspired from: https://stackoverflow.com/questions/44584829/how-to-determine-if-file-is-opened-in-binary-or-text-mode
            raise ValueError(
                "path_or_fileobj must be either an instance of str, bytes or"
                " io.BufferedIOBase. If you passed a file-like object, make sure it is"
                " in binary mode."
            )
        if isinstance(self.path_or_fileobj, io.BufferedIOBase):
            try:
                self.path_or_fileobj.tell()
                self.path_or_fileobj.seek(0, os.SEEK_CUR)
            except (OSError, AttributeError) as exc:
                raise ValueError(
                    "path_or_fileobj is a file-like object but does not implement seek() and tell()"
                ) from exc

        # Compute "upload_info" attribute
        if isinstance(self.path_or_fileobj, str):
            self.upload_info = UploadInfo.from_path(self.path_or_fileobj)
        elif isinstance(self.path_or_fileobj, bytes):
            self.upload_info = UploadInfo.from_bytes(self.path_or_fileobj)
        else:
            self.upload_info = UploadInfo.from_fileobj(self.path_or_fileobj)

    @contextmanager
    def as_file(self, with_tqdm: bool = False) -> Iterator[BinaryIO]:
        """
        A context manager that yields a file-like object allowing to read the underlying
        data behind `path_or_fileobj`.

        Args:
            with_tqdm (`bool`, *optional*, defaults to `False`):
                If True, iterating over the file object will display a progress bar. Only
                works if the file-like object is a path to a file. Pure bytes and buffers
                are not supported.

        Example:

        ```python
        >>> operation = CommitOperationAdd(
        ...        path_in_repo="remote/dir/weights.h5",
        ...        path_or_fileobj="./local/weights.h5",
        ... )
        CommitOperationAdd(path_in_repo='remote/dir/weights.h5', path_or_fileobj='./local/weights.h5')

        >>> with operation.as_file() as file:
        ...     content = file.read()

        >>> with operation.as_file(with_tqdm=True) as file:
        ...     while True:
        ...         data = file.read(1024)
        ...         if not data:
        ...              break
        config.json: 100%|█████████████████████████| 8.19k/8.19k [00:02<00:00, 3.72kB/s]

        >>> with operation.as_file(with_tqdm=True) as file:
        ...     httpx.put(..., data=file)
        config.json: 100%|█████████████████████████| 8.19k/8.19k [00:02<00:00, 3.72kB/s]
        ```
        """
        if isinstance(self.path_or_fileobj, str) or isinstance(self.path_or_fileobj, Path):
            if with_tqdm:
                with tqdm_stream_file(self.path_or_fileobj) as file:
                    yield file
            else:
                with open(self.path_or_fileobj, "rb") as file:
                    yield file
        elif isinstance(self.path_or_fileobj, bytes):
            yield io.BytesIO(self.path_or_fileobj)
        elif isinstance(self.path_or_fileobj, io.BufferedIOBase):
            prev_pos = self.path_or_fileobj.tell()
            yield self.path_or_fileobj
            self.path_or_fileobj.seek(prev_pos, io.SEEK_SET)

    def b64content(self) -> bytes:
        """
        The base64-encoded content of `path_or_fileobj`

        Returns: `bytes`
        """
        with self.as_file() as file:
            return base64.b64encode(file.read())

    @property
    def _local_oid(self) -> str | None:
        """Return the OID of the local file.

        This OID is then compared to `self._remote_oid` to check if the file has changed compared to the remote one.
        If the file did not change, we won't upload it again to prevent empty commits.

        For LFS files, the OID corresponds to the SHA256 of the file content (used a LFS ref).
        For regular files, the OID corresponds to the SHA1 of the file content.
        Note: this is slightly different to git OID computation since the oid of an LFS file is usually the git-SHA1 of the
              pointer file content (not the actual file content). However, using the SHA256 is enough to detect changes
              and more convenient client-side.
        """
        if self._upload_mode is None:
            return None
        elif self._upload_mode == "lfs":
            return self.upload_info.sha256.hex()
        else:
            # Regular file => compute sha1
            # => no need to read by chunk since the file is guaranteed to be <=5MB.
            with self.as_file() as file:
                return sha.git_hash(file.read())


def _validate_path_in_repo(path_in_repo: str) -> str:
    # Validate `path_in_repo` value to prevent a server-side issue
    if path_in_repo.startswith("/"):
        path_in_repo = path_in_repo[1:]
    if path_in_repo == "." or path_in_repo == ".." or path_in_repo.startswith("../"):
        raise ValueError(f"Invalid `path_in_repo` in CommitOperation: '{path_in_repo}'")
    if path_in_repo.startswith("./"):
        path_in_repo = path_in_repo[2:]
    for forbidden in FORBIDDEN_FOLDERS:
        if any(part == forbidden for part in path_in_repo.split("/")):
            raise ValueError(
                f"Invalid `path_in_repo` in CommitOperation: cannot update files under a '{forbidden}/' folder (path:"
                f" '{path_in_repo}')."
            )
    return path_in_repo


CommitOperation = Union[CommitOperationAdd, CommitOperationCopy, CommitOperationDelete]


def _warn_on_overwriting_operations(operations: list[CommitOperation]) -> None:
    """
    Warn user when a list of operations is expected to overwrite itself in a single
    commit.

    Rules:
    - If a filepath is updated by multiple `CommitOperationAdd` operations, a warning
      message is triggered.
    - If a filepath is updated at least once by a `CommitOperationAdd` and then deleted
      by a `CommitOperationDelete`, a warning is triggered.
    - If a `CommitOperationDelete` deletes a filepath that is then updated by a
      `CommitOperationAdd`, no warning is triggered. This is usually useless (no need to
      delete before upload) but can happen if a user deletes an entire folder and then
      add new files to it.
    """
    nb_additions_per_path: dict[str, int] = defaultdict(int)
    for operation in operations:
        path_in_repo = operation.path_in_repo
        if isinstance(operation, CommitOperationAdd):
            if nb_additions_per_path[path_in_repo] > 0:
                warnings.warn(
                    "About to update multiple times the same file in the same commit:"
                    f" '{path_in_repo}'. This can cause undesired inconsistencies in"
                    " your repo."
                )
            nb_additions_per_path[path_in_repo] += 1
            for parent in PurePosixPath(path_in_repo).parents:
                # Also keep track of number of updated files per folder
                # => warns if deleting a folder overwrite some contained files
                nb_additions_per_path[str(parent)] += 1
        if isinstance(operation, CommitOperationDelete):
            if nb_additions_per_path[str(PurePosixPath(path_in_repo))] > 0:
                if operation.is_folder:
                    warnings.warn(
                        "About to delete a folder containing files that have just been"
                        f" updated within the same commit: '{path_in_repo}'. This can"
                        " cause undesired inconsistencies in your repo."
                    )
                else:
                    warnings.warn(
                        "About to delete a file that have just been updated within the"
                        f" same commit: '{path_in_repo}'. This can cause undesired"
                        " inconsistencies in your repo."
                    )


@validate_hf_hub_args
def _upload_files(
    *,
    additions: list[CommitOperationAdd],
    repo_type: str,
    repo_id: str,
    headers: dict[str, str],
    endpoint: str | None = None,
    num_threads: int = 5,
    revision: str | None = None,
    create_pr: bool | None = None,
):
    """
    Uploads the files through the Xet protocol if possible, otherwise through the legacy LFS protocol.

    The Xet path does not require any Python-side sha256 computation: hashing happens inside `hf_xet`
    while chunking the files (single read pass) and is backfilled on the operations afterwards.
    """
    has_buffered_io_data = any(isinstance(op.path_or_fileobj, io.BufferedIOBase) for op in additions)
    if is_xet_available():
        if not has_buffered_io_data:
            _upload_xet_files(
                additions=additions,
                repo_type=repo_type,
                repo_id=repo_id,
                headers=headers,
                endpoint=endpoint,
                revision=revision,
                create_pr=create_pr,
            )
            return
        logger.warning(
            "Uploading files as a binary IO buffer is not supported by Xet Storage. Falling back to HTTP upload."
        )

    # Legacy LFS path: sha256 is required by the LFS batch endpoint => compute missing ones (in parallel).
    _compute_missing_sha256s(additions, num_threads=num_threads)

    lfs_actions: list[dict[str, Any]] = []
    lfs_oid2addop: dict[str, CommitOperationAdd] = {}
    for chunk in chunk_iterable(additions, chunk_size=UPLOAD_BATCH_MAX_NUM_FILES):
        chunk_list = [op for op in chunk]
        actions_chunk, errors_chunk, _ = post_lfs_batch_info(
            upload_infos=[op.upload_info for op in chunk_list],
            repo_id=repo_id,
            repo_type=repo_type,
            revision=revision,
            endpoint=endpoint,
            headers=headers,
            token=None,  # already passed in 'headers'
            transfers=["basic", "multipart"],
        )
        if errors_chunk:
            message = "\n".join(
                [
                    f"Encountered error for file with OID {err.get('oid')}: `{err.get('error', {}).get('message')}"
                    for err in errors_chunk
                ]
            )
            raise ValueError(f"LFS batch API returned errors:\n{message}")
        lfs_actions.extend(actions_chunk)
        for op in chunk_list:
            lfs_oid2addop[op.upload_info.sha256.hex()] = op

    if len(lfs_actions) > 0:
        _upload_lfs_files(
            actions=lfs_actions,
            oid2addop=lfs_oid2addop,
            headers=headers,
            endpoint=endpoint,
            num_threads=num_threads,
        )


def _compute_missing_sha256s(additions: list[CommitOperationAdd], num_threads: int) -> None:
    """Compute the sha256 of the operations that don't have one yet, in parallel."""
    not_hashed = [op for op in additions if not op.upload_info.is_hashed]
    if len(not_hashed) == 0:
        return
    logger.info(f"Computing sha256 for {len(not_hashed)} files.")
    if len(not_hashed) == 1:
        _ = not_hashed[0].upload_info.sha256
        return
    with ThreadPoolExecutor(max_workers=num_threads) as executor:
        list(executor.map(lambda op: op.upload_info.sha256, not_hashed))


@validate_hf_hub_args
def _upload_lfs_files(
    *,
    actions: list[dict[str, Any]],
    oid2addop: dict[str, CommitOperationAdd],
    headers: dict[str, str],
    endpoint: str | None = None,
    num_threads: int = 5,
):
    """
    Uploads the content of `additions` to the Hub using the large file storage protocol.

    Relevant external documentation:
        - LFS Batch API: https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md

    Args:
        actions (`list[dict[str, Any]]`):
            LFS batch actions returned by the server.
        oid2addop (`dict[str, CommitOperationAdd]`):
            A dictionary mapping the OID of the file to the corresponding `CommitOperationAdd` object.
        headers (`dict[str, str]`):
            Headers to use for the request, including authorization headers and user agent.
        endpoint (`str`, *optional*):
            The endpoint to use for the request. Defaults to `constants.ENDPOINT`.
        num_threads (`int`, *optional*):
            The number of concurrent threads to use when uploading. Defaults to 5.

    Raises:
        [`EnvironmentError`](https://docs.python.org/3/library/exceptions.html#EnvironmentError)
            If an upload failed for any reason
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            Type of the repo to upload to: `"model"`, `"dataset"` or `"space"`.
        repo_id (`str`):
            A namespace (user or an organization) and a repo name separated
            by a `/`.
        headers (`dict[str, str]`):
            Headers to use for the request, including authorization headers and user agent.
        num_threads (`int`, *optional*):
            The number of concurrent threads to use when uploading. Defaults to 5.
        revision (`str`, *optional*):
            The git revision to upload to.

    Raises:
        [`EnvironmentError`](https://docs.python.org/3/library/exceptions.html#EnvironmentError)
            If an upload failed for any reason
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If the server returns malformed responses
        [`HfHubHTTPError`]
            If the LFS batch endpoint returned an HTTP error.
    """
    # Filter out files already present upstream
    filtered_actions = []
    for action in actions:
        if action.get("actions") is None:
            logger.debug(
                f"Content of file {oid2addop[action['oid']].path_in_repo} is already present upstream - skipping upload."
            )
        else:
            filtered_actions.append(action)

    # Upload according to server-provided actions
    def _wrapped_lfs_upload(batch_action) -> None:
        try:
            operation = oid2addop[batch_action["oid"]]
            lfs_upload(operation=operation, lfs_batch_action=batch_action, headers=headers, endpoint=endpoint)
        except Exception as exc:
            raise RuntimeError(f"Error while uploading '{operation.path_in_repo}' to the Hub.") from exc

    if len(filtered_actions) == 1:
        logger.debug("Uploading 1 LFS file to the Hub")
        _wrapped_lfs_upload(filtered_actions[0])
    else:
        logger.debug(
            f"Uploading {len(filtered_actions)} LFS files to the Hub using up to {num_threads} threads concurrently"
        )
        hf_thread_map(
            _wrapped_lfs_upload,
            filtered_actions,
            desc=f"Upload {len(filtered_actions)} LFS files",
            max_workers=num_threads,
            tqdm_class=hf_tqdm,
        )


@validate_hf_hub_args
def _upload_xet_files(
    *,
    additions: list[CommitOperationAdd],
    repo_type: str,
    repo_id: str,
    headers: dict[str, str],
    endpoint: str | None = None,
    revision: str | None = None,
    create_pr: bool | None = None,
):
    """
    Uploads the content of `additions` to the Hub using the xet storage protocol.
    This chunks the files and deduplicates the chunks before uploading them to xetcas storage.

    Args:
        additions (`` of `CommitOperationAdd`):
            The files to be uploaded.
        repo_type (`str`):
            Type of the repo (e.g. `"model"`, `"dataset"`, `"space"`).
        repo_id (`str`):
            A namespace (user or an organization) and a repo name separated
            by a `/`.
        headers (`dict[str, str]`):
            Headers to use for the request, including authorization headers and user agent.
        endpoint: (`str`, *optional*):
            The endpoint to use for the xetcas service. Defaults to `constants.ENDPOINT`.
        revision (`str`, *optional*):
            The git revision to upload to.
        create_pr (`bool`, *optional*):
            Whether or not to create a Pull Request with that commit.

    Raises:
        [`EnvironmentError`](https://docs.python.org/3/library/exceptions.html#EnvironmentError)
            If an upload failed for any reason.
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If the server returns malformed responses or if the user is unauthorized to upload to xet storage.
        [`HfHubHTTPError`]
            If the LFS batch endpoint returned an HTTP error.

    **How it works:**
        The file upload system uses Xet storage, which is a content-addressable storage system that breaks files into chunks
        for efficient storage and transfer.

        ``session.new_upload_commit()`` manages uploading files by:
            - Registering upload tasks and starting upload immediately in the background
            - Breaking files into smaller chunks for efficient storage
            - Avoiding duplicate storage by recognizing identical chunks across files
            - Connecting to a storage server (CAS server) that manages these chunks

        Authentication works transparently: the upload commit accepts a ``token_refresh_url``
        that is used to refresh the short-lived xet write token as needed.

        The upload process works like this:
        1. Upload tasks run in parallel:
            1.1. Read the file content from a path, bytes array, or a stream.
            1.2. Split the file content into smaller chunks based on content patterns: each chunk gets a unique ID based on what's in it.
            1.3. For each chunk:
                - Check if it already exists in storage.
                - Skip uploading chunks that already exist.
            1.4. Group chunks into larger blocks for efficient transfer.
            1.5. Upload these blocks to the storage server.
            1.6. Assemble the file manifest locally and send it to the server for validation.
        2. Return reference files that contain information about the uploaded files, which can be used later to download them.
    """
    if len(additions) == 0:
        return

    # at this point, we know that hf_xet is installed
    from .utils._xet import (
        XetTokenType,
        abort_xet_session,
        get_xet_session,
        xet_connection_info_refresh_url,
        xet_headers_without_auth,
    )
    from .utils._xet_progress_reporting import XetUploadProgressReporter

    refresh_url = xet_connection_info_refresh_url(
        token_type=XetTokenType.WRITE,
        repo_id=repo_id,
        repo_type=repo_type,
        revision=revision,
        endpoint=endpoint,
    )
    if create_pr:
        refresh_url += "?create_pr=1"

    xet_headers = xet_headers_without_auth(headers)

    import hf_xet

    session = get_xet_session()
    progress = None

    def _sha256_arg(op: CommitOperationAdd):
        # If the sha256 is already known, pass it to avoid recomputation. Otherwise let hf_xet
        # compute it while chunking the file (single read pass) and backfill it afterwards.
        return op.upload_info.sha256.hex() if op.upload_info.is_hashed else hf_xet.COMPUTE_SHA256

    try:
        if not are_progress_bars_disabled():
            progress = XetUploadProgressReporter()
            progress_callback = progress.update_progress
        else:
            progress_callback = None

        all_bytes_ops = [op for op in additions if isinstance(op.path_or_fileobj, bytes)]
        all_paths_ops = [op for op in additions if isinstance(op.path_or_fileobj, (str, Path))]

        handles: list[tuple[CommitOperationAdd, Any]] = []
        with session.new_upload_commit(
            token_refresh_url=refresh_url,
            token_refresh_headers=headers,
            custom_headers=xet_headers,
            progress_callback=progress_callback,
        ) as commit:
            for op in all_paths_ops:
                handles.append((op, commit.start_upload_file(str(op.path_or_fileobj), sha256=_sha256_arg(op))))
            for op in all_bytes_ops:
                handles.append((op, commit.start_upload_bytes(op.path_or_fileobj, sha256=_sha256_arg(op))))

        # Backfill sha256 computed by hf_xet (needed later for the commit payload).
        for op, handle in handles:
            if not op.upload_info.is_hashed:
                op.upload_info.sha256 = bytes.fromhex(handle.result().xet_info.sha256)
    except KeyboardInterrupt:
        abort_xet_session()
        raise
    finally:
        if progress is not None:
            progress.close()


def _validate_preupload_info(preupload_info: dict):
    files = preupload_info.get("files")
    if not isinstance(files, list):
        raise ValueError("preupload_info is improperly formatted")
    for file_info in files:
        if not (
            isinstance(file_info, dict)
            and isinstance(file_info.get("path"), str)
            and isinstance(file_info.get("uploadMode"), str)
            and (file_info["uploadMode"] in ("lfs", "regular"))
        ):
            raise ValueError("preupload_info is improperly formatted:")
    return preupload_info


@validate_hf_hub_args
def _fetch_upload_modes(
    additions: Iterable[CommitOperationAdd],
    repo_type: str,
    repo_id: str,
    headers: dict[str, str],
    revision: str,
    endpoint: str | None = None,
    create_pr: bool = False,
    gitignore_content: str | None = None,
) -> None:
    """
    Requests the Hub "preupload" endpoint to determine whether each input file should be uploaded as a regular git blob,
    as a git LFS blob, or as a XET file. Input `additions` are mutated in-place with the upload mode.

    Args:
        additions (`Iterable` of :class:`CommitOperationAdd`):
            Iterable of :class:`CommitOperationAdd` describing the files to
            upload to the Hub.
        repo_type (`str`):
            Type of the repo to upload to: `"model"`, `"dataset"` or `"space"`.
        repo_id (`str`):
            A namespace (user or an organization) and a repo name separated
            by a `/`.
        headers (`dict[str, str]`):
            Headers to use for the request, including authorization headers and user agent.
        revision (`str`):
            The git revision to upload the files to. Can be any valid git revision.
        gitignore_content (`str`, *optional*):
            The content of the `.gitignore` file to know which files should be ignored. The order of priority
            is to first check if `gitignore_content` is passed, then check if the `.gitignore` file is present
            in the list of files to commit and finally default to the `.gitignore` file already hosted on the Hub
            (if any).
    Raises:
        [`~utils.HfHubHTTPError`]
            If the Hub API returned an error.
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If the Hub API response is improperly formatted.
    """
    endpoint = endpoint if endpoint is not None else constants.ENDPOINT

    # Fetch upload mode (LFS or regular) chunk by chunk.
    upload_modes: dict[str, UploadMode] = {}
    should_ignore_info: dict[str, bool] = {}
    oid_info: dict[str, str | None] = {}

    for chunk in chunk_iterable(additions, 256):
        payload: dict = {
            "files": [
                {
                    "path": op.path_in_repo,
                    "sample": base64.b64encode(op.upload_info.sample).decode("ascii"),
                    "size": op.upload_info.size,
                }
                for op in chunk
            ]
        }
        if gitignore_content is not None:
            payload["gitIgnore"] = gitignore_content

        resp = http_backoff(
            "POST",
            f"{endpoint}/api/{repo_type}s/{repo_id}/preupload/{revision}",
            json=payload,
            headers=headers,
            params={"create_pr": "1"} if create_pr else None,
        )
        hf_raise_for_status(resp)
        preupload_info = _validate_preupload_info(resp.json())
        upload_modes.update(**{file["path"]: file["uploadMode"] for file in preupload_info["files"]})
        should_ignore_info.update(**{file["path"]: file["shouldIgnore"] for file in preupload_info["files"]})
        oid_info.update(**{file["path"]: file.get("oid") for file in preupload_info["files"]})

    # Set upload mode for each addition operation
    for addition in additions:
        addition._upload_mode = upload_modes[addition.path_in_repo]
        addition._should_ignore = should_ignore_info[addition.path_in_repo]
        addition._remote_oid = oid_info[addition.path_in_repo]

    # Empty files cannot be uploaded as LFS (S3 would fail with a 501 Not Implemented)
    # => empty files are uploaded as "regular" to still allow users to commit them.
    for addition in additions:
        if addition.upload_info.size == 0:
            addition._upload_mode = "regular"


class _CopySource(NamedTuple):
    src_repo_id: str | None
    src_repo_type: str | None
    path: str
    revision: str | None


@validate_hf_hub_args
def _fetch_files_to_copy(
    copies: Iterable[CommitOperationCopy],
    repo_type: str,
    repo_id: str,
    headers: dict[str, str],
    revision: str,
    endpoint: str | None = None,
) -> dict[_CopySource, Union["RepoFile", bytes]]:
    """
    Fetch information about the files to copy.

    For LFS files, we only need their metadata (file size and sha256) while for regular files
    we need to download the raw content from the Hub.

    Args:
        copies (`Iterable` of :class:`CommitOperationCopy`):
            Iterable of :class:`CommitOperationCopy` describing the files to
            copy on the Hub.
        repo_type (`str`):
            Type of the repo to upload to: `"model"`, `"dataset"` or `"space"`.
        repo_id (`str`):
            A namespace (user or an organization) and a repo name separated
            by a `/`.
        headers (`dict[str, str]`):
            Headers to use for the request, including authorization headers and user agent.
        revision (`str`):
            The git revision to upload the files to. Can be any valid git revision.

    Returns: `dict[_CopySource, Union[RepoFile, bytes]]]`
        Key is `(src_repo_id, src_repo_type, path, revision)`. For intra-repo copies,
        `src_repo_id` and `src_repo_type` are `None`.
        Value is the raw content as bytes (for regular files) or the file information as a RepoFile (for LFS files).

    Raises:
        [`~utils.HfHubHTTPError`]
            If the Hub API returned an error.
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If the Hub API response is improperly formatted.
    """
    from .hf_api import HfApi, RepoFolder

    hf_api = HfApi(endpoint=endpoint, headers=headers)
    copies = list(copies)
    files_to_copy: dict[_CopySource, Union["RepoFile", bytes]] = {}
    oid_info: dict[tuple[str, str | None], str | None] = {}

    # 1. Fetch OIDs for destination paths in batches.
    dest_paths = [op.path_in_repo for op in copies]
    for batch in chunk_iterable(dest_paths, FETCH_LFS_BATCH_SIZE):
        dest_repo_files = hf_api.get_paths_info(
            repo_id=repo_id,
            paths=list(batch),
            revision=revision,
            repo_type=repo_type,
        )
        for file in dest_repo_files:
            if not isinstance(file, RepoFolder):
                oid_info[(file.path, revision)] = file.blob_id

    # 2. Fetch source file info, grouped by (src_repo_id, src_repo_type, src_revision).
    copies.sort(key=lambda op: (op.src_repo_id or "", op.src_repo_type or "", op.src_revision or ""))
    for (src_repo_id_key, src_repo_type_key, src_revision_key), group in groupby(
        copies, key=lambda op: (op.src_repo_id, op.src_repo_type, op.src_revision)
    ):
        operations = list(group)
        is_cross_repo = src_repo_id_key is not None
        eff_repo_id = src_repo_id_key or repo_id
        eff_repo_type = src_repo_type_key or repo_type
        eff_revision = src_revision_key or ("main" if is_cross_repo else revision)

        src_paths = [op.src_path_in_repo for op in operations]
        for paths_batch in chunk_iterable(src_paths, FETCH_LFS_BATCH_SIZE):
            src_repo_files = hf_api.get_paths_info(
                repo_id=eff_repo_id,
                paths=list(paths_batch),
                revision=eff_revision,
                repo_type=eff_repo_type,
            )
            for src_repo_file in src_repo_files:
                if isinstance(src_repo_file, RepoFolder):
                    raise NotImplementedError("Copying a folder is not implemented.")
                source = _CopySource(src_repo_id_key, src_repo_type_key, src_repo_file.path, src_revision_key)
                if src_repo_file.lfs:
                    files_to_copy[source] = src_repo_file
                else:
                    url = hf_hub_url(
                        endpoint=endpoint,
                        repo_type=eff_repo_type,
                        repo_id=eff_repo_id,
                        revision=eff_revision,
                        filename=src_repo_file.path,
                    )
                    response = get_session().get(url, headers=headers)
                    hf_raise_for_status(response)
                    files_to_copy[source] = response.content
                if not is_cross_repo:
                    oid_info[(src_repo_file.path, src_revision_key)] = src_repo_file.blob_id

        for operation in operations:
            key = _CopySource(src_repo_id_key, src_repo_type_key, operation.src_path_in_repo, src_revision_key)
            if key not in files_to_copy:
                source_desc = f" from {eff_repo_type}s/{eff_repo_id}" if is_cross_repo else ""
                raise EntryNotFoundError(
                    f"Cannot copy {operation.src_path_in_repo} at revision "
                    f"{eff_revision}{source_desc}: file is missing on repo."
                )
            operation._dest_oid = oid_info.get((operation.path_in_repo, revision))
            if not is_cross_repo:
                operation._src_oid = oid_info.get((operation.src_path_in_repo, operation.src_revision))

    return files_to_copy


def _prepare_commit_payload(
    operations: Iterable[CommitOperation],
    files_to_copy: dict[_CopySource, Union["RepoFile", bytes]],
    commit_message: str,
    commit_description: str | None = None,
    parent_commit: str | None = None,
) -> Iterable[dict[str, Any]]:
    """
    Builds the payload to POST to the `/commit` API of the Hub.

    Payload is returned as an iterator so that it can be streamed as a ndjson in the
    POST request.

    For more information, see:
        - https://github.com/huggingface/huggingface_hub/issues/1085#issuecomment-1265208073
        - http://ndjson.org/
    """
    commit_description = commit_description if commit_description is not None else ""

    # 1. Send a header item with the commit metadata
    header_value = {"summary": commit_message, "description": commit_description}
    if parent_commit is not None:
        header_value["parentCommit"] = parent_commit
    yield {"key": "header", "value": header_value}

    nb_ignored_files = 0

    # 2. Send operations, one per line
    for operation in operations:
        # Skip ignored files
        if isinstance(operation, CommitOperationAdd) and operation._should_ignore:
            logger.debug(f"Skipping file '{operation.path_in_repo}' in commit (ignored by gitignore file).")
            nb_ignored_files += 1
            continue

        # 2.a. Case adding a regular file
        if isinstance(operation, CommitOperationAdd) and operation._upload_mode == "regular":
            yield {
                "key": "file",
                "value": {
                    "content": operation.b64content().decode(),
                    "path": operation.path_in_repo,
                    "encoding": "base64",
                },
            }
        # 2.b. Case adding an LFS file
        elif isinstance(operation, CommitOperationAdd) and operation._upload_mode == "lfs":
            yield {
                "key": "lfsFile",
                "value": {
                    "path": operation.path_in_repo,
                    "algo": "sha256",
                    "oid": operation.upload_info.sha256.hex(),
                    "size": operation.upload_info.size,
                },
            }
        # 2.c. Case deleting a file or folder
        elif isinstance(operation, CommitOperationDelete):
            yield {
                "key": "deletedFolder" if operation.is_folder else "deletedFile",
                "value": {"path": operation.path_in_repo},
            }
        # 2.d. Case copying a file or folder
        elif isinstance(operation, CommitOperationCopy):
            source = _CopySource(
                operation.src_repo_id,
                operation.src_repo_type,
                operation.src_path_in_repo,
                operation.src_revision,
            )
            file_to_copy = files_to_copy[source]
            if isinstance(file_to_copy, bytes):
                yield {
                    "key": "file",
                    "value": {
                        "content": base64.b64encode(file_to_copy).decode(),
                        "path": operation.path_in_repo,
                        "encoding": "base64",
                    },
                }
            elif file_to_copy.lfs:
                yield {
                    "key": "lfsFile",
                    "value": {
                        "path": operation.path_in_repo,
                        "algo": "sha256",
                        "oid": file_to_copy.lfs.sha256,
                    },
                }
            else:
                raise ValueError(
                    "Malformed files_to_copy (should be raw file content as bytes or RepoFile objects with LFS info."
                )
        # 2.e. Never expected to happen
        else:
            raise ValueError(
                f"Unknown operation to commit. Operation: {operation}. Upload mode:"
                f" {getattr(operation, '_upload_mode', None)}"
            )

    if nb_ignored_files > 0:
        logger.info(f"Skipped {nb_ignored_files} file(s) in commit (ignored by gitignore file).")


def _send_commit(
    *,
    operations: Iterable[CommitOperation],
    files_to_copy: dict[_CopySource, Union["RepoFile", bytes]],
    commit_message: str,
    commit_description: str,
    repo_type: str,
    repo_id: str,
    headers: dict[str, str],
    revision: str,
    endpoint: str | None = None,
    parent_commit: str | None = None,
    create_pr: bool = False,
    hot_reload: bool = False,
    retry_on_error: bool = False,
) -> "CommitInfo":
    """
    Build the ndjson payload for `operations` and POST it to the `/commit` endpoint of the Hub.

    `revision` must already be URL-quoted. Operations must be ready to commit: upload modes fetched
    and LFS/Xet content uploaded.

    If `retry_on_error` is `True`, the POST is retried with exponential backoff on transient errors.
    Caution: if a commit succeeds but its response is lost, the retry will create a duplicate commit
    (and a duplicate pull request if `create_pr` is set) — only enable it when this is acceptable.

    Returns a [`CommitInfo`] built from the server response.

    Raises:
        [`~utils.HfHubHTTPError`]
            If the Hub API returned an error.
    """
    endpoint = endpoint if endpoint is not None else constants.ENDPOINT
    payload = _prepare_commit_payload(
        operations=operations,
        files_to_copy=files_to_copy,
        commit_message=commit_message,
        commit_description=commit_description,
        parent_commit=parent_commit,
    )
    data = b"".join(json.dumps(item).encode() + b"\n" for item in payload)
    # See https://github.com/huggingface/huggingface_hub/issues/1085#issuecomment-1265208073
    headers = {"Content-Type": "application/x-ndjson", **headers}
    url = f"{endpoint}/api/{repo_type}s/{repo_id}/commit/{revision}"

    params: dict[str, str] = {}
    if create_pr:
        params["create_pr"] = "1"
    if hot_reload:
        params["hot_reload"] = "1"

    if retry_on_error:
        response = http_backoff("POST", url, headers=headers, content=data, params=params)
    else:
        response = get_session().post(url, headers=headers, content=data, params=params)
    hf_raise_for_status(response, endpoint_name="commit")

    commit_data = response.json()
    from .hf_api import CommitInfo

    return CommitInfo(
        commit_url=commit_data["commitUrl"],
        commit_message=commit_message,
        commit_description=commit_description,
        oid=commit_data["commitOid"],
        pr_url=commit_data["pullRequestUrl"] if create_pr else None,
        _endpoint=endpoint,
    )
