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
"""Contains commands to interact with spaces on the Hugging Face Hub."""

import enum
import functools
import itertools
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from collections import deque
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Literal, get_args

import click
from packaging import version
from typing_extensions import assert_never

from huggingface_hub._hot_reload.client import multi_replica_reload_events
from huggingface_hub._hot_reload.types import ApiGetReloadEventSourceData, ReloadRegion
from huggingface_hub._space_api import SpaceHardware, SpaceStage
from huggingface_hub.cli._cli_utils import SoftChoice
from huggingface_hub.errors import CLIError, RemoteEntryNotFoundError, RepositoryNotFoundError, RevisionNotFoundError
from huggingface_hub.file_download import hf_hub_download
from huggingface_hub.hf_api import ExpandSpaceProperty_T, HfApi, SpaceSort_T
from huggingface_hub.repocard import SpaceCard
from huggingface_hub.utils import disable_progress_bars
from huggingface_hub.utils._parsing import parse_duration

from ._cli_utils import (
    REPO_LIST_DEFAULT_LIMIT,
    AuthorOpt,
    EnvFileOpt,
    EnvOpt,
    FilterOpt,
    LimitOpt,
    RevisionOpt,
    SearchOpt,
    SecretsFileOpt,
    SecretsOpt,
    SshDryRunOpt,
    SshIdentityFileOpt,
    TokenOpt,
    VolumesOpt,
    exec_ssh,
    get_hf_api,
    make_expand_properties_parser,
    parse_env_map,
    parse_volumes,
    typer_factory,
)
from ._file_listing import list_repo_files_cmd
from ._framework import Argument, Option
from ._output import _dataclass_to_dict, out


HOT_RELOADING_MIN_GRADIO = "6.1.0"


_EXPAND_PROPERTIES = sorted(get_args(ExpandSpaceProperty_T))
_SORT_OPTIONS = get_args(SpaceSort_T)
SpaceSortEnum = enum.Enum("SpaceSortEnum", {s: s for s in _SORT_OPTIONS}, type=str)  # type: ignore[misc]


ExpandOpt = Annotated[
    str | None,
    Option(
        help=f"Comma-separated properties to return. When used, only the listed properties (and id) are returned. Example: '--expand=likes,tags'. Valid: {', '.join(_EXPAND_PROPERTIES)}.",
        callback=make_expand_properties_parser(_EXPAND_PROPERTIES),
    ),
]

spaces_cli = typer_factory(help="Interact with spaces on the Hub.")
volumes_cli = typer_factory(help="Manage volumes for a Space on the Hub.")
secrets_cli = typer_factory(help="Manage secrets for a Space on the Hub.")
variables_cli = typer_factory(help="Manage environment variables for a Space on the Hub.")
spaces_cli.add_group(volumes_cli, name="volumes")
spaces_cli.add_group(secrets_cli, name="secrets")
spaces_cli.add_group(variables_cli, name="variables")


@spaces_cli.command(
    "list | ls",
    examples=[
        "hf spaces ls --limit 10",
        'hf spaces ls --search "chatbot" --author huggingface',
        "hf spaces ls victor/deepsite",
        "hf spaces ls victor/deepsite -R",
        "hf spaces ls victor/deepsite --tree -h",
    ],
)
def spaces_ls(
    repo_id: Annotated[
        str | None,
        Argument(help="Space ID (e.g. `username/repo-name`) to list files from. If omitted, lists spaces."),
    ] = None,
    search: SearchOpt = None,
    author: AuthorOpt = None,
    filter: FilterOpt = None,
    sort: Annotated[
        SpaceSortEnum | None,
        Option(help="Sort results."),
    ] = None,
    limit: LimitOpt = REPO_LIST_DEFAULT_LIMIT,
    expand: ExpandOpt = None,
    human_readable: Annotated[
        bool,
        Option("--human-readable", "-h", help="Show sizes in human readable format (only for listing files)."),
    ] = False,
    as_tree: Annotated[
        bool,
        Option("--tree", help="List files in tree format (only for listing files)."),
    ] = False,
    recursive: Annotated[
        bool,
        Option("--recursive", "-R", help="List files recursively (only for listing files)."),
    ] = False,
    revision: RevisionOpt = None,
    token: TokenOpt = None,
) -> None:
    """List spaces on the Hub, or files in a space repo.

    When called with no argument, lists spaces on the Hub.
    When called with a space ID, lists files in that space repo.
    """
    if repo_id is not None:
        if search is not None:
            raise click.BadParameter("Cannot use --search when listing files.")
        if author is not None:
            raise click.BadParameter("Cannot use --author when listing files.")
        if filter is not None:
            raise click.BadParameter("Cannot use --filter when listing files.")
        if sort is not None:
            raise click.BadParameter("Cannot use --sort when listing files.")
        if limit != REPO_LIST_DEFAULT_LIMIT:
            raise click.BadParameter("Cannot use --limit when listing files.")
        if expand is not None:
            raise click.BadParameter("Cannot use --expand when listing files.")
        return list_repo_files_cmd(
            repo_id=repo_id,
            repo_type="space",
            human_readable=human_readable,
            as_tree=as_tree,
            recursive=recursive,
            revision=revision,
            token=token,
        )

    if as_tree:
        raise click.BadParameter("Cannot use --tree when listing spaces.")
    if recursive:
        raise click.BadParameter("Cannot use --recursive when listing spaces.")
    if human_readable:
        raise click.BadParameter("Cannot use --human-readable when listing spaces.")
    if revision is not None:
        raise click.BadParameter("Cannot use --revision when listing spaces.")
    api = get_hf_api(token=token)
    sort_key = sort.value if sort else None
    results = [
        _dataclass_to_dict(space_info)
        for space_info in api.list_spaces(
            filter=filter,
            author=author,
            search=search,
            sort=sort_key,
            limit=limit,
            expand=expand,  # type: ignore[arg-type]
        )
    ]
    out.table(results)


@spaces_cli.command(
    "info",
    examples=[
        "hf spaces info enzostvs/deepsite",
        "hf spaces info gradio/theme_builder --expand sdk,runtime,likes",
    ],
)
def spaces_info(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    revision: RevisionOpt = None,
    expand: ExpandOpt = None,
    token: TokenOpt = None,
) -> None:
    """Get info about a space on the Hub."""
    api = get_hf_api(token=token)
    try:
        info = api.space_info(repo_id=space_id, revision=revision, expand=expand)  # type: ignore[arg-type]
    except RepositoryNotFoundError as e:
        raise CLIError(f"Space '{space_id}' not found.") from e
    except RevisionNotFoundError as e:
        raise CLIError(f"Revision '{revision}' not found on '{space_id}'.") from e
    out.dict(info)


@spaces_cli.command(
    "card",
    examples=[
        "hf spaces card mteb/leaderboard",
        "hf spaces card mteb/leaderboard --metadata",
        "hf spaces card mteb/leaderboard --metadata --format json",
        "hf spaces card mteb/leaderboard --text",
    ],
)
def spaces_card(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    metadata: Annotated[bool, Option("--metadata", help="Output only the metadata from the card.")] = False,
    text: Annotated[bool, Option("--text", help="Output only the text body (no metadata).")] = False,
    token: TokenOpt = None,
) -> None:
    """Get the Space card (README) for a Space on the Hub."""
    if metadata and text:
        raise CLIError("--metadata and --text are mutually exclusive.")
    card = SpaceCard.load(space_id, token=token)
    if metadata:
        out.dict(card.data.to_dict())
    elif text:
        out.text(card.text)
    else:
        out.text(card.content)
        out.hint(f"Use `hf spaces card {space_id} --metadata` to extract only the card metadata.")


@spaces_cli.command(
    "templates",
    examples=["hf spaces templates"],
)
def spaces_templates(
    token: TokenOpt = None,
) -> None:
    """List the available Space templates.

    The `repo_id` (or `name`) of a template can be passed to `hf repos create --template ...` to
    create a new Space from that template.
    """
    api = get_hf_api(token=token)
    templates = [_dataclass_to_dict(template) for template in api.list_space_templates()]
    out.table(templates, id_key="name")
    out.hint(
        "Create a Space from a template with `hf repos create <id> --type space --space-sdk <sdk> --template <repo_id>`."
    )


@spaces_cli.command(
    "search",
    examples=[
        'hf spaces search "generate image"',
        'hf spaces search "identify objects in pictures" --sdk gradio --limit 5',
        'hf spaces search "remove background from photo" --description --json',
    ],
)
def spaces_search(
    query: Annotated[str, Argument(help="Search query.")],
    filter: FilterOpt = None,
    sdk: Annotated[list[str] | None, Option(help="Filter by SDK (e.g. gradio, docker, static).")] = None,
    include_non_running: Annotated[bool, Option(help="Include non-running spaces in results.")] = False,
    description: Annotated[bool, Option(help="Show AI-generated descriptions.")] = False,
    limit: LimitOpt = 10,
    token: TokenOpt = None,
) -> None:
    """Search spaces on the Hub using semantic search."""
    api = get_hf_api(token=token)
    results = api.search_spaces(
        query=query,
        filter=filter,
        sdk=sdk,
        include_non_running=include_non_running,
        token=token,
    )
    items = []
    for r in itertools.islice(results, limit):
        item: dict = {
            "id": r.id,
            "title": r.title,
            "sdk": r.sdk,
            "likes": r.likes,
            "stage": r.runtime.stage if r.runtime else None,
            "category": r.ai_category,
            "score": round(r.semantic_relevancy_score, 2) if r.semantic_relevancy_score is not None else None,
        }
        if description:
            item["description"] = r.ai_short_description
        items.append(item)
    out.table(items)
    if not description:
        out.hint("Use --description to show AI-generated descriptions.")


@spaces_cli.command(
    "wait",
    examples=[
        "hf spaces wait username/my-space",
        "hf spaces wait username/my-space --timeout 5m",
    ],
)
def spaces_wait(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    timeout: Annotated[
        str | None,
        Option(
            help="Max time to wait: int with s (seconds, default), m (minutes), h (hours) or d (days).",
        ),
    ] = None,
    token: TokenOpt = None,
) -> None:
    """Wait for a Space to finish building/starting.

    Blocks until the Space leaves an intermediate stage (BUILDING, APP_STARTING, etc.)
    and reaches a settled stage. Exits with code 0 if the Space is RUNNING,
    or a non-zero exit code otherwise (e.g. BUILD_ERROR, RUNTIME_ERROR).
    """
    timeout_secs = parse_duration(timeout) if timeout is not None else None
    api = get_hf_api(token=token)
    status = out.status("Waiting for Space to be ready...")
    try:
        runtime = api.wait_for_space(space_id, timeout=timeout_secs)
    except TimeoutError:
        status.done("Timed out.")
        raise CLIError(f"Timed out after {timeout} waiting for Space '{space_id}' to be ready.") from None
    status.done(f"Space reached stage '{runtime.stage}'.")
    if runtime.stage != SpaceStage.RUNNING:
        raise CLIError(f"Space '{space_id}' is not running (stage='{runtime.stage}').")
    out.result("Space ready", space_id=space_id, stage=str(runtime.stage))
    out.hint(f"Use `hf spaces logs {space_id}` to view run logs.")


@spaces_cli.command(
    "dev-mode",
    examples=[
        "hf spaces dev-mode my-user-name/deepsite",
    ],
)
def dev_mode(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    stop: Annotated[bool, Option(help="Stop dev mode.")] = False,
    token: TokenOpt = None,
):
    """
    Enable or disable dev mode on a Space.

    Spaces Dev Mode eases the debugging of your application and makes iterating on Spaces faster by allowing you to
    restart your application without stopping the Space container itself. This feature is available as part of a PRO
    or Team & Enterprise plan.

    See docs: https://huggingface.co/docs/hub/spaces-dev-mode
    """
    api = get_hf_api(token=token)
    if stop:
        api.disable_space_dev_mode(space_id)
        print(f"Dev mode disabled for '{space_id}'")
        return
    api.enable_space_dev_mode(space_id)
    runtime = api.wait_for_space(space_id)
    if runtime.stage != SpaceStage.RUNNING:
        out.warning(f"Dev mode is not ready (stage='{runtime.stage}')")
        return
    info = api.space_info(space_id)
    folder = getattr(info.card_data, "dev-mode-folder", "" if info.sdk == "docker" else "/home/user/app")
    folder_query_param = f"folder={folder}" if folder else ""
    print("Connect to dev environment:")
    print("")
    print("Web:")
    vscode_web_url = f"https://huggingface.co/spaces/{info.id}/dev-mode/vscode-web"
    if folder_query_param:
        vscode_web_url += f"?{folder_query_param}"
    ssh_host = f"{info.subdomain}@ssh.hf.space"
    print(f"  * VSCode: {vscode_web_url}")
    print("")
    print("Local:")
    print("1. Add your SSH key to https://huggingface.co/settings/keys")
    print(f"2. SSH with `hf spaces ssh {space_id}` (or `ssh -i <your_key> {ssh_host}`)")
    print("   Or open")
    print(f"  * VSCode: vscode://vscode-remote/ssh-remote+{ssh_host}{folder}")
    print(f"  * Cursor: cursor://vscode-remote/ssh-remote+{ssh_host}{folder}")
    print("")
    print("PS: Dev mode stops after 48h of inactivity, don't forget to save your changes regularly.")


@spaces_cli.command(
    "ssh",
    examples=[
        "hf spaces ssh username/my-space",
        "hf spaces ssh username/my-space --dry-run",
        "hf spaces ssh username/my-space -i ~/.ssh/id_ed25519",
        "hf spaces ssh username/my-space --auto",
    ],
)
def spaces_ssh(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    identity_file: SshIdentityFileOpt = None,
    dry_run: SshDryRunOpt = False,
    auto: Annotated[
        bool,
        Option("--auto", help="Enable Dev Mode without prompting if not already enabled."),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """SSH into a Space's Dev Mode container.

    Requires Dev Mode to be running on the Space and your SSH public key to be registered at https://huggingface.co/settings/keys.

    See: https://huggingface.co/docs/hub/spaces-dev-mode
    """
    api = get_hf_api(token=token)
    info = api.space_info(space_id)
    if info.runtime is None or not info.runtime.dev_mode:
        out.confirm(
            f"Dev Mode is disabled on '{space_id}'. Enable it now?", yes=auto, default=True, confirm_param="--auto"
        )
        api.enable_space_dev_mode(space_id)
        runtime = api.wait_for_space(space_id)
        if runtime.stage != SpaceStage.RUNNING:
            raise CLIError(f"Space '{space_id}' is not running (stage='{runtime.stage}').")
        info = api.space_info(space_id)
    exec_ssh(f"{info.subdomain}@ssh.hf.space", identity_file=identity_file, dry_run=dry_run)


@spaces_cli.command(
    "pause",
    examples=[
        "hf spaces pause username/my-space",
    ],
)
def spaces_pause(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    token: TokenOpt = None,
) -> None:
    """Pause a Space."""
    api = get_hf_api(token=token)
    runtime = api.pause_space(space_id)
    out.result("Space paused", space_id=space_id, stage=runtime.stage)
    out.hint(f"Use `hf spaces restart {space_id}` to restart it.")
    out.hint(
        f"Mount a Volume or bucket to persist data across restarts: `hf spaces volumes set {space_id} -v hf://...`"
    )


@spaces_cli.command(
    "restart",
    examples=[
        "hf spaces restart username/my-space",
        "hf spaces restart username/my-space --factory-reboot",
    ],
)
def spaces_restart(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    factory_reboot: Annotated[
        bool,
        Option(
            "--factory-reboot",
            help="Rebuild the Space from scratch without using the build cache.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Restart a Space."""
    api = get_hf_api(token=token)
    runtime = api.restart_space(space_id, factory_reboot=factory_reboot)
    out.result(
        "Space restart triggered",
        space_id=space_id,
        stage=runtime.stage,
        factory_reboot=factory_reboot,
    )
    out.hint(f"Use `hf spaces wait {space_id}` to wait until the Space is ready.")
    out.hint(
        f"Mount a Volume or bucket to persist data across restarts: `hf spaces volumes set {space_id} -v hf://...`"
    )


@spaces_cli.command(
    "hardware",
    examples=[
        "hf spaces hardware",
    ],
)
def spaces_hardware(token: TokenOpt = None) -> None:
    """List available hardware options for Spaces."""
    api = get_hf_api(token=token)
    hardware_list = api.list_spaces_hardware()
    items = []
    for hw in hardware_list:
        accelerator = (
            f"{hw.accelerator.quantity}x {hw.accelerator.model} ({hw.accelerator.vram})" if hw.accelerator else None
        )
        cost_min = f"${hw.unit_cost_usd:.4f}" if hw.unit_cost_usd else "free"
        cost_hour = f"${hw.unit_cost_usd * 60:.2f}" if hw.unit_cost_usd else "free"
        items.append(
            {
                "name": hw.name,
                "pretty name": hw.pretty_name,
                "cpu": hw.cpu,
                "ram": hw.ram,
                "accelerator": accelerator,
                "cost/min": cost_min,
                "cost/hour": cost_hour,
            }
        )
    out.table(items)
    out.hint("Use `hf spaces settings <space_id> --hardware <name>` to request hardware for a Space.")


@spaces_cli.command(
    "settings",
    examples=[
        "hf spaces settings username/my-space --sleep-time 300",
        "hf spaces settings username/my-space --hardware t4-medium",
    ],
)
def spaces_settings(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    sleep_time: Annotated[
        int | None,
        Option(
            "--sleep-time",
            help="Idle time in seconds after which the Space goes to sleep. Use -1 to never sleep. Only available on upgraded hardware.",
        ),
    ] = None,
    hardware: Annotated[
        str | None,
        Option(
            "--hardware",
            help="Space hardware flavor (e.g. 'cpu-basic', 't4-medium', 'l4x4'). Run 'hf spaces hardware' to list available options.",
            click_type=SoftChoice(SpaceHardware),
        ),
    ] = None,
    token: TokenOpt = None,
) -> None:
    """Update the settings of a Space."""
    api = get_hf_api(token=token)
    if hardware is not None:
        runtime = api.request_space_hardware(space_id, hardware=hardware, sleep_time=sleep_time)  # type: ignore[arg-type]
    elif sleep_time is not None:
        runtime = api.set_space_sleep_time(space_id, sleep_time=sleep_time)
    else:
        raise CLIError("Specify at least one setting to update.")
    out.result(
        "Space settings updated",
        space_id=space_id,
        hardware=runtime.requested_hardware,
        sleep_time=runtime.sleep_time,
    )
    out.hint(f"Use `hf spaces info {space_id}` to verify the runtime configuration.")


@spaces_cli.command(
    "logs",
    examples=[
        "hf spaces logs username/my-space",
        "hf spaces logs username/my-space --build",
        "hf spaces logs -f username/my-space",
        "hf spaces logs -n 50 username/my-space",
    ],
)
def spaces_logs(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    build: Annotated[
        bool,
        Option(
            "--build",
            help="Fetch the container build logs instead of the run logs. Useful when a Space is stuck in BUILD_ERROR.",
        ),
    ] = False,
    follow: Annotated[
        bool,
        Option(
            "-f",
            "--follow",
            help="Follow log output (stream until the server closes the stream). Without this flag, only currently available logs are printed.",
        ),
    ] = False,
    tail: Annotated[
        int | None,
        Option(
            "-n",
            "--tail",
            help="Number of lines to show from the end of the logs.",
        ),
    ] = None,
    token: TokenOpt = None,
) -> None:
    """Fetch the run or build logs of a Space.

    By default, prints currently available run logs and exits (non-blocking, like
    `docker logs`). Use --follow/-f to stream until the server closes the stream.
    Use --build to see the container build logs instead (useful when a Space is
    stuck in BUILD_ERROR).
    """
    if follow and tail is not None:
        raise CLIError(
            "Cannot use --follow and --tail together. Use --follow to stream logs or --tail to show recent logs."
        )

    api = get_hf_api(token=token)
    logs = api.fetch_space_logs(space_id, build=build, follow=follow)
    if tail is not None:
        logs = deque(logs, maxlen=tail)
    found_logs = False
    for line in logs:
        clean_line = line.strip()
        out.text(clean_line)
        if clean_line:
            found_logs = True
    if not found_logs and not build:
        out.hint(f"No run logs found for space {space_id}. Try passing --build to fetch build logs instead.")


@spaces_cli.command(
    "hot-reload",
    examples=[
        "hf spaces hot-reload username/repo-name app.py     # Open an interactive editor to the remote app.py file",
        "hf spaces hot-reload username/repo-name -f app.py  # Take local version from ./app.py and patch app.py remotely",
        "hf spaces hot-reload username/repo-name app.py -f src/app.py # Take local version from ./src/app.py",
    ],
)
def spaces_hot_reload(
    space_id: Annotated[
        str,
        Argument(
            help="The space ID (e.g. `username/repo-name`).",
        ),
    ],
    filename: Annotated[
        str | None,
        Argument(
            help="Path to the Python file in the Space repository. Can be omitted when --local-file is specified and path in repository matches."
        ),
    ] = None,
    local_file: Annotated[
        Path | None,
        Option(
            "--local-file",
            "-f",
            help="Path of local file. Interactive editor mode if not specified",
        ),
    ] = None,
    skip_checks: Annotated[bool, Option(help="Skip hot-reload compatibility checks.")] = False,
    skip_summary: Annotated[bool, Option(help="Skip summary display after hot-reload is triggered")] = False,
    token: TokenOpt = None,
) -> None:
    """
    Hot-reload any Python file of a Space without a full rebuild + restart.

    ⚠ This feature is experimental ⚠

    Only works with Gradio SDK (6.1+)
    Opens an interactive editor unless --local-file/-f is specified.

    This command patches the live Python process using https://github.com/breuleux/jurigged
    (AST-based diffing, in-place function updates, etc.), integrated with Gradio's native hot-reload support
    (meaning that Gradio demo object changes are reflected in the UI)

    The command creates a remote commit.
    If you are working from a local clone, run `git pull --autostash` afterwards
    to bring the commit back and keep your local git state in sync.
    """

    click.secho("This feature is experimental and subject to change", fg="bright_black")

    api = get_hf_api(token=token)

    if not skip_checks:
        space_info = api.space_info(space_id)
        if space_info.sdk != "gradio":
            raise CLIError(f"Hot-reloading is only available on Gradio SDK. Found {space_info.sdk} SDK")
        if (card_data := space_info.card_data) is None:
            raise CLIError(f"Unable to read cardData for Space {space_id}")
        if (sdk_version := card_data.sdk_version) is None:
            raise CLIError(f"Unable to read sdk_version from {space_id} cardData")
        if version.parse(sdk_version) < version.Version(HOT_RELOADING_MIN_GRADIO):
            raise CLIError(f"Hot-reloading requires Gradio >= {HOT_RELOADING_MIN_GRADIO} (found {sdk_version})")
        if (current_sha := space_info.sha) is None:
            raise CLIError(f"Unexpected `None` running SHA for Space {space_id}")
    else:
        current_sha = None

    if local_file:
        local_path = str(local_file)
        filename = local_file.as_posix() if filename is None else filename
    elif filename:
        if not skip_checks:
            try:
                api.auth_check(
                    repo_type="space",
                    repo_id=space_id,
                    write=True,
                )
            except RepositoryNotFoundError as e:
                raise CLIError(
                    f"Write access check to {space_id} repository failed. Make sure that you are authenticated"
                ) from e
        temp_dir = tempfile.TemporaryDirectory()
        local_path = os.path.join(temp_dir.name, filename)
        with disable_progress_bars():
            try:
                hf_hub_download(repo_type="space", repo_id=space_id, filename=filename, local_dir=temp_dir.name)
            except RemoteEntryNotFoundError:
                click.secho(f"{filename} not found in remote repository. Assuming new file", fg="bright_black")

        editor_res = _editor_open(local_path)
        if editor_res == "no-tty":
            persistent_temp_dir = tempfile.mkdtemp()
            shutil.copytree(temp_dir.name, persistent_temp_dir, dirs_exist_ok=True)
            local_path = os.path.join(persistent_temp_dir, filename)
            click.secho("No TTY detected. Non-interactive fallback:")
            click.secho(f"- Edit {local_path}")
            click.secho(f"- Run `hf spaces hot-reload {space_id} {filename} -f {local_path}`")
            return
        if editor_res == "no-editor":
            raise CLIError("No editor found in local environment. Use -f flag to hot-reload from local path")
        if editor_res != 0:
            raise CLIError(f"Editor returned a non-zero exit code while attempting to edit {local_path}")
    else:
        raise CLIError("Either filename or --local-file/-f must be specified")

    commit_info = api.upload_file(
        repo_type="space",
        repo_id=space_id,
        path_or_fileobj=local_path,
        path_in_repo=filename,
        parent_commit=current_sha,
        _hot_reload=True,
    )

    if local_file is not None and local_file.resolve().is_relative_to(Path.cwd()):
        click.secho(f"Created commit {commit_info.oid} in remote Space repository.")
        click.secho("Consider running `git pull --autostash` to stay synced if you are working from a local clone.")

    if not skip_summary:
        click.secho("Hot-reload summary:")
        _spaces_hot_reload_summary(
            api=api,
            space_id=space_id,
            current_sha=current_sha,
            commit_sha=commit_info.oid,
            local_path=local_path if local_file else filename,
            filename=filename,
            token=token,
        )


def _spaces_hot_reload_summary(
    api: HfApi,
    space_id: str,
    current_sha: str | None,
    commit_sha: str,
    filename: str,
    local_path: str,
    token: str | None,
) -> None:
    while (space_info := api.space_info(space_id)).sha == current_sha:
        if current_sha is None or current_sha == commit_sha:
            break
        click.secho("Waiting for up-to-date Space infos", fg="bright_black", err=True)
        time.sleep(2)
    if space_info.sha != commit_sha:
        raise CLIError(f"Expected SHA {commit_sha} after hot-reload but got {space_info.sha}")
    if (runtime := space_info.runtime) is None:
        raise CLIError(f"Unable to read SpaceRuntime from {space_id} infos")
    if (hot_reloading := runtime.hot_reloading) is None:
        raise CLIError(f"Space {space_id} current running version has not been hot-reloaded")
    if hot_reloading.status != "created":
        click.echo(f"Failed creating hot-reloaded commit. {hot_reloading.replica_statuses=}")
        return

    if (space_host := space_info.host) is None:
        raise CLIError("Unexpected None host on hotReloaded Space")
    if (space_subdomain := space_info.subdomain) is None:
        raise CLIError("Unexpected None subdomain on hotReloaded Space")

    def render_region(region: ReloadRegion) -> str:
        res = f"{local_path}, "
        if region["startLine"] == region["endLine"]:
            res += f"line {region['startLine'] - 1}"
        else:
            res += f"lines {region['startLine'] - 1}-{region['endLine']}"
        return res

    def display_event(event: ApiGetReloadEventSourceData) -> None:
        if event["data"]["kind"] == "error":
            click.secho("✘ Unexpected hot-reloading error", bold=True)
            click.secho(event["data"]["traceback"], italic=True)
        elif event["data"]["kind"] == "exception":
            click.secho(f"✘ Exception at {render_region(event['data']['region'])}", bold=True)
            click.secho(event["data"]["traceback"], italic=True)
        elif event["data"]["kind"] == "add":
            click.secho(f"✔︎ Created {event['data']['objectName']} {event['data']['objectType']}", bold=True)
        elif event["data"]["kind"] == "delete":
            click.secho(f"∅ Deleted {event['data']['objectName']} {event['data']['objectType']}", bold=True)
        elif event["data"]["kind"] == "update":
            click.secho(f"✔︎ Updated {event['data']['objectName']} {event['data']['objectType']}", bold=True)
        elif event["data"]["kind"] == "run":
            click.secho(f"▶ Run {render_region(event['data']['region'])}", bold=True)
            click.secho(event["data"]["codeLines"], italic=True)
        elif event["data"]["kind"] == "ui":
            if event["data"]["updated"]:
                click.secho("⟳ UI updated", bold=True)
            else:
                click.secho("∅ UI untouched", bold=True)
        elif event["data"]["kind"] == "file":
            if event["data"]["created"]:
                click.secho(f"✔︎ {filename} created", bold=True)
            else:
                click.secho(f"✔︎ {filename} updated", bold=True)
        else:
            click.secho(f"❓ Unknown update event: {event=}")
            if TYPE_CHECKING:
                assert_never(event["data"]["kind"])

    for replica_stream_event in multi_replica_reload_events(
        commit_sha=commit_sha,
        host=space_host,
        subdomain=space_subdomain,
        replica_hashes=[hash for hash, _ in hot_reloading.replica_statuses],
        token=token,
    ):
        if replica_stream_event["kind"] == "event":
            display_event(replica_stream_event["event"])
        elif replica_stream_event["kind"] == "replicaHash":
            click.secho(f"---- Replica {replica_stream_event['hash']} ----")
        elif replica_stream_event["kind"] == "fullMatch":
            click.echo("✔︎ Same as first replica")
        elif replica_stream_event["kind"] == "warning":
            click.secho(f"⚠ {replica_stream_event['message']}", fg="bright_black")
        else:
            assert_never(replica_stream_event)


PREFERRED_EDITORS = (
    ("code", "code --wait"),
    ("nvim", "nvim"),
    ("nano", "nano"),
    ("vim", "vim"),
    ("vi", "vi"),
)


@functools.cache
def _get_editor_command() -> str | None:
    for env in ("HF_EDITOR", "VISUAL", "EDITOR"):
        if command := os.getenv(env, "").strip():
            return command
    for binary_path, editor_command in PREFERRED_EDITORS:
        if shutil.which(binary_path) is not None:
            return editor_command
    return None


def _editor_open(local_path: str) -> int | Literal["no-tty", "no-editor"]:
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return "no-tty"
    if (editor_command := _get_editor_command()) is None:
        return "no-editor"
    command = [*shlex.split(editor_command), local_path]
    res = subprocess.run(command, start_new_session=True)
    return res.returncode


@volumes_cli.command(
    "list | ls",
    examples=[
        "hf spaces volumes ls username/my-space",
    ],
)
def volumes_ls(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    token: TokenOpt = None,
) -> None:
    """List volumes mounted in a Space."""
    api = get_hf_api(token=token)
    info = api.space_info(space_id)
    if info.runtime is None:
        raise CLIError(f"Runtime not available for Space '{space_id}'.")
    volumes = info.runtime.volumes or []
    items = [_dataclass_to_dict(v) for v in volumes]
    out.table(items)
    out.hint(
        f"Use `hf spaces volumes set {space_id} -v hf://<repo_type>/<repo_id>:/<mount_path>` to set volumes for a Space."
    )


@volumes_cli.command(
    "set",
    examples=[
        "hf spaces volumes set username/my-space -v hf://models/username/my-model:/models",
        "hf spaces volumes set username/my-space -v hf://buckets/username/my-bucket:/data -v hf://datasets/username/my-dataset:/datasets:ro",
    ],
)
def volumes_set(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    volume: VolumesOpt = None,
    token: TokenOpt = None,
) -> None:
    """Set (replace) volumes for a Space."""
    volumes = parse_volumes(volume)
    if not volumes:
        raise CLIError("At least one volume must be specified with -v/--volume.")
    api = get_hf_api(token=token)
    api.set_space_volumes(space_id, volumes=volumes)
    out.result("Volumes set", space_id=space_id, volumes=[v.to_uri() for v in volumes])
    out.hint(f"Use `hf spaces volumes ls {space_id}` to list volumes for a Space.")


@volumes_cli.command(
    "delete",
    examples=[
        "hf spaces volumes delete username/my-space",
        "hf spaces volumes delete username/my-space --yes",
    ],
)
def volumes_delete(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    yes: Annotated[
        bool,
        Option(
            "-y",
            "--yes",
            help="Answer Yes to prompt automatically.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Remove all volumes from a Space."""
    out.confirm(f"You are about to remove all volumes from Space '{space_id}'. Proceed?", yes=yes)
    api = get_hf_api(token=token)
    api.delete_space_volumes(space_id)
    out.result("Volumes deleted", space_id=space_id)
    out.hint(
        f"Use `hf spaces volumes set {space_id} -v hf://<repo_type>/<repo_id>:/<mount_path>` to set volumes for a Space."
    )


@secrets_cli.command(
    "list | ls",
    examples=["hf spaces secrets ls username/my-space"],
)
def secrets_ls(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    token: TokenOpt = None,
) -> None:
    """List secrets for a Space. Secret values are write-only and not returned."""
    api = get_hf_api(token=token)
    secrets = api.get_space_secrets(space_id)
    items = [_dataclass_to_dict(s) for s in secrets.values()]
    out.table(items)
    out.hint(f"Use `hf spaces secrets add {space_id} -s KEY=VALUE` to add secrets to a Space.")


@secrets_cli.command(
    "add",
    examples=[
        "hf spaces secrets add username/my-space -s HF_TOKEN",
        "hf spaces secrets add username/my-space -s OPENAI_API_KEY=sk-... -s ANTHROPIC_API_KEY=sk-...",
        "hf spaces secrets add username/my-space --secrets-file .env.secrets",
    ],
)
def secrets_add(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    secrets: SecretsOpt = None,
    secrets_file: SecretsFileOpt = None,
    token: TokenOpt = None,
) -> None:
    """Add or update secrets for a Space."""
    secrets_map = parse_env_map(secrets, secrets_file)
    if not secrets_map:
        raise CLIError("At least one secret must be specified with -s/--secrets or --secrets-file.")
    api = get_hf_api(token=token)
    for key, value in secrets_map.items():
        api.add_space_secret(space_id, key=key, value=value or "")
    out.result("Secrets added", space_id=space_id, keys=list(secrets_map))
    out.hint(f"Use `hf spaces secrets delete {space_id} <key>` to remove a secret from a Space.")


@secrets_cli.command(
    "delete",
    examples=[
        "hf spaces secrets delete username/my-space HF_TOKEN",
        "hf spaces secrets delete username/my-space HF_TOKEN --yes",
    ],
)
def secrets_delete(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    key: Annotated[str, Argument(help="Name of the secret to remove.")],
    yes: Annotated[
        bool,
        Option(
            "-y",
            "--yes",
            help="Answer Yes to prompt automatically.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Remove a secret from a Space."""
    out.confirm(
        f"You are about to remove secret '{key}' from Space '{space_id}'. The value cannot be recovered. Proceed?",
        yes=yes,
    )
    api = get_hf_api(token=token)
    api.delete_space_secret(space_id, key=key)
    out.result("Secret deleted", space_id=space_id, key=key)
    out.hint(f"Use `hf spaces secrets add {space_id} -s {key}=<value>` to re-add a secret to a Space.")


@variables_cli.command(
    "list | ls",
    examples=["hf spaces variables ls username/my-space"],
)
def variables_ls(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    token: TokenOpt = None,
) -> None:
    """List environment variables for a Space."""
    api = get_hf_api(token=token)
    variables = api.get_space_variables(space_id)
    items = [_dataclass_to_dict(v) for v in variables.values()]
    out.table(items)
    out.hint(f"Use `hf spaces variables add {space_id} -e KEY=VALUE` to add variables to a Space.")


@variables_cli.command(
    "add",
    examples=[
        "hf spaces variables add username/my-space -e DEBUG=1",
        "hf spaces variables add username/my-space -e MODEL_ID=gpt2 -e MAX_TOKENS=512",
        "hf spaces variables add username/my-space --env-file .env",
    ],
)
def variables_add(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    env: EnvOpt = None,
    env_file: EnvFileOpt = None,
    token: TokenOpt = None,
) -> None:
    """Add or update environment variables for a Space."""
    env_map = parse_env_map(env, env_file)
    if not env_map:
        raise CLIError("At least one variable must be specified with -e/--env or --env-file.")
    api = get_hf_api(token=token)
    for key, value in env_map.items():
        api.add_space_variable(space_id, key=key, value=value or "")
    out.result("Variables added", space_id=space_id, keys=list(env_map))
    out.hint(f"Use `hf spaces variables ls {space_id}` to list variables for a Space.")


@variables_cli.command(
    "delete",
    examples=[
        "hf spaces variables delete username/my-space DEBUG",
        "hf spaces variables delete username/my-space DEBUG --yes",
    ],
)
def variables_delete(
    space_id: Annotated[str, Argument(help="The space ID (e.g. `username/repo-name`).")],
    key: Annotated[str, Argument(help="Name of the variable to remove.")],
    yes: Annotated[
        bool,
        Option(
            "-y",
            "--yes",
            help="Answer Yes to prompt automatically.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Remove an environment variable from a Space."""
    out.confirm(
        f"You are about to remove variable '{key}' from Space '{space_id}'. Proceed?",
        yes=yes,
    )
    api = get_hf_api(token=token)
    api.delete_space_variable(space_id, key=key)
    out.result("Variable deleted", space_id=space_id, key=key)
    out.hint(f"Use `hf spaces variables ls {space_id}` to list remaining variables for a Space.")
