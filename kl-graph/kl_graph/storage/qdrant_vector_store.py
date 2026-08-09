"""Qdrant implementation of the backend-neutral vector store."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from qdrant_client.models import (
    FieldCondition,
    Filter,
    MatchAny,
    MatchValue,
    PayloadSchemaType,
    PointStruct,
    Range,
)

from kl_graph.storage.qdrant_store import QdrantStore
from kl_graph.storage.vector_store import VectorPoint, VectorSearchResult, VectorStore

_STABLE_ID_KEY = "_kl_stable_id"

_COLLECTIONS = {
    **QdrantStore.COLLECTIONS,
    "communities": {
        "payload_indexes": {
            "level": PayloadSchemaType.KEYWORD,
            "node_type": PayloadSchemaType.KEYWORD,
            "member_count": PayloadSchemaType.INTEGER,
        }
    },
}


def _domain_id(collection: str, payload: dict[str, Any], fallback: str) -> str:
    stable = payload.get(_STABLE_ID_KEY)
    if stable is not None:
        return str(stable)
    key = {"chunks": "chunk_id", "entities": "entity_id", "facts": "fact_id"}.get(
        collection
    )
    if key and payload.get(key) is not None:
        return str(payload[key])
    if collection == "communities" and payload.get("community_id") is not None:
        return (
            f"community:{payload.get('level', '')}:{payload.get('node_type', '')}:"
            f"{payload['community_id']}"
        )
    return fallback


def _public_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    result = dict(payload or {})
    result.pop(_STABLE_ID_KEY, None)
    return result


def _split_filter_key(key: str) -> tuple[str, str]:
    for suffix in ("_gte", "_lte", "_gt", "_lt"):
        if key.endswith(suffix):
            return key[: -len(suffix)], suffix[1:]
    return key, "match"


def _to_qdrant_filter(payload_filter: dict[str, Any] | None) -> Filter | None:
    if not payload_filter:
        return None
    conditions = []
    ranges: dict[str, dict[str, Any]] = {}
    for raw_key, value in payload_filter.items():
        key, operation = _split_filter_key(raw_key)
        if operation != "match":
            ranges.setdefault(key, {})[operation] = value
        elif isinstance(value, (list, tuple, set, frozenset)):
            conditions.append(
                FieldCondition(key=key, match=MatchAny(any=list(value)))
            )
        else:
            conditions.append(FieldCondition(key=key, match=MatchValue(value=value)))
    conditions.extend(
        FieldCondition(key=key, range=Range(**bounds))
        for key, bounds in ranges.items()
    )
    return Filter(must=conditions)


class QdrantVectorStore(VectorStore):
    """Adapt the existing embedded/remote Qdrant implementation."""

    def __init__(
        self,
        path: str | Path | None = None,
        embedding_dim: int = 1024,
        *,
        data_dir: str | Path | None = None,
        host: str = "",
        port: int = 6333,
        api_key: str = "",
        exact_search: bool = False,
        collections: list[str] | tuple[str, ...] | None = None,
        client=None,
    ) -> None:
        names = tuple(collections or ("chunks", "entities", "facts"))
        unknown = set(names) - set(_COLLECTIONS)
        if unknown:
            raise ValueError(f"Unknown vector collections: {sorted(unknown)!r}")
        if path is None and data_dir is None:
            raise ValueError("QdrantVectorStore requires path or data_dir")
        self.path = str(path if path is not None else data_dir)
        self._store = QdrantStore(
            path=self.path,
            host=host,
            port=port,
            api_key=api_key,
            embedding_dim=embedding_dim,
            exact_search=exact_search,
            collections={name: _COLLECTIONS[name] for name in names},
            client=client,
        )

    @property
    def client(self):
        """Compatibility handle; backend-neutral callers must not use it."""

        return self._store.client

    @staticmethod
    def stable_id_to_point_id(stable_id: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, stable_id))

    def upsert(self, collection: str, points: list[VectorPoint]) -> None:
        converted = [
            PointStruct(
                id=self.stable_id_to_point_id(point.id),
                vector=point.vector,
                payload={**point.payload, _STABLE_ID_KEY: point.id},
            )
            for point in points
        ]
        self._store.upsert_batch(collection, converted)

    def search(
        self,
        collection: str,
        query_vector: list[float],
        limit: int = 20,
        score_threshold: float | None = None,
        filter_payload: dict[str, Any] | None = None,
    ) -> list[VectorSearchResult]:
        hits = self._store.search(
            collection,
            query_vector,
            limit=limit,
            filter_conditions=_to_qdrant_filter(filter_payload),
            score_threshold=score_threshold,
        )
        return [
            VectorSearchResult(
                id=_domain_id(collection, hit["payload"] or {}, str(hit["id"])),
                score=float(hit["score"]),
                payload=_public_payload(hit["payload"]),
            )
            for hit in hits
        ]

    def retrieve_vectors(
        self, collection: str, ids: list[str]
    ) -> dict[str, list[float]]:
        if not ids:
            return {}
        result: dict[str, list[float]] = {}
        for start in range(0, len(ids), 256):
            stable_batch = ids[start : start + 256]
            point_to_stable = {
                self.stable_id_to_point_id(stable_id): stable_id
                for stable_id in stable_batch
            }
            records = self.client.retrieve(
                collection_name=collection,
                ids=list(point_to_stable),
                with_payload=True,
                with_vectors=True,
            )
            for record in records:
                if record.vector is None:
                    continue
                physical_id = str(record.id)
                stable_id = _domain_id(
                    collection,
                    record.payload or {},
                    point_to_stable.get(physical_id, physical_id),
                )
                result[stable_id] = list(record.vector)
        return result

    def scroll_all(self, collection: str) -> Iterator[VectorPoint]:
        offset = None
        while True:
            records, offset = self.client.scroll(
                collection_name=collection,
                limit=256,
                offset=offset,
                with_vectors=True,
                with_payload=True,
            )
            for record in records:
                if record.vector is None:
                    continue
                payload = record.payload or {}
                yield VectorPoint(
                    id=_domain_id(collection, payload, str(record.id)),
                    vector=list(record.vector),
                    payload=_public_payload(payload),
                )
            if offset is None:
                break

    def count(self, collection: str) -> int:
        return self._store.count(collection)

    def existing_ids(self, collection: str, ids: list[str]) -> set[str]:
        if not ids:
            return set()
        mapping = {self.stable_id_to_point_id(stable_id): stable_id for stable_id in ids}
        found = self._store.existing_ids(collection, list(mapping))
        return {mapping[point_id] for point_id in found if point_id in mapping}

    def delete(self, collection: str, ids: list[str]) -> None:
        if not ids:
            return
        for start in range(0, len(ids), 256):
            self.client.delete(
                collection_name=collection,
                points_selector=[
                    self.stable_id_to_point_id(stable_id)
                    for stable_id in ids[start : start + 256]
                ],
            )

    def close(self) -> None:
        self._store.close()


__all__ = ["QdrantVectorStore"]
