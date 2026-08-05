import json
import mimetypes
import uuid
from typing import Any

from huggingface_hub.hf_api import InferenceProviderMapping
from huggingface_hub.inference._common import MimeBytes, RequestParameters, _as_dict, _open_as_mime_bytes

from ._common import BaseConversationalTask, BaseTextGenerationTask, TaskProviderHelper, filter_none


_PROVIDER = "deepinfra"
_BASE_URL = "https://api.deepinfra.com"


def _form_field_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):  # bool before int: bool is an int subclass
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(value)


def _encode_multipart(audio: MimeBytes, fields: dict[str, Any]) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    # Fall back to .wav when the MIME type is unknown: transcription servers sniff the format from the filename.
    filename = "audio" + (mimetypes.guess_extension(audio.mime_type or "") or ".wav")
    lines: list[bytes] = [
        f"--{boundary}".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode(),
        f"Content-Type: {audio.mime_type or 'application/octet-stream'}".encode(),
        b"",
        bytes(audio),
    ]
    for key, value in fields.items():
        lines += [
            f"--{boundary}".encode(),
            f'Content-Disposition: form-data; name="{key}"'.encode(),
            b"",
            _form_field_value(value).encode(),
        ]
    lines += [f"--{boundary}--".encode(), b""]
    return b"\r\n".join(lines), f"multipart/form-data; boundary={boundary}"


class DeepInfraTextGenerationTask(BaseTextGenerationTask):
    def __init__(self):
        super().__init__(provider=_PROVIDER, base_url=_BASE_URL)

    def _prepare_route(self, mapped_model: str, api_key: str) -> str:
        return "/v1/openai/completions"

    def _prepare_payload_as_dict(
        self, inputs: Any, parameters: dict, provider_mapping_info: InferenceProviderMapping
    ) -> dict | None:
        params = filter_none(parameters.copy())
        params["max_tokens"] = params.pop("max_new_tokens", None)

        return {"prompt": inputs, **params, "model": provider_mapping_info.provider_id}

    def get_response(self, response: bytes | dict, request_params: RequestParameters | None = None) -> Any:
        output = _as_dict(response)["choices"][0]
        return {
            "generated_text": output["text"],
            "details": {
                "finish_reason": output.get("finish_reason"),
                "seed": output.get("seed"),
            },
        }


class DeepInfraConversationalTask(BaseConversationalTask):
    def __init__(self):
        super().__init__(provider=_PROVIDER, base_url=_BASE_URL)

    def _prepare_route(self, mapped_model: str, api_key: str) -> str:
        return "/v1/openai/chat/completions"


class DeepInfraAutomaticSpeechRecognitionTask(TaskProviderHelper):
    def __init__(self):
        super().__init__(provider=_PROVIDER, base_url=_BASE_URL, task="automatic-speech-recognition")

    def _prepare_route(self, mapped_model: str, api_key: str) -> str:
        return "/v1/openai/audio/transcriptions"

    def _prepare_payload_as_bytes(
        self,
        inputs: Any,
        parameters: dict,
        provider_mapping_info: InferenceProviderMapping,
        extra_payload: dict | None,
    ) -> MimeBytes | None:
        # OpenAI-compatible transcription endpoint expects a multipart/form-data body, not JSON.
        audio = _open_as_mime_bytes(inputs)
        # `model` is applied last so parameters cannot override the mapped provider model.
        fields: dict[str, Any] = {
            **filter_none(parameters),
            **filter_none(extra_payload or {}),
            "model": provider_mapping_info.provider_id,
        }
        body, content_type = _encode_multipart(audio, fields)
        return MimeBytes(body, mime_type=content_type)

    def get_response(self, response: bytes | dict, request_params: RequestParameters | None = None) -> Any:
        output = _as_dict(response)
        text = output["text"]
        if not isinstance(text, str):
            raise ValueError(f"Unexpected output format from DeepInfra API. Expected string, got {type(text)}.")
        result: dict[str, Any] = {"text": text}
        segments = output.get("segments")
        if isinstance(segments, list):
            result["chunks"] = [
                {"text": segment.get("text"), "timestamp": [segment.get("start"), segment.get("end")]}
                for segment in segments
                if isinstance(segment, dict)
            ]
        return result
