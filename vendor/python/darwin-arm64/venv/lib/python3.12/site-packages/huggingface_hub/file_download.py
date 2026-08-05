import copy
import errno
import os
import re
import shutil
import stat
import time
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Literal, NoReturn, overload
from urllib.parse import quote, urlparse

import httpx
from tqdm.auto import tqdm as base_tqdm

from . import constants
from ._local_folder import (
    _create_cachedir_tag,
    _validate_relative_filename,
    get_local_download_paths,
    read_download_metadata,
    write_download_metadata,
)
from ._revision import ResolvedRevision
from ._tree_cache import read_tree_cache, tree_cache_folder_for_local_dir
from .errors import (
    FileMetadataError,
    GatedRepoError,
    HfHubHTTPError,
    LocalEntryNotFoundError,
    RemoteEntryNotFoundError,
    RepositoryNotFoundError,
    RevisionNotFoundError,
)
from .utils import (
    OfflineModeIsEnabled,
    SoftTemporaryDirectory,
    WeakFileLock,
    XetFileData,
    build_hf_headers,
    hf_raise_for_status,
    logging,
    parse_xet_file_data_from_response,
    tqdm,
    validate_hf_hub_args,
)
from .utils._http import (
    _DEFAULT_RETRY_ON_EXCEPTIONS,
    _DEFAULT_RETRY_ON_STATUS_CODES,
    _adjust_range_header,
    _httpx_follow_relative_redirects_with_backoff,
    http_stream_backoff,
)
from .utils._runtime import is_xet_available
from .utils._xet import XetTokenType, is_valid_xet_hash, xet_connection_info_refresh_url
from .utils.sha import sha_fileobj
from .utils.tqdm import _get_progress_bar_context


logger = logging.get_logger(__name__)

# Return value when trying to load a file from cache but the file does not exist in the distant repo.
_CACHED_NO_EXIST = object()
_CACHED_NO_EXIST_T = Any

# Regex to get filename from a "Content-Disposition" header for CDN-served files
HEADER_FILENAME_PATTERN = re.compile(r'filename="(?P<filename>.*?)";')

# Regex to check if the revision IS directly a commit_hash
REGEX_COMMIT_HASH = re.compile(r"^[0-9a-f]{40}$")

# Regex to check if the file etag IS a valid sha256
REGEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")

_are_symlinks_supported_in_dir: dict[str, bool] = {}

# Internal retry timeout for metadata fetch when no local file exists
_ETAG_RETRY_TIMEOUT = 60


def are_symlinks_supported(cache_dir: str | Path | None = None) -> bool:
    """Return whether the symlinks are supported on the machine.

    Since symlinks support can change depending on the mounted disk, we need to check
    on the precise cache folder. By default, the default HF cache directory is checked.

    Args:
        cache_dir (`str`, `Path`, *optional*):
            Path to the folder where cached files are stored.

    Returns: [bool] Whether symlinks are supported in the directory.
    """
    # Defaults to HF cache
    if cache_dir is None:
        cache_dir = constants.HF_HUB_CACHE
    cache_dir = str(Path(cache_dir).expanduser().resolve())  # make it unique

    # If symlinks are explicitly disabled by the user, always return False
    if constants.HF_HUB_DISABLE_SYMLINKS:
        return False

    # Check symlink compatibility only once (per cache directory) at first time use
    if cache_dir not in _are_symlinks_supported_in_dir:
        _are_symlinks_supported_in_dir[cache_dir] = True

        os.makedirs(cache_dir, exist_ok=True)
        with SoftTemporaryDirectory(dir=cache_dir) as tmpdir:
            src_path = Path(tmpdir) / "dummy_file_src"
            src_path.touch()
            dst_path = Path(tmpdir) / "dummy_file_dst"

            # Relative source path as in `_create_symlink``
            relative_src = os.path.relpath(src_path, start=os.path.dirname(dst_path))
            try:
                os.symlink(relative_src, dst_path)
            except OSError:
                # Likely running on Windows
                _are_symlinks_supported_in_dir[cache_dir] = False

                if not constants.HF_HUB_DISABLE_SYMLINKS_WARNING:
                    message = (
                        "`huggingface_hub` cache-system uses symlinks by default to"
                        " efficiently store duplicated files but your machine does not"
                        f" support them in {cache_dir}. Caching files will still work"
                        " but in a degraded version that might require more space on"
                        " your disk. This warning can be disabled by setting the"
                        " `HF_HUB_DISABLE_SYMLINKS_WARNING` environment variable. For"
                        " more details, see"
                        " https://huggingface.co/docs/huggingface_hub/how-to-cache#limitations."
                    )
                    if os.name == "nt":
                        message += (
                            "\nTo support symlinks on Windows, you either need to"
                            " activate Developer Mode or to run Python as an"
                            " administrator. In order to activate developer mode,"
                            " see this article:"
                            " https://docs.microsoft.com/en-us/windows/apps/get-started/enable-your-device-for-development"
                        )
                    warnings.warn(message)

    return _are_symlinks_supported_in_dir[cache_dir]


@dataclass(frozen=True)
class HfFileMetadata:
    """Data structure containing information about a file versioned on the Hub.

    Returned by [`get_hf_file_metadata`] based on a URL.

    Args:
        commit_hash (`str`, *optional*):
            The commit_hash related to the file.
        etag (`str`, *optional*):
            Etag of the file on the server.
        location (`str`):
            Location where to download the file. Can be a Hub url or not (CDN).
        size (`size`):
            Size of the file. In case of an LFS file, contains the size of the actual
            LFS file, not the pointer.
        xet_file_data (`XetFileData`, *optional*):
            Xet information for the file. This is only set if the file is stored using Xet storage.
    """

    commit_hash: str | None
    etag: str | None
    location: str
    size: int | None
    xet_file_data: XetFileData | None


@dataclass
class DryRunFileInfo:
    """Information returned when performing a dry run of a file download.

    Returned by [`hf_hub_download`] when `dry_run=True`.

    Args:
        commit_hash (`str`):
            The commit_hash related to the file.
        file_size (`int`):
            Size of the file. In case of an LFS file, contains the size of the actual LFS file, not the pointer.
        filename (`str`):
            Name of the file in the repo.
        is_cached (`bool`):
            Whether the file is already cached locally.
        will_download (`bool`):
            Whether the file will be downloaded if `hf_hub_download` is called with `dry_run=False`.
            In practice, will_download is `True` if the file is not cached or if `force_download=True`.
    """

    commit_hash: str
    file_size: int
    filename: str
    local_path: str
    is_cached: bool
    will_download: bool


@validate_hf_hub_args
def hf_hub_url(
    repo_id: str,
    filename: str,
    *,
    subfolder: str | None = None,
    repo_type: str | None = None,
    revision: str | None = None,
    endpoint: str | None = None,
) -> str:
    """Construct the URL of a file from the given information.

    The resolved address can either be a huggingface.co-hosted url, or a link to
    Cloudfront (a Content Delivery Network, or CDN) for large files which are
    more than a few MBs.

    Args:
        repo_id (`str`):
            A namespace (user or an organization) name and a repo name separated
            by a `/`.
        filename (`str`):
            The name of the file in the repo.
        subfolder (`str`, *optional*):
            An optional value corresponding to a folder inside the repo.
        repo_type (`str`, *optional*):
            Set to `"dataset"`, `"space"` or `"kernel"` if downloading from a dataset, space or kernel repo,
            `None` or `"model"` if downloading from a model. Default is `None`.
        revision (`str`, *optional*):
            An optional Git revision id which can be a branch name, a tag, or a
            commit hash.
        endpoint (`str`, *optional*):
            The Hub endpoint to send the request to. Defaults to the value of `HF_ENDPOINT`.

    Example:

    ```python
    >>> from huggingface_hub import hf_hub_url

    >>> hf_hub_url(
    ...     repo_id="julien-c/EsperBERTo-small", filename="pytorch_model.bin"
    ... )
    'https://huggingface.co/julien-c/EsperBERTo-small/resolve/main/pytorch_model.bin'
    ```

    > [!TIP]
    > Notes:
    >
    >     Cloudfront is replicated over the globe so downloads are way faster for
    >     the end user (and it also lowers our bandwidth costs).
    >
    >     Cloudfront aggressively caches files by default (default TTL is 24
    >     hours), however this is not an issue here because we implement a
    >     git-based versioning system on huggingface.co, which means that we store
    >     the files on S3/Cloudfront in a content-addressable way (i.e., the file
    >     name is its hash). Using content-addressable filenames means cache can't
    >     ever be stale.
    >
    >     In terms of client-side caching from this library, we base our caching
    >     on the objects' entity tag (`ETag`), which is an identifier of a
    >     specific version of a resource [1]_. An object's ETag is: its git-sha1
    >     if stored in git, or its sha256 if stored in git-lfs.

    References:

    -  [1] https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag
    """
    if subfolder == "":
        subfolder = None
    if subfolder is not None:
        filename = f"{subfolder}/{filename}"

    if repo_type not in constants.REPO_TYPES_WITH_KERNEL:
        raise ValueError("Invalid repo type")

    if repo_type in constants.REPO_TYPES_URL_PREFIXES:
        repo_id = constants.REPO_TYPES_URL_PREFIXES[repo_type] + repo_id  # type: ignore

    if revision is None:
        revision = constants.DEFAULT_REVISION
    url = constants.HUGGINGFACE_CO_URL_TEMPLATE.format(
        repo_id=repo_id, revision=quote(revision, safe=""), filename=quote(filename)
    )
    # Update endpoint if provided
    if endpoint is not None and url.startswith(constants.ENDPOINT):
        url = endpoint + url[len(constants.ENDPOINT) :]
    return url


def _get_file_length_from_http_response(response: httpx.Response) -> int | None:
    """
    Get the length of the file from the HTTP response headers.

    This function extracts the file size from the HTTP response headers, either from the
    `Content-Range` or `Content-Length` header, if available (in that order).

    Args:
        response (`httpx.Response`):
            The HTTP response object.

    Returns:
        `int` or `None`: The length of the file in bytes, or None if not available.
    """

    # If HTTP response contains compressed body (e.g. gzip), the `Content-Length` header will
    # contain the length of the compressed body, not the uncompressed file size.
    # And at the start of transmission there's no way to know the uncompressed file size for gzip,
    # thus we return None in that case.
    content_encoding = response.headers.get("Content-Encoding", "identity").lower()
    if content_encoding != "identity":
        # gzip/br/deflate/zstd etc
        return None

    content_range = response.headers.get("Content-Range")
    if content_range is not None:
        return int(content_range.rsplit("/")[-1])

    content_length = response.headers.get("Content-Length")
    if content_length is not None:
        return int(content_length)

    return None


@validate_hf_hub_args
def http_get(
    url: str,
    temp_file: BinaryIO,
    *,
    resume_size: int = 0,
    headers: dict[str, Any] | None = None,
    expected_size: int | None = None,
    displayed_filename: str | None = None,
    tqdm_class: type[base_tqdm] | None = None,
    _nb_retries: int = 5,
    _tqdm_bar: tqdm | None = None,
) -> None:
    """
    Download a remote file. Do not gobble up errors, and will return errors tailored to the Hugging Face Hub.

    If ConnectionError (SSLError) or ReadTimeout happen while streaming data from the server, it is most likely a
    transient error (network outage?). We log a warning message and try to resume the download a few times before
    giving up. The method gives up after 5 attempts if no new data has being received from the server.

    Args:
        url (`str`):
            The URL of the file to download.
        temp_file (`BinaryIO`):
            The file-like object where to save the file.
        resume_size (`int`, *optional*):
            The number of bytes already downloaded. If set to 0 (default), the whole file is download. If set to a
            positive number, the download will resume at the given position.
        headers (`dict`, *optional*):
            Dictionary of HTTP Headers to send with the request.
        expected_size (`int`, *optional*):
            The expected size of the file to download. If set, the download will raise an error if the size of the
            received content is different from the expected one.
        displayed_filename (`str`, *optional*):
            The filename of the file that is being downloaded. Value is used only to display a nice progress bar. If
            not set, the filename is guessed from the URL or the `Content-Disposition` header.
    """
    if expected_size is not None and resume_size == expected_size:
        # If the file is already fully downloaded, we don't need to download it again.
        return

    initial_headers = headers
    headers = copy.deepcopy(headers) or {}
    if resume_size > 0:
        headers["Range"] = _adjust_range_header(headers.get("Range"), resume_size)
    elif expected_size and expected_size > constants.MAX_HTTP_DOWNLOAD_SIZE:
        # Any files over 50GB will not be available through basic http requests.
        raise ValueError(
            "The file is too large to be downloaded using the regular download method. "
            " Install `hf_xet` with `pip install hf_xet` for xet-powered downloads."
        )

    with http_stream_backoff(
        method="GET",
        url=url,
        headers=headers,
        timeout=constants.HF_HUB_DOWNLOAD_TIMEOUT,
        retry_on_exceptions=(),
        retry_on_status_codes=(408, 429),
    ) as response:
        hf_raise_for_status(response)

        # If we requested a Range but got 200 back, the server ignored our Range header
        # (e.g. CloudFront with Accept-Encoding: gzip). Reset file to avoid corruption.
        if resume_size > 0 and response.status_code == 200:
            temp_file.seek(0)
            temp_file.truncate()
            if _tqdm_bar is not None:
                # When the progress bar is reused across retries, its counter has already been advanced by `resume_size`
                # worth of chunks from earlier attempts. Those bytes are gone from disk now, so roll the counter back
                # to keep the upcoming full re-download from double-counting (e.g. ending at 130/100 on a 100-byte file).
                _tqdm_bar.update(-resume_size)
                if callable(update_transfer := getattr(_tqdm_bar, "update_transfer", None)):
                    update_transfer(-resume_size)
            resume_size = 0

        total: int | None = _get_file_length_from_http_response(response)
        if total is None:
            # Hub serves compressible text files (e.g. vocab.json) with `Content-Encoding: gzip` and
            # `Transfer-Encoding: chunked`, so the response carries no `Content-Length`. Fall back to the caller's
            # `expected_size` (always known from the metadata HEAD on the hf_hub path) so the progress bar, and any
            # aggregating wrapper such as snapshot_download's `_AggregatedTqdm` — still sees the file size.
            total = expected_size

        if displayed_filename is None:
            displayed_filename = url
            content_disposition = response.headers.get("Content-Disposition")
            if content_disposition is not None:
                match = HEADER_FILENAME_PATTERN.search(content_disposition)
                if match is not None:
                    # Means file is on CDN
                    displayed_filename = match.groupdict()["filename"]

        # Truncate filename if too long to display
        if len(displayed_filename) > 40:
            displayed_filename = f"(…){displayed_filename[-40:]}"

        consistency_error_message = (
            f"Consistency check failed: file should be of size {expected_size} but has size"
            f" {{actual_size}} ({displayed_filename}).\nThis is usually due to network issues while downloading the file."
            " Please retry with `force_download=True`."
        )
        progress_cm = _get_progress_bar_context(
            desc=displayed_filename,
            log_level=logger.getEffectiveLevel(),
            total=total,
            initial=resume_size,
            name="huggingface_hub.http_get",
            tqdm_class=tqdm_class,
            _tqdm_bar=_tqdm_bar,
        )

        with progress_cm as progress:
            new_resume_size = resume_size
            try:
                for chunk in response.iter_bytes(chunk_size=constants.DOWNLOAD_CHUNK_SIZE):
                    if chunk:  # filter out keep-alive new chunks
                        progress.update(len(chunk))
                        if callable(update_transfer := getattr(progress, "update_transfer", None)):
                            update_transfer(len(chunk))
                        temp_file.write(chunk)
                        new_resume_size += len(chunk)
                        # Some data has been downloaded from the server so we reset the number of retries.
                        _nb_retries = 5
            except (httpx.ConnectError, httpx.TimeoutException, httpx.RemoteProtocolError) as e:
                # If ConnectionError (SSLError), ReadTimeout, or RemoteProtocolError (peer closed the connection before
                # sending the complete body) happen while streaming data from the server, it is most likely a transient
                # error (network outage?). We log a warning message and try to resume the download a few times  before
                # giving up. The retry mechanism is basic but should be enough in most cases.
                if _nb_retries <= 0:
                    logger.warning("Error while downloading from %s: %s\nMax retries exceeded.", url, str(e))
                    raise
                logger.warning("Error while downloading from %s: %s\nTrying to resume download...", url, str(e))
                time.sleep(1)
                return http_get(
                    url=url,
                    temp_file=temp_file,
                    resume_size=new_resume_size,
                    headers=initial_headers,
                    expected_size=expected_size,
                    tqdm_class=tqdm_class,
                    _nb_retries=_nb_retries - 1,
                    # Reuse the existing progress bar across retries so a custom `tqdm_class` (e.g. snapshot_download's `_AggregatedTqdm`,
                    # which mutates a shared parent bar in `__init__`) is not re-instantiated and does not double-count `total`/`initial`.
                    _tqdm_bar=progress,
                )

    if expected_size is not None and expected_size != temp_file.tell():
        raise OSError(
            consistency_error_message.format(
                actual_size=temp_file.tell(),
            )
        )


def xet_get(
    *,
    incomplete_path: Path,
    xet_file_data: XetFileData,
    headers: dict[str, str],
    expected_size: int | None = None,
    displayed_filename: str | None = None,
    tqdm_class: type[base_tqdm] | None = None,
    _tqdm_bar: tqdm | None = None,
) -> None:
    """
    Download a file using Xet storage service.

    Args:
        incomplete_path (`Path`):
            The path to the file to download.
        xet_file_data (`XetFileData`):
            The file metadata needed to make the request to the xet storage service.
        headers (`dict[str, str]`):
            The headers to send to the xet storage service.
        expected_size (`int`, *optional*):
            The expected size of the file to download. If set, the download will raise an error if the size of the
            received content is different from the expected one.
        displayed_filename (`str`, *optional*):
            The filename of the file that is being downloaded. Value is used only to display a nice progress bar. If
            not set, the filename is guessed from the URL or the `Content-Disposition` header.

    **How it works:**
        The file download system uses Xet storage, which is a content-addressable storage system that breaks files into chunks
        for efficient storage and transfer.

        ``session.new_file_download_group()`` manages downloading files by:
        - Registering download tasks (each with its unique content hash) and starting download immediately in the background
        - Connecting to a storage server (CAS server) that knows how files are chunked
        - Using authentication to ensure secure access
        - Providing progress updates during download

        Authentication works transparently: the download group accepts a ``token_refresh_url``
        that is used to refresh the short-lived xet access token as needed.

        The download process works like this:
        1. Download tasks run in parallel:
            1.1. Prepare to write the file to disk or to a stream (e.g. truncate file, set up cache)
            1.2. Ask the server "how is this file split into chunks?" using the file's unique hash
                The server responds with:
                - Which chunks make up the complete file
                - Where each chunk can be downloaded from
            1.3. For each needed chunk:
                - Checks if we already have it in our local cache
                - If not, download it from cloud storage (S3)
                - Save it to cache for future use
                - Assemble the chunks in order to recreate the original file

    """
    try:
        from hf_xet import XetFileInfo  # type: ignore[no-redef]
    except ImportError:
        raise ValueError(
            "To use optimized download using Xet storage, you need to install the hf_xet package. "
            'Try `pip install "huggingface_hub[hf_xet]"` or `pip install hf_xet`.'
        )

    if not displayed_filename:
        displayed_filename = incomplete_path.name

    # Truncate filename if too long to display
    if len(displayed_filename) > 40:
        displayed_filename = f"{displayed_filename[:40]}(…)"

    from .utils._xet import abort_xet_session, get_xet_session, xet_headers_without_auth
    from .utils._xet_progress_reporting import XetDownloadProgressReporter

    xet_headers = xet_headers_without_auth(headers)

    session = get_xet_session()

    with XetDownloadProgressReporter(
        reconstruction_desc=f"{displayed_filename}: reconstructing file",
        transfer_desc=f"{displayed_filename}: downloading bytes",
        total=expected_size,
        log_level=logger.getEffectiveLevel(),
        name="huggingface_hub.xet_get",
        tqdm_class=tqdm_class,
        external_reconstruction_bar=_tqdm_bar,
    ) as progress:
        try:
            with session.new_file_download_group(
                token_refresh_url=xet_file_data.refresh_route,
                token_refresh_headers=headers,
                custom_headers=xet_headers,
                progress_callback=progress.update_progress,
            ) as group:
                group.start_download_file(
                    XetFileInfo(xet_file_data.file_hash, expected_size), str(incomplete_path.absolute())
                )
        except KeyboardInterrupt:
            abort_xet_session()
            raise


def _normalize_etag(etag: str | None) -> str | None:
    """Normalize ETag HTTP header, so it can be used to create nice filepaths.

    The HTTP spec allows two forms of ETag:
      ETag: W/"<etag_value>"
      ETag: "<etag_value>"

    For now, we only expect the second form from the server, but we want to be future-proof so we support both. For
    more context, see `TestNormalizeEtag` tests and https://github.com/huggingface/huggingface_hub/pull/1428.

    Args:
        etag (`str`, *optional*): HTTP header

    Returns:
        `str` or `None`: string that can be used as a nice directory name.
        Returns `None` if input is None.
    """
    if etag is None:
        return None
    return etag.lstrip("W/").strip('"')


def _create_relative_symlink(src: str, dst: str, new_blob: bool = False) -> None:
    """Alias method used in `transformers` conversion script."""
    return _create_symlink(src=src, dst=dst, new_blob=new_blob)


def _create_symlink(src: str, dst: str, new_blob: bool = False) -> None:
    """Create a symbolic link named dst pointing to src.

    By default, it will try to create a symlink using a relative path. Relative paths have 2 advantages:
    - If the cache_folder is moved (example: back-up on a shared drive), relative paths within the cache folder will
      not break.
    - Relative paths seems to be better handled on Windows. Issue was reported 3 times in less than a week when
      changing from relative to absolute paths. See https://github.com/huggingface/huggingface_hub/issues/1398,
      https://github.com/huggingface/diffusers/issues/2729 and https://github.com/huggingface/transformers/pull/22228.
      NOTE: The issue with absolute paths doesn't happen on admin mode.
    When creating a symlink from the cache to a local folder, it is possible that a relative path cannot be created.
    This happens when paths are not on the same volume. In that case, we use absolute paths.


    The result layout looks something like
        └── [ 128]  snapshots
            ├── [ 128]  2439f60ef33a0d46d85da5001d52aeda5b00ce9f
            │   ├── [  52]  README.md -> ../../../blobs/d7edf6bd2a681fb0175f7735299831ee1b22b812
            │   └── [  76]  pytorch_model.bin -> ../../../blobs/403450e234d65943a7dcf7e05a771ce3c92faa84dd07db4ac20f592037a1e4bd

    If symlinks cannot be created on this platform (most likely to be Windows), the workaround is to avoid symlinks by
    having the actual file in `dst`. If it is a new file (`new_blob=True`), we move it to `dst`. If it is not a new file
    (`new_blob=False`), we don't know if the blob file is already referenced elsewhere. To avoid breaking existing
    cache, the file is duplicated on the disk.

    In case symlinks are not supported, a warning message is displayed to the user once when loading `huggingface_hub`.
    The warning message can be disabled with the `DISABLE_SYMLINKS_WARNING` environment variable.
    """
    try:
        os.remove(dst)
    except OSError:
        pass

    abs_src = os.path.abspath(os.path.expanduser(src))
    abs_dst = os.path.abspath(os.path.expanduser(dst))
    abs_dst_folder = os.path.dirname(abs_dst)

    # Use relative_dst in priority
    try:
        relative_src = os.path.relpath(abs_src, abs_dst_folder)
    except ValueError:
        # Raised on Windows if src and dst are not on the same volume. This is the case when creating a symlink to a
        # local_dir instead of within the cache directory.
        # See https://docs.python.org/3/library/os.path.html#os.path.relpath
        relative_src = None

    try:
        commonpath = os.path.commonpath([abs_src, abs_dst])
        _support_symlinks = are_symlinks_supported(commonpath)
    except ValueError:
        # Raised if src and dst are not on the same volume. Symlinks will still work on Linux/Macos.
        # See https://docs.python.org/3/library/os.path.html#os.path.commonpath
        _support_symlinks = os.name != "nt" and not constants.HF_HUB_DISABLE_SYMLINKS
    except PermissionError:
        # Permission error means src and dst are not in the same volume (e.g. destination path has been provided
        # by the user via `local_dir`. Let's test symlink support there)
        _support_symlinks = are_symlinks_supported(abs_dst_folder)
    except OSError as e:
        # OS error (errno=30) means that the commonpath is readonly on Linux/MacOS.
        if e.errno == errno.EROFS:
            _support_symlinks = are_symlinks_supported(abs_dst_folder)
        else:
            raise

    # Symlinks are supported => let's create a symlink.
    if _support_symlinks:
        src_rel_or_abs = relative_src or abs_src
        logger.debug(f"Creating pointer from {src_rel_or_abs} to {abs_dst}")
        try:
            os.symlink(src_rel_or_abs, abs_dst)
            return
        except FileExistsError:
            if os.path.islink(abs_dst) and os.path.realpath(abs_dst) == os.path.realpath(abs_src):
                # `abs_dst` already exists and is a symlink to the `abs_src` blob. It is most likely that the file has
                # been cached twice concurrently (exactly between `os.remove` and `os.symlink`). Do nothing.
                return
            else:
                # Very unlikely to happen. Means a file `dst` has been created exactly between `os.remove` and
                # `os.symlink` and is not a symlink to the `abs_src` blob file. Raise exception.
                raise
        except PermissionError:
            # Permission error means src and dst are not in the same volume (e.g. download to local dir) and symlink
            # is supported on both volumes but not between them. Let's just make a hard copy in that case.
            pass

    # Symlinks are not supported => let's move or copy the file.
    if new_blob:
        logger.debug(f"Symlink not supported. Moving file from {abs_src} to {abs_dst}")
        shutil.move(abs_src, abs_dst, copy_function=_copy_no_matter_what)
    else:
        logger.debug(f"Symlink not supported. Copying file from {abs_src} to {abs_dst}")
        shutil.copyfile(abs_src, abs_dst)


def _cache_commit_hash_for_specific_revision(storage_folder: str, revision: str, commit_hash: str) -> None:
    """Cache reference between a revision (tag, branch or truncated commit hash) and the corresponding commit hash.

    Does nothing if `revision` is already a proper `commit_hash` or reference is already cached.
    """
    if revision != commit_hash:
        ref_path = Path(storage_folder) / "refs" / revision
        ref_path.parent.mkdir(parents=True, exist_ok=True)
        if not ref_path.exists() or commit_hash != ref_path.read_text():
            # Update ref only if has been updated. Could cause useless error in case
            # repo is already cached and user doesn't have write access to cache folder.
            # See https://github.com/huggingface/huggingface_hub/issues/1216.
            # Write atomically (tmp file + rename) so that concurrent readers never see
            # a partially written ref.
            tmp_path = ref_path.with_name(f"{ref_path.name}.{uuid.uuid4().hex[:8]}.tmp")
            tmp_path.write_text(commit_hash)
            os.replace(tmp_path, ref_path)


@validate_hf_hub_args
def repo_folder_name(*, repo_id: str, repo_type: str) -> str:
    """Return a serialized version of a hf.co repo name and type, safe for disk storage
    as a single non-nested folder.

    Example: models--julien-c--EsperBERTo-small
    """
    # remove all `/` occurrences to correctly convert repo to directory name
    parts = [f"{repo_type}s", *repo_id.split("/")]
    return constants.REPO_ID_SEPARATOR.join(parts)


def _check_disk_space(expected_size: int, target_dir: str | Path) -> None:
    """Check disk usage and log a warning if there is not enough disk space to download the file.

    Args:
        expected_size (`int`):
            The expected size of the file in bytes.
        target_dir (`str`):
            The directory where the file will be stored after downloading.
    """

    target_dir = Path(target_dir)  # format as `Path`
    for path in [target_dir] + list(target_dir.parents):  # first check target_dir, then each parents one by one
        try:
            target_dir_free = shutil.disk_usage(path).free
            if target_dir_free < expected_size:
                warnings.warn(
                    "Not enough free disk space to download the file. "
                    f"The expected file size is: {expected_size / 1e6:.2f} MB. "
                    f"The target location {target_dir} only has {target_dir_free / 1e6:.2f} MB free disk space."
                )
            return
        except OSError:  # raise on anything: file does not exist or space disk cannot be checked
            pass


@overload
def hf_hub_download(
    repo_id: str,
    filename: str,
    *,
    subfolder: str | None = None,
    repo_type: str | None = None,
    revision: str | None = None,
    library_name: str | None = None,
    library_version: str | None = None,
    cache_dir: str | Path | None = None,
    local_dir: str | Path | None = None,
    user_agent: dict | str | None = None,
    force_download: bool = False,
    etag_timeout: float = constants.DEFAULT_ETAG_TIMEOUT,
    token: bool | str | None = None,
    local_files_only: bool = False,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
    tqdm_class: type[base_tqdm] | None = None,
    dry_run: Literal[False] = False,
) -> str: ...


@overload
def hf_hub_download(
    repo_id: str,
    filename: str,
    *,
    subfolder: str | None = None,
    repo_type: str | None = None,
    revision: str | None = None,
    library_name: str | None = None,
    library_version: str | None = None,
    cache_dir: str | Path | None = None,
    local_dir: str | Path | None = None,
    user_agent: dict | str | None = None,
    force_download: bool = False,
    etag_timeout: float = constants.DEFAULT_ETAG_TIMEOUT,
    token: bool | str | None = None,
    local_files_only: bool = False,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
    tqdm_class: type[base_tqdm] | None = None,
    dry_run: Literal[True] = True,
) -> DryRunFileInfo: ...


@overload
def hf_hub_download(
    repo_id: str,
    filename: str,
    *,
    subfolder: str | None = None,
    repo_type: str | None = None,
    revision: str | None = None,
    library_name: str | None = None,
    library_version: str | None = None,
    cache_dir: str | Path | None = None,
    local_dir: str | Path | None = None,
    user_agent: dict | str | None = None,
    force_download: bool = False,
    etag_timeout: float = constants.DEFAULT_ETAG_TIMEOUT,
    token: bool | str | None = None,
    local_files_only: bool = False,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
    tqdm_class: type[base_tqdm] | None = None,
    dry_run: bool = False,
) -> str | DryRunFileInfo: ...


@validate_hf_hub_args
def hf_hub_download(
    repo_id: str,
    filename: str,
    *,
    subfolder: str | None = None,
    repo_type: str | None = None,
    revision: str | None = None,
    library_name: str | None = None,
    library_version: str | None = None,
    cache_dir: str | Path | None = None,
    local_dir: str | Path | None = None,
    user_agent: dict | str | None = None,
    force_download: bool = False,
    etag_timeout: float = constants.DEFAULT_ETAG_TIMEOUT,
    token: bool | str | None = None,
    local_files_only: bool = False,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
    tqdm_class: type[base_tqdm] | None = None,
    dry_run: bool = False,
) -> str | DryRunFileInfo:
    """Download a given file if it's not already present in the local cache.

    The new cache file layout looks like this:
    - The cache directory contains one subfolder per repo_id (namespaced by repo type)
    - inside each repo folder:
        - refs is a list of the latest known revision => commit_hash pairs
        - blobs contains the actual file blobs (identified by their git-sha or sha256, depending on
          whether they're LFS files or not)
        - snapshots contains one subfolder per commit, each "commit" contains the subset of the files
          that have been resolved at that particular commit. Each filename is a symlink to the blob
          at that particular commit.

    ```
    [  96]  .
    └── [ 160]  models--julien-c--EsperBERTo-small
        ├── [ 160]  blobs
        │   ├── [321M]  403450e234d65943a7dcf7e05a771ce3c92faa84dd07db4ac20f592037a1e4bd
        │   ├── [ 398]  7cb18dc9bafbfcf74629a4b760af1b160957a83e
        │   └── [1.4K]  d7edf6bd2a681fb0175f7735299831ee1b22b812
        ├── [  96]  refs
        │   └── [  40]  main
        └── [ 128]  snapshots
            ├── [ 128]  2439f60ef33a0d46d85da5001d52aeda5b00ce9f
            │   ├── [  52]  README.md -> ../../blobs/d7edf6bd2a681fb0175f7735299831ee1b22b812
            │   └── [  76]  pytorch_model.bin -> ../../blobs/403450e234d65943a7dcf7e05a771ce3c92faa84dd07db4ac20f592037a1e4bd
            └── [ 128]  bbc77c8132af1cc5cf678da3f1ddf2de43606d48
                ├── [  52]  README.md -> ../../blobs/7cb18dc9bafbfcf74629a4b760af1b160957a83e
                └── [  76]  pytorch_model.bin -> ../../blobs/403450e234d65943a7dcf7e05a771ce3c92faa84dd07db4ac20f592037a1e4bd
    ```

    If `local_dir` is provided, the file structure from the repo will be replicated in this location. When using this
    option, the `cache_dir` will not be used and a `.cache/huggingface/` folder will be created at the root of `local_dir`
    to store some metadata related to the downloaded files. While this mechanism is not as robust as the main
    cache-system, it's optimized for regularly pulling the latest version of a repository.

    Args:
        repo_id (`str`):
            A user or an organization name and a repo name separated by a `/`.
        filename (`str`):
            The name of the file in the repo.
        subfolder (`str`, *optional*):
            An optional value corresponding to a folder inside the model repo.
        repo_type (`str`, *optional*):
            Set to `"dataset"`, `"space"` or `"kernel"` if downloading from a dataset, space or kernel repo,
            `None` or `"model"` if downloading from a model. Default is `None`.
        revision (`str`, *optional*):
            An optional Git revision id which can be a branch name, a tag, or a
            commit hash.
        library_name (`str`, *optional*):
            The name of the library to which the object corresponds.
        library_version (`str`, *optional*):
            The version of the library.
        cache_dir (`str`, `Path`, *optional*):
            Path to the folder where cached files are stored.
        local_dir (`str` or `Path`, *optional*):
            If provided, the downloaded file will be placed under this directory.
        user_agent (`dict`, `str`, *optional*):
            The user-agent info in the form of a dictionary or a string.
        force_download (`bool`, *optional*, defaults to `False`):
            Whether the file should be downloaded even if it already exists in
            the local cache.
        etag_timeout (`float`, *optional*, defaults to `10`):
            When fetching ETag, how many seconds to wait for the server to send
            data before giving up, which is passed to `httpx.request`.
        token (`str`, `bool`, *optional*):
            A token to be used for the download.
                - If `True`, the token is read from the HuggingFace config
                  folder.
                - If a string, it's used as the authentication token.
        local_files_only (`bool`, *optional*, defaults to `False`):
            If `True`, avoid downloading the file and return the path to the
            local cached file if it exists.
        headers (`dict`, *optional*):
            Additional headers to be sent with the request.
        endpoint (`str`, *optional*):
            The Hub endpoint to send the request to. Defaults to the value of `HF_ENDPOINT`.
        tqdm_class (`tqdm`, *optional*):
            If provided, overwrites the default behavior for the progress bar. Passed
            argument must inherit from `tqdm.auto.tqdm` or at least mimic its behavior.
            Defaults to the custom HF progress bar that can be disabled by setting
            `HF_HUB_DISABLE_PROGRESS_BARS` environment variable.
        dry_run (`bool`, *optional*, defaults to `False`):
            If `True`, perform a dry run without actually downloading the file. Returns a
            [`DryRunFileInfo`] object containing information about what would be downloaded.

    Returns:
        `str` or [`DryRunFileInfo`]:
            - If `dry_run=False`: Local path of file or if networking is off, last version of file cached on disk.
            - If `dry_run=True`: A [`DryRunFileInfo`] object containing download information.

    Raises:
        [`~utils.RepositoryNotFoundError`]
            If the repository to download from cannot be found. This may be because it doesn't exist,
            or because it is set to `private` and you do not have access.
        [`~utils.RevisionNotFoundError`]
            If the revision to download from cannot be found.
        [`~utils.RemoteEntryNotFoundError`]
            If the file to download cannot be found.
        [`~utils.LocalEntryNotFoundError`]
            If network is disabled or unavailable and file is not found in cache.
        [`EnvironmentError`](https://docs.python.org/3/library/exceptions.html#EnvironmentError)
            If `token=True` but the token cannot be found.
        [`OSError`](https://docs.python.org/3/library/exceptions.html#OSError)
            If ETag cannot be determined.
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If some parameter value is invalid.

    """
    if constants.HF_HUB_ETAG_TIMEOUT != constants.DEFAULT_ETAG_TIMEOUT:
        # Respect environment variable above user value
        etag_timeout = constants.HF_HUB_ETAG_TIMEOUT

    if revision is None:
        revision = constants.DEFAULT_REVISION
    elif isinstance(revision, ResolvedRevision):
        # Revision has already been resolved to a commit hash (see [`HfApi.resolve_revision`]) => use it directly.
        # This pins the download to an immutable commit and lets us skip network calls when it's already cached.
        revision = revision.resolved

    if cache_dir is None:
        cache_dir = constants.HF_HUB_CACHE
    cache_dir = str(Path(cache_dir).expanduser().resolve())

    if local_dir is not None:
        local_dir = str(Path(local_dir).expanduser().resolve())

    if subfolder == "":
        subfolder = None
    if subfolder is not None:
        # This is used to create a URL, and not a local path, hence the forward slash.
        filename = f"{subfolder}/{filename}"

    if repo_type is None:
        repo_type = "model"
    if repo_type not in constants.REPO_TYPES_WITH_KERNEL:
        raise ValueError(
            f"Invalid repo type: {repo_type}. Accepted repo types are: {str(constants.REPO_TYPES_WITH_KERNEL)}"
        )

    hf_headers = build_hf_headers(
        token=token,
        library_name=library_name,
        library_version=library_version,
        user_agent=user_agent,
        headers=headers,
    )

    if local_dir is not None:
        return _hf_hub_download_to_local_dir(
            # Destination
            local_dir=local_dir,
            # File info
            repo_id=repo_id,
            repo_type=repo_type,
            filename=filename,
            revision=revision,
            # HTTP info
            endpoint=endpoint,
            etag_timeout=etag_timeout,
            headers=hf_headers,
            token=token,
            # Additional options
            cache_dir=cache_dir,
            force_download=force_download,
            local_files_only=local_files_only,
            tqdm_class=tqdm_class,
            dry_run=dry_run,
        )
    else:
        return _hf_hub_download_to_cache_dir(
            # Destination
            cache_dir=cache_dir,
            # File info
            repo_id=repo_id,
            filename=filename,
            repo_type=repo_type,
            revision=revision,
            # HTTP info
            endpoint=endpoint,
            etag_timeout=etag_timeout,
            headers=hf_headers,
            token=token,
            # Additional options
            local_files_only=local_files_only,
            force_download=force_download,
            tqdm_class=tqdm_class,
            dry_run=dry_run,
        )


def _hf_hub_download_to_cache_dir(
    *,
    # Destination
    cache_dir: str,
    # File info
    repo_id: str,
    filename: str,
    repo_type: str,
    revision: str,
    # HTTP info
    endpoint: str | None,
    etag_timeout: float,
    headers: dict[str, str],
    token: bool | str | None,
    # Additional options
    local_files_only: bool,
    force_download: bool,
    tqdm_class: type[base_tqdm] | None,
    dry_run: bool,
) -> str | DryRunFileInfo:
    """Download a given file to a cache folder, if not already present.

    Method should not be called directly. Please use `hf_hub_download` instead.
    """
    locks_dir = os.path.join(cache_dir, ".locks")
    storage_folder = os.path.join(cache_dir, repo_folder_name(repo_id=repo_id, repo_type=repo_type))

    _validate_relative_filename(filename)
    # cross-platform transcription of filename, to be used as a local file path.
    relative_filename = os.path.join(*filename.split("/"))

    # if user provides a commit_hash and they already have the file on disk, shortcut everything.
    if REGEX_COMMIT_HASH.match(revision):
        pointer_path = _get_pointer_path(storage_folder, revision, relative_filename)
        if os.path.exists(pointer_path):
            if dry_run:
                return DryRunFileInfo(
                    commit_hash=revision,
                    file_size=os.path.getsize(pointer_path),
                    filename=filename,
                    is_cached=True,
                    local_path=pointer_path,
                    will_download=force_download,
                )
            if not force_download:
                return pointer_path

    # Try to get metadata (etag, commit_hash, url, size) from the server.
    # If we can't, a HEAD request error is returned.
    (url_to_download, etag, commit_hash, expected_size, xet_file_data, head_call_error) = _get_metadata_or_catch_error(
        repo_id=repo_id,
        filename=filename,
        repo_type=repo_type,
        revision=revision,
        endpoint=endpoint,
        etag_timeout=etag_timeout,
        headers=headers,
        token=token,
        local_files_only=local_files_only,
        storage_folder=storage_folder,
        relative_filename=relative_filename,
        tree_cache_folder=storage_folder,
    )

    # etag can be None for several reasons:
    # 1. we passed local_files_only.
    # 2. we don't have a connection
    # 3. Hub is down (HTTP 500, 503, 504)
    # 4. repo is not found -for example private or gated- and invalid/missing token sent
    # 5. Hub is blocked by a firewall or proxy is not set correctly.
    # => Try to get the last downloaded one from the specified revision.
    #
    # If the specified revision is a commit hash, look inside "snapshots".
    # If the specified revision is a branch or tag, look inside "refs".
    if head_call_error is not None:
        # Couldn't make a HEAD call => let's try to find a local file
        if not force_download:
            commit_hash = None
            if REGEX_COMMIT_HASH.match(revision):
                commit_hash = revision
            else:
                ref_path = os.path.join(storage_folder, "refs", revision)
                if os.path.isfile(ref_path):
                    with open(ref_path) as f:
                        commit_hash = f.read()

            # Return pointer file if exists
            if commit_hash is not None:
                pointer_path = _get_pointer_path(storage_folder, commit_hash, relative_filename)
                if os.path.exists(pointer_path):
                    if dry_run:
                        return DryRunFileInfo(
                            commit_hash=commit_hash,
                            file_size=os.path.getsize(pointer_path),
                            filename=filename,
                            is_cached=True,
                            local_path=pointer_path,
                            will_download=force_download,
                        )
                    if not force_download:
                        return pointer_path

            if isinstance(head_call_error, _DEFAULT_RETRY_ON_EXCEPTIONS) or (
                isinstance(head_call_error, HfHubHTTPError)
                and head_call_error.response.status_code in _DEFAULT_RETRY_ON_STATUS_CODES
            ):
                logger.info("No local file found. Retrying..")
                (url_to_download, etag, commit_hash, expected_size, xet_file_data, head_call_error) = (
                    _get_metadata_or_catch_error(
                        repo_id=repo_id,
                        filename=filename,
                        repo_type=repo_type,
                        revision=revision,
                        endpoint=endpoint,
                        etag_timeout=_ETAG_RETRY_TIMEOUT,
                        headers=headers,
                        token=token,
                        local_files_only=local_files_only,
                        storage_folder=storage_folder,
                        relative_filename=relative_filename,
                        retry_on_errors=True,
                    )
                )

        # If still error, raise
        if head_call_error is not None:
            _raise_on_head_call_error(head_call_error, force_download, local_files_only)

    # From now on, etag, commit_hash, url and size are not None.
    assert etag is not None, "etag must have been retrieved from server"
    assert commit_hash is not None, "commit_hash must have been retrieved from server"
    assert url_to_download is not None, "file location must have been retrieved from server"
    assert expected_size is not None, "expected_size must have been retrieved from server"
    blob_path = os.path.join(storage_folder, "blobs", etag)
    pointer_path = _get_pointer_path(storage_folder, commit_hash, relative_filename)

    if dry_run:
        is_cached = os.path.exists(pointer_path) or os.path.exists(blob_path)
        return DryRunFileInfo(
            commit_hash=commit_hash,
            file_size=expected_size,
            filename=filename,
            is_cached=is_cached,
            local_path=pointer_path,
            will_download=force_download or not is_cached,
        )

    # Pointer already exists -> update the ref best-effort, then return without
    # attempting to write to the cache (which may be mounted read-only).
    if not force_download and os.path.exists(pointer_path):
        try:
            _cache_commit_hash_for_specific_revision(storage_folder, revision, commit_hash)
        except OSError:
            pass
        return pointer_path

    os.makedirs(os.path.dirname(blob_path), exist_ok=True)
    os.makedirs(os.path.dirname(pointer_path), exist_ok=True)

    # Tag cache_dir so backup tools can skip it (CACHEDIR.TAG standard).
    _create_cachedir_tag(Path(cache_dir))

    # if passed revision is not identical to commit_hash
    # then revision has to be a branch name or tag name.
    # In that case store a ref.
    _cache_commit_hash_for_specific_revision(storage_folder, revision, commit_hash)

    # Prevent parallel downloads of the same file with a lock.
    # etag could be duplicated across repos.
    # Note: the lock is best-effort to avoid downloading the same file twice. Cache correctness
    # does not depend on it: each download writes to a process-unique temporary file that is
    # atomically renamed into place (see `_download_to_tmp_and_move`).
    lock_path = os.path.join(locks_dir, repo_folder_name(repo_id=repo_id, repo_type=repo_type), f"{etag}.lock")

    # Some Windows versions do not allow for paths longer than 255 characters.
    # In this case, we must specify it as an extended path by using the "\\?\" prefix.
    if (
        os.name == "nt"
        and len(os.path.abspath(lock_path)) > 255
        and not os.path.abspath(lock_path).startswith("\\\\?\\")
    ):
        lock_path = "\\\\?\\" + os.path.abspath(lock_path)

    if (
        os.name == "nt"
        and len(os.path.abspath(blob_path)) > 255
        and not os.path.abspath(blob_path).startswith("\\\\?\\")
    ):
        blob_path = "\\\\?\\" + os.path.abspath(blob_path)

    Path(lock_path).parent.mkdir(parents=True, exist_ok=True)

    # Blob exists but pointer must be (safely) created -> take the lock
    if not force_download and os.path.exists(blob_path):
        with WeakFileLock(lock_path):
            if not os.path.exists(pointer_path):
                _create_symlink(blob_path, pointer_path, new_blob=False)
            return pointer_path

    # Local file doesn't exist or etag isn't a match => retrieve file from remote (or cache)

    with WeakFileLock(lock_path):
        _download_to_tmp_and_move(
            incomplete_path=Path(blob_path + ".incomplete"),
            destination_path=Path(blob_path),
            url_to_download=url_to_download,
            headers=headers,
            expected_size=expected_size,
            filename=filename,
            force_download=force_download,
            etag=etag,
            xet_file_data=xet_file_data,
            tqdm_class=tqdm_class,
        )
        if not os.path.exists(pointer_path):
            _create_symlink(blob_path, pointer_path, new_blob=True)

    return pointer_path


def _hf_hub_download_to_local_dir(
    *,
    # Destination
    local_dir: str | Path,
    # File info
    repo_id: str,
    repo_type: str,
    filename: str,
    revision: str,
    # HTTP info
    endpoint: str | None,
    etag_timeout: float,
    headers: dict[str, str],
    token: bool | str | None,
    # Additional options
    cache_dir: str,
    force_download: bool,
    local_files_only: bool,
    tqdm_class: type[base_tqdm] | None,
    dry_run: bool,
) -> str | DryRunFileInfo:
    """Download a given file to a local folder, if not already present.

    Method should not be called directly. Please use `hf_hub_download` instead.
    """
    # Some Windows versions do not allow for paths longer than 255 characters.
    # In this case, we must specify it as an extended path by using the "\\?\" prefix.
    if os.name == "nt" and len(os.path.abspath(local_dir)) > 255:
        local_dir = "\\\\?\\" + os.path.abspath(local_dir)
    local_dir = Path(local_dir)
    paths = get_local_download_paths(local_dir=local_dir, filename=filename)
    local_metadata = read_download_metadata(local_dir=local_dir, filename=filename)

    # Local file exists + metadata exists + commit_hash matches => return file
    if (
        REGEX_COMMIT_HASH.match(revision)
        and paths.file_path.is_file()
        and local_metadata is not None
        and local_metadata.commit_hash == revision
    ):
        local_file = str(paths.file_path)
        if dry_run:
            return DryRunFileInfo(
                commit_hash=revision,
                file_size=os.path.getsize(local_file),
                filename=filename,
                is_cached=True,
                local_path=local_file,
                will_download=force_download,
            )
        if not force_download:
            return local_file

    # Local file doesn't exist or commit_hash doesn't match => we need the etag
    # - Xet file => might be cached in /tree listing
    # - otherwise => HEAD /resolve call
    tree_cache_folder = tree_cache_folder_for_local_dir(str(local_dir))
    (url_to_download, etag, commit_hash, expected_size, xet_file_data, head_call_error) = _get_metadata_or_catch_error(
        repo_id=repo_id,
        filename=filename,
        repo_type=repo_type,
        revision=revision,
        endpoint=endpoint,
        etag_timeout=etag_timeout,
        headers=headers,
        token=token,
        local_files_only=local_files_only,
        tree_cache_folder=tree_cache_folder,
    )

    if head_call_error is not None:
        # No HEAD call but local file exists => default to local file
        if paths.file_path.is_file():
            if dry_run or not force_download:
                logger.warning(
                    f"Couldn't access the Hub to check for update but local file already exists. Defaulting to existing file. (error: {head_call_error})"
                )
            local_path = str(paths.file_path)
            if dry_run and local_metadata is not None:
                return DryRunFileInfo(
                    commit_hash=local_metadata.commit_hash,
                    file_size=os.path.getsize(local_path),
                    filename=filename,
                    is_cached=True,
                    local_path=local_path,
                    will_download=force_download,
                )
            if not force_download:
                return local_path
        elif not force_download:
            if isinstance(head_call_error, _DEFAULT_RETRY_ON_EXCEPTIONS) or (
                isinstance(head_call_error, HfHubHTTPError)
                and head_call_error.response.status_code in _DEFAULT_RETRY_ON_STATUS_CODES
            ):
                logger.info("No local file found. Retrying..")
                (url_to_download, etag, commit_hash, expected_size, xet_file_data, head_call_error) = (
                    _get_metadata_or_catch_error(
                        repo_id=repo_id,
                        filename=filename,
                        repo_type=repo_type,
                        revision=revision,
                        endpoint=endpoint,
                        etag_timeout=_ETAG_RETRY_TIMEOUT,
                        headers=headers,
                        token=token,
                        local_files_only=local_files_only,
                        retry_on_errors=True,
                    )
                )

        # If still error, raise
        if head_call_error is not None:
            _raise_on_head_call_error(head_call_error, force_download, local_files_only)

    # From now on, etag, commit_hash, url and size are not None.
    assert etag is not None, "etag must have been retrieved from server"
    assert commit_hash is not None, "commit_hash must have been retrieved from server"
    assert url_to_download is not None, "file location must have been retrieved from server"
    assert expected_size is not None, "expected_size must have been retrieved from server"

    # Local file exists => check if it's up-to-date
    if not force_download and paths.file_path.is_file():
        # etag matches => update metadata and return file
        if local_metadata is not None and local_metadata.etag == etag:
            write_download_metadata(local_dir=local_dir, filename=filename, commit_hash=commit_hash, etag=etag)
            if dry_run:
                return DryRunFileInfo(
                    commit_hash=commit_hash,
                    file_size=expected_size,
                    filename=filename,
                    is_cached=True,
                    local_path=str(paths.file_path),
                    will_download=False,
                )
            return str(paths.file_path)

        # metadata is outdated + etag is a sha256
        # => means it's an LFS file (large)
        # => let's compute local hash and compare
        # => if match, update metadata and return file
        if local_metadata is None and REGEX_SHA256.match(etag) is not None:
            with open(paths.file_path, "rb") as f:
                file_hash = sha_fileobj(f).hex()
            if file_hash == etag:
                write_download_metadata(local_dir=local_dir, filename=filename, commit_hash=commit_hash, etag=etag)
                if dry_run:
                    return DryRunFileInfo(
                        commit_hash=commit_hash,
                        file_size=expected_size,
                        filename=filename,
                        is_cached=True,
                        local_path=str(paths.file_path),
                        will_download=False,
                    )
                return str(paths.file_path)

    # Local file doesn't exist or etag isn't a match => retrieve file from remote (or cache)

    # If we are lucky enough, the file is already in the cache => copy it
    if not force_download:
        cached_path = try_to_load_from_cache(
            repo_id=repo_id,
            filename=filename,
            cache_dir=cache_dir,
            revision=commit_hash,
            repo_type=repo_type,
        )
        if isinstance(cached_path, str):
            with WeakFileLock(paths.lock_path):
                paths.file_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(cached_path, paths.file_path)
            write_download_metadata(local_dir=local_dir, filename=filename, commit_hash=commit_hash, etag=etag)
            if dry_run:
                return DryRunFileInfo(
                    commit_hash=commit_hash,
                    file_size=expected_size,
                    filename=filename,
                    is_cached=True,
                    local_path=str(paths.file_path),
                    will_download=False,
                )
            return str(paths.file_path)

    if dry_run:
        is_cached = paths.file_path.is_file()
        return DryRunFileInfo(
            commit_hash=commit_hash,
            file_size=expected_size,
            filename=filename,
            is_cached=is_cached,
            local_path=str(paths.file_path),
            will_download=force_download or not is_cached,
        )

    # Otherwise, let's download the file!
    with WeakFileLock(paths.lock_path):
        paths.file_path.unlink(missing_ok=True)  # delete outdated file first
        _download_to_tmp_and_move(
            incomplete_path=paths.incomplete_path(etag),
            destination_path=paths.file_path,
            url_to_download=url_to_download,
            headers=headers,
            expected_size=expected_size,
            filename=filename,
            force_download=force_download,
            etag=etag,
            xet_file_data=xet_file_data,
            tqdm_class=tqdm_class,
        )

    write_download_metadata(local_dir=local_dir, filename=filename, commit_hash=commit_hash, etag=etag)
    return str(paths.file_path)


@validate_hf_hub_args
def try_to_load_from_cache(
    repo_id: str,
    filename: str,
    cache_dir: str | Path | None = None,
    revision: str | None = None,
    repo_type: str | None = None,
) -> str | _CACHED_NO_EXIST_T | None:
    """
    Explores the cache to return the latest cached file for a given revision if found.

    This function will not raise any exception if the file in not cached.

    Args:
        cache_dir (`str` or `os.PathLike`):
            The folder where the cached files lie.
        repo_id (`str`):
            The ID of the repo on huggingface.co.
        filename (`str`):
            The filename to look for inside `repo_id`.
        revision (`str`, *optional*):
            The specific model version to use. Will default to `"main"` if it's not provided and no `commit_hash` is
            provided either.
        repo_type (`str`, *optional*):
            The type of the repository. Will default to `"model"`.

    Returns:
        `Optional[str]` or `_CACHED_NO_EXIST`:
            Will return `None` if the file was not cached. Otherwise:
            - The exact path to the cached file if it's found in the cache
            - A special value `_CACHED_NO_EXIST` if the file does not exist at the given commit hash and this fact was
              cached.

    Example:

    ```python
    from huggingface_hub import try_to_load_from_cache, _CACHED_NO_EXIST

    filepath = try_to_load_from_cache()
    if isinstance(filepath, str):
        # file exists and is cached
        ...
    elif filepath is _CACHED_NO_EXIST:
        # non-existence of file is cached
        ...
    else:
        # file is not cached
        ...
    ```
    """
    if revision is None:
        revision = "main"
    if repo_type is None:
        repo_type = "model"
    if repo_type not in constants.REPO_TYPES_WITH_KERNEL:
        raise ValueError(
            f"Invalid repo type: {repo_type}. Accepted repo types are: {str(constants.REPO_TYPES_WITH_KERNEL)}"
        )
    if cache_dir is None:
        cache_dir = constants.HF_HUB_CACHE

    repo_cache = os.path.join(cache_dir, repo_folder_name(repo_id=repo_id, repo_type=repo_type))
    if not os.path.isdir(repo_cache):
        # No cache for this model
        return None

    refs_dir = os.path.join(repo_cache, "refs")
    snapshots_dir = os.path.join(repo_cache, "snapshots")
    no_exist_dir = os.path.join(repo_cache, ".no_exist")

    # Resolve refs (for instance to convert main to the associated commit sha)
    if os.path.isdir(refs_dir):
        revision_file = os.path.join(refs_dir, revision)
        if os.path.isfile(revision_file):
            with open(revision_file) as f:
                revision = f.read()

    # Check if file is cached as "no_exist"
    if os.path.isfile(os.path.join(no_exist_dir, revision, filename)):
        return _CACHED_NO_EXIST

    # Check if revision folder exists
    if not os.path.exists(snapshots_dir):
        return None
    cached_shas = os.listdir(snapshots_dir)
    if revision not in cached_shas:
        # No cache for this revision and we won't try to return a random revision
        return None

    # Check if file exists in cache
    cached_file = os.path.join(snapshots_dir, revision, filename)
    return cached_file if os.path.isfile(cached_file) else None


@validate_hf_hub_args
def get_hf_file_metadata(
    url: str,
    token: bool | str | None = None,
    timeout: float | None = constants.HF_HUB_ETAG_TIMEOUT,
    library_name: str | None = None,
    library_version: str | None = None,
    user_agent: dict | str | None = None,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
    retry_on_errors: bool = False,
) -> HfFileMetadata:
    """Fetch metadata of a file versioned on the Hub for a given url.

    Args:
        url (`str`):
            File url, for example returned by [`hf_hub_url`].
        token (`str` or `bool`, *optional*):
            A token to be used for the download.
                - If `True`, the token is read from the HuggingFace config
                  folder.
                - If `False` or `None`, no token is provided.
                - If a string, it's used as the authentication token.
        timeout (`float`, *optional*, defaults to 10):
            How many seconds to wait for the server to send metadata before giving up.
        library_name (`str`, *optional*):
            The name of the library to which the object corresponds.
        library_version (`str`, *optional*):
            The version of the library.
        user_agent (`dict`, `str`, *optional*):
            The user-agent info in the form of a dictionary or a string.
        headers (`dict`, *optional*):
            Additional headers to be sent with the request.
        endpoint (`str`, *optional*):
            Endpoint of the Hub. Defaults to <https://huggingface.co>.
        retry_on_errors (`bool`, *optional*, defaults to `False`):
            Whether to retry on errors (429, 5xx, timeout, network errors).
            If False, no retry for fast fallback to local cache.

    Returns:
        A [`HfFileMetadata`] object containing metadata such as location, etag, size and
        commit_hash.
    """
    hf_headers = build_hf_headers(
        token=token,
        library_name=library_name,
        library_version=library_version,
        user_agent=user_agent,
        headers=headers,
    )
    hf_headers["Accept-Encoding"] = "identity"  # prevent any compression => we want to know the real size of the file

    # Retrieve metadata
    response = _httpx_follow_relative_redirects_with_backoff(
        method="HEAD", url=url, headers=hf_headers, timeout=timeout, retry_on_errors=retry_on_errors
    )
    hf_raise_for_status(response)

    # Return
    return HfFileMetadata(
        commit_hash=response.headers.get(constants.HUGGINGFACE_HEADER_X_REPO_COMMIT),
        # We favor a custom header indicating the etag of the linked resource, and we fall back to the regular etag header.
        etag=_normalize_etag(
            response.headers.get(constants.HUGGINGFACE_HEADER_X_LINKED_ETAG) or response.headers.get("ETag")
        ),
        # Either from response headers (if redirected) or defaults to request url
        # Do not use directly `url` as we might have followed relative redirects.
        location=response.headers.get("Location") or str(response.request.url),  # type: ignore
        size=_int_or_none(
            response.headers.get(constants.HUGGINGFACE_HEADER_X_LINKED_SIZE) or response.headers.get("Content-Length")
        ),
        xet_file_data=parse_xet_file_data_from_response(response, endpoint=endpoint),  # type: ignore
    )


def _get_metadata_or_catch_error(
    *,
    repo_id: str,
    filename: str,
    repo_type: str,
    revision: str,
    endpoint: str | None,
    etag_timeout: float | None,
    headers: dict[str, str],  # mutated inplace!
    token: bool | str | None,
    local_files_only: bool,
    relative_filename: str | None = None,  # only used to store `.no_exists` in cache
    storage_folder: str | None = None,  # only used to store `.no_exists` in cache
    retry_on_errors: bool = False,
    tree_cache_folder: str | None = None,  # if set, read the on-disk tree listing to skip the HEAD call
) -> (
    # Either an exception is caught and returned
    tuple[None, None, None, None, None, Exception]
    |
    # Or the metadata is returned as
    # `(url_to_download, etag, commit_hash, expected_size, xet_file_data, None)`
    tuple[str, str, str, int, XetFileData | None, None]
):
    """Get metadata for a file on the Hub, safely handling network issues.

    Returns either the etag, commit_hash and expected size of the file, or the error
    raised while fetching the metadata.

    NOTE: This function mutates `headers` inplace! It removes the `authorization` header
          if the file is a LFS blob and the domain of the url is different from the
          domain of the location (typically an S3 bucket).
    """
    if local_files_only:
        return (
            None,
            None,
            None,
            None,
            None,
            OfflineModeIsEnabled(
                f"Cannot access file since 'local_files_only=True' as been set. (repo_id: {repo_id}, repo_type: {repo_type}, revision: {revision}, filename: {filename})"
            ),
        )

    # Skip the per-file HEAD call when the file metadata can be rebuilt from a tree listing cached on disk.
    if tree_cache_folder is not None and REGEX_COMMIT_HASH.match(revision):
        tree_metadata = _xet_file_metadata_from_tree_cache(
            tree_cache_folder=tree_cache_folder,
            repo_id=repo_id,
            repo_type=repo_type,
            commit_hash=revision,
            filename=filename,
            endpoint=endpoint,
        )
        if tree_metadata is not None:
            return tree_metadata

    url = hf_hub_url(repo_id, filename, repo_type=repo_type, revision=revision, endpoint=endpoint)
    url_to_download: str = url
    etag: str | None = None
    commit_hash: str | None = None
    expected_size: int | None = None
    head_error_call: Exception | None = None
    xet_file_data: XetFileData | None = None

    # Try to get metadata from the server.
    # Do not raise yet if the file is not found or not accessible.
    if not local_files_only:
        try:
            try:
                metadata = get_hf_file_metadata(
                    url=url,
                    timeout=etag_timeout,
                    headers=headers,
                    token=token,
                    endpoint=endpoint,
                    retry_on_errors=retry_on_errors,
                )
            except RemoteEntryNotFoundError as http_error:
                if storage_folder is not None and relative_filename is not None:
                    # Cache the non-existence of the file
                    commit_hash = http_error.response.headers.get(constants.HUGGINGFACE_HEADER_X_REPO_COMMIT)
                    if commit_hash is not None:
                        no_exist_file_path = Path(storage_folder) / ".no_exist" / commit_hash / relative_filename
                        if not no_exist_file_path.exists():
                            try:
                                no_exist_file_path.parent.mkdir(parents=True, exist_ok=True)
                                no_exist_file_path.touch()
                            except OSError as e:
                                logger.error(
                                    f"Could not cache non-existence of file. Will ignore error and continue. Error: {e}"
                                )
                        _cache_commit_hash_for_specific_revision(storage_folder, revision, commit_hash)
                raise

            # Commit hash must exist
            commit_hash = metadata.commit_hash
            if commit_hash is None:
                raise FileMetadataError(
                    "Distant resource does not seem to be on huggingface.co. It is possible that a configuration issue"
                    " prevents you from downloading resources from https://huggingface.co. Please check your firewall"
                    " and proxy settings and make sure your SSL certificates are updated."
                )

            # Etag must exist
            # If we don't have any of those, raise an error.
            etag = metadata.etag
            if etag is None:
                raise FileMetadataError(
                    "Distant resource does not have an ETag, we won't be able to reliably ensure reproducibility."
                )

            # Size must exist
            expected_size = metadata.size
            if expected_size is None:
                raise FileMetadataError("Distant resource does not have a Content-Length.")

            xet_file_data = metadata.xet_file_data

            # In case of a redirect, save an extra redirect on the request.get call,
            # and ensure we download the exact atomic version even if it changed
            # between the HEAD and the GET (unlikely, but hey).
            #
            # If url domain is different => we are downloading from a CDN => url is signed => don't send auth
            # If url domain is the same => redirect due to repo rename AND downloading a regular file => keep auth
            if xet_file_data is None and url != metadata.location:
                url_to_download = metadata.location
                if urlparse(url).netloc != urlparse(metadata.location).netloc:
                    # Remove authorization header when downloading a LFS blob
                    headers.pop("authorization", None)
        except httpx.ProxyError:
            # Actually raise on proxy error
            raise
        except (httpx.ConnectError, httpx.TimeoutException, OfflineModeIsEnabled) as error:
            # Otherwise, our Internet connection is down.
            # etag is None
            head_error_call = error
        except (RevisionNotFoundError, RemoteEntryNotFoundError):
            # The repo was found but the revision or entry doesn't exist on the Hub (never existed or got deleted)
            raise
        except HfHubHTTPError as error:
            # Multiple reasons for an http error:
            # - Repository is private and invalid/missing token sent
            # - Repository is gated and invalid/missing token sent
            # - Hub is down (error 500 or 504)
            # => let's switch to 'local_files_only=True' to check if the files are already cached.
            #    (if it's not the case, the error will be re-raised)
            head_error_call = error
        except FileMetadataError as error:
            # Multiple reasons for a FileMetadataError:
            # - Wrong network configuration (proxy, firewall, SSL certificates)
            # - Inconsistency on the Hub
            # => let's switch to 'local_files_only=True' to check if the files are already cached.
            #    (if it's not the case, the error will be re-raised)
            head_error_call = error

    if not (local_files_only or etag is not None or head_error_call is not None):
        raise RuntimeError("etag is empty due to uncovered problems")

    return (url_to_download, etag, commit_hash, expected_size, xet_file_data, head_error_call)  # type: ignore


def _xet_file_metadata_from_tree_cache(
    *,
    tree_cache_folder: str,
    repo_id: str,
    repo_type: str,
    commit_hash: str,
    filename: str,
    endpoint: str | None,
) -> tuple[str, str, str, int, XetFileData, None] | None:
    """Rebuild the metadata a HEAD call would return, from the on-disk tree listing cache.

    The optimization is intentionally limited to Xet files when Xet is enabled: that's the only case where
    skipping the HEAD call pays off, since Xet downloads don't rely on the `/resolve` redirect the HEAD call
    would resolve. For regular files (or when Xet is unavailable) we return `None` and let the caller make the
    HEAD call as usual. Also returns `None` when the commit's tree listing or the file is not cached.
    """
    if not is_xet_available():
        return None
    tree_entries = read_tree_cache(tree_cache_folder, commit_hash)
    if tree_entries is None:
        return None
    entry = tree_entries.get(filename)
    if (
        entry is None
        or entry.xet_hash is None
        or not is_valid_xet_hash(entry.xet_hash)
        or entry.lfs_sha256 is None
        or entry.lfs_size is None
    ):
        return None

    xet_file_data = XetFileData(
        file_hash=entry.xet_hash,
        refresh_route=xet_connection_info_refresh_url(
            token_type=XetTokenType.READ,
            repo_id=repo_id,
            repo_type=repo_type,
            revision=commit_hash,
            endpoint=endpoint,
        ),
    )
    # Mirror the server's HEAD response: ETag/size come from the LFS metadata for LFS-tracked files (which Xet
    # files are).
    etag = entry.lfs_sha256
    file_size = entry.lfs_size
    location = hf_hub_url(repo_id, filename, repo_type=repo_type, revision=commit_hash, endpoint=endpoint)
    return (location, etag, commit_hash, file_size, xet_file_data, None)


def _raise_on_head_call_error(head_call_error: Exception, force_download: bool, local_files_only: bool) -> NoReturn:
    """Raise an appropriate error when the HEAD call failed and we cannot locate a local file."""
    # No head call => we cannot force download.
    if force_download:
        if local_files_only:
            raise ValueError("Cannot pass 'force_download=True' and 'local_files_only=True' at the same time.")
        elif isinstance(head_call_error, OfflineModeIsEnabled):
            raise ValueError("Cannot pass 'force_download=True' when offline mode is enabled.") from head_call_error
        else:
            raise ValueError("Force download failed due to the above error.") from head_call_error

    # No head call + couldn't find an appropriate file on disk => raise an error.
    if local_files_only:
        raise LocalEntryNotFoundError(
            "Cannot find the requested files in the disk cache and outgoing traffic has been disabled. To enable"
            " hf.co look-ups and downloads online, set 'local_files_only' to False."
        )
    elif isinstance(head_call_error, (RepositoryNotFoundError, GatedRepoError)) or (
        isinstance(head_call_error, HfHubHTTPError) and head_call_error.response.status_code == 401
    ):
        # Repo not found or gated => let's raise the actual error
        # Unauthorized => likely a token issue => let's raise the actual error
        raise head_call_error
    else:
        # Otherwise: most likely a connection issue or Hub downtime => let's warn the user
        raise LocalEntryNotFoundError(
            "An error happened while trying to locate the file on the Hub and we cannot find the requested files"
            " in the local cache. Please check your connection and try again or make sure your Internet connection"
            " is on."
        ) from head_call_error


def _download_to_tmp_and_move(
    incomplete_path: Path,
    destination_path: Path,
    url_to_download: str,
    headers: dict[str, str],
    expected_size: int | None,
    filename: str,
    force_download: bool,
    etag: str | None,
    xet_file_data: XetFileData | None,
    tqdm_class: type[base_tqdm] | None = None,
) -> None:
    """Download content from a URL to a destination path.

    Internal logic:
    - return early if file is already downloaded
    - check disk space before downloading
    - download content to a process-unique temporary file
    - set correct permissions on temporary file
    - move the temporary file to the destination path

    Both `incomplete_path` and `destination_path` must be on the same volume to avoid a local copy.
    """
    if destination_path.exists() and not force_download:
        # Do nothing if already exists (except if force_download=True)
        return

    # Download to a process-unique temporary file before moving it in place. A shared
    # `<etag>.incomplete` file corrupts the cache whenever the surrounding lock is not honored:
    # on some filesystems (Lustre, GPFS, some NFS mounts) `flock(2)` silently succeeds for every
    # caller and concurrent processes end up appending to the same file. With a unique file per
    # process, a broken lock costs only duplicated bandwidth: each process downloads the full
    # file and atomically renames it to the final destination.
    # See https://github.com/huggingface/huggingface_hub/pull/4228.
    tmp_path = incomplete_path.with_name(f"{incomplete_path.stem}.{uuid.uuid4().hex[:8]}.incomplete")
    try:
        with tmp_path.open("wb") as f:
            logger.debug(f"Downloading '{filename}' to '{tmp_path}'")

            if expected_size is not None:  # might be None if HTTP header not set correctly
                # Check disk space in both tmp and destination path
                _check_disk_space(expected_size, tmp_path.parent)
                _check_disk_space(expected_size, destination_path.parent)

            if xet_file_data is not None and is_xet_available():
                logger.debug("Xet Storage is enabled for this repo. Downloading file from Xet Storage..")
                xet_get(
                    incomplete_path=tmp_path,
                    xet_file_data=xet_file_data,
                    headers=headers,
                    expected_size=expected_size,
                    displayed_filename=filename,
                    tqdm_class=tqdm_class,
                )
            else:
                if xet_file_data is not None and not constants.HF_HUB_DISABLE_XET:
                    logger.warning(
                        "Xet Storage is enabled for this repo, but the 'hf_xet' package is not installed. "
                        "Falling back to regular HTTP download. "
                        "For better performance, install the package with: `pip install huggingface_hub[hf_xet]` or `pip install hf_xet`"
                    )

                http_get(
                    url_to_download,
                    f,
                    headers=headers,
                    expected_size=expected_size,
                    tqdm_class=tqdm_class,
                )

        logger.debug(f"Download complete. Moving file to {destination_path}")
        _chmod_and_move(tmp_path, destination_path)
    finally:
        # No-op on success (file has been moved). On failure, do not keep a partial file around:
        # it could not be reused anyway since the temporary name is unique to this download.
        tmp_path.unlink(missing_ok=True)


def _int_or_none(value: str | None) -> int | None:
    try:
        return int(value)  # type: ignore
    except (TypeError, ValueError):
        return None


def _chmod_and_move(src: Path, dst: Path) -> None:
    """Set correct permission before moving a blob from tmp directory to cache dir.

    Do not take into account the `umask` from the process as there is no convenient way
    to get it that is thread-safe.

    See:
    - About umask: https://docs.python.org/3/library/os.html#os.umask
    - Thread-safety: https://stackoverflow.com/a/70343066
    - About solution: https://github.com/huggingface/huggingface_hub/pull/1220#issuecomment-1326211591
    - Fix issue: https://github.com/huggingface/huggingface_hub/issues/1141
    - Fix issue: https://github.com/huggingface/huggingface_hub/issues/1215
    """
    # Get umask by creating a temporary file in the folder containing the incomplete file.
    # We know this folder is writable since the incomplete file has just been written there.
    # Probing next to `dst` is not always possible: when downloading to a local dir, `dst` is the
    # final file location and its parents might not be writable (e.g. read-only root filesystem).
    # See https://github.com/huggingface/huggingface_hub/issues/4304.
    tmp_file = src.parent / f"tmp_{uuid.uuid4()}"
    try:
        tmp_file.touch()
        cache_dir_mode = Path(tmp_file).stat().st_mode
        os.chmod(str(src), stat.S_IMODE(cache_dir_mode))
    except OSError as e:
        logger.warning(
            f"Could not set the permissions on the file '{src}'. Error: {e}.\nContinuing without setting permissions."
        )
    finally:
        try:
            tmp_file.unlink()
        except OSError:
            # fails if `tmp_file.touch()` failed => do nothing
            # See https://github.com/huggingface/huggingface_hub/issues/2359
            pass

    shutil.move(str(src), str(dst), copy_function=_copy_no_matter_what)


def _copy_no_matter_what(src: str, dst: str) -> None:
    """Copy file from src to dst.

    If `shutil.copy2` fails, fallback to `shutil.copyfile`.
    """
    try:
        # Copy file with metadata and permission
        # Can fail e.g. if dst is an S3 mount
        shutil.copy2(src, dst)
    except OSError:
        # Copy only file content
        shutil.copyfile(src, dst)


def _get_pointer_path(storage_folder: str, revision: str, relative_filename: str) -> str:
    # Using `os.path.abspath` instead of `Path.resolve()` to avoid resolving symlinks
    snapshot_path = os.path.join(storage_folder, "snapshots")
    pointer_path = os.path.join(snapshot_path, revision, relative_filename)
    if Path(os.path.abspath(snapshot_path)) not in Path(os.path.abspath(pointer_path)).parents:
        raise ValueError(
            "Invalid pointer path: cannot create pointer path in snapshot folder if"
            f" `storage_folder='{storage_folder}'`, `revision='{revision}'` and"
            f" `relative_filename='{relative_filename}'`."
        )
    return pointer_path
