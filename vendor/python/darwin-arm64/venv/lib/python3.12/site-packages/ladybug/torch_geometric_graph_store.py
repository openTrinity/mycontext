from __future__ import annotations

import multiprocessing
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import numpy as np
import torch
from torch_geometric.data.graph_store import EdgeAttr, EdgeLayout, GraphStore

from .connection import Connection

if TYPE_CHECKING:
    from typing import TypeAlias

    from torch_geometric.typing import EdgeTensorType

    from .database import Database

StoreKeyType: TypeAlias = tuple[tuple[str], Any, bool]

REL_BATCH_SIZE = 1000000


@dataclass
class Rel:  # noqa: D101
    edge_type: tuple[str, ...]
    layout: str
    is_sorted: bool
    size: tuple[int, ...]
    materialized: bool = False
    edge_index: EdgeTensorType | None = None


class LbugGraphStore(GraphStore):  # type: ignore[misc]
    """Graph store compatible with `torch_geometric`."""

    def __init__(self, db: Database, num_threads: int | None = None):
        super().__init__()
        self.db = db
        self.connection: Connection | None = None
        self.store: dict[StoreKeyType, Rel] = {}
        if num_threads is None:
            num_threads = multiprocessing.cpu_count()
        self.num_threads = num_threads
        self.__populate_edge_attrs()

    @staticmethod
    def key(attr: EdgeAttr) -> tuple[tuple[str], Any, bool]:  # noqa: D102
        return attr.edge_type, attr.layout.value, attr.is_sorted

    def _put_edge_index(self, edge_index: EdgeTensorType, edge_attr: EdgeAttr) -> None:
        key = self.key(edge_attr)
        if key in self.store:
            self.store[key].edge_index = edge_index
            self.store[key].materialized = True
            self.store[key].size = edge_attr.size
        else:
            self.store[key] = Rel(
                key[0], key[1], key[2], edge_attr.size, True, edge_index
            )

    def _get_edge_index(self, edge_attr: EdgeAttr) -> EdgeTensorType | None:
        if edge_attr.layout.value == EdgeLayout.COO.value:  # noqa: SIM102
            # We always return a sorted COO edge index, if the request is
            # for an unsorted COO edge index, we change the is_sorted flag
            # to True and return the sorted COO edge index.
            if edge_attr.is_sorted is False:
                edge_attr.is_sorted = True

        key = self.key(edge_attr)
        if key in self.store:
            rel = self.store[self.key(edge_attr)]
            if not rel.materialized and rel.layout != EdgeLayout.COO.value:
                msg = "Only COO layout is supported"
                raise ValueError(msg)

            if rel.layout == EdgeLayout.COO.value:
                self.__get_edge_coo_from_database(self.key(edge_attr))
            return rel.edge_index
        else:
            return None

    def _remove_edge_index(self, edge_attr: EdgeAttr) -> None:
        key = self.key(edge_attr)
        if key in self.store:
            del self.store[key]

    def get_all_edge_attrs(self) -> list[EdgeAttr]:
        """Return all EdgeAttr from the store values."""
        return [
            EdgeAttr(rel.edge_type, rel.layout, rel.is_sorted, rel.size)
            for rel in self.store.values()
        ]

    def __get_edge_coo_from_database(self, key: StoreKeyType) -> None:
        if not self.connection:
            self.connection = Connection(self.db, self.num_threads)

        rel = self.store[key]
        if rel.layout != EdgeLayout.COO.value:
            msg = "Only COO layout is supported"
            raise ValueError(msg)
        if rel.materialized:
            return

        edge_type = rel.edge_type
        num_edges = self.connection._connection.get_num_rels(edge_type[1])
        result = np.empty(2 * num_edges, dtype=np.int64)
        self.connection._connection.get_all_edges_for_torch_geometric(
            result, edge_type[0], edge_type[1], edge_type[2], REL_BATCH_SIZE
        )
        edge_list = torch.from_numpy(result)
        edge_list = edge_list.reshape((2, edge_list.shape[0] // 2))
        rel.edge_index = edge_list
        rel.materialized = True

    def __populate_edge_attrs(self) -> None:
        if not self.connection:
            self.connection = Connection(self.db, self.num_threads)
        rel_tables = self.connection._get_rel_table_names()
        for rel_table in rel_tables:
            edge_type = (rel_table["src"], rel_table["name"], rel_table["dst"])
            size = self.__get_size(edge_type)
            rel = Rel(edge_type, EdgeLayout.COO.value, True, size, False, None)
            self.store[self.key(EdgeAttr(edge_type, EdgeLayout.COO, True))] = rel

    def __get_size(self, edge_type: tuple[str, ...]) -> tuple[int, int]:
        num_nodes = self.connection._connection.get_num_nodes  # type: ignore[union-attr]
        src_count, dst_count = num_nodes(edge_type[0]), num_nodes(edge_type[-1])
        return (src_count, dst_count)
