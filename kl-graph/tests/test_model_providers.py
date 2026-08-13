"""Provider-aware model routing."""

from __future__ import annotations

from types import SimpleNamespace

from kl_graph.utils.litellm_config import (
    connection_from_service,
    litellm_base_url,
    provider_api_key,
    provider_model,
)


def test_provider_model_adds_prefix_once() -> None:
    assert provider_model("anthropic", "flash") == "anthropic/flash"
    assert provider_model("anthropic", "anthropic/flash") == "anthropic/flash"
    assert provider_model("", "custom/flash") == "custom/flash"


def test_provider_api_key_preserves_legacy_anthropic_env(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "legacy-key")

    assert provider_api_key("anthropic") == "legacy-key"
    assert provider_api_key("openai") is None
    assert provider_api_key("openai", "explicit-key") == "explicit-key"


def test_litellm_base_url_appends_missing_v1() -> None:
    # The OpenAI transport treats base_url as the API root and appends only
    # /chat/completions, so the /v1 segment must be part of the base URL.
    assert (
        litellm_base_url("openai", "https://api.example.com/base")
        == "https://api.example.com/base/v1"
    )


def test_litellm_base_url_keeps_single_v1() -> None:
    assert (
        litellm_base_url("openai", "https://api.example.com/base/v1")
        == "https://api.example.com/base/v1"
    )


def test_litellm_base_url_collapses_doubled_v1() -> None:
    # The desktop launcher used to append /v1 to an already-versioned URL,
    # producing /v1/v1 and the same 404 as a missing segment.
    assert (
        litellm_base_url("openai", "https://api.example.com/base/v1/v1")
        == "https://api.example.com/base/v1"
    )
    assert (
        litellm_base_url("openai", "http://localhost:8000/v1/v1/v1/")
        == "http://localhost:8000/v1"
    )


def test_litellm_base_url_normalizes_trailing_slash() -> None:
    assert litellm_base_url("openai", "http://localhost:8000/") == "http://localhost:8000/v1"
    assert litellm_base_url("openai", "  http://localhost:8000/v1/  ") == "http://localhost:8000/v1"


def test_litellm_base_url_strips_v1_from_anthropic() -> None:
    # Anthropic transport appends /v1/messages itself; a pasted versioned URL
    # would double the segment (POST /v1/v1/messages -> 404, observed live),
    # so any trailing /v1 run is stripped down to the bare host.
    assert litellm_base_url("anthropic", "https://gateway.example.com") == "https://gateway.example.com"
    assert litellm_base_url("Anthropic", "https://gateway.example.com/") == "https://gateway.example.com"
    assert litellm_base_url("anthropic", "https://gateway.example.com/v1") == "https://gateway.example.com"
    assert litellm_base_url("anthropic", "https://gateway.example.com/v1/v1/") == "https://gateway.example.com"


def test_litellm_base_url_empty_passthrough() -> None:
    # Empty keeps provider/litellm defaults in charge.
    assert litellm_base_url("openai", "") == ""
    assert litellm_base_url("anthropic", "") == ""

def test_connection_from_service_normalizes_openai_base() -> None:
    service = SimpleNamespace(
        provider="openai",
        model="qwen-plus",
        base_url="https://api.example.com/base/v1/v1",
        timeout=120,
    )
    connection = connection_from_service(service, api_key="k")

    assert connection.model == "openai/qwen-plus"
    assert connection.base_url == "https://api.example.com/base/v1"
    assert connection.api_key == "k"


def test_connection_from_service_preserves_anthropic_base() -> None:
    service = SimpleNamespace(
        provider="anthropic",
        model="qwen3.7-flash",
        base_url="https://gateway.example.com",
        timeout=60,
    )
    connection = connection_from_service(service, api_key="k")

    assert connection.base_url == "https://gateway.example.com"


def test_connection_from_service_strips_versioned_anthropic_base() -> None:
    # A user pasting the OpenAI-style versioned URL must not break the
    # anthropic transport.
    service = SimpleNamespace(
        provider="anthropic",
        model="qwen3.7-flash",
        base_url="https://gateway.example.com/v1",
        timeout=60,
    )
    connection = connection_from_service(service, api_key="k")

    assert connection.base_url == "https://gateway.example.com"
