# Copyright 2020 The HuggingFace Team. All rights reserved.
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
"""Contains methods to log in to the Hub."""

import html
import os
import subprocess
import sys
import time
from datetime import datetime
from getpass import getpass
from pathlib import Path

from . import constants
from .errors import DeviceCodeError
from .utils import (
    ANSI,
    get_token,
    is_google_colab,
    is_notebook,
    list_credential_helpers,
    logging,
    run_subprocess,
    select_choice,
    set_git_credential,
    tabulate,
    unset_git_credential,
)
from .utils._auth import (
    _get_token_by_name,
    _get_token_from_environment,
    _get_token_from_file,
    _get_token_from_google_colab,
    _read_stored_tokens_full,
    _save_stored_tokens_full,
    _save_token,
    _write_secret,
    get_stored_tokens,
)
from .utils._oauth_device import OAuthTokenResponse, poll_device_token, request_device_code


logger = logging.get_logger(__name__)


def login(
    token: str | None = None,
    *,
    add_to_git_credential: bool = False,
    skip_if_logged_in: bool = True,
) -> None:
    """Login the machine to access the Hub.

    The `token` is persisted in cache and set as a git credential. Once done, the machine
    is logged in and the access token will be available across all `huggingface_hub`
    components. If `token` is not provided, a browser-based OAuth flow is used to
    authenticate: open a URL, enter a short code, and the token is retrieved and saved.
    In a terminal, you can also choose to paste an existing access token instead.

    To log in from outside of a script, one can also use `hf auth login` which is
    a cli command that wraps [`login`].

    > [!TIP]
    > When the token is not passed, [`login`] will automatically detect if the script runs
    > in a notebook or not. However, this detection might not be accurate due to the
    > variety of notebooks that exists nowadays. If that is the case, you can always force
    > the UI by using [`notebook_login`] or [`interpreter_login`].

    Args:
        token (`str`, *optional*):
            User access token to generate from https://huggingface.co/settings/token.
        add_to_git_credential (`bool`, defaults to `False`):
            If `True`, token will be set as git credential. If no git credential helper
            is configured, a warning will be displayed to the user. Only used when `token`
            is provided; ignored by the browser-based flow.
        skip_if_logged_in (`bool`, defaults to `True`):
            If `True`, do not prompt for token if user is already logged in.
            Set to `False` to force re-login. In CLI, use `--force` instead.
    Raises:
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If an organization token is passed. Only personal account tokens are valid
            to log in.
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError)
            If token is invalid.
        [`DeviceCodeError`]
            If the browser-based login fails (authorization denied, code expired, ...).
    """
    if token is not None:
        if not add_to_git_credential:
            logger.info(
                "The token has not been saved to the git credentials helper. Pass "
                "`add_to_git_credential=True` in this function directly or "
                "`--add-to-git-credential` if using via `hf`CLI if "
                "you want to set the git credential as well."
            )
        _validate_and_save_token(token, add_to_git_credential=add_to_git_credential)
        return
    if add_to_git_credential:
        logger.warning(
            "`add_to_git_credential=True` is only supported when a token is passed directly. "
            "It is ignored by the browser-based login."
        )
    if is_notebook():
        notebook_login(skip_if_logged_in=skip_if_logged_in)
    else:
        interpreter_login(skip_if_logged_in=skip_if_logged_in)


def logout(token_name: str | None = None) -> None:
    """Logout the machine from the Hub.

    Token is deleted from the machine and removed from git credential.

    Args:
        token_name (`str`, *optional*):
            Name of the access token to logout from. If `None`, will log out from all saved access tokens.
    Raises:
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError):
            If the access token name is not found.
    """
    if get_token() is None and not get_stored_tokens():  # No active token and no saved access tokens
        logger.warning("Not logged in!")
        return
    if not token_name:
        # Delete all saved access tokens and token
        for file_path in (constants.HF_TOKEN_PATH, constants.HF_STORED_TOKENS_PATH):
            try:
                Path(file_path).unlink()
            except FileNotFoundError:
                pass
        logger.info("Successfully logged out from all access tokens.")
    else:
        _logout_from_token(token_name)
        logger.info(f"Successfully logged out from access token: {token_name}.")

    unset_git_credential()

    # Check if still logged in
    if _get_token_from_google_colab() is not None:
        raise OSError(
            "You are automatically logged in using a Google Colab secret.\n"
            "To log out, you must unset the `HF_TOKEN` secret in your Colab settings."
        )
    if _get_token_from_environment() is not None:
        raise OSError(
            "Token has been deleted from your machine but you are still logged in.\n"
            "To log out, you must clear out both `HF_TOKEN` and `HUGGING_FACE_HUB_TOKEN` environment variables."
        )


def auth_switch(token_name: str, add_to_git_credential: bool = False) -> None:
    """Switch to a different access token.

    Args:
        token_name (`str`):
            Name of the access token to switch to.
        add_to_git_credential (`bool`, defaults to `False`):
            If `True`, token will be set as git credential. If no git credential helper
            is configured, a warning will be displayed to the user. If `token` is `None`,
            the value of `add_to_git_credential` is ignored and will be prompted again
            to the end user.

    Raises:
        [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError):
            If the access token name is not found.
    """
    token = _get_token_by_name(token_name)
    if not token:
        raise ValueError(f"Access token {token_name} not found in {constants.HF_STORED_TOKENS_PATH}")
    # Write token to HF_TOKEN_PATH
    _set_active_token(token_name, add_to_git_credential)
    logger.info(f"The current active token is: {token_name}")
    token_from_environment = _get_token_from_environment()
    if token_from_environment is not None and token_from_environment != token:
        logger.warning(
            "The environment variable `HF_TOKEN` is set and will override the access token you've just switched to."
        )


def auth_list() -> None:
    """List all stored access tokens."""
    # Resolve the current token before reading the file: `get_token()` may refresh an OAuth
    # token and rewrite the stored tokens on the way.
    current_token = get_token()
    stored_tokens = _read_stored_tokens_full()

    if not stored_tokens:
        if _get_token_from_environment():
            logger.info("No stored access tokens found.")
            logger.warning("Note: Environment variable `HF_TOKEN` is set and is the current active token.")
        else:
            logger.info("No access tokens found.")
        return
    show_expires = any("expires_at" in fields for fields in stored_tokens.values())
    headers = [" ", "name", "token"] + (["expires"] if show_expires else [])

    current_token_name = None
    rows: list[list[str | int]] = []
    for token_name, fields in stored_tokens.items():
        token = fields.get("hf_token", "<not set>")
        if token == current_token:
            current_token_name = token_name
        masked_token = f"{token[:3]}****{token[-4:]}" if token != "<not set>" else token
        row: list[str | int] = ["*" if token == current_token else "", token_name, masked_token]
        if show_expires:
            row.append(_format_expiration(fields.get("expires_at")))
        rows.append(row)
    print(tabulate(rows, headers=headers))

    if _get_token_from_environment():
        logger.warning(
            "\nNote: Environment variable `HF_TOKEN` is set and is the current active token independently from the stored tokens listed above."
        )
    elif current_token_name is None:
        logger.warning(
            "\nNote: No active token is set and no environment variable `HF_TOKEN` is found. Use `hf auth login` to log in."
        )


###
# Device Code OAuth login (RFC 8628)
###


def _device_code_login() -> None:
    """Run the Device Code OAuth flow: request a code, prompt the user to authorize it in a browser,
    poll for the token and save it."""
    device_info = request_device_code()

    # The complete URI has the code pre-filled when the server supports it.
    print(f"\n    Open this URL in your browser:\n        {device_info['verification_uri_complete']}\n")
    print(f"    And enter the code: {device_info['user_code']}\n")

    print("    Waiting for authorization", end="", flush=True)
    try:
        response = poll_device_token(device_info, on_pending=lambda: print(".", end="", flush=True))
    finally:
        print()  # newline after the progress dots, also on failure

    _save_oauth_token(response)


def _save_oauth_token(response: OAuthTokenResponse) -> tuple[str, str]:
    """Validate and persist a token response from the device code flow, including refresh metadata."""
    expires_in = response.get("expires_in")
    token_name, username = _validate_and_save_token(
        response["access_token"],
        add_to_git_credential=False,
        refresh_token=response.get("refresh_token"),
        expires_at=int(time.time()) + int(expires_in) if expires_in else None,
    )
    if note := _expiration_note(response):
        logger.info(f"Note: {note}")
    return token_name, username


def _expiration_note(response: OAuthTokenResponse) -> str | None:
    """Human-readable note about the lifetime of a freshly obtained OAuth token, if known."""
    expires_in = response.get("expires_in")
    if not expires_in:
        return None
    if response.get("refresh_token"):
        return "This token will be refreshed automatically when it expires."
    days = max(1, int(expires_in) // 86400)
    return f"This token expires in {days} days. Log in again to renew it."


###
# Interpreter-based login (text)
###


def interpreter_login(*, skip_if_logged_in: bool = True) -> None:
    """
    Displays a prompt to log in to the HF website and store the token.

    This is equivalent to [`login`] without passing a token when not run in a notebook.
    [`interpreter_login`] is useful if you want to force the use of the terminal prompt
    instead of a notebook flow.

    For more details, see [`login`].

    Args:
        skip_if_logged_in (`bool`, defaults to `True`):
            If `True`, do not prompt for token if user is already logged in.
            Set to `False` to force re-login. In CLI, use `--force` instead.
    """
    if skip_if_logged_in and get_token() is not None:
        logger.info("User is already logged in. Use `hf auth login --force` to force re-login.")
        return

    if get_token() is not None:
        logger.info("Note: a token is already saved on this machine. Logging in again will replace the active token.")

    if _prompt_login_method() == "token":
        _paste_token_login()
    else:
        _device_code_login()


def _prompt_login_method() -> str:
    """Ask the user how to log in: "browser" (default) or "token". Never prompts without a TTY."""
    if sys.stdin is None or not sys.stdin.isatty():
        return "browser"
    choice = select_choice("How would you like to log in?", ["Log in with your browser", "Paste an access token"])
    return "browser" if choice == 0 else "token"


def _paste_token_login() -> None:
    logger.info(
        "    To log in, `huggingface_hub` requires a token generated from https://huggingface.co/settings/tokens ."
    )
    if os.name == "nt":
        logger.info("Token can be pasted using 'Right-Click'.")
    token = getpass("Enter your token (input will not be visible): ")
    _validate_and_save_token(token=token, add_to_git_credential=False)


###
# Notebook-based login
###


def notebook_login(*, skip_if_logged_in: bool = True) -> None:
    """
    Displays a prompt to log in to the HF website and store the token.

    This is equivalent to [`login`] without passing a token when run in a notebook.
    [`notebook_login`] is useful if you want to force the use of the notebook flow
    instead of a prompt in the terminal.

    For more details, see [`login`].

    Args:
        skip_if_logged_in (`bool`, defaults to `True`):
            If `True`, do not prompt for token if user is already logged in.
            Set to `False` to force re-login. In CLI, use `--force` instead.
    """
    if skip_if_logged_in and get_token() is not None:
        logger.info("User is already logged in. Use `hf auth login --force` to force re-login.")
        return

    try:
        from IPython.display import HTML, display  # type: ignore
    except ImportError:
        # Not in a notebook environment: fall back to the terminal flow
        interpreter_login(skip_if_logged_in=False)
        return

    device_info = request_device_code()
    # Escape server-provided values: they end up in raw notebook HTML.
    verification_uri = html.escape(device_info["verification_uri"])
    verification_uri_complete = html.escape(device_info["verification_uri_complete"])

    display(
        HTML(
            '<center><img src="https://huggingface.co/front/assets/huggingface_logo-noborder.svg"'
            ' width="100" alt="Hugging Face"><br><br>'
            "<p>To log in, open this URL and enter the code:</p>"
            f'<p><a href="{verification_uri_complete}" target="_blank"><b>{verification_uri}</b></a></p>'
            '<p style="font-size: 1.6em; letter-spacing: 0.3em; font-family: monospace;">'
            f"<b>{html.escape(device_info['user_code'])}</b></p></center>"
        )
    )
    display(HTML("<center><i>Waiting for authorization...</i></center>"))
    try:
        response = poll_device_token(device_info)
    except DeviceCodeError as e:
        display(HTML(f"<center><b style='color: red;'>Login failed: {html.escape(str(e))}</b></center>"))
        return

    try:
        token_name, username = _save_oauth_token(response)
    except Exception as error:
        display(HTML(f"<center><b style='color: red;'>{html.escape(str(error))}</b></center>"))
        return

    message = f"Login successful. Logged in as <b>{html.escape(username)}</b> (token: <code>{html.escape(token_name)}</code>)."
    if note := _expiration_note(response):
        message += f"<br>{html.escape(note)}"
    display(HTML(f"<center>{message}</center>"))


###
# Login private helpers
###


def _validate_and_save_token(
    token: str,
    add_to_git_credential: bool,
    refresh_token: str | None = None,
    expires_at: int | None = None,
) -> tuple[str, str]:
    """Validate a token against the Hub, save it to the stored tokens file and set it as active.

    The token is stored under its `displayName` from the whoami response, or `oauth-{username}`
    for OAuth tokens (which have no display name).

    Args:
        token (`str`):
            The access token.
        add_to_git_credential (`bool`):
            Whether to save the token to the git credential helpers.
        refresh_token (`str`, *optional*):
            OAuth refresh token to persist alongside the access token.
        expires_at (`int`, *optional*):
            Unix timestamp at which the access token expires.

    Returns:
        `tuple[str, str]`: The token name and the username.
    """
    from .hf_api import whoami  # avoid circular import

    if token.startswith("api_org"):
        raise ValueError("You must use your personal account token, not an organization token.")

    token_info = whoami(token)
    username = token_info["name"]

    access_token_info = (token_info.get("auth") or {}).get("accessToken") or {}
    if role := access_token_info.get("role"):
        logger.info(f"Token is valid (permission: {role}).")
    else:
        logger.info("Token is valid.")

    token_name = access_token_info.get("displayName") or f"oauth-{username}"

    # Store token locally
    _save_token(token=token, token_name=token_name, refresh_token=refresh_token, expires_at=expires_at)
    # Set active token
    _set_active_token(token_name=token_name, add_to_git_credential=add_to_git_credential)
    logger.info("Login successful.")
    if _get_token_from_environment():
        logger.warning(
            "Note: Environment variable`HF_TOKEN` is set and is the current active token independently from the token you've just configured."
        )
    else:
        logger.info(f"The current active token is: `{token_name}`")
    return token_name, username


def _logout_from_token(token_name: str) -> None:
    """Logout from a specific access token.

    Args:
        token_name (`str`):
            The name of the access token to logout from.
    """
    stored_tokens = _read_stored_tokens_full()
    # If there is no access tokens saved or the access token name is not found, do nothing
    if token_name not in stored_tokens:
        return

    fields = stored_tokens.pop(token_name)
    _save_stored_tokens_full(stored_tokens)

    if fields.get("hf_token") == _get_token_from_file():
        logger.warning(f"Active token '{token_name}' has been deleted.")
        Path(constants.HF_TOKEN_PATH).unlink(missing_ok=True)


def _format_expiration(expires_at: str | None) -> str:
    """Format an `expires_at` unix timestamp for display in `auth list`."""
    if not expires_at:
        return ""
    try:
        timestamp = int(expires_at)
    except ValueError:
        return ""
    date_str = datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d")
    return f"{date_str} (expired)" if timestamp < time.time() else date_str


def _set_active_token(
    token_name: str,
    add_to_git_credential: bool,
) -> None:
    """Set the active access token.

    Args:
        token_name (`str`):
            The name of the token to set as active.
    """
    token = _get_token_by_name(token_name)
    if not token:
        raise ValueError(f"Token {token_name} not found in {constants.HF_STORED_TOKENS_PATH}")
    if add_to_git_credential:
        if _is_git_credential_helper_configured():
            set_git_credential(token)
            logger.info(
                "Your token has been saved in your configured git credential helpers"
                + f" ({','.join(list_credential_helpers())})."
            )
        else:
            logger.warning("Token has not been saved to git credential helper.")
    # Write token to HF_TOKEN_PATH
    _write_secret(Path(constants.HF_TOKEN_PATH), token)
    logger.info(f"Your token has been saved to {constants.HF_TOKEN_PATH}")


def _is_git_credential_helper_configured() -> bool:
    """Check if a git credential helper is configured.

    Warns user if not the case (except for Google Colab where "store" is set by default
    by `huggingface_hub`).
    """
    helpers = list_credential_helpers()
    if len(helpers) > 0:
        return True  # Do not warn: at least 1 helper is set

    # Only in Google Colab to avoid the warning message
    # See https://github.com/huggingface/huggingface_hub/issues/1043#issuecomment-1247010710
    if is_google_colab():
        _set_store_as_git_credential_helper_globally()
        return True  # Do not warn: "store" is used by default in Google Colab

    # Otherwise, warn user
    print(
        ANSI.red(
            "Cannot authenticate through git-credential as no helper is defined on your"
            " machine.\nYou might have to re-authenticate when pushing to the Hugging"
            " Face Hub.\nRun the following command in your terminal in case you want to"
            " set the 'store' credential helper as default.\n\ngit config --global"
            " credential.helper store\n\nRead"
            " https://git-scm.com/book/en/v2/Git-Tools-Credential-Storage for more"
            " details."
        )
    )
    return False


def _set_store_as_git_credential_helper_globally() -> None:
    """Set globally the credential.helper to `store`.

    To be used only in Google Colab as we assume the user doesn't care about the git
    credential config. It is the only particular case where we don't want to display the
    warning message in [`notebook_login()`].

    Related:
    - https://github.com/huggingface/huggingface_hub/issues/1043
    - https://github.com/huggingface/huggingface_hub/issues/1051
    - https://git-scm.com/docs/git-credential-store
    """
    try:
        run_subprocess("git config --global credential.helper store")
    except subprocess.CalledProcessError as exc:
        raise OSError(exc.stderr)
