"""Incremental ingestion orchestrator — extends IngestionPipeline with run_incremental
method that processes only new data since the last watermark without rebuilding
the full graph. Handles delta detection, incremental entity/fact merging,
similarity edge computation, and community assignment.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING

from kl_graph.config import cfg, DATA_DIR
from kl_graph.ingest.strategies import (
    AnnPlusIntraBatch,
    DynamicFrontierLeiden,
    IncrementalCommunityStrategy,
    IncrementalSimilarityStrategy,
)
from kl_graph.ingest.watermark import (
    increment_run_count,
    needs_full_rebuild,
    reset_run_count,
    set_watermark,
)
from kl_graph.periodic.community_detection import (
    RESOLUTIONS,
    project_community_membership_edges,
)

if TYPE_CHECKING:
    from kl_graph.ingest.checkpoint import IngestCheckpoint
    from kl_graph.ingest.embedder import Embedder
    from kl_graph.models.types import Chunk, Edge
    from kl_graph.storage.base import KnowledgeStore
    from kl_graph.storage.qdrant_store import QdrantStore

logger = logging.getLogger(__name__)

# Derived constants from OmegaConf config
SQLITE_PATH = DATA_DIR / "knowledge.db"
FULL_REBUILD_EVERY = int(cfg.pipelines.ingestion.incremental.full_rebuild_every)
INCR_COMMUNITY_SUMMARY_THRESHOLD = float(cfg.pipelines.ingestion.incremental.community_summary_threshold)


class IncrementalIngestion:
    """Orchestrates incremental ingestion: delta detection, extraction, entity/fact
    merge, similarity, and community assignment.

    Lock acquisition is the caller's responsibility; IngestionPipeline.run_incremental()
    acquires the ingest file lock before constructing this object.
    Checkpoint keys: incr.load_delta, incr.persist_chunks,
        incr.embed_chunks, incr.extract, incr.build_entities,
        incr.build_facts, incr.embed_new, incr.similarity,
        incr.communities, incr.invalidate_summaries
    """

    def __init__(
        self,
        store: KnowledgeStore,
        qdrant: QdrantStore,
        *,
        embedder: Embedder | None = None,
        checkpoint: IngestCheckpoint | None = None,
        similarity_strategy: IncrementalSimilarityStrategy | None = None,
        community_strategy: IncrementalCommunityStrategy | None = None,
        cache_db: Path | None = None,
        max_concurrent_llm: int = 50,
    ) -> None:
        self.store = store
        self.qdrant = qdrant
        self.embedder = embedder
        self.checkpoint = checkpoint
        self.similarity_strategy: IncrementalSimilarityStrategy = (
            similarity_strategy
            if similarity_strategy is not None
            else AnnPlusIntraBatch()
        )
        self.community_strategy: IncrementalCommunityStrategy = (
            community_strategy
            if community_strategy is not None
            else DynamicFrontierLeiden()
        )
        self.cache_db = cache_db
        self.max_concurrent_llm = max_concurrent_llm

    @contextmanager
    def step(self, name: str, *, on_skip=None, params: dict | None = None):
        """Checkpoint-guarded step context manager (None-safe).

        Args:
            name: Step identifier (checkpoint key).
            on_skip: Callback invoked when step is already done.
            params: Optional parameters for improve steps.
        """
        if self.checkpoint is not None:
            with self.checkpoint.step(name, on_skip=on_skip, params=params) as guard:
                yield guard
        else:
            from kl_graph.ingest.checkpoint import StepGuard

            yield StepGuard(None, name, skip=False)

    async def run(self, since_timestamp: int | None = None) -> dict:
        """Execute the full incremental ingestion pipeline.

        Steps (all checkpointed with "incr.*" keys via self.step() context manager):
        1. incr.load_delta — detect new chunks via watermark + existing_chunk_ids.
        2. incr.persist_chunks — insert new chunks to SQLite.
        3. incr.embed_chunks — embed new chunks to Qdrant (only those not in qdrant).
        4. incr.extract — LLM extraction for new chunks only.
        5. incr.build_entities — merge entities incrementally.
        6. incr.build_facts — insert new facts.
        7. incr.embed_new — embed new entities/facts not yet in Qdrant.
        8. incr.similarity — delegate to similarity_strategy.compute_similarity_edges().
        9. incr.communities — delegate to community_strategy.assign_communities().
        10. incr.invalidate_summaries — mark stale summaries.

        After all steps: update watermark, increment_run_count(),
        check needs_full_rebuild() and if True run full Leiden + similarity then
        reset_run_count().

        Args:
            since_timestamp: Optional explicit cutoff (unix ms). Overrides stored watermark.

        Returns:
            Dict with keys: new_chunks, new_entities, new_facts, new_edges, changed_communities.
        """

        summary = {
            "new_chunks": 0,
            "new_entities": 0,
            "new_facts": 0,
            "new_edges": 0,
            "changed_communities": 0,
        }

        # Step 1: Load delta (detect new chunks)
        new_chunks: list[Chunk] = []
        with self.step("incr.load_delta") as s:
            if not s.skip:
                new_chunks = self._load_delta_chunks(since_timestamp)
                logger.info("incr.load_delta: %d new chunks", len(new_chunks))
                s.done(count=len(new_chunks))

        if not new_chunks:
            logger.info("incr: no new data since watermark — returning early")
            return summary

        summary["new_chunks"] = len(new_chunks)

        # Step 2: Persist new chunks
        with self.step("incr.persist_chunks") as s:
            if not s.skip:
                self._persist_new_chunks(new_chunks)
                s.done(count=len(new_chunks))

        # Step 3: Embed new chunks
        with self.step("incr.embed_chunks") as s:
            if not s.skip:
                await self._embed_new_chunks(new_chunks)
                s.done(count=len(new_chunks))

        # Step 4: LLM extraction for new chunks
        with self.step("incr.extract") as s:
            if not s.skip:
                extraction_results = await self._extract_new_chunks(new_chunks)
                s.done(count=len(extraction_results))
            else:
                extraction_results = self._load_extraction_cache_for(new_chunks)

        # Step 5: Build entities incrementally
        new_entity_ids: list[str] = []

        def _restore_entity_ids() -> None:
            # On checkpoint resume, reload entity IDs created in the previous run
            # so downstream steps (similarity, community) receive the correct IDs.
            nonlocal new_entity_ids
            rows = self.store.sql_conn.execute(
                "SELECT id FROM entities WHERE first_seen > ?",
                (min(c.timestamp for c in new_chunks) - 1,),
            ).fetchall()
            new_entity_ids = [r[0] for r in rows]

        with self.step("incr.build_entities", on_skip=_restore_entity_ids) as s:
            if not s.skip:
                new_entity_ids = await self._build_incremental_entities(
                    new_chunks, extraction_results
                )
                summary["new_entities"] = len(new_entity_ids)
                s.done(count=len(new_entity_ids))

        # Step 6: Build facts incrementally
        new_fact_ids: list[str] = []

        def _restore_fact_ids() -> None:
            # On checkpoint resume, reload fact IDs created in the previous run.
            nonlocal new_fact_ids
            rows = self.store.sql_conn.execute(
                "SELECT id FROM facts WHERE timestamp >= ?",
                (min(c.timestamp for c in new_chunks),),
            ).fetchall()
            new_fact_ids = [r[0] for r in rows]

        with self.step("incr.build_facts", on_skip=_restore_fact_ids) as s:
            if not s.skip:
                new_fact_ids = self._build_incremental_facts(
                    new_chunks, extraction_results
                )
                summary["new_facts"] = len(new_fact_ids)
                s.done(count=len(new_fact_ids))

        # Step 7: Embed new entities and facts
        with self.step("incr.embed_new") as s:
            if not s.skip:
                await self._embed_new_nodes(new_entity_ids, new_fact_ids)
                s.done(count=len(new_entity_ids) + len(new_fact_ids))

        # Step 8: Compute similarity edges
        new_similarity_edges: list[Edge] = []
        with self.step("incr.similarity") as s:
            if not s.skip:
                new_similarity_edges = (
                    self.similarity_strategy.compute_similarity_edges(
                        new_entity_ids,
                        new_fact_ids,
                        self.qdrant,
                        self.store,
                    )
                )
                if new_similarity_edges:
                    self.store.insert_edges(new_similarity_edges)
                summary["new_edges"] = len(new_similarity_edges)
                logger.info("incr.similarity: %d new edges", len(new_similarity_edges))
                s.done(count=len(new_similarity_edges))

        # Step 9: Assign communities
        changed_community_ids: set[str] = set()
        with self.step("incr.communities") as s:
            if not s.skip:
                changed_community_ids = self.community_strategy.assign_communities(
                    self.store,
                    new_entity_ids,
                    new_fact_ids,
                    entity_resolutions=RESOLUTIONS,
                    fact_resolutions=RESOLUTIONS,
                )
                # Project COMM_MEMBER edges for changed communities
                if changed_community_ids:
                    project_community_membership_edges(self.store)
                summary["changed_communities"] = len(changed_community_ids)
                logger.info(
                    "incr.communities: %d communities changed",
                    len(changed_community_ids),
                )
                s.done(count=len(changed_community_ids))

        # Step 10: Invalidate stale community summaries
        with self.step("incr.invalidate_summaries") as s:
            if not s.skip:
                n_invalidated = self._invalidate_stale_summaries(
                    changed_community_ids,
                    threshold=INCR_COMMUNITY_SUMMARY_THRESHOLD,
                )
                logger.info("incr.invalidate_summaries: %d marked stale", n_invalidated)
                s.done(count=n_invalidated)

        # Update watermark to max timestamp of new chunks
        max_ts = max(c.timestamp for c in new_chunks)
        self._update_watermark(max_ts)

        # Increment run count and check if full rebuild is needed.
        # Note: IngestionPipeline.run_incremental() performs a preflight check and
        # calls reset_run_count() before constructing this object when a full rebuild
        # was already triggered by the caller. Therefore, the needs_full_rebuild()
        # check here will not double-trigger: the run_count was reset to 0 by the
        # preflight, so it can only reach FULL_REBUILD_EVERY after many more runs.
        new_count = increment_run_count(self.store)
        logger.info("incr: run_count=%d (threshold=%d)", new_count, FULL_REBUILD_EVERY)

        if needs_full_rebuild(self.store, FULL_REBUILD_EVERY):
            logger.info(
                "incr: triggering full Leiden rebuild (run_count >= %d)",
                FULL_REBUILD_EVERY,
            )
            self._run_full_rebuild()
            reset_run_count(self.store)

        return summary

    # ── Private step implementations ─────────────────────────────────────────

    def _load_delta_chunks(self, since_timestamp: int | None) -> list[Chunk]:
        """Load all source chunks and return only those not yet in the DB.

        Args:
            since_timestamp: Optional explicit cutoff (unix ms). Currently
                used for future filtering; delta detection uses existing_chunk_ids.

        Returns:
            List of new Chunk objects.
        """
        # TODO: Feature envy — this method delegates entirely to IngestionPipeline._load_delta().
        # The delta detection logic should be extracted into a standalone function
        # (e.g. kl_graph.ingest.delta.load_delta(store, qdrant, since_timestamp))
        # so both IncrementalIngestion and IngestionPipeline can call it directly.
        from kl_graph.ingest.pipeline import IngestionPipeline

        # Reuse the pipeline's delta detection logic
        # We create a temporary pipeline instance with our injected stores
        pipeline = IngestionPipeline(store=self.store, qdrant=self.qdrant)
        delta = pipeline._load_delta()
        pipeline.close()
        return delta

    def _persist_new_chunks(self, new_chunks: list[Chunk]) -> None:
        """Insert new chunks to SQLite.

        Args:
            new_chunks: Chunks not yet in the store.
        """
        chat = [c for c in new_chunks if c.source_type == "message"]
        other = [c for c in new_chunks if c.source_type != "message"]
        if chat:
            self.store.insert_messages(chat)
        if other:
            self.store.insert_chunks(other)

    async def _embed_new_chunks(self, new_chunks: list[Chunk]) -> None:
        """Embed new chunks into Qdrant, skipping already-embedded ones.

        Args:
            new_chunks: New chunks to embed.
        """
        if self.embedder is None:
            logger.warning("incr.embed_chunks: no embedder configured, skipping")
            return

        from qdrant_client.models import PointStruct

        from kl_graph.storage.qdrant_store import point_id

        pids = [point_id(c.id) for c in new_chunks]
        already = self.qdrant.existing_ids("chunks", pids)
        todo = [(c, pid) for c, pid in zip(new_chunks, pids) if pid not in already]
        if not todo:
            return

        def _is_chat(chunk: Chunk) -> bool:
            return chunk.source_type == "message"

        texts = [c.content if _is_chat(c) else c.content[:2000] for c, _ in todo]
        embeddings = self.embedder.embed_batch_with_progress(texts, "  IncrChunks")
        points = []
        for (c, pid), emb in zip(todo, embeddings):
            payload = {
                "chunk_id": c.id,
                "source_type": c.source_type,
                "source_ref": c.source_ref or "",
                "content": c.content[:500],
                "timestamp": c.timestamp,
            }
            if _is_chat(c):
                payload.update(
                    conversation_id=c.metadata.get("conversation_id", ""),
                    sender=c.metadata.get("sender", ""),
                    sender_id=c.metadata.get("sender_id") or "",
                )
            points.append(PointStruct(id=pid, vector=emb, payload=payload))
        self.qdrant.upsert_batch("chunks", points)

    async def _extract_new_chunks(self, new_chunks: list[Chunk]) -> dict:
        """Run LLM extraction for new chunks. Cache naturally skips already-processed.

        Args:
            new_chunks: Chunks to run extraction on.

        Returns:
            Dict mapping chunk_id to extraction result.
        """
        from kl_graph.ingest.llm_extractor import LLMExtractor

        cache_db = self.cache_db
        if cache_db is None:
            cache_db = SQLITE_PATH

        extractor = LLMExtractor(
            cache_db=cache_db,
            max_concurrent=self.max_concurrent_llm,
        )
        try:
            await extractor.extract_all_flat(new_chunks)
        finally:
            extractor.close()
        # Reload results from cache
        return self._load_extraction_cache_for(new_chunks)

    def _load_extraction_cache_for(self, new_chunks: list[Chunk]) -> dict:
        """Load cached extraction results for the given chunks.

        Args:
            new_chunks: Chunks whose cache entries to load.

        Returns:
            Dict mapping chunk_id to extraction result (successes only).
        """
        from kl_graph.ingest.extraction_cache import ExtractionCacheStore
        from kl_graph.ingest.llm_extractor import LLMExtractor

        cache_db = self.cache_db
        if cache_db is None:
            cache_db = SQLITE_PATH

        model = LLMExtractor(cache_db=cache_db).model
        store = ExtractionCacheStore(cache_db)
        try:
            return store.get_many([c.id for c in new_chunks], model)
        finally:
            store.close()

    async def _build_incremental_entities(
        self, new_chunks: list[Chunk], extraction_results: dict
    ) -> list[str]:
        """Merge entities from new chunks into the graph.

        If entity exists by normalized name: increment mention_count, update last_seen.
        If not: create new entity.

        Args:
            new_chunks: New chunks to process.
            extraction_results: LLM extraction results keyed by chunk_id.

        Returns:
            List of entity IDs that were newly created.
        """
        from kl_graph.ingest.pipeline import (
            _participants_of,
            build_entity_description,
            entity_id_from_name,
            map_entity_type,
        )
        from kl_graph.models.types import Entity, EntityType

        entity_description_concurrency = int(cfg.pipelines.ingestion.entity_description.concurrency)

        # Track existing entities from DB
        existing = {e.id: e for e in self.store.iter_all_entities()}
        new_entity_ids: list[str] = []
        descriptions: dict[str, list[tuple[int, str]]] = {}
        updates: dict[str, Entity] = {}

        for chunk in new_chunks:
            result = extraction_results.get(chunk.id)
            if not result:
                continue

            for raw in result.get("entities", []):
                if not isinstance(raw, dict):
                    continue
                name = raw.get("name", "").strip().lstrip("@").strip()
                if not name or len(name) < 2 or len(name) > 50:
                    continue
                if "mediaId=" in name or "http" in name:
                    continue
                if name in ("所有人", "全体成员", "全体"):
                    continue

                eid = entity_id_from_name(name)
                etype = map_entity_type(raw.get("entity_type", "Unknown"))

                raw_desc = raw.get("description") or ""
                if isinstance(raw_desc, str) and raw_desc.strip():
                    descriptions.setdefault(eid, []).append(
                        (chunk.timestamp, raw_desc.strip())
                    )

                if eid in existing:
                    ent = existing[eid]
                    ent.mention_count += 1
                    ent.last_seen = max(ent.last_seen, chunk.timestamp)
                    updates[eid] = ent
                else:
                    new_entity = Entity(
                        id=eid,
                        name=name,
                        entity_type=etype,
                        first_seen=chunk.timestamp,
                        last_seen=chunk.timestamp,
                        mention_count=1,
                    )
                    existing[eid] = new_entity
                    updates[eid] = new_entity
                    new_entity_ids.append(eid)

        # Add participants as Person entities
        for chunk in new_chunks:
            for pname in _participants_of(chunk):
                sender_name = pname.strip()
                if (
                    not sender_name
                    or len(sender_name) < 2
                    or sender_name.startswith("[")
                ):
                    continue
                eid = entity_id_from_name(sender_name)
                if eid in existing:
                    ent = existing[eid]
                    ent.mention_count += 1
                    ent.last_seen = max(ent.last_seen, chunk.timestamp)
                    updates[eid] = ent
                else:
                    new_entity = Entity(
                        id=eid,
                        name=sender_name,
                        entity_type=EntityType.PERSON,
                        first_seen=chunk.timestamp,
                        last_seen=chunk.timestamp,
                        mention_count=1,
                    )
                    existing[eid] = new_entity
                    updates[eid] = new_entity
                    new_entity_ids.append(eid)

        # Update descriptions. Hub entities (> gate) each fire one summarizer
        # LLM call; run them concurrently under a bounded semaphore (mirrors the
        # batch build) instead of one serial blocking call each.
        async def _fold(eid: str, contributions: list[tuple[int, str]]) -> None:
            entity = updates.get(eid) or existing.get(eid)
            if entity is None:
                return
            entity.description = await build_entity_description(
                entity.name, contributions
            )

        sem = asyncio.Semaphore(entity_description_concurrency)

        async def _bounded_fold(eid: str, contributions: list[tuple[int, str]]) -> None:
            async with sem:
                await _fold(eid, contributions)

        await asyncio.gather(
            *(
                _bounded_fold(eid, contributions)
                for eid, contributions in descriptions.items()
            )
        )

        if updates:
            self.store.upsert_entities(list(updates.values()))

        return new_entity_ids

    def _build_incremental_facts(
        self, new_chunks: list[Chunk], extraction_results: dict
    ) -> list[str]:
        """Insert new facts from new chunks.

        Args:
            new_chunks: New chunks to process.
            extraction_results: LLM extraction results keyed by chunk_id.

        Returns:
            List of newly inserted fact IDs.
        """
        from kl_graph.ingest.pipeline import (
            IngestionPipeline,
            _dated_fact_text,
            _fact_id,
            map_fact_type,
        )
        from kl_graph.models.types import Fact

        all_entities = {e.id: e for e in self.store.iter_all_entities()}
        new_facts: list[Fact] = []
        new_fact_ids: list[str] = []
        fact_edges: list[Edge] = []

        for chunk in new_chunks:
            result = extraction_results.get(chunk.id)
            if not result:
                continue

            for raw in result.get("facts", []):
                if not isinstance(raw, dict):
                    continue
                fact_text = raw.get("fact_text", "").strip()
                if not fact_text or len(fact_text) < 5:
                    continue

                # U0 parity with the batch path (_build_facts): prefix the
                # chunk's date BEFORE id derivation so the same (chunk, raw
                # fact) gets the identical id/text whether ingested batch or
                # incrementally. Local rebind only — the raw cache text stays
                # untouched.
                fact_text = _dated_fact_text(fact_text, chunk.timestamp)

                fact_type = map_fact_type(raw.get("fact_type", "GENERAL"))
                fact_id = _fact_id(chunk.id, fact_text)

                try:
                    confidence = float(raw.get("confidence", 0.9))
                except (TypeError, ValueError):
                    confidence = 0.9
                confidence = min(1.0, max(0.0, confidence))

                fact = Fact(
                    id=fact_id,
                    text=fact_text,
                    fact_type=fact_type,
                    timestamp=chunk.timestamp,
                    confidence=confidence,
                    source_chunk_id=chunk.id,
                )
                new_facts.append(fact)
                new_fact_ids.append(fact_id)

                # Build STATES + ABOUT edges — pass the chunk timestamp so the
                # edge fact ids use the same date-prefixed text as the node.
                fact_edges.extend(
                    IngestionPipeline._fact_edges(
                        chunk.id, raw, all_entities, chunk.timestamp
                    )
                )

        if new_facts:
            self.store.insert_facts(new_facts)
        if fact_edges:
            self.store.insert_edges(fact_edges)

        return new_fact_ids

    async def _embed_new_nodes(
        self, new_entity_ids: list[str], new_fact_ids: list[str]
    ) -> None:
        """Embed new entities and facts not yet in Qdrant.

        Args:
            new_entity_ids: IDs of newly created entities.
            new_fact_ids: IDs of newly created facts.
        """
        if self.embedder is None:
            logger.warning("incr.embed_new: no embedder configured, skipping")
            return

        from qdrant_client.models import PointStruct

        from kl_graph.storage.qdrant_store import point_id

        # Embed new entities
        if new_entity_ids:
            all_entities = {e.id: e for e in self.store.iter_all_entities()}
            entities = [
                all_entities[eid] for eid in new_entity_ids if eid in all_entities
            ]
            if entities:
                epids = [point_id(e.id) for e in entities]
                already = self.qdrant.existing_ids("entities", epids)
                todo = [
                    (e, pid) for e, pid in zip(entities, epids) if pid not in already
                ]
                if todo:
                    texts = [e.name for e, _ in todo]
                    embeddings = self.embedder.embed_batch_with_progress(
                        texts, "  IncrEntities"
                    )
                    points = []
                    for (ent, pid), emb in zip(todo, embeddings):
                        points.append(
                            PointStruct(
                                id=pid,
                                vector=emb,
                                payload={
                                    "entity_id": ent.id,
                                    "name": ent.name,
                                    "entity_type": ent.entity_type.value,
                                    "mention_count": ent.mention_count,
                                },
                            )
                        )
                    self.qdrant.upsert_batch("entities", points)

        # Embed new facts
        if new_fact_ids:
            all_facts_iter = self.store.iter_all_facts()
            facts_map = {f.id: f for f in all_facts_iter}
            facts = [facts_map[fid] for fid in new_fact_ids if fid in facts_map]
            if facts:
                fpids = [point_id(f.id) for f in facts]
                already = self.qdrant.existing_ids("facts", fpids)
                todo = [(f, pid) for f, pid in zip(facts, fpids) if pid not in already]
                if todo:
                    texts = [f.text for f, _ in todo]
                    embeddings = self.embedder.embed_batch_with_progress(
                        texts, "  IncrFacts"
                    )
                    points = []
                    for (fact, pid), emb in zip(todo, embeddings):
                        points.append(
                            PointStruct(
                                id=pid,
                                vector=emb,
                                payload={
                                    "fact_id": fact.id,
                                    "text": fact.text[:300],
                                    "fact_type": fact.fact_type.value,
                                    "timestamp": fact.timestamp,
                                    "confidence": fact.confidence,
                                    "source_chunk_id": fact.source_chunk_id,
                                },
                            )
                        )
                    self.qdrant.upsert_batch("facts", points)

    def _invalidate_stale_summaries(
        self, changed_community_ids: set[str], *, threshold: float
    ) -> int:
        """Mark community summaries as stale when membership change exceeds threshold.

        For each community that had members added/removed: compute ratio =
        changed_members / total_members. If ratio > threshold: set summary_stale = 1.
        Does NOT re-summarize inline — just marks for later.

        Args:
            changed_community_ids: Community UUIDs whose membership changed.
            threshold: Fraction of membership change to trigger stale mark.

        Returns:
            Number of communities marked stale.
        """
        if not changed_community_ids:
            return 0

        conn = self.store.sql_conn

        # Check if communities table and summary_stale column exist
        try:
            cols = {
                r[1] for r in conn.execute("PRAGMA table_info(communities)").fetchall()
            }
        except sqlite3.DatabaseError:
            return 0

        if "summary_stale" not in cols:
            return 0

        # Load current member counts for changed communities
        placeholders = ",".join("?" * len(changed_community_ids))
        try:
            rows = conn.execute(
                f"SELECT id, member_count FROM communities WHERE id IN ({placeholders})",
                list(changed_community_ids),
            ).fetchall()
        except sqlite3.DatabaseError:
            return 0

        # For each changed community, check the change ratio.
        # Approximation: we conservatively assume exactly 1 member changed per
        # community (we track changed community UUIDs, not per-member deltas).
        # ratio = 1 / member_count is a lower bound on the actual change fraction.
        # Communities with a single member always satisfy ratio > threshold, which
        # is intentional: any change to a 1-member community invalidates its summary.
        n_stale = 0
        stale_ids: list[str] = []
        for row in rows:
            comm_id = row[0]
            member_count = row[1] or 1
            # Conservative estimate: 1 member changed
            ratio = 1.0 / member_count
            if ratio > threshold:
                stale_ids.append(comm_id)

        if stale_ids:
            ph = ",".join("?" * len(stale_ids))
            try:
                conn.execute(
                    f"UPDATE communities SET summary_stale = 1 WHERE id IN ({ph})",
                    stale_ids,
                )
                conn.commit()
                n_stale = len(stale_ids)
            except sqlite3.DatabaseError:
                logger.exception("Failed to mark summaries as stale")

        return n_stale

    def _update_watermark(self, max_timestamp: int) -> None:
        """Update the watermark to the max timestamp of new chunks.

        Args:
            max_timestamp: Maximum timestamp from the new chunks.
        """
        # Use "message" as the canonical source type for the watermark key.
        set_watermark(self.store, "message", max_timestamp)

    def _run_full_rebuild(self) -> None:
        """Trigger a full Leiden + similarity rebuild."""
        from kl_graph.periodic.runner import run_periodic_improvement

        run_periodic_improvement(
            store=self.store,
            qdrant=self.qdrant,
            checkpoint=self.checkpoint,
        )
