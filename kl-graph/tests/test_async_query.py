"""Async query engine: parity with the sync path + reentrancy under concurrency.

Covers the two `[!RED]` risks from docs/todo/async-ask.md:

1. **Output parity** — ``aquery()`` must return an identical ``QueryResult`` to
   ``query()`` for the same input; the only difference is that the async path
   frees the event loop at each I/O boundary.
2. **Reentrancy / no cross-talk** — the engine is a single shared instance and
   many ``aquery()`` coroutines interleave on it at every ``await``. The
   per-query rewrite is now a *returned value* (not ``self._last_rewrite``), so
   two concurrent queries with different rewrites must not contaminate each
   other. We force interleaving and assert each query keeps its own match.

The engine is built via ``__new__`` so ``__init__`` (which opens Qdrant / a store
and reads env) never runs; only the collaborators the query path touches are
faked. No network, no Qdrant, no SQLite.

Run: ``.venv/bin/python -m pytest tests/test_async_query.py -q``
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.query.engine import QueryEngine
from kl_graph.query.query_rewrite import QueryRewrite


@dataclass
class _FakeFact:
    id: str
    text: str
    fact_type: object
    timestamp: int
    confidence: float


class _FT:
    """Stand-in for a FactType enum member (has ``.value``)."""

    def __init__(self, value: str) -> None:
        self.value = value


class _FakeStore:
    """Minimal KnowledgeStore surface the query path reads."""

    # QueryEngine._conn resolves live from store.sql_conn; the query paths
    # under test run with fts_enabled=False so it is never dereferenced.
    sql_conn = None

    def __init__(self) -> None:
        self._facts = {
            "f1": _FakeFact("f1", "悟空负责部署平台", _FT("DECISION"), 100, 0.9),
            "f2": _FakeFact("f2", "八戒待定", _FT("STATUS"), 90, 0.5),
        }

    def count_entities(self) -> int:
        return 3

    def count_facts(self) -> int:
        return 2

    def get_messages_for_entity(self, eid, limit=20):
        return []

    def get_facts_for_entity(self, eid, limit=10):
        return {"e1": [self._facts["f1"]], "e2": [self._facts["f2"]]}.get(eid, [])

    def get_fact(self, fid):
        return self._facts.get(fid)

    def get_message(self, mid):
        return None

    def search_entities_by_name(self, query, limit=5):
        return []


class _FakeQdrant:
    """Fake Qdrant: fixed ANN hits so fusion is deterministic."""

    def search(self, collection, vector, limit=20, score_threshold=None):
        if collection == "facts":
            return [
                {
                    "score": 0.9,
                    "payload": {
                        "fact_id": "f1",
                        "text": "悟空负责部署平台",
                        "fact_type": "DECISION",
                        "timestamp": 100,
                        "confidence": 0.9,
                    },
                },
                {
                    "score": 0.5,
                    "payload": {
                        "fact_id": "f2",
                        "text": "八戒待定",
                        "fact_type": "STATUS",
                        "timestamp": 90,
                        "confidence": 0.5,
                    },
                },
            ]
        if collection == "chunks":
            return [
                {
                    "score": 0.8,
                    "payload": {
                        "chunk_id": "c1",
                        "content": "关于悟空",
                        "source_type": "message",
                        "sender": "唐僧",
                        "timestamp": 100,
                    },
                },
            ]
        if collection == "entities":
            return [
                {
                    "score": 0.95,
                    "payload": {
                        "entity_id": "e1",
                        "name": "悟空",
                        "entity_type": "Project",
                    },
                },
                {
                    "score": 0.85,
                    "payload": {
                        "entity_id": "e2",
                        "name": "八戒",
                        "entity_type": "Person",
                    },
                },
            ]
        return []


class _FakeEmbedder:
    """Fake embedder exposing both the sync and async twins."""

    def embed_one(self, text):
        return [0.1] * 8

    async def aembed_one(self, text):
        await asyncio.sleep(0)  # yield so overlapping coroutines interleave here
        return [0.1] * 8


class _FakeReranker:
    enabled = False


def _make_engine():
    """A QueryEngine with only the query-path collaborators wired (no network)."""
    eng = QueryEngine.__new__(QueryEngine)
    eng.store = _FakeStore()
    eng.qdrant = _FakeQdrant()
    eng.embedder = _FakeEmbedder()
    eng.reranker = _FakeReranker()
    eng.pagerank = {"e1": 0.9, "e2": 0.8}
    eng.fts_enabled = False
    eng.type_pool = {}
    eng.llm_model = "anthropic/x"
    eng.llm_base_url = "http://x"
    eng.api_key = "k"
    return eng


def _patch_rewrite(monkeypatch, rw):
    import kl_graph.query.engine as emod

    def fake_rewrite_query(*a, **k):
        return rw

    async def fake_arewrite_query(*a, **k):
        await asyncio.sleep(0)  # let concurrent coroutines interleave
        return rw

    monkeypatch.setattr(emod, "rewrite_query", fake_rewrite_query)
    monkeypatch.setattr(emod, "arewrite_query", fake_arewrite_query)


def _normalize(result):
    """Comparable snapshot of a QueryResult (timing dropped)."""
    return {
        "answer": result.answer,
        "items": result.items,
        "phase": result.phase,
        "entities_found": result.entities_found,
        "matched_entities": result.matched_entities,
        "fact_hits": result.fact_hits,
        "chunk_hits": result.chunk_hits,
    }


# ── 1. Parity ─────────────────────────────────────────────────────────────────


def test_aquery_matches_query_phase1(monkeypatch) -> None:
    rw = QueryRewrite(
        entities_from_query=["悟空"],
        entity_type_keywords=["PROJECT"],
        fact_type_keywords=["DECISION"],
    )
    _patch_rewrite(monkeypatch, rw)

    sync_out = _normalize(_make_engine().query("谁负责部署平台"))
    async_out = _normalize(asyncio.run(_make_engine().aquery("谁负责部署平台")))

    assert sync_out == async_out
    assert sync_out["items"], "expected non-empty fused items"


def test_aquery_matches_query_substring_path(monkeypatch) -> None:
    # rewrite=None -> substring fallback path on both sync + async.
    _patch_rewrite(monkeypatch, None)

    sync_out = _normalize(_make_engine().query("随便问问"))
    async_out = _normalize(asyncio.run(_make_engine().aquery("随便问问")))
    assert sync_out == async_out


def test_caller_rewrite_skips_llm_and_still_resolves_entities(monkeypatch) -> None:
    import kl_graph.query.engine as emod

    async def unexpected_rewrite(*_args, **_kwargs):
        raise AssertionError("caller intent must bypass the rewrite LLM")

    monkeypatch.setattr(emod, "arewrite_query", unexpected_rewrite)
    supplied = QueryRewrite(
        entities_from_query=["悟空"],
        entity_type_keywords=["PROJECT"],
        fact_type_keywords=["DECISION"],
    )

    result = asyncio.run(
        _make_engine().aquery("谁负责部署平台", query_rewrite=supplied)
    )

    assert result.entities_found == ["悟空", "八戒"]
    assert result.items


# ── 2. Reentrancy: concurrent aquery() must not cross-contaminate ──────────────


def test_concurrent_aqueries_do_not_crosstalk(monkeypatch) -> None:
    """Overlapping asks with different rewrites keep their own entity match.

    Query A's rewrite matches 悟空 (e1); query B's matches 八戒 (e2). If the
    rewrite leaked across coroutines (the old ``self._last_rewrite`` bug), a
    query would pick up the other's entities. We run many interleaved pairs and
    assert each result carries only its own match.
    """
    import kl_graph.query.engine as emod

    rw_a = QueryRewrite(
        entities_from_query=["悟空"], entity_type_keywords=[], fact_type_keywords=[]
    )
    rw_b = QueryRewrite(
        entities_from_query=["八戒"], entity_type_keywords=[], fact_type_keywords=[]
    )

    async def fake_arewrite_query(model, question, type_pool, **k):
        await asyncio.sleep(0)  # force A and B to interleave mid-flight
        # NOTE: the engine normalizes (lowercases) the query before calling the
        # rewrite, so match on the normalized text.
        return rw_a if question == "a" else rw_b

    monkeypatch.setattr(emod, "arewrite_query", fake_arewrite_query)

    # Distinct vector per keyword so the entities search routes deterministic-
    # ally: 悟空 -> [1,0,...] -> e1, 八戒 -> [0,1,...] -> e2. The engine embeds
    # ``rw.entities_from_query`` per query, so a leaked rewrite would embed the
    # wrong keyword and surface the wrong entity — a clean cross-talk detector.
    class _RoutingEmbedder:
        def embed_one(self, text):
            return self._vec(text)

        async def aembed_one(self, text):
            await asyncio.sleep(0)
            return self._vec(text)

        @staticmethod
        def _vec(text):
            if text == "悟空":
                return [1.0] + [0.0] * 7
            if text == "八戒":
                return [0.0, 1.0] + [0.0] * 6
            return [0.0] * 8

    class _RoutingQdrant(_FakeQdrant):
        def search(self, collection, vector, limit=20, score_threshold=None):
            if collection == "entities":
                if vector and vector[0] == 1.0:
                    return [
                        {
                            "score": 0.95,
                            "payload": {
                                "entity_id": "e1",
                                "name": "悟空",
                                "entity_type": "Project",
                            },
                        }
                    ]
                if len(vector) > 1 and vector[1] == 1.0:
                    return [
                        {
                            "score": 0.9,
                            "payload": {
                                "entity_id": "e2",
                                "name": "八戒",
                                "entity_type": "Person",
                            },
                        }
                    ]
                return []
            return super().search(collection, vector, limit, score_threshold)

    eng = _make_engine()  # single SHARED engine, like the server
    eng.embedder = _RoutingEmbedder()
    eng.qdrant = _RoutingQdrant()

    async def run_many():
        tasks = []
        for _ in range(25):
            tasks.append(eng.aquery("A"))
            tasks.append(eng.aquery("B"))
        return await asyncio.gather(*tasks)

    results = asyncio.run(run_many())

    for i, res in enumerate(results):
        names = res.entities_found
        if i % 2 == 0:  # A -> only 悟空
            assert names == ["悟空"], f"A #{i} cross-talk: {names}"
        else:  # B -> only 八戒
            assert names == ["八戒"], f"B #{i} cross-talk: {names}"
