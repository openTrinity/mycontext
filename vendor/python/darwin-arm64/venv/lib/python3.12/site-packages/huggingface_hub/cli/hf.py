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

import os
import sys
import traceback
from typing import Annotated

import click

from huggingface_hub import __version__, constants
from huggingface_hub.cli._cli_utils import check_cli_update, fallback_typer_group_factory, typer_factory
from huggingface_hub.cli._cp import CP_EXAMPLES, make_cp
from huggingface_hub.cli._errors import format_known_exception
from huggingface_hub.cli._output import out
from huggingface_hub.cli.auth import auth_cli
from huggingface_hub.cli.buckets import buckets_cli, sync
from huggingface_hub.cli.cache import cache_cli
from huggingface_hub.cli.collections import collections_cli
from huggingface_hub.cli.datasets import datasets_cli
from huggingface_hub.cli.discussions import discussions_cli
from huggingface_hub.cli.download import DOWNLOAD_EXAMPLES, download
from huggingface_hub.cli.extensions import (
    dispatch_unknown_top_level_extension,
    extensions_cli,
    list_installed_extensions_for_help,
)
from huggingface_hub.cli.inference_endpoints import ie_cli
from huggingface_hub.cli.jobs import jobs_cli
from huggingface_hub.cli.lfs import lfs_enable_largefiles, lfs_multipart_upload
from huggingface_hub.cli.models import models_cli
from huggingface_hub.cli.papers import papers_cli
from huggingface_hub.cli.repo_files import repo_files_cli
from huggingface_hub.cli.repos import repos_cli
from huggingface_hub.cli.sandbox import sandbox_cli
from huggingface_hub.cli.skills import skills_cli
from huggingface_hub.cli.spaces import spaces_cli
from huggingface_hub.cli.system import env, update, version
from huggingface_hub.cli.upload import UPLOAD_EXAMPLES, upload
from huggingface_hub.cli.upload_large_folder import UPLOAD_LARGE_FOLDER_EXAMPLES, upload_large_folder
from huggingface_hub.cli.webhooks import webhooks_cli
from huggingface_hub.utils import logging

from ._completion import _COMPLETE_VAR, InstallCompletionOpt, ShowCompletionOpt
from ._framework import Option


app = typer_factory(
    help="Hugging Face Hub CLI",
    cls=fallback_typer_group_factory(
        dispatch_unknown_top_level_extension,
        extra_commands_provider=list_installed_extensions_for_help,
    ),
)


def _version_callback(value: bool) -> None:
    if value:
        print(__version__)
        raise click.exceptions.Exit()


@app.group_callback(invoke_without_command=True)
def app_callback(
    version: Annotated[
        bool | None, Option("-v", "--version", callback=_version_callback, is_eager=True, hidden=True)
    ] = None,
    install_completion: InstallCompletionOpt = False,
    show_completion: ShowCompletionOpt = False,
) -> None:
    pass


# top level single commands (defined in their respective files)
app.command(examples=CP_EXAMPLES)(make_cp())
app.command()(sync)
app.command(examples=DOWNLOAD_EXAMPLES)(download)
app.command(examples=UPLOAD_EXAMPLES)(upload)
app.command(examples=UPLOAD_LARGE_FOLDER_EXAMPLES)(upload_large_folder)

app.command(topic="help")(env)
app.command(topic="help")(update)
app.command(topic="help")(version)

app.command(hidden=True)(lfs_enable_largefiles)
app.command(hidden=True)(lfs_multipart_upload)

# command groups
app.add_group(auth_cli, name="auth")
app.add_group(buckets_cli, name="buckets")
app.add_group(cache_cli, name="cache")
app.add_group(collections_cli, name="collections")
app.add_group(datasets_cli, name="datasets")
app.add_group(discussions_cli, name="discussions")
app.add_group(jobs_cli, name="jobs")
app.add_group(models_cli, name="models")
app.add_group(papers_cli, name="papers")
app.add_group(repos_cli, name="repos | repo")
app.add_group(repo_files_cli, name="repo-files", hidden=True)
app.add_group(sandbox_cli, name="sandbox")
app.add_group(skills_cli, name="skills")
app.add_group(spaces_cli, name="spaces")
app.add_group(webhooks_cli, name="webhooks")
app.add_group(ie_cli, name="endpoints")
app.add_group(extensions_cli, name="extensions | ext")


def main():
    # Shell-completion requests must stay fast and emit nothing but candidates:
    # skip the startup work and let click handle the env var inside `app()`.
    if _COMPLETE_VAR not in os.environ:
        if not constants.HF_DEBUG:
            logging.set_verbosity_info()
        check_cli_update("huggingface_hub")

    try:
        app()
    except Exception as e:
        message = format_known_exception(e)
        if message:
            out.error(message)
            if constants.HF_DEBUG:
                traceback.print_exc()
            else:
                out.hint("set HF_DEBUG=1 as environment variable for full traceback.")
            sys.exit(1)
        raise


if __name__ == "__main__":
    main()
