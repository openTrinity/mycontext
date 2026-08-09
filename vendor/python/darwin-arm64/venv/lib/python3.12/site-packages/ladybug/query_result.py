from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from .constants import DST, ID, LABEL, NODES, RELS, SRC
from .torch_geometric_result_converter import TorchGeometricResultConverter
from .types import Type

if TYPE_CHECKING:
    import sys
    from collections.abc import Iterator
    from types import TracebackType
    from typing import Any

    import networkx as nx
    import pandas as pd
    import polars as pl
    import pyarrow as pa
    import torch_geometric.data as geo

    if sys.version_info >= (3, 11):
        from typing import Self
    else:
        from typing_extensions import Self


class QueryResult:
    """QueryResult stores the result of a query execution."""

    def __init__(self, connection: Any, query_result: Any):
        """
        Parameters
        ----------
        connection : _lbug.Connection
            The underlying C++ connection object from pybind11.

        query_result : _lbug.QueryResult
            The underlying C++ query result object from pybind11.

        """
        self.connection = connection
        self._query_result = query_result
        self.is_closed = False
        self.as_dict = False

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        exc_traceback: TracebackType | None,
    ) -> None:
        self.close()

    def __del__(self) -> None:
        self.close()

    def __iter__(self) -> Iterator[list[Any] | dict[str, Any]]:
        return self

    def __next__(self) -> list[Any] | dict[str, Any]:
        if self.has_next():
            return self.get_next()

        raise StopIteration

    def has_next(self) -> bool:
        """
        Check if there are more rows in the query result.

        Returns
        -------
        bool
            True if there are more rows in the query result, False otherwise.
        """
        self.check_for_query_result_close()
        return self._query_result.hasNext()

    def get_next(self) -> list[Any] | dict[str, Any]:
        """
        Get the next row in the query result.

        Returns
        -------
        list
            Next row in the query result.

        Raises
        ------
        Exception
            If there are no more rows.
        """
        self.check_for_query_result_close()
        row = self._query_result.getNext()
        return _row_to_dict(self.columns, row) if self.as_dict else row

    def get_all(self) -> list[list[Any] | dict[str, Any]]:
        """
        Get the next row in the query result.

        Returns
        -------
        list
            All remaining rows in the query result.
        """
        return list(self)

    def get_n(self, count: int) -> list[list[Any] | dict[str, Any]]:
        """
        Get many rows in the query result.

        Returns
        -------
        list
            Up to `count` rows in the query result.
        """
        results = []
        while self.has_next() and count > 0:
            results.append(self.get_next())
            count -= 1
        return results

    def close(self) -> None:
        """Close the query result."""
        if self.is_closed:
            return

        # Allows the connection to be garbage collected if the query result
        # is closed manually by the user.
        parent_db_closed = (
            self.connection is not None and self.connection.database.is_closed
        )
        if self.connection is not None:
            self.connection._unregister_query_result(self)
        if not parent_db_closed:
            self._query_result.close()
        self.connection = None
        self.is_closed = True

    def check_for_query_result_close(self) -> None:
        """
        Check if the query result is closed and raise an exception if it is.

        Raises
        ------
        Exception
            If the query result is closed.

        """
        if self.is_closed:
            msg = "Query result is closed"
            raise RuntimeError(msg)

        if self.connection is None:
            msg = "Query result is closed"
            raise RuntimeError(msg)

        if self.connection.database.is_closed:
            msg = "the parent database is closed"
            raise RuntimeError(msg)

        if self.connection.is_closed:
            msg = "the parent connection is closed"
            raise RuntimeError(msg)

    def get_as_df(self) -> pd.DataFrame:
        """
        Get the query result as a Pandas DataFrame.

        Returns
        -------
        pandas.DataFrame
            Query result as a Pandas DataFrame.

        See Also
        --------
        get_as_pl : Get the query result as a Polars DataFrame.
        get_as_arrow : Get the query result as a PyArrow Table.

        """
        self.check_for_query_result_close()

        return self._query_result.getAsDF()

    def get_as_pl(self) -> pl.DataFrame:
        """
        Get the query result as a Polars DataFrame.

        Returns
        -------
        polars.DataFrame
            Query result as a Polars DataFrame.

        See Also
        --------
        get_as_df : Get the query result as a Pandas DataFrame.
        get_as_arrow : Get the query result as a PyArrow Table.
        """
        import polars as pl

        self.check_for_query_result_close()

        # note: polars should always export just a single chunk,
        # (eg: "-1") otherwise it will just need to rechunk anyway
        return pl.from_arrow(  # type: ignore[return-value]
            data=self.get_as_arrow(chunk_size=-1, fallbackExtensionTypes=True),
        )

    def get_as_arrow(
        self, chunk_size: int | None = None, *, fallbackExtensionTypes: bool = False
    ) -> pa.Table:
        """
        Get the query result as a PyArrow Table.

        Parameters
        ----------
        chunk_size : Number of rows to include in each chunk.
            None
                The chunk size is adaptive and depends on the number of columns in the query result.
            -1 or 0
                The entire result is returned as a single chunk.
            > 0
                The chunk size is the number of rows specified.

        fallbackExtensionTypes : bool
            Avoid using Arrow extension types for compatibility with Polars

        Returns
        -------
        pyarrow.Table
            Query result as a PyArrow Table.

        See Also
        --------
        get_as_pl : Get the query result as a Polars DataFrame.
        get_as_df : Get the query result as a Pandas DataFrame.
        """
        self.check_for_query_result_close()

        if chunk_size is None:
            # Adaptive; target 10m total elements in each chunk.
            # (eg: if we had 10 cols, this would result in a 1m row chunk_size).
            target_n_elems = 10_000_000
            chunk_size = max(target_n_elems // len(self.get_column_names()), 10)
        elif chunk_size <= 0:
            # No chunking: return the entire result as a single chunk
            chunk_size = self.get_num_tuples()

        return self._query_result.getAsArrow(chunk_size, fallbackExtensionTypes)

    def get_column_data_types(self) -> list[str]:
        """
        Get the data types of the columns in the query result.

        Returns
        -------
        list
            Data types of the columns in the query result.

        """
        self.check_for_query_result_close()
        return self._query_result.getColumnDataTypes()

    def get_column_names(self) -> list[str]:
        """
        Get the names of the columns in the query result.

        Returns
        -------
        list
            Names of the columns in the query result.

        """
        self.check_for_query_result_close()
        return self._query_result.getColumnNames()

    def get_schema(self) -> dict[str, str]:
        """
        Get the column schema of the query result.

        Returns
        -------
        dict
            Schema of the query result.

        """
        self.check_for_query_result_close()
        return dict(
            zip(
                self._query_result.getColumnNames(),
                self._query_result.getColumnDataTypes(),
                strict=False,
            )
        )

    def reset_iterator(self) -> None:
        """Reset the iterator of the query result."""
        self.check_for_query_result_close()
        self._query_result.resetIterator()

    def get_as_networkx(
        self,
        directed: bool = True,  # noqa: FBT001
    ) -> nx.MultiGraph | nx.MultiDiGraph:
        """
        Convert the nodes and rels in query result into a NetworkX directed or undirected graph
        with the following rules:
        Columns with data type other than node or rel will be ignored.
        Duplicated nodes and rels will be converted only once.

        Parameters
        ----------
        directed : bool
            Whether the graph should be directed. Defaults to True.

        Returns
        -------
        networkx.MultiDiGraph or networkx.MultiGraph
            Query result as a NetworkX graph.

        """
        self.check_for_query_result_close()
        import networkx as nx

        nx_graph = nx.MultiDiGraph() if directed else nx.MultiGraph()
        properties_to_extract = self._get_properties_to_extract()

        self.reset_iterator()

        nodes = {}
        rels = {}
        table_to_label_dict = {}
        table_primary_key_dict = {}

        def encode_node_id(
            node: dict[str, Any], table_primary_key_dict: dict[str, Any]
        ) -> str:
            node_label = node[LABEL]
            return f"{node_label}_{node[table_primary_key_dict[node_label]]!s}"

        def encode_rel_id(rel: dict[str, Any]) -> tuple[int, int]:
            return rel[ID]["table"], rel[ID]["offset"]

        # De-duplicate nodes and rels
        while self.has_next():
            row = self.get_next()
            for i in properties_to_extract:
                # Skip empty nodes and rels, which may be returned by
                # OPTIONAL MATCH
                if row[i] is None or row[i] == {}:
                    continue
                column_type, _ = properties_to_extract[i]
                if column_type == Type.NODE.value:
                    nid = row[i][ID]
                    nodes[nid["table"], nid["offset"]] = row[i]
                    table_to_label_dict[nid["table"]] = row[i][LABEL]

                elif column_type == Type.REL.value:
                    rels[encode_rel_id(row[i])] = row[i]

                elif column_type == Type.RECURSIVE_REL.value:
                    for node in row[i][NODES]:
                        nid = node[ID]
                        nodes[nid["table"], nid["offset"]] = node
                        table_to_label_dict[nid["table"]] = node[LABEL]
                    for rel in row[i][RELS]:
                        for key in list(rel.keys()):
                            if rel[key] is None:
                                del rel[key]
                        rels[encode_rel_id(rel)] = rel

        # Add nodes
        for node in nodes.values():
            nid = node[ID]
            node_id = node[LABEL] + "_" + str(nid["offset"])
            if node[LABEL] not in table_primary_key_dict:
                props = self.connection._get_node_property_names(node[LABEL])
                for prop_name in props:
                    if props[prop_name]["is_primary_key"]:
                        table_primary_key_dict[node[LABEL]] = prop_name
                        break
            node_id = encode_node_id(node, table_primary_key_dict)
            node[node[LABEL]] = True
            nx_graph.add_node(node_id, **node)

        # Add rels
        for rel in rels.values():
            src = rel[SRC]
            dst = rel[DST]
            src_node = nodes[src["table"], src["offset"]]
            dst_node = nodes[dst["table"], dst["offset"]]
            src_id = encode_node_id(src_node, table_primary_key_dict)
            dst_id = encode_node_id(dst_node, table_primary_key_dict)
            nx_graph.add_edge(src_id, dst_id, **rel)
        return nx_graph

    def _get_properties_to_extract(self) -> dict[int, tuple[str, str]]:
        column_names = self.get_column_names()
        column_types = self.get_column_data_types()
        properties_to_extract = {}

        # Iterate over columns and extract nodes and rels, ignoring other columns
        for i in range(len(column_names)):
            column_name = column_names[i]
            column_type = column_types[i]
            if column_type in [
                Type.NODE.value,
                Type.REL.value,
                Type.RECURSIVE_REL.value,
            ]:
                properties_to_extract[i] = (column_type, column_name)
        return properties_to_extract

    def get_as_torch_geometric(self) -> tuple[geo.Data | geo.HeteroData, dict, dict, dict]:  # type: ignore[type-arg]
        """
        Convert the nodes and rels in query result into a PyTorch Geometric graph representation
        torch_geometric.data.Data or torch_geometric.data.HeteroData.

        For node conversion, numerical and boolean properties are directly converted into tensor and
        stored in Data/HeteroData. For properties cannot be converted into tensor automatically
        (please refer to the notes below for more detail), they are returned as unconverted_properties.

        For rel conversion, rel is converted into edge_index tensor director. Edge properties are returned
        as edge_properties.

        Node properties that cannot be converted into tensor automatically:
        - If the type of a node property is not one of INT64, DOUBLE, or BOOL, it cannot be converted
          automatically.
        - If a node property contains a null value, it cannot be converted automatically.
        - If a node property contains a nested list of variable length (e.g. [[1,2],[3]]), it cannot be
          converted automatically.
        - If a node property is a list or nested list, but the shape is inconsistent (e.g. the list length
          is 6 for one node but 5 for another node), it cannot be converted automatically.

        Additional conversion rules:
        - Columns with data type other than node or rel will be ignored.
        - Duplicated nodes and rels will be converted only once.

        Returns
        -------
        torch_geometric.data.Data or torch_geometric.data.HeteroData
            Query result as a PyTorch Geometric graph. Containing numeric or boolean node properties
            and edge_index tensor.

        dict
            A dictionary that maps the positional offset of each node in Data/HeteroData to its primary
            key in the database.

        dict
            A dictionary contains node properties that cannot be converted into tensor automatically. The
            order of values for each property is aligned with nodes in Data/HeteroData.

        dict
            A dictionary contains edge properties. The order of values for each property is aligned with
            edge_index in Data/HeteroData.
        """
        self.check_for_query_result_close()
        # Despite we are not using torch_geometric in this file, we need to
        # import it here to throw an error early if the user does not have
        # torch_geometric or torch installed.

        converter = TorchGeometricResultConverter(self)
        return converter.get_as_torch_geometric()

    def get_execution_time(self) -> int:
        """
        Get the time in ms which was required for executing the query.

        Returns
        -------
        double
            Query execution time as double in ms.

        """
        self.check_for_query_result_close()
        return self._query_result.getExecutionTime()

    def get_compiling_time(self) -> int:
        """
        Get the time in ms which was required for compiling the query.

        Returns
        -------
        double
            Query compile time as double in ms.

        """
        self.check_for_query_result_close()
        return self._query_result.getCompilingTime()

    def get_num_tuples(self) -> int:
        """
        Get the number of tuples which the query returned.

        Returns
        -------
        int
            Number of tuples.

        """
        self.check_for_query_result_close()
        return self._query_result.getNumTuples()

    def rows_as_dict(self, state=True) -> Self:
        """
        Change the format of the results, such that each row is a dict with the
        column name as a key.

        Parameters
        ----------
        state
            Whether to turn dict formatting on or off. Turns it on by default.

        Returns
        -------
        self
            The object itself.

        """
        self.as_dict = state
        if state:
            self.columns = self.get_column_names()
        return self


class ArrowQueryResult(QueryResult):
    """QueryResult backed by the native Arrow collector path."""

    def __init__(
        self, connection: Any, query_result: Any, native_chunk_size: int
    ) -> None:
        super().__init__(connection, query_result)
        self._native_chunk_size = native_chunk_size

    def get_as_arrow(
        self, chunk_size: int | None = None, *, fallbackExtensionTypes: bool = False
    ) -> pa.Table:
        """
        Get the query result as a PyArrow Table.

        Arrow-native results preserve the execution-time chunking chosen by
        `Connection.query_as_arrow(...)`. Requesting `None`, `0`, or `-1`
        reuses that native chunk size instead of rechunking the result.
        """
        if chunk_size is None or chunk_size <= 0:
            chunk_size = self._native_chunk_size
        return super().get_as_arrow(
            chunk_size, fallbackExtensionTypes=fallbackExtensionTypes
        )

    def csr(self) -> CSRResult:
        """
        Get native CSR arrays from an Arrow query result.

        This is available only for Arrow results with CSR metadata, typically
        from `Connection.query_as_arrow(...)` on relationship-shaped projections.
        """
        self.check_for_query_result_close()

        csr = self._query_result.getCSR()
        return CSRResult(
            indptr=csr["indptr"],
            indices=csr["indices"],
            edge_ids=csr["edge_ids"],
        )


@dataclass(frozen=True)
class CSRResult:
    """Native CSR arrays returned by an Arrow query result."""

    indptr: pa.Array
    indices: pa.Array
    edge_ids: pa.Array | None = None


def _row_to_dict(columns: list[str], row: list[Any]) -> dict[str, Any]:
    if len(columns) != len(row):
        msg = "Number of columns in output row does not match number of columns"
        raise RuntimeError(msg)

    return dict(zip(columns, row, strict=False))
