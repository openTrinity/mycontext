"""Tests for embedding dedup + resume (docs/todo/archive/embedding-dedup.md).

Covers the offline-testable pieces of the deterministic-point-id + skip-existing
+ incremental-flush + content-reuse design, without a live embedder or a real
Qdrant:

- ``point_id`` is a deterministic UUID5 of the stable id (idempotent, order-free).
- ``QdrantStore.existing_ids`` returns exactly the ids already present.
- ``_embed_texts_reusing_duplicates`` calls the embedder once per *unique* text
  and fans the vector back out in input order (Goal 2 — reuse, never skip).
- the incremental-flush helpers upsert every N points and clear the buffer.

Run: ``.venv/bin/python -m pytest tests/test_embedding_dedup.py -q``
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.ingest.pipeline import IngestionPipeline
from kl_graph.storage.qdrant_store import point_id
from kl_graph.storage.vector_store import VectorPoint

# ── point_id ──────────────────────────────────────────────────────────────


def test_point_id_is_deterministic_uuid5() -> None:
    assert point_id("chunk-1") == str(uuid.uuid5(uuid.NAMESPACE_DNS, "chunk-1"))
    assert point_id("chunk-1") == point_id("chunk-1")


def test_point_id_distinct_per_input() -> None:
    assert point_id("a") != point_id("b")
    # order-free: the id depends only on the stable id, not any position
    ids = ["m1", "m2", "m3"]
    forward = [point_id(i) for i in ids]
    backward = [point_id(i) for i in reversed(ids)]
    assert set(forward) == set(backward)


# ── content-reuse embedding (Goal 2) ────────────────────────────────────────


class _RecordingEmbedder:
    """Fake embedder: returns a deterministic vector per text, records calls."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed_batch_with_progress(self, texts, desc="Embedding"):
        self.calls.append(list(texts))
        # 1-dim vector keyed to the text so we can assert fan-out correctness
        return [[float(len(t))] for t in texts]


def _bare_pipeline() -> IngestionPipeline:
    """An IngestionPipeline instance without opening any store (no __init__)."""
    return IngestionPipeline.__new__(IngestionPipeline)


def test_reuse_embeds_each_unique_text_once() -> None:
    pipe = _bare_pipeline()
    pipe.embedder = _RecordingEmbedder()
    texts = ["hello", "hello", "world", "hello", "hi"]
    out = pipe._embed_texts_reusing_duplicates(texts, "  T")
    # embedder saw only the 3 unique texts, in first-seen order
    assert pipe.embedder.calls == [["hello", "world", "hi"]]
    # output aligns 1:1 with the input (duplicates reuse the same vector)
    assert out == [[5.0], [5.0], [5.0], [5.0], [2.0]]
    assert out[0] is out[1] or out[0] == out[1]  # same vector reused


def test_reuse_preserves_order_and_length() -> None:
    pipe = _bare_pipeline()
    pipe.embedder = _RecordingEmbedder()
    texts = ["c", "aa", "c", "bbb"]
    out = pipe._embed_texts_reusing_duplicates(texts, "  T")
    assert len(out) == len(texts)
    assert out == [[1.0], [2.0], [1.0], [3.0]]


def test_reuse_empty() -> None:
    pipe = _bare_pipeline()
    pipe.embedder = _RecordingEmbedder()
    assert pipe._embed_texts_reusing_duplicates([], "  T") == []


# ── incremental flush helpers (Goal 1) ──────────────────────────────────────


class _RecordingQdrant:
    """Fake vector store: records each upsert call's collection + size."""

    def __init__(self) -> None:
        self.upserts: list[tuple[str, int]] = []
        self.ids: set[str] = set()

    def upsert(self, collection, points):
        self.upserts.append((collection, len(points)))
        self.ids.update(point.id for point in points)

    def existing_ids(self, collection, ids):
        return set(ids) & self.ids


def test_flush_points_upserts_and_clears() -> None:
    pipe = _bare_pipeline()
    pipe.qdrant = _RecordingQdrant()
    points = [VectorPoint(str(i), [float(i)]) for i in range(3)]
    n = pipe._flush_points("chunks", points)
    assert n == 3
    assert points == []  # cleared in place
    assert pipe.qdrant.upserts == [("chunks", 3)]


def test_flush_points_noop_on_empty() -> None:
    pipe = _bare_pipeline()
    pipe.qdrant = _RecordingQdrant()
    assert pipe._flush_points("chunks", []) == 0
    assert pipe.qdrant.upserts == []


def test_flush_if_full_respects_threshold(monkeypatch) -> None:
    import kl_graph.ingest.pipeline as plmod

    monkeypatch.setattr(plmod, "EMBED_FLUSH_EVERY", 3)
    pipe = _bare_pipeline()
    pipe.qdrant = _RecordingQdrant()
    points = [VectorPoint(str(i), [float(i)]) for i in range(2)]
    # below threshold -> no flush
    assert pipe._flush_if_full("chunks", points) == 0
    assert len(points) == 2
    # at threshold -> flush + clear
    points.append(VectorPoint("2", [2.0]))
    assert pipe._flush_if_full("chunks", points) == 3
    assert points == []
    assert pipe.qdrant.upserts == [("chunks", 3)]


def test_flush_points_drops_duplicate_ids_first_seen_wins() -> None:
    pipe = _bare_pipeline()
    pipe.qdrant = _RecordingQdrant()
    points = [
        VectorPoint("same", [1.0]),
        VectorPoint("same", [2.0]),
        VectorPoint("other", [3.0]),
    ]

    assert pipe._flush_points("facts", points) == 2
    assert pipe.qdrant.upserts == [("facts", 2)]
    assert points == []


# ── existing_ids (skip-existing) ─────────────────────────────────────────────


def test_existing_ids_returns_present_subset(tmp_path) -> None:
    # Uses a real embedded QdrantStore over a temp dir. Skipped if qdrant_client
    # is unavailable in the environment.
    try:
        from qdrant_client.models import PointStruct

        from kl_graph.storage.qdrant_store import QdrantStore
    except Exception:  # noqa: BLE001
        import pytest

        pytest.skip("qdrant_client not available")

    store = QdrantStore(path=str(tmp_path / "qd"))
    from kl_graph.config import cfg

    EMBEDDING_DIM = int(cfg.services.embedding.dim)

    id_a, id_b = point_id("a"), point_id("b")
    store.upsert_batch(
        "chunks",
        [PointStruct(id=id_a, vector=[0.0] * EMBEDDING_DIM, payload={"chunk_id": "a"})],
    )
    present = store.existing_ids("chunks", [id_a, id_b])
    assert present == {id_a}
    assert store.existing_ids("chunks", []) == set()
    store.close()
