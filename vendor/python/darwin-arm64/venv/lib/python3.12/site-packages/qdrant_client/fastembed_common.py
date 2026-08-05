from typing import Any

from pydantic import BaseModel, Field

from qdrant_client.conversions.common_types import SparseVector
from qdrant_client.http import models

try:
    from fastembed import (
        TextEmbedding,
        SparseTextEmbedding,
        ImageEmbedding,
        LateInteractionTextEmbedding,
        LateInteractionMultimodalEmbedding,
    )
    from fastembed.common import OnnxProvider, ImageInput
except ImportError:
    TextEmbedding = None
    SparseTextEmbedding = None
    ImageEmbedding = None
    LateInteractionTextEmbedding = None
    LateInteractionMultimodalEmbedding = None
    OnnxProvider = None
    ImageInput = None


class QueryResponse(BaseModel, extra="forbid"):  # type: ignore
    id: str | int
    embedding: list[float] | None
    sparse_embedding: SparseVector | None = Field(default=None)
    metadata: dict[str, Any]
    document: str
    score: float


class FastEmbedMisc:
    IS_INSTALLED: bool = False
    _TEXT_MODELS: set[str] = set()
    _IMAGE_MODELS: set[str] = set()
    _LATE_INTERACTION_TEXT_MODELS: set[str] = set()
    _LATE_INTERACTION_MULTIMODAL_MODELS: set[str] = set()
    _SPARSE_MODELS: set[str] = set()

    @classmethod
    def is_installed(cls) -> bool:
        if cls.IS_INSTALLED:
            return cls.IS_INSTALLED

        try:
            from fastembed import (
                SparseTextEmbedding,
                TextEmbedding,
                ImageEmbedding,
                LateInteractionMultimodalEmbedding,
                LateInteractionTextEmbedding,
            )

            assert len(SparseTextEmbedding.list_supported_models()) > 0
            assert len(TextEmbedding.list_supported_models()) > 0
            assert len(ImageEmbedding.list_supported_models()) > 0
            assert len(LateInteractionTextEmbedding.list_supported_models()) > 0
            assert len(LateInteractionMultimodalEmbedding.list_supported_models()) > 0
            cls.IS_INSTALLED = True
        except ImportError:
            cls.IS_INSTALLED = False

        return cls.IS_INSTALLED

    @classmethod
    def import_fastembed(cls) -> None:
        if cls.IS_INSTALLED:
            return

        # If it's not, ask the user to install it
        raise ImportError(
            "fastembed is not installed."
            " Please install it to compute embedding for document implicitly with `pip install fastembed`."
        )

    @classmethod
    def list_text_models(cls) -> dict[str, tuple[int, models.Distance]]:
        """Lists the supported dense text models.

        Requires invocation of TextEmbedding.list_supported_models() to support custom models.

        Returns:
            dict[str, tuple[int, models.Distance]]: A dict of model names, their dimensions and distance metrics.
        """
        return (
            {
                model["model"]: (model["dim"], models.Distance.COSINE)
                for model in TextEmbedding.list_supported_models()
            }
            if TextEmbedding
            else {}
        )

    @classmethod
    def list_image_models(cls) -> dict[str, tuple[int, models.Distance]]:
        """Lists the supported image dense models.

        Custom image models are not supported yet, but calls to ImageEmbedding.list_supported_models() is done each
        time in order for preserving the same style as with TextEmbedding.

        Returns:
            dict[str, tuple[int, models.Distance]]: A dict of model names, their dimensions and distance metrics.
        """
        return (
            {
                model["model"]: (model["dim"], models.Distance.COSINE)
                for model in ImageEmbedding.list_supported_models()
            }
            if ImageEmbedding
            else {}
        )

    @classmethod
    def list_late_interaction_text_models(cls) -> dict[str, tuple[int, models.Distance]]:
        """Lists the supported late interaction text models.

        Custom late interaction models are not supported yet, but calls to
        LateInteractionTextEmbedding.list_supported_models()
        is done each time in order for preserving the same style as with TextEmbedding.

        Returns:
            dict[str, tuple[int, models.Distance]]: A dict of model names, their dimensions and distance metrics.
        """
        return (
            {
                model["model"]: (model["dim"], models.Distance.COSINE)
                for model in LateInteractionTextEmbedding.list_supported_models()
            }
            if LateInteractionTextEmbedding
            else {}
        )

    @classmethod
    def list_late_interaction_multimodal_models(cls) -> dict[str, tuple[int, models.Distance]]:
        """Lists the supported late interaction multimodal models.

        Custom late interaction multimodal models are not supported yet, but calls to
        LateInteractionMultimodalEmbedding.list_supported_models()
        is done each time in order for preserving the same style as with TextEmbedding.

        Returns:
            dict[str, tuple[int, models.Distance]]: A dict of model names, their dimensions and distance metrics.
        """
        return (
            {
                model["model"]: (model["dim"], models.Distance.COSINE)
                for model in LateInteractionMultimodalEmbedding.list_supported_models()
            }
            if LateInteractionMultimodalEmbedding
            else {}
        )

    @classmethod
    def list_sparse_models(cls) -> dict[str, dict[str, Any]]:
        """Lists the supported sparse models.

        Custom sparse models are not supported yet, but calls to
        SparseTextEmbedding.list_supported_models()
        is done each time in order for preserving the same style as with TextEmbedding.

        Returns:
            dict[str, dict[str, Any]]: A dict of model names and their descriptions.
        """
        descriptions = {}
        if SparseTextEmbedding:
            for description in SparseTextEmbedding.list_supported_models():
                descriptions[description.pop("model")] = description
        return descriptions

    @classmethod
    def is_supported_text_model(cls, model_name: str) -> bool:
        """Checks if the model is supported by fastembed.

        Args:
            model_name (str): The name of the model to check.

        Returns:
            bool: True if the model is supported, False otherwise.
        """
        if model_name.lower() in cls._TEXT_MODELS:
            return True
        # update cached list in case custom models were added
        cls._TEXT_MODELS = {model.lower() for model in cls.list_text_models()}
        if model_name.lower() in cls._TEXT_MODELS:
            return True
        return False

    @classmethod
    def is_supported_image_model(cls, model_name: str) -> bool:
        """Checks if the model is supported by fastembed.

        Args:
            model_name (str): The name of the model to check.

        Returns:
            bool: True if the model is supported, False otherwise.
        """
        if model_name.lower() in cls._IMAGE_MODELS:
            return True
        # update cached list in case custom models were added
        cls._IMAGE_MODELS = {model.lower() for model in cls.list_image_models()}
        if model_name.lower() in cls._IMAGE_MODELS:
            return True
        return False

    @classmethod
    def is_supported_late_interaction_text_model(cls, model_name: str) -> bool:
        """Checks if the model is supported by fastembed.

        Args:
            model_name (str): The name of the model to check.

        Returns:
            bool: True if the model is supported, False otherwise.
        """
        if model_name.lower() in cls._LATE_INTERACTION_TEXT_MODELS:
            return True
        # update cached list in case custom models were added
        cls._LATE_INTERACTION_TEXT_MODELS = {
            model.lower() for model in cls.list_late_interaction_text_models()
        }
        if model_name.lower() in cls._LATE_INTERACTION_TEXT_MODELS:
            return True
        return False

    @classmethod
    def is_supported_late_interaction_multimodal_model(cls, model_name: str) -> bool:
        """Checks if the model is supported by fastembed.

        Args:
            model_name (str): The name of the model to check.

        Returns:
            bool: True if the model is supported, False otherwise.
        """
        if model_name.lower() in cls._LATE_INTERACTION_MULTIMODAL_MODELS:
            return True
        # update cached list in case custom models were added
        cls._LATE_INTERACTION_MULTIMODAL_MODELS = {
            model.lower() for model in cls.list_late_interaction_multimodal_models()
        }
        if model_name.lower() in cls._LATE_INTERACTION_MULTIMODAL_MODELS:
            return True
        return False

    @classmethod
    def is_supported_sparse_model(cls, model_name: str) -> bool:
        """Checks if the model is supported by fastembed.

        Args:
            model_name (str): The name of the model to check.

        Returns:
            bool: True if the model is supported, False otherwise.
        """
        if model_name.lower() in cls._SPARSE_MODELS:
            return True
        # update cached list in case custom models were added
        cls._SPARSE_MODELS = {model.lower() for model in cls.list_sparse_models()}
        if model_name.lower() in cls._SPARSE_MODELS:
            return True
        return False


# region deprecated
# prefer using methods builtin into QdrantClient, e.g. list_supported_text_models, list_supported_idf_models, etc.

SUPPORTED_EMBEDDING_MODELS: dict[str, tuple[int, models.Distance]] = (
    {
        model["model"]: (model["dim"], models.Distance.COSINE)
        for model in TextEmbedding.list_supported_models()
    }
    if TextEmbedding
    else {}
)

SUPPORTED_SPARSE_EMBEDDING_MODELS: dict[str, dict[str, Any]] = (
    {model["model"]: model for model in SparseTextEmbedding.list_supported_models()}
    if SparseTextEmbedding
    else {}
)

IDF_EMBEDDING_MODELS: set[str] = (
    {
        model_config["model"]
        for model_config in SparseTextEmbedding.list_supported_models()
        if model_config.get("requires_idf", None)
    }
    if SparseTextEmbedding
    else set()
)

_LATE_INTERACTION_EMBEDDING_MODELS: dict[str, tuple[int, models.Distance]] = (
    {
        model["model"]: (model["dim"], models.Distance.COSINE)
        for model in LateInteractionTextEmbedding.list_supported_models()
    }
    if LateInteractionTextEmbedding
    else {}
)

_IMAGE_EMBEDDING_MODELS: dict[str, tuple[int, models.Distance]] = (
    {
        model["model"]: (model["dim"], models.Distance.COSINE)
        for model in ImageEmbedding.list_supported_models()
    }
    if ImageEmbedding
    else {}
)

_LATE_INTERACTION_MULTIMODAL_EMBEDDING_MODELS: dict[str, tuple[int, models.Distance]] = (
    {
        model["model"]: (model["dim"], models.Distance.COSINE)
        for model in LateInteractionMultimodalEmbedding.list_supported_models()
    }
    if LateInteractionMultimodalEmbedding
    else {}
)
# endregion
