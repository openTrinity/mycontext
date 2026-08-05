import os
import tempfile
import threading
from collections import deque
from collections.abc import Iterable, Iterator
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from itertools import chain
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn, Union
from urllib.parse import quote, unquote

import fsspec
import httpx
from fsspec.callbacks import _DEFAULT_CALLBACK, NoOpCallback, TqdmCallback
from fsspec.config import apply_config
from fsspec.utils import isfilelike

from . import constants
from ._commit_api import CommitOperationCopy, CommitOperationDelete
from .errors import (
    BucketNotFoundError,
    EntryNotFoundError,
    HfHubHTTPError,
    RepositoryNotFoundError,
    RevisionNotFoundError,
)
from .file_download import hf_hub_url, http_get
from .hf_api import SPECIAL_REFS_REVISION_REGEX, BucketFile, BucketFolder, HfApi, LastCommitInfo, RepoFile, RepoFolder
from .utils import HFValidationError, hf_raise_for_status, http_backoff, http_stream_backoff, parse_hf_uri
from .utils.insecure_hashlib import md5


@dataclass
class HfFileSystemResolvedPath:
    """Top level Data structure containing information about a resolved Hugging Face file system path."""

    root: str
    path: str

    def unresolve(self) -> str:
        return f"{self.root}/{self.path}".rstrip("/")


@dataclass
class HfFileSystemResolvedRepositoryPath(HfFileSystemResolvedPath):
    """Data structure containing information about a resolved path in a repository."""

    repo_type: str
    repo_id: str
    revision: str
    path_in_repo: str
    root: str = field(init=False)
    path: str = field(init=False)
    # The part placed after '@' in the initial path. It can be a quoted or unquoted refs revision.
    # Used to reconstruct the unresolved path to return to the user.
    _raw_revision: str | None = field(default=None, repr=False)

    def __post_init__(self):
        repo_path = constants.REPO_TYPES_URL_PREFIXES.get(self.repo_type, "") + self.repo_id
        if self._raw_revision:
            self.root = f"{repo_path}@{self._raw_revision}"
        elif self.revision != constants.DEFAULT_REVISION:
            self.root = f"{repo_path}@{safe_revision(self.revision)}"
        else:
            self.root = repo_path
        self.path = self.path_in_repo


@dataclass
class HfFileSystemResolvedBucketPath(HfFileSystemResolvedPath):
    """Data structure containing information about a resolved path in a bucket."""

    bucket_id: str
    root: str = field(init=False)

    def __post_init__(self):
        self.root = "buckets/" + self.bucket_id


# We need to improve fsspec.spec._Cached which is AbstractFileSystem's metaclass
_cached_base: Any = type(fsspec.AbstractFileSystem)


class _Cached(_cached_base):
    """
    Metaclass for caching HfFileSystem instances according to the args.

    This creates an additional reference to the filesystem, which prevents the
    filesystem from being garbage collected when all *user* references go away.
    A call to the :meth:`AbstractFileSystem.clear_instance_cache` must *also*
    be made for a filesystem instance to be garbage collected.

    This is a slightly modified version of `fsspec.spec._Cached` to improve it.
    In particular in `_tokenize` the pid isn't taken into account for the
    `fs_token` used to identify cached instances. The `fs_token` logic is also
    robust to defaults values and the order of the args. Finally new instances
    reuse the states from sister instances in the main thread.
    """

    def __init__(cls, *args, **kwargs):
        # Hack: override https://github.com/fsspec/filesystem_spec/blob/dcb167e8f50e6273d4cfdfc4cab8fc5aa4c958bf/fsspec/spec.py#L53
        super().__init__(*args, **kwargs)
        # Note: we intentionally create a reference here, to avoid garbage
        # collecting instances when all other references are gone. To really
        # delete a FileSystem, the cache must be cleared.
        cls._cache = {}

    def __call__(cls, *args, **kwargs):
        # Hack: override https://github.com/fsspec/filesystem_spec/blob/dcb167e8f50e6273d4cfdfc4cab8fc5aa4c958bf/fsspec/spec.py#L65
        # Apply fsspec config (env vars / config files) before tokenizing so that
        # HfFileSystem picks up defaults the same way other fsspec filesystems do.
        kwargs = apply_config(cls, kwargs)
        skip = kwargs.pop("skip_instance_cache", False)
        fs_token = cls._tokenize(cls, threading.get_ident(), *args, **kwargs)
        fs_token_main_thread = cls._tokenize(cls, threading.main_thread().ident, *args, **kwargs)
        if not skip and cls.cachable and fs_token in cls._cache:
            # reuse cached instance
            cls._latest = fs_token
            return cls._cache[fs_token]
        else:
            # create new instance
            obj = type.__call__(cls, *args, **kwargs)
            if not skip and cls.cachable and fs_token_main_thread in cls._cache:
                # reuse the cache from the main thread instance in the new instance
                instance_state = cls._cache[fs_token_main_thread]._get_instance_state()
                for attr, state_value in instance_state.items():
                    setattr(obj, attr, state_value)
            obj._fs_token_ = fs_token
            obj.storage_args = args
            obj.storage_options = kwargs
            if cls.cachable and not skip:
                cls._latest = fs_token
                cls._cache[fs_token] = obj
            return obj


class HfFileSystem(fsspec.AbstractFileSystem, metaclass=_Cached):  # ty: ignore[conflicting-metaclass]
    """
    Access a remote Hugging Face Hub repository as if were a local file system.

    > [!WARNING]
    > [`HfFileSystem`] provides fsspec compatibility, which is useful for libraries that require it (e.g., reading
    >     Hugging Face datasets directly with `pandas`). However, it introduces additional overhead due to this compatibility
    >     layer. For better performance and reliability, it's recommended to use `HfApi` methods when possible.

    The file system supports paths for the `hf://` protocol, which follows those URL schemes:

    * Models, Datasets and Spaces repositories:

        ```
        hf://<repo-id>[@<revision>]/<path/in/repo>
        hf://datasets/<repo-id>[@<revision>]/<path/in/repo>
        hf://spaces/<repo-id>[@<revision>]/<path/in/repo>
        ```

    * Buckets (generic storage):

        ```
        hf://buckets/<bucket-id>/<path/in/bucket>
        ```

    Note: when using the [`HfFileSystem`] directly, passing the `hf://` protocol prefix is optional in paths.

    Args:
        endpoint (`str`, *optional*):
                Endpoint of the Hub. Defaults to <https://huggingface.co>.
        token (`bool` or `str`, *optional*):
            A valid user access token (string). Defaults to the locally saved
            token, which is the recommended method for authentication (see
            https://huggingface.co/docs/huggingface_hub/quick-start#authentication).
            To disable authentication, pass `False`.
        block_size (`int`, *optional*):
            Block size for reading and writing files.
        expand_info (`bool`, *optional*):
            Whether to expand the information of the files.
        **storage_options (`dict`, *optional*):
            Additional options for the filesystem. See [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.__init__).

    Usage:

    ```python
    >>> from huggingface_hub import hffs

    >>> # List files
    >>> hffs.glob("my-username/my-model/*.bin")
    ['my-username/my-model/pytorch_model.bin']
    >>> hffs.ls("datasets/my-username/my-dataset", detail=False)
    ['datasets/my-username/my-dataset/.gitattributes', 'datasets/my-username/my-dataset/README.md', 'datasets/my-username/my-dataset/data.json']

    >>> # Read/write files
    >>> with hffs.open("my-username/my-model/pytorch_model.bin") as f:
    ...     data = f.read()
    >>> with hffs.open("my-username/my-model/pytorch_model.bin", "wb") as f:
    ...     f.write(data)
    ```

    Specify a token for authentication:
    ```python
    >>> from huggingface_hub import HfFileSystem
    >>> hffs = HfFileSystem(token=token)
    ```
    """

    root_marker = ""
    protocol = "hf"

    def __init__(
        self,
        *args,
        endpoint: str | None = None,
        token: bool | str | None = None,
        block_size: int | None = None,
        expand_info: bool | None = None,
        **storage_options,
    ):
        super().__init__(*args, **storage_options)
        self.endpoint = endpoint or constants.ENDPOINT
        self.token = token
        self._api = HfApi(endpoint=endpoint, token=token)
        self.block_size = block_size
        self.expand_info = expand_info
        # Maps (repo_type, repo_id, revision) to a 2-tuple with:
        #  * the 1st element indicating whether the repository and the revision exist
        #  * the 2nd element being the exception raised if the repository or revision doesn't exist
        self._repo_and_revision_exists_cache: dict[tuple[str, str, str | None], tuple[bool, Exception | None]] = {}
        # Same for buckets
        self._bucket_exists_cache: dict[str, tuple[bool, Exception | None]] = {}
        # Note: special case for buckets: revision is always None
        # Maps parent directory path to path infos
        self.dircache: dict[str, list[dict[str, Any]]] = {}

    @classmethod
    def _tokenize(cls, threading_ident: int, *args, **kwargs) -> str:
        """Deterministic token for caching"""
        # make fs_token robust to default values and to kwargs order
        kwargs["endpoint"] = kwargs.get("endpoint") or constants.ENDPOINT
        kwargs["token"] = kwargs.get("token")
        kwargs = {key: kwargs[key] for key in sorted(kwargs)}
        # contrary to fsspec, we don't include pid here
        tokenize_args = (cls, threading_ident, args, kwargs)
        h = md5(str(tokenize_args).encode())
        return h.hexdigest()

    def _repo_and_revision_exist(
        self, repo_type: str, repo_id: str, revision: str | None
    ) -> tuple[bool, Exception | None]:
        if (repo_type, repo_id, revision) not in self._repo_and_revision_exists_cache:
            try:
                self._api.repo_info(
                    repo_id, revision=revision, repo_type=repo_type, timeout=constants.HF_HUB_ETAG_TIMEOUT
                )
            except (RepositoryNotFoundError, HFValidationError) as e:
                self._repo_and_revision_exists_cache[(repo_type, repo_id, revision)] = False, e
                self._repo_and_revision_exists_cache[(repo_type, repo_id, None)] = False, e
            except RevisionNotFoundError as e:
                self._repo_and_revision_exists_cache[(repo_type, repo_id, revision)] = False, e
                self._repo_and_revision_exists_cache[(repo_type, repo_id, None)] = True, None
            else:
                self._repo_and_revision_exists_cache[(repo_type, repo_id, revision)] = True, None
                self._repo_and_revision_exists_cache[(repo_type, repo_id, None)] = True, None
        return self._repo_and_revision_exists_cache[(repo_type, repo_id, revision)]

    def _bucket_exists(self, bucket_id: str) -> tuple[bool, Exception | None]:
        if bucket_id not in self._bucket_exists_cache:
            try:
                self._api.bucket_info(bucket_id)
            except BucketNotFoundError as e:
                self._bucket_exists_cache[bucket_id] = False, e
            else:
                self._bucket_exists_cache[bucket_id] = True, None
        return self._bucket_exists_cache[bucket_id]

    def resolve_path(
        self, path: str, revision: str | None = None
    ) -> HfFileSystemResolvedRepositoryPath | HfFileSystemResolvedBucketPath:
        """
        Resolve a Hugging Face file system path into its components.

        Args:
            path (`str`):
                Path to resolve.
            revision (`str`, *optional*):
                The revision of the repo to resolve. Defaults to the revision specified in the path.

        Returns:
            [`HfFileSystemResolvedPath`]: Resolved path information containing `repo_type`, `repo_id`, `revision` and `path_in_repo`.

        Raises:
            `ValueError`:
                If path contains conflicting revision information.
            `NotImplementedError`:
                If trying to list repositories.
        """
        path = self._strip_protocol(path)
        if not path:
            raise NotImplementedError("Access to buckets and repositories lists is not implemented.")
        if path.count("/") == 0:
            raise ValueError(
                f"Repository id must be 'namespace/name', got '{path}'. Single-segment ids (e.g. 'gpt2') are no longer supported."
            )

        parsed = parse_hf_uri(f"{constants.HF_PROTOCOL}{path}")

        # --- Buckets ---
        if parsed.is_bucket:
            bucket_exists, err = self._bucket_exists(parsed.id)
            if not bucket_exists:
                _raise_file_not_found(path, err)
            return HfFileSystemResolvedBucketPath(bucket_id=parsed.id, path=parsed.path_in_repo)

        # --- Repositories ---
        # Align revision from path with explicit revision argument
        if revision is not None and parsed.revision is not None and parsed.revision != revision:
            # The caller provided an explicit revision that conflicts with what parse_hf_uri
            # parsed. This can happen when a user has a branch literally named "refs" and a
            # file at "pr/10" — parse_hf_uri would greedily match "refs/pr/10" as a special
            # ref. Fall back to simple '@' splitting so the caller's revision wins.
            path_without_type = path.split("/", 1)[1] if path.split("/")[0] in constants.HF_URI_TYPE_PREFIXES else path
            repo_id, after_at = path_without_type.split("@", 1)
            revision_in_path, path_in_repo = after_at.split("/", 1) if "/" in after_at else (after_at, "")
            revision_in_path_decoded = unquote(revision_in_path)
            if revision_in_path_decoded != revision:
                raise ValueError(
                    f'Revision specified in path ("{revision_in_path_decoded}") and in `revision` argument ("{revision}") are not the same.'
                )
            repo_and_revision_exist, err = self._repo_and_revision_exist(parsed.type, repo_id, revision)
            if not repo_and_revision_exist:
                _raise_file_not_found(path, err)
            return HfFileSystemResolvedRepositoryPath(
                parsed.type, repo_id, revision, path_in_repo, _raw_revision=revision_in_path
            )

        if parsed.revision is not None and revision is None:
            revision = parsed.revision

        repo_and_revision_exist, err = self._repo_and_revision_exist(parsed.type, parsed.id, revision)
        if not repo_and_revision_exist:
            _raise_file_not_found(path, err)

        # Extract raw revision from original path for unresolve() fidelity
        raw_revision: str | None = None
        if "@" in path and parsed.revision is not None:
            path_without_type = path.split("/", 1)[1] if path.split("/")[0] in constants.HF_URI_TYPE_PREFIXES else path
            raw_after_at = path_without_type.split("@", 1)[1]
            raw_revision = raw_after_at[: -(len(parsed.path_in_repo) + 1)] if parsed.path_in_repo else raw_after_at

        revision = revision if revision is not None else constants.DEFAULT_REVISION
        return HfFileSystemResolvedRepositoryPath(
            parsed.type, parsed.id, revision, parsed.path_in_repo, _raw_revision=raw_revision
        )

    def invalidate_cache(self, path: str | None = None) -> None:
        """
        Clear the cache for a given path.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.invalidate_cache).

        Args:
            path (`str`, *optional*):
                Path to clear from cache. If not provided, clear the entire cache.

        """
        if not path:
            self.dircache.clear()
            self._repo_and_revision_exists_cache.clear()
        else:
            resolved_path = self.resolve_path(path)
            path = resolved_path.unresolve()
            while path:
                self.dircache.pop(path, None)
                path = self._parent(path)

            # Only clear repo cache if path is to repo root
            if not resolved_path.path:
                if isinstance(resolved_path, HfFileSystemResolvedRepositoryPath):
                    self._repo_and_revision_exists_cache.pop(
                        (resolved_path.repo_type, resolved_path.repo_id, None), None
                    )
                    self._repo_and_revision_exists_cache.pop(
                        (resolved_path.repo_type, resolved_path.repo_id, resolved_path.revision), None
                    )
                else:
                    self._bucket_exists_cache.pop(resolved_path.bucket_id, None)

    def _open(  # type: ignore
        self,
        path: str,
        mode: str = "rb",
        block_size: int | None = None,
        revision: str | None = None,
        **kwargs,
    ) -> Union["HfFileSystemFile", "HfFileSystemStreamFile"]:
        block_size = block_size if block_size is not None else self.block_size
        if block_size is not None:
            kwargs["block_size"] = block_size
        if "a" in mode:
            raise NotImplementedError("Appending to remote files is not yet supported.")
        if block_size == 0:
            return HfFileSystemStreamFile(self, path, mode=mode, revision=revision, **kwargs)
        else:
            return HfFileSystemFile(self, path, mode=mode, revision=revision, **kwargs)

    def _rm(self, path: str, revision: str | None = None, **kwargs) -> None:
        resolved_path = self.resolve_path(path, revision=revision)
        if isinstance(resolved_path, HfFileSystemResolvedBucketPath):
            self._api.batch_bucket_files(resolved_path.bucket_id, delete=[resolved_path.path])
        else:
            self._api.delete_file(
                path_in_repo=resolved_path.path_in_repo,
                repo_id=resolved_path.repo_id,
                token=self.token,
                repo_type=resolved_path.repo_type,
                revision=resolved_path.revision,
                commit_message=kwargs.get("commit_message"),
                commit_description=kwargs.get("commit_description"),
            )
        self.invalidate_cache(path=resolved_path.unresolve())

    def rm(
        self,
        path: str,
        recursive: bool = False,
        maxdepth: int | None = None,
        revision: str | None = None,
        **kwargs,
    ) -> None:
        """
        Delete files from a repository.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.rm).

        > [!WARNING]
        > Note: When possible, use `HfApi.delete_file()` for better performance.

        Args:
            path (`str`):
                Path to delete.
            recursive (`bool`, *optional*):
                If True, delete directory and all its contents. Defaults to False.
            maxdepth (`int`, *optional*):
                Maximum number of subdirectories to visit when deleting recursively.
            revision (`str`, *optional*):
                The git revision to delete from.

        """
        resolved_path = self.resolve_path(path, revision=revision)
        paths = self.expand_path(path, recursive=recursive, maxdepth=maxdepth, revision=revision)
        if isinstance(resolved_path, HfFileSystemResolvedBucketPath):
            delete = [self.resolve_path(path).path for path in paths if not self.isdir(path)]
            self._api.batch_bucket_files(resolved_path.bucket_id, delete=delete)
        else:
            paths_in_repo = [self.resolve_path(path).path for path in paths if not self.isdir(path)]
            operations = [CommitOperationDelete(path_in_repo=path_in_repo) for path_in_repo in paths_in_repo]
            commit_message = f"Delete {path} "
            commit_message += "recursively " if recursive else ""
            commit_message += f"up to depth {maxdepth} " if maxdepth is not None else ""
            # TODO: use `commit_description` to list all the deleted paths?
            self._api.create_commit(
                repo_id=resolved_path.repo_id,
                repo_type=resolved_path.repo_type,
                token=self.token,
                operations=operations,
                revision=resolved_path.revision,
                commit_message=kwargs.get("commit_message", commit_message),
                commit_description=kwargs.get("commit_description"),
            )
        self.invalidate_cache(path=resolved_path.unresolve())

    def ls(
        self, path: str, detail: bool = True, refresh: bool = False, revision: str | None = None, **kwargs
    ) -> list[str | dict[str, Any]]:
        """
        List the contents of a directory.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.ls).

        > [!WARNING]
        > Note: When possible, use `HfApi.list_repo_tree()` for better performance.

        Args:
            path (`str`):
                Path to the directory.
            detail (`bool`, *optional*):
                If True, returns a list of dictionaries containing file information. If False,
                returns a list of file paths. Defaults to True.
            refresh (`bool`, *optional*):
                If True, bypass the cache and fetch the latest data. Defaults to False.
            revision (`str`, *optional*):
                The git revision to list from.

        Returns:
            `list[Union[str, dict[str, Any]]]`: List of file paths (if detail=False) or list of file information
            dictionaries (if detail=True).
        """
        resolved_path = self.resolve_path(path, revision=revision)
        path = resolved_path.unresolve()
        try:
            out = self._ls_tree(path, refresh=refresh, revision=revision, **kwargs)
        except EntryNotFoundError:
            # Path could be a file
            if not resolved_path.path:
                _raise_file_not_found(path, None)
            try:
                out = self._ls_tree(self._parent(path), refresh=refresh, revision=revision, **kwargs)
            except EntryNotFoundError:
                out = []
            out = [o for o in out if o["name"] == path]
            if len(out) == 0:
                _raise_file_not_found(path, None)
        return out if detail else [o["name"] for o in out]

    def _ls_tree(
        self,
        path: str,
        recursive: bool = False,
        refresh: bool = False,
        revision: str | None = None,
        expand_info: bool | None = None,
        maxdepth: int | None = None,
    ):
        expand_info = (
            expand_info if expand_info is not None else (self.expand_info if self.expand_info is not None else False)
        )
        resolved_path = self.resolve_path(path, revision=revision)
        path = resolved_path.unresolve()
        root_path = resolved_path.root
        maxdepth = maxdepth if recursive else 1

        out = []
        if path in self.dircache and not refresh:
            cached_path_infos = self.dircache[path]
            out.extend(cached_path_infos)
            dirs_not_in_dircache = []
            if recursive:
                # Use BFS to traverse the cache and build the "recursive "output
                # (The Hub uses a so-called "tree first" strategy for the tree endpoint but we sort the output to follow the spec so the result is (eventually) the same)
                depth = 2
                dirs_to_visit = deque(
                    [(depth, path_info) for path_info in cached_path_infos if path_info["type"] == "directory"]
                )
                while dirs_to_visit:
                    depth, dir_info = dirs_to_visit.popleft()
                    if maxdepth is None or depth <= maxdepth:
                        if dir_info["name"] not in self.dircache:
                            dirs_not_in_dircache.append(dir_info["name"])
                        else:
                            cached_path_infos = self.dircache[dir_info["name"]]
                            out.extend(cached_path_infos)
                            dirs_to_visit.extend(
                                [
                                    (depth + 1, path_info)
                                    for path_info in cached_path_infos
                                    if path_info["type"] == "directory"
                                ]
                            )

            dirs_not_expanded = []
            if expand_info and isinstance(resolved_path, HfFileSystemResolvedRepositoryPath):
                # Check if there are directories in repos with non-expanded entries
                dirs_not_expanded = [self._parent(o["name"]) for o in out if o["last_commit"] is None]

            if (recursive and dirs_not_in_dircache) or (expand_info and dirs_not_expanded):
                # If the dircache is incomplete, find the common path of the missing and non-expanded entries
                # and extend the output with the result of `_ls_tree(common_path, recursive=True)`
                common_prefix = os.path.commonprefix(dirs_not_in_dircache + dirs_not_expanded)
                # Get the parent directory if the common prefix itself is not a directory
                common_path = (
                    common_prefix.rstrip("/")
                    if common_prefix.endswith("/")
                    or common_prefix == root_path
                    or common_prefix in chain(dirs_not_in_dircache, dirs_not_expanded)
                    else self._parent(common_prefix)
                )
                if maxdepth is not None:
                    common_path_depth = common_path[len(path) :].count("/")
                    maxdepth -= common_path_depth
                out = [o for o in out if not o["name"].startswith(common_path + "/")]
                for cached_path in list(self.dircache):
                    if cached_path.startswith(common_path + "/"):
                        self.dircache.pop(cached_path, None)
                self.dircache.pop(common_path, None)
                out.extend(
                    self._ls_tree(
                        common_path,
                        recursive=recursive,
                        refresh=True,
                        revision=revision,
                        expand_info=expand_info,
                        maxdepth=maxdepth,
                    )
                )
        else:
            tree: Iterable[RepoFile | RepoFolder | BucketFile | BucketFolder]
            if isinstance(resolved_path, HfFileSystemResolvedBucketPath):
                tree = self._list_bucket_tree_with_folders(
                    resolved_path.bucket_id,
                    prefix=resolved_path.path,
                    recursive=recursive,
                )
            else:
                tree = self._api.list_repo_tree(
                    resolved_path.repo_id,
                    resolved_path.path,
                    recursive=recursive,
                    expand=expand_info,
                    revision=resolved_path.revision,
                    repo_type=resolved_path.repo_type,
                )
            for path_info in tree:
                cache_path = root_path + "/" + path_info.path
                if isinstance(path_info, RepoFile):
                    cache_path_info = {
                        "name": cache_path,
                        "size": path_info.size,
                        "type": "file",
                        "blob_id": path_info.blob_id,
                        "lfs": path_info.lfs,
                        "xet_hash": path_info.xet_hash,
                        "last_commit": path_info.last_commit,
                        "security": path_info.security,
                    }
                elif isinstance(path_info, BucketFile):
                    cache_path_info = {
                        "name": cache_path,
                        "size": path_info.size,
                        "type": "file",
                        "xet_hash": path_info.xet_hash,
                        "mtime": path_info.mtime,
                        "uploaded_at": path_info.uploaded_at,
                    }
                elif isinstance(path_info, RepoFolder):
                    cache_path_info = {
                        "name": cache_path,
                        "size": 0,
                        "type": "directory",
                        "tree_id": path_info.tree_id,
                        "last_commit": path_info.last_commit,
                    }
                else:
                    cache_path_info = {
                        "name": cache_path,
                        "size": 0,
                        "type": "directory",
                        "uploaded_at": path_info.uploaded_at,
                    }
                parent_path = self._parent(cache_path_info["name"])
                self.dircache.setdefault(parent_path, []).append(cache_path_info)
                depth = cache_path[len(path) :].count("/")
                if maxdepth is None or depth <= maxdepth:
                    out.append(cache_path_info)
        return out

    def _list_bucket_tree_with_folders(
        self, bucket_id: str, prefix: str, recursive: bool
    ) -> Iterable[BucketFile | BucketFolder]:
        """Same as `HfApi.list_bucket_tree` but always includes folders"""
        bucket_files = self._api.list_bucket_tree(bucket_id, prefix, recursive=recursive)
        bucket_folders: dict[str, BucketFolder] = {}
        min_depth = 1 + prefix.count("/") if prefix else 0
        out: list[BucketFile | BucketFolder] = []

        for bucket_entry in bucket_files:
            out.append(bucket_entry)

            # If recursive=False, both files and folders are returned by the server => nothing to do
            if not recursive:
                continue

            # Otherwise, let's rebuild BucketFolders manually
            for parent_bucket_folder_str in list(PurePosixPath(bucket_entry.path).parents)[: -min_depth - 1]:
                parent_bucket_folder = BucketFolder(
                    type="directory", path=str(parent_bucket_folder_str), uploaded_at=bucket_entry.uploaded_at
                )

                # If folder not visited yet, add it
                if parent_bucket_folder.path not in bucket_folders:
                    out.append(parent_bucket_folder)
                    bucket_folders[parent_bucket_folder.path] = parent_bucket_folder
                    continue

                # Otherwise, get back BucketFolder object and update its 'uploaded_at'
                if parent_bucket_folder.uploaded_at is not None:
                    bucket_folder = bucket_folders[parent_bucket_folder.path]
                    if bucket_folder.uploaded_at is None or (
                        bucket_folder.uploaded_at < parent_bucket_folder.uploaded_at
                    ):
                        bucket_folder.uploaded_at = parent_bucket_folder.uploaded_at

        if not out:
            raise EntryNotFoundError(f"File not found in bucket '{bucket_id}': '{prefix}'")
        return out

    def walk(self, path: str, *args, **kwargs) -> Iterator[tuple[str, list[str], list[str]]]:
        """
        Return all files below the given path.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.walk).

        Args:
            path (`str`):
                Root path to list files from.

        Returns:
            `Iterator[tuple[str, list[str], list[str]]]`: An iterator of (path, list of directory names, list of file names) tuples.
        """
        path = self.resolve_path(path, revision=kwargs.get("revision")).unresolve()
        yield from super().walk(path, *args, **kwargs)

    def glob(self, path: str, maxdepth: int | None = None, **kwargs) -> list[str]:
        """
        Find files by glob-matching.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.glob).

        Args:
            path (`str`):
                Path pattern to match.
            maxdepth (`int`, *optional*):
                Maximum depth to descend into directories. By default, no limit.

        Returns:
            `list[str]`: List of paths matching the pattern.
        """
        path = self.resolve_path(path, revision=kwargs.get("revision")).unresolve()
        return super().glob(path, maxdepth=maxdepth, **kwargs)

    def find(
        self,
        path: str,
        maxdepth: int | None = None,
        withdirs: bool = False,
        detail: bool = False,
        refresh: bool = False,
        revision: str | None = None,
        **kwargs,
    ) -> list[str] | dict[str, dict[str, Any]]:
        """
        List all files below path.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.find).

        Args:
            path (`str`):
                Root path to list files from.
            maxdepth (`int`, *optional*):
                Maximum depth to descend into subdirectories.
            withdirs (`bool`, *optional*):
                Include directory paths in the output. Defaults to False.
            detail (`bool`, *optional*):
                If True, returns a dict mapping paths to file information. Defaults to False.
            refresh (`bool`, *optional*):
                If True, bypass the cache and fetch the latest data. Defaults to False.
            revision (`str`, *optional*):
                The git revision to list from.

        Returns:
            `Union[list[str], dict[str, dict[str, Any]]]`: List of paths or dict of file information.
        """
        if maxdepth is not None and maxdepth < 1:
            raise ValueError("maxdepth must be at least 1")
        resolved_path = self.resolve_path(path, revision=revision)
        path = resolved_path.unresolve()
        try:
            out = self._ls_tree(path, recursive=True, refresh=refresh, maxdepth=maxdepth, **kwargs)
        except EntryNotFoundError:
            # Path could be a file
            try:
                if self.info(path, revision=revision, **kwargs)["type"] == "file":
                    out = {path: {}}
                else:
                    out = {}
            except FileNotFoundError:
                out = {}
        else:
            if not withdirs:
                out = [o for o in out if o["type"] != "directory"]
            else:
                # If `withdirs=True`, include the directory itself to be consistent with the spec
                path_info = self.info(path, **kwargs)
                out = [path_info] + out if path_info["type"] == "directory" else out
            out = {o["name"]: o for o in out}
        names = sorted(out)
        if not detail:
            return names
        else:
            return {name: out[name] for name in names}

    def cp_file(self, path1: str, path2: str, revision: str | None = None, **kwargs) -> None:
        """
        Copy a file within or between repositories.

        > [!WARNING]
        > Note: When possible, use `HfApi.upload_file()` for better performance.

        Args:
            path1 (`str`):
                Source path to copy from.
            path2 (`str`):
                Destination path to copy to.
            revision (`str`, *optional*):
                The git revision to copy from.

        """
        resolved_path1 = self.resolve_path(path1, revision=revision)
        resolved_path2 = self.resolve_path(path2, revision=revision)
        if isinstance(resolved_path1, HfFileSystemResolvedBucketPath) or isinstance(
            resolved_path2, HfFileSystemResolvedBucketPath
        ):
            raise NotImplementedError("Copy from/to buckets is not available yet")

        same_repo = (
            resolved_path1.repo_type == resolved_path2.repo_type and resolved_path1.repo_id == resolved_path2.repo_id
        )

        if same_repo:
            commit_message = f"Copy {path1} to {path2}"
            self._api.create_commit(
                repo_id=resolved_path1.repo_id,
                repo_type=resolved_path1.repo_type,
                revision=resolved_path2.revision,
                commit_message=kwargs.get("commit_message", commit_message),
                commit_description=kwargs.get("commit_description", ""),
                operations=[
                    CommitOperationCopy(
                        src_path_in_repo=resolved_path1.path_in_repo,
                        path_in_repo=resolved_path2.path_in_repo,
                        src_revision=resolved_path1.revision,
                    )
                ],
            )
        else:
            with self.open(path1, "rb", revision=resolved_path1.revision) as f:
                content = f.read()
            commit_message = f"Copy {path1} to {path2}"
            self._api.upload_file(
                path_or_fileobj=content,
                path_in_repo=resolved_path2.path_in_repo,
                repo_id=resolved_path2.repo_id,
                token=self.token,
                repo_type=resolved_path2.repo_type,
                revision=resolved_path2.revision,
                commit_message=kwargs.get("commit_message", commit_message),
                commit_description=kwargs.get("commit_description"),
            )
        self.invalidate_cache(path=resolved_path1.unresolve())
        self.invalidate_cache(path=resolved_path2.unresolve())

    def modified(self, path: str, **kwargs) -> datetime:
        """
        Get the last modified time of a file.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.modified).

        Args:
            path (`str`):
                Path to the file.

        Returns:
            `datetime`: Last modified time of the file.
        """
        info = self.info(path, **{**kwargs, "expand_info": True})  # type: ignore
        if "last_commit" in info:
            if info["last_commit"] is None:
                raise NotImplementedError(f"'modified' is not implemented for repository paths like '{path}'")
            return info["last_commit"].date
        elif "mtime" in info and info["mtime"]:
            return info["mtime"]
        elif "uploaded_at" in info and info["uploaded_at"]:
            return info["uploaded_at"]
        else:
            raise NotImplementedError(f"Cannot determined 'modified' for path '{path}' (info: {info})")

    def info(self, path: str, refresh: bool = False, revision: str | None = None, **kwargs) -> dict[str, Any]:
        """
        Get information about a file or directory.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.info).

        > [!WARNING]
        > Note: When possible, use `HfApi.get_paths_info()` or `HfApi.repo_info()`  for better performance
        > (or `HfApi.get_bucket_paths_info()` or `HfApi.bucket_info()` for buckets)

        Args:
            path (`str`):
                Path to get info for.
            refresh (`bool`, *optional*):
                If True, bypass the cache and fetch the latest data. Defaults to False.
            revision (`str`, *optional*):
                The git revision to get info from.

        Returns:
            `dict[str, Any]`: Dictionary containing file information (type, size, commit info, etc.).

        """
        resolved_path = self.resolve_path(path, revision=revision)
        path = resolved_path.unresolve()
        expand_info = kwargs.get(
            "expand_info", self.expand_info if self.expand_info is not None else False
        )  # don't expose it as a parameter in the public API to follow the spec
        out: dict[str, Any] | None
        if not resolved_path.path:
            # Path is the root directory
            out = {
                "name": path,
                "size": 0,
                "type": "directory",
            }
            if isinstance(resolved_path, HfFileSystemResolvedRepositoryPath):
                out["last_commit"] = None
            if isinstance(resolved_path, HfFileSystemResolvedRepositoryPath) and expand_info:
                last_commit = self._api.list_repo_commits(
                    resolved_path.repo_id, repo_type=resolved_path.repo_type, revision=resolved_path.revision
                )[-1]
                out = {
                    **out,
                    "tree_id": None,  # TODO: tree_id of the root directory?
                    "last_commit": LastCommitInfo(
                        oid=last_commit.commit_id, title=last_commit.title, date=last_commit.created_at
                    ),
                }
        elif isinstance(resolved_path, HfFileSystemResolvedBucketPath):
            parent_path = self._parent(path)
            # Fill the cache with cheap call
            self.ls(parent_path, refresh=refresh)
            out1 = [o for o in self.dircache[parent_path] if o["name"] == path]
            if not out1:
                _raise_file_not_found(path, None)
            out = out1[0]
        else:
            out = None
            parent_path = self._parent(path)
            if not expand_info and parent_path not in self.dircache:
                # Fill the cache with cheap call
                self.ls(parent_path)
            if parent_path in self.dircache:
                # Check if the path is in the cache
                out1 = [o for o in self.dircache[parent_path] if o["name"] == path]
                if not out1:
                    _raise_file_not_found(path, None)
                out = out1[0]
            if refresh or out is None or (expand_info and out and out["last_commit"] is None):
                paths_info = self._api.get_paths_info(
                    resolved_path.repo_id,
                    resolved_path.path_in_repo,
                    expand=expand_info,
                    revision=resolved_path.revision,
                    repo_type=resolved_path.repo_type,
                )
                if not paths_info:
                    _raise_file_not_found(path, None)
                path_info = paths_info[0]
                root_path = HfFileSystemResolvedRepositoryPath(
                    resolved_path.repo_type,
                    resolved_path.repo_id,
                    resolved_path.revision,
                    path_in_repo="",
                    _raw_revision=resolved_path._raw_revision,
                ).unresolve()
                if isinstance(path_info, RepoFile):
                    out = {
                        "name": root_path + "/" + path_info.path,
                        "size": path_info.size,
                        "type": "file",
                        "blob_id": path_info.blob_id,
                        "lfs": path_info.lfs,
                        "xet_hash": path_info.xet_hash,
                        "last_commit": path_info.last_commit,
                        "security": path_info.security,
                    }
                else:
                    out = {
                        "name": root_path + "/" + path_info.path,
                        "size": 0,
                        "type": "directory",
                        "tree_id": path_info.tree_id,
                        "last_commit": path_info.last_commit,
                    }
                if not expand_info:
                    out = {k: out[k] for k in ["name", "size", "type"]}
        assert out is not None
        return out

    def exists(self, path, **kwargs):
        """
        Check if a file exists.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.exists).

        > [!WARNING]
        > Note: When possible, use `HfApi.file_exists()` for better performance.

        Args:
            path (`str`):
                Path to check.

        Returns:
            `bool`: True if file exists, False otherwise.
        """
        try:
            if kwargs.get("refresh", False):
                self.invalidate_cache(path)

            self.info(path, **kwargs)
            return True
        except OSError:
            return False

    def isdir(self, path):
        """
        Check if a path is a directory.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.isdir).

        Args:
            path (`str`):
                Path to check.

        Returns:
            `bool`: True if path is a directory, False otherwise.
        """
        try:
            return self.info(path)["type"] == "directory"
        except OSError:
            return False

    def isfile(self, path):
        """
        Check if a path is a file.

        For more details, refer to [fsspec documentation](https://filesystem-spec.readthedocs.io/en/latest/api.html#fsspec.spec.AbstractFileSystem.isfile).

        Args:
            path (`str`):
                Path to check.

        Returns:
            `bool`: True if path is a file, False otherwise.
        """
        try:
            return self.info(path)["type"] == "file"
        except OSError:
            return False

    def url(self, path: str) -> str:
        """
        Get the HTTP URL of the given path.

        Args:
            path (`str`):
                Path to get URL for.

        Returns:
            `str`: HTTP URL to access the file or directory on the Hub.
        """
        resolved_path = self.resolve_path(path)
        if isinstance(resolved_path, HfFileSystemResolvedBucketPath):
            url = f"{self.endpoint}/buckets/{resolved_path.bucket_id}/resolve/{quote(resolved_path.path)}"
        else:
            url = hf_hub_url(
                resolved_path.repo_id,
                resolved_path.path_in_repo,
                repo_type=resolved_path.repo_type,
                revision=resolved_path.revision,
                endpoint=self.endpoint,
            )
        if self.isdir(path):
            url = url.replace("/resolve/", "/tree/", 1)
        return url

    def get_file(self, rpath, lpath, callback=_DEFAULT_CALLBACK, outfile=None, **kwargs) -> None:
        """
        Copy single remote file to local.

        > [!WARNING]
        > Note: When possible, use `HfApi.hf_hub_download()` or `HfApi.download_bucket_files` for better performance.

        Args:
            rpath (`str`):
                Remote path to download from.
            lpath (`str`):
                Local path to download to.
            callback (`Callback`, *optional*):
                Optional callback to track download progress. Defaults to no callback.
            outfile (`IO`, *optional*):
                Optional file-like object to write to. If provided, `lpath` is ignored.

        """
        revision = kwargs.get("revision")
        unhandled_kwargs = set(kwargs.keys()) - {"revision"}
        if not isinstance(callback, (NoOpCallback, TqdmCallback)) or len(unhandled_kwargs) > 0:
            # for now, let's not handle custom callbacks
            # and let's not handle custom kwargs
            return super().get_file(rpath, lpath, callback=callback, outfile=outfile, **kwargs)

        # Taken from https://github.com/fsspec/filesystem_spec/blob/47b445ae4c284a82dd15e0287b1ffc410e8fc470/fsspec/spec.py#L883
        if isfilelike(lpath):
            outfile = lpath
        elif self.isdir(rpath):
            os.makedirs(lpath, exist_ok=True)
            return None

        if isinstance(lpath, (str, Path)):  # otherwise, let's assume it's a file-like object
            os.makedirs(os.path.dirname(lpath), exist_ok=True)

        # Open file if not already open
        close_file = False
        if outfile is None:
            outfile = open(lpath, "wb")
            close_file = True
        initial_pos = outfile.tell()

        # Custom implementation of `get_file` to use `http_get`.
        resolve_remote_path = self.resolve_path(rpath, revision=revision)
        expected_size = self.info(rpath, revision=revision)["size"]
        callback.set_size(expected_size)
        try:
            http_get(
                url=self.url(resolve_remote_path.unresolve()),
                temp_file=outfile,  # type: ignore
                displayed_filename=rpath,
                expected_size=expected_size,
                resume_size=0,
                headers=self._api._build_hf_headers(),
                _tqdm_bar=callback.tqdm if isinstance(callback, TqdmCallback) else None,
            )
            outfile.seek(initial_pos)
        finally:
            # Close file only if we opened it ourselves
            if close_file:
                outfile.close()

    @property
    def transaction(self):
        """A context within which files are committed together upon exit

        Requires the file class to implement `.commit()` and `.discard()`
        for the normal and exception cases.
        """
        # Taken from https://github.com/fsspec/filesystem_spec/blob/3fbb6fee33b46cccb015607630843dea049d3243/fsspec/spec.py#L231
        # See https://github.com/huggingface/huggingface_hub/issues/1733
        raise NotImplementedError("Transactional commits are not supported.")

    def start_transaction(self):
        """Begin write transaction for deferring files, non-context version"""
        # Taken from https://github.com/fsspec/filesystem_spec/blob/3fbb6fee33b46cccb015607630843dea049d3243/fsspec/spec.py#L241
        # See https://github.com/huggingface/huggingface_hub/issues/1733
        raise NotImplementedError("Transactional commits are not supported.")

    def __reduce__(self):
        # re-populate the instance cache at HfFileSystem._cache and re-populate the state of every instance
        return make_instance, (
            type(self),
            self.storage_args,
            self.storage_options,
            self._get_instance_state(),
        )

    def _get_instance_state(self):
        return {
            "dircache": deepcopy(self.dircache),
            "_repo_and_revision_exists_cache": deepcopy(self._repo_and_revision_exists_cache),
            "_bucket_exists_cache": deepcopy(self._bucket_exists_cache),
        }


class HfFileSystemFile(fsspec.spec.AbstractBufferedFile):
    def __init__(self, fs: HfFileSystem, path: str, revision: str | None = None, **kwargs):
        try:
            self.resolved_path = fs.resolve_path(path, revision=revision)
        except FileNotFoundError as e:
            if "w" in kwargs.get("mode", ""):
                raise FileNotFoundError(
                    f"{e}.\nMake sure the repository and revision exist before writing data."
                ) from e
            raise
        super().__init__(fs, self.resolved_path.unresolve(), **kwargs)
        self.fs: HfFileSystem

    def __del__(self):
        if not hasattr(self, "resolved_path"):
            # Means that the constructor failed. Nothing to do.
            return
        return super().__del__()

    def _fetch_range(self, start: int, end: int) -> bytes:
        headers = {
            "range": f"bytes={start}-{end - 1}",
            **self.fs._api._build_hf_headers(),
        }
        url = self.url()
        r = http_backoff("GET", url, headers=headers, timeout=constants.HF_HUB_DOWNLOAD_TIMEOUT)
        hf_raise_for_status(r)
        return r.content

    def _initiate_upload(self) -> None:
        self.temp_file = tempfile.NamedTemporaryFile(prefix="hffs-", delete=False)

    def _upload_chunk(self, final: bool = False) -> None:
        self.buffer.seek(0)
        block = self.buffer.read()
        self.temp_file.write(block)
        if final:
            self.temp_file.close()
            if isinstance(self.resolved_path, HfFileSystemResolvedBucketPath):
                self.fs._api.batch_bucket_files(
                    self.resolved_path.bucket_id, add=[(self.temp_file.name, self.resolved_path.path)]
                )
            else:
                self.fs._api.upload_file(
                    path_or_fileobj=self.temp_file.name,
                    path_in_repo=self.resolved_path.path_in_repo,
                    repo_id=self.resolved_path.repo_id,
                    token=self.fs.token,
                    repo_type=self.resolved_path.repo_type,
                    revision=self.resolved_path.revision,
                    commit_message=self.kwargs.get("commit_message"),
                    commit_description=self.kwargs.get("commit_description"),
                )
            os.remove(self.temp_file.name)
            self.fs.invalidate_cache(
                path=self.resolved_path.unresolve(),
            )

    def read(self, length=-1):
        """Read remote file.

        If `length` is not provided or is -1, the entire file is downloaded and read. On POSIX systems the file is
        loaded in memory directly. Otherwise, the file is downloaded to a temporary file and read from there.
        """
        if self.mode == "rb" and (length is None or length == -1) and self.loc == 0:
            with self.fs.open(self.path, "rb", block_size=0) as f:  # block_size=0 enables fast streaming
                out = f.read()
                self.loc += len(out)
                return out
        return super().read(length)

    def url(self) -> str:
        return self.fs.url(self.path)


class HfFileSystemStreamFile(fsspec.spec.AbstractBufferedFile):
    def __init__(
        self,
        fs: HfFileSystem,
        path: str,
        mode: str = "rb",
        revision: str | None = None,
        block_size: int = 0,
        cache_type: str = "none",
        **kwargs,
    ):
        if block_size != 0:
            raise ValueError(f"HfFileSystemStreamFile only supports block_size=0 but got {block_size}")
        if cache_type != "none":
            raise ValueError(f"HfFileSystemStreamFile only supports cache_type='none' but got {cache_type}")
        if "w" in mode:
            raise ValueError(f"HfFileSystemStreamFile only supports reading but got mode='{mode}'")
        # Let a missing repo/revision/file surface as FileNotFoundError (as the buffered
        # `HfFileSystemFile` does) instead of an AttributeError on `self.resolved_path` below.
        self.resolved_path = fs.resolve_path(path, revision=revision)
        # avoid an unnecessary .info() call to instantiate .details
        self.details = {"name": self.resolved_path.unresolve(), "size": None}
        super().__init__(
            fs, self.resolved_path.unresolve(), mode=mode, block_size=block_size, cache_type=cache_type, **kwargs
        )
        self.response: httpx.Response | None = None
        self.fs: HfFileSystem
        self._exit_stack = ExitStack()
        # streaming state
        self._stream_iterator: Iterator[bytes] | None = None
        self._stream_buffer = bytearray()

    def seek(self, loc: int, whence: int = 0):
        if loc == 0 and whence == 1:
            return
        if loc == self.loc and whence == 0:
            return
        raise ValueError("Cannot seek streaming HF file")

    def read(self, length: int = -1):
        """Read the remote file.

        If the file is already open, we reuse the connection.
        Otherwise, open a new connection and read from it.

        If reading the stream fails, we retry with a new connection.
        """
        if self.response is None:
            self._open_connection()

        retried_once = False
        while True:
            try:
                if self.response is None or self._stream_iterator is None:
                    return b""  # Already read the entire file
                out = self._read_from_stream(self._stream_iterator, length)
                self.loc += len(out)
                return out
            except Exception:
                if self.response is not None:
                    self.response.close()
                if retried_once:  # Already retried once, give up
                    raise
                # First failure, retry with range header
                self._open_connection()
                retried_once = True

    def _read_from_stream(self, iterator: Iterator[bytes], length: int = -1) -> bytes:
        """Read up to `length` bytes from stream buffer and stream.

        If length < 0, read until EOF.

        If EOF is reached before length, fewer bytes may be returned.
        """
        if length == 0:
            return b""

        if length < 0:
            buf = bytearray(self._stream_buffer)
            self._stream_buffer.clear()
            for chunk in iterator:
                buf.extend(chunk)
            return bytes(buf)

        if length <= len(self._stream_buffer):
            result = bytes(self._stream_buffer[:length])
            del self._stream_buffer[:length]
            return result

        buf = bytearray(self._stream_buffer)
        self._stream_buffer.clear()
        for chunk in iterator:
            need = length - len(buf)
            if need > len(chunk):
                buf.extend(chunk)
            else:
                buf.extend(chunk[:need])
                self._stream_buffer.extend(chunk[need:])
                break
        return bytes(buf)

    def url(self) -> str:
        return self.fs.url(self.path)

    def __del__(self):
        if not hasattr(self, "resolved_path"):
            # Means that the constructor failed. Nothing to do.
            return
        self._exit_stack.close()
        return super().__del__()

    def __reduce__(self):
        return reopen, (self.fs, self.path, self.mode, self.blocksize, self.cache.name)

    def _open_connection(self):
        """Open a connection to the remote file."""
        # reset streaming state
        self._stream_buffer.clear()
        self._stream_iterator = None

        url = self.url()
        headers = self.fs._api._build_hf_headers()
        if self.loc > 0:
            headers["Range"] = f"bytes={self.loc}-"
        self.response = self._exit_stack.enter_context(
            http_stream_backoff(
                "GET",
                url,
                headers=headers,
                timeout=constants.HF_HUB_DOWNLOAD_TIMEOUT,
            )
        )

        try:
            hf_raise_for_status(self.response)
        except HfHubHTTPError as e:
            if e.response.status_code == 416:
                # Range not satisfiable => means that we have already read the entire file
                self.response = None
                return
            raise

        self._stream_iterator = self.response.iter_bytes()


def safe_revision(revision: str) -> str:
    return revision if SPECIAL_REFS_REVISION_REGEX.match(revision) else safe_quote(revision)


def safe_quote(s: str) -> str:
    return quote(s, safe="")


def _raise_file_not_found(path: str, err: Exception | None) -> NoReturn:
    msg = path
    if isinstance(err, RepositoryNotFoundError):
        msg = f"{path} (repository not found)"
    elif isinstance(err, RevisionNotFoundError):
        msg = f"{path} (revision not found)"
    elif isinstance(err, HFValidationError):
        msg = f"{path} (invalid repository id)"
    raise FileNotFoundError(msg) from err


def reopen(fs: HfFileSystem, path: str, mode: str, block_size: int, cache_type: str):
    return fs.open(path, mode=mode, block_size=block_size, cache_type=cache_type)


def make_instance(cls, args, kwargs, instance_state):
    fs = cls(*args, **kwargs)
    for attr, state_value in instance_state.items():
        setattr(fs, attr, state_value)
    return fs


hffs = HfFileSystem()
