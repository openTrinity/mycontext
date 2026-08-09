"""Embedded Zvec implementation of :mod:`kl_graph.storage.vector_store`."""

from __future__ import annotations

import gc
import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from kl_graph.storage.vector_store import VectorPoint, VectorSearchResult, VectorStore

_VECTOR_FIELD = "embedding"
_PAYLOAD_FIELD = "_payload_json"

# Zvec collections have fixed schemas. The JSON field preserves the complete
# backend-neutral payload; the typed fields below are projections used by
# filters and indexes.
_PAYLOAD_FIELDS: dict[str, dict[str, str]] = {
    "chunks": {
        "chunk_id": "string",
        "source_type": "string",
        "source_ref": "string",
        "content": "string",
        "timestamp": "int64",
        "conversation_id": "string",
        "sender": "string",
        "sender_id": "string",
    },
    "entities": {
        "entity_id": "string",
        "name": "string",
        "entity_type": "string",
        "mention_count": "int32",
    },
    "facts": {
        "fact_id": "string",
        "text": "string",
        "fact_type": "string",
        "timestamp": "int64",
        "confidence": "double",
        "source_chunk_id": "string",
    },
    "communities": {
        "level": "string",
        "community_id": "int64",
        "node_type": "string",
        "member_count": "int32",
        "summary": "string",
        "tags": "string",
        "top_members": "string",
    },
}

_FILTER_FIELDS = {
    "chunks": {"source_type", "conversation_id", "sender_id", "timestamp"},
    "entities": {"entity_type", "mention_count"},
    "facts": {"fact_type", "timestamp", "confidence"},
    "communities": {"level", "node_type", "member_count"},
}


def _split_filter_key(key: str) -> tuple[str, str]:
    for suffix in ("_gte", "_lte", "_gt", "_lt"):
        if key.endswith(suffix):
            return key[: -len(suffix)], suffix[1:]
    return key, "match"


def _literal(value: Any) -> str:
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return repr(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    raise TypeError(f"Unsupported Zvec filter value: {value!r}")


def _filter_expression(
    collection: str, payload_filter: dict[str, Any] | None
) -> str | None:
    if not payload_filter:
        return None
    clauses: list[str] = []
    operators = {"gte": ">=", "lte": "<=", "gt": ">", "lt": "<"}
    allowed = _FILTER_FIELDS[collection]
    for raw_key, value in payload_filter.items():
        field, operation = _split_filter_key(raw_key)
        if field not in allowed:
            raise ValueError(
                f"Payload field {field!r} is not filterable in {collection!r}"
            )
        if operation != "match":
            clauses.append(f"{field} {operators[operation]} {_literal(value)}")
        elif isinstance(value, (list, tuple, set, frozenset)):
            values = list(value)
            if not values:
                return ""
            clauses.append(f"{field} IN ({', '.join(_literal(v) for v in values)})")
        else:
            clauses.append(f"{field} = {_literal(value)}")
    return " AND ".join(clauses)


class ZvecVectorStore(VectorStore):
    """Zvec-backed vector store with one on-disk collection per node type."""

    def __init__(
        self,
        data_dir: str | Path,
        embedding_dim: int,
        *,
        index_type: str = "hnsw",
        metric: str = "cosine",
        collections: list[str] | tuple[str, ...] | None = None,
        optimize_on_upsert: bool = True,
    ) -> None:
        try:
            import zvec
        except ImportError as exc:  # pragma: no cover - exercised without extra
            raise ImportError(
                "The zvec backend requires the 'zvec' package (pip install zvec)"
            ) from exc

        self._zvec = zvec
        self.data_dir = Path(data_dir)
        self.embedding_dim = int(embedding_dim)
        self.index_type = index_type.lower()
        self.metric = metric.lower()
        self.optimize_on_upsert = bool(optimize_on_upsert)
        names = tuple(collections or ("chunks", "entities", "facts"))
        unknown = set(names) - set(_PAYLOAD_FIELDS)
        if unknown:
            raise ValueError(f"Unknown vector collections: {sorted(unknown)!r}")

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._manifest_path = self.data_dir / "point_ids.sqlite3"
        self._init_manifest()
        self._collections = {name: self._open_collection(name) for name in names}

    def _init_manifest(self) -> None:
        with sqlite3.connect(self._manifest_path) as conn:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS point_ids (
                       collection TEXT NOT NULL,
                       point_id TEXT NOT NULL,
                       PRIMARY KEY (collection, point_id)
                   )"""
            )

    def _metric_type(self):
        mapping = {
            "cosine": self._zvec.MetricType.COSINE,
            "ip": self._zvec.MetricType.IP,
            "l2": self._zvec.MetricType.L2,
        }
        try:
            return mapping[self.metric]
        except KeyError as exc:
            raise ValueError(f"Unsupported Zvec metric: {self.metric!r}") from exc

    def _index_param(self):
        metric = self._metric_type()
        if self.index_type == "hnsw":
            return self._zvec.HnswIndexParam(metric_type=metric)
        if self.index_type == "flat":
            return self._zvec.FlatIndexParam(metric_type=metric)
        if self.index_type == "ivf":
            return self._zvec.IVFIndexParam(metric_type=metric)
        if self.index_type == "diskann":
            raise ValueError("Zvec 0.6 does not expose a DiskANN index")
        raise ValueError(f"Unsupported Zvec index type: {self.index_type!r}")

    def _field_type(self, name: str):
        return {
            "string": self._zvec.DataType.STRING,
            "int32": self._zvec.DataType.INT32,
            "int64": self._zvec.DataType.INT64,
            "double": self._zvec.DataType.DOUBLE,
        }[name]

    def _schema(self, collection: str):
        fields = []
        for name, type_name in _PAYLOAD_FIELDS[collection].items():
            index = (
                self._zvec.InvertIndexParam()
                if name in _FILTER_FIELDS[collection]
                else None
            )
            fields.append(
                self._zvec.FieldSchema(
                    name=name,
                    data_type=self._field_type(type_name),
                    nullable=True,
                    index_param=index,
                )
            )
        fields.append(
            self._zvec.FieldSchema(
                name=_PAYLOAD_FIELD,
                data_type=self._zvec.DataType.STRING,
                nullable=False,
            )
        )
        return self._zvec.CollectionSchema(
            name=collection,
            fields=fields,
            vectors=[
                self._zvec.VectorSchema(
                    name=_VECTOR_FIELD,
                    data_type=self._zvec.DataType.VECTOR_FP32,
                    dimension=self.embedding_dim,
                    index_param=self._index_param(),
                )
            ],
        )

    def _open_collection(self, name: str):
        path = self.data_dir / name
        if path.exists():
            collection = self._zvec.open(str(path))
            vector_schema = collection.schema.vector(_VECTOR_FIELD)
            if vector_schema is None or vector_schema.dimension != self.embedding_dim:
                raise ValueError(
                    f"Zvec collection {name!r} has an incompatible embedding dimension"
                )
            return collection
        return self._zvec.create_and_open(str(path), self._schema(name))

    def _collection(self, name: str):
        try:
            return self._collections[name]
        except KeyError as exc:
            raise ValueError(f"Vector collection is not open: {name!r}") from exc

    def _fields(self, collection: str, payload: dict[str, Any]) -> dict[str, Any]:
        projected = {
            name: payload[name]
            for name in _PAYLOAD_FIELDS[collection]
            if name in payload and payload[name] is not None
        }
        projected[_PAYLOAD_FIELD] = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        )
        return projected

    @staticmethod
    def _payload(doc) -> dict[str, Any]:
        raw = doc.fields.get(_PAYLOAD_FIELD, "{}")
        try:
            value = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            value = {}
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _check_statuses(statuses) -> None:
        values = statuses if isinstance(statuses, list) else [statuses]
        failed = [
            status
            for status in values
            if callable(getattr(status, "ok", None)) and not status.ok()
        ]
        if failed:
            raise RuntimeError(f"Zvec operation failed: {failed[0]}")

    def _remember_ids(self, collection: str, ids: list[str]) -> None:
        with sqlite3.connect(self._manifest_path) as conn:
            conn.executemany(
                "INSERT OR IGNORE INTO point_ids(collection, point_id) VALUES (?, ?)",
                ((collection, point_id) for point_id in ids),
            )

    def _forget_ids(self, collection: str, ids: list[str]) -> None:
        with sqlite3.connect(self._manifest_path) as conn:
            conn.executemany(
                "DELETE FROM point_ids WHERE collection = ? AND point_id = ?",
                ((collection, point_id) for point_id in ids),
            )

    def _manifest_ids(self, collection: str) -> list[str]:
        with sqlite3.connect(self._manifest_path) as conn:
            rows = conn.execute(
                "SELECT point_id FROM point_ids WHERE collection = ? ORDER BY point_id",
                (collection,),
            ).fetchall()
        ids = [str(row[0]) for row in rows]
        expected = self.count(collection)
        if len(ids) == expected:
            return ids
        # Recover a manifest that was absent or interrupted between Zvec's
        # durable write and the sidecar commit. Zvec has no scan API, so a
        # neutral zero-vector top-k query is the only complete enumeration.
        if expected == 0:
            return []
        docs = self._collection(collection).query(
            self._zvec.Query(_VECTOR_FIELD, vector=[0.0] * self.embedding_dim),
            topk=expected,
            include_vector=False,
            output_fields=[],
        )
        ids = [str(doc.id) for doc in docs]
        with sqlite3.connect(self._manifest_path) as conn:
            conn.execute("DELETE FROM point_ids WHERE collection = ?", (collection,))
            conn.executemany(
                "INSERT INTO point_ids(collection, point_id) VALUES (?, ?)",
                ((collection, point_id) for point_id in ids),
            )
        return ids

    def upsert(self, collection: str, points: list[VectorPoint]) -> None:
        if not points:
            return
        target = self._collection(collection)
        ids: list[str] = []
        for start in range(0, len(points), 1000):
            batch = points[start : start + 1000]
            docs = [
                self._zvec.Doc(
                    id=point.id,
                    vectors={_VECTOR_FIELD: point.vector},
                    fields=self._fields(collection, point.payload),
                )
                for point in batch
            ]
            self._check_statuses(target.upsert(docs))
            ids.extend(point.id for point in batch)
        target.flush()
        if self.optimize_on_upsert:
            target.optimize()
        self._remember_ids(collection, ids)

    def _similarity(self, raw_score: float) -> float:
        if self.metric == "cosine":
            return 1.0 - raw_score
        if self.metric == "ip":
            return -raw_score
        return 1.0 / (1.0 + max(0.0, raw_score))

    def search(
        self,
        collection: str,
        query_vector: list[float],
        limit: int = 20,
        score_threshold: float | None = None,
        filter_payload: dict[str, Any] | None = None,
    ) -> list[VectorSearchResult]:
        if limit <= 0:
            return []
        expression = _filter_expression(collection, filter_payload)
        if expression == "":
            return []
        docs = self._collection(collection).query(
            self._zvec.Query(_VECTOR_FIELD, vector=query_vector),
            topk=limit,
            filter=expression,
        )
        results = [
            VectorSearchResult(
                id=str(doc.id),
                score=self._similarity(float(doc.score or 0.0)),
                payload=self._payload(doc),
            )
            for doc in docs
        ]
        if score_threshold is not None:
            results = [hit for hit in results if hit.score >= score_threshold]
        return results

    def retrieve_vectors(
        self, collection: str, ids: list[str]
    ) -> dict[str, list[float]]:
        result: dict[str, list[float]] = {}
        target = self._collection(collection)
        for start in range(0, len(ids), 1000):
            docs = target.fetch(
                ids[start : start + 1000], output_fields=[], include_vector=True
            )
            for point_id, doc in docs.items():
                vector = doc.vector(_VECTOR_FIELD)
                if vector is not None:
                    result[str(point_id)] = list(vector)
        return result

    def scroll_all(self, collection: str) -> Iterator[VectorPoint]:
        target = self._collection(collection)
        ids = self._manifest_ids(collection)
        for start in range(0, len(ids), 1000):
            docs = target.fetch(ids[start : start + 1000], include_vector=True)
            for point_id in ids[start : start + 1000]:
                doc = docs.get(point_id)
                if doc is None:
                    continue
                vector = doc.vector(_VECTOR_FIELD)
                if vector is not None:
                    yield VectorPoint(
                        id=point_id,
                        vector=list(vector),
                        payload=self._payload(doc),
                    )

    def count(self, collection: str) -> int:
        return int(self._collection(collection).stats.doc_count)

    def existing_ids(self, collection: str, ids: list[str]) -> set[str]:
        found: set[str] = set()
        target = self._collection(collection)
        for start in range(0, len(ids), 1000):
            found.update(
                str(point_id)
                for point_id in target.fetch(
                    ids[start : start + 1000],
                    output_fields=[],
                    include_vector=False,
                )
            )
        return found

    def delete(self, collection: str, ids: list[str]) -> None:
        if not ids:
            return
        target = self._collection(collection)
        for start in range(0, len(ids), 1000):
            batch = ids[start : start + 1000]
            self._check_statuses(target.delete(batch))
        target.flush()
        self._forget_ids(collection, ids)

    def close(self) -> None:
        for collection in self._collections.values():
            collection.flush()
        # Zvec 0.6 exposes no close method. Dropping the last native wrapper
        # releases mmap/file handles (important on Windows).
        self._collections.clear()
        gc.collect()


__all__ = ["ZvecVectorStore"]
