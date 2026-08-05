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
"""Contains commands to interact with discussions and pull requests on the Hugging Face Hub."""

import enum
import sys
from pathlib import Path
from typing import Annotated

import click

from huggingface_hub import constants

from ._cli_utils import (
    AuthorOpt,
    LimitOpt,
    RepoIdArg,
    RepoType,
    RepoTypeOpt,
    TokenOpt,
    get_hf_api,
    typer_factory,
)
from ._framework import Argument, Option
from ._output import _dataclass_to_dict, out


class DiscussionStatus(str, enum.Enum):
    open = "open"
    closed = "closed"
    merged = "merged"
    draft = "draft"
    all = "all"


class DiscussionKind(str, enum.Enum):
    all = "all"
    discussion = "discussion"
    pull_request = "pull_request"


# "merged" and "draft" are valid Discussion statuses but the Hub API filter
# (DiscussionStatusFilter) only accepts "all", "open", "closed". When the user
# asks for merged/draft we fetch with api_status=None (i.e. all) and filter
# client-side.
_CLIENT_SIDE_STATUSES = {"merged", "draft"}


DiscussionNumArg = Annotated[
    int,
    Argument(
        help="The discussion or pull request number.",
        min=1,
    ),
]


def _read_body(body: str | None, body_file: Path | None) -> str | None:
    """Resolve body text from --body or --body-file (supports '-' for stdin)."""
    if body is not None and body_file is not None:
        raise click.BadParameter("Cannot use both --body and --body-file.")
    if body_file is not None:
        if str(body_file) == "-":
            return sys.stdin.read()
        return body_file.read_text(encoding="utf-8")
    return body


discussions_cli = typer_factory(help="Manage discussions and pull requests on the Hub.")


@discussions_cli.command(
    "list | ls",
    examples=[
        "hf discussions list username/my-model",
        "hf discussions list username/my-model --kind pull_request --status merged",
        "hf discussions list username/my-dataset --type dataset --status closed",
        "hf discussions list username/my-model --author alice --format json",
    ],
)
def discussion_list(
    repo_id: RepoIdArg,
    status: Annotated[
        DiscussionStatus,
        Option(
            "-s",
            "--status",
            help="Filter by status (open, closed, merged, draft, all).",
        ),
    ] = DiscussionStatus.open,
    kind: Annotated[
        DiscussionKind,
        Option(
            "-k",
            "--kind",
            help="Filter by kind (discussion, pull_request, all).",
        ),
    ] = DiscussionKind.all,
    author: AuthorOpt = None,
    limit: LimitOpt = 30,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """List discussions and pull requests on a repo."""
    api = get_hf_api(token=token)

    api_status: constants.DiscussionStatusFilter | None
    if status == DiscussionStatus.open:
        api_status = "open"
    elif status == DiscussionStatus.closed:
        api_status = "closed"
    else:
        api_status = None

    api_discussion_type: constants.DiscussionTypeFilter | None
    if kind == DiscussionKind.all:
        api_discussion_type = None
    else:
        api_discussion_type = kind.value  # type: ignore[assignment]

    discussions = []
    for d in api.get_repo_discussions(
        repo_id=repo_id,
        author=author,
        discussion_type=api_discussion_type,
        discussion_status=api_status,
        repo_type=repo_type.value,
    ):
        if status.value in _CLIENT_SIDE_STATUSES and d.status != status.value:
            continue
        discussions.append(d)
        if len(discussions) >= limit:
            break

    items = [_dataclass_to_dict(d) for d in discussions]
    out.table(
        items,
        headers=["num", "title", "is_pull_request", "status", "author", "created_at"],
        id_key="num",
    )


@discussions_cli.command(
    "info",
    examples=[
        "hf discussions info username/my-model 5",
        "hf discussions info username/my-model 5 --format json",
    ],
)
def discussion_info(
    repo_id: RepoIdArg,
    num: DiscussionNumArg,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """Get info about a discussion or pull request."""
    api = get_hf_api(token=token)
    details = api.get_discussion_details(
        repo_id=repo_id,
        discussion_num=num,
        repo_type=repo_type.value,
    )
    out.dict(details)


@discussions_cli.command(
    "create",
    examples=[
        'hf discussions create username/my-model --title "Bug report"',
        'hf discussions create username/my-model --title "Feature request" --body "Please add X"',
        'hf discussions create username/my-model --title "Fix typo" --pull-request',
        'hf discussions create username/my-dataset --type dataset --title "Data quality issue"',
    ],
)
def discussion_create(
    repo_id: RepoIdArg,
    title: Annotated[
        str,
        Option(
            "--title",
            help="The title of the discussion or pull request.",
        ),
    ],
    body: Annotated[
        str | None,
        Option(
            "--body",
            help="The description (supports Markdown).",
        ),
    ] = None,
    body_file: Annotated[
        Path | None,
        Option(
            "--body-file",
            help="Read the description from a file. Use '-' for stdin.",
        ),
    ] = None,
    pull_request: Annotated[
        bool,
        Option(
            "--pull-request",
            "--pr",
            help="Create a pull request instead of a discussion.",
        ),
    ] = False,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """Create a new discussion or pull request on a repo."""
    description = _read_body(body, body_file)
    api = get_hf_api(token=token)
    discussion = api.create_discussion(
        repo_id=repo_id,
        title=title,
        description=description,
        repo_type=repo_type.value,
        pull_request=pull_request,
    )
    kind = "pull request" if pull_request else "discussion"
    ref = f"refs/pr/{discussion.num}" if pull_request else None
    out.result(f"Created {kind} #{discussion.num} on {repo_id}", num=discussion.num, url=discussion.url, ref=ref)


@discussions_cli.command(
    "comment",
    examples=[
        'hf discussions comment username/my-model 5 --body "Thanks for reporting!"',
        'hf discussions comment username/my-model 5 --body "LGTM!"',
    ],
)
def discussion_comment(
    repo_id: RepoIdArg,
    num: DiscussionNumArg,
    body: Annotated[
        str | None,
        Option(
            "--body",
            help="The comment text (supports Markdown).",
        ),
    ] = None,
    body_file: Annotated[
        Path | None,
        Option(
            "--body-file",
            help="Read the comment from a file. Use '-' for stdin.",
        ),
    ] = None,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """Comment on a discussion or pull request."""
    comment = _read_body(body, body_file)
    if comment is None:
        raise click.BadParameter("Either --body or --body-file is required.")
    api = get_hf_api(token=token)
    api.comment_discussion(
        repo_id=repo_id,
        discussion_num=num,
        comment=comment,
        repo_type=repo_type.value,
    )
    out.result(f"Commented on #{num} in {repo_id}", num=num, repo=repo_id)


@discussions_cli.command(
    "edit",
    examples=[
        'hf discussions edit username/my-model 5 abc123 --body "Updated comment."',
        "hf discussions edit username/my-model 5 abc123 --body-file fixed.md",
    ],
)
def discussion_edit(
    repo_id: RepoIdArg,
    num: DiscussionNumArg,
    comment_id: Annotated[
        str,
        Argument(
            help="The ID of the comment to edit (see 'hf discussions info ... --format json').",
        ),
    ],
    body: Annotated[
        str | None,
        Option(
            "--body",
            help="The new comment text (supports Markdown).",
        ),
    ] = None,
    body_file: Annotated[
        Path | None,
        Option(
            "--body-file",
            help="Read the new comment from a file. Use '-' for stdin.",
        ),
    ] = None,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """Edit an existing comment on a discussion or pull request."""
    new_content = _read_body(body, body_file)
    if new_content is None:
        raise click.BadParameter("Either --body or --body-file is required.")
    api = get_hf_api(token=token)
    api.edit_discussion_comment(
        repo_id=repo_id,
        discussion_num=num,
        comment_id=comment_id,
        new_content=new_content,
        repo_type=repo_type.value,
    )
    out.result(f"Edited comment {comment_id} on #{num} in {repo_id}", num=num, repo=repo_id, comment_id=comment_id)


@discussions_cli.command(
    "close",
    examples=[
        "hf discussions close username/my-model 5",
        'hf discussions close username/my-model 5 --comment "Closing as resolved."',
    ],
)
def discussion_close(
    repo_id: RepoIdArg,
    num: DiscussionNumArg,
    comment: Annotated[
        str | None,
        Option(
            "--comment",
            help="An optional comment to post when closing.",
        ),
    ] = None,
    yes: Annotated[
        bool,
        Option(
            "--yes",
            "-y",
            help="Skip confirmation prompt.",
        ),
    ] = False,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """Close a discussion or pull request."""
    out.confirm(f"Close #{num} on '{repo_id}'?", yes=yes)
    api = get_hf_api(token=token)
    api.change_discussion_status(
        repo_id=repo_id,
        discussion_num=num,
        new_status="closed",
        comment=comment,
        repo_type=repo_type.value,
    )
    out.result(f"Closed #{num} in {repo_id}", num=num, repo=repo_id)


@discussions_cli.command(
    "reopen",
    examples=[
        "hf discussions reopen username/my-model 5",
        'hf discussions reopen username/my-model 5 --comment "Reopening for further investigation."',
    ],
)
def discussion_reopen(
    repo_id: RepoIdArg,
    num: DiscussionNumArg,
    comment: Annotated[
        str | None,
        Option(
            "--comment",
            help="An optional comment to post when reopening.",
        ),
    ] = None,
    yes: Annotated[
        bool,
        Option(
            "--yes",
            "-y",
            help="Skip confirmation prompt.",
        ),
    ] = False,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """Reopen a closed discussion or pull request."""
    out.confirm(f"Reopen #{num} on '{repo_id}'?", yes=yes)
    api = get_hf_api(token=token)
    api.change_discussion_status(
        repo_id=repo_id,
        discussion_num=num,
        new_status="open",
        comment=comment,
        repo_type=repo_type.value,
    )
    out.result(f"Reopened #{num} in {repo_id}", num=num, repo=repo_id)


@discussions_cli.command(
    "rename",
    examples=[
        'hf discussions rename username/my-model 5 "Updated title"',
    ],
)
def discussion_rename(
    repo_id: RepoIdArg,
    num: DiscussionNumArg,
    new_title: Annotated[
        str,
        Argument(
            help="The new title.",
        ),
    ],
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """Rename a discussion or pull request."""
    api = get_hf_api(token=token)
    api.rename_discussion(
        repo_id=repo_id,
        discussion_num=num,
        new_title=new_title,
        repo_type=repo_type.value,
    )
    out.result(f"Renamed #{num} in {repo_id}", num=num, repo=repo_id, title=new_title)


@discussions_cli.command(
    "merge",
    examples=[
        "hf discussions merge username/my-model 5",
        'hf discussions merge username/my-model 5 --comment "Merging, thanks!"',
    ],
)
def discussion_merge(
    repo_id: RepoIdArg,
    num: DiscussionNumArg,
    comment: Annotated[
        str | None,
        Option(
            "--comment",
            help="An optional comment to post when merging.",
        ),
    ] = None,
    yes: Annotated[
        bool,
        Option(
            "--yes",
            "-y",
            help="Skip confirmation prompt.",
        ),
    ] = False,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """Merge a pull request."""
    out.confirm(f"Merge #{num} on '{repo_id}'?", yes=yes)
    api = get_hf_api(token=token)
    api.merge_pull_request(
        repo_id=repo_id,
        discussion_num=num,
        comment=comment,
        repo_type=repo_type.value,
    )
    out.result(f"Merged #{num} in {repo_id}", num=num, repo=repo_id)


@discussions_cli.command(
    "diff",
    examples=[
        "hf discussions diff username/my-model 5",
    ],
)
def discussion_diff(
    repo_id: RepoIdArg,
    num: DiscussionNumArg,
    repo_type: RepoTypeOpt = RepoType.model,
    token: TokenOpt = None,
) -> None:
    """Show the diff of a pull request."""
    api = get_hf_api(token=token)
    details = api.get_discussion_details(
        repo_id=repo_id,
        discussion_num=num,
        repo_type=repo_type.value,
    )
    if details.diff:
        out.text(details.diff)
    else:
        out.text("No diff available.")
