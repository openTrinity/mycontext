"""Graph database abstraction — path queries across backends."""

from __future__ import annotations

import warnings
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Self


@dataclass
class PathNode:
    """A node on a path."""

    id: str  # bare entity/fact id
    node_type: str  # "entity" | "fact"
    label: str = ""  # resolved name/text (filled by server)


@dataclass
class PathEdge:
    """A directed edge on a path."""

    source_id: str
    target_id: str
    edge_type: str
    direction: str = "out"  # "out" or "in" (relative to traversal)
    properties: dict = field(default_factory=dict)


@dataclass
class Path:
    """A single path between two nodes."""

    nodes: list[PathNode]
    edges: list[PathEdge]
    hop_count: int = 0

    @property
    def length(self) -> int:
        """Number of edges in this path."""
        return len(self.edges)


@dataclass
class PathResult:
    """Result of a path query."""

    source: PathNode
    target: PathNode
    paths: list[Path]
    exhausted: bool = False  # True = no path exists within max_hops


class GraphDB(ABC):
    """Abstract graph database interface for path/traversal queries.

    Backends share the same interface so callers are backend-agnostic.
    The path-finding methods are the primary contract; raw Cypher (.query)
    is available on backends that support it but is NOT required.
    """

    @abstractmethod
    def find_paths(
        self,
        source_id: str,
        target_id: str,
        *,
        max_hops: int = 4,
        all_shortest: bool = False,
        edge_types: list[str] | None = None,
        node_types: list[str] | None = None,
    ) -> PathResult:
        """Find shortest path(s) between two nodes.

        Args:
            source_id: Bare entity/fact id of the start node.
            target_id: Bare entity/fact id of the end node.
            max_hops: Maximum path length (edges).
            all_shortest: If True, return ALL shortest paths (same length).
                          If False, return just one shortest path.
            edge_types: Restrict traversal to these edge types.
                        None = all walkable types.
            node_types: Restrict intermediate nodes to these types.
                        None = ["entity", "fact"].
        """
        ...

    @abstractmethod
    def neighbors(
        self,
        node_id: str,
        node_type: str,
        *,
        edge_types: list[str] | None = None,
        direction: str = "both",
        limit: int = 50,
    ) -> list[tuple[str, str, str, dict]]:
        """Return immediate neighbors of a node.

        Returns: [(neighbor_id, neighbor_type, edge_type, properties), ...]
        """
        ...

    def query(self, cypher: str, params: dict | None = None) -> list[dict[str, Any]]:
        """Execute raw Cypher (only available on Cypher-native backends).

        Raises NotImplementedError on backends that don't support it.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support raw Cypher queries"
        )

    @abstractmethod
    def close(self) -> None:
        """Close the database connection."""
        ...

    def __enter__(self) -> Self:
        """Enter context manager."""
        return self

    def __exit__(self, *_: object) -> None:
        """Exit context manager and close."""
        self.close()


def create_graph_db(backend: str = "sqlite", **kwargs: Any) -> GraphDB:
    """Factory for graph DB backends.

    .. deprecated::
        Use :func:`kl_graph.storage.base.create_store` instead.
        ``create_store()`` returns a ``KnowledgeStore`` that covers both
        storage and graph traversal in a single interface.

    Args:
        backend: "sqlite" (default), "ladybug", or "falkordb"
        **kwargs: Backend-specific options:
            sqlite: conn (sqlite3.Connection, required)
            ladybug: db_path (str, required)
            falkordb: graph_name (str), host (str), port (int)

    Raises:
        ValueError: If an unknown backend name is provided.
    """
    warnings.warn(
        "create_graph_db() is deprecated. Use create_store() from "
        "kl_graph.storage.base instead, which returns a KnowledgeStore "
        "covering both storage and graph traversal.",
        DeprecationWarning,
        stacklevel=2,
    )
    match backend:
        case "sqlite":
            from kl_graph.storage.sqlite_graph import SQLiteGraphDB

            return SQLiteGraphDB(**kwargs)
        case "ladybug":
            from kl_graph.storage.ladybug_graph import LadybugGraphDB

            return LadybugGraphDB(**kwargs)
        case "falkordb":
            from kl_graph.storage.falkor_graph import FalkorGraphDB

            return FalkorGraphDB(**kwargs)
        case _:
            raise ValueError(f"Unknown graph backend: {backend}")
