"""Recall-dedup coverage: intra-route (U1) + same-type suppression (U2) + gate.

Locks the finalized recall-dedup design (docs/todo/recall-dedup.md):

- **U1** — :func:`kl_graph.utils.helpers.dedup_ranked` collapses repeat ids
  *within* one ranked list (keep-first == best rank) before RRF, so a route that
  surfaces the same id twice (a chunk MENTIONING two matched entities) stops
  double-contributing ``1/(k+rank)`` to the fusion.
- **U2** — post-fusion suppression collapses **same-type** duplicates only.
  Two items of the same ``type`` whose normalized content is md5-equal or fuzzy
  (byte-identical normalized content, md5-equal) keep one
  survivor (highest fused score, tie-break by fused rank); losers are recorded
  in the survivor's ``merged_ids``. Different types never suppress each other —
  a fact and its source chunk are BOTH kept, and two chunks from different
  source types are BOTH kept.
- **Gate** — both layers honour ``config.QUERY_DEDUP_ENABLED``
  (``KL_QUERY_DEDUP`` env). Off ⇒ exactly the pre-dedup behaviour, empty stats.

All tests run offline: no network/LLM/live-``data`` dependency. The engine-level
tests build a :class:`QueryEngine` via ``__new__`` and wire only the query-path
collaborators with fakes, mirroring ``tests/test_async_query.py`` /
``tests/test_query_backend.py``.

Run: ``.venv/bin/python -m pytest tests/test_recall_dedup.py -q``
"""

from __future__ import annotations

import hashlib
import importlib

import kl_graph.config as config_mod
import kl_graph.query.engine as emod
from kl_graph.models.types import Chunk, Entity, EntityType
from kl_graph.query.engine import (
    QueryEngine,
    _is_duplicate,
    _normalize_for_dedup,
    _suppress_same_type_duplicates,
)
from kl_graph.utils.helpers import dedup_ranked

# ── shared string fixtures (ratios pre-verified against the real helpers) ──────
# Same normalized text apart from whitespace/line breaks → md5-equal.
_WS_A = "悟空  负责\n部署平台\t安全"
_WS_B = "悟空 负责 部署平台 安全"
# Byte-identical content — collapses under exact-hash suppression.
_DUP = "The sandbox security policy ships this Friday for the review."
# Distinct content — never collapses (different normalized text → different id).
_OTHER = "The database migration runs next Tuesday during the maintenance window."


def _hash(text: str) -> str:
    """md5 hex of ``text`` (matches the engine's per-item hashing).

    Args:
        text: Already-normalized text.

    Returns:
        The md5 hexdigest the suppression pass keys hash-equality on.
    """
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def _near_dup(a: str, b: str) -> bool:
    """Normalize + hash two raw texts and ask :func:`_is_duplicate`.

    Mirrors exactly what ``_suppress_same_type_duplicates`` does per pair, so the
    unit tests exercise the helper through its real calling convention.

    Args:
        a: First raw item content.
        b: Second raw item content.

    Returns:
        True if the two are treated as the same evidence.
    """
    na, nb = _normalize_for_dedup(a), _normalize_for_dedup(b)
    ha = _hash(na) if na else ""
    hb = _hash(nb) if nb else ""
    return _is_duplicate(ha, hb)


def _item(item_id: str, item_type: str, content: str, score: float) -> dict:
    """Build a resolved-item dict shaped like ``_fuse_and_resolve`` emits.

    Args:
        item_id: Item id (fact/chunk uuid).
        item_type: Exact ``type`` value (``"fact"``, ``"message"``, ``"mail"``…).
        content: The text compared for near-duplicate suppression.
        score: Fused score (items reach suppression in descending score order).

    Returns:
        A dict with the keys the suppression pass reads (``id``/``type``/
        ``content``) plus ``score`` for realism.
    """
    return {"id": item_id, "type": item_type, "content": content, "score": score}


# ── 1. Unit — dedup_ranked (U1: intra-route keep-first) ────────────────────────


def test_dedup_ranked_keep_first_and_order() -> None:
    """Later repeats drop; first (best-rank) occurrence kept; order preserved."""
    ranked = [("a", 0.9), ("b", 0.8), ("a", 0.7), ("c", 0.6), ("b", 0.5)]
    assert dedup_ranked(ranked) == [("a", 0.9), ("b", 0.8), ("c", 0.6)]


def test_dedup_ranked_empty_list() -> None:
    """An empty ranked list is returned unchanged (no crash)."""
    assert dedup_ranked([]) == []


def test_dedup_ranked_noop_when_all_unique() -> None:
    """A list with no repeats is returned intact, order and scores preserved."""
    ranked = [("a", 0.9), ("b", 0.8), ("c", 0.7)]
    assert dedup_ranked(ranked) == ranked


def test_dedup_ranked_keeps_first_occurrence_score() -> None:
    """The kept score is the first occurrence's, never a later repeat's."""
    ranked = [("a", 0.99), ("a", 0.01)]
    out = dedup_ranked(ranked)
    assert out == [("a", 0.99)]


# ── 2. Unit — normalization / hash / duplicate helpers (U2 primitives) ────────


def test_normalize_collapses_whitespace() -> None:
    """Leading/trailing stripped and internal whitespace runs collapse to one."""
    assert _normalize_for_dedup(_WS_A) == "悟空 负责 部署平台 安全"
    assert _normalize_for_dedup("  a   b\n\tc  ") == "a b c"


def test_normalize_empty_and_blank_safety() -> None:
    """Empty / blank / whitespace-only inputs normalize to the empty string."""
    assert _normalize_for_dedup("") == ""
    assert _normalize_for_dedup("   \n\t  ") == ""


def test_identical_text_after_normalization_is_duplicate() -> None:
    """Copies differing only in whitespace hash-equal → treated as duplicates."""
    na, nb = _normalize_for_dedup(_WS_A), _normalize_for_dedup(_WS_B)
    assert _hash(na) == _hash(nb)
    assert _near_dup(_WS_A, _WS_B) is True


def test_distinct_text_is_not_duplicate() -> None:
    """Different normalized text → different md5 → not a duplicate."""
    assert _near_dup(_DUP, _OTHER) is False


def test_duplicate_empty_content_never_matches() -> None:
    """Two empty (or blank) contents must never be fused as duplicates."""
    assert _near_dup("", "") is False
    assert _near_dup("   ", "\n\t") is False
    assert _near_dup("abc", "") is False


# ── 3. Unit — _suppress_same_type_duplicates ───────────────────────────────────


def test_suppress_identical_same_type_keeps_highest_score() -> None:
    """Same-type identical text collapses to the highest-score survivor.

    Items arrive in descending fused-score order, so the first is the survivor;
    the loser id lands in ``merged_ids`` and in the returned ``merged`` log.
    """
    items = [
        _item("a", "message", "请确认数据同步策略上线时间。", 0.9),
        _item("b", "message", "请确认数据同步策略上线时间。", 0.5),
    ]
    kept, suppressed, merged = _suppress_same_type_duplicates(items)

    assert [k["id"] for k in kept] == ["a"]
    assert suppressed == 1
    assert kept[0]["merged_ids"] == ["b"]
    assert merged == [{"survivor": "a", "dropped": "b"}]


def test_suppress_tie_score_earlier_rank_survives() -> None:
    """On a score tie the earlier-ranked (first) item survives, deterministically."""
    items = [
        _item("first", "message", "打平分数的内容。", 0.5),
        _item("second", "message", "打平分数的内容。", 0.5),
    ]
    kept, suppressed, merged = _suppress_same_type_duplicates(items)

    assert [k["id"] for k in kept] == ["first"]
    assert suppressed == 1
    assert merged == [{"survivor": "first", "dropped": "second"}]


def test_suppress_distinct_texts_all_survive() -> None:
    """Same-type items with distinct text are all kept, no annotations added."""
    items = [
        _item("x", "fact", "悟空负责数据同步模块。", 0.9),
        _item("y", "fact", "八戒负责数据同步任务。", 0.8),
    ]
    kept, suppressed, merged = _suppress_same_type_duplicates(items)

    assert [k["id"] for k in kept] == ["x", "y"]
    assert suppressed == 0
    assert merged == []
    assert all("merged_ids" not in k for k in kept)


def test_suppress_fact_and_chunk_identical_text_both_kept() -> None:
    """A fact and its source chunk with identical text are BOTH kept.

    Suppression groups by exact ``type``; ``fact`` and ``message`` never compare.
    """
    items = [
        _item("f1", "fact", "悟空负责数据同步模块。", 0.9),
        _item("c1", "message", "悟空负责数据同步模块。", 0.8),
    ]
    kept, suppressed, merged = _suppress_same_type_duplicates(items)

    assert {(k["id"], k["type"]) for k in kept} == {("f1", "fact"), ("c1", "message")}
    assert suppressed == 0
    assert merged == []


def test_suppress_message_and_mail_identical_text_both_kept() -> None:
    """Different source types (message vs mail) never suppress each other."""
    items = [
        _item("m1", "message", "相同的内容文本在此。", 0.9),
        _item("l1", "mail", "相同的内容文本在此。", 0.8),
    ]
    kept, suppressed, merged = _suppress_same_type_duplicates(items)

    assert {(k["id"], k["type"]) for k in kept} == {("m1", "message"), ("l1", "mail")}
    assert suppressed == 0
    assert merged == []


def test_suppress_three_item_cluster_one_survivor_two_merged() -> None:
    """A three-item duplicate cluster collapses to one survivor with two losers."""
    items = [
        _item("p", "message", "同样的三条消息内容。", 0.9),
        _item("q", "message", "同样的三条消息内容。", 0.7),
        _item("r", "message", "同样的三条消息内容。", 0.5),
    ]
    kept, suppressed, merged = _suppress_same_type_duplicates(items)

    assert [k["id"] for k in kept] == ["p"]
    assert suppressed == 2
    assert kept[0]["merged_ids"] == ["q", "r"]
    assert merged == [
        {"survivor": "p", "dropped": "q"},
        {"survivor": "p", "dropped": "r"},
    ]


def test_suppress_blank_content_items_kept_separate() -> None:
    """Same-type items with blank content must not be collapsed together."""
    items = [
        _item("b1", "message", "   ", 0.9),
        _item("b2", "message", "\n\t", 0.8),
    ]
    kept, suppressed, merged = _suppress_same_type_duplicates(items)

    assert [k["id"] for k in kept] == ["b1", "b2"]
    assert suppressed == 0
    assert merged == []


# ── 4. Integration — engine Phase-1 (real query() path, faked collaborators) ───


class _FakeEmbedder:
    """Fake embedder: fixed vector, no network. Exposes sync + async twins."""

    def embed_one(self, text: str) -> list[float]:
        return [0.1] * 8

    async def aembed_one(self, text: str) -> list[float]:
        return [0.1] * 8


class _FakeReranker:
    """Disabled reranker → the engine applies its plain top-K cut."""

    enabled = False


class _StubQdrant:
    """Fake Qdrant returning canned ANN hits per collection.

    Args:
        hits: Mapping of collection name → ``[{"score", "payload"}, ...]``.
    """

    def __init__(self, hits: dict[str, list[dict]]) -> None:
        self._hits = hits

    def search(self, collection, vector, limit=20, score_threshold=None):
        return list(self._hits.get(collection, []))


class _StubStore:
    """Minimal KnowledgeStore surface the Phase-1 query path reads.

    Configurable per scenario. ``n_ent``/``n_fact`` drive entity-match routing
    (both ``0`` forces the substring fallback so no LLM rewrite is needed);
    ``entities`` feeds the substring matcher; ``ent_msgs``/``ent_facts`` feed
    structural expansion; ``facts``/``chunks`` back the id→content resolve.
    """

    def __init__(
        self,
        *,
        n_ent: int = 0,
        n_fact: int = 0,
        entities: tuple = (),
        ent_msgs: dict | None = None,
        ent_facts: dict | None = None,
        facts: dict | None = None,
        chunks: dict | None = None,
    ) -> None:
        self._n_ent = n_ent
        self._n_fact = n_fact
        self._entities = list(entities)
        self._ent_msgs = ent_msgs or {}
        self._ent_facts = ent_facts or {}
        self._facts = facts or {}
        self._chunks = chunks or {}
        # QueryEngine._conn is a property resolving to store.sql_conn (upstream
        # 14d78f7 made connections per-thread). Tests run with fts_enabled=False
        # so it is never dereferenced; expose the attribute so the property works.
        self.sql_conn = None

    def count_entities(self) -> int:
        return self._n_ent

    def count_facts(self) -> int:
        return self._n_fact

    def search_entities_by_name(self, query, limit=5):
        return list(self._entities)

    def get_messages_for_entity(self, eid, limit=20):
        return list(self._ent_msgs.get(eid, []))

    def get_facts_for_entity(self, eid, limit=10):
        return list(self._ent_facts.get(eid, []))

    def get_fact(self, fid):
        return self._facts.get(fid)

    def get_message(self, mid):
        return self._chunks.get(mid)


def _make_engine(store: _StubStore, qdrant: _StubQdrant, pagerank=None) -> QueryEngine:
    """Build a QueryEngine with only the Phase-1 collaborators wired (no network).

    Mirrors ``tests/test_async_query.py``: constructs via ``__new__`` so the real
    ``__init__`` (which opens Qdrant / a store and reads env) never runs.

    Args:
        store: Stub knowledge store.
        qdrant: Stub vector store.
        pagerank: Optional entity-importance prior; defaults to empty.

    Returns:
        A query-ready :class:`QueryEngine`.
    """
    eng = QueryEngine.__new__(QueryEngine)
    eng.store = store  # pyright: ignore[reportAttributeAccessIssue]  (duck-typed stub)
    eng.qdrant = qdrant  # pyright: ignore[reportAttributeAccessIssue]
    eng.embedder = _FakeEmbedder()  # pyright: ignore[reportAttributeAccessIssue]
    eng.reranker = _FakeReranker()  # pyright: ignore[reportAttributeAccessIssue]
    eng.pagerank = pagerank or {}
    eng.fts_enabled = False
    eng.type_pool = {}
    eng.llm_model = "anthropic/x"
    eng.llm_base_url = "http://x"
    eng.api_key = "k"
    return eng


def _fact_hit(fid: str, text: str, score: float) -> dict:
    """A dense ``facts`` ANN hit shaped like Qdrant returns."""
    return {
        "score": score,
        "payload": {
            "fact_id": fid,
            "text": text,
            "fact_type": "GENERAL",
            "timestamp": 100,
            "confidence": 0.9,
        },
    }


def _chunk_hit(
    cid: str, content: str, score: float, source_type: str = "message"
) -> dict:
    """A dense ``chunks`` ANN hit shaped like Qdrant returns."""
    return {
        "score": score,
        "payload": {
            "chunk_id": cid,
            "content": content,
            "source_type": source_type,
            "sender": "唐僧",
            "timestamp": 100,
        },
    }


def test_chunk_mentioning_two_entities_single_contribution(monkeypatch) -> None:
    """One chunk MENTIONING two matched entities contributes once, not twice.

    Structural expansion emits ``(chunk_id, score)`` per matched entity, so a
    chunk mentioned by both entities is appended twice to the same route list.
    U1 must collapse that to a single best-rank contribution — recorded in
    ``dedup_stats["intra_route"]`` — so the chunk's fused score is *lower* than
    when dedup is off (where the route double-counts ``1/(k+rank)``).
    """
    chunk = Chunk(
        id="c1",
        content="悟空 与 八戒 讨论数据同步。",
        source_type="message",
        timestamp=100,
        metadata={"sender": "唐僧"},
    )
    store = _StubStore(
        n_ent=0,  # 0/0 → substring fallback (no LLM rewrite needed)
        n_fact=0,
        entities=(
            Entity(id="e1", name="悟空", entity_type=EntityType.PROJECT),
            Entity(id="e2", name="八戒", entity_type=EntityType.PERSON),
        ),
        ent_msgs={"e1": [chunk], "e2": [chunk]},  # SAME chunk from both entities
        chunks={"c1": chunk},
    )
    qdrant = _StubQdrant({})  # dense channels empty → the double is purely structural
    pagerank = {"e1": 0.9, "e2": 0.8}

    # Dedup ON (default binding).
    on = _make_engine(store, qdrant, pagerank).query("悟空 八戒")
    on_ids = [i["id"] for i in on.items]
    assert on_ids.count("c1") == 1
    assert on.dedup_stats["intra_route"] >= 1
    score_on = on.items[0]["score"]

    # Dedup OFF → the route double-counts, so c1's fused score is higher.
    monkeypatch.setattr(emod, "QUERY_DEDUP_ENABLED", False)
    off = _make_engine(store, qdrant, pagerank).query("悟空 八戒")
    assert [i["id"] for i in off.items].count("c1") == 1  # seen_ids still dedups items
    assert off.dedup_stats == {}
    score_off = off.items[0]["score"]

    assert score_off > score_on, (
        "without U1 the single route must double-count the chunk's RRF weight"
    )


def test_quoted_messages_collapse_to_one_survivor() -> None:
    """Two chunks (different ids, identical text, same source_type) collapse.

    Simulates a reposted message recalled twice by the dense channel. U2
    keeps one survivor (higher fused score) and records the loser in
    ``merged_ids`` + ``dedup_stats``.
    """
    store = _StubStore(n_ent=0, n_fact=0)  # no entities → dense-only
    qdrant = _StubQdrant(
        {"chunks": [_chunk_hit("c1", _DUP, 0.9), _chunk_hit("c2", _DUP, 0.8)]}
    )

    res = _make_engine(store, qdrant).query("数据同步策略")

    assert len(res.items) == 1
    survivor = res.items[0]
    assert survivor["id"] == "c1"  # higher fused score
    assert survivor["type"] == "message"
    assert survivor.get("merged_ids") == ["c2"]
    assert res.dedup_stats["same_type_content"] == 1
    assert res.dedup_stats["merged"] == [{"survivor": "c1", "dropped": "c2"}]


def test_two_identical_facts_collapse_to_one() -> None:
    """Two facts (different ids) with identical text collapse to one survivor."""
    store = _StubStore(n_ent=0, n_fact=0)
    qdrant = _StubQdrant(
        {"facts": [_fact_hit("f1", _DUP, 0.9), _fact_hit("f2", _DUP, 0.8)]}
    )

    res = _make_engine(store, qdrant).query("数据同步策略")

    assert [i["id"] for i in res.items] == ["f1"]
    assert res.items[0]["type"] == "fact"
    assert res.items[0].get("merged_ids") == ["f2"]
    assert res.dedup_stats["same_type_content"] == 1


def test_fact_and_source_chunk_both_present() -> None:
    """A fact and its source chunk with identical text are BOTH recalled/kept.

    Cross-type suppression never fires, so both survive with no ``merged_ids``.
    """
    shared = "悟空负责数据同步模块的整体设计与上线。"
    store = _StubStore(n_ent=0, n_fact=0)
    qdrant = _StubQdrant(
        {
            "facts": [_fact_hit("f1", shared, 0.9)],
            "chunks": [_chunk_hit("c1", shared, 0.85)],
        }
    )

    res = _make_engine(store, qdrant).query("数据同步")

    by_type = {i["type"]: i["id"] for i in res.items}
    assert by_type == {"fact": "f1", "message": "c1"}
    assert all("merged_ids" not in i for i in res.items)
    assert res.dedup_stats["same_type_content"] == 0


def test_distinct_facts_from_one_chunk_both_present() -> None:
    """Distinct claims (different text) survive even if they share a source chunk."""
    store = _StubStore(n_ent=0, n_fact=0)
    qdrant = _StubQdrant(
        {
            "facts": [
                _fact_hit("f1", "悟空负责数据同步模块。", 0.9),
                _fact_hit("f2", "八戒负责数据同步任务。", 0.8),
            ]
        }
    )

    res = _make_engine(store, qdrant).query("项目分工")

    assert sorted(i["id"] for i in res.items) == ["f1", "f2"]
    assert res.dedup_stats["same_type_content"] == 0


# ── 5. Config gate — KL_QUERY_DEDUP / QUERY_DEDUP_ENABLED ──────────────────────


def test_dedup_disabled_keeps_duplicates_and_empty_stats(monkeypatch) -> None:
    """With the gate off, duplicate inputs survive untouched and stats are empty.

    Same two identical chunks as the reposted-message case: dedup ON collapses
    them (asserted elsewhere); with ``QUERY_DEDUP_ENABLED`` monkeypatched off,
    both must remain and ``dedup_stats`` must be the empty dict.
    """
    monkeypatch.setattr(emod, "QUERY_DEDUP_ENABLED", False)

    store = _StubStore(n_ent=0, n_fact=0)
    qdrant = _StubQdrant(
        {"chunks": [_chunk_hit("c1", _DUP, 0.9), _chunk_hit("c2", _DUP, 0.8)]}
    )

    res = _make_engine(store, qdrant).query("数据同步策略")

    assert sorted(i["id"] for i in res.items) == ["c1", "c2"]
    assert all("merged_ids" not in i for i in res.items)
    assert res.dedup_stats == {}


def test_config_env_gate_parses_truthy_and_falsy(monkeypatch) -> None:
    """``KL_QUERY_DEDUP`` parses the documented on/off spellings at import time.

    Reloads :mod:`kl_graph.config` under each env value and restores the default
    (unset → enabled) at the end so the reloaded module does not leak state.
    """
    try:
        for falsy in ("0", "false", "no", "off", "OFF", "False"):
            monkeypatch.setenv("KL_QUERY_DEDUP", falsy)
            reloaded = importlib.reload(config_mod)
            assert reloaded.cfg.pipelines.query.dedup_enabled is False, falsy

        for truthy in ("1", "true", "yes", "on"):
            monkeypatch.setenv("KL_QUERY_DEDUP", truthy)
            reloaded = importlib.reload(config_mod)
            assert reloaded.cfg.pipelines.query.dedup_enabled is True, truthy

        monkeypatch.delenv("KL_QUERY_DEDUP", raising=False)
        reloaded = importlib.reload(config_mod)
        assert reloaded.cfg.pipelines.query.dedup_enabled is True  # default on
    finally:
        # Restore the process-default binding regardless of assertion outcome.
        monkeypatch.delenv("KL_QUERY_DEDUP", raising=False)
        importlib.reload(config_mod)
