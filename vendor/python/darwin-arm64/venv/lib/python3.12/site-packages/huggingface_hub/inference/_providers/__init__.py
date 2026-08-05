from typing import Literal, Union

from huggingface_hub.inference._providers.featherless_ai import (
    FeatherlessConversationalTask,
    FeatherlessTextGenerationTask,
)
from huggingface_hub.utils import logging

from ._common import AutoRouterConversationalTask, TaskProviderHelper, _fetch_inference_provider_mapping
from .cerebras import CerebrasConversationalTask
from .cohere import CohereConversationalTask
from .deepinfra import (
    DeepInfraAutomaticSpeechRecognitionTask,
    DeepInfraConversationalTask,
    DeepInfraTextGenerationTask,
)
from .fal_ai import (
    FalAIAutomaticSpeechRecognitionTask,
    FalAIImageSegmentationTask,
    FalAIImageToImageTask,
    FalAIImageToVideoTask,
    FalAITextToImageTask,
    FalAITextToSpeechTask,
    FalAITextToVideoTask,
)
from .fireworks_ai import FireworksAIConversationalTask
from .groq import GroqConversationalTask
from .hf_inference import (
    HFInferenceBinaryInputTask,
    HFInferenceConversational,
    HFInferenceFeatureExtractionTask,
    HFInferenceTask,
)
from .novita import NovitaConversationalTask, NovitaTextGenerationTask, NovitaTextToVideoTask
from .nscale import NscaleConversationalTask, NscaleTextToImageTask
from .openai import OpenAIConversationalTask
from .ovhcloud import OVHcloudConversationalTask
from .publicai import PublicAIConversationalTask
from .replicate import (
    ReplicateAutomaticSpeechRecognitionTask,
    ReplicateImageToImageTask,
    ReplicateTask,
    ReplicateTextToImageTask,
    ReplicateTextToSpeechTask,
)
from .scaleway import ScalewayConversationalTask, ScalewayFeatureExtractionTask
from .together import (
    TogetherConversationalTask,
    TogetherFeatureExtractionTask,
    TogetherImageToImageTask,
    TogetherImageToVideoTask,
    TogetherTextGenerationTask,
    TogetherTextToImageTask,
    TogetherTextToSpeechTask,
    TogetherTextToVideoTask,
)
from .wavespeed import (
    WavespeedAIImageToImageTask,
    WavespeedAIImageToVideoTask,
    WavespeedAITextToImageTask,
    WavespeedAITextToVideoTask,
)
from .zai_org import ZaiConversationalTask, ZaiTextToImageTask


logger = logging.get_logger(__name__)


PROVIDER_T = Literal[
    "cerebras",
    "cohere",
    "deepinfra",
    "fal-ai",
    "featherless-ai",
    "fireworks-ai",
    "groq",
    "hf-inference",
    "novita",
    "nscale",
    "openai",
    "ovhcloud",
    "publicai",
    "replicate",
    "scaleway",
    "together",
    "wavespeed",
    "zai-org",
]

PROVIDER_OR_POLICY_T = Union[PROVIDER_T, Literal["auto"]]

CONVERSATIONAL_AUTO_ROUTER = AutoRouterConversationalTask()

PROVIDERS: dict[PROVIDER_T, dict[str, TaskProviderHelper]] = {
    "cerebras": {
        "conversational": CerebrasConversationalTask(),
    },
    "cohere": {
        "conversational": CohereConversationalTask(),
    },
    "deepinfra": {
        "automatic-speech-recognition": DeepInfraAutomaticSpeechRecognitionTask(),
        "conversational": DeepInfraConversationalTask(),
        "text-generation": DeepInfraTextGenerationTask(),
    },
    "fal-ai": {
        "automatic-speech-recognition": FalAIAutomaticSpeechRecognitionTask(),
        "text-to-image": FalAITextToImageTask(),
        "text-to-speech": FalAITextToSpeechTask(),
        "text-to-video": FalAITextToVideoTask(),
        "image-to-video": FalAIImageToVideoTask(),
        "image-to-image": FalAIImageToImageTask(),
        "image-segmentation": FalAIImageSegmentationTask(),
    },
    "featherless-ai": {
        "conversational": FeatherlessConversationalTask(),
        "text-generation": FeatherlessTextGenerationTask(),
    },
    "fireworks-ai": {
        "conversational": FireworksAIConversationalTask(),
    },
    "groq": {
        "conversational": GroqConversationalTask(),
    },
    "hf-inference": {
        "text-to-image": HFInferenceTask("text-to-image"),
        "conversational": HFInferenceConversational(),
        "text-generation": HFInferenceTask("text-generation"),
        "text-classification": HFInferenceTask("text-classification"),
        "question-answering": HFInferenceTask("question-answering"),
        "audio-classification": HFInferenceBinaryInputTask("audio-classification"),
        "automatic-speech-recognition": HFInferenceBinaryInputTask("automatic-speech-recognition"),
        "fill-mask": HFInferenceTask("fill-mask"),
        "feature-extraction": HFInferenceFeatureExtractionTask(),
        "image-classification": HFInferenceBinaryInputTask("image-classification"),
        "image-segmentation": HFInferenceBinaryInputTask("image-segmentation"),
        "document-question-answering": HFInferenceTask("document-question-answering"),
        "image-to-text": HFInferenceBinaryInputTask("image-to-text"),
        "object-detection": HFInferenceBinaryInputTask("object-detection"),
        "audio-to-audio": HFInferenceBinaryInputTask("audio-to-audio"),
        "zero-shot-image-classification": HFInferenceBinaryInputTask("zero-shot-image-classification"),
        "zero-shot-classification": HFInferenceTask("zero-shot-classification"),
        "image-to-image": HFInferenceBinaryInputTask("image-to-image"),
        "sentence-similarity": HFInferenceTask("sentence-similarity"),
        "table-question-answering": HFInferenceTask("table-question-answering"),
        "tabular-classification": HFInferenceTask("tabular-classification"),
        "text-to-speech": HFInferenceTask("text-to-speech"),
        "token-classification": HFInferenceTask("token-classification"),
        "translation": HFInferenceTask("translation"),
        "summarization": HFInferenceTask("summarization"),
        "visual-question-answering": HFInferenceBinaryInputTask("visual-question-answering"),
    },
    "novita": {
        "text-generation": NovitaTextGenerationTask(),
        "conversational": NovitaConversationalTask(),
        "text-to-video": NovitaTextToVideoTask(),
    },
    "nscale": {
        "conversational": NscaleConversationalTask(),
        "text-to-image": NscaleTextToImageTask(),
    },
    "openai": {
        "conversational": OpenAIConversationalTask(),
    },
    "ovhcloud": {
        "conversational": OVHcloudConversationalTask(),
    },
    "publicai": {
        "conversational": PublicAIConversationalTask(),
    },
    "replicate": {
        "automatic-speech-recognition": ReplicateAutomaticSpeechRecognitionTask(),
        "image-to-image": ReplicateImageToImageTask(),
        "text-to-image": ReplicateTextToImageTask(),
        "text-to-speech": ReplicateTextToSpeechTask(),
        "text-to-video": ReplicateTask("text-to-video"),
    },
    "scaleway": {
        "conversational": ScalewayConversationalTask(),
        "feature-extraction": ScalewayFeatureExtractionTask(),
    },
    "together": {
        "conversational": TogetherConversationalTask(),
        "feature-extraction": TogetherFeatureExtractionTask(),
        "image-to-image": TogetherImageToImageTask(),
        "image-to-video": TogetherImageToVideoTask(),
        "text-generation": TogetherTextGenerationTask(),
        "text-to-image": TogetherTextToImageTask(),
        "text-to-speech": TogetherTextToSpeechTask(),
        "text-to-video": TogetherTextToVideoTask(),
    },
    "wavespeed": {
        "text-to-image": WavespeedAITextToImageTask(),
        "text-to-video": WavespeedAITextToVideoTask(),
        "image-to-image": WavespeedAIImageToImageTask(),
        "image-to-video": WavespeedAIImageToVideoTask(),
    },
    "zai-org": {
        "conversational": ZaiConversationalTask(),
        "text-to-image": ZaiTextToImageTask(),
    },
}


def get_provider_helper(provider: PROVIDER_OR_POLICY_T | None, task: str, model: str | None) -> TaskProviderHelper:
    """Get provider helper instance by name and task.

    Args:
        provider (`str`, *optional*): name of the provider, or "auto" to automatically select the provider for the model.
        task (`str`): Name of the task
        model (`str`, *optional*): Name of the model
    Returns:
        TaskProviderHelper: Helper instance for the specified provider and task

    Raises:
        ValueError: If provider or task is not supported
    """

    if (model is None and provider in (None, "auto")) or (
        model is not None and model.startswith(("http://", "https://"))
    ):
        provider = "hf-inference"

    if provider is None:
        logger.info(
            "No provider specified for task `conversational`. Defaulting to server-side auto routing."
            if task == "conversational"
            else "Defaulting to 'auto' which will select the first provider available for the model, sorted by the user's order in https://hf.co/settings/inference-providers."
        )
        provider = "auto"

    if provider == "auto":
        if model is None:
            raise ValueError("Specifying a model is required when provider is 'auto'")
        if task == "conversational":
            # Special case: we have a dedicated auto-router for conversational models. No need to fetch provider mapping.
            return CONVERSATIONAL_AUTO_ROUTER

        provider_mapping = _fetch_inference_provider_mapping(model)
        provider = next(iter(provider_mapping)).provider

    provider_tasks = PROVIDERS.get(provider)  # type: ignore
    if provider_tasks is None:
        raise ValueError(
            f"Provider '{provider}' not supported. Available values: 'auto' or any provider from {list(PROVIDERS.keys())}."
            "Passing 'auto' (default value) will automatically select the first provider available for the model, sorted "
            "by the user's order in https://hf.co/settings/inference-providers."
        )

    if task not in provider_tasks:
        raise ValueError(
            f"Task '{task}' not supported for provider '{provider}'. Available tasks: {list(provider_tasks.keys())}"
        )
    return provider_tasks[task]
