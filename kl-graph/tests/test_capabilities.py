"""Dynamic server/CLI capability discovery."""

from __future__ import annotations

import asyncio
import json

from click.testing import CliRunner

import kl_cli
import kl_server


def test_server_capabilities_hide_experimental_communities(monkeypatch) -> None:
    server_state = kl_server.ServerState()
    server_state.ready = True
    monkeypatch.setattr(kl_server, "state", server_state)
    monkeypatch.setattr(kl_server, "COMMUNITIES_ENABLED", False)

    result = asyncio.run(kl_server.get_capabilities())

    assert result["commands"]["ask"]["enabled"] is True
    assert result["commands"]["global-search"] == {
        "enabled": False,
        "experimental": True,
        "reason": "communities_disabled",
    }
    assert "communities" not in result["commands"]["search"]["collections"]


def test_server_capabilities_expose_enabled_communities(monkeypatch) -> None:
    server_state = kl_server.ServerState()
    server_state.ready = True
    monkeypatch.setattr(kl_server, "state", server_state)
    monkeypatch.setattr(kl_server, "COMMUNITIES_ENABLED", True)

    result = asyncio.run(kl_server.get_capabilities())

    assert result["commands"]["global-search"]["enabled"] is True
    assert "communities" in result["commands"]["search"]["collections"]


def test_cli_capabilities_json_is_machine_readable(monkeypatch) -> None:
    payload = {
        "schema_version": 1,
        "features": {"communities": {"enabled": False, "experimental": True}},
        "commands": {"ask": {"enabled": True}},
    }
    monkeypatch.setattr(kl_cli, "_server_request", lambda *_args, **_kwargs: payload)

    result = CliRunner().invoke(kl_cli.cli, ["capabilities", "--json"])

    assert result.exit_code == 0
    assert json.loads(result.output) == payload
