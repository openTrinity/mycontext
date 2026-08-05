"""Query engine: Phase 1 (instant retrieval) + Phase 2 (LLM synthesis)."""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional

import litellm

from kl_graph.config import (
    CONFIDENCE_HIGH,
    CONFIDENCE_LOW,
    LLM_BASE_URL,
    LLM_MODEL,
    PHASE1_ENTITY_EXPAND_LIMIT,
    PHASE1_FACT_LIMIT,
    PHASE1_MESSAGE_LIMIT,
    PHASE2_CONTEXT_LIMIT,
    RERANK_TOP_K,
    RERANK_WINDOW,
    RRF_K,
    QDRANT_PATH,
    SQLITE_PATH,
)
from kl_graph.ingest.embedder import Embedder
from kl_graph.models.types import EdgeType, EntityType, Fact, Message
from kl_graph.query import fts
from kl_graph.query.pagerank import compute_entity_pagerank
from kl_graph.query.query_rewrite import build_type_pool, normalize_query, rewrite_query
from kl_graph.query.rerank import Reranker
from kl_graph.storage.qdrant_store import QdrantStore
from kl_graph.storage.sqlite_store import SQLiteStore
from kl_graph.utils.helpers import rrf

logger = logging.getLogger(__name__)


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


@dataclass
class QueryResult:
    """Final query result (Phase 1 or Phase 1 + Phase 2)."""

    answer: Optional[str] = None  # LLM-generated answer (Phase 2)
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
    # Raw Qdrant ANN hits from Phase 1 (facts / chunks collections), passed
    # through so /ask's graph walk can seed from them without re-searching.
    fact_hits: list[dict] = field(default_factory=list)
    chunk_hits: list[dict] = field(default_factory=list)


class QueryEngine:
    """Hybrid query engine with Phase 1 (instant) and Phase 2 (LLM synthesis)."""

    def __init__(
        self,
        sqlite_path=SQLITE_PATH,
        qdrant_path=QDRANT_PATH,
        sqlite: Optional[SQLiteStore] = None,
        qdrant: Optional[QdrantStore] = None,
        pagerank: Optional[dict] = None,
    ):
        # Accept already-open stores (the server injects its warm SQLite/Qdrant
        # so we don't double-open — Qdrant local mode locks a path to one
        # client). Fall back to opening our own from the paths otherwise.
        self.sqlite = sqlite if sqlite is not None else SQLiteStore(sqlite_path)
        self.qdrant = qdrant if qdrant is not None else QdrantStore(qdrant_path)
        self.embedder = Embedder()
        # Don't close stores we didn't open (the server owns injected ones).
        self._owns_stores = sqlite is None and qdrant is None

        # Facts-only entity-importance prior for sim x pagerank structural
        # ranking (Phase 1). Built once at init from the current graph, or
        # reused from the caller (the server already computes it at startup).
        self.pagerank = (
            pagerank
            if pagerank is not None
            else compute_entity_pagerank(self.sqlite.conn)
        )

        # Corpus-derived type pool for the LLM query-rewrite prompt (Phase 2).
        # Built once at init, like the PageRank prior; refresh by restarting.
        self.type_pool = build_type_pool(self.sqlite)

        # Sparse (BM25) keyword channel via SQLite FTS5 + jieba. Built once at
        # init (mirror of messages/facts); disabled gracefully if FTS5 or jieba
        # is unavailable.
        self.fts_enabled = fts.build_fts_index(self.sqlite.conn)

        # Opt-in cross-encoder reranker over the fused candidates. Passthrough
        # (RRF order preserved) unless KL_RERANK_BASE_URL + KL_RERANK_MODEL set.
        self.reranker = Reranker()

        # LLM client for Phase 2. litellm in Anthropic mode: the model carries
        # the ``anthropic/`` provider prefix and requests hit LLM_BASE_URL's
        # /messages endpoint. Key from ANTHROPIC_AUTH_TOKEN.
        self.api_key = os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
        self.llm_base_url = LLM_BASE_URL
        self.llm_model = f"anthropic/{LLM_MODEL}"

    def query(self, text: str, force_phase2: bool = False) -> QueryResult:
        """Run a query through Phase 1, optionally escalating to Phase 2.

        Args:
            text: Natural language query
            force_phase2: If True, always run Phase 2 synthesis
        """
        t0 = time.time()

        # Phase 1: instant retrieval
        phase1 = self._phase1(text)

        # Decide whether to escalate
        needs_phase2 = force_phase2 or self._should_escalate(text, phase1)

        if needs_phase2:
            answer = self._phase2(text, phase1)
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
            )

    def _match_entities(self, query: str, q_vec: list[float]) -> list[dict]:
        """Find entities relevant to the query, each with a similarity score.

        Phase 2: run the LLM query rewrite, then vector-match the extracted
        entity mentions against the ``entities`` collection so each match carries
        a real ``sim``. On any failure (LLM/parse/embed), degrade to the legacy
        substring matcher, assigning those a neutral ``sim`` of 1.0.

        Returns a list of dicts: ``{id, name, type, sim}`` and the parsed
        ``fact_type_keywords`` / ``entity_type_keywords`` via ``self._last_rewrite``.
        """
        # Reset per-query rewrite signal (used for type boosting downstream).
        self._last_rewrite = None

        # If the LLM-extracted graph is not built, the rewrite would match
        # against an empty entities collection: skip it and use substring only.
        # Checked live (not cached at init) since the DB may be populated mid-
        # lifetime by a concurrent ingestion run.
        if not (self.sqlite.count_entities() > 0 and self.sqlite.count_facts() > 0):
            return self._substring_entities(query)

        try:
            rw = rewrite_query(
                self.llm_model,
                query,
                self.type_pool,
                api_base=self.llm_base_url,
                api_key=self.api_key,
            )
            self._last_rewrite = rw

            matched: dict[str, dict] = {}
            for kw in rw.entities_from_query:
                kw_vec = self.embedder.embed_one(kw)
                hits = self.qdrant.search(
                    "entities", kw_vec, limit=3, score_threshold=0.3
                )
                for h in hits:
                    p = h["payload"]
                    eid = p["entity_id"]
                    # Keep the best sim if an entity matches multiple keywords.
                    if eid not in matched or h["score"] > matched[eid]["sim"]:
                        matched[eid] = {
                            "id": eid,
                            "name": p.get("name", ""),
                            "type": p.get("entity_type", ""),
                            "sim": h["score"],
                        }
            if matched:
                return list(matched.values())
            # LLM ran but found no vector matches: fall through to substring.
        except Exception as e:
            logger.warning(f"Query rewrite failed, falling back to substring: {e}")

        # Fallback: legacy substring matching, neutral sim.
        return self._substring_entities(query)

    def _substring_entities(self, query: str) -> list[dict]:
        """Legacy substring entity match with a neutral ``sim`` of 1.0.

        Used both as the LLM-rewrite fallback and when the graph is not built.
        """
        return [
            {"id": e.id, "name": e.name, "type": e.entity_type.value, "sim": 1.0}
            for e in self.sqlite.search_entities_by_name(query, limit=5)
        ]

    def _phase1(self, query: str) -> RetrievalResult:
        """Phase 1: vector ANN + structural expansion + RRF fusion."""
        t0 = time.time()

        # 0. Normalize the query (full-width->half-width, case fold, eng<->zh
        #    spacing) so cosmetic variants embed to the same vector.
        query = normalize_query(query)

        # 1. Embed query
        q_vec = self.embedder.embed_one(query)

        # 2. Entity matching (LLM rewrite -> vector match; substring fallback)
        matched = self._match_entities(query, q_vec)
        # matched carries {id, name, type, sim}; keep the full dicts (incl. sim)
        # for downstream reuse (the server's depth-1 graph view needs sim).
        entity_dicts = matched
        rw = getattr(self, "_last_rewrite", None)
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

        # 3. Parallel retrieval (synchronous for simplicity in MVP)
        # 3a. Vector ANN on chunks (messages today; pdf/doc/... later)
        msg_results = self.qdrant.search("chunks", q_vec, limit=PHASE1_MESSAGE_LIMIT)
        msg_ranked = [(r["payload"]["chunk_id"], r["score"]) for r in msg_results]

        # 3b. Vector ANN on facts
        fact_results = self.qdrant.search("facts", q_vec, limit=PHASE1_FACT_LIMIT)
        fact_ranked = [(r["payload"]["fact_id"], r["score"]) for r in fact_results]

        # 3c. Structural expansion: entity -> messages, scored sim x pagerank.
        # sim comes from query->entity vector match (Phase 2); pagerank is the
        # importance prior (Phase 0). Entities absent from the prior fall back to
        # a flat 0.5 pagerank rather than dropping out.
        structural_msgs = []
        for ent in matched:
            ent_pr = self.pagerank.get(ent["id"], 0.5)
            # Boost entities whose type matches the query's answer-type intent.
            type_mult = 2.0 if ent["type"] in entity_type_boost else 1.0
            score = ent["sim"] * ent_pr * type_mult
            ent_msgs = self.sqlite.get_messages_for_entity(
                ent["id"], limit=PHASE1_ENTITY_EXPAND_LIMIT
            )
            for m in ent_msgs:
                structural_msgs.append((m.id, score))

        # 3d. Structural expansion: entity -> facts, scored sim x pagerank x
        # fact.confidence, with a boost when the fact's type matches intent.
        structural_facts = []
        for ent in matched:
            ent_pr = self.pagerank.get(ent["id"], 0.0)
            type_mult = 2.0 if ent["type"] in entity_type_boost else 1.0
            base = ent["sim"] * ent_pr * type_mult
            ent_facts = self.sqlite.get_facts_for_entity(ent["id"], limit=10)
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
                self.sqlite.conn, query, limit=PHASE1_MESSAGE_LIMIT
            )
            sparse_facts = fts.search_facts(
                self.sqlite.conn, query, limit=PHASE1_FACT_LIMIT
            )

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
        # Filter empty lists
        all_lists = [lst for lst in all_lists if lst]
        if not all_lists:
            return RetrievalResult(latency_ms=(time.time() - t0) * 1000)

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

            # Not in the dense payloads: resolve from SQLite (structural or
            # sparse-only hit). Try fact first (more informative), then message.
            fact = self.sqlite.get_fact(item_id)
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

            msg = self.sqlite.get_message(item_id)
            if msg:
                items.append(
                    {
                        "type": msg.source_type,
                        "id": item_id,
                        "score": score,
                        "content": msg.content[:500],
                        "sender": msg.sender,
                        "timestamp": msg.timestamp,
                    }
                )

        # 6. Optional model rerank over the resolved window, then final cut.
        # Gate on the reranker being configured (RAGFlow-style if rerank_mdl);
        # otherwise keep RRF order and just cut to the top_k.
        if self.reranker.enabled:
            items = self.reranker.rerank(query, items, top_k=RERANK_TOP_K)

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
        )

    def _should_escalate(self, query: str, phase1: RetrievalResult) -> bool:
        """Decide if Phase 2 is needed."""
        # No results at all
        if not phase1.items:
            return True

        # Low confidence
        if phase1.confidence < CONFIDENCE_LOW:
            return True

        # Synthesis keywords in query
        synthesis_keywords = ["详细", "展开", "什么方案", "什么情况", "总结", "概括"]
        if any(kw in query for kw in synthesis_keywords):
            return True

        return False

    def _phase2(self, query: str, phase1: RetrievalResult) -> str:
        """Phase 2: LLM synthesis from retrieved context."""
        # Build context from Phase 1 results
        context_parts = []

        # Facts first (more informative)
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

        # LLM call
        system_prompt = """你是一个知识助手，基于提供的工作消息记录回答问题。
规则：
1. 只使用提供的上下文信息回答，不要编造
2. 如果信息不足，说明缺少什么
3. 引用具体消息作为依据
4. 使用简洁的中文回答"""

        user_prompt = f"问题：{query}\n\n{context}"

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
        except Exception as e:
            return f"[Phase 2 synthesis failed: {e}]"

    def _find_in_results(
        self, results: list[dict], key: str, value: str
    ) -> Optional[dict]:
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

        dt = datetime.datetime.fromtimestamp(ts / 1000)
        return dt.strftime("%m-%d %H:%M")

    def close(self):
        if self._owns_stores:
            self.sqlite.close()
            self.qdrant.close()
