# Copyright 2025 The HuggingFace Team. All rights reserved.
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
"""Contains commands to interact with repositories on the Hugging Face Hub."""

import enum
from typing import Annotated

import click

from huggingface_hub import SpaceHardware, SpaceStorage
from huggingface_hub.cli._cli_utils import SoftChoice
from huggingface_hub.errors import CLIError, HfHubHTTPError, RepositoryNotFoundError, RevisionNotFoundError
from huggingface_hub.hf_api import REPO_REGIONS

from ._city_game import run_city_game
from ._cli_utils import (
    REPO_LIST_DEFAULT_LIMIT,
    EnvFileOpt,
    EnvOpt,
    LimitOpt,
    PrivateOpt,
    RepoIdArg,
    RepoType,
    RepoTypeOpt,
    RevisionOpt,
    SearchOpt,
    SecretsFileOpt,
    SecretsOpt,
    TokenOpt,
    VolumesOpt,
    env_map_to_key_value_list,
    get_hf_api,
    parse_env_map,
    parse_volumes,
    typer_factory,
)
from ._cp import make_cp
from ._file_listing import format_size
from ._framework import Argument, Option
from ._output import OutputFormat, out


repos_cli = typer_factory(help="Manage repos on the Hub.")


@repos_cli.group_callback(invoke_without_command=True)
def _repos_callback(ctx: click.Context) -> None:
    if ctx.info_name == "repo":
        out.warning("`hf repo` is deprecated in favor of `hf repos`.")


class RepoTypeAll(str, enum.Enum):
    model = "model"
    dataset = "dataset"
    space = "space"
    bucket = "bucket"


class GatedChoices(str, enum.Enum):
    auto = "auto"
    manual = "manual"
    false = "false"


PublicOpt = Annotated[
    bool | None,
    Option(
        "--public",
        help="Whether to make the repo public. Ignored if the repo already exists.",
    ),
]

ProtectedOpt = Annotated[
    bool | None,
    Option(
        "--protected",
        help="Whether to make the Space protected (Spaces only). Ignored if the repo already exists.",
    ),
]
SpaceHardwareOpt = Annotated[
    str | None,
    Option(
        "--flavor",
        help="Space hardware flavor (e.g. 'cpu-basic', 't4-medium', 'l4x4'). Only for Spaces.",
        click_type=SoftChoice(SpaceHardware),
    ),
]

SpaceStorageOpt = Annotated[
    SpaceStorage | None,
    Option(
        "--storage",
        help="(Deprecated, use volumes instead) Space persistent storage tier ('small', 'medium', or 'large'). Only for Spaces.",
    ),
]

SpaceSleepTimeOpt = Annotated[
    int | None,
    Option(
        "--sleep-time",
        help="Seconds of inactivity before the Space is put to sleep. Use -1 to disable. Only for Spaces.",
    ),
]


tag_cli = typer_factory(help="Manage tags for a repo on the Hub.")
branch_cli = typer_factory(help="Manage branches for a repo on the Hub.")
repos_cli.add_group(tag_cli, name="tag")
repos_cli.add_group(branch_cli, name="branch")


@repos_cli.command(
    "list | ls",
    examples=[
        "hf repos ls",
        "hf repos ls --explore",
        "hf repos ls --namespace my-org --search bert",
    ],
)
def repo_list(
    namespace: Annotated[
        str | None,
        Option(
            help="Organization name. If not provided, lists repos for the authenticated user.",
        ),
    ] = None,
    repo_type: Annotated[
        RepoTypeAll | None,
        Option(
            "--type",
            "--repo-type",
            help="Filter by repository type (model, dataset, space, or bucket).",
        ),
    ] = None,
    search: SearchOpt = None,
    limit: LimitOpt = REPO_LIST_DEFAULT_LIMIT,
    explore: Annotated[
        bool,
        Option("--explore", help="Explore your repos as an interactive 3D city."),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """List all repos (models, datasets, spaces, buckets) with storage info."""
    api = get_hf_api(token=token)
    repos = list(api.list_user_repos(namespace=namespace))
    if repo_type is not None:
        repos = [r for r in repos if r.type == repo_type.value]
    if search is not None:
        search_lower = search.lower()
        repos = [r for r in repos if search_lower in r.id.lower()]
    total = len(repos)

    if explore:
        if out.mode == OutputFormat.human:
            run_city_game(repos)
            return
        raise CLIError("Repository exploration is only available in terminal.")

    if limit > 0:
        repos = repos[:limit]
    items = [
        {
            "id": r.id,
            "type": r.type,
            "updated": r.updated_at.strftime("%Y-%m-%d"),
            "visibility": r.visibility,
            "storage": format_size(r.storage, human_readable=True),
            "%_of_total": f"{r.storage_percent:.1f}%",
        }
        for r in repos
    ]
    out.table(items, id_key="id", alignments={"storage": "right", "%_of_total": "right"})
    if limit > 0 and total > limit:
        out.hint(f"Showing {limit} of {total} repos. Use `--limit 0` to list all.")


@repos_cli.command(
    "create",
    examples=[
        "hf repos create my-model",
        "hf repos create my-dataset --repo-type dataset --private",
        "hf repos create my-space --type space --sdk gradio --flavor t4-medium --secrets HF_TOKEN -e THEME=dark --protected",
        "hf repos create my-jupyterlab --type space --template SpacesExamples/jupyterlab",
        "hf repos create my-space --type space --sdk gradio -v hf://org/my-model:/models -v hf://buckets/org/b:/data",
        "hf repos create my-model --region us",
    ],
)
def repo_create(
    repo_id: RepoIdArg,
    repo_type: RepoTypeOpt = RepoType.model,
    sdk: Annotated[
        str | None,
        Option(
            "--sdk",
            "--space-sdk",
            help="Hugging Face Spaces SDK type. Required when --type is set to 'space'.",
        ),
    ] = None,
    template: Annotated[
        str | None,
        Option(
            "--template",
            help=(
                "Create a Space from an official template. Pass a template repo id (e.g. "
                "'SpacesExamples/jupyterlab') or its short name (e.g. 'JupyterLab'). List available templates with "
                "`hf spaces templates`. Spaces only."
            ),
        ),
    ] = None,
    private: PrivateOpt = None,
    public: PublicOpt = None,
    protected: ProtectedOpt = None,
    token: TokenOpt = None,
    exist_ok: Annotated[
        bool,
        Option(
            help="Do not raise an error if repo already exists.",
        ),
    ] = False,
    resource_group_id: Annotated[
        str | None,
        Option(
            help="Resource group in which to create the repo. Resource groups is only available for Enterprise Hub organizations.",
        ),
    ] = None,
    region: Annotated[
        REPO_REGIONS | None,
        Option(
            "--region",
            help="Cloud region in which to create the repo. Can be one of 'us' or 'eu'. Requires Team plan or above.",
        ),
    ] = None,
    hardware: SpaceHardwareOpt = None,
    storage: SpaceStorageOpt = None,
    sleep_time: SpaceSleepTimeOpt = None,
    secrets: SecretsOpt = None,
    secrets_file: SecretsFileOpt = None,
    env: EnvOpt = None,
    env_file: EnvFileOpt = None,
    volume: VolumesOpt = None,
) -> None:
    """Create a new repo on the Hub."""
    api = get_hf_api(token=token)
    repo_url = api.create_repo(
        repo_id=repo_id,
        repo_type=repo_type.value,
        visibility="private" if private else "public" if public else "protected" if protected else None,  # type: ignore [arg-type]
        token=token,
        exist_ok=exist_ok,
        resource_group_id=resource_group_id,
        region=region,
        space_sdk=sdk,
        space_hardware=hardware,
        space_storage=storage,
        space_sleep_time=sleep_time,
        space_secrets=env_map_to_key_value_list(parse_env_map(secrets, secrets_file)),
        space_variables=env_map_to_key_value_list(parse_env_map(env, env_file)),
        space_volumes=parse_volumes(volume),
        space_template=template,
    )
    out.result("Repo created", repo_id=repo_url.repo_id, url=str(repo_url))


@repos_cli.command(
    "duplicate",
    examples=[
        "hf repos duplicate openai/gdpval --type dataset",
        "hf repos duplicate multimodalart/dreambooth-training my-dreambooth --type space --flavor l4x4 --secrets HF_TOKEN --private",
        "hf repos duplicate org/my-space my-space --type space -v hf://org/my-model:/models -v hf://buckets/org/b:/data",
    ],
)
def repo_duplicate(
    from_id: RepoIdArg,
    to_id: Annotated[
        str | None,
        Argument(
            help="Destination repo ID (e.g. `myorg/my-copy`). Defaults to your namespace with the same repo name.",
        ),
    ] = None,
    repo_type: RepoTypeOpt = RepoType.model,
    private: PrivateOpt = None,
    public: PublicOpt = None,
    protected: ProtectedOpt = None,
    token: TokenOpt = None,
    exist_ok: Annotated[
        bool,
        Option(
            help="Do not raise an error if repo already exists.",
        ),
    ] = False,
    hardware: SpaceHardwareOpt = None,
    storage: SpaceStorageOpt = None,
    sleep_time: SpaceSleepTimeOpt = None,
    secrets: SecretsOpt = None,
    secrets_file: SecretsFileOpt = None,
    env: EnvOpt = None,
    env_file: EnvFileOpt = None,
    volume: VolumesOpt = None,
) -> None:
    """Duplicate a repo on the Hub (model, dataset, or Space)."""
    api = get_hf_api(token=token)
    repo_url = api.duplicate_repo(
        from_id=from_id,
        to_id=to_id,
        repo_type=repo_type.value,
        visibility="private" if private else "public" if public else "protected" if protected else None,  # type: ignore [arg-type]
        token=token,
        exist_ok=exist_ok,
        space_hardware=hardware,
        space_storage=storage,
        space_sleep_time=sleep_time,
        space_secrets=env_map_to_key_value_list(parse_env_map(secrets, secrets_file)),
        space_variables=env_map_to_key_value_list(parse_env_map(env, env_file)),
        space_volumes=parse_volumes(volume),
    )
    out.result("Repo duplicated", from_id=from_id, to_id=repo_url.repo_id, url=str(repo_url))


@repos_cli.command("delete", examples=["hf repos delete my-model"])
def repo_delete(
    repo_id: RepoIdArg,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
    missing_ok: Annotated[
        bool,
        Option(
            help="If set to True, do not raise an error if repo does not exist.",
        ),
    ] = False,
    yes: Annotated[
        bool,
        Option(
            "-y",
            "--yes",
            help="Answer Yes to prompt automatically.",
        ),
    ] = False,
) -> None:
    """Delete a repo from the Hub. This is an irreversible operation."""
    out.confirm(f"You are about to permanently delete {repo_type.value} '{repo_id}'. Proceed?", yes=yes)
    api = get_hf_api(token=token)
    api.delete_repo(
        repo_id=repo_id,
        repo_type=repo_type.value,
        missing_ok=missing_ok,
    )
    out.result("Repo deleted", repo_id=repo_id)


@repos_cli.command("move", examples=["hf repos move old-namespace/my-model new-namespace/my-model"])
def repo_move(
    from_id: RepoIdArg,
    to_id: RepoIdArg,
    token: TokenOpt = None,
    repo_type: RepoTypeOpt = RepoType.model,
) -> None:
    """Move a repository from a namespace to another namespace."""
    api = get_hf_api(token=token)
    api.move_repo(
        from_id=from_id,
        to_id=to_id,
        repo_type=repo_type.value,
    )
    out.result("Repo moved", from_id=from_id, to_id=to_id)


@repos_cli.command(
    "settings",
    examples=[
        "hf repos settings my-model --private",
        "hf repos settings my-model --gated auto",
        "hf repos settings my-space --repo-type space --protected",
    ],
)
def repo_settings(
    repo_id: RepoIdArg,
    gated: Annotated[
        GatedChoices | None,
        Option(
            help="The gated status for the repository.",
        ),
    ] = None,
    private: PrivateOpt = None,
    public: PublicOpt = None,
    protected: ProtectedOpt = None,
    token: TokenOpt = None,
    repo_type: RepoTypeOpt = RepoType.model,
) -> None:
    """Update the settings of a repository."""
    api = get_hf_api(token=token)
    api.update_repo_settings(
        repo_id=repo_id,
        gated=(None if gated is None else False if gated is GatedChoices.false else gated.value),
        visibility="private" if private else "public" if public else "protected" if protected else None,  # type: ignore [arg-type]
        repo_type=repo_type.value,
    )
    out.result("Repo settings updated", repo_id=repo_id)


@repos_cli.command(
    "delete-files",
    examples=[
        "hf repos delete-files my-model file.txt",
        'hf repos delete-files my-model "*.json"',
        "hf repos delete-files my-model folder/",
    ],
)
def repo_delete_files(
    repo_id: RepoIdArg,
    patterns: Annotated[
        list[str],
        Argument(
            help="Glob patterns to match files to delete. Based on fnmatch, '*' matches files recursively.",
        ),
    ],
    repo_type: RepoTypeOpt = RepoType.model,
    revision: RevisionOpt = None,
    commit_message: Annotated[
        str | None,
        Option(
            help="The summary / title / first line of the generated commit.",
        ),
    ] = None,
    commit_description: Annotated[
        str | None,
        Option(
            help="The description of the generated commit.",
        ),
    ] = None,
    create_pr: Annotated[
        bool,
        Option(
            help="Whether to create a new Pull Request for these changes.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Delete files from a repo on the Hub."""
    api = get_hf_api(token=token)
    url = api.delete_files(
        delete_patterns=patterns,
        repo_id=repo_id,
        repo_type=repo_type.value,
        revision=revision,
        commit_message=commit_message,
        commit_description=commit_description,
        create_pr=create_pr,
    )
    out.result("Files deleted", repo_id=repo_id, commit_url=url)


# `hf repos cp` is an alias for the top-level `hf cp` command (see `cli/_cp.py`).
repos_cli.command(
    name="cp",
    examples=[
        # Download (repo or bucket -> local / stdout)
        "hf repos cp hf://username/my-model/config.json config.json",
        "hf repos cp hf://datasets/username/my-dataset/data.csv data/",
        "hf repos cp hf://username/my-model/config.json -",
        # Upload (local / stdin -> repo)
        "hf repos cp model.safetensors hf://username/my-model/model.safetensors",
        "hf repos cp config.json hf://username/my-model/logs/",
        "hf repos cp - hf://username/my-model/config.json",
        # Remote to remote (repo -> repo)
        "hf repos cp hf://username/source-model/config.json hf://username/dest-model/config.json",
        "hf repos cp hf://datasets/username/my-dataset/processed/ hf://datasets/username/dest-dataset/processed/",
        "hf repos cp hf://username/my-model/logs/ hf://username/archive-model/logs/",
    ],
)(make_cp("repos"))


@branch_cli.command(
    "create",
    examples=[
        "hf repos branch create my-model dev",
        "hf repos branch create my-model dev --revision abc123",
    ],
)
def branch_create(
    repo_id: RepoIdArg,
    branch: Annotated[
        str,
        Argument(
            help="The name of the branch to create.",
        ),
    ],
    revision: RevisionOpt = None,
    token: TokenOpt = None,
    repo_type: RepoTypeOpt = RepoType.model,
    exist_ok: Annotated[
        bool,
        Option(
            help="If set to True, do not raise an error if branch already exists.",
        ),
    ] = False,
) -> None:
    """Create a new branch for a repo on the Hub."""
    api = get_hf_api(token=token)
    api.create_branch(
        repo_id=repo_id,
        branch=branch,
        revision=revision,
        repo_type=repo_type.value,
        exist_ok=exist_ok,
    )
    out.result("Branch created", branch=branch, repo_type=repo_type.value, repo_id=repo_id)


@branch_cli.command("delete", examples=["hf repos branch delete my-model dev"])
def branch_delete(
    repo_id: RepoIdArg,
    branch: Annotated[
        str,
        Argument(
            help="The name of the branch to delete.",
        ),
    ],
    token: TokenOpt = None,
    repo_type: RepoTypeOpt = RepoType.model,
) -> None:
    """Delete a branch from a repo on the Hub."""
    api = get_hf_api(token=token)
    api.delete_branch(
        repo_id=repo_id,
        branch=branch,
        repo_type=repo_type.value,
    )
    out.result("Branch deleted", branch=branch, repo_type=repo_type.value, repo_id=repo_id)


@tag_cli.command(
    "create",
    examples=[
        "hf repos tag create my-model v1.0",
        'hf repos tag create my-model v1.0 -m "First release"',
    ],
)
def tag_create(
    repo_id: RepoIdArg,
    tag: Annotated[
        str,
        Argument(
            help="The name of the tag to create.",
        ),
    ],
    message: Annotated[
        str | None,
        Option(
            "-m",
            "--message",
            help="The description of the tag to create.",
        ),
    ] = None,
    revision: RevisionOpt = None,
    token: TokenOpt = None,
    repo_type: RepoTypeOpt = RepoType.model,
) -> None:
    """Create a tag for a repo."""
    repo_type_str = repo_type.value
    api = get_hf_api(token=token)
    try:
        api.create_tag(repo_id=repo_id, tag=tag, tag_message=message, revision=revision, repo_type=repo_type_str)
    except RepositoryNotFoundError as e:
        raise CLIError(f"{repo_type_str.capitalize()} '{repo_id}' not found.") from e
    except RevisionNotFoundError as e:
        raise CLIError(f"Revision '{revision}' not found.") from e
    except HfHubHTTPError as e:
        if e.response.status_code == 409:
            raise CLIError(f"Tag '{tag}' already exists on '{repo_id}'.") from e
        raise
    out.result("Tag created", tag=tag, repo_type=repo_type_str, repo_id=repo_id)


@tag_cli.command("list | ls", examples=["hf repos tag list my-model"])
def tag_list(
    repo_id: RepoIdArg,
    token: TokenOpt = None,
    repo_type: RepoTypeOpt = RepoType.model,
) -> None:
    """List tags for a repo."""
    repo_type_str = repo_type.value
    api = get_hf_api(token=token)
    try:
        refs = api.list_repo_refs(repo_id=repo_id, repo_type=repo_type_str)
    except RepositoryNotFoundError as e:
        raise CLIError(f"{repo_type_str.capitalize()} '{repo_id}' not found.") from e
    items = [{"name": t.name, "target_commit": t.target_commit, "ref": t.ref} for t in refs.tags]
    out.table(items)


@tag_cli.command("delete", examples=["hf repos tag delete my-model v1.0"])
def tag_delete(
    repo_id: RepoIdArg,
    tag: Annotated[
        str,
        Argument(
            help="The name of the tag to delete.",
        ),
    ],
    yes: Annotated[
        bool,
        Option(
            "-y",
            "--yes",
            help="Answer Yes to prompt automatically",
        ),
    ] = False,
    token: TokenOpt = None,
    repo_type: RepoTypeOpt = RepoType.model,
) -> None:
    """Delete a tag for a repo."""
    repo_type_str = repo_type.value
    out.text(f"You are about to delete tag {tag} on {repo_type_str} {repo_id}")
    out.confirm("Proceed?", yes=yes)
    api = get_hf_api(token=token)
    try:
        api.delete_tag(repo_id=repo_id, tag=tag, repo_type=repo_type_str)
    except RepositoryNotFoundError as e:
        raise CLIError(f"{repo_type_str.capitalize()} '{repo_id}' not found.") from e
    except RevisionNotFoundError as e:
        raise CLIError(f"Tag '{tag}' not found on '{repo_id}'.") from e
    out.result("Tag deleted", tag=tag, repo_type=repo_type_str, repo_id=repo_id)
