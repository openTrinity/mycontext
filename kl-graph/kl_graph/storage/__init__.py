"""Storage backends for the knowledge graph.

Responsibilities:
- Define the KnowledgeStore ABC — the unified storage contract
- Provide SQLiteStore (all-SQLite), LadybugStore (hybrid: LadybugDB edges + SQLite content)
- Factory function create_store() selects backend by env var
- Expose GraphDB and PathResult for path-finding queries

Dependencies: kl_graph.models.types (data models), ladybug (required by the application-default LadybugStore)
"""

from kl_graph.storage.base import KnowledgeStore, create_store
from kl_graph.storage.graph_db import GraphDB, PathResult, create_graph_db
from kl_graph.storage.sqlite_store import SQLiteStore
from kl_graph.storage.vector_store import (
    VectorPoint,
    VectorSearchResult,
    VectorStore,
    create_vector_store,
)

__all__ = [
    "GraphDB",
    "KnowledgeStore",
    "PathResult",
    "SQLiteStore",
    "VectorPoint",
    "VectorSearchResult",
    "VectorStore",
    "create_graph_db",
    "create_store",
    "create_vector_store",
]
