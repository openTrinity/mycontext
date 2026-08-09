"""Integration tests: extractor ↔ SQLite cache ↔ pipeline/incremental replay.

Proves the U2+U3 wiring end to end without any network:

  1. The pipeline's Phase-B replay (``_load_extraction_cache``) loads only the
     validated successes the extractor stored — poison never re-enters.
  2. ``keep_cache=False`` clears the cache table after a successful build.
  3. Incremental replay (``_load_extraction_cache_for`` → ``get_many``) returns
     only the requested chunks' results.

Run: ``.venv/bin/python -m pytest tests/test_extraction_cache_integration.py -q``
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import kl_graph.ingest.llm_extractor as lx
from kl_graph.ingest.extraction_cache import ExtractionCacheStore
from kl_graph.ingest.llm_extractor import LLMExtractor
from kl_graph.models.types import Chunk


def _chunk(cid: str) -> Chunk:
    return Chunk(id=cid, content=f"content-{cid}", source_type="message", metadata={})


def _resp(content: str):
    msg = type("M", (), {"content": content})()
    choice = type(
        "C", (), {"message": msg, "finish_reason": "stop", "stop_reason": None}
    )()
    return type("R", (), {"choices": [choice], "usage": None})()


def test_extract_then_pipeline_replay_loads_only_successes(monkeypatch, tmp_path):
    """extract_all_flat over a mixed batch → only the success is replayable."""
    knowledge_db = tmp_path / "knowledge.db"
    cache_db = tmp_path / "extraction_cache.db"

    # Batch of two: slot 0 succeeds, slot 1 is dropped by the model.
    async def one_of_two(**kwargs):
        return _resp('{"results": [{"msg_index": 0, "entities": [{"name": "X"}], "facts": []}]}')

    monkeypatch.setattr(lx.litellm, "acompletion", one_of_two)
    monkeypatch.setattr(lx, "LLM_BATCH_SIZE", 8)

    ex = LLMExtractor(cache_db=cache_db)
    c0, c1 = _chunk("c0"), _chunk("c1")
    asyncio.run(ex.extract_all_flat([c0, c1]))
    model = ex.model
    ex.close()

    # Pipeline replay reads the same table.
    from kl_graph.ingest.pipeline import IngestionPipeline

    pipe = IngestionPipeline(
        sqlite_path=knowledge_db, cache_db=cache_db, store=object()
    )
    pipe._load_extraction_cache()
    assert "c0" in pipe.extraction_results  # success replayed
    assert "c1" not in pipe.extraction_results  # dropped slot never stored
    assert pipe.extraction_results["c0"]["entities"] == [{"name": "X"}]

    # Cross-check the raw store agrees.
    store = ExtractionCacheStore(cache_db)
    assert store.count() == 1
    assert store.all_results(model).keys() == {"c0"}
    store.close()
    pipe.close()


def test_keep_cache_false_clears_table(monkeypatch, tmp_path):
    knowledge_db = tmp_path / "knowledge.db"
    cache_db = tmp_path / "extraction_cache.db"
    legacy = ExtractionCacheStore(knowledge_db)
    legacy.put(
        {"entities": [], "facts": [], "_msg_id": "legacy"},
        "legacy",
        "anthropic/m",
    )
    legacy.close()
    store = ExtractionCacheStore(cache_db)
    store.put({"entities": [], "facts": [], "_msg_id": "c0"}, "c0", "anthropic/m")
    store.close()

    from kl_graph.ingest.pipeline import IngestionPipeline

    pipe = IngestionPipeline(
        sqlite_path=knowledge_db,
        cache_db=cache_db,
        keep_cache=False,
        store=object(),
    )
    pipe._graph_build_ran = True
    pipe._maybe_clear_extraction_cache()

    store = ExtractionCacheStore(cache_db)
    assert store.count() == 0
    migration_markers = store.conn.execute(
        "SELECT COUNT(*) FROM cache_metadata"
    ).fetchone()[0]
    assert migration_markers == 0
    store.close()
    pipe.close()


def test_pipeline_defaults_to_cache_sibling_of_content_db(tmp_path):
    from kl_graph.ingest.pipeline import IngestionPipeline

    knowledge_db = tmp_path / "knowledge.db"
    pipe = IngestionPipeline(sqlite_path=knowledge_db, store=object())

    assert pipe.cache_db == tmp_path / "extraction_cache.db"
    assert pipe.legacy_cache_db == knowledge_db
    pipe.close()


def test_pipeline_rejects_workset_larger_than_rolling_cache(tmp_path):
    from kl_graph.ingest.pipeline import IngestionPipeline

    pipe = IngestionPipeline(
        sqlite_path=tmp_path / "knowledge.db",
        cache_max_entries=2,
        store=object(),
    )
    with pytest.raises(RuntimeError, match="3 chunks.*limit of 2"):
        pipe._validate_extraction_cache_capacity(3)
    pipe.close()


def test_incremental_get_many_returns_only_requested(tmp_path):
    db = tmp_path / "knowledge.db"
    model = "anthropic/m"
    store = ExtractionCacheStore(db)
    store.put({"entities": [], "facts": [], "_msg_id": "a"}, "a", model)
    store.put({"entities": [], "facts": [], "_msg_id": "b"}, "b", model)
    store.put({"entities": [], "facts": [], "_msg_id": "c"}, "c", model)
    store.close()

    reader = ExtractionCacheStore(db)
    got = reader.get_many(["a", "c"], model)
    assert set(got.keys()) == {"a", "c"}
    reader.close()
