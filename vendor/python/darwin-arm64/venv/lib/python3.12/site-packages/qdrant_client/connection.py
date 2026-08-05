import asyncio
import collections
from typing import Any, Awaitable, Callable

import grpc

from qdrant_client.common.client_exceptions import ResourceExhaustedResponse
from qdrant_client.common.client_warnings import show_warning_once
from qdrant_client.context_headers import get_context_headers


# type: ignore # noqa: F401
# Source <https://github.com/grpc/grpc/blob/master/examples/python/interceptors/headers/generic_client_interceptor.py>
class _GenericClientInterceptor(
    grpc.UnaryUnaryClientInterceptor,
    grpc.UnaryStreamClientInterceptor,
    grpc.StreamUnaryClientInterceptor,
    grpc.StreamStreamClientInterceptor,
):
    def __init__(self, interceptor_function: Callable):
        self._fn = interceptor_function

    def intercept_unary_unary(
        self, continuation: Any, client_call_details: Any, request: Any
    ) -> Any:
        new_details, new_request_iterator, postprocess = self._fn(
            client_call_details, iter((request,)), False, False
        )
        response = continuation(new_details, next(new_request_iterator))
        return postprocess(response) if postprocess else response

    def intercept_unary_stream(
        self, continuation: Any, client_call_details: Any, request: Any
    ) -> Any:
        new_details, new_request_iterator, postprocess = self._fn(
            client_call_details, iter((request,)), False, True
        )
        response_it = continuation(new_details, next(new_request_iterator))
        return postprocess(response_it) if postprocess else response_it

    def intercept_stream_unary(
        self, continuation: Any, client_call_details: Any, request_iterator: Any
    ) -> Any:
        new_details, new_request_iterator, postprocess = self._fn(
            client_call_details, request_iterator, True, False
        )
        response = continuation(new_details, new_request_iterator)
        return postprocess(response) if postprocess else response

    def intercept_stream_stream(
        self, continuation: Any, client_call_details: Any, request_iterator: Any
    ) -> Any:
        new_details, new_request_iterator, postprocess = self._fn(
            client_call_details, request_iterator, True, True
        )
        response_it = continuation(new_details, new_request_iterator)
        return postprocess(response_it) if postprocess else response_it


class _GenericAsyncClientInterceptor(
    grpc.aio.UnaryUnaryClientInterceptor,
    grpc.aio.UnaryStreamClientInterceptor,
    grpc.aio.StreamUnaryClientInterceptor,
    grpc.aio.StreamStreamClientInterceptor,
):
    def __init__(self, interceptor_function: Callable):
        self._fn = interceptor_function

    async def intercept_unary_unary(
        self, continuation: Any, client_call_details: Any, request: Any
    ) -> Any:
        new_details, new_request_iterator, postprocess = await self._fn(
            client_call_details, iter((request,)), False, False
        )
        next_request = next(new_request_iterator)
        response = await continuation(new_details, next_request)
        return await postprocess(response) if postprocess else response

    async def intercept_unary_stream(
        self, continuation: Any, client_call_details: Any, request: Any
    ) -> Any:
        new_details, new_request_iterator, postprocess = await self._fn(
            client_call_details, iter((request,)), False, True
        )
        response_it = await continuation(new_details, next(new_request_iterator))
        return await postprocess(response_it) if postprocess else response_it

    async def intercept_stream_unary(
        self, continuation: Any, client_call_details: Any, request_iterator: Any
    ) -> Any:
        new_details, new_request_iterator, postprocess = await self._fn(
            client_call_details, request_iterator, True, False
        )
        response = await continuation(new_details, new_request_iterator)
        return await postprocess(response) if postprocess else response

    async def intercept_stream_stream(
        self, continuation: Any, client_call_details: Any, request_iterator: Any
    ) -> Any:
        new_details, new_request_iterator, postprocess = await self._fn(
            client_call_details, request_iterator, True, True
        )
        response_it = await continuation(new_details, new_request_iterator)
        return await postprocess(response_it) if postprocess else response_it


def create_generic_client_interceptor(intercept_call: Any) -> _GenericClientInterceptor:
    return _GenericClientInterceptor(intercept_call)


def create_generic_async_client_interceptor(
    intercept_call: Any,
) -> _GenericAsyncClientInterceptor:
    return _GenericAsyncClientInterceptor(intercept_call)


# Source:
# <https://github.com/grpc/grpc/blob/master/examples/python/interceptors/headers/header_manipulator_client_interceptor.py>
class _ClientCallDetails(
    collections.namedtuple("_ClientCallDetails", ("method", "timeout", "metadata", "credentials")),
    grpc.ClientCallDetails,
):
    pass


class _ClientAsyncCallDetails(
    collections.namedtuple("_ClientCallDetails", ("method", "timeout", "metadata", "credentials")),
    grpc.aio.ClientCallDetails,
):
    pass


def header_adder_interceptor(
    new_metadata: list[tuple[str, str]],
    auth_token_provider: Callable[[], str] | None = None,
) -> _GenericClientInterceptor:
    def process_response(response: Any) -> Any:
        if response.code() == grpc.StatusCode.RESOURCE_EXHAUSTED:
            retry_after = None
            for item in response.trailing_metadata():
                if item.key == "retry-after":
                    try:
                        retry_after = int(item.value)
                    except Exception:
                        retry_after = None
                    break
            reason_phrase = response.details() if response.details() else ""
            if retry_after:
                raise ResourceExhaustedResponse(message=reason_phrase, retry_after_s=retry_after)
        return response

    def intercept_call(
        client_call_details: _ClientCallDetails,
        request_iterator: Any,
        _request_streaming: Any,
        _response_streaming: Any,
    ) -> tuple[_ClientCallDetails, Any, Any]:
        metadata = []

        if client_call_details.metadata is not None:
            metadata = list(client_call_details.metadata)
        for header, value in new_metadata:
            metadata.append(
                (
                    header,
                    value,
                )
            )

        if auth_token_provider:
            if not asyncio.iscoroutinefunction(auth_token_provider):
                metadata.append(("authorization", f"Bearer {auth_token_provider()}"))
            else:
                raise ValueError("Synchronous channel requires synchronous auth token provider.")

        for key, value in get_context_headers().items():
            metadata.append((key, value))

        client_call_details = _ClientCallDetails(
            client_call_details.method,
            client_call_details.timeout,
            metadata,
            client_call_details.credentials,
        )
        return client_call_details, request_iterator, process_response

    return create_generic_client_interceptor(intercept_call)


def header_adder_async_interceptor(
    new_metadata: list[tuple[str, str]],
    auth_token_provider: Callable[[], str] | Callable[[], Awaitable[str]] | None = None,
) -> _GenericAsyncClientInterceptor:
    async def process_response(call: Any) -> Any:
        try:
            return await call
        except grpc.aio.AioRpcError as er:
            if er.code() == grpc.StatusCode.RESOURCE_EXHAUSTED:
                retry_after = None
                for item in er.trailing_metadata():
                    if item[0] == "retry-after":
                        try:
                            retry_after = int(item[1])
                        except Exception:
                            retry_after = None
                        break
                reason_phrase = er.details() if er.details() else ""
                if retry_after:
                    raise ResourceExhaustedResponse(
                        message=reason_phrase, retry_after_s=retry_after
                    ) from er
            raise

    async def intercept_call(
        client_call_details: grpc.aio.ClientCallDetails,
        request_iterator: Any,
        _request_streaming: Any,
        _response_streaming: Any,
    ) -> tuple[_ClientAsyncCallDetails, Any, Any]:
        metadata = []
        if client_call_details.metadata is not None:
            metadata = list(client_call_details.metadata)
        for header, value in new_metadata:
            metadata.append(
                (
                    header,
                    value,
                )
            )

        if auth_token_provider:
            if asyncio.iscoroutinefunction(auth_token_provider):
                token = await auth_token_provider()
            else:
                token = auth_token_provider()
            metadata.append(("authorization", f"Bearer {token}"))

        for key, value in get_context_headers().items():
            metadata.append((key, value))

        client_call_details = client_call_details._replace(metadata=metadata)
        return client_call_details, request_iterator, process_response

    return create_generic_async_client_interceptor(intercept_call)


def parse_channel_options(options: dict[str, Any] | None = None) -> list[tuple[str, Any]]:
    default_options: list[tuple[str, Any]] = [
        ("grpc.max_send_message_length", -1),
        ("grpc.max_receive_message_length", -1),
    ]

    if options is None:
        return default_options

    _options = [(option_name, option_value) for option_name, option_value in options.items()]
    for option_name, option_value in default_options:
        if option_name not in options:
            _options.append((option_name, option_value))

    return _options


def parse_ssl_credentials(options: dict[str, Any] | None = None) -> dict[str, bytes | None]:
    """Parse ssl credentials to create `grpc.ssl_channel_credentials` for `grpc.secure_channel`

    WARN: Directly modifies input `options`

    Return:
        dict[str, Optional[bytes]]: dict(root_certificates=..., private_key=..., certificate_chain=...)
    """
    ssl_options: dict[str, bytes | None] = dict(
        root_certificates=None, private_key=None, certificate_chain=None
    )

    if options is None:
        return ssl_options

    for ssl_option_name in ssl_options:
        option_value: Any = options.pop(ssl_option_name, None)
        if f"grpc.{ssl_option_name}" in options:
            show_warning_once(
                f"`{ssl_option_name}` is supposed to be used without `grpc.` prefix",
                idx=f"grpc.{ssl_option_name}",
                stacklevel=10,
            )

        if option_value is None:
            continue

        if not isinstance(option_value, bytes):
            raise TypeError(f"{ssl_option_name} must be a byte string")

        ssl_options[ssl_option_name] = option_value

    return ssl_options


def get_channel(
    host: str,
    port: int,
    ssl: bool,
    metadata: list[tuple[str, str]] | None = None,
    options: dict[str, Any] | None = None,
    compression: grpc.Compression | None = None,
    auth_token_provider: Callable[[], str] | None = None,
) -> grpc.Channel:
    # Parse gRPC client options
    _copied_options = (
        options.copy() if options is not None else None
    )  # we're changing options inplace
    _ssl_cred_options = parse_ssl_credentials(_copied_options)
    _options = parse_channel_options(_copied_options)
    metadata_interceptor = header_adder_interceptor(
        new_metadata=metadata or [], auth_token_provider=auth_token_provider
    )

    if ssl:
        ssl_creds = grpc.ssl_channel_credentials(**_ssl_cred_options)
        channel = grpc.secure_channel(f"{host}:{port}", ssl_creds, _options, compression)
        return grpc.intercept_channel(channel, metadata_interceptor)
    else:
        channel = grpc.insecure_channel(f"{host}:{port}", _options, compression)
        return grpc.intercept_channel(channel, metadata_interceptor)


def get_async_channel(
    host: str,
    port: int,
    ssl: bool,
    metadata: list[tuple[str, str]] | None = None,
    options: dict[str, Any] | None = None,
    compression: grpc.Compression | None = None,
    auth_token_provider: Callable[[], str] | Callable[[], Awaitable[str]] | None = None,
) -> grpc.aio.Channel:
    # Parse gRPC client options
    _copied_options = (
        options.copy() if options is not None else None
    )  # we're changing options inplace
    _ssl_cred_options = parse_ssl_credentials(_copied_options)
    _options = parse_channel_options(_copied_options)

    # Create metadata interceptor
    metadata_interceptor = header_adder_async_interceptor(
        new_metadata=metadata or [], auth_token_provider=auth_token_provider
    )

    if ssl:
        ssl_creds = grpc.ssl_channel_credentials(**_ssl_cred_options)
        return grpc.aio.secure_channel(
            f"{host}:{port}",
            ssl_creds,
            _options,
            compression,
            interceptors=[metadata_interceptor],
        )
    else:
        return grpc.aio.insecure_channel(
            f"{host}:{port}", _options, compression, interceptors=[metadata_interceptor]
        )
