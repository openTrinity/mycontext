"""Contract tests shared by the Qdrant and Zvec vector adapters."""

from __future__ import annotations

import uuid

import pytest

from kl_graph.storage.vector_store import (
    VectorPoint,
    create_vector_store,
    vector_store_path,
)


@pytest.fixture(params=["qdrant", "zvec"])
def vector_backend(request, tmp_path):
    backend = request.param
    if backend == "zvec":
        pytest.importorskip("zvec")
    kwargs = {"optimize_on_upsert": False} if backend == "zvec" else {}
    store = create_vector_store(
        backend,
        data_dir=tmp_path,
        embedding_dim=3,
        collections=["chunks"],
        **kwargs,
    )
    try:
        yield backend, store
    finally:
        store.close()


def test_vector_store_contract(vector_backend) -> None:
    _backend, store = vector_backend
    store.upsert(
        "chunks",
        [
            VectorPoint(
                "chunk-a",
                [1.0, 0.0, 0.0],
                {
                    "chunk_id": "chunk-a",
                    "source_type": "message",
                    "timestamp": 10,
                    "custom": {"preserved": True},
                },
            ),
            VectorPoint(
                "chunk-b",
                [0.8, 0.2, 0.0],
                {"chunk_id": "chunk-b", "source_type": "mail", "timestamp": 20},
            ),
            VectorPoint(
                "chunk-c",
                [0.0, 1.0, 0.0],
                {
                    "chunk_id": "chunk-c",
                    "source_type": "message",
                    "timestamp": 30,
                },
            ),
        ],
    )

    assert store.count("chunks") == 3
    assert store.existing_ids("chunks", ["chunk-a", "missing"]) == {"chunk-a"}
    assert set(store.retrieve_vectors("chunks", ["chunk-a", "missing"])) == {
        "chunk-a"
    }

    hits = store.search(
        "chunks",
        [1.0, 0.0, 0.0],
        limit=10,
        score_threshold=0.5,
        filter_payload={"source_type": ["message"], "timestamp_gte": 5},
    )
    assert [hit.id for hit in hits] == ["chunk-a"]
    assert hits[0].score == pytest.approx(1.0)
    assert hits[0].payload["custom"] == {"preserved": True}

    points = {point.id: point for point in store.scroll_all("chunks")}
    assert set(points) == {"chunk-a", "chunk-b", "chunk-c"}
    assert points["chunk-a"].payload["custom"] == {"preserved": True}

    store.delete("chunks", ["chunk-b"])
    assert store.count("chunks") == 2


def test_qdrant_uses_uuid5_physical_ids(tmp_path) -> None:
    store = create_vector_store(
        "qdrant", data_dir=tmp_path, embedding_dim=3, collections=["chunks"]
    )
    try:
        expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, "chunk-a"))
        assert store.stable_id_to_point_id("chunk-a") == expected
    finally:
        store.close()


def test_zvec_scroll_manifest_survives_reopen(tmp_path) -> None:
    pytest.importorskip("zvec")
    kwargs = {
        "data_dir": tmp_path,
        "embedding_dim": 3,
        "collections": ["chunks"],
        "optimize_on_upsert": False,
    }
    store = create_vector_store("zvec", **kwargs)
    store.upsert(
        "chunks",
        [VectorPoint("chunk-a", [1.0, 0.0, 0.0], {"chunk_id": "chunk-a"})],
    )
    store.close()

    reopened = create_vector_store("zvec", **kwargs)
    try:
        assert [point.id for point in reopened.scroll_all("chunks")] == ["chunk-a"]
    finally:
        reopened.close()


def test_zvec_upsert_drops_duplicate_ids_before_hnsw_indexing(tmp_path) -> None:
    pytest.importorskip("zvec")
    store = create_vector_store(
        "zvec",
        data_dir=tmp_path,
        embedding_dim=3,
        collections=["facts"],
    )
    try:
        store.upsert(
            "facts",
            [
                VectorPoint("fact-a", [1.0, 0.0, 0.0], {"fact_id": "fact-a"}),
                VectorPoint("fact-a", [0.0, 1.0, 0.0], {"fact_id": "fact-a"}),
            ],
        )
        assert store.count("facts") == 1
        assert store.retrieve_vectors("facts", ["fact-a"])["fact-a"] == pytest.approx(
            [1.0, 0.0, 0.0]
        )
    finally:
        store.close()


def test_zvec_full_write_verification_is_debug_gated(tmp_path, monkeypatch) -> None:
    pytest.importorskip("zvec")
    store = create_vector_store(
        "zvec",
        data_dir=tmp_path,
        embedding_dim=3,
        collections=["facts"],
        verify_writes=False,
    )
    try:
        monkeypatch.setattr(
            store,
            "retrieve_vectors",
            lambda *_args, **_kwargs: pytest.fail("normal writes must not read vectors back"),
        )
        store.upsert(
            "facts",
            [VectorPoint("fact-a", [1.0, 0.0, 0.0], {"fact_id": "fact-a"})],
        )
    finally:
        store.close()

    debug_store = create_vector_store(
        "zvec",
        data_dir=tmp_path / "debug",
        embedding_dim=3,
        collections=["facts"],
        verify_writes=True,
    )
    try:
        monkeypatch.setattr(debug_store, "retrieve_vectors", lambda *_args, **_kwargs: {})
        with pytest.raises(RuntimeError, match="write verification failed"):
            debug_store.upsert(
                "facts",
                [VectorPoint("fact-b", [0.0, 1.0, 0.0], {"fact_id": "fact-b"})],
            )
    finally:
        debug_store.close()


def test_vector_store_path_separates_backends_and_namespaces(tmp_path) -> None:
    assert vector_store_path("qdrant", tmp_path) == tmp_path / "qdrant_data"
    assert vector_store_path("zvec", tmp_path) == tmp_path / "zvec_data"
    assert vector_store_path(
        "zvec", tmp_path, namespace="communities"
    ) == tmp_path / "zvec_communities"


def test_factory_rejects_unknown_backend(tmp_path) -> None:
    with pytest.raises(ValueError, match="Unknown vector backend"):
        create_vector_store("unknown", data_dir=tmp_path, embedding_dim=3)
