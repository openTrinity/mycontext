"""Server-port configuration at the CLI boundary."""

from __future__ import annotations

from pathlib import Path

from click.testing import CliRunner

import kl_cli


def test_config_file_selects_client_port(tmp_path: Path, monkeypatch) -> None:
    override = tmp_path / "port.yaml"
    override.write_text("server:\n  port: 8300\n", encoding="utf-8")
    monkeypatch.setattr(kl_cli, "_check_server_running", lambda: False)
    monkeypatch.setattr(kl_cli, "_check_embedding_server", lambda: False)
    monkeypatch.setattr(kl_cli, "_detect_gpus", lambda: [])
    original_port = kl_cli.KL_SERVER_PORT

    try:
        result = CliRunner().invoke(
            kl_cli.cli, ["--config", str(override), "status"]
        )

        assert result.exit_code == 0
        assert "port 8300" in result.output
    finally:
        kl_cli.config_module.cfg = kl_cli.config_module._build_config()
        kl_cli.config_module.DATA_DIR = kl_cli.config_module._derive_data_dir(
            kl_cli.config_module.cfg
        )
        kl_cli._set_server_port(original_port)


def test_global_port_option_selects_client_port(monkeypatch) -> None:
    monkeypatch.setattr(kl_cli, "_check_server_running", lambda: False)
    monkeypatch.setattr(kl_cli, "_check_embedding_server", lambda: False)
    monkeypatch.setattr(kl_cli, "_detect_gpus", lambda: [])
    original_port = kl_cli.KL_SERVER_PORT

    try:
        result = CliRunner().invoke(kl_cli.cli, ["--port", "8301", "status"])

        assert result.exit_code == 0
        assert "port 8301" in result.output
        assert kl_cli.KL_SERVER_URL == "http://127.0.0.1:8301"
    finally:
        kl_cli._set_server_port(original_port)
