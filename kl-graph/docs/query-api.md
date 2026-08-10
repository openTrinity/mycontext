# Query API

HTTP reference for reading and searching a running KL-Graph server. The default
base URL is `http://127.0.0.1:8200`. Retrieval endpoints use `POST` with a JSON
body; capability discovery uses `GET`. The server also publishes generated
OpenAPI documentation at `/docs` and the raw schema at `/openapi.json`.

Community features are disabled by default through
`pipelines.experimental.communities.enabled` (`KL_COMMUNITIES_ENABLED=0`). While disabled,
community vectors are not opened, `COMM_MEMBER` edges are excluded from the
serving adjacency index, `/global_search` returns
`reason: communities_disabled`, and direct community endpoints return 404.
Existing community artifacts remain on disk and are used again only after the
gate is enabled and a full improvement refreshes them.

## Conventions

- Timestamps are Unix epoch milliseconds. Timeline date filters use
  `YYYY-MM-DD`.
- Stored IDs are bare IDs. Interactive graph responses namespace them as
  `ent:<id>`, `fact:<id>`, `cnk:<id>`, and `comm:<id>` so node types cannot
  collide.
- A server that is not ready returns HTTP `503`. Missing exact resources
  generally return `404`; lookup endpoints such as `/entity` and `/timeline`
  return successful empty results.
- Graph-backed endpoints read the backend-neutral in-memory adjacency index.
  They work the same way whether the configured graph authority is LadybugDB or
  SQLite.

## Endpoint overview

| Endpoint | Purpose |
|---|---|
| `GET /capabilities` | Discover the live feature-gated query command surface |
| `/search` | Vector search within one collection |
| `/ask` | Hybrid retrieval, optional answer synthesis, and initial graph walk |
| `/global_search` | Community-summary map/reduce for conceptual questions |
| `/entity` | Find entities by name substring |
| `/expand` | Read an entity's `ENTITY_SIMILAR` neighbors |
| `/facts` | Read facts connected to one entity by `ABOUT` |
| `/neighbors` | Batch exact graph-neighbor reads with filters and pagination |
| `/community` | List communities or read one community summary |
| `/members` | List the entity or fact members of a community |
| `/context` | Read a fact, its source chunk, entities, and nearby chat context |
| `/timeline` | Read an entity's facts over time |
| `/graph_hop` | Continue the interactive graph walk returned by `/ask` |
| `/chunk` | Batch-read full chunk content by ID |
| `/path` | Find shortest graph paths between two entities |

### `GET /capabilities`

Agents and other dynamic callers should query this before choosing a retrieval
command. The response is server-derived and therefore reflects feature gates
used by the running process:

```json
{
  "schema_version": 2,
  "features": {
    "communities": {"enabled": false, "experimental": true}
  },
  "commands": {
    "ask": {
      "enabled": true,
      "caller_intent": true,
      "synthesize_default": false,
      "entity_types": ["PERSON", "SYSTEM", "PROJECT", "ORGANIZATION", "LOCATION", "DOCUMENT", "UNKNOWN"],
      "fact_types": ["DECISION", "DELEGATE", "STATUS", "CAUSAL", "GENERAL"]
    },
    "global-search": {
      "enabled": false,
      "experimental": true,
      "reason": "communities_disabled"
    }
  }
}
```

The CLI exposes the same contract through `kl capabilities --json`. `ask` is
always available.

## Search and question answering

### `POST /search`

Runs vector similarity search over exactly one collection.

```json
{
  "query": "数据同步策略",
  "collection": "facts",
  "top_k": 10,
  "min_timestamp": null,
  "max_timestamp": null
}
```

`collection` accepts `facts`, `chunks`, `entities`, or `communities`;
`messages` is an alias for `chunks`. Timestamp filters apply to the main
collections. The response contains `collection`, `results`, and latency fields.
Each result has the domain `id`, backend point ID in `point_id`, `score`, and
the stored `payload`.

### `POST /ask`

Runs hybrid retrieval over chunks and facts. It can synthesize an answer and,
when the graph is available, returns the first interactive graph frontier.

```json
{
  "query": "谁负责网络白名单？",
  "top_k": 10,
  "force_phase2": false,
  "intent": {
    "entities": ["网络白名单"],
    "entity_types": ["SYSTEM"],
    "fact_types": ["DELEGATE"]
  },
  "radius": 1,
  "max_fanout": 10,
  "max_nodes": 50,
  "lambda": 0.6,
  "seed_k": 6
}
```

`intent` is optional. Agent callers should derive it from the question and use
the type values advertised by `/capabilities`; supplying it skips the server's
query-rewrite LLM call while the server still vector-resolves entity names.
Without `intent`, the server performs its own rewrite for compatibility with
plain clients.

`force_phase2` is also optional. When omitted it follows
`pipelines.query.ask.synthesize` (`KL_ASK_SYNTHESIZE`, false by default). An
explicit boolean overrides that default. Agent callers normally send `false`
and synthesize their answer from the returned evidence themselves.

Important response fields are:

- `answer`, `items`, `phase`, `entities_found`, and `query_intent_source` for retrieval;
- `mode`, either `graph` or `chunks_only`;
- `graph.components`, `graph.seeds`, and `graph.expandable` for traversal;
- `recalled_chunks` and `graph_mermaids` for display; and
- `cursor`, which must be echoed to `/graph_hop` to continue the same walk.

### `POST /graph_hop`

Expands one namespaced node by one hop without another embedding or LLM call.
For the first standalone hop, omit `cursor` or pass `{}`. When continuing an
`/ask` or previous `/graph_hop` result, echo its complete cursor.

```json
{
  "node_id": "ent:2c1f...",
  "cursor": {
    "visited": {"ent:2c1f...": 1.0},
    "lambda": 0.6
  },
  "max_fanout": 10
}
```

The response contains the newly revealed `graph.components`, `expandable`
nodes, Mermaid diagrams, and the next cursor.

### `POST /global_search`

Answers a conceptual question by map/reducing community summaries associated
with one person.

```json
{
  "query": "我最近参与了哪些项目？",
  "user": "张伟"
}
```

`user` may be omitted when a server-side current-user default is configured.
The response includes `answer`, resolved identity, selected `communities`,
`citations`, diagnostics, and latency. Missing identity or community data is a
grounded HTTP `200` no-data response with a machine-readable `reason`.

## Entity and fact reads

### `POST /entity`

```json
{"name": "张伟", "limit": 20}
```

Returns substring-matched entities ordered by mention count. Each result
includes identity/type, occurrence timestamps, community assignments, degree,
up to five representative edges, and up to five related facts. Use
`/neighbors` for complete edge access and `/facts` for a larger fact list.

### `POST /expand`

```json
{"entity_id": "2c1f..."}
```

Returns only `ENTITY_SIMILAR` entity neighbors. It does not return `ABOUT`,
`MENTIONS`, or other graph relations.

### `POST /facts`

```json
{"entity_id": "2c1f...", "limit": 100}
```

Returns facts connected to the entity by incoming `ABOUT` edges, ordered by
confidence and timestamp. Fact IDs can be passed to `/context`.

### `POST /timeline`

```json
{
  "entity_name": "张伟",
  "from_date": "2026-06-01",
  "to_date": "2026-07-01",
  "limit": 30
}
```

Returns the matched entity, graph degree, facts in reverse chronological order,
and latency. If no date range is supplied for an entity with degree greater
than 200, the server automatically limits results to the last 90 days and sets
`auto_filtered` to `true`.

## Batch exact neighbors

### `POST /neighbors`

Reads exact adjacency for as many as 2,000 typed source nodes in one request.
This is the preferred endpoint for callers that need arbitrary graph relations
or need to derive co-occurrence, such as `entity -> ABOUT facts -> ABOUT
entities`.

```json
{
  "nodes": [
    {"type": "entity", "id": "2c1f..."},
    {"type": "fact", "id": "fact:98ab..."}
  ],
  "edge_types": ["ABOUT"],
  "direction": "both",
  "target_types": ["entity", "fact"],
  "limit_per_node": 100,
  "cursor": {},
  "hydrate": true
}
```

Request fields:

| Field | Meaning |
|---|---|
| `nodes` | Typed source nodes. Types: `entity`, `fact`, `chunk`, `scope`, `community`. Bare or namespaced IDs are accepted. Input order and duplicates are preserved. |
| `edge_types` | Optional case-insensitive allow-list such as `ABOUT`, `STATES`, or `MENTIONS`. `null` means all edge types. |
| `direction` | `in`, `out`, or `both`, relative to each requested source node. |
| `target_types` | Optional neighbor-node type allow-list. |
| `limit_per_node` | Page size independently applied to each source node; range 1–2,000, default 100. |
| `cursor` | Per-node offset map from the preceding response. Use `{}` for the first page. |
| `hydrate` | When true, include type-specific node properties; when false, return only neighbor `type` and `id`. |

Example response shape:

```json
{
  "results": [
    {
      "node": {"type": "entity", "id": "2c1f...", "name": "张伟"},
      "found": true,
      "edges": [
        {
          "type": "ABOUT",
          "direction": "in",
          "node": {"type": "fact", "id": "98ab...", "text": "..."}
        }
      ],
      "total": 2532,
      "has_more": true
    }
  ],
  "count": 1,
  "cursor": {"ent:2c1f...": 100},
  "has_more": true
}
```

Pagination is independent per node. Pass the entire returned `cursor` into the
next request; exhausted nodes retain their final offset and do not restart.
Missing nodes remain aligned with the input and return `found: false`, empty
edges, and total zero. Quarantined entities are omitted from hydrated sources
and neighbors.

## Communities

### `POST /community`

List the largest communities at a level:

```json
{"level": "L1", "node_type": "entity", "top_k": 20}
```

Read one summary by adding `community_id`:

```json
{"level": "L1", "node_type": "entity", "community_id": 8}
```

The list response contains `communities`; the single response contains the
summary, tags, top members, and member count. When summaries are unavailable,
the endpoint returns an empty result or explanatory `error` instead of failing.

### `POST /members`

```json
{
  "community_id": 8,
  "level": "L1",
  "node_type": "fact",
  "limit": 30
}
```

Returns `members`. Entity members include name, type, and mentions; fact
members include text, type, and timestamp.

## Provenance and raw content

### `POST /context`

```json
{"fact_id": "98ab..."}
```

Accepts a full fact ID or an unambiguous ID prefix. Returns `fact`, universal
`source_chunk`, related `entities`, and—when the source is chat—a
`source_message` view plus nearby messages in `surrounding`.

### `POST /chunk`

```json
{"chunk_ids": ["cnk:a1...", "a2..."]}
```

Batch-reads full chunk content. The `chunks` response remains aligned 1:1 with
the request, including duplicates and missing IDs. Each item contains `found`;
found chunks also contain content, source type, timestamp, source reference,
and metadata.

## Paths

### `POST /path`

```json
{
  "source": "张伟",
  "target": "李强",
  "max_hops": 4,
  "all_paths": false,
  "edge_types": null
}
```

`source` and `target` accept entity names or bare entity IDs. `max_hops` is
limited to 1–8. Set `all_paths` to return all shortest paths. `edge_types` can
restrict traversal; `null` uses the graph backend's default relation set. The
response contains resolved endpoints, node/edge sequences, hop counts,
`path_count`, and whether the search was exhausted.

