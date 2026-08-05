# Extract Entities/Facts from Every Source Folder

**Status:** Not started. Non-chat sources are loaded + embedded as retrieval
chunks (done, see `ingest-sources.md`) but never go through LLM extraction, so
they contribute **no entities, facts, or edges** to the graph. This redefines
the pipeline into two clean phases and makes the graph build a monitorable
background job.
**Depends on:** the multi-source loaders (done — `kl_graph/ingest/loaders/`) and
the unified `chunks` store (done). This closes the loop those opened.

> Annotation tags (see AGENTS.md): `[!RED]` = pay extra attention;
> `[REMARK]` = anticipated approach; `[Q agent]`/`[Q human]` = open question,
> answered on the next line with `[A human]`/`[A agent]`. Answered threads stay.
> Under the `todo-driven-implementation` skill, an unanswered `[!RED][Q]` means
> do not implement that piece yet.

## The problem

The current pipeline treats sources asymmetrically. Its two phases are:

- **`run_extraction()`** — the only LLM-billed step. It loads **chat messages
  only** (`load_all_messages`), extracts entities+facts per message, and caches
  to `extraction_cache/`. The six non-chat sources are never touched here.
  - [REMARK] We need a new function that is responsible for loading and parsing
           the raw inputs and save the chunks to db. And the run_extraction()
          and run_graph_build() can be merged into one funciton which can be
          ran in brackground.
- **`run_graph_build()`** — no LLM. Builds entities/facts from the chat cache,
  embeds chat, then `_ingest_sources()` loads minutes/mail/wiki/doc/aitable/
  calendar/report as `Chunk`s into SQLite + Qdrant, then creates edges — but
  only from the chat-derived entities/facts.

The consequence: non-chat content is **retrievable by vector/BM25 similarity**
(it lives in `chunks`) but is **absent from the graph** — no entities, no facts,
no `ABOUT`/`MENTIONS`/`STATES` edges, no participation in community detection,
disambiguation, or PageRank, and unreachable by the graph walk (`kl hop`,
`/ask` Phase 2). So the "knowledge graph" is really a *chat* knowledge graph
with a bag of searchable documents bolted on.

## Target design — redefine the two phases

Every source folder must go through entity/fact extraction. Restructure the
pipeline into two cleanly separated phases (this re-labels what "Phase A/B"
mean vs. the current code):

### Phase A — Chunking (all folders → SQLite)

Parse **every** source folder with its parser/loader, truncate by delimiters
into chunks, and persist them to the DB (SQLite for now). No LLM in this phase.

- You can refer to [ragflow](~/Desktop/projects/rag_research/ragflow/) parser as   an example of how you would parse the difference sources.
- Chat is folded in as just another source: chat messages are `Chunk`s too, so
  Phase A produces one unified `chunks` table spanning all folders.
- Most of this already exists (`loaders/` + `_ingest_sources()` +
  `insert_chunks`); the work is to (a) route chat through the same chunk path
  and (b) make Phase A a standalone step that ends at "all chunks in SQLite,"
  with no embedding/extraction mixed in.
  [Q human] can these function be directly reused to the chunking? Can you verify?
  `[A agent]` Mostly yes — verified against the code:
  - All seven non-chat loaders already return `list[Chunk]` and
    `_ingest_sources()` already calls `insert_chunks()` → the chunks table.
    Reusable as-is for Phase A.
  - Chat is *already* chunk-compatible: `Message(Chunk)` is a subclass
    (`models/types.py:72`, `source_type="message"`) and `insert_messages()`
    already dual-writes into `chunks` (via `insert_chunks`) plus the `messages`
    detail table. So chat needs **no new chunking** — `load_all_messages` +
    `insert_messages` already lands chat in the unified `chunks` table.
  - What's *not* reusable directly: today embedding + extraction are entangled
    inside `run_graph_build` (steps B.6/B.6b), and `_ingest_sources` both loads
    **and** embeds in one call. To make Phase A end cleanly at "chunks (+ per
    the answer below, vectors) in the DB," the load/persist step must be split
    out from the entity/fact extraction + edge build. So: reuse the loaders and
    `insert_chunks` unchanged; refactor the *orchestration* so Phase A is
    load+persist(+embed) only and Phase B owns extraction+graph.
  - One gap: the message loader still expects a flat `chat/messages/*.json`; the
    real export nests `chats/{groups,personal}/<name>/history.json`. A staging
    /flatten step (or a recursive glob in the loader) is needed regardless.
- `[Q agent]` "truncated by delimiters" — reuse the existing per-source
  splitters (`_split_markdown` for wiki/doc, the token-budgeted mergers for
  minutes/aitable) as the delimiter logic, or introduce one shared
  delimiter-based chunker across all sources?
  `[A human]` Can you check the ragflow logic on delimiters?
            And write your answer here?
  `[A agent]` Checked `rag/nlp/__init__.py` (`naive_merge` + `get_delimiters`).
  RAGFlow uses **one shared chunker** driven by a delimiter string, not a
  splitter-per-source. How it works:
  - Default `delimiter="\n。；！？"` — i.e. newline + Chinese sentence-enders.
    `get_delimiters` turns the string into a regex alternation; backtick-wrapped
    substrings (e.g. `` `\n\n` ``) are treated as multi-char delimiters, so a
    user can configure their own.
  - `naive_merge(sections, chunk_token_num=128, delimiter, overlapped_percent)`:
    for each section, if it's already under `chunk_token_num` it's emitted
    whole; otherwise it's split at the delimiters, then `add_chunk` **greedily
    re-merges** consecutive pieces up to `chunk_token_num`, carrying an
    `overlapped_percent` prefix from the previous chunk. So delimiters define
    the *cut points* and the token budget defines the *chunk size* — both
    together, not either alone.
  - Special case: if the delimiter string contains backtick-wrapped **custom**
    delimiters, each split segment becomes its own chunk and the token budget is
    ignored (hard cut).
  Recommendation for us: adopt RAGFlow's model — **one shared delimiter+token
  chunker** (a `naive_merge`-style helper) as the default for prose sources
  (wiki/doc/mail), parameterized by a delimiter string and a token/char budget.
  Keep the *structured* sources (minutes transcript merge, aitable
  one-chunk-per-table) on their bespoke logic, because their "delimiters" are
  structural (speaker turns, table rows) not sentence punctuation. This matches
  what we already have: our `_split_markdown` is a heading-aware variant of the
  same idea; we'd generalize it into the shared chunker and route prose through
  it, rather than maintaining N ad-hoc splitters.
- `[Q agent]` Embedding currently happens inside `run_graph_build` (B.6/B.6b).
  Does it stay in Phase B (with extraction + graph build), or move into
  Phase A next to chunking (so Phase A = "chunks + vectors persisted")?
  `[A human]` Embedding needs to move to Phase A, so when phase A is done,
            we can have a useable flat/vector rag already, and when phase B
            is done silently on the background, we can switch to a more powerful
            flat/vector rag + graph rag without the users noticing.
  `[A agent]` Agreed and clear. Implication: Phase A = load → chunk → persist to
  SQLite → embed into Qdrant, so at end-of-A the server can already serve
  dense+BM25+RRF over all sources. Phase B adds only the graph layer. Note the
  FTS/BM25 mirror is built from `chunks`, so it lights up as soon as Phase A
  persists — no extra step.

### Phase B — Extraction + graph build (background job, monitorable)

After all chunks exist, run entity/fact extraction over **all chunks** (not just
chat) and build the graph — the analog of today's `run_extraction` +
`run_graph_build`, but source-agnostic.

- Extraction iterates every chunk in SQLite regardless of `source_type`. The
  extractor already caches by content hash, so re-runs stay cheap.
- Facts/entities attach to the **chunk** they came from (a message is a chunk),
  so a fact extracted from a wiki/mail/minutes chunk gets `STATES`/`ABOUT`
  edges exactly like a chat-derived fact.
- Authors/speakers/participants already sitting in chunk `metadata` (minutes
  speakers, mail from/to, report creators) become Person entities with
  attribution edges. `[REMARK]` overlaps the deferred `contacts` →
  entity-disambiguation item in `ingest-sources.md`; do them together so
  花名/real-name variants resolve.

**Phase B runs as a background / non-blocking job**, and its progress is
observable via the `kl status` command.

- `[!RED][Q agent]` **Foundational invocation question (RESOLVED).** The human's
  constraints — "never stop/pause the server" + Qdrant is single-writer + Phase B
  runs in-server + embedding moves to Phase A — taken
  together imply the **entire** pipeline (Phase A load+chunk+embed *and* Phase B
  extract+build) must run **inside `kl_server`**, because only the server process
  can write to Qdrant while it's serving. That means ingestion can no longer be a
  standalone `python -m scripts.ingest` process (it would fight for the Qdrant
  lock or require stopping the server).
  Proposed model: a new HTTP endpoint `POST /ingest {export_dir}` (driven by a
  new `kl ingest <folder>` CLI command) that: runs Phase A inline (or as a
  server-owned background task), then auto-chains Phase B as a background task,
  with `/status` reporting overall percent. `scripts/ingest.py` stays only for
  offline/cold builds when the server is down.
  Is this the intended architecture? Specifically: **does Phase A also run
  in-server via `kl ingest`, or does Phase A stay a script and only Phase B move
  in-server?** (If Phase A stays a script, we either accept stopping the server
  for Phase A, or Phase A writes only SQLite and the server embeds later — both
  contradict "usable vector RAG the moment Phase A ends.")
  `[A human]` Yes, you are right. So the Phase A and Phase B all should be
            running inside the kl_server

- `[!RED][Q human]` What granularity should `kl status` report for a running
  Phase B — overall percent, per-phase step (extraction vs. edge build vs.
  community detection), counts (chunks extracted / entities / facts / edges so
  far), and ETA? Which of these are must-haves?
  `[A human]` Overall percentage is good.
- `[Q agent]` Where does the background job run and how is its state tracked so
  `kl status` (a thin HTTP client → `kl_server`) can read it? Options: the job
  runs inside `kl_server` (a background task + an in-memory/DB progress record
  the existing `/status` endpoint extends), or a separate worker process that
  writes progress rows to SQLite which `/status` reads. The server owns the
  single Qdrant writer lock, which argues for running it in-server.
  `[A human]` I would prefer the job runs inside the kl_server, we can discuss
            in details when implementing.
- `[Q agent]` Is Phase B triggered by a new `kl` command (e.g. `kl build` /
  `kl ingest`), or automatically after Phase A completes?
  `[A human]`it should be automatically triggered when phase A compeltes.
- `[Q agent]` Concurrency vs. the live server: extraction + build mutate SQLite
  and Qdrant while the server is serving queries. Do we accept serving stale
  results during a build, pause serving, or build into a side DB and swap?
  `[A human]` The phase B's results should only be dumped into SQLite and Qdrant
            All the extractions are done, and we should not restart/pause the
            server or the service.
  `[A agent]` Understood: extract everything first, then commit to SQLite+Qdrant
  in one shot, no restart. Two consequences I'll design around:
  - **Adjacency hot-swap.** The graph walk reads `state.adjacency`, an in-memory
    index built once at startup from the `edges` table (`_build_adjacency` in
    the lifespan). Writing new edges to SQLite does *not* update it. Since
    Phase B runs in-process, after the commit it will **rebuild the adjacency
    from the updated edges table and atomically swap the reference** (and
    refresh community labels) — no process restart, satisfying the constraint.
  - **Qdrant single-writer lock.** Qdrant is single-writer (portalocker); the
    server already holds the client. Because Phase B runs in-server, it reuses
    that client and there is no lock contention. This is the strongest reason
    the job must live in-server, and it also constrains Phase A (next question).

## Why it matters

- **Graph walk reaches the richest sources.** Minutes (transcripts + action
  items), mail (decisions/threads), wiki (authored knowledge) become reachable
  by `kl hop` / `/ask` Phase 2 instead of being similarity-only.
- **Community detection spans sources.** Communities are computed over the full
  cross-source entity/fact graph, so topics cluster across chat + docs + mail.
- **Hybrid retrieval is whole again.** The structural half (entity → chunks/
  facts expansion) and RRF fusion finally have structure for non-chat chunks.

## Implementation checklist (all `[!RED]` questions answered — ready to implement)

- [x] **Phase A:** one load→chunk→embed→persist step landing all folders (chat
      included) in SQLite `chunks` + Qdrant, so vector+BM25 RAG is usable at
      end-of-A. Reuse the existing loaders + `insert_chunks`/`insert_messages`
      unchanged; split load/persist/embed out of `run_graph_build`.
      `[DONE]` `run_phase_a()` = load → `_persist_chunks()` → `_embed_chunks()`
              (no LLM). `run_phase_b()` = `run_extraction()` + `run_graph_build()`
              (graph only). `run_full` chains A then B. Verified offline: Phase A
              yields chunks with 0 entities; Phase B adds the graph.
- [x] Generalize the prose chunker: promote `_split_markdown` into a shared
      `naive_merge`-style delimiter+token chunker (default `\n。；！？`, token
      budget, overlap) for wiki/doc/mail; keep minutes/aitable bespoke.
      `[DONE]` `kl_graph/ingest/chunker.py` (`chunk_text`, char-budget proxy,
              heading-aware, overlap). `wiki_loader._split_markdown` now delegates
              to it. Tests: `tests/test_chunker.py`.
- [x] Flatten/recursive-glob the nested chat export (`chats/{groups,personal}/
      <name>/history.json`) so the message loader actually finds it.
      `[DONE]` `config._chat_root()` resolves `chat/messages` (flat) or `chats`
              (nested); `load_all_messages` recursively finds `history.json`,
              else flat `*.json` (skips `_*`/`index.json`). Tested both layouts;
              loads 40,334 msgs from the real export.
- [x] **Phase B:** generalize extraction to iterate every chunk (all
      `source_type`s), not just messages.
      `[DONE]` Extractor flat path typed `Chunk` + `_sender_of()` fallback;
              pipeline iterates `all_chunks()` for entity/fact/MENTIONS/STATES/ABOUT.
- [x] Rekey `Fact` source/id from message → chunk (message stays a chunk); emit
      `STATES`/`ABOUT` edges for facts from any chunk.
      `[DONE]` `Fact.source_message_id` holds the source chunk id (message id ==
              chunk id, so chat is unchanged); `/context` resolves against the
              universal `chunks` table with a chat-only `source_message` extra.
- [x] Author/speaker/participant → Person entities + attribution edges
      (coordinate with the `contacts` disambiguation item).
      `[DONE]` `_participants_of(chunk)` pulls names from chat `sender` + non-chat
              metadata (mail from/to/cc, calendar organizer/attendees, minutes
              speakers, report creator); `_build_entities` makes them Person
              entities and `_create_edges` emits SENT_BY (deduped per chunk).
              Verified across all four source shapes.
- [x] Run Phase B in-server as a background task; on completion, commit to
      SQLite+Qdrant, rebuild `state.adjacency`, and atomically swap it in (no
      restart).
      `[DONE]` `kl_server.py`: `POST /ingest` → `asyncio.create_task(_run_ingest_job)`;
      sync work via `asyncio.to_thread`; `_shared_stores()` reuses the server's
      warm SQLite conn + single Qdrant writer (injected into `IngestionPipeline`
      + `run_periodic_improvement`, which now skip opening/closing their own
      stores). `_hot_swap_graph()` rebuilds adjacency+pagerank and swaps by
      atomic ref assignment. Verified: health stayed OK throughout the run.
- [x] Auto-trigger Phase B when Phase A completes.
      `[DONE]` `_run_ingest_job` chains Phase A → extraction → graph build →
      improve → hot-swap in one task.
- [x] Report overall-percent progress via `/status` + `kl status`.
      `[DONE]` `state.ingest_progress` ({state,phase,percent,detail,error});
      `/status` returns it; `kl status` prints `Ingest: <state> <pct>% (phase)`.
      Observed 0→40→70→100% live.
- [x] Re-run community detection / PageRank over the cross-source graph.
      `[DONE]` `run_improve=True` calls `run_periodic_improvement` with injected
      stores; Leiden L0–L3 ran over the 5-entity/3-fact cross-source graph.
- [x] Verify a `kl hop` from a chat entity can reach a wiki/minutes/mail node.
      `[DONE]` Tiny fixture (2 chat msgs + 1 wiki doc): `kl ask "sandbox 隔离"`
      returned a connected subgraph spanning the chat fact (`m1`) and two wiki
      facts (`wiki:node1:0`) bridged via shared `gVisor`/`sandbox` entities.

## Open questions from the human

- `[Q human]`
  `[A agent]`
