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


class _CollectionsApi:
    def __init__(self, api_client: "Union[ApiClient, AsyncApiClient]"):
        self.api_client = api_client

    def _build_for_collection_exists(
        self,
        collection_name: str,
    ):
        """
        Returns \"true\" if the given collection name exists, and \"false\" otherwise
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2008,
            method="GET",
            url="/collections/{collection_name}/exists",
            headers=headers if headers else None,
            path_params=path_params,
        )

    def _build_for_create_collection(
        self,
        collection_name: str,
        timeout: int = None,
        create_collection: m.CreateCollection = None,
    ):
        """
        Create new collection with given parameters
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(create_collection)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2001,
            method="PUT",
            url="/collections/{collection_name}",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_create_vector_name(
        self,
        collection_name: str,
        vector_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        vector_name_config: m.VectorNameConfig = None,
    ):
        """
        Create a new named vector on an existing collection
        """
        path_params = {
            "collection_name": str(collection_name),
            "vector_name": str(vector_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(vector_name_config)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="PUT",
            url="/collections/{collection_name}/vectors/{vector_name}",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_delete_collection(
        self,
        collection_name: str,
        timeout: int = None,
    ):
        """
        Drop collection and all associated data
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2001,
            method="DELETE",
            url="/collections/{collection_name}",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
        )

    def _build_for_delete_vector_name(
        self,
        collection_name: str,
        vector_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
    ):
        """
        Delete a named vector from a collection
        """
        path_params = {
            "collection_name": str(collection_name),
            "vector_name": str(vector_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="DELETE",
            url="/collections/{collection_name}/vectors/{vector_name}",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
        )

    def _build_for_get_collection(
        self,
        collection_name: str,
    ):
        """
        Get detailed information about specified existing collection
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2006,
            method="GET",
            url="/collections/{collection_name}",
            headers=headers if headers else None,
            path_params=path_params,
        )

    def _build_for_get_collections(
        self,
    ):
        """
        Get list name of all existing collections
        """
        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2005,
            method="GET",
            url="/collections",
            headers=headers if headers else None,
        )

    def _build_for_get_optimizations(
        self,
        collection_name: str,
        _with: str = None,
        completed_limit: int = None,
    ):
        """
        Get progress of ongoing and completed optimizations for a collection
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if _with is not None:
            query_params["with"] = str(_with)
        if completed_limit is not None:
            query_params["completed_limit"] = str(completed_limit)

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse20010,
            method="GET",
            url="/collections/{collection_name}/optimizations",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
        )

    def _build_for_update_collection(
        self,
        collection_name: str,
        timeout: int = None,
        update_collection: m.UpdateCollection = None,
    ):
        """
        Update parameters of the existing collection
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(update_collection)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2001,
            method="PATCH",
            url="/collections/{collection_name}",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )


class AsyncCollectionsApi(_CollectionsApi):
    async def collection_exists(
        self,
        collection_name: str,
    ) -> m.InlineResponse2008:
        """
        Returns \"true\" if the given collection name exists, and \"false\" otherwise
        """
        return await self._build_for_collection_exists(
            collection_name=collection_name,
        )

    async def create_collection(
        self,
        collection_name: str,
        timeout: int = None,
        create_collection: m.CreateCollection = None,
    ) -> m.InlineResponse2001:
        """
        Create new collection with given parameters
        """
        return await self._build_for_create_collection(
            collection_name=collection_name,
            timeout=timeout,
            create_collection=create_collection,
        )

    async def create_vector_name(
        self,
        collection_name: str,
        vector_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        vector_name_config: m.VectorNameConfig = None,
    ) -> m.InlineResponse2007:
        """
        Create a new named vector on an existing collection
        """
        return await self._build_for_create_vector_name(
            collection_name=collection_name,
            vector_name=vector_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            vector_name_config=vector_name_config,
        )

    async def delete_collection(
        self,
        collection_name: str,
        timeout: int = None,
    ) -> m.InlineResponse2001:
        """
        Drop collection and all associated data
        """
        return await self._build_for_delete_collection(
            collection_name=collection_name,
            timeout=timeout,
        )

    async def delete_vector_name(
        self,
        collection_name: str,
        vector_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
    ) -> m.InlineResponse2007:
        """
        Delete a named vector from a collection
        """
        return await self._build_for_delete_vector_name(
            collection_name=collection_name,
            vector_name=vector_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
        )

    async def get_collection(
        self,
        collection_name: str,
    ) -> m.InlineResponse2006:
        """
        Get detailed information about specified existing collection
        """
        return await self._build_for_get_collection(
            collection_name=collection_name,
        )

    async def get_collections(
        self,
    ) -> m.InlineResponse2005:
        """
        Get list name of all existing collections
        """
        return await self._build_for_get_collections()

    async def get_optimizations(
        self,
        collection_name: str,
        _with: str = None,
        completed_limit: int = None,
    ) -> m.InlineResponse20010:
        """
        Get progress of ongoing and completed optimizations for a collection
        """
        return await self._build_for_get_optimizations(
            collection_name=collection_name,
            _with=_with,
            completed_limit=completed_limit,
        )

    async def update_collection(
        self,
        collection_name: str,
        timeout: int = None,
        update_collection: m.UpdateCollection = None,
    ) -> m.InlineResponse2001:
        """
        Update parameters of the existing collection
        """
        return await self._build_for_update_collection(
            collection_name=collection_name,
            timeout=timeout,
            update_collection=update_collection,
        )


class SyncCollectionsApi(_CollectionsApi):
    def collection_exists(
        self,
        collection_name: str,
    ) -> m.InlineResponse2008:
        """
        Returns \"true\" if the given collection name exists, and \"false\" otherwise
        """
        return self._build_for_collection_exists(
            collection_name=collection_name,
        )

    def create_collection(
        self,
        collection_name: str,
        timeout: int = None,
        create_collection: m.CreateCollection = None,
    ) -> m.InlineResponse2001:
        """
        Create new collection with given parameters
        """
        return self._build_for_create_collection(
            collection_name=collection_name,
            timeout=timeout,
            create_collection=create_collection,
        )

    def create_vector_name(
        self,
        collection_name: str,
        vector_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        vector_name_config: m.VectorNameConfig = None,
    ) -> m.InlineResponse2007:
        """
        Create a new named vector on an existing collection
        """
        return self._build_for_create_vector_name(
            collection_name=collection_name,
            vector_name=vector_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            vector_name_config=vector_name_config,
        )

    def delete_collection(
        self,
        collection_name: str,
        timeout: int = None,
    ) -> m.InlineResponse2001:
        """
        Drop collection and all associated data
        """
        return self._build_for_delete_collection(
            collection_name=collection_name,
            timeout=timeout,
        )

    def delete_vector_name(
        self,
        collection_name: str,
        vector_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
    ) -> m.InlineResponse2007:
        """
        Delete a named vector from a collection
        """
        return self._build_for_delete_vector_name(
            collection_name=collection_name,
            vector_name=vector_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
        )

    def get_collection(
        self,
        collection_name: str,
    ) -> m.InlineResponse2006:
        """
        Get detailed information about specified existing collection
        """
        return self._build_for_get_collection(
            collection_name=collection_name,
        )

    def get_collections(
        self,
    ) -> m.InlineResponse2005:
        """
        Get list name of all existing collections
        """
        return self._build_for_get_collections()

    def get_optimizations(
        self,
        collection_name: str,
        _with: str = None,
        completed_limit: int = None,
    ) -> m.InlineResponse20010:
        """
        Get progress of ongoing and completed optimizations for a collection
        """
        return self._build_for_get_optimizations(
            collection_name=collection_name,
            _with=_with,
            completed_limit=completed_limit,
        )

    def update_collection(
        self,
        collection_name: str,
        timeout: int = None,
        update_collection: m.UpdateCollection = None,
    ) -> m.InlineResponse2001:
        """
        Update parameters of the existing collection
        """
        return self._build_for_update_collection(
            collection_name=collection_name,
            timeout=timeout,
            update_collection=update_collection,
        )
