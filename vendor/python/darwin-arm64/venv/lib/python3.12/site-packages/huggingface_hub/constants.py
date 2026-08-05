import os
import re
import typing
from typing import Literal
from urllib.parse import urlsplit


# Possible values for env variables


ENV_VARS_TRUE_VALUES = {"1", "ON", "YES", "TRUE"}
ENV_VARS_TRUE_AND_AUTO_VALUES = ENV_VARS_TRUE_VALUES.union({"AUTO"})


def _is_true(value: str | None) -> bool:
    if value is None:
        return False
    return value.upper() in ENV_VARS_TRUE_VALUES


def _as_int(value: str | None) -> int | None:
    if value is None:
        return None
    return int(value)


# Constants for file downloads

PYTORCH_WEIGHTS_NAME = "pytorch_model.bin"
TF2_WEIGHTS_NAME = "tf_model.h5"
TF_WEIGHTS_NAME = "model.ckpt"
FLAX_WEIGHTS_NAME = "flax_model.msgpack"
CONFIG_NAME = "config.json"
REPOCARD_NAME = "README.md"
EVAL_RESULTS_FOLDER = ".eval_results"
DEFAULT_ETAG_TIMEOUT = 10
DEFAULT_DOWNLOAD_TIMEOUT = 10
DEFAULT_REQUEST_TIMEOUT = 10
DOWNLOAD_CHUNK_SIZE = 10 * 1024 * 1024
MAX_HTTP_DOWNLOAD_SIZE = 50 * 1000 * 1000 * 1000  # 50 GB

# Constants for serialization

PYTORCH_WEIGHTS_FILE_PATTERN = "pytorch_model{suffix}.bin"  # Unsafe pickle: use safetensors instead
SAFETENSORS_WEIGHTS_FILE_PATTERN = "model{suffix}.safetensors"
TF2_WEIGHTS_FILE_PATTERN = "tf_model{suffix}.h5"

# Constants for safetensors repos

SAFETENSORS_SINGLE_FILE = "model.safetensors"
SAFETENSORS_INDEX_FILE = "model.safetensors.index.json"
SAFETENSORS_MAX_HEADER_LENGTH = 25_000_000

# Timeout of acquiring file lock and logging the attempt
FILELOCK_LOG_EVERY_SECONDS = 10

# Git-related constants

DEFAULT_REVISION = "main"
REGEX_COMMIT_OID = re.compile(r"[A-Fa-f0-9]{5,40}")

HUGGINGFACE_CO_URL_HOME = "https://huggingface.co/"

_staging_mode = _is_true(os.environ.get("HUGGINGFACE_CO_STAGING"))

_HF_DEFAULT_ENDPOINT = "https://huggingface.co"
_HF_DEFAULT_STAGING_ENDPOINT = "https://hub-ci.huggingface.co"
ENDPOINT = os.getenv("HF_ENDPOINT", _HF_DEFAULT_ENDPOINT).rstrip("/")
HUGGINGFACE_CO_URL_TEMPLATE = ENDPOINT + "/{repo_id}/resolve/{revision}/{filename}"

if _staging_mode:
    ENDPOINT = _HF_DEFAULT_STAGING_ENDPOINT
    HUGGINGFACE_CO_URL_TEMPLATE = _HF_DEFAULT_STAGING_ENDPOINT + "/{repo_id}/resolve/{revision}/{filename}"

# Hosts whose web URLs can be parsed into a ``hf://`` URI (see ``huggingface_hub/utils/_hf_uris.py``).
# Includes the public Hub host and its ``hf.co`` short domain, the staging host, and the host of the
# currently configured ``ENDPOINT`` so that self-hosted / staging endpoints work too.
HF_URL_HOSTS: frozenset[str] = frozenset(
    {"hf.co"}
    | {
        host.lower()
        for host in (
            urlsplit(_HF_DEFAULT_ENDPOINT).hostname,
            urlsplit(_HF_DEFAULT_STAGING_ENDPOINT).hostname,
            urlsplit(ENDPOINT).hostname,
        )
        if host
    }
)

DATASETS_SERVER_ENDPOINT = "https://datasets-server.huggingface.co"

HUGGINGFACE_HEADER_X_REPO_COMMIT = "X-Repo-Commit"
HUGGINGFACE_HEADER_X_LINKED_ETAG = "X-Linked-Etag"
HUGGINGFACE_HEADER_X_LINKED_SIZE = "X-Linked-Size"
HUGGINGFACE_HEADER_X_BILL_TO = "X-HF-Bill-To"

INFERENCE_ENDPOINT = os.environ.get("HF_INFERENCE_ENDPOINT", "https://api-inference.huggingface.co")

# See https://huggingface.co/docs/inference-endpoints/index
INFERENCE_ENDPOINTS_ENDPOINT = "https://api.endpoints.huggingface.cloud/v2"
INFERENCE_CATALOG_ENDPOINT = "https://endpoints.huggingface.co/api/catalog"

# See https://api.endpoints.huggingface.cloud/#post-/v2/endpoint/-namespace-
INFERENCE_ENDPOINT_IMAGE_KEYS = [
    "custom",
    "huggingface",
    "huggingfaceNeuron",
    "llamacpp",
    "tei",
    "tgi",
    "tgiNeuron",
]

# Proxy for third-party providers
INFERENCE_PROXY_TEMPLATE = "https://router.huggingface.co/{provider}"

REPO_ID_SEPARATOR = "--"
# ^ this substring is not allowed in repo_ids on hf.co
# and is the canonical one we use for serialization of repo ids elsewhere.


REPO_TYPE_DATASET = "dataset"
REPO_TYPE_SPACE = "space"
REPO_TYPE_MODEL = "model"
REPO_TYPE_KERNEL = "kernel"
REPO_TYPES = [None, REPO_TYPE_MODEL, REPO_TYPE_DATASET, REPO_TYPE_SPACE]
REPO_TYPES_WITH_KERNEL = REPO_TYPES + [REPO_TYPE_KERNEL]
SPACES_SDK_TYPES = ["gradio", "streamlit", "docker", "static"]

REPO_TYPES_URL_PREFIXES = {
    REPO_TYPE_DATASET: "datasets/",
    REPO_TYPE_SPACE: "spaces/",
    REPO_TYPE_KERNEL: "kernels/",
}
REPO_TYPES_MAPPING = {
    "datasets": REPO_TYPE_DATASET,
    "spaces": REPO_TYPE_SPACE,
    "models": REPO_TYPE_MODEL,
    "kernels": REPO_TYPE_KERNEL,
}

# HF Hub URIs (``hf://...``). See ``huggingface_hub/utils/_hf_uris.py``
# and ``docs/source/en/package_reference/hf_uris.md`` for the full grammar.
HF_PROTOCOL = "hf://"
HfUriType = Literal["model", "dataset", "space", "kernel", "bucket"]
# Maps the plural URI prefix that may appear in a HF URI (e.g. ``datasets/``)
# to the canonical singular type name. Buckets are first-class HF URI types.
HF_URI_TYPE_PREFIXES: dict[str, HfUriType] = {
    "models": "model",
    "datasets": "dataset",
    "spaces": "space",
    "kernels": "kernel",
    "buckets": "bucket",
}


DiscussionTypeFilter = Literal["all", "discussion", "pull_request"]
DISCUSSION_TYPES: tuple[DiscussionTypeFilter, ...] = typing.get_args(DiscussionTypeFilter)
DiscussionStatusFilter = Literal["all", "open", "closed"]
DISCUSSION_STATUS: tuple[DiscussionTypeFilter, ...] = typing.get_args(DiscussionStatusFilter)

# Webhook subscription types
WEBHOOK_DOMAIN_T = Literal["repo", "discussions"]

# default cache
default_home = os.path.join(os.path.expanduser("~"), ".cache")
HF_HOME = os.path.expandvars(
    os.path.expanduser(
        os.getenv(
            "HF_HOME",
            os.path.join(os.getenv("XDG_CACHE_HOME", default_home), "huggingface"),
        )
    )
)

default_cache_path = os.path.join(HF_HOME, "hub")
default_assets_cache_path = os.path.join(HF_HOME, "assets")

# Legacy env variables
HUGGINGFACE_HUB_CACHE = os.getenv("HUGGINGFACE_HUB_CACHE", default_cache_path)
HUGGINGFACE_ASSETS_CACHE = os.getenv("HUGGINGFACE_ASSETS_CACHE", default_assets_cache_path)

# New env variables
HF_HUB_CACHE = os.path.expandvars(
    os.path.expanduser(
        os.getenv(
            "HF_HUB_CACHE",
            HUGGINGFACE_HUB_CACHE,
        )
    )
)
HF_ASSETS_CACHE = os.path.expandvars(
    os.path.expanduser(
        os.getenv(
            "HF_ASSETS_CACHE",
            HUGGINGFACE_ASSETS_CACHE,
        )
    )
)

HF_HUB_OFFLINE = _is_true(os.environ.get("HF_HUB_OFFLINE") or os.environ.get("TRANSFORMERS_OFFLINE"))


def is_offline_mode() -> bool:
    """Returns whether we are in offline mode for the Hub.

    When offline mode is enabled, all HTTP requests made with `get_session` will raise an `OfflineModeIsEnabled` exception.

    Example:
        ```py
        from huggingface_hub import is_offline_mode

        def list_files(repo_id: str):
            if is_offline_mode():
                ... # list files from local cache (degraded experience but still functional)
            else:
                ... # list files from Hub (complete experience)
        ```
    """
    return HF_HUB_OFFLINE


# File created to mark that the version check has been done.
# Check is performed once per 24 hours at most.
CHECK_FOR_UPDATE_DONE_PATH = os.path.join(HF_HOME, ".check_for_update_done")

# File caching the AI agent harnesses registry fetched from `{ENDPOINT}/api/agent-harnesses`.
# Refreshed once per 24 hours at most (see `utils/_detect_agent.py`).
AGENT_HARNESSES_PATH = os.path.join(HF_HOME, ".agent_harnesses.json")

# Set to skip the CLI update check (PyPI query + "new version available" warning at startup).
HF_HUB_DISABLE_UPDATE_CHECK = _is_true(os.environ.get("HF_HUB_DISABLE_UPDATE_CHECK"))

# If set, log level will be set to DEBUG and all requests made to the Hub will be logged
# as curl commands for reproducibility.
HF_DEBUG = _is_true(os.environ.get("HF_DEBUG"))

# Opt-out from telemetry requests
HF_HUB_DISABLE_TELEMETRY = (
    _is_true(os.environ.get("HF_HUB_DISABLE_TELEMETRY"))  # HF-specific env variable
    or _is_true(os.environ.get("DISABLE_TELEMETRY"))
    or _is_true(os.environ.get("DO_NOT_TRACK"))  # https://donottrack.sh/
)

HF_TOKEN_PATH = os.path.expandvars(
    os.path.expanduser(
        os.getenv(
            "HF_TOKEN_PATH",
            os.path.join(HF_HOME, "token"),
        )
    )
)
HF_STORED_TOKENS_PATH = os.path.join(os.path.dirname(HF_TOKEN_PATH), "stored_tokens")

if _staging_mode:
    # In staging mode, we use a different cache to ensure we don't mix up production and staging data or tokens
    # In practice in `huggingface_hub` tests, we monkeypatch these values with temporary directories. The following
    # lines are only used in third-party libraries tests (e.g. `transformers`, `diffusers`, etc.).
    _staging_home = os.path.join(os.path.expanduser("~"), ".cache", "huggingface_staging")
    HUGGINGFACE_HUB_CACHE = os.path.join(_staging_home, "hub")
    HF_TOKEN_PATH = os.path.join(_staging_home, "token")

# Here, `True` will disable progress bars globally without possibility of enabling it
# programmatically. `False` will enable them without possibility of disabling them.
# If environment variable is not set (None), then the user is free to enable/disable
# them programmatically.
# TL;DR: env variable has priority over code
__HF_HUB_DISABLE_PROGRESS_BARS = os.environ.get("HF_HUB_DISABLE_PROGRESS_BARS")
HF_HUB_DISABLE_PROGRESS_BARS: bool | None = (
    _is_true(__HF_HUB_DISABLE_PROGRESS_BARS) if __HF_HUB_DISABLE_PROGRESS_BARS is not None else None
)

# Disable symlinks in the cache (files are copied instead of symlinked)
HF_HUB_DISABLE_SYMLINKS: bool = _is_true(os.environ.get("HF_HUB_DISABLE_SYMLINKS"))

# Disable warning on machines that do not support symlinks (e.g. Windows non-developer)
HF_HUB_DISABLE_SYMLINKS_WARNING: bool = _is_true(os.environ.get("HF_HUB_DISABLE_SYMLINKS_WARNING"))

# Disable warning when using experimental features
HF_HUB_DISABLE_EXPERIMENTAL_WARNING: bool = _is_true(os.environ.get("HF_HUB_DISABLE_EXPERIMENTAL_WARNING"))

# Disable sending the cached token by default is all HTTP requests to the Hub
HF_HUB_DISABLE_IMPLICIT_TOKEN: bool = _is_true(os.environ.get("HF_HUB_DISABLE_IMPLICIT_TOKEN"))

HF_XET_HIGH_PERFORMANCE: bool = _is_true(os.environ.get("HF_XET_HIGH_PERFORMANCE"))

# Bucket and mount path used when launching Jobs
HF_JOBS_ARTIFACTS_BUCKET_NAME: str = "jobs-artifacts"
HF_JOBS_ARTIFACTS_MOUNT_PATH: str = "/data"

# hf_transfer is not used anymore. Let's warn user is case they set the env variable.
# Note: we use FutureWarning (shown by default) instead of DeprecationWarning (silenced
# by default for end users) so users running standard `python` actually see the message.
if _is_true(os.environ.get("HF_HUB_ENABLE_HF_TRANSFER")) and not HF_XET_HIGH_PERFORMANCE:
    import warnings

    warnings.warn(
        "The `HF_HUB_ENABLE_HF_TRANSFER` environment variable is deprecated as 'hf_transfer' is not used anymore. "
        "Please use `HF_XET_HIGH_PERFORMANCE` instead to enable high performance transfer with Xet. "
        "Visit https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables#hfxethighperformance for more details.",
        FutureWarning,
    )

# Used to override the etag timeout on a system level
HF_HUB_ETAG_TIMEOUT: int = _as_int(os.environ.get("HF_HUB_ETAG_TIMEOUT")) or DEFAULT_ETAG_TIMEOUT

# Used to override the get request timeout on a system level
# Also used as a default timeout for other requests if not specified (kept the naming for legacy reasons)
HF_HUB_DOWNLOAD_TIMEOUT: int = _as_int(os.environ.get("HF_HUB_DOWNLOAD_TIMEOUT")) or DEFAULT_DOWNLOAD_TIMEOUT

# Allows to add information about the requester in the user-agent (e.g. partner name)
HF_HUB_USER_AGENT_ORIGIN: str | None = os.environ.get("HF_HUB_USER_AGENT_ORIGIN")

# If OAuth didn't work after 2 redirects, there's likely a third-party cookie issue in the Space iframe view.
# In this case, we redirect the user to the non-iframe view.
OAUTH_MAX_REDIRECTS = 2

# OAuth-related environment variables injected by the Space
OAUTH_CLIENT_ID = os.environ.get("OAUTH_CLIENT_ID")
OAUTH_CLIENT_SECRET = os.environ.get("OAUTH_CLIENT_SECRET")
OAUTH_SCOPES = os.environ.get("OAUTH_SCOPES")
OPENID_PROVIDER_URL = os.environ.get("OPENID_PROVIDER_URL")

# OAuth client ID of the Device Code login flow (RFC 8628) used by `hf auth login` / `login()`.
# Overridable for Hub deployments (staging, Enterprise) where the default client ID is not provisioned.
DEVICE_CODE_OAUTH_CLIENT_ID = os.environ.get("HF_DEVICE_CODE_OAUTH_CLIENT_ID", "26be6b09-91c5-47da-9861-d2d2bb7a7e36")

# Xet constants
HUGGINGFACE_HEADER_X_XET_ENDPOINT = "X-Xet-Cas-Url"
HUGGINGFACE_HEADER_X_XET_ACCESS_TOKEN = "X-Xet-Access-Token"
HUGGINGFACE_HEADER_X_XET_EXPIRATION = "X-Xet-Token-Expiration"
HUGGINGFACE_HEADER_X_XET_HASH = "X-Xet-Hash"
HUGGINGFACE_HEADER_X_XET_REFRESH_ROUTE = "X-Xet-Refresh-Route"
HUGGINGFACE_HEADER_LINK_XET_AUTH_KEY = "xet-auth"

default_xet_cache_path = os.path.join(HF_HOME, "xet")
HF_XET_CACHE = os.getenv("HF_XET_CACHE", default_xet_cache_path)
HF_HUB_DISABLE_XET: bool = _is_true(os.environ.get("HF_HUB_DISABLE_XET"))

# Bucket hosting the static sandbox server binary (see huggingface_hub.Sandbox)
SANDBOX_SERVER_BUCKET: str = "huggingface/sbx-server"
