from copy import copy
from typing import Iterable, get_args

from pydantic import BaseModel

from qdrant_client._pydantic_compat import model_fields_set
from qdrant_client.embed.common import INFERENCE_OBJECT_TYPES
from qdrant_client.embed.schema_parser import ModelSchemaParser

from qdrant_client.embed.utils import convert_paths, FieldPath


class InspectorEmbed:
    """Inspector which collects paths to objects requiring inference in the received models

    Attributes:
        parser: ModelSchemaParser instance
    """

    def __init__(self, parser: ModelSchemaParser | None = None) -> None:
        self.parser = ModelSchemaParser() if parser is None else parser

    def inspect(self, points: Iterable[BaseModel] | BaseModel) -> list[FieldPath]:
        """Looks for all the paths to objects requiring inference in the received models

        Args:
            points: models to inspect

        Returns:
            list of FieldPath objects
        """
        paths = []
        if isinstance(points, BaseModel):
            self.parser.parse_model(points.__class__)
            paths.extend(self._inspect_model(points))
        elif isinstance(points, dict):
            for value in points.values():
                paths.extend(self.inspect(value))
        elif isinstance(points, Iterable):
            for point in points:
                if isinstance(point, BaseModel):
                    self.parser.parse_model(point.__class__)
                    paths.extend(self._inspect_model(point))

        paths = sorted(set(paths))

        return convert_paths(paths)

    def _inspect_model(
        self, mod: BaseModel, paths: list[FieldPath] | None = None, accum: str | None = None
    ) -> list[str]:
        """Looks for all the paths to objects requiring inference in the received model

        Args:
            mod: model to inspect
            paths: list of paths to the fields possibly containing objects for inference
            accum: accumulator for the path. Path is a dot separated string of field names which we assemble recursively

        Returns:
            list of paths to the model fields containing objects for inference
        """
        paths = self.parser.path_cache.get(mod.__class__.__name__, []) if paths is None else paths

        found_paths = []
        for path in paths:
            found_paths.extend(
                self._inspect_inner_models(
                    mod, path.current, path.tail if path.tail else [], accum
                )
            )
        return found_paths

    def _inspect_inner_models(
        self,
        original_model: BaseModel,
        current_path: str,
        tail: list[FieldPath],
        accum: str | None = None,
    ) -> list[str]:
        """Looks for all the paths to objects requiring inference in the received model

        Args:
            original_model: model to inspect
            current_path: the field to inspect on the current iteration
            tail: list of FieldPath objects to the fields possibly containing objects for inference
            accum: accumulator for the path. Path is a dot separated string of field names which we assemble recursively

        Returns:
            list of paths to the model fields containing objects for inference
        """
        found_paths = []
        if accum is None:
            accum = current_path
        else:
            accum += f".{current_path}"

        def inspect_recursive(member: BaseModel, accumulator: str) -> list[str]:
            """Iterates over the set model fields, expand recursive ones and find paths to objects requiring inference

            Args:
                member: currently inspected model, which may or may not contain recursive fields
                accumulator: accumulator for the path, which is a dot separated string assembled recursively
            """
            recursive_paths = []
            for field in model_fields_set(member):
                if field in self.parser.name_recursive_ref_mapping:
                    mapped_field = self.parser.name_recursive_ref_mapping[field]
                    recursive_paths.extend(self.parser.path_cache[mapped_field])

            return self._inspect_model(member, copy(recursive_paths), accumulator)

        model = getattr(original_model, current_path, None)
        if model is None:
            return []

        if isinstance(model, get_args(INFERENCE_OBJECT_TYPES)):
            return [accum]

        if isinstance(model, BaseModel):
            found_paths.extend(inspect_recursive(model, accum))

            for next_path in tail:
                found_paths.extend(
                    self._inspect_inner_models(
                        model, next_path.current, next_path.tail if next_path.tail else [], accum
                    )
                )

            return found_paths

        elif isinstance(model, list):
            for current_model in model:
                if not isinstance(current_model, BaseModel):
                    continue

                if isinstance(current_model, get_args(INFERENCE_OBJECT_TYPES)):
                    found_paths.append(accum)

                found_paths.extend(inspect_recursive(current_model, accum))

            for next_path in tail:
                for current_model in model:
                    found_paths.extend(
                        self._inspect_inner_models(
                            current_model,
                            next_path.current,
                            next_path.tail if next_path.tail else [],
                            accum,
                        )
                    )
            return found_paths

        elif isinstance(model, dict):
            found_paths = []
            for key, values in model.items():
                values = [values] if not isinstance(values, list) else values
                for current_model in values:
                    if not isinstance(current_model, BaseModel):
                        continue

                    if isinstance(current_model, get_args(INFERENCE_OBJECT_TYPES)):
                        found_paths.append(accum)

                    found_paths.extend(inspect_recursive(current_model, accum))

                for next_path in tail:
                    for current_model in values:
                        found_paths.extend(
                            self._inspect_inner_models(
                                current_model,
                                next_path.current,
                                next_path.tail if next_path.tail else [],
                                accum,
                            )
                        )
        return found_paths
