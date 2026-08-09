# kl-graph: Spatio-Temporal Knowledge Graph

A retrieval system that ingests DingTalk workplace data (chat, wiki, mail,
meeting minutes, and more), extracts entities and facts via an LLM, builds a
multi-resolution knowledge graph with community detection, and serves queries
through a persistent FastAPI server queried by a thin CLI.

## Agent Quickstart (end-to-end workflow)

If you are an agent driving this repo end to end, follow these three steps in
order. (Human readers can skip to [Architecture](#architecture); the detailed,
manual instructions live in [Data Preparation](#data-preparation),
[Pipeline](#pipeline), and [Querying](#querying) below.)

1. **Download the DingTalk data.** Use the `dws-personal-data-dump` skill
   (`skills/dws-personal-data-dump/SKILL.md`) to export the DingTalk
   data into the canonical folder layout. **By default, export only the last 30
   days of data** — unless the user explicitly asks for a different range (e.g.
   "all history", "last 90 days", a specific month), in which case honor their
   request. **Store the export under the system temp directory** so it works on
   both macOS and Windows: use `${TMPDIR:-/tmp}/dws_export` on macOS/Linux and
   `%TEMP%\dws_export` on Windows (equivalently, Python
   `os.path.join(tempfile.gettempdir(), "dws_export")`). The directory is passed
   to `kl ingest` at runtime; `KL_DWS_EXPORT_DIR` is only needed by the offline
   `scripts.ingest` workflow.
2. **Start the server and ingest the freshly downloaded data.** Bring up the
   retrieval server, then run the normal incremental ingest (Phase A + Phase B)
   over the new export. On an empty index this naturally performs the initial
   build:
   ```bash
   set -a; source .env; set +a          # load endpoints/keys
   ./kl start                           # start the retrieval server
   ./kl ingest -d /path/to/dws_export --source-id dingtalk-personal
   ./kl status                          # poll until ingest completes
   ```
   Note: the service is usable as soon as **Phase A** completes; **Phase B**
   keeps running to improve accuracy (see the ingest notes below).
3. **Prompt the user to ask questions.** Once the whole ingestion has finished
   (`kl status` shows it done), tell the user the knowledge base is ready and
   invite them to ask questions — then answer via `kl ask` (see
   [Querying](#querying)).

## Architecture

```
DingTalk DWS Export → Ingestion (Phase A + B) → SQLite + Qdrant → Retrieval Server → CLI
```

Three stages:

1. **Ingestion** — two phases plus finalization:
   - **Phase A** scans every source folder, filters already-recorded source
     units, then chunks, atomically persists lineage, and embeds the new chunks.
     No LLM; dense + BM25 recall works after this.
   - **Phase B** runs LLM entity/fact extraction over the selected chunks, then builds
     and embeds the graph (entities, facts, structural edges). This is the only
     LLM-billed phase; results are cached per chunk in the separate, bounded
     `extraction_cache.db` and remain replayable across database rebuilds.
   - **Finalization** builds similarity edges (ENTITY_SIMILAR, FACT_SIMILAR),
     runs community detection (Leiden L0–L3), entity disambiguation, and
     community summarization + embedding. Re-runnable standalone with different
     parameters via `scripts/improve.py`.
2. **Incremental Ingestion** — every server-side ingest scans a local export and
   processes only unseen source units. Deduplication uses
   `(source_id, source_type, unit_id)`, not timestamps. Messages are filtered
   before session chunking, so a late-arriving message becomes a new chunk;
   large document units may map to several ordered chunks.
3. **Retrieval** — a FastAPI server that keeps SQLite + Qdrant warm and holds an
   in-memory adjacency index, plus a `kl` CLI that talks to it over HTTP.

All LLM and embedding calls go through **litellm** (OpenAI- and
Anthropic-compatible transports), selected by the model/endpoint you configure.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Python 3.12+ | System Python or a managed install |
| OpenAI-compatible embedding endpoint | For vector search (remote or local) |
| Anthropic/OpenAI-compatible LLM endpoint | For entity/fact extraction + query synthesis |
| CUDA GPUs | Only for the *optional* local embedding server; not needed with a remote endpoint |
| ~2 GB disk | Runtime data (SQLite + Qdrant vectors), scales with corpus |

## Installation

```bash
cd /path/to/kl-graph

# Create a venv (add --system-site-packages to inherit local PyTorch/CUDA)
uv venv .venv --python 3.12

# All dependencies (server + graph improvement) are in the main [project.dependencies]
uv pip install -e .
```

### requirements.txt

`requirements.txt` remains available for core-only/manual environments.
`pyproject.toml` is the authoritative dependency list; `click`
is a core project dependency used by the CLI.

## Configuration

`config.default.yaml` contains the complete shipped defaults, organized as
`application`, `server`, `services`, `storage`, and `pipelines`. Override it with a local,
gitignored `config.yaml`, a CLI `--config` file, or `KL_*` environment
variables. The Pydantic models in `kl_graph/config.py` are the authoritative
schema: unknown or missing fields fail at startup. They can also emit JSON
Schema through `AppConfig.model_json_schema()` for editor integration.
Persistent settings belong in this schema; CLI/request arguments are reserved
for runtime overrides and one-off actions, with CLI values taking precedence.

Environment variables are recommended for secrets — **no endpoints or secrets
are baked into the repo**. The recommended workflow is a local, gitignored `.env`
at the project root that you source before starting the server. Nothing
auto-loads it:

```bash
set -a; source .env; set +a      # export every KL_* + ANTHROPIC_AUTH_TOKEN
```

Example `.env`:

```bash
# --- data + export locations ---
export KL_DATA_DIR=./data                      # knowledge/cache DBs + qdrant
export KL_DWS_EXPORT_DIR=/path/to/dws_export   # offline scripts.ingest default only

# --- embedding endpoint (OpenAI-compatible, routed via litellm) ---
export KL_EMBED_BASE_URL=https://your-embed-endpoint/v1
export KL_EMBED_MODEL=Qwen3-Embedding-8B
export KL_EMBED_API_KEY=your-embed-key         # empty for an unauthenticated local vLLM
export KL_EMBEDDING_DIM=4096                    # MUST match the model's output dim
export KL_EMBED_SEND_DIMENSIONS=0              # 1 only for matryoshka servers (v4)

# --- embedding behavioral params (ingestion path) ---
export KL_EMBED_BATCH_SIZE=10                  # texts per API call
export KL_EMBED_CONCURRENCY=10                 # parallel API calls
export KL_EMBED_MAX_RETRIES=6                  # retry on transient errors
export KL_EMBED_TIMEOUT=60                     # per-call timeout (seconds)

# --- embedding behavioral params (query path) ---
export KL_QUERY_EMBED_MAX_RETRIES=2            # fail fast (user is waiting)
export KL_QUERY_EMBED_TIMEOUT=30               # shorter than ingestion

# --- extraction / synthesis LLM (Anthropic-compatible, routed via litellm) ---
# For an Anthropic-compatible base, do NOT append /v1 (litellm adds /v1/messages).
export KL_LLM_FLASH_BASE_URL=https://your-llm-endpoint
export KL_LLM_FLASH_PROVIDER=anthropic             # LiteLLM provider prefix
export KL_LLM_FLASH_MODEL=qwen3.6-flash
export ANTHROPIC_AUTH_TOKEN=your-llm-key       # used as the LLM API key
export KL_EXTRACTION_CACHE_MAX_ENTRIES=100000  # rolling LRU row limit
# Force litellm onto its httpx transport (kl-graph also sets this in code).
# Its default aiohttp transport raises `'ascii' codec` UnicodeEncodeError when a
# gateway returns a non-ASCII response header. Value MUST be "True" (not "1").
export DISABLE_AIOHTTP_TRANSPORT=True

# --- optional: reranker, server ports, local GPU embedding ---
export KL_RERANK_BASE_URL=                      # optional cross-encoder rerank
export KL_RERANK_MODEL=
export KL_RERANK_API_KEY=
export KL_SERVER_PORT=8200                       # default
export KL_EMBED_PORT=8100                        # default (local embedding server)
export KL_LOCAL_EMBED_MODEL_PATH=/data/models/Qwen/Qwen3-Embedding-8B

# --- graph backend (LadybugDB is installed and used by default) ---
export KL_GRAPH_BACKEND=ladybug                  # "ladybug" (default) | "sqlite" (fallback, no graph dependency)
# LadybugDB engine options (0 = Kuzu auto-detection):
# export KL_LADYBUG_READ_ONLY=0                 # open graph read-only (query-only deployments)
# export KL_LADYBUG_BUFFER_POOL_SIZE=0           # buffer pool bytes (0 ≈ 80% of RAM)
# export KL_LADYBUG_MAX_NUM_THREADS=0           # max query threads (0 = auto)

# --- vector backend (Qdrant remains the default) ---
export KL_VECTOR_BACKEND=qdrant                  # "qdrant" | "zvec"
# Empty KL_QDRANT_HOST selects embedded local-file mode.
# export KL_QDRANT_HOST=localhost
# export KL_QDRANT_PORT=6333
# export KL_QDRANT_API_KEY=
# export KL_ZVEC_INDEX_TYPE=hnsw                 # hnsw | flat | ivf
# export KL_ZVEC_METRIC=cosine                   # cosine | ip | l2
```

The stable server port can also be set as `server.port` in YAML. For a
one-off override, use `./kl --port 8300 start` or run
`python kl_server.py --port 8300` directly; the CLI option takes precedence.

> **Embedding dimension.** `KL_EMBEDDING_DIM` is baked into the vector-store
> collections at creation time. Pick the value that matches your model
> (e.g. 4096 for Qwen3-Embedding-8B, 1024 for Qwen3-Embedding-0.6B). Changing
> models later requires wiping `$KL_DATA_DIR` and re-embedding everything.

Local Qdrant data lives in `data/qdrant_data/` and
`data/qdrant_communities/`; Zvec uses `data/zvec_data/` and
`data/zvec_communities/`.

> **Windows users.** Add `set PYTHONUTF8=1` to your `.env`. Without it, the
> Python console defaults to GBK / cp1252 and any `print()` or log line
> containing emoji or non-ASCII characters (common in Chinese group/doc names)
> will crash with `UnicodeEncodeError`. macOS and Linux are unaffected
> (already UTF-8).

## Data Preparation

### The unified DWS export format

The pipeline reads a **DingTalk Workspace (DWS) export** where every product
lives in its own directory under the `input_dir` supplied to `kl ingest` (or
under `$KL_DWS_EXPORT_DIR` for the offline script) and shares the same on-disk
"quartet":

```
dws_export/
├── chat/          # group/1:1 messages        (bespoke loader → Message)
│   ├── manifest.json
│   ├── scopes.jsonl      # containers/hierarchy: {id, type, parent_id, data}
│   ├── records.jsonl     # content items:        {id, scope_id, type, data}
│   └── resources.jsonl   # attachments:          {id, kind, uri, local_path, ...}
├── wiki/          # documents                  (bespoke loader → doc sections)
├── mail/          # email                      (bespoke loader → subject+body)
├── minutes/       # AI meeting minutes         (bespoke loader → summary + transcript)
├── work/          # tasks/approvals            ┐
├── contacts/      # org contacts               │ generic loader
├── attendance/    # attendance                 │ (flattens each record to text)
├── calendar/      # calendar events            │
└── drive/         # drive files                ┘
```

Each loader first normalizes its records into caller-owned source units,
identified by `(source_id, source_type, unit_id)`, and then maps them into
generic `Chunk`s.
Chat fields such as `conversation_id`, `sender`, and `reply_to` live in chunk
metadata; there is no separate `Message` node type.
Structured sources (chat/wiki/mail/minutes) have bespoke mappers; every other
folder flows through the generic flattener, so all folders ingest without a
whitelist. Absent folders are simply skipped.

Records carry a common envelope; e.g. a chat message record:

```json
{
  "id": "msg:...",
  "scope_id": "chat:...",
  "type": "message",
  "data": {
    "openMessageId": "msg...",
    "openConversationId": "cid...",
    "sender": "张三",
    "content": "消息文本",
    "createTime": "2026-06-18 21:13:39",
    "quotedMessage": { "openMessageId": "msg..." }
  }
}
```

Empty-content messages are dropped; `quotedMessage.openMessageId` becomes a
`REPLY_TO` edge; the conversation title comes from the linked `scope`.

### Source units and chunk lineage

SQLite records input identity separately from retrieval chunks:

- `units` deduplicates `(source_id, source_type, unit_id)` and records the
  observed content hash.
- `chunks` stores framework-owned retrieval text and its content hash.
- `chunk_units` is the ordered many-to-many mapping. Its
  `unit_ordinal_in_chunk` orders merged messages, while
  `chunk_ordinal_in_unit` orders pieces of a split message or document.
- `ingest_batches` and `ingest_batch_chunks` hold the crash-resumable chunk
  workset consumed by embedding, extraction, and graph building.
- `ingest_runs` persists `/status` progress and errors across server restarts.

Chunk rows and their unit/membership rows share the checkpointed
`phase_a.persist_chunks` transaction: the checkpoint is marked complete only
after the canonical rows and batch workset have committed. Failed runs retain
the workset; successful runs mark completion before cleaning it up.

See [Ingestion Deduplication Design](docs/ingestion-dedup-design.md) for the
identity contract, behavior table, chunking changes, and crash semantics.

### Exporting from DingTalk

This repo includes a self-contained skill
(`skills/dws-personal-data-dump/`) with scripts that produce the export
above. See `skills/dws-personal-data-dump/SKILL.md` for the full
pipeline. Pass the resulting directory to `kl ingest --input-dir`; set
`KL_DWS_EXPORT_DIR` only when using the offline ingestion script.

## Pipeline

The simplest path drives the entire build **through the running server** with
`kl ingest`. There is also an offline scripted path for cold/headless builds.

### Option 1 — in-server ingest (recommended)

```bash
set -a; source .env; set +a
./kl start                      # start the retrieval server (ingest runs inside it)
kl status                       # wait for "status": "ready"

kl ingest -d /path/to/dws_export --source-id dingtalk-personal
kl status                           # persisted run, phase, counts, and errors

# Community summaries are NOT produced by kl ingest — add them once the graph
# is built so `search -c communities` and community labels work:
python -m kl_graph.periodic.community_summarizer
python scripts/embed_communities.py
```

`input_dir` is a path on the server's local filesystem; source data is not sent
in the HTTP body. `source_id` is a stable namespace for the producer, so exports
from multiple IM systems can safely share one index once normalized into the
supported on-disk layout, even when their native ids overlap. Repeating the same
source-unit id skips it. A same-id/different-content update is detected and
warned about but remains a TODO in this version.

The equivalent HTTP request is:

```http
POST /ingest
Content-Type: application/json

{"input_dir":"/path/on/server/dws_export","source_id":"dingtalk-personal","improve_mode":"auto"}
```

If another run is active, the request is persisted and queued. Poll
`GET /status`; its `ingest` object reports the run/source ids, phase, percent,
unit counters, chunk count, and any error.

`kl ingest` has no wipe flag; for a clean rebuild use the offline `--fresh-db`
workflow below. Improvement defaults to `auto`: it seeds a missing community
baseline with one global pass, then uses batch-targeted similarity and frontier
community updates. `--no-improve` disables it; `-c N` raises extraction
concurrency.

The HTTP `improve_mode` field accepts `auto`, `incremental`, `full`, or `off`.
`incremental` requires an existing full baseline; `full` forces the graph-wide
periodic pass. Selection is based on persisted community state, not timestamps
or an arbitrary run counter.
See [Ingest API and Cost Guide](docs/ingest-api.md) for queue/status semantics,
errors, retries, and the cost of every pipeline step.

To keep two knowledge bases physically separate, run them with different
`application.data_dir` / `KL_DATA_DIR` values. That separates `knowledge.db`,
local Qdrant, checkpoints, and the default Ladybug path; explicitly configured
external backend paths or graph names must also be distinct.

> **Improve phase.** The current improve phase uses Leiden; the HDBSCAN fact-topic
> path exists in code but is disabled. All improve dependencies (leidenalg,
> igraph, scikit-learn, pypinyin) are included in the main project dependencies,
> so no separate install is needed. Omit `--improve` to skip it. It reads and writes edges
> through the backend-agnostic store API, so it runs under either
> `KL_GRAPH_BACKEND=ladybug` (default) or `sqlite`.

### Option 2 — offline scripted build

```bash
set -a; source .env; set +a

# Ingest: Phase A + Phase B. --fresh-db wipes knowledge.db + Qdrant + the
# Ladybug graph, but preserves the rolling extraction_cache.db;
# with no flag it smart-resumes (skip Phase A if already embedded).
python -m scripts.ingest \
  --input-dir /path/to/dws_export \
  --source-id dingtalk-prod \
  --fresh-db --concurrency 50

# Improve (runs on either backend): ENTITY_SIMILAR/FACT_SIMILAR edges +
# disambiguation + Leiden L0–L3 communities.
python -m scripts.improve --skip-llm-judge

# Community summaries + embed them for community-level vector search
python -m kl_graph.periodic.community_summarizer
python scripts/embed_communities.py
```

`scripts.ingest` flags:

| Flag | Effect |
|------|--------|
| `--input-dir PATH` | Local export root containing `chat/`, `wiki/`, `mail/`, etc.; defaults to `application.dws_export_dir` |
| `--source-id ID` | Required stable namespace owned by the caller; unit deduplication uses `(source_id, source_type, unit_id)` |
| *(none)* / `--full` | Full pipeline with **smart resume** (skip Phase A if every chunk is persisted + embedded, else run it), then Phase B |
| `--phase-a` | Phase A only: load + chunk + embed (no LLM). Usable dense/BM25 RAG after this |
| `--extract-only` | Advanced: LLM extraction only, cache results (assumes Phase A ran) |
| `--build-only` | Advanced: build graph from cached results only, no LLM (assumes Phase A ran) |
| `--concurrency N` | Max concurrent extraction LLM calls (recommended: **50**) |
| `--improve-mode MODE` | `auto` (default), `incremental`, `full`, or `off` |
| `--fresh-db` | Delete `knowledge.db`, Qdrant, and the active Ladybug graph first; preserve `extraction_cache.db` |

The script and `POST /ingest` use the same unit-incremental runner and the same
source-specific checkpoint. There is no timestamp watermark or separate
incremental mode: every normal run skips unit IDs already stored for that source.
See [Ingestion Cost Profile](docs/ingestion-cost-profile.md) for the scaling and
resource characteristics of each phase.

`scripts.improve` runs the **finalization sub-phase** standalone (similarity edges +
communities). Useful for tuning parameters without re-running extraction. Flags
include `--entity-resolution` / `--fact-resolution` (Leiden),
`--fact-min-cluster` (reserved for the currently disabled HDBSCAN path),
`--skip-disambiguation`, `--skip-llm-judge`,
and `--llm-budget`.

### Optional: local GPU embedding server

If you self-host embeddings instead of using a remote endpoint:

```bash
./kl start embedding                 # 1 GPU, defaults
./kl start embedding --dp 4          # data-parallel across 4 GPUs
./kl start embedding --model /path/to/model --tp 2 --port 8100 --gpu-util 0.4
```

Otherwise just set `KL_EMBED_BASE_URL` to any OpenAI-compatible endpoint — no
local GPU needed.

## Querying

Start the server (if not already running), then use the `kl` CLI. `ask` and
`search` output **JSON by default** (agent-friendly); add `--pretty` for a
human view. Browsing commands (`entity`, `community`, …) are pretty by default
and accept `--json`.

```bash
./kl start                       # retrieval server on :8200 (~90s Qdrant warmup)
```

```bash
# Ask — hybrid retrieval (dense + BM25 + RRF over chunks & facts) plus an
# interactive depth-1 graph walk; optional LLM synthesis with --phase2.
./kl ask "数据同步用什么方案？"
./kl ask "谁负责网络白名单" --phase2 --pretty
# ask returns items + a hoppable subgraph (seeds/nodes/edges/expandable + cursor)

# Hop — continue an ask walk one node deeper (no embed, no LLM)
./kl hop -n "ent:<id>" -c '<cursor-json-from-ask>'

# Search — pure vector ANN over ONE collection
./kl search "数据同步"                          # facts (default)
./kl search "sandbox" -c chunks -k 20           # chunks (messages = alias)
./kl search "gVisor" -c entities
./kl search "网络白名单" -c communities

# Path — shortest path between two entities/facts in the knowledge graph
./kl path "李强" "杨帆"                        # single shortest path
./kl path "张伟" "黄磊" --all-shortest        # all shortest paths
./kl path "A" "B" --max-hops 3 --edge-types ABOUT,INVOLVES

# Entity lookup / alias resolution (no embedding needed)
./kl entity "张伟"
./kl expand <entity_id>                         # ENTITY_SIMILAR neighbors

# Community browsing (needs the summarize + embed steps above)
./kl community -l L1 -t entity
./kl community -l L2 --id 8
./kl members 8 -l L2 -t fact

# Fact provenance / timeline / stats
./kl context <fact_id>
./kl timeline "网络白名单" --from 2026-06-01 --to 2026-07-01
./kl stats
```

### Global search (conceptual questions)

`ask` answers targeted questions via hybrid recall over chunks and facts;
**global search** answers *conceptual* questions whose answers must be
aggregated over everything a person has been involved in — e.g.
"我最近的任务是什么". It runs a GraphRAG-style map-reduce over the current
user's community summaries (Leiden communities + their LLM summaries) and
returns a grounded markdown answer with community citations. It is read-only:
it never mutates the graph.

```bash
./kl global-search "我最近的任务是什么"
./kl global-search "我参与了哪些项目" --user "张伟"
```

**Identity.** The answer is anchored to one user. When `--user` is omitted,
the CLI resolves your identity itself via `dws contact user get-self`
(`--format json`, using `orgUserName`) and sends it to the server; if `dws` is
unavailable or unauthenticated, the server falls back to the `KL_CURRENT_USER`
environment variable:

```bash
export KL_CURRENT_USER="your-name"   # server-side default identity (put it in .env)
```

**Prerequisites.** Global search reads the `community_summaries` table in
SQLite, so community detection + summarization must have run first (see
[Pipeline](#pipeline)): `python -m scripts.improve` (or `kl ingest --improve`)
plus `python -m kl_graph.periodic.community_summarizer`. Running
`scripts/embed_communities.py` is **optional** for this command — the endpoint
reads the SQLite summaries directly and does not require the
`qdrant_communities` store.

**No-data behaviour.** Before summaries exist, for a user that cannot be
resolved to an entity, or for a user without community memberships, the
command returns a canned "unable to answer given the provided data" response
immediately and with **zero LLM calls** — it never guesses from arbitrary
corpus-wide communities.

**Cost and latency.** Each answered query makes multiple LLM calls — one per
summary batch in the map step plus one final reduce call — so expect
multi-second latency and corresponding LLM cost per query; the no-data paths
bill nothing.

**Reading citations.** Claims carry `[Data: Communities (L1-12, L2-3)]`
references naming the community summaries that support them (`L1-12` =
level L1, community 12; at most 5 ids, then `+more`). Browse a cited
community with `kl community -l L1 --id 12` or `kl members 12 -l L1 -t entity`.

### Server management

```bash
./kl status                   # server + DB stats + any running ingest progress
./kl start                    # retrieval server only
./kl start embedding          # local embedding server (GPU)
./kl stop                     # stop both servers
./kl stop embedding           # stop only the embedding server
```

## Project Structure

```
kl-graph/
├── kl                    # Shell entry point (→ kl_cli.py in the venv)
├── kl_cli.py             # Thin HTTP CLI client (click + httpx)
├── kl_server.py          # Persistent FastAPI retrieval server (port 8200)
├── kl_graph/
│   ├── config.py         # All env-based configuration
│   ├── ingest/
│   │   ├── pipeline.py       # Phase A/B orchestrator
│   │   ├── chunker.py        # heading/token-aware text chunking
│   │   ├── embedder.py       # litellm embedding client
│   │   ├── llm_extractor.py  # async batched entity/fact extraction + cache
│   │   └── loaders/          # per-source DWS loaders (chat/wiki/mail/minutes/generic)
│   ├── models/           # types: Chunk, Message, Entity, Fact, Edge + enums
│   ├── periodic/         # similarity, disambiguation, communities, summarizer
│   ├── query/            # engine, fts (BM25), graph_walk, pagerank, rerank, query_rewrite
│   ├── storage/          # SQLite + Qdrant + LadybugDB/FalkorDB graph backends
│   └── utils/            # RRF fusion, bounded async helpers
├── scripts/
│   ├── ingest.py             # offline ingestion (Phase A/B)
│   ├── improve.py            # offline periodic improvement
│   ├── embed_communities.py  # embed community summaries
│   └── query.py              # interactive REPL (direct engine, no server)
├── requirements.txt
├── .env                  # (gitignored) local endpoint/secret config
└── data/                 # (gitignored) runtime data
    ├── knowledge.db          # SQLite content/metadata; also edges when backend=sqlite
    ├── extraction_cache.db   # durable Phase-A LLM cache; rolling LRU, 100k rows by default
    ├── graph.ladybug/        # LadybugDB nodes/edges when backend=ladybug
    ├── qdrant_data/          # main vector store (chunks/entities/facts)
    └── qdrant_communities/   # community-summary vector store
```

## Running Without GPUs

Point `KL_EMBED_BASE_URL` at any remote OpenAI-compatible embedding endpoint
(set `KL_EMBED_API_KEY`), and everything works on CPU. Ensure `KL_EMBEDDING_DIM`
matches the endpoint's output dimension.

| Feature | Works without GPU? |
|---------|-------------------|
| `kl entity` / `community` / `members` / `timeline` / `context` / `expand` / `hop` / `path` / `global-search` | Yes (no embedding at all) |
| `kl search` / `kl ask` | Yes (with a remote embedding endpoint) |
| Ingestion Phase A (chunk + embed) | Yes (remote embedding endpoint) |
| Ingestion Phase B (LLM extract + graph build) | Yes (LLM + embedding endpoints) |
| Periodic improvement + community summaries | Yes (remote endpoints) |

## Notes

- **Identity and determinism.** Callers own source-unit identity; the composite
  `(source_id, source_type, unit_id)` makes normal ingestion idempotent.
  Framework-owned chunk ids are namespaced by `source_id`, while entity/fact
  ids remain deterministic UUID5s of normalized content.
- **Two query paths.** Production is `kl` → `kl_server.py` (direct
  SQLite/Qdrant). `kl_graph/query/engine.py` (RRF + optional Phase-2 synthesis)
  is the standalone path used by `scripts/query.py`.
- **Server warmup.** First startup mmaps Qdrant (~90s for a large store); after
  that most graph/browse queries are tens of milliseconds.
- **Graph backend and upgrades.** LadybugDB is the default. It receives graph
  nodes and edges incrementally during ingestion; it is **not** reconstructed
  from SQLite at startup. Existing databases previously ingested with
  `KL_GRAPH_BACKEND=sqlite` must either be rebuilt with
  `python -m scripts.ingest --build-only` under the Ladybug backend, or continue
  using `KL_GRAPH_BACKEND=sqlite`. Do not switch backends without rebuilding the
  graph, because each backend has its own edge authority. LadybugDB handles
  `--all-shortest` efficiently; SQLite BFS requires no graph dependency but can
  be slow on high-degree nodes.
