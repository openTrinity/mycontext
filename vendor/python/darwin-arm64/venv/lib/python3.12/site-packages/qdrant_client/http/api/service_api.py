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


class _ServiceApi:
    def __init__(self, api_client: "Union[ApiClient, AsyncApiClient]"):
        self.api_client = api_client

    def _build_for_healthz(
        self,
    ):
        """
        An endpoint for health checking used in Kubernetes.
        """
        headers = {}
        return self.api_client.request(
            type_=str,
            method="GET",
            url="/healthz",
            headers=headers if headers else None,
        )

    def _build_for_livez(
        self,
    ):
        """
        An endpoint for health checking used in Kubernetes.
        """
        headers = {}
        return self.api_client.request(
            type_=str,
            method="GET",
            url="/livez",
            headers=headers if headers else None,
        )

    def _build_for_metrics(
        self,
        anonymize: bool = None,
        per_collection: bool = None,
        timeout: int = None,
    ):
        """
        Collect metrics data including app info, collections info, cluster info and statistics
        """
        query_params = {}
        if anonymize is not None:
            query_params["anonymize"] = str(anonymize).lower()
        if per_collection is not None:
            query_params["per_collection"] = str(per_collection).lower()
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        return self.api_client.request(
            type_=str,
            method="GET",
            url="/metrics",
            headers=headers if headers else None,
            params=query_params,
        )

    def _build_for_readyz(
        self,
    ):
        """
        An endpoint for health checking used in Kubernetes.
        """
        headers = {}
        return self.api_client.request(
            type_=str,
            method="GET",
            url="/readyz",
            headers=headers if headers else None,
        )

    def _build_for_root(
        self,
    ):
        """
        Returns information about the running Qdrant instance like version and commit id
        """
        headers = {}
        return self.api_client.request(
            type_=m.VersionInfo,
            method="GET",
            url="/",
            headers=headers if headers else None,
        )

    def _build_for_telemetry(
        self,
        anonymize: bool = None,
        details_level: int = None,
        per_collection: bool = None,
        timeout: int = None,
    ):
        """
        Collect telemetry data including app info, system info, collections info, cluster info, configs and statistics
        """
        query_params = {}
        if anonymize is not None:
            query_params["anonymize"] = str(anonymize).lower()
        if details_level is not None:
            query_params["details_level"] = str(details_level)
        if per_collection is not None:
            query_params["per_collection"] = str(per_collection).lower()
        if timeout is not None:
            query_params["timeout"] = str(timeout)

        headers = {}
        return self.api_client.request(
            type_=m.InlineResponse2002,
            method="GET",
            url="/telemetry",
            headers=headers if headers else None,
            params=query_params,
        )


class AsyncServiceApi(_ServiceApi):
    async def healthz(
        self,
    ) -> str:
        """
        An endpoint for health checking used in Kubernetes.
        """
        return await self._build_for_healthz()

    async def livez(
        self,
    ) -> str:
        """
        An endpoint for health checking used in Kubernetes.
        """
        return await self._build_for_livez()

    async def metrics(
        self,
        anonymize: bool = None,
        per_collection: bool = None,
        timeout: int = None,
    ) -> str:
        """
        Collect metrics data including app info, collections info, cluster info and statistics
        """
        return await self._build_for_metrics(
            anonymize=anonymize,
            per_collection=per_collection,
            timeout=timeout,
        )

    async def readyz(
        self,
    ) -> str:
        """
        An endpoint for health checking used in Kubernetes.
        """
        return await self._build_for_readyz()

    async def root(
        self,
    ) -> m.VersionInfo:
        """
        Returns information about the running Qdrant instance like version and commit id
        """
        return await self._build_for_root()

    async def telemetry(
        self,
        anonymize: bool = None,
        details_level: int = None,
        per_collection: bool = None,
        timeout: int = None,
    ) -> m.InlineResponse2002:
        """
        Collect telemetry data including app info, system info, collections info, cluster info, configs and statistics
        """
        return await self._build_for_telemetry(
            anonymize=anonymize,
            details_level=details_level,
            per_collection=per_collection,
            timeout=timeout,
        )


class SyncServiceApi(_ServiceApi):
    def healthz(
        self,
    ) -> str:
        """
        An endpoint for health checking used in Kubernetes.
        """
        return self._build_for_healthz()

    def livez(
        self,
    ) -> str:
        """
        An endpoint for health checking used in Kubernetes.
        """
        return self._build_for_livez()

    def metrics(
        self,
        anonymize: bool = None,
        per_collection: bool = None,
        timeout: int = None,
    ) -> str:
        """
        Collect metrics data including app info, collections info, cluster info and statistics
        """
        return self._build_for_metrics(
            anonymize=anonymize,
            per_collection=per_collection,
            timeout=timeout,
        )

    def readyz(
        self,
    ) -> str:
        """
        An endpoint for health checking used in Kubernetes.
        """
        return self._build_for_readyz()

    def root(
        self,
    ) -> m.VersionInfo:
        """
        Returns information about the running Qdrant instance like version and commit id
        """
        return self._build_for_root()

    def telemetry(
        self,
        anonymize: bool = None,
        details_level: int = None,
        per_collection: bool = None,
        timeout: int = None,
    ) -> m.InlineResponse2002:
        """
        Collect telemetry data including app info, system info, collections info, cluster info, configs and statistics
        """
        return self._build_for_telemetry(
            anonymize=anonymize,
            details_level=details_level,
            per_collection=per_collection,
            timeout=timeout,
        )
