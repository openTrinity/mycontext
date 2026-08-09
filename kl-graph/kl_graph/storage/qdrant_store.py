"""Qdrant vector storage backend."""

from __future__ import annotations

import uuid

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchAny,
    PayloadSchemaType,
    PointStruct,
    Range,
    SearchParams,
    VectorParams,
)

from kl_graph.config import DATA_DIR, cfg

QDRANT_PATH = str(DATA_DIR / "qdrant_data")
EMBEDDING_DIM = int(cfg.services.embedding.dim)
QDRANT_EXACT_SEARCH = bool(cfg.storage.vector.qdrant.exact_search)


class QdrantStore:
    """Vector storage for chunks, entities, and facts.

    ``chunks`` is the unified retrieval-unit collection: every embedded piece of
    source content (chat messages today; PDF/doc/sheet chunks later) lives here,
    discriminated by the ``source_type`` payload field. ``entities`` and
    ``facts`` are graph-derived nodes and keep their own collections.
    """

    COLLECTIONS = {  # noqa: RUF012
        "chunks": {
            "payload_indexes": {
                "source_type": PayloadSchemaType.KEYWORD,
                "conversation_id": PayloadSchemaType.KEYWORD,
                "sender_id": PayloadSchemaType.KEYWORD,
                "timestamp": PayloadSchemaType.INTEGER,
            }
        },
        "entities": {
            "payload_indexes": {
                "entity_type": PayloadSchemaType.KEYWORD,
                "mention_count": PayloadSchemaType.INTEGER,
            }
        },
        "facts": {
            "payload_indexes": {
                "fact_type": PayloadSchemaType.KEYWORD,
                "timestamp": PayloadSchemaType.INTEGER,
                "confidence": PayloadSchemaType.FLOAT,
            }
        },
    }

    def __init__(
        self,
        path: str | None = None,
        *,
        host: str = "",
        port: int = 6333,
        api_key: str = "",
        embedding_dim: int = EMBEDDING_DIM,
        exact_search: bool = QDRANT_EXACT_SEARCH,
        collections: dict | None = None,
        client: QdrantClient | None = None,
    ):
        self.path = path or QDRANT_PATH
        self.embedding_dim = int(embedding_dim)
        self.exact_search = bool(exact_search)
        self.collections = collections or self.COLLECTIONS
        if client is not None:
            self.client = client
        elif host:
            self.client = QdrantClient(
                host=host,
                port=int(port),
                api_key=api_key or None,
            )
        else:
            self.client = QdrantClient(path=self.path)
        self._ensure_collections()

    def _ensure_collections(self):
        existing = {c.name for c in self.client.get_collections().collections}
        for name, config in self.collections.items():
            if name not in existing:
                self.client.create_collection(
                    collection_name=name,
                    vectors_config=VectorParams(
                        size=self.embedding_dim,
                        distance=Distance.COSINE,
                    ),
                )
                # Create payload indexes
                for field_name, schema_type in config["payload_indexes"].items():
                    self.client.create_payload_index(
                        collection_name=name,
                        field_name=field_name,
                        field_schema=schema_type,
                    )

    def upsert_batch(self, collection: str, points: list[PointStruct]):
        """Bulk upsert points to a collection."""
        if not points:
            return
        # Qdrant handles batches up to 256 points efficiently
        batch_size = 256
        for i in range(0, len(points), batch_size):
            batch = points[i : i + batch_size]
            self.client.upsert(collection_name=collection, points=batch)

    def search(
        self,
        collection: str,
        query_vector: list[float],
        limit: int = 20,
        filter_conditions: Filter | None = None,
        score_threshold: float | None = None,
    ) -> list[dict]:
        """Search by vector similarity with optional filtering.

        Uses exact (brute-force) search when ``config.QDRANT_EXACT_SEARCH`` is
        set, otherwise the approximate HNSW walk (``hnsw_ef=128``).
        """
        response = self.client.query_points(
            collection_name=collection,
            query=query_vector,
            limit=limit,
            query_filter=filter_conditions,
            score_threshold=score_threshold,
            search_params=SearchParams(exact=self.exact_search, hnsw_ef=128),
        )
        return [
            {
                "id": str(r.id),
                "score": r.score,
                "payload": r.payload,
            }
            for r in response.points
        ]

    def search_chunks(
        self,
        query_vector: list[float],
        limit: int = 20,
        source_types: list[str] | None = None,
        min_timestamp: int | None = None,
        max_timestamp: int | None = None,
    ) -> list[dict]:
        """Vector search over the unified ``chunks`` collection.

        Searches all chunk types at once (messages, and later pdf/doc/...). Pass
        ``source_types`` to restrict to specific sources, e.g.
        ``["message"]`` or ``["pdf", "docx"]``.
        """
        conditions = []
        if source_types:
            conditions.append(
                FieldCondition(key="source_type", match=MatchAny(any=source_types))
            )
        if min_timestamp is not None:
            conditions.append(
                FieldCondition(key="timestamp", range=Range(gte=min_timestamp))
            )
        if max_timestamp is not None:
            conditions.append(
                FieldCondition(key="timestamp", range=Range(lte=max_timestamp))
            )
        filter_obj = Filter(must=conditions) if conditions else None
        return self.search("chunks", query_vector, limit, filter_obj)

    def search_with_time_filter(
        self,
        collection: str,
        query_vector: list[float],
        limit: int = 20,
        min_timestamp: int | None = None,
        max_timestamp: int | None = None,
    ) -> list[dict]:
        """Search with optional time range filter."""
        conditions = []
        if min_timestamp is not None:
            conditions.append(
                FieldCondition(key="timestamp", range=Range(gte=min_timestamp))
            )
        if max_timestamp is not None:
            conditions.append(
                FieldCondition(key="timestamp", range=Range(lte=max_timestamp))
            )

        filter_obj = Filter(must=conditions) if conditions else None
        return self.search(collection, query_vector, limit, filter_obj)

    def count(self, collection: str) -> int:
        info = self.client.get_collection(collection)
        return info.points_count

    def existing_ids(self, collection: str, ids: list[str]) -> set[str]:
        """Return the subset of ``ids`` that already have a point in ``collection``.

        Used by the embedding step to skip work that a previous (crashed or
        partial) run already flushed. ``client.retrieve`` returns only the
        points that exist, so the returned set is exactly the already-embedded
        ids. Vectors/payloads are not fetched (``with_payload=False``).
        """
        if not ids:
            return set()
        found: set[str] = set()
        batch_size = 256
        for i in range(0, len(ids), batch_size):
            batch = ids[i : i + batch_size]
            records = self.client.retrieve(
                collection_name=collection,
                ids=batch,
                with_payload=False,
                with_vectors=False,
            )
            found.update(str(r.id) for r in records)
        return found

    def close(self):
        self.client.close()


def point_id(stable_id: str) -> str:
    """Deterministic Qdrant point id (UUID5) from a stable content id.

    Qdrant point ids must be an unsigned int or a UUID string. Deriving the id
    from the chunk/entity/fact's own stable id (``uuid5(NAMESPACE_DNS, id)``)
    makes re-embedding the same item **overwrite the same point** instead of
    appending a duplicate — idempotent across runs, and immune to list-order
    changes (the old positional ``id=i`` scheme silently rebound point ``i`` to a
    different item when the input order shifted).
    """
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, stable_id))
