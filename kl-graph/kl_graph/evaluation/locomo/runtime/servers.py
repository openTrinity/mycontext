"""Start one unmodified production KL server per selected conversation graph."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from kl_graph.evaluation.io import atomic_write_json
from kl_graph.evaluation.locomo.build import (
    CASE_DATA_DIRNAME,
    PROJECT_ROOT,
    case_environment,
    resolve_case_root,
)

ROUTES_ENV = "KL_LOCOMO_ROUTES"
SERVER_START_TIMEOUT = 90.0


class ProductionGraphServers:
    """Context manager for case-local production servers and their route table."""

    def __init__(
        self,
        case_set_root: Path,
        cases: list[dict[str, Any]],
        artifact_dir: Path,
        *,
        startup_timeout: float = SERVER_START_TIMEOUT,
    ):
        if not cases:
            raise ValueError("at least one LoCoMo conversation graph is required")
        self.case_set_root = case_set_root
        self.cases = cases
        self.artifact_dir = artifact_dir
        self.startup_timeout = startup_timeout
        self.routes_path = artifact_dir / "server_routes.json"
        self.processes: list[subprocess.Popen] = []
        self._prior_routes: str | None = None

    def __enter__(self) -> ProductionGraphServers:  # noqa: PYI034
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def start(self) -> None:
        if self.processes:
            return
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        routes: dict[str, dict[str, object]] = {}
        try:
            for case in self.cases:
                case_root = resolve_case_root(self.case_set_root, case)
                data_dir = case_root / CASE_DATA_DIRNAME
                conversation_id = str(case["conversation_id"])
                if not (data_dir / "knowledge.db").is_file():
                    raise FileNotFoundError(
                        f"conversation graph has not been built: {data_dir}"
                    )
                port = _free_port()
                env = case_environment(os.environ, self.case_set_root, case)
                env["KL_SERVER_PORT"] = str(port)
                log_path = self.artifact_dir / f"{_safe_stem(conversation_id)}.log"
                log_stream = log_path.open("w", encoding="utf-8")
                process = subprocess.Popen(
                    [sys.executable, str(PROJECT_ROOT / "kl_server.py")],
                    cwd=PROJECT_ROOT,
                    env=env,
                    stdout=log_stream,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                # Popen owns the duplicated descriptor; the parent need not retain it.
                log_stream.close()
                self.processes.append(process)
                _wait_for_server(process, port, log_path, self.startup_timeout)
                routes[conversation_id] = {
                    "port": port,
                    "pid": process.pid,
                }
            atomic_write_json(
                self.routes_path,
                {"schema_version": 1, "routes": routes},
            )
            self._prior_routes = os.environ.get(ROUTES_ENV)
            os.environ[ROUTES_ENV] = str(self.routes_path.resolve())
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        for process in reversed(self.processes):
            _stop_server(process)
        self.processes.clear()
        if self._prior_routes is None:
            os.environ.pop(ROUTES_ENV, None)
        else:
            os.environ[ROUTES_ENV] = self._prior_routes


def route_port(conversation_id: str, routes_path: Path | None = None) -> int:
    configured = os.environ.get(ROUTES_ENV)
    if routes_path is None and not configured:
        raise RuntimeError(f"{ROUTES_ENV} is not configured")
    path = routes_path or Path(str(configured))
    value = json.loads(path.read_text(encoding="utf-8"))
    routes = value.get("routes") if isinstance(value, dict) else None
    route = routes.get(conversation_id) if isinstance(routes, dict) else None
    if not isinstance(route, dict) or not isinstance(route.get("port"), int):
        raise KeyError(f"no production graph route for {conversation_id}")
    return int(route["port"])


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_server(
    process: subprocess.Popen,
    port: int,
    log_path: Path,
    timeout: float,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"KL server exited {process.returncode}; see {log_path}")
        try:
            response = httpx.get(f"http://127.0.0.1:{port}/health", timeout=1)
            if response.json().get("status") == "ok":
                return
        except (httpx.HTTPError, json.JSONDecodeError):
            pass
        time.sleep(0.25)
    raise TimeoutError(f"KL server startup timed out; see {log_path}")


def _stop_server(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _safe_stem(value: str) -> str:
    return "".join(character if character.isalnum() else "_" for character in value)
