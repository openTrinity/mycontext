# Copyright 2022 The HuggingFace Team. All rights reserved.
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
"""Contains commands to print information about the environment and version."""

import click

from huggingface_hub import __version__

from ..utils import dump_environment_info
from ._cli_utils import _fetch_latest_pypi_version, run_update
from ._output import out


def env() -> None:
    """Print information about the environment."""
    dump_environment_info()


def version() -> None:
    """Print information about the hf version."""
    out.result("hf version", version=__version__)


def update() -> None:
    """Update the `hf` CLI to the latest version."""
    out.text(f"Current version: {__version__}")
    out.text("Checking for updates to latest version...")
    latest_version = _fetch_latest_pypi_version("huggingface_hub")
    if latest_version is not None and __version__ == latest_version:
        out.text(f"hf is up to date ({__version__})")
        return

    returncode = run_update()
    if returncode != 0:
        raise click.exceptions.Exit(code=returncode)
    out.hint(
        "You may also want to run `hf skills update` to refresh any installed skills "
        "so your AI agent sees the latest command surface."
    )
