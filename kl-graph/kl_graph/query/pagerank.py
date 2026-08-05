"""Facts-only entity PageRank: a query-side entity-importance prior.

Both the persistent server (``kl_server.py``) and the standalone engine
(``kl_graph/query/engine.py``) build this prior at startup and use it to weight
structural expansion (see the ``sim x pagerank`` ranking). Keeping the
implementation here avoids duplicating it across the two query paths.
"""

from __future__ import annotations

import logging
import sqlite3
import time

logger = logging.getLogger(__name__)


def compute_entity_pagerank(
    conn: sqlite3.Connection,
    damping: float = 0.85,
    max_iter: int = 100,
    tol: float = 1e-6,
) -> dict[str, float]:
    """Compute an entity-importance prior via weighted PageRank.

    The graph is a **facts-only projection**: each fact is treated as an
    (undirected) edge between the entities it links (its ABOUT-edge endpoints),
    weighted by the fact's LLM-generated ``confidence``. Parallel facts between
    the same entity pair accumulate their confidence, so a pair discussed in
    many/strong facts gets a heavier edge. ``SIMILAR_TO`` edges are deliberately
    NOT included.

    A fact that resolves to fewer than two known entities contributes no edge.

    Args:
        conn: Open SQLite connection.
        damping: PageRank damping factor (probability of following an edge).
        max_iter: Maximum power-iteration steps.
        tol: L1 convergence threshold.

    Returns:
        Mapping of ``entity_id`` -> PageRank score (scores sum to ~1 over all
        entities that participate in at least one fact edge).
    """
    logger.info("Computing facts-only entity PageRank...")
    t0 = time.time()

    # 1. Fact confidences (edge weights).
    fact_conf: dict[str, float] = {
        row[0]: (row[1] if row[1] is not None else 0.9)
        for row in conn.execute("SELECT id, confidence FROM facts")
    }

    # 2. Group ABOUT edges (fact -> entity) by fact to recover entity endpoints.
    fact_entities: dict[str, list[str]] = {}
    for fact_id, entity_id in conn.execute(
        """SELECT source_id, target_id FROM edges
           WHERE edge_type = 'ABOUT'
             AND source_type = 'fact' AND target_type = 'entity'"""
    ):
        fact_entities.setdefault(fact_id, []).append(entity_id)

    # 3. Project onto an undirected weighted entity graph.
    #    graph[a][b] = graph[b][a] = accumulated confidence over facts linking a,b
    graph: dict[str, dict[str, float]] = {}
    for fact_id, ents in fact_entities.items():
        uniq = list(dict.fromkeys(ents))  # dedup, preserve order
        if len(uniq) < 2:
            continue
        w = fact_conf.get(fact_id, 0.9)
        for i in range(len(uniq)):
            for j in range(i + 1, len(uniq)):
                a, b = uniq[i], uniq[j]
                graph.setdefault(a, {})[b] = graph.setdefault(a, {}).get(b, 0.0) + w
                graph.setdefault(b, {})[a] = graph.setdefault(b, {}).get(a, 0.0) + w

    n = len(graph)
    if n == 0:
        logger.warning("PageRank: no fact-projection edges found; scores empty.")
        return {}

    # 4. Weighted power iteration.
    #    PR[i] = (1-d)/N + d * sum_j( w[j][i] / outdeg[j] * PR[j] )
    nodes = list(graph.keys())
    outdeg = {node: sum(neigh.values()) for node, neigh in graph.items()}
    pr = {node: 1.0 / n for node in nodes}
    base = (1.0 - damping) / n

    iteration = 0
    for iteration in range(max_iter):
        new_pr = {node: base for node in nodes}
        for j in nodes:
            share = damping * pr[j] / outdeg[j]  # outdeg[j] > 0 by construction
            for i, w in graph[j].items():
                new_pr[i] += share * w
        delta = sum(abs(new_pr[node] - pr[node]) for node in nodes)
        pr = new_pr
        if delta < tol:
            break

    elapsed = time.time() - t0
    logger.info(
        f"PageRank: {n} entities over {sum(len(v) for v in graph.values()) // 2} "
        f"fact-projection edges, {iteration + 1} iters, {elapsed:.1f}s"
    )
    return pr
