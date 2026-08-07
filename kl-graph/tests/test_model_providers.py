"""Provider-aware model routing."""

from __future__ import annotations

from kl_graph.utils.litellm_config import provider_api_key, provider_model


def test_provider_model_adds_prefix_once() -> None:
    assert provider_model("anthropic", "flash") == "anthropic/flash"
    assert provider_model("anthropic", "anthropic/flash") == "anthropic/flash"
    assert provider_model("", "custom/flash") == "custom/flash"


def test_provider_api_key_preserves_legacy_anthropic_env(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "legacy-key")

    assert provider_api_key("anthropic") == "legacy-key"
    assert provider_api_key("openai") is None
    assert provider_api_key("openai", "explicit-key") == "explicit-key"
