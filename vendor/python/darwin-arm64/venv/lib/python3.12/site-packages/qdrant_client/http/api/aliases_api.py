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


class _AliasesApi:
    def __init__(self, api_client: "Union[ApiClient, AsyncApiClient]"):
        self.api_client = api_client

    def _build_for_get_collection_aliases(
        self,
        collection_name: str,
    ):
        """
        Get list of all aliases for a collection
        """
        path_params = {
            "collection_name": str(collection_name),
        }

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse20011,
            method="GET",
            url="/collections/{collection_name}/aliases",
            headers=headers if headers else None,
            path_params=path_params,
        )

    def _build_for_get_collections_aliases(
        self,
    ):
        """
        Get list of all existing collections aliases
        """
        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse20011,
            method="GET",
            url="/aliases",
            headers=headers if headers else None,
        )

    def _build_for_update_aliases(
        self,
        timeout: int = None,
        change_aliases_operation: m.ChangeAliasesOperation = None,
    ):
        query_params = {}
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        body = jsonable_encoder(change_aliases_operation)
        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return self.api_client.request(
            type_=m.InlineResponse2001,
            method="POST",
            url="/collections/aliases",
            headers=headers if headers else None,
            params=query_params,
            content=body,
        )


class AsyncAliasesApi(_AliasesApi):
    async def get_collection_aliases(
        self,
        collection_name: str,
    ) -> m.InlineResponse20011:
        """
        Get list of all aliases for a collection
        """
        return await self._build_for_get_collection_aliases(
            collection_name=collection_name,
        )

    async def get_collections_aliases(
        self,
    ) -> m.InlineResponse20011:
        """
        Get list of all existing collections aliases
        """
        return await self._build_for_get_collections_aliases()

    async def update_aliases(
        self,
        timeout: int = None,
        change_aliases_operation: m.ChangeAliasesOperation = None,
    ) -> m.InlineResponse2001:
        return await self._build_for_update_aliases(
            timeout=timeout,
            change_aliases_operation=change_aliases_operation,
        )


class SyncAliasesApi(_AliasesApi):
    def get_collection_aliases(
        self,
        collection_name: str,
    ) -> m.InlineResponse20011:
        """
        Get list of all aliases for a collection
        """
        return self._build_for_get_collection_aliases(
            collection_name=collection_name,
        )

    def get_collections_aliases(
        self,
    ) -> m.InlineResponse20011:
        """
        Get list of all existing collections aliases
        """
        return self._build_for_get_collections_aliases()

    def update_aliases(
        self,
        timeout: int = None,
        change_aliases_operation: m.ChangeAliasesOperation = None,
    ) -> m.InlineResponse2001:
        return self._build_for_update_aliases(
            timeout=timeout,
            change_aliases_operation=change_aliases_operation,
        )
