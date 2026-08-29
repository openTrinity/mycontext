"""OpenAI / Anthropic 兼容 HTTP 客户端（替代 litellm）。

调用方仍通过 ``kl_graph.utils.litellm_config.litellm`` 拿到本模块，
保留 ``acompletion`` / ``embedding`` / 异常类名，减少改调用点的面。
"""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ─── 异常类（名称对齐旧 litellm，供 llm_extractor 分类）────────────────


class _LlmError(Exception):
    """兼容旧 litellm 构造参数（``llm_provider`` / ``model`` 等可忽略关键字）。"""

    def __init__(
        self,
        message: str = "",
        *,
        status_code: int | None = None,
        headers: dict | None = None,
        **_kwargs: Any,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.headers = headers or {}


class RateLimitError(_LlmError):
    def __init__(
        self,
        message: str = "",
        *,
        status_code: int = 429,
        headers: dict | None = None,
        **kwargs: Any,
    ):
        super().__init__(message, status_code=status_code, headers=headers, **kwargs)


class APIConnectionError(_LlmError):
    def __init__(
        self,
        message: str = "",
        *,
        status_code: int | None = None,
        **kwargs: Any,
    ):
        super().__init__(message, status_code=status_code, **kwargs)


class Timeout(_LlmError):
    def __init__(self, message: str = "", *, status_code: int = 408, **kwargs: Any):
        super().__init__(message, status_code=status_code, **kwargs)


APITimeoutError = Timeout


class AuthenticationError(_LlmError):
    def __init__(self, message: str = "", *, status_code: int = 401, **kwargs: Any):
        super().__init__(message, status_code=status_code, **kwargs)


class BadRequestError(_LlmError):
    def __init__(self, message: str = "", *, status_code: int = 400, **kwargs: Any):
        super().__init__(message, status_code=status_code, **kwargs)


class ContextWindowExceededError(BadRequestError):
    """上下文超长（旧 litellm 名；归类为永久失败）。"""


class ContentPolicyViolationError(BadRequestError):
    """内容策略拒绝（旧 litellm 名；归类为永久失败）。"""


class PermissionDeniedError(_LlmError):
    def __init__(self, message: str = "", *, status_code: int = 403, **kwargs: Any):
        super().__init__(message, status_code=status_code, **kwargs)


class NotFoundError(_LlmError):
    def __init__(self, message: str = "", *, status_code: int = 404, **kwargs: Any):
        super().__init__(message, status_code=status_code, **kwargs)


class ServiceUnavailableError(_LlmError):
    def __init__(self, message: str = "", *, status_code: int = 503, **kwargs: Any):
        super().__init__(message, status_code=status_code, **kwargs)


class InternalServerError(_LlmError):
    def __init__(self, message: str = "", *, status_code: int = 500, **kwargs: Any):
        super().__init__(message, status_code=status_code, **kwargs)

def _ns(**kwargs: Any) -> SimpleNamespace:
    return SimpleNamespace(**kwargs)


def _split_model(model: str) -> tuple[str, str]:
    raw = (model or "").strip()
    if "/" in raw:
        provider, name = raw.split("/", 1)
        return provider.strip().lower(), name.strip()
    return "openai", raw


def _raise_for_status(resp: httpx.Response) -> None:
    status = resp.status_code
    text = (resp.text or "").strip()
    if not text:
        # 本机 llama / 部分网关会回空 body 的 503；空串会让 UI 变成「未知错误」。
        text = f"HTTP {status}"
    text = text[:500]
    headers = {k.lower(): v for k, v in resp.headers.items()}
    lower = text.lower()
    if status == 401:
        raise AuthenticationError(text, status_code=status)
    if status == 403:
        raise PermissionDeniedError(text, status_code=status)
    if status == 404:
        raise NotFoundError(text, status_code=status)
    if status == 400 or status == 422:
        if (
            "exceed_context_size" in lower
            or "exceeds the available context" in lower
            or ("context" in lower and ("length" in lower or "window" in lower or "too long" in lower))
        ):
            raise ContextWindowExceededError(text, status_code=status)
        if "content" in lower and ("policy" in lower or "filter" in lower or "safety" in lower):
            raise ContentPolicyViolationError(text, status_code=status)
        raise BadRequestError(text, status_code=status)
    if status == 429:
        raise RateLimitError(text, status_code=status, headers=headers)
    if status == 408:
        raise Timeout(text, status_code=status)
    if status == 503:
        raise ServiceUnavailableError(text, status_code=status)
    if status >= 500:
        raise InternalServerError(text, status_code=status)
    if status >= 400:
        raise BadRequestError(text, status_code=status)


def _usage_from(data: dict) -> SimpleNamespace:
    usage = data.get("usage") or {}
    return _ns(
        prompt_tokens=int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
        completion_tokens=int(
            usage.get("completion_tokens") or usage.get("output_tokens") or 0
        ),
        total_tokens=int(usage.get("total_tokens") or 0),
    )


def _openai_chat_response(data: dict) -> SimpleNamespace:
    choices = []
    for ch in data.get("choices") or []:
        msg = ch.get("message") or {}
        choices.append(
            _ns(
                message=_ns(content=msg.get("content") or "", role=msg.get("role") or "assistant"),
                finish_reason=ch.get("finish_reason"),
            )
        )
    if not choices:
        choices = [_ns(message=_ns(content="", role="assistant"), finish_reason=None)]
    return _ns(choices=choices, usage=_usage_from(data), model=data.get("model"), raw=data)


def _anthropic_chat_response(data: dict) -> SimpleNamespace:
    parts = data.get("content") or []
    texts: list[str] = []
    for part in parts:
        if isinstance(part, dict) and part.get("type") == "text":
            texts.append(str(part.get("text") or ""))
        elif isinstance(part, str):
            texts.append(part)
    content = "".join(texts)
    usage_raw = data.get("usage") or {}
    usage = _ns(
        prompt_tokens=int(usage_raw.get("input_tokens") or 0),
        completion_tokens=int(usage_raw.get("output_tokens") or 0),
        total_tokens=int(usage_raw.get("input_tokens") or 0)
        + int(usage_raw.get("output_tokens") or 0),
    )
    return _ns(
        choices=[_ns(message=_ns(content=content, role="assistant"), finish_reason=data.get("stop_reason"))],
        usage=usage,
        model=data.get("model"),
        raw=data,
    )


def _embedding_response(data: dict) -> SimpleNamespace:
    items = []
    for row in data.get("data") or []:
        # litellm 调用方有时用 dict 下标：`d["embedding"]`
        emb = row.get("embedding") if isinstance(row, dict) else None
        items.append({"embedding": emb, "index": row.get("index", 0)})
    return _ns(data=items, usage=_usage_from(data), model=data.get("model"), raw=data)


def _timeout_value(timeout: float | None) -> float:
    if timeout is None:
        return 60.0
    return float(timeout)


def _is_loopback_api_base(api_base: str) -> bool:
    raw = (api_base or "").strip()
    if raw == "":
        return False
    try:
        from urllib.parse import urlparse

        host = urlparse(raw if "://" in raw else f"http://{raw}").hostname or ""
    except Exception:  # noqa: BLE001
        return False
    return host in {"127.0.0.1", "localhost", "::1"}


def _httpx_client(api_base: str, timeout: float, *, is_async: bool = False):
    """Build httpx client; never route loopback LLM/embed via system proxy.

    macOS ``urllib.getproxies()`` often yields ``http://127.0.0.1:8080`` (Clash
    etc.). httpx ``trust_env=True`` (default) then proxies ``127.0.0.1:8020``
    through it → empty HTTP 503 / ``ServiceUnavailableError('')``. urllib's
    direct connect still works, which is why probes looked fine.
    """
    kwargs: dict[str, Any] = {"timeout": timeout}
    if _is_loopback_api_base(api_base):
        kwargs["trust_env"] = False
    return httpx.AsyncClient(**kwargs) if is_async else httpx.Client(**kwargs)


def _timeout_error(exc: BaseException, *, timeout: float, url: str) -> Timeout:
    """Attach budget + URL; bare httpx message is often just ``timed out``."""
    detail = str(exc).strip() or type(exc).__name__
    return Timeout(f"timed out after {timeout:g}s calling {url}: {detail}")


def _build_openai_chat_body(kwargs: dict, wire_model: str) -> dict:
    body: dict[str, Any] = {
        "model": wire_model,
        "messages": kwargs.get("messages") or [],
    }
    for key in ("temperature", "max_tokens", "top_p", "stop", "response_format"):
        if key in kwargs and kwargs[key] is not None:
            body[key] = kwargs[key]
    extra = kwargs.get("extra_body")
    if isinstance(extra, dict):
        body.update(extra)
    return body


def _build_anthropic_body(kwargs: dict, wire_model: str) -> dict:
    messages = list(kwargs.get("messages") or [])
    system_parts: list[str] = []
    converted: list[dict] = []
    for msg in messages:
        role = (msg.get("role") if isinstance(msg, dict) else None) or "user"
        content = msg.get("content") if isinstance(msg, dict) else ""
        if role == "system":
            system_parts.append(str(content or ""))
            continue
        if role not in ("user", "assistant"):
            role = "user"
        converted.append({"role": role, "content": str(content or "")})
    body: dict[str, Any] = {
        "model": wire_model,
        "messages": converted or [{"role": "user", "content": ""}],
        "max_tokens": int(kwargs.get("max_tokens") or 4096),
    }
    if system_parts:
        body["system"] = "\n\n".join(system_parts)
    if kwargs.get("temperature") is not None:
        body["temperature"] = kwargs["temperature"]
    return body


def _chat_url(provider: str, api_base: str) -> str:
    base = (api_base or "").rstrip("/")
    if provider == "anthropic":
        return f"{base}/v1/messages"
    return f"{base}/chat/completions"


def _embed_url(api_base: str) -> str:
    return f"{(api_base or '').rstrip('/')}/embeddings"


def _headers(provider: str, api_key: str | None) -> dict[str, str]:
    key = (api_key or "").strip() or "not-needed"
    if provider == "anthropic":
        return {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        }
    return {
        "content-type": "application/json",
        "authorization": f"Bearer {key}",
    }


def completion(**kwargs: Any) -> SimpleNamespace:
    """同步 chat completion（OpenAI 或 Anthropic）。"""
    provider, wire_model = _split_model(str(kwargs.get("model") or ""))
    api_base = str(kwargs.get("api_base") or kwargs.get("base_url") or "")
    api_key = kwargs.get("api_key")
    timeout = _timeout_value(kwargs.get("timeout"))
    url = _chat_url(provider, api_base)
    headers = _headers(provider, api_key if isinstance(api_key, str) else None)
    body = (
        _build_anthropic_body(kwargs, wire_model)
        if provider == "anthropic"
        else _build_openai_chat_body(kwargs, wire_model)
    )
    try:
        with _httpx_client(api_base, timeout) as client:
            resp = client.post(url, headers=headers, content=json.dumps(body))
    except httpx.TimeoutException as exc:
        raise _timeout_error(exc, timeout=timeout, url=url) from exc
    except httpx.HTTPError as exc:
        raise APIConnectionError(str(exc)) from exc
    _raise_for_status(resp)
    data = resp.json()
    return _anthropic_chat_response(data) if provider == "anthropic" else _openai_chat_response(data)


async def acompletion(**kwargs: Any) -> SimpleNamespace:
    """异步 chat completion。"""
    provider, wire_model = _split_model(str(kwargs.get("model") or ""))
    api_base = str(kwargs.get("api_base") or kwargs.get("base_url") or "")
    api_key = kwargs.get("api_key")
    timeout = _timeout_value(kwargs.get("timeout"))
    url = _chat_url(provider, api_base)
    headers = _headers(provider, api_key if isinstance(api_key, str) else None)
    body = (
        _build_anthropic_body(kwargs, wire_model)
        if provider == "anthropic"
        else _build_openai_chat_body(kwargs, wire_model)
    )
    try:
        async with _httpx_client(api_base, timeout, is_async=True) as client:
            resp = await client.post(url, headers=headers, content=json.dumps(body))
    except httpx.TimeoutException as exc:
        raise _timeout_error(exc, timeout=timeout, url=url) from exc
    except httpx.HTTPError as exc:
        raise APIConnectionError(str(exc)) from exc
    _raise_for_status(resp)
    data = resp.json()
    return _anthropic_chat_response(data) if provider == "anthropic" else _openai_chat_response(data)


def embedding(**kwargs: Any) -> SimpleNamespace:
    """同步 embeddings（始终 OpenAI 兼容）。"""
    _provider, wire_model = _split_model(str(kwargs.get("model") or ""))
    # embedding 强制走 OpenAI 兼容路径（与旧 embedder 注释一致）
    if wire_model.startswith("openai/"):
        wire_model = wire_model[len("openai/") :]
    api_base = str(kwargs.get("api_base") or kwargs.get("base_url") or "")
    api_key = kwargs.get("api_key")
    timeout = _timeout_value(kwargs.get("timeout"))
    body: dict[str, Any] = {
        "model": wire_model,
        "input": kwargs.get("input"),
        "encoding_format": kwargs.get("encoding_format") or "float",
    }
    extra = kwargs.get("extra_body")
    if isinstance(extra, dict):
        body.update(extra)
    url = _embed_url(api_base)
    headers = _headers("openai", api_key if isinstance(api_key, str) else None)
    try:
        with _httpx_client(api_base, timeout) as client:
            resp = client.post(url, headers=headers, content=json.dumps(body))
    except httpx.TimeoutException as exc:
        raise _timeout_error(exc, timeout=timeout, url=url) from exc
    except httpx.HTTPError as exc:
        raise APIConnectionError(str(exc)) from exc
    _raise_for_status(resp)
    return _embedding_response(resp.json())


async def aembedding(**kwargs: Any) -> SimpleNamespace:
    _provider, wire_model = _split_model(str(kwargs.get("model") or ""))
    if wire_model.startswith("openai/"):
        wire_model = wire_model[len("openai/") :]
    api_base = str(kwargs.get("api_base") or kwargs.get("base_url") or "")
    api_key = kwargs.get("api_key")
    timeout = _timeout_value(kwargs.get("timeout"))
    body: dict[str, Any] = {
        "model": wire_model,
        "input": kwargs.get("input"),
        "encoding_format": kwargs.get("encoding_format") or "float",
    }
    extra = kwargs.get("extra_body")
    if isinstance(extra, dict):
        body.update(extra)
    url = _embed_url(api_base)
    headers = _headers("openai", api_key if isinstance(api_key, str) else None)
    try:
        async with _httpx_client(api_base, timeout, is_async=True) as client:
            resp = await client.post(url, headers=headers, content=json.dumps(body))
    except httpx.TimeoutException as exc:
        raise _timeout_error(exc, timeout=timeout, url=url) from exc
    except httpx.HTTPError as exc:
        raise APIConnectionError(str(exc)) from exc
    _raise_for_status(resp)
    return _embedding_response(resp.json())


def completion_cost(_response: Any = None, **_kwargs: Any) -> float:
    """成本估算：无定价表时返回 0（调用方只用于统计展示）。"""
    return 0.0


# 旧代码偶发引用；保持 no-op 以免 import 失败
disable_aiohttp_transport = True

__all__ = [
    "APIConnectionError",
    "APITimeoutError",
    "AuthenticationError",
    "BadRequestError",
    "ContentPolicyViolationError",
    "ContextWindowExceededError",
    "InternalServerError",
    "NotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
    "ServiceUnavailableError",
    "Timeout",
    "acompletion",
    "aembedding",
    "completion",
    "completion_cost",
    "disable_aiohttp_transport",
    "embedding",
]
