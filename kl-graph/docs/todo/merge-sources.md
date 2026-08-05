# Merge query funciton in engine.py and graph_walk function in graph_walk.py

## ORIGINAL GOAL

My original goal is to build the query function like the graph_retrieve function in kl_server.py.
So like:
    - Phase 1:
      - Do the query embedding, query_rewrite, entities/facts extraction, and then do BM25, TF-IDF on keyword(entities, facts, etc...) just like the query function
      - [REMARK] the phase 1 is pretty much just like the query function
               in engine.py.

    - Phase 2:
      - the Phase 2 is just like the graph_retrieve, we continue on the 
        engine.query's result to build the depth 1 graph for the agent to explore.

## Questions

[!RED][Q human]: do you think we can just remove the current /ask cli command and replace it with the /graph_retrieve command (namely rename graph_retrieve to /ask)

[A human]: Collapse `/ask` into `/graph_retrieve`, but keep the user-facing name
`ask` (so `kl ask` / `POST /ask` survive; the standalone `/graph_retrieve`
endpoint + `kl graph` command are deleted). No CLI reaches the bare query
function anymore. Keep Phase-2 LLM answer synthesis in the merged endpoint but
default it off (`force_phase2=False`); Phase 2 is really the `gw.graph_walk`
that continues on the entities/facts the query function extracted.

[A agent] DONE: merged `/ask` now runs `engine.query()` (Phase 1) → always
`gw.graph_walk()` seeded from the reused `q_vec` + `matched_entities` (Phase 2,
one LLM call total) → optional synthesis. Returns
`{answer, items, phase, entities_found, mode, seeds, nodes, edges, expandable,
cursor, latency_ms}`. Dropped the redundant `chunks` field (it duplicated
`items`). Deleted `/graph_retrieve` + `GraphRetrieveRequest` + `kl graph` (+ its
mermaid renderer). `/graph_hop` kept (fed by `ask`'s `cursor`). Consumers
updated: `kl_cli.py`, `.claude/skills/kl/SKILL.md`, `instruction.md`.
