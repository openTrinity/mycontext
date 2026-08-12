# LoCoMo evaluation

LoCoMo uses one physical production KL graph per benchmark conversation.  A
conversation's SQLite/Ladybug, Qdrant, extraction cache, and ingestion
checkpoint live in that conversation's own `kl_data/`; no query-time scope
filter is used to simulate graph isolation.

The package is only a benchmark adapter:

```text
locomo10.json
  -> convert.py                 official LoCoMo fields -> production DWS case set
  -> build.py                   one scripts.ingest process per conversation
  -> runners/ask/ask.py         one production kl ask per question
  -> runners/ask/generate.py    optional answer generation
  -> runners/ask/score.py       LoCoMo answer/evidence scoring
```

Message loading, session detection, chunking, embedding, extraction, graph
construction, storage, and query ranking are all production KL behavior.

Run commands from the repository root after exporting the production model
configuration into the current shell. If it is stored in `.env`, use:

```bash
set -a
source .env
set +a
```

## Artifacts

```text
data/locomo-v2/
├── manifest.json
├── cases/
│   └── CONVERSATION_ID/
│       ├── manifest.json
│       ├── evaluation.jsonl       # questions, answers and Gold; never ingested
│       ├── evidence_map.jsonl     # source message -> dia_id; never ingested
│       ├── dws/chat/              # only production ingestion input
│       ├── kl_data/               # this conversation's physical KL graph
│       ├── build.log
│       └── build_status.json
└── benchmark/
```

## Convert

```bash
python -m kl_graph.evaluation.locomo.convert \
  /path/to/locomo/data \
  data/locomo-v2
```

The input may be `locomo10.json` itself or its containing directory. The
converter writes the standard DWS chat quartet directly from the official
LoCoMo JSON. Questions, answers, `dia_id`, and Gold evidence remain outside
`dws/` and cannot enter chunks or embeddings.

## Build

```bash
python -m kl_graph.evaluation.locomo.build \
  data/locomo-v2 \
  --all \
  --case-concurrency 3 \
  --keep-going
```

For every selected conversation, `build.py` launches a fresh process equivalent
to:

```bash
KL_DWS_EXPORT_DIR=CASE/dws \
KL_DATA_DIR=CASE/kl_data \
python -m scripts.ingest \
  --input-dir CASE/dws \
  --source-id locomo-CONVERSATION_ID \
  --full --improve-mode off
```

`--with-improve` changes the explicit mode from `off` to `full`. Build rejects
partial extraction and records the production storage/embedding configuration
in `build_status.json`. Use `--fresh` only when the selected production graphs
should be rebuilt.

## Ask

`ask.py` processes graphs sequentially: it starts one production server, calls
production `kl ask` exactly once for every question belonging to that graph,
stops the server, and advances to the next graph. Questions within the active
graph may run concurrently. It stores only run metadata and the raw Phase-1
responses; rerank remains part of production KL.

Before starting a server, Ask requires a successful `build_status.json` and
checks that the current graph/vector backend and embedding model/dimension match
the build.

When `--conversation` is specified, the default run directory is case-local:
`cases/CONVERSATION/benchmark/locomo-ask/CATEGORY/RUN_TIME/`. Multi-conversation
runs remain under the case-set-level `benchmark/` directory.
Configure it through `KL_RERANK_BASE_URL`, `KL_RERANK_MODEL`, and
`KL_RERANK_API_KEY` before starting the run.

```bash
python -m kl_graph.evaluation.locomo.runners.ask.ask \
  --dataset data/locomo-v2 \
  --conversation chat:conv-26
```

## Generate

Answer generation consumes the raw ask artifacts and does not read Gold data or
score its own output. Its default output is case-local at
`cases/CONVERSATION/benchmark/locomo-generate/CATEGORY/RUN_TIME/`:

```bash
python -m kl_graph.evaluation.locomo.runners.ask.generate \
  --ask-dir ASK_RUN
```

Add `--include-community-context` to append the cached community reports returned
by `/ask` to the generation prompt. This reads only the persisted response and
does not query KL or the case database again.

## Score

The scoring stage is the only direct-ask stage that joins benchmark Gold and
resolves KL evidence. Omit `--answers-dir` for retrieval-only scoring. Its
default output is case-local at
`cases/CONVERSATION/benchmark/locomo-score/CATEGORY/RUN_TIME/`:

```bash
python -m kl_graph.evaluation.locomo.runners.ask.score \
  --ask-dir ASK_RUN \
  --answers-dir ANSWER_RUN
```

## Codex agentic evaluation

Codex agentic protocol:

```bash
python -m kl_graph.evaluation.locomo \
  --dataset data/locomo-v2 \
  --eval
```

The runner starts one unmodified production `kl_server` for every selected
conversation graph and routes each question to its graph's port. There are no
SQLite, FTS, Qdrant, entity, fact, or edge scope patches.

## RAGFlow SDK evaluation

The RAGFlow runner reads the official `locomo10.json` directly. It does not
consume the converted DWS case set. One native conversation becomes one remote
RAGFlow Dataset containing one complete transcript Document; RAGFlow owns
parsing, chunking, embedding, GraphRAG construction, and retrieval.

RAGFlow SDK 0.26.4 requires Python 3.13. Keep it in a dedicated environment so
the KL Graph environment and dependency lock remain unchanged:

```bash
uv venv --python 3.13 .venv-ragflow
uv pip install --python .venv-ragflow/bin/python ragflow-sdk==0.26.4
export RAGFLOW_BASE_URL=http://127.0.0.1:9380
export RAGFLOW_API_KEY=ragflow-xxxxxxxx
```

The dedicated `.venv-ragflow` environment keeps the normal KL Graph `.venv`
unchanged. Use its interpreter for every RAGFlow SDK command.

Build the document chunks and GraphRAG index:

```bash
.venv-ragflow/bin/python -m kl_graph.evaluation.locomo.runners.ragflow.build \
  /path/to/locomo10.json \
  --conversation conv-26 \
  --graph
```

Retrieve with the graph enabled, then reuse the existing answer generator and
the RAGFlow-native evidence scorer:

```bash
.venv-ragflow/bin/python -m kl_graph.evaluation.locomo.runners.ragflow.ask \
  /path/to/locomo10.json \
  --conversation conv-26 \
  --use-kg \
  --max-concurrent 4

python -m kl_graph.evaluation.locomo.runners.ask.generate \
  --ask-dir RAGFLOW_ASK_RUN

.venv-ragflow/bin/python -m kl_graph.evaluation.locomo.runners.ragflow.score \
  --ask-dir RAGFLOW_ASK_RUN \
  --answers-dir RAGFLOW_GENERATE_RUN
```

Remote Dataset and Document IDs are persisted under
`data/locomo-ragflow/cases/CONVERSATION/ragflow.json`; `--resume` reuses this
state and never deletes a remote Dataset.

## Khoj server evaluation

The Khoj runner is an HTTP-only adapter over an independently running
production Khoj server. It does not import Khoj's evaluation package or any
Khoj parser. Each native LoCoMo conversation is uploaded as one complete
plaintext document; Khoj owns parsing, chunking, embedding, persistence,
candidate retrieval, and reranking.

Configure the server endpoint and, when it is not running in anonymous mode,
an API token:

```bash
export KHOJ_BASE_URL=http://127.0.0.1:42112
export KHOJ_API_TOKEN=optional-bearer-token
```

Build verifies the remote raw document after upload and persists only document
state. It does not create or persist client-side chunks:

```bash
python -m kl_graph.evaluation.locomo.runners.khoj.build \
  /path/to/locomo10.json \
  --conversation conv-26
```

Retrieve server-generated plaintext chunks. Every request adds an exact Khoj
filename filter for the conversation document. `dedupe=false` is part of the
fixed protocol because chunks split from one plaintext entry share a Khoj
`corpus_id`; deduplication would collapse Top-K chunk retrieval to one
representative from the document.

```bash
python -m kl_graph.evaluation.locomo.runners.khoj.ask \
  /path/to/locomo10.json \
  --conversation conv-26 \
  --top-k 5 \
  --max-concurrent 4

python -m kl_graph.evaluation.locomo.runners.ask.generate \
  --ask-dir KHOJ_ASK_RUN

python -m kl_graph.evaluation.locomo.runners.khoj.score \
  --ask-dir KHOJ_ASK_RUN \
  --answers-dir KHOJ_GENERATE_RUN
```

Every question is filtered to its conversation document. Scoring also verifies
document ownership before counting a returned `dia_id` as evidence.

## Package boundaries

- `convert.py` owns only LoCoMo-to-DWS field conversion.
- `build.py` reads the case-set manifest and orchestrates production ingestion.
- `metrics/` implements LoCoMo-specific scoring and evidence resolution.
- `runners/` read only the benchmark fields needed by their stage and
  orchestrate evaluation; retrieval remains production KL code.
- Production ingestion and query packages never import this evaluation package.
