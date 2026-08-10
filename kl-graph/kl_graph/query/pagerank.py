"""Facts-only entity PageRank: a query-side entity-importance prior.

Both the persistent server (``kl_server.py``) and the standalone engine
(``kl_graph/query/engine.py``) build this prior at startup and use it to weight
structural expansion (see the ``sim x pagerank`` ranking). Keeping the
implementation here avoids duplicating it across the two query paths.

Edge endpoints are read through the backend-agnostic
:meth:`~kl_graph.storage.base.KnowledgeStore.scan_edges_by_type` so the prior is
correct on every backend. On the LadybugDB backend the SQLite ``edges`` table is
empty (LadybugDB is the edge authority), so reading edges from a raw SQLite
connection would silently yield an empty prior.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kl_graph.storage.base import KnowledgeStore

logger = logging.getLogger(__name__)


def compute_entity_pagerank(
    store: KnowledgeStore,
    damping: float = 0.85,
    max_iter: int = 100,
    tol: float = 1e-6,
) -> dict[str, float]:
    """Compute an entity-importance prior via weighted PageRank.

    The graph is a **facts-only projection**: each fact is treated as an
    (undirected) edge between the entities it links (its ABOUT-edge endpoints),
    weighted by the fact's LLM-generated ``confidence``. Parallel facts between
    the same entity pair accumulate their confidence, so a pair discussed in
    many/strong facts gets a heavier edge. ``ENTITY_SIMILAR`` edges are deliberately
    NOT included.

    A fact that resolves to fewer than two known entities contributes no edge.

    Args:
        store: An open :class:`~kl_graph.storage.base.KnowledgeStore`. ABOUT edge
            endpoints are read via ``scan_edges_by_type`` (backend-agnostic);
            fact confidences are read from the shared ``facts`` table via
            ``store.sql_conn``.
        damping: PageRank damping factor (probability of following an edge).
        max_iter: Maximum power-iteration steps.
        tol: L1 convergence threshold.

    Returns:
        Mapping of ``entity_id`` -> PageRank score (scores sum to ~1 over all
        entities that participate in at least one fact edge).
    """
    logger.info("Computing facts-only entity PageRank...")
    t0 = time.time()

    # 1. Fact confidences (edge weights). The ``facts`` table lives in SQLite on
    #    every backend, so it is read from the store's shared connection.
    conn = store.sql_conn
    fact_conf: dict[str, float] = {
        row[0]: (row[1] if row[1] is not None else 0.9)
        for row in conn.execute("SELECT id, confidence FROM facts")
    }

    # 2. Group ABOUT edges (fact -> entity) by fact to recover entity endpoints.
    #    Read through the backend-agnostic store API (LadybugDB on ladybug, the
    #    SQLite ``edges`` table on sqlite) — NOT a raw SQL JOIN, which would be
    #    empty on ladybug.
    fact_entities: dict[str, list[str]] = {}
    for fact_id, entity_id, _props in store.scan_edges_by_type(
        ["ABOUT"], source_type="fact", target_type="entity"
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
        if not fact_conf:
            logger.info("PageRank: knowledge graph has no facts yet; scores empty.")
        else:
            logger.warning(
                "PageRank: facts exist but no fact-projection edges were found; "
                "scores empty."
            )
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
