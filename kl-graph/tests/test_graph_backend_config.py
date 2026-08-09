"""Tests for graph-backend configuration and destructive reset behavior."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).parent.parent


def test_application_graph_backend_defaults_to_ladybug() -> None:
    """An unset backend selects LadybugDB at the application boundary."""
    env = os.environ.copy()
    env.pop("KL_GRAPH_BACKEND", None)
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from kl_graph.config import cfg; print(cfg.storage.graph.backend)",
        ],
        cwd=PROJECT_ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert result.stdout.strip() == "ladybug"


def test_ingest_cli_rejects_nonpositive_concurrency(tmp_path: Path) -> None:
    input_dir = tmp_path / "export"
    input_dir.mkdir()
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "scripts.ingest",
            "--input-dir",
            str(input_dir),
            "--source-id",
            "test-source",
            "--concurrency",
            "0",
        ],
        cwd=PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 2
    assert "--concurrency must be greater than zero" in result.stderr


def test_fresh_db_removes_ladybug_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fresh Ladybug ingest cannot retain edges from the previous graph."""
    pytest.importorskip("ladybug")
    import scripts.ingest as ingest_script

    sqlite_path = tmp_path / "knowledge.db"
    extraction_cache_path = tmp_path / "extraction_cache.db"
    qdrant_path = tmp_path / "qdrant_data"
    ladybug_path = tmp_path / "graph.ladybug"
    sqlite_path.write_text("stale", encoding="utf-8")
    extraction_cache_path.write_text("expensive-cache", encoding="utf-8")
    qdrant_path.mkdir()

    from kl_graph.storage.ladybug_graph import LadybugGraphDB

    graph = LadybugGraphDB(str(ladybug_path))
    graph.close()
    assert ladybug_path.exists()

    monkeypatch.setattr(ingest_script, "SQLITE_PATH", sqlite_path)
    monkeypatch.setattr(ingest_script, "QDRANT_PATH", str(qdrant_path))
    monkeypatch.setattr(ingest_script, "GRAPH_BACKEND", "ladybug")
    monkeypatch.setattr(ingest_script, "GRAPH_DB_PATH", str(ladybug_path))

    ingest_script._reset_stores()

    assert not sqlite_path.exists()
    assert extraction_cache_path.read_text(encoding="utf-8") == "expensive-cache"
    assert not qdrant_path.exists()
    assert not ladybug_path.exists()
