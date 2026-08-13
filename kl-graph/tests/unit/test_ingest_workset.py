"""Crash-resumable ingestion workset behavior."""

from __future__ import annotations

from unittest.mock import MagicMock

from kl_graph.ingest.checkpoint import IngestCheckpoint
from kl_graph.ingest.pipeline import IngestionPipeline
from kl_graph.models.types import Chunk, ChunkUnit, Edge, EdgeType, Fact, SourceUnit
from kl_graph.storage.sqlite_store import SQLiteStore


def _committed_batch(tmp_path):
    source_dir = tmp_path / "export"
    source_dir.mkdir()
    store = SQLiteStore(tmp_path / "knowledge.db")
    checkpoint = IngestCheckpoint(store.conn, "ding", [source_dir])
    chunks = [
        Chunk(id="ding:chat", content="chat", source_type="message"),
        Chunk(id="ding:wiki", content="wiki", source_type="wiki"),
    ]
    units = [
        SourceUnit("ding", "message", "m1", "h1"),
        SourceUnit("ding", "wiki", "w1", "h2"),
    ]
    memberships = [
        ChunkUnit("ding:chat", "ding", "message", "m1", 0, 0),
        ChunkUnit("ding:wiki", "ding", "wiki", "w1", 0, 0),
    ]
    store.insert_chunks_with_units(
        chunks,
        units,
        memberships,
        batch_id=checkpoint.batch_id,
        batch_source_id="ding",
        source_hash=checkpoint.source_hash,
    )
    checkpoint.mark_done(
        "phase_a.persist_chunks", params={"unit_lineage_schema": 1}
    )
    return source_dir, checkpoint, store


def test_resumed_pipeline_hydrates_exact_committed_workset(tmp_path) -> None:
    _, checkpoint, store = _committed_batch(tmp_path)
    pipeline = IngestionPipeline(
        store=store,
        qdrant=MagicMock(),
        checkpoint=checkpoint,
        source_id="ding",
        incremental_units=True,
    )

    pipeline._load_workset()

    assert [c.id for c in pipeline.messages] == ["ding:chat"]
    assert [c.id for c in pipeline.extra_chunks] == ["ding:wiki"]
    assert pipeline.workset_unit_count == 2
    assert pipeline.workset_chunk_count == 2


def test_partial_phase_a_uses_workset_without_reparsing_sources(tmp_path) -> None:
    _, checkpoint, store = _committed_batch(tmp_path)
    pipeline = IngestionPipeline(
        store=store,
        qdrant=MagicMock(),
        checkpoint=checkpoint,
        source_id="ding",
        incremental_units=True,
    )
    pipeline._load_sources = MagicMock(side_effect=AssertionError("must not reparse"))

    assert pipeline._phase_a_complete() is False
    pipeline._load_phase_a_input()

    pipeline._load_sources.assert_not_called()
    assert [c.id for c in pipeline.all_chunks()] == ["ding:chat", "ding:wiki"]


def test_db_commit_before_checkpoint_mark_recovers_same_workset(tmp_path) -> None:
    _, checkpoint, store = _committed_batch(tmp_path)
    checkpoint.clear_prefix("phase_a.")
    pipeline = IngestionPipeline(
        store=store,
        qdrant=MagicMock(),
        checkpoint=checkpoint,
        source_id="ding",
        incremental_units=True,
    )
    pipeline._load_sources = MagicMock(side_effect=AssertionError("must not reparse"))

    assert pipeline._phase_a_complete() is False
    pipeline._load_phase_a_input()

    pipeline._load_sources.assert_not_called()
    assert pipeline.workset_unit_count == 2
    assert [c.id for c in pipeline.all_chunks()] == ["ding:chat", "ding:wiki"]


def test_source_change_keeps_interrupted_committed_batch(tmp_path) -> None:
    source_dir, checkpoint, store = _committed_batch(tmp_path)
    original_batch = checkpoint.batch_id
    original_hash = checkpoint.source_hash
    (source_dir / "new.jsonl").write_text("new", encoding="utf-8")

    # Re-open using the same DB connection (the store is still open)
    resumed = IngestCheckpoint(store.conn, "ding", [source_dir])

    assert resumed.batch_id == original_batch
    assert resumed.source_hash == original_hash


def test_cleaned_workset_fails_loudly_if_a_phase_is_reopened(tmp_path) -> None:
    _, checkpoint, store = _committed_batch(tmp_path)
    store.complete_ingest_batch(checkpoint.batch_id)
    pipeline = IngestionPipeline(
        store=store,
        qdrant=MagicMock(),
        checkpoint=checkpoint,
        source_id="ding",
        incremental_units=True,
    )

    try:
        pipeline._load_workset()
    except RuntimeError as exc:
        assert "no longer available" in str(exc)
    else:
        raise AssertionError("cleaned workset was silently treated as empty")


def test_store_initialization_does_not_move_extractor_across_threads(tmp_path) -> None:
    extractor = MagicMock()
    pipeline = IngestionPipeline(
        store=SQLiteStore(tmp_path / "knowledge.db"),
        qdrant=MagicMock(),
        embedder=MagicMock(),
    )
    pipeline.extractor = extractor

    pipeline._init_stores()

    assert pipeline.extractor is extractor
    extractor.close.assert_not_called()


def test_improvement_targets_are_recovered_from_committed_workset(tmp_path) -> None:
    _, checkpoint, store = _committed_batch(tmp_path)
    store.insert_facts(
        [Fact(id="f1", text="fact", source_chunk_id="ding:wiki")]
    )
    store.insert_edges(
        [
            Edge("chunk", "ding:chat", "entity", "e1", EdgeType.MENTIONS),
            Edge("fact", "f1", "entity", "e2", EdgeType.ABOUT),
        ]
    )
    pipeline = IngestionPipeline(
        store=store,
        qdrant=MagicMock(),
        checkpoint=checkpoint,
        source_id="ding",
        incremental_units=True,
    )

    targets = pipeline.improvement_targets()

    assert targets.fact_ids == ("f1",)
    assert targets.entity_ids == ("e1", "e2")


def _drop_workset_row(store, batch_id: str) -> None:
    """删掉 ingest_batches 工作集行，但保留 chunks / units（模拟 Case B）。"""
    conn = store.sql_conn
    with conn:
        conn.execute("DELETE FROM ingest_batch_chunks WHERE batch_id=?", (batch_id,))
        conn.execute(
            "DELETE FROM ingest_batch_extraction_items WHERE batch_id=?", (batch_id,)
        )
        conn.execute(
            "DELETE FROM ingest_batch_extraction_projections WHERE batch_id=?",
            (batch_id,),
        )
        conn.execute("DELETE FROM ingest_batches WHERE batch_id=?", (batch_id,))


def test_case_b_with_seen_units_fails_loudly_not_silently_empty(tmp_path) -> None:
    """Case B 自愈：源仍在盘上，但去重账本已记全部 unit → 内存工作集会塌成空。

    此时必须诚实报错而不是把 DB 里幸存的 chunk 静默当成空跑完（CLAUDE.md §4）。
    """
    source_dir, checkpoint, store = _committed_batch(tmp_path)
    batch_id = checkpoint.batch_id
    # chunks 与 units 仍在，仅工作集行丢失 → 恰好是 Case B。
    _drop_workset_row(store, batch_id)
    assert store.count_chunks() > 0

    pipeline = IngestionPipeline(
        store=store,
        qdrant=MagicMock(),
        messages_dir=source_dir / "chat",
        checkpoint=checkpoint,
        source_id="ding",
        incremental_units=True,
    )

    try:
        pipeline._load_workset()
    except RuntimeError as exc:
        assert "--fresh-db" in str(exc)
    else:
        raise AssertionError(
            "Case B silently produced an empty workset instead of raising"
        )
    # 未被误标为已加载，扩展阶段不会拿到一个空工作集。
    assert pipeline._sources_loaded is False
    assert not pipeline.all_chunks()

