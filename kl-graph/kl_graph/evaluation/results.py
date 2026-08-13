"""Persist completed evaluation scores in a small shared SQLite registry."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import uuid
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from omegaconf import DictConfig, OmegaConf

BackendName = Literal["kl_graph", "khoj", "ragflow"]

_SCHEMA_VERSION = 1
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_REVISION_ENV = {
    "khoj": "KHOJ_REVISION",
    "ragflow": "RAGFLOW_REVISION",
}
_SENSITIVE_KEYS = {"api_key", "authorization", "password", "secret", "token"}
_SENSITIVE_SUFFIXES = (
    "_access_token",
    "_api_key",
    "_auth_token",
    "_password",
    "_secret",
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    benchmark TEXT NOT NULL,
    backend TEXT NOT NULL,
    backend_version TEXT NOT NULL,
    git_commit TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    config_sha256 TEXT NOT NULL,
    resolved_config_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    artifact_dir TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_results (
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    question_type TEXT,
    recall_k INTEGER,
    recall_at_k REAL,
    qa_score REAL,
    details_json TEXT NOT NULL,
    PRIMARY KEY (run_id, question_id)
);

CREATE INDEX IF NOT EXISTS runs_comparison
    ON runs(benchmark, backend, source_sha256, created_at);
CREATE INDEX IF NOT EXISTS case_results_question
    ON case_results(question_id, run_id);
"""


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): (
                "<redacted>"
                if str(key).lower() in _SENSITIVE_KEYS
                or str(key).lower().endswith(_SENSITIVE_SUFFIXES)
                else _redact(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _config_snapshot(config_path: Path, resolved_path: Path | None) -> dict[str, Any]:
    if resolved_path is not None and resolved_path.is_file():
        value = json.loads(resolved_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise TypeError(f"resolved experiment must be an object: {resolved_path}")
        recorded_config = value.get("config_file")
        if recorded_config is None or Path(str(recorded_config)).resolve() == config_path:
            return _redact(value)

    config = OmegaConf.load(config_path)
    if not isinstance(config, DictConfig):
        raise TypeError(f"experiment config must be a mapping: {config_path}")
    value = OmegaConf.to_container(config, resolve=False)
    if not isinstance(value, dict):  # pragma: no cover - guarded by DictConfig
        raise TypeError(f"experiment config must be a mapping: {config_path}")
    return _redact(value)


def _git_commit() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=_PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode:
        return "unknown"
    return completed.stdout.strip() or "unknown"


def _backend_version(backend: BackendName, git_commit: str) -> str:
    if backend == "kl_graph":
        return git_commit
    env_name = _REVISION_ENV[backend]
    return os.environ.get(env_name, "").strip() or "unknown"


def _optional_score(value: Any, field: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"case result {field} must be numeric or null")
    return float(value)


def score_run_exists(
    *,
    database: Path,
    benchmark: Literal["locomo", "longmemeval"],
    backend: BackendName,
    source_sha256: str,
    config_path: Path,
    resolved_config_path: Path | None,
    artifact_dir: Path,
) -> bool:
    """Return whether this completed artifact set is already registered."""

    database = database.expanduser().resolve()
    if not database.is_file():
        return False
    config = _config_snapshot(config_path.expanduser().resolve(), resolved_config_path)
    config_sha256 = hashlib.sha256(
        _canonical_json(config).encode("utf-8")
    ).hexdigest()
    try:
        with sqlite3.connect(database, timeout=30) as connection:
            row = connection.execute(
                """
                SELECT 1 FROM runs
                WHERE benchmark = ? AND backend = ? AND source_sha256 = ?
                  AND config_sha256 = ? AND artifact_dir = ?
                LIMIT 1
                """,
                (
                    benchmark,
                    backend,
                    source_sha256,
                    config_sha256,
                    str(artifact_dir.expanduser().resolve()),
                ),
            ).fetchone()
    except sqlite3.OperationalError:
        return False
    return row is not None


def record_score_run(
    *,
    database: Path,
    benchmark: Literal["locomo", "longmemeval"],
    backend: BackendName,
    source_sha256: str,
    config_path: Path,
    resolved_config_path: Path | None,
    artifact_dir: Path,
    metrics: Mapping[str, Any],
    recall_k: int | None,
    cases: Iterable[Mapping[str, Any]],
) -> str:
    """Append one completed Score run and its per-question results."""

    config_path = config_path.expanduser().resolve()
    config = _config_snapshot(config_path, resolved_config_path)
    config_json = _canonical_json(config)
    config_sha256 = hashlib.sha256(config_json.encode("utf-8")).hexdigest()
    commit = _git_commit()
    run_id = str(uuid.uuid4())

    case_rows: list[tuple[Any, ...]] = []
    seen: set[str] = set()
    for case in cases:
        question_id = str(case.get("question_id") or "").strip()
        if not question_id:
            raise ValueError("tracked case result has no question_id")
        if question_id in seen:
            raise ValueError(f"duplicate tracked question_id: {question_id}")
        seen.add(question_id)
        question_type = case.get("question_type")
        details = case.get("details") or {}
        if not isinstance(details, Mapping):
            raise TypeError(f"case result details must be a mapping: {question_id}")
        case_rows.append(
            (
                run_id,
                question_id,
                str(question_type) if question_type is not None else None,
                recall_k,
                _optional_score(case.get("recall_at_k"), "recall_at_k"),
                _optional_score(case.get("qa_score"), "qa_score"),
                _canonical_json(dict(details)),
            )
        )

    database = database.expanduser().resolve()
    database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database, timeout=30) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA journal_mode = WAL")
        current_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if current_version not in {0, _SCHEMA_VERSION}:
            raise RuntimeError(
                f"unsupported evaluation result schema version: {current_version}"
            )
        connection.executescript(_SCHEMA)
        connection.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
        connection.execute(
            """
            INSERT INTO runs(
                run_id, created_at, benchmark, backend, backend_version,
                git_commit, source_sha256, config_sha256,
                resolved_config_json, metrics_json, artifact_dir
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                datetime.now(timezone.utc).isoformat(),
                benchmark,
                backend,
                _backend_version(backend, commit),
                commit,
                source_sha256,
                config_sha256,
                config_json,
                _canonical_json(dict(metrics)),
                str(artifact_dir.expanduser().resolve()),
            ),
        )
        connection.executemany(
            """
            INSERT INTO case_results(
                run_id, question_id, question_type, recall_k,
                recall_at_k, qa_score, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            case_rows,
        )
    return run_id
