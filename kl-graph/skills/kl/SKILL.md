---
name: kl
description: Query the DingTalk spatio-temporal knowledge graph (tens of thousands of messages/chunks, plus entities, facts, and multi-resolution communities). Use when answering questions about workplace conversations, team structures, project decisions, people, or system relationships from the DingTalk export. Triggered by questions about who said what, project timelines, team composition, technical decisions, conceptual/aggregate questions about a person ("what are my recent tasks", "what does X mainly work on" — use `kl global-search`), or any question that can be grounded in workplace chat history.
---

# Knowledge Graph Query (kl)

CLI tool for querying a spatio-temporal knowledge graph built from DingTalk workplace messages (and other exported sources). Contains entities (people, systems, projects), facts (decisions, statuses, relations), and multi-resolution community structures. Run `kl status` for live counts.

**Architecture**: kl CLI is a thin HTTP client talking to kl-server (port 8200). The server keeps Qdrant + SQLite warm in memory. All commands require the server to be running.

## Invoking `kl` (any directory, macOS & Windows)

The examples below write `kl ...` / `./kl ...` for brevity, but the repo can be
installed **anywhere**, so never hardcode a path. **Discover the repo root at
runtime, then invoke `kl` relative to it.**

Discover the repo root (call it `KL_REPO`):

- This skill file lives at `<repo>/skills/kl/SKILL.md`, so the repo root
  is **three directories up from this file** — if you know this file's path, use
  its `../../..`.
- Otherwise walk up from the current directory until you find the marker files
  (the `kl` script + `kl_cli.py`):
  ```bash
  # macOS / Linux
  KL_REPO="$PWD"
  while [ "$KL_REPO" != "/" ] && [ ! -f "$KL_REPO/kl_cli.py" ]; do
    KL_REPO="$(dirname "$KL_REPO")"
  done
  ```
  ```powershell
  # Windows (PowerShell)
  $KL_REPO = (Get-Location).Path
  while ($KL_REPO -and -not (Test-Path (Join-Path $KL_REPO 'kl_cli.py'))) {
    $KL_REPO = Split-Path $KL_REPO -Parent
  }
  ```

Then invoke it (works from any directory):

- **macOS / Linux** — the `kl` wrapper `cd`s into its own directory, so calling
  it via `$KL_REPO` works from anywhere:
  ```bash
  "$KL_REPO/kl" status
  "$KL_REPO/kl" ask "..."
  ```
  Equivalent direct form: `"$KL_REPO/.venv/bin/python" "$KL_REPO/kl_cli.py" status`.
- **Portable rule of thumb:** if `./kl` fails (wrong directory, or Windows),
  fall back to invoking the venv interpreter on `kl_cli.py` with the same
  arguments — the venv Python is at `.venv/bin/python` on macOS/Linux and
  `.venv/Scripts/python.exe` on Windows. On Windows, see the dedicated
  section below for bash-specific syntax and encoding requirements.

## Invoking on Windows (read this if you are on win32)

**AIAssist agents run in bash on Windows, not PowerShell.** The macOS/Linux
examples above (`$KL_REPO/kl`) and old PowerShell snippets (`&
"$KL_REPO\.venv\..."`) **neither works in the agent's bash shell**. Use the
patterns below instead.

### 1. Always set PYTHONUTF8=1

Windows defaults to GBK / cp1252 for console encoding. Without `PYTHONUTF8=1`,
any `print()` or log line containing Chinese characters (group names, entity
names, fact text) will crash with `UnicodeEncodeError` or produce garbled
output you cannot read. Set it as the **first thing** before any `kl` command:

```bash
export PYTHONUTF8=1
```

Or prefix every invocation inline:

```bash
PYTHONUTF8=1 "$KL_REPO/.venv/Scripts/python.exe" "$KL_REPO/kl_cli.py" status
```

### 2. Use bash syntax: forward slashes, not backslashes

The venv Python lives at `.venv/Scripts/python.exe` (note: `Scripts`, not
`bin`). In bash, use **forward slashes** throughout — backslashes are escape
characters in bash, so `"$KL_REPO\.venv\Scripts\..."` will break.

```bash
# Discover the repo root (agent runs in bash, not PowerShell)
KL_REPO="$PWD"
while [ "$KL_REPO" != "/" ] && [ ! -f "$KL_REPO/kl_cli.py" ]; do
  KL_REPO="$(dirname "$KL_REPO")"
done

# All subsequent calls use forward slashes
PYTHONUTF8=1 "$KL_REPO/.venv/Scripts/python.exe" "$KL_REPO/kl_cli.py" status
PYTHONUTF8=1 "$KL_REPO/.venv/Scripts/python.exe" "$KL_REPO/kl_cli.py" ask "你的问题" --pretty
```

### 3. Environment variables: use `export`, not `set`

The `.env` file in the repo uses Windows CMD `set` syntax, which bash cannot
`source`. Instead, export each variable explicitly in bash before starting
the server or querying:

```bash
export PYTHONUTF8=1
export KL_DATA_DIR="$KL_REPO/data"
export KL_DWS_EXPORT_DIR="$KL_REPO/dataset/<your-export-dir>"
export KL_EMBED_BASE_URL=<your-embed-endpoint>/v1
export KL_EMBED_MODEL=Qwen3-Embedding-0.6B
export KL_EMBED_API_KEY=<your-key>
export KL_EMBEDDING_DIM=1024
export KL_EMBED_SEND_DIMENSIONS=0
export KL_LLM_BASE_URL=<your-llm-endpoint>
export KL_LLM_MODEL=qwen3.6-flash
export ANTHROPIC_AUTH_TOKEN=<your-token>
export DISABLE_AIOHTTP_TRANSPORT=True
export KL_SERVER_PORT=8200
```

### 4. Start the server in bash (not via `./kl`)

The `./kl` wrapper script may not work on Windows. Start the server directly.
**Prerequisite:** all environment variables from section 3 must be exported
in the same shell session first — the server needs `KL_EMBED_*`, `KL_LLM_*`,
etc. to function:

```bash
# (env vars from section 3 must already be exported in this shell)

PYTHONUTF8=1 "$KL_REPO/.venv/Scripts/python.exe" "$KL_REPO/kl_server.py" &
sleep 15  # Qdrant warmup
PYTHONUTF8=1 "$KL_REPO/.venv/Scripts/python.exe" "$KL_REPO/kl_cli.py" status
```

### 5. Quick reference: the complete pattern

```bash
# One-time per session: discover repo + set encoding
export PYTHONUTF8=1
KL_REPO="$PWD"
while [ "$KL_REPO" != "/" ] && [ ! -f "$KL_REPO/kl_cli.py" ]; do
  KL_REPO="$(dirname "$KL_REPO")"
done
export KL_REPO

# Environment variables (adjust paths/values for your setup)
export KL_DATA_DIR="$KL_REPO/data"
export KL_DWS_EXPORT_DIR="$KL_REPO/dataset/<your-export-dir>"
export KL_EMBED_BASE_URL=<your-embed-endpoint>/v1
export KL_EMBED_MODEL=Qwen3-Embedding-0.6B
export KL_EMBED_API_KEY=<your-key>
export KL_EMBEDDING_DIM=1024
export KL_EMBED_SEND_DIMENSIONS=0
export KL_LLM_BASE_URL=<your-llm-endpoint>
export KL_LLM_MODEL=qwen3.6-flash
export ANTHROPIC_AUTH_TOKEN=<your-token>
export DISABLE_AIOHTTP_TRANSPORT=True
export KL_SERVER_PORT=8200

# Start server (if not already running)
PYTHONUTF8=1 "$KL_REPO/.venv/Scripts/python.exe" "$KL_REPO/kl_server.py" &
sleep 15

# Query
PYTHONUTF8=1 "$KL_REPO/.venv/Scripts/python.exe" "$KL_REPO/kl_cli.py" status
PYTHONUTF8=1 "$KL_REPO/.venv/Scripts/python.exe" "$KL_REPO/kl_cli.py" ask "session打标进度" --pretty
```

### 6. Request timeout

The CLI HTTP timeout defaults to **120 seconds** (configurable via
`KL_CLI_TIMEOUT`). If `kl ask` times out, it usually means Phase-2 LLM
synthesis is slow — the server may still complete the request; check
`kl status` for server health. To allow more time:

```bash
export KL_CLI_TIMEOUT=180  # 3 minutes
```

## End to End (build → ingest → query)

First-time setup from a raw DWS export to answering questions. Steps 1–4 are
the one-time **build**; after that you only use step 5 (query), and re-run the
ingest when new data arrives.

```bash
# 1. BUILD: install deps + point at your endpoints and data (env-only, no
#    secrets are baked into the repo). Put the config in a local .env file
#    (gitignored) and source it before starting the server:
pip install -r requirements.txt
set -a; source .env; set +a          # load KL_* + ANTHROPIC_AUTH_TOKEN
```

The repo ships a `.env` at the project root (gitignored — never commit it)
with working endpoints. Nothing auto-loads it, so you must `source` it as above.
It sets:

```bash
# data + export
export KL_DATA_DIR=./data                      # where knowledge.db + qdrant land
export KL_DWS_EXPORT_DIR=/path/to/dws_export   # the exported source folders

# embedding: PAI-EAS Qwen3-Embedding-0.6B (1024-dim). URL MUST end in /v1;
# KL_EMBEDDING_DIM MUST match the model (1024) — it is baked into the Qdrant
# collections, so changing models later requires wiping + re-embedding.
export KL_EMBED_BASE_URL=<your-embed-endpoint>/v1
export KL_EMBED_MODEL=Qwen3-Embedding-0.6B
export KL_EMBED_API_KEY=<embedding-api-key>   # real value lives only in .env
export KL_EMBEDDING_DIM=1024
export KL_EMBED_SEND_DIMENSIONS=0

# extraction/synthesis LLM: qwen3.6-flash (Anthropic-compatible base;
# do NOT append /v1 — litellm adds /v1/messages itself).
export KL_LLM_BASE_URL=https://example.com/apps/anthropic
export KL_LLM_MODEL=qwen3.6-flash
export ANTHROPIC_AUTH_TOKEN=<api-key>   # real value lives only in .env
```

```bash
# 2. SERVE: start the retrieval server first (ingest runs inside it).
./kl start
kl status                                      # wait for "status": "ready"

# 3. INGEST: drive the whole build through the running server. This runs
#    Phase A (chunk+embed every source) → Phase B (LLM extract + build+embed
#    the graph) → the improve step (ENTITY_SIMILAR/FACT_SIMILAR edges +
#    communities L0–L3), then hot-swaps the new graph in. Non-blocking.
kl ingest -d "$KL_DWS_EXPORT_DIR"              # omit -d to use $KL_DWS_EXPORT_DIR
kl status                                      # poll: "Ingest: running NN% (phase)"

# 4. COMMUNITY SUMMARIES (optional but recommended): kl ingest builds the
#    community structure but NOT their summaries/vectors. These two steps add
#    1–2 sentence summaries and make `search -c communities` work.
python -m kl_graph.periodic.community_summarizer   # 1–2 sentence summary/community
python scripts/embed_communities.py                # embed summaries (search -c communities)

# 5. QUERY: ask questions (see Retrieval Patterns below).
kl ask "who decided to use e2b for sandbox" -k 5
kl context <fact_id>                               # ground the answer in source
```

Notes:

- `kl ingest` **upserts** into the current DB (deterministic UUID5 ids mean
  re-ingesting never duplicates entities/facts); it has no wipe flag, so for a
  truly clean rebuild `rm -rf "$KL_DATA_DIR"` before step 2. `--no-improve`
  skips the community/PageRank step; `-c N` raises extraction concurrency.
- For a **cold/scripted build without a running server**, the offline
  equivalents are `python -m scripts.ingest --fresh-db` (Phase A + B, `--fresh-db`
  wipes `knowledge.db` — which now holds the extraction cache, so the cache is
  cleared too) followed by
  `python -m scripts.improve --skip-llm-judge`. `kl ingest` is the preferred
  path when the server is up.
- Community columns (`community_L0..L3`) come from the improve step; without it
  `community`/`members` are empty and `entity` shows no community labels.

## Commands

```bash
# Lifecycle
kl status              # Server status + DB stats (+ ingest progress)
kl start               # Start kl-server (retrieval)
kl start embedding [--model P] [--dp N] [--tp N] [--port 8100] [--gpu-util 0.4]
kl stop                # Stop both servers
kl stop embedding      # Stop only the embedding server
kl ingest [-c N] [-d PATH] [--no-improve]  # in-server background ingest (Phase A + B)

# All commands require kl-server running (kl start)
kl entity "<name>"     # Entity lookup by name (substring); shows id +
                       #   communities + top edges + facts about it (id + text)
                       #   + ENTITY_SIMILAR neighbors ("similar", with names)
kl entity --id <id>    # Same, but look up by entity id (exact or prefix).
                       #   Add --no-similar to skip the ENTITY_SIMILAR block.
kl facts <entity_id>   # Facts ABOUT an entity (id + text), confidence-sorted
kl facts --fact-id <id>  # A single fact by its id (exact/prefix); minimal —
                       #   use `kl context` for full source provenance
kl expand <entity_id>  # [DEPRECATED] ENTITY_SIMILAR neighbors — same as the
                       #   "similar" block of `kl entity --id <id>`
kl community [-l L0|L1|L2|L3] [-t entity|fact] [--id N]
kl members <id> [-l L1] [-t entity]
kl context <fact_id>   # Source message + context + entities
kl timeline "<entity>" [--from YYYY-MM-DD] [--to YYYY-MM-DD]
kl stats               # Detailed statistics
kl search "<query>" [-c chunks|messages|facts|entities|communities] [-k 10]  # vector ANN, one collection
kl ask "<question>" [-k 10] [--phase2] [--seed-k 6] [--radius 1] [--max-nodes 40]  # hybrid retrieval + graph walk (+ optional synthesis)
kl global-search "<question>" [--user "<name>"] [--json]  # GraphRAG map-reduce over a person's community summaries
kl hop -n <node_id> -c '<cursor_json>'   # expand one node one hop deeper (no LLM/embed)
```

**Ingest is two phases** (`kl ingest` for in-server background ingest, or
`python -m scripts.ingest` for a cold/scripted build):
**Phase A** loads + chunks + embeds *every* source folder (chat + wiki/mail/
work/…) into SQLite `chunks` + Qdrant — no LLM, dense/BM25 recall works after
this. **Phase B** runs LLM entity/fact extraction over all chunks, then builds
and embeds the graph (the only LLM-billed phase; results are cached per chunk).
Watch progress with `kl status` (`Ingest: running NN% (phase)`).

> **Run the full ingest (Phase A + Phase B) — `kl ingest` does both.** But you
> don't have to *wait* for Phase B: the service is usable as soon as **Phase A**
> completes (search/ask work off dense + BM25 recall), so start querying while
> Phase B is still running. **Phase B then improves performance/accuracy** by
> adding the entity/fact graph on top — check `kl status` to see when it lands.

Offline build (needs `KL_DWS_EXPORT_DIR`, `KL_DATA_DIR`, `ANTHROPIC_AUTH_TOKEN`,
`KL_EMBED_API_KEY` in the env):

```bash
python -m scripts.ingest --fresh-db                # Phase A + Phase B (fresh)
python -m scripts.improve --skip-llm-judge         # ENTITY_SIMILAR/FACT_SIMILAR + communities L0–L3
python -m kl_graph.periodic.community_summarizer   # 1–2 sentence summary/community
python scripts/embed_communities.py                # embed summaries (search -c communities)
```

- With no flag, `scripts.ingest` runs the full pipeline with **smart resume**:
  if Phase A is fully done (every chunk persisted *and* embedded) it skips to
  Phase B, else it re-runs Phase A. `--phase-a` = chunk+embed only (no LLM).
- `--fresh-db` wipes `knowledge.db` + the Qdrant dir. The extraction cache now
  lives in the `extraction_cache` table **inside** `knowledge.db`, so `--fresh-db`
  clears it too. To rebuild the graph **without** re-billing the LLM (reusing the
  cache), run `python -m scripts.ingest --build-only` **without** `--fresh-db`.
  To wipe everything, `rm -rf "$KL_DATA_DIR"` first.
- Ids are deterministic UUID5s of normalized content, so re-ingesting never
  duplicates entities/facts.
- Community columns (`community_L0..L3`) are created **only** by
  `scripts.improve` (or `kl ingest` unless `--no-improve`); without them
  `community`/`members` are empty and `entity` shows no community labels.

To ingest a new export into the **running server** (non-blocking — it keeps
serving and hot-swaps the new graph in when done):

```bash
kl ingest -d /path/to/dws_export     # start Phase A → B in the background
kl status                            # poll: "Ingest: running NN% (phase_a|phase_b)"
# -c N raises LLM extraction concurrency (default 8); --no-improve skips
# community detection/PageRank; omit -d to use $KL_DWS_EXPORT_DIR.
```

`search` returns raw nearest-neighbor hits from a single collection (default
`facts`; other collections: `chunks`/`messages`, `entities`, `communities` —
`chunks` is the unified retrieval-unit collection for all embedded source
content, and `messages` is a backward-compat alias for it). `ask` runs the full engine over chunks+facts (dense+sparse+RRF) **and**
walks the depth-1 graph from the entities/facts the query extracted — one call,
one LLM invocation. It may also return a synthesized `answer` (opt-in via
`--phase2`). Both output JSON by default; add `--pretty` for a human view, or
`--json` to force JSON explicitly. (The browsing commands like `entity` /
`community` also support `--json`.)

### `ask` returns retrieval + a hoppable subgraph

A single `kl ask "<query>"` call returns both flat recall and an interactive
graph view:

- `items`: the embedding-recalled items (dense+sparse+RRF fused facts+chunks),
  cut at `top_k`. This is the flat vector recall.
- `answer`: LLM synthesis, or `null` unless Phase 2 escalated / `--phase2` set.
- `seeds`: entry nodes as `{id, label}` (`ent:<uuid>`/`fact:<uuid>` + name/text).
- `nodes`: seeds (hop 0) **plus** the hop-1 frontier reached from them, each
  resolved to `{id, type, score, hop, name|text, ...}`.
- `edges`: `{from, to, from_label, to_label, type, weight}` — the walkable edges
  (`ABOUT`/`INVOLVES`); `*_label` inline the endpoint name/text so an edge is
  self-describing. `from`/`to` are node ids in `nodes`.
- `expandable`: `{id, label}` for nodes that still have further un-walked edges.
- `cursor`: opaque walk state — pass it to `kl hop` to expand a node one more
  hop (no LLM, no embed).

When the graph is not built the walk fields come back empty
(`mode="chunks_only"`) and only `items` are populated.

To go deeper, feed an `expandable` id + the `cursor` to `kl hop` (pass the
`.id` from an `expandable`/`seeds` entry):

```bash
kl hop -n <expandable_id> -c '<cursor json from ask>' --pretty
```

`hop` returns **only the newly revealed frontier** (`nodes`/`edges`) plus an
updated `cursor` — the server is stateless between hops, so merge the frontier
into the graph you already hold and chain `hop` again with the new cursor. It
never re-embeds or calls the LLM.

Note the decay: each hop multiplies a node's score by `λ` (default 0.6) and
drops branches below `mini_threshold` (0.2). With these defaults real query
seeds (~0.5–0.6) reach **depth 2** and a strong seed reaches depth 3 — a node
survives while `score × 0.6^hop ≥ 0.2`. Weak/deep nodes eventually return an
empty hop; that is the expected stop signal, not an error.

`graph` / `hop` are the interactive GraphRAG mode — see "Interactive Graph Walk"
below. The embedding server (`kl start embedding`) is only needed on a GPU host;
retrieval itself uses the remote embedding endpoint, so `kl start` alone is
enough for querying.

## Command Best Practices

How to use `kl` well, in priority order:

1. **Check the server first.** Every query command needs `kl start` running;
   run `kl status` and confirm `"status": "ready"` before querying. If a build
   is in progress, remember the service is usable after Phase A.
2. **Plan before you query.** Think about what the user is really asking and
   which commands answer it; don't fire commands blindly (see the Query
   strategy callout under Retrieval Patterns).
3. **Start with `kl ask`, avoid `kl search`.** `kl ask` is the primary entry
   point (hybrid retrieval + graph walk); reserve `kl search` for narrow
   single-collection lookups `kl ask` can't serve. For **conceptual,
   person-scoped "what has X been about / what are my recent tasks" questions**
   that need aggregation rather than a single hit, use `kl global-search`
   (see Retrieval Pattern 8).
4. **Trace before you trust.** Ground every claim in source: take a `fact_id`
   from `ask`/`entity`/`facts`/`timeline` and run `kl context <fact_id>` to see
   the original message before reporting it.
5. **Discriminate semantic relevance before drilling.** `kl ask` and `kl search`
   return nearest-neighbour hits by embedding similarity — this surfaces
   keyword-overlap results that may be **semantically unrelated** to your
   actual question (e.g. a query about "session 打标障碍" may return results
   about model evaluation timeouts or billing identification simply because
   they share the words "session", "超时", or "标识"). Before running
   `kl context`, hopping the graph, or synthesizing an answer, **pause and
   ask: does this result actually address the user's question, or does it just
   share vocabulary?** Filter out the irrelevant hits, note which results
   genuinely match, and **do not follow irrelevant paths** into `context` or
   `hop` — that wastes the query budget and pollutes the answer with
   off-topic evidence. When in doubt, rephrase the query with more specific
   terms rather than stacking broad keywords.
6. **Chain by id, not by name.** Every id `kl` prints is traceable
   (`entity` → `entity_id` → `kl facts` → `fact_id` → `kl context`). Prefer ids
   when chaining — names aren't unique (e.g. two `周强` entities), so a
   name-based `timeline`/`entity` may mix them up.
7. **Show evidence, then conclude.** Quote the raw `kl` output first, then give
   your synthesis (see the Answering callout under Retrieval Patterns).
8. **Respect the budget.** Cap at ~10 commands per question; stop once you have
   ≥3 grounded facts or two consecutive queries add nothing new (see Search
   Budget & Stop Criteria).
9. **Use `--json` for chaining, `--pretty` for humans.** Query commands emit
   JSON by default (easy to parse ids out of); pass `--pretty` when showing a
   person a result. `--json` always wins if both are given.
10. **Widen before narrowing on empty results.** If `kl ask` comes back thin,
    try a broader phrasing or `kl community` to find the right neighborhood,
    then drill via `kl members` → `kl context`.

## Latency Profile

| Command type | Typical latency |
|---|---|
| entity, expand, context, community, members | 30-50ms server-side |
| timeline (with date filter or low-degree) | 30-50ms |
| timeline (high-degree, no filter) | auto-filtered to 90 days |
| search (single-collection ANN) | remote embed + Qdrant ANN |
| ask (hybrid; may synthesize) | dense+sparse+RRF + hop-1 graph walk; +LLM when it escalates to Phase 2 |
| global-search (map-reduce over communities) | 1 map + 1 reduce LLM call (~30s on the `ok` path); 0 ms / 0 LLM on no-data |
| hop (expand one node) | no embed/LLM — pure in-memory adjacency (fastest) |
| CLI total (Python startup + httpx) | +1.5s overhead |

`ask` is slower when it escalates to Phase-2 synthesis (an extra LLM call).
Embeddings are served by the configured remote endpoint (`KL_EMBED_*` env
vars); the embedding dimension is fixed at build time, so changing models
requires a full re-embed.

## Retrieval Patterns

> **Query strategy (read first).** Before running any `kl` command, think
> carefully about what the user is actually asking and which commands will
> answer it — plan the sequence, don't fire commands blindly. **Always start a
> search with `kl ask`** (hybrid retrieval + graph walk + optional synthesis);
> it is the primary entry point. **Avoid `kl search`** — it is a low-level
> single-collection vector ANN and should only be used for narrow, specific
> lookups when `kl ask` clearly can't serve the need.

> **Answering — show evidence, then conclude.** To make results trustworthy,
> first quote the **original text you got from `kl`** (the raw message/fact
> content, verified with `kl context` where possible), then give **your
> conclusion** drawn from it. Lead with the source evidence, follow with your
> synthesis — never present a conclusion without the underlying `kl` output it
> rests on.

> **Semantic mismatch — filter before you drill.** Embedding-based retrieval
> (`ask`, `search`) ranks by vector proximity, which measures **keyword
> overlap**, not **topical relevance**. A result about "session 超时" in a
> model-benchmarking conversation is *not* an obstacle to "session 打标" work,
> even though both contain "session" and "超时". Before spending `context` or
> `hop` calls on any hit, ask: *"Is this about the same topic the user asked
> about, or does it just share words?"* Discard the misses silently, do not
> summarize them as "evidence found but not relevant" — that wastes the
> reader's attention. If fewer than 3 hits survive the filter, **rephrase the
> query** with more specific terms (e.g. "session 打标 进度" instead of
> "session 打标 障碍 超时 模型 训练") and query again, rather than padding the
> answer with off-topic results.

### 1. Direct Answer (factual questions)

```bash
kl ask "who decided to use e2b for sandbox" -k 5   # hybrid retrieval + synthesis
kl context <best_fact_id>                          # ground the answer in source
```

### 2. Entity Deep-Dive (about a person/project/system)

```bash
kl entity "周强"                    # id + "similar" (ENTITY_SIMILAR) + top facts (with fact_ids)
kl facts <entity_id>                 # all facts ABOUT it (fact_id + text)
kl context <fact_id>                 # ground a fact in its source message
kl community -l L2 --id <community_id>
kl members <community_id> -l L2 -t fact
kl timeline "周强" --from 2026-06-01
```

**Id-driven trace-back (no name round-trip):** every id `kl` prints is
traceable. `kl entity` returns an `entity_id` plus the facts about it; feed the
`entity_id` back with `kl entity --id <id>` (or `kl facts <entity_id>` for the
full list), then any `fact_id` to `kl context` for the exact source message
(or `kl facts --fact-id <id>` for just the fact text). The `similar` block also
shows each ENTITY_SIMILAR neighbor's name + full `entity_id`, so you can
`kl entity --id`/`kl facts` on those too. Prefer ids over names when chaining
— names aren't unique (e.g. two `周强` entities).

(To find a person/system when unsure of the exact surface form, use
`kl search "<term>" -c entities` for a semantic entity lookup.)

### 3. Broad Survey (exploratory)

```bash
kl search "sandbox architecture" -c communities -k 5  # Find relevant communities
kl members <community_id> -l L2 -t fact               # Read the facts
kl context <fact_id>                                   # Ground in source
```

Or browse linearly:

```bash
kl community -l L1 -t entity    # Team-level (best starting point)
kl community -l L2 --id 8       # Drill into a project
kl members 8 -l L2 -t entity    # Who's in it?
```

### 4. Alias Resolution

```bash
kl entity "张伟"
kl entity --id <entity_id>       # the "similar" block lists ENTITY_SIMILAR links
```

### 5. Timeline

```bash
kl timeline "InkFlow" --from 2026-06-01 --to 2026-07-01
```

### 6. Topic Discovery

```bash
kl community -l L1 -t fact      # What topics exist?
kl community -l L2 -t fact --id 5  # Detail on one
kl members 5 -l L2 -t fact         # Read facts
```

### 7. Interactive Graph Walk (relationship / multi-hop questions)

Use `ask` when the question is about *how things connect* (who works with whom,
what a decision depends on, how a system relates to a project). A single `ask`
call already returns both flat recall (`items`) **and** a hoppable subgraph
(`seeds`/`nodes`/`edges`/`expandable` + a `cursor`) — walked from the
entities/facts the query extracted. There is **no separate `graph` command**;
the walk is built into `ask`.

```bash
kl ask "e2b 部署平台和谁相关" --seed-k 6 --max-nodes 40   # items + seeds + hop-1 subgraph (JSON)
kl ask "e2b 部署平台和谁相关" --pretty                    # human view + expandable ids
```

The response includes `nodes`, `edges`, an `expandable` list of node ids, and a
`cursor` object. To go deeper, expand a specific node one hop with `hop`,
passing the `cursor` back so visited state and decay carry over:

```bash
# take an id from "expandable" and the "cursor" object from the ask response
kl hop -n "ent:<id>" -c '<cursor-json-from-previous-response>'
```

Notes:

- Node ids are namespaced: `ent:<entity_id>` and `fact:<fact_id>`.
- If the graph isn't built, `ask` falls back to `mode="chunks_only"` (flat
  vector hits) in the same response shape — check the `mode` field.
- `hop` does no embedding/LLM (pure in-memory walk) — cheap to chain.
- Ground any interesting fact node with `kl context <fact_id>` as usual.

### 8. Global Search (conceptual / aggregate questions about a person)

Use `kl global-search` when the question is **conceptual and person-scoped** —
it must be *aggregated* over everything a person has been involved in, not
answered by any single chunk/fact. Canonical example: *"我最近的任务是什么"*
(what are my recent tasks?), *"这个人主要负责什么"* (what does this person mainly
work on?). Where `ask` does flat recall + a depth-1 graph walk, `global-search`
resolves the person to a Person entity, collects **that person's community
summaries across L0–L3**, and runs a GraphRAG-style **map-reduce** over them
(strict-JSON key points scored 0–100 → drop score-0 → importance-sort →
token-budgeted reduce → grounded markdown with `[Data: Communities (...)]`
citations).

```bash
kl global-search "我最近的任务是什么" --user "孙亮"   # explicit person
kl global-search "这个人主要负责什么"                    # identity via DWS get-self
kl global-search "我最近的任务是什么" --json            # full wire shape for chaining
```

Identity resolution precedence: **`--user <name>`** → **DWS `get-self`** (the
CLI shells out to `dws contact user get-self` for the logged-in user) →
otherwise the server's `KL_CURRENT_USER`. The response carries `reason`,
`communities` (the selected `{level, community_id, member_count}`), `citations`,
and `diagnostics` (map/reduce call counts, latency).

When there is **no grounding** — the name doesn't resolve
(`reason=identity_unresolved`), or the person has no community memberships
(`reason=no_communities`) — it returns a **canned bilingual no-data answer in
~0 ms with ZERO LLM calls** plus a remediation hint (e.g. run
`python -m scripts.improve`). It never falls back to a corpus-wide search or
errors out.

Requires the community layer to be built **and summarized**: `kl ingest` /
`scripts.improve` create the `community_L0..L3` columns, and
`python -m kl_graph.periodic.community_summarizer` generates the summaries this
command reads. Without summaries every query returns `no_communities`.

> **Caveat — summaries are name-based, not task-based (today).** Community
> summaries are built from member *names/aliases*, so a person whose graph
> neighborhood is dominated by identity/HR material may get a thin, honest
> "can't pin down concrete tasks" answer even on the `ok` path. That is a data
> limitation, not a retrieval bug — prefer `ask`/`facts`/`timeline` for
> specific, dateable task lookups, and use `global-search` for the high-level
> "what has this person been about" shape.

## Community Hierarchy

Drill-down pattern for navigating the graph:

```
L0 (org-level)       -> "Which team?"
L1 (team-level)      -> "Which project?"       <- BEST STARTING POINT
L2 (project-level)   -> "Which component?"
L3 (component-level) -> "Specific facts + evidence"
```

## Search Budget & Stop Criteria

### When to STOP drilling

- You have ≥3 grounded facts (with `kl context` verification) that **genuinely
  match the user's question** and answer it
- You've reached L3 community level (most granular — no further drill-down)
- Two consecutive queries returned no new **semantically relevant** information
- The user's question is answered with high confidence from existing results
- A query returns only keyword-overlap hits with no topically relevant result —
  **rephrase and retry once**; if still no match, report what you found rather
  than forcing off-topic evidence into the answer

### Rejection signals — do NOT drill into these

- The result shares keywords ("session", "超时", "模型") but discusses a
  different topic (benchmarking, billing, deployment) than what the user asked
- The surrounding context (`kl context`) reveals the conversation is about a
  different project or task than the question targets
- A fact's `subject_entity` or `object_entity` is unrelated to the question's
  domain — the connection is coincidental keyword overlap, not topical
  similarity
- A graph `hop` expands into entities/facts that are clearly off-topic from the
  seed — stop expanding that branch immediately

### Query budget per question

- Simple factual: 2-3 commands (ask → context → done)
- Entity deep-dive: 4-6 commands (entity → facts → context, or entity → community → members → timeline → context)
- Broad survey: 5-8 commands (community L1 → pick → L2 → members → context × 2-3)
- Relationship / multi-hop: ask (walks the graph) → hop (× 1-2 on expandable ids) → context
- Maximum: 10 commands per question before synthesizing what you have

### Confidence signals

- Fact type=DECISION with confidence≥0.9 → high reliability
- Multiple facts from different messages saying the same thing → confirmed
- Single fact from one message → report but flag as single-source
- Community summary matching your query with score≥0.8 → right neighborhood

## Key Notes

- Entity names are Chinese and English: "周强", "InkFlow", "VS Code"
- Fact IDs support prefix match: `kl context 49d8370a`
- High-degree entities (>200 edges) get auto-filtered to last 90 days on timeline (use --from/--to to override)
- Check `kl status` first — if server not running, use `kl start`
- Time range: 2025-09 to 2026-07
