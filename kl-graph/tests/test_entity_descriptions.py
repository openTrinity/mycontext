"""Tests for the Entity ``description`` feature (conformance divergence G).

Covers the RAGFlow-style inline+lazy accumulation designed in
``docs/todo/archive/graph-design-conformance.md`` section G:

- ``ExtractedEntity`` carries an optional per-chunk ``description``;
- ``build_entity_description`` folds many per-chunk contributions into deduped,
  chronological ``- `` bullets, and only fires the LLM summarize step past the
  gate (``DESCRIPTION_GATE``);
- SQLite persists ``description`` and exposes it to keyword search
  (``entities_fts`` FTS5, backfilled for pre-existing rows, with a ``LIKE``
  fallback whenever FTS5 is unavailable or its MATCH comes back empty) while the
  Qdrant entity vector stays name-only.

The LLM boundary (``summarize_entity_descriptions``) is monkeypatched throughout
so these tests never touch a live model.
"""

from __future__ import annotations

import asyncio
import sqlite3

import pytest

from kl_graph.ingest import pipeline as pipeline_mod
from kl_graph.ingest.llm_extractor import ExtractedEntity
from kl_graph.ingest.pipeline import (
    DESCRIPTION_GATE,
    DESCRIPTION_TOKEN_BUDGET,
    _estimate_tokens,
    _truncate_descriptions,
)
from kl_graph.ingest.pipeline import (
    build_entity_description as _abuild_entity_description,
)
from kl_graph.models.types import Entity, EntityType
from kl_graph.storage.sqlite_store import SQLiteStore


def build_entity_description(*args, **kwargs) -> str:
    """Sync shim: ``build_entity_description`` is a coroutine now (concurrent
    hub summaries). These tests exercise the gate/bounding logic synchronously.
    """
    return asyncio.run(_abuild_entity_description(*args, **kwargs))

# --------------------------------------------------------------------------- #
# (a) ExtractedEntity parses a description; empty is valid.
# --------------------------------------------------------------------------- #

def test_extracted_entity_parses_description() -> None:
    e = ExtractedEntity(
        name="张伟",
        entity_type="Person",
        description="负责数据同步的工程师",
    )
    assert e.description == "负责数据同步的工程师"


def test_extracted_entity_description_defaults_empty() -> None:
    # No description key at all -> defaults to "" (the accumulated-desc contract).
    e = ExtractedEntity(name="网关系统", entity_type="System")
    assert e.description == ""


# --------------------------------------------------------------------------- #
# (b) Accumulation: deduped, chronological bullets below the gate.
# --------------------------------------------------------------------------- #

def test_build_description_dedupes_and_orders_chronologically(monkeypatch) -> None:
    # Guard: the summarizer must NOT be called below the gate.
    async def _fail_summarize(*a, **k):
        pytest.fail("summarizer must not run below the gate")

    monkeypatch.setattr(
        pipeline_mod,
        "summarize_entity_descriptions",
        _fail_summarize,
    )
    # Contributions are (source_chunk_timestamp, description). Deliberately out of
    # timestamp order on input, with a duplicate, to prove ordering + dedup.
    contributions = [
        (300, "later note"),
        (100, "first note"),
        (200, "first note"),   # duplicate text, earlier than 300
        (200, "middle note"),
    ]
    out = build_entity_description("X", contributions)
    lines = out.splitlines()
    # Every line is a bullet.
    assert all(line.startswith("- ") for line in lines)
    texts = [line[2:] for line in lines]
    # Deduped (one "first note") and in first-seen chronological order.
    assert texts == ["first note", "middle note", "later note"]


def test_build_description_empty_when_no_contributions(monkeypatch) -> None:
    async def _fail_empty(*a, **k):
        pytest.fail("should not summarize an empty list")

    monkeypatch.setattr(
        pipeline_mod, "summarize_entity_descriptions", _fail_empty,
    )
    assert build_entity_description("X", []) == ""
    # Contributions that are all empty strings collapse to "".
    assert build_entity_description("X", [(1, ""), (2, "")]) == ""


# --------------------------------------------------------------------------- #
# (c) The lazy summarizer fires ONLY above the gate.
# --------------------------------------------------------------------------- #

def test_summarizer_not_called_at_gate(monkeypatch) -> None:
    calls: list[tuple] = []

    async def _record(name, descs, **k):
        calls.append((name, descs))
        return "SUMMARY"

    monkeypatch.setattr(
        pipeline_mod,
        "summarize_entity_descriptions",
        _record,
    )
    # Exactly ``gate`` distinct descriptions -> still bullets, no LLM.
    contribs = [(i, f"desc {i}") for i in range(DESCRIPTION_GATE)]
    out = build_entity_description("X", contribs)
    assert calls == []
    assert out.startswith("- desc 0")


def test_summarizer_called_above_gate(monkeypatch) -> None:
    calls: list[tuple] = []

    def fake_summarize(name, descs, **k):
        calls.append((name, tuple(descs)))
        return "GENERALIZED PARAGRAPH"

    async def _afake(name, descs, **k):
        return fake_summarize(name, descs, **k)

    monkeypatch.setattr(
        pipeline_mod, "summarize_entity_descriptions", _afake
    )
    # gate + 1 distinct descriptions -> one summarize call, its result stored.
    contribs = [(i, f"desc {i}") for i in range(DESCRIPTION_GATE + 1)]
    out = build_entity_description("张伟", contribs)
    assert len(calls) == 1
    assert calls[0][0] == "张伟"
    assert out == "GENERALIZED PARAGRAPH"


def test_summarizer_skipped_when_disabled(monkeypatch) -> None:
    # KL_ENTITY_DESCRIPTION_SUMMARIZE=0 must skip the LLM entirely (no call) and
    # keep the bounded bullet list, so a flaky gateway can't stall a build.
    calls: list = []

    async def _record_disabled(*a, **k):
        calls.append(a)
        return "SHOULD NOT BE USED"

    monkeypatch.setattr(
        pipeline_mod, "summarize_entity_descriptions", _record_disabled,
    )
    monkeypatch.setattr(pipeline_mod, "ENTITY_DESCRIPTION_SUMMARIZE", False)
    contribs = [(i, f"desc {i}") for i in range(DESCRIPTION_GATE + 5)]
    out = build_entity_description("X", contribs)
    assert calls == []  # LLM never called
    assert out.startswith("- desc 0")
    assert "SHOULD NOT BE USED" not in out


def test_falls_back_to_bullets_when_summarizer_unavailable(monkeypatch) -> None:
    # Summarizer returns None (no LLM configured / failed) -> bounded bullets.
    async def _none(*a, **k):
        return None

    monkeypatch.setattr(
        pipeline_mod, "summarize_entity_descriptions", _none
    )
    contribs = [(i, f"desc {i}") for i in range(DESCRIPTION_GATE + 3)]
    out = build_entity_description("X", contribs)
    assert out.startswith("- desc 0")
    assert "GENERALIZED" not in out


# --------------------------------------------------------------------------- #
# (e) The ~token budget is a real bound, even for one oversized description.
# --------------------------------------------------------------------------- #

def test_truncate_bounds_single_oversized_description() -> None:
    # One description far over the budget: the "always return at least one"
    # invariant must hold, but bounded — not the unbounded original.
    budget = 64
    huge = "word " * 5_000
    kept = _truncate_descriptions([huge], budget)
    assert len(kept) == 1
    assert kept[0]  # still non-empty: at least one description is returned
    assert len(kept[0]) < len(huge)  # actually clipped
    assert len(kept[0]) <= budget * 4
    assert _estimate_tokens(kept[0]) <= budget


def test_truncate_bounds_oversized_first_of_many() -> None:
    # The oversized item is first, so the old ``if kept`` guard appended it whole
    # and every later item was dropped; the bound now applies to it too.
    budget = 32
    kept = _truncate_descriptions(["x" * 10_000, "short follow-up"], budget)
    assert len(kept) == 1
    assert len(kept[0]) <= budget * 4
    assert _estimate_tokens(kept[0]) <= budget


def test_truncate_leaves_within_budget_description_untouched() -> None:
    # No clipping when the description already fits (no mid-sentence cuts).
    kept = _truncate_descriptions(["负责数据同步的工程师"], DESCRIPTION_TOKEN_BUDGET)
    assert kept == ["负责数据同步的工程师"]


def test_build_description_bounds_oversized_fallback(monkeypatch) -> None:
    # End-to-end through the fallback path: summarizer unavailable + a single
    # oversized contribution above the gate -> stored text is still bounded.
    async def _none(*a, **k):
        return None

    monkeypatch.setattr(
        pipeline_mod, "summarize_entity_descriptions", _none
    )
    huge = "数据同步处理逻辑" * 2_000
    contribs = [(i, f"{huge}{i}") for i in range(DESCRIPTION_GATE + 1)]
    out = build_entity_description("X", contribs)
    assert out.startswith("- ")
    assert len(out) < len(huge)
    # Bounded by the budget (+2 chars for the "- " bullet prefix).
    assert len(out) <= DESCRIPTION_TOKEN_BUDGET * 4 + 2
    assert _estimate_tokens(out) <= DESCRIPTION_TOKEN_BUDGET + 2


def test_build_description_summarize_input_is_bounded(monkeypatch) -> None:
    # The summarizer is what costs tokens, so assert the bound on what it gets.
    seen: list[list[str]] = []

    def fake_summarize(name, descs, **k):
        seen.append(list(descs))
        return "GENERALIZED PARAGRAPH"

    async def _afake(name, descs, **k):
        return fake_summarize(name, descs, **k)

    monkeypatch.setattr(
        pipeline_mod, "summarize_entity_descriptions", _afake
    )
    huge = "word " * 5_000
    contribs = [(i, f"{huge}{i}") for i in range(DESCRIPTION_GATE + 1)]
    assert build_entity_description("X", contribs) == "GENERALIZED PARAGRAPH"
    assert len(seen) == 1
    sent = seen[0]
    assert len(sent) == 1
    assert _estimate_tokens(sent[0]) <= DESCRIPTION_TOKEN_BUDGET


# --------------------------------------------------------------------------- #
# (d) SQLite round-trip retains description.
# --------------------------------------------------------------------------- #

@pytest.fixture()
def store() -> SQLiteStore:
    conn = sqlite3.connect(":memory:")
    return SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]


def test_sqlite_entity_roundtrip_keeps_description(store: SQLiteStore) -> None:
    ent = Entity(
        id="e1",
        name="网关系统",
        entity_type=EntityType.SYSTEM,
        description="- 用户会话沙箱\n- 安全隔离环境",
    )
    store.upsert_entities([ent])
    got = store.get_entity_by_name("网关系统")
    assert got is not None
    assert got.description == "- 用户会话沙箱\n- 安全隔离环境"


def test_sqlite_missing_description_defaults_empty(store: SQLiteStore) -> None:
    ent = Entity(id="e2", name="李强", entity_type=EntityType.PERSON)
    store.upsert_entities([ent])
    got = store.get_entity_by_name("李强")
    assert got is not None
    assert got.description == ""


# --------------------------------------------------------------------------- #
# (f) Keyword search matches description text; name lookup still works.
# --------------------------------------------------------------------------- #

def test_search_entities_matches_description(store: SQLiteStore) -> None:
    store.upsert_entities([
        Entity(id="e1", name="张伟", entity_type=EntityType.PERSON,
               description="负责数据同步的工程师"),
        Entity(id="e2", name="李雷", entity_type=EntityType.PERSON,
               description="做前端页面"),
    ])
    # A term that appears only in a description, not in any name.
    results = store.search_entities("数据同步")
    names = {e.name for e in results}
    assert "张伟" in names


def test_search_entities_by_name_still_works(store: SQLiteStore) -> None:
    store.upsert_entities([
        Entity(id="e1", name="张伟", entity_type=EntityType.PERSON,
               description="工程师"),
    ])
    results = store.search_entities_by_name("张伟")
    assert any(e.name == "张伟" for e in results)


def test_search_entities_by_name_ignores_description(store: SQLiteStore) -> None:
    # ``search_entities_by_name`` stays name-only: a description-only term must
    # not match there (that's what ``search_entities`` is for).
    store.upsert_entities([
        Entity(id="e1", name="张伟", entity_type=EntityType.PERSON,
               description="负责数据同步的工程师"),
    ])
    assert store.search_entities_by_name("数据同步") == []


# --------------------------------------------------------------------------- #
# (f2) Pre-existing entity rows are backfilled into the FTS index on open, and
#      an empty FTS MATCH falls through to the LIKE scan.
# --------------------------------------------------------------------------- #

def _legacy_conn() -> sqlite3.Connection:
    """A connection whose ``entities`` table predates the FTS index.

    Mirrors a database built before ``entities_fts`` existed: real rows, no index
    and (like the pre-``description`` schema) no ``description`` column, so the
    defensive ``ALTER`` path runs too.
    """
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """CREATE TABLE entities (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               entity_type TEXT DEFAULT 'Unknown',
               first_seen INTEGER DEFAULT 0,
               last_seen INTEGER DEFAULT 0,
               mention_count INTEGER DEFAULT 1,
               embedding_id TEXT
           )"""
    )
    conn.commit()
    return conn


def test_open_backfills_preexisting_entities_into_fts() -> None:
    conn = _legacy_conn()
    conn.execute(
        "INSERT INTO entities (id, name, entity_type) VALUES ('legacy1', 'LegacyName', 'Person')"
    )
    conn.commit()
    # A description written by a raw-SQL path, after the ALTER adds the column.
    SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]
    conn.execute(
        "UPDATE entities SET description = ? WHERE id = 'legacy1'",
        ("负责数据同步的工程师",),
    )
    conn.execute("DELETE FROM entities_fts WHERE entity_id = 'legacy1'")
    conn.commit()

    # Re-opening the store re-indexes the row it finds missing from the index.
    store = SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]
    assert store._has_entities_fts
    # Findable by a term that appears ONLY in the description.
    assert [e.name for e in store.search_entities("数据同步")] == ["LegacyName"]
    # ...and by its (whole-token) name, which used to require a rewrite.
    assert [e.name for e in store.search_entities("LegacyName")] == ["LegacyName"]


def test_backfill_is_idempotent_across_reopens() -> None:
    conn = _legacy_conn()
    conn.execute(
        "INSERT INTO entities (id, name) VALUES ('legacy1', 'LegacyName')"
    )
    conn.commit()
    for _ in range(3):
        store = SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]
    n_fts = conn.execute("SELECT COUNT(*) FROM entities_fts").fetchone()[0]
    assert n_fts == conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0] == 1
    # No duplicate hits from a repeated backfill.
    assert len(store.search_entities("LegacyName")) == 1


def test_search_entities_falls_back_to_like_when_fts_matches_nothing(
    store: SQLiteStore,
) -> None:
    store.upsert_entities([
        Entity(id="e1", name="LegacyName", entity_type=EntityType.PERSON,
               description="sandbox owner"),
    ])
    assert store._has_entities_fts
    # "Legacy" is a prefix, not a token: FTS5 MATCH finds nothing here...
    tokens = ['"Legacy"']
    fts_rows = store.conn.execute(
        "SELECT entity_id FROM entities_fts WHERE entities_fts MATCH ?",
        (" OR ".join(tokens),),
    ).fetchall()
    assert fts_rows == []
    # ...so search_entities must fall through to the LIKE scan and still answer.
    assert [e.name for e in store.search_entities("Legacy")] == ["LegacyName"]


def test_search_entities_like_fallback_covers_description(store: SQLiteStore) -> None:
    store.upsert_entities([
        Entity(id="e1", name="张伟", entity_type=EntityType.PERSON,
               description="owns 网关相关g"),
    ])
    # "网关相关" is a substring of the description token "网关相关g": no FTS
    # match, LIKE-over-description match.
    assert [e.name for e in store.search_entities("网关相关")] == ["张伟"]


def test_search_entities_returns_empty_when_nothing_matches(store: SQLiteStore) -> None:
    store.upsert_entities([
        Entity(id="e1", name="张伟", entity_type=EntityType.PERSON,
               description="工程师"),
    ])
    # The fallthrough must not turn a genuine miss into a match.
    assert store.search_entities("zzz-no-such-term") == []


# --------------------------------------------------------------------------- #
# (g) The Qdrant entity embedding text is name-only (no description folded in).
# --------------------------------------------------------------------------- #

def test_entity_embedding_text_is_name_only() -> None:
    # Guard the RAGFlow name-dense / description-sparse split: the embedded text
    # for an entity must be its name, never its (mutable, growing) description.
    # This mirrors pipeline._embed_graph: ``entity_texts = [e.name for e in ...]``.
    ents = [
        Entity(id="e1", name="张伟", entity_type=EntityType.PERSON,
               description="负责数据同步的工程师"),
        Entity(id="e2", name="网关系统", entity_type=EntityType.SYSTEM,
               description="安全隔离环境"),
    ]
    entity_texts = [e.name for e in ents]
    assert entity_texts == ["张伟", "网关系统"]
    for e in ents:
        assert e.description not in entity_texts
