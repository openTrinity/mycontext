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

1. **Prepare the DingTalk data.** Produce the canonical DWS export layout
   described in [Data Preparation](#data-preparation), store it in a local or
   temporary directory, and point `KL_DWS_EXPORT_DIR` at the export root.
2. **Start the server and ingest the freshly downloaded data.** Bring up the
   retrieval server, then run a full ingest (Phase A + Phase B) over the new
   export:
   ```bash
   set -a; source .env; set +a          # load endpoints/keys
   ./kl start                           # start the retrieval server
   ./kl ingest -d "$KL_DWS_EXPORT_DIR"   # Phase A + B in the background
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

1. **Ingestion** — two phases:
   - **Phase A** loads + chunks + embeds *every* source folder into SQLite
     (`chunks`) and Qdrant. No LLM; dense + BM25 recall works after this.
   - **Phase B** runs LLM entity/fact extraction over all chunks, then builds
     and embeds the graph (entities, facts, structural edges). This is the only
     LLM-billed phase; results are cached per chunk to disk and replayable.
2. **Periodic Improvement** — SIMILAR_TO edges, entity disambiguation,
   multi-resolution community detection (Leiden L0–L3), then (separately)
   community summarization + summary embedding.
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
uv venv .venv --python python3

# Core dependencies
uv pip install -r requirements.txt

# Additional deps for the periodic-improvement phase (communities/clustering)
uv pip install igraph leidenalg hdbscan scipy scikit-learn
```

### requirements.txt

```
# Core
qdrant-client>=1.9.0
aiosqlite>=0.19.0
litellm>=1.0
jieba>=0.42
numpy>=2.0
pydantic>=2.0

# Utilities
tqdm>=4.60
nltk>=3.9
httpx>=0.27
```

The retrieval server + CLI additionally need `fastapi`, `uvicorn`, and `click`.

## Configuration

All configuration is via environment variables — **no endpoints or secrets are
baked into the repo**. The recommended workflow is a local, gitignored `.env`
at the project root that you source before starting the server. Nothing
auto-loads it:

```bash
set -a; source .env; set +a      # export every KL_* + ANTHROPIC_AUTH_TOKEN
```

Example `.env`:

```bash
# --- data + export locations ---
export KL_DATA_DIR=./data                      # where knowledge.db + qdrant land
export KL_DWS_EXPORT_DIR=/path/to/dws_export   # the exported source folders

# --- embedding endpoint (OpenAI-compatible, routed via litellm) ---
export KL_EMBED_BASE_URL=https://your-embed-endpoint/v1
export KL_EMBED_MODEL=Qwen3-Embedding-8B
export KL_EMBED_API_KEY=your-embed-key         # empty for an unauthenticated local vLLM
export KL_EMBEDDING_DIM=4096                    # MUST match the model's output dim
export KL_EMBED_SEND_DIMENSIONS=0              # 1 only for matryoshka servers (DashScope v4)

# --- extraction / synthesis LLM (Anthropic-compatible, routed via litellm) ---
# For a DashScope Anthropic base, do NOT append /v1 (litellm adds /v1/messages).
export KL_LLM_BASE_URL=https://your-llm-endpoint
export KL_LLM_MODEL=qwen3.6-flash
export ANTHROPIC_AUTH_TOKEN=your-llm-key       # used as the LLM API key
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
```

> **Embedding dimension.** `KL_EMBEDDING_DIM` is baked into the Qdrant
> collections at creation time. Pick the value that matches your model
> (e.g. 4096 for Qwen3-Embedding-8B, 1024 for Qwen3-Embedding-0.6B). Changing
> models later requires wiping `$KL_DATA_DIR` and re-embedding everything.

> **Windows users.** Add `set PYTHONUTF8=1` to your `.env`. Without it, the
> Python console defaults to GBK / cp1252 and any `print()` or log line
> containing emoji or non-ASCII characters (common in Chinese group/doc names)
> will crash with `UnicodeEncodeError`. macOS and Linux are unaffected
> (already UTF-8).

## Data Preparation

### The unified DWS export format

The pipeline reads a **DingTalk Workspace (DWS) export** where every product
lives in its own directory under `$KL_DWS_EXPORT_DIR` and shares the same
on-disk "quartet":

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

Each source is loaded into generic `Chunk`s (chat additionally into the
`Message` subtype, which carries `conversation_id` / `sender` / `reply_to`).
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

### Exporting from DingTalk

Data collection is intentionally outside this repository. Supply an export in
the canonical layout above, then point `KL_DWS_EXPORT_DIR` at its root.

## Pipeline

The simplest path drives the entire build **through the running server** with
`kl ingest`. There is also an offline scripted path for cold/headless builds.

### Option 1 — in-server ingest (recommended)

```bash
set -a; source .env; set +a
./kl start                      # start the retrieval server (ingest runs inside it)
kl status                       # wait for "status": "ready"

kl ingest -d "$KL_DWS_EXPORT_DIR"   # Phase A → Phase B → improve, non-blocking
kl status                           # poll: "Ingest: running NN% (phase_a|phase_b|improve)"

# Community summaries are NOT produced by kl ingest — add them once the graph
# is built so `search -c communities` and community labels work:
python -m kl_graph.periodic.community_summarizer
python scripts/embed_communities.py
```

`kl ingest` upserts into the current DB (entity/fact ids are deterministic
UUID5s, so re-ingesting never duplicates). It has no wipe flag; for a clean
rebuild `rm -rf "$KL_DATA_DIR"` first. `--no-improve` skips community/PageRank;
`-c N` raises extraction concurrency.

> **Improve deps.** The improve phase inside `kl ingest` (community detection
> via Leiden + HDBSCAN) requires `igraph`, `leidenalg`, `hdbscan`, `scipy`, and
> `scikit-learn`. Install them once (see [Installation](#installation)) or the
> improve phase will fail with `ModuleNotFoundError`. Use `--no-improve` to
> skip if you don't need communities.

### Option 2 — offline scripted build

```bash
set -a; source .env; set +a

# Ingest: Phase A + Phase B. --fresh-db wipes the DB (but keeps the extraction
# cache); with no flag it smart-resumes (skip Phase A if already embedded).
python -m scripts.ingest --fresh-db

# Improve: SIMILAR_TO edges + disambiguation + communities (Leiden L0–L3)
python -m scripts.improve --skip-llm-judge

# Community summaries + embed them for community-level vector search
python -m kl_graph.periodic.community_summarizer
python scripts/embed_communities.py
```

`scripts.ingest` flags:

| Flag | Effect |
|------|--------|
| *(none)* / `--full` | Full pipeline with **smart resume** (skip Phase A if every chunk is persisted + embedded, else run it), then Phase B |
| `--phase-a` | Phase A only: load + chunk + embed (no LLM). Usable dense/BM25 RAG after this |
| `--extract-only` | Advanced: LLM extraction only, cache results (assumes Phase A ran) |
| `--build-only` | Advanced: build graph from cached results only, no LLM (assumes Phase A ran) |
| `--concurrency N` | Max concurrent extraction LLM calls |
| `--fresh-db` | Delete `knowledge.db` + Qdrant dir first (keeps `extraction_cache/`) |

`scripts.improve` flags include `--entity-resolution` / `--fact-resolution`
(Leiden), `--fact-min-cluster` (HDBSCAN), `--skip-disambiguation`,
`--skip-llm-judge`, and `--llm-budget`.

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

# Entity lookup / alias resolution (no embedding needed)
./kl entity "张伟"
./kl expand <entity_id>                         # SIMILAR_TO neighbors

# Community browsing (needs the summarize + embed steps above)
./kl community -l L1 -t entity
./kl community -l L2 --id 8
./kl members 8 -l L2 -t fact

# Fact provenance / timeline / stats
./kl context <fact_id>
./kl timeline "网络白名单" --from 2026-06-01 --to 2026-07-01
./kl stats
```

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
│   ├── storage/          # SQLite + Qdrant backends
│   └── utils/            # RRF fusion, bounded async helpers
├── scripts/
│   ├── ingest.py             # offline ingestion (Phase A/B)
│   ├── improve.py            # offline periodic improvement
│   └── embed_communities.py  # embed community summaries
├── requirements.txt
├── .env                  # (gitignored) local endpoint/secret config
└── data/                 # (gitignored) runtime data
    ├── knowledge.db          # SQLite (chunks, messages, entities, facts, edges, communities)
    ├── extraction_cache/     # Phase A/B LLM cache (replay source)
    ├── qdrant_data/          # main vector store (chunks/entities/facts)
    └── qdrant_communities/   # community-summary vector store
```

## Running Without GPUs

Point `KL_EMBED_BASE_URL` at any remote OpenAI-compatible embedding endpoint
(set `KL_EMBED_API_KEY`), and everything works on CPU. Ensure `KL_EMBEDDING_DIM`
matches the endpoint's output dimension.

| Feature | Works without GPU? |
|---------|-------------------|
| `kl entity` / `community` / `members` / `timeline` / `context` / `expand` / `hop` | Yes (no embedding at all) |
| `kl search` / `kl ask` | Yes (with a remote embedding endpoint) |
| Ingestion Phase A (chunk + embed) | Yes (remote embedding endpoint) |
| Ingestion Phase B (LLM extract + graph build) | Yes (LLM + embedding endpoints) |
| Periodic improvement + community summaries | Yes (remote endpoints) |

## Notes

- **Determinism.** Entity/fact ids are UUID5s of normalized content, so
  re-ingesting is idempotent — duplicates merge by construction.
- **Query path.** Queries run through `kl` → `kl_server.py`, which uses
  `kl_graph/query/engine.py` for RRF and optional Phase-2 synthesis.
- **Server warmup.** First startup mmaps Qdrant (~90s for a large store); after
  that most graph/browse queries are tens of milliseconds.
