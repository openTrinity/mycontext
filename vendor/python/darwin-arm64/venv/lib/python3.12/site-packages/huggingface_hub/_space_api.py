# Copyright 2019-present, the HuggingFace Inc. team.
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
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Literal

from huggingface_hub.utils import HfMount, HfUri, parse_datetime


class SpaceStage(str, Enum):
    """
    Enumeration of possible stage of a Space on the Hub.

    Value can be compared to a string:
    ```py
    assert SpaceStage.BUILDING == "BUILDING"
    ```

    Taken from https://github.com/huggingface/moon-landing/blob/main/server/repo_types/SpaceInfo.ts#L61 (private url).
    """

    # Copied from moon-landing > server > repo_types > SpaceInfo.ts (private repo)
    NO_APP_FILE = "NO_APP_FILE"
    CONFIG_ERROR = "CONFIG_ERROR"
    BUILDING = "BUILDING"
    BUILD_ERROR = "BUILD_ERROR"
    RUNNING = "RUNNING"
    RUNNING_BUILDING = "RUNNING_BUILDING"
    RUNTIME_ERROR = "RUNTIME_ERROR"
    DELETING = "DELETING"
    STOPPED = "STOPPED"
    PAUSED = "PAUSED"
    APP_STARTING = "APP_STARTING"
    RUNNING_APP_STARTING = "RUNNING_APP_STARTING"


INTERMEDIATE_SPACE_STAGES = (
    SpaceStage.BUILDING,
    SpaceStage.RUNNING_BUILDING,
    SpaceStage.APP_STARTING,
    SpaceStage.RUNNING_APP_STARTING,
)

TERMINAL_SPACE_STAGES = (
    SpaceStage.RUNNING,
    SpaceStage.BUILD_ERROR,
    SpaceStage.RUNTIME_ERROR,
    SpaceStage.CONFIG_ERROR,
    SpaceStage.NO_APP_FILE,
    SpaceStage.STOPPED,
    SpaceStage.PAUSED,
    SpaceStage.DELETING,
)


class SpaceHardware(str, Enum):
    """
    Enumeration of hardwares available to run your Space on the Hub.

    Value can be compared to a string:
    ```py
    assert SpaceHardware.CPU_BASIC == "cpu-basic"
    ```

    Taken from https://github.com/huggingface-internal/moon-landing/blob/main/server/repo_types/SpaceHardwareFlavor.ts (private url).
    """

    # CPU
    CPU_BASIC = "cpu-basic"
    CPU_UPGRADE = "cpu-upgrade"

    # ZeroGPU
    ZERO_A10G = "zero-a10g"

    # GPU
    T4_SMALL = "t4-small"
    T4_MEDIUM = "t4-medium"
    L4X1 = "l4x1"
    L4X4 = "l4x4"
    L40SX1 = "l40sx1"
    L40SX4 = "l40sx4"
    L40SX8 = "l40sx8"
    A10G_SMALL = "a10g-small"
    A10G_LARGE = "a10g-large"
    A10G_LARGEX2 = "a10g-largex2"
    A10G_LARGEX4 = "a10g-largex4"
    A100_LARGE = "a100-large"
    A100X4 = "a100x4"
    A100X8 = "a100x8"


class SpaceStorage(str, Enum):
    """
    Enumeration of persistent storage available for your Space on the Hub.

    Value can be compared to a string:
    ```py
    assert SpaceStorage.SMALL == "small"
    ```

    Taken from https://github.com/huggingface/moon-landing/blob/main/server/repo_types/SpaceHardwareFlavor.ts#L24 (private url).
    """

    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"


@dataclass
class Volume:
    """
    Describes a volume to mount in a Space or Job container.

    Args:
        type (`str`):
            Type of volume: `"bucket"`, `"model"`, `"dataset"`, or `"space"`.
        source (`str`):
            Source identifier, e.g. `"username/my-bucket"` or `"username/my-model"`.
        mount_path (`str`):
            Mount path inside the container, e.g. `"/data"`. Must start with `/`.
        revision (`str` or `None`):
            Git revision (only for repos, defaults to `"main"`).
        read_only (`bool` or `None`):
            Read-only mount. Forced `True` for repos, defaults to `False` for buckets.
        path (`str` or `None`):
            Subfolder prefix inside the bucket/repo to mount, e.g. `"path/to/dir"`.
    """

    type: Literal["bucket", "model", "dataset", "space"]
    source: str
    mount_path: str
    revision: str | None = None
    read_only: bool | None = None
    path: str | None = None

    def __init__(self, **kwargs) -> None:
        self.type = kwargs.get("type", "model")
        self.source = kwargs["source"]
        mount_path = kwargs.get("mountPath")
        self.mount_path = mount_path if mount_path is not None else kwargs["mount_path"]
        self.revision = kwargs.get("revision")
        read_only = kwargs.get("readOnly")
        self.read_only = read_only if read_only is not None else kwargs.get("read_only")
        self.path = kwargs.get("path")

    def to_dict(self) -> dict:
        """Serialize to the JSON payload expected by the Hub API."""
        data: dict = {
            "type": self.type,
            "source": self.source,
            "mountPath": self.mount_path,
        }
        if self.revision is not None:
            data["revision"] = self.revision
        if self.read_only is not None:
            data["readOnly"] = self.read_only
        if self.path is not None:
            data["path"] = self.path
        return data

    def to_uri(self) -> str:
        """Return the volume as an HF mount URI in the format expected by the CLI."""
        return HfMount(
            source=HfUri(type=self.type, id=self.source, revision=self.revision, path_in_repo=self.path or ""),
            mount_path=self.mount_path,
            read_only=self.read_only,
        ).to_uri()


@dataclass
class SpaceHotReloading:
    status: Literal["created", "canceled"]
    replica_statuses: list[tuple[str, str | None]]  # See _hot_reloading_types.ApiCreateReloadResponse.res.status
    raw: dict

    def __init__(self, data: dict) -> None:
        self.status = data["status"]
        self.replica_statuses = data["replicaStatuses"]
        self.raw = data


@dataclass
class SpaceRuntime:
    """
    Contains information about the current runtime of a Space.

    Args:
        stage (`str`):
            Current stage of the space. Example: RUNNING.
        hardware (`str` or `None`):
            Current hardware of the space. Example: "cpu-basic". Can be `None` if Space
            is `BUILDING` for the first time.
        requested_hardware (`str` or `None`):
            Requested hardware. Can be different from `hardware` especially if the request
            has just been made. Example: "t4-medium". Can be `None` if no hardware has
            been requested yet.
        sleep_time (`int` or `None`):
            Number of seconds the Space will be kept alive after the last request. By default (if value is `None`), the
            Space will never go to sleep if it's running on an upgraded hardware, while it will go to sleep after 48
            hours on a free 'cpu-basic' hardware. For more details, see https://huggingface.co/docs/hub/spaces-gpus#sleep-time.
        volumes (`list[Volume]` or `None`):
            List of volumes mounted in the Space. Each volume is a [`Volume`] object describing its type, source,
            mount path, and optional settings. `None` if no volumes are attached.
        raw (`dict`):
            Raw response from the server. Contains more information about the Space
            runtime like number of replicas, number of cpu, memory size,...
    """

    stage: SpaceStage
    hardware: SpaceHardware | None
    requested_hardware: SpaceHardware | None
    sleep_time: int | None
    storage: SpaceStorage | None
    dev_mode: bool
    hot_reloading: SpaceHotReloading | None
    volumes: list[Volume] | None
    raw: dict

    def __init__(self, data: dict) -> None:
        self.stage = data["stage"]
        self.hardware = data.get("hardware", {}).get("current")
        self.requested_hardware = data.get("hardware", {}).get("requested")
        self.sleep_time = data.get("gcTimeout")
        self.storage = data.get("storage")
        self.dev_mode = data.get("devMode", False)
        self.hot_reloading = SpaceHotReloading(raw_hr) if (raw_hr := data.get("hotReloading")) is not None else None
        raw_volumes = data.get("volumes")
        self.volumes = [Volume(**v) for v in raw_volumes] if raw_volumes is not None else None
        self.raw = data


@dataclass
class SpaceSecret:
    """
    Contains information about a secret of a Space.

    Secret values are write-only and cannot be read back. Only the key, description,
    and last update time are returned by the API.

    Args:
        key (`str`):
            Secret key. Example: `"GITHUB_API_KEY"`
        description (`str` or None):
            Description of the secret. Example: `"Github API key to access the Github API"`.
        updated_at (`datetime` or None):
            datetime of the last update of the secret (if the secret has been updated at least once).
    """

    key: str
    description: str | None
    updated_at: datetime | None

    def __init__(self, key: str, values: dict) -> None:
        self.key = key
        self.description = values.get("description")
        updated_at = values.get("updatedAt")
        self.updated_at = parse_datetime(updated_at) if updated_at is not None else None


@dataclass
class SpaceVariable:
    """
    Contains information about the current variables of a Space.

    Args:
        key (`str`):
            Variable key. Example: `"MODEL_REPO_ID"`
        value (`str`):
            Variable value. Example: `"the_model_repo_id"`.
        description (`str` or None):
            Description of the variable. Example: `"Model Repo ID of the implemented model"`.
        updatedAt (`datetime` or None):
            datetime of the last update of the variable (if the variable has been updated at least once).
    """

    key: str
    value: str
    description: str | None
    updated_at: datetime | None

    def __init__(self, key: str, values: dict) -> None:
        self.key = key
        self.value = values["value"]
        self.description = values.get("description")
        updated_at = values.get("updatedAt")
        self.updated_at = parse_datetime(updated_at) if updated_at is not None else None


@dataclass
class SpaceSearchResult:
    """A single result from the Spaces semantic search API.

    Returned by [`HfApi.search_spaces`].

    Attributes:
        id (`str`):
            ID of the Space (e.g. `"username/repo-name"`).
        author (`str`):
            Author of the Space.
        title (`str`):
            Display title of the Space.
        emoji (`str` or `None`):
            Emoji icon of the Space.
        sdk (`str` or `None`):
            SDK used by the Space (e.g. `"gradio"`, `"docker"`, `"static"`).
        likes (`int`):
            Number of likes.
        private (`bool`):
            Whether the Space is private.
        tags (`list[str]` or `None`):
            List of tags.
        runtime ([`SpaceRuntime`] or `None`):
            Runtime information (stage, hardware, etc.).
        ai_short_description (`str` or `None`):
            AI-generated short description.
        ai_category (`str` or `None`):
            AI-generated category (e.g. `"Image Generation"`).
        semantic_relevancy_score (`float` or `None`):
            Semantic relevancy score (0-1) relative to the search query.
        trending_score (`int` or `None`):
            Trending score.
    """

    id: str
    author: str
    title: str
    emoji: str | None
    sdk: str | None
    likes: int
    private: bool
    tags: list[str] | None
    runtime: SpaceRuntime | None
    ai_short_description: str | None
    ai_category: str | None
    semantic_relevancy_score: float | None
    trending_score: int | None

    def __init__(self, data: dict) -> None:
        runtime = data.get("runtime")
        self.id = data["id"]
        self.author = data.get("author", "")
        self.title = data.get("title", "")
        self.emoji = data.get("emoji")
        self.sdk = data.get("sdk")
        self.likes = data.get("likes", 0)
        self.private = data.get("private", False)
        self.tags = data.get("tags")
        self.runtime = SpaceRuntime(runtime) if runtime else None
        self.ai_short_description = data.get("ai_short_description")
        self.ai_category = data.get("ai_category")
        self.semantic_relevancy_score = data.get("semanticRelevancyScore")
        self.trending_score = data.get("trendingScore")


@dataclass
class SpaceTemplate:
    """
    Contains information about a Space template available on the Hub.

    Returned by [`HfApi.list_space_templates`]. The `repo_id` can be passed as `space_template`
    to [`HfApi.create_repo`] to seed a new Space from that template.

    Args:
        name (`str`):
            Human-friendly name of the template (e.g. `"JupyterLab"`, `"chatbot"`).
        repo_id (`str`):
            Repo id of the template Space (e.g. `"SpacesExamples/jupyterlab"`).
        sdk (`str`):
            SDK the template is built with (e.g. `"gradio"`, `"docker"`, `"static"`).
        preferred_private (`bool`):
            Whether Spaces created from this template are recommended to be private.
    """

    name: str
    repo_id: str
    sdk: str
    preferred_private: bool

    def __init__(self, data: dict) -> None:
        self.name = data["name"]
        self.repo_id = data["repoId"]
        self.sdk = data["sdk"]
        self.preferred_private = data["preferredPrivate"]
