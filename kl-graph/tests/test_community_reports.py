"""Tests for community reports generation.

Covers:
- Mixed membership collection (entities + facts)
- Token packing respects MAX_INPUT_LENGTH (8192), no mid-text slicing
- One LLM call per community (via fake LLM)
- GraphRAG output schema: title/summary/rating/rating_explanation/findings/tags
- Strict validation rejects malformed output (empty findings, bool rating, out-of-range rating, wrong tag count)
- Malformed JSON retry logic, skip if persistent failure
- Empty community table returns 0
- Whole-item packing: lowest-ranked items dropped, retained items equal originals exactly
- Complete-message budget: system+template+members ≤ MAX_INPUT_LENGTH tokens
- top_members stored WITHOUT [:xx] slicing
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from unittest.mock import AsyncMock, patch

import pytest

from kl_graph.ingest.chunker import num_tokens_from_string
from kl_graph.models.types import Edge, EdgeType, community_id_from
from kl_graph.periodic.community_summarizer import (
    MAX_INPUT_LENGTH,
    CommunityReport,
    SYSTEM_PROMPT,
    COMMUNITY_PROMPT_TEMPLATE,
    _build_ranked_context,
    _get_mixed_communities,
    _render_member_context,
    _summarize_community,
    _token_pack,
    _validate_report_response,
    generate_community_reports,
    run_community_summarization,
    store_community_reports,
)
from kl_graph.storage.sqlite_store import SQLiteStore


def _create_test_store():
    """Create a test store with communities."""
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)
    
    # Add community columns
    for table in ["entities", "facts"]:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN community_L0 INTEGER")
    
    # Insert test entities
    conn.executemany(
        "INSERT INTO entities (id, name, description, mention_count, community_L0) VALUES (?, ?, ?, ?, ?)",
        [
            ("e1", "Alice", "Backend engineer", 5, 0),
            ("e2", "Bob", "Frontend developer", 3, 0),
            ("e3", "Charlie", "DevOps", 7, 1),
        ],
    )
    
    # Insert test facts
    conn.executemany(
        "INSERT INTO facts (id, text, confidence, source_chunk_id, community_L0) VALUES (?, ?, ?, ?, ?)",
        [
            ("f1", "Alice leads backend team", 0.9, "c1", 0),
            ("f2", "Bob maintains React codebase", 0.8, "c2", 0),
            ("f3", "Charlie manages infrastructure", 0.95, "c3", 1),
        ],
    )
    
    # Insert MENTIONS edges for degree calculation
    store.insert_edges([
        Edge(source_type="chunk", source_id="c1", target_type="entity", target_id="e1", edge_type=EdgeType.MENTIONS),
        Edge(source_type="chunk", source_id="c2", target_type="entity", target_id="e2", edge_type=EdgeType.MENTIONS),
        Edge(source_type="chunk", source_id="c3", target_type="entity", target_id="e3", edge_type=EdgeType.MENTIONS),
        Edge(source_type="chunk", source_id="c4", target_type="entity", target_id="e1", edge_type=EdgeType.MENTIONS),
    ])
    
    # Insert ABOUT edges for degree calculation
    store.insert_edges([
        Edge(source_type="fact", source_id="f1", target_type="entity", target_id="e1", edge_type=EdgeType.ABOUT),
        Edge(source_type="fact", source_id="f2", target_type="entity", target_id="e2", edge_type=EdgeType.ABOUT),
        Edge(source_type="fact", source_id="f3", target_type="entity", target_id="e3", edge_type=EdgeType.ABOUT),
    ])

    # Native Community rows (projection authority): the summarizer only
    # summarizes column-derived groups that have a materialized Community row.
    conn.executemany(
        "INSERT INTO communities (id, level, node_type, member_count) VALUES (?, ?, 'mixed', ?)",
        [
            (community_id_from("L0", 0), "L0", 4),
            (community_id_from("L0", 1), "L0", 2),
        ],
    )

    conn.commit()
    return store


def test_get_mixed_communities_collects_entities_and_facts():
    """Test that _get_mixed_communities collects both entities and facts."""
    from kl_graph.periodic.community_summarizer import _precompute_entity_degrees, _precompute_fact_degrees
    
    store = _create_test_store()
    
    # Precompute degrees
    entity_degrees = _precompute_entity_degrees(store)
    fact_degrees = _precompute_fact_degrees(store)
    
    communities = _get_mixed_communities(store, 0, entity_degrees, fact_degrees)
    
    # Community 0: 2 entities, 2 facts
    assert 0 in communities
    assert len(communities[0]['entities']) == 2
    assert len(communities[0]['facts']) == 2
    
    # Community 1: 1 entity, 1 fact
    assert 1 in communities
    assert len(communities[1]['entities']) == 1
    assert len(communities[1]['facts']) == 1


def test_render_member_context_sorts_by_degree():
    """Test that member context is sorted by degree (descending)."""
    entities = [
        ("e1", "Alice", "Engineer", 5),
        ("e2", "Bob", "Developer", 3),
        ("e3", "Charlie", "DevOps", 7),
    ]
    facts = [
        ("f1", "Fact 1", 0.9, 2),
        ("f2", "Fact 2", 0.8, 5),
    ]
    
    context = _render_member_context(entities, facts)
    lines = context.strip().split("\n")
    
    # Entities should be sorted by degree: Charlie(7), Alice(5), Bob(3)
    assert "Charlie" in lines[0]
    assert "Alice" in lines[1]
    assert "Bob" in lines[2]
    
    # Facts should be sorted by degree: Fact 2(5), Fact 1(2)
    assert "Fact 2" in lines[3]
    assert "Fact 1" in lines[4]


def test_token_pack_respects_budget_no_mid_text_slicing():
    """Test that _token_pack respects token budget without mid-text slicing.
    
    Verifies:
    - Each retained line is EXACTLY an original line (not truncated)
    - Lowest-ranked lines (from the end) are dropped first
    - Output fits within token budget
    """
    # Create uniquely identifiable lines
    lines = [f"UNIQUE_LINE_{i:03d}: " + "x" * 100 for i in range(50)]
    text = "\n".join(lines)
    
    # Pack to 1000 tokens
    packed = _token_pack(text, 1000)
    
    # Should have fewer lines than original
    packed_lines = packed.strip().split("\n")
    assert len(packed_lines) < len(lines), "Should drop some lines to fit budget"
    
    # Each retained line must be EXACTLY an original line (no truncation)
    for line in packed_lines:
        assert line in lines, f"Retained line must be an exact original: {line[:50]}..."
    
    # Verify lowest-ranked lines (from end) are dropped
    # The first N lines should be retained, the rest dropped
    n_retained = len(packed_lines)
    for i in range(n_retained):
        assert packed_lines[i] == lines[i], f"Line {i} should be retained"
    for i in range(n_retained, len(lines)):
        assert lines[i] not in packed_lines, f"Line {i} should be dropped"
    
    # Verify token budget is respected
    assert num_tokens_from_string(packed) <= 1000, "Output must fit within token budget"


def test_build_ranked_context_drops_lowest_ranked_items():
    """Test that _build_ranked_context drops lowest-ranked items by combined degree order.
    
    Verifies:
    - Items are ranked by degree (entities and facts merged)
    - Lowest-ranked items are dropped first
    - Retained items equal originals exactly
    """
    # Create entities and facts with uniquely identifiable names and different degrees
    entities = [
        ("e_high", "HighDegreeEntity_ALPHA", "High degree entity", 10),
        ("e_med", "MedDegreeEntity_BRAVO", "Medium degree entity", 5),
        ("e_low", "LowDegreeEntity_CHARLIE", "Low degree entity", 1),
    ]
    facts = [
        ("f_high", "HighDegreeFact_DELTA", 0.9, 8),
        ("f_med", "MedDegreeFact_ECHO", 0.8, 4),
        ("f_low", "LowDegreeFact_FOXTROT", 0.7, 2),
    ]
    
    # Set a tight token budget that forces dropping some items
    max_tokens = 100  # Small budget to force dropping
    
    packed_text, selected_entries = _build_ranked_context(entities, facts, max_tokens)
    
    # Verify that selected entries are exact originals (not truncated)
    all_original_entries = ["HighDegreeEntity_ALPHA", "MedDegreeEntity_BRAVO", "LowDegreeEntity_CHARLIE",
                           "HighDegreeFact_DELTA", "MedDegreeFact_ECHO", "LowDegreeFact_FOXTROT"]
    
    for entry in selected_entries:
        assert entry in all_original_entries, f"Selected entry must be an exact original: {entry}"
    
    # Verify highest-degree items are retained
    # Expected order by degree (desc): e_high(10), f_high(8), e_med(5), f_med(4), f_low(2), e_low(1)
    if len(selected_entries) >= 1:
        assert "HighDegreeEntity_ALPHA" in selected_entries, "Highest degree entity should be retained"
    if len(selected_entries) >= 2:
        assert "HighDegreeFact_DELTA" in selected_entries, "Highest degree fact should be retained"
    
    # Verify lowest-degree items are dropped first
    if len(selected_entries) < 6:
        assert "LowDegreeEntity_CHARLIE" not in selected_entries, "Lowest degree entity should be dropped"
    if len(selected_entries) < 5:
        assert "LowDegreeFact_FOXTROT" not in selected_entries, "Lowest degree fact should be dropped"


def test_validate_report_response_rejects_empty_findings():
    """Test that _validate_report_response rejects empty findings list."""
    invalid_report = {
        "title": "Test",
        "summary": "Test summary",
        "rating": 7.0,
        "rating_explanation": "Good",
        "findings": [],  # Empty findings
        "tags": ["tag1", "tag2", "tag3"],
    }
    
    with pytest.raises(ValueError, match="findings"):
        _validate_report_response(invalid_report)


def test_validate_report_response_rejects_bool_rating():
    """Test that _validate_report_response rejects bool rating (even though bool is int subclass)."""
    invalid_report = {
        "title": "Test",
        "summary": "Test summary",
        "rating": True,  # Bool instead of number
        "rating_explanation": "Good",
        "findings": [{"summary": "F1", "explanation": "E1"}],
        "tags": ["tag1", "tag2", "tag3"],
    }
    
    with pytest.raises(ValueError, match="rating"):
        _validate_report_response(invalid_report)


def test_validate_report_response_rejects_out_of_range_rating():
    """Test that _validate_report_response rejects out-of-range rating."""
    invalid_report = {
        "title": "Test",
        "summary": "Test summary",
        "rating": 15.0,  # Out of range (should be 0-10)
        "rating_explanation": "Good",
        "findings": [{"summary": "F1", "explanation": "E1"}],
        "tags": ["tag1", "tag2", "tag3"],
    }
    
    with pytest.raises(ValueError, match="rating"):
        _validate_report_response(invalid_report)


def test_validate_report_response_rejects_wrong_tag_count():
    """Test that _validate_report_response rejects wrong tag count."""
    invalid_report = {
        "title": "Test",
        "summary": "Test summary",
        "rating": 7.0,
        "rating_explanation": "Good",
        "findings": [
            {"summary": "F1", "explanation": "E1"},
            {"summary": "F2", "explanation": "E2"},
            {"summary": "F3", "explanation": "E3"},
            {"summary": "F4", "explanation": "E4"},
            {"summary": "F5", "explanation": "E5"},
        ],
        "tags": ["tag1"],  # Only 1 tag (should be 3-5)
    }
    
    with pytest.raises(ValueError, match="tags"):
        _validate_report_response(invalid_report)


def test_complete_message_budget_within_limit():
    """Test that complete message (system+template+members) fits within MAX_INPUT_LENGTH."""
    # Create a large set of entities and facts
    entities = [
        (f"e{i}", f"Entity_{i:03d}", "A" * 200, 5)
        for i in range(50)
    ]
    facts = [
        (f"f{i}", "F" * 200, 0.8, 3)
        for i in range(50)
    ]
    
    # Build the context
    member_budget = MAX_INPUT_LENGTH - 500  # Reserve some for system+template
    packed_context, _ = _build_ranked_context(entities, facts, member_budget)
    
    # Build the complete message
    prompt = COMMUNITY_PROMPT_TEMPLATE.format(
        level=0,
        community_id=0,
        member_count=len(entities) + len(facts),
        entity_count=len(entities),
        fact_count=len(facts),
        members_text=packed_context,
    )
    
    total_tokens = num_tokens_from_string(SYSTEM_PROMPT) + num_tokens_from_string(prompt)
    
    # Verify total fits within budget
    assert total_tokens <= MAX_INPUT_LENGTH, (
        f"Complete message must fit within {MAX_INPUT_LENGTH} tokens, got {total_tokens}"
    )


def test_top_members_stored_without_slicing():
    """Test that top_members are stored as complete entries without [:xx] slicing."""
    store = _create_test_store()
    
    # Create a report with long member names
    long_member_name = "A" * 500  # Very long name
    report = CommunityReport(
        level=0,
        community_id=0,
        member_count=1,
        entity_count=1,
        fact_count=0,
        title="Test",
        summary="Test summary",
        rating=7.0,
        rating_explanation="Good",
        findings=[{"summary": "F1", "explanation": "E1"}],
        tags=["tag1", "tag2", "tag3"],
        top_members=[long_member_name],  # Store the complete long name
    )
    
    # Store the report
    store_community_reports(store, [report])
    
    # Retrieve and verify
    rows = store.sql_conn.execute(
        "SELECT top_members FROM community_summaries WHERE level = 0 AND community_id = 0"
    ).fetchall()
    
    assert len(rows) == 1
    stored_members = json.loads(rows[0][0])
    
    # Verify the complete name is stored (not truncated)
    assert len(stored_members) == 1
    assert stored_members[0] == long_member_name, "top_members must be stored without slicing"
    assert len(stored_members[0]) == 500, "Complete member name must be preserved"


def test_build_ranked_context_returns_packed_entries_without_slicing():
    """Prove stored top_members == exactly the packed entries, no [:xx] on storage path.
    
    This test verifies that _build_ranked_context returns entries that are:
    1. Built incrementally (not sliced from a larger list)
    2. Complete, untruncated original values
    3. Exactly matching the packed lines (1:1 correspondence)
    4. In the correct combined degree ranking order
    
    The new implementation builds kept_entries by appending items as they fit
    the budget, proving no [:xx] slice occurs on the storage path.
    """
    # Create entities and facts with unique, identifiable names
    entities = [
        ("e1", "AlphaEntity_UNIQUE", "Description A", 10),
        ("e2", "BravoEntity_UNIQUE", "Description B", 5),
        ("e3", "CharlieEntity_UNIQUE", "Description C", 1),
    ]
    facts = [
        ("f1", "AlphaFact_UNIQUE", 0.9, 8),
        ("f2", "BravoFact_UNIQUE", 0.8, 4),
    ]
    
    # Use a tight budget to force some items to be dropped
    max_tokens = 80
    
    packed_text, selected_entries = _build_ranked_context(entities, facts, max_tokens)
    packed_lines = packed_text.split("\n") if packed_text else []
    
    # 1. Entries count == lines count (proves no post-hoc slicing)
    assert len(selected_entries) == len(packed_lines), (
        f"Entries ({len(selected_entries)}) must match packed lines ({len(packed_lines)})"
    )
    
    # 2. Each entry is a complete, untruncated original value
    all_entity_names = {e[1] for e in entities}
    all_fact_texts = {f[1] for f in facts}
    all_originals = all_entity_names | all_fact_texts
    
    for entry in selected_entries:
        assert entry in all_originals, (
            f"Entry must be exact original (not truncated): {entry!r}"
        )
    
    # 3. Each entry corresponds to its packed line (entry appears in the line)
    for i, line in enumerate(packed_lines):
        entry = selected_entries[i]
        assert entry in line, (
            f"Entry {entry!r} must appear in its packed line: {line!r}"
        )
    
    # 4. Verify ranking order: entries should be in degree-descending order
    # Build expected order based on combined ranking
    ranked_items = []
    for eid, name, desc, degree in entities:
        ranked_items.append((-degree, 0, 0.0, eid, name))
    for fid, text, conf, degree in facts:
        ranked_items.append((-degree, 1, -conf, fid, text))
    ranked_items.sort(key=lambda x: x[0])
    expected_order = [item[4] for item in ranked_items]
    
    # selected_entries should be a prefix of expected_order (highest-ranked items kept)
    assert selected_entries == expected_order[:len(selected_entries)], (
        f"Entries must be in combined rank order: {selected_entries} vs {expected_order}"
    )
    
    # 5. Verify completeness: each stored entry is the full original, not a substring
    for entry in selected_entries:
        for orig in all_originals:
            if entry.startswith(orig[:10]):  # Match by prefix
                assert entry == orig, (
                    f"Entry must be complete, not truncated: got {entry!r}, expected {orig!r}"
                )


@pytest.mark.asyncio
async def test_summarize_community_one_call_per_community():
    """Test that _summarize_community makes exactly one LLM call per community."""
    store = _create_test_store()
    
    # Get communities
    from kl_graph.periodic.community_summarizer import _precompute_entity_degrees, _precompute_fact_degrees
    entity_degrees = _precompute_entity_degrees(store)
    fact_degrees = _precompute_fact_degrees(store)
    communities = _get_mixed_communities(store, 0, entity_degrees, fact_degrees)
    
    # Create a fake LLM that returns a proper response object
    valid_response = {
        "title": "Test Community",
        "summary": "Test summary",
        "rating": 7.0,
        "rating_explanation": "Good",
        "findings": [
            {"summary": "F1", "explanation": "E1"},
            {"summary": "F2", "explanation": "E2"},
            {"summary": "F3", "explanation": "E3"},
            {"summary": "F4", "explanation": "E4"},
            {"summary": "F5", "explanation": "E5"},
        ],
        "tags": ["tag1", "tag2", "tag3"],
    }
    
    # Create mock response object that mimics LiteLLM response structure
    from unittest.mock import MagicMock
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message = MagicMock()
    mock_response.choices[0].message.content = json.dumps(valid_response)
    mock_response.usage = MagicMock()
    mock_response.usage.prompt_tokens = 100
    mock_response.usage.completion_tokens = 50
    mock_response.usage.total_tokens = 150
    
    fake_llm = AsyncMock(return_value=mock_response)
    
    # Patch litellm.acompletion
    with patch('kl_graph.periodic.community_summarizer.litellm.acompletion', fake_llm):
        # Summarize community 0
        entities = communities[0]['entities']
        facts = communities[0]['facts']
        
        result = await _summarize_community(
            api_key="fake-key",
            level=0,
            community_id=0,
            entities=entities,
            facts=facts,
            semaphore=asyncio.Semaphore(1),
        )
        
        # Verify exactly one LLM call was made
        assert fake_llm.call_count == 1, "Should make exactly one LLM call per community"
        
        # Verify result is valid
        assert result is not None
        report, selected_entries = result
        assert report['title'] == "Test Community"
        assert report['rating'] == 7.0


@pytest.mark.asyncio
async def test_summarize_community_retry_on_malformed_then_skip():
    """Test that _summarize_community retries on malformed output, then skips if persistent."""
    store = _create_test_store()
    
    # Get communities
    from kl_graph.periodic.community_summarizer import _precompute_entity_degrees, _precompute_fact_degrees
    entity_degrees = _precompute_entity_degrees(store)
    fact_degrees = _precompute_fact_degrees(store)
    communities = _get_mixed_communities(store, 0, entity_degrees, fact_degrees)
    
    # Create a fake LLM that always returns malformed JSON in a proper response object
    from unittest.mock import MagicMock
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message = MagicMock()
    mock_response.choices[0].message.content = "This is not valid JSON {{{"
    
    fake_llm = AsyncMock(return_value=mock_response)
    
    # Patch litellm.acompletion
    with patch('kl_graph.periodic.community_summarizer.litellm.acompletion', fake_llm):
        # Summarize community 0
        entities = communities[0]['entities']
        facts = communities[0]['facts']
        
        result = await _summarize_community(
            api_key="fake-key",
            level=0,
            community_id=0,
            entities=entities,
            facts=facts,
            semaphore=asyncio.Semaphore(1),
            max_retries=3,  # Set to 3 retries
        )
        
        # Verify retries were attempted
        assert fake_llm.call_count == 3, f"Should retry {3} times on malformed output"
        
        # Verify result is None (skipped after persistent failure)
        assert result is None, "Should return None after persistent malformed output"


@pytest.mark.asyncio
async def test_generate_community_reports_stores_valid_reports():
    """Test that generate_community_reports stores valid reports and skips invalid ones."""
    store = _create_test_store()
    
    # Create a fake LLM that returns valid JSON in a proper response object
    valid_response = {
        "title": "Test Community",
        "summary": "Test summary",
        "rating": 7.0,
        "rating_explanation": "Good",
        "findings": [
            {"summary": "F1", "explanation": "E1"},
            {"summary": "F2", "explanation": "E2"},
            {"summary": "F3", "explanation": "E3"},
            {"summary": "F4", "explanation": "E4"},
            {"summary": "F5", "explanation": "E5"},
        ],
        "tags": ["tag1", "tag2", "tag3"],
    }
    
    # Create mock response object that mimics LiteLLM response structure
    from unittest.mock import MagicMock
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message = MagicMock()
    mock_response.choices[0].message.content = json.dumps(valid_response)
    mock_response.usage = MagicMock()
    mock_response.usage.prompt_tokens = 100
    mock_response.usage.completion_tokens = 50
    mock_response.usage.total_tokens = 150
    
    fake_llm = AsyncMock(return_value=mock_response)

    # Patch litellm.acompletion
    with patch('kl_graph.periodic.community_summarizer.litellm.acompletion', fake_llm):
        # Generate reports
        reports, llm_stats = await generate_community_reports(store, levels=[0], min_members=1)
        
        # Verify reports were generated
        assert len(reports) == 2, "Should generate reports for both communities"
        
        # Verify each report has the expected fields
        for report in reports:
            assert report.title == "Test Community"
            assert report.rating == 7.0
            assert len(report.findings) == 5
            assert len(report.tags) == 3
        
        # Verify one LLM call per community
        assert fake_llm.call_count == 2, "Should make one LLM call per community"


def test_empty_community_table_returns_zero():
    """Test that empty community table returns 0 reports."""
    conn = sqlite3.connect(":memory:")
    store = SQLiteStore(db_path=None, conn=conn)
    
    # Add community columns but no data
    for table in ["entities", "facts"]:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN community_L0 INTEGER")
    conn.commit()
    
    # Precompute degrees (empty)
    from kl_graph.periodic.community_summarizer import _precompute_entity_degrees, _precompute_fact_degrees
    entity_degrees = _precompute_entity_degrees(store)
    fact_degrees = _precompute_fact_degrees(store)
    
    communities = _get_mixed_communities(store, 0, entity_degrees, fact_degrees)
    
    assert len(communities) == 0


def test_community_report_dataclass():
    """Test CommunityReport dataclass structure."""
    report = CommunityReport(
        level=0,
        community_id=0,
        member_count=4,
        entity_count=2,
        fact_count=2,
        title="Test Community",
        summary="This is a test community",
        rating=7.5,
        rating_explanation="Moderately important",
        findings=[
            {"summary": "Finding 1", "explanation": "Explanation 1"},
            {"summary": "Finding 2", "explanation": "Explanation 2"},
        ],
        tags=["tag1", "tag2", "tag3"],
        top_members=["Alice", "Bob"],
    )
    
    assert report.level == 0
    assert report.community_id == 0
    assert report.member_count == 4
    assert report.rating == 7.5
    assert len(report.findings) == 2
    assert len(report.tags) == 3


def test_store_community_reports():
    """Test storing community reports to database."""
    store = _create_test_store()
    
    reports = [
        CommunityReport(
            level=0,
            community_id=0,
            member_count=4,
            entity_count=2,
            fact_count=2,
            title="Community 0",
            summary="Summary 0",
            rating=8.0,
            rating_explanation="High importance",
            findings=[{"summary": "F1", "explanation": "E1"}],
            tags=["tag1"],
            top_members=["Alice"],
        ),
        CommunityReport(
            level=0,
            community_id=1,
            member_count=2,
            entity_count=1,
            fact_count=1,
            title="Community 1",
            summary="Summary 1",
            rating=6.0,
            rating_explanation="Medium importance",
            findings=[{"summary": "F2", "explanation": "E2"}],
            tags=["tag2"],
            top_members=["Charlie"],
        ),
    ]
    
    count = store_community_reports(store, reports)
    
    assert count == 2
    
    # Verify storage
    rows = store.sql_conn.execute(
        "SELECT level, community_id, title, rating FROM community_summaries"
    ).fetchall()
    
    assert len(rows) == 2
    # Convert sqlite3.Row to tuple for comparison
    row_tuples = [(r[0], r[1], r[2], r[3]) for r in rows]
    assert row_tuples[0] == (0, 0, "Community 0", 8.0)
    assert row_tuples[1] == (0, 1, "Community 1", 6.0)


def test_run_community_summarization_signature():
    """Test that run_community_summarization has the pinned signature."""
    import inspect
    sig = inspect.signature(run_community_summarization)
    params = list(sig.parameters.keys())
    
    assert params == ["sqlite", "levels", "min_members", "max_concurrent"]
    
    # Check default values
    assert sig.parameters["levels"].default is None
    assert sig.parameters["min_members"].default == 10
    assert sig.parameters["max_concurrent"].default == 8
    
    # Check return type annotation (it's a string 'int', not the int type)
    assert sig.return_annotation == 'int' or sig.return_annotation == int
