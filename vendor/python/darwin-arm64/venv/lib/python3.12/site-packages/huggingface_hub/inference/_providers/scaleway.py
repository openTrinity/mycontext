from typing import Any

from huggingface_hub.inference._common import RequestParameters, _as_dict

from ._common import BaseConversationalTask, InferenceProviderMapping, TaskProviderHelper, filter_none


class ScalewayConversationalTask(BaseConversationalTask):
    def __init__(self):
        super().__init__(provider="scaleway", base_url="https://api.scaleway.ai")


class ScalewayFeatureExtractionTask(TaskProviderHelper):
    def __init__(self):
        super().__init__(provider="scaleway", base_url="https://api.scaleway.ai", task="feature-extraction")

    def _prepare_route(self, mapped_model: str, api_key: str) -> str:
        return "/v1/embeddings"

    def _prepare_payload_as_dict(
        self, inputs: Any, parameters: dict, provider_mapping_info: InferenceProviderMapping
    ) -> dict | None:
        parameters = filter_none(parameters)
        return {"input": inputs, "model": provider_mapping_info.provider_id, **parameters}

    def get_response(self, response: bytes | dict, request_params: RequestParameters | None = None) -> Any:
        embeddings = _as_dict(response)["data"]
        return [embedding["embedding"] for embedding in embeddings]
