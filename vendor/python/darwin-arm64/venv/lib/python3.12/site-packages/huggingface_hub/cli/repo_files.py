# Copyright 2023-present, the HuggingFace Inc. team.
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
"""Legacy `hf repo-files` command.

Kept for backward compatibility. Users are nudged to use `hf repos delete-files` instead.
"""

from typing import Annotated

from ._cli_utils import (
    RepoIdArg,
    RepoType,
    RepoTypeOpt,
    RevisionOpt,
    TokenOpt,
    get_hf_api,
    typer_factory,
)
from ._framework import Argument, Option
from ._output import out


repo_files_cli = typer_factory(
    help="(Deprecated) Manage files in a repo on the Hub. Use `hf repos delete-files` instead."
)


@repo_files_cli.command(
    "delete",
)
def repo_files_delete(
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
    out.warning("`hf repo-files delete` is deprecated. Use `hf repos delete-files` instead.")
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
