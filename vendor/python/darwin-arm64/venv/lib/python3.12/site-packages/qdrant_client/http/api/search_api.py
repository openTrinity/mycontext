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


class _SearchApi:
    def __init__(self, api_client: "Union[ApiClient, AsyncApiClient]"):
        self.api_client = api_client

    def _build_for_discover_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        discover_request_batch: m.DiscoverRequestBatch = None,
    ):
        """
        Look for points based on target and/or positive and negative example pairs, in batch.
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
        body = jsonable_encoder(discover_request_batch)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20020,
            method="POST",
            url="/collections/{collection_name}/points/discover/batch",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_discover_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        discover_request: m.DiscoverRequest = None,
    ):
        """
        Use context and a target to find the most similar points to the target, constrained by the context. When using only the context (without a target), a special search - called context search - is performed where pairs of points are used to generate a loss that guides the search towards the zone where most positive examples overlap. This means that the score minimizes the scenario of finding a point closer to a negative than to a positive part of a pair. Since the score of a context relates to loss, the maximum score a point can get is 0.0, and it becomes normal that many points can have a score of 0.0. When using target (with or without context), the score behaves a little different: The integer part of the score represents the rank with respect to the context, while the decimal part of the score relates to the distance to the target. The context part of the score for each pair is calculated +1 if the point is closer to a positive than to a negative part of a pair, and -1 otherwise.
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
        body = jsonable_encoder(discover_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20019,
            method="POST",
            url="/collections/{collection_name}/points/discover",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_query_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        query_request_batch: m.QueryRequestBatch = None,
    ):
        """
        Universally query points in batch. This endpoint covers all capabilities of search, recommend, discover, filters. But also enables hybrid and multi-stage queries.
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
        body = jsonable_encoder(query_request_batch)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20025,
            method="POST",
            url="/collections/{collection_name}/points/query/batch",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_query_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        query_request: m.QueryRequest = None,
    ):
        """
        Universally query points. This endpoint covers all capabilities of search, recommend, discover, filters. But also enables hybrid and multi-stage queries.
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
        body = jsonable_encoder(query_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20024,
            method="POST",
            url="/collections/{collection_name}/points/query",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_query_points_groups(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        query_groups_request: m.QueryGroupsRequest = None,
    ):
        """
        Universally query points, grouped by a given payload field
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
        body = jsonable_encoder(query_groups_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20021,
            method="POST",
            url="/collections/{collection_name}/points/query/groups",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_recommend_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        recommend_request_batch: m.RecommendRequestBatch = None,
    ):
        """
        Look for the points which are closer to stored positive examples and at the same time further to negative examples.
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
        body = jsonable_encoder(recommend_request_batch)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20020,
            method="POST",
            url="/collections/{collection_name}/points/recommend/batch",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_recommend_point_groups(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        recommend_groups_request: m.RecommendGroupsRequest = None,
    ):
        """
        Look for the points which are closer to stored positive examples and at the same time further to negative examples, grouped by a given payload field.
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
        body = jsonable_encoder(recommend_groups_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20021,
            method="POST",
            url="/collections/{collection_name}/points/recommend/groups",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_recommend_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        recommend_request: m.RecommendRequest = None,
    ):
        """
        Look for the points which are closer to stored positive examples and at the same time further to negative examples.
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
        body = jsonable_encoder(recommend_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20019,
            method="POST",
            url="/collections/{collection_name}/points/recommend",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_search_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_request_batch: m.SearchRequestBatch = None,
    ):
        """
        Retrieve by batch the closest points based on vector similarity and given filtering conditions
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
        body = jsonable_encoder(search_request_batch)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20020,
            method="POST",
            url="/collections/{collection_name}/points/search/batch",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_search_matrix_offsets(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_matrix_request: m.SearchMatrixRequest = None,
    ):
        """
        Compute distance matrix for sampled points with an offset based output format
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
        body = jsonable_encoder(search_matrix_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20027,
            method="POST",
            url="/collections/{collection_name}/points/search/matrix/offsets",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_search_matrix_pairs(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_matrix_request: m.SearchMatrixRequest = None,
    ):
        """
        Compute distance matrix for sampled points with a pair based output format
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
        body = jsonable_encoder(search_matrix_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20026,
            method="POST",
            url="/collections/{collection_name}/points/search/matrix/pairs",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_search_point_groups(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_groups_request: m.SearchGroupsRequest = None,
    ):
        """
        Retrieve closest points based on vector similarity and given filtering conditions, grouped by a given payload field
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
        body = jsonable_encoder(search_groups_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20021,
            method="POST",
            url="/collections/{collection_name}/points/search/groups",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_search_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_request: m.SearchRequest = None,
    ):
        """
        Retrieve closest points based on vector similarity and given filtering conditions
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
        body = jsonable_encoder(search_request)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse20019,
            method="POST",
            url="/collections/{collection_name}/points/search",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )


class AsyncSearchApi(_SearchApi):
    async def discover_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        discover_request_batch: m.DiscoverRequestBatch = None,
    ) -> m.InlineResponse20020:
        """
        Look for points based on target and/or positive and negative example pairs, in batch.
        """
        return await self._build_for_discover_batch_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            discover_request_batch=discover_request_batch,
        )

    async def discover_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        discover_request: m.DiscoverRequest = None,
    ) -> m.InlineResponse20019:
        """
        Use context and a target to find the most similar points to the target, constrained by the context. When using only the context (without a target), a special search - called context search - is performed where pairs of points are used to generate a loss that guides the search towards the zone where most positive examples overlap. This means that the score minimizes the scenario of finding a point closer to a negative than to a positive part of a pair. Since the score of a context relates to loss, the maximum score a point can get is 0.0, and it becomes normal that many points can have a score of 0.0. When using target (with or without context), the score behaves a little different: The integer part of the score represents the rank with respect to the context, while the decimal part of the score relates to the distance to the target. The context part of the score for each pair is calculated +1 if the point is closer to a positive than to a negative part of a pair, and -1 otherwise.
        """
        return await self._build_for_discover_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            discover_request=discover_request,
        )

    async def query_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        query_request_batch: m.QueryRequestBatch = None,
    ) -> m.InlineResponse20025:
        """
        Universally query points in batch. This endpoint covers all capabilities of search, recommend, discover, filters. But also enables hybrid and multi-stage queries.
        """
        return await self._build_for_query_batch_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            query_request_batch=query_request_batch,
        )

    async def query_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        query_request: m.QueryRequest = None,
    ) -> m.InlineResponse20024:
        """
        Universally query points. This endpoint covers all capabilities of search, recommend, discover, filters. But also enables hybrid and multi-stage queries.
        """
        return await self._build_for_query_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            query_request=query_request,
        )

    async def query_points_groups(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        query_groups_request: m.QueryGroupsRequest = None,
    ) -> m.InlineResponse20021:
        """
        Universally query points, grouped by a given payload field
        """
        return await self._build_for_query_points_groups(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            query_groups_request=query_groups_request,
        )

    async def recommend_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        recommend_request_batch: m.RecommendRequestBatch = None,
    ) -> m.InlineResponse20020:
        """
        Look for the points which are closer to stored positive examples and at the same time further to negative examples.
        """
        return await self._build_for_recommend_batch_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            recommend_request_batch=recommend_request_batch,
        )

    async def recommend_point_groups(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        recommend_groups_request: m.RecommendGroupsRequest = None,
    ) -> m.InlineResponse20021:
        """
        Look for the points which are closer to stored positive examples and at the same time further to negative examples, grouped by a given payload field.
        """
        return await self._build_for_recommend_point_groups(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            recommend_groups_request=recommend_groups_request,
        )

    async def recommend_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        recommend_request: m.RecommendRequest = None,
    ) -> m.InlineResponse20019:
        """
        Look for the points which are closer to stored positive examples and at the same time further to negative examples.
        """
        return await self._build_for_recommend_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            recommend_request=recommend_request,
        )

    async def search_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_request_batch: m.SearchRequestBatch = None,
    ) -> m.InlineResponse20020:
        """
        Retrieve by batch the closest points based on vector similarity and given filtering conditions
        """
        return await self._build_for_search_batch_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_request_batch=search_request_batch,
        )

    async def search_matrix_offsets(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_matrix_request: m.SearchMatrixRequest = None,
    ) -> m.InlineResponse20027:
        """
        Compute distance matrix for sampled points with an offset based output format
        """
        return await self._build_for_search_matrix_offsets(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_matrix_request=search_matrix_request,
        )

    async def search_matrix_pairs(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_matrix_request: m.SearchMatrixRequest = None,
    ) -> m.InlineResponse20026:
        """
        Compute distance matrix for sampled points with a pair based output format
        """
        return await self._build_for_search_matrix_pairs(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_matrix_request=search_matrix_request,
        )

    async def search_point_groups(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_groups_request: m.SearchGroupsRequest = None,
    ) -> m.InlineResponse20021:
        """
        Retrieve closest points based on vector similarity and given filtering conditions, grouped by a given payload field
        """
        return await self._build_for_search_point_groups(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_groups_request=search_groups_request,
        )

    async def search_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_request: m.SearchRequest = None,
    ) -> m.InlineResponse20019:
        """
        Retrieve closest points based on vector similarity and given filtering conditions
        """
        return await self._build_for_search_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_request=search_request,
        )


class SyncSearchApi(_SearchApi):
    def discover_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        discover_request_batch: m.DiscoverRequestBatch = None,
    ) -> m.InlineResponse20020:
        """
        Look for points based on target and/or positive and negative example pairs, in batch.
        """
        return self._build_for_discover_batch_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            discover_request_batch=discover_request_batch,
        )

    def discover_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        discover_request: m.DiscoverRequest = None,
    ) -> m.InlineResponse20019:
        """
        Use context and a target to find the most similar points to the target, constrained by the context. When using only the context (without a target), a special search - called context search - is performed where pairs of points are used to generate a loss that guides the search towards the zone where most positive examples overlap. This means that the score minimizes the scenario of finding a point closer to a negative than to a positive part of a pair. Since the score of a context relates to loss, the maximum score a point can get is 0.0, and it becomes normal that many points can have a score of 0.0. When using target (with or without context), the score behaves a little different: The integer part of the score represents the rank with respect to the context, while the decimal part of the score relates to the distance to the target. The context part of the score for each pair is calculated +1 if the point is closer to a positive than to a negative part of a pair, and -1 otherwise.
        """
        return self._build_for_discover_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            discover_request=discover_request,
        )

    def query_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        query_request_batch: m.QueryRequestBatch = None,
    ) -> m.InlineResponse20025:
        """
        Universally query points in batch. This endpoint covers all capabilities of search, recommend, discover, filters. But also enables hybrid and multi-stage queries.
        """
        return self._build_for_query_batch_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            query_request_batch=query_request_batch,
        )

    def query_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        query_request: m.QueryRequest = None,
    ) -> m.InlineResponse20024:
        """
        Universally query points. This endpoint covers all capabilities of search, recommend, discover, filters. But also enables hybrid and multi-stage queries.
        """
        return self._build_for_query_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            query_request=query_request,
        )

    def query_points_groups(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        query_groups_request: m.QueryGroupsRequest = None,
    ) -> m.InlineResponse20021:
        """
        Universally query points, grouped by a given payload field
        """
        return self._build_for_query_points_groups(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            query_groups_request=query_groups_request,
        )

    def recommend_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        recommend_request_batch: m.RecommendRequestBatch = None,
    ) -> m.InlineResponse20020:
        """
        Look for the points which are closer to stored positive examples and at the same time further to negative examples.
        """
        return self._build_for_recommend_batch_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            recommend_request_batch=recommend_request_batch,
        )

    def recommend_point_groups(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        recommend_groups_request: m.RecommendGroupsRequest = None,
    ) -> m.InlineResponse20021:
        """
        Look for the points which are closer to stored positive examples and at the same time further to negative examples, grouped by a given payload field.
        """
        return self._build_for_recommend_point_groups(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            recommend_groups_request=recommend_groups_request,
        )

    def recommend_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        recommend_request: m.RecommendRequest = None,
    ) -> m.InlineResponse20019:
        """
        Look for the points which are closer to stored positive examples and at the same time further to negative examples.
        """
        return self._build_for_recommend_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            recommend_request=recommend_request,
        )

    def search_batch_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_request_batch: m.SearchRequestBatch = None,
    ) -> m.InlineResponse20020:
        """
        Retrieve by batch the closest points based on vector similarity and given filtering conditions
        """
        return self._build_for_search_batch_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_request_batch=search_request_batch,
        )

    def search_matrix_offsets(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_matrix_request: m.SearchMatrixRequest = None,
    ) -> m.InlineResponse20027:
        """
        Compute distance matrix for sampled points with an offset based output format
        """
        return self._build_for_search_matrix_offsets(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_matrix_request=search_matrix_request,
        )

    def search_matrix_pairs(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_matrix_request: m.SearchMatrixRequest = None,
    ) -> m.InlineResponse20026:
        """
        Compute distance matrix for sampled points with a pair based output format
        """
        return self._build_for_search_matrix_pairs(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_matrix_request=search_matrix_request,
        )

    def search_point_groups(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_groups_request: m.SearchGroupsRequest = None,
    ) -> m.InlineResponse20021:
        """
        Retrieve closest points based on vector similarity and given filtering conditions, grouped by a given payload field
        """
        return self._build_for_search_point_groups(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_groups_request=search_groups_request,
        )

    def search_points(
        self,
        collection_name: str,
        consistency: m.ReadConsistency = None,
        timeout: int = None,
        search_request: m.SearchRequest = None,
    ) -> m.InlineResponse20019:
        """
        Retrieve closest points based on vector similarity and given filtering conditions
        """
        return self._build_for_search_points(
            collection_name=collection_name,
            consistency=consistency,
            timeout=timeout,
            search_request=search_request,
        )
