import os
import re
import threading
from dataclasses import dataclass
from enum import Enum

import httpx

from .. import constants
from . import validate_hf_hub_args


_REGEX_XET_HASH = re.compile(r"^[0-9a-fA-F]{64}$")


def is_valid_xet_hash(xet_hash: str) -> bool:
    """Return whether `xet_hash` looks like a real Xet content hash (64 hex chars)."""
    return bool(_REGEX_XET_HASH.fullmatch(xet_hash))


class XetTokenType(str, Enum):
    READ = "read"
    WRITE = "write"


@dataclass(frozen=True)
class XetFileData:
    file_hash: str
    refresh_route: str


def parse_xet_file_data_from_response(response: httpx.Response, endpoint: str | None = None) -> XetFileData | None:
    """
    Parse XET file metadata from an HTTP response.

    This function extracts XET file metadata from the HTTP headers or HTTP links
    of a given response object. If the required metadata is not found, it returns `None`.

    Args:
        response (`httpx.Response`):
            The HTTP response object containing headers dict and links dict to extract the XET metadata from.
    Returns:
        `Optional[XetFileData]`:
            An instance of `XetFileData` containing the file hash and refresh route if the metadata
            is found. Returns `None` if the required metadata is missing.
    """
    if response is None:
        return None
    try:
        file_hash = response.headers[constants.HUGGINGFACE_HEADER_X_XET_HASH]

        if constants.HUGGINGFACE_HEADER_LINK_XET_AUTH_KEY in response.links:
            refresh_route = response.links[constants.HUGGINGFACE_HEADER_LINK_XET_AUTH_KEY]["url"]
        else:
            refresh_route = response.headers[constants.HUGGINGFACE_HEADER_X_XET_REFRESH_ROUTE]
    except KeyError:
        return None
    endpoint = endpoint if endpoint is not None else constants.ENDPOINT
    if refresh_route.startswith(constants.HUGGINGFACE_CO_URL_HOME):
        refresh_route = refresh_route.replace(constants.HUGGINGFACE_CO_URL_HOME.rstrip("/"), endpoint.rstrip("/"))
    return XetFileData(
        file_hash=file_hash,
        refresh_route=refresh_route,
    )


@validate_hf_hub_args
def xet_connection_info_refresh_url(
    *,
    token_type: XetTokenType,
    repo_id: str,
    repo_type: str,
    revision: str | None = None,
    endpoint: str | None = None,
) -> str:
    """
    Build the URL used to fetch or refresh a Xet access token for a given repo.
    Args:
        token_type (`XetTokenType`):
            Type of the token to request: `"read"` or `"write"`.
        repo_id (`str`):
            A namespace (user or an organization) and a repo name separated by a `/`.
        repo_type (`str`):
            Type of the repo (e.g. `"model"`, `"dataset"`, `"space"`, `"bucket"`).
        revision (`str`, `optional`):
            The revision of the repo to get the token for.
        endpoint (`str`, `optional`):
            The endpoint to use for the request. Defaults to the Hub endpoint.
    Returns:
        `str`:
            The fully-qualified URL of the token refresh endpoint.
    """
    endpoint = endpoint if endpoint is not None else constants.ENDPOINT
    url = f"{endpoint}/api/{repo_type}s/{repo_id}/xet-{token_type.value}-token"
    if repo_type != "bucket" or revision is not None:
        # On "bucket" repo type, the revision never needed => don't use it
        # Otherwise, use the revision.
        # Note: when creating a PR on a git-based repo, user needs write access but they don't know the revision in advance.
        # => pass "/None" in URL and server will return a token for PR refs.
        url += f"/{revision}"
    return url


class XetSessionHolder:
    """Holds an optional XetSession; supports safe re-creation after sigint_abort or fork.

    Thread-safe: a ``threading.Lock`` guards all state mutations, which matters
    for free-threaded Python (3.14t) where multiple threads can race on ``get()``
    or ``sigint_abort()`` without the GIL serialising them.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._session = None
        self._session_pid: int | None = None

    def get(self):
        """Return the current session, creating one if needed.

        Fork-safe: if the current process PID differs from the PID that created
        the session (i.e. we are in a forked child), the old session is discarded
        and a fresh session is created for this process.
        """
        with self._lock:
            current_pid = os.getpid()

            if self._session is not None and self._session_pid != current_pid:
                # Fork detected. Discard the parent's session; the Rust Drop will
                # call discard_runtime() (std::mem::forget) rather than the normal
                # shutdown path, so this returns immediately without blocking.
                self._session = None

            if self._session is None:
                from hf_xet import XetSession

                self._session = XetSession()
                self._session_pid = current_pid

            return self._session

    def sigint_abort(self):
        """Abort the current session and clear it so the next get() creates a fresh one."""
        with self._lock:
            if self._session is not None:
                try:
                    self._session.sigint_abort()
                except Exception:
                    pass
                self._session = None
                self._session_pid = None


_GLOBAL_XET_HOLDER = XetSessionHolder()


def get_xet_session():
    """Return the global :class:`hf_xet.XetSession`, creating it on first call.

    The session is shared across all calls within a process, just as the HTTP
    client returned by :func:`~huggingface_hub.utils._http.get_session` is shared.
    It is created lazily and is fork-safe and thread-safe.
    """
    return _GLOBAL_XET_HOLDER.get()


def xet_headers_without_auth(headers: dict[str, str]) -> dict[str, str]:
    """Return a copy of headers with the authorization header removed.

    Xet storage requests use a short-lived xet access token for auth, so the
    Hub authorization header must not be forwarded to xet storage endpoints.
    """
    return {key: value for key, value in headers.items() if key.lower() != "authorization"}


def abort_xet_session():
    """Abort the global xet session after a KeyboardInterrupt.

    Cancels any in-flight Rust operation and clears the session so the next
    call to :func:`get_xet_session` starts fresh (notebook-friendly).
    """
    _GLOBAL_XET_HOLDER.sigint_abort()
