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
"""Contains commands to authenticate to the Hugging Face Hub and interact with your repositories."""

from typing import Annotated

import click

from huggingface_hub.constants import ENDPOINT
from huggingface_hub.hf_api import whoami

from .._login import _save_oauth_token, auth_list, auth_switch, login, logout
from ..errors import CLIError
from ..utils import get_stored_tokens, get_token, logging, select_choice
from ..utils._oauth_device import poll_device_token, request_device_code
from ._cli_utils import TokenOpt, typer_factory
from ._framework import Option
from ._output import OutputFormat, out


logger = logging.get_logger(__name__)


auth_cli = typer_factory(help="Manage authentication (login, logout, etc.).")


@auth_cli.command(
    "login",
    examples=[
        "hf auth login",
        "hf auth login --token $HF_TOKEN",
        "hf auth login --token $HF_TOKEN --add-to-git-credential",
        "hf auth login --force",
    ],
)
def auth_login(
    token: TokenOpt = None,
    add_to_git_credential: Annotated[
        bool,
        Option(
            help="Save to git credential helper. Useful only if you plan to run git commands directly.",
        ),
    ] = False,
    force: Annotated[
        bool,
        Option(
            help="Force re-login even if already logged in.",
        ),
    ] = False,
) -> None:
    """Login from your browser, or using a token from huggingface.co/settings/tokens."""
    if token is not None or out.mode == OutputFormat.human:
        # `--token` bypasses any prompt; in human mode the gh-style menu lives in `login()`.
        login(token=token, add_to_git_credential=add_to_git_credential, skip_if_logged_in=not force)
        return

    # Logging in is an interactive flow: besides human mode, only agent mode is supported.
    if out.mode != OutputFormat.agent:
        raise CLIError(
            "`hf auth login` is interactive and does not support --format json/quiet. "
            "Pass --token for a non-interactive login."
        )

    # agent mode: never prompt; print instructions the agent can relay to its user.
    if not force and get_token() is not None:
        out.text(agent="Already logged in. Use `hf auth login --force` to re-login.")
        return
    device_info = request_device_code()
    out.text(
        agent=(
            f"Ask the user to open {device_info['verification_uri_complete']} in a browser and enter the code "
            f"{device_info['user_code']}. The code expires in {device_info['expires_in']} seconds. "
            "Waiting for authorization..."
        )
    )
    response = poll_device_token(device_info)
    token_name, username = _save_oauth_token(response)
    out.text(agent=f"Login successful: logged in as {username} (token saved as '{token_name}').")


@auth_cli.command(
    "logout",
    examples=["hf auth logout", "hf auth logout --token-name my-token"],
)
def auth_logout(
    token_name: Annotated[
        str | None,
        Option(help="Name of token to logout"),
    ] = None,
) -> None:
    """Logout from a specific token."""
    logout(token_name=token_name)


def _select_token_name() -> str | None:
    token_names = list(get_stored_tokens().keys())

    if not token_names:
        logger.error("No stored tokens found. Please login first.")
        return None

    if out.mode != OutputFormat.human:
        raise CLIError("Use --token-name to select a token in non-interactive mode.")
    return token_names[select_choice("Select a token to switch to:", token_names)]


@auth_cli.command(
    "switch",
    examples=["hf auth switch", "hf auth switch --token-name my-token"],
)
def auth_switch_cmd(
    token_name: Annotated[
        str | None,
        Option(
            help="Name of the token to switch to",
        ),
    ] = None,
    add_to_git_credential: Annotated[
        bool,
        Option(
            help="Save to git credential helper. Useful only if you plan to run git commands directly.",
        ),
    ] = False,
) -> None:
    """Switch between access tokens."""
    if token_name is None:
        token_name = _select_token_name()
    if token_name is None:
        print("No token name provided. Aborting.")
        raise click.exceptions.Exit()
    auth_switch(token_name, add_to_git_credential=add_to_git_credential)


@auth_cli.command("list | ls", examples=["hf auth list"])
def auth_list_cmd() -> None:
    """List all stored access tokens."""
    auth_list()


@auth_cli.command("token", examples=["hf auth token", "hf auth token | xargs curl -H 'Authorization: Bearer {}'"])
def auth_token() -> None:
    """Print the current access token to stdout."""
    token = get_token()
    if token is None:
        out.error("Not logged in. Run `hf auth login` first.")
        raise click.exceptions.Exit(code=1)
    print(token)
    out.hint("Run `hf auth whoami` to see which account this token belongs to.")


@auth_cli.command("whoami", examples=["hf auth whoami", "hf auth whoami --format json"])
def auth_whoami() -> None:
    """Find out which huggingface.co account you are logged in as."""

    token = get_token()
    if token is None:
        out.error("Not logged in")
        raise click.exceptions.Exit(code=1)

    info = whoami(token)
    orgs = ",".join(org["name"] for org in info["orgs"]) or None
    endpoint = ENDPOINT if ENDPOINT != "https://huggingface.co" else None
    out.result("Logged in", user=info["name"], orgs=orgs, endpoint=endpoint)
