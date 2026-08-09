from enum import Enum


class Type(Enum):
    """The type of a value in the database."""

    ANY = "ANY"
    NODE = "NODE"
    REL = "REL"
    RECURSIVE_REL = "RECURSIVE_REL"
    SERIAL = "SERIAL"
    BOOL = "BOOL"
    INT64 = "INT64"
    INT32 = "INT32"
    INT16 = "INT16"
    INT8 = "INT8"
    UINT64 = "UINT64"
    UINT32 = "UINT32"
    UINT16 = "UINT16"
    UINT8 = "UINT8"
    INT128 = "INT128"
    DOUBLE = "DOUBLE"
    FLOAT = "FLOAT"
    DATE = "DATE"
    TIMESTAMP = "TIMESTAMP"
    TIMSTAMP_TZ = "TIMESTAMP_TZ"
    TIMESTAMP_NS = "TIMESTAMP_NS"
    TIMESTAMP_MS = "TIMESTAMP_MS"
    TIMESTAMP_SEC = "TIMESTAMP_SEC"
    INTERVAL = "INTERVAL"
    INTERNAL_ID = "INTERNAL_ID"
    STRING = "STRING"
    BLOB = "BLOB"
    UUID = "UUID"
    LIST = "LIST"
    ARRAY = "ARRAY"
    STRUCT = "STRUCT"
    MAP = "MAP"
    UNION = "UNION"


class ArrowRelTableLayout(Enum):
    """Arrow-backed relationship table layout."""

    FLAT = "FLAT"
    CSR = "CSR"
