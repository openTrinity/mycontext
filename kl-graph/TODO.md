# TODO — kl-graph

Two tracks:

- **Machine TODOs** — follow-ups the assistant proposed and the maintainer agreed
  to. Small, self-contained, no separate design doc needed.
- **Human TODOs** — features the maintainer wants implemented. Each links to a
  detailed design in `docs/todo/`.

---

## 1. Machine TODOs

- [ ] **Query-rewrite latency: take the LLM off the hot path.** The Phase-1 LLM
      query-rewrite (`_match_entities` → `rewrite_query`) is ~15-20s and is ~99%
      of `/ask` and `/search` latency — retrieval itself (Qdrant exact + BM25 +
      RRF + depth-1 walk) is <10ms, query embedding ~230ms. This forces an
      unacceptably large CLI `REQUEST_TIMEOUT` (currently 60s). The rewrite is
      unnecessary for most queries: dense + sparse + substring already retrieve
      the answer; the LLM only uniquely adds multi-entity decomposition + the
      entity/fact type ×2 boosts. **Keep the LLM extractor** (maintainer's
      choice), but make it not run by default. Options: (a) opt-in flag / run
      only for compound or type-specific queries, defaulting to a cheap path
      (direct `q_vec`→`entities` vector match ∪ substring); or (b) keep it always
      but swap to a fast/turbo model for this trivial extraction (~1-2s). Then
      the timeout can drop to ~5-10s. See the conversation analysis; the two
      call sites are `engine._phase1` and `kl_server._seeds_for_query` (both now
      share one match — fixing the one function fixes both).
- [ ] Reconcile the `/entity` vs `/timeline` missing-resource convention:
      `/entity` returns an empty `200`, `/timeline` returns `404`. Pick one.
- [ ] **Unify per-source metadata storage.** Chat-specific fields
      (`sender`, `sender_id`, `conversation_id`, `reply_to`) live in the
      `messages` detail table, but other sources have their own structured
      metadata too (mail: from/to/cc/subject; minutes: speakers; calendar:
      organizer/attendees; report: creator/dept). Right now non-chat extras go
      into the free-form `chunks.metadata` JSON (not indexable/joinable), while
      chat gets a typed table — an inconsistency. Design one coherent scheme for
      queryable per-source metadata (e.g. a shared typed "participants" concept
      for sender/receiver/attendee across sources, or a metadata table with
      indexed keys) so cross-source queries like "facts involving person X"
      work regardless of source. **For now keep the `messages` table as is**;
      this is a later consolidation, not an immediate change. Related: chat
      `content`/`timestamp` are currently duplicated in both `messages` and
      `chunks` — could drop them from `messages` and join to `chunks`.

---

## 2. Human TODOs

- [x] **Extract entities/facts from every source folder.**
        - Phase A: Chunking: during this phase, all the folders can parsed
            and according to the parser, and then
            is truncated by delimiters. And then saved to the db (SQLite for now).
        - Phase B: after all the chunks are done, you should start the entity and
            facts extraction on all chunks, and build the graph. Just like
            the current self.run_extraction and self.run_graph_build.
            But this build (the whole Phase B) should be a background/non-blocking
            job which we can use kl command (`status`) to monitor the progress.
      → [docs/todo/extract-nonchat-sources.md](docs/todo/extract-nonchat-sources.md)
      `[DONE]` 10/10 checklist items. In-server `POST /ingest` runs Phase A
      (chunk+embed all folders) → Phase B (extract+graph, background task) →
      periodic improvement → atomic graph hot-swap, without restarting the
      server. Progress via `kl status`. Verified end to end on a tiny 2-source
      fixture: a chat query surfaced wiki-sourced facts through shared entities.
- [x] **Ingest additional data sources** (documents, meetings, calendar) via
      per-source `Chunk` adapters — the payoff of the `Chunk`/`chunks` work.
      → [docs/todo/ingest-sources.md](docs/todo/ingest-sources.md)
- [x] Merge the graph_retrieve function in graph_walk, and the query function
      in engine.py. They have a lot of reusable logics.
      → [docs/todo/merge-sources.md](docs/todo/merge-sources.md)
      → DONE: collapsed `/graph_retrieve` into `/ask` (one query entry point;
        Phase 1 = engine.query, Phase 2 = graph walk over the reused
        entities/facts, one LLM call; synthesis kept but default-off).
- [ ] **Deduplicate & resume embedding** — never embed the same chunk twice.
      Phase A embedding over the full corpus is ~55 min through the inkflow
      gateway, and a crash/restart part-way re-pays the *entire* cost: Qdrant
      points are keyed by list position (not chunk identity), a single bulk
      upsert happens only at the very end (nothing persists until 100%), and
      `_phase_a_complete()` is all-or-nothing so any shortfall re-runs Phase A
      from 0. Plan: deterministic UUID5 Qdrant point ids (chunks/entities/facts,
      also fixes a latent positional-id correctness bug) + incremental flush +
      skip-existing on resume, plus in-batch content-identical dedup.
      → [docs/todo/embedding-dedup.md](docs/todo/embedding-dedup.md)

- [ ] **Chat: stop mapping one message → one chunk.** The chat loader currently
      emits exactly one `Chunk` per DingTalk message (drop-empty aside). Single
      messages are often tiny, context-poor fragments ("好的", "收到", a bare
      @mention), which hurts retrieval (many near-duplicate low-signal chunks)
      and entity/fact extraction (no surrounding context). In the future, group
      consecutive messages within a conversation into coherent, token-budgeted
      chunks — e.g. merge by same-sender runs and/or a time-gap + reply-thread
      window, prefixing each line with its speaker so attribution survives
      (mirroring the minutes transcript-chunking approach). Kept as 1→1 for now
      per maintainer's request while adapting loaders to the new DWS format.

---

## Completed

- [x] Generalized the SQLite side toward the unified `chunks` collection: added a
      generic `chunks` table (`id, content, source_type, timestamp, source_ref,
      embedding_id, metadata`) with a `source_type` column + index; `messages`
      dual-writes into it; `fts.py` BM25 mirror now built from `chunks`. Landed
      with the multi-source loaders.
- [x] `/graph_retrieve` surfaces embedding-recalled `chunks` in graph mode (not
      just the `chunks_only` fallback), reusing Phase-1's `q_vec` + matched
      entities so the walk adds no second LLM call.
- [x] `Chunk` base class + `Message` subtype; unified Qdrant `chunks` collection
      with `source_type` (foundation for multi-source ingest)
- [x] Hybrid retrieval (dense ANN + BM25 sparse + structural) fused with RRF
- [x] litellm/DashScope migration (LLM + embeddings)
- [x] Agent-facing retrieval: GraphRAG walk + `search`/`ask` split
- [x] `QDRANT_EXACT_SEARCH` toggle (exact brute-force cosine vs approximate HNSW)
- [x] Community embeddings (separate Qdrant store)
- [x] Persistent retrieval server (kl-server :8200, <50ms warm queries)
- [x] Thin CLI client (no heavy imports)
- [x] SQLite timeline optimization (auto-filter high-degree entities, covering indexes)
- [x] In-memory adjacency index (1-hop expansion; future ego subgraph)
- [x] Search budget & stop criteria in SKILL.md
