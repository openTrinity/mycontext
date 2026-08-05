"""Contains all custom errors."""

from enum import Enum
from pathlib import Path

from httpx import HTTPError, Response


# CACHE ERRORS


class CacheNotFound(Exception):
    """Exception thrown when the Huggingface cache is not found."""

    cache_dir: str | Path

    def __init__(self, msg: str, cache_dir: str | Path, *args, **kwargs):
        super().__init__(msg, *args, **kwargs)
        self.cache_dir = cache_dir


class CorruptedCacheException(Exception):
    """Exception for any unexpected structure in the Huggingface cache-system."""


class CachedRepoTreeNotFoundError(Exception):
    """Raised by [`get_cached_repo_tree`] when no tree listing is cached for the requested revision.

    The tree listing is populated as a side effect of [`snapshot_download`].
    """


# HEADERS ERRORS


class LocalTokenNotFoundError(EnvironmentError):
    """Raised if local token is required but not found."""


# OIDC ERRORS


class OIDCError(Exception):
    """Raised when keyless CI/CD auth via OIDC token exchange ("Trusted Publishers") cannot proceed.

    Typically because `HF_OIDC_RESOURCE` is set but no id token is available: not running in a
    supported CI provider and `HF_OIDC_ID_TOKEN` is unset.

    See https://huggingface.co/docs/hub/trusted-publishers.
    """


# DEVICE CODE OAUTH ERRORS


class OAuthErrorCode(str, Enum):
    """Known OAuth `error` codes returned by the Hub's token endpoint (RFC 6749 / RFC 8628)."""

    AUTHORIZATION_PENDING = "authorization_pending"
    SLOW_DOWN = "slow_down"
    EXPIRED_TOKEN = "expired_token"
    ACCESS_DENIED = "access_denied"
    INVALID_GRANT = "invalid_grant"


class DeviceCodeError(Exception):
    """Raised when the Device Code OAuth login flow (RFC 8628) or an OAuth token refresh fails.

    Covers failures at any step: requesting the device code, polling for the token,
    authorization denied/expired, or unexpected server responses.

    Attributes:
        error_code (`str`, *optional*):
            The OAuth `error` code returned by the server, if any. Known values are listed in
            [`OAuthErrorCode`] but the server may return other codes.
    """

    def __init__(self, message: str, error_code: str | None = None):
        super().__init__(message)
        self.error_code = error_code


# HTTP ERRORS


class OfflineModeIsEnabled(ConnectionError):
    """Raised when a request is made but `HF_HUB_OFFLINE=1` is set as environment variable."""


class HfHubHTTPError(HTTPError, OSError):
    """
    HTTPError to inherit from for any custom HTTP Error raised in HF Hub.

    Any HTTPError is converted at least into a `HfHubHTTPError`. If some information is
    sent back by the server, it will be added to the error message.

    Added details:
    - Request ID sourced from headers in order of precedence: "X-Request-Id", "X-Amzn-Trace-Id", "X-Amz-Cf-Id".
    - Server error message from the header "X-Error-Message".
    - Server error message if we can found one in the response body.

    Example:
    ```py
        import httpx
        from huggingface_hub.utils import get_session, hf_raise_for_status, HfHubHTTPError

        response = get_session().post(...)
        try:
            hf_raise_for_status(response)
        except HfHubHTTPError as e:
            print(str(e)) # formatted message
            e.request_id, e.server_message # details returned by server

            # Complete the error message with additional information once it's raised
            e.append_to_message("\n`create_commit` expects the repository to exist.")
            raise
    ```
    """

    def __init__(
        self,
        message: str,
        *,
        response: Response,
        server_message: str | None = None,
    ):
        self.request_id = (
            response.headers.get("x-request-id")
            or response.headers.get("X-Amzn-Trace-Id")
            or response.headers.get("x-amz-cf-id")
        )
        self.server_message = server_message
        self.response = response
        self.request = response.request
        super().__init__(message)

    def append_to_message(self, additional_message: str) -> None:
        """Append additional information to the `HfHubHTTPError` initial message."""
        self.args = (self.args[0] + additional_message,) + self.args[1:]

    @classmethod
    def _reconstruct_hf_hub_http_error(
        cls, message: str, response: Response, server_message: str | None
    ) -> "HfHubHTTPError":
        return cls(message, response=response, server_message=server_message)

    def __reduce_ex__(self, protocol):
        """Fix pickling of Exception subclass with kwargs. We need to override __reduce_ex__ of the parent class"""
        return (self.__class__._reconstruct_hf_hub_http_error, (str(self), self.response, self.server_message))


# INFERENCE CLIENT ERRORS


class InferenceTimeoutError(HTTPError, TimeoutError):
    """Error raised when a model is unavailable or the request times out."""


# INFERENCE ENDPOINT ERRORS


class InferenceEndpointError(Exception):
    """Generic exception when dealing with Inference Endpoints."""


class InferenceEndpointTimeoutError(InferenceEndpointError, TimeoutError):
    """Exception for timeouts while waiting for Inference Endpoint."""


# SAFETENSORS ERRORS


class SafetensorsParsingError(Exception):
    """Raised when failing to parse a safetensors file metadata.

    This can be the case if the file is not a safetensors file or does not respect the specification.
    """


class NotASafetensorsRepoError(Exception):
    """Raised when a repo is not a Safetensors repo i.e. doesn't have either a `model.safetensors` or a
    `model.safetensors.index.json` file.
    """


# TEXT GENERATION ERRORS


class TextGenerationError(HTTPError):
    """Generic error raised if text-generation went wrong."""


# Text Generation Inference Errors
class ValidationError(TextGenerationError):
    """Server-side validation error."""


class GenerationError(TextGenerationError):
    pass


class OverloadedError(TextGenerationError):
    pass


class IncompleteGenerationError(TextGenerationError):
    pass


class UnknownError(TextGenerationError):
    pass


# VALIDATION ERRORS


class HFValidationError(ValueError):
    """Generic exception thrown by `huggingface_hub` validators.

    Inherits from [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError).
    """


class HfUriError(ValueError):
    """Raised when an `hf://...` URI is malformed.

    See [`parse_hf_uri`] and the
    [HF URIs reference](https://huggingface.co/docs/huggingface_hub/main/en/package_reference/hf_uris)
    for the canonical syntax.

    Inherits from [`ValueError`](https://docs.python.org/3/library/exceptions.html#ValueError).
    """

    def __init__(self, uri: str, msg: str):
        self.uri = uri
        self.msg = msg
        full_msg = f"Invalid HF URI '{uri}'. {msg}" if uri else f"Invalid HF URI. {msg}"
        super().__init__(full_msg)


# FILE METADATA ERRORS


class DryRunError(OSError):
    """Error triggered when a dry run is requested but cannot be performed (e.g. invalid repo)."""


class FileMetadataError(OSError):
    """Error triggered when the metadata of a file on the Hub cannot be retrieved (missing ETag or commit_hash).

    Inherits from `OSError` for backward compatibility.
    """


# BUCKET ERRORS


class BucketNotFoundError(HfHubHTTPError):
    """
    Raised when trying to access a bucket that does not exist.

    Attributes:
        bucket_id (`str` or `None`):
            The bucket id (namespace/name) that was not found, if it could be determined from the request URL.

    Example:

    ```py
    >>> from huggingface_hub import bucket_info
    >>> bucket_info("<non_existent_bucket>")
    (...)
    huggingface_hub.errors.BucketNotFoundError: 404 Client Error. (Request ID: XXX)

    Bucket Not Found for url: https://huggingface.co/api/buckets/namespace/name.
    Please make sure you specified the correct bucket id (namespace/name).
    If the bucket is private, make sure you are authenticated and your token has the required permissions.
    ```
    """

    bucket_id: str | None = None


# JOB ERRORS


class JobNotFoundError(HfHubHTTPError):
    """
    Raised when trying to access a Job that does not exist.

    Attributes:
        job_id (`str`):
            The job id that was not found.
    """

    job_id: str


# REPOSITORY ERRORS


class RepositoryNotFoundError(HfHubHTTPError):
    """
    Raised when trying to access a hf.co URL with an invalid repository name, or
    with a private repo name the user does not have access to.

    Attributes:
        repo_id (`str` or `None`):
            The repo id that was not found, if it could be determined from the request URL.
        repo_type (`str` or `None`):
            The repo type ("model", "dataset", or "space"), if it could be determined from the request URL.

    Example:

    ```py
    >>> from huggingface_hub import model_info
    >>> model_info("<non_existent_repository>")
    (...)
    huggingface_hub.errors.RepositoryNotFoundError: 401 Client Error. (Request ID: PvMw_VjBMjVdMz53WKIzP)

    Repository Not Found for url: https://huggingface.co/api/models/%3Cnon_existent_repository%3E.
    Please make sure you specified the correct `repo_id` and `repo_type`.
    If the repo is private, make sure you are authenticated and your token has the required permissions.
    Invalid username or password.
    ```
    """

    repo_id: str | None = None
    repo_type: str | None = None


class GatedRepoError(RepositoryNotFoundError):
    """
    Raised when trying to access a gated repository for which the user is not on the
    authorized list.

    Note: derives from `RepositoryNotFoundError` to ensure backward compatibility.

    Example:

    ```py
    >>> from huggingface_hub import model_info
    >>> model_info("<gated_repository>")
    (...)
    huggingface_hub.errors.GatedRepoError: 403 Client Error. (Request ID: ViT1Bf7O_026LGSQuVqfa)

    Cannot access gated repo for url https://huggingface.co/api/models/ardent-figment/gated-model.
    Access to model ardent-figment/gated-model is restricted and you are not in the authorized list.
    Visit https://huggingface.co/ardent-figment/gated-model to ask for access.
    ```
    """


class DisabledRepoError(HfHubHTTPError):
    """
    Raised when trying to access a repository that has been disabled by its author.

    Example:

    ```py
    >>> from huggingface_hub import dataset_info
    >>> dataset_info("laion/laion-art")
    (...)
    huggingface_hub.errors.DisabledRepoError: 403 Client Error. (Request ID: Root=1-659fc3fa-3031673e0f92c71a2260dbe2;bc6f4dfb-b30a-4862-af0a-5cfe827610d8)

    Cannot access repository for url https://huggingface.co/api/datasets/laion/laion-art.
    Access to this resource is disabled.
    ```
    """


# REVISION ERROR


class RevisionNotFoundError(HfHubHTTPError):
    """
    Raised when trying to access a hf.co URL with a valid repository but an invalid
    revision.

    Attributes:
        repo_id (`str` or `None`):
            The repo id, if it could be determined from the request URL.
        repo_type (`str` or `None`):
            The repo type ("model", "dataset", or "space"), if it could be determined from the request URL.

    Example:

    ```py
    >>> from huggingface_hub import hf_hub_download
    >>> hf_hub_download('bert-base-cased', 'config.json', revision='<non-existent-revision>')
    (...)
    huggingface_hub.errors.RevisionNotFoundError: 404 Client Error. (Request ID: Mwhe_c3Kt650GcdKEFomX)

    Revision Not Found for url: https://huggingface.co/bert-base-cased/resolve/%3Cnon-existent-revision%3E/config.json.
    ```
    """

    repo_id: str | None = None
    repo_type: str | None = None


class RevisionResolutionError(Exception):
    """
    Raised by [`HfApi.resolve_revision`] when a revision cannot be resolved to a commit hash: the Hub could not be
    reached (offline mode, connection error, timeout, Hub downtime, ...) and no matching entry was found in the
    local cache.
    """


# ENTRY ERRORS
class EntryNotFoundError(Exception):
    """
    Raised when entry not found, either locally or remotely.

    Example:

    ```py
    >>> from huggingface_hub import hf_hub_download
    >>> hf_hub_download('bert-base-cased', '<non-existent-file>')
    (...)
    huggingface_hub.errors.RemoteEntryNotFoundError (...)
    >>> hf_hub_download('bert-base-cased', '<non-existent-file>', local_files_only=True)
    (...)
    huggingface_hub.utils.errors.LocalEntryNotFoundError (...)
    ```
    """


class RemoteEntryNotFoundError(HfHubHTTPError, EntryNotFoundError):
    """
    Raised when trying to access a hf.co URL with a valid repository and revision
    but an invalid filename.

    Attributes:
        repo_id (`str` or `None`):
            The repo id, if it could be determined from the request URL.
        repo_type (`str` or `None`):
            The repo type ("model", "dataset", or "space"), if it could be determined from the request URL.

    Example:

    ```py
    >>> from huggingface_hub import hf_hub_download
    >>> hf_hub_download('bert-base-cased', '<non-existent-file>')
    (...)
    huggingface_hub.errors.EntryNotFoundError: 404 Client Error. (Request ID: 53pNl6M0MxsnG5Sw8JA6x)

    Entry Not Found for url: https://huggingface.co/bert-base-cased/resolve/main/%3Cnon-existent-file%3E.
    ```
    """

    repo_id: str | None = None
    repo_type: str | None = None


class LocalEntryNotFoundError(FileNotFoundError, EntryNotFoundError):
    """
    Raised when trying to access a file or snapshot that is not on the disk when network is
    disabled or unavailable (connection issue). The entry may exist on the Hub.

    Example:

    ```py
    >>> from huggingface_hub import hf_hub_download
    >>> hf_hub_download('bert-base-cased', '<non-cached-file>',  local_files_only=True)
    (...)
    huggingface_hub.errors.LocalEntryNotFoundError: Cannot find the requested files in the disk cache and outgoing traffic has been disabled. To enable hf.co look-ups and downloads online, set 'local_files_only' to False.
    ```
    """

    def __init__(self, message: str):
        super().__init__(message)


class IncompleteSnapshotError(LocalEntryNotFoundError):
    """
    Raised by [`snapshot_download`] when the Hub cannot be reached (offline, connection issue, or
    `local_files_only=True`) and the cached snapshot is known to be incomplete: some files listed in
    the repository's cached tree listing are missing from the local snapshot.

    This is a subclass of [`LocalEntryNotFoundError`] for backward compatibility.

    The `snapshot_path` attribute holds the path to the incomplete local snapshot, so a downstream library can locate
    the latest cached files even though they are known to be incomplete.
    """

    def __init__(self, message: str, snapshot_path: str):
        super().__init__(message)
        self.snapshot_path = snapshot_path


# REQUEST ERROR
class BadRequestError(HfHubHTTPError, ValueError):
    """
    Raised by `hf_raise_for_status` when the server returns a HTTP 400 error.

    Example:

    ```py
    >>> resp = httpx.post("hf.co/api/check", ...)
    >>> hf_raise_for_status(resp, endpoint_name="check")
    huggingface_hub.errors.BadRequestError: Bad request for check endpoint: {details} (Request ID: XXX)
    ```
    """


# DDUF file format ERROR


class DDUFError(Exception):
    """Base exception for errors related to the DDUF format."""


class DDUFCorruptedFileError(DDUFError):
    """Exception thrown when the DDUF file is corrupted."""


class DDUFExportError(DDUFError):
    """Base exception for errors during DDUF export."""


class DDUFInvalidEntryNameError(DDUFExportError):
    """Exception thrown when the entry name is invalid."""


# STRICT DATACLASSES ERRORS


class StrictDataclassError(Exception):
    """Base exception for strict dataclasses."""


class StrictDataclassDefinitionError(StrictDataclassError):
    """Exception thrown when a strict dataclass is defined incorrectly."""


class StrictDataclassFieldValidationError(StrictDataclassError):
    """Exception thrown when a strict dataclass fails validation for a given field."""

    def __init__(self, field: str, cause: Exception):
        error_message = f"Validation error for field '{field}':"
        error_message += f"\n    {cause.__class__.__name__}: {cause}"
        super().__init__(error_message)


class StrictDataclassClassValidationError(StrictDataclassError):
    """Exception thrown when a strict dataclass fails validation on a class validator."""

    def __init__(self, validator: str, cause: Exception):
        error_message = f"Class validation error for validator '{validator}':"
        error_message += f"\n    {cause.__class__.__name__}: {cause}"
        super().__init__(error_message)


# XET ERRORS


class XetDownloadError(Exception):
    """Exception thrown when the download from Xet Storage fails."""


# LFS ERRORS


class FileDuplicationError(Exception):
    """Raised when duplicating files across repos fails."""


# CLI ERRORS


class CLIError(Exception):
    """CLI error with clean message (no traceback by default)."""


class ConfirmationError(CLIError):
    """Raised when a confirmation prompt is declined (non-interactive mode)."""


class CLIExtensionInstallError(CLIError):
    """Error during CLI extension installation."""


# SANDBOX ERRORS


class SandboxError(Exception):
    """Base exception for sandbox operations (see `huggingface_hub.Sandbox`).

    Attributes:
        status_code: The HTTP status returned by the in-sandbox server, if the error
            originated from an API response (e.g. `404` for a missing file). `None` otherwise.
    """

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class SandboxCommandError(SandboxError):
    """Raised when a command run in a sandbox exits with a non-zero code.

    Attributes:
        cmd: The command that failed.
        result: The full `SandboxCommandResult` (exit_code, stdout, stderr, ...).
    """

    def __init__(self, cmd, result) -> None:
        self.cmd = cmd
        self.result = result
        stderr_tail = result.stderr[-1000:] if result.stderr else "<empty>"
        if result.timed_out:
            reason = "timed out"
        elif result.signal is not None:
            reason = f"was killed by signal {result.signal}"
        else:
            reason = f"exited with code {result.exit_code}"
        super().__init__(f"Command {cmd!r} {reason}. stderr:\n{stderr_tail}")
