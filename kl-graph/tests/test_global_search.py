"""Global search (U1) unit tests: selection, map parsing, reduce, budgets.

No LLM, no network. A temp SQLite database mirrors the real schema
(``entities`` with the lazily-added ``community_L*`` columns +
``community_summaries`` exactly as ``SQLiteStore._create_tables`` builds it),
and a stub async completion callable counts invocations and returns scripted
responses — so the zero-LLM-call paths (no communities / no points) are
verified by asserting ``stub.calls`` stays empty.

Run: ``.venv/bin/python -m pytest tests/test_global_search.py -q``
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.query.global_search import (
    BUDGET_SAFETY_FACTOR,
    MAP_SYSTEM_PROMPT,
    NO_DATA_ANSWER,
    REDUCE_SYSTEM_PROMPT,
    GlobalSearch,
    _new_diagnostics,
    clamp_citations,
    community_ref,
    effective_budget,
    estimate_tokens,
    normalize_point_citation,
    parse_levels,
)
from kl_graph.storage.sqlite_store import SQLiteStore

# ── fixtures + helpers ──────────────────────────────────────────────────────


@pytest.fixture()
def db(tmp_path: Path) -> sqlite3.Connection:
    """Real ``SQLiteStore`` schema plus the ``community_L*`` columns.

    The level columns are added by ``scripts.improve`` (ALTER TABLE) in
    production, so the fixture mirrors that instead of assuming they exist.
    """
    store = SQLiteStore(tmp_path / "global_search.db")
    conn = store.conn
    for level in ("L0", "L1", "L2", "L3"):
        try:
            conn.execute(f"ALTER TABLE entities ADD COLUMN community_{level} INTEGER")
        except sqlite3.OperationalError:  # already present
            pass
    conn.commit()
    return conn


def _add_entity(
    conn: sqlite3.Connection,
    eid: str,
    communities: dict[str, int] | None = None,
) -> None:
    conn.execute(
        "INSERT INTO entities (id, name, entity_type, first_seen, last_seen, "
        "mention_count, description) VALUES (?, ?, 'Person', 0, 0, 1, '')",
        (eid, "用户"),
    )
    for level, cid in (communities or {}).items():
        conn.execute(
            f"UPDATE entities SET community_{level} = ? WHERE id = ?", (cid, eid)
        )
    conn.commit()


def _add_summary(
    conn: sqlite3.Connection,
    level: str,
    cid: int,
    member_count: int,
    summary: str,
    tags: str = "[]",
    node_type: str = "entity",
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO community_summaries "
        "(level, community_id, node_type, member_count, summary, tags, top_members) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (level, cid, node_type, member_count, summary, tags, "[]"),
    )
    conn.commit()


def _summary_row(level: str, cid: int, text: str, members: int = 1) -> dict:
    """A selected-summary dict as ``select_communities`` returns."""
    return {
        "level": level,
        "community_id": cid,
        "member_count": members,
        "summary": text,
        "tags": "[]",
    }


class StubComplete:
    """Scripted async completion stub; records every (system, user) call.

    Args:
        responses: Either a list consumed in call order (each item a response
            string or an Exception to raise), or a callable
            ``(system, user) -> str``.
    """

    def __init__(self, responses) -> None:
        self.responses = responses
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        if callable(self.responses):
            resp = self.responses(system, user)
        else:
            resp = self.responses[len(self.calls) - 1]
        if isinstance(resp, Exception):
            raise resp
        return resp

    @property
    def call_count(self) -> int:
        return len(self.calls)

    def reduce_user_prompt(self) -> str:
        """User prompt of the reduce call (the one non-map call)."""
        for system, user in reversed(self.calls):
            if "Respond ONLY with JSON" not in system:
                return user
        raise AssertionError("no reduce call recorded")


def _point(description: str, score: object, ids: tuple = ()) -> dict:
    return {"description": description, "score": score, "community_ids": list(ids)}


def _points_json(*points: dict) -> str:
    return json.dumps({"points": list(points)}, ensure_ascii=False)


def _budget_for_material(overhead: int, material: int) -> int:
    """A configured budget whose effective value leaves ``material`` tokens
    after ``overhead`` (the +1 absorbs floor rounding)."""
    return math.ceil((overhead + material) / BUDGET_SAFETY_FACTOR) + 1


# ── constructor contract ────────────────────────────────────────────────────


def test_constructor_requires_exactly_one_connection_source(db) -> None:
    stub = StubComplete([])
    with pytest.raises(ValueError):
        GlobalSearch(None, acomplete=stub)
    with pytest.raises(ValueError):
        GlobalSearch(db, conn_provider=lambda: db, acomplete=stub)
    with pytest.raises(ValueError):
        GlobalSearch(db)  # no acomplete


def test_conn_provider_variant_runs_search(db) -> None:
    """A zero-arg provider returning the connection works end to end."""
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "数据同步")
    stub = StubComplete([_points_json(_point("要点", 50, ["L0-1"])), "OK"])
    gs = GlobalSearch(conn_provider=lambda: db, acomplete=stub)
    result = asyncio.run(gs.search("我最近的任务是什么", "u1"))
    assert result.reason == "ok"
    assert result.answer == "OK"


# ── selection identities ────────────────────────────────────────────────────


def test_select_joins_entity_communities_and_ignores_fact_rows(db) -> None:
    _add_entity(db, "u1", {"L0": 1, "L1": 2})
    _add_summary(db, "L0", 1, 10, "数据同步社区摘要")
    _add_summary(db, "L1", 2, 5, "评审流程社区摘要")
    # Same (level, community_id) as a fact community — must NOT be selected.
    _add_summary(db, "L0", 1, 99, "fact 社区摘要", node_type="fact")

    gs = GlobalSearch(db, acomplete=StubComplete([]))
    selected = gs.select_communities("u1")

    assert [(s["level"], s["community_id"]) for s in selected] == [
        ("L0", 1),
        ("L1", 2),
    ]
    assert selected[0]["summary"] == "数据同步社区摘要"  # full text, never sliced
    assert selected[0]["member_count"] == 10


def test_select_respects_levels_override(db) -> None:
    _add_entity(db, "u1", {"L0": 1, "L1": 2})
    _add_summary(db, "L0", 1, 10, "L0 摘要")
    _add_summary(db, "L1", 2, 5, "L1 摘要")
    gs = GlobalSearch(db, acomplete=StubComplete([]), levels=["L1"])
    assert [(s["level"], s["community_id"]) for s in gs.select_communities("u1")] == [
        ("L1", 2)
    ]


def test_select_excludes_empty_whitespace_and_missing_summaries(db) -> None:
    _add_entity(db, "u1", {"L0": 1, "L1": 2, "L2": 3, "L3": 4})
    _add_summary(db, "L0", 1, 4, "")
    _add_summary(db, "L1", 2, 3, "   ")
    # (L2, 3) has no summary row at all.
    _add_summary(db, "L3", 4, 2, "有效摘要")
    gs = GlobalSearch(db, acomplete=StubComplete([]))
    assert [(s["level"], s["community_id"]) for s in gs.select_communities("u1")] == [
        ("L3", 4)
    ]


def test_select_dedups_duplicate_level_specs(db) -> None:
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 2, "摘要")
    gs = GlobalSearch(db, acomplete=StubComplete([]), levels=["L0", "L0"])
    assert len(gs.select_communities("u1")) == 1


def test_select_orders_by_member_count_desc(db) -> None:
    _add_entity(db, "u1", {"L0": 1, "L1": 2, "L2": 3})
    _add_summary(db, "L0", 1, 5, "小社区")
    _add_summary(db, "L1", 2, 20, "大社区")
    _add_summary(db, "L2", 3, 9, "中社区")
    gs = GlobalSearch(db, acomplete=StubComplete([]))
    assert [s["member_count"] for s in gs.select_communities("u1")] == [20, 9, 5]


def test_select_seeded_shuffle_is_reproducible_within_ties(db) -> None:
    """Equal member_count: fixed-seed shuffle, identical across runs/instances."""
    _add_entity(db, "u1", {"L0": 1, "L1": 2, "L2": 3, "L3": 4})
    for level, cid in (("L0", 1), ("L1", 2), ("L2", 3), ("L3", 4)):
        _add_summary(db, level, cid, 10, f"摘要{cid}")

    pairs = {
        (
            GlobalSearch(db, acomplete=StubComplete([]), shuffle_seed=seed),
            GlobalSearch(db, acomplete=StubComplete([]), shuffle_seed=seed),
        )
        for seed in (86, 7)
    }
    for gs_a, gs_b in pairs:
        order_a = [(s["level"], s["community_id"]) for s in gs_a.select_communities("u1")]
        order_b = [(s["level"], s["community_id"]) for s in gs_b.select_communities("u1")]
        assert order_a == order_b  # reproducibility within one seed
        assert sorted(order_a) == [("L0", 1), ("L1", 2), ("L2", 3), ("L3", 4)]


def test_select_caps_by_max_communities(db) -> None:
    _add_entity(db, "u1", {"L0": 1, "L1": 2, "L2": 3, "L3": 4})
    _add_summary(db, "L0", 1, 1, "c1")
    _add_summary(db, "L1", 2, 4, "c2")
    _add_summary(db, "L2", 3, 3, "c3")
    _add_summary(db, "L3", 4, 2, "c4")
    gs = GlobalSearch(db, acomplete=StubComplete([]), max_communities=2)
    selected = gs.select_communities("u1")
    assert [(s["level"], s["community_id"]) for s in selected] == [("L1", 2), ("L2", 3)]


def test_select_caps_by_total_prompt_budget_without_slicing(db) -> None:
    """Whole lowest-priority rows are dropped; kept rows stay full-length."""
    _add_entity(db, "u1", {"L0": 1, "L1": 2, "L2": 3})
    for level, cid, members in (("L0", 1, 30), ("L1", 2, 20), ("L2", 3, 10)):
        _add_summary(db, level, cid, members, "字" * 300)
    # Each rendered row ≈ 240 est. tokens; effective budget = 500 * 0.85 = 425
    # fits exactly one row.
    gs = GlobalSearch(db, acomplete=StubComplete([]), map_budget=500)
    selected = gs.select_communities("u1")
    assert len(selected) == 1
    assert (selected[0]["level"], selected[0]["member_count"]) == ("L0", 30)
    assert len(selected[0]["summary"]) == 300  # never truncated


def test_select_drops_single_oversized_summary_whole(db) -> None:
    """[!RED R3] A first row over the effective map budget is dropped, not
    admitted as an exception — and the STORED summary stays full."""
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 10, "字" * 3000)  # ~2000 est. tokens > eff(500)=425
    gs = GlobalSearch(db, acomplete=StubComplete([]), map_budget=500)
    assert gs.select_communities("u1") == []
    # Budgets only drop TRANSIENT prompt rows — the stored value is untouched.
    stored = db.execute(
        "SELECT summary FROM community_summaries "
        "WHERE level = 'L0' AND community_id = 1 AND node_type = 'entity'"
    ).fetchone()[0]
    assert stored == "字" * 3000


def test_pack_batches_splits_rows_and_keeps_them_whole(db) -> None:
    query = "q"
    overhead = estimate_tokens(
        MAP_SYSTEM_PROMPT.format(max_length=1024) + f"Question: {query}\n\n"
    )
    # Leave ~300 material tokens: one 238-token row fits per batch, two don't.
    gs = GlobalSearch(
        db,
        acomplete=StubComplete([]),
        map_budget=_budget_for_material(overhead, 300),
        map_max_tokens=1024,
    )
    rows = [_summary_row("L0", i, "字" * 300) for i in range(1, 4)]
    batches = gs._pack_batches(rows, query)
    assert [len(b) for b in batches] == [1, 1, 1]
    flat = [s for b in batches for s in b]
    assert flat == rows  # whole rows, priority order preserved


def test_pack_batches_drops_oversized_row_whole(db) -> None:
    """[!RED R3] A row larger than the whole material budget is dropped —
    never sent alone over budget, never sliced; smaller rows still pack."""
    query = "q"
    overhead = estimate_tokens(
        MAP_SYSTEM_PROMPT.format(max_length=1024) + f"Question: {query}\n\n"
    )
    gs = GlobalSearch(
        db,
        acomplete=StubComplete([]),
        map_budget=_budget_for_material(overhead, 300),
        map_max_tokens=1024,
    )
    oversized = _summary_row("L0", 1, "字" * 3000)  # ~2000 est. tokens
    normal = _summary_row("L1", 2, "正常摘要")
    batches = gs._pack_batches([oversized, normal], query)
    flat = [(s["level"], s["community_id"]) for b in batches for s in b]
    assert flat == [("L1", 2)]  # oversized dropped whole, normal kept


# ── zero-LLM-call no-data paths ─────────────────────────────────────────────


def test_no_community_assignments_zero_llm_calls(db) -> None:
    _add_entity(db, "u1", {})
    stub = StubComplete([])
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("我最近的任务是什么", "u1"))
    assert result.answer == NO_DATA_ANSWER
    assert result.reason == "no_communities"
    assert stub.call_count == 0
    assert result.diagnostics["summaries_selected"] == 0
    assert result.diagnostics["map_calls"] == 0
    assert result.diagnostics["reduce_called"] is False
    assert result.latency_ms >= 0


def test_unknown_entity_zero_llm_calls(db) -> None:
    stub = StubComplete([])
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "missing-id"))
    assert result.reason == "no_communities"
    assert stub.call_count == 0


def test_missing_community_columns_zero_llm_calls(tmp_path: Path) -> None:
    """A never-improved DB (no ``community_L*`` columns) degrades safely."""
    store = SQLiteStore(tmp_path / "bare.db")
    conn = store.conn
    conn.execute("INSERT INTO entities (id, name) VALUES ('u1', '用户')")
    conn.commit()
    stub = StubComplete([])
    result = asyncio.run(GlobalSearch(conn, acomplete=stub).search("q", "u1"))
    assert result.reason == "no_communities"
    assert stub.call_count == 0


def test_missing_summaries_table_zero_llm_calls(db) -> None:
    _add_entity(db, "u1", {"L0": 1})
    db.execute("DROP TABLE community_summaries")
    db.commit()
    stub = StubComplete([])
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "u1"))
    assert result.reason == "no_communities"
    assert stub.call_count == 0


# ── full ok path ────────────────────────────────────────────────────────────


def test_ok_path_answer_communities_citations_and_diagnostics(db) -> None:
    _add_entity(db, "u1", {"L0": 1, "L1": 2})
    _add_summary(db, "L0", 1, 10, "数据同步相关工作")
    _add_summary(db, "L1", 2, 5, "评审流程")
    stub = StubComplete(
        [
            _points_json(
                _point("负责数据同步评审 [Data: Communities (L0-1)]", 80, ("L0-1",)),
                _point("参与评审流程 [Data: Communities (L1-2)]", 60, ("L1-2",)),
            ),
            "FINAL ANSWER",
        ]
    )
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("我最近的任务是什么", "u1"))

    assert result.reason == "ok"
    assert result.answer == "FINAL ANSWER"
    assert result.communities == [
        {"level": "L0", "community_id": 1, "member_count": 10},
        {"level": "L1", "community_id": 2, "member_count": 5},
    ]
    assert result.citations == ["L0-1", "L1-2"]
    d = result.diagnostics
    assert d["summaries_selected"] == 2
    assert d["map_calls"] == 1
    assert d["map_batches_ok"] == 1
    assert d["map_batches_parse_failed"] == 0
    assert d["map_batches_error"] == 0
    assert d["points_total"] == 2
    assert d["points_kept"] == 2
    assert d["reduce_called"] is True
    assert d["llm_errors"] == []

    # Map prompt carries the FULL summary text (no slice-and-drop).
    map_user = stub.calls[0][1]
    assert "数据同步相关工作" in map_user and "评审流程" in map_user


# ── map step: parse vs transport ([!RED R4]) ────────────────────────────────


def test_map_batch_malformed_json_counts_parse_failed_not_error(db) -> None:
    stub = StubComplete(["this is not json"])
    gs = GlobalSearch(db, acomplete=stub)
    diagnostics = _new_diagnostics()
    points = asyncio.run(
        gs._map_batch([_summary_row("L0", 1, "摘要")], "q", diagnostics, asyncio.Semaphore(1))
    )
    assert points == []
    assert diagnostics["map_batches_parse_failed"] == 1
    assert diagnostics["map_batches_error"] == 0
    assert diagnostics["llm_errors"] == []  # parse discard != transport failure


def test_map_batch_bad_schema_counts_parse_failed(db) -> None:
    for bad in ('{"points": "nope"}', "[1, 2, 3]", '"just a string"'):
        stub = StubComplete([bad])
        gs = GlobalSearch(db, acomplete=stub)
        diagnostics = _new_diagnostics()
        points = asyncio.run(
            gs._map_batch(
                [_summary_row("L0", 1, "摘要")], "q", diagnostics, asyncio.Semaphore(1)
            )
        )
        assert points == []
        assert diagnostics["map_batches_parse_failed"] == 1


def test_map_batch_transport_error_counts_error_and_records_message(db) -> None:
    stub = StubComplete([RuntimeError("gateway 503")])
    gs = GlobalSearch(db, acomplete=stub)
    diagnostics = _new_diagnostics()
    points = asyncio.run(
        gs._map_batch([_summary_row("L0", 1, "摘要")], "q", diagnostics, asyncio.Semaphore(1))
    )
    assert points == []
    assert diagnostics["map_batches_error"] == 1
    assert diagnostics["map_batches_parse_failed"] == 0
    assert diagnostics["llm_errors"] == ["map: gateway 503"]


def test_map_batch_failure_does_not_block_other_batches(db) -> None:
    """Gather-level: one failing batch, one good batch → the good one lands."""
    stub = StubComplete([RuntimeError("boom"), _points_json(_point("要点", 70, ("L0-2",)))])
    gs = GlobalSearch(db, acomplete=stub)
    diagnostics = _new_diagnostics()
    sem = asyncio.Semaphore(2)

    async def run() -> list:
        return await asyncio.gather(
            gs._map_batch([_summary_row("L0", 1, "甲")], "q", diagnostics, sem),
            gs._map_batch([_summary_row("L0", 2, "乙")], "q", diagnostics, sem),
        )

    batch_points = asyncio.run(run())
    points = [p for batch in batch_points for p in batch]
    assert [p["description"] for p in points] == ["要点"]
    assert diagnostics["map_batches_error"] == 1
    assert diagnostics["map_batches_ok"] == 1


def test_search_level_malformed_json_yields_no_points_without_reduce(db) -> None:
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    stub = StubComplete(["definitely not json"])
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "u1"))
    assert result.answer == NO_DATA_ANSWER
    assert result.reason == "no_points"
    assert stub.call_count == 1  # map only — no reduce call
    assert result.diagnostics["map_batches_parse_failed"] == 1
    assert result.diagnostics["reduce_called"] is False


def test_search_level_map_transport_error_is_visible_not_silent(db) -> None:
    """Transport failure surfaces in diagnostics, never raises, never fakes."""
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    stub = StubComplete([RuntimeError("auth expired")])
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "u1"))
    assert result.answer == NO_DATA_ANSWER
    assert result.reason == "no_points"
    assert result.diagnostics["map_batches_error"] == 1
    assert result.diagnostics["map_batches_parse_failed"] == 0
    assert result.diagnostics["llm_errors"] == ["map: auth expired"]
    assert result.diagnostics["reduce_called"] is False


def test_map_out_of_range_and_wrong_type_scores_dropped(db) -> None:
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    stub = StubComplete(
        [
            _points_json(
                _point("too high", 150),
                _point("negative", -5),
                _point("string score", "85"),
                _point("bool score", True),
                _point("   ", 90),  # blank description -> dropped
                _point("valid", 75, ("L0-1",)),
            ),
            "REDUCED",
        ]
    )
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "u1"))
    assert result.reason == "ok"
    assert result.diagnostics["points_total"] == 1  # only the valid point
    assert result.diagnostics["points_kept"] == 1


# ── reduce step ─────────────────────────────────────────────────────────────


def test_reduce_drops_zero_scores_and_sorts_descending(db) -> None:
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    stub = StubComplete(
        [
            _points_json(
                _point("中点", 30, ("L0-1",)),
                _point("零点", 0, ("L0-1",)),
                _point("高点", 80, ("L0-1",)),
            ),
            "ANSWER",
        ]
    )
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "u1"))
    assert result.reason == "ok"
    prompt = stub.reduce_user_prompt()
    assert "零点" not in prompt  # score-0 dropped before reduce
    first = prompt.index("----Analyst 1----\nImportance Score: 80")
    second = prompt.index("----Analyst 2----\nImportance Score: 30")
    assert first < second  # stable descending by importance


def test_reduce_budget_drops_oversized_blocks_whole_without_reduce_call(db) -> None:
    """[!RED R3] FLIPPED: blocks that exceed the effective reduce budget are
    DROPPED whole (never sent), no reduce call runs, stored summary intact."""
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    stub = StubComplete(
        [
            _points_json(
                _point("甲" * 300, 90, ("L0-1",)),
                _point("乙" * 300, 50, ("L0-1",)),
                _point("丙" * 300, 10, ("L0-1",)),
            ),
            "ANSWER",
        ]
    )
    # Effective reduce budget = floor(260 * 0.85) = 221 tokens; once the
    # system-prompt + question overhead is reserved, no 228-token block fits,
    # so the whole evidence is dropped and reduce never runs.
    result = asyncio.run(
        GlobalSearch(db, acomplete=stub, reduce_budget=260).search("q", "u1")
    )
    assert result.answer == NO_DATA_ANSWER
    assert result.reason == "no_points"
    assert stub.call_count == 1  # map only — no reduce call
    assert result.diagnostics["reduce_called"] is False
    assert result.diagnostics["points_kept"] == 3
    # Budgets only drop TRANSIENT blocks — the STORED summary is untouched.
    stored = db.execute(
        "SELECT summary FROM community_summaries "
        "WHERE level = 'L0' AND community_id = 1 AND node_type = 'entity'"
    ).fetchone()[0]
    assert stored == "摘要"


def test_reduce_budget_keeps_top_block_and_drops_rest_whole(db) -> None:
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    stub = StubComplete(
        [
            _points_json(
                _point("甲" * 300, 90, ("L0-1",)),
                _point("乙" * 300, 50, ("L0-1",)),
                _point("丙" * 300, 10, ("L0-1",)),
            ),
            "ANSWER",
        ]
    )
    overhead = estimate_tokens(
        REDUCE_SYSTEM_PROMPT.format(max_length=1500) + "Question: q\n\n"
    )
    # Leave ~300 material tokens: one 228-token block fits, two don't.
    gs = GlobalSearch(
        db,
        acomplete=stub,
        reduce_budget=_budget_for_material(overhead, 300),
        reduce_max_tokens=1500,
    )
    result = asyncio.run(gs.search("q", "u1"))
    assert result.reason == "ok"
    prompt = stub.reduce_user_prompt()
    assert "----Analyst 1----" in prompt and "甲" * 300 in prompt
    assert "----Analyst 2----" not in prompt
    assert "乙" not in prompt and "丙" not in prompt  # whole blocks dropped


def test_emitted_prompts_never_exceed_effective_budgets(db) -> None:
    """[!RED R3] every emitted prompt (system + user) estimates within the
    effective budget — map and reduce alike."""
    _add_entity(db, "u1", {"L0": 1, "L1": 2, "L2": 3})
    for level, cid, members in (("L0", 1, 30), ("L1", 2, 20), ("L2", 3, 10)):
        _add_summary(db, level, cid, members, "字" * 300)

    query = "我最近的任务是什么"
    map_overhead = estimate_tokens(
        MAP_SYSTEM_PROMPT.format(max_length=1024) + f"Question: {query}\n\n"
    )
    reduce_overhead = estimate_tokens(
        REDUCE_SYSTEM_PROMPT.format(max_length=1500) + f"Question: {query}\n\n"
    )
    row_costs = [
        estimate_tokens(
            GlobalSearch._render_row(
                _summary_row(level, cid, "字" * 300, members=members)
            )
            + "\n\n"
        )
        for level, cid, members in (("L0", 1, 30), ("L1", 2, 20), ("L2", 3, 10))
    ]
    # Selection (overhead-free) must admit all three rows, while packing must
    # not admit two rows per batch.
    map_budget = max(
        math.ceil(sum(row_costs) / BUDGET_SAFETY_FACTOR) + 1,
        _budget_for_material(map_overhead, max(row_costs)),
    )
    reduce_budget = _budget_for_material(reduce_overhead, 500)

    stub = StubComplete(
        [
            _points_json(_point("甲要点 [Data: Communities (L0-1)]", 90, ("L0-1",))),
            _points_json(_point("乙要点 [Data: Communities (L1-2)]", 60, ("L1-2",))),
            _points_json(_point("丙要点 [Data: Communities (L2-3)]", 30, ("L2-3",))),
            "ANSWER",
        ]
    )
    gs = GlobalSearch(
        db,
        acomplete=stub,
        map_budget=map_budget,
        reduce_budget=reduce_budget,
        map_max_tokens=1024,
        reduce_max_tokens=1500,
    )
    result = asyncio.run(gs.search(query, "u1"))
    assert result.reason == "ok"
    assert result.diagnostics["reduce_called"] is True
    assert result.diagnostics["map_calls"] == 3  # single-row batches

    for system, user in stub.calls:
        is_map = "Respond ONLY with JSON" in system
        limit = effective_budget(map_budget if is_map else reduce_budget)
        assert estimate_tokens(system + user) <= limit


def test_reduce_transport_error_returns_error_reason_and_visible_log(db) -> None:
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    stub = StubComplete([_points_json(_point("要点", 50, ("L0-1",))), RuntimeError("timeout")])
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "u1"))
    assert result.answer == NO_DATA_ANSWER
    assert result.reason == "error"
    assert result.diagnostics["reduce_called"] is False
    assert result.diagnostics["llm_errors"] == ["reduce: timeout"]
    assert result.citations == []  # nothing was cited by a successful answer


def test_all_points_score_zero_no_reduce_call(db) -> None:
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    stub = StubComplete(
        [_points_json(_point("无关", 0, ("L0-1",)), _point("不知道", 0, ("L0-1",)))]
    )
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "u1"))
    assert result.answer == NO_DATA_ANSWER
    assert result.reason == "no_points"
    assert stub.call_count == 1  # map only
    assert result.diagnostics["points_total"] == 2
    assert result.diagnostics["points_kept"] == 0
    assert result.diagnostics["reduce_called"] is False
    # Selected metadata is still reported for the no_points path.
    assert result.communities == [
        {"level": "L0", "community_id": 1, "member_count": 3}
    ]


# ── citations + helpers ─────────────────────────────────────────────────────


def test_citation_clamp_five_ids_plus_more() -> None:
    ids = [f"L1-{i}" for i in range(1, 8)]
    assert clamp_citations(ids) == ids[:5] + ["+more"]
    assert clamp_citations(ids[:5]) == ids[:5]
    assert clamp_citations(ids[:2]) == ids[:2]
    assert clamp_citations([]) == []


def test_citations_clamped_end_to_end(db) -> None:
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    many = tuple(f"L0-{i}" for i in range(1, 8))
    stub = StubComplete([_points_json(_point("要点", 50, many)), "ANSWER"])
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "u1"))
    assert result.reason == "ok"
    assert result.citations == list(many[:5])  # '+more' not stored as a citation


def test_reduce_prompt_citations_clamped_to_five_ids_plus_more(db) -> None:
    """FIX-NOW: inspect the ACTUAL reduce prompt — no citation may exceed
    five ids + '+more', and ids come from the validated community_ids."""
    _add_entity(db, "u1", {"L0": 1})
    _add_summary(db, "L0", 1, 3, "摘要")
    many = tuple(f"L0-{i}" for i in range(1, 8))
    # The model-authored bracket smuggles 8 ids (incl. one never validated);
    # the reduce evidence must carry the canonical 5 + '+more' instead.
    desc = "要点 [Data: Communities (L0-7, L0-6, L0-5, L0-4, L0-3, L0-2, L0-1, FAKE-9)]"
    stub = StubComplete([_points_json(_point(desc, 50, many)), "ANSWER"])
    result = asyncio.run(GlobalSearch(db, acomplete=stub).search("q", "u1"))
    assert result.reason == "ok"
    prompt = stub.reduce_user_prompt()
    assert "[Data: Communities (L0-1, L0-2, L0-3, L0-4, L0-5, +more)]" in prompt
    assert "L0-6" not in prompt and "L0-7" not in prompt and "FAKE-9" not in prompt
    # Every bracket in the actual reduce prompt carries at most five real ids.
    for bracket in re.finditer(r"\[Data:\s*Communities\s*\(([^)]*)\)\]", prompt):
        ids = [part.strip() for part in bracket.group(1).split(",")]
        assert len([c for c in ids if c != "+more"]) <= 5


def test_normalize_point_citation_rewrites_from_validated_ids() -> None:
    ids = [f"L1-{i}" for i in range(1, 8)]
    canonical = "[Data: Communities (L1-1, L1-2, L1-3, L1-4, L1-5, +more)]"
    replaced = normalize_point_citation(
        "要点 [Data: Communities (X-9, X-8, X-7, X-6, X-5, X-4)]", ids
    )
    assert replaced == f"要点 {canonical}"  # model bracket replaced
    assert normalize_point_citation("要点", ids) == f"要点 {canonical}"  # appended
    # No validated ids -> nothing canonical to write, description untouched.
    untouched = "要点 [Data: Communities (X-1, X-2, X-3, X-4, X-5, X-6)]"
    assert normalize_point_citation(untouched, []) == untouched


def test_estimate_tokens_and_budget_margin() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("abc") == 2  # ceil(3 / 1.5)
    assert estimate_tokens("abcd") == 3  # ceil(4 / 1.5)
    assert effective_budget(100) == 85
    assert effective_budget(0) == 1  # never zero


def test_parse_levels_and_community_ref() -> None:
    assert parse_levels("L0, L2,L0,L3") == ["L0", "L2", "L3"]
    assert parse_levels("") == []
    assert community_ref("L1", 12) == "L1-12"
