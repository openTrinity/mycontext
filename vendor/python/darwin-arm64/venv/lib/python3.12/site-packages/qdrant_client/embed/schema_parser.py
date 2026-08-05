from copy import copy, deepcopy
from pathlib import Path
from typing import Type, Any

from pydantic import BaseModel

from qdrant_client._pydantic_compat import model_json_schema
from qdrant_client.embed.utils import FieldPath, convert_paths


try:
    from qdrant_client.embed._inspection_cache import (
        DEFS,
        CACHE_STR_PATH,
        RECURSIVE_REFS,
        EXCLUDED_RECURSIVE_REFS,
        INCLUDED_RECURSIVE_REFS,
        NAME_RECURSIVE_REF_MAPPING,
    )
except ImportError as e:
    DEFS = {}
    CACHE_STR_PATH = {}
    RECURSIVE_REFS = set()  # type: ignore
    EXCLUDED_RECURSIVE_REFS = {"Filter"}  # type: ignore
    INCLUDED_RECURSIVE_REFS = set()  # type: ignore
    NAME_RECURSIVE_REF_MAPPING = {}


class ModelSchemaParser:
    """Model schema parser. Parses json schemas to retrieve paths to objects requiring inference.

    The parser is stateful, it accumulates the results of parsing in its internal structures.

    Attributes:
        _defs: definitions extracted from json schemas
        _recursive_refs: set of recursive refs found in the processed schemas, e.g.:
            {"Filter", "Prefetch"}
        _excluded_recursive_refs: predefined time-consuming recursive refs which don't have inference objects, e.g.:
            {"Filter"}
        _included_recursive_refs: set of recursive refs which have inference objects, e.g.:
            {"Prefetch"}
        _cache: cache of string paths for models containing objects for inference, e.g.:
            {"Prefetch": ['prefetch.query', 'prefetch.query.context.negative', ...]}
        path_cache: cache of FieldPath objects for models containing objects for inference, e.g.:
            {
                 "Prefetch": [
                     FieldPath(
                         current="prefetch",
                         tail=[
                             FieldPath(
                                 current="query",
                                 tail=[
                                     FieldPath(
                                         current="recommend",
                                         tail=[
                                             FieldPath(current="negative", tail=None),
                                             FieldPath(current="positive", tail=None),
                                         ],
                                     ),
                                     ...,
                                 ],
                             ),
                         ],
                     )
                 ]
            }
        name_recursive_ref_mapping: mapping of model field names to ref names, e.g.:
            {"prefetch": "Prefetch"}
    """

    CACHE_PATH = "_inspection_cache.py"
    INFERENCE_OBJECT_NAMES = {"Document", "Image", "InferenceObject"}

    def __init__(self) -> None:
        # self._defs does not include the whole schema, but only the part with the structures used in $defs
        self._defs: dict[str, dict[str, Any] | list[dict[str, Any]]] = deepcopy(DEFS)  # type: ignore[arg-type]
        self._cache: dict[str, list[str]] = deepcopy(CACHE_STR_PATH)

        self._recursive_refs: set[str] = set(RECURSIVE_REFS)
        self._excluded_recursive_refs: set[str] = set(EXCLUDED_RECURSIVE_REFS)
        self._included_recursive_refs: set[str] = set(INCLUDED_RECURSIVE_REFS)

        self.name_recursive_ref_mapping: dict[str, str] = {
            k: v for k, v in NAME_RECURSIVE_REF_MAPPING.items()
        }
        self.path_cache: dict[str, list[FieldPath]] = {
            model: convert_paths(paths) for model, paths in self._cache.items()
        }
        self._processed_recursive_defs: dict[str, Any] = {}

    def _replace_refs(
        self,
        schema: dict[str, Any] | list[dict[str, Any]],
        parent: str | None = None,
        seen_refs: set | None = None,
    ) -> dict[str, Any] | list[dict[str, Any]]:
        """Replace refs in schema with their definitions

        Args:
            schema: schema to parse
            parent: previous level key
            seen_refs: set of seen refs to spot recursive paths

        Returns:
            schema with replaced refs
        """
        parent = parent if parent else None
        seen_refs = seen_refs if seen_refs else set()

        if isinstance(schema, dict):
            if "$ref" in schema:
                ref_path = schema["$ref"]
                def_key = ref_path.split("/")[-1]
                if def_key in self._processed_recursive_defs:
                    return self._processed_recursive_defs[def_key]

                if def_key == parent or def_key in seen_refs:
                    self._recursive_refs.add(def_key)
                    self._processed_recursive_defs[def_key] = schema
                    return schema

                seen_refs.add(def_key)

                return self._replace_refs(
                    self._defs[def_key], parent=def_key, seen_refs=copy(seen_refs)
                )

            schemes = {}
            if "properties" in schema:
                for k, v in schema.items():
                    if k == "properties":
                        schemes[k] = self._replace_refs(
                            schema=v, parent=parent, seen_refs=copy(seen_refs)
                        )
                    else:
                        schemes[k] = v
            else:
                for k, v in schema.items():
                    parent_key = k if isinstance(v, dict) and "properties" in v else parent
                    schemes[k] = self._replace_refs(
                        schema=v, parent=parent_key, seen_refs=copy(seen_refs)
                    )

            return schemes
        elif isinstance(schema, list):
            return [
                self._replace_refs(schema=item, parent=parent, seen_refs=copy(seen_refs))  # type: ignore
                for item in schema
            ]
        else:
            return schema

    def _find_document_paths(
        self,
        schema: dict[str, Any] | list[dict[str, Any]],
        current_path: str = "",
        after_properties: bool = False,
        seen_refs: set | None = None,
    ) -> list[str]:
        """Read a schema and find paths to objects requiring inference

        Populates model fields names to ref names mapping

        Args:
            schema: schema to parse
            current_path: current path in the schema
            after_properties: flag indicating if the current path is after "properties" key
            seen_refs: set of seen refs to spot recursive paths

        Returns:
            List of string dot separated paths to objects requiring inference
        """
        document_paths: list[str] = []
        seen_recursive_refs = seen_refs if seen_refs is not None else set()

        parts = current_path.split(".")
        if len(parts) != len(set(parts)):  # check for recursive paths
            return document_paths

        if not isinstance(schema, dict):
            return document_paths

        if "title" in schema and schema["title"] in self.INFERENCE_OBJECT_NAMES:
            document_paths.append(current_path)
            return document_paths

        for key, value in schema.items():
            if key == "$defs":
                continue

            if key == "$ref":
                model_name = value.split("/")[-1]

                value = self._defs[model_name]
                if model_name in seen_recursive_refs:
                    continue

                if (
                    model_name in self._excluded_recursive_refs
                ):  # on the first run it might be empty
                    continue

                if (
                    model_name in self._recursive_refs
                ):  # included and excluded refs might not be filled up yet, we're looking in all recursive refs
                    # we would need to clean up name recursive ref mapping later and delete excluded refs from there
                    seen_recursive_refs.add(model_name)
                    self.name_recursive_ref_mapping[current_path.split(".")[-1]] = model_name

            if after_properties:  # field name seen in pydantic models comes after "properties" key
                if current_path:
                    new_path = f"{current_path}.{key}"
                else:
                    new_path = key
            else:
                new_path = current_path

            if isinstance(value, dict):
                document_paths.extend(
                    self._find_document_paths(
                        value, new_path, key == "properties", seen_refs=seen_recursive_refs
                    )
                )
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        document_paths.extend(
                            self._find_document_paths(
                                item,
                                new_path,
                                key == "properties",
                                seen_refs=seen_recursive_refs,
                            )
                        )

        return sorted(set(document_paths))

    def parse_model(self, model: Type[BaseModel]) -> None:
        """Parse model schema to retrieve paths to objects requiring inference.

        Checks model json schema, extracts definitions and finds paths to objects requiring inference.
        No parsing happens if model has already been processed.

        Args:
            model: model to parse

        Returns:
            None
        """
        model_name = model.__name__
        if model_name in self._cache:
            return None

        schema = model_json_schema(model)

        for k, v in schema.get("$defs", {}).items():
            if k not in self._defs:
                self._defs[k] = v

        if "$defs" in schema:
            raw_refs = (
                {"$ref": schema["$ref"]}
                if "$ref" in schema
                else {"properties": schema["properties"]}
            )
            refs = self._replace_refs(raw_refs)
            self._cache[model_name] = self._find_document_paths(refs)
        else:
            self._cache[model_name] = []

        for ref in self._recursive_refs:
            if ref in self._excluded_recursive_refs or ref in self._included_recursive_refs:
                continue

            if self._find_document_paths(self._defs[ref]):
                self._included_recursive_refs.add(ref)
            else:
                self._excluded_recursive_refs.add(ref)

        self.name_recursive_ref_mapping = {
            k: v
            for k, v in self.name_recursive_ref_mapping.items()
            if v not in self._excluded_recursive_refs
        }

        # convert str paths to FieldPath objects which group path parts and reduce the time of the traversal
        self.path_cache = {model: convert_paths(paths) for model, paths in self._cache.items()}

    def _persist(self, output_path: Path | str = CACHE_PATH) -> None:
        """Persist the parser state to a file

        Args:
            output_path: path to the file to save the parser state

        Returns:
            None
        """
        with open(output_path, "w") as f:
            f.write(f"CACHE_STR_PATH = {self._cache}\n")
            f.write(f"DEFS = {self._defs}\n")
            # `sorted is required` to use `diff` in comparisons
            f.write(f"RECURSIVE_REFS = {sorted(self._recursive_refs)}\n")
            f.write(f"INCLUDED_RECURSIVE_REFS = {sorted(self._included_recursive_refs)}\n")
            f.write(f"EXCLUDED_RECURSIVE_REFS = {sorted(self._excluded_recursive_refs)}\n")
            f.write(f"NAME_RECURSIVE_REF_MAPPING = {self.name_recursive_ref_mapping}\n")
