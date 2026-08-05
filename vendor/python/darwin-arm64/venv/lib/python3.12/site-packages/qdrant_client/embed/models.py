from typing import TypeAlias

from pydantic import StrictFloat, StrictStr

from qdrant_client.http.models import ExtendedPointId, SparseVector


NumericVector: TypeAlias = list[StrictFloat] | SparseVector | list[list[StrictFloat]]
NumericVectorInput: TypeAlias = (
    list[StrictFloat] | SparseVector | list[list[StrictFloat]] | ExtendedPointId
)
NumericVectorStruct: TypeAlias = (
    list[StrictFloat] | list[list[StrictFloat]] | dict[StrictStr, NumericVector]
)

__all__ = ["NumericVector", "NumericVectorInput", "NumericVectorStruct"]
