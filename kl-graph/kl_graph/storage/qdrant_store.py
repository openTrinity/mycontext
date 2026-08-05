"""Qdrant vector storage backend."""

from __future__ import annotations

from typing import Optional

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchAny,
    MatchValue,
    PayloadSchemaType,
    PointStruct,
    Range,
    SearchParams,
    VectorParams,
)

from kl_graph.config import EMBEDDING_DIM, QDRANT_PATH, QDRANT_EXACT_SEARCH


class QdrantStore:
    """Vector storage for chunks, entities, and facts.

    ``chunks`` is the unified retrieval-unit collection: every embedded piece of
    source content (chat messages today; PDF/doc/sheet chunks later) lives here,
    discriminated by the ``source_type`` payload field. ``entities`` and
    ``facts`` are graph-derived nodes and keep their own collections.
    """

    COLLECTIONS = {
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

    def __init__(self, path: Optional[str] = None):
        self.path = path or QDRANT_PATH
        self.client = QdrantClient(path=self.path)
        self._ensure_collections()

    def _ensure_collections(self):
        existing = {c.name for c in self.client.get_collections().collections}
        for name, config in self.COLLECTIONS.items():
            if name not in existing:
                self.client.create_collection(
                    collection_name=name,
                    vectors_config=VectorParams(
                        size=EMBEDDING_DIM,
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
        filter_conditions: Optional[Filter] = None,
        score_threshold: Optional[float] = None,
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
            search_params=SearchParams(exact=QDRANT_EXACT_SEARCH, hnsw_ef=128),
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
        source_types: Optional[list[str]] = None,
        min_timestamp: Optional[int] = None,
        max_timestamp: Optional[int] = None,
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
        min_timestamp: Optional[int] = None,
        max_timestamp: Optional[int] = None,
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

    def close(self):
        self.client.close()
