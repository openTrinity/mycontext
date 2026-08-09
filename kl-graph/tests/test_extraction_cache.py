"""Tests for the SQLite-backed extraction cache (``ExtractionCacheStore``).

Covers the Part-C store contract from
``docs/todo/archive/extraction-cache-hardening-2026-08-05.md``: schema creation on a fresh tmp db,
md5-key parity with the extractor, UPSERT idempotence, model-scoped misses,
self-healing on unparsable payloads, ``get_many``/``all_results`` scoping,
``clear``/``count``, and two interleaved WAL connections on one db file.

No network I/O. Run:
``.venv/bin/python -m pytest tests/test_extraction_cache.py -q``
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.ingest.extraction_cache import ExtractionCacheStore

MODEL = "qwen-test"


def _result(msg_id: str, entities=None, facts=None) -> dict:
    """A realistic extraction payload with the metadata the extractor adds."""
    return {
        "entities": entities or [],
        "facts": facts or [],
        "_msg_id": msg_id,
        "_msg_sender": "Alice",
        "_msg_timestamp": 1700000000,
        "_msg_content_preview": "hello",
    }


# ─── schema + key ───────────────────────────────────────────────────────────


def test_schema_created_on_fresh_db(tmp_path) -> None:
    db = tmp_path / "knowledge.db"
    store = ExtractionCacheStore(db)
    # The table exists with exactly the designed columns and no status column.
    cols = {
        r[1]
        for r in store.conn.execute("PRAGMA table_info(extraction_cache)").fetchall()
    }
    assert cols == {
        "cache_key",
        "chunk_id",
        "payload",
        "model",
        "created_at",
        "updated_at",
        "last_accessed",
    }
    assert "status" not in cols
    store.close()


def test_cache_key_matches_extractor_md5() -> None:
    # MUST equal LLMExtractor._cache_key = md5(chunk.id).hexdigest().
    for cid in ("c1", "chunk-abc", "钉钉-123"):
        assert (
            ExtractionCacheStore.cache_key(cid)
            == hashlib.md5(cid.encode()).hexdigest()
        )


def test_cache_key_matches_llm_extractor_helper(tmp_path) -> None:
    # Cross-check against the real extractor helper so the two never drift.
    from kl_graph.ingest.llm_extractor import LLMExtractor
    from kl_graph.models.types import Chunk

    ext = LLMExtractor(cache_db=tmp_path / "knowledge.db")
    chunk = Chunk(id="chunk-abc", content="x", source_type="message", metadata={})
    assert ExtractionCacheStore.cache_key(chunk.id) == ext._cache_key(chunk)


# ─── put / get roundtrip + idempotence ───────────────────────────────────────


def test_put_get_roundtrip(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    payload = _result("c1", entities=[{"name": "X"}])
    store.put(payload, "c1", MODEL)
    got = store.get("c1", MODEL)
    assert got == payload  # full dict incl. _msg_* metadata, not sliced
    store.close()


def test_get_missing_returns_none(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    assert store.get("nope", MODEL) is None
    store.close()


def test_upsert_idempotent_one_row_created_at_preserved(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    store.put(_result("c1", entities=[{"name": "old"}]), "c1", MODEL)
    created = store.conn.execute(
        "SELECT created_at FROM extraction_cache WHERE chunk_id='c1'"
    ).fetchone()["created_at"]

    # Re-put with new content: still one row, payload updated, created_at kept.
    store.put(_result("c1", entities=[{"name": "new"}]), "c1", MODEL)
    assert store.count() == 1
    got = store.get("c1", MODEL)
    assert got["entities"] == [{"name": "new"}]
    row = store.conn.execute(
        "SELECT created_at, updated_at FROM extraction_cache WHERE chunk_id='c1'"
    ).fetchone()
    assert row["created_at"] == created
    # updated_at must STRICTLY advance on every UPSERT, even for two writes in
    # the same epoch second (monotonic MAX(excluded, existing+1) rule).
    assert row["updated_at"] > created
    store.close()


def test_upsert_updated_at_strictly_increases_across_repeats(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    seen = []
    for i in range(4):
        store.put(_result("c1", entities=[{"name": str(i)}]), "c1", MODEL)
        seen.append(
            store.conn.execute(
                "SELECT updated_at FROM extraction_cache WHERE chunk_id='c1'"
            ).fetchone()["updated_at"]
        )
    # Even back-to-back within one second, each write advances updated_at.
    assert seen == sorted(seen) and len(set(seen)) == len(seen)
    store.close()


# ─── model scoping ────────────────────────────────────────────────────────────


def test_model_mismatch_is_miss_on_get(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    store.put(_result("c1"), "c1", MODEL)
    assert store.get("c1", MODEL) is not None
    assert store.get("c1", "other-model") is None
    store.close()


def test_model_mismatch_is_miss_on_get_many_and_all_results(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    store.put(_result("c1"), "c1", MODEL)
    store.put(_result("c2"), "c2", "other-model")

    many = store.get_many(["c1", "c2"], MODEL)
    assert set(many) == {"c1"}
    allr = store.all_results(MODEL)
    assert set(allr) == {"c1"}
    store.close()


# ─── self-healing on corrupt payload ─────────────────────────────────────────


def test_unparsable_payload_is_miss(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    # Insert raw garbage directly via SQL (simulates a corrupt/legacy row).
    store.conn.execute(
        "INSERT INTO extraction_cache "
        "(cache_key, chunk_id, payload, model, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (ExtractionCacheStore.cache_key("bad"), "bad", "{not json", MODEL, 1, 1),
    )
    store.conn.commit()
    assert store.get("bad", MODEL) is None
    assert store.get_many(["bad"], MODEL) == {}
    assert store.all_results(MODEL) == {}
    # But count() still sees the physical row.
    assert store.count() == 1
    store.close()


def test_non_dict_payload_is_miss(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    store.conn.execute(
        "INSERT INTO extraction_cache "
        "(cache_key, chunk_id, payload, model, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (ExtractionCacheStore.cache_key("li"), "li", "[1, 2, 3]", MODEL, 1, 1),
    )
    store.conn.commit()
    assert store.get("li", MODEL) is None
    store.close()


# ─── get_many / all_results scoping ───────────────────────────────────────────


def test_get_many_returns_only_requested(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    store.put_many([(_result("c1"), "c1"), (_result("c2"), "c2"), (_result("c3"), "c3")], MODEL)
    got = store.get_many(["c1", "c3", "missing"], MODEL)
    assert set(got) == {"c1", "c3"}
    assert got["c1"]["_msg_id"] == "c1"
    store.close()


def test_get_many_empty_input(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    assert store.get_many([], MODEL) == {}
    store.close()


def test_get_many_over_chunk_boundary(tmp_path) -> None:
    # Exercise the batched IN(...) path beyond the 500-id chunk size.
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    ids = [f"c{i}" for i in range(1200)]
    store.put_many([(_result(cid), cid) for cid in ids], MODEL)
    got = store.get_many(ids, MODEL)
    assert len(got) == 1200
    assert store.all_results(MODEL).keys() == set(ids)
    store.close()


# ─── clear / count ────────────────────────────────────────────────────────────


def test_clear_empties_table(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    store.put_many([(_result("c1"), "c1"), (_result("c2"), "c2")], MODEL)
    assert store.count() == 2
    store.clear()
    assert store.count() == 0
    assert store.all_results(MODEL) == {}
    store.close()


def test_put_many_empty_is_noop(tmp_path) -> None:
    store = ExtractionCacheStore(tmp_path / "knowledge.db")
    store.put_many([], MODEL)
    assert store.count() == 0
    store.close()


# ─── bounded rolling eviction ────────────────────────────────────────────────


def test_cache_rejects_non_positive_entry_limit(tmp_path) -> None:
    with pytest.raises(ValueError, match="greater than zero"):
        ExtractionCacheStore(tmp_path / "extraction_cache.db", max_entries=0)


def test_rolling_cache_evicts_least_recently_used_row(tmp_path) -> None:
    store = ExtractionCacheStore(
        tmp_path / "extraction_cache.db", max_entries=3
    )
    store.put_many(
        [(_result("c1"), "c1"), (_result("c2"), "c2"), (_result("c3"), "c3")],
        MODEL,
    )

    # A hit makes c1 newer than c2/c3. The pending touch is flushed before the
    # next write and therefore participates in that write's eviction decision.
    assert store.get("c1", MODEL) is not None
    store.put(_result("c4"), "c4", MODEL)

    assert store.count() == 3
    assert store.get("c1", MODEL) is not None
    assert store.get("c2", MODEL) is None
    assert store.get("c3", MODEL) is not None
    assert store.get("c4", MODEL) is not None
    store.close()


def test_put_many_larger_than_limit_keeps_newest_rows(tmp_path) -> None:
    store = ExtractionCacheStore(
        tmp_path / "extraction_cache.db", max_entries=2
    )
    store.put_many(
        [(_result("c1"), "c1"), (_result("c2"), "c2"), (_result("c3"), "c3")],
        MODEL,
    )
    assert set(store.all_results(MODEL)) == {"c2", "c3"}
    store.close()


def test_reopening_with_lower_limit_prunes_existing_rows(tmp_path) -> None:
    cache_db = tmp_path / "extraction_cache.db"
    store = ExtractionCacheStore(cache_db, max_entries=3)
    store.put_many(
        [(_result("c1"), "c1"), (_result("c2"), "c2"), (_result("c3"), "c3")],
        MODEL,
    )
    store.close()

    reopened = ExtractionCacheStore(cache_db, max_entries=2)
    assert set(reopened.all_results(MODEL)) == {"c2", "c3"}
    reopened.close()


def test_legacy_knowledge_db_cache_is_imported_only_once(tmp_path) -> None:
    legacy_db = tmp_path / "knowledge.db"
    legacy = sqlite3.connect(legacy_db)
    legacy.execute(
        """CREATE TABLE extraction_cache (
               cache_key TEXT PRIMARY KEY,
               chunk_id TEXT NOT NULL,
               payload TEXT NOT NULL,
               model TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
           )"""
    )
    for index, chunk_id in enumerate(("c1", "c2", "c3"), start=1):
        legacy.execute(
            "INSERT INTO extraction_cache VALUES (?, ?, ?, ?, ?, ?)",
            (
                ExtractionCacheStore.cache_key(chunk_id),
                chunk_id,
                json.dumps(_result(chunk_id)),
                MODEL,
                index,
                index,
            ),
        )
    legacy.commit()
    legacy.close()

    cache_db = tmp_path / "extraction_cache.db"
    store = ExtractionCacheStore(
        cache_db, max_entries=2, legacy_db_path=legacy_db
    )
    assert set(store.all_results(MODEL)) == {"c2", "c3"}
    store.close()

    # Once marked migrated, later legacy writes are not resurrected into the
    # rolling cache on every process start.
    legacy = sqlite3.connect(legacy_db)
    legacy.execute(
        "INSERT INTO extraction_cache VALUES (?, ?, ?, ?, ?, ?)",
        (
            ExtractionCacheStore.cache_key("c4"),
            "c4",
            json.dumps(_result("c4")),
            MODEL,
            4,
            4,
        ),
    )
    legacy.commit()
    legacy.close()

    reopened = ExtractionCacheStore(
        cache_db, max_entries=2, legacy_db_path=legacy_db
    )
    assert reopened.get("c4", MODEL) is None
    reopened.close()


# ─── context manager ──────────────────────────────────────────────────────────


def test_context_manager_closes(tmp_path) -> None:
    db = tmp_path / "knowledge.db"
    with ExtractionCacheStore(db) as store:
        store.put(_result("c1"), "c1", MODEL)
        assert store.count() == 1
    # Connection is closed after the block.
    try:
        store.conn.execute("SELECT 1")
        closed = False
    except sqlite3.ProgrammingError:
        closed = True
    assert closed


# ─── two interleaved WAL connections on one db file ───────────────────────────


def test_two_interleaved_handles_same_db(tmp_path) -> None:
    db = tmp_path / "knowledge.db"
    writer = ExtractionCacheStore(db)
    reader = ExtractionCacheStore(db)  # second connection to the same file

    writer.put(_result("c1", entities=[{"name": "A"}]), "c1", MODEL)
    # Reader (separate connection) sees the committed write under WAL.
    assert reader.get("c1", MODEL) is not None

    # Interleave: reader writes, writer reads.
    reader.put(_result("c2", entities=[{"name": "B"}]), "c2", MODEL)
    assert writer.get("c2", MODEL)["entities"] == [{"name": "B"}]

    # Cross-handle update visibility.
    writer.put(_result("c1", entities=[{"name": "A2"}]), "c1", MODEL)
    assert reader.get("c1", MODEL)["entities"] == [{"name": "A2"}]
    assert reader.count() == 2

    writer.close()
    reader.close()
