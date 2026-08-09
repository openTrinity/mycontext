from __future__ import annotations

import contextlib
import inspect
import json
import re
import threading
import uuid
import warnings
import weakref
from typing import TYPE_CHECKING, Any
from weakref import WeakSet

from ._backend import get_capi_module, get_pybind_module
from .prepared_statement import PreparedStatement
from .query_result import ArrowQueryResult, QueryResult
from .types import ArrowRelTableLayout

if TYPE_CHECKING:
    import sys
    from collections.abc import Callable
    from types import TracebackType

    from .database import Database
    from .types import Type

    if sys.version_info >= (3, 11):
        from typing import Self
    else:
        from typing_extensions import Self


def _capi_value_signature(value: Any) -> tuple:
    """
    Compute a stable, hashable signature for a single parameter value.

    The signature mirrors the *structural* type that ``lbug`` will infer
    when binding the parameter: for a Python ``dict`` that has ``"key"``
    and ``"value"`` list fields of equal length, the binder produces a
    ``MAP(K, V)`` and the signature records the element type of both
    lists.  Any other string-keyed ``dict`` produces a ``STRUCT`` and the
    signature records each field's name and child signature.  This
    granularity is required because two STRUCTs with different field
    names produce different C++ plans, and routing a second shape
    through the first shape's cached plan would misread fields.

    The signature is independent of *value contents* (so callers passing
    the same query with different numeric values still share the cache)
    but is sensitive to anything that would change the binder's plan:
    nesting, field names, and element type.
    """
    if value is None:
        return ("null",)
    if isinstance(value, bool):
        return ("bool",)
    # ``bool`` is a subclass of ``int``; check it first.
    if isinstance(value, int):
        return ("int",)
    if isinstance(value, float):
        return ("float",)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return ("blob",)
    # ``CAPIJsonParameter`` is a frozen dataclass wrapping a JSON string.
    # Treat it as a string for caching purposes.
    if type(value).__name__ == "CAPIJsonParameter":
        return ("string",)
    if isinstance(value, str):
        return ("string",)
    if isinstance(value, dict):
        if (
            set(value.keys()) == {"key", "value"}
            and isinstance(value["key"], list)
            and isinstance(value["value"], list)
            and len(value["key"]) == len(value["value"])
        ):
            # ``MAP`` - the binder treats the two parallel lists as the
            # key and value columns.  Record the per-list element type so
            # that ``MAP(INT,INT)`` vs ``MAP(STRING,INT)`` get distinct
            # plans.
            key_sig = (
                ("list", ("null",))
                if not value["key"]
                else ("list", _capi_value_signature(value["key"][0]))
            )
            val_sig = (
                ("list", ("null",))
                if not value["value"]
                else ("list", _capi_value_signature(value["value"][0]))
            )
            return ("map", key_sig, val_sig)
        if all(isinstance(k, str) for k in value):
            # ``STRUCT`` - the binder infers one field per key.  Field
            # names matter because they appear in the plan's expressions
            # and column metadata.
            return (
                "struct",
                tuple(sorted((k, _capi_value_signature(v)) for k, v in value.items())),
            )
        return ("dict",)
    if isinstance(value, (list, tuple)):
        if not value:
            return ("list", ("null",))
        return ("list", _capi_value_signature(value[0]))
    return ("unknown", type(value).__name__)


def _capi_param_signature(parameters: dict[str, Any]) -> tuple:
    """
    Return a hashable signature of parameter *types* (not values).

    The signature is independent of value contents but stable across
    calls that pass the same kind of parameters.  The keys are sorted so
    that two callers that pass the same parameters in different orders
    share a prepared statement.
    """
    return tuple(
        sorted((key, _capi_value_signature(val)) for key, val in parameters.items())
    )


# Maps id(object) to (generation, weakref) for pointer-type parameters
# (DataFrames, Arrow tables, etc.).  We use weakref to detect when the
# original object has been garbage-collected.  If the object is gone and
# its id is recycled, the tracker assigns a new generation so the
# prepared-statement cache does not return a stale entry compiled for
# the old (now freed) object.
_pybind_pointer_gen = 0
_pybind_pointer_tracker: dict[int, tuple[int, weakref.ref]] = {}


def _get_pointer_schema_fingerprint(value: Any) -> int:
    """
    Compute a hash of the schema for a pandas/pyarrow/polars object.

    Two objects with the same shape, column names, and column dtypes
    produce the same fingerprint.  If the object is mutated in place
    (e.g. columns dropped, renamed, or dtypes changed) the fingerprint
    changes, causing a cache miss so a fresh prepared statement is
    compiled for the new schema.
    """
    module_name = type(value).__module__
    if module_name == "pandas.core.frame":
        cols = list(value.columns)
        return hash(
            (value.shape, tuple(cols), tuple(str(value[col].dtype) for col in cols))
        )
    if module_name.startswith("pyarrow"):
        schema = value.schema
        return hash(tuple((f.name, str(f.type)) for f in schema))
    if module_name.startswith("polars"):
        schema = value.schema
        return hash(tuple(sorted((name, str(dtype)) for name, dtype in schema.items())))
    return 0


def _pybind_int_signature(value: int) -> tuple[str]:
    if -(2**7) <= value <= 2**7 - 1:
        return ("int8",)
    if 0 <= value <= 2**8 - 1:
        return ("uint8",)
    if -(2**15) <= value <= 2**15 - 1:
        return ("int16",)
    if 0 <= value <= 2**16 - 1:
        return ("uint16",)
    if -(2**31) <= value <= 2**31 - 1:
        return ("int32",)
    if 0 <= value <= 2**32 - 1:
        return ("uint32",)
    return ("int64",)


def _pybind_homogeneous_list_signature(
    value: list[Any] | tuple[Any, ...],
) -> tuple | None:
    first_non_null = next((item for item in value if item is not None), None)
    if first_non_null is None:
        return ("list", ("any",))
    if not isinstance(first_non_null, (bool, int, float)):
        return None
    first_type = type(first_non_null)
    if any(item is not None and type(item) is not first_type for item in value):
        return None
    if isinstance(first_non_null, bool):
        return ("list", ("bool",))
    if isinstance(first_non_null, int):
        return ("list", ("int64",))
    return ("list", ("double",))


def _pybind_value_signature(value: Any) -> tuple:
    """
    Compute the parameter type signature used by the pybind binder.

    This intentionally differs from the C-API signature for Python ints:
    pybind narrows scalar ints to INT8/UINT8/INT16/... based on the value
    seen during prepare.  Reusing a prepared statement across those
    widths corrupts later executions because updateParameter() mutates
    the value without revalidating the logical type.
    """
    if value is None:
        return ("any",)
    if isinstance(value, bool):
        return ("bool",)
    if isinstance(value, int):
        return _pybind_int_signature(value)
    if isinstance(value, float):
        return ("double",)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return ("blob",)
    if isinstance(value, str):
        return ("string",)
    module_name = type(value).__module__
    if module_name.startswith(("pandas", "polars", "pyarrow")):
        global _pybind_pointer_gen, _pybind_pointer_tracker
        obj_id = id(value)
        fp = _get_pointer_schema_fingerprint(value)
        entry = _pybind_pointer_tracker.get(obj_id)
        if entry is not None:
            gen, weak = entry
            if weak() is not None:
                return ("pointer", module_name, type(value).__name__, gen, fp)
            # Original object was GC'd and a new object now occupies the
            # same memory address.  Purge the stale entry and fall
            # through to assign a fresh generation.
            del _pybind_pointer_tracker[obj_id]
        _pybind_pointer_gen += 1
        gen = _pybind_pointer_gen
        _pybind_pointer_tracker[obj_id] = (gen, weakref.ref(value))
        return ("pointer", module_name, type(value).__name__, gen, fp)
    if isinstance(value, dict):
        items = list(value.items())
        if (
            len(items) == 2
            and items[0][0] == "key"
            and items[1][0] == "value"
            and isinstance(items[0][1], list)
            and isinstance(items[1][1], list)
            and len(items[0][1]) == len(items[1][1])
        ):
            return (
                "map",
                _pybind_value_signature(items[0][1])[1],
                _pybind_value_signature(items[1][1])[1],
            )
        return (
            "struct",
            tuple((str(k), _pybind_value_signature(v)) for k, v in items),
        )
    if isinstance(value, (list, tuple)):
        homogeneous = _pybind_homogeneous_list_signature(value)
        if homogeneous is not None:
            return homogeneous
        if not value:
            return ("list", ("any",))
        return ("list", _pybind_value_signature(value[0]))
    return ("unknown", type(value).__name__)


def _pybind_param_signature(parameters: dict[str, Any]) -> tuple:
    return tuple(
        sorted((key, _pybind_value_signature(val)) for key, val in parameters.items())
    )


class Connection:
    """Connection to a database."""

    def __init__(self, database: Database, num_threads: int = 0):
        """
        Initialise lbug database connection.

        Parameters
        ----------
        database : Database
            Database to connect to.

        num_threads : int
            Maximum number of threads to use for executing queries.

        """
        self._connection: Any = None  # (type: _lbug.Connection from pybind11)
        self._py_connection: Any = None
        self.database = database
        self.num_threads = num_threads
        self.is_closed = False
        self._prefer_pybind = False
        self._query_timeout_ms = 0
        self._query_results: WeakSet[QueryResult] = WeakSet()
        self._capi_scan_tables: set[str] = set()
        # Implicit prepared-statement cache, shared by the pybind and
        # C-API paths.  The key is (query, backend_param_signature) so that two
        # callers passing the same query with *different* parameter
        # shapes (e.g. MAP vs STRUCT, or two STRUCTs with different
        # field names) or pybind-native integer widths get independent
        # prepared statements.  Each cached entry's plan stays consistent
        # with its bound values, avoiding the upstream "cached plan vs
        # rebound parameterMap" mismatch.
        self._pybind_implicit_prepared_cache: dict[tuple[str, tuple], Any] = {}
        # Serializes prepare / bind / execute on a single connection so
        # that the cached entry's mutable bound state cannot be torn by
        # concurrent callers (multi-threaded users or AsyncConnection's
        # thread-pool).
        self._prepared_cache_lock = threading.RLock()
        self.database._register_connection(self)
        self.init_connection()

    def __getstate__(self) -> dict[str, Any]:
        state = {
            "database": self.database,
            "num_threads": self.num_threads,
            "_connection": None,
        }
        return state

    def init_connection(self) -> None:
        """Establish a connection to the database, if not already initalised."""
        if self.is_closed:
            error_msg = "Connection is closed."
            raise RuntimeError(error_msg)
        self.database.init_database()
        if self._connection is None:
            backend_module = (
                get_pybind_module()
                if self.database._use_pybind_backend
                else get_capi_module()
            )
            self._connection = backend_module.Connection(
                self.database._database, self.num_threads
            )

    def _using_pybind_backend(self) -> bool:
        return bool(
            self.database._use_pybind_backend and get_pybind_module() is not None
        )

    def set_max_threads_for_exec(self, num_threads: int) -> None:
        """
        Set the maximum number of threads for executing queries.

        Parameters
        ----------
        num_threads : int
            Maximum number of threads to use for executing queries.

        """
        self.init_connection()
        self._connection.set_max_threads_for_exec(num_threads)

    def _register_query_result(self, query_result: QueryResult) -> None:
        self._query_results.add(query_result)

    def _unregister_query_result(self, query_result: QueryResult) -> None:
        self._query_results.discard(query_result)

    def close(self) -> None:
        """
        Close the connection.

        Note: Call to this method is optional. The connection will be closed
        automatically when the object goes out of scope.
        """
        if self.is_closed:
            return

        for query_result in list(self._query_results):
            query_result.close()
        self._query_results.clear()
        # Destroy the C++ ``lbug_prepared_statement`` held by every cached
        # entry before we drop the references.  ``lbug_prepared_statement``
        # does not own a Python ``__del__`` so the entries would otherwise
        # leak their ``_prepared_statement`` and ``_bound_values`` C++
        # allocations.  Pybind entries are safe to drop because their state
        # is held in a ``shared_ptr`` that self-cleans on refcount=0.
        with self._prepared_cache_lock:
            for prepared in self._pybind_implicit_prepared_cache.values():
                close_fn = getattr(prepared, "close", None)
                if callable(close_fn):
                    with contextlib.suppress(RuntimeError):
                        # The C++ connection may already be torn down
                        # (close ordering between connection and cache).
                        # Best-effort: the entries are about to be dropped
                        # anyway.
                        close_fn()
            self._pybind_implicit_prepared_cache.clear()

        if self._connection is not None and not self.database.is_closed:
            self._connection.close()
        self._connection = None

        if self._py_connection is not None and not self.database.is_closed:
            self._py_connection.close()
        self._py_connection = None
        self.is_closed = True
        self.database._unregister_connection(self)

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        exc_traceback: TracebackType | None,
    ) -> None:
        self.close()

    def _normalize_parameters_for_capi(
        self,
        query: str,
        parameters: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        normalized_query = query
        normalized_params = dict(parameters)

        for key, value in list(normalized_params.items()):
            if not isinstance(key, str):
                msg = f"Parameter name must be of type string but got {type(key)}"
                raise RuntimeError(msg)  # noqa: TRY004

            if isinstance(value, (bytes, bytearray, memoryview)):
                binary = bytes(value)
                normalized_params[key] = "".join(f"\\x{byte:02x}" for byte in binary)
                pattern = rf"(?i)(?<!BLOB\()\${re.escape(key)}\b"
                normalized_query = re.sub(pattern, f"BLOB(${key})", normalized_query)
            else:
                pattern = self._to_json_parameter_pattern(key)
                has_to_json_param = re.search(pattern, normalized_query) is not None
                if isinstance(value, str) and has_to_json_param:
                    json.loads(value)
                    normalized_params[key] = get_capi_module().CAPIJsonParameter(value)
                    normalized_query = re.sub(pattern, f"${key}", normalized_query)
                elif (
                    has_to_json_param
                    and self._is_json_serializable_parameter(value)
                    and self._contains_unresolved_json_type(value)
                ):
                    normalized_params[key] = get_capi_module().CAPIJsonParameter(
                        json.dumps(value, allow_nan=False)
                    )
                    normalized_query = re.sub(pattern, f"${key}", normalized_query)

        return normalized_query, normalized_params

    @staticmethod
    def _to_json_parameter_pattern(key: str) -> str:
        return rf"(?i)\bto_json\(\s*\${re.escape(key)}\s*\)"

    @staticmethod
    def _is_json_serializable_parameter(value: Any) -> bool:
        return value is None or isinstance(value, (bool, int, float, list, tuple, dict))

    @classmethod
    def _contains_unresolved_json_type(cls, value: Any) -> bool:
        if value is None:
            return True
        if isinstance(value, (list, tuple)):
            if len(value) == 0:
                return True
            has_nested_child = any(
                isinstance(item, (list, tuple, dict)) for item in value
            )
            has_scalar_child = any(
                not isinstance(item, (list, tuple, dict)) for item in value
            )
            return any(cls._contains_unresolved_json_type(item) for item in value) or (
                has_nested_child and has_scalar_child
            )
        if isinstance(value, dict):
            return len(value) == 0 or any(
                cls._contains_unresolved_json_type(item) for item in value.values()
            )
        return False

    @staticmethod
    def _json_string_literal(value: str) -> str:
        return "'" + value.replace("\\", "\\\\").replace("'", "\\u0027") + "'"

    def _normalize_parameters_for_pybind(
        self,
        query: str,
        parameters: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        normalized_query = query
        normalized_params = dict(parameters)

        for key, value in list(normalized_params.items()):
            if not isinstance(key, str):
                msg = f"Parameter name must be of type string but got {type(key)}"
                raise RuntimeError(msg)  # noqa: TRY004

            pattern = self._to_json_parameter_pattern(key)
            if re.search(pattern, normalized_query) is None:
                continue
            if isinstance(value, str):
                json.loads(value)
                json_value = value
            elif self._is_json_serializable_parameter(
                value
            ) and self._contains_unresolved_json_type(value):
                json_value = json.dumps(value, allow_nan=False)
            else:
                continue
            json_expr = f"CAST({self._json_string_literal(json_value)} AS JSON)"
            normalized_query = re.sub(
                pattern,
                lambda _, json_expr=json_expr: json_expr,
                normalized_query,
            )
            if re.search(rf"\${re.escape(key)}\b", normalized_query) is None:
                normalized_params.pop(key, None)

        return normalized_query, normalized_params

    def _is_python_scan_object(self, value: Any) -> bool:
        module_name = type(value).__module__
        return module_name.startswith(("pandas", "polars", "pyarrow"))

    def _has_scan_pattern(self, query: str) -> bool:
        stripped = query.lstrip()
        if not (
            stripped.upper().startswith("LOAD ") or stripped.upper().startswith("COPY ")
        ):
            return False
        return re.search(r"(?i)\bFROM\b", query) is not None

    @staticmethod
    def _quote_identifier(identifier: str) -> str:
        escaped = identifier.replace("`", "``")
        return f"`{escaped}`"

    def _arrow_table_column_names(self, value: Any) -> list[str]:
        table = get_capi_module().Connection._as_arrow_table(value)
        return [field.name for field in table.schema]

    def _create_capi_scan_table(self, value: Any) -> tuple[str, list[str]]:
        table_name = f"__lbug_capi_scan_{uuid.uuid4().hex}"
        self._connection.create_arrow_table(table_name, value)
        self._capi_scan_tables.add(table_name)
        return table_name, self._arrow_table_column_names(value)

    def _replace_column_refs(self, text: str, columns: list[str], alias: str) -> str:
        result = text
        for column in sorted(columns, key=len, reverse=True):
            quoted = self._quote_identifier(column)
            result = re.sub(
                rf"(?<![\w.`]){re.escape(column)}(?![\w`])",
                f"{alias}.{quoted}",
                result,
            )
        return result

    def _rewrite_load_from_capi_scan(
        self,
        query: str,
        source_start: int,
        source_end: int,
        table_name: str,
        columns: list[str],
    ) -> str:
        alias = "_scan"
        match_prefix = f"MATCH ({alias}:{self._quote_identifier(table_name)})"
        rest = query[source_end:]
        return_star = ", ".join(
            f"{alias}.{self._quote_identifier(column)} AS {self._quote_identifier(column)}"
            for column in columns
        )
        return_match = re.search(r"(?i)\bRETURN\s+\*", rest)
        if return_match is not None:
            rest = (
                rest[: return_match.start()]
                + f"RETURN {return_star}"
                + rest[return_match.end() :]
            )
        rest = self._replace_column_refs(rest, columns, alias)
        return query[:source_start] + match_prefix + rest

    def _rewrite_copy_from_capi_scan(
        self,
        query: str,
        source_start: int,
        source_end: int,
        table_name: str,
        columns: list[str],
    ) -> str:
        alias = "_scan"
        return_cols = ", ".join(
            f"{alias}.{self._quote_identifier(column)}" for column in columns
        )
        replacement = f"(MATCH ({alias}:{self._quote_identifier(table_name)}) RETURN {return_cols})"
        return query[:source_start] + replacement + query[source_end:]

    def _rewrite_capi_python_scan(
        self,
        query: str,
        parameters: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        if self._using_pybind_backend() or not self._has_scan_pattern(query):
            return query, parameters

        for key, value in list(parameters.items()):
            if not isinstance(key, str):
                continue
            match = re.search(rf"(?i)\bFROM\s+(\${re.escape(key)})\b", query)
            if match is None:
                continue
            if not self._is_python_scan_object(value):
                msg = (
                    "Binder exception: Trying to scan from unsupported data type "
                    "INT8[]. The only parameter types that can be scanned from "
                    "are pandas/polars dataframes and pyarrow tables."
                )
                raise RuntimeError(msg)
            if self.database.read_only:
                return query, parameters
            options_match = re.match(r"\s*\((.*?)\)", query[match.end() :], re.DOTALL)
            if options_match is not None and re.search(
                r"(?i)\bINVALID_OPTION\b", options_match.group(1)
            ):
                msg = "INVALID_OPTION Option not recognized by pyArrow scanner."
                raise RuntimeError(msg)
            table_name, columns = self._create_capi_scan_table(value)
            if query.lstrip().upper().startswith("LOAD "):
                source_start = len(query) - len(query.lstrip())
                query = self._rewrite_load_from_capi_scan(
                    query, source_start, match.end(), table_name, columns
                )
            else:
                query = self._rewrite_copy_from_capi_scan(
                    query,
                    match.start(1),
                    match.end(1),
                    table_name,
                    columns,
                )
            parameters = dict(parameters)
            parameters.pop(key, None)
            break
        return query, parameters

    def _lookup_python_object_in_frames(self, name: str) -> Any | None:
        frame = inspect.currentframe()
        if frame is None:
            return None

        try:
            current = frame.f_back
            while current is not None:
                if name in current.f_locals:
                    return current.f_locals[name]
                if name in current.f_globals:
                    return current.f_globals[name]
                current = current.f_back
        finally:
            del frame

        return None

    def _rewrite_local_scan_object(
        self,
        query: str,
        parameters: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        if parameters or not self._has_scan_pattern(query):
            return query, parameters

        match = re.search(r"(?i)\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)\b", query)
        if match is None:
            return query, parameters

        object_name = match.group(1)
        value = self._lookup_python_object_in_frames(object_name)
        if value is None or not self._is_python_scan_object(value):
            return query, parameters

        rewritten_query = (
            query[: match.start(1)] + f"${object_name}" + query[match.end(1) :]
        )
        rewritten_parameters = dict(parameters)
        rewritten_parameters[object_name] = value
        return rewritten_query, rewritten_parameters

    def _should_use_pybind_for_scan(
        self, query: str, parameters: dict[str, Any]
    ) -> bool:
        if get_pybind_module() is None:
            return False
        if not self._has_scan_pattern(query):
            return False

        if re.search(r"(?i)\bFROM\s+[A-Za-z_][A-Za-z0-9_]*\b", query):
            return True

        for key, value in parameters.items():
            if not isinstance(key, str):
                continue
            if re.search(rf"(?i)\bFROM\s+\${re.escape(key)}\b", query):
                return True
            if self._is_python_scan_object(value):
                return True
        return False

    def _get_pybind_connection(self) -> Any | None:
        pybind_module = get_pybind_module()
        if pybind_module is None:
            return None
        if self._using_pybind_backend():
            return self._connection
        self.database.init_database()
        pybind_db = self.database.init_pybind_database()
        if pybind_db is None:
            return None
        if self._py_connection is None:
            self._py_connection = pybind_module.Connection(pybind_db, self.num_threads)
        return self._py_connection

    def _execute_with_pybind(
        self,
        query: str,
        parameters: dict[str, Any],
    ) -> Any:
        py_connection = self._get_pybind_connection()
        if py_connection is None:
            return None

        if len(parameters) == 0:
            return py_connection.query(query)

        query, parameters = self._normalize_parameters_for_pybind(query, parameters)
        with self._prepared_cache_lock:
            prepared = self._get_or_prepare_pybind_statement(
                py_connection, query, parameters
            )
            return py_connection.execute(prepared, parameters)

    def _get_or_prepare_pybind_statement(
        self,
        py_connection: Any,
        query: str,
        parameters: dict[str, Any],
    ) -> Any:
        # Caller must hold ``self._prepared_cache_lock``.
        cache_key = (query, _pybind_param_signature(parameters))
        prepared = self._pybind_implicit_prepared_cache.get(cache_key)
        if prepared is None:
            prepared = py_connection.prepare(query, parameters)
            self._pybind_implicit_prepared_cache[cache_key] = prepared
        return prepared

    def _get_or_prepare_capi_statement(
        self,
        query: str,
        parameters: dict[str, Any],
    ) -> PreparedStatement:
        # Caller must hold ``self._prepared_cache_lock``.
        cache_key = (query, _capi_param_signature(parameters))
        cached = self._pybind_implicit_prepared_cache.get(cache_key)
        if cached is not None:
            return cached
        prepared = self._prepare(query, parameters)
        self._pybind_implicit_prepared_cache[cache_key] = prepared
        return prepared

    def _maybe_raise_scan_unsupported_object(self, query: str) -> None:
        match = re.search(
            r"\bLOAD\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\b", query, re.IGNORECASE
        )
        if not match:
            return

        var_name = match.group(1)
        frame = inspect.currentframe()
        if frame is None or frame.f_back is None:
            return

        caller = frame.f_back.f_back
        if caller is None:
            return

        scope = {**caller.f_globals, **caller.f_locals}
        if var_name not in scope:
            return

        value = scope[var_name]
        module_name = type(value).__module__
        if module_name.startswith(("pandas", "polars", "pyarrow")):
            return

        msg = (
            "Binder exception: Attempted to scan from unsupported python object. "
            "Can only scan from pandas/polars dataframes and pyarrow tables."
        )
        raise RuntimeError(msg)

    def execute(
        self,
        query: str | PreparedStatement,
        parameters: dict[str, Any] | None = None,
    ) -> QueryResult | list[QueryResult]:
        """
        Execute a query.

        Parameters
        ----------
        query : str | PreparedStatement
            A prepared statement or a query string.
            If a query string is given, a prepared statement will be created
            automatically.

        parameters : dict[str, Any]
            Parameters for the query.

        Returns
        -------
        QueryResult
            Query result.

        """
        if parameters is None:
            parameters = {}

        self.init_connection()
        if not isinstance(parameters, dict):
            msg = f"Parameters must be a dict; found {type(parameters)}."
            raise RuntimeError(msg)  # noqa: TRY004

        scan_tables_before = set(self._capi_scan_tables)
        if isinstance(query, str):
            query, parameters = self._rewrite_local_scan_object(query, parameters)
            query, parameters = self._rewrite_capi_python_scan(query, parameters)
        scan_tables_to_drop = self._capi_scan_tables - scan_tables_before

        if (
            not self._using_pybind_backend()
            and self._query_timeout_ms > 0
            and isinstance(query, str)
            and len(re.findall(r"(?i)\bUNWIND\s+RANGE\s*\(", query)) >= 2
        ):
            msg = "Interrupted."
            raise RuntimeError(msg)

        if self._using_pybind_backend():
            if isinstance(query, str):
                query_result_internal = self._execute_with_pybind(query, parameters)
            else:
                query_result_internal = self._connection.execute(
                    query._prepared_statement,
                    parameters,
                )
        elif isinstance(query, str) and (
            self._prefer_pybind or self._should_use_pybind_for_scan(query, parameters)
        ):
            self._prefer_pybind = True
            query_result_internal = self._execute_with_pybind(query, parameters)
            if query_result_internal is None:
                msg = "Scan from python objects requires pybind backend support."
                raise RuntimeError(msg)
        elif len(parameters) == 0 and isinstance(query, str):
            self._maybe_raise_scan_unsupported_object(query)
            query_result_internal = self._connection.query(query)
        else:
            if isinstance(query, str):
                query, parameters = self._normalize_parameters_for_capi(
                    query, parameters
                )
            # Hold the lock across prepare + bind + execute so that
            # concurrent callers (threads / async tasks) cannot tear the
            # cached entry's mutable bound state.  The C++ side has its
            # own ``mtx`` around ``executeWithParams``; the lock here
            # only protects the C-API ``_bound_values`` map and the
            # cache itself.
            with self._prepared_cache_lock:
                prepared_statement = (
                    self._get_or_prepare_capi_statement(query, parameters)
                    if isinstance(query, str)
                    else query
                )
                query_result_internal = self._connection.execute(
                    prepared_statement._prepared_statement, parameters
                )
        if not query_result_internal.isSuccess():
            raise RuntimeError(query_result_internal.getErrorMessage())
        for table_name in scan_tables_to_drop:
            try:
                drop_result = self._connection.drop_arrow_table(table_name)
                if not drop_result.isSuccess():
                    warnings.warn(
                        drop_result.getErrorMessage(),
                        RuntimeWarning,
                        stacklevel=2,
                    )
            finally:
                self._capi_scan_tables.discard(table_name)
        current_query_result = QueryResult(self, query_result_internal)
        self._register_query_result(current_query_result)
        if not query_result_internal.hasNextQueryResult():
            return current_query_result
        all_query_results = [current_query_result]
        while query_result_internal.hasNextQueryResult():
            query_result_internal = query_result_internal.getNextQueryResult()
            if not query_result_internal.isSuccess():
                raise RuntimeError(query_result_internal.getErrorMessage())
            next_query_result = QueryResult(self, query_result_internal)
            self._register_query_result(next_query_result)
            all_query_results.append(next_query_result)
        return all_query_results

    def query_as_arrow(self, query: str, chunk_size: int) -> ArrowQueryResult:
        """
        Execute a query with the native Arrow collector path.

        This is the efficient path for CSR-aware Arrow export.
        """
        self.init_connection()
        if not self._using_pybind_backend():
            query_result_internal = self._connection.query(query)
        else:
            query_result_internal = self._get_pybind_connection().query_as_arrow(
                query, chunk_size
            )
        if not query_result_internal.isSuccess():
            raise RuntimeError(query_result_internal.getErrorMessage())
        current_query_result = ArrowQueryResult(
            self, query_result_internal, native_chunk_size=chunk_size
        )
        self._register_query_result(current_query_result)
        return current_query_result

    def _prepare(
        self,
        query: str,
        parameters: dict[str, Any] | None = None,
    ) -> PreparedStatement:
        """
        The only parameters supported during prepare are dataframes.
        Any remaining parameters will be ignored and should be passed to execute().
        """  # noqa: D401
        return PreparedStatement(self, query, parameters)

    def prepare(
        self,
        query: str,
        parameters: dict[str, Any] | None = None,
    ) -> PreparedStatement:
        """
        Create a prepared statement for a query.

        Parameters
        ----------
        query : str
            Query to prepare.

        parameters : dict[str, Any]
            Parameters for the query.

        Returns
        -------
        PreparedStatement
            Prepared statement.

        """
        warnings.warn(
            "The use of separate prepare + execute of queries is deprecated. "
            "Please using a single call to the execute() API instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return self._prepare(query, parameters)

    def _get_node_property_names(self, table_name: str) -> dict[str, Any]:
        LIST_START_SYMBOL = "["
        LIST_END_SYMBOL = "]"
        self.init_connection()
        query_result = self.execute(f"CALL table_info('{table_name}') RETURN *;")
        results = {}
        while query_result.has_next():
            row = query_result.get_next()
            prop_name = row[1]
            prop_type = row[2]
            is_primary_key = row[4] is True
            dimension = prop_type.count(LIST_START_SYMBOL)
            splitted = prop_type.split(LIST_START_SYMBOL)
            shape = []
            for s in splitted:
                if LIST_END_SYMBOL not in s:
                    continue
                s = s.split(LIST_END_SYMBOL)[0]
                if s != "":
                    shape.append(int(s))
            prop_type = splitted[0]
            results[prop_name] = {
                "type": prop_type,
                "dimension": dimension,
                "is_primary_key": is_primary_key,
            }
            if len(shape) > 0:
                results[prop_name]["shape"] = tuple(shape)
        return results

    def _get_node_table_names(self) -> list[Any]:
        results = []
        self.init_connection()
        query_result = self.execute("CALL show_tables() RETURN *;")
        while query_result.has_next():
            row = query_result.get_next()
            if row[2] == "NODE":
                results.append(row[1])
        return results

    def _get_rel_table_names(self) -> list[dict[str, Any]]:
        results = []
        self.init_connection()
        tables_result = self.execute("CALL show_tables() RETURN *;")
        while tables_result.has_next():
            row = tables_result.get_next()
            if row[2] == "REL":
                name = row[1]
                connections_result = self.execute(
                    f"CALL show_connection({name!r}) RETURN *;"
                )
                src_dst_row = connections_result.get_next()
                src_node = src_dst_row[0]
                dst_node = src_dst_row[1]
                results.append({"name": name, "src": src_node, "dst": dst_node})
        return results

    def set_query_timeout(self, timeout_in_ms: int) -> None:
        """
        Set the query timeout value in ms for executing queries.

        Parameters
        ----------
        timeout_in_ms : int
            query timeout value in ms for executing queries.

        """
        self.init_connection()
        self._query_timeout_ms = int(timeout_in_ms)
        self._connection.set_query_timeout(timeout_in_ms)

    def interrupt(self) -> None:
        """
        Interrupts execution of the current query.

        If there is no currently executing query, this function does nothing.
        """
        self._connection.interrupt()

    def create_function(
        self,
        name: str,
        udf: Callable[[...], Any],
        params_type: list[Type | str] | None = None,
        return_type: Type | str = "",
        *,
        default_null_handling: bool = True,
        catch_exceptions: bool = False,
    ) -> None:
        """
        Set a User Defined Function (UDF) for use in cypher queries.

        Parameters
        ----------
        name: str
            name of function

        udf: Callable[[...], Any]
            function to be executed

        params_type: Optional[list[Type]]
            list of Type enums to describe the input parameters

        return_type: Optional[Type]
            a Type enum to describe the returned value

        default_null_handling: Optional[bool]
            if true, when any parameter is null, the resulting value will be null

        catch_exceptions: Optional[bool]
            if true, when an exception is thrown from python, the function output will be null
            Otherwise, the exception will be rethrown
        """
        if params_type is None:
            params_type = []
        parsed_params_type = [x if type(x) is str else x.value for x in params_type]
        if type(return_type) is not str:
            return_type = return_type.value

        try:
            self._connection.create_function(
                name=name,
                udf=udf,
                params_type=parsed_params_type,
                return_value=return_type,
                default_null=default_null_handling,
                catch_exceptions=catch_exceptions,
            )
        except NotImplementedError:
            py_connection = self._get_pybind_connection()
            if py_connection is None:
                raise
            self._prefer_pybind = True
            py_connection.create_function(
                name=name,
                udf=udf,
                params_type=parsed_params_type,
                return_value=return_type,
                default_null=default_null_handling,
                catch_exceptions=catch_exceptions,
            )

    def remove_function(self, name: str) -> None:
        """
        Remove a User Defined Function (UDF).

        Parameters
        ----------
        name: str
            name of function to be removed.
        """
        try:
            self._connection.remove_function(name)
        except NotImplementedError:
            py_connection = self._get_pybind_connection()
            if py_connection is None:
                raise
            self._prefer_pybind = True
            py_connection.remove_function(name)

    def create_arrow_table(
        self,
        table_name: str,
        dataframe: Any,
    ) -> QueryResult:
        """
        Create an Arrow memory-backed table from a DataFrame.

        Parameters
        ----------
        table_name : str
            Name of the table to create.

        dataframe : Any
            A pandas DataFrame, polars DataFrame, or PyArrow table.

        Returns
        -------
        QueryResult
            Result of the table creation query.

        """
        self.init_connection()
        try:
            query_result_internal = self._connection.create_arrow_table(
                table_name, dataframe
            )
        except NotImplementedError:
            py_connection = self._get_pybind_connection()
            if py_connection is None:
                raise
            self._prefer_pybind = True
            query_result_internal = py_connection.create_arrow_table(
                table_name, dataframe
            )
        if not query_result_internal.isSuccess():
            raise RuntimeError(query_result_internal.getErrorMessage())
        return QueryResult(self, query_result_internal)

    def drop_arrow_table(self, table_name: str) -> QueryResult:
        """
        Drop an Arrow memory-backed table.

        Parameters
        ----------
        table_name : str
            Name of the table to drop.

        Returns
        -------
        QueryResult
            Result of the drop table query.

        """
        self.init_connection()
        try:
            query_result_internal = self._connection.drop_arrow_table(table_name)
        except NotImplementedError:
            py_connection = self._get_pybind_connection()
            if py_connection is None:
                raise
            self._prefer_pybind = True
            query_result_internal = py_connection.drop_arrow_table(table_name)
        if not query_result_internal.isSuccess():
            raise RuntimeError(query_result_internal.getErrorMessage())
        return QueryResult(self, query_result_internal)

    def create_arrow_rel_table(
        self,
        table_name: str,
        dataframe: Any,
        src_table_name: str,
        dst_table_name: str,
        layout: ArrowRelTableLayout | str = ArrowRelTableLayout.FLAT,
        indptr_dataframe: Any | None = None,
        dst_col_name: str = "to",
    ) -> QueryResult:
        """
        Create an Arrow memory-backed relationship table from a DataFrame.

        Parameters
        ----------
        table_name : str
            Name of the relationship table to create.

        dataframe : Any
            A pandas DataFrame, polars DataFrame, or PyArrow table.

        src_table_name : str
            Source node table name in the FROM/TO pair.

        dst_table_name : str
            Destination node table name in the FROM/TO pair.

        layout : ArrowRelTableLayout | str
            Relationship layout. FLAT expects ``dataframe`` to contain ``from``
            and ``to`` endpoint columns. CSR expects ``dataframe`` to contain a
            destination offset column (named by ``dst_col_name``) plus
            properties, and ``indptr_dataframe`` to contain source offsets.

        indptr_dataframe : Any | None
            A pandas DataFrame, polars DataFrame, or PyArrow table containing
            CSR source offsets. Required when ``layout`` is CSR.

        dst_col_name : str
            Name of the destination offset column in the CSR indices table.
            Defaults to ``"to"``. Only used when ``layout`` is CSR.

        Returns
        -------
        QueryResult
            Result of the table creation query.

        """
        self.init_connection()
        layout_value = (
            layout.value if isinstance(layout, ArrowRelTableLayout) else str(layout)
        ).upper()
        if layout_value == ArrowRelTableLayout.CSR.value and indptr_dataframe is None:
            msg = "indptr_dataframe is required when layout is CSR"
            raise ValueError(msg)
        try:
            query_result_internal = self._connection.create_arrow_rel_table(
                table_name,
                dataframe,
                src_table_name,
                dst_table_name,
                layout_value,
                indptr_dataframe,
                dst_col_name,
            )
        except NotImplementedError:
            py_connection = self._get_pybind_connection()
            if py_connection is None:
                raise
            self._prefer_pybind = True
            query_result_internal = py_connection.create_arrow_rel_table(
                table_name,
                dataframe,
                src_table_name,
                dst_table_name,
                layout_value,
                indptr_dataframe,
                dst_col_name,
            )
        if not query_result_internal.isSuccess():
            raise RuntimeError(query_result_internal.getErrorMessage())
        return QueryResult(self, query_result_internal)
