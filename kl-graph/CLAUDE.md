# Project: kl-graph — Spatio-Temporal Knowledge Graph

A retrieval system that ingests DingTalk workplace messages, extracts entities and facts via LLM, builds a multi-resolution knowledge graph with community detection, and serves queries through a persistent FastAPI server.

> **Authoritative graph design — `docs/graph-design.md`.** It is the
> "Grand Design" and the source of truth for the graph's node types, edge types,
> pipeline phases, and naming. **All graph-building work MUST obey
> `docs/graph-design.md`.** Read it before changing extraction, edge creation
> (`pipeline.py` `_create_edges`), the `EdgeType` enum, or the periodic/query
> graph logic. If the design must change, update `docs/graph-design.md` first, then
> the code.

## Environment Constraints

### Storage
- **Always use `/data/` for large blobs** — never write large files to `/` (root filesystem has limited space).
- Models: `/data/models/` (e.g., `/data/models/Qwen/Qwen3-Embedding-8B`)
- Runtime data (SQLite, Qdrant, cache): `./data/` (gitignored)

### Python & Virtual Environments
- **Never install to system Python.** Always create/use the project venv.
- Use `uv` with `--system-site-packages` to inherit PyTorch/CUDA from the system env:
  ```bash
  uv venv /data/projects/kl-graph/.venv --python /usr/local/bin/python3 --system-site-packages
  ```
- System Python (`/usr/local/bin/python3` = 3.12.3) has: `torch`, `vllm 0.23.0`, CUDA support, 8x GPUs.
- uv global config at `~/.config/uv/uv.toml` — Aliyun mirror configured as default index.

### Hardware
- 8x GPUs, ~95GB VRAM each (total ~765GB)
- CUDA functional via system Python

### What's NOT Available
- No Docker daemon
- No external API keys besides Anthropic (and the aggregated OpenAI-compatible one)

## Architecture

### Data Flow
```
DingTalk DWS Export → Ingestion Pipeline → SQLite + Qdrant → Retrieval Server → CLI
```

### Three Phases

> These phases implement the pipeline defined in `docs/graph-design.md` — conform to
> that spec when changing any graph-building step below.

1. **Ingestion** (`scripts/ingest.py` → `kl_graph/ingest/pipeline.py`)
   - Phase A: LLM extraction (entities + facts from messages, cached to disk)
   - Phase B: Graph build (SQLite + embeddings + structural edges)

2. **Periodic Improvement** (`scripts/improve.py` → `kl_graph/periodic/runner.py`)
   - SIMILAR_TO edges, entity disambiguation, multi-resolution community detection (Leiden L0-L3), community summarization

3. **Retrieval** (`kl_server.py` on port 8200 + `kl_cli.py`)
   - Persistent FastAPI server with in-memory adjacency index
   - Endpoints: /search, /entity, /expand, /community, /members, /context, /timeline
   - CLI entry point: `./kl`

### Key Dependencies

| Component | Technology | Notes |
|-----------|-----------|-------|
| Storage | SQLite (WAL mode) | `data/knowledge.db` |
| Vectors | Qdrant (local file mode) | `data/qdrant_data/`, `data/qdrant_communities/` |
| Embeddings | Qwen3-Embedding-8B via vLLM | Port 8100, dim=4096, no Matryoshka |
| LLM | qwen3.7-plus via remote API | Entity/fact extraction + query synthesis |
| Community | Leiden algorithm (4 resolutions) + HDBSCAN | Multi-resolution clustering |

### Embedding Server
- Start: `vllm serve /data/models/Qwen/Qwen3-Embedding-8B --convert embed --port 8100 --tensor-parallel-size 1 --gpu-memory-utilization 0.4`
- Access: OpenAI-compatible at `http://localhost:8100/v1`
- Dimension: **4096** (fixed, no reduction)
- Prerequisites: `scipy` & `scikit-learn` compiled against numpy 2.x

### LLM for Extraction
- Endpoint: configured via `KL_LLM_BASE_URL` (see `.env.example`)
- Model: `qwen3.7-plus`
- Used with `structured_output_mode="json_object"`

## Data Source

DingTalk Workspace (DWS) export located at the path set by `KL_DWS_EXPORT_DIR`
(see `.env.example`).
- 100 conversations, 19,605 messages
- Message schema: `{content, createTime, openConversationId, openMessageId, sender, senderOpenDingTalkId, quotedMessage}`
- Threading via `quotedMessage` (reply-to links, not full trees)

## Data Scale (current)
- 19,605 messages, ~5,361 entities, ~17K facts, ~73K edges
- 1,946 community vectors
- Server startup: ~87s (Qdrant mmap warmup), then <50ms queries

## Project Structure
```
kl-graph/
├── CLAUDE.md
├── TODO.md
├── .gitignore
├── requirements.txt
├── kl                    # Shell entry point
├── kl_cli.py             # Thin HTTP CLI client (click + httpx)
├── kl_server.py          # Persistent FastAPI retrieval server (port 8200)
├── kl_graph/
│   ├── config.py
│   ├── ingest/           # Pipeline, embedder, LLM extractor, message loader
│   ├── models/           # Pydantic types (Message, Entity, Fact, Edge)
│   ├── periodic/         # Community detection, disambiguation, similarity
│   ├── query/            # Retrieval engine (Phase 1 instant + Phase 2 LLM)
│   ├── storage/          # SQLite + Qdrant backends
│   └── utils/            # RRF fusion, helpers
├── scripts/              # CLI scripts (ingest, improve, query, embed_communities)
├── tests/
└── data/                 # (gitignored) Runtime data
    ├── knowledge.db
    ├── extraction_cache/
    ├── qdrant_data/
    └── qdrant_communities/
```

## Running

```bash
# Start embedding server (needs GPU)
vllm serve /data/models/Qwen/Qwen3-Embedding-8B --convert embed --port 8100 --tensor-parallel-size 1 --gpu-memory-utilization 0.4

# Start retrieval server
./kl start

# Query
./kl search "数据同步"
./kl entity "张伟"
./kl timeline "张伟"
./kl community
```
