"""CLI contract for the shared unit-incremental ingestion workflow."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def test_normal_ingest_uses_shared_runner(tmp_path) -> None:
    from scripts import ingest

    checkpoint = MagicMock(source_hash="abc")
    shared_run = AsyncMock()
    argv = [
        "scripts/ingest.py",
        "--input-dir",
        str(tmp_path),
        "--source-id",
        "slack-prod",
    ]
    with (
        patch("sys.argv", argv),
        patch.object(ingest, "make_checkpoint", return_value=checkpoint),
        patch.object(ingest, "run_ingestion", shared_run),
    ):
        asyncio.run(ingest.main())

    options = shared_run.await_args.args[0]
    assert options.source_id == "slack-prod"
    assert options.input_dir == tmp_path.resolve()


@pytest.mark.parametrize("legacy_flag", ["--incremental", "--since"])
def test_timestamp_incremental_flags_are_rejected(legacy_flag, tmp_path) -> None:
    from scripts import ingest

    argv = [
        "scripts/ingest.py",
        "--input-dir",
        str(tmp_path),
        "--source-id",
        "slack-prod",
        legacy_flag,
    ]
    with patch("sys.argv", argv), pytest.raises(SystemExit):
        asyncio.run(ingest.main())


def test_source_id_is_required(tmp_path) -> None:
    from scripts import ingest

    argv = ["scripts/ingest.py", "--input-dir", str(tmp_path)]
    with patch("sys.argv", argv), pytest.raises(SystemExit):
        asyncio.run(ingest.main())
