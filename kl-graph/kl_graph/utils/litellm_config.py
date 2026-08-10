"""Shared LiteLLM transport configuration."""

import os
from dataclasses import dataclass
from typing import Any

import litellm

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


def connection_from_service(service: Any, api_key: str | None = None) -> LLMConnection:
    """Build immutable transport settings from a typed/OmegaConf service block."""
    provider = str(service.provider)
    return LLMConnection(
        provider=provider,
        model=provider_model(provider, str(service.model)),
        base_url=str(service.base_url or ""),
        timeout=float(service.timeout),
        api_key=provider_api_key(provider, api_key),
    )


__all__ = [
    "LLMConnection",
    "connection_from_service",
    "litellm",
    "provider_api_key",
    "provider_model",
]
