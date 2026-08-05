import sys

import numpy as np
import numpy.typing as npt

from typing import Union, get_args, Sequence, TypeAlias
from uuid import UUID

from qdrant_client import grpc
from qdrant_client.http import models as rest

typing_remap = {
    rest.StrictStr: str,
    rest.StrictInt: int,
    rest.StrictFloat: float,
    rest.StrictBool: bool,
}


def remap_type(tp: type) -> type:
    """Remap type to a type that can be used in type annotations

    Pydantic uses custom types for strict types, so we need to remap them to standard types
    so that they can be used in type annotations and isinstance checks
    """
    return typing_remap.get(tp, tp)


def get_args_subscribed(tp):  # type: ignore
    """Get type arguments with all substitutions performed. Supports subscripted generics having __origin__

    Args:
        tp: type to get arguments from. Can be either a type or a subscripted generic

    Returns:
        tuple of type arguments
    """
    return tuple(
        remap_type(arg if not hasattr(arg, "__origin__") else arg.__origin__)
        for arg in get_args(tp)
    )


Filter: TypeAlias = rest.Filter | grpc.Filter
SearchParams: TypeAlias = rest.SearchParams | grpc.SearchParams
PayloadSelector: TypeAlias = rest.PayloadSelector | grpc.WithPayloadSelector
Distance: TypeAlias = rest.Distance | int  # type(grpc.Distance) == int
HnswConfigDiff: TypeAlias = rest.HnswConfigDiff | grpc.HnswConfigDiff
VectorsConfigDiff: TypeAlias = rest.VectorsConfigDiff | grpc.VectorsConfigDiff
QuantizationConfigDiff: TypeAlias = rest.QuantizationConfigDiff | grpc.QuantizationConfigDiff
OptimizersConfigDiff: TypeAlias = rest.OptimizersConfigDiff | grpc.OptimizersConfigDiff
CollectionParamsDiff: TypeAlias = rest.CollectionParamsDiff | grpc.CollectionParamsDiff
WalConfigDiff: TypeAlias = rest.WalConfigDiff | grpc.WalConfigDiff
QuantizationConfig: TypeAlias = rest.QuantizationConfig | grpc.QuantizationConfig
PointId: TypeAlias = int | str | UUID | grpc.PointId
PayloadSchemaType: TypeAlias = (
    rest.PayloadSchemaType | rest.PayloadSchemaParams | int | grpc.PayloadIndexParams
)  # type(grpc.PayloadSchemaType) == int
PointStruct: TypeAlias = rest.PointStruct
Batch: TypeAlias = rest.Batch
Points: TypeAlias = Batch | Sequence[rest.PointStruct | grpc.PointStruct]
PointsSelector: TypeAlias = (
    list[PointId] | rest.Filter | grpc.Filter | rest.PointsSelector | grpc.PointsSelector
)
LookupLocation: TypeAlias = rest.LookupLocation | grpc.LookupLocation
RecommendStrategy: TypeAlias = rest.RecommendStrategy
OrderBy: TypeAlias = rest.OrderByInterface | grpc.OrderBy
ShardingMethod: TypeAlias = rest.ShardingMethod
ShardKey: TypeAlias = rest.ShardKey
ShardKeySelector: TypeAlias = rest.ShardKeySelector

AliasOperations: TypeAlias = (
    rest.CreateAliasOperation
    | rest.RenameAliasOperation
    | rest.DeleteAliasOperation
    | grpc.AliasOperations
)
Payload: TypeAlias = rest.Payload

ScoredPoint: TypeAlias = rest.ScoredPoint
UpdateResult: TypeAlias = rest.UpdateResult
Record: TypeAlias = rest.Record
CollectionsResponse: TypeAlias = rest.CollectionsResponse
CollectionInfo: TypeAlias = rest.CollectionInfo
CountResult: TypeAlias = rest.CountResult
SnapshotDescription: TypeAlias = rest.SnapshotDescription
NamedVector: TypeAlias = rest.NamedVector
NamedSparseVector: TypeAlias = rest.NamedSparseVector
SparseVector: TypeAlias = rest.SparseVector
PointVectors: TypeAlias = rest.PointVectors
Vector: TypeAlias = rest.Vector
VectorInput: TypeAlias = rest.VectorInput
VectorStruct: TypeAlias = rest.VectorStruct
VectorParams: TypeAlias = rest.VectorParams
SparseVectorParams: TypeAlias = rest.SparseVectorParams
VectorNameConfig: TypeAlias = rest.VectorNameConfig
SnapshotPriority: TypeAlias = rest.SnapshotPriority
CollectionsAliasesResponse: TypeAlias = rest.CollectionsAliasesResponse
UpdateOperation: TypeAlias = rest.UpdateOperation
Query: TypeAlias = rest.Query
Prefetch: TypeAlias = rest.Prefetch
Document: TypeAlias = rest.Document
Image: TypeAlias = rest.Image
InferenceObject: TypeAlias = rest.InferenceObject
StrictModeConfig: TypeAlias = rest.StrictModeConfig
UpdateMode: TypeAlias = rest.UpdateMode

QueryRequest: TypeAlias = rest.QueryRequest

Mmr: TypeAlias = rest.Mmr

ReadConsistency: TypeAlias = rest.ReadConsistency
WriteOrdering: TypeAlias = rest.WriteOrdering
WithLookupInterface: TypeAlias = rest.WithLookupInterface

GroupsResult: TypeAlias = rest.GroupsResult
QueryResponse: TypeAlias = rest.QueryResponse

FacetValue: TypeAlias = rest.FacetValue
FacetResponse: TypeAlias = rest.FacetResponse
SearchMatrixRequest: TypeAlias = rest.SearchMatrixRequest | grpc.SearchMatrixPoints
SearchMatrixOffsetsResponse: TypeAlias = rest.SearchMatrixOffsetsResponse
SearchMatrixPairsResponse: TypeAlias = rest.SearchMatrixPairsResponse
SearchMatrixPair: TypeAlias = rest.SearchMatrixPair

VersionInfo: TypeAlias = rest.VersionInfo

ReplicaState: TypeAlias = rest.ReplicaState
ClusterOperations: TypeAlias = rest.ClusterOperations
ClusterStatus: TypeAlias = rest.ClusterStatus
CollectionClusterInfo: TypeAlias = rest.CollectionClusterInfo
OptimizationsResponse: TypeAlias = rest.OptimizationsResponse
ShardKeysResponse: TypeAlias = rest.ShardKeysResponse
DistributedTelemetryData: TypeAlias = rest.DistributedTelemetryData

# we can't use `nptyping` package due to numpy/python-version incompatibilities
# thus we need to define precise type annotations while we support python3.7
_np_numeric = Union[
    np.bool_,  # pylance can't handle np.bool8 alias
    np.int8,
    np.int16,
    np.int32,
    np.int64,
    np.uint8,
    np.uint16,
    np.uint32,
    np.uint64,
    np.intp,
    np.uintp,
    np.float16,
    np.float32,
    np.float64,
    np.longdouble,  # np.float96 and np.float128 are platform dependant aliases for longdouble
]

NumpyArray: TypeAlias = npt.NDArray[_np_numeric]
