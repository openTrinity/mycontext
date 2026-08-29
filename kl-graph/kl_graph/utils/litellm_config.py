"""Shared LLM transport configuration（不再依赖 litellm）。

历史文件名保留：调用方大量 ``from kl_graph.utils.litellm_config import …``。
``litellm`` 名字现在指向 ``http_llm`` 兼容模块。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any

from kl_graph.utils import http_llm as litellm

# Trailing runs of the OpenAI version segment, e.g. the doubled suffix a
# caller produces when it appends /v1 to a base URL that already ends in /v1.
_TRAILING_V1_RUN = re.compile(r"(/v1)+$")


@dataclass(frozen=True)
class LLMConnection:
    """Provider-neutral connection settings shared by LLM consumers."""

    provider: str
    model: str
    base_url: str
    timeout: float
    api_key: str | None


def provider_model(provider: str, model: str) -> str:
    """Return a provider/model identifier without duplicating its provider."""
    provider = provider.strip().rstrip("/")
    if not provider or model.startswith(f"{provider}/"):
        return model
    return f"{provider}/{model}"


def provider_api_key(provider: str, explicit: str | None = None) -> str | None:
    """Resolve legacy Anthropic auth while letting other providers use the key env."""
    if explicit:
        return explicit
    if provider.strip().lower() == "anthropic":
        return os.environ.get("ANTHROPIC_AUTH_TOKEN") or None
    return None


def litellm_base_url(provider: str, base_url: str) -> str:
    """Normalize a base URL to the shape each transport expects.

    - **OpenAI-compatible** — client appends ``/chat/completions`` /
      ``/embeddings``; base must end in **exactly one** ``/v1``.
    - **Anthropic** — we append ``/v1/messages`` ourselves; base must be a
      **bare host** (no trailing ``/v1``).

    Empty values pass through.
    """
    url = (base_url or "").strip().rstrip("/")
    if not url:
        return url
    if provider.strip().lower() == "anthropic":
        return _TRAILING_V1_RUN.sub("", url)
    url = _TRAILING_V1_RUN.sub("/v1", url)
    return url if url.endswith("/v1") else f"{url}/v1"


# 新名字：与实现一致；旧名 ``litellm_base_url`` 保留作别名。
api_base_url = litellm_base_url


def connection_from_service(service: Any, api_key: str | None = None) -> LLMConnection:
    """Build immutable transport settings from a typed/OmegaConf service block."""
    provider = str(service.provider)
    return LLMConnection(
        provider=provider,
        model=provider_model(provider, str(service.model)),
        base_url=litellm_base_url(provider, str(service.base_url or "")),
        timeout=float(service.timeout),
        api_key=provider_api_key(provider, api_key),
    )


__all__ = [
    "LLMConnection",
    "api_base_url",
    "connection_from_service",
    "litellm",
    "litellm_base_url",
    "provider_api_key",
    "provider_model",
]
