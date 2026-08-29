"""http_llm：本机 URL 不得走系统代理（否则 macOS 代理口回空 503）。"""

from __future__ import annotations

from kl_graph.utils.http_llm import _httpx_client, _is_loopback_api_base


def test_loopback_detection() -> None:
    assert _is_loopback_api_base("http://127.0.0.1:8020/v1") is True
    assert _is_loopback_api_base("http://localhost:8020/v1") is True
    assert _is_loopback_api_base("https://api.example.com/v1") is False


def test_loopback_client_disables_trust_env() -> None:
    with _httpx_client("http://127.0.0.1:8020/v1", 30.0) as client:
        assert client._trust_env is False  # noqa: SLF001 — 契约：本机禁用代理


def test_remote_client_keeps_trust_env_default() -> None:
    with _httpx_client("https://api.example.com/v1", 30.0) as client:
        assert client._trust_env is True  # noqa: SLF001
