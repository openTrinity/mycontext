"""CLI tests for `kl global-search` (U3 of the global-search design).

No network, no real ``dws`` binary: ``kl_cli._server_request`` and
``kl_cli.subprocess.run`` are monkeypatched. Covers request-JSON construction
(including explicit ``--user`` precedence), DWS identity resolution success
and failure modes, no-data rendering, and happy-path rendering.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import click
import pytest
from click.testing import CliRunner

# Ensure project root is on the path for imports.
sys.path.insert(0, str(Path(__file__).parent.parent))

import kl_cli

# Real DWS `contact user get-self --format json` payload (verified against
# the live binary): an outer {"result": [...], "success": true} envelope.
DWS_OK_STDOUT = json.dumps(
    {"result": [{"orgEmployeeModel": {"orgUserName": "孟允之"}}], "success": True},
    ensure_ascii=False,
)
# Legacy bare-list shape: what an older/inaccurate parser+fixture assumed.
DWS_LEGACY_BARE_LIST_STDOUT = json.dumps(
    [{"orgEmployeeModel": {"orgUserName": "孟允之"}}], ensure_ascii=False
)

NO_DATA_ANSWER = (
    "I am sorry but I am unable to answer this question given the provided data."
)


def _ok_response(**overrides) -> dict:
    """Happy-path response matching the frozen POST /global_search contract."""
    resp = {
        "answer": "最近你主要在做沙箱安全评审 [Data: Communities (L1-12, L2-3)]",
        "user": "孟允之",
        "entity_id": "ent-abc",
        "reason": "ok",
        "communities": [
            {"level": "L1", "community_id": 12, "member_count": 41},
            {"level": "L2", "community_id": 3, "member_count": 17},
        ],
        "citations": ["L1-12", "L2-3"],
        "diagnostics": {
            "summaries_selected": 2,
            "map_calls": 1,
            "map_batches_ok": 1,
            "points_total": 6,
            "points_kept": 5,
            "latency_ms": 6200,
        },
        "latency_ms": 6200,
    }
    resp.update(overrides)
    return resp


class _CaptureRequest:
    """Stand-in for kl_cli._server_request recording call args."""

    def __init__(self, response: dict | None = None) -> None:
        self.response = response if response is not None else _ok_response()
        self.calls: list[tuple[str, str, dict]] = []

    def __call__(self, method: str, endpoint: str, **kwargs) -> dict:
        self.calls.append((method, endpoint, kwargs))
        return self.response

    @property
    def body(self) -> dict:
        return self.calls[-1][2]["json"]


def _dws_run(stdout: str = DWS_OK_STDOUT, returncode: int = 0):
    """Fake subprocess.run returning a DWS result; records call args/kwargs."""

    calls: list[tuple[tuple, dict]] = []

    def run(*args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args[0], returncode, stdout=stdout, stderr="")

    run.calls = calls
    return run


@pytest.fixture()
def runner() -> CliRunner:
    return CliRunner()


# ── Request construction ─────────────────────────────────────────────────────


def test_explicit_user_wins_and_dws_not_called(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    """--user is sent as-is and the DWS CLI is never invoked."""
    capture = _CaptureRequest()
    monkeypatch.setattr(kl_cli, "_server_request", capture)

    def _boom(*args, **kwargs):
        raise AssertionError("subprocess.run must not be called when --user is given")

    monkeypatch.setattr(kl_cli.subprocess, "run", _boom)

    result = runner.invoke(
        kl_cli.cli, ["global-search", "我最近的任务是什么", "--user", "傅书言"]
    )
    assert result.exit_code == 0, result.output
    method, endpoint, _ = capture.calls[0]
    assert method == "POST"
    assert endpoint == "/global_search"
    assert capture.body == {"query": "我最近的任务是什么", "user": "傅书言"}


def test_dws_success_sends_org_username(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without --user, dws get-self's orgUserName is sent as user."""
    capture = _CaptureRequest()
    monkeypatch.setattr(kl_cli, "_server_request", capture)
    dws_run = _dws_run()
    monkeypatch.setattr(kl_cli.subprocess, "run", dws_run)

    result = runner.invoke(kl_cli.cli, ["global-search", "我最近的任务是什么"])
    assert result.exit_code == 0, result.output
    assert capture.body == {"query": "我最近的任务是什么", "user": "孟允之"}
    # Subprocess contract: exact DWS argv and the 30s timeout.
    args, kwargs = dws_run.calls[0]
    assert args[0] == ["dws", "contact", "user", "get-self", "--format", "json"]
    assert kwargs["timeout"] == 30


# ── DWS failure modes → loud ClickException, no server request ──────────────────


@pytest.mark.parametrize(
    "run_stub, expected_msg",
    [
        pytest.param(
            lambda *a, **kw: (_ for _ in ()).throw(FileNotFoundError("dws")),
            "dws CLI not found",
            id="dws-missing",
        ),
        pytest.param(
            lambda *a, **kw: (_ for _ in ()).throw(
                subprocess.TimeoutExpired(cmd="dws", timeout=30)
            ),
            "timed out",
            id="dws-timeout",
        ),
        pytest.param(_dws_run(returncode=1), "exited with code 1", id="dws-nonzero-exit"),
        pytest.param(_dws_run(stdout="not json at all"), "non-JSON", id="dws-bad-json"),
        pytest.param(_dws_run(stdout="[]"), "missing result", id="dws-empty-list"),
        pytest.param(
            _dws_run(stdout=json.dumps({"unexpected": True})),
            "missing result",
            id="dws-bad-shape",
        ),
        pytest.param(
            _dws_run(stdout=DWS_LEGACY_BARE_LIST_STDOUT),
            "missing result",
            id="dws-legacy-bare-list-shape",
        ),
        pytest.param(
            _dws_run(
                stdout=json.dumps(
                    {
                        "result": [{"orgEmployeeModel": {"orgUserName": ""}}],
                        "success": True,
                    },
                    ensure_ascii=False,
                )
            ),
            "blank orgUserName",
            id="dws-blank-name",
        ),
    ],
)
def test_dws_failure_raises_loudly_without_server_request(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch, run_stub, expected_msg
) -> None:
    """Any dws get-self failure aborts with a clear error and never hits the server."""
    capture = _CaptureRequest()
    monkeypatch.setattr(kl_cli, "_server_request", capture)
    monkeypatch.setattr(kl_cli.subprocess, "run", run_stub)

    result = runner.invoke(kl_cli.cli, ["global-search", "我最近的任务是什么"])
    assert result.exit_code != 0
    assert expected_msg in result.output
    assert capture.calls == []


# ── Rendering ────────────────────────────────────────────────────────────────


def test_no_data_response_renders_readable_note(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    """reason != 'ok' → canned answer plus a clear note and remediation hint."""
    monkeypatch.setattr(kl_cli.subprocess, "run", _dws_run())
    monkeypatch.setattr(
        kl_cli,
        "_server_request",
        _CaptureRequest(
            _ok_response(
                answer=NO_DATA_ANSWER,
                reason="no_communities",
                entity_id=None,
                communities=[],
                citations=[],
                diagnostics={
                    "hint": "run `scripts.improve` + `scripts/embed_communities.py`"
                },
                latency_ms=3.0,
            )
        ),
    )

    result = runner.invoke(kl_cli.cli, ["global-search", "我最近的任务是什么"])
    assert result.exit_code == 0, result.output
    assert NO_DATA_ANSWER in result.output
    assert "no_communities" in result.output
    assert "no data:" in result.output
    assert "remediation:" in result.output


def test_happy_path_rendering(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Markdown answer first; resolved user, communities, citations, latency."""
    monkeypatch.setattr(kl_cli.subprocess, "run", _dws_run())
    monkeypatch.setattr(kl_cli, "_server_request", _CaptureRequest(_ok_response()))

    result = runner.invoke(kl_cli.cli, ["global-search", "我最近的任务是什么"])
    assert result.exit_code == 0, result.output
    assert result.output.index("最近你主要在做沙箱安全评审") < result.output.index(
        "[ok]"
    ), "answer must render before the metadata block"
    assert "user: 孟允之 (entity: ent-abc)" in result.output
    assert "communities: 2 selected" in result.output
    assert "L1-12 (41 members)" in result.output
    assert "citations: L1-12, L2-3" in result.output
    assert "6200ms" in result.output


def test_json_output_flag_echoes_raw_response(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(kl_cli.subprocess, "run", _dws_run())
    response = _ok_response()
    monkeypatch.setattr(kl_cli, "_server_request", _CaptureRequest(response))

    result = runner.invoke(kl_cli.cli, ["global-search", "任务", "--json"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == response


def test_server_error_translates_to_click_error(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Server-side failures surface via _server_request's ClickException."""
    monkeypatch.setattr(kl_cli.subprocess, "run", _dws_run())

    def _fail(*args, **kwargs):
        raise click.ClickException("kl-server not running. Start it with: kl start")

    monkeypatch.setattr(kl_cli, "_server_request", _fail)

    result = runner.invoke(kl_cli.cli, ["global-search", "我最近的任务是什么"])
    assert result.exit_code == 1
    assert "kl-server not running" in result.output
