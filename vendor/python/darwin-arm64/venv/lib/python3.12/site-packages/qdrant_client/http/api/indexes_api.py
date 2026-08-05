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


class _IndexesApi:
    def __init__(self, api_client: "Union[ApiClient, AsyncApiClient]"):
        self.api_client = api_client

    def _build_for_create_field_index(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        create_field_index: m.CreateFieldIndex = None,
    ):
        """
        Create index for field in collection
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
        body = jsonable_encoder(create_field_index)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2007,
            method="PUT",
            url="/collections/{collection_name}/index",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
            content=body,
        )

    def _build_for_delete_field_index(
        self,
        collection_name: str,
        field_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
    ):
        """
        Delete field index for collection
        """
        path_params = {
            "collection_name": str(collection_name),
            "field_name": str(field_name),
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
            url="/collections/{collection_name}/index/{field_name}",
            headers=headers if headers else None,
            path_params=path_params,
            params=query_params,
        )


class AsyncIndexesApi(_IndexesApi):
    async def create_field_index(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        create_field_index: m.CreateFieldIndex = None,
    ) -> m.InlineResponse2007:
        """
        Create index for field in collection
        """
        return await self._build_for_create_field_index(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            create_field_index=create_field_index,
        )

    async def delete_field_index(
        self,
        collection_name: str,
        field_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
    ) -> m.InlineResponse2007:
        """
        Delete field index for collection
        """
        return await self._build_for_delete_field_index(
            collection_name=collection_name,
            field_name=field_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
        )


class SyncIndexesApi(_IndexesApi):
    def create_field_index(
        self,
        collection_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
        create_field_index: m.CreateFieldIndex = None,
    ) -> m.InlineResponse2007:
        """
        Create index for field in collection
        """
        return self._build_for_create_field_index(
            collection_name=collection_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
            create_field_index=create_field_index,
        )

    def delete_field_index(
        self,
        collection_name: str,
        field_name: str,
        wait: bool = None,
        ordering: WriteOrdering = None,
        timeout: int = None,
    ) -> m.InlineResponse2007:
        """
        Delete field index for collection
        """
        return self._build_for_delete_field_index(
            collection_name=collection_name,
            field_name=field_name,
            wait=wait,
            ordering=ordering,
            timeout=timeout,
        )
