from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from typing import AsyncIterator, Awaitable, Callable, Iterator

from httpx import Request, Response

_context_headers: ContextVar[dict[str, str]] = ContextVar("_context_headers", default={})


def get_context_headers() -> dict[str, str]:
    return _context_headers.get()


@contextmanager
def headers(extra_headers: dict[str, str]) -> Iterator[None]:
    current = _context_headers.get()
    merged = {**current, **extra_headers}
    token = _context_headers.set(merged)
    try:
        yield
    finally:
        _context_headers.reset(token)


@asynccontextmanager
async def async_headers(extra_headers: dict[str, str]) -> AsyncIterator[None]:
    current = _context_headers.get()
    merged = {**current, **extra_headers}
    token = _context_headers.set(merged)
    try:
        yield
    finally:
        _context_headers.reset(token)


def rest_headers_middleware(request: Request, call_next: Callable[[Request], Response]) -> Response:
    for key, value in get_context_headers().items():
        request.headers[key] = value
    return call_next(request)


async def async_rest_headers_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    for key, value in get_context_headers().items():
        request.headers[key] = value
    return await call_next(request)
