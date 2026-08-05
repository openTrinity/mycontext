import os
from collections import defaultdict
from copy import deepcopy
from multiprocessing import get_all_start_methods
from typing import Iterable, Any, Type, get_args

from pydantic import BaseModel

from qdrant_client.http import models
from qdrant_client.embed.common import INFERENCE_OBJECT_TYPES
from qdrant_client.embed.embed_inspector import InspectorEmbed
from qdrant_client.embed.embedder import Embedder
from qdrant_client.embed.models import NumericVector, NumericVectorStruct
from qdrant_client.embed.schema_parser import ModelSchemaParser
from qdrant_client.embed.utils import FieldPath
from qdrant_client.fastembed_common import FastEmbedMisc
from qdrant_client.parallel_processor import ParallelWorkerPool, Worker
from qdrant_client.uploader.uploader import iter_batch


class ModelEmbedderWorker(Worker):
    def __init__(self, batch_size: int, **kwargs: Any):
        self.model_embedder = ModelEmbedder(**kwargs)
        self.batch_size = batch_size

    @classmethod
    def start(cls, batch_size: int, **kwargs: Any) -> "ModelEmbedderWorker":
        return cls(threads=1, batch_size=batch_size, **kwargs)

    def process(self, items: Iterable[tuple[int, Any]]) -> Iterable[tuple[int, Any]]:
        for idx, batch in items:
            yield (
                idx,
                list(
                    self.model_embedder.embed_models_batch(
                        batch, inference_batch_size=self.batch_size
                    )
                ),
            )


class ModelEmbedder:
    MAX_INTERNAL_BATCH_SIZE = 64

    def __init__(
        self,
        parser: ModelSchemaParser | None = None,
        is_local_mode: bool = False,
        **kwargs: Any,
    ):
        self._batch_accumulator: dict[str, list[INFERENCE_OBJECT_TYPES]] = {}
        self._embed_storage: dict[str, list[NumericVector] | list[models.Document]] = {}
        self._embed_inspector = InspectorEmbed(parser=parser)
        self._is_builtin_embedder_available = not is_local_mode
        self._fastembed_available = FastEmbedMisc.is_installed()
        self.embedder = Embedder(use_core_bm25=self._is_builtin_embedder_available, **kwargs)

    def embed_models(
        self,
        raw_models: BaseModel | Iterable[BaseModel],
        is_query: bool = False,
        batch_size: int = 8,
    ) -> Iterable[BaseModel]:
        """Embed raw data fields in models and return models with vectors

            If any of model fields required inference, a deepcopy of a model with computed embeddings is returned,
            otherwise returns original models.
        Args:
            raw_models: Iterable[BaseModel] - models which can contain fields with raw data
            is_query: bool - flag to determine which embed method to use. Defaults to False.
            batch_size: int - batch size for inference
        Returns:
            list[BaseModel]: models with embedded fields
        """
        if not self._is_builtin_embedder_available:
            FastEmbedMisc.import_fastembed()  # fail fast if fastembed is required

        if isinstance(raw_models, BaseModel):
            raw_models = [raw_models]
        for raw_models_batch in iter_batch(raw_models, batch_size):
            yield from self.embed_models_batch(
                raw_models_batch, is_query, inference_batch_size=batch_size
            )

    def embed_models_strict(
        self,
        raw_models: Iterable[dict[str, BaseModel] | BaseModel],
        batch_size: int = 8,
        parallel: int | None = None,
    ) -> Iterable[dict[str, BaseModel] | BaseModel]:
        """Embed raw data fields in models and return models with vectors

        Requires every input sequences element to contain raw data fields to inference.
        Does not accept ready vectors.

        Args:
            raw_models: Iterable[BaseModel] - models which contain fields with raw data to inference
            batch_size: int - batch size for inference
            parallel: int - number of parallel processes to use. Defaults to None.

        Returns:
            Iterable[Union[dict[str, BaseModel], BaseModel]]: models with embedded fields
        """
        if not self._is_builtin_embedder_available:
            FastEmbedMisc.import_fastembed()  # fail fast if fastembed is required

        is_small = False

        if isinstance(raw_models, list):
            if len(raw_models) < batch_size:
                is_small = True

        if parallel is None or parallel == 1 or is_small:
            for batch in iter_batch(raw_models, batch_size):
                yield from self.embed_models_batch(batch, inference_batch_size=batch_size)
        else:
            multiprocessing_batch_size = 1  # larger batch sizes do not help with data parallel
            # on cpu. todo: adjust when multi-gpu is available
            raw_models_batches = iter_batch(raw_models, size=multiprocessing_batch_size)
            if parallel == 0:
                parallel = os.cpu_count()

            start_method = "forkserver" if "forkserver" in get_all_start_methods() else "spawn"
            assert parallel is not None  # just a mypy complaint
            pool = ParallelWorkerPool(
                num_workers=parallel,
                worker=self._get_worker_class(),
                start_method=start_method,
                max_internal_batch_size=self.MAX_INTERNAL_BATCH_SIZE,
            )

            for batch in pool.ordered_map(
                raw_models_batches, batch_size=multiprocessing_batch_size
            ):
                yield from batch

    def embed_models_batch(
        self,
        raw_models: list[dict[str, BaseModel] | BaseModel],
        is_query: bool = False,
        inference_batch_size: int = 8,
    ) -> Iterable[BaseModel]:
        """Embed a batch of models with raw data fields and return models with vectors

            If any of model fields required inference, a deepcopy of a model with computed embeddings is returned,
            otherwise returns original models.
        Args:
            raw_models: list[Union[dict[str, BaseModel], BaseModel]] - models which can contain fields with raw data
            is_query: bool - flag to determine which embed method to use. Defaults to False.
            inference_batch_size: int - batch size for inference
        Returns:
            Iterable[BaseModel]: models with embedded fields
        """
        if not self._is_builtin_embedder_available:
            FastEmbedMisc.import_fastembed()  # fail fast if fastembed is required

        for raw_model in raw_models:
            self._process_model(raw_model, is_query=is_query, accumulating=True)

        if not self._batch_accumulator:
            yield from raw_models
        else:
            yield from (
                self._process_model(
                    raw_model,
                    is_query=is_query,
                    accumulating=False,
                    inference_batch_size=inference_batch_size,
                )
                for raw_model in raw_models
            )

    def _process_model(
        self,
        model: dict[str, BaseModel] | BaseModel,
        paths: list[FieldPath] | None = None,
        is_query: bool = False,
        accumulating: bool = False,
        inference_batch_size: int | None = None,
    ) -> (
        dict[str, BaseModel]
        | dict[str, NumericVector]
        | BaseModel
        | NumericVector
        | models.Document
    ):
        """Embed model's fields requiring inference

        Args:
            model: Qdrant http model containing fields to embed
            paths: Path to fields to embed. E.g. [FieldPath(current="recommend", tail=[FieldPath(current="negative", tail=None)])]
            is_query: Flag to determine which embed method to use. Defaults to False.
            accumulating: Flag to determine if we are accumulating models for batch embedding. Defaults to False.
            inference_batch_size: Optional[int] - batch size for inference

        Returns:
            A deepcopy of the method with embedded fields
        """

        if isinstance(model, get_args(INFERENCE_OBJECT_TYPES)):
            if accumulating:
                self._accumulate(model)  # type: ignore
            else:
                assert (
                    inference_batch_size is not None
                ), "inference_batch_size should be passed for inference"
                return self._drain_accumulator(
                    model,  # type: ignore
                    is_query=is_query,
                    inference_batch_size=inference_batch_size,
                )

        if paths is None:
            model = deepcopy(model) if not accumulating else model

        if isinstance(model, dict):
            for key, value in model.items():
                if accumulating:
                    self._process_model(value, paths, accumulating=True)
                else:
                    model[key] = self._process_model(
                        value,
                        paths,
                        is_query=is_query,
                        accumulating=False,
                        inference_batch_size=inference_batch_size,
                    )
            return model

        paths = paths if paths is not None else self._embed_inspector.inspect(model)

        for path in paths:
            list_model = [model] if not isinstance(model, list) else model
            for item in list_model:
                current_model = getattr(item, path.current, None)
                if current_model is None:
                    continue
                if path.tail:
                    self._process_model(
                        current_model,
                        path.tail,
                        is_query=is_query,
                        accumulating=accumulating,
                        inference_batch_size=inference_batch_size,
                    )
                else:
                    was_list = isinstance(current_model, list)
                    current_model = current_model if was_list else [current_model]

                    if not accumulating:
                        assert (
                            inference_batch_size is not None
                        ), "inference_batch_size should be passed for inference"
                        embeddings = [
                            self._drain_accumulator(
                                data, is_query=is_query, inference_batch_size=inference_batch_size
                            )
                            for data in current_model
                        ]
                        if was_list:
                            setattr(item, path.current, embeddings)
                        else:
                            setattr(item, path.current, embeddings[0])
                    else:
                        for data in current_model:
                            self._accumulate(data)
        return model

    def _accumulate(self, data: models.VectorStruct) -> None:
        """Add data to batch accumulator

        Args:
            data: models.VectorStruct - any vector struct data, if inference object types instances in `data` - add them
                to the accumulator, otherwise - do nothing. `InferenceObject` instances are converted to proper types.

        Returns:
            None
        """
        if isinstance(data, dict):
            for value in data.values():
                self._accumulate(value)
            return None

        if isinstance(data, list):
            for value in data:
                if not isinstance(value, get_args(INFERENCE_OBJECT_TYPES)):  # if value is a vector
                    return None
                self._accumulate(value)

        if not isinstance(data, get_args(INFERENCE_OBJECT_TYPES)):
            return None

        data = self._resolve_inference_object(data)
        if data.model not in self._batch_accumulator:
            self._batch_accumulator[data.model] = []
        self._batch_accumulator[data.model].append(data)
        return None

    def _drain_accumulator(
        self, data: models.VectorStruct, is_query: bool, inference_batch_size: int = 8
    ) -> NumericVectorStruct | models.Document:
        """Drain accumulator and replaces inference objects with computed embeddings
            It is assumed objects are traversed in the same order as they were added to the accumulator

        Args:
            data: models.VectorStruct - any vector struct data, if inference object types instances in `data` - replace
                them with computed embeddings. If embeddings haven't yet been computed - compute them and then replace
                inference objects.
            inference_batch_size: int - batch size for inference

        Returns:
            NumericVectorStruct: data with replaced inference objects
        """
        if isinstance(data, dict):
            for key, value in data.items():
                data[key] = self._drain_accumulator(
                    value, is_query=is_query, inference_batch_size=inference_batch_size
                )
            return data

        if isinstance(data, list):
            for i, value in enumerate(data):
                if not isinstance(value, get_args(INFERENCE_OBJECT_TYPES)):  # if value is a vector
                    return data

                data[i] = self._drain_accumulator(
                    value, is_query=is_query, inference_batch_size=inference_batch_size
                )
            return data

        if not isinstance(
            data, get_args(INFERENCE_OBJECT_TYPES)
        ):  # ide type checker ignores `not` and scolds
            return data  # type: ignore

        if not self._embed_storage or not self._embed_storage.get(data.model, None):
            self._embed_accumulator(is_query=is_query, inference_batch_size=inference_batch_size)

        return self._next_embed(data.model)

    def _embed_accumulator(self, is_query: bool = False, inference_batch_size: int = 8) -> None:
        """Embed all accumulated objects for all models

        Args:
            is_query: bool - flag to determine which embed method to use. Defaults to False.
            inference_batch_size: int - batch size for inference
        Returns:
            None
        """

        def embed(
            objects: list[INFERENCE_OBJECT_TYPES], model_name: str, batch_size: int
        ) -> list[NumericVector] | list[models.Document]:
            """
            Assemble batches by options and data type based groups, embeds and return embeddings in the original order.
            If models.Document model is bm25 and Qdrant version is 1.15.3 or higher, return the document without changes
            to be processed by Qdrant itself.
            """
            unique_options: list[dict[str, Any]] = []
            unique_options_is_text: list[bool] = []  # multimodal models can have both text
            # and image data, we need to track which data we process to construct separate batches for texts and images
            batches: list[Any] = []
            group_indices: dict[int, list[int]] = defaultdict(list)
            for i, obj in enumerate(objects):
                is_text = isinstance(obj, models.Document)
                for j, (options, options_is_text) in enumerate(
                    zip(unique_options, unique_options_is_text)
                ):
                    if options == obj.options and is_text == options_is_text:
                        group_indices[j].append(i)
                        batches[j].append(obj.text if is_text else obj.image)
                        break
                else:
                    # Create a new group if no match was found
                    group_indices[len(unique_options)] = [i]
                    unique_options.append(obj.options)
                    unique_options_is_text.append(is_text)
                    batches.append([obj.text if is_text else obj.image])

            embeddings = []
            for i, (options, is_text) in enumerate(zip(unique_options, unique_options_is_text)):
                embeddings.extend(
                    [
                        embedding
                        for embedding in self.embedder.embed(
                            model_name=model_name,
                            texts=batches[i] if is_text else None,
                            images=batches[i] if not is_text else None,
                            is_query=is_query,
                            options=options or {},
                            batch_size=batch_size,
                        )
                    ]
                )

            iter_embeddings = iter(embeddings)
            ordered_embeddings: list[list[NumericVector]] = [[]] * len(objects)
            for indices in group_indices.values():
                for index in indices:
                    ordered_embeddings[index] = next(iter_embeddings)
            return ordered_embeddings

        for model in self._batch_accumulator:
            if not any(
                (
                    self.embedder.is_supported_text_model(model),
                    self.embedder.is_supported_sparse_model(model),
                    self.embedder.is_supported_late_interaction_text_model(model),
                    self.embedder.is_supported_image_model(model),
                    self.embedder.is_supported_late_interaction_multimodal_model(model),
                )
            ):
                raise ValueError(
                    f"{model} is not found among supported models."
                    f"Check if `cloud_inference` is set to True or `fastembed` is installed (for local inference)?"
                )

        for model, data in self._batch_accumulator.items():
            self._embed_storage[model] = embed(
                objects=data, model_name=model, batch_size=inference_batch_size
            )
        self._batch_accumulator.clear()

    def _next_embed(self, model_name: str) -> NumericVector | models.Document:
        """Get next computed embedding from embedded batch

        Args:
            model_name: str - retrieve embedding from the storage by this model name

        Returns:
            NumericVector | models.Document : computed embedding
        """
        return self._embed_storage[model_name].pop(0)

    def _resolve_inference_object(self, data: models.VectorStruct) -> models.VectorStruct:
        """Resolve inference object into a model

        Args:
            data: models.VectorStruct - data to resolve, if it's an inference object, convert it to a proper type,
                otherwise - keep unchanged

        Returns:
            models.VectorStruct: resolved data
        """

        if not isinstance(data, models.InferenceObject):
            return data

        model_name = data.model
        value = data.object
        options = data.options
        if any(
            (
                self.embedder.is_supported_text_model(model_name),
                self.embedder.is_supported_sparse_model(model_name),
                self.embedder.is_supported_late_interaction_text_model(model_name),
            )
        ):
            return models.Document(model=model_name, text=value, options=options)
        if self.embedder.is_supported_image_model(model_name):
            return models.Image(model=model_name, image=value, options=options)
        if self.embedder.is_supported_late_interaction_multimodal_model(model_name):
            raise ValueError(f"{model_name} does not support `InferenceObject` interface")

        raise ValueError(f"{model_name} is not among supported models")

    @classmethod
    def _get_worker_class(cls) -> Type[ModelEmbedderWorker]:
        return ModelEmbedderWorker
