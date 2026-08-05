import os
from pathlib import Path
from typing import Literal, overload

import httpx
from tqdm.auto import tqdm as base_tqdm

from . import constants
from ._revision import ResolvedRevision
from ._tree_cache import TreeCacheEntry, read_tree_cache, tree_cache_folder_for_local_dir, write_tree_cache
from .errors import (
    CachedRepoTreeNotFoundError,
    DryRunError,
    GatedRepoError,
    HfHubHTTPError,
    IncompleteSnapshotError,
    LocalEntryNotFoundError,
    RepositoryNotFoundError,
    RevisionNotFoundError,
)
from .file_download import REGEX_COMMIT_HASH, DryRunFileInfo, hf_hub_download, repo_folder_name
from .hf_api import HfApi, RepoFile
from .utils import OfflineModeIsEnabled, filter_repo_objects, logging, validate_hf_hub_args
from .utils._xet_progress_reporting import (
    XET_BYTES_BAR_FORMAT,
    XET_TRANSFER_BAR_FORMAT,
    _finish_transfer_bar,
    _set_aggregate_rate_postfix,
    _update_transfer_bar,
)
from .utils.tqdm import _create_progress_bar, hf_thread_map
from .utils.tqdm import tqdm as hf_tqdm


logger = logging.get_logger(__name__)


@overload
def snapshot_download(
    repo_id: str,
    *,
    repo_type: str | None = None,
    revision: str | None = None,
    cache_dir: str | Path | None = None,
    local_dir: str | Path | None = None,
    library_name: str | None = None,
    library_version: str | None = None,
    user_agent: dict | str | None = None,
    etag_timeout: float = constants.DEFAULT_ETAG_TIMEOUT,
    force_download: bool = False,
    token: bool | str | None = None,
    local_files_only: bool = False,
    allow_patterns: list[str] | str | None = None,
    ignore_patterns: list[str] | str | None = None,
    max_workers: int = 8,
    tqdm_class: type[base_tqdm] | None = None,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
    dry_run: Literal[False] = False,
) -> str: ...


@overload
def snapshot_download(
    repo_id: str,
    *,
    repo_type: str | None = None,
    revision: str | None = None,
    cache_dir: str | Path | None = None,
    local_dir: str | Path | None = None,
    library_name: str | None = None,
    library_version: str | None = None,
    user_agent: dict | str | None = None,
    etag_timeout: float = constants.DEFAULT_ETAG_TIMEOUT,
    force_download: bool = False,
    token: bool | str | None = None,
    local_files_only: bool = False,
    allow_patterns: list[str] | str | None = None,
    ignore_patterns: list[str] | str | None = None,
    max_workers: int = 8,
    tqdm_class: type[base_tqdm] | None = None,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
    dry_run: Literal[True] = True,
) -> list[DryRunFileInfo]: ...


@overload
def snapshot_download(
    repo_id: str,
    *,
    repo_type: str | None = None,
    revision: str | None = None,
    cache_dir: str | Path | None = None,
    local_dir: str | Path | None = None,
    library_name: str | None = None,
    library_version: str | None = None,
    user_agent: dict | str | None = None,
    etag_timeout: float = constants.DEFAULT_ETAG_TIMEOUT,
    force_download: bool = False,
    token: bool | str | None = None,
    local_files_only: bool = False,
    allow_patterns: list[str] | str | None = None,
    ignore_patterns: list[str] | str | None = None,
    max_workers: int = 8,
    tqdm_class: type[base_tqdm] | None = None,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
    dry_run: bool = False,
) -> str | list[DryRunFileInfo]: ...


@validate_hf_hub_args
def snapshot_download(
    repo_id: str,
    *,
    repo_type: str | None = None,
    revision: str | None = None,
    cache_dir: str | Path | None = None,
    local_dir: str | Path | None = None,
    library_name: str | None = None,
    library_version: str | None = None,
    user_agent: dict | str | None = None,
    etag_timeout: float = constants.DEFAULT_ETAG_TIMEOUT,
    force_download: bool = False,
    token: bool | str | None = None,
    local_files_only: bool = False,
    allow_patterns: list[str] | str | None = None,
    ignore_patterns: list[str] | str | None = None,
    max_workers: int = 8,
    tqdm_class: type[base_tqdm] | None = None,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
    dry_run: bool = False,
) -> str | list[DryRunFileInfo]:
    """Download repo files.

    Download a whole snapshot of a repo's files at the specified revision. This is useful when you want all files from
    a repo because you don't know which ones you will need _a priori_. All files are nested in a folder to keep their
    path and filename relative to that folder. You can also filter which files to download by using `allow_patterns`
    and `ignore_patterns`.

    If `local_dir` is provided, the file structure from the repo will be replicated in this location. When using this
    option, the `cache_dir` will not be used, and a `.cache/huggingface/` folder will be created at the root of `local_dir`
    to store some metadata related to the downloaded files. While this mechanism is not as robust as the main
    cache system, it's optimized for regularly pulling the latest version of a repository.

    An alternative would be to clone the repo, but this requires git and git-lfs to be installed and properly
    configured. It is also not possible to filter which files to download when cloning a repository using git.

    Args:
        repo_id (`str`):
            A user or an organization name and a repo name separated by a `/`.
        repo_type (`str`, *optional*):
            Set to `"dataset"`, `"space"` or `"kernel"` if downloading from a dataset, space or kernel repo,
            `None` or `"model"` if downloading from a model. Default is `None`.
        revision (`str`, *optional*):
            An optional Git revision id, which can be a branch name, a tag, or a
            commit hash.
        cache_dir (`str`, `Path`, *optional*):
            Path to the folder where cached files are stored.
        local_dir (`str` or `Path`, *optional*):
            If provided, the downloaded files will be placed under this directory.
        library_name (`str`, *optional*):
            The name of the library to which the object corresponds.
        library_version (`str`, *optional*):
            The version of the library.
        user_agent (`str`, `dict`, *optional*):
            The user-agent info in the form of a dictionary or a string.
        etag_timeout (`float`, *optional*, defaults to `10`):
            When fetching ETag, how many seconds to wait for the server to send
            data before giving up, which is passed to `httpx.request`.
        force_download (`bool`, *optional*, defaults to `False`):
            Whether the file should be downloaded even if it already exists in the local cache.
        token (`str`, `bool`, *optional*):
            A token to be used for the download.
                - If `True`, the token is read from the HuggingFace config
                  folder.
                - If a string, it's used as the authentication token.
        headers (`dict`, *optional*):
            Additional headers to include in the request. Those headers take precedence over the others.
        endpoint (`str`, *optional*):
            The Hub endpoint to send the request to. Defaults to the value of `HF_ENDPOINT`.
        local_files_only (`bool`, *optional*, defaults to `False`):
            If `True`, do not download any files even if they are not in `cache_dir` or `local_dir`.
        allow_patterns (`list[str]` or `str`, *optional*):
            If provided, only files matching at least one pattern are downloaded.
        ignore_patterns (`list[str]` or `str`, *optional*):
            If provided, files matching any of the patterns are not downloaded.
        max_workers (`int`, *optional*):
            Number of concurrent threads to download files (1 thread = 1 file download).
            Defaults to 8.
        tqdm_class (`tqdm`, *optional*):
            If provided, overwrites the default behavior for the progress bar. Passed
            argument must inherit from `tqdm.auto.tqdm` or at least mimic its behavior.
            Note that the `tqdm_class` is not passed to each individual download.
            Defaults to the custom HF progress bar that can be disabled by setting
            `HF_HUB_DISABLE_PROGRESS_BARS` environment variable.
        dry_run (`bool`, *optional*, defaults to `False`):
            If `True`, perform a dry run without actually downloading the files. Returns a list of
            [`DryRunFileInfo`] objects containing information about what would be downloaded.

    Returns:
        `str` or list of [`DryRunFileInfo`]:
            - If `dry_run=False`: Local snapshot path.
            - If `dry_run=True`: A list of [`DryRunFileInfo`] objects containing download information.

    Raises:
        [`~utils.RepositoryNotFoundError`]
            If the repository to download from cannot be found. This may be because it doesn't exist
            or because it is set to `private` and you do not have access.
        [`~utils.RevisionNotFoundError`]
            If the revision to download from cannot be found.
        [`~errors.IncompleteSnapshotError`]
            If the Hub cannot be reached (offline, connection issue, or `local_files_only=True`) and the
            cached snapshot is missing some of the requested files.
        [`EnvironmentError`](https://docs.python.org/3/library/exceptions.html#EnvironmentError)
            If `token=True` and the token cannot be found.
        [`OSError`](https://docs.python.org/3/library/exceptions.html#OSError) if
            ETag cannot be determined.
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If some parameter value is invalid.
    """
    if cache_dir is None:
        cache_dir = constants.HF_HUB_CACHE
    cache_dir = str(Path(cache_dir).expanduser().resolve())
    if local_dir is not None:
        local_dir = str(Path(local_dir).expanduser().resolve())
    if revision is None:
        revision = constants.DEFAULT_REVISION

    if repo_type is None:
        repo_type = "model"
    if repo_type not in constants.REPO_TYPES_WITH_KERNEL:
        raise ValueError(
            f"Invalid repo type: {repo_type}. Accepted repo types are: {str(constants.REPO_TYPES_WITH_KERNEL)}"
        )

    storage_folder = os.path.join(cache_dir, repo_folder_name(repo_id=repo_id, repo_type=repo_type))

    # Folder under which the per-commit tree listing (`trees/<commit_hash>.json`) is cached on disk.
    tree_cache_folder = tree_cache_folder_for_local_dir(local_dir) if local_dir is not None else storage_folder

    api = HfApi(
        library_name=library_name,
        library_version=library_version,
        user_agent=user_agent,
        endpoint=endpoint,
        headers=headers,
        token=token,
    )

    # The revision is already a commit hash if:
    # - it's a `ResolvedRevision` (already resolved, see [`HfApi.resolve_revision`])
    # - it's a commit hash, which is immutable
    # => in both cases, there is nothing to resolve and the `repo_info` call can be skipped.
    commit_hash: str | None = None
    if isinstance(revision, ResolvedRevision):
        commit_hash = revision.resolved
    elif REGEX_COMMIT_HASH.match(revision):
        commit_hash = revision

    api_call_error: Exception | None = None
    if commit_hash is None and not local_files_only:
        # try/except logic to handle different errors => taken from `hf_hub_download`
        try:
            # if we have internet connection we want to list files to download
            repo_info = api.repo_info(repo_id=repo_id, repo_type=repo_type, revision=revision)
            assert repo_info.sha is not None, "Repo info returned from server must have a revision sha."
            commit_hash = repo_info.sha
        except httpx.ProxyError:
            # Actually raise on proxy error
            raise
        except (httpx.ConnectError, httpx.TimeoutException, OfflineModeIsEnabled) as error:
            # Internet connection is down
            # => will try to use local files only
            api_call_error = error
            pass
        except RevisionNotFoundError:
            # The repo was found but the revision doesn't exist on the Hub (never existed or got deleted)
            raise
        except HfHubHTTPError as error:
            # Multiple reasons for an http error:
            # - Repository is private and invalid/missing token sent
            # - Repository is gated and invalid/missing token sent
            # - Hub is down (error 500 or 504)
            # => let's switch to 'local_files_only=True' to check if the files are already cached.
            #    (if it's not the case, the error will be re-raised)
            api_call_error = error
            pass

    # At this stage, if the commit hash is unknown it means either:
    # - internet connection is down
    # - internet connection is deactivated (local_files_only=True or HF_HUB_OFFLINE=True)
    # - repo is private/gated and invalid/missing token sent
    # - Hub is down
    # => let's look if we can find the appropriate folder in the cache:
    #    - if the specified revision is a commit hash, look inside "snapshots".
    #    - f the specified revision is a branch or tag, look inside "refs".
    # => if local_dir is not None, we will return the path to the local folder if it exists.
    if commit_hash is None or local_files_only:
        if dry_run:
            raise DryRunError(
                "Dry run cannot be performed as the repository cannot be accessed. Please check your internet connection or authentication token."
            ) from api_call_error

        # Try to get which commit hash corresponds to the specified revision
        if commit_hash is None:
            ref_path = os.path.join(storage_folder, "refs", revision)
            if os.path.exists(ref_path):
                # retrieve commit_hash from refs file
                with open(ref_path) as f:
                    commit_hash = f.read()

        # Try to locate snapshot folder for this commit hash
        if commit_hash is not None and local_dir is None:
            snapshot_folder = os.path.join(storage_folder, "snapshots", commit_hash)
            if os.path.exists(snapshot_folder):
                # The folder exists, but may be partial (e.g. after an interrupted download): only return it
                # if the cached tree listing confirms it is complete.
                _raise_if_incomplete_snapshot(
                    tree_cache_folder=tree_cache_folder,
                    commit_hash=commit_hash,
                    base_dir=snapshot_folder,
                    allow_patterns=allow_patterns,
                    ignore_patterns=ignore_patterns,
                    repo_id=repo_id,
                    revision=revision,
                    api_call_error=api_call_error,
                )
                return snapshot_folder

        # If local_dir is not None, return it if it exists and is complete
        if local_dir is not None:
            local_dir = Path(local_dir)
            if local_dir.is_dir() and any(local_dir.iterdir()):
                if commit_hash is not None:
                    _raise_if_incomplete_snapshot(
                        tree_cache_folder=tree_cache_folder,
                        commit_hash=commit_hash,
                        base_dir=str(local_dir),
                        allow_patterns=allow_patterns,
                        ignore_patterns=ignore_patterns,
                        repo_id=repo_id,
                        revision=revision,
                        api_call_error=api_call_error,
                    )
                logger.warning(
                    f"Returning existing local_dir `{local_dir}` as remote repo cannot be accessed in `snapshot_download` ({api_call_error})."
                )
                return str(local_dir.resolve())
        # If we couldn't find the appropriate folder on disk, raise an error.
        if local_files_only:
            raise LocalEntryNotFoundError(
                "Cannot find an appropriate cached snapshot folder for the specified revision on the local disk and "
                "outgoing traffic has been disabled. To enable repo look-ups and downloads online, pass "
                "'local_files_only=False' as input."
            )
        elif isinstance(api_call_error, OfflineModeIsEnabled):
            raise LocalEntryNotFoundError(
                "Cannot find an appropriate cached snapshot folder for the specified revision on the local disk and "
                "outgoing traffic has been disabled. To enable repo look-ups and downloads online, set "
                "'HF_HUB_OFFLINE=0' as environment variable."
            ) from api_call_error
        elif isinstance(api_call_error, (RepositoryNotFoundError, GatedRepoError)) or (
            isinstance(api_call_error, HfHubHTTPError) and api_call_error.response.status_code == 401
        ):
            # Repo not found, gated, or specific authentication error => let's raise the actual error
            raise api_call_error
        else:
            # Otherwise: most likely a connection issue or Hub downtime => let's warn the user
            raise LocalEntryNotFoundError(
                f"Got: {api_call_error.__class__.__name__}: {api_call_error}"
                "\nAn error happened while trying to locate the files on the Hub, and we cannot find the appropriate"
                " snapshot folder for the specified revision on the local disk. Please check your internet connection"
                " and try again."
            ) from api_call_error

    # At this stage, the commit hash is known and internet connection is up and running
    # => let's download the files!
    assert commit_hash is not None

    # Retrieve /tree listing from cache or fetch it
    tree_entries = read_tree_cache(tree_cache_folder, commit_hash)
    if tree_entries is None:
        tree_entries = {
            f.path: TreeCacheEntry(
                size=f.size,
                blob_id=f.blob_id,
                lfs_sha256=f.lfs.sha256 if f.lfs is not None else None,
                lfs_size=f.lfs.size if f.lfs is not None else None,
                xet_hash=f.xet_hash,
            )
            for f in api.list_repo_tree(repo_id=repo_id, recursive=True, revision=commit_hash, repo_type=repo_type)
            if isinstance(f, RepoFile)
        }
        if not dry_run:
            write_tree_cache(tree_cache_folder, commit_hash, tree_entries)

    filtered_repo_files = list(
        filter_repo_objects(
            items=tree_entries.keys(),
            allow_patterns=allow_patterns,
            ignore_patterns=ignore_patterns,
        )
    )
    tqdm_desc = f"Fetching {len(filtered_repo_files)} files"
    if dry_run:
        tqdm_desc = "[dry-run] " + tqdm_desc

    snapshot_folder = os.path.join(storage_folder, "snapshots", commit_hash)
    # if passed revision is not identical to commit_hash
    # then revision has to be a branch name or tag name.
    # In that case store a ref (except if ResolvedRevision, in which case it's already done).
    if not isinstance(revision, ResolvedRevision) and revision != commit_hash:
        ref_path = os.path.join(storage_folder, "refs", revision)
        try:
            os.makedirs(os.path.dirname(ref_path), exist_ok=True)
            with open(ref_path, "w") as f:
                f.write(commit_hash)
        except OSError as e:
            logger.warning(f"Ignored error while writing commit hash to {ref_path}: {e}.")

    results: list[str | DryRunFileInfo] = []

    # User can use its own tqdm class or the default one from `huggingface_hub.utils`
    tqdm_class = tqdm_class or hf_tqdm

    # Create progress bars for the bytes downloaded.
    # Transfer bytes are received from the network; reconstruction bytes are written to disk.
    transfer_progress = _create_progress_bar(
        cls=tqdm_class,
        log_level=logger.getEffectiveLevel(),
        name="huggingface_hub.snapshot_download.transfer",
        desc="Downloading bytes",
        total=0,
        initial=0,
        unit="B",
        unit_scale=True,
        bar_format=XET_TRANSFER_BAR_FORMAT,
    )

    reconstruct_progress = _create_progress_bar(
        cls=tqdm_class,
        log_level=logger.getEffectiveLevel(),
        name="huggingface_hub.snapshot_download",
        desc="Reconstructing (incomplete total...)",
        total=0,
        initial=0,
        unit="B",
        unit_scale=True,
        bar_format=XET_BYTES_BAR_FORMAT,
    )

    class _AggregatedTqdm:
        """Fake tqdm object to aggregate progress into the parent snapshot progress bars.

        In practice, the `_AggregatedTqdm` object won't be displayed; it's just used to update
        the `reconstruct_progress` and `transfer_progress` bars from each thread/file download.
        """

        def __init__(self, *args, **kwargs):
            # Adjust the total of the parent progress bar
            total = kwargs.pop("total", None)
            if total is not None:
                reconstruct_progress.total = (reconstruct_progress.total or 0) + total
                transfer_progress.total = (transfer_progress.total or 0) + total
                reconstruct_progress.refresh()

            # Adjust initial of the parent progress bar
            initial = kwargs.pop("initial", 0)
            if initial:
                reconstruct_progress.update(initial)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            pass

        def close(self) -> None:
            pass

        def update(self, n: int | float | None = 1) -> None:
            reconstruct_progress.update(n)

        def update_transfer(self, n: int | float | None = 1) -> None:
            _update_transfer_bar(transfer_progress, int(n or 0))

        def set_postfix_str(self, postfix: str, refresh: bool = False) -> None:
            # Discard the caller's per-file rate; report the summed rate across all files instead.
            _set_aggregate_rate_postfix(reconstruct_progress)

        def set_transfer_postfix_str(self, postfix: str, refresh: bool = False) -> None:
            _set_aggregate_rate_postfix(transfer_progress)

    # Pass the commit_hash as revision to hf_hub_download to skip network call if:
    # - file is cached
    # - or xet file with metadata cached in /tree cache
    def _inner_hf_hub_download(repo_file: str) -> None:
        results.append(
            hf_hub_download(  # type: ignore
                repo_id,
                filename=repo_file,
                repo_type=repo_type,
                revision=commit_hash,
                endpoint=endpoint,
                cache_dir=cache_dir,
                local_dir=local_dir,
                library_name=library_name,
                library_version=library_version,
                user_agent=user_agent,
                etag_timeout=etag_timeout,
                force_download=force_download,
                token=token,
                headers=headers,
                tqdm_class=_AggregatedTqdm,  # type: ignore
                dry_run=dry_run,
            )
        )

    hf_thread_map(
        _inner_hf_hub_download,
        filtered_repo_files,
        desc=tqdm_desc,
        max_workers=max_workers,
        tqdm_class=tqdm_class,
    )

    _finish_transfer_bar(transfer_progress)
    transfer_progress.set_description("Download complete")
    reconstruct_progress.set_description("Reconstruction complete")

    if dry_run:
        assert all(isinstance(r, DryRunFileInfo) for r in results)
        return results  # type: ignore

    if local_dir is not None:
        return str(os.path.realpath(local_dir))
    return snapshot_folder


def _raise_if_incomplete_snapshot(
    *,
    tree_cache_folder: str,
    commit_hash: str,
    base_dir: str,
    allow_patterns: list[str] | str | None,
    ignore_patterns: list[str] | str | None,
    repo_id: str,
    revision: str,
    api_call_error: Exception | None,
) -> None:
    """Raise [`IncompleteSnapshotError`] if the cached tree listing shows `base_dir` misses requested files.

    If the tree listing is not cached we cannot tell, so we do nothing and the caller keeps returning the
    folder as-is. Otherwise every expected file (after pattern filtering) must exist under `base_dir`.
    """
    tree_entries = read_tree_cache(tree_cache_folder, commit_hash)
    if tree_entries is None:
        return
    expected = filter_repo_objects(
        items=tree_entries.keys(), allow_patterns=allow_patterns, ignore_patterns=ignore_patterns
    )
    missing = [path for path in expected if not _local_file_exists(base_dir, path)]
    if not missing:
        return

    sample = ", ".join(missing[:3])
    if len(missing) > 3:
        sample += f", ... ({len(missing) - 3} more)"
    if api_call_error is not None:
        reason = f"The Hub could not be reached ({api_call_error.__class__.__name__}: {api_call_error})."
    else:
        reason = "Outgoing traffic is disabled ('local_files_only=True')."
    raise IncompleteSnapshotError(
        f"The cached snapshot for '{repo_id}' (revision '{revision}', commit {commit_hash}) is incomplete: "
        f"{len(missing)} file(s) are missing ({sample}). {reason} Re-run the download with network access "
        "to complete the snapshot.",
        snapshot_path=base_dir,
    ) from api_call_error


@validate_hf_hub_args
def get_cached_repo_tree(
    repo_id: str,
    *,
    repo_type: str | None = None,
    revision: str | None = None,
    cache_dir: str | Path | None = None,
    local_dir: str | Path | None = None,
) -> list[RepoFile]:
    """Return the cached tree listing of a repo at a given revision, without any network call.

    The tree listing is the set of files (with their download metadata) of a repo at a commit. It is populated
    on disk as a side effect of [`snapshot_download`] (see the `trees/<commit_hash>.json` cache files) and is
    used to skip network calls on subsequent downloads. This function exposes that cache directly.

    If you need the current tree listing of a repo on the Hub, use [`list_repo_tree`] instead.

    Args:
        repo_id (`str`):
            A user or an organization name and a repo name separated by a `/`.
        repo_type (`str`, *optional*):
            Set to `"dataset"`, `"space"` or `"kernel"` if listing from a dataset, space or kernel repo,
            `None` or `"model"` if listing from a model. Default is `None`.
        revision (`str`, *optional*):
            An optional Git revision id, which can be a branch name, a tag, or a commit hash. Defaults to the
            default branch. Branch/tag names are resolved to a commit hash using the local cache (`refs/`).
        cache_dir (`str`, `Path`, *optional*):
            Path to the folder where cached files are stored. Defaults to the value of `HF_HUB_CACHE`.
        local_dir (`str` or `Path`, *optional*):
            If provided, read the tree listing cached by a `local_dir` download (from
            `local_dir/.cache/huggingface/`) instead of the main cache. Branch/tag revisions are still resolved
            to a commit hash using the main cache (`cache_dir`).

    Returns:
        `list[RepoFile]`: The list of [`RepoFile`] objects cached for this revision.

    Raises:
        [`~errors.CachedRepoTreeNotFoundError`]
            If no tree listing is cached for the requested revision (e.g. the repo was never downloaded at this revision).

    Example:
        ```py
        >>> from huggingface_hub import get_cached_repo_tree
        >>> files = get_cached_repo_tree("openai-community/gpt2")
        >>> [f.path for f in files]
        ['.gitattributes', 'config.json', 'model.safetensors', ...]
        ```
    """
    if cache_dir is None:
        cache_dir = constants.HF_HUB_CACHE
    cache_dir = str(Path(cache_dir).expanduser().resolve())
    if local_dir is not None:
        local_dir = str(Path(local_dir).expanduser().resolve())
    if revision is None:
        revision = constants.DEFAULT_REVISION
    if repo_type is None:
        repo_type = constants.REPO_TYPE_MODEL
    if repo_type not in constants.REPO_TYPES_WITH_KERNEL:
        raise ValueError(
            f"Invalid repo type: {repo_type}. Accepted repo types are: {str(constants.REPO_TYPES_WITH_KERNEL)}"
        )

    storage_folder = os.path.join(cache_dir, repo_folder_name(repo_id=repo_id, repo_type=repo_type))

    # For `local_dir` downloads the tree listing lives under `local_dir/.cache/huggingface/`; otherwise it lives
    # in the per-repo `storage_folder`. Refs are always recorded in the main cache, so we resolve them there.
    tree_cache_folder = tree_cache_folder_for_local_dir(local_dir) if local_dir is not None else storage_folder

    # The tree cache is keyed by commit hash. Resolve the revision to a commit hash: either it already is one,
    # or it's a branch/tag name recorded in `refs/` by a previous download.
    if isinstance(revision, ResolvedRevision):
        commit_hash = revision.resolved
    elif REGEX_COMMIT_HASH.match(revision):
        commit_hash = revision
    else:
        ref_path = os.path.join(storage_folder, "refs", revision)
        if not os.path.isfile(ref_path):
            raise CachedRepoTreeNotFoundError(
                f"No cached tree listing found for '{repo_id}' (revision '{revision}', repo_type '{repo_type}'): "
                f"the revision is not a commit hash and no matching ref is cached in '{storage_folder}'. "
                "Download the repo (e.g. with `snapshot_download`) to populate the cache first."
            )
        with open(ref_path) as f:
            commit_hash = f.read()

    tree_entries = read_tree_cache(tree_cache_folder, commit_hash)
    if tree_entries is None:
        raise CachedRepoTreeNotFoundError(
            f"No cached tree listing found for '{repo_id}' (revision '{revision}', commit '{commit_hash}', "
            f"repo_type '{repo_type}') in '{tree_cache_folder}'. Download the repo (e.g. with `snapshot_download`) "
            "to populate the cache first."
        )

    return [
        RepoFile(path=path, size=entry.size, oid=entry.blob_id, xetHash=entry.xet_hash)
        for path, entry in tree_entries.items()
    ]


def _local_file_exists(base_dir: str, path: str) -> bool:
    """Check whether a repo file (path relative to `base_dir`, '/'-separated) exists on disk.

    On Windows, paths longer than 255 characters must be prefixed with `\\\\?\\`, otherwise `os.path.isfile` reports an
    existing file as missing.
    """
    full_path = os.path.join(base_dir, *path.split("/"))
    if os.name == "nt" and len(os.path.abspath(full_path)) > 255 and not full_path.startswith("\\\\?\\"):
        full_path = "\\\\?\\" + os.path.abspath(full_path)
    return os.path.isfile(full_path)
