"""Query engine: Phase 1 (instant retrieval) + Phase 2 (LLM synthesis)."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from kl_graph.config import DATA_DIR, GRAPH_DB_PATH, LADYBUG_OPTS, cfg
from kl_graph.ingest.embedder import Embedder
from kl_graph.utils.litellm_config import (
    litellm,
    litellm_base_url,
    provider_api_key,
    provider_model,
)

# Derived constants from OmegaConf config
SQLITE_PATH = DATA_DIR / "knowledge.db"
QDRANT_PATH = str(DATA_DIR / "qdrant_data")
GRAPH_BACKEND = cfg.storage.graph.backend
LLM_PROVIDER = cfg.services.llm_flash.provider
LLM_BASE_URL = litellm_base_url(
    cfg.services.llm_flash.provider, cfg.services.llm_flash.base_url or ""
)
LLM_MODEL = cfg.services.llm_flash.model
CONFIDENCE_HIGH = float(cfg.pipelines.query.confidence.high)
RRF_K = int(cfg.pipelines.query.fusion.rrf_k)
PHASE1_MESSAGE_LIMIT = int(cfg.pipelines.query.phase1_message_limit)
PHASE1_FACT_LIMIT = int(cfg.pipelines.query.phase1_fact_limit)
PHASE1_ENTITY_EXPAND_LIMIT = int(cfg.pipelines.query.phase1_entity_expand_limit)
PHASE2_CONTEXT_LIMIT = int(cfg.pipelines.query.phase2_context_limit)
QUERY_DEDUP_ENABLED = bool(cfg.pipelines.query.dedup_enabled)
FACT_NEAR_DUP_THRESHOLD = float(cfg.pipelines.query.fact_near_dup_threshold)
RERANK_TOP_K = int(cfg.pipelines.query.reranking.top_k)
RERANK_WINDOW = int(cfg.pipelines.query.reranking.window)
from kl_graph.models.types import EntityType
from kl_graph.query import fts
from kl_graph.query.local_search import build_local_context
from kl_graph.query.pagerank import compute_entity_pagerank
from kl_graph.query.query_rewrite import (
    QueryRewrite,
    arewrite_query,
    build_type_pool,
    normalize_query,
    rewrite_query,
)
from kl_graph.query.rerank import Reranker
from kl_graph.storage.base import KnowledgeStore, create_store
from kl_graph.storage.sqlite_store import SQLiteStore
from kl_graph.storage.vector_store import VectorStore, create_vector_store
from kl_graph.utils.helpers import dedup_ranked, rrf

logger = logging.getLogger(__name__)

# PageRank fallback for entities absent from the facts-only projection (they
# participate in no multi-entity fact, so they have no importance score). A tiny
# epsilon rather than 0.0 or 0.5: RRF fuses by list *position*, so this keeps
# off-graph entities' structural hits participating and consistently ordered
# behind on-graph ones, without a flat 0.5 creating large score ties that
# scramble the pre-fusion structural sort. Used identically by 3c and 3d.
_OFF_GRAPH_PR = 1e-4

# Same-type duplicate suppression (U2): two same-type items are the same
# evidence only when their normalized content is byte-identical (md5-equal).
# We deliberately do NOT do fuzzy/near-duplicate matching here — ids are
# UUID5s of normalized content, so "same normalized content" is equivalent to
# "same id", and exact hash equality is O(1) per pair with no false positives.

_WHITESPACE_RUN = re.compile(r"\s+")


def _normalize_for_dedup(text: str) -> str:
    """Normalize item content for duplicate comparison.

    Strips leading/trailing whitespace and collapses internal whitespace runs
    to a single space so that copies differing only in spacing/line breaks
    (a quote re-wrapped, a forward re-indented) compare equal.

    Args:
        text: Raw item content.

    Returns:
        The whitespace-normalized text (never ``None``).
    """
    return _WHITESPACE_RUN.sub(" ", (text or "").strip())


def _is_duplicate(hash_a: str, hash_b: str) -> bool:
    """Decide whether two already-normalized texts are the same evidence.

    Exact md5 equality only — no fuzzy matching. Empty texts never match (a
    blank payload must not collapse unrelated items). Because ids are UUID5s of
    normalized content, hash equality is the id-level notion of "duplicate".

    Args:
        hash_a: md5 hex of the first item's normalized text, or ``""`` if blank.
        hash_b: md5 hex of the second item's normalized text, or ``""`` if blank.

    Returns:
        True if the two items should be treated as the same evidence.
    """
    if not hash_a or not hash_b:
        return False
    return hash_a == hash_b


def _suppress_same_type_duplicates(
    items: list[dict],
) -> tuple[list[dict], int, list[dict]]:
    """Collapse same-type duplicate items, keeping the best-ranked survivor.

    Runs on the resolved items **after** RRF fusion and **before** rerank/cut.
    Items are grouped by their exact ``type`` (``"fact"``, ``"message"``,
    ``"mail"``, ...): different types — including a fact and its source chunk,
    or two chunks from different sources — are never compared. Within a type,
    two items whose normalized content is byte-identical (md5-equal, see
    :func:`_is_duplicate`) are the same evidence; the first (highest fused
    score, since ``items`` arrives in descending fused order) is kept and the
    later one is dropped, its id appended to the survivor's ``merged_ids``.

    Pure CPU: no I/O, no store/embedding calls. Does not touch stored content —
    it only removes whole items from the response list.

    Args:
        items: Resolved items in descending fused-score order.

    Returns:
        ``(kept_items, suppressed_count, merged)`` where ``kept_items`` is in
        the original order, ``suppressed_count`` is the number of dropped
        items, and ``merged`` is ``[{"survivor": id, "dropped": id}, ...]``.
    """
    norms = [_normalize_for_dedup(it.get("content", "")) for it in items]
    hashes = [hashlib.md5(n.encode("utf-8")).hexdigest() if n else "" for n in norms]

    kept: list[dict] = []
    kept_idx: list[int] = []  # indices (into items) of surviving reps
    suppressed_count = 0
    merged: list[dict] = []

    for i, item in enumerate(items):
        survivor = None
        for r in kept_idx:
            if items[r].get("type") != item.get("type"):
                continue
            if _is_duplicate(hashes[i], hashes[r]):
                survivor = items[r]
                break
        if survivor is None:
            kept.append(item)
            kept_idx.append(i)
            continue
        # Duplicate of an already-kept, higher-ranked item: drop it and record
        # the collapse on the survivor.
        survivor.setdefault("merged_ids", []).append(item["id"])
        merged.append({"survivor": survivor["id"], "dropped": item["id"]})
        suppressed_count += 1

    return kept, suppressed_count, merged


def _suppress_near_duplicate_facts(
    items: list[dict], threshold: float = FACT_NEAR_DUP_THRESHOLD
) -> tuple[list[dict], int, list[dict]]:
    """Collapse near-duplicate facts, keeping the highest-confidence survivor.

    Runs after :func:`_suppress_same_type_duplicates` (which removes only
    byte-identical text) and catches the rest: two extractions of the same claim
    that differ in wording, punctuation, or a truncated tail. Similarity is
    ``difflib.SequenceMatcher.ratio()`` over the whitespace-normalized text;
    pairs scoring strictly above ``threshold`` are the same evidence.

    **Facts only.** Chunks are verbatim source text, so two near-identical
    messages (a quote and its reply, a resend) are genuinely distinct evidence
    and must both survive. Non-fact items pass through untouched, keeping their
    original relative order.

    Survivor rule: highest ``confidence``, breaking ties by fused rank (earlier
    in ``items`` wins, so an equally-confident but more relevant fact is kept).
    This deliberately differs from the exact-hash pass, which keeps the
    best-ranked item: for a *reworded* claim the more trustworthy extraction is
    the one to surface, not merely the better-matching phrasing.

    Cost: ``ratio()`` is O(n*m) in text length, so it is guarded by
    ``real_quick_ratio()`` and ``quick_ratio()`` — both cheap upper bounds. A
    pair whose upper bound cannot clear ``threshold`` is rejected without ever
    running the full diff. Comparisons are only ever fact-vs-surviving-fact.

    Args:
        items: Resolved items in descending fused-score order.
        threshold: Minimum ``ratio()`` to treat two facts as duplicates. Values
            ``<= 0`` disable the pass entirely.

    Returns:
        ``(kept_items, suppressed_count, merged)`` where ``kept_items``
        preserves the input order, ``suppressed_count`` is the number of dropped
        facts, and ``merged`` is ``[{"survivor": id, "dropped": id}, ...]``.
    """
    if threshold <= 0.0:
        return items, 0, []

    # (index into items, normalized text) for each surviving fact.
    survivors: list[tuple[int, str]] = []
    dropped: set[int] = set()
    merged: list[dict] = []

    def _conf(item: dict) -> float:
        raw = item.get("confidence")
        return float(raw) if isinstance(raw, (int, float)) else 0.0

    for i, item in enumerate(items):
        if item.get("type") != "fact":
            continue
        text = _normalize_for_dedup(item.get("content", ""))
        if not text:
            # A blank fact must not collapse unrelated items.
            continue

        matcher = SequenceMatcher(None, text, "", autojunk=False)
        hit: int | None = None
        for kept_i, kept_text in survivors:
            matcher.set_seq2(kept_text)
            # Cheap upper bounds first: both are >= ratio(), so failing either
            # proves ratio() cannot clear the threshold.
            if matcher.real_quick_ratio() <= threshold:
                continue
            if matcher.quick_ratio() <= threshold:
                continue
            if matcher.ratio() > threshold:
                hit = kept_i
                break

        if hit is None:
            survivors.append((i, text))
            continue

        # Same claim: keep whichever is more trustworthy. On a confidence tie
        # the earlier (better-fused) item wins, so ordering stays deterministic.
        if _conf(item) > _conf(items[hit]):
            winner, loser = i, hit
            survivors = [(i, text) if s == hit else (s, t) for s, t in survivors]
        else:
            winner, loser = hit, i
        dropped.add(loser)
        items[winner].setdefault("merged_ids", []).append(items[loser]["id"])
        merged.append({"survivor": items[winner]["id"], "dropped": items[loser]["id"]})

    if not dropped:
        return items, 0, []
    kept = [it for i, it in enumerate(items) if i not in dropped]
    return kept, len(dropped), merged


@dataclass
class RetrievalResult:
    """Result from Phase 1 retrieval."""

    items: list[dict] = field(default_factory=list)  # [{type, id, score, content, ...}]
    confidence: float = 0.0
    matched_entities: list[dict] = field(default_factory=list)
    latency_ms: float = 0.0
    q_vec: list[float] = field(
        default_factory=list
    )  # query embedding (reuse downstream)
    # Raw Qdrant ANN hits from steps 3a/3b, kept so a downstream graph walk can
    # seed from them without re-searching the same collections with the same
    # q_vec. Each hit is ``{"score": float, "payload": {...}}``.
    fact_hits: list[dict] = field(default_factory=list)  # facts collection
    chunk_hits: list[dict] = field(default_factory=list)  # chunks collection
    # Recall-dedup accounting for this retrieval (see ``_fuse_and_resolve``):
    # ``{"intra_route": n, "same_type_content": m, "merged": [...]}``. Empty
    # when dedup is disabled (``KL_QUERY_DEDUP=0``).
    dedup_stats: dict = field(default_factory=dict)


@dataclass
class QueryResult:
    """Final query result (Phase 1 or Phase 1 + Phase 2)."""

    answer: str | None = None  # LLM-generated answer (Phase 2)
    items: list[dict] = field(default_factory=list)  # Retrieved items
    phase: int = 1
    latency_ms: float = 0.0
    entities_found: list[str] = field(default_factory=list)
    # Intermediate signals exposed so a caller can seed a graph walk without
    # recomputing the expensive query embedding / LLM entity match (the server's
    # /ask reuses these for its graph walk). In-process only; the server does
    # not serialize them in the HTTP response.
    matched_entities: list[dict] = field(
        default_factory=list
    )  # [{id, name, type, sim}]
    q_vec: list[float] = field(default_factory=list)  # query embedding
    # Recall-dedup accounting, threaded up from Phase 1 (see
    # ``RetrievalResult.dedup_stats``). Empty when dedup is disabled.
    dedup_stats: dict = field(default_factory=dict)
    # Raw Qdrant ANN hits from Phase 1 (facts / chunks collections), passed
    # through so /ask's graph walk can seed from them without re-searching.
    fact_hits: list[dict] = field(default_factory=list)
    chunk_hits: list[dict] = field(default_factory=list)


class QueryEngine:
    """Hybrid query engine with Phase 1 (instant) and Phase 2 (LLM synthesis)."""

    @property
    def _conn(self):
        """The calling thread's SQLite connection (never cached).

        ``_fuse_and_resolve`` runs under ``asyncio.to_thread``; resolving the
        connection live ensures each worker thread uses its own thread-local
        handle instead of sharing the startup thread's connection (race).
        """
        return self.store.sql_conn

    def __init__(
        self,
        sqlite_path=SQLITE_PATH,
        qdrant_path=QDRANT_PATH,
        sqlite: SQLiteStore | None = None,
        qdrant: VectorStore | None = None,
        pagerank: dict | None = None,
        store: KnowledgeStore | None = None,
    ):
        # Accept already-open stores (the server injects its warm store/Qdrant
        # so we don't double-open — Qdrant local mode locks a path to one
        # client). Resolution order for the graph store:
        #   1. explicit ``store`` (the configured KnowledgeStore — ladybug today);
        #   2. explicit ``sqlite`` (legacy callers / tests that inject a SQLite
        #      store directly);
        #   3. otherwise open the configured backend from paths.
        # ``self.store`` is the single edge/content authority. On the ladybug
        # backend its edges live in LadybugDB while content/FTS tables share the
        # injected SQLite connection (``store.sql_conn``) — so edge-derived reads
        # MUST go through the store, never a raw SQLite ``edges`` JOIN (that
        # table is empty on ladybug). ``self.sqlite`` is kept as a back-compat
        # alias for the content store used by callers' stats/printing.
        if store is not None:
            self.store = store
        elif sqlite is not None:
            self.store = sqlite
        else:
            self.store = create_store(
                backend=GRAPH_BACKEND,
                db_path=sqlite_path,
                **(
                    {"ladybug_path": GRAPH_DB_PATH, **LADYBUG_OPTS}
                    if GRAPH_BACKEND == "ladybug"
                    else {}
                ),
            )
        self.sqlite = self.store  # back-compat alias (content reads + stats)
        vector_backend = str(cfg.storage.vector.backend)
        self.qdrant = (
            qdrant
            if qdrant is not None
            else create_vector_store(
                vector_backend,
                data_dir=DATA_DIR,
                embedding_dim=int(cfg.services.embedding.dim),
                path=qdrant_path if vector_backend == "qdrant" else None,
            )
        )
        qemb_cfg = cfg.pipelines.query.embedding
        self.embedder = Embedder(
            max_retries=qemb_cfg.max_retries,
            timeout=qemb_cfg.timeout,
        )
        # Don't close stores we didn't open (the server owns injected ones).
        self._owns_stores = store is None and sqlite is None and qdrant is None

        # SQLite connection for backend-agnostic content reads (FTS mirror,
        # type pool). Present on every KnowledgeStore via the ``sql_conn``
        # property; on ladybug it is the same shared connection the store uses.
        # NOTE: resolved live via the ``_conn`` property (below) rather than
        # cached, because ``_fuse_and_resolve`` runs under ``asyncio.to_thread``
        # and each worker thread must use its own thread-local connection.

        # Facts-only entity-importance prior for sim x pagerank structural
        # ranking (Phase 1). Built once at init from the current graph, or
        # reused from the caller (the server already computes it at startup).
        # Reads edge endpoints via the store (backend-agnostic), NOT a raw
        # SQLite ``edges`` JOIN.
        self.pagerank = (
            pagerank if pagerank is not None else compute_entity_pagerank(self.store)
        )

        # Corpus-derived type pool for the LLM query-rewrite prompt (Phase 2).
        # Built once at init, like the PageRank prior; refresh by restarting.
        self.type_pool = build_type_pool(self.store)

        # Sparse (BM25) keyword channel via SQLite FTS5 + jieba. Built once at
        # init (mirror of messages/facts); disabled gracefully if FTS5 or jieba
        # is unavailable.
        self.fts_enabled = fts.build_fts_index(self._conn)

        # Opt-in cross-encoder reranker over the fused candidates. Passthrough
        # (RRF order preserved) unless KL_RERANK_BASE_URL + KL_RERANK_MODEL set.
        self.reranker = Reranker()

        # LLM client for Phase 2. The provider controls LiteLLM routing.
        self.api_key = provider_api_key(LLM_PROVIDER)
        self.llm_base_url = LLM_BASE_URL
        self.llm_model = provider_model(LLM_PROVIDER, LLM_MODEL)

    def query(
        self,
        text: str,
        force_phase2: bool = False,
        query_rewrite: QueryRewrite | None = None,
    ) -> QueryResult:
        """Run a query through Phase 1, optionally escalating to Phase 2.

        Synchronous entry point (used by ``scripts/query.py`` and tests). The
        server uses the async :meth:`aquery` twin so it can serve requests
        concurrently.

        Args:
            text: Natural language query
            force_phase2: If True, always run Phase 2 synthesis
            query_rewrite: Caller-supplied retrieval intent. When present, skip
                the rewrite LLM and only vector-resolve its entity mentions.
        """
        t0 = time.time()

        # Phase 1: instant retrieval
        phase1 = self._phase1(text, query_rewrite=query_rewrite)

        # Phase 2 (LLM synthesis) runs only when explicitly requested.
        needs_phase2 = force_phase2

        if needs_phase2:
            # Build local context from phase-1 recall (GraphRAG-style).
            local_ctx = build_local_context(
                self.store,
                phase1.matched_entities,
                phase1.chunk_hits,
                phase1.fact_hits,
            )
            answer = self._phase2(text, phase1, local_context=local_ctx.context_text)
            latency = (time.time() - t0) * 1000
            return QueryResult(
                answer=answer,
                items=phase1.items,
                phase=2,
                latency_ms=latency,
                entities_found=[e["name"] for e in phase1.matched_entities],
                matched_entities=phase1.matched_entities,
                q_vec=phase1.q_vec,
                fact_hits=phase1.fact_hits,
                chunk_hits=phase1.chunk_hits,
                dedup_stats=phase1.dedup_stats,
            )
        else:
            latency = (time.time() - t0) * 1000
            return QueryResult(
                items=phase1.items,
                phase=1,
                latency_ms=latency,
                entities_found=[e["name"] for e in phase1.matched_entities],
                matched_entities=phase1.matched_entities,
                q_vec=phase1.q_vec,
                fact_hits=phase1.fact_hits,
                chunk_hits=phase1.chunk_hits,
                dedup_stats=phase1.dedup_stats,
            )

    async def aquery(
        self,
        text: str,
        force_phase2: bool = False,
        query_rewrite: QueryRewrite | None = None,
    ) -> QueryResult:
        """Async twin of :meth:`query` (server path).

        Awaits the async Phase 1 (network layers freed, local work offloaded)
        and, when requested, the async Phase 2 synthesis. Produces a
        byte-for-byte identical :class:`QueryResult` to :meth:`query`; the only
        difference is that it yields the event loop at every I/O boundary, so the
        server can serve other requests concurrently.
        """
        t0 = time.time()

        phase1 = await self._aphase1(text, query_rewrite=query_rewrite)

        needs_phase2 = force_phase2

        if needs_phase2:
            # Build local context from phase-1 recall (GraphRAG-style).
            # Offload blocking work to thread (store I/O + tokenization).
            local_ctx = await asyncio.to_thread(
                build_local_context,
                self.store,
                phase1.matched_entities,
                phase1.chunk_hits,
                phase1.fact_hits,
            )
            answer = await self._aphase2(
                text, phase1, local_context=local_ctx.context_text
            )
            latency = (time.time() - t0) * 1000
            return QueryResult(
                answer=answer,
                items=phase1.items,
                phase=2,
                latency_ms=latency,
                entities_found=[e["name"] for e in phase1.matched_entities],
                matched_entities=phase1.matched_entities,
                q_vec=phase1.q_vec,
                fact_hits=phase1.fact_hits,
                chunk_hits=phase1.chunk_hits,
                dedup_stats=phase1.dedup_stats,
            )
        else:
            latency = (time.time() - t0) * 1000
            return QueryResult(
                items=phase1.items,
                phase=1,
                latency_ms=latency,
                entities_found=[e["name"] for e in phase1.matched_entities],
                matched_entities=phase1.matched_entities,
                q_vec=phase1.q_vec,
                fact_hits=phase1.fact_hits,
                chunk_hits=phase1.chunk_hits,
                dedup_stats=phase1.dedup_stats,
            )

    def _match_entities(self, query: str) -> tuple[list[dict], object | None]:
        """Find entities relevant to the query, each with a similarity score.

        Phase 2: run the LLM query rewrite, then vector-match the extracted
        entity mentions against the ``entities`` collection so each match carries
        a real ``sim``. Each rewrite keyword is embedded on its own
        (``embed_one(kw)``) — the whole-query ``q_vec`` is deliberately not used
        here (keyword→entity, not query→entity). On any failure (LLM/parse/embed),
        degrade to the legacy substring matcher, assigning those a neutral ``sim``
        of 1.0.

        Returns ``(matched, rewrite)`` where ``matched`` is a list of
        ``{id, name, type, sim}`` dicts and ``rewrite`` is the parsed
        :class:`QueryRewrite` (or ``None`` on the substring path). The rewrite is
        RETURNED, not stored on ``self`` — the engine is a single shared instance
        and many ``query()`` coroutines interleave on it, so per-query state on
        ``self`` would cross-contaminate. The caller threads it into scoring.
        """
        # If the LLM-extracted graph is not built, the rewrite would match
        # against an empty entities collection: skip it and use substring only.
        # Checked live (not cached at init) since the DB may be populated mid-
        # lifetime by a concurrent ingestion run.
        if not (self.store.count_entities() > 0 and self.store.count_facts() > 0):
            return self._substring_entities(query), None

        try:
            rw = rewrite_query(
                self.llm_model,
                query,
                self.type_pool,
                api_base=self.llm_base_url,
                api_key=self.api_key,
            )
            return self._match_rewrite_entities(query, rw), rw
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Query rewrite failed, falling back to substring: {e}")

        # Fallback: legacy substring matching, neutral sim.
        return self._substring_entities(query), None

    def _substring_entities(self, query: str) -> list[dict]:
        """Legacy substring entity match with a neutral ``sim`` of 1.0.

        Used both as the LLM-rewrite fallback and when the graph is not built.
        """
        return [
            {"id": e.id, "name": e.name, "type": e.entity_type.value, "sim": 1.0}
            for e in self.store.search_entities_by_name(query, limit=5)
        ]

    def _match_rewrite_entities(self, query: str, rewrite: QueryRewrite) -> list[dict]:
        """Vector-resolve a supplied intent without invoking the rewrite LLM."""
        try:
            matched: dict[str, dict] = {}
            for keyword in rewrite.entities_from_query:
                keyword_vec = self.embedder.embed_one(keyword)
                hits = self.qdrant.search(
                    "entities", keyword_vec, limit=3, score_threshold=0.3
                )
                for hit in hits:
                    payload = hit["payload"]
                    entity_id = payload["entity_id"]
                    if (
                        entity_id not in matched
                        or hit["score"] > matched[entity_id]["sim"]
                    ):
                        matched[entity_id] = {
                            "id": entity_id,
                            "name": payload.get("name", ""),
                            "type": payload.get("entity_type", ""),
                            "sim": hit["score"],
                        }
            return list(matched.values()) or self._substring_entities(query)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Supplied query intent could not be resolved; using substring: %s", e
            )
            return self._substring_entities(query)

    async def _amatch_entities(self, query: str) -> tuple[list[dict], object | None]:
        """Async twin of :meth:`_match_entities`.

        ``await``s the rewrite LLM call (`arewrite_query`) and each keyword
        embedding (`aembed_one`), and offloads the per-keyword local-Qdrant
        search with ``asyncio.to_thread``. Same return contract
        ``(matched, rewrite)`` and same substring fallbacks as the sync version.
        """
        # count_* are cheap local SQLite reads; offload to avoid touching the
        # store from the loop thread concurrently with a threaded fuse.
        n_ent, n_fact = await asyncio.to_thread(
            lambda: (self.store.count_entities(), self.store.count_facts())
        )
        if not (n_ent > 0 and n_fact > 0):
            return await asyncio.to_thread(self._substring_entities, query), None

        try:
            rw = await arewrite_query(
                self.llm_model,
                query,
                self.type_pool,
                api_base=self.llm_base_url,
                api_key=self.api_key,
            )
            return await self._amatch_rewrite_entities(query, rw), rw
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Query rewrite failed, falling back to substring: {e}")

        return await asyncio.to_thread(self._substring_entities, query), None

    async def _amatch_rewrite_entities(
        self, query: str, rewrite: QueryRewrite
    ) -> list[dict]:
        """Async vector resolution for caller-supplied retrieval intent."""
        try:
            matched: dict[str, dict] = {}
            for keyword in rewrite.entities_from_query:
                keyword_vec = await self.embedder.aembed_one(keyword)
                hits = await asyncio.to_thread(
                    lambda v=keyword_vec: self.qdrant.search(
                        "entities", v, limit=3, score_threshold=0.3
                    )
                )
                for hit in hits:
                    payload = hit["payload"]
                    entity_id = payload["entity_id"]
                    if (
                        entity_id not in matched
                        or hit["score"] > matched[entity_id]["sim"]
                    ):
                        matched[entity_id] = {
                            "id": entity_id,
                            "name": payload.get("name", ""),
                            "type": payload.get("entity_type", ""),
                            "sim": hit["score"],
                        }
            if matched:
                return list(matched.values())
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Supplied query intent could not be resolved; using substring: %s", e
            )
        return await asyncio.to_thread(self._substring_entities, query)

    def _phase1(
        self, query: str, query_rewrite: QueryRewrite | None = None
    ) -> RetrievalResult:
        """Phase 1 (sync): vector ANN + structural expansion + RRF fusion.

        Gathers the I/O (embed, entity match, two Qdrant ANN searches) then hands
        off to the shared, side-effect-light :meth:`_fuse_and_resolve`. The async
        twin :meth:`_aphase1` does the same gather with ``await``/``to_thread``
        and calls the same fuser, so both paths produce identical results.
        """
        t0 = time.time()

        # 0. Normalize the query (full-width->half-width, case fold, eng<->zh
        #    spacing) so cosmetic variants embed to the same vector.
        query = normalize_query(query)

        # 1. Embed query
        q_vec = self.embedder.embed_one(query)

        # 2. Entity matching (LLM rewrite -> vector match; substring fallback).
        #    Returns the rewrite as a value (not on self) so the engine is
        #    reentrant under concurrency.
        if query_rewrite is None:
            matched, rw = self._match_entities(query)
        else:
            matched = self._match_rewrite_entities(query, query_rewrite)
            rw = query_rewrite

        # 3a/3b. Vector ANN on chunks + facts.
        msg_results = self.qdrant.search("chunks", q_vec, limit=PHASE1_MESSAGE_LIMIT)
        fact_results = self.qdrant.search("facts", q_vec, limit=PHASE1_FACT_LIMIT)

        return self._fuse_and_resolve(
            query, q_vec, matched, rw, msg_results, fact_results, t0
        )

    async def _aphase1(
        self, query: str, query_rewrite: QueryRewrite | None = None
    ) -> RetrievalResult:
        """Phase 1 (async): same as :meth:`_phase1` but frees the event loop.

        The two network layers are ``await``ed (query embed + the LLM entity
        match inside :meth:`_amatch_entities`); the local-Qdrant ANN searches and
        the CPU-bound fusion are offloaded with ``asyncio.to_thread`` (embedded
        local Qdrant has no socket to await on). Result is identical to the sync
        path.
        """
        t0 = time.time()
        query = normalize_query(query)

        # 1. Embed query (network -> await).
        q_vec = await self.embedder.aembed_one(query)

        # 2. Entity matching (network LLM rewrite awaited; Qdrant offloaded).
        if query_rewrite is None:
            matched, rw = await self._amatch_entities(query)
        else:
            matched = await self._amatch_rewrite_entities(query, query_rewrite)
            rw = query_rewrite

        # 3a/3b. Vector ANN on chunks + facts (local Qdrant -> offload).
        msg_results = await asyncio.to_thread(
            self.qdrant.search, "chunks", q_vec, PHASE1_MESSAGE_LIMIT
        )
        fact_results = await asyncio.to_thread(
            self.qdrant.search, "facts", q_vec, PHASE1_FACT_LIMIT
        )

        # 4-6. Fusion + resolution is CPU + local-store reads -> offload so the
        # loop stays free for other asks.
        return await asyncio.to_thread(
            self._fuse_and_resolve,
            query,
            q_vec,
            matched,
            rw,
            msg_results,
            fact_results,
            t0,
        )

    def _fuse_and_resolve(
        self,
        query: str,
        q_vec: list[float],
        matched: list[dict],
        rw: object | None,
        msg_results: list[dict],
        fact_results: list[dict],
        t0: float,
    ) -> RetrievalResult:
        """Steps 3c-6: structural expansion, RRF fusion, resolve, rerank, cut.

        Shared by the sync and async Phase-1 paths. Pure of network I/O (only
        local store + FTS reads + CPU), so it is safe to run on a worker thread.
        ``rw`` is the per-query :class:`QueryRewrite` (or ``None``), passed in
        rather than read from ``self`` so concurrent queries don't collide.
        """
        # matched carries {id, name, type, sim}; keep the full dicts (incl. sim)
        # for downstream reuse (the server's depth-1 graph view needs sim).
        entity_dicts = matched
        fact_type_boost = set(rw.fact_type_keywords) if rw else set()
        # Rewrite returns EntityType *names* (e.g. "PERSON"); entity payloads
        # store EntityType *values* (e.g. "Person"). Normalize to values.
        entity_type_boost: set[str] = set()
        if rw:
            for kw in rw.entity_type_keywords:
                try:
                    entity_type_boost.add(EntityType[kw].value)
                except KeyError:
                    entity_type_boost.add(kw)

        msg_ranked = [(r["payload"]["chunk_id"], r["score"]) for r in msg_results]
        fact_ranked = [(r["payload"]["fact_id"], r["score"]) for r in fact_results]

        # 3c. Structural expansion: entity -> messages, scored sim x pagerank.
        # sim comes from query->entity vector match (Phase 2); pagerank is the
        # importance prior (Phase 0). Entities absent from the prior fall back to
        # ``_OFF_GRAPH_PR`` rather than dropping out. Edge reads go through the
        # configured store (backend-agnostic): on ladybug they resolve MENTIONS
        # via LadybugDB, not the empty SQLite ``edges`` table.
        structural_msgs = []
        for ent in matched:
            ent_pr = self.pagerank.get(ent["id"], _OFF_GRAPH_PR)
            # Boost entities whose type matches the query's answer-type intent.
            type_mult = 2.0 if ent["type"] in entity_type_boost else 1.0
            score = ent["sim"] * ent_pr * type_mult
            ent_msgs = self.store.get_messages_for_entity(
                ent["id"], limit=PHASE1_ENTITY_EXPAND_LIMIT
            )
            for m in ent_msgs:
                structural_msgs.append((m.id, score))

        # 3d. Structural expansion: entity -> facts, scored sim x pagerank x
        # fact.confidence, with a boost when the fact's type matches intent.
        # Same store-routed, backend-agnostic edge read (ABOUT via LadybugDB on
        # ladybug) and the same ``_OFF_GRAPH_PR`` fallback as 3c.
        structural_facts = []
        for ent in matched:
            ent_pr = self.pagerank.get(ent["id"], _OFF_GRAPH_PR)
            type_mult = 2.0 if ent["type"] in entity_type_boost else 1.0
            base = ent["sim"] * ent_pr * type_mult
            ent_facts = self.store.get_facts_for_entity(ent["id"], limit=10)
            for f in ent_facts:
                fact_mult = 2.0 if f.fact_type.value in fact_type_boost else 1.0
                structural_facts.append((f.id, base * f.confidence * fact_mult))

        # 3e. Sparse (BM25) keyword channel over messages + facts. Catches exact
        # rare tokens (codes, names) that dense embeddings fuzz over. Already
        # rank-ordered by bm25(), so no re-sort needed for RRF.
        sparse_msgs: list[tuple[str, float]] = []
        sparse_facts: list[tuple[str, float]] = []
        if self.fts_enabled:
            sparse_msgs = fts.search_messages(
                self._conn, query, limit=PHASE1_MESSAGE_LIMIT
            )
            sparse_facts = fts.search_facts(self._conn, query, limit=PHASE1_FACT_LIMIT)

        # 4. RRF fusion
        # RRF ranks by list position (not score value), so sort the structural
        # lists by their sim x pagerank score first — otherwise the PageRank
        # weighting would not influence the fused ranking at all.
        structural_msgs.sort(key=lambda x: x[1], reverse=True)
        structural_facts.sort(key=lambda x: x[1], reverse=True)
        all_lists = [
            msg_ranked,
            fact_ranked,
            structural_msgs,
            structural_facts,
            sparse_msgs,
            sparse_facts,
        ]
        # U1: intra-route dedup before RRF. A single route can surface the same
        # id twice (e.g. structural expansion emits a chunk once per matched
        # entity it MENTIONS); left as-is that route double-contributes
        # ``1/(k+rank)``. Collapse repeats to their best rank *within* each list
        # only — never across lists (cross-list presence is the corroboration
        # signal RRF harvests). Gated by ``KL_QUERY_DEDUP``.
        dedup_stats: dict = {}
        if QUERY_DEDUP_ENABLED:
            deduped_lists = [dedup_ranked(lst) for lst in all_lists]
            intra_route = sum(
                len(orig) - len(ded)
                for orig, ded in zip(all_lists, deduped_lists, strict=True)
            )
            all_lists = deduped_lists
            dedup_stats = {
                "intra_route": intra_route,
                "same_type_content": 0,
                "merged": [],
            }
        # Filter empty lists
        all_lists = [lst for lst in all_lists if lst]
        if not all_lists:
            return RetrievalResult(
                latency_ms=(time.time() - t0) * 1000, dedup_stats=dedup_stats
            )

        fused = rrf(all_lists, k=RRF_K)

        # 5. Resolve fused IDs to content. Resolve a larger window than the
        # final cut so the optional reranker can reorder within it.
        items = []
        seen_ids = set()
        for item_id, score in fused[:RERANK_WINDOW]:
            if item_id in seen_ids:
                continue
            seen_ids.add(item_id)

            # Try as fact first (more informative)
            fact_payload = self._find_in_results(fact_results, "fact_id", item_id)
            if fact_payload:
                items.append(
                    {
                        "type": "fact",
                        "id": item_id,
                        "score": score,
                        "content": fact_payload.get("text", ""),
                        "fact_type": fact_payload.get("fact_type", ""),
                        "timestamp": fact_payload.get("timestamp", 0),
                        "confidence": fact_payload.get("confidence", 0.8),
                    }
                )
                continue

            # Try as chunk (message today; pdf/doc/... later)
            msg_payload = self._find_in_results(msg_results, "chunk_id", item_id)
            if msg_payload:
                items.append(
                    {
                        "type": msg_payload.get("source_type", "message"),
                        "id": item_id,
                        "score": score,
                        "content": msg_payload.get("content", ""),
                        "sender": msg_payload.get("sender", ""),
                        "timestamp": msg_payload.get("timestamp", 0),
                    }
                )
                continue

            # Not in the dense payloads: resolve from the store (structural or
            # sparse-only hit). Try fact first (more informative), then message.
            fact = self.store.get_fact(item_id)
            if fact:
                items.append(
                    {
                        "type": "fact",
                        "id": item_id,
                        "score": score,
                        "content": fact.text,
                        "fact_type": fact.fact_type.value,
                        "timestamp": fact.timestamp,
                        "confidence": fact.confidence,
                    }
                )
                continue

            msg = self.store.get_message(item_id)
            if msg:
                items.append(
                    {
                        "type": msg.source_type,
                        "id": item_id,
                        "score": score,
                        # Full content (no ``[:500]``): the dense-payload branch
                        # above returns full content, so truncating only the
                        # SQLite-resolved branch made the SAME chunk render at
                        # two different lengths depending on which channel
                        # surfaced it (and fed a truncated copy into Phase-2).
                        # Phase-2 caps its own prompt budget separately.
                        "content": msg.content,
                        "sender": msg.metadata.get("sender", ""),
                        "timestamp": msg.timestamp,
                    }
                )

        # U2: same-type duplicate suppression, post-fusion and pre-rerank.
        # ``items`` is in descending fused-score order, so keeping the first
        # member of each duplicate cluster == highest fused score (tie-break by
        # fused rank). Collapses reposted content that surfaced as two
        # chunks/facts with byte-identical text; never crosses ``type``
        # boundaries (a fact and its source chunk, or two chunks from different
        # sources, are both kept). Gated by ``KL_QUERY_DEDUP``.
        if QUERY_DEDUP_ENABLED:
            items, suppressed, merged = _suppress_same_type_duplicates(items)
            dedup_stats["same_type_content"] = suppressed
            dedup_stats["merged"] = merged
            # U3: near-duplicate facts (reworded/truncated restatements of one
            # claim), which the byte-identical pass above cannot see. Runs on the
            # already-collapsed list so the O(n*m) diff sees as few facts as
            # possible, and before rerank/cut so a dropped duplicate frees a slot
            # for genuinely new evidence.
            items, fact_suppressed, fact_merged = _suppress_near_duplicate_facts(items)
            dedup_stats["fact_near_dup"] = fact_suppressed
            dedup_stats["merged"] = merged + fact_merged

        # 6. Optional model rerank over the resolved window, then final cut.
        # Gate on the reranker being configured (RAGFlow-style if rerank_mdl);
        # the reranker cuts to ``RERANK_TOP_K`` itself. When it is disabled
        # (the default) apply the SAME cut here, so both callers
        # (``kl_server`` and ``scripts/query.py``) get a consistent top_k
        # contract instead of the full ``RERANK_WINDOW`` window.
        if self.reranker.enabled:
            items = self.reranker.rerank(query, items, top_k=RERANK_TOP_K)
        else:
            items = items[:RERANK_TOP_K]

        # Compute confidence (based on best fact scores)
        fact_items = [i for i in items if i["type"] == "fact"]
        if fact_items:
            confidence = max(i.get("confidence", 0.5) for i in fact_items)
        elif items:
            confidence = 0.4  # only messages, no cached facts
        else:
            confidence = 0.0

        latency = (time.time() - t0) * 1000
        return RetrievalResult(
            items=items,
            confidence=confidence,
            matched_entities=entity_dicts,
            latency_ms=latency,
            q_vec=q_vec,
            fact_hits=fact_results,
            chunk_hits=msg_results,
            dedup_stats=dedup_stats,
        )

    def _phase2_prompt(
        self,
        query: str,
        phase1: RetrievalResult,
        *,
        local_context: str | None = None,
    ) -> tuple[str, str]:
        """Build (system_prompt, user_prompt) for Phase-2 synthesis.

        Shared by the sync and async synthesis paths; pure CPU (no I/O).
        When ``local_context`` is provided, it is prepended as additional
        graph-enriched evidence alongside the Phase-1 fact/message items
        (local context first, then phase-1 evidence). Phase-1 items are
        never dropped regardless of whether local_context is present.
        """
        # Build context from Phase 1 results
        context_parts = []

        if local_context:
            # GraphRAG-style local context: community reports + relationships
            # + chunks assembled by the local search builder.
            context_parts.append(local_context)

        # Facts first (more informative) - always include phase1 evidence
        facts = [i for i in phase1.items if i["type"] == "fact"][:10]
        if facts:
            context_parts.append("=== 已知事实 ===")
            for f in facts:
                conf_label = (
                    "确认" if f.get("confidence", 0) > CONFIDENCE_HIGH else "待验证"
                )
                context_parts.append(
                    f"[{conf_label}] [{f.get('fact_type', '')}] {f['content']}"
                )

        # Chunks as evidence (messages today; pdf/doc/... later)
        messages = [i for i in phase1.items if i["type"] != "fact"][
            :PHASE2_CONTEXT_LIMIT
        ]
        if messages:
            context_parts.append("\n=== 相关消息 ===")
            for m in messages:
                ts = self._format_timestamp(m.get("timestamp", 0))
                context_parts.append(f"[{ts}] {m.get('sender', '?')}: {m['content']}")

        # Entity context
        if phase1.matched_entities:
            context_parts.append("\n=== 匹配实体 ===")
            for e in phase1.matched_entities:
                context_parts.append(f"- {e['name']} ({e['type']})")

        context = "\n".join(context_parts)

        system_prompt = """你是一个知识助手，基于提供的工作消息记录回答问题。
规则：
1. 只使用提供的上下文信息回答，不要编造
2. 如果信息不足，说明缺少什么
3. 引用具体消息作为依据
4. 使用简洁的中文回答"""
        user_prompt = f"问题：{query}\n\n{context}"
        return system_prompt, user_prompt

    def _phase2(
        self,
        query: str,
        phase1: RetrievalResult,
        *,
        local_context: str | None = None,
    ) -> str:
        """Phase 2 (sync): LLM synthesis from retrieved context."""
        system_prompt, user_prompt = self._phase2_prompt(
            query,
            phase1,
            local_context=local_context,
        )
        try:
            resp = litellm.completion(
                model=self.llm_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                api_base=self.llm_base_url,
                api_key=self.api_key,
                max_tokens=1024,
                temperature=0.3,
            )
            return resp.choices[0].message.content
        except Exception as e:  # noqa: BLE001
            return f"[Phase 2 synthesis failed: {e}]"

    async def _aphase2(
        self,
        query: str,
        phase1: RetrievalResult,
        *,
        local_context: str | None = None,
    ) -> str:
        """Phase 2 (async): same synthesis via ``litellm.acompletion``."""
        system_prompt, user_prompt = self._phase2_prompt(
            query,
            phase1,
            local_context=local_context,
        )
        try:
            resp = await litellm.acompletion(
                model=self.llm_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                api_base=self.llm_base_url,
                api_key=self.api_key,
                max_tokens=1024,
                temperature=0.3,
            )
            return resp.choices[0].message.content
        except Exception as e:  # noqa: BLE001
            return f"[Phase 2 synthesis failed: {e}]"

    async def synthesize(
        self,
        query: str,
        recall: RetrievalResult,
        *,
        local_context: str | None = None,
    ) -> str:
        """Run Phase-2 synthesis with optional local context augmentation.

        Exposed so the server can build local context (from the recall
        outputs + the graph walk) and then re-run synthesis with the
        richer evidence set — without re-executing the expensive Phase-1
        recall.

        Args:
            query: The user's query string.
            recall: A :class:`RetrievalResult` from Phase 1.
            local_context: If provided, the assembled local context text
                is prepended as additional graph-enriched evidence before
                the Phase-1 fact/message items. Phase-1 items are always
                included regardless of local_context presence.

        Returns:
            The synthesized answer string.
        """
        return await self._aphase2(query, recall, local_context=local_context)

    def _find_in_results(
        self, results: list[dict], key: str, value: str
    ) -> dict | None:
        """Find a result by payload key match."""
        for r in results:
            if r.get("payload", {}).get(key) == value:
                return r["payload"]
        return None

    def _format_timestamp(self, ts: int) -> str:
        """Format unix ms timestamp to readable string."""
        if not ts:
            return "?"
        import datetime

        dt = datetime.datetime.fromtimestamp(ts / 1000)  # noqa: DTZ006
        return dt.strftime("%m-%d %H:%M")

    def close(self):
        if self._owns_stores:
            self.store.close()
            self.qdrant.close()
