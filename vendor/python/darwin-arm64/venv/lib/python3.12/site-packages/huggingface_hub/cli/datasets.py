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
"""Contains commands to interact with datasets on the Hugging Face Hub."""

import enum
from typing import Annotated, get_args

import click

from huggingface_hub._dataset_viewer import execute_raw_sql_query
from huggingface_hub.errors import CLIError, RepositoryNotFoundError, RevisionNotFoundError
from huggingface_hub.hf_api import DatasetSort_T, ExpandDatasetProperty_T
from huggingface_hub.repocard import DatasetCard

from ._cli_utils import (
    REPO_LIST_DEFAULT_LIMIT,
    AuthorOpt,
    FilterOpt,
    LimitOpt,
    RevisionOpt,
    SearchOpt,
    TokenOpt,
    get_hf_api,
    make_expand_properties_parser,
    typer_factory,
)
from ._file_listing import list_repo_files_cmd
from ._framework import Argument, Option
from ._output import _dataclass_to_dict, out


_EXPAND_PROPERTIES = sorted(get_args(ExpandDatasetProperty_T))
_SORT_OPTIONS = get_args(DatasetSort_T)
DatasetSortEnum = enum.Enum("DatasetSortEnum", {s: s for s in _SORT_OPTIONS}, type=str)  # type: ignore[misc]


ExpandOpt = Annotated[
    str | None,
    Option(
        help=f"Comma-separated properties to return. When used, only the listed properties (and id) are returned. Example: '--expand=downloads,likes,tags'. Valid: {', '.join(_EXPAND_PROPERTIES)}.",
        callback=make_expand_properties_parser(_EXPAND_PROPERTIES),
    ),
]


datasets_cli = typer_factory(help="Interact with datasets on the Hub.")


@datasets_cli.command(
    "list | ls",
    examples=[
        "hf datasets ls",
        "hf datasets ls --sort downloads --limit 10",
        'hf datasets ls --search "code"',
        "hf datasets ls --filter benchmark:official",
        "hf datasets ls HuggingFaceFW/fineweb",
        "hf datasets ls HuggingFaceFW/fineweb -R",
        "hf datasets ls HuggingFaceFW/fineweb --tree -h",
    ],
)
def datasets_ls(
    repo_id: Annotated[
        str | None,
        Argument(help="Dataset ID (e.g. `username/repo-name`) to list files from. If omitted, lists datasets."),
    ] = None,
    search: SearchOpt = None,
    author: AuthorOpt = None,
    filter: FilterOpt = None,
    sort: Annotated[
        DatasetSortEnum | None,
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
    """List datasets on the Hub, or files in a dataset repo.

    When called with no argument, lists datasets on the Hub.
    When called with a dataset ID, lists files in that dataset repo.
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
            repo_type="dataset",
            human_readable=human_readable,
            as_tree=as_tree,
            recursive=recursive,
            revision=revision,
            token=token,
        )

    if as_tree:
        raise click.BadParameter("Cannot use --tree when listing datasets.")
    if recursive:
        raise click.BadParameter("Cannot use --recursive when listing datasets.")
    if human_readable:
        raise click.BadParameter("Cannot use --human-readable when listing datasets.")
    if revision is not None:
        raise click.BadParameter("Cannot use --revision when listing datasets.")

    api = get_hf_api(token=token)
    sort_key = sort.value if sort else None
    results = [
        _dataclass_to_dict(dataset_info)
        for dataset_info in api.list_datasets(
            filter=filter,
            author=author,
            search=search,
            sort=sort_key,
            limit=limit,
            expand=expand,  # type: ignore
        )
    ]
    out.table(results)


@datasets_cli.command(
    "leaderboard",
    examples=[
        "hf datasets leaderboard SWE-bench/SWE-bench_Verified",
        "hf datasets leaderboard SWE-bench/SWE-bench_Verified --limit 5 --format json",
        "hf datasets ls --filter benchmark:official  # list available leaderboards",
    ],
)
def datasets_leaderboard(
    dataset_id: Annotated[str, Argument(help="The benchmark dataset ID (e.g. `SWE-bench/SWE-bench_Verified`).")],
    limit: LimitOpt = 20,
    token: TokenOpt = None,
) -> None:
    """List model scores from a dataset leaderboard. This command helps find the best models for a task or compare models by benchmark scores. Use 'hf datasets ls --filter benchmark:official' to list available leaderboards."""
    api = get_hf_api(token=token)
    leaderboard = api.get_dataset_leaderboard(repo_id=dataset_id)
    results = [_dataclass_to_dict(entry) for entry in leaderboard[:limit]]
    out.table(
        results,
        headers=["rank", "model_id", "value", "source"],
        id_key="model_id",
    )
    out.hint("Use 'hf datasets ls --filter benchmark:official' to list available leaderboards.")
    if leaderboard:
        out.hint(f"Use 'hf models info {leaderboard[0].model_id}' to get details about a model.")


@datasets_cli.command(
    "info",
    examples=[
        "hf datasets info HuggingFaceFW/fineweb",
        "hf datasets info my-dataset --expand downloads,likes,tags",
    ],
)
def datasets_info(
    dataset_id: Annotated[str, Argument(help="The dataset ID (e.g. `username/repo-name`).")],
    revision: RevisionOpt = None,
    expand: ExpandOpt = None,
    token: TokenOpt = None,
) -> None:
    """Get info about a dataset on the Hub."""
    api = get_hf_api(token=token)
    try:
        info = api.dataset_info(repo_id=dataset_id, revision=revision, expand=expand)  # type: ignore
    except RepositoryNotFoundError as e:
        raise CLIError(f"Dataset '{dataset_id}' not found.") from e
    except RevisionNotFoundError as e:
        raise CLIError(f"Revision '{revision}' not found on '{dataset_id}'.") from e
    out.dict(info)


@datasets_cli.command(
    "parquet",
    examples=[
        "hf datasets parquet cfahlgren1/hub-stats",
        "hf datasets parquet cfahlgren1/hub-stats --subset models",
        "hf datasets parquet cfahlgren1/hub-stats --split train",
        "hf datasets parquet cfahlgren1/hub-stats --format json",
    ],
)
def datasets_parquet(
    dataset_id: Annotated[str, Argument(help="The dataset ID (e.g. `username/repo-name`).")],
    subset: Annotated[str | None, Option("--subset", help="Filter parquet entries by subset/config.")] = None,
    split: Annotated[str | None, Option(help="Filter parquet entries by split.")] = None,
    token: TokenOpt = None,
) -> None:
    """List parquet file URLs available for a dataset."""
    api = get_hf_api(token=token)
    entries = api.list_dataset_parquet_files(repo_id=dataset_id, config=subset)
    filtered = [entry for entry in entries if split is None or entry.split == split]
    results = [
        {"subset": entry.config, "split": entry.split, "url": entry.url, "size": entry.size} for entry in filtered
    ]
    out.table(results, headers=["subset", "split", "url", "size"], id_key="url")


@datasets_cli.command(
    "sql",
    examples=[
        "hf datasets sql \"SELECT COUNT(*) AS rows FROM read_parquet('https://huggingface.co/api/datasets/cfahlgren1/hub-stats/parquet/models/train/0.parquet')\"",
        "hf datasets sql \"SELECT * FROM read_parquet('https://huggingface.co/api/datasets/cfahlgren1/hub-stats/parquet/models/train/0.parquet') LIMIT 5\" --format json",
    ],
)
def datasets_sql(
    sql: Annotated[str, Argument(help="Raw SQL query to execute.")],
    token: TokenOpt = None,
) -> None:
    """Execute a raw SQL query with DuckDB against dataset parquet URLs."""
    try:
        result = execute_raw_sql_query(sql_query=sql, token=token)
    except ImportError as e:
        raise CLIError(str(e)) from e
    out.table(result)


@datasets_cli.command(
    "card",
    examples=[
        "hf datasets card HuggingFaceFW/fineweb",
        "hf datasets card HuggingFaceFW/fineweb --metadata",
        "hf datasets card HuggingFaceFW/fineweb --metadata --format json",
        "hf datasets card HuggingFaceFW/fineweb --text",
    ],
)
def datasets_card(
    dataset_id: Annotated[str, Argument(help="The dataset ID (e.g. `username/repo-name`).")],
    metadata: Annotated[bool, Option("--metadata", help="Output only the metadata from the card.")] = False,
    text: Annotated[bool, Option("--text", help="Output only the text body (no metadata).")] = False,
    token: TokenOpt = None,
) -> None:
    """Get the dataset card (README) for a dataset on the Hub."""
    if metadata and text:
        raise CLIError("--metadata and --text are mutually exclusive.")
    card = DatasetCard.load(dataset_id, token=token)
    if metadata:
        out.dict(card.data.to_dict())
    elif text:
        out.text(card.text)
    else:
        out.text(card.content)
        out.hint(f"Use `hf datasets card {dataset_id} --metadata` to extract only the card metadata.")
