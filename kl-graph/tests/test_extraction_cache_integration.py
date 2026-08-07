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
    db = tmp_path / "knowledge.db"

    # Batch of two: slot 0 succeeds, slot 1 is dropped by the model.
    async def one_of_two(**kwargs):
        return _resp('{"results": [{"msg_index": 0, "entities": [{"name": "X"}], "facts": []}]}')

    monkeypatch.setattr(lx.litellm, "acompletion", one_of_two)
    monkeypatch.setattr(lx, "LLM_BATCH_SIZE", 8)

    ex = LLMExtractor(cache_db=db)
    c0, c1 = _chunk("c0"), _chunk("c1")
    asyncio.run(ex.extract_all_flat([c0, c1]))
    model = ex.model
    ex.close()

    # Pipeline replay reads the same table.
    from kl_graph.ingest.pipeline import IngestionPipeline

    pipe = IngestionPipeline(sqlite_path=db, cache_db=db)
    pipe._load_extraction_cache()
    assert "c0" in pipe.extraction_results  # success replayed
    assert "c1" not in pipe.extraction_results  # dropped slot never stored
    assert pipe.extraction_results["c0"]["entities"] == [{"name": "X"}]

    # Cross-check the raw store agrees.
    store = ExtractionCacheStore(db)
    assert store.count() == 1
    assert store.all_results(model).keys() == {"c0"}
    store.close()


def test_keep_cache_false_clears_table(monkeypatch, tmp_path):
    db = tmp_path / "knowledge.db"
    store = ExtractionCacheStore(db)
    store.put({"entities": [], "facts": [], "_msg_id": "c0"}, "c0", "anthropic/m")
    store.close()

    from kl_graph.ingest.pipeline import IngestionPipeline

    pipe = IngestionPipeline(sqlite_path=db, cache_db=db, keep_cache=False)
    pipe._graph_build_ran = True
    pipe._maybe_clear_extraction_cache()

    store = ExtractionCacheStore(db)
    assert store.count() == 0
    store.close()


def test_incremental_get_many_returns_only_requested(tmp_path):
    db = tmp_path / "knowledge.db"
    model = "anthropic/m"
    store = ExtractionCacheStore(db)
    store.put({"entities": [], "facts": [], "_msg_id": "a"}, "a", model)
    store.put({"entities": [], "facts": [], "_msg_id": "b"}, "b", model)
    store.put({"entities": [], "facts": [], "_msg_id": "c"}, "c", model)
    store.close()

    got = ExtractionCacheStore(db).get_many(["a", "c"], model)
    assert set(got.keys()) == {"a", "c"}
