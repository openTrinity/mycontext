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
"""Contains commands to interact with papers on the Hugging Face Hub."""

import datetime
import enum
from typing import Annotated, get_args

from huggingface_hub.errors import CLIError, HfHubHTTPError
from huggingface_hub.hf_api import DailyPapersSort_T

from ._cli_utils import (
    LimitOpt,
    TokenOpt,
    get_hf_api,
    typer_factory,
)
from ._framework import Argument, Option
from ._output import _dataclass_to_dict, out


_SORT_OPTIONS = get_args(DailyPapersSort_T)
PaperSortEnum = enum.Enum("PaperSortEnum", {s: s for s in _SORT_OPTIONS}, type=str)  # type: ignore[misc]


def _parse_date(value: str | None) -> str | None:
    """Parse date option, converting 'today' to current date."""
    if value is None:
        return None
    if value.lower() == "today":
        return datetime.date.today().isoformat()
    return value


papers_cli = typer_factory(help="Interact with papers on the Hub.")


@papers_cli.command(
    "list | ls",
    examples=[
        "hf papers ls",
        "hf papers ls --sort trending",
        "hf papers ls --date 2025-01-23",
        "hf papers ls --week 2025-W09",
        "hf papers ls --submitter akhaliq",
        "hf papers ls --format json",
    ],
)
def papers_ls(
    date: Annotated[
        str | None,
        Option(
            help="Date in ISO format (YYYY-MM-DD) or 'today'.",
            callback=_parse_date,
        ),
    ] = None,
    week: Annotated[
        str | None,
        Option(help="ISO week to filter by, e.g. '2025-W09'."),
    ] = None,
    month: Annotated[
        str | None,
        Option(help="Month to filter by in ISO format (YYYY-MM), e.g. '2025-02'."),
    ] = None,
    submitter: Annotated[
        str | None,
        Option(help="Filter by username of the submitter."),
    ] = None,
    sort: Annotated[
        PaperSortEnum | None,
        Option(help="Sort results."),
    ] = None,
    limit: LimitOpt = 50,
    token: TokenOpt = None,
) -> None:
    """List daily papers on the Hub."""
    api = get_hf_api(token=token)
    sort_key = sort.value if sort else None
    results = []
    for paper_info in api.list_daily_papers(
        date=date,
        week=week,
        month=month,
        submitter=submitter,
        sort=sort_key,
        limit=limit,
    ):
        item = _dataclass_to_dict(paper_info)
        submitted_by = item.get("submitted_by") or {}
        item["submitted_by_name"] = submitted_by.get("fullname") or submitted_by.get("username") or ""
        results.append(item)
    out.table(
        results,
        headers=["id", "title", "upvotes", "comments", "published_at", "submitted_by_name"],
    )


@papers_cli.command(
    "search",
    examples=[
        'hf papers search "vision language"',
        'hf papers search "attention mechanism" --limit 10',
        'hf papers search "diffusion" --format json',
    ],
)
def papers_search(
    query: Annotated[str, Argument(help="Search query string.")],
    limit: LimitOpt = 20,
    token: TokenOpt = None,
) -> None:
    """Search papers on the Hub."""
    api = get_hf_api(token=token)
    results = [_dataclass_to_dict(paper_info) for paper_info in api.list_papers(query=query, limit=limit)]
    out.table(results, headers=["id", "title", "summary", "upvotes", "published_at"])


@papers_cli.command(
    "info",
    examples=[
        "hf papers info 2601.15621",
    ],
)
def papers_info(
    paper_id: Annotated[str, Argument(help="The arXiv paper ID (e.g. '2502.08025').")],
    token: TokenOpt = None,
) -> None:
    """Get info about a paper on the Hub."""
    api = get_hf_api(token=token)
    try:
        info = api.paper_info(id=paper_id)
    except HfHubHTTPError as e:
        if e.response.status_code == 404:
            raise CLIError(f"Paper '{paper_id}' not found on the Hub.") from e
        raise
    out.dict(info)


@papers_cli.command(
    "read",
    examples=[
        "hf papers read 2601.15621",
    ],
)
def papers_read(
    paper_id: Annotated[str, Argument(help="The arXiv paper ID (e.g. '2502.08025').")],
    token: TokenOpt = None,
) -> None:
    """Read a paper as markdown."""
    api = get_hf_api(token=token)
    try:
        content = api.read_paper(id=paper_id)
    except HfHubHTTPError as e:
        if e.response.status_code == 404:
            raise CLIError(f"Paper '{paper_id}' not found on the Hub.") from e
        raise
    out.text(content)
