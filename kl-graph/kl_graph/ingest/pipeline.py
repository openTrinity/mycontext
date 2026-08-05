"""Main ingestion pipeline orchestrator (v2: LLM extraction).

Two-phase design:
  Phase A: Chunking (load + persist + embed; no LLM)
    - Loads every source (chat + non-chat) into unified ``Chunk``s
    - Persists them to SQLite and embeds them into Qdrant ``chunks``
    - At end-of-A dense + BM25 retrieval over all sources is usable

  Phase B: Extraction + graph build (LLM; replayable from cache)
    - Calls qwen3.7-plus for entity+fact extraction per chunk (cached)
    - Builds entities, facts, edges in SQLite; embeds entity/fact vectors

You can re-run Phase B with different configurations without
re-running its extraction (the expensive LLM calls are cached).
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Optional

from qdrant_client.models import PointStruct
from tqdm import tqdm

from kl_graph.config import (
    EMBEDDING_DIM,
    CHAT_DIR,
    QDRANT_PATH,
    SQLITE_PATH,
    DATA_DIR,
    DWS_EXPORT_DIR,
    MAIL_DIR,
    WIKI_DIR,
    GENERIC_SOURCES,
)
from kl_graph.ingest.embedder import Embedder
from kl_graph.ingest.llm_extractor import LLMExtractor, needs_extraction
from kl_graph.ingest.loaders import (
    load_all_messages,
    load_generic,
    load_mail,
    load_minutes,
    load_wiki,
)
from kl_graph.models.types import (
    Chunk,
    Edge,
    EdgeType,
    Entity,
    EntityType,
    Fact,
    FactType,
    Message,
)
from kl_graph.storage.qdrant_store import QdrantStore
from kl_graph.storage.sqlite_store import SQLiteStore


# ─── Extraction Cache Path ───────────────────────────────────────────────

EXTRACTION_CACHE_DIR = DATA_DIR / "extraction_cache"


# ─── Normalization helpers ───────────────────────────────────────────────


def normalize_entity_name(name: str) -> str:
    """Normalize entity name for dedup (exact match)."""
    return name.strip().lower()


def entity_id_from_name(name: str) -> str:
    """Deterministic ID from normalized entity name."""
    norm = normalize_entity_name(name)
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"entity:{norm}"))


VALID_ENTITY_TYPES = {t.value for t in EntityType}
VALID_FACT_TYPES = {t.value for t in FactType}


def map_entity_type(raw_type: str) -> EntityType:
    """Map LLM output entity type to our enum."""
    raw = raw_type.strip().capitalize()
    if raw in VALID_ENTITY_TYPES:
        return EntityType(raw)
    # Common mappings
    mapping = {
        "Team": EntityType.ORGANIZATION,
        "Concept": EntityType.UNKNOWN,
        "Event": EntityType.UNKNOWN,
        "Tool": EntityType.SYSTEM,
        "Service": EntityType.SYSTEM,
        "Platform": EntityType.SYSTEM,
        "Product": EntityType.SYSTEM,
        "Company": EntityType.ORGANIZATION,
        "Department": EntityType.ORGANIZATION,
        "Group": EntityType.ORGANIZATION,
    }
    return mapping.get(raw, EntityType.UNKNOWN)


def map_fact_type(raw_type: str) -> FactType:
    """Map LLM output fact type to our enum."""
    raw = raw_type.strip().upper()
    if raw in VALID_FACT_TYPES:
        return FactType(raw)
    # Common mappings
    mapping = {
        "OPINION": FactType.GENERAL,
        "INFORMATION": FactType.GENERAL,
        "FACT": FactType.GENERAL,
        "TASK": FactType.DELEGATE,
        "ASSIGNMENT": FactType.DELEGATE,
        "UPDATE": FactType.STATUS,
        "PROGRESS": FactType.STATUS,
        "PLAN": FactType.DECISION,
    }
    return mapping.get(raw, FactType.GENERAL)


def _participants_of(chunk: Chunk) -> list[str]:
    """Author/participant names for any chunk, for Person-entity attribution.

    Chat messages contribute their ``sender``; non-chat sources contribute the
    people recorded in their metadata (mail from/to/cc, calendar
    organizer/attendees, minutes speakers, report creator). Names are returned
    as plain strings; the caller normalizes + dedupes into Person entities and
    SENT_BY edges. Everything is best-effort — missing/oddly-typed fields are
    skipped, never raised.
    """
    names: list[str] = []
    sender = getattr(chunk, "sender", None)
    if sender:
        names.append(sender)

    md = chunk.metadata or {}

    def _add(val):
        if isinstance(val, str):
            names.append(val)
        elif isinstance(val, (list, tuple)):
            names.extend(v for v in val if isinstance(v, str))

    # Known participant-bearing metadata keys across sources.
    for key in ("from", "to", "cc", "organizer", "attendees", "speakers", "creator"):
        if key in md:
            _add(md[key])
    return names


# ─── Pipeline ────────────────────────────────────────────────


class IngestionPipeline:
    """Orchestrates the full ingestion process: load → extract (LLM) → embed → store."""

    def __init__(
        self,
        sqlite_path: Path = SQLITE_PATH,
        qdrant_path: str = QDRANT_PATH,
        messages_dir: Path = CHAT_DIR,
        cache_dir: Path = EXTRACTION_CACHE_DIR,
        max_concurrent_llm: int = 50,
        *,
        sqlite: Optional[SQLiteStore] = None,
        qdrant: Optional[QdrantStore] = None,
        embedder: Optional[Embedder] = None,
    ):
        self.messages_dir = messages_dir
        self.sqlite_path = sqlite_path
        self.qdrant_path = qdrant_path
        self.cache_dir = cache_dir

        # Injected stores (e.g. from a running kl-server that already holds the
        # single-writer Qdrant client) are reused instead of opening new ones.
        self.sqlite: Optional[SQLiteStore] = sqlite
        self.qdrant: Optional[QdrantStore] = qdrant
        self.embedder: Optional[Embedder] = embedder
        self._owns_stores = sqlite is None and qdrant is None
        self.extractor: Optional[LLMExtractor] = None
        self.max_concurrent_llm = max_concurrent_llm

        # Accumulators
        self.messages: list[Message] = []
        self.messages_by_conv: dict[str, list[Message]] = {}
        self.extra_chunks: list[Chunk] = []  # non-chat source chunks
        self.all_entities: dict[str, Entity] = {}  # id → Entity
        self.all_facts: list[Fact] = []
        self.extraction_results: dict[str, dict] = {}  # msg_id → raw result

    def all_chunks(self) -> list[Chunk]:
        """All retrieval units in one list: chat messages + non-chat chunks.

        A :class:`Message` is a :class:`Chunk`, so extraction / entity / fact /
        edge building can iterate this uniformly. Chat-specific edges
        (SENT_BY / TEMPORAL / REPLY_TO) still restrict themselves to messages.
        """
        return [*self.messages, *self.extra_chunks]

    def _init_stores(self):
        """Initialize storage backends (skip any that were injected)."""
        if self.sqlite is None:
            self.sqlite = SQLiteStore(self.sqlite_path)
        if self.qdrant is None:
            self.qdrant = QdrantStore(self.qdrant_path)
        if self.embedder is None:
            self.embedder = Embedder()
        self.extractor = LLMExtractor(
            cache_dir=self.cache_dir,
            max_concurrent=self.max_concurrent_llm,
        )

    # ═══════════════════════════════════════════════════════════════════════
    # PHASE A: Chunking (load + persist + embed; no LLM)
    # ═══════════════════════════════════════════════════════════════════════

    def run_phase_a(self, progress_callback=None):
        """Phase A: load every source, persist chunks, embed them. No LLM.

        At the end of Phase A the SQLite ``chunks`` table + Qdrant ``chunks``
        collection are populated for all sources, so dense + BM25 retrieval is
        immediately usable. Phase B then adds the graph layer on top.
        """
        t0 = time.time()
        print("=" * 60)
        print("PHASE A: CHUNKING (load + persist + embed, no LLM)")
        print("=" * 60)

        self._init_stores()

        print("\n[A.1] Loading chunks (chat + sources)...")
        self._load_sources()
        chunks = self.all_chunks()
        print(
            f"  {len(self.messages)} messages + {len(self.extra_chunks)} "
            f"source chunks = {len(chunks)} total"
        )
        if progress_callback:
            progress_callback("phase_a", 0.3)

        print("\n[A.2] Persisting chunks to SQLite...")
        self._persist_chunks()
        if progress_callback:
            progress_callback("phase_a", 0.5)

        print("\n[A.3] Embedding chunks into Qdrant...")
        self._embed_chunks()

        elapsed = time.time() - t0
        print(f"\n  Phase A complete in {elapsed:.1f}s ({elapsed / 60:.1f} min)")
        if self.embedder:
            self.embedder.print_usage_stats("Phase A (Chunk Embedding)")
        if progress_callback:
            progress_callback("phase_a", 1.0)

    # ═══════════════════════════════════════════════════════════════════════
    # PHASE B: Extraction + graph build (LLM; replayable from cache)
    # ═══════════════════════════════════════════════════════════════════════

    async def run_extraction(self, progress_callback=None):
        """Run LLM extraction on all chunks (chat + non-chat). Results cached.

        A Phase-B sub-step: loads chunks if Phase A didn't already, then fires
        cached, batched extraction over every chunk.

        Args:
            progress_callback: optional ``callable(done, total)`` invoked as
                batches complete, forwarded straight to
                :meth:`LLMExtractor.extract_all_flat`.
        """
        t0 = time.time()
        print("=" * 60)
        print("PHASE B.1: LLM EXTRACTION")
        print("=" * 60)

        # Load chat + non-chat sources into one chunk list (if not already).
        print("\n[B.1] Loading chunks (chat + sources)...")
        self._load_sources()
        chunks = self.all_chunks()
        print(
            f"  Loaded {len(self.messages)} messages + "
            f"{len(self.extra_chunks)} source chunks = {len(chunks)} total"
        )

        # Count how many need extraction
        need_extract = sum(1 for c in chunks if needs_extraction(c))
        print(f"  Chunks needing extraction: {need_extract} / {len(chunks)}")

        # Initialize extractor
        if self.extractor is None:
            self.extractor = LLMExtractor(
                cache_dir=self.cache_dir,
                max_concurrent=self.max_concurrent_llm,
            )

        # Run flat parallel extraction over all chunks
        print(
            f"\n[B.2] Running LLM extraction (max_concurrent={self.max_concurrent_llm})..."
        )
        await self.extractor.extract_all_flat(
            chunks, progress_callback=progress_callback
        )

        elapsed = time.time() - t0
        print(f"\n  Extraction complete in {elapsed:.1f}s ({elapsed / 60:.1f} min)")
        self.extractor.print_stats()
        # Step-level summary
        s = self.extractor.stats
        print(f"\n  ┌─ Phase B.1 (LLM Extraction) Cost Summary ─┐")
        print(f"  │  LLM calls:          {s['llm_calls']:,}")
        print(f"  │  Prompt tokens:      {s['prompt_tokens']:,}")
        print(f"  │  Completion tokens:  {s['completion_tokens']:,}")
        print(f"  │  Total tokens:        {s['total_tokens']:,}")
        print(f"  │  Estimated cost:     ${s['estimated_cost_usd']:.4f}")
        print(f"  │  Time:               {elapsed:.1f}s ({elapsed / 60:.1f} min)")
        print(f"  └────────────────────────────────────────────┘")

    def run_graph_build(self, progress_callback=None):
        """Build the graph (entities/facts/edges) from cached extraction results.

        No LLM. Assumes chunks are already persisted + embedded by Phase A; this
        adds only the graph layer (entity/fact rows, their vectors, and edges).

        Args:
            progress_callback: optional ``callable(frac)`` where ``frac`` is a
                float in ``[0, 1]`` marking completion of each sub-step
                (load → entities → facts → embed → edges). Embedding is the
                heaviest step, so the fractions are weighted, not uniform.
        """

        def _report(frac: float):
            if progress_callback:
                progress_callback(frac)

        t0 = time.time()
        print("\n" + "=" * 60)
        print("PHASE B.2: GRAPH BUILDING")
        print("=" * 60)

        self._init_stores()

        # B.3: Load chunks (needed to iterate for entity/fact/edge building)
        print("\n[B.3] Loading chunks (chat + sources)...")
        self._load_sources()
        print(
            f"  Messages: {len(self.messages)} + source chunks: {len(self.extra_chunks)}"
        )

        # B.4: Load cached extraction results
        print("\n[B.4] Loading cached extraction results...")
        if not self.extraction_results:
            self._load_extraction_cache()
        print(f"  Cached results loaded: {len(self.extraction_results)}")
        _report(0.10)

        # B.5: Build entities from extraction results (all chunks)
        print("\n[B.5] Building entities...")
        self._build_entities()
        print(f"  Unique entities: {len(self.all_entities)}")
        _report(0.25)

        # B.6: Build facts from extraction results (all chunks)
        print("\n[B.6] Building facts...")
        self._build_facts()
        print(f"  Facts: {len(self.all_facts)}")
        _report(0.35)

        # B.7: Embed the graph layer (entities + facts) — heaviest sub-step.
        print("\n[B.7] Embedding entities + facts...")
        self._embed_graph()
        _report(0.85)

        # B.8: Create edges
        print("\n[B.8] Creating edges...")
        self._create_edges()
        _report(1.0)

        elapsed = time.time() - t0
        self._print_summary(elapsed)

    async def run_phase_b(self):
        """Phase B: LLM extraction over all chunks + graph build.

        Assumes Phase A already persisted + embedded the chunks. Both sub-steps
        are self-sufficient (they load chunks if needed), so this also works as
        a standalone ``--phase-b`` run over an export whose chunks are cached.
        """
        await self.run_extraction()
        self.run_graph_build()

    def _load_extraction_cache(self):
        """Load all cached extraction results from disk."""
        count = 0
        for subdir in self.cache_dir.iterdir():
            if not subdir.is_dir():
                continue
            for cache_file in subdir.glob("*.json"):
                try:
                    with open(cache_file, "r", encoding="utf-8") as f:
                        result = json.load(f)
                    msg_id = result.get("_msg_id")
                    if msg_id:
                        self.extraction_results[msg_id] = result
                        count += 1
                except (json.JSONDecodeError, IOError):
                    continue
        print(f"  Loaded {count} cached results from {self.cache_dir}")

    def _build_entities(self):
        """Build entities from extraction results. Exact name match → merge.

        The extraction loop runs over **all chunks** (chat + non-chat) so an
        entity named only in a wiki/mail/minutes chunk becomes a node. The
        sender loop stays chat-only (non-chat chunks have no chat sender).
        """
        for msg in self.all_chunks():
            result = self.extraction_results.get(msg.id)
            if not result:
                continue

            raw_entities = result.get("entities", [])
            for raw in raw_entities:
                if not isinstance(raw, dict):
                    continue
                name = raw.get("name", "").strip()
                if not name or len(name) < 2:
                    continue
                # Skip garbage (URLs, overly long strings)
                if len(name) > 50 or "mediaId=" in name or "http" in name:
                    continue

                eid = entity_id_from_name(name)
                etype = map_entity_type(raw.get("entity_type", "Unknown"))

                if eid in self.all_entities:
                    # Update existing (exact name match)
                    existing = self.all_entities[eid]
                    existing.mention_count += 1
                    existing.last_seen = max(existing.last_seen, msg.timestamp)
                else:
                    self.all_entities[eid] = Entity(
                        id=eid,
                        name=name,
                        entity_type=etype,
                        first_seen=msg.timestamp,
                        last_seen=msg.timestamp,
                        mention_count=1,
                    )

        # Also add authors/participants as Person entities. Chat contributes
        # the sender; non-chat sources contribute people from their metadata
        # (mail from/to, calendar attendees, minutes speakers, report creator).
        for msg in self.all_chunks():
            for pname in _participants_of(msg):
                sender_name = pname.strip()
                if (
                    not sender_name
                    or len(sender_name) < 2
                    or sender_name.startswith("[")
                ):
                    continue
                eid = entity_id_from_name(sender_name)
                if eid in self.all_entities:
                    self.all_entities[eid].mention_count += 1
                    self.all_entities[eid].last_seen = max(
                        self.all_entities[eid].last_seen, msg.timestamp
                    )
                else:
                    self.all_entities[eid] = Entity(
                        id=eid,
                        name=sender_name,
                        entity_type=EntityType.PERSON,
                        first_seen=msg.timestamp,
                        last_seen=msg.timestamp,
                        mention_count=1,
                    )

        # Store in SQLite
        self.sqlite.upsert_entities_bulk(list(self.all_entities.values()))

    def _build_facts(self):
        """Build facts from extraction results (over all chunks).

        A fact's ``source_message_id`` holds the id of the **chunk** it was
        extracted from (a message is a chunk, so chat facts are unchanged). The
        deterministic fact id is derived from that chunk id + text, so facts
        from non-chat sources dedupe/replay the same way.
        """
        for msg in self.all_chunks():
            result = self.extraction_results.get(msg.id)
            if not result:
                continue

            raw_facts = result.get("facts", [])
            for raw in raw_facts:
                if not isinstance(raw, dict):
                    continue
                fact_text = raw.get("fact_text", "").strip()
                if not fact_text or len(fact_text) < 5:
                    continue

                fact_type = map_fact_type(raw.get("fact_type", "GENERAL"))

                # Deterministic ID from source chunk + fact text
                fact_id = str(
                    uuid.uuid5(uuid.NAMESPACE_DNS, f"fact:{msg.id}:{fact_text[:100]}")
                )

                # LLM-generated confidence in [0,1]; clamp defensively and fall
                # back to 0.9 when the model omits it or emits a bad value.
                try:
                    confidence = float(raw.get("confidence", 0.9))
                except (TypeError, ValueError):
                    confidence = 0.9
                confidence = min(1.0, max(0.0, confidence))

                fact = Fact(
                    id=fact_id,
                    text=fact_text,
                    fact_type=fact_type,
                    timestamp=msg.timestamp,
                    confidence=confidence,  # LLM-generated, clamped to [0,1]
                    source_message_id=msg.id,
                )
                self.all_facts.append(fact)

        # Store in SQLite
        if self.all_facts:
            self.sqlite.insert_facts(self.all_facts)

    def _embed_chunks(self):
        """Embed all chunks (chat + non-chat) into the Qdrant ``chunks`` collection.

        Phase A step: after this, dense + BM25 retrieval over every source is
        usable, before any LLM extraction runs. Chat messages carry extra
        payload (sender/conversation) for chat-specific filters; non-chat chunks
        carry the generic fields. Point ids are contiguous across all chunks.
        """
        chunks = self.all_chunks()
        if not chunks:
            print("  No chunks to embed.")
            return
        print(f"  Embedding {len(chunks)} chunks (all sources)...")
        texts = [
            f"{c.sender}: {c.content[:500]}"
            if isinstance(c, Message)
            else c.content[:2000]
            for c in chunks
        ]
        embeddings = self.embedder.embed_batch_with_progress(texts, "  Chunks")
        points = []
        for i, (c, emb) in enumerate(zip(chunks, embeddings)):
            payload = {
                "chunk_id": c.id,
                "source_type": c.source_type,
                "source_ref": c.source_ref or "",
                "content": c.content[:500],
                "timestamp": c.timestamp,
            }
            if isinstance(c, Message):
                payload.update(
                    source_ref=c.source_ref or c.sender,
                    conversation_id=c.conversation_id,
                    sender=c.sender,
                    sender_id=c.sender_id or "",
                )
            points.append(PointStruct(id=i, vector=emb, payload=payload))
        self.qdrant.upsert_batch("chunks", points)
        print(f"  Chunks: {len(points)} vectors stored")

    def _embed_graph(self):
        """Embed entities and facts into their Qdrant collections (Phase B)."""
        # Embed entities
        if self.all_entities:
            print("  Embedding entities...")
            entity_list = list(self.all_entities.values())
            entity_texts = [e.name for e in entity_list]
            entity_embeddings = self.embedder.embed_batch_with_progress(
                entity_texts, "  Entities"
            )

            entity_points = []
            for i, (ent, emb) in enumerate(zip(entity_list, entity_embeddings)):
                point = PointStruct(
                    id=i,
                    vector=emb,
                    payload={
                        "entity_id": ent.id,
                        "name": ent.name,
                        "entity_type": ent.entity_type.value,
                        "mention_count": ent.mention_count,
                    },
                )
                entity_points.append(point)
            self.qdrant.upsert_batch("entities", entity_points)
            print(f"  Entities: {len(entity_points)} vectors stored")

        # Embed facts
        if self.all_facts:
            print("  Embedding facts...")
            fact_texts = [f.text for f in self.all_facts]
            fact_embeddings = self.embedder.embed_batch_with_progress(
                fact_texts, "  Facts"
            )

            fact_points = []
            for i, (fact, emb) in enumerate(zip(self.all_facts, fact_embeddings)):
                point = PointStruct(
                    id=i,
                    vector=emb,
                    payload={
                        "fact_id": fact.id,
                        "text": fact.text[:300],
                        "fact_type": fact.fact_type.value,
                        "timestamp": fact.timestamp,
                        "confidence": fact.confidence,
                        "source_message_id": fact.source_message_id,
                    },
                )
                fact_points.append(point)
            self.qdrant.upsert_batch("facts", fact_points)
            print(f"  Facts: {len(fact_points)} vectors stored")

    def _load_sources(self):
        """Parse every source dir into chunks (no I/O to stores).

        Chat is just one source among many: it loads into ``self.messages``
        (a :class:`Message` is a :class:`Chunk`) while the rest load into
        ``self.extra_chunks``. The split exists only for *storage* (chat has a
        detail table + chat-only edges), not for loading — every source is
        loaded here through the same call. Loaders no-op when a dir is absent,
        so a partial export still works. Kept separate from persistence so
        Phase A can extract over the chunks before Phase B embeds/stores them.
        """
        if self.messages or self.extra_chunks:
            return
        # Chat first (it feeds the detail table + chat-only edges), then the rest.
        self.messages = load_all_messages(self.messages_dir)
        if self.messages:
            print(f"  chat: {len(self.messages)} messages")

        # Other sources live as sibling dirs under the export root. Derive the
        # root from the chat dir so a custom export_dir (per-ingest override)
        # still resolves the siblings correctly.
        export_root = self.messages_dir.parent
        sources: list[tuple[str, list[Chunk]]] = []
        # Structured sources with bespoke mappers.
        sources.append(("wiki", load_wiki(export_root / "wiki")))
        sources.append(("mail", load_mail(export_root / "mail")))
        sources.append(("minutes", load_minutes(export_root / "minutes")))
        # Everything else: one chunk per record via the generic flattener.
        for name in GENERIC_SOURCES:
            src_dir = export_root / name
            if src_dir.is_dir():
                sources.append((name, load_generic(src_dir, name)))
        self.extra_chunks = [c for _, chunks in sources for c in chunks]
        for name, chunks in sources:
            if chunks:
                print(f"  {name}: {len(chunks)} chunks")

    def _persist_chunks(self):
        """Write all chunks (chat + non-chat) to SQLite. No embedding here.

        Messages go through ``insert_messages`` (detail table + dual-write into
        ``chunks``); non-chat chunks go through ``insert_chunks``. Embedding is a
        separate step (:meth:`_embed_chunks`) so persistence and vectors can be
        reasoned about independently.
        """
        self._load_sources()
        if self.messages:
            self.sqlite.insert_messages(self.messages)
            print(f"  Messages persisted: {self.sqlite.count_messages()}")
        if self.extra_chunks:
            self.sqlite.insert_chunks(self.extra_chunks)
        print(f"  Chunks (all sources): {self.sqlite.count_chunks()}")

    def _create_edges(self):
        """Create all structural edges from extraction results."""
        edges = []

        # MENTIONS edges (chunk → entity) from extraction results
        print("  Creating MENTIONS edges...")
        for msg in self.all_chunks():
            result = self.extraction_results.get(msg.id)
            if not result:
                continue
            raw_entities = result.get("entities", [])
            for raw in raw_entities:
                if not isinstance(raw, dict):
                    continue
                name = raw.get("name", "").strip()
                if not name or len(name) < 2 or len(name) > 50:
                    continue
                eid = entity_id_from_name(name)
                if eid in self.all_entities:
                    edges.append(
                        Edge(
                            source_type="message",
                            source_id=msg.id,
                            target_type="entity",
                            target_id=eid,
                            edge_type=EdgeType.MENTIONS,
                        )
                    )

        # SENT_BY edges (chunk → author/participant Person entity)
        print("  Creating SENT_BY edges...")
        for msg in self.all_chunks():
            seen_eids = set()
            for pname in _participants_of(msg):
                sender_name = pname.strip()
                if not sender_name or len(sender_name) < 2:
                    continue
                eid = entity_id_from_name(sender_name)
                if eid in seen_eids:
                    continue
                seen_eids.add(eid)
                if eid in self.all_entities:
                    edges.append(
                        Edge(
                            source_type="message",
                            source_id=msg.id,
                            target_type="entity",
                            target_id=eid,
                            edge_type=EdgeType.SENT_BY,
                        )
                    )

        # TEMPORAL edges
        print("  Creating TEMPORAL edges...")
        conv_messages: dict[str, list[Message]] = {}
        for msg in self.messages:
            conv_messages.setdefault(msg.conversation_id, []).append(msg)
        for conv_id, msgs in conv_messages.items():
            msgs.sort(key=lambda m: m.timestamp)
            for i in range(len(msgs) - 1):
                edges.append(
                    Edge(
                        source_type="message",
                        source_id=msgs[i].id,
                        target_type="message",
                        target_id=msgs[i + 1].id,
                        edge_type=EdgeType.TEMPORAL,
                    )
                )

        # REPLY_TO edges
        print("  Creating REPLY_TO edges...")
        for msg in self.messages:
            if msg.reply_to:
                edges.append(
                    Edge(
                        source_type="message",
                        source_id=msg.id,
                        target_type="message",
                        target_id=msg.reply_to,
                        edge_type=EdgeType.REPLY_TO,
                    )
                )

        # STATES edges (fact → source chunk)
        # ABOUT edges (fact → entities mentioned in fact)
        print("  Creating STATES/ABOUT edges...")
        for msg in self.all_chunks():
            result = self.extraction_results.get(msg.id)
            if not result:
                continue
            raw_facts = result.get("facts", [])
            for raw_fact in raw_facts:
                if not isinstance(raw_fact, dict):
                    continue
                fact_text = raw_fact.get("fact_text", "").strip()
                if not fact_text or len(fact_text) < 5:
                    continue

                fact_id = str(
                    uuid.uuid5(uuid.NAMESPACE_DNS, f"fact:{msg.id}:{fact_text[:100]}")
                )

                # STATES: fact → source chunk (message id == chunk id)
                edges.append(
                    Edge(
                        source_type="fact",
                        source_id=fact_id,
                        target_type="message",
                        target_id=msg.id,
                        edge_type=EdgeType.STATES,
                    )
                )

                # ABOUT: fact → subject entity
                subject = (raw_fact.get("subject_entity") or "").strip()
                if subject and len(subject) >= 2:
                    subj_eid = entity_id_from_name(subject)
                    if subj_eid in self.all_entities:
                        edges.append(
                            Edge(
                                source_type="fact",
                                source_id=fact_id,
                                target_type="entity",
                                target_id=subj_eid,
                                edge_type=EdgeType.ABOUT,
                            )
                        )

                # ABOUT: fact → object entity
                obj = (raw_fact.get("object_entity") or "").strip()
                if obj and len(obj) >= 2:
                    obj_eid = entity_id_from_name(obj)
                    if obj_eid in self.all_entities:
                        edges.append(
                            Edge(
                                source_type="fact",
                                source_id=fact_id,
                                target_type="entity",
                                target_id=obj_eid,
                                edge_type=EdgeType.ABOUT,
                            )
                        )

        # Bulk insert
        print(f"  Inserting {len(edges)} edges...")
        batch_size = 10000
        for i in range(0, len(edges), batch_size):
            self.sqlite.insert_edges(edges[i : i + batch_size])

        print(f"  Edge counts by type: {self.sqlite.count_edges_by_type()}")

    def _print_summary(self, elapsed: float):
        """Print build summary."""
        print("\n" + "=" * 60)
        print("GRAPH BUILD COMPLETE")
        print("=" * 60)
        print(f"  Time: {elapsed:.1f}s ({elapsed / 60:.1f} min)")
        print(f"  Messages: {self.sqlite.count_messages()}")
        print(f"  Chunks (all sources): {self.sqlite.count_chunks()}")
        print(f"  Chunk breakdown: {self.sqlite.count_chunks_by_source()}")
        print(f"  Entities: {self.sqlite.count_entities()}")
        print(f"  Facts: {self.sqlite.count_facts()}")
        print(f"  Edges: {self.sqlite.count_edges()}")
        print(f"  Edge breakdown: {self.sqlite.count_edges_by_type()}")
        print(f"  Qdrant chunks: {self.qdrant.count('chunks')}")
        print(f"  Qdrant entities: {self.qdrant.count('entities')}")
        print(f"  Qdrant facts: {self.qdrant.count('facts')}")
        # Embedding token usage for graph build
        if self.embedder:
            self.embedder.print_usage_stats("Phase B.2 (Entity/Fact Embedding)")
        # Full-pipeline LLM cost summary
        if self.extractor and self.extractor.stats.get("llm_calls", 0) > 0:
            s = self.extractor.stats
            print(f"\n  ┌─ Full Pipeline LLM Cost Summary ────────────┐")
            print(f"  │  Phase B.1 (Extraction):")
            print(f"  │    LLM calls:          {s['llm_calls']:,}")
            print(f"  │    Prompt tokens:      {s['prompt_tokens']:,}")
            print(f"  │    Completion tokens:  {s['completion_tokens']:,}")
            print(f"  │    Total tokens:        {s['total_tokens']:,}")
            print(f"  │    Estimated cost:     ${s['estimated_cost_usd']:.4f}")
            print(f"  │  Phase B.2 (Graph Build): no LLM")
            print(f"  │  ────────────────────────────────────────")
            print(f"  │  Total estimated cost: ${s['estimated_cost_usd']:.4f}")
            print(f"  └────────────────────────────────────────────┘")
        print("=" * 60)

    # ═══════════════════════════════════════════════════════════════════════
    # Full pipeline (run both phases)
    # ═══════════════════════════════════════════════════════════════════════

    async def run_full(self):
        """Run the complete pipeline with a smart resume.

        Phase B on its own is useless (a graph with no embedded chunks to ground
        it), so the only supported "do everything" entry point verifies Phase A
        first: if every chunk that would be loaded is already persisted **and**
        embedded, it skips straight to Phase B; otherwise it runs Phase A from
        the beginning, then Phase B.
        """
        self._init_stores()
        if self._phase_a_complete():
            print(
                "Phase A already complete (all chunks persisted + embedded) — "
                "resuming at Phase B."
            )
        else:
            self.run_phase_a()
        await self.run_phase_b()

    def _phase_a_complete(self) -> bool:
        """True iff every loadable chunk is already persisted **and** embedded.

        Parses the source folders (cheap, no store writes) to learn how many
        chunks Phase A would produce, then checks the SQLite ``chunks`` table
        and the Qdrant ``chunks`` collection both cover them. A partial Phase A
        (persisted but not embedded, or fewer rows than sources) counts as *not*
        complete, so ``run_full`` re-runs Phase A from the start.
        """
        self._init_stores()
        self._load_sources()
        expected = len(self.all_chunks())
        if expected == 0:
            return False
        persisted = self.sqlite.count_chunks()
        embedded = self.qdrant.count("chunks")
        return persisted >= expected and embedded >= expected

    def close(self):
        # Never close injected stores — their owner (e.g. kl-server) manages them.
        if not self._owns_stores:
            return
        if self.sqlite:
            self.sqlite.close()
        if self.qdrant:
            self.qdrant.close()
