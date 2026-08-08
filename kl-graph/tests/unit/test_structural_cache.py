"""Unit tests for the StructuralCache (Optimization 1).

Tests verify:
- from_store loads correctly from a mock store
- apply_delta updates all four maps
- entities_for_chunks and entities_for_facts return correct sets
- Non-structural edges (ENTITY_SIMILAR) are ignored by apply_delta
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

from kl_graph.ingest.pipeline import IngestionPipeline, entity_id_from_name
from kl_graph.ingest.structural_cache import StructuralCache
from kl_graph.models.types import Edge, EdgeType


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_edge(
    source_type: str,
    source_id: str,
    target_type: str,
    target_id: str,
    edge_type: EdgeType,
) -> Edge:
    """Build a minimal Edge object for testing."""
    return Edge(
        source_type=source_type,
        source_id=source_id,
        target_type=target_type,
        target_id=target_id,
        edge_type=edge_type,
    )


def _mock_store(
    mentions_edges: list[tuple[str, str, dict]] | None = None,
    about_edges: list[tuple[str, str, dict]] | None = None,
) -> MagicMock:
    """Build a mock KnowledgeStore whose scan_edges_by_type returns per-type rows.

    scan_edges_by_type receives a list of edge type strings and yields tuples
    of (source_id, target_id, properties). The mock dispatches based on the
    requested edge types.
    """
    mentions_edges = mentions_edges or []
    about_edges = about_edges or []

    def scan_edges_by_type(edge_types, source_type=None, target_type=None):
        et_set = set(edge_types)
        if et_set == {"MENTIONS", "AUTHORED_BY"}:
            yield from mentions_edges
        elif et_set == {"ABOUT"}:
            yield from about_edges
        # else: no rows for unknown type combos

    store = MagicMock()
    store.scan_edges_by_type = scan_edges_by_type
    return store


# ── Tests ─────────────────────────────────────────────────────────────────────


class TestFromStore:
    """from_store: full O(E) load from the store."""

    def test_loads_mentions_and_authored_by(self):
        """MENTIONS and AUTHORED_BY edges populate entity↔chunk maps."""
        mentions = [
            ("chunk-1", "entity-A", {}),
            ("chunk-2", "entity-A", {}),
            ("chunk-1", "entity-B", {}),
        ]
        store = _mock_store(mentions_edges=mentions, about_edges=[])

        cache = StructuralCache.from_store(store)

        assert cache.entity_to_chunks == {
            "entity-A": {"chunk-1", "chunk-2"},
            "entity-B": {"chunk-1"},
        }
        assert cache.chunk_to_entities == {
            "chunk-1": {"entity-A", "entity-B"},
            "chunk-2": {"entity-A"},
        }
        # No ABOUT edges → empty fact maps
        assert cache.entity_to_facts == {}
        assert cache.fact_to_entities == {}

    def test_loads_about_edges(self):
        """ABOUT edges populate entity↔fact maps."""
        about = [
            ("fact-1", "entity-A", {}),
            ("fact-2", "entity-A", {}),
            ("fact-1", "entity-B", {}),
        ]
        store = _mock_store(mentions_edges=[], about_edges=about)

        cache = StructuralCache.from_store(store)

        assert cache.entity_to_facts == {
            "entity-A": {"fact-1", "fact-2"},
            "entity-B": {"fact-1"},
        }
        assert cache.fact_to_entities == {
            "fact-1": {"entity-A", "entity-B"},
            "fact-2": {"entity-A"},
        }
        # No MENTIONS/AUTHORED_BY → empty chunk maps
        assert cache.entity_to_chunks == {}
        assert cache.chunk_to_entities == {}

    def test_empty_store(self):
        """An empty store yields an empty cache."""
        store = _mock_store(mentions_edges=[], about_edges=[])
        cache = StructuralCache.from_store(store)
        assert cache.entity_to_chunks == {}
        assert cache.entity_to_facts == {}
        assert cache.chunk_to_entities == {}
        assert cache.fact_to_entities == {}


class TestApplyDelta:
    """apply_delta: incremental update from newly created edges."""

    def test_mentions_delta_updates_both_maps(self):
        """A MENTIONS edge delta updates entity_to_chunks and chunk_to_entities."""
        cache = StructuralCache()
        edges = [_make_edge("chunk", "chunk-3", "entity", "entity-C", EdgeType.MENTIONS)]

        cache.apply_delta(edges)

        assert cache.entity_to_chunks == {"entity-C": {"chunk-3"}}
        assert cache.chunk_to_entities == {"chunk-3": {"entity-C"}}
        # Fact maps untouched
        assert cache.entity_to_facts == {}
        assert cache.fact_to_entities == {}

    def test_authored_by_delta_updates_both_maps(self):
        """An AUTHORED_BY edge delta updates entity↔chunk maps."""
        cache = StructuralCache()
        edges = [_make_edge("chunk", "chunk-1", "entity", "entity-A", EdgeType.AUTHORED_BY)]

        cache.apply_delta(edges)

        assert cache.entity_to_chunks == {"entity-A": {"chunk-1"}}
        assert cache.chunk_to_entities == {"chunk-1": {"entity-A"}}

    def test_about_delta_updates_both_maps(self):
        """An ABOUT edge delta updates entity_to_facts and fact_to_entities."""
        cache = StructuralCache()
        edges = [_make_edge("fact", "fact-3", "entity", "entity-C", EdgeType.ABOUT)]

        cache.apply_delta(edges)

        assert cache.entity_to_facts == {"entity-C": {"fact-3"}}
        assert cache.fact_to_entities == {"fact-3": {"entity-C"}}
        # Chunk maps untouched
        assert cache.entity_to_chunks == {}
        assert cache.chunk_to_entities == {}

    def test_entity_similar_ignored(self):
        """ENTITY_SIMILAR edges (non-structural) are ignored by apply_delta."""
        cache = StructuralCache()
        edges = [
            _make_edge("entity", "entity-A", "entity", "entity-B", EdgeType.ENTITY_SIMILAR),
            _make_edge("entity", "entity-A", "entity", "entity-C", EdgeType.ENTITY_SIMILAR),
        ]

        cache.apply_delta(edges)

        # None of the four maps should have been updated
        assert cache.entity_to_chunks == {}
        assert cache.entity_to_facts == {}
        assert cache.chunk_to_entities == {}
        assert cache.fact_to_entities == {}

    def test_fact_similar_ignored(self):
        """FACT_SIMILAR edges (non-structural) are ignored by apply_delta."""
        cache = StructuralCache()
        edges = [
            _make_edge("fact", "fact-1", "fact", "fact-2", EdgeType.FACT_SIMILAR),
        ]

        cache.apply_delta(edges)

        assert cache.entity_to_chunks == {}
        assert cache.entity_to_facts == {}
        assert cache.chunk_to_entities == {}
        assert cache.fact_to_entities == {}

    def test_mixed_delta_only_structural_applied(self):
        """A mix of structural + non-structural edges: only structural applied."""
        cache = StructuralCache()
        edges = [
            _make_edge("chunk", "chunk-1", "entity", "entity-A", EdgeType.MENTIONS),
            _make_edge("entity", "entity-A", "entity", "entity-B", EdgeType.ENTITY_SIMILAR),
            _make_edge("fact", "fact-1", "entity", "entity-A", EdgeType.ABOUT),
            _make_edge("fact", "fact-1", "fact", "fact-2", EdgeType.FACT_SIMILAR),
        ]

        cache.apply_delta(edges)

        assert cache.entity_to_chunks == {"entity-A": {"chunk-1"}}
        assert cache.chunk_to_entities == {"chunk-1": {"entity-A"}}
        assert cache.entity_to_facts == {"entity-A": {"fact-1"}}
        assert cache.fact_to_entities == {"fact-1": {"entity-A"}}

    def test_delta_appends_to_existing(self):
        """apply_delta appends to existing sets, not replacing them."""
        cache = StructuralCache()
        cache.entity_to_chunks = {"entity-A": {"chunk-1"}}
        cache.chunk_to_entities = {"chunk-1": {"entity-A"}}

        edges = [_make_edge("chunk", "chunk-2", "entity", "entity-A", EdgeType.MENTIONS)]
        cache.apply_delta(edges)

        assert cache.entity_to_chunks == {"entity-A": {"chunk-1", "chunk-2"}}
        assert cache.chunk_to_entities == {
            "chunk-1": {"entity-A"},
            "chunk-2": {"entity-A"},
        }

    def test_empty_delta_is_noop(self):
        """An empty edge list is a no-op."""
        cache = StructuralCache()
        cache.entity_to_chunks = {"entity-A": {"chunk-1"}}
        cache.apply_delta([])
        assert cache.entity_to_chunks == {"entity-A": {"chunk-1"}}


class TestReverseLookups:
    """entities_for_chunks / entities_for_facts reverse lookups."""

    def _populated_cache(self) -> StructuralCache:
        cache = StructuralCache()
        cache.chunk_to_entities = {
            "chunk-1": {"entity-A", "entity-B"},
            "chunk-2": {"entity-B"},
            "chunk-3": {"entity-C"},
        }
        cache.fact_to_entities = {
            "fact-1": {"entity-A"},
            "fact-2": {"entity-B", "entity-C"},
        }
        return cache

    def test_entities_for_chunks_single(self):
        cache = self._populated_cache()
        assert cache.entities_for_chunks({"chunk-1"}) == {"entity-A", "entity-B"}

    def test_entities_for_chunks_multiple_union(self):
        cache = self._populated_cache()
        result = cache.entities_for_chunks({"chunk-1", "chunk-2"})
        assert result == {"entity-A", "entity-B"}

    def test_entities_for_chunks_unknown_chunk(self):
        cache = self._populated_cache()
        assert cache.entities_for_chunks({"nonexistent"}) == set()

    def test_entities_for_chunks_mixed(self):
        cache = self._populated_cache()
        result = cache.entities_for_chunks({"chunk-1", "nonexistent", "chunk-3"})
        assert result == {"entity-A", "entity-B", "entity-C"}

    def test_entities_for_facts_single(self):
        cache = self._populated_cache()
        assert cache.entities_for_facts({"fact-1"}) == {"entity-A"}

    def test_entities_for_facts_multiple_union(self):
        cache = self._populated_cache()
        result = cache.entities_for_facts({"fact-1", "fact-2"})
        assert result == {"entity-A", "entity-B", "entity-C"}

    def test_entities_for_facts_unknown(self):
        cache = self._populated_cache()
        assert cache.entities_for_facts({"nonexistent"}) == set()

    def test_entities_for_empty_sets(self):
        cache = self._populated_cache()
        assert cache.entities_for_chunks(set()) == set()
        assert cache.entities_for_facts(set()) == set()


class TestFromStoreAndDeltaIntegration:
    """Verify delta application keeps a from_store cache consistent."""

    def test_delta_after_load_adds_new_entities(self):
        """A delta after from_store adds new chunk→entity mappings."""
        mentions = [("chunk-1", "entity-A", {})]
        store = _mock_store(mentions_edges=mentions, about_edges=[])
        cache = StructuralCache.from_store(store)

        # Apply a delta with a new entity and a new chunk
        cache.apply_delta([
            _make_edge("chunk", "chunk-2", "entity", "entity-B", EdgeType.MENTIONS),
        ])

        assert cache.entity_to_chunks == {
            "entity-A": {"chunk-1"},
            "entity-B": {"chunk-2"},
        }
        assert cache.chunk_to_entities == {
            "chunk-1": {"entity-A"},
            "chunk-2": {"entity-B"},
        }

        # The new entity is reachable via entities_for_chunks
        assert cache.entities_for_chunks({"chunk-2"}) == {"entity-B"}

    def test_delta_after_load_adds_to_existing_entity(self):
        """A delta can add a new chunk to an entity that already has chunks."""
        mentions = [("chunk-1", "entity-A", {})]
        store = _mock_store(mentions_edges=mentions, about_edges=[])
        cache = StructuralCache.from_store(store)

        cache.apply_delta([
            _make_edge("chunk", "chunk-2", "entity", "entity-A", EdgeType.MENTIONS),
        ])

        assert cache.entity_to_chunks["entity-A"] == {"chunk-1", "chunk-2"}
        assert cache.entities_for_chunks({"chunk-1", "chunk-2"}) == {"entity-A"}


def test_edge_checkpoint_applies_cache_delta_before_done() -> None:
    """A completed edge checkpoint always includes its in-memory cache delta."""
    cache = StructuralCache()
    entity_id = entity_id_from_name("Alice")
    pipeline = object.__new__(IngestionPipeline)
    pipeline.structural_cache = cache
    pipeline.extraction_results = {
        "chunk-1": {"entities": [{"name": "Alice"}], "facts": []}
    }
    pipeline.all_entities = {entity_id: object()}
    pipeline.messages = []
    pipeline.store = MagicMock()
    pipeline.store.count_edges_by_type.return_value = {"MENTIONS": 1}
    pipeline.store.count_edges.return_value = 1
    pipeline._ensure_extraction_loaded = MagicMock()
    pipeline._ensure_entities_loaded = MagicMock()
    pipeline._ensure_facts_loaded = MagicMock()
    pipeline._persist_scopes = MagicMock(return_value=[])
    chunk = SimpleNamespace(
        id="chunk-1", timestamp=0, source_type="document", metadata={}
    )
    pipeline.all_chunks = MagicMock(return_value=[chunk])

    done = {"value": False}

    @contextmanager
    def _step(_name):
        guard = SimpleNamespace(skip=False)

        def _done(**_meta):
            assert cache.entities_for_chunks({"chunk-1"}) == {entity_id}
            done["value"] = True

        guard.done = _done
        yield guard

    pipeline.step = _step
    pipeline._create_edges()

    assert done["value"]
    pipeline.store.insert_edges.assert_called_once()
