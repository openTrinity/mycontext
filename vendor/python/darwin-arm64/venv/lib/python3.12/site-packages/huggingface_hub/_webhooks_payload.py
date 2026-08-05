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
"""Contains data structures to parse the webhooks payload."""

from typing import Literal

from .utils import is_pydantic_available


if is_pydantic_available():
    from pydantic import BaseModel
else:
    # Define a dummy BaseModel to avoid import errors when pydantic is not installed
    # Import error will be raised when trying to use the class

    class BaseModel:  # type: ignore [no-redef]
        def __init__(self, *args, **kwargs) -> None:
            raise ImportError(
                "You must have `pydantic` installed to use `WebhookPayload`. This is an optional dependency that"
                " should be installed separately. Please run `pip install --upgrade pydantic` and retry."
            )


# This is an adaptation of the ReportV3 interface implemented in moon-landing. V0, V1 and V2 have been ignored as they
# are not in used anymore. To keep in sync when format is updated in
# https://github.com/huggingface/moon-landing/blob/main/server/lib/HFWebhooks.ts (internal link).


WebhookEvent_T = Literal[
    "create",
    "delete",
    "move",
    "update",
]
RepoChangeEvent_T = Literal[
    "add",
    "move",
    "remove",
    "update",
]
RepoType_T = Literal[
    "dataset",
    "model",
    "space",
]
DiscussionStatus_T = Literal[
    "closed",
    "draft",
    "open",
    "merged",
]
SupportedWebhookVersion = Literal[3]


class ObjectId(BaseModel):
    id: str


class WebhookPayloadUrl(BaseModel):
    web: str
    api: str | None = None


class WebhookPayloadMovedTo(BaseModel):
    name: str
    owner: ObjectId


class WebhookPayloadWebhook(ObjectId):
    version: SupportedWebhookVersion


class WebhookPayloadEvent(BaseModel):
    action: WebhookEvent_T
    scope: str


class WebhookPayloadDiscussionChanges(BaseModel):
    base: str
    mergeCommitId: str | None = None


class WebhookPayloadComment(ObjectId):
    author: ObjectId
    hidden: bool
    content: str | None = None
    url: WebhookPayloadUrl


class WebhookPayloadDiscussion(ObjectId):
    num: int
    author: ObjectId
    url: WebhookPayloadUrl
    title: str
    isPullRequest: bool
    status: DiscussionStatus_T
    changes: WebhookPayloadDiscussionChanges | None = None
    pinned: bool | None = None


class WebhookPayloadRepo(ObjectId):
    owner: ObjectId
    head_sha: str | None = None
    name: str
    private: bool
    subdomain: str | None = None
    tags: list[str] | None = None
    type: Literal["dataset", "model", "space"]
    url: WebhookPayloadUrl


class WebhookPayloadUpdatedRef(BaseModel):
    ref: str
    oldSha: str | None = None
    newSha: str | None = None


class WebhookPayload(BaseModel):
    event: WebhookPayloadEvent
    repo: WebhookPayloadRepo
    discussion: WebhookPayloadDiscussion | None = None
    comment: WebhookPayloadComment | None = None
    webhook: WebhookPayloadWebhook
    movedTo: WebhookPayloadMovedTo | None = None
    updatedRefs: list[WebhookPayloadUpdatedRef] | None = None
