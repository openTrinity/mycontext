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
"""Contains commands to manage webhooks on the Hugging Face Hub."""

import enum
from typing import Annotated, get_args, get_type_hints

import click

from huggingface_hub.constants import WEBHOOK_DOMAIN_T
from huggingface_hub.hf_api import WebhookWatchedItem

from ._cli_utils import (
    TokenOpt,
    get_hf_api,
    typer_factory,
)
from ._framework import Argument, Option
from ._output import out


# Build enums dynamically from Literal types to avoid duplication
_WATCHED_TYPES = get_args(get_type_hints(WebhookWatchedItem)["type"])
WatchedItemType = enum.Enum("WatchedItemType", {t: t for t in _WATCHED_TYPES}, type=str)  # type: ignore[misc]

_DOMAIN_TYPES = get_args(WEBHOOK_DOMAIN_T)
WebhookDomain = enum.Enum("WebhookDomain", {d: d for d in _DOMAIN_TYPES}, type=str)  # type: ignore[misc]


def _parse_watch(values: list[str]) -> list[WebhookWatchedItem]:
    """Parse 'type:name' strings into WebhookWatchedItem objects.

    Args:
        values: List of strings in the format 'type:name'
            (e.g., 'model:bert-base-uncased', 'org:HuggingFace').

    Returns:
        List of WebhookWatchedItem objects.

    Raises:
        click.BadParameter: If any value doesn't match the expected format.
    """
    items = []
    valid_types = tuple(_WATCHED_TYPES)
    for v in values:
        if ":" not in v:
            raise click.BadParameter(
                f"Expected format 'type:name' (e.g. 'model:bert-base-uncased'), got '{v}'."
                f" Valid types: {', '.join(valid_types)}."
            )
        kind, name = v.split(":", 1)
        if kind not in valid_types:
            raise click.BadParameter(f"Invalid type '{kind}'. Valid types: {', '.join(valid_types)}.")
        items.append(WebhookWatchedItem(type=kind, name=name))  # type: ignore
    return items


webhooks_cli = typer_factory(help="Manage webhooks on the Hub.")


@webhooks_cli.command(
    "list | ls",
    examples=[
        "hf webhooks ls",
        "hf webhooks ls --format json",
        "hf webhooks ls --format quiet",
    ],
)
def webhooks_ls(
    token: TokenOpt = None,
) -> None:
    """List all webhooks for the current user."""
    api = get_hf_api(token=token)
    results = [
        {
            "id": w.id,
            "url": w.url or "(job)",
            "disabled": w.disabled,
            "domains": w.domains or [],
            "watched": [f"{wi.type}:{wi.name}" for wi in (w.watched or [])],
        }
        for w in api.list_webhooks()
    ]
    out.table(results)


@webhooks_cli.command(
    "info",
    examples=[
        "hf webhooks info abc123",
    ],
)
def webhooks_info(
    webhook_id: Annotated[str, Argument(help="The ID of the webhook.")],
    token: TokenOpt = None,
) -> None:
    """Show full details for a single webhook."""
    api = get_hf_api(token=token)
    webhook = api.get_webhook(webhook_id)
    out.dict(webhook)


@webhooks_cli.command(
    "create",
    examples=[
        "hf webhooks create --url https://example.com/hook --watch model:bert-base-uncased",
        "hf webhooks create --url https://example.com/hook --watch org:HuggingFace --watch model:gpt2 --domain repo",
        "hf webhooks create --job-id 687f911eaea852de79c4a50a --watch user:julien-c",
    ],
)
def webhooks_create(
    watch: Annotated[
        list[str],
        Option(
            "--watch",
            help="Item to watch, in 'type:name' format (e.g. 'model:bert-base-uncased'). Repeatable.",
        ),
    ],
    url: Annotated[
        str | None,
        Option(help="URL to send webhook payloads to. Mutually exclusive with --job-id."),
    ] = None,
    job_id: Annotated[
        str | None,
        Option(
            "--job-id",
            help="ID of a Job to trigger (from job.id) instead of pinging a URL. Mutually exclusive with --url.",
        ),
    ] = None,
    domain: Annotated[
        list[WebhookDomain] | None,
        Option(
            "--domain",
            help="Domain to watch: 'repo' or 'discussions'. Repeatable. Defaults to all domains.",
        ),
    ] = None,
    secret: Annotated[
        str | None,
        Option(help="Optional secret used to sign webhook payloads."),
    ] = None,
    token: TokenOpt = None,
) -> None:
    """Create a new webhook.

    Provide either --url (to ping a remote server) or --job-id (to trigger a Job), but not both.
    """
    if url is not None and job_id is not None:
        raise click.BadParameter("Provide either --url or --job-id, not both.")
    if url is None and job_id is None:
        raise click.BadParameter("Provide either --url or --job-id.")
    api = get_hf_api(token=token)
    watched_items = _parse_watch(watch)
    domains = [d.value for d in domain] if domain else None
    webhook = api.create_webhook(url=url, job_id=job_id, watched=watched_items, domains=domains, secret=secret)  # type: ignore
    out.result("Webhook created", id=webhook.id)


@webhooks_cli.command(
    "update",
    examples=[
        "hf webhooks update abc123 --url https://new-url.com/hook",
        "hf webhooks update abc123 --watch model:gpt2 --domain repo",
        "hf webhooks update abc123 --secret newsecret",
    ],
)
def webhooks_update(
    webhook_id: Annotated[str, Argument(help="The ID of the webhook to update.")],
    url: Annotated[
        str | None,
        Option(help="New URL to send webhook payloads to."),
    ] = None,
    watch: Annotated[
        list[str] | None,
        Option(
            "--watch",
            help=(
                "New list of items to watch, in 'type:name' format. "
                "Repeatable. Replaces the entire existing watched list."
            ),
        ),
    ] = None,
    domain: Annotated[
        list[WebhookDomain] | None,
        Option(
            "--domain",
            help="New list of domains to watch: 'repo' or 'discussions'. Repeatable.",
        ),
    ] = None,
    secret: Annotated[
        str | None,
        Option(help="New secret used to sign webhook payloads."),
    ] = None,
    token: TokenOpt = None,
) -> None:
    """Update an existing webhook. Only provided options are changed."""
    api = get_hf_api(token=token)
    watched_items = _parse_watch(watch) if watch else None
    domains = [d.value for d in domain] if domain else None
    webhook = api.update_webhook(webhook_id, url=url, watched=watched_items, domains=domains, secret=secret)  # type: ignore
    out.result("Webhook updated", id=webhook.id)


@webhooks_cli.command(
    "enable",
    examples=[
        "hf webhooks enable abc123",
    ],
)
def webhooks_enable(
    webhook_id: Annotated[str, Argument(help="The ID of the webhook to enable.")],
    token: TokenOpt = None,
) -> None:
    """Enable a disabled webhook."""
    api = get_hf_api(token=token)
    webhook = api.enable_webhook(webhook_id)
    out.result("Webhook enabled", id=webhook.id)


@webhooks_cli.command(
    "disable",
    examples=[
        "hf webhooks disable abc123",
    ],
)
def webhooks_disable(
    webhook_id: Annotated[str, Argument(help="The ID of the webhook to disable.")],
    token: TokenOpt = None,
) -> None:
    """Disable an active webhook."""
    api = get_hf_api(token=token)
    webhook = api.disable_webhook(webhook_id)
    out.result("Webhook disabled", id=webhook.id)


@webhooks_cli.command(
    "delete",
    examples=[
        "hf webhooks delete abc123",
        "hf webhooks delete abc123 --yes",
    ],
)
def webhooks_delete(
    webhook_id: Annotated[str, Argument(help="The ID of the webhook to delete.")],
    yes: Annotated[
        bool,
        Option(
            "--yes",
            "-y",
            help="Skip confirmation prompt.",
        ),
    ] = False,
    token: TokenOpt = None,
) -> None:
    """Delete a webhook permanently."""
    out.confirm(f"Are you sure you want to delete webhook '{webhook_id}'?", yes=yes)
    api = get_hf_api(token=token)
    api.delete_webhook(webhook_id)
    out.result("Webhook deleted", id=webhook_id)
