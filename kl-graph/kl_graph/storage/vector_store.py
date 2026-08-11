"""Backend-neutral vector storage contract and factory."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kl_graph.config import DATA_DIR, cfg


@dataclass(slots=True)
class VectorPoint:
    """A vector point identified by its stable domain ID."""

    id: str
    vector: list[float]
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class VectorSearchResult(Mapping[str, Any]):
    """A backend-neutral vector search hit.

    The small ``Mapping`` compatibility surface lets existing ranking code use
    ``hit["score"]`` while new code can use typed attributes.
    """

    id: str
    score: float
    payload: dict[str, Any] = field(default_factory=dict)

    def __getitem__(self, key: str) -> Any:
        if key not in {"id", "score", "payload"}:
            raise KeyError(key)
        return getattr(self, key)

    def __iter__(self):
        return iter(("id", "score", "payload"))

    def __len__(self) -> int:
        return 3


class VectorStore(ABC):
    """Storage-independent vector collection operations."""

    @abstractmethod
    def upsert(self, collection: str, points: list[VectorPoint]) -> None:
        """Insert or replace points by stable ID.

        Callers should submit unique stable IDs. Implementations must raise when
        the backend reports a write failure; diagnostic verification may be
        stronger when application debug mode is enabled.
        """

    @abstractmethod
    def search(
        self,
        collection: str,
        query_vector: list[float],
        limit: int = 20,
        score_threshold: float | None = None,
        filter_payload: dict[str, Any] | None = None,
    ) -> list[VectorSearchResult]:
        """Return the most similar points, with larger scores being better."""

    @abstractmethod
    def retrieve_vectors(
        self, collection: str, ids: list[str]
    ) -> dict[str, list[float]]:
        """Retrieve vectors keyed by the requested stable IDs."""

    @abstractmethod
    def scroll_all(self, collection: str) -> Iterator[VectorPoint]:
        """Iterate every point in a collection, including vector and payload."""

    @abstractmethod
    def count(self, collection: str) -> int:
        """Return the number of points in a collection."""

    @abstractmethod
    def existing_ids(self, collection: str, ids: list[str]) -> set[str]:
        """Return the subset of stable IDs already stored."""

    @abstractmethod
    def delete(self, collection: str, ids: list[str]) -> None:
        """Delete points by stable ID."""

    @abstractmethod
    def close(self) -> None:
        """Flush and release backend resources."""

    @staticmethod
    def stable_id_to_point_id(stable_id: str) -> str:
        """Map a stable domain ID to the backend's physical point ID."""

        return stable_id


def vector_store_path(
    backend: str,
    data_dir: str | Path = DATA_DIR,
    *,
    namespace: str = "main",
) -> Path:
    """Return the local path used by a configured vector backend."""

    root = Path(data_dir)
    suffix = "data" if namespace == "main" else namespace
    return root / f"{backend}_{suffix}"


def create_vector_store(
    backend: str | None = None,
    *,
    data_dir: str | Path = DATA_DIR,
    embedding_dim: int | None = None,
    namespace: str = "main",
    path: str | Path | None = None,
    collections: list[str] | tuple[str, ...] | None = None,
    **kwargs: Any,
) -> VectorStore:
    """Create the selected vector backend using validated application config.

    ``data_dir`` is the runtime data root. ``path`` is an exact local-store
    override retained for callers that already expose a Qdrant path argument.
    Backend packages are imported lazily so a Qdrant deployment does not need
    Zvec installed, and vice versa.
    """

    selected = str(backend or cfg.storage.vector.backend).lower()
    dimension = int(embedding_dim or cfg.services.embedding.dim)
    local_path = Path(path) if path is not None else vector_store_path(
        selected, data_dir, namespace=namespace
    )

    if selected == "qdrant":
        from kl_graph.storage.qdrant_vector_store import QdrantVectorStore

        qcfg = cfg.storage.vector.qdrant
        options = {
            "host": str(qcfg.host),
            "port": int(qcfg.port),
            "api_key": str(qcfg.api_key),
            "exact_search": bool(qcfg.exact_search),
            **kwargs,
        }
        return QdrantVectorStore(
            path=local_path,
            embedding_dim=dimension,
            collections=collections,
            **options,
        )
    if selected == "zvec":
        from kl_graph.storage.zvec_vector_store import ZvecVectorStore

        zcfg = cfg.storage.vector.zvec
        options = {
            "index_type": str(zcfg.index_type),
            "metric": str(zcfg.metric),
            **kwargs,
        }
        return ZvecVectorStore(
            data_dir=local_path,
            embedding_dim=dimension,
            collections=collections,
            **options,
        )
    raise ValueError(f"Unknown vector backend: {selected!r}")


__all__ = [
    "VectorPoint",
    "VectorSearchResult",
    "VectorStore",
    "create_vector_store",
    "vector_store_path",
]
