"""Shared LiteLLM transport configuration."""

import os
import re
from dataclasses import dataclass
from typing import Any

import litellm

# Trailing runs of the OpenAI version segment, e.g. the doubled suffix a
# caller produces when it appends /v1 to a base URL that already ends in /v1.
_TRAILING_V1_RUN = re.compile(r"(/v1)+$")


# httpx tolerates non-ASCII gateway response headers that break aiohttp.
litellm.disable_aiohttp_transport = True


@dataclass(frozen=True)
class LLMConnection:
    """Provider-neutral connection settings shared by LLM consumers."""

    provider: str
    model: str
    base_url: str
    timeout: float
    api_key: str | None

def provider_model(provider: str, model: str) -> str:
    """Return a LiteLLM model identifier without duplicating its provider."""
    provider = provider.strip().rstrip("/")
    if not provider or model.startswith(f"{provider}/"):
        return model
    return f"{provider}/{model}"


def provider_api_key(provider: str, explicit: str | None = None) -> str | None:
    """Resolve legacy Anthropic auth while letting other providers use LiteLLM."""
    if explicit:
        return explicit
    if provider.strip().lower() == "anthropic":
        return os.environ.get("ANTHROPIC_AUTH_TOKEN") or None
    return None


def litellm_base_url(provider: str, base_url: str) -> str:
    """Normalize a base URL to the shape litellm's transport for it expects.

    Both litellm transports treat the configured base URL as a root and
    append the endpoint path, but they disagree about where the ``/v1``
    segment lives, so the same gateway URL pasted by a user works for one
    transport and 404s on the other unless normalized:

    - **OpenAI-compatible** — the SDK hands ``base_url`` to the OpenAI
      client, whose own default root is ``https://api.openai.com/v1``; the
      client appends only ``/chat/completions`` / ``/embeddings``. The base
      must therefore end in **exactly one** ``/v1``: missing → gateway 404
      (e.g. DashScope serves only ``…/compatible-mode/v1/...``); doubled
      (``…/v1/v1``, produced by a launcher that appends /v1 to an
      already-versioned URL) 404s identically.
    - **Anthropic** — litellm appends ``/v1/messages`` itself, so the base
      must be a **bare host**: a pasted versioned URL doubles the segment
      (``POST /v1/v1/messages`` → 404, observed live).

    Empty values pass through so provider/litellm defaults still apply.

    Args:
        provider: LiteLLM provider name from config (e.g. ``openai``).
        base_url: Configured endpoint base URL, possibly empty.

    Returns:
        The base URL safe to pass as ``api_base`` for that provider.
    """
    url = (base_url or "").strip().rstrip("/")
    if not url:
        return url
    if provider.strip().lower() == "anthropic":
        return _TRAILING_V1_RUN.sub("", url)
    url = _TRAILING_V1_RUN.sub("/v1", url)
    return url if url.endswith("/v1") else f"{url}/v1"


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
    "connection_from_service",
    "litellm",
    "litellm_base_url",
    "provider_api_key",
    "provider_model",
]
