from typing import Any, Iterable, Mapping, Sequence

from qdrant_client.conversions import common_types as types


class QdrantBase:
    def __init__(self, **kwargs: Any):
        pass

    def search_matrix_offsets(
        self,
        collection_name: str,
        query_filter: types.Filter | None = None,
        limit: int = 3,
        sample: int = 10,
        using: str | None = None,
        **kwargs: Any,
    ) -> types.SearchMatrixOffsetsResponse:
        raise NotImplementedError()

    def search_matrix_pairs(
        self,
        collection_name: str,
        query_filter: types.Filter | None = None,
        limit: int = 3,
        sample: int = 10,
        using: str | None = None,
        **kwargs: Any,
    ) -> types.SearchMatrixPairsResponse:
        raise NotImplementedError()

    def query_batch_points(
        self,
        collection_name: str,
        requests: Sequence[types.QueryRequest],
        **kwargs: Any,
    ) -> list[types.QueryResponse]:
        raise NotImplementedError()

    def query_points(
        self,
        collection_name: str,
        query: types.PointId
        | list[float]
        | list[list[float]]
        | types.SparseVector
        | types.Query
        | types.NumpyArray
        | types.Document
        | types.Image
        | types.InferenceObject
        | None = None,
        using: str | None = None,
        prefetch: types.Prefetch | list[types.Prefetch] | None = None,
        query_filter: types.Filter | None = None,
        search_params: types.SearchParams | None = None,
        limit: int = 10,
        offset: int | None = None,
        with_payload: bool | Sequence[str] | types.PayloadSelector = True,
        with_vectors: bool | Sequence[str] = False,
        score_threshold: float | None = None,
        lookup_from: types.LookupLocation | None = None,
        **kwargs: Any,
    ) -> types.QueryResponse:
        raise NotImplementedError()

    def query_points_groups(
        self,
        collection_name: str,
        group_by: str,
        query: types.PointId
        | list[float]
        | list[list[float]]
        | types.SparseVector
        | types.Query
        | types.NumpyArray
        | types.Document
        | types.Image
        | types.InferenceObject
        | None = None,
        using: str | None = None,
        prefetch: types.Prefetch | list[types.Prefetch] | None = None,
        query_filter: types.Filter | None = None,
        search_params: types.SearchParams | None = None,
        limit: int = 10,
        group_size: int = 3,
        with_payload: bool | Sequence[str] | types.PayloadSelector = True,
        with_vectors: bool | Sequence[str] = False,
        score_threshold: float | None = None,
        with_lookup: types.WithLookupInterface | None = None,
        lookup_from: types.LookupLocation | None = None,
        **kwargs: Any,
    ) -> types.GroupsResult:
        raise NotImplementedError()

    def scroll(
        self,
        collection_name: str,
        scroll_filter: types.Filter | None = None,
        limit: int = 10,
        order_by: types.OrderBy | None = None,
        offset: types.PointId | None = None,
        with_payload: bool | Sequence[str] | types.PayloadSelector = True,
        with_vectors: bool | Sequence[str] = False,
        **kwargs: Any,
    ) -> tuple[list[types.Record], types.PointId | None]:
        raise NotImplementedError()

    def count(
        self,
        collection_name: str,
        count_filter: types.Filter | None = None,
        exact: bool = True,
        **kwargs: Any,
    ) -> types.CountResult:
        raise NotImplementedError()

    def facet(
        self,
        collection_name: str,
        key: str,
        facet_filter: types.Filter | None = None,
        limit: int = 10,
        exact: bool = False,
        **kwargs: Any,
    ) -> types.FacetResponse:
        raise NotImplementedError()

    def upsert(
        self,
        collection_name: str,
        points: types.Points,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def update_vectors(
        self,
        collection_name: str,
        points: Sequence[types.PointVectors],
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def delete_vectors(
        self,
        collection_name: str,
        vectors: Sequence[str],
        points: types.PointsSelector,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def retrieve(
        self,
        collection_name: str,
        ids: Sequence[types.PointId],
        with_payload: bool | Sequence[str] | types.PayloadSelector = True,
        with_vectors: bool | Sequence[str] = False,
        **kwargs: Any,
    ) -> list[types.Record]:
        raise NotImplementedError()

    def delete(
        self,
        collection_name: str,
        points_selector: types.PointsSelector,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def set_payload(
        self,
        collection_name: str,
        payload: types.Payload,
        points: types.PointsSelector,
        key: str | None = None,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def overwrite_payload(
        self,
        collection_name: str,
        payload: types.Payload,
        points: types.PointsSelector,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def delete_payload(
        self,
        collection_name: str,
        keys: Sequence[str],
        points: types.PointsSelector,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def clear_payload(
        self,
        collection_name: str,
        points_selector: types.PointsSelector,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def batch_update_points(
        self,
        collection_name: str,
        update_operations: Sequence[types.UpdateOperation],
        **kwargs: Any,
    ) -> list[types.UpdateResult]:
        raise NotImplementedError()

    def update_collection_aliases(
        self,
        change_aliases_operations: Sequence[types.AliasOperations],
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError()

    def get_collection_aliases(
        self, collection_name: str, **kwargs: Any
    ) -> types.CollectionsAliasesResponse:
        raise NotImplementedError()

    def get_aliases(self, **kwargs: Any) -> types.CollectionsAliasesResponse:
        raise NotImplementedError()

    def get_collections(self, **kwargs: Any) -> types.CollectionsResponse:
        raise NotImplementedError()

    def get_collection(self, collection_name: str, **kwargs: Any) -> types.CollectionInfo:
        raise NotImplementedError()

    def collection_exists(self, collection_name: str, **kwargs: Any) -> bool:
        raise NotImplementedError()

    def update_collection(
        self,
        collection_name: str,
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError()

    def delete_collection(self, collection_name: str, **kwargs: Any) -> bool:
        raise NotImplementedError()

    def create_collection(
        self,
        collection_name: str,
        vectors_config: types.VectorParams | Mapping[str, types.VectorParams],
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError()

    def recreate_collection(
        self,
        collection_name: str,
        vectors_config: types.VectorParams | Mapping[str, types.VectorParams],
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError()

    def upload_points(
        self,
        collection_name: str,
        points: Iterable[types.PointStruct],
        **kwargs: Any,
    ) -> None:
        raise NotImplementedError()

    def upload_collection(
        self,
        collection_name: str,
        vectors: dict[str, types.NumpyArray] | types.NumpyArray | Iterable[types.VectorStruct],
        payload: Iterable[dict[Any, Any]] | None = None,
        ids: Iterable[types.PointId] | None = None,
        **kwargs: Any,
    ) -> None:
        raise NotImplementedError()

    def create_payload_index(
        self,
        collection_name: str,
        field_name: str,
        field_schema: types.PayloadSchemaType | None = None,
        field_type: types.PayloadSchemaType | None = None,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def delete_payload_index(
        self,
        collection_name: str,
        field_name: str,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def create_vector_name(
        self,
        collection_name: str,
        vector_name: str,
        vector_name_config: types.VectorNameConfig,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def delete_vector_name(
        self,
        collection_name: str,
        vector_name: str,
        **kwargs: Any,
    ) -> types.UpdateResult:
        raise NotImplementedError()

    def list_snapshots(
        self, collection_name: str, **kwargs: Any
    ) -> list[types.SnapshotDescription]:
        raise NotImplementedError()

    def create_snapshot(
        self, collection_name: str, **kwargs: Any
    ) -> types.SnapshotDescription | None:
        raise NotImplementedError()

    def delete_snapshot(
        self, collection_name: str, snapshot_name: str, **kwargs: Any
    ) -> bool | None:
        raise NotImplementedError()

    def list_full_snapshots(self, **kwargs: Any) -> list[types.SnapshotDescription]:
        raise NotImplementedError()

    def create_full_snapshot(self, **kwargs: Any) -> types.SnapshotDescription | None:
        raise NotImplementedError()

    def delete_full_snapshot(self, snapshot_name: str, **kwargs: Any) -> bool | None:
        raise NotImplementedError()

    def recover_snapshot(
        self,
        collection_name: str,
        location: str,
        **kwargs: Any,
    ) -> bool | None:
        raise NotImplementedError()

    def list_shard_snapshots(
        self, collection_name: str, shard_id: int, **kwargs: Any
    ) -> list[types.SnapshotDescription]:
        raise NotImplementedError()

    def create_shard_snapshot(
        self, collection_name: str, shard_id: int, **kwargs: Any
    ) -> types.SnapshotDescription | None:
        raise NotImplementedError()

    def delete_shard_snapshot(
        self, collection_name: str, shard_id: int, snapshot_name: str, **kwargs: Any
    ) -> bool | None:
        raise NotImplementedError()

    def recover_shard_snapshot(
        self,
        collection_name: str,
        shard_id: int,
        location: str,
        **kwargs: Any,
    ) -> bool | None:
        raise NotImplementedError()

    def close(self, **kwargs: Any) -> None:
        pass

    def migrate(
        self,
        dest_client: "QdrantBase",
        collection_names: list[str] | None = None,
        batch_size: int = 100,
        recreate_on_collision: bool = False,
    ) -> None:
        raise NotImplementedError()

    def create_shard_key(
        self,
        collection_name: str,
        shard_key: types.ShardKey,
        shards_number: int | None = None,
        replication_factor: int | None = None,
        placement: list[int] | None = None,
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError()

    def delete_shard_key(
        self,
        collection_name: str,
        shard_key: types.ShardKey,
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError()

    def info(self) -> types.VersionInfo:
        raise NotImplementedError()

    def cluster_collection_update(
        self,
        collection_name: str,
        cluster_operation: types.ClusterOperations,
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError()

    def collection_cluster_info(self, collection_name: str) -> types.CollectionClusterInfo:
        raise NotImplementedError()

    def cluster_status(self) -> types.ClusterStatus:
        raise NotImplementedError()

    def recover_current_peer(self) -> bool:
        raise NotImplementedError()

    def remove_peer(self, peer_id: int, **kwargs: Any) -> bool:
        raise NotImplementedError()

    def get_optimizations(
        self,
        collection_name: str,
        **kwargs: Any,
    ) -> types.OptimizationsResponse:
        raise NotImplementedError()

    def list_shard_keys(
        self,
        collection_name: str,
        **kwargs: Any,
    ) -> types.ShardKeysResponse:
        raise NotImplementedError()

    def cluster_telemetry(
        self,
        **kwargs: Any,
    ) -> types.DistributedTelemetryData:
        raise NotImplementedError()
