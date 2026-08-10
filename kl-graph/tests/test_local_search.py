"""Tests for local search module."""

import pytest
from kl_graph.query.local_search import (
    _enumerate_community_levels,
    _edge_score,
    _select_seeds,
    _gather_relationships,
    _gather_community_context,
    _render_community_item,
    _gather_text_units,
    _assemble_context_text,
    build_local_context,
    CommunityContextItem,
    RelationshipItem,
    ChunkContextItem,
    MAX_CONTEXT_TOKENS,
    COMMUNITY_PROP,
    TEXT_UNIT_PROP,
    TOP_K_ENTITIES,
    TOP_K_RELATIONSHIPS,
)
from kl_graph.query.engine import QueryEngine, RetrievalResult


def test_enumerate_community_levels_empty():
    """Test _enumerate_community_levels with no community columns."""
    class MockStore:
        class MockConn:
            def execute(self, sql):
                return self
            def fetchall(self):
                return []
        sql_conn = MockConn()
    
    store = MockStore()
    levels = _enumerate_community_levels(store)
    assert levels == []


def test_enumerate_community_levels_with_columns():
    """Test _enumerate_community_levels with community columns."""
    class MockCursor:
        def __init__(self, rows):
            self.rows = rows
        def fetchall(self):
            return self.rows
    
    class MockConn:
        def execute(self, sql):
            # PRAGMA table_info returns (cid, name, type, notnull, dflt_value, pk)
            if "entities" in sql:
                return MockCursor([(0, "id", "TEXT", 1, None, 1), (1, "name", "TEXT", 1, None, 0), (2, "community_L0", "INTEGER", 0, None, 0), (3, "community_L1", "INTEGER", 0, None, 0)])
            elif "facts" in sql:
                return MockCursor([(0, "id", "TEXT", 1, None, 1), (1, "text", "TEXT", 1, None, 0), (2, "community_L0", "INTEGER", 0, None, 0), (3, "community_L2", "INTEGER", 0, None, 0)])
            return MockCursor([])
    
    class MockStore:
        sql_conn = MockConn()
    
    store = MockStore()
    levels = _enumerate_community_levels(store)
    assert sorted(levels) == [0, 1, 2]


def test_edge_score_default():
    """Test _edge_score with no score fields."""
    props = {}
    score = _edge_score(props)
    assert score == 0.5


def test_edge_score_hybrid_score():
    """Test _edge_score with hybrid_score."""
    props = {"hybrid_score": 0.9}
    score = _edge_score(props)
    assert score == 0.9


def test_edge_score_fact_similar():
    """Test _edge_score with score."""
    props = {"score": 0.8}
    score = _edge_score(props)
    assert score == 0.8


def test_edge_score_priority():
    """Test _edge_score priority order."""
    props = {"hybrid_score": 0.9, "fact_similar_score": 0.8}
    score = _edge_score(props)
    assert score == 0.9  # hybrid_score takes priority


def test_select_seeds_basic():
    """Test _select_seeds with basic input."""
    class MockStore:
        def get_neighbors(self, node_type, node_id, edge_type=None, direction="out"):
            return []
    
    store = MockStore()
    matched_entities = [
        {"id": "e1", "name": "Entity1", "type": "entity", "sim": 0.9},
        {"id": "e2", "name": "Entity2", "type": "entity", "sim": 0.8},
    ]
    chunk_hits = []
    fact_hits = []
    
    seeds = _select_seeds(store, matched_entities, chunk_hits, fact_hits, top_k=10)
    assert len(seeds) == 2
    assert seeds[0]["id"] == "e1"  # Higher similarity first


def test_select_seeds_top_k_limit():
    """Test _select_seeds respects top_k."""
    class MockStore:
        def get_neighbors(self, node_type, node_id, edge_type=None, direction="out"):
            return []
    
    store = MockStore()
    matched_entities = [
        {"id": f"e{i}", "name": f"Entity{i}", "type": "entity", "sim": 0.9 - i * 0.1}
        for i in range(20)
    ]
    chunk_hits = []
    fact_hits = []
    
    seeds = _select_seeds(store, matched_entities, chunk_hits, fact_hits, top_k=5)
    assert len(seeds) == 5


def test_select_seeds_empty():
    """Test _select_seeds with no matches."""
    class MockStore:
        def get_neighbors(self, node_type, node_id, edge_type=None, direction="out"):
            return []
    
    store = MockStore()
    seeds = _select_seeds(store, [], [], [], top_k=10)
    assert seeds == []


def test_gather_relationships_basic():
    """Test _gather_relationships with basic store."""
    class MockStore:
        def scan_edges_by_type(self, edge_types, direction="out"):
            return []
        def get_neighbors(self, node_id, direction="out"):
            return []
    
    store = MockStore()
    seeds = [{"id": "e1", "name": "Entity1", "type": "entity"}]
    
    relationships = _gather_relationships(store, seeds, top_k_per_seed=10)
    assert relationships == []


def test_gather_community_context_empty_summaries():
    """Test _gather_community_context with no summaries (graceful degradation)."""
    class MockStore:
        class MockConn:
            def execute(self, sql, params=None):
                return self
            def fetchall(self):
                return []
        sql_conn = MockConn()
    
    store = MockStore()
    seeds = [{"id": "e1", "name": "Entity1", "type": "entity"}]
    
    context = _gather_community_context(store, seeds, max_tokens=1000)
    assert context == []


def test_gather_community_context_no_levels():
    """Test _gather_community_context with no community levels."""
    class MockStore:
        class MockConn:
            def execute(self, sql, params=None):
                return self
            def fetchall(self):
                return []
        sql_conn = MockConn()
    
    store = MockStore()
    seeds = [{"id": "e1", "name": "Entity1", "type": "entity"}]
    
    context = _gather_community_context(store, seeds, max_tokens=1000)
    assert context == []


def test_render_community_item():
    """Test _render_community_item with valid item."""
    item = CommunityContextItem(
        community_id=1,
        level=0,
        title="Test Community",
        summary="This is a test community",
        rating=8.5,
        tags=["tag1", "tag2"],
        matched_seeds=["e1", "e2"],
        member_count=10,
    )
    
    rendered = _render_community_item(item)
    assert "Test Community" in rendered
    assert "8.5" in rendered
    assert "tag1" in rendered


def test_gather_text_units_basic():
    """Test _gather_text_units with basic input."""
    class MockStore:
        class MockConn:
            def execute(self, sql, params=None):
                return self
            def fetchall(self):
                return []
        sql_conn = MockConn()
    
    store = MockStore()
    seeds = [{"id": "e1", "name": "Entity1", "type": "entity"}]
    chunk_hits = [
        {"id": "c1", "score": 0.9, "payload": {"content": "Test content", "chunk_id": "c1"}},
    ]
    
    text_units = _gather_text_units(store, seeds, chunk_hits, max_tokens=1000)
    assert len(text_units) <= 1


def test_gather_text_units_empty():
    """Test _gather_text_units with no chunks."""
    class MockStore:
        class MockConn:
            def execute(self, sql, params=None):
                return self
            def fetchall(self):
                return []
        sql_conn = MockConn()
    
    store = MockStore()
    seeds = [{"id": "e1", "name": "Entity1", "type": "entity"}]
    chunk_hits = []
    
    text_units = _gather_text_units(store, seeds, chunk_hits, max_tokens=1000)
    assert text_units == []


def test_assemble_context_text_empty():
    """Test _assemble_context_text with empty inputs."""
    community_context = []
    relationships = []
    text_units = []
    max_rel_tokens = 1000
    
    context_text, community_tokens, relationship_tokens, text_unit_tokens = _assemble_context_text(
        community_context, relationships, text_units, max_rel_tokens
    )
    assert context_text == ""
    assert community_tokens == 0
    assert relationship_tokens == 0
    assert text_unit_tokens == 0


def test_assemble_context_text_with_content():
    """Test _assemble_context_text with content."""
    community_context = [
        CommunityContextItem(
            community_id=1,
            level=0,
            title="Test Community",
            summary="This is a test community",
            rating=8.5,
            tags=["tag1"],
            matched_seeds=["e1"],
            member_count=10,
        )
    ]
    relationships = [
        RelationshipItem(
            source_id="e1",
            source_type="entity",
            target_id="e2",
            target_type="entity",
            edge_type="ENTITY_SIMILAR",
            score=0.9,
        )
    ]
    text_units = [
        ChunkContextItem(
            chunk_id="c1",
            content="Test content",
            source_type="message",
            seed_match_count=2,
            recall_score=0.8,
        )
    ]
    max_rel_tokens = 1000
    
    context_text, community_tokens, relationship_tokens, text_unit_tokens = _assemble_context_text(
        community_context, relationships, text_units, max_rel_tokens
    )
    assert len(context_text) > 0
    assert community_tokens > 0
    assert relationship_tokens > 0
    assert text_unit_tokens > 0


def test_build_local_context_empty():
    """Test build_local_context with empty inputs."""
    class MockStore:
        class MockConn:
            def execute(self, sql, params=None):
                return self
            def fetchall(self):
                return []
        sql_conn = MockConn()
        def scan_edges_by_type(self, edge_types, direction="out"):
            return []
        def get_neighbors(self, node_id, direction="out"):
            return []
    
    store = MockStore()
    matched_entities = []
    chunk_hits = []
    fact_hits = []
    
    context = build_local_context(
        store, matched_entities, chunk_hits, fact_hits,
        max_context_tokens=MAX_CONTEXT_TOKENS,
        community_prop=COMMUNITY_PROP,
        text_unit_prop=TEXT_UNIT_PROP,
        top_k_entities=TOP_K_ENTITIES,
        top_k_relationships=TOP_K_RELATIONSHIPS,
    )
    
    assert context.community_context == []
    assert context.relationships == []
    assert context.text_units == []
    assert context.total_tokens == 0


def test_build_local_context_basic():
    """Test build_local_context with basic inputs."""
    class MockStore:
        class MockConn:
            def execute(self, sql, params=None):
                return self
            def fetchall(self):
                return []
        sql_conn = MockConn()
        def scan_edges_by_type(self, edge_types, direction="out"):
            return []
        def get_neighbors(self, node_id, direction="out"):
            return []
    
    store = MockStore()
    matched_entities = [
        {"id": "e1", "name": "Entity1", "type": "entity", "sim": 0.9},
    ]
    chunk_hits = []
    fact_hits = []
    
    context = build_local_context(
        store, matched_entities, chunk_hits, fact_hits,
        max_context_tokens=MAX_CONTEXT_TOKENS,
        community_prop=COMMUNITY_PROP,
        text_unit_prop=TEXT_UNIT_PROP,
        top_k_entities=TOP_K_ENTITIES,
        top_k_relationships=TOP_K_RELATIONSHIPS,
    )
    
    assert context.seed_ids == ["e1"]


def test_synthesis_includes_both_local_context_and_phase1_items():
    """Test that synthesis prompt includes both local_context AND phase1 items."""
    from kl_graph.query.engine import QueryEngine, RetrievalResult
    
    # Create a minimal engine (we only need _phase2_prompt)
    engine = QueryEngine.__new__(QueryEngine)
    
    # Create phase1 result with facts and messages
    phase1 = RetrievalResult(
        items=[
            {"type": "fact", "content": "Important fact about project", "fact_type": "WORK", "confidence": 0.9},
            {"type": "fact", "content": "Another fact", "fact_type": "MEETING", "confidence": 0.8},
            {"type": "message", "content": "Discussion about architecture", "sender": "Alice", "timestamp": 1609459200000},
            {"type": "message", "content": "Follow-up message", "sender": "Bob", "timestamp": 1609462800000},
        ],
        matched_entities=[
            {"name": "Project", "type": "PROJECT"},
        ],
    )
    
    # Create local context
    local_context = "=== 社区报告 ===\nCommunity summary here\n=== 关联关系 ===\nRelationships here"
    
    # Build synthesis prompt with local_context
    system_prompt, user_prompt = engine._phase2_prompt(
        "What is the project status?",
        phase1,
        local_context=local_context,
    )
    
    # Verify local_context is present
    assert "=== 社区报告 ===" in user_prompt, "local_context should be in prompt"
    assert "Community summary here" in user_prompt
    
    # Verify phase1 facts are ALSO present (not replaced)
    assert "=== 已知事实 ===" in user_prompt, "phase1 facts should be in prompt"
    assert "Important fact about project" in user_prompt, "fact content should be in prompt"
    assert "Another fact" in user_prompt
    
    # Verify phase1 messages are ALSO present (not replaced)
    assert "=== 相关消息 ===" in user_prompt, "phase1 messages should be in prompt"
    assert "Discussion about architecture" in user_prompt, "message content should be in prompt"
    assert "Alice" in user_prompt
    
    # Verify entities are present
    assert "=== 匹配实体 ===" in user_prompt
    assert "Project" in user_prompt


def test_community_context_item_dataclass():
    """Test CommunityContextItem dataclass."""
    item = CommunityContextItem(
        community_id=1,
        level=0,
        title="Test",
        summary="Test summary",
        rating=8.0,
        tags=["tag1"],
        matched_seeds=["e1"],
        member_count=10,
    )
    
    assert item.community_id == 1
    assert item.level == 0
    assert item.title == "Test"
    assert item.rating == 8.0


def test_relationship_item_dataclass():
    """Test RelationshipItem dataclass."""
    item = RelationshipItem(
        source_id="e1",
        source_type="entity",
        target_id="e2",
        target_type="entity",
        edge_type="ENTITY_SIMILAR",
        score=0.9,
    )
    
    assert item.source_id == "e1"
    assert item.target_id == "e2"
    assert item.score == 0.9


def test_chunk_context_item_dataclass():
    """Test ChunkContextItem dataclass."""
    item = ChunkContextItem(
        chunk_id="c1",
        content="Test content",
        source_type="message",
        seed_match_count=2,
        recall_score=0.8,
    )
    
    assert item.chunk_id == "c1"
    assert item.content == "Test content"
    assert item.source_type == "message"
    assert item.seed_match_count == 2
    assert item.recall_score == 0.8


def test_relationship_global_cap():
    """Test that relationships are globally capped across in-network and external."""
    # Create 3 seeds
    seeds = [
        {"id": "s1", "name": "Seed1", "type": "entity", "sim": 0.9},
        {"id": "s2", "name": "Seed2", "type": "entity", "sim": 0.8},
        {"id": "s3", "name": "Seed3", "type": "entity", "sim": 0.7},
    ]
    
    # Mock store with many in-network and external relationships
    class MockStore:
        def scan_edges_by_type(self, edge_types, source_type=None, target_type=None):
            # Return many in-network edges (s1-s2, s2-s3, s1-s3, etc.)
            edges = []
            for i in range(20):  # 20 in-network edges
                edges.append((f"s{i%3+1}", f"s{(i+1)%3+1}", {"confidence": 0.9 - i*0.01}))
            return edges
        
        def get_neighbors(self, node_type, node_id, edge_type=None, direction="out"):
            # Return many external neighbors for each seed
            neighbors = []
            for i in range(15):  # 15 external per seed
                neighbors.append({
                    "source_id": node_id,
                    "target_id": f"ext_{node_id}_{i}",
                    "source_type": "entity",
                    "target_type": "entity",
                    "edge_type": "ENTITY_SIMILAR",
                    "properties": '{"hybrid_score": ' + str(0.8 - i*0.01) + '}',
                })
            return neighbors
        
        class MockConn:
            def execute(self, sql, params=None):
                class Result:
                    def fetchone(self):
                        return ("External",)
                return Result()
        sql_conn = MockConn()
    
    store = MockStore()
    top_k_per_seed = 5
    
    relationships = _gather_relationships(store, seeds, top_k_per_seed=top_k_per_seed)
    
    # Total should not exceed top_k_per_seed * len(seeds) = 5 * 3 = 15
    expected_cap = top_k_per_seed * len(seeds)
    assert len(relationships) <= expected_cap, (
        f"Expected at most {expected_cap} relationships, got {len(relationships)}"
    )


def test_assemble_context_text_respects_token_budget():
    """Test that assembled context text respects MAX_CONTEXT_TOKENS boundary."""
    # Create content that would exceed budget if not properly tracked
    from kl_graph.ingest.chunker import num_tokens_from_string
    
    budget = 100  # Small budget for testing
    
    # Create community items with substantial content
    community_items = []
    for i in range(5):
        item = CommunityContextItem(
            community_id=i,
            level=0,
            title=f"Community {i}",
            summary="A" * 200,  # Long summary
            rating=8.0,
            tags=["tag1", "tag2"],
            matched_seeds=["s1"],
            member_count=10,
        )
        community_items.append(item)
    
    # Create relationships
    relationships = []
    for i in range(10):
        rel = RelationshipItem(
            source_id=f"s{i}",
            target_id=f"t{i}",
            source_type="entity",
            target_type="entity",
            edge_type="MENTIONS",
            score=0.9,
            label=f"Label {i}",
        )
        relationships.append(rel)
    
    # Create text units
    text_units = []
    for i in range(10):
        chunk = ChunkContextItem(
            chunk_id=f"c{i}",
            content="B" * 200,  # Long content
            source_type="message",
            seed_match_count=2,
            recall_score=0.8,
            timestamp=1609459200000,
        )
        text_units.append(chunk)
    
    # Assemble with strict budget
    context_text, comm_tokens, rel_tokens, tu_tokens = _assemble_context_text(
        community_items, relationships, text_units, budget
    )
    
    # Total tokens should not exceed budget
    total_tokens = comm_tokens + rel_tokens + tu_tokens
    assert total_tokens <= budget, (
        f"Total tokens {total_tokens} exceeded budget {budget}"
    )
    
    # Verify token counts match actual content
    actual_tokens = num_tokens_from_string(context_text)
    # Allow small variance for newline joining
    assert abs(actual_tokens - total_tokens) <= 10, (
        f"Token count mismatch: reported {total_tokens}, actual ~{actual_tokens}"
    )
