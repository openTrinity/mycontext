"""Atomic run artifacts, event transcripts, and per-Codex KL wrappers."""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

class TranscriptWriter:
    """Stream one Codex turn to a case-local JSONL transcript."""

    def __init__(self, path: Path):
        self.path = path
        self.partial_path = path.with_suffix(path.suffix + ".partial")
        self.partial_path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self.partial_path.open("w", encoding="utf-8")

    def write(self, record_type: str, **values: Any) -> None:
        row = {
            "record_type": record_type,
            "timestamp": datetime.now().astimezone().isoformat(),
            **values,
        }
        self._handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        self._handle.flush()

    def write_event(self, event: Any) -> None:
        payload = event.payload
        if hasattr(payload, "model_dump"):
            payload = payload.model_dump(mode="json", by_alias=True)
        elif hasattr(payload, "params"):
            payload = payload.params
        self.write("codex_event", method=event.method, payload=payload)

    def close(self) -> None:
        if self._handle.closed:
            return
        self._handle.close()
        os.replace(self.partial_path, self.path)

    def __enter__(self) -> TranscriptWriter:  # noqa: PYI034
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()


def create_agent_workspace(
    work_root: Path,
    case_stem: str,
    real_kl_path: Path,
    max_kl_calls: int | None,
    scope_id: str,
    scoped_cli_module: str,
    skill_path: Path | None = None,
) -> Path:
    """Create an isolated cwd with budget and hidden-scope enforcement."""
    work_root.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix=f"{case_stem}.", dir=work_root))
    wrapper = workspace / "kl"
    wrapper.write_text(
        _wrapper_source(
            real_kl_path.resolve(), max_kl_calls, scope_id, scoped_cli_module
        ),
        encoding="utf-8",
    )
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR)
    if skill_path is not None:
        runtime_skill = workspace / ".agents" / "skills" / "kl" / "SKILL.md"
        runtime_skill.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(skill_path, runtime_skill)
    return workspace


def preserve_tool_log(workspace: Path, destination: Path) -> dict[str, int]:
    """Move the wrapper log into run artifacts and return call counters."""
    source = workspace / "kl_calls.jsonl"
    destination.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    if source.is_file():
        for line in source.read_text(encoding="utf-8").splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                rows.append(value)
        os.replace(source, destination)
    used = sum(1 for row in rows if row.get("allowed") is True)
    denied = sum(1 for row in rows if row.get("allowed") is False)
    return {"used": used, "denied": denied}


def remove_agent_workspace(workspace: Path) -> None:
    shutil.rmtree(workspace)


def _wrapper_source(
    real_kl_path: Path,
    max_kl_calls: int | None,
    scope_id: str,
    scoped_cli_module: str,
) -> str:
    """Build a self-contained Python executable without shell interpolation."""
    return f'''#!/usr/bin/env python3
import fcntl
import json
import os
import sys
from datetime import datetime
from pathlib import Path

REAL_KL = {str(real_kl_path)!r}
MAX_CALLS = {max_kl_calls!r}
SCOPE_ID = {scope_id!r}
SCOPED_CLI_MODULE = {scoped_cli_module!r}
ROOT = Path(__file__).resolve().parent
STATE = ROOT / ".kl_budget"
LOG = ROOT / "kl_calls.jsonl"

with STATE.open("a+", encoding="utf-8") as state:
    fcntl.flock(state.fileno(), fcntl.LOCK_EX)
    state.seek(0)
    raw = state.read().strip()
    used = int(raw) if raw else 0
    allowed = MAX_CALLS is None or used < MAX_CALLS
    if allowed:
        used += 1
        state.seek(0)
        state.truncate()
        state.write(str(used))
        state.flush()
    with LOG.open("a", encoding="utf-8") as log:
        log.write(json.dumps({{
            "timestamp": datetime.now().astimezone().isoformat(),
            "args": sys.argv[1:],
            "allowed": allowed,
            "calls_used": used,
            "max_kl_calls": MAX_CALLS,
        }}, ensure_ascii=False) + "\\n")

if not allowed:
    print(json.dumps({{
        "error": "KL tool call budget exhausted",
        "calls_used": used,
        "max_kl_calls": MAX_CALLS,
        "instruction": "Stop retrieving and answer from evidence already seen.",
    }}, ensure_ascii=False))
    raise SystemExit(0)

project_root = Path(REAL_KL).parent
python = project_root / ".venv" / "bin" / "python"
env = os.environ.copy()
prior_pythonpath = env.get("PYTHONPATH", "")
env["PYTHONPATH"] = (
    str(project_root) + (os.pathsep + prior_pythonpath if prior_pythonpath else "")
)
os.execve(
    python,
    [
        str(python),
        "-m",
        SCOPED_CLI_MODULE,
        SCOPE_ID,
        "--",
        *sys.argv[1:],
    ],
    env,
)
'''
