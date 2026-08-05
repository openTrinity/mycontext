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


class _PointsApi:
    def __init__(self, api_client: "Union[ApiClient, AsyncApiClient]"):
        self.api_client = api_client

    def _build_for_batch_update(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        update_operations: m.UpdateOperations = None,
    ):
        """
        Apply a series of update operations for points, vectors and payloads
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(update_operations)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20017,
            method="POST",
            url="/collections/{collection_name}/points/batch",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_clear_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        points_selector: m.PointsSelector = None,
    ):
        """
        Remove all payload for specified points
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(points_selector)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="POST",
            url="/collections/{collection_name}/points/payload/clear",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_count_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        count_request: m.CountRequest = None,
    ):
        """
        Count points which matches given filtering condition
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if consistency is not None:
            query_params["consistency"] = str(consistency)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(count_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20022,
            method="POST",
            url="/collections/{collection_name}/points/count",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_delete_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        delete_payload: m.DeletePayload = None,
    ):
        """
        Delete specified key payload for points
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(delete_payload)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="POST",
            url="/collections/{collection_name}/points/payload/delete",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_delete_points(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        points_selector: m.PointsSelector = None,
    ):
        """
        Delete points
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(points_selector)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="POST",
            url="/collections/{collection_name}/points/delete",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_delete_vectors(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        delete_vectors: m.DeleteVectors = None,
    ):
        """
        Delete named vectors from the given points.
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(delete_vectors)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="POST",
            url="/collections/{collection_name}/points/vectors/delete",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_facet(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        facet_request: m.FacetRequest = None,
    ):
        """
        Count points that satisfy the given filter for each unique value of a payload key.
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if consistency is not None:
            query_params["consistency"] = str(consistency)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(facet_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20023,
            method="POST",
            url="/collections/{collection_name}/facet",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_get_point(
        self,
        collection_name: str,
        id: m.ExtendedPointId,
        consistency: m.ReadConsistency = None,
    ):
        """
        Retrieve full information of single point by id
        """
        path_params = {
            "collection_name": str(collection_name),
            "id": str(id),
        }

        query_params = {}
        if consistency is not None:
            query_params["consistency"] = str(consistency)

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse20015,
            method="GET",
            url="/collections/{collection_name}/points/{id}",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
        )

    def _build_for_get_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        point_request: m.PointRequest = None,
    ):
        """
        Retrieve multiple points by specified IDs
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if consistency is not None:
            query_params["consistency"] = str(consistency)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(point_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20016,
            method="POST",
            url="/collections/{collection_name}/points",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_overwrite_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        set_payload: m.SetPayload = None,
    ):
        """
        Replace full payload of points with new one
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(set_payload)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="PUT",
            url="/collections/{collection_name}/points/payload",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_scroll_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        scroll_request: m.ScrollRequest = None,
    ):
        """
        Scroll request - paginate over all points which matches given filtering condition
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if consistency is not None:
            query_params["consistency"] = str(consistency)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(scroll_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20018,
            method="POST",
            url="/collections/{collection_name}/points/scroll",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_set_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        set_payload: m.SetPayload = None,
    ):
        """
        Set payload values for points
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(set_payload)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="POST",
            url="/collections/{collection_name}/points/payload",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_update_vectors(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        update_vectors: m.UpdateVectors = None,
    ):
        """
        Update specified named vectors on points, keep unspecified vectors intact.
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(update_vectors)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="PUT",
            url="/collections/{collection_name}/points/vectors",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_upsert_points(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        point_insert_operations: m.PointInsertOperations = None,
    ):
        """
        Perform insert + updates on points. If point with given ID already exists - it will be overwritten.
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        query_params = {}
        if wait is not None:
            query_params["wait"] = str(wait).lower()
        if ordering is not None:
            query_params["ordering"] = str(ordering)
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(point_insert_operations)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="PUT",
            url="/collections/{collection_name}/points",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )


class AsyncPointsApi(_PointsApi):
    async def batch_update(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        update_operations: m.UpdateOperations = None,
    ) -> m.InlineResponse20017:
        """
        Apply a series of update operations for points, vectors and payloads
        """
        return await self._build_for_batch_update(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            update_operations=update_operations,
        )

    async def clear_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        points_selector: m.PointsSelector = None,
    ) -> m.InlineResponse2007:
        """
        Remove all payload for specified points
        """
        return await self._build_for_clear_payload(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            points_selector=points_selector,
        )

    async def count_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        count_request: m.CountRequest = None,
    ) -> m.InlineResponse20022:
        """
        Count points which matches given filtering condition
        """
        return await self._build_for_count_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            count_request=count_request,
        )

    async def delete_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        delete_payload: m.DeletePayload = None,
    ) -> m.InlineResponse2007:
        """
        Delete specified key payload for points
        """
        return await self._build_for_delete_payload(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            delete_payload=delete_payload,
        )

    async def delete_points(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        points_selector: m.PointsSelector = None,
    ) -> m.InlineResponse2007:
        """
        Delete points
        """
        return await self._build_for_delete_points(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            points_selector=points_selector,
        )

    async def delete_vectors(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        delete_vectors: m.DeleteVectors = None,
    ) -> m.InlineResponse2007:
        """
        Delete named vectors from the given points.
        """
        return await self._build_for_delete_vectors(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            delete_vectors=delete_vectors,
        )

    async def facet(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        facet_request: m.FacetRequest = None,
    ) -> m.InlineResponse20023:
        """
        Count points that satisfy the given filter for each unique value of a payload key.
        """
        return await self._build_for_facet(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            facet_request=facet_request,
        )

    async def get_point(
        self,
        collection_name: str,
        id: m.ExtendedPointId,
        consistency: m.ReadConsistency = None,
    ) -> m.InlineResponse20015:
        """
        Retrieve full information of single point by id
        """
        return await self._build_for_get_point(
            collection_name=collection_name,
            id=id,
            consistency=consistency,
        )

    async def get_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        point_request: m.PointRequest = None,
    ) -> m.InlineResponse20016:
        """
        Retrieve multiple points by specified IDs
        """
        return await self._build_for_get_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            point_request=point_request,
        )

    async def overwrite_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        set_payload: m.SetPayload = None,
    ) -> m.InlineResponse2007:
        """
        Replace full payload of points with new one
        """
        return await self._build_for_overwrite_payload(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            set_payload=set_payload,
        )

    async def scroll_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        scroll_request: m.ScrollRequest = None,
    ) -> m.InlineResponse20018:
        """
        Scroll request - paginate over all points which matches given filtering condition
        """
        return await self._build_for_scroll_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            scroll_request=scroll_request,
        )

    async def set_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        set_payload: m.SetPayload = None,
    ) -> m.InlineResponse2007:
        """
        Set payload values for points
        """
        return await self._build_for_set_payload(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            set_payload=set_payload,
        )

    async def update_vectors(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        update_vectors: m.UpdateVectors = None,
    ) -> m.InlineResponse2007:
        """
        Update specified named vectors on points, keep unspecified vectors intact.
        """
        return await self._build_for_update_vectors(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            update_vectors=update_vectors,
        )

    async def upsert_points(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        point_insert_operations: m.PointInsertOperations = None,
    ) -> m.InlineResponse2007:
        """
        Perform insert + updates on points. If point with given ID already exists - it will be overwritten.
        """
        return await self._build_for_upsert_points(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            point_insert_operations=point_insert_operations,
        )


class SyncPointsApi(_PointsApi):
    def batch_update(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        update_operations: m.UpdateOperations = None,
    ) -> m.InlineResponse20017:
        """
        Apply a series of update operations for points, vectors and payloads
        """
        return self._build_for_batch_update(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            update_operations=update_operations,
        )

    def clear_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        points_selector: m.PointsSelector = None,
    ) -> m.InlineResponse2007:
        """
        Remove all payload for specified points
        """
        return self._build_for_clear_payload(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            points_selector=points_selector,
        )

    def count_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        count_request: m.CountRequest = None,
    ) -> m.InlineResponse20022:
        """
        Count points which matches given filtering condition
        """
        return self._build_for_count_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            count_request=count_request,
        )

    def delete_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        delete_payload: m.DeletePayload = None,
    ) -> m.InlineResponse2007:
        """
        Delete specified key payload for points
        """
        return self._build_for_delete_payload(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            delete_payload=delete_payload,
        )

    def delete_points(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        points_selector: m.PointsSelector = None,
    ) -> m.InlineResponse2007:
        """
        Delete points
        """
        return self._build_for_delete_points(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            points_selector=points_selector,
        )

    def delete_vectors(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        delete_vectors: m.DeleteVectors = None,
    ) -> m.InlineResponse2007:
        """
        Delete named vectors from the given points.
        """
        return self._build_for_delete_vectors(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            delete_vectors=delete_vectors,
        )

    def facet(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        facet_request: m.FacetRequest = None,
    ) -> m.InlineResponse20023:
        """
        Count points that satisfy the given filter for each unique value of a payload key.
        """
        return self._build_for_facet(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            facet_request=facet_request,
        )

    def get_point(
        self,
        collection_name: str,
        id: m.ExtendedPointId,
        consistency: m.ReadConsistency = None,
    ) -> m.InlineResponse20015:
        """
        Retrieve full information of single point by id
        """
        return self._build_for_get_point(
            collection_name=collection_name,
            id=id,
            consistency=consistency,
        )

    def get_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        point_request: m.PointRequest = None,
    ) -> m.InlineResponse20016:
        """
        Retrieve multiple points by specified IDs
        """
        return self._build_for_get_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            point_request=point_request,
        )

    def overwrite_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        set_payload: m.SetPayload = None,
    ) -> m.InlineResponse2007:
        """
        Replace full payload of points with new one
        """
        return self._build_for_overwrite_payload(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            set_payload=set_payload,
        )

    def scroll_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        scroll_request: m.ScrollRequest = None,
    ) -> m.InlineResponse20018:
        """
        Scroll request - paginate over all points which matches given filtering condition
        """
        return self._build_for_scroll_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            scroll_request=scroll_request,
        )

    def set_payload(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        set_payload: m.SetPayload = None,
    ) -> m.InlineResponse2007:
        """
        Set payload values for points
        """
        return self._build_for_set_payload(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            set_payload=set_payload,
        )

    def update_vectors(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        update_vectors: m.UpdateVectors = None,
    ) -> m.InlineResponse2007:
        """
        Update specified named vectors on points, keep unspecified vectors intact.
        """
        return self._build_for_update_vectors(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            update_vectors=update_vectors,
        )

    def upsert_points(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        point_insert_operations: m.PointInsertOperations = None,
    ) -> m.InlineResponse2007:
        """
        Perform insert + updates on points. If point with given ID already exists - it will be overwritten.
        """
        return self._build_for_upsert_points(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            point_insert_operations=point_insert_operations,
        )
