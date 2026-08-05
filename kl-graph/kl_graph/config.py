"""Spatio-Temporal Knowledge Retrieval System configuration."""

import os
from pathlib import Path

import litellm

# Force litellm onto its httpx transport instead of the default aiohttp one.
# litellm's aiohttp transport crashes with ``UnicodeEncodeError: 'ascii' codec``
# when an upstream returns a response header containing non-ASCII bytes (seen
# with the llmapi.example.com gateway); the httpx transport handles it fine.
# Setting the module flag here — imported before any acompletion/completion
# call — fixes every call site at once. (The DISABLE_AIOHTTP_TRANSPORT env var
# only accepts the string "True"/"False", not "1", so we set the flag directly.)
litellm.disable_aiohttp_transport = True

# Paths
PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = Path(os.environ.get("KL_DATA_DIR", PROJECT_ROOT / "data"))
DWS_EXPORT_DIR = Path(os.environ.get("KL_DWS_EXPORT_DIR", ""))

# Unified DWS export: every product is a sibling source directory holding the
# standard quartet (manifest.json + scopes/records/resources .jsonl). Chat has
# a bespoke loader (feeds the messages detail table + chat-only edges); the
# other folders are enumerated generically by the pipeline, so no per-source
# path constants are needed here anymore. Loaders no-op when a dir is absent,
# so a partial export (e.g. chat-only) still works.
CHAT_DIR = DWS_EXPORT_DIR / "chat"
# Structured sources with a bespoke loader (mapped by directory name).
WIKI_DIR = DWS_EXPORT_DIR / "wiki"
MAIL_DIR = DWS_EXPORT_DIR / "mail"
MINUTES_DIR = DWS_EXPORT_DIR / "minutes"
# Source directory names handled by the generic record→chunk loader (everything
# except chat/wiki/mail/minutes). Absent dirs are skipped at load time.
GENERIC_SOURCES = ("work", "contacts", "attendance", "calendar", "drive")

# SQLite
SQLITE_PATH = DATA_DIR / "knowledge.db"

# Qdrant
QDRANT_PATH = str(DATA_DIR / "qdrant_data")
# Embedding dimension. Must match the embedding model in use: DashScope
# text-embedding-v4 supports 1024/1536/2048; Qwen3-Embedding-8B emits 4096;
# Qwen3-Embedding-0.6B emits 1024. Qdrant collections are created at this size,
# so changing it requires dropping + re-embedding both vector stores. Override
# per-deployment with KL_EMBEDDING_DIM to match your endpoint.
EMBEDDING_DIM = int(os.environ.get("KL_EMBEDDING_DIM", "4096"))

# Embedding server. Routed through litellm (OpenAI-compatible transport).
# Targets a self-hosted Qwen3-Embedding-8B (4096-dim) by default model name;
# the base URL and key are environment-only (no baked-in defaults). Base must
# include ``/v1``. Set KL_EMBED_BASE_URL + KL_EMBED_API_KEY at launch.
EMBED_BASE_URL = os.environ.get("KL_EMBED_BASE_URL", "")
EMBED_MODEL = os.environ.get("KL_EMBED_MODEL", "Qwen3-Embedding-8B")
EMBED_API_KEY = os.environ.get("KL_EMBED_API_KEY", "")
# Whether to send the ``dimensions`` param on embedding requests. DashScope's
# text-embedding-v4 honors it (matryoshka truncation); the self-hosted
# Qwen3-Embedding-8B (vLLM) rejects it with a 400 (no matryoshka support), so
# default off. Set KL_EMBED_SEND_DIMENSIONS=1 for DashScope-style servers.
EMBED_SEND_DIMENSIONS = os.environ.get("KL_EMBED_SEND_DIMENSIONS", "0") == "1"
# DashScope caps embedding batches at 10 inputs per request.
EMBED_BATCH_SIZE = 10
# Embedding calls are I/O-bound network round-trips; issue this many 10-input
# requests in parallel (thread pool) to speed up bulk embedding. Lower it if the
# provider returns 429s. Only affects bulk paths, not single-query embedding.
EMBED_CONCURRENCY = int(os.environ.get("KL_EMBED_CONCURRENCY", "10"))

# LLM (for extraction + Phase 2 query synthesis).
# Routed through litellm in Anthropic mode: the endpoint speaks the Anthropic
# /messages protocol, so LLM_MODEL carries the ``anthropic/`` provider prefix
# and LLM_BASE_URL points at the Anthropic-compatible base. litellm auto-appends
# ``/v1/messages`` to the base, so it must NOT already include ``/v1``. The API
# key is read from ANTHROPIC_AUTH_TOKEN by the call sites. Base URL is
# environment-only (no baked-in default); set KL_LLM_BASE_URL at launch.
LLM_BASE_URL = os.environ.get("KL_LLM_BASE_URL", "")
LLM_MODEL = os.environ.get("KL_LLM_MODEL", "qwen3.6-flash")

# Reranker (opt-in cross-encoder over fused candidates; disabled unless both
# base URL and model are set). See kl_graph/query/rerank.py.
RERANK_BASE_URL = os.environ.get("KL_RERANK_BASE_URL", "")
RERANK_MODEL = os.environ.get("KL_RERANK_MODEL", "")
RERANK_API_KEY = os.environ.get("KL_RERANK_API_KEY", "")

# Entity extraction
ENTITY_DICT_PATH = DATA_DIR / "entity_dict.txt"
V1_ENTITIES_PATH = Path(
    os.environ.get("KL_V1_ENTITIES_PATH", "")
)  # Legacy, for bootstrap only

# Thresholds
CONFIDENCE_HIGH = 0.7
CONFIDENCE_LOW = 0.3
SIMILAR_TO_THRESHOLD = 0.85
RRF_K = 60

# Vector search mode. When True, Qdrant computes the exact cosine similarity
# against every stored vector (brute force, 100%% recall) instead of the
# approximate HNSW walk. Cheap and exact on small collections; O(N) at scale.
# Hardcoded on for now.
QDRANT_EXACT_SEARCH = False

# Query limits
PHASE1_MESSAGE_LIMIT = 20
PHASE1_FACT_LIMIT = 10
PHASE1_ENTITY_EXPAND_LIMIT = 20
PHASE2_CONTEXT_LIMIT = 50

# Rerank candidate window: how many top fused hits to (re)rank before the final
# cut. Larger = the reranker can rescue good items RRF ranked lower, at more
# rerank cost. Only used when the reranker is enabled.
RERANK_WINDOW = 64
RERANK_TOP_K = 30
