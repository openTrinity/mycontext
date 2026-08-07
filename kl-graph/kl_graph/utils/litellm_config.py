"""Shared LiteLLM transport configuration."""

import os

import litellm

# httpx tolerates non-ASCII gateway response headers that break aiohttp.
litellm.disable_aiohttp_transport = True

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


__all__ = ["litellm", "provider_api_key", "provider_model"]
