# Copyright 2023 The HuggingFace Team. All rights reserved.
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
"""Contains a helper to get the token from machine (env variable, secret or config file)."""

import configparser
import io
import logging
import os
import time
import warnings
from pathlib import Path
from threading import Lock
from typing import TypedDict

from .. import constants
from ..errors import DeviceCodeError, OAuthErrorCode, OIDCError
from ._fixes import WeakFileLock
from ._oauth_device import refresh_access_token
from ._runtime import is_colab_enterprise, is_google_colab


_SECRET_FILE_MODE = 0o600
_SECRET_DIR_MODE = 0o700


def _write_secret(path: Path, content: str) -> None:
    """Write content to file, restricting both the file and its parent directory to owner-only on POSIX systems."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=_SECRET_DIR_MODE)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, _SECRET_FILE_MODE)
    with os.fdopen(fd, "w") as f:
        f.write(content)
    try:
        path.chmod(_SECRET_FILE_MODE)
        path.parent.chmod(_SECRET_DIR_MODE)
    except (OSError, NotImplementedError):
        # Windows does not support POSIX modes; chmod() will raise. Best-effort.
        pass


_IS_GOOGLE_COLAB_CHECKED = False
_GOOGLE_COLAB_SECRET_LOCK = Lock()
_GOOGLE_COLAB_SECRET: str | None = None

logger = logging.getLogger(__name__)


def get_token() -> str | None:
    """
    Get token if user is logged in.

    Note: in most cases, you should use [`huggingface_hub.utils.build_hf_headers`] instead. This method is only useful
          if you want to retrieve the token for other purposes than sending an HTTP request.

    If `HF_OIDC_RESOURCE` is set (Trusted Publishers, typically in CI), a short-lived token obtained via OIDC token
    exchange takes precedence. Otherwise the token is retrieved from the `HF_TOKEN` environment variable, then from the
    token file in the Hugging Face home folder. Returns None if user is not logged in. To log in, use [`login`] or
    `hf auth login`.

    OAuth tokens obtained with the browser-based login come with a refresh token: when such a token is close to
    expiry, it is transparently refreshed and persisted before being returned.

    Note: if `HF_OIDC_RESOURCE` is set but the OIDC token exchange fails, this raises instead of returning `None`,
    opting into OIDC is explicit, so a failure surfaces as a clear error rather than a silent fallback.

    Returns:
        `str` or `None`: The token, `None` if it doesn't exist.
    """
    return (
        _get_token_from_oidc()
        or _get_token_from_environment()
        or _get_token_from_file_refreshed()
        or _get_token_from_google_colab()
    )


def _get_token_from_google_colab() -> str | None:
    """Get token from Google Colab secrets vault using `google.colab.userdata.get(...)`.

    Token is read from the vault only once per session and then stored in a global variable to avoid re-requesting
    access to the vault.
    """
    # If it's not a Google Colab or it's Colab Enterprise, fallback to environment variable or token file authentication
    if not is_google_colab() or is_colab_enterprise():
        return None

    # `google.colab.userdata` is not thread-safe
    # This can lead to a deadlock if multiple threads try to access it at the same time
    # (typically when using `snapshot_download`)
    # => use a lock
    # See https://github.com/huggingface/huggingface_hub/issues/1952 for more details.
    with _GOOGLE_COLAB_SECRET_LOCK:
        global _GOOGLE_COLAB_SECRET
        global _IS_GOOGLE_COLAB_CHECKED

        if _IS_GOOGLE_COLAB_CHECKED:  # request access only once
            return _GOOGLE_COLAB_SECRET

        try:
            from google.colab import userdata  # type: ignore
            from google.colab.errors import Error as ColabError  # type: ignore
        except ImportError:
            return None

        try:
            token = userdata.get("HF_TOKEN")
            _GOOGLE_COLAB_SECRET = _clean_token(token)
        except userdata.NotebookAccessError:
            # Means the user has a secret call `HF_TOKEN` and got a popup "please grand access to HF_TOKEN" and refused it
            # => warn user but ignore error => do not re-request access to user
            warnings.warn(
                "\nAccess to the secret `HF_TOKEN` has not been granted on this notebook."
                "\nYou will not be requested again."
                "\nPlease restart the session if you want to be prompted again."
            )
            _GOOGLE_COLAB_SECRET = None
        except userdata.SecretNotFoundError:
            # No `HF_TOKEN` secret defined: simply not logged in via the Colab vault. Not worth a
            # warning now that `login()` is the primary flow (it would even fire during `login()`
            # itself, telling the user to set up a secret while they are busy authenticating).
            logger.info(
                "The secret `HF_TOKEN` does not exist in your Colab secrets. Run `huggingface_hub.login()` to"
                " authenticate (recommended but still optional to access public models or datasets)."
            )
            _GOOGLE_COLAB_SECRET = None
        except ColabError as e:
            # Something happen but we don't know what => recommend to open a GitHub issue
            warnings.warn(f"\nError while fetching `HF_TOKEN` secret value from your vault: '{str(e)}'.")
            _GOOGLE_COLAB_SECRET = None

        _IS_GOOGLE_COLAB_CHECKED = True
        return _GOOGLE_COLAB_SECRET


def _get_token_from_environment() -> str | None:
    # `HF_TOKEN` has priority (keep `HUGGING_FACE_HUB_TOKEN` for backward compatibility)
    return _clean_token(os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"))


def _get_token_from_file() -> str | None:
    try:
        return _clean_token(Path(constants.HF_TOKEN_PATH).read_text())
    except FileNotFoundError:
        return None


class _OidcTokenCache(TypedDict):
    resource: str
    token: str
    expires_at: float  # monotonic clock value after which the cached token must be re-exchanged


# Cache for the OIDC-exchanged token: re-exchanging on every `get_token()` call would be wasteful,
# and re-exchanging shortly before expiry transparently keeps long-running jobs authenticated.
_OIDC_TOKEN_LOCK = Lock()
_OIDC_TOKEN_CACHE: _OidcTokenCache | None = None
_OIDC_REFRESH_MARGIN = 300  # re-exchange this many seconds before the token actually expires


def _get_token_from_oidc() -> str | None:
    """Get a short-lived OIDC token in CI (Trusted Publishers).

    Enabled by setting `HF_OIDC_RESOURCE`, which scopes the token to a repo or user.
    The ID token is read from `HF_OIDC_ID_TOKEN` if available, or minted from a supported CI provider (e.g. GitHub Actions).

    Returns `None` when OIDC is not enabled.
    If enabled, any failure is raised explicitly rather than falling back silently.

    See `huggingface_hub._oidc` and https://huggingface.co/docs/hub/trusted-publishers.
    """
    resource = os.environ.get("HF_OIDC_RESOURCE")
    if not resource:
        return None

    from .._oidc import detect_provider, oidc_login

    global _OIDC_TOKEN_CACHE
    with _OIDC_TOKEN_LOCK:
        now = time.monotonic()
        if (
            _OIDC_TOKEN_CACHE is not None
            and _OIDC_TOKEN_CACHE["resource"] == resource
            and now < _OIDC_TOKEN_CACHE["expires_at"]
        ):
            return _OIDC_TOKEN_CACHE["token"]

        # An explicit id token (any provider) takes precedence; otherwise mint from a detected one.
        subject_token = os.environ.get("HF_OIDC_ID_TOKEN") or None
        if subject_token is None and detect_provider() is None:
            raise OIDCError(
                "HF_OIDC_RESOURCE is set but no OIDC id token is available: not running in a supported "
                "CI provider (github) and HF_OIDC_ID_TOKEN is not set. Set HF_OIDC_ID_TOKEN to the id "
                "token minted by your CI provider, or unset HF_OIDC_RESOURCE."
            )

        result = oidc_login(resource=resource, subject_token=subject_token)
        token = result["access_token"]
        expires_in = int(result.get("expires_in", 3600))
        # A pre-supplied HF_OIDC_ID_TOKEN can't be re-minted, so refreshing early is pointless (the id
        # token is likely already expired by then): cache for the full lifetime. Only the auto-minted
        # path can refresh, so only it gets the safety margin.
        margin = 0 if subject_token is not None else _OIDC_REFRESH_MARGIN
        _OIDC_TOKEN_CACHE = {
            "resource": resource,
            "token": token,
            "expires_at": now + max(expires_in - margin, 0),
        }
        return token


class _OAuthRefreshCache(TypedDict):
    file_token: str  # token as read from HF_TOKEN_PATH (cache key)
    resolved_token: str  # token to return (refreshed, or identical if no refresh was needed)
    recheck_at: float  # wall-clock timestamp after which the expiry must be re-evaluated


# Cache the refresh decision in-process: `get_token()` is called on every HTTP request and must not
# re-read the stored tokens file (let alone hit the network) each time.
_OAUTH_REFRESH_LOCK = Lock()
_OAUTH_REFRESH_CACHE: _OAuthRefreshCache | None = None
_OAUTH_REFRESH_MARGIN = 24 * 3600  # refresh when less than 1 day of validity remains
_OAUTH_RECHECK_INTERVAL = 300  # re-check interval when there is no metadata or the refresh failed
_OAUTH_REFRESH_WARNED = False  # warn at most once per process on refresh failure


def _get_token_from_file_refreshed() -> str | None:
    """Get the token from `HF_TOKEN_PATH`, transparently refreshing it if close to expiry."""
    token = _get_token_from_file()
    if token is None:
        return None
    return _refresh_oauth_token_if_needed(token)


def _refresh_oauth_token_if_needed(token: str) -> str:
    """Refresh an OAuth access token if it is close to expiry. Best-effort: never raises.

    OAuth tokens obtained with the browser-based login are stored with a `refresh_token` and an
    `expires_at` timestamp (see `_save_token`). When the active token is one of them and about to
    expire, exchange the refresh token for a new access token and persist it. Any other token is
    returned unchanged.
    """
    global _OAUTH_REFRESH_CACHE
    with _OAUTH_REFRESH_LOCK:
        now = time.time()
        cache = _OAUTH_REFRESH_CACHE
        if cache is not None and cache["file_token"] == token and now < cache["recheck_at"]:
            return cache["resolved_token"]

        token_name, fields = next(
            ((name, fields) for name, fields in _read_stored_tokens_full().items() if fields.get("hf_token") == token),
            (None, {}),
        )
        refresh_token = fields.get("refresh_token")
        expires_at = _parse_expires_at(fields)
        if token_name is None or refresh_token is None or expires_at is None:
            # `token` may have just been replaced by a concurrent refresh (in which case it no
            # longer appears in the stored tokens): serve the fresh file token without caching.
            current_file_token = _get_token_from_file()
            if current_file_token is not None and current_file_token != token:
                return current_file_token
            # Not a refreshable OAuth token (or its metadata was lost): nothing to do.
            _OAUTH_REFRESH_CACHE = {
                "file_token": token,
                "resolved_token": token,
                "recheck_at": now + _OAUTH_RECHECK_INTERVAL,
            }
            return token

        if expires_at - _OAUTH_REFRESH_MARGIN > now:
            _OAUTH_REFRESH_CACHE = {
                "file_token": token,
                "resolved_token": token,
                "recheck_at": expires_at - _OAUTH_REFRESH_MARGIN,
            }
            return token

        try:
            # Cross-process file lock: if the server rotates refresh tokens, two processes
            # refreshing concurrently would invalidate each other's refresh token.
            with WeakFileLock(constants.HF_STORED_TOKENS_PATH + ".lock", timeout=30):
                # Re-read under the lock: another process may have refreshed in the meantime.
                fields = _read_stored_tokens_full().get(token_name, {})
                if fields.get("hf_token") != token:
                    # Another process already refreshed this token: adopt its result.
                    new_token = fields.get("hf_token") or token
                    new_expires_at = _parse_expires_at(fields)
                else:
                    response = refresh_access_token(refresh_token)
                    new_token = response["access_token"]
                    new_expires_at = int(now) + int(response["expires_in"]) if "expires_in" in response else None
                    _save_token(
                        token=new_token,
                        token_name=token_name,
                        # The server may rotate the refresh token; keep the old one if it doesn't.
                        refresh_token=response.get("refresh_token") or refresh_token,
                        expires_at=new_expires_at,
                    )
                    # Update the active token file, unless another process switched to a different token meanwhile.
                    if _get_token_from_file() == token:
                        _write_secret(Path(constants.HF_TOKEN_PATH), new_token)
                    logger.info(f"Access token `{token_name}` has been refreshed.")
        except Exception as e:
            if isinstance(e, DeviceCodeError) and e.error_code == OAuthErrorCode.INVALID_GRANT:
                # Refresh token expired or revoked: retrying is pointless, a re-login is required.
                # Warned unconditionally (the inf recheck guarantees it fires at most once): an
                # earlier transient warning must not suppress this actionable message.
                logger.warning(
                    "Your Hugging Face access token has expired and could not be refreshed "
                    f"(session expired or revoked). Run `hf auth login` to re-authenticate. ({e})"
                )
                recheck_at = float("inf")
            else:
                # Transient failure (offline, server error, ...): retry later.
                _warn_refresh_failure_once(f"Could not refresh your Hugging Face access token: {e}. Will retry later.")
                recheck_at = now + _OAUTH_RECHECK_INTERVAL
            # Return the existing token: if it's truly expired, the API will reject it with a clear error.
            _OAUTH_REFRESH_CACHE = {"file_token": token, "resolved_token": token, "recheck_at": recheck_at}
            return token

        _OAUTH_REFRESH_CACHE = {
            "file_token": new_token,
            "resolved_token": new_token,
            # The floor guards against a token lifetime shorter than the refresh margin, which
            # would otherwise put `recheck_at` in the past and trigger a refresh on every call.
            "recheck_at": max(
                now + _OAUTH_RECHECK_INTERVAL,
                new_expires_at - _OAUTH_REFRESH_MARGIN if new_expires_at else 0,
            ),
        }
        return new_token


def _warn_refresh_failure_once(message: str) -> None:
    global _OAUTH_REFRESH_WARNED
    if not _OAUTH_REFRESH_WARNED:
        logger.warning(message)
        _OAUTH_REFRESH_WARNED = True


def _parse_expires_at(fields: dict[str, str]) -> int | None:
    """Parse the `expires_at` field of a stored-tokens section, `None` if missing or corrupt."""
    try:
        return int(fields["expires_at"])
    except (KeyError, ValueError):
        return None


def get_stored_tokens() -> dict[str, str]:
    """
    Returns the parsed INI file containing the access tokens.
    The file is located at `HF_STORED_TOKENS_PATH`, defaulting to `~/.cache/huggingface/stored_tokens`.
    If the file does not exist, an empty dictionary is returned.

    Returns: `dict[str, str]`
        Key is the token name and value is the token.
    """
    return {token_name: fields.get("hf_token", "") for token_name, fields in _read_stored_tokens_full().items()}


def _read_stored_tokens_full() -> dict[str, dict[str, str]]:
    """Read all sections of the stored tokens INI file, with all their fields.

    Beside `hf_token`, sections for OAuth tokens also carry `refresh_token` and `expires_at`
    (unix timestamp), used by [`get_token`] to transparently refresh them.
    """
    tokens_path = Path(constants.HF_STORED_TOKENS_PATH)
    if not tokens_path.exists():
        return {}
    # interpolation=None: token values are opaque strings, a `%` must not be interpreted.
    config = configparser.ConfigParser(interpolation=None)
    try:
        config.read(tokens_path)
        return {token_name: dict(config.items(token_name)) for token_name in config.sections()}
    except configparser.Error as e:
        logger.error(f"Error parsing stored tokens file: {e}")
        return {}


def _save_stored_tokens_full(stored_tokens: dict[str, dict[str, str]]) -> None:
    """Write all sections and their fields to the stored tokens INI file."""
    config = configparser.ConfigParser(interpolation=None)
    for token_name in sorted(stored_tokens.keys()):
        config.add_section(token_name)
        for key, value in stored_tokens[token_name].items():
            config.set(token_name, key, value)

    buf = io.StringIO()
    config.write(buf)
    _write_secret(Path(constants.HF_STORED_TOKENS_PATH), buf.getvalue())


def _get_token_by_name(token_name: str) -> str | None:
    """
    Get the token by name.

    Args:
        token_name (`str`):
            The name of the token to get.

    Returns:
        `str` or `None`: The token, `None` if it doesn't exist.

    """
    stored_tokens = get_stored_tokens()
    if token_name not in stored_tokens:
        return None
    return _clean_token(stored_tokens[token_name])


def _save_token(
    token: str, token_name: str, *, refresh_token: str | None = None, expires_at: int | None = None
) -> None:
    """
    Save the given token.

    If the stored tokens file does not exist, it will be created.
    Args:
        token (`str`):
            The token to save.
        token_name (`str`):
            The name of the token.
        refresh_token (`str`, *optional*):
            OAuth refresh token used to renew the access token when it expires.
        expires_at (`int`, *optional*):
            Unix timestamp at which the access token expires.
    """
    stored_tokens = _read_stored_tokens_full()
    fields = {"hf_token": token}
    if refresh_token is not None:
        fields["refresh_token"] = refresh_token
    if expires_at is not None:
        fields["expires_at"] = str(expires_at)
    # Replace the whole section: re-logging in under the same name must drop stale metadata.
    stored_tokens[token_name] = fields
    _save_stored_tokens_full(stored_tokens)
    logger.info(f"The token `{token_name}` has been saved to {constants.HF_STORED_TOKENS_PATH}")


def _clean_token(token: str | None) -> str | None:
    """Clean token by removing trailing and leading spaces and newlines.

    If token is an empty string, return None.
    """
    if token is None:
        return None
    return token.replace("\r", "").replace("\n", "").strip() or None
