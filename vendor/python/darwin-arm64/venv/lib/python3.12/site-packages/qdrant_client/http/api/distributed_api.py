# flake8: noqa E501
from typing import TYPE_CHECKING, Any, Dict, Set, TypeVar, Union

from pydantic import BaseModel
from pydantic.main import BaseModel
from pydantic.version import VERSION as PYDANTIC_VERSION
from qdrant_client.http.models import *
from qdrant_client.http.models import models as m

PYDANTIC_V2 = PYDANTIC_VERSION.startswith("2.")
Model = TypeVar("Model", bound="BaseModel")

SetIntStr = Set[Union[int, str]]
DictIntStrAny = Dict[Union[int, str], Any]
file = None


def to_json(model: BaseModel, *args: Any, **kwargs: Any) -> str:
    if PYDANTIC_V2:
        return model.model_dump_json(*args, **kwargs)
    else:
        return model.json(*args, **kwargs)


def jsonable_encoder(
    obj: Any,
    include: Union[SetIntStr, DictIntStrAny] = None,
    exclude=None,
    by_alias: bool = True,
    skip_defaults: bool = None,
    exclude_unset: bool = True,
    exclude_none: bool = True,
):
    if hasattr(obj, "json") or hasattr(obj, "model_dump_json"):
        return to_json(
            obj,
            include=include,
            exclude=exclude,
            by_alias=by_alias,
            exclude_unset=bool(exclude_unset or skip_defaults),
            exclude_none=exclude_none,
        )

    return obj


if TYPE_CHECKING:
    from qdrant_client.http.api_client import ApiClient


class _DistributedApi:
    def __init__(self, api_client: "Union[ApiClient, AsyncApiClient]"):
        self.api_client = api_client

    def _build_for_cluster_status(
        self,
    ):
        """
        Get information about the current state and composition of the cluster
        """
        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2003,
            method="GET",
            url="/cluster",
            headers=headers if headers else None,
        )

    def _build_for_cluster_telemetry(
        self,
        details_level: int = None,
        timeout: int = None,
    ):
        """
        Get telemetry data, from the point of view of the cluster. This includes peers info, collections info, shard transfers, and resharding status
        """
        query_params = {}
        if details_level is not None:
            query_params["details_level"] = str(details_level)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2004,
            method="GET",
            url="/cluster/telemetry",
            headers=headers if headers else None,
            params=query_params,
        )

    def _build_for_collection_cluster_info(
        self,
        collection_name: str,
    ):
        """
        Get cluster information for a collection
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2009,
            method="GET",
            url="/collections/{collection_name}/cluster",
            headers=headers if headers else None,
            path_params=path_params,
        )

    def _build_for_create_shard_key(
        self,
        collection_name: str,
        timeout: int = None,
        create_sharding_key: m.CreateShardingKey = None,
    ):
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(create_sharding_key)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2001,
            method="PUT",
            url="/collections/{collection_name}/shards",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_delete_shard_key(
        self,
        collection_name: str,
        timeout: int = None,
        drop_sharding_key: m.DropShardingKey = None,
    ):
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(drop_sharding_key)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2001,
            method="POST",
            url="/collections/{collection_name}/shards/delete",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_list_shard_keys(
        self,
        collection_name: str,
    ):
        path_params = {
            "collection_name": str(collection_name),
        }

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse200,
            method="GET",
            url="/collections/{collection_name}/shards",
            headers=headers if headers else None,
            path_params=path_params,
        )

    def _build_for_recover_current_peer(
        self,
    ):
        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2001,
            method="POST",
            url="/cluster/recover",
            headers=headers if headers else None,
        )

    def _build_for_remove_peer(
        self,
        peer_id: int,
        timeout: int = None,
        force: bool = None,
    ):
        """
        Tries to remove peer from the cluster. Will return an error if peer has shards on it.
        """
        path_params = {
            "peer_id": str(peer_id),
        }

        query_params = {}
        if timeout is not None:
            query_params["timeout"] = str(timeout)
        if force is not None:
            query_params["force"] = str(force).lower()

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2001,
            method="DELETE",
            url="/cluster/peer/{peer_id}",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
        )

    def _build_for_update_collection_cluster(
        self,
        collection_name: str,
        timeout: int = None,
        cluster_operations: m.ClusterOperations = None,
    ):
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(cluster_operations)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2001,
            method="POST",
            url="/collections/{collection_name}/cluster",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )


class AsyncDistributedApi(_DistributedApi):
    async def cluster_status(
        self,
    ) -> m.InlineResponse2003:
        """
        Get information about the current state and composition of the cluster
        """
        return await self._build_for_cluster_status()

    async def cluster_telemetry(
        self,
        details_level: int = None,
        timeout: int = None,
    ) -> m.InlineResponse2004:
        """
        Get telemetry data, from the point of view of the cluster. This includes peers info, collections info, shard transfers, and resharding status
        """
        return await self._build_for_cluster_telemetry(
            details_level=details_level,
            timeout=timeout,
        )

    async def collection_cluster_info(
        self,
        collection_name: str,
    ) -> m.InlineResponse2009:
        """
        Get cluster information for a collection
        """
        return await self._build_for_collection_cluster_info(
            collection_name=collection_name,
        )

    async def create_shard_key(
        self,
        collection_name: str,
        timeout: int = None,
        create_sharding_key: m.CreateShardingKey = None,
    ) -> m.InlineResponse2001:
        return await self._build_for_create_shard_key(
            collection_name=collection_name,
            timeout=timeout,
            create_sharding_key=create_sharding_key,
        )

    async def delete_shard_key(
        self,
        collection_name: str,
        timeout: int = None,
        drop_sharding_key: m.DropShardingKey = None,
    ) -> m.InlineResponse2001:
        return await self._build_for_delete_shard_key(
            collection_name=collection_name,
            timeout=timeout,
            drop_sharding_key=drop_sharding_key,
        )

    async def list_shard_keys(
        self,
        collection_name: str,
    ) -> m.InlineResponse200:
        return await self._build_for_list_shard_keys(
            collection_name=collection_name,
        )

    async def recover_current_peer(
        self,
    ) -> m.InlineResponse2001:
        return await self._build_for_recover_current_peer()

    async def remove_peer(
        self,
        peer_id: int,
        timeout: int = None,
        force: bool = None,
    ) -> m.InlineResponse2001:
        """
        Tries to remove peer from the cluster. Will return an error if peer has shards on it.
        """
        return await self._build_for_remove_peer(
            peer_id=peer_id,
            timeout=timeout,
            force=force,
        )

    async def update_collection_cluster(
        self,
        collection_name: str,
        timeout: int = None,
        cluster_operations: m.ClusterOperations = None,
    ) -> m.InlineResponse2001:
        return await self._build_for_update_collection_cluster(
            collection_name=collection_name,
            timeout=timeout,
            cluster_operations=cluster_operations,
        )


class SyncDistributedApi(_DistributedApi):
    def cluster_status(
        self,
    ) -> m.InlineResponse2003:
        """
        Get information about the current state and composition of the cluster
        """
        return self._build_for_cluster_status()

    def cluster_telemetry(
        self,
        details_level: int = None,
        timeout: int = None,
    ) -> m.InlineResponse2004:
        """
        Get telemetry data, from the point of view of the cluster. This includes peers info, collections info, shard transfers, and resharding status
        """
        return self._build_for_cluster_telemetry(
            details_level=details_level,
            timeout=timeout,
        )

    def collection_cluster_info(
        self,
        collection_name: str,
    ) -> m.InlineResponse2009:
        """
        Get cluster information for a collection
        """
        return self._build_for_collection_cluster_info(
            collection_name=collection_name,
        )

    def create_shard_key(
        self,
        collection_name: str,
        timeout: int = None,
        create_sharding_key: m.CreateShardingKey = None,
    ) -> m.InlineResponse2001:
        return self._build_for_create_shard_key(
            collection_name=collection_name,
            timeout=timeout,
            create_sharding_key=create_sharding_key,
        )

    def delete_shard_key(
        self,
        collection_name: str,
        timeout: int = None,
        drop_sharding_key: m.DropShardingKey = None,
    ) -> m.InlineResponse2001:
        return self._build_for_delete_shard_key(
            collection_name=collection_name,
            timeout=timeout,
            drop_sharding_key=drop_sharding_key,
        )

    def list_shard_keys(
        self,
        collection_name: str,
    ) -> m.InlineResponse200:
        return self._build_for_list_shard_keys(
            collection_name=collection_name,
        )

    def recover_current_peer(
        self,
    ) -> m.InlineResponse2001:
        return self._build_for_recover_current_peer()

    def remove_peer(
        self,
        peer_id: int,
        timeout: int = None,
        force: bool = None,
    ) -> m.InlineResponse2001:
        """
        Tries to remove peer from the cluster. Will return an error if peer has shards on it.
        """
        return self._build_for_remove_peer(
            peer_id=peer_id,
            timeout=timeout,
            force=force,
        )

    def update_collection_cluster(
        self,
        collection_name: str,
        timeout: int = None,
        cluster_operations: m.ClusterOperations = None,
    ) -> m.InlineResponse2001:
        return self._build_for_update_collection_cluster(
            collection_name=collection_name,
            timeout=timeout,
            cluster_operations=cluster_operations,
        )
