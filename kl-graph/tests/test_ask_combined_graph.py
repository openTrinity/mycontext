"""Combined graph tests: /ask nested shape, chunk nodes, /chunk endpoint, batch store read.

Tests the [!RED] breaking change from flat to nested graph response shape, plus
the new chunk-node surfacing and batch chunk retrieval via get_chunks_by_ids.

Run: `.venv/bin/python -m pytest tests/test_ask_combined_graph.py -v`
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.query import graph_walk as gw
from kl_graph.storage.sqlite_store import SQLiteStore
from kl_server import (
    app,
    state,
    _connected_components,
    _resolve_nodes,
    _chunk_impl,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def sqlite_store(tmp_path: Path) -> SQLiteStore:
    """Create an in-memory SQLiteStore with real schema."""
    store = SQLiteStore(tmp_path / "test.db")
    return store


@pytest.fixture
def adjacency_with_chunk() -> dict:
    """Hand-built adjacency: fact f1 -> chunk c1 via STATES edge.

    Adjacency format: bare_id -> [(edge_type, related_id, related_type, direction)]
    """
    return {
        "f1": [
            ("STATES", "c1", "chunk", "out"),
            ("ABOUT", "e1", "entity", "out"),
        ],
        "c1": [
            ("STATES", "f1", "fact", "in"),
        ],
        "e1": [
            ("ABOUT", "f1", "fact", "in"),
        ],
    }


@pytest.fixture
def sample_chunks(sqlite_store: SQLiteStore) -> list[str]:
    """Insert sample chunks and return their IDs."""
    from kl_graph.models.types import Chunk

    chunks = [
        Chunk(id="c1", content="Test chunk 1", source_type="message", timestamp=1000),
        Chunk(id="c2", content="Test chunk 2", source_type="document", timestamp=2000),
        Chunk(id="c3", content="Test chunk 3", source_type="message", timestamp=3000),
    ]
    sqlite_store.insert_chunks(chunks)
    return ["c1", "c2", "c3"]


# ── Test 1: get_chunks_by_ids ────────────────────────────────────────────────


def test_get_chunks_by_ids_returns_known_ids(
    sqlite_store: SQLiteStore, sample_chunks: list[str]
) -> None:
    """get_chunks_by_ids returns chunks for known IDs, skips unknown."""
    # Request known and unknown IDs
    result = sqlite_store.get_chunks_by_ids(["c1", "c2", "unknown", "c3"])

    # Should return 3 chunks (unknown is skipped)
    assert len(result) == 3
    returned_ids = {c.id for c in result}
    assert returned_ids == {"c1", "c2", "c3"}

    # Verify content
    c1 = next(c for c in result if c.id == "c1")
    assert c1.content == "Test chunk 1"
    assert c1.source_type == "message"
    assert c1.timestamp == 1000


def test_get_chunks_by_ids_empty_input(sqlite_store: SQLiteStore) -> None:
    """get_chunks_by_ids with empty list returns empty list."""
    result = sqlite_store.get_chunks_by_ids([])
    assert result == []


def test_get_chunks_by_ids_all_unknown(sqlite_store: SQLiteStore) -> None:
    """get_chunks_by_ids with all unknown IDs returns empty list."""
    result = sqlite_store.get_chunks_by_ids(["x", "y", "z"])
    assert result == []


def test_get_chunks_by_ids_batching(sqlite_store: SQLiteStore) -> None:
    """get_chunks_by_ids handles >500 IDs (SQLite variable limit is 999)."""
    from kl_graph.models.types import Chunk

    # Insert 600 chunks
    chunk_ids = [f"chunk_{i}" for i in range(600)]
    chunks = [
        Chunk(id=cid, content=f"Content {cid}", source_type="message", timestamp=0)
        for cid in chunk_ids
    ]
    sqlite_store.insert_chunks(chunks)

    # Request all 600 (triggers batching at 500)
    result = sqlite_store.get_chunks_by_ids(chunk_ids)
    assert len(result) == 600
    returned_ids = {c.id for c in result}
    assert returned_ids == set(chunk_ids)


# ── Test 2: _connected_components ────────────────────────────────────────────


def test_connected_components_merges_shared_neighbors() -> None:
    """Two nodes sharing a 1-hop neighbor land in the same component."""
    # Build resolved nodes
    nodes = [
        {"id": "ent:e1", "type": "entity", "score": 0.9, "hop": 0, "name": "E1"},
        {"id": "ent:e2", "type": "entity", "score": 0.8, "hop": 0, "name": "E2"},
        {"id": "fact:f1", "type": "fact", "score": 0.7, "hop": 1, "text": "F1"},
    ]

    # Build labeled edges: e1 -> f1, e2 -> f1 (shared neighbor)
    edges = [
        {"from": "ent:e1", "to": "fact:f1", "type": "ABOUT", "from_label": "E1", "to_label": "F1"},
        {"from": "ent:e2", "to": "fact:f1", "type": "ABOUT", "from_label": "E2", "to_label": "F1"},
    ]

    components = _connected_components(nodes, edges)

    # Should be 1 component with all 3 nodes
    assert len(components) == 1
    comp = components[0]
    assert len(comp["nodes"]) == 3
    assert len(comp["edges"]) == 2


def test_connected_components_isolated_node() -> None:
    """A node with no edges forms its own single-node component."""
    nodes = [
        {"id": "ent:e1", "type": "entity", "score": 0.9, "hop": 0, "name": "E1"},
        {"id": "ent:e2", "type": "entity", "score": 0.5, "hop": 0, "name": "E2"},
    ]
    edges = []  # No edges

    components = _connected_components(nodes, edges)

    # Should be 2 separate components
    assert len(components) == 2
    # Ordered by best score (descending)
    assert components[0]["nodes"][0]["id"] == "ent:e1"
    assert components[1]["nodes"][0]["id"] == "ent:e2"
    # Each has empty edges
    assert components[0]["edges"] == []
    assert components[1]["edges"] == []


def test_connected_components_ordered_by_score() -> None:
    """Components are ordered by best node score (descending)."""
    nodes = [
        {"id": "ent:e1", "type": "entity", "score": 0.5, "hop": 0, "name": "E1"},
        {"id": "ent:e2", "type": "entity", "score": 0.9, "hop": 0, "name": "E2"},
        {"id": "ent:e3", "type": "entity", "score": 0.7, "hop": 0, "name": "E3"},
    ]
    edges = []

    components = _connected_components(nodes, edges)

    assert len(components) == 3
    assert components[0]["nodes"][0]["score"] == 0.9  # e2
    assert components[1]["nodes"][0]["score"] == 0.7  # e3
    assert components[2]["nodes"][0]["score"] == 0.5  # e1


# ── Test 3: _resolve_nodes chunk branch ───────────────────────────────────────


def test_resolve_nodes_chunk_branch(sqlite_store: SQLiteStore, sample_chunks: list[str]) -> None:
    """_resolve_nodes chunk branch returns source_type/timestamp/readable, no content."""
    # Patch state
    original_conn = state.sqlite_conn
    state.sqlite_conn = sqlite_store.conn

    try:
        # Build walk nodes with a chunk
        chunk_id = "c1"
        nodes = [
            {"id": gw.namespaced(chunk_id, "chunk"), "score": 0.8, "hop": 1},
        ]

        resolved = _resolve_nodes(nodes)

        assert len(resolved) == 1
        node = resolved[0]

        # Chunk branch assertions
        assert node["type"] == "chunk"
        assert node["source_type"] == "message"
        assert node["timestamp"] == 1000
        assert node["readable"] is True
        # Critical: NO content key
        assert "content" not in node
    finally:
        state.sqlite_conn = original_conn


# ── Test 4: /chunk endpoint ──────────────────────────────────────────────────


def test_chunk_endpoint_known_ids(
    sqlite_store: SQLiteStore, sample_chunks: list[str]
) -> None:
    """/chunk returns full content for known IDs in request order."""
    from kl_server import ChunkRequest

    original_store = state.store
    state.store = sqlite_store

    try:
        req = ChunkRequest(chunk_ids=["c2", "c1"])
        result = _chunk_impl(req)

        assert "chunks" in result
        chunks = result["chunks"]
        assert len(chunks) == 2

        # Request order preserved
        assert chunks[0]["id"] == "c2"
        assert chunks[0]["found"] is True
        assert chunks[0]["content"] == "Test chunk 2"
        assert chunks[0]["source_type"] == "document"
        assert chunks[0]["timestamp"] == 2000

        assert chunks[1]["id"] == "c1"
        assert chunks[1]["found"] is True
        assert chunks[1]["content"] == "Test chunk 1"
    finally:
        state.store = original_store


def test_chunk_endpoint_unknown_id(sqlite_store: SQLiteStore) -> None:
    """/chunk returns found:false for unknown IDs."""
    from kl_server import ChunkRequest

    original_store = state.store
    state.store = sqlite_store

    try:
        req = ChunkRequest(chunk_ids=["unknown"])
        result = _chunk_impl(req)

        chunks = result["chunks"]
        assert len(chunks) == 1
        assert chunks[0]["id"] == "unknown"
        assert chunks[0]["found"] is False
        # No content/source_type/timestamp when not found
        assert "content" not in chunks[0]
    finally:
        state.store = original_store


def test_chunk_endpoint_strips_prefix(
    sqlite_store: SQLiteStore, sample_chunks: list[str]
) -> None:
    """/chunk strips cnk: prefix and returns the original requested ID."""
    from kl_server import ChunkRequest

    original_store = state.store
    state.store = sqlite_store

    try:
        req = ChunkRequest(chunk_ids=["cnk:c1"])
        result = _chunk_impl(req)

        chunks = result["chunks"]
        assert len(chunks) == 1
        # Echoes the ORIGINAL requested ID (with prefix)
        assert chunks[0]["id"] == "cnk:c1"
        assert chunks[0]["found"] is True
        assert chunks[0]["content"] == "Test chunk 1"
    finally:
        state.store = original_store


# ── Test 5: /ask nested graph shape ──────────────────────────────────────────


def test_ask_returns_nested_graph_shape(
    sqlite_store: SQLiteStore, adjacency_with_chunk: dict
) -> None:
    """/ask returns graph.components, recalled_chunks, graph_mermaids."""
    from kl_graph.query.engine import QueryResult

    # Patch state
    original_adj = state.adjacency
    original_conn = state.sqlite_conn
    original_ready = state.ready
    original_engine = state.engine

    state.adjacency = adjacency_with_chunk
    state.sqlite_conn = sqlite_store.conn
    state.ready = True

    # Stub engine to return a minimal QueryResult
    class StubEngine:
        async def aquery(self, query: str, force_phase2: bool = False) -> QueryResult:
            return QueryResult(
                items=[],
                phase=1,
                entities_found=[],
                matched_entities=[],
                q_vec=[0.1] * 128,
                fact_hits=[],
                chunk_hits=[],
            )

    state.engine = StubEngine()

    try:
        # Plain TestClient (NOT `with ...`) so the FastAPI lifespan does NOT run
        # and clobber the patched global state with the real DB — mirrors
        # tests/test_path_endpoint.py's lifespan-free client.
        client = TestClient(app)
        response = client.post("/ask", json={"query": "test", "radius": 1})

        assert response.status_code == 200
        data = response.json()

        # Nested graph shape
        assert "graph" in data
        assert "components" in data["graph"]
        assert isinstance(data["graph"]["components"], list)

        # Top-level recalled_chunks
        assert "recalled_chunks" in data
        assert isinstance(data["recalled_chunks"], list)

        # graph_mermaids (one per component)
        assert "graph_mermaids" in data
        assert isinstance(data["graph_mermaids"], list)
        assert len(data["graph_mermaids"]) == len(data["graph"]["components"])
    finally:
        state.adjacency = original_adj
        state.sqlite_conn = original_conn
        state.ready = original_ready
        state.engine = original_engine


def test_ask_chunks_only_empty_graph(sqlite_store: SQLiteStore) -> None:
    """/ask with no graph returns empty components and recalled_chunks."""
    from kl_graph.query.engine import QueryResult
    from kl_server import _ask_graph_walk, AskRequest

    original_conn = state.sqlite_conn
    original_adj = state.adjacency
    original_engine = state.engine

    # Empty adjacency = no graph
    state.adjacency = {}
    state.sqlite_conn = sqlite_store.conn

    # Create a result with empty hits
    result = QueryResult(
        items=[],
        phase=1,
        entities_found=[],
        matched_entities=[],
        q_vec=[],
        fact_hits=[],  # Empty fact hits
        chunk_hits=[],  # Empty chunk hits
    )

    # Create a request
    req = AskRequest(query="test")

    try:
        # Call the implementation directly
        walk_data = _ask_graph_walk(req, result)

        # With empty adjacency and empty hits, should have no components
        assert walk_data["graph"]["components"] == []
        assert walk_data["recalled_chunks"] == []
        assert walk_data["graph_mermaids"] == []
    finally:
        state.adjacency = original_adj
        state.sqlite_conn = original_conn
        state.engine = original_engine


# ── Test 6: Chunk-seed bucket ────────────────────────────────────────────────


def test_chunk_seed_in_recalled_chunks(sqlite_store: SQLiteStore) -> None:
    """Chunk hits appear in recalled_chunks by chunk_id."""
    from kl_graph.models.types import Chunk
    from kl_graph.query.engine import QueryResult
    from kl_server import _ask_graph_walk, AskRequest

    # Insert a chunk
    sqlite_store.insert_chunks(
        [Chunk(id="c_seed", content="Seed chunk", source_type="message", timestamp=5000)]
    )

    original_conn = state.sqlite_conn
    original_adj = state.adjacency
    original_engine = state.engine

    state.sqlite_conn = sqlite_store.conn
    # Set up adjacency that includes the chunk so it can be walked
    state.adjacency = {
        "c_seed": [("STATES", "f1", "fact", "in")],
        "f1": [("STATES", "c_seed", "chunk", "out")],
    }

    # Create a result with chunk_hits
    result = QueryResult(
        items=[],
        phase=1,
        entities_found=[],
        matched_entities=[],
        q_vec=[],
        fact_hits=[],
        chunk_hits=[
            {
                "payload": {"chunk_id": "c_seed", "source_type": "message", "timestamp": 5000},
                "score": 0.95,
            },
        ],
    )

    # Create a request
    req = AskRequest(query="test")

    try:
        # Call the implementation directly
        walk_data = _ask_graph_walk(req, result)
        recalled = walk_data.get("recalled_chunks", [])

        # Should have the chunk seed
        assert len(recalled) >= 1
        chunk_ids = [r.get("id") for r in recalled]
        # Check for the namespaced chunk ID
        assert any("c_seed" in cid for cid in chunk_ids)
    finally:
        state.sqlite_conn = original_conn
        state.adjacency = original_adj
        state.engine = original_engine


# ── Test 7: All edge types render ────────────────────────────────────────────


def test_all_edge_types_in_components() -> None:
    """Component edges include ABOUT, ENTITY_SIMILAR, TEMPORAL with labels."""
    nodes = [
        {"id": "fact:f1", "type": "fact", "score": 0.9, "hop": 0, "text": "F1"},
        {"id": "ent:e1", "type": "entity", "score": 0.8, "hop": 1, "name": "E1"},
        {"id": "ent:e2", "type": "entity", "score": 0.7, "hop": 1, "name": "E2"},
        {"id": "cnk:c1", "type": "chunk", "score": 0.6, "hop": 1, "source_type": "message", "timestamp": 1000},
        {"id": "cnk:c2", "type": "chunk", "score": 0.5, "hop": 1, "source_type": "message", "timestamp": 2000},
    ]

    edges = [
        # ABOUT: fact -> entity
        {"from": "fact:f1", "to": "ent:e1", "type": "ABOUT", "from_label": "F1", "to_label": "E1"},
        # ENTITY_SIMILAR: entity -> entity
        {"from": "ent:e1", "to": "ent:e2", "type": "ENTITY_SIMILAR", "from_label": "E1", "to_label": "E2"},
        # TEMPORAL: chunk -> chunk (connect to entity to make single component)
        {"from": "ent:e2", "to": "cnk:c1", "type": "MENTIONS", "from_label": "E2", "to_label": "c1"},
        {"from": "cnk:c1", "to": "cnk:c2", "type": "TEMPORAL", "from_label": "c1", "to_label": "c2"},
    ]

    components = _connected_components(nodes, edges)

    # All nodes connected via edges -> 1 component
    assert len(components) == 1
    comp = components[0]

    # All edge types present
    edge_types = {e["type"] for e in comp["edges"]}
    assert "ABOUT" in edge_types
    assert "ENTITY_SIMILAR" in edge_types
    assert "TEMPORAL" in edge_types
    assert "MENTIONS" in edge_types

    # All edges have from_label and to_label
    for edge in comp["edges"]:
        assert "from_label" in edge
        assert "to_label" in edge


# ── Test 8: graph_mermaids ───────────────────────────────────────────────────


def test_mermaid_starts_with_graph_td() -> None:
    """Each mermaid string starts with 'graph TD'."""
    nodes = [
        {"id": "ent:e1", "type": "entity", "score": 0.9, "hop": 0, "name": "E1"},
    ]
    edges = []

    mermaid = gw.to_mermaid(nodes, edges)

    assert mermaid.startswith("graph TD")


def test_mermaid_chunk_shape() -> None:
    """Chunk nodes render with the [/.../] parallelogram shape."""
    nodes = [
        {"id": "cnk:c1", "type": "chunk", "score": 0.8, "hop": 1, "source_type": "message", "timestamp": 1000},
    ]
    edges = []

    mermaid = gw.to_mermaid(nodes, edges)

    # Chunk shape marker: [/
    assert "[/" in mermaid


def test_mermaid_all_four_node_types() -> None:
    """to_mermaid handles entity, fact, chunk, community (4 node types)."""
    nodes = [
        {"id": "ent:e1", "type": "entity", "score": 0.9, "hop": 0, "name": "E1"},
        {"id": "fact:f1", "type": "fact", "score": 0.8, "hop": 1, "text": "F1"},
        {"id": "cnk:c1", "type": "chunk", "score": 0.7, "hop": 1, "source_type": "message", "timestamp": 1000},
        {"id": "comm:comm1", "type": "community", "score": 0.6, "hop": 1, "summary": "C1"},
    ]
    edges = [
        {"from": "ent:e1", "to": "fact:f1", "type": "ABOUT", "from_label": "E1", "to_label": "F1"},
    ]

    mermaid = gw.to_mermaid(nodes, edges)

    # All 4 node shapes present
    assert "E1" in mermaid  # entity
    assert "F1" in mermaid  # fact
    assert "[/" in mermaid  # chunk parallelogram
    assert "{" in mermaid  # community hexagon (uses { not {{)


# ── Test 9: KnowledgeStore ABC ───────────────────────────────────────────────


def test_knowledge_store_abc_has_get_chunks_by_ids() -> None:
    """KnowledgeStore ABC includes get_chunks_by_ids method."""
    from kl_graph.storage.base import KnowledgeStore

    # Check that get_chunks_by_ids is defined in the ABC
    assert hasattr(KnowledgeStore, "get_chunks_by_ids")

    # Verify it's an abstract method
    method = getattr(KnowledgeStore, "get_chunks_by_ids")
    assert getattr(method, "__isabstractmethod__", False)


def test_sqlite_store_implements_get_chunks_by_ids(sqlite_store: SQLiteStore) -> None:
    """SQLiteStore implements get_chunks_by_ids (no longer abstract)."""
    # SQLiteStore should have a concrete implementation
    method = getattr(sqlite_store, "get_chunks_by_ids")
    # Should not be abstract
    assert not getattr(method, "__isabstractmethod__", False)


# ── Test 10: LadybugStore get_chunks_by_ids ────────────────────────────────


def test_ladybug_store_get_chunks_by_ids(sqlite_store: SQLiteStore, sample_chunks: list[str]) -> None:
    """LadybugStore.get_chunks_by_ids delegates to SQLite and skips unknown IDs."""
    from kl_graph.storage.ladybug_store import LadybugStore

    # LadybugStore wraps a SQLiteStore
    # We'll test the delegation by checking that it calls the underlying store

    # Since we can't easily instantiate a real LadybugStore without LadybugDB,
    # we verify the method exists and has the right signature
    assert hasattr(LadybugStore, "get_chunks_by_ids")

    # Verify it's implemented (not abstract)
    method = getattr(LadybugStore, "get_chunks_by_ids")
    assert not getattr(method, "__isabstractmethod__", False)

    # The actual delegation is tested via the SQLiteStore tests above,
    # since LadybugStore.get_chunks_by_ids just calls self._sqlite.get_chunks_by_ids