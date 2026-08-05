import base64
import time
from abc import ABC
from typing import Any

from huggingface_hub.hf_api import InferenceProviderMapping
from huggingface_hub.inference._common import (
    RequestParameters,
    _as_dict,
    _as_url,
)
from huggingface_hub.inference._providers._common import (
    BaseConversationalTask,
    BaseTextGenerationTask,
    TaskProviderHelper,
    filter_none,
)
from huggingface_hub.utils import get_session, hf_raise_for_status, logging


logger = logging.get_logger(__name__)

_PROVIDER = "together"
_BASE_URL = "https://api.together.xyz"

# Polling interval for async video generation (in seconds).
_VIDEO_POLLING_INTERVAL = 2.0

# Upper bound on status polls (initial response may already be terminal; each further poll is one attempt).
_VIDEO_MAX_POLL_ATTEMPTS = 150  # ~5 minutes at _VIDEO_POLLING_INTERVAL

# Job statuses that mean "keep polling". Together returns "queued" before transitioning to
# "in_progress", so we must treat both as pending.
_VIDEO_PENDING_STATUSES = {"queued", "in_progress"}


class TogetherTask(TaskProviderHelper, ABC):
    """Base class for Together API tasks."""

    def __init__(self, task: str):
        super().__init__(provider=_PROVIDER, base_url=_BASE_URL, task=task)

    def _prepare_route(self, mapped_model: str, api_key: str) -> str:
        match self.task:
            case "text-to-image" | "image-to-image":
                return "/v1/images/generations"
            case "text-to-speech":
                return "/v1/audio/speech"
            case "feature-extraction":
                return "/v1/embeddings"
            case "text-to-video" | "image-to-video":
                # Video creation lives under /v2 (see https://docs.together.ai/reference/create-videos).
                return "/v2/videos"
        raise ValueError(f"Unsupported task '{self.task}' for Together API.")


class TogetherTextGenerationTask(BaseTextGenerationTask):
    def __init__(self):
        super().__init__(provider=_PROVIDER, base_url=_BASE_URL)

    def get_response(self, response: bytes | dict, request_params: RequestParameters | None = None) -> Any:
        output = _as_dict(response)["choices"][0]
        return {
            "generated_text": output["text"],
            "details": {
                "finish_reason": output.get("finish_reason"),
                "seed": output.get("seed"),
            },
        }


class TogetherConversationalTask(BaseConversationalTask):
    def __init__(self):
        super().__init__(provider=_PROVIDER, base_url=_BASE_URL)

    def _prepare_payload_as_dict(
        self, inputs: Any, parameters: dict, provider_mapping_info: InferenceProviderMapping
    ) -> dict | None:
        payload = super()._prepare_payload_as_dict(inputs, parameters, provider_mapping_info)
        if payload is None:
            return None
        # Together accepts response_format `{type: "json_schema", schema: <schema>}` (flattened),
        # so unwrap the OpenAI-style `{type: "json_schema", json_schema: {schema}}` envelope.
        response_format = payload.get("response_format")
        if (
            isinstance(response_format, dict)
            and response_format.get("type") == "json_schema"
            and isinstance(response_format.get("json_schema"), dict)
            and "schema" in response_format["json_schema"]
        ):
            payload["response_format"] = {
                "type": "json_schema",
                "schema": response_format["json_schema"]["schema"],
            }
        return payload


class TogetherTextToImageTask(TogetherTask):
    def __init__(self):
        super().__init__("text-to-image")

    def _prepare_payload_as_dict(
        self, inputs: Any, parameters: dict, provider_mapping_info: InferenceProviderMapping
    ) -> dict | None:
        mapped_model = provider_mapping_info.provider_id
        parameters = filter_none(parameters)
        if "num_inference_steps" in parameters:
            parameters["steps"] = parameters.pop("num_inference_steps")

        return {"prompt": inputs, "response_format": "base64", **parameters, "model": mapped_model}

    def get_response(self, response: bytes | dict, request_params: RequestParameters | None = None) -> Any:
        response_dict = _as_dict(response)
        return base64.b64decode(response_dict["data"][0]["b64_json"])


class TogetherImageToImageTask(TogetherTask):
    def __init__(self):
        super().__init__("image-to-image")

    def _prepare_payload_as_dict(
        self, inputs: Any, parameters: dict, provider_mapping_info: InferenceProviderMapping
    ) -> dict | None:
        mapped_model = provider_mapping_info.provider_id
        image_url = _as_url(inputs, default_mime_type="image/jpeg")

        # Filter `None` values first: the client always passes `"prompt": None` when the user
        # omits the argument, so popping before filtering would yield `None` instead of the
        # `""` default and send `"prompt": null` to Together (rejected by Flux Kontext).
        parameters = filter_none(parameters)
        prompt = parameters.pop("prompt", "")
        if "num_inference_steps" in parameters:
            parameters["steps"] = parameters.pop("num_inference_steps")

        # Together exposes two mutually-exclusive image inputs (see
        # https://docs.together.ai/docs/image-to-image): FLUX.1 Kontext only accepts
        # `image_url`; FLUX.2 [dev] and Google models (Gemini 3 Pro Image, Flash Image
        # 2.5) only accept `reference_images`. FLUX.2 [pro]/[flex] accept either but
        # `reference_images` is the documented default. Use `image_url` only for
        # FLUX.1 Kontext models and `reference_images` for everything else.
        lowered = mapped_model.lower()
        use_image_url = "kontext" in lowered and "flux.1" in lowered
        image_field: dict[str, Any] = {"image_url": image_url} if use_image_url else {"reference_images": [image_url]}
        return {
            "prompt": prompt,
            **image_field,
            "response_format": "base64",
            **parameters,
            "model": mapped_model,
        }

    def get_response(self, response: bytes | dict, request_params: RequestParameters | None = None) -> Any:
        response_dict = _as_dict(response)
        return base64.b64decode(response_dict["data"][0]["b64_json"])


class TogetherFeatureExtractionTask(TogetherTask):
    def __init__(self):
        super().__init__("feature-extraction")

    def _prepare_payload_as_dict(
        self, inputs: Any, parameters: dict, provider_mapping_info: InferenceProviderMapping
    ) -> dict | None:
        return {
            "input": inputs,
            "model": provider_mapping_info.provider_id,
            **filter_none(parameters),
        }

    def get_response(self, response: bytes | dict, request_params: RequestParameters | None = None) -> Any:
        return [item["embedding"] for item in _as_dict(response)["data"]]


class TogetherTextToSpeechTask(TogetherTask):
    def __init__(self):
        super().__init__("text-to-speech")

    def _prepare_payload_as_dict(
        self, inputs: Any, parameters: dict, provider_mapping_info: InferenceProviderMapping
    ) -> dict | None:
        # `voice` is required by the Together API and is model-specific
        # (see https://docs.together.ai/docs/text-to-speech#supported-voices),
        # so we don't set a default and let the API surface a clear error if missing.
        return {
            "input": inputs,
            "model": provider_mapping_info.provider_id,
            **filter_none(parameters),
        }

    def get_response(self, response: bytes | dict, request_params: RequestParameters | None = None) -> Any:
        if isinstance(response, bytes):
            return response
        raise ValueError(f"Expected raw audio bytes for text-to-speech, got {type(response).__name__}.")


def _normalize_video_parameters(parameters: dict) -> dict:
    """Map HF inference-client conventions onto Together's video API parameter names."""
    parameters = filter_none(parameters)
    if "num_inference_steps" in parameters:
        parameters["steps"] = parameters.pop("num_inference_steps")
    if "target_size" in parameters:
        target_size = parameters.pop("target_size")
        if "width" in target_size:
            parameters["width"] = target_size["width"]
        if "height" in target_size:
            parameters["height"] = target_size["height"]
    return parameters


class TogetherVideoTask(TogetherTask, ABC):
    """Base class for Together's asynchronous video generation tasks."""

    def get_response(self, response: bytes | dict, request_params: RequestParameters | None = None) -> Any:
        if request_params is None:
            raise ValueError("A `RequestParameters` object is required to poll Together video jobs.")

        job = _as_dict(response)
        job_id = job.get("id")
        if not job_id:
            raise ValueError("No job ID found in Together video generation response.")

        # Status polling lives at the same /v2/videos URL with the job ID appended.
        status_url = f"{request_params.url}/{job_id}"

        logger.info("Generating video, polling for completion...")
        # Together usually returns `status: "queued"` on the initial POST, but the field is
        # optional per the spec — treat a missing status as "still pending" and poll, rather
        # than falling through to the "unexpected status" error below.
        status = job.get("status")
        for _ in range(_VIDEO_MAX_POLL_ATTEMPTS):
            if status is not None and status not in _VIDEO_PENDING_STATUSES:
                break
            time.sleep(_VIDEO_POLLING_INTERVAL)
            status_response = get_session().get(status_url, headers=request_params.headers)
            hf_raise_for_status(status_response)
            job = status_response.json()
            status = job.get("status")
            if status is not None and status not in _VIDEO_PENDING_STATUSES:
                break
        else:
            raise ValueError(
                "Timed out while waiting for Together video generation "
                f"— aborting after {_VIDEO_MAX_POLL_ATTEMPTS} status polls"
            )

        if status == "failed":
            error = job.get("error") or {}
            raise RuntimeError(f"Together video generation failed: {error.get('message') or 'Unknown error'}")
        if status != "completed":
            raise RuntimeError(f"Unexpected Together video job status: {status!r}")

        video_url = (job.get("outputs") or {}).get("video_url")
        if not video_url:
            raise ValueError("No video URL found in completed Together video job.")

        video_response = get_session().get(video_url)
        hf_raise_for_status(video_response)
        return video_response.content


class TogetherTextToVideoTask(TogetherVideoTask):
    def __init__(self):
        super().__init__("text-to-video")

    def _prepare_payload_as_dict(
        self, inputs: Any, parameters: dict, provider_mapping_info: InferenceProviderMapping
    ) -> dict | None:
        return {
            "prompt": inputs,
            "model": provider_mapping_info.provider_id,
            **_normalize_video_parameters(parameters),
        }


class TogetherImageToVideoTask(TogetherVideoTask):
    def __init__(self):
        super().__init__("image-to-video")

    def _prepare_payload_as_dict(
        self, inputs: Any, parameters: dict, provider_mapping_info: InferenceProviderMapping
    ) -> dict | None:
        # Together expects each keyframe as `{input_image, frame: "first" | "last"}`
        # for i2v models. See https://docs.together.ai/docs/inference/videos/reference-and-keyframes.
        # Note: `input_image` accepts a data URL or an HTTP(S) URL but the field is capped
        # at ~60KB — users with larger inputs should host the image and pass `frame_images`
        # directly via `extra_body`.
        return {
            "model": provider_mapping_info.provider_id,
            "frame_images": [{"input_image": _as_url(inputs, default_mime_type="image/png"), "frame": "first"}],
            **_normalize_video_parameters(parameters),
        }
