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
"""Contains commands to interact with models on the Hugging Face Hub."""

import enum
from typing import Annotated, get_args

import click

from huggingface_hub.errors import CLIError, RepositoryNotFoundError, RevisionNotFoundError
from huggingface_hub.hf_api import ExpandModelProperty_T, ModelSort_T
from huggingface_hub.inference._providers import PROVIDER_T
from huggingface_hub.repocard import ModelCard

from ._cli_utils import (
    REPO_LIST_DEFAULT_LIMIT,
    AuthorOpt,
    FilterOpt,
    LimitOpt,
    RevisionOpt,
    SearchOpt,
    SoftChoice,
    TokenOpt,
    get_hf_api,
    make_expand_properties_parser,
    typer_factory,
)
from ._file_listing import list_repo_files_cmd
from ._framework import Argument, Option
from ._output import _dataclass_to_dict, out


_EXPAND_PROPERTIES = sorted(get_args(ExpandModelProperty_T))
_SORT_OPTIONS = get_args(ModelSort_T)
ModelSortEnum = enum.Enum("ModelSortEnum", {s: s for s in _SORT_OPTIONS}, type=str)  # type: ignore[misc]
InferenceProviderEnum = enum.Enum(  # type: ignore[misc]
    "InferenceProviderEnum", {p: p for p in sorted(get_args(PROVIDER_T))}, type=str
)


ExpandOpt = Annotated[
    str | None,
    Option(
        help=f"Comma-separated properties to return. When used, only the listed properties (and id) are returned. Example: '--expand=downloads,likes,tags'. Valid: {', '.join(_EXPAND_PROPERTIES)}.",
        callback=make_expand_properties_parser(_EXPAND_PROPERTIES),
    ),
]


models_cli = typer_factory(help="Interact with models on the Hub.")


@models_cli.command(
    "list | ls",
    examples=[
        "hf models ls --sort downloads --limit 10",
        'hf models ls --search "llama" --author meta-llama',
        "hf models ls --pipeline-tag text-generation --warm",
        "hf models ls --num-parameters min:6B,max:128B --sort likes",
        "hf models ls --no-gated --author google",
        "hf models ls --apps llama.cpp --apps vllm",
        "hf models ls --inference-provider fireworks-ai --sort downloads",
        "hf models ls --warm --search llama",
        "hf models ls meta-llama/Llama-3.2-1B-Instruct",
        "hf models ls meta-llama/Llama-3.2-1B-Instruct -R",
        "hf models ls meta-llama/Llama-3.2-1B-Instruct --tree -h",
    ],
)
def models_ls(
    repo_id: Annotated[
        str | None,
        Argument(help="Model ID (e.g. `username/repo-name`) to list files from. If omitted, lists models."),
    ] = None,
    search: SearchOpt = None,
    author: AuthorOpt = None,
    filter: FilterOpt = None,
    pipeline_tag: Annotated[
        str | None,
        Option("--pipeline-tag", help="Filter by pipeline tag (canonical task), e.g. 'summarization'."),
    ] = None,
    gated: Annotated[
        bool | None,
        Option(
            "--gated/--no-gated",
            help="Filter by gated status. '--gated' for gated only, '--no-gated' for non-gated only.",
        ),
    ] = None,
    apps: Annotated[
        list[str] | None,
        Option("--apps", help="Filter by app(s) that can run the model, e.g. 'ollama' or 'vllm'."),
    ] = None,
    num_parameters: Annotated[
        str | None,
        Option(help="Filter by parameter count, e.g. 'min:6B,max:128B'."),
    ] = None,
    inference_provider: Annotated[
        list[str] | None,
        Option(
            "--inference-provider",
            click_type=SoftChoice(InferenceProviderEnum),
            help="Filter by inference provider(s) serving the model, e.g. 'fireworks-ai'.",
        ),
    ] = None,
    warm: Annotated[
        bool,
        Option("--warm", help="Only list models currently served by at least one inference provider."),
    ] = False,
    sort: Annotated[
        ModelSortEnum | None,
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
    """List models on the Hub, or files in a model repo.

    When called with no argument, lists models on the Hub.
    When called with a model ID, lists files in that model repo.
    """
    if repo_id is not None:
        if search is not None:
            raise click.BadParameter("Cannot use --search when listing files.")
        if author is not None:
            raise click.BadParameter("Cannot use --author when listing files.")
        if filter is not None:
            raise click.BadParameter("Cannot use --filter when listing files.")
        if pipeline_tag is not None:
            raise click.BadParameter("Cannot use --pipeline-tag when listing files.")
        if gated is not None:
            raise click.BadParameter("Cannot use --gated/--no-gated when listing files.")
        if apps is not None:
            raise click.BadParameter("Cannot use --apps when listing files.")
        if num_parameters is not None:
            raise click.BadParameter("Cannot use --num-parameters when listing files.")
        if inference_provider is not None:
            raise click.BadParameter("Cannot use --inference-provider when listing files.")
        if warm:
            raise click.BadParameter("Cannot use --warm when listing files.")
        if sort is not None:
            raise click.BadParameter("Cannot use --sort when listing files.")
        if limit != REPO_LIST_DEFAULT_LIMIT:
            raise click.BadParameter("Cannot use --limit when listing files.")
        if expand is not None:
            raise click.BadParameter("Cannot use --expand when listing files.")
        return list_repo_files_cmd(
            repo_id=repo_id,
            repo_type="model",
            human_readable=human_readable,
            as_tree=as_tree,
            recursive=recursive,
            revision=revision,
            token=token,
        )

    if as_tree:
        raise click.BadParameter("Cannot use --tree when listing models.")
    if recursive:
        raise click.BadParameter("Cannot use --recursive when listing models.")
    if human_readable:
        raise click.BadParameter("Cannot use --human-readable when listing models.")
    if revision is not None:
        raise click.BadParameter("Cannot use --revision when listing models.")
    if warm and inference_provider is not None:
        raise click.BadParameter("Cannot use --warm together with --inference-provider.")
    api = get_hf_api(token=token)
    sort_key = sort.value if sort else None
    results = [
        _dataclass_to_dict(model_info)
        for model_info in api.list_models(
            filter=filter,
            author=author,
            search=search,
            pipeline_tag=pipeline_tag,
            gated=gated,
            apps=apps,
            num_parameters=num_parameters,
            inference="warm" if warm else None,
            inference_provider=inference_provider,
            sort=sort_key,
            limit=limit,
            expand=expand,  # type: ignore
        )
    ]
    out.table(results)
    if (inference_provider is not None or warm) and not expand:
        out.hint(
            "Use `--expand inferenceProviderMapping` to see which provider serves each model and the provider-specific model id."
        )


@models_cli.command(
    "info",
    examples=[
        "hf models info meta-llama/Llama-3.2-1B-Instruct",
        "hf models info Qwen/Qwen3.5-9B --expand downloads,likes,tags",
    ],
)
def models_info(
    model_id: Annotated[str, Argument(help="The model ID (e.g. `username/repo-name`).")],
    revision: RevisionOpt = None,
    expand: ExpandOpt = None,
    token: TokenOpt = None,
) -> None:
    """Get info about a model on the Hub."""
    api = get_hf_api(token=token)
    try:
        info = api.model_info(repo_id=model_id, revision=revision, expand=expand)  # type: ignore
    except RepositoryNotFoundError as e:
        raise CLIError(f"Model '{model_id}' not found.") from e
    except RevisionNotFoundError as e:
        raise CLIError(f"Revision '{revision}' not found on '{model_id}'.") from e
    out.dict(info)


@models_cli.command(
    "card",
    examples=[
        "hf models card google/gemma-4-31B-it",
        "hf models card google/gemma-4-31B-it --metadata",
        "hf models card google/gemma-4-31B-it --metadata --format json",
        "hf models card google/gemma-4-31B-it --text",
    ],
)
def models_card(
    model_id: Annotated[str, Argument(help="The model ID (e.g. `username/repo-name`).")],
    metadata: Annotated[bool, Option("--metadata", help="Output only the metadata from the card.")] = False,
    text: Annotated[bool, Option("--text", help="Output only the text body (no metadata).")] = False,
    token: TokenOpt = None,
) -> None:
    """Get the model card (README) for a model on the Hub."""
    if metadata and text:
        raise CLIError("--metadata and --text are mutually exclusive.")
    card = ModelCard.load(model_id, token=token)
    if metadata:
        out.dict(card.data.to_dict())
    elif text:
        out.text(card.text)
    else:
        out.text(card.content)
        out.hint(f"Use `hf models card {model_id} --metadata` to extract only the card metadata.")
