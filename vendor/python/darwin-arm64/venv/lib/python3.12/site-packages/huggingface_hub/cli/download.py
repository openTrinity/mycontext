# Copyright 202-present, the HuggingFace Inc. team.
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
"""Contains command to download files from the Hub with the CLI."""

import warnings
from typing import Annotated

from huggingface_hub import constants
from huggingface_hub._snapshot_download import snapshot_download
from huggingface_hub.errors import CLIError
from huggingface_hub.file_download import DryRunFileInfo, hf_hub_download
from huggingface_hub.utils import _format_size, parse_hf_uri

from ._cli_utils import RepoIdArg, RepoType, RepoTypeOptionalOpt, RevisionOpt, TokenOpt
from ._framework import Argument, Option
from ._output import out


DOWNLOAD_EXAMPLES = [
    "hf download meta-llama/Llama-3.2-1B-Instruct",
    "hf download meta-llama/Llama-3.2-1B-Instruct config.json tokenizer.json",
    'hf download meta-llama/Llama-3.2-1B-Instruct --include "*.safetensors" --exclude "*.bin"',
    "hf download meta-llama/Llama-3.2-1B-Instruct --local-dir ./models/llama",
    "hf download HuggingFaceM4/FineVision art/ --repo-type dataset",
    "hf download hf://datasets/HuggingFaceH4/ultrachat_200k",
]


def download(
    repo_id: RepoIdArg,
    filenames: Annotated[
        list[str] | None,
        Argument(
            help="Files to download (e.g. `config.json`, `data/metadata.jsonl`).",
        ),
    ] = None,
    repo_type: RepoTypeOptionalOpt = None,
    revision: RevisionOpt = None,
    include: Annotated[
        list[str] | None,
        Option(
            help="Glob patterns to include from files to download. eg: *.json",
        ),
    ] = None,
    exclude: Annotated[
        list[str] | None,
        Option(
            help="Glob patterns to exclude from files to download.",
        ),
    ] = None,
    cache_dir: Annotated[
        str | None,
        Option(
            help="Directory where to save files.",
        ),
    ] = None,
    local_dir: Annotated[
        str | None,
        Option(
            help="If set, the downloaded file will be placed under this directory. Check out https://huggingface.co/docs/huggingface_hub/guides/download#download-files-to-a-local-folder for more details.",
        ),
    ] = None,
    force_download: Annotated[
        bool,
        Option(
            help="If True, the files will be downloaded even if they are already cached.",
        ),
    ] = False,
    dry_run: Annotated[
        bool,
        Option(
            help="If True, perform a dry run without actually downloading the file.",
        ),
    ] = False,
    token: TokenOpt = None,
    max_workers: Annotated[
        int,
        Option(
            help="Maximum number of workers to use for downloading files. Default is 8.",
        ),
    ] = 8,
) -> None:
    """Download files from the Hub."""
    if local_dir is not None and cache_dir is not None:
        raise CLIError(
            "Cannot use both `--local-dir` and `--cache-dir` at the same time. "
            "Use `--cache-dir` (or set the HF_HOME environment variable) for shared caching, "
            "or `--local-dir` for a one-off download to a specific directory."
        )

    # `repo_id` may be a plain repo id or an `hf://` URI (e.g. `hf://datasets/my-org/my-dataset@v1.0/data/`).
    # When a URI is provided, it is authoritative for the repo type, revision and (optionally) file path,
    # so explicit `--repo-type` / `--revision` options are forbidden alongside it.
    # We branch on the `hf://` prefix (the user's *intent*) rather than on whether the string parses as a
    # valid URI: a malformed URI then surfaces a precise `HfUriError` (formatted globally in `cli/_errors.py`)
    # instead of silently falling through to the plain-repo-id path and failing later with an opaque error.
    if repo_id.startswith(constants.HF_PROTOCOL):
        if repo_type is not None:
            raise CLIError(f"'--repo-type' cannot be used with an 'hf://' URI ('{repo_id}').")
        if revision is not None:
            raise CLIError(f"'--revision' cannot be used with an 'hf://' URI ('{repo_id}').")
        uri = parse_hf_uri(repo_id)
        if uri.is_bucket:
            raise CLIError("Buckets are not supported by `hf download`. Use `hf sync` instead.")
        # The URI parser strips trailing slashes, but `hf download` uses a trailing '/' to denote a subfolder
        # download (e.g. `data/` -> `data/**`). Re-append it when the URI explicitly ended with '/' so a folder
        # URI keeps routing through the subfolder code path below.
        path_in_repo = uri.path_in_repo
        if path_in_repo and repo_id.endswith("/"):
            path_in_repo += "/"
        repo_id, repo_type_str, revision = uri.id, uri.type, uri.revision
        if path_in_repo:
            if filenames:
                raise CLIError(
                    f"Cannot combine a file path in the hf:// URI ('{path_in_repo}') with positional filenames {filenames}."
                )
            filenames = [path_in_repo]
    else:
        repo_type_str = (repo_type or RepoType.model).value

    def run_download() -> str | DryRunFileInfo | list[DryRunFileInfo]:
        filenames_list = filenames if filenames is not None else []

        # Separate subfolder patterns (ending with '/') from regular filenames
        # Subfolders like "art/" are converted to include patterns like "art/**"
        subfolders = [f for f in filenames_list if f.endswith("/")]
        subfolder_patterns = [f"{f.rstrip('/')}/**" for f in subfolders]
        regular_filenames = [f for f in filenames_list if not f.endswith("/")]

        # Error if subfolder patterns are combined with --include/--exclude
        # Guide user to use --include instead of subfolder argument
        if len(subfolder_patterns) > 0:
            if include is not None and len(include) > 0:
                raise CLIError(
                    f"Cannot combine subfolder argument ('{subfolders[0]}') with `--include`. "
                    f'Please use `--include "{subfolders[0]}*"` instead.'
                )
            if exclude is not None and len(exclude) > 0:
                raise CLIError(
                    f"Cannot combine subfolder argument ('{subfolders[0]}') with `--exclude`. "
                    f'Please use `--include "{subfolders[0]}*"` with `--exclude` instead.'
                )

        # Warn user if patterns are ignored (only if regular filenames are provided)
        if len(regular_filenames) > 0:
            if include is not None and len(include) > 0:
                warnings.warn("Ignoring `--include` since filenames have been explicitly set.")
            if exclude is not None and len(exclude) > 0:
                warnings.warn("Ignoring `--exclude` since filenames have been explicitly set.")

        # Single file to download (not a subfolder): use `hf_hub_download`
        if len(regular_filenames) == 1 and len(subfolder_patterns) == 0:
            return hf_hub_download(
                repo_id=repo_id,
                repo_type=repo_type_str,
                revision=revision,
                filename=regular_filenames[0],
                cache_dir=cache_dir,
                force_download=force_download,
                token=token,
                local_dir=local_dir,
                library_name="huggingface-cli",
                dry_run=dry_run,
            )

        # Otherwise: use `snapshot_download` to ensure all files comes from same revision
        if len(regular_filenames) == 0 and len(subfolder_patterns) == 0:
            # No filenames provided: use include/exclude patterns
            allow_patterns = include
            ignore_patterns = exclude
        else:
            # Combine regular filenames and subfolder patterns as allow_patterns
            allow_patterns = regular_filenames + subfolder_patterns
            ignore_patterns = None

        return snapshot_download(
            repo_id=repo_id,
            repo_type=repo_type_str,
            revision=revision,
            allow_patterns=allow_patterns,
            ignore_patterns=ignore_patterns,
            force_download=force_download,
            cache_dir=cache_dir,
            token=token,
            local_dir=local_dir,
            library_name="huggingface-cli",
            max_workers=max_workers,
            dry_run=dry_run,
        )

    def _print_result(result: str | DryRunFileInfo | list[DryRunFileInfo]) -> None:
        if isinstance(result, str):
            out.result("Downloaded", path=result)
            return

        # Print dry run info
        if isinstance(result, DryRunFileInfo):
            result = [result]
        will_download = [r for r in result if r.will_download]
        out.text(
            f"[dry-run] Will download {len(will_download)} files"
            f" (out of {len(result)})"
            f" totalling {_format_size(sum(r.file_size for r in will_download))}."
        )
        items = [
            {
                "file": info.filename,
                "size": _format_size(info.file_size) if info.will_download else "-",
            }
            for info in sorted(result, key=lambda x: x.filename)
        ]
        out.table(items)

    _print_result(run_download())
