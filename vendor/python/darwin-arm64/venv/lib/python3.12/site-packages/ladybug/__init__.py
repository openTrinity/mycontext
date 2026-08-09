# ruff: noqa
"""
# Lbug Python API bindings.

This package provides a Python API for Lbug graph database management system.

To install the package, run:
```
python3 -m pip install ladybug
```

Example usage:
```python
import ladybug as lb

db = lb.Database("./test")
conn = lb.Connection(db)

# Define the schema
conn.execute("CREATE NODE TABLE User(name STRING, age INT64, PRIMARY KEY (name))")
conn.execute("CREATE NODE TABLE City(name STRING, population INT64, PRIMARY KEY (name))")
conn.execute("CREATE REL TABLE Follows(FROM User TO User, since INT64)")
conn.execute("CREATE REL TABLE LivesIn(FROM User TO City)")

# Load some data
conn.execute('COPY User FROM "user.csv"')
conn.execute('COPY City FROM "city.csv"')
conn.execute('COPY Follows FROM "follows.csv"')
conn.execute('COPY LivesIn FROM "lives-in.csv"')

# Query the data
results = conn.execute("MATCH (u:User) RETURN u.name, u.age;")
while results.has_next():
    print(results.get_next())
```

The dataset used in this example can be found [here](https://github.com/LadybugDB/ladybug/tree/master/dataset/demo-db/csv).

"""

from __future__ import annotations

from pathlib import Path

# In local dev/test runs the optional pybind extension is built under build/ladybug
# while the package sources live in src_py. Extend the package path so
# `from . import _lbug` can discover the built extension without installation.
_pkg_dir = Path(__file__).resolve().parent
_repo_build_pkg_dir = _pkg_dir.parent / "build" / "ladybug"
if _repo_build_pkg_dir.is_dir():
    __path__.append(str(_repo_build_pkg_dir))

from ._backend import get_capi_module, get_pybind_module  # noqa: E402

from .async_connection import AsyncConnection  # noqa: E402
from .connection import Connection  # noqa: E402
from .database import Database  # noqa: E402
from .prepared_statement import PreparedStatement  # noqa: E402
from .query_result import ArrowQueryResult, CSRResult, QueryResult  # noqa: E402
from .types import ArrowRelTableLayout, Type  # noqa: E402

_VERSION_INFO: tuple[str, int] | None = None


def _get_version_info() -> tuple[str, int]:
    global _VERSION_INFO
    if _VERSION_INFO is None:
        _VERSION_INFO = (Database.get_version(), Database.get_storage_version())
    return _VERSION_INFO


def __getattr__(name: str) -> str | int:
    if name == "version" or name == "__version__":
        return _get_version_info()[0]
    if name == "storage_version":
        return _get_version_info()[1]
    msg = f"module {__name__!r} has no attribute {name!r}"
    raise AttributeError(msg)


__all__ = [
    "AsyncConnection",
    "ArrowQueryResult",
    "ArrowRelTableLayout",
    "Connection",
    "CSRResult",
    "Database",
    "PreparedStatement",
    "QueryResult",
    "Type",
    "__version__",  # noqa: F822
    "storage_version",  # noqa: F822
    "version",  # noqa: F822
]
