"""Tests for global search over community summaries."""

import pytest
from kl_graph.models.types import Community, community_id_from
from kl_graph.query.global_search import (
    GlobalSearch,
    GlobalSearchResult,
    estimate_tokens,
    effective_budget,
    community_ref,
    clamp_citations,
    canonical_citation,
    normalize_point_citations,
    parse_rate_response,
    _new_diagnostics,
    MAX_RATINGS_PER_QUERY,
    MAX_DATA_TOKENS,
    RATE_THRESHOLD,
    NO_DATA_ANSWER,
)


def test_estimate_tokens_empty():
    """Test estimate_tokens with empty string."""
    assert estimate_tokens("") == 0


def test_estimate_tokens_basic():
    """Test estimate_tokens with basic string."""
    # Roughly 1 token per 4 characters for English
    text = "a" * 100
    tokens = estimate_tokens(text)
    assert tokens > 0


def test_effective_budget():
    """Test effective_budget calculation."""
    budget = effective_budget(1000)
    # Should be 85% of budget
    assert budget == 850


def test_community_ref():
    """Test community_ref formatting."""
    ref = community_ref(level=0, community_id=1)
    assert ref == "L0-1"


def test_clamp_citations_short():
    """Test clamp_citations with list shorter than 5."""
    citations = ["L0-1", "L0-2", "L0-3"]
    result = clamp_citations(citations)
    assert result == ["L0-1", "L0-2", "L0-3"]


def test_clamp_citations_exact_5():
    """Test clamp_citations with exactly 5 items."""
    citations = ["L0-1", "L0-2", "L0-3", "L0-4", "L0-5"]
    result = clamp_citations(citations)
    assert result == ["L0-1", "L0-2", "L0-3", "L0-4", "L0-5"]


def test_clamp_citations_more_than_5():
    """Test clamp_citations with more than 5 items."""
    citations = ["L0-1", "L0-2", "L0-3", "L0-4", "L0-5", "L0-6", "L0-7"]
    result = clamp_citations(citations)
    assert result == ["L0-1", "L0-2", "L0-3", "L0-4", "L0-5", "+more"]


def test_canonical_citation():
    """Test canonical_citation formatting."""
    citations = ["L0-1", "L0-2", "L0-3"]
    result = canonical_citation(citations)
    assert "L0-1" in result
    assert "L0-2" in result
    assert "L0-3" in result


def test_normalize_point_citations():
    """Test normalize_point_citations."""
    description = "This is a test point"
    citations = ["L0-1", "L0-2"]
    result = normalize_point_citations(description, citations)
    assert "L0-1" in result
    assert "L0-2" in result


def test_parse_rate_response_valid():
    """Test parse_rate_response with valid rating."""
    response = '{"rating": 8}'
    rating = parse_rate_response(response)
    assert rating == 8


def test_parse_rate_response_invalid():
    """Test parse_rate_response with invalid response."""
    response = "not json"
    rating = parse_rate_response(response)
    assert rating is None


def test_parse_rate_response_missing_key():
    """Test parse_rate_response with missing rating key."""
    # The function extracts any integer from the response, so {"score": 8} returns 8
    response = '{"score": 8}'
    rating = parse_rate_response(response)
    assert rating == 8  # It extracts the integer 8 from the response


def test_new_diagnostics():
    """Test _new_diagnostics creates fresh diagnostics dict."""
    diag = _new_diagnostics()
    assert "rating_calls" in diag
    assert "map_calls" in diag
    assert "reduce_called" in diag
    assert diag["rating_calls"] == 0


def test_global_search_result_dataclass():
    """Test GlobalSearchResult dataclass."""
    result = GlobalSearchResult(
        answer="Test answer",
        reason="ok",
        citations=["L0-1"],
        communities=[],
        diagnostics=_new_diagnostics(),
    )
    
    assert result.answer == "Test answer"
    assert result.reason == "ok"
    assert result.citations == ["L0-1"]


def test_global_search_init():
    """Test GlobalSearch initialization."""
    import sqlite3
    # Create a mock acomplete function
    async def mock_acomplete(system_prompt, user_prompt, **kwargs):
        return ""
    
    # GlobalSearch requires either conn or conn_provider
    conn = sqlite3.connect(":memory:")
    search = GlobalSearch(acomplete=mock_acomplete, conn=conn)
    assert search._acomplete == mock_acomplete
    conn.close()


@pytest.mark.asyncio
async def test_global_search_empty_summaries():
    """[!RED] Test global search with empty summaries table returns zero LLM calls."""
    import sqlite3
    call_count = 0
    
    async def mock_acomplete(messages, max_tokens=2000):
        nonlocal call_count
        call_count += 1
        return ""
    
    # Create real SQLite connection with empty community_summaries
    conn = sqlite3.connect(":memory:")
    # Create required tables
    conn.execute("CREATE TABLE community_summaries (level INTEGER NOT NULL, community_id INTEGER NOT NULL, member_count INTEGER NOT NULL, entity_count INTEGER NOT NULL, fact_count INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', rating REAL NOT NULL DEFAULT 0.0, rating_explanation TEXT NOT NULL DEFAULT '', findings TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]', top_members TEXT NOT NULL DEFAULT '[]')")
    conn.execute("CREATE TABLE communities (id TEXT, level INTEGER, parent_id TEXT)")
    conn.commit()
    
    search = GlobalSearch(conn=conn, acomplete=mock_acomplete)
    result = await search.search("test query")
    
    assert result.answer == NO_DATA_ANSWER
    assert result.reason == "no_communities"
    assert call_count == 0  # Zero LLM calls
    conn.close()


@pytest.mark.asyncio
async def test_global_search_rate_threshold():
    """Threshold boundary: rating exactly RATE_THRESHOLD (1) kept, 0 dropped.

    Two L0 roots with real summaries: one rated 1 (kept), one rated 0 (dropped).
    Asserts only the kept community appears in the selection.
    """
    import sqlite3

    kept_uuid = community_id_from("L0", 10)
    dropped_uuid = community_id_from("L0", 20)

    async def mock_acomplete(system, user):
        if "L0-10" in user or "RootKept" in user:
            return "1"  # exactly threshold → kept
        return "0"  # below threshold → dropped

    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE community_summaries "
        "(level INTEGER NOT NULL, community_id INTEGER NOT NULL, "
        "member_count INTEGER NOT NULL, entity_count INTEGER NOT NULL, "
        "fact_count INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', "
        "summary TEXT NOT NULL DEFAULT '', rating REAL NOT NULL DEFAULT 0.0, "
        "rating_explanation TEXT NOT NULL DEFAULT '', "
        "findings TEXT NOT NULL DEFAULT '[]', "
        "tags TEXT NOT NULL DEFAULT '[]', "
        "top_members TEXT NOT NULL DEFAULT '[]')"
    )
    conn.execute(
        "CREATE TABLE communities "
        "(id TEXT, level TEXT, node_type TEXT, summary TEXT, "
        "tags TEXT, member_count INTEGER, parent_id TEXT, parent_level INTEGER)"
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (0, 10, 3, 2, 1, "RootKept", "Summary for kept root", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (0, 20, 3, 2, 1, "RootDropped", "Summary for dropped root", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (kept_uuid, "L0", "mixed", "", "[]", 3, None, None),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (dropped_uuid, "L0", "mixed", "", "[]", 3, None, None),
    )
    conn.commit()

    search = GlobalSearch(conn=conn, acomplete=mock_acomplete)
    diagnostics = _new_diagnostics()
    selected = await search._select_communities("test query", diagnostics)

    assert len(selected) == 1
    assert selected[0]["community_id"] == 10
    assert diagnostics["ratings_kept"] == 1
    assert diagnostics["rating_calls"] == 2
    conn.close()


@pytest.mark.asyncio
async def test_global_search_mixed_communities():
    """Test that global search includes mixed communities (no node_type filtering)."""
    import sqlite3
    
    call_count = 0
    
    async def mock_acomplete(messages, max_tokens=2000):
        nonlocal call_count
        call_count += 1
        # Return high rating for rate calls
        if call_count <= 2:  # Rating calls
            return '{"rating": 8}'
        # Return points for map call
        elif "points" in str(messages):
            return '{"points": [{"description": "Test point", "score": 90, "community_ids": ["L0-1"]}]}'
        # Return answer for reduce call
        else:
            return "Test answer"
    
    # Create real SQLite connection with mixed community
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE community_summaries (level INTEGER NOT NULL, community_id INTEGER NOT NULL, member_count INTEGER NOT NULL, entity_count INTEGER NOT NULL, fact_count INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', rating REAL NOT NULL DEFAULT 0.0, rating_explanation TEXT NOT NULL DEFAULT '', findings TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]', top_members TEXT NOT NULL DEFAULT '[]')")
    conn.execute("CREATE TABLE communities (id TEXT, level INTEGER, parent_id TEXT)")
    tags_json = '["tag1"]'
    conn.execute("INSERT INTO community_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (0, 1, 10, 5, 5, 'Mixed Community', 'Mixed Community', 8.0, 'High rating', '[]', tags_json, '[]'))
    conn.commit()
    
    search = GlobalSearch(conn=conn, acomplete=mock_acomplete)
    result = await search.search("test query")
    
    # Should include the mixed community
    assert len(result.communities) > 0
    conn.close()


@pytest.mark.asyncio
async def test_global_search_budget_enforcement():
    """Test that global search respects token budget across hierarchy."""
    import sqlite3
    
    async def mock_acomplete(messages, max_tokens=2000):
        # Return high rating
        return '{"rating": 8}'
    
    # Create real SQLite connection with many communities
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE community_summaries (level INTEGER NOT NULL, community_id INTEGER NOT NULL, member_count INTEGER NOT NULL, entity_count INTEGER NOT NULL, fact_count INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', rating REAL NOT NULL DEFAULT 0.0, rating_explanation TEXT NOT NULL DEFAULT '', findings TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]', top_members TEXT NOT NULL DEFAULT '[]')")
    conn.execute("CREATE TABLE communities (id TEXT, level INTEGER, parent_id TEXT)")
    for i in range(50):
        conn.execute("INSERT INTO community_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", 
                     (0, i, 5, 3, 2, f"Title {i}", "Summary" * 100, 7.0, 'Good rating', '[]', '["tag"]', '[]'))
    conn.commit()
    
    search = GlobalSearch(conn=conn, acomplete=mock_acomplete)
    result = await search.search("test query")
    
    # Should respect MAX_RATINGS_PER_QUERY
    assert result.diagnostics["rating_calls"] <= MAX_RATINGS_PER_QUERY
    conn.close()


def test_max_ratings_per_query_constant():
    """Test that MAX_RATINGS_PER_QUERY is defined."""
    assert MAX_RATINGS_PER_QUERY > 0
    assert MAX_RATINGS_PER_QUERY <= 1000  # Reasonable upper bound


def test_max_data_tokens_constant():
    """Test that MAX_DATA_TOKENS is defined."""
    assert MAX_DATA_TOKENS > 0
    assert MAX_DATA_TOKENS <= 10000  # Reasonable upper bound


def test_rate_threshold_constant():
    """Test that RATE_THRESHOLD is defined."""
    assert 0 <= RATE_THRESHOLD <= 10


def test_no_data_answer_constant():
    """Test that NO_DATA_ANSWER is defined."""
    assert len(NO_DATA_ANSWER) > 0
    assert isinstance(NO_DATA_ANSWER, str)


# ── Rate-then-descent protection tests ────────────────────────────────────────


@pytest.mark.asyncio
async def test_parent_links_drive_descent_kept():
    """Kept L0 parent descends to L1/L2 children via persisted parent links.

    Hierarchy: L0 root → L1 child → L2 grandchild (all with summaries).
    Root rated high (10) → child rated → grandchild rated → all 3 selected.
    """
    import sqlite3

    root_uuid = community_id_from("L0", 1)
    child_uuid = community_id_from("L1", 2)
    grand_uuid = community_id_from("L2", 3)

    async def mock_acomplete(system, user):
        return "10"  # All rated high

    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE community_summaries "
        "(level INTEGER NOT NULL, community_id INTEGER NOT NULL, "
        "member_count INTEGER NOT NULL, entity_count INTEGER NOT NULL, "
        "fact_count INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', "
        "summary TEXT NOT NULL DEFAULT '', rating REAL NOT NULL DEFAULT 0.0, "
        "rating_explanation TEXT NOT NULL DEFAULT '', "
        "findings TEXT NOT NULL DEFAULT '[]', "
        "tags TEXT NOT NULL DEFAULT '[]', "
        "top_members TEXT NOT NULL DEFAULT '[]')"
    )
    conn.execute(
        "CREATE TABLE communities "
        "(id TEXT, level TEXT, node_type TEXT, summary TEXT, "
        "tags TEXT, member_count INTEGER, parent_id TEXT, parent_level INTEGER)"
    )
    # Summaries at L0, L1, L2
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (0, 1, 5, 3, 2, "Root", "Root summary text", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (1, 2, 4, 2, 2, "Child", "Child summary text", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (2, 3, 3, 1, 2, "Grand", "Grandchild summary text", 0.0, "", "[]", "[]", "[]"),
    )
    # Communities with parent links
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (root_uuid, "L0", "mixed", "", "[]", 5, None, None),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (child_uuid, "L1", "mixed", "", "[]", 4, root_uuid, 0),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (grand_uuid, "L2", "mixed", "", "[]", 3, child_uuid, 1),
    )
    conn.commit()

    search = GlobalSearch(conn=conn, acomplete=mock_acomplete)
    diagnostics = _new_diagnostics()
    selected = await search._select_communities("test query", diagnostics)

    # All three selected: root kept → child rated & kept → grand rated & kept
    assert len(selected) == 3
    levels = {s["level"] for s in selected}
    assert levels == {0, 1, 2}
    assert diagnostics["rating_calls"] == 3  # root + child + grandchild
    assert diagnostics["ratings_kept"] == 3
    conn.close()


@pytest.mark.asyncio
async def test_parent_links_drive_descent_rejected():
    """Rejected L0 parent stops descent: children NOT rated.

    Hierarchy: L0 root → L1 child → L2 grandchild (all with summaries).
    Root rated 0 (below threshold) → children never queued → selected empty.
    """
    import sqlite3

    root_uuid = community_id_from("L0", 1)
    child_uuid = community_id_from("L1", 2)
    grand_uuid = community_id_from("L2", 3)

    async def mock_acomplete(system, user):
        return "0"  # All rated zero — but only root should be called

    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE community_summaries "
        "(level INTEGER NOT NULL, community_id INTEGER NOT NULL, "
        "member_count INTEGER NOT NULL, entity_count INTEGER NOT NULL, "
        "fact_count INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', "
        "summary TEXT NOT NULL DEFAULT '', rating REAL NOT NULL DEFAULT 0.0, "
        "rating_explanation TEXT NOT NULL DEFAULT '', "
        "findings TEXT NOT NULL DEFAULT '[]', "
        "tags TEXT NOT NULL DEFAULT '[]', "
        "top_members TEXT NOT NULL DEFAULT '[]')"
    )
    conn.execute(
        "CREATE TABLE communities "
        "(id TEXT, level TEXT, node_type TEXT, summary TEXT, "
        "tags TEXT, member_count INTEGER, parent_id TEXT, parent_level INTEGER)"
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (0, 1, 5, 3, 2, "Root", "Root summary text", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (1, 2, 4, 2, 2, "Child", "Child summary text", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (2, 3, 3, 1, 2, "Grand", "Grandchild summary text", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (root_uuid, "L0", "mixed", "", "[]", 5, None, None),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (child_uuid, "L1", "mixed", "", "[]", 4, root_uuid, 0),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (grand_uuid, "L2", "mixed", "", "[]", 3, child_uuid, 1),
    )
    conn.commit()

    search = GlobalSearch(conn=conn, acomplete=mock_acomplete)
    diagnostics = _new_diagnostics()
    selected = await search._select_communities("test query", diagnostics)

    # Root rejected → no descent → selected empty
    assert len(selected) == 0
    assert diagnostics["rating_calls"] == 1  # only root rated
    assert diagnostics["ratings_kept"] == 0
    conn.close()


@pytest.mark.asyncio
async def test_dynamic_levels_deep_hierarchy():
    """Hierarchy deeper than L2 is fully traversed (no hardcoded cap).

    5 levels: L0 → L1 → L2 → L3 → L4, each with a summary and parent link.
    All rated high → all 5 selected.
    """
    import sqlite3

    uuids = {i: community_id_from(f"L{i}", i + 1) for i in range(5)}

    async def mock_acomplete(system, user):
        return "10"

    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE community_summaries "
        "(level INTEGER NOT NULL, community_id INTEGER NOT NULL, "
        "member_count INTEGER NOT NULL, entity_count INTEGER NOT NULL, "
        "fact_count INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', "
        "summary TEXT NOT NULL DEFAULT '', rating REAL NOT NULL DEFAULT 0.0, "
        "rating_explanation TEXT NOT NULL DEFAULT '', "
        "findings TEXT NOT NULL DEFAULT '[]', "
        "tags TEXT NOT NULL DEFAULT '[]', "
        "top_members TEXT NOT NULL DEFAULT '[]')"
    )
    conn.execute(
        "CREATE TABLE communities "
        "(id TEXT, level TEXT, node_type TEXT, summary TEXT, "
        "tags TEXT, member_count INTEGER, parent_id TEXT, parent_level INTEGER)"
    )
    for lvl in range(5):
        cid = lvl + 1
        conn.execute(
            "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (lvl, cid, 5 - lvl, 3, 2, f"Level{lvl}", f"Summary at level {lvl}", 0.0, "", "[]", "[]", "[]"),
        )
        parent_uuid = uuids[lvl - 1] if lvl > 0 else None
        parent_level = lvl - 1 if lvl > 0 else None
        conn.execute(
            "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
            (uuids[lvl], f"L{lvl}", "mixed", "", "[]", 5 - lvl, parent_uuid, parent_level),
        )
    conn.commit()

    search = GlobalSearch(conn=conn, acomplete=mock_acomplete)
    diagnostics = _new_diagnostics()
    selected = await search._select_communities("test query", diagnostics)

    assert len(selected) == 5
    levels = sorted(s["level"] for s in selected)
    assert levels == [0, 1, 2, 3, 4]
    assert diagnostics["rating_calls"] == 5
    assert diagnostics["ratings_kept"] == 5
    conn.close()


@pytest.mark.asyncio
async def test_budget_exhausted_at_cap(monkeypatch):
    """Exactly MAX_RATINGS_PER_QUERY candidates, queue empties: budget NOT hit.

    2 L0 roots, no children, cap = 2 → both rated, queue empty, no truncation.
    """
    import sqlite3
    import kl_graph.query.global_search as gs

    monkeypatch.setattr(gs, "MAX_RATINGS_PER_QUERY", 2)

    uuid1 = community_id_from("L0", 1)
    uuid2 = community_id_from("L0", 2)

    async def mock_acomplete(system, user):
        return "10"

    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE community_summaries "
        "(level INTEGER NOT NULL, community_id INTEGER NOT NULL, "
        "member_count INTEGER NOT NULL, entity_count INTEGER NOT NULL, "
        "fact_count INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', "
        "summary TEXT NOT NULL DEFAULT '', rating REAL NOT NULL DEFAULT 0.0, "
        "rating_explanation TEXT NOT NULL DEFAULT '', "
        "findings TEXT NOT NULL DEFAULT '[]', "
        "tags TEXT NOT NULL DEFAULT '[]', "
        "top_members TEXT NOT NULL DEFAULT '[]')"
    )
    conn.execute(
        "CREATE TABLE communities "
        "(id TEXT, level TEXT, node_type TEXT, summary TEXT, "
        "tags TEXT, member_count INTEGER, parent_id TEXT, parent_level INTEGER)"
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (0, 1, 3, 2, 1, "Root1", "Summary 1", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (0, 2, 3, 2, 1, "Root2", "Summary 2", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (uuid1, "L0", "mixed", "", "[]", 3, None, None),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (uuid2, "L0", "mixed", "", "[]", 3, None, None),
    )
    conn.commit()

    search = GlobalSearch(conn=conn, acomplete=mock_acomplete)
    diagnostics = _new_diagnostics()
    selected = await search._select_communities("test query", diagnostics)

    assert len(selected) == 2
    assert diagnostics["rating_calls"] == 2
    assert diagnostics["rating_budget_hit"] is False
    conn.close()


@pytest.mark.asyncio
async def test_budget_truncated_at_cap(monkeypatch):
    """More candidates than cap: rating_budget_hit is True.

    3 L0 roots, no children, cap = 2 → 2 rated, 1 remains unprocessed.
    """
    import sqlite3
    import kl_graph.query.global_search as gs

    monkeypatch.setattr(gs, "MAX_RATINGS_PER_QUERY", 2)

    uuid1 = community_id_from("L0", 1)
    uuid2 = community_id_from("L0", 2)
    uuid3 = community_id_from("L0", 3)

    async def mock_acomplete(system, user):
        return "10"

    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE community_summaries "
        "(level INTEGER NOT NULL, community_id INTEGER NOT NULL, "
        "member_count INTEGER NOT NULL, entity_count INTEGER NOT NULL, "
        "fact_count INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', "
        "summary TEXT NOT NULL DEFAULT '', rating REAL NOT NULL DEFAULT 0.0, "
        "rating_explanation TEXT NOT NULL DEFAULT '', "
        "findings TEXT NOT NULL DEFAULT '[]', "
        "tags TEXT NOT NULL DEFAULT '[]', "
        "top_members TEXT NOT NULL DEFAULT '[]')"
    )
    conn.execute(
        "CREATE TABLE communities "
        "(id TEXT, level TEXT, node_type TEXT, summary TEXT, "
        "tags TEXT, member_count INTEGER, parent_id TEXT, parent_level INTEGER)"
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (0, 1, 3, 2, 1, "Root1", "Summary 1", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (0, 2, 3, 2, 1, "Root2", "Summary 2", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (0, 3, 3, 2, 1, "Root3", "Summary 3", 0.0, "", "[]", "[]", "[]"),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (uuid1, "L0", "mixed", "", "[]", 3, None, None),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (uuid2, "L0", "mixed", "", "[]", 3, None, None),
    )
    conn.execute(
        "INSERT INTO communities VALUES (?,?,?,?,?,?,?,?)",
        (uuid3, "L0", "mixed", "", "[]", 3, None, None),
    )
    conn.commit()

    search = GlobalSearch(conn=conn, acomplete=mock_acomplete)
    diagnostics = _new_diagnostics()
    selected = await search._select_communities("test query", diagnostics)

    # Only 2 rated (cap hit), 1 unprocessed
    assert len(selected) == 2
    assert diagnostics["rating_calls"] == 2
    assert diagnostics["rating_budget_hit"] is True
    conn.close()
