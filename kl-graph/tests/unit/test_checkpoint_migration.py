"""Legacy JSON → ingest_checkpoint table migration at store-open.

The sidecar ``ingest_checkpoint.<safe_source>.json`` files predate folding the
checkpoint into ``knowledge.db``. On open, :class:`SQLiteStore` imports any it
finds. The filename encodes a *name-mangled* source_id (runner's safe-source
substitution), which is not invertible — so migration is only safe when the
filename is a fixed point of that mangle. See ``sqlite_store._migrate_checkpoint_json``.
"""

from __future__ import annotations

import json
from pathlib import Path

from kl_graph.storage.sqlite_store import SQLiteStore


def _write_legacy(data_dir: Path, safe_source: str, *, batch_id: str) -> Path:
    p = data_dir / f"ingest_checkpoint.{safe_source}.json"
    p.write_text(
        json.dumps(
            {
                "version": 1,
                "source_hash": "sha256:FAKEHASH",
                "batch_id": batch_id,
                "workset_schema": 1,
                "steps": {"phase_a.persist_chunks": {"status": "done"}},
            }
        ),
        encoding="utf-8",
    )
    return p


def _read_checkpoint_row(store: SQLiteStore, source_id: str):
    return store.conn.execute(
        "SELECT batch_id, workset_schema FROM ingest_checkpoint WHERE source_id=?",
        (source_id,),
    ).fetchone()


def test_plain_source_id_migrates_and_deletes_json(tmp_path: Path) -> None:
    # "ding" is a fixed point of the mangle → its filename == its source_id.
    legacy = _write_legacy(tmp_path, "ding", batch_id="FAKEBATCH-MIG-01")
    store = SQLiteStore(tmp_path / "knowledge.db")
    try:
        row = _read_checkpoint_row(store, "ding")
        assert row is not None, "plain source_id must migrate under its own key"
        assert row["batch_id"] == "FAKEBATCH-MIG-01"
        assert not legacy.exists(), "migrated JSON must be deleted"
    finally:
        store.close()


def test_mangled_filename_is_skipped_not_misfiled(tmp_path: Path) -> None:
    # A filename that is NOT a fixed point of the safe-source mangle (here it
    # contains a '.', which the mangle always rewrites to '_') cannot have been
    # produced by the real checkpoint_path, so its original source_id is
    # unrecoverable. Migrating it under the raw filename would create a row the
    # runner never queries — an orphan. It must be skipped and left in place.
    #
    # (Note the genuinely lossy collision — e.g. source_id "ding:main" mangles
    # to the file "ding_main", which IS a fixed point and so migrates under
    # "ding_main". That ambiguity is inherent to the lossy filename and is out
    # of scope here; the fixed-point guard just refuses to misfile the cases it
    # can actually detect as non-recoverable.)
    legacy = _write_legacy(tmp_path, "weird.name", batch_id="FAKEBATCH-MIG-02")
    store = SQLiteStore(tmp_path / "knowledge.db")
    try:
        assert _read_checkpoint_row(store, "weird.name") is None
        assert _read_checkpoint_row(store, "weird_name") is None, (
            "must not silently insert a row under the mangled key"
        )
        assert legacy.exists(), "ambiguous legacy file must be left in place"
    finally:
        store.close()
