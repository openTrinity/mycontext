"""Interactive GraphRAG traversal — pure, I/O-free graph walk + mermaid render.

This module is the structural core of the interactive GraphRAG retrieval mode
(see ``query_process.md`` Part B). It is deliberately free of SQLite/Qdrant/HTTP
so the walk and the mermaid renderer can be unit-tested with a synthetic
adjacency, exactly like the Phase-0 PageRank test.

The walk hops over every edge type **whose both endpoints are valid nodes**
(entity / fact / chunk / community) — the ``WALKABLE`` set (see below). This
includes ``ABOUT`` (fact↔entity), ``MENTIONS``/``AUTHORED_BY`` (chunk↔entity),
``TEMPORAL``/``REPLY_TO`` (chunk↔chunk), ``STATES`` (fact→chunk),
``ENTITY_SIMILAR``/``FACT_SIMILAR``/``ENTAILS``/``CONTRADICTS`` (entity↔entity /
fact↔fact), and ``COMM_MEMBER`` (entity/fact↔community, walkable both
directions). The node-type guard in :func:`graph_walk` is the real gate: any
neighbour whose ``related_type`` is not one of entity/fact/chunk/community is
skipped, so an edge to a non-node (e.g. a bare conversation id) can never be
walked even if present. Scoring is a path-aware multiplicative
decay — a node's score is the best (least-penalized) product of its seed
relevance and the per-hop ``edge_weight × λ`` along any discovered path, so
further-away nodes are monotonically penalized and best-path wins.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence

from kl_graph.models.types import EdgeType

# Edge types the walk traverses: every ``EdgeType`` whose both endpoints are
# valid nodes (entity / fact / chunk / community). ``COMM_MEMBER`` is included
# now that Community is a reified node — memberships are materialized from the
# authoritative ``community_L0..L3`` columns, so node→community and
# community→members are both real hops. Derived from the enum so new
# node-connecting edge types are walkable by construction; the node-type guard in
# :func:`graph_walk` enforces the valid-node rule regardless of this set's
# contents.
_NON_NODE_EDGE_TYPES: set[str] = set()
WALKABLE = {e.value for e in EdgeType} - _NON_NODE_EDGE_TYPES

# Node types the walk models (and will hop onto). related_type -> node-id prefix.
_PREFIX = {
    "entity": "ent",
    "fact": "fact",
    "chunk": "cnk",
    "community": "comm",
}


def namespaced(raw_id: str, node_type: str) -> str:
    """Prefix a bare UUID with its type so entity/fact ids never collide.

    Args:
        raw_id: The bare UUID string as stored in SQLite.
        node_type: One of ``entity`` / ``fact`` / ``chunk`` / ``community``.

    Returns:
        A namespaced id like ``ent:<uuid>`` / ``fact:<uuid>`` / ``cnk:<uuid>`` /
        ``comm:<uuid>``.
    """
    return f"{_PREFIX.get(node_type, node_type)}:{raw_id}"


def strip_prefix(node_id: str) -> str:
    """Return the bare UUID from a namespaced node id (``ent:x`` -> ``x``)."""
    return node_id.split(":", 1)[1] if ":" in node_id else node_id


def node_type_of(node_id: str) -> str:
    """Return the node type implied by a namespaced id's prefix."""
    prefix = node_id.split(":", 1)[0] if ":" in node_id else ""
    for ntype, p in _PREFIX.items():
        if p == prefix:
            return ntype
    return prefix


def edge_weight(edge_type: str, properties: dict | None = None) -> float:
    """Per-edge multiplicative weight used in the decay.

    Every walkable edge type currently carries a flat weight ``1.0``, so the
    per-hop factor is just ``λ``. The term is kept so that a future per-type or
    ``ENTITY_SIMILAR``-confidence weighting (using stored
    ``confidence``/``hybrid_score``) needs no change to the scoring model.
    """
    return 1.0


def _rank_and_cap(
    neighbors: list[tuple],
    max_fanout: int,
    importance_fn: Callable[[str], float],
) -> list[tuple]:
    """Keep the top ``max_fanout`` neighbors, ranked structurally.

    Ordering is query-independent (edge_weight, then the neighbor's intrinsic
    importance via ``importance_fn`` — pagerank for entities, confidence for
    facts). The agent, not the server, decides where to hop next.
    """
    def key(n: tuple):
        etype, rel_id, rel_type, _dir = n
        return (edge_weight(etype), importance_fn(namespaced(rel_id, rel_type)))

    return sorted(neighbors, key=key, reverse=True)[:max_fanout]


def graph_walk(
    adjacency: Mapping[str, Sequence[tuple]],
    seeds: list[tuple[str, float]],
    *,
    radius: int = 1,
    max_fanout: int = 10,
    max_nodes: int = 50,
    lambda_: float = 0.6,
    mini_threshold: float = 0.2,
    importance_fn: Callable[[str], float] | None = None,
    initial_best: dict[str, float] | None = None,
) -> tuple[list[dict], list[dict], dict[str, float]]:
    """BFS with best-score relaxation over the walkable subgraph.

    Args:
        adjacency: ``bare_id -> [(edge_type, related_id, related_type, dir)]``.
            Keyed by the **bare** (un-prefixed) id, as the server builds it.
        seeds: ``[(namespaced_id, seed_relevance)]`` entry points.
        radius: Number of hops to expand (``/ask`` uses 1;
            ``/graph_hop`` uses 1 from a single seed).
        max_fanout: Max neighbors expanded per node (hub guard).
        max_nodes: Hard cap on total discovered nodes.
        lambda_: Per-hop decay factor (<1 → monotonic penalty).
        mini_threshold: Branches scoring below this are not returned.
        importance_fn: ``namespaced_id -> float`` structural importance for the
            fan-out ranking. Defaults to a constant (stable) order.
        initial_best: Pre-seeded ``id -> best score`` map (the echoed cursor's
            ``visited``) so a stateless ``/graph_hop`` prunes already-seen nodes
            unless a cheaper path is found. Seeds are still always emitted.

    Returns:
        ``(nodes, edges, visited)`` where ``nodes`` is
        ``[{id, score, hop}]`` (seeds at hop 0), ``edges`` is
        ``[{from, to, type, weight}]`` (deduped, may show multiple routes), and
        ``visited`` is the full ``id -> best score`` map to echo in the cursor.
    """
    if importance_fn is None:
        importance_fn = lambda _nid: 0.0

    # best carries every prior score (cursor) plus this walk's discoveries, so
    # relaxation is correct across stateless calls. hop_of tracks display depth.
    best: dict[str, float] = dict(initial_best or {})
    hop_of: dict[str, int] = {}

    # Dedup seeds, keeping the strongest relevance per id. Seeds are hop 0 and
    # are always part of the result even if below mini_threshold.
    seed_best: dict[str, float] = {}
    for sid, rel in seeds:
        if sid not in seed_best or rel > seed_best[sid]:
            seed_best[sid] = rel
    for sid, rel in seed_best.items():
        best[sid] = max(best.get(sid, 0.0), rel)
        hop_of[sid] = 0

    edges: list[dict] = []
    edge_seen: set[tuple] = set()
    frontier = [(sid, seed_best[sid], (sid,)) for sid in seed_best]

    for hop in range(radius):
        next_frontier: list[tuple] = []
        for node_id, score, path in frontier:
            neighbors = adjacency.get(strip_prefix(node_id), [])
            neighbors = [n for n in neighbors if n[0] in WALKABLE]
            neighbors = _rank_and_cap(neighbors, max_fanout, importance_fn)
            for etype, rel_id, rel_type, _dir in neighbors:
                # Valid-node rule: only entity/fact/chunk/community are hop
                # targets. Any other related_type is not a modeled node and is
                # skipped here, so it can never be walked even if such an edge is
                # present. ``community`` is included so a walk can both leave a
                # node onto its community and land back on that community's
                # members via ``COMM_MEMBER``.
                if rel_type not in ("entity", "fact", "chunk", "community"):
                    continue
                cand = namespaced(rel_id, rel_type)
                if cand in path:
                    continue  # no cycles within a single path
                new_score = score * edge_weight(etype) * lambda_
                if new_score < mini_threshold:
                    continue  # low branch: not returned to the agent
                # Record the traversed edge (dedup) so the subgraph shows routes.
                ekey = (node_id, cand, etype)
                if ekey not in edge_seen:
                    edge_seen.add(ekey)
                    edges.append({
                        "from": node_id, "to": cand,
                        "type": etype, "weight": edge_weight(etype),
                    })
                # Relaxation: only advance/keep the best path to cand.
                if new_score <= best.get(cand, 0.0):
                    continue
                best[cand] = new_score
                hop_of[cand] = hop + 1
                next_frontier.append((cand, new_score, path + (cand,)))
                if len(hop_of) >= max_nodes:
                    break
            if len(hop_of) >= max_nodes:
                break
        frontier = next_frontier
        if len(hop_of) >= max_nodes:
            break

    # Assemble nodes from everything this walk touched (hop_of), scored by best.
    nodes = [
        {"id": nid, "score": best[nid], "hop": hop_of[nid]}
        for nid in hop_of
    ]
    nodes.sort(key=lambda n: n["score"], reverse=True)
    # Drop edges that point at a node we never materialized (pruned/capped).
    live = set(hop_of)
    edges = [e for e in edges if e["from"] in live and e["to"] in live]
    return nodes, edges, best


# ── Mermaid rendering (agent-parseable structural view) ──────────────────────

def _mm_id(node_id: str) -> str:
    """Mangle a namespaced id into a mermaid-safe node id (no ``:`` / unicode)."""
    prefix = node_id.split(":", 1)[0] if ":" in node_id else "n"
    bare = strip_prefix(node_id)
    safe = "".join(c if c.isalnum() else "_" for c in bare)[:16]
    return f"{prefix}_{safe}"


def _mm_label(text: str, limit: int = 40) -> str:
    """Escape + truncate a label so it can't break mermaid flowchart syntax."""
    text = (text or "").replace("\n", " ").replace("\r", " ")
    # Strip characters that are structural in mermaid node/edge syntax.
    for ch in '"[](){}#|<>':
        text = text.replace(ch, " ")
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


def to_mermaid(nodes: list[dict], edges: list[dict]) -> str:
    """Render a walk subgraph as a mermaid ``graph TD`` flowchart.

    Entities are ``[...]`` boxes, facts are ``(...)`` rounded nodes, chunks are
    ``[/.../]`` parallelograms, and communities are ``{{...}}`` hexagons.  Each
    edge is labelled with its type.  Scores are shown in the node label.  The
    output is mermaid *source* (agents parse it; humans paste into a renderer).
    """
    lines = ["graph TD"]
    for n in nodes:
        nid = n["id"]
        mm = _mm_id(nid)
        ntype = node_type_of(nid)
        label = _mm_label(n.get("name") or n.get("text") or strip_prefix(nid))
        score = n.get("score", 0.0)
        if ntype == "entity":
            lines.append(f'    {mm}["👤 {label}<br/>{score:.2f}"]')
        elif ntype == "fact":
            lines.append(f'    {mm}("📄 {label}<br/>{score:.2f}")')
        elif ntype == "chunk":
            lines.append(f'    {mm}[/"📦 {label}<br/>{score:.2f}"/]')
        elif ntype == "community":
            lines.append(f'    {mm}{{"🏘️ {label}<br/>{score:.2f}"}}')
        else:
            lines.append(f'    {mm}["{label}"]')
    for e in edges:
        lines.append(f'    {_mm_id(e["from"])} -->|{e["type"]}| {_mm_id(e["to"])}')
    return "\n".join(lines)
