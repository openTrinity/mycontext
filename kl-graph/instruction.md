# kl-graph CLI — Usage Instructions

A practical guide to querying the DingTalk spatio-temporal knowledge graph via
the `kl` command-line interface (and the underlying `kl-server` HTTP API).

Examples below use the **aliding-export** graph (ExampleCorp/Qwen team work chats:
onboarding, sandbox/e2b, InkFlow, model evals, OKR, travel platform, security).

---

## 1. Mental model

```
DingTalk export (JSON)
   → ingest  (Phase A: chunk + embed every source → Phase B: LLM extraction + graph build)
   → improve (SIMILAR_TO edges, entity/fact communities L0–L3)
   → server  (kl-server, port 8200, keeps SQLite + Qdrant warm in memory)
   → kl CLI  (thin HTTP client → formats output)
```

The **CLI is a thin HTTP client** over `kl-server`. Every query command needs
the server running on port 8200. It builds an in-memory adjacency index at
startup (~2.5 s here), after which queries are typically <50 ms server-side
(vector search adds ~200–400 ms for the query embedding round-trip).

**Ingestion is two phases** (see §2):
- **Phase A — chunking:** every source folder (chat + wiki/mail/minutes/docs/
  aitable/calendar/report) is loaded, chunked, persisted to SQLite `chunks`,
  and embedded into Qdrant. **No LLM.** Dense + BM25 retrieval works after this.
- **Phase B — extraction + graph build:** LLM entity/fact extraction over *all*
  chunks (not just chat), then the graph (entities/facts/edges) is built and
  embedded. This is the only LLM-billed phase, and it is replayable from cache.

**Two data ids you must not confuse** (this bites agents):
- **Qdrant point id** — an integer index (`"86"`), internal to the vector store.
- **Domain id** — the deterministic UUID5 of a fact/entity/message
  (`daf2309f-…`). This is what `context`, `expand`, `timeline` expect.

`search` returns the **domain id** as `id` (and the raw point id as `point_id`),
so you can chain `search → context/expand` directly.

---

## 2. One-time setup (build the graph)

There are two ways to build/refresh the graph:

### 2a. In-server ingest (recommended: `kl ingest`)

Run the whole pipeline **inside a running server** — it never pauses or
restarts, keeps serving queries throughout, and hot-swaps the new graph in when
done. This is the normal path once a server is up (even against an empty DB).

```bash
./kl start                                   # server on :8200 (empty DB is fine)
kl ingest                                    # Phase A + Phase B in the background
kl status                                    # watch "Ingest: running NN% (phase)"
```

Options: `-c/--concurrency N` (parallel extraction LLM calls, default 8),
`-d/--export-dir PATH` (override `KL_DWS_EXPORT_DIR` for this run),
`--no-improve` (skip community detection / PageRank after the graph build).
Only one ingest runs at a time; a second call returns HTTP 409. On completion
the adjacency + PageRank indexes are rebuilt and atomically swapped in, so graph
queries (`ask`/`hop`/`expand`) immediately see the new data.

### 2b. Offline ingest (`scripts.ingest`, for cold/scripted builds)

```bash
# --- environment ---
export KL_DWS_EXPORT_DIR=/path/to/export      # chat under chat/messages/ or chats/
export KL_DATA_DIR=/path/to/data              # where knowledge.db + qdrant land
export ANTHROPIC_AUTH_TOKEN=sk-...            # LLM key (the API, anthropic mode)
export KL_EMBED_API_KEY=sk-...                # embedding key (the API)

# --- build ---
python -m scripts.ingest --fresh-db                # Phase A (chunk+embed) + Phase B (extract+graph)
python -m scripts.improve --skip-llm-judge         # SIMILAR_TO + communities L0–L3
python -m kl_graph.periodic.community_summarizer   # 1–2 sentence summary per community
python scripts/embed_communities.py                # embed summaries for `search -c communities`
```

Phase flags: `--phase-a` (chunk + embed only, no LLM). With no flag (or
`--full`) it runs the **full pipeline with smart resume**: it verifies Phase A
is done (every loadable chunk is persisted in SQLite *and* embedded in Qdrant)
and, if so, skips straight to Phase B; otherwise it runs Phase A from the start,
then Phase B. A half-finished Phase A (persisted but not embedded) counts as not
done and is re-run. `--extract-only` / `--build-only` are advanced Phase-B
cache-replay sub-steps (they assume Phase A already ran). There is no
“Phase B only” flag — a graph with no embedded chunks to ground it is not useful.

Notes:
- `--fresh-db` deletes `knowledge.db` **and** the Qdrant dir. The extraction
  cache now lives in the `extraction_cache` table **inside** `knowledge.db`, so
  `--fresh-db` clears the cache too. To rebuild the graph *without* re-billing
  the LLM (reusing the cache), run `python -m scripts.ingest --build-only`
  **without** `--fresh-db`. To wipe everything, `rm -rf "$KL_DATA_DIR"` first.
- Phase B is the only expensive/LLM-billed step; Phase A and everything else is
  cheap and replayable. Determinism: re-ingesting never duplicates
  entities/facts (ids are UUID5s of normalized content).
- `--concurrency N` on ingest controls parallel LLM calls (default 8).
- Community columns (`community_L0..L3`) are created **only** by `scripts.improve`
  (or by `kl ingest` unless you pass `--no-improve`). Without them,
  `community`/`members` return empty and `entity` shows no community labels.

---

## 3. Start / stop the server

```bash
./kl start          # start kl-server (+ embedding server if configured)
./kl status         # is it up? DB + collection stats
./kl stop           # stop it
```

`./kl` is a shell wrapper that runs `kl_cli.py` inside the project venv. From
another interpreter, `python kl_cli.py <command>` works too, as long as
`KL_SERVER_URL` points at the server (default `http://localhost:8200`).

`kl status` confirms the graph is loaded, and reports any running ingest:

```json
{
  "status": "ready", "startup_time_s": 2.5, "adjacency_entities": 1166,
  "sqlite":  {"messages": 921, "entities": 394, "facts": 774, "edges": 5436},
  "qdrant":  {"chunks": 921, "entities": 394, "facts": 775, "communities": 226},
  "ingest":  {"state": "idle", "percent": 0.0}
}
```

During a background `kl ingest` the `ingest` block shows
`{state: "running", phase: "phase_a|phase_b|improve", percent, detail, error}`
(`state` ends at `done` or `error`); the pretty `kl status` prints it as a
`Ingest: running NN% (phase) — detail` line.

---

## 4. Commands at a glance

| Command | What it does | Default output |
|---|---|---|
| `ask "<q>"` | **Hybrid QA.** Dense + sparse (BM25) + RRF over messages & facts, optional LLM synthesis. Start here for questions. | JSON |
| `search "<q>" -c <coll>` | Pure vector ANN over **one** collection: `chunks` (all source content — messages, later pdf/doc), `facts`, `entities`, `communities` (`facts` default). | JSON |
| `entity "<name>"` | Entity lookup by substring; ids, mentions, degree, community labels. | pretty |
| `timeline "<entity>"` | Chronological facts for an entity (date-range aware). | pretty |
| `context <fact_id>` | Ground a fact: source chunk (any source) + related entities + neighbors. | pretty |
| `community` / `members` | Browse the community hierarchy (L0–L3). | pretty |
| `expand <entity_id>` | `SIMILAR_TO` neighbors (alias/duplicate resolution). | pretty |
| `hop -n <id> -c <cursor>` | Expand one node one hop deeper (continues an `ask` walk). | JSON |
| `stats` / `status` | Graph statistics / server health (incl. ingest progress). | pretty |
| `ingest` | Start an in-server background ingest (Phase A + B); watch via `status`. | pretty |

Output convention: **`ask`, `search` are JSON by default** (agent
consumption). All browsing commands are **pretty by default**. Every command
takes `--json` to force JSON; `ask`/`search` also take `--pretty`. **`--json`
wins if both are given.**

---

### 4.1 `ask` — hybrid question answering (the main entry point)

```bash
kl ask "谁负责 InkFlow 项目？" -k 8              # JSON by default
kl ask "周强的 OKR 是怎么安排的？" -k 10 --pretty
kl ask "线上服务 502 报错根因是什么？" --phase2   # force LLM synthesis
```

Options: `-k/--top-k N`, `--phase2` (force synthesis), `--pretty`, `--json`.

**Response schema:**
```json
{
  "answer": "…",                       // non-empty only when phase == 2
  "items": [
    {"type": "fact|message", "id": "<uuid>", "score": 0.83,
     "content": "…", "sender": "周强", "timestamp": 1768466221000}
  ],
  "phase": 1,                          // 1 = retrieval only, 2 = synthesized
  "latency_ms": 240,
  "entities_found": ["孙亮", "InkFlow"]
}
```

- `ask` escalates to Phase-2 LLM synthesis automatically on empty results, low
  confidence, or synthesis keywords ("为什么/根因/总结/对比"…). `--phase2` forces it.
- **Latency:** Phase-2 adds an LLM call — 30–90 s on a cold topic. **The CLI has
  a 60 s HTTP timeout**, so heavy synthesis can still time out on the CLI. Either
  read the Phase-1 `items` (retrieval is complete regardless of phase), or call
  the `/ask` endpoint directly with a longer timeout (see §8).

### 4.2 `search` — single-collection vector search

```bash
kl search "部署平台 gRPC 网络"                    # facts (default)
kl search "孙亮" -c entities -k 5           # resolve a person/system by meaning
kl search "新员工入职流程" -c communities -k 3  # find relevant community neighborhoods
kl search "502 报错" -c chunks               # raw source content (messages; later pdf/doc)
```

`chunks` is the unified retrieval-unit collection — all embedded source content
regardless of format (chat messages today, PDF/doc/sheet chunks later),
discriminated by a `source_type` payload field. `messages` is accepted as a
backward-compat alias for `chunks`.

Options: `-c/--collection [chunks|messages|facts|entities|communities]`, `-k/--top-k`,
`--pretty`, `--json`.

**Response schema:**
```json
{
  "collection": "facts",
  "results": [
    {"id": "daf2309f-…",     // DOMAIN id (fact_id/entity_id/chunk_id) — chainable
     "point_id": "86",       // raw Qdrant point id (debugging only)
     "score": 0.61,
     "payload": {"fact_id": "daf2309f-…", "text": "…", "fact_type": "DELEGATE",
                 "timestamp": 1768466221000, "confidence": 0.95,
                 "source_message_id": "msg…"}}
  ],
  "latency_ms": 202, "embed_ms": 200, "search_ms": 2
}
```

Use `search -c entities` whenever you are **unsure of the exact surface form**
of a name — it matches semantically. On this dataset the LLM emits variants like
`孙亮` vs `孙亮(小孙)`, or `sandbox` vs `dev部署平台`; `entity`/`timeline` need the
exact stored name, so resolve it here first.

### 4.3 `entity` / `timeline` / `context`

```bash
kl entity "孙亮"                             # id, type, mentions, degree, community labels
kl timeline "周强"                           # all facts, newest first
kl timeline "孙亮" --from 2026-01-01 --to 2026-06-30
kl context daf2309f                           # fact → source message + entities (prefix id OK)
```

`entity` options: `--json`. **Response:** `{results:[{id, name, type, mentions,
first_seen, last_seen, communities:{L0..L3}, degree, edges_out, edges_in}],
count}`. Substring match → multiple results possible.

`timeline` options: `--from`, `--to` (YYYY-MM-DD), `-n/--limit`, `--json`.
**Response:** `{entity, entity_id, degree, auto_filtered, facts:[{id, text, type,
timestamp, confidence}], latency_ms}`. High-degree entities (>200 edges) auto-
filter to a recent window unless you pass a date range (`auto_filtered: true`
tells you when this happened).

`context` options: `--json`. Fact id accepts a **prefix**. **Response:**
`{fact:{id,text,type,timestamp,confidence}, source_chunk:{id,content,source_type,
timestamp,source_ref}, source_message:{id,sender,content,timestamp,
conversation_id}|null, entities:[…], surrounding:[…]}`. `source_chunk` is the
universal provenance (any source); `source_message`+`surrounding` are populated
only when the fact's source is a chat message.

### 4.4 `community` / `members` — browse the hierarchy

```bash
kl community -l L1 -t fact                    # list L1 fact communities (summaries + tags)
kl community -l L2 -t entity --id 8           # detail on one community
kl members 8 -l L2 -t fact                    # read its member facts
kl members 1 -l L1 -t entity                  # who's in an entity community
```

Levels: `L0` org → `L1` team (**best starting point**) → `L2` project →
`L3` component. Options: `-l/--level [L0|L1|L2|L3]`, `-t/--type [entity|fact]`,
`--id` (detail), `-k/--top-k`, `-n/--limit`, `--json`.

**`community` (list) response:** `{communities:[{community_id, member_count,
summary, tags}]}`. **`members` response:** `{members:[{id, text|name, type,
timestamp|mentions}]}` (fact members carry `text`/`timestamp`; entity members
carry `name`/`mentions`).

### 4.5 `ask` — hybrid retrieval + interactive GraphRAG walk

```bash
kl ask "数据同步 ECS 部署" --pretty                # items + seed facts + hop-1 entities
kl ask "InkFlow 高校合作" --seed-k 8 --radius 1 --max-nodes 20
kl ask "模型评测失败" --phase2 --pretty            # also force LLM synthesis
```

Options: `-k/--top-k`, `--phase2`, `--seed-k`, `-r/--radius`, `--max-nodes`.
Runs the query engine (dense+sparse+RRF over chunks+facts) and, when the graph
is built, walks `radius` hops from the query-extracted entities/facts
(**excluding `SIMILAR_TO` edges**) — one call, one LLM invocation. **Response:**
`{answer, items, phase, entities_found, mode, seeds, nodes, edges, expandable,
cursor, latency_ms}`. `seeds`/`expandable` are `{id, label}` and `edges` carry
`from_label`/`to_label`, so references are human-readable without joining against
`nodes`. `cursor` + an `expandable` `.id` feed `kl hop` for paginated expansion.

### 4.6 `hop` — expand one node one hop deeper

```bash
kl hop -n <node_id> -c '<cursor_json>' [--max-fanout 10] [--pretty]
```

Continues the walk started by `ask`: pass an `expandable` id plus the `cursor`
from the previous response. No LLM, no embedding — pure in-memory traversal
(sub-ms). **Returns only the newly revealed frontier** `{mode, node_id, nodes,
edges, expandable, cursor, latency_ms}` and an updated `cursor` (same labeled
shape: `seeds`/`expandable` as `{id, label}`, edges with `from_label`/`to_label`).
The server is stateless between hops, so merge the frontier into the graph you
already hold and chain `hop` with the new cursor. Each hop decays a node's score by `λ`
(default 0.6) and prunes branches below `mini_threshold` (0.2): a node survives
while `score × 0.6^hop ≥ 0.2`, so real query seeds (~0.5–0.6) reach depth 2 and
a strong seed reaches depth 3. A deep/weak node eventually returns an empty hop
— that is the expected stop signal, not an error.

---

## 5. Recommended retrieval patterns

**Factual question →** `ask`, then ground the best fact:
```bash
kl ask "谁决定用 e2b 做部署平台？" -k 5 --pretty
kl context <best_fact_id_from_items>
```

**Entity deep-dive →** resolve name, walk its timeline, read its community:
```bash
kl search "周强" -c entities        # get the exact stored name + id
kl timeline "周强" --from 2026-06-01
kl entity "周强"                     # community labels → kl members <L2 id> -t fact
```

**Broad survey →** communities top-down:
```bash
kl search "sandbox architecture" -c communities -k 5
kl members <id> -l L2 -t fact
kl context <fact_id>
```

**Relationship / multi-hop →** `ask` (walks the graph automatically):
```bash
kl ask "线上服务 502 部署" --seed-k 8 --pretty
```

**Stop when:** you have ≥3 grounded facts answering the question, you reach L3,
or two consecutive queries return nothing new. Budget ~2–3 commands for a simple
factual question, up to ~10 for a broad survey.

---

## 6. Output conventions (summary)

- `ask`, `search` → **JSON by default**; add `--pretty` for prose. `--json`
  forces JSON and wins over `--pretty`.
- `entity`, `timeline`, `community`, `members`, `context`, `expand` →
  **pretty by default**; add `--json` for machine output.
- Fact ids accept a **prefix** (`kl context daf2309f`). Entity/timeline names
  must match the stored surface form exactly (use `search -c entities` first).

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Connection refused` / CLI hangs | Server not running → `./kl start`, verify `./kl status`. |
| `Entity not found: X` (404) | Surface-form mismatch → `kl search "X" -c entities` to find the stored name. This 404 is expected for a genuinely absent entity. |
| `Fact not found` (404) | You passed a Qdrant `point_id` (e.g. `"86"`) instead of the domain id. Use the `id` field from `search`, not `point_id`. |
| `ask` times out (60 s) | Phase-2 synthesis is slow → drop `--phase2` and read Phase-1 `items`, or call `/ask` directly with a longer timeout (§8). |
| Empty communities / `community_L*` errors | Run `python -m scripts.improve` (or `kl ingest` without `--no-improve`) — community columns are created only by the improve step, not by chunking/extraction. |
| Wrong embedding dim on startup | Qdrant collections are fixed-dim (2048); changing embedding models requires a full re-embed (`rm -rf $KL_DATA_DIR/qdrant_data` then rebuild). |

---

## 8. Direct server API (bypassing the CLI)

Every command maps to a `POST` endpoint on `kl-server`. Use this when you need a
longer timeout (Phase-2 synthesis) or are driving the graph from code. **Request
field names differ from CLI flags** — the table below is authoritative.

| CLI | Endpoint | Request body (JSON) |
|---|---|---|
| `ask` | `POST /ask` | `{query, top_k, force_phase2, radius, max_fanout, max_nodes, "lambda", seed_k}` |
| `search` | `POST /search` | `{query, collection, top_k, min_timestamp?, max_timestamp?}` |
| `entity` | `POST /entity` | `{name, limit}` |
| `expand` | `POST /expand` | `{entity_id}` |
| `community` | `POST /community` | `{level, node_type, community_id?, top_k}` |
| `members` | `POST /members` | `{community_id, level, node_type, limit}` |
| `context` | `POST /context` | `{fact_id}` |
| `timeline` | `POST /timeline` | `{entity_name, from_date?, to_date?, limit}` |
| `hop` | `POST /graph_hop` | `{node_id, cursor, max_fanout}` |
| `ingest` | `POST /ingest` | `{input_dir, source_id, concurrency?, improve_mode?}` |
| `status` | `GET /status` | — |
| — | `GET /health` | — |

Gotchas:
- `community`/`members` use **`node_type`** (`"entity"`|`"fact"`), not `type`.
- `timeline` uses **`from_date`/`to_date`**, not `from`/`to` or `start_date`.
- `ask`'s graph-walk decay field is JSON key **`lambda`** (aliased to `lambda_`).

Example (force Phase-2 with a long timeout):
```bash
curl -s --max-time 120 -X POST localhost:8200/ask \
  -H 'content-type: application/json' \
  -d '{"query":"线上服务 502 报错根因？","top_k":8,"force_phase2":true}'
```
