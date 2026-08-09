from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar
from weakref import WeakSet

from ._backend import get_capi_module, get_pybind_module
from .types import Type

if TYPE_CHECKING:
    import sys
    from types import TracebackType

    from numpy.typing import NDArray
    from torch_geometric.data.feature_store import IndexType

    from .connection import Connection
    from .torch_geometric_feature_store import LbugFeatureStore
    from .torch_geometric_graph_store import LbugGraphStore

    if sys.version_info >= (3, 11):
        from typing import Self
    else:
        from typing_extensions import Self


class Database:
    """Lbug database instance."""

    _VALID_BACKENDS: ClassVar[set[str]] = {"auto", "capi", "pybind"}

    def __init__(
        self,
        database_path: str | Path | None = None,
        *,
        buffer_pool_size: int = 0,
        max_num_threads: int = 0,
        compression: bool = True,
        lazy_init: bool = False,
        read_only: bool = False,
        max_db_size: int | None = None,
        auto_checkpoint: bool = True,
        checkpoint_threshold: int = -1,
        throw_on_wal_replay_failure: bool = True,
        enable_checksums: bool = True,
        enable_multi_writes: bool = False,
        backend: str = "auto",
    ):
        """
        Parameters
        ----------
        database_path : str, Path
            The path to database files. If the path is not specified, or empty, or equal to `:memory:`, the database
            will be created in memory.

        buffer_pool_size : int
            The maximum size of buffer pool in bytes. Defaults to ~80% of system memory.

        max_num_threads : int
            The maximum number of threads to use for executing queries.

        compression : bool
            Enable database compression.

        lazy_init : bool
            If True, the database will not be initialized until the first query.
            This is useful when the database is not used in the main thread or
            when the main process is forked.
            Default to False.

        read_only : bool
            If true, the database is opened read-only. No write transactions is
            allowed on the `Database` object. Multiple read-only `Database`
            objects can be created with the same database path. However, there
            cannot be multiple `Database` objects created with the same
            database path.
            Default to False.

        max_db_size : int, optional
            The maximum size of the database in bytes. Note that this is introduced
            temporarily for now to get around with the default 8TB mmap address
             space limit some environment. This will be removed once we implement
             a better solution later. If not specified, the backend's default is used.

        auto_checkpoint: bool
            If true, the database will automatically checkpoint when the size of
            the WAL file exceeds the checkpoint threshold.

        checkpoint_threshold: int
            The threshold of the WAL file size in bytes. When the size of the
            WAL file exceeds this threshold, the database will checkpoint if autoCheckpoint is true.

        throw_on_wal_replay_failure: bool
            If true, any WAL replaying failure when loading the database will throw an error.
            Otherwise, Lbug will silently ignore the failure and replay up to where the error
            occured.

        enable_checksums: bool
            If true, the database will use checksums to detect corruption in the
            WAL file.

        enable_multi_writes: bool
            If true, multiple concurrent write transactions are allowed. Default to False.

        backend : {"auto", "capi", "pybind"}
            Backend to use for database/query execution.
            `auto` prefers pybind when the optional `_lbug` extension is available and
            falls back to the C-API shim otherwise.

        """
        if database_path is None:
            database_path = ":memory:"
        if isinstance(database_path, Path):
            database_path = str(database_path)

        self.database_path = database_path
        self.buffer_pool_size = buffer_pool_size
        self.max_num_threads = max_num_threads
        self.compression = compression
        self.read_only = read_only
        self.max_db_size = max_db_size
        self.auto_checkpoint = auto_checkpoint
        self.checkpoint_threshold = checkpoint_threshold
        self.throw_on_wal_replay_failure = throw_on_wal_replay_failure
        self.enable_checksums = enable_checksums
        self.enable_multi_writes = enable_multi_writes
        self.backend = self._resolve_backend_preference(backend)
        self.is_closed = False

        self._database: Any = None  # (type: _lbug.Database from pybind11)
        self._pybind_database: Any = None
        self._use_pybind_backend = self._should_use_pybind_backend()
        self._connections: WeakSet[Connection] = WeakSet()
        if not lazy_init:
            self.init_database()

    @classmethod
    def _resolve_backend_preference(cls, backend: str) -> str:
        env_backend = os.getenv("LBUG_PYTHON_BACKEND")
        selected = env_backend if env_backend is not None else backend
        normalized = selected.strip().lower()
        if normalized not in cls._VALID_BACKENDS:
            valid = ", ".join(sorted(cls._VALID_BACKENDS))
            msg = f"Invalid backend {selected!r}. Expected one of: {valid}."
            raise ValueError(msg)
        return normalized

    def _should_use_pybind_backend(self) -> bool:
        if self.backend == "capi":
            return False
        pybind_module = get_pybind_module()
        if self.backend == "pybind":
            if pybind_module is None:
                msg = "Requested pybind backend, but ladybug._lbug is not available."
                raise RuntimeError(msg)
            return True
        return pybind_module is not None

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        exc_traceback: TracebackType | None,
    ) -> None:
        self.close()

    @staticmethod
    def get_version() -> str:
        """
        Get the version of the database.

        Returns
        -------
        str
            The version of the database.
        """
        backend = os.getenv("LBUG_PYTHON_BACKEND", "").strip().lower()
        pybind_module = None if backend == "capi" else get_pybind_module()
        if pybind_module is not None:
            return str(pybind_module.Database.get_version())

        return str(get_capi_module().Database.get_version())

    @staticmethod
    def get_storage_version() -> int:
        """
        Get the storage version of the database.

        Returns
        -------
        int
            The storage version of the database.
        """
        backend = os.getenv("LBUG_PYTHON_BACKEND", "").strip().lower()
        pybind_module = None if backend == "capi" else get_pybind_module()
        if pybind_module is not None:
            return int(pybind_module.Database.get_storage_version())

        return int(get_capi_module().Database.get_storage_version())

    def __getstate__(self) -> dict[str, Any]:
        state = {
            "database_path": self.database_path,
            "buffer_pool_size": self.buffer_pool_size,
            "compression": self.compression,
            "read_only": self.read_only,
            "backend": self.backend,
            "_database": None,
        }
        return state

    def init_database(self) -> None:
        """Initialize the database."""
        self.check_for_database_close()
        if self._database is None:
            if self._use_pybind_backend:
                self._database = self.init_pybind_database()
            else:
                self._database = get_capi_module().Database(
                    self.database_path,
                    self.buffer_pool_size,
                    self.max_num_threads,
                    self.compression,
                    self.read_only,
                    self.max_db_size,
                    self.auto_checkpoint,
                    self.checkpoint_threshold,
                    self.throw_on_wal_replay_failure,
                    self.enable_checksums,
                    self.enable_multi_writes,
                )

    def init_pybind_database(self) -> Any | None:
        """Initialize and return the optional pybind database backend."""
        self.check_for_database_close()
        pybind_module = get_pybind_module()
        if pybind_module is None:
            return None
        if self._pybind_database is None:
            kwargs = {
                "database_path": self.database_path,
                "buffer_pool_size": self.buffer_pool_size,
                "max_num_threads": self.max_num_threads,
                "compression": self.compression,
                "read_only": self.read_only,
                "auto_checkpoint": self.auto_checkpoint,
                "checkpoint_threshold": self.checkpoint_threshold,
                "throw_on_wal_replay_failure": self.throw_on_wal_replay_failure,
                "enable_checksums": self.enable_checksums,
                "enable_multi_writes": self.enable_multi_writes,
            }

            if self.max_db_size is not None:
                kwargs["max_db_size"] = self.max_db_size

            self._pybind_database = pybind_module.Database(**kwargs)

        return self._pybind_database

    def get_torch_geometric_remote_backend(
        self, num_threads: int | None = None
    ) -> tuple[LbugFeatureStore, LbugGraphStore]:
        """
        Use the database as the remote backend for torch_geometric.

        For the interface of the remote backend, please refer to
        https://pytorch-geometric.readthedocs.io/en/latest/advanced/remote.html.
        The current implementation is read-only and does not support edge
        features. The IDs of the nodes are based on the internal IDs (i.e., node
        offsets). For the remote node IDs to be consistent with the positions in
        the output tensors, please ensure that no deletion has been performed
        on the node tables.

        The remote backend can also be plugged into the data loader of
        torch_geometric, which is useful for mini-batch training. For example:

        ```python
            loader_lbug = NeighborLoader(
                data=(feature_store, graph_store),
                num_neighbors={('paper', 'cites', 'paper'): [12, 12, 12]},
                batch_size=LOADER_BATCH_SIZE,
                input_nodes=('paper', input_nodes),
                num_workers=4,
                filter_per_worker=False,
            )
        ```

        Please note that the database instance is not fork-safe, so if more than
        one worker is used, `filter_per_worker` must be set to False.

        Parameters
        ----------
        num_threads : int
            Number of threads to use for data loading. Default to None, which
            means using the number of CPU cores.

        Returns
        -------
        feature_store : LbugFeatureStore
            Feature store compatible with torch_geometric.
        graph_store : LbugGraphStore
            Graph store compatible with torch_geometric.
        """
        self.check_for_database_close()
        from .torch_geometric_feature_store import LbugFeatureStore
        from .torch_geometric_graph_store import LbugGraphStore

        return (
            LbugFeatureStore(self, num_threads),
            LbugGraphStore(self, num_threads),
        )

    def _scan_node_table(
        self,
        table_name: str,
        prop_name: str,
        prop_type: str,
        dim: int,
        indices: IndexType,
        num_threads: int,
    ) -> NDArray[Any]:
        self.check_for_database_close()
        import numpy as np

        """
        Scan a node table from storage directly, bypassing query engine.
        Used internally by torch_geometric remote backend only.
        """
        self.init_database()
        indices_cast = np.array(indices, dtype=np.uint64)
        result = None

        if prop_type == Type.INT64.value:
            result = np.empty(len(indices) * dim, dtype=np.int64)
            self._database.scan_node_table_as_int64(
                table_name, prop_name, indices_cast, result, num_threads
            )
        elif prop_type == Type.INT32.value:
            result = np.empty(len(indices) * dim, dtype=np.int32)
            self._database.scan_node_table_as_int32(
                table_name, prop_name, indices_cast, result, num_threads
            )
        elif prop_type == Type.INT16.value:
            result = np.empty(len(indices) * dim, dtype=np.int16)
            self._database.scan_node_table_as_int16(
                table_name, prop_name, indices_cast, result, num_threads
            )
        elif prop_type == Type.DOUBLE.value:
            result = np.empty(len(indices) * dim, dtype=np.float64)
            self._database.scan_node_table_as_double(
                table_name, prop_name, indices_cast, result, num_threads
            )
        elif prop_type == Type.FLOAT.value:
            result = np.empty(len(indices) * dim, dtype=np.float32)
            self._database.scan_node_table_as_float(
                table_name, prop_name, indices_cast, result, num_threads
            )

        if result is not None:
            return result

        msg = f"Unsupported property type: {prop_type}"
        raise ValueError(msg)

    def _register_connection(self, connection: Connection) -> None:
        self._connections.add(connection)

    def _unregister_connection(self, connection: Connection) -> None:
        self._connections.discard(connection)

    def close(self) -> None:
        """
        Close the database. Once the database is closed, the lock on the database
        files is released and the database can be opened in another process.

        Note: Call to this method is not required. The Python garbage collector
        will automatically close the database when no references to the database
        object exist. It is recommended not to call this method explicitly. If you
        decide to manually close the database, make sure that all the QueryResult
        and Connection objects are closed before calling this method.
        """
        if self.is_closed:
            return
        self.is_closed = True

        if self._database is not None:
            self._database.close()
            self._database: Any = None  # (type: _lbug.Database from pybind11)

        if self._pybind_database is not None:
            self._pybind_database.close()
            self._pybind_database = None

    def check_for_database_close(self) -> None:
        """
        Check if the database is closed and raise an exception if it is.

        Raises
        ------
        Exception
            If the database is closed.

        """
        if not self.is_closed:
            return
        msg = "Database is closed"
        raise RuntimeError(msg)
