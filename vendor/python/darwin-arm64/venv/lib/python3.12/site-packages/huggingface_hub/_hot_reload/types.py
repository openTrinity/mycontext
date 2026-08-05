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


from typing import Literal, TypedDict

from typing_extensions import NotRequired


class ReloadRegion(TypedDict):
    startLine: int
    startCol: int
    endLine: int
    endCol: int


class ReloadOperationObject(TypedDict):
    kind: Literal["add", "update", "delete"]
    region: ReloadRegion
    objectType: str
    objectName: str


class ReloadOperationRun(TypedDict):
    kind: Literal["run"]
    region: ReloadRegion
    codeLines: str
    stdout: NotRequired[str]
    stderr: NotRequired[str]


class ReloadOperationException(TypedDict):
    kind: Literal["exception"]
    region: ReloadRegion
    traceback: str


class ReloadOperationError(TypedDict):
    kind: Literal["error"]
    traceback: str


class ReloadOperationUI(TypedDict):
    kind: Literal["ui"]
    updated: bool


class ReloadOperationFile(TypedDict):
    kind: Literal["file"]
    created: bool


class ApiCreateReloadRequest(TypedDict):
    filepath: str
    contents: str
    reloadId: NotRequired[str]


class ApiCreateReloadResponseSuccess(TypedDict):
    status: Literal["created"]
    reloadId: str


class ApiCreateReloadResponseError(TypedDict):
    status: Literal["alreadyReloading", "fileNotFound"]


class ApiCreateReloadResponse(TypedDict):
    res: ApiCreateReloadResponseError | ApiCreateReloadResponseSuccess


class ApiGetReloadRequest(TypedDict):
    reloadId: str


class ApiGetReloadEventSourceData(TypedDict):
    data: (
        ReloadOperationError
        | ReloadOperationException
        | ReloadOperationObject
        | ReloadOperationRun
        | ReloadOperationUI
        | ReloadOperationFile
    )


class ApiGetStatusRequest(TypedDict):
    revision: str


class ApiGetStatusResponse(TypedDict):
    reloading: bool
    uncommited: list[str]


class ApiFetchContentsRequest(TypedDict):
    filepath: str


class ApiFetchContentsResponseError(TypedDict):
    status: Literal["fileNotFound"]


class ApiFetchContentsResponseSuccess(TypedDict):
    status: Literal["ok"]
    contents: str


class ApiFetchContentsResponse(TypedDict):
    res: ApiFetchContentsResponseError | ApiFetchContentsResponseSuccess
