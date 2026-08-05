"""Deprecated `huggingface-cli` entry point. Warns and exits."""

import shutil
import sys

from ._output import out


def main() -> None:
    out.warning("`huggingface-cli` is deprecated and no longer works. Use `hf` instead.\n")

    if shutil.which("hf"):
        from huggingface_hub.cli._cli_utils import check_cli_update

        check_cli_update("huggingface_hub")
        out.hint("`hf` is already installed! Use it directly.\n")
    else:
        out.hint(
            "Install `hf`:\n"
            "  Standalone (recommended): curl -LsSf https://hf.co/cli/install.sh | bash\n"
            "  Using Homebrew:           brew install hf\n"
            "  Using pip:                pip install huggingface_hub\n",
        )

    out.hint(
        "Examples:\n"
        "  hf auth login\n"
        "  hf download unsloth/gemma-4-31B-it-GGUF\n"
        "  hf upload my-cool-model . .\n"
        '  hf models ls --search "gemma"\n'
        "  hf repos ls --format json\n"
        "  hf jobs run python:3.12 python -c 'print(\"Hello!\")'\n"
        "  hf --help\n",
    )
    sys.exit(1)
