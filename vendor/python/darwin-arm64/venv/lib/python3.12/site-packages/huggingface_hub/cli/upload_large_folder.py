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
"""Contains command to upload a large folder with the CLI."""

import os
import warnings
from typing import Annotated

import click

from huggingface_hub import logging
from huggingface_hub.utils import disable_progress_bars

from ._cli_utils import (
    PrivateOpt,
    RepoIdArg,
    RepoType,
    RepoTypeOpt,
    RevisionOpt,
    TokenOpt,
    get_hf_api,
)
from ._framework import Argument, Option
from ._output import out


logger = logging.get_logger(__name__)


UPLOAD_LARGE_FOLDER_EXAMPLES = [
    "hf upload-large-folder Wauplin/my-cool-model ./large_model_dir",
    "hf upload-large-folder Wauplin/my-cool-model ./large_model_dir --revision v1.0",
]


def upload_large_folder(
    repo_id: RepoIdArg,
    local_path: Annotated[
        str,
        Argument(
            help="Local path to the folder to upload.",
        ),
    ],
    repo_type: RepoTypeOpt = RepoType.model,
    revision: RevisionOpt = None,
    private: PrivateOpt = None,
    include: Annotated[
        list[str] | None,
        Option(
            help="Glob patterns to match files to upload.",
        ),
    ] = None,
    exclude: Annotated[
        list[str] | None,
        Option(
            help="Glob patterns to exclude from files to upload.",
        ),
    ] = None,
    token: TokenOpt = None,
    num_workers: Annotated[
        int | None,
        Option(
            help="Number of workers to use to hash, upload and commit files.",
        ),
    ] = None,
    no_report: Annotated[
        bool,
        Option(
            help="Whether to disable regular status report.",
        ),
    ] = False,
    no_bars: Annotated[
        bool,
        Option(
            help="Whether to disable progress bars.",
        ),
    ] = False,
) -> None:
    """[Deprecated] Upload a large folder to the Hub. Use `hf upload` instead."""
    if not os.path.isdir(local_path):
        raise click.BadParameter("Large upload is only supported for folders.", param_hint="local_path")

    # Build the equivalent `hf upload` command to recommend to the user.
    equivalent = [f"hf upload {repo_id} '{local_path}' --repo-type {repo_type.value}"]
    if revision is not None:
        equivalent.append(f"--revision '{revision}'")
    if private:
        equivalent.append("--private")
    for pattern in include or []:
        equivalent.append(f"--include '{pattern}'")
    for pattern in exclude or []:
        equivalent.append(f"--exclude '{pattern}'")

    out.warning(
        "\n"
        "================================================================================\n"
        "`hf upload-large-folder` is DEPRECATED and will be removed in a future release.\n"
        "\n"
        "Use `hf upload` instead:\n"
        "\n"
        f"    {' '.join(equivalent)}\n"
        "================================================================================"
    )

    if no_bars:
        disable_progress_bars()

    api = get_hf_api(token=token)
    with warnings.catch_warnings():
        # Avoid printing the API-level deprecation warning on top of the CLI one above.
        warnings.simplefilter("ignore", FutureWarning)
        api.upload_large_folder(
            repo_id=repo_id,
            folder_path=local_path,
            repo_type=repo_type.value,
            revision=revision,
            private=private,
            allow_patterns=include,
            ignore_patterns=exclude,
            num_workers=num_workers,
            print_report=not no_report,
        )
