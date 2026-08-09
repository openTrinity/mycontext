from __future__ import annotations

import multiprocessing
from typing import TYPE_CHECKING, Any

import numpy as np
import torch
from torch import Tensor
from torch_geometric.data.feature_store import FeatureStore, TensorAttr

from .connection import Connection
from .types import Type

if TYPE_CHECKING:
    from torch_geometric.typing import FeatureTensorType

    from .database import Database


class LbugFeatureStore(FeatureStore):  # type: ignore[misc]
    """Feature store compatible with `torch_geometric`."""

    def __init__(self, db: Database, num_threads: int | None = None):
        super().__init__()
        self.db = db
        self.connection: Connection = None  # type: ignore[assignment]
        self.node_properties_cache: dict[str, dict[str, Any]] = {}
        if num_threads is None:
            num_threads = multiprocessing.cpu_count()
        self.num_threads = num_threads

    def __get_connection(self) -> Connection:
        if self.connection is None:
            self.connection = Connection(self.db, self.num_threads)
        return self.connection

    def _put_tensor(self, tensor: FeatureTensorType, attr: TensorAttr) -> bool:
        raise NotImplementedError

    def _get_tensor(self, attr: TensorAttr) -> FeatureTensorType | None:
        table_name = attr.group_name
        attr_name = attr.attr_name
        attr_info = self.__get_node_property(table_name, attr_name)
        if (
            attr_info["type"]
            not in [
                Type.INT64.value,
                Type.INT32.value,
                Type.INT16.value,
                Type.DOUBLE.value,
                Type.FLOAT.value,
                Type.BOOL.value,
            ]
        ) or (attr_info["dimension"] > 0 and "shape" not in attr_info):
            return self.__get_tensor_by_query(attr)
        return self.__get_tensor_by_scan(attr)

    def __get_tensor_by_scan(self, attr: TensorAttr) -> FeatureTensorType | None:
        table_name = attr.group_name
        attr_name = attr.attr_name
        indices = attr.index

        if indices is None:
            shape = self.get_tensor_size(attr)
            if indices is None:
                indices = np.arange(shape[0], dtype=np.uint64)
        elif isinstance(indices, slice):
            if indices.step is None or indices.step == 1:
                indices = np.arange(indices.start, indices.stop, dtype=np.uint64)
            else:
                indices = np.arange(
                    indices.start, indices.stop, indices.step, dtype=np.uint64
                )
        elif isinstance(indices, int):
            indices = np.array([indices])

        if table_name not in self.node_properties_cache:
            self.node_properties_cache[table_name] = (
                self.connection._get_node_property_names(table_name)
            )
        attr_info = self.node_properties_cache[table_name][attr_name]

        flat_dim = 1
        if attr_info["dimension"] > 0:
            for i in range(attr_info["dimension"]):
                flat_dim *= attr_info["shape"][i]
        scan_result = self.connection.database._scan_node_table(
            table_name,
            attr_name,
            attr_info["type"],
            flat_dim,
            indices,
            self.num_threads,
        )

        if attr_info["dimension"] > 0 and "shape" in attr_info:
            result_shape = (len(indices),) + attr_info["shape"]
            scan_result = scan_result.reshape(result_shape)

        result = torch.from_numpy(scan_result)
        return result

    def __get_tensor_by_query(self, attr: TensorAttr) -> FeatureTensorType | None:
        table_name = attr.group_name
        attr_name = attr.attr_name
        indices = attr.index

        self.__get_connection()

        match_clause = f"MATCH (item:{table_name})"
        return_clause = f"RETURN item.{attr_name}"

        if indices is None:
            where_clause = ""
        elif isinstance(indices, int):
            where_clause = f"WHERE offset(id(item)) = {indices}"
        elif isinstance(indices, slice):
            if indices.step is None or indices.step == 1:
                where_clause = f"WHERE offset(id(item)) >= {indices.start} AND offset(id(item)) < {indices.stop}"
            else:
                where_clause = (
                    f"WHERE offset(id(item)) >= {indices.start} AND offset(id(item)) < {indices.stop} "
                    f"AND (offset(id(item)) - {indices.start}) % {indices.step} = 0"
                )
        elif isinstance(indices, (Tensor, list, np.ndarray, tuple)):
            where_clause = "WHERE"
            for i in indices:
                where_clause += f" offset(id(item)) = {int(i)} OR"
            where_clause = where_clause[:-3]
        else:
            msg = f"Invalid attr.index type: {type(indices)!s}"
            raise ValueError(msg)

        query = f"{match_clause} {where_clause} {return_clause}"
        res = self.connection.execute(query)

        result_list = []
        while res.has_next():
            value_array = res.get_next()
            if len(value_array) == 1:
                value_array = value_array[0]
            result_list.append(value_array)
        try:
            return torch.tensor(result_list)
        except Exception:
            return result_list

    def _remove_tensor(self, attr: TensorAttr) -> bool:
        raise NotImplementedError

    def _get_tensor_size(self, attr: TensorAttr) -> tuple[Any, ...]:
        self.__get_connection()
        length_query = f"MATCH (item:{attr.group_name}) RETURN count(item)"
        res = self.connection.execute(length_query)
        length = res.get_next()[0]
        attr_info = self.__get_node_property(attr.group_name, attr.attr_name)
        if attr_info["dimension"] == 0:
            return (length,)
        else:
            return (length,) + attr_info["shape"]

    def __get_node_property(self, table_name: str, attr_name: str) -> dict[str, Any]:
        if (
            table_name in self.node_properties_cache
            and attr_name in self.node_properties_cache[table_name]
        ):
            return self.node_properties_cache[table_name][attr_name]
        self.__get_connection()
        if table_name not in self.node_properties_cache:
            self.node_properties_cache[table_name] = (
                self.connection._get_node_property_names(table_name)
            )
        if attr_name not in self.node_properties_cache[table_name]:
            msg = f"Attribute {attr_name} not found in group {table_name}"
            raise ValueError(msg)
        attr_info = self.node_properties_cache[table_name][attr_name]
        return attr_info

    def get_all_tensor_attrs(self) -> list[TensorAttr]:
        """Return all TensorAttr from the table nodes."""
        result_list = []
        self.__get_connection()
        for table_name in self.connection._get_node_table_names():
            if table_name not in self.node_properties_cache:
                self.node_properties_cache[table_name] = (
                    self.connection._get_node_property_names(table_name)
                )
            for attr_name in self.node_properties_cache[table_name]:
                if self.node_properties_cache[table_name][attr_name]["type"] in [
                    Type.INT64.value,
                    Type.INT32.value,
                    Type.INT16.value,
                    Type.DOUBLE.value,
                    Type.FLOAT.value,
                    Type.BOOL.value,
                ] and (
                    self.node_properties_cache[table_name][attr_name]["dimension"] == 0
                    or "shape" in self.node_properties_cache[table_name][attr_name]
                ):
                    result_list.append(TensorAttr(table_name, attr_name))
        return result_list
