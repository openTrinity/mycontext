from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .connection import Connection


class PreparedStatement:
    """
    A prepared statement is a parameterized query which can avoid planning the
    same query for repeated execution.
    """

    def __init__(
        self,
        connection: Connection,
        query: str,
        parameters: dict[str, Any] | None = None,
    ):
        """
        Parameters
        ----------
        connection : Connection
            Connection to a database.
        query : str
            Query to prepare.
        parameters : dict[str, Any]
            Parameters for the query.
        """
        if parameters is None:
            parameters = {}
        self._prepared_statement = connection._connection.prepare(query, parameters)
        self._connection = connection

    def close(self) -> None:
        """
        Release the underlying C-API prepared statement resources.

        The C-API ``PreparedStatement`` (from ``_lbug_capi.py``) holds a
        ``lbug_prepared_statement`` C struct that must be destroyed explicitly;
        it is NOT garbage-collected when the Python wrapper is dropped.
        The pybind variant is managed by ``shared_ptr`` and can be dropped
        without an explicit call.

        ``Connection.close()`` iterates the implicit prepared-statement cache
        and calls this method on every cached entry so that resources are
        freed when the connection is closed.
        """
        close_fn = getattr(self._prepared_statement, "close", None)
        if callable(close_fn):
            close_fn()

    def __del__(self) -> None:
        self.close()

    def is_success(self) -> bool:
        """
        Check if the prepared statement is successfully prepared.

        Returns
        -------
        bool
            True if the prepared statement is successfully prepared.
        """
        return self._prepared_statement.is_success()

    def get_error_message(self) -> str:
        """
        Get the error message if the query is not prepared successfully.

        Returns
        -------
        str
            Error message.
        """
        return self._prepared_statement.get_error_message()
