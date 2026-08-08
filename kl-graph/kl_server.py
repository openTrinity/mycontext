#!/usr/bin/env python3
"""kl-server — Persistent retrieval server for the knowledge graph.

Keeps Qdrant stores and SQLite open in memory to eliminate cold-start overhead.
The kl CLI becomes a thin HTTP client calling this server.

Start: .venv/bin/python kl_server.py
Port: configured by server.port; override with --port
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import sys
import threading
import time
import uuid
from collections.abc import Iterable, Mapping
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from kl_graph.utils.litellm_config import litellm, provider_api_key, provider_model

# Ensure Unicode-safe stdout/stderr on all platforms.  On Windows the console
# defaults to GBK / cp1252, which crashes print()/logging on emoji or non-ASCII.
# reconfigure() is a no-op on systems already using UTF-8 (macOS, Linux).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# Project setup
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

# Parse --config/-c early (before kl_graph imports) so load_config() can
# override the default YAML before any module reads cfg at import time.
_cli_port: int | None = None
if __name__ == "__main__":
    import argparse as _ap

    _pre = _ap.ArgumentParser(add_help=False)
    _pre.add_argument("-c", "--config", metavar="PATH", default=None)
    _pre.add_argument("--port", type=int, default=None)
    _pre_args, _ = _pre.parse_known_args()
    _cli_port = _pre_args.port
    if _pre_args.config:
        # Minimal import — load_config only touches OmegaConf, no heavy deps
        from kl_graph.config import load_config

        load_config(_pre_args.config)

from kl_graph.config import DATA_DIR, GRAPH_DB_PATH, LADYBUG_OPTS, cfg

SQLITE_PATH = DATA_DIR / "knowledge.db"
QDRANT_PATH = str(DATA_DIR / "qdrant_data")
QUERY_MAX_CONCURRENCY = int(cfg.pipelines.query.max_concurrency)
CURRENT_USER = str(cfg.pipelines.query.global_search.current_user or "")

from kl_graph.query import graph_walk as gw
from kl_graph.query.adjacency import AdjacencyEntry, AdjacencyIndex
from kl_graph.query.global_search import NO_DATA_ANSWER, GlobalSearch
from kl_graph.query.pagerank import compute_entity_pagerank
from kl_graph.storage.base import KnowledgeStore, create_store

if TYPE_CHECKING:
    from kl_graph.ingest.runner import ServingIndexUpdate

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("kl-server")

# Community Qdrant is a separate lightweight store
COMMUNITY_QDRANT_PATH = str(Path(QDRANT_PATH).parent / "qdrant_communities")

PORT = _cli_port if _cli_port is not None else int(cfg.server.port)
if not 1 <= PORT <= 65535:
    raise ValueError(f"server port must be between 1 and 65535, got {PORT}")


# ── Global state (initialized in lifespan) ─────────────────────────────────


class ServerState:
    """Holds pre-warmed connections."""

    qdrant_main: object | None = None  # QdrantClient
    qdrant_communities: object | None = None  # QdrantClient
    adjacency: Mapping[str, tuple[AdjacencyEntry, ...]] | None = (
        None  # entity_id/fact_id -> list of (edge_type, neighbor_id, neighbor_type, dir)
    )
    pagerank: dict | None = (
        None  # entity_id -> importance score (facts-only projection)
    )
    engine: object | None = None  # QueryEngine (hybrid search + seed extraction)
    store: KnowledgeStore | None = (
        None  # unified KnowledgeStore (replaces sqlite + graph_db)
    )
    # Optimization 1: in-memory structural edge cache for O(K) improvement lookups
    structural_cache: object | None = None  # StructuralCache
    startup_time: float = 0
    ready: bool = False
    # Background ingestion job (Phase A + B). Only one runs at a time.
    ingest_task: object | None = None  # asyncio.Task
    ingest_progress: dict | None = None  # {state, phase, percent, detail, error}
    current_run_id: str | None = None
    # Request-admission gate for the retrieval endpoints. A single
    # asyncio.Semaphore(QUERY_MAX_CONCURRENCY) so at most that many queries run
    # concurrently; the rest queue-and-wait. Created lazily on the running loop
    # (an asyncio.Semaphore binds to the loop it is first used on, and the
    # TestClient spins a fresh loop per request), see ``_query_sema()``.
    query_sema: object | None = None  # asyncio.Semaphore

    def __init__(self) -> None:
        # Per-thread SQLite connections. A single sqlite3.Connection is not safe
        # to share across the asyncio.to_thread worker threads that serve the
        # retrieval endpoints, so for a file-backed DB each thread lazily opens
        # its own WAL-tuned handle to the same file. WAL allows many concurrent
        # readers. For an injected connection without a reproducible path
        # (e.g. tests passing an in-memory ``:memory:`` connection) we fall back
        # to sharing that single connection, since ``:memory:`` cannot be
        # reopened in another thread.
        self._sqlite_local = threading.local()
        self._sqlite_path: str | None = None
        self._sqlite_shared: sqlite3.Connection | None = None
        self._sqlite_conns: list[sqlite3.Connection] = []
        self.ingest_queue: list[tuple[str, IngestRequest]] = []

    def _open_sqlite(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._sqlite_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA cache_size=-64000")  # 64MB
        conn.execute("PRAGMA mmap_size=100000000")  # 100MB mmap
        return conn

    @property
    def sqlite_conn(self) -> sqlite3.Connection | None:
        """Return the SQLite connection for the calling thread.

        Resolution order:
        1. A connection already bound to this thread (injected or lazily opened).
        2. If a file path is known, open a fresh per-thread WAL connection.
        3. Fall back to a shared injected connection (no reproducible path,
           e.g. an in-memory test connection).
        """
        existing = getattr(self._sqlite_local, "conn", None)
        if existing is not None:
            return existing
        if self._sqlite_path is not None:
            conn = self._open_sqlite()
            self._sqlite_local.conn = conn
            self._sqlite_conns.append(conn)
            return conn
        return self._sqlite_shared

    @sqlite_conn.setter
    def sqlite_conn(self, conn: sqlite3.Connection | None) -> None:
        """Bind an externally-opened connection.

        Lifespan opens the warm startup connection this way (with a path also
        set, so worker threads open their own). Tests inject a connection with
        no path, which becomes the shared fallback for all threads.
        """
        if conn is None:
            self._sqlite_local.conn = None
            self._sqlite_shared = None
            return
        self._sqlite_local.conn = conn
        self._sqlite_shared = conn
        self._sqlite_conns.append(conn)

    def close_sqlite(self) -> None:
        for conn in self._sqlite_conns:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - best-effort cleanup
                pass
        self._sqlite_conns.clear()
        self._sqlite_local = threading.local()


state = ServerState()


def _query_sema() -> asyncio.Semaphore:
    """Return the shared request-admission semaphore, creating it on demand.

    Lazily constructed on the currently running loop so it binds correctly both
    under uvicorn (one long-lived loop) and under Starlette's TestClient (which
    may drive requests on a fresh loop). Cached on ``state`` after first use.
    """
    sema = state.query_sema
    if sema is None:
        sema = asyncio.Semaphore(QUERY_MAX_CONCURRENCY)
        state.query_sema = sema
    return sema


def _build_adjacency_buckets_full(store: KnowledgeStore) -> dict:
    """Build in-memory adjacency index from edges via KnowledgeStore.

    Key: entity_id, fact_id, chunk_id or community_id (namespacing is applied
    by the walk layer)
    Value: list of (edge_type, related_id, related_type, direction)

    Stores entity-keyed edges (for ego subgraph traversal and ENTITY_SIMILAR
    expansion) plus fact-keyed ABOUT edges so an interactive walk sitting *on a
    fact* can reach its entities, chunk-keyed edges from both ends (so a walk
    that lands on a chunk via ``STATES``/``MENTIONS`` can expand along
    ``TEMPORAL``/``REPLY_TO``/``MENTIONS`` instead of dead-ending), plus both
    ends of every COMM_MEMBER edge so node→community and community→members are
    traversable. ~125K edges -> ~10MB in memory.
    """
    logger.info("Building in-memory adjacency index...")
    t0 = time.time()
    adj: dict[str, list] = {}

    index_entries = 0
    fact_count = 0
    chunk_count = 0
    community_count = 0

    for (
        source_type,
        source_id,
        target_type,
        target_id,
        edge_type,
    ) in store.scan_entity_edges():
        # Entity as source (outgoing)
        if source_type == "entity":
            if source_id not in adj:
                adj[source_id] = []
            adj[source_id].append((edge_type, target_id, target_type, "out"))
            index_entries += 1

        # Entity as target (incoming) — for ABOUT edges (fact -> entity)
        if target_type == "entity":
            if target_id not in adj:
                adj[target_id] = []
            adj[target_id].append((edge_type, source_id, source_type, "in"))
            index_entries += 1

        # Fact-keyed walkable edges (fact -> entity via ABOUT)
        if source_type == "fact" and edge_type == "ABOUT":
            if source_id not in adj:
                adj[source_id] = []
            adj[source_id].append((edge_type, target_id, target_type, "out"))
            fact_count += 1

        # Chunk endpoints, both directions. A chunk is never an entity/fact key,
        # so without this a walk that lands on a chunk (via a fact's STATES edge
        # or an entity's MENTIONS edge) would dead-end instead of following
        # TEMPORAL/REPLY_TO to its neighbours. The fact-keyed branch above only
        # covers ABOUT, so the fact side of STATES is indexed here too. The
        # entity end is skipped when the entity branches already indexed it, so
        # no neighbour is listed twice.
        if source_type == "chunk":
            if source_id not in adj:
                adj[source_id] = []
            adj[source_id].append((edge_type, target_id, target_type, "out"))
            chunk_count += 1
        if target_type == "chunk":
            if target_id not in adj:
                adj[target_id] = []
            adj[target_id].append((edge_type, source_id, source_type, "in"))
            chunk_count += 1
            if source_type not in ("entity", "chunk"):
                if source_id not in adj:
                    adj[source_id] = []
                adj[source_id].append((edge_type, target_id, target_type, "out"))
                chunk_count += 1

        # Community endpoints, both directions: the fact-keyed branch above only
        # covers ABOUT, so a fact's COMM_MEMBER would otherwise be unreachable,
        # and the community itself is never an entity/fact key. Indexing both ends
        # is what makes node<->community walkable (fan-out is capped at walk time
        # by max_fanout). The node end is skipped when the entity branches above
        # already indexed it, so no neighbour is listed twice.
        if target_type == "community":
            if source_type != "entity":
                if source_id not in adj:
                    adj[source_id] = []
                adj[source_id].append((edge_type, target_id, target_type, "out"))
                community_count += 1
            if target_id not in adj:
                adj[target_id] = []
            adj[target_id].append((edge_type, source_id, source_type, "in"))
            community_count += 1
        elif source_type == "community":
            if source_id not in adj:
                adj[source_id] = []
            adj[source_id].append((edge_type, target_id, target_type, "out"))
            community_count += 1
            if target_type != "entity":
                if target_id not in adj:
                    adj[target_id] = []
                adj[target_id].append((edge_type, source_id, source_type, "in"))
                community_count += 1

    elapsed = time.time() - t0
    logger.info(
        f"Adjacency index: {len(adj)} keys, "
        f"{index_entries} entity index entries + {fact_count} fact-keyed entries "
        f"+ {chunk_count} chunk-keyed entries "
        f"+ {community_count} community-keyed entries, {elapsed:.1f}s"
    )
    return adj


EdgeRecord = tuple[str, str, str, str, str]
NodeRef = tuple[str, str]

# Endpoint schemas from graph-design.md. COMM_MEMBER accepts two source types,
# so it intentionally has two entries. This lets incremental refresh reuse the
# endpoint-indexed store primitive and reconstruct full edge records.
_EDGE_ENDPOINTS: tuple[tuple[str, str, str], ...] = (
    ("TEMPORAL", "chunk", "chunk"),
    ("REPLY_TO", "chunk", "chunk"),
    ("AUTHORED_BY", "chunk", "entity"),
    ("PART_OF", "chunk", "scope"),
    ("MENTIONS", "chunk", "entity"),
    ("STATES", "fact", "chunk"),
    ("ABOUT", "fact", "entity"),
    ("ENTITY_SIMILAR", "entity", "entity"),
    ("FACT_SIMILAR", "fact", "fact"),
    ("ENTAILS", "fact", "fact"),
    ("CONTRADICTS", "fact", "fact"),
    ("COMM_MEMBER", "entity", "community"),
    ("COMM_MEMBER", "fact", "community"),
)


def _append_adjacency_edge(
    adjacency: dict[str, list[AdjacencyEntry]],
    edge: EdgeRecord,
    *,
    only_ids: set[str] | None = None,
) -> None:
    """Project one stored edge into the server's existing adjacency shape."""

    source_type, source_id, target_type, target_id, edge_type = edge

    def append(node_id: str, entry: AdjacencyEntry) -> None:
        if only_ids is None or node_id in only_ids:
            adjacency.setdefault(node_id, []).append(entry)

    if source_type == "entity":
        append(source_id, (edge_type, target_id, target_type, "out"))
    if target_type == "entity":
        append(target_id, (edge_type, source_id, source_type, "in"))
    if source_type == "fact" and edge_type == "ABOUT":
        append(source_id, (edge_type, target_id, target_type, "out"))

    if source_type == "chunk":
        append(source_id, (edge_type, target_id, target_type, "out"))
    if target_type == "chunk":
        append(target_id, (edge_type, source_id, source_type, "in"))
        if source_type not in ("entity", "chunk"):
            append(source_id, (edge_type, target_id, target_type, "out"))

    if target_type == "community":
        if source_type != "entity":
            append(source_id, (edge_type, target_id, target_type, "out"))
        append(target_id, (edge_type, source_id, source_type, "in"))
    elif source_type == "community":
        append(source_id, (edge_type, target_id, target_type, "out"))
        if target_type != "entity":
            append(target_id, (edge_type, source_id, source_type, "in"))


def _adjacency_buckets(
    edges: Iterable[EdgeRecord], *, only_ids: set[str] | None = None
) -> dict[str, list[AdjacencyEntry]]:
    adjacency: dict[str, list[AdjacencyEntry]] = {}
    for edge in edges:
        _append_adjacency_edge(adjacency, edge, only_ids=only_ids)
    return adjacency


def _build_adjacency(store: KnowledgeStore) -> AdjacencyIndex:
    """Build the complete immutable adjacency serving index from storage."""

    return AdjacencyIndex.from_mapping(_build_adjacency_buckets_full(store))


def _scan_incident_edges(
    store: KnowledgeStore,
    nodes: set[NodeRef],
    *,
    edge_types: set[str] | None = None,
) -> list[EdgeRecord]:
    """Read typed edges touching ``nodes`` through indexed store APIs."""

    if not nodes:
        return []
    seen: set[EdgeRecord] = set()
    edges: list[EdgeRecord] = []
    for edge_type, source_type, target_type in _EDGE_ENDPOINTS:
        if edge_types is not None and edge_type not in edge_types:
            continue
        node_ids = {
            node_id
            for node_type, node_id in nodes
            if node_type == source_type or node_type == target_type
        }
        if not node_ids:
            continue
        for source_id, target_id, _properties in store.scan_edges_for_nodes(
            [edge_type],
            node_ids,
            source_type=source_type,
            target_type=target_type,
        ):
            edge = (source_type, source_id, target_type, target_id, edge_type)
            if (source_type, source_id) not in nodes and (
                target_type,
                target_id,
            ) not in nodes:
                # The store endpoint filter is untyped. Reject the extremely
                # unlikely case where two node types share the same bare ID.
                continue
            if edge not in seen:
                seen.add(edge)
                edges.append(edge)
    return edges


def _incremental_adjacency(
    store: KnowledgeStore,
    current: Mapping[str, tuple[AdjacencyEntry, ...]],
    update: ServingIndexUpdate,
) -> AdjacencyIndex:
    """Reconcile affected buckets from committed graph state."""

    base = (
        current
        if isinstance(current, AdjacencyIndex)
        else AdjacencyIndex.from_mapping(current)
    )
    structural_nodes = set(update.structural_nodes)
    similarity_nodes = set(update.similarity_nodes)
    community_nodes = {
        ("community", community_id) for community_id in update.community_ids
    }
    dirty_nodes = structural_nodes | similarity_nodes | community_nodes

    # Deleted memberships are absent from the new store view. The old snapshot
    # supplies their member endpoints so those buckets are cleared too.
    for _community_type, community_id in community_nodes:
        for edge_type, related_id, related_type, _direction in base.get(
            community_id, ()
        ):
            if edge_type == "COMM_MEMBER":
                dirty_nodes.add((related_type, related_id))

    discovery_edges: list[EdgeRecord] = []
    discovery_edges.extend(_scan_incident_edges(store, structural_nodes))
    discovery_edges.extend(
        _scan_incident_edges(
            store,
            similarity_nodes,
            edge_types={"ENTITY_SIMILAR", "FACT_SIMILAR"},
        )
    )
    discovery_edges.extend(
        _scan_incident_edges(store, community_nodes, edge_types={"COMM_MEMBER"})
    )
    for source_type, source_id, target_type, target_id, _edge_type in discovery_edges:
        dirty_nodes.add((source_type, source_id))
        dirty_nodes.add((target_type, target_id))

    dirty_ids = {node_id for _node_type, node_id in dirty_nodes}
    if len(base) >= 1_000 and len(dirty_ids) > len(base) // 4:
        logger.info(
            "Adjacency frontier is broad (%d/%d keys); using full rebuild",
            len(dirty_ids),
            len(base),
        )
        return _build_adjacency(store)

    current_edges = _scan_incident_edges(store, dirty_nodes)
    buckets = _adjacency_buckets(current_edges, only_ids=dirty_ids)
    replacements = {node_id: buckets.get(node_id, ()) for node_id in dirty_ids}
    refreshed = base.replace_buckets(replacements)
    logger.info(
        "Adjacency incremental refresh: %d dirty keys, %d incident edges, "
        "%d total keys",
        len(dirty_ids),
        len(current_edges),
        len(refreshed),
    )
    return refreshed


def _compute_pagerank(
    store: KnowledgeStore,
    damping: float = 0.85,
    max_iter: int = 100,
    tol: float = 1e-6,
) -> dict[str, float]:
    """Facts-only entity PageRank prior (see kl_graph.query.pagerank).

    Reads ABOUT edge endpoints through the configured store (backend-agnostic),
    so the prior is non-empty on the LadybugDB backend where the SQLite
    ``edges`` table is empty by design.
    """
    return compute_entity_pagerank(store, damping=damping, max_iter=max_iter, tol=tol)


def _shared_stores():
    """Return a (store, qdrant) pair for background ingest/improve jobs.

    Reuses state.store so the configured backend's routing is preserved during
    ingest. A missing store is a startup failure: silently falling back to
    SQLite would split graph writes across two edge authorities.
    Always reuses the single open Qdrant client (single-writer lock).
    """
    from kl_graph.storage.qdrant_store import QdrantStore

    if state.store is None:
        raise RuntimeError("KnowledgeStore is not initialized")
    shared_store = state.store

    shared_qdrant = QdrantStore.__new__(QdrantStore)
    shared_qdrant.path = QDRANT_PATH
    shared_qdrant.client = state.qdrant_main
    return shared_store, shared_qdrant


def _hot_swap_graph(update: ServingIndexUpdate | None = None):
    """Refresh only dirty serving indexes, retaining a full recovery path.

    A missing update keeps the historical/manual behavior: full adjacency and
    PageRank rebuild. Normal server ingestion passes ``ServingIndexUpdate`` so
    adjacency buckets are reconciled from committed store state and PageRank is
    recomputed only when facts/ABOUT inputs may have changed.
    """

    if update is None:
        from kl_graph.ingest.runner import ServingIndexUpdate

        update = ServingIndexUpdate(full_adjacency=True, pagerank_dirty=True)

    logger.info("Refreshing graph serving indexes after ingest...")
    if update.adjacency_dirty:
        try:
            if update.full_adjacency or state.adjacency is None:
                new_adjacency = _build_adjacency(state.store)
            else:
                new_adjacency = _incremental_adjacency(
                    state.store, state.adjacency, update
                )
        except Exception:  # noqa: BLE001 - recovery must prefer correctness
            logger.exception("Incremental adjacency refresh failed; rebuilding fully")
            new_adjacency = _build_adjacency(state.store)
        state.adjacency = new_adjacency

    pagerank_refreshed = update.pagerank_dirty or state.pagerank is None
    if pagerank_refreshed:
        new_pagerank = _compute_pagerank(state.store)
        state.pagerank = new_pagerank
        # The query engine reads pagerank by reference; refresh its handle too.
        if state.engine is not None and hasattr(state.engine, "pagerank"):
            state.engine.pagerank = new_pagerank
    # Re-open the community store if this ingest created it.
    if state.qdrant_communities is None and Path(COMMUNITY_QDRANT_PATH).exists():
        try:
            from qdrant_client import QdrantClient

            state.qdrant_communities = QdrantClient(path=COMMUNITY_QDRANT_PATH)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Could not open community store after ingest: {e}")
    logger.info(
        "Serving-index refresh done: %d adjacency keys%s",
        len(state.adjacency or ()),
        ", PageRank refreshed" if pagerank_refreshed else "",
    )


def _set_progress(
    state_str: str, phase: str, percent: float, detail: str = "", error: str = ""
):
    """Update the background-ingest progress record read by /status."""
    previous = state.ingest_progress or {}
    state.ingest_progress = {
        "run_id": state.current_run_id,
        "source_id": previous.get("source_id"),
        "improve_mode": previous.get("improve_mode"),
        "state": state_str,  # idle | running | done | error
        "phase": phase,  # phase_a | phase_b | improve | finalize | ""
        "percent": round(percent, 3),
        "detail": detail,
        "error": error,
        "updated_at": time.time(),
        "units_discovered": previous.get("units_discovered", 0),
        "units_skipped": previous.get("units_skipped", 0),
        "units_processed": previous.get("units_processed", 0),
        "chunks_created": previous.get("chunks_created", 0),
    }
    if state.current_run_id and state.sqlite_conn is not None:
        completed_at = int(time.time()) if state_str in {"done", "error"} else None
        state.sqlite_conn.execute(
            """UPDATE ingest_runs
               SET state=?, phase=?, percent=?, detail=?, error=?,
                   updated_at=?, completed_at=?,
                   units_discovered=?, units_skipped=?, units_processed=?,
                   chunks_created=? WHERE run_id=?""",
            (
                state_str,
                phase,
                round(percent, 3),
                detail,
                error or None,
                int(time.time()),
                completed_at,
                state.ingest_progress["units_discovered"],
                state.ingest_progress["units_skipped"],
                state.ingest_progress["units_processed"],
                state.ingest_progress["chunks_created"],
                state.current_run_id,
            ),
        )
        state.sqlite_conn.commit()


def _set_ingest_counts(result) -> None:
    if state.ingest_progress is None:
        return
    state.ingest_progress.update(
        units_discovered=result.units_discovered,
        units_skipped=result.units_skipped,
        units_processed=result.units_processed,
        chunks_created=result.chunks_created,
    )


async def _run_single_ingest_job(req: IngestRequest):
    """Background ingest: Phase A (chunk+embed) then Phase B (extract+graph).

    Runs inside the server process so it reuses the single Qdrant writer. The
    server keeps serving throughout; on completion the graph indexes are
    hot-swapped in. Overall progress is surfaced via /status.
    """
    try:
        from kl_graph.ingest.runner import IngestOptions, run_ingestion

        shared_store, qdrant = _shared_stores()
        await run_ingestion(
            IngestOptions(
                input_dir=Path(req.input_dir),
                source_id=req.source_id,
                concurrency=req.concurrency,
                improve_mode=req.improve_mode,
            ),
            store=shared_store,
            qdrant=qdrant,
            progress_callback=lambda phase, percent, detail: _set_progress(
                "running", phase, percent, detail
            ),
            counts_callback=_set_ingest_counts,
            finalize_callback=_hot_swap_graph,
            structural_cache=state.structural_cache,
        )
        _set_progress("done", "", 1.0, "ingest complete")
        logger.info("Background ingest complete.")
    except Exception as e:
        logger.exception("Background ingest failed")
        _set_progress("error", "", 0.0, "", str(e))


async def _run_ingest_queue(first: tuple[str, IngestRequest]) -> None:
    """Serially drain locally referenced ingest requests."""
    pending: tuple[str, IngestRequest] | None = first
    try:
        while pending is not None:
            run_id, req = pending
            state.current_run_id = run_id
            state.ingest_progress = {
                "source_id": req.source_id,
                "improve_mode": req.improve_mode,
            }
            _set_progress("running", "phase_a", 0.0, "queued")
            await _run_single_ingest_job(req)
            pending = state.ingest_queue.pop(0) if state.ingest_queue else None
    finally:
        state.ingest_task = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Pre-warm all stores on startup."""
    t_start = time.time()
    logger.info("=== kl-server starting ===")

    # 1. SQLite (fast)
    logger.info(f"Opening SQLite: {SQLITE_PATH}")
    Path(SQLITE_PATH).parent.mkdir(parents=True, exist_ok=True)
    # Register the path so worker threads can open their own connections lazily,
    # then bind the warm startup connection to this thread.
    state._sqlite_path = str(SQLITE_PATH)
    _startup_conn = sqlite3.connect(str(SQLITE_PATH), check_same_thread=False)
    _startup_conn.execute("PRAGMA journal_mode=WAL")
    _startup_conn.execute("PRAGMA synchronous=NORMAL")
    _startup_conn.execute("PRAGMA cache_size=-64000")  # 64MB
    _startup_conn.execute("PRAGMA mmap_size=100000000")  # 100MB mmap
    state.sqlite_conn = _startup_conn
    # Ensure the schema exists so the server can start against a brand-new DB
    # (before any ingest). SQLiteStore(conn=...) runs idempotent CREATE IF NOT
    # EXISTS on our warm connection; it does not open a second handle.
    from kl_graph.storage.sqlite_store import SQLiteStore

    SQLiteStore(Path(SQLITE_PATH), conn=state.sqlite_conn)
    state.sqlite_conn.execute(
        """UPDATE ingest_runs
           SET state='error', error='server restarted before completion',
               completed_at=strftime('%s', 'now'), updated_at=strftime('%s', 'now')
           WHERE state IN ('queued', 'running')"""
    )
    state.sqlite_conn.commit()
    # Warm the cache
    state.sqlite_conn.execute("SELECT COUNT(*) FROM edges").fetchone()
    state.sqlite_conn.execute("SELECT COUNT(*) FROM facts").fetchone()
    logger.info("SQLite: ready")

    # 1b. KnowledgeStore — unified store wrapping the warm SQLite conn.
    # For sqlite backend this is a SQLiteStore; ladybug uses LadybugStore.
    logger.info(f"Initializing KnowledgeStore (backend={cfg.storage.graph.backend})...")
    try:
        if cfg.storage.graph.backend == "ladybug":
            state.store = create_store(
                backend=cfg.storage.graph.backend,
                db_path=Path(SQLITE_PATH),
                ladybug_path=GRAPH_DB_PATH,
                conn=state.sqlite_conn,
                **LADYBUG_OPTS,
            )
        else:
            state.store = create_store(
                backend=cfg.storage.graph.backend,
                db_path=Path(SQLITE_PATH),
                conn=state.sqlite_conn,
            )
        logger.info(f"KnowledgeStore: ready ({cfg.storage.graph.backend})")
    except Exception as e:
        logger.exception("KnowledgeStore initialization failed")
        raise RuntimeError(
            f"Cannot start with graph backend {cfg.storage.graph.backend!r}: {e}"
        ) from e

    # 1c. StructuralCache — O(E) one-time load of MENTIONS/AUTHORED_BY/ABOUT
    # edges into memory, so incremental improvement uses O(K) lookups instead
    # of repeated O(E) store scans.
    from kl_graph.ingest.structural_cache import StructuralCache

    state.structural_cache = StructuralCache.from_store(state.store)

    # 2. Build adjacency index
    state.adjacency = _build_adjacency(state.store)

    # 2b. Facts-only entity PageRank prior (ENTITY_SIMILAR excluded). Reads edge
    #     endpoints through the configured store (LadybugDB on ladybug).
    state.pagerank = _compute_pagerank(state.store)

    # 3. Qdrant main store (slow — mmaps 300MB)
    logger.info(f"Opening Qdrant main: {QDRANT_PATH}")
    from qdrant_client import QdrantClient

    state.qdrant_main = QdrantClient(path=QDRANT_PATH)
    # Ensure the main collections exist so the server can start against a
    # brand-new store and a first ingest can upsert. Reuses QdrantStore's
    # idempotent _ensure_collections on our already-open client (no 2nd handle).
    from kl_graph.storage.qdrant_store import QdrantStore

    _main_store = QdrantStore.__new__(QdrantStore)
    _main_store.path = QDRANT_PATH
    _main_store.client = state.qdrant_main
    try:
        _main_store._ensure_collections()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Could not ensure Qdrant collections: {e}")
    # Warm by doing a dummy operation
    try:
        state.qdrant_main.get_collection("facts")
    except Exception:  # noqa: BLE001, S110
        pass
    logger.info("Qdrant main: ready")

    # 4. Qdrant communities (fast — separate small store)
    if Path(COMMUNITY_QDRANT_PATH).exists():
        logger.info(f"Opening Qdrant communities: {COMMUNITY_QDRANT_PATH}")
        state.qdrant_communities = QdrantClient(path=COMMUNITY_QDRANT_PATH)
        logger.info("Qdrant communities: ready")
    else:
        logger.warning(f"Community store not found: {COMMUNITY_QDRANT_PATH}")

    # 5. Hybrid query engine — shares the warm store (configured backend) +
    # Qdrant client + pagerank so /search delegates to the full engine
    # (dense+sparse+RRF+rerank +optional Phase-2) and the graph endpoints reuse
    # it for seed extraction. Injecting ``store=state.store`` (NOT a fresh
    # SQLiteStore) is what makes the engine's structural expansion + PageRank
    # read edges from the configured backend: on ladybug the SQLite ``edges``
    # table is empty, so a SQLite-only engine would silently lose those channels.
    logger.info("Initializing query engine (shared stores)...")
    try:
        from kl_graph.query.engine import QueryEngine

        state.engine = QueryEngine(
            store=state.store,
            qdrant=_main_store,
            pagerank=state.pagerank,
        )
        logger.info("Query engine: ready")
    except Exception as e:  # noqa: BLE001
        logger.error(f"Query engine init failed (search will be degraded): {e}")
        state.engine = None

    state.startup_time = time.time() - t_start
    state.ready = True
    logger.info(f"=== kl-server ready in {state.startup_time:.1f}s (port {PORT}) ===")

    yield

    # Shutdown
    logger.info("Shutting down...")
    if state.qdrant_main:
        state.qdrant_main.close()
    if state.qdrant_communities:
        state.qdrant_communities.close()
    if state.store:
        state.store.close()
    # Close every per-thread SQLite connection opened via state.sqlite_conn
    # (independent of the store's own per-thread handles).
    state.close_sqlite()


app = FastAPI(title="kl-server", lifespan=lifespan)


# ── Request/Response models ─────────────────────────────────────────────────


class EmbedSearchRequest(BaseModel):
    query: str
    collection: str = (
        "facts"  # facts | chunks (alias: messages) | entities | communities
    )
    top_k: int = 10
    min_timestamp: int | None = None
    max_timestamp: int | None = None


class IngestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_dir: str
    source_id: str = Field(min_length=1)
    concurrency: int = Field(default=50, ge=1)  # concurrent extraction LLM calls
    improve_mode: Literal["off", "auto", "incremental", "full"] = "auto"


class AskRequest(BaseModel):
    query: str
    top_k: int = 10
    force_phase2: bool = False
    # Graph-walk params (Phase 2 = the depth-1 walk over the entities/facts the
    # query function extracted). The walk always runs when the graph is built.
    radius: int = 1
    max_fanout: int = 10
    max_nodes: int = 50
    lambda_: float = 0.6  # alias "lambda" in JSON
    seed_k: int = 6

    class Config:
        fields = {"lambda_": "lambda"}  # noqa: RUF012


class GlobalSearchRequest(BaseModel):
    """Conceptual-question query for /global_search (GraphRAG-style)."""

    query: str
    user: str | None = None


class EntityRequest(BaseModel):
    name: str
    limit: int = 20


class ExpandRequest(BaseModel):
    entity_id: str


class FactsRequest(BaseModel):
    entity_id: str
    limit: int = 20


class CommunityRequest(BaseModel):
    level: str = "L1"
    node_type: str = "entity"
    community_id: int | None = None
    top_k: int = 20


class MembersRequest(BaseModel):
    community_id: int
    level: str = "L1"
    node_type: str = "entity"
    limit: int = 30


class ContextRequest(BaseModel):
    fact_id: str


class ChunkRequest(BaseModel):
    chunk_ids: list[str]


class TimelineRequest(BaseModel):
    entity_name: str
    from_date: str | None = None  # YYYY-MM-DD
    to_date: str | None = None
    limit: int = 30


class GraphHopRequest(BaseModel):
    node_id: str  # "ent:.." | "fact:.."
    cursor: dict  # echoed from the previous response
    max_fanout: int = 10


class PathRequest(BaseModel):
    source: str  # entity name or ID
    target: str  # entity name or ID
    max_hops: int = Field(default=4, ge=1, le=8)  # max path length (capped at 8)
    all_paths: bool = False  # all shortest vs first shortest
    edge_types: list[str] | None = (
        None  # filter (None = ABOUT+ENTITY_SIMILAR+FACT_SIMILAR)
    )


# ── Embedding helper ─────────────────────────────────────────────────────────

# ── Endpoints ────────────────────────────────────────────────────────────────


@app.get("/status")
async def get_status():
    """Server health + DB stats."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    stats = {}
    # SQLite counts
    stats["messages"] = state.sqlite_conn.execute(
        "SELECT COUNT(*) FROM chunks WHERE source_type = 'message'"
    ).fetchone()[0]
    stats["entities"] = state.sqlite_conn.execute(
        "SELECT COUNT(*) FROM entities"
    ).fetchone()[0]
    stats["facts"] = state.sqlite_conn.execute("SELECT COUNT(*) FROM facts").fetchone()[
        0
    ]
    stats["edges"] = state.store.count_edges() if state.store else 0

    # Qdrant counts
    qdrant_stats = {}
    for coll in ["chunks", "entities", "facts"]:
        try:
            info = state.qdrant_main.get_collection(coll)
            qdrant_stats[coll] = info.points_count
        except Exception:  # noqa: BLE001
            qdrant_stats[coll] = 0

    if state.qdrant_communities:
        try:
            info = state.qdrant_communities.get_collection("communities")
            qdrant_stats["communities"] = info.points_count
        except Exception:  # noqa: BLE001
            qdrant_stats["communities"] = 0

    ingest_status = state.ingest_progress
    if ingest_status is None:
        row = state.sqlite_conn.execute(
            """SELECT run_id, source_id, state, phase, percent, detail,
                      units_discovered,
                      units_skipped, units_processed, chunks_created, error,
                      updated_at
               FROM ingest_runs ORDER BY updated_at DESC LIMIT 1"""
        ).fetchone()
        if row:
            ingest_status = dict(row)

    return {
        "status": "ready",
        "startup_time_s": round(state.startup_time, 1),
        "graph_backend": cfg.storage.graph.backend,
        "adjacency_entities": len(state.adjacency) if state.adjacency else 0,
        "sqlite": stats,
        "qdrant": qdrant_stats,
        "ingest": ingest_status or {"state": "idle", "percent": 0.0},
    }


@app.post("/ingest")
async def ingest(req: IngestRequest):
    """Scan a server-local directory and incrementally ingest unseen units."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")
    input_dir = Path(req.input_dir).expanduser().resolve()
    if not input_dir.is_dir():
        raise HTTPException(400, f"input_dir is not a directory: {input_dir}")
    req.input_dir = str(input_dir)
    run_id = str(uuid.uuid4())
    now = int(time.time())
    state.sqlite_conn.execute(
        """INSERT INTO ingest_runs
           (run_id, source_id, input_dir, state, phase, started_at, updated_at)
           VALUES (?, ?, ?, 'queued', '', ?, ?)""",
        (run_id, req.source_id, req.input_dir, now, now),
    )
    state.sqlite_conn.commit()

    item = (run_id, req)
    if state.ingest_task is not None and not state.ingest_task.done():
        state.ingest_queue.append(item)
        return {
            "status": "continued",
            "run_id": state.current_run_id,
            "queued_run_id": run_id,
            "queued_source": req.source_id,
        }

    state.current_run_id = run_id
    state.ingest_progress = {
        "source_id": req.source_id,
        "improve_mode": req.improve_mode,
    }
    _set_progress("running", "phase_a", 0.0, "queued")
    state.ingest_task = asyncio.create_task(_run_ingest_queue(item))
    return {"status": "started", "run_id": run_id, "ingest": state.ingest_progress}


@app.post("/search")
async def search(req: EmbedSearchRequest):
    """Vector similarity search over a single collection.

    Embeds the query once (via the shared engine's embedder) and runs a pure
    cosine ANN against one Qdrant collection: ``facts`` (default), ``chunks``
    (alias ``messages``),
    ``entities``, or ``communities``. Returns raw hits ``{results:[{id, score,
    payload}], ...}``. For a synthesized answer over all collections use /ask.
    """
    if not state.ready:
        raise HTTPException(503, "Server not ready")
    if state.engine is None:
        raise HTTPException(503, "Query engine not available")

    t0 = time.time()
    async with _query_sema():
        # Embed on the network path (awaited); run the local Qdrant ANN on a
        # worker thread so the loop stays free for other requests.
        try:
            vec = await state.engine.embedder.aembed_one(req.query)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"Embedding error: {e}")
        t_embed = time.time() - t0

        response = await asyncio.to_thread(_search_qdrant, req, vec)

        # Surface the domain id (fact_id / entity_id / chunk_id) as ``id`` so
        # callers can chain search → context/expand/timeline directly. The raw
        # Qdrant point id is kept as ``point_id`` for debugging; the full payload
        # (which also carries the domain id) is returned unchanged.
        _id_key = {
            "facts": "fact_id",
            "entities": "entity_id",
            "chunks": "chunk_id",
            "messages": "chunk_id",
        }.get(req.collection)
        results = []
        for r in response.points:
            payload = r.payload or {}
            domain_id = payload.get(_id_key) if _id_key else None
            results.append(
                {
                    "id": str(domain_id) if domain_id is not None else str(r.id),
                    "point_id": str(r.id),
                    "score": r.score,
                    "payload": payload,
                }
            )
        t_total = time.time() - t0
        return {
            "collection": req.collection,
            "results": results,
            "latency_ms": round(t_total * 1000),
            "embed_ms": round(t_embed * 1000),
            "search_ms": round((t_total - t_embed) * 1000),
        }


def _search_qdrant(req: EmbedSearchRequest, vec: list[float]):
    """Run /search's Qdrant ANN (local, blocking; offload target)."""
    from qdrant_client.models import (
        FieldCondition,
        Filter,
        Range,
        SearchParams,
    )

    if req.collection == "communities":
        if not state.qdrant_communities:
            raise HTTPException(404, "Community store not available")
        return state.qdrant_communities.query_points(
            collection_name="communities",
            query=vec,
            limit=req.top_k,
            search_params=SearchParams(
                exact=bool(cfg.storage.vector.qdrant.exact_search), hnsw_ef=128
            ),
        )
    # `messages` is a backward-compat alias for the unified `chunks` store.
    collection = "chunks" if req.collection == "messages" else req.collection
    conditions = []
    if req.min_timestamp is not None:
        conditions.append(
            FieldCondition(key="timestamp", range=Range(gte=req.min_timestamp))
        )
    if req.max_timestamp is not None:
        conditions.append(
            FieldCondition(key="timestamp", range=Range(lte=req.max_timestamp))
        )
    filter_obj = Filter(must=conditions) if conditions else None

    return state.qdrant_main.query_points(
        collection_name=collection,
        query=vec,
        limit=req.top_k,
        query_filter=filter_obj,
        search_params=SearchParams(
            exact=bool(cfg.storage.vector.qdrant.exact_search), hnsw_ef=128
        ),
    )


@app.post("/ask")
async def ask(req: AskRequest):
    """Hybrid question-answering + interactive graph walk in one call.

    Two phases sharing a single query embedding + entity match (one LLM call):

    1. **Query** — ``engine.aquery()``: dense + sparse + RRF (+ optional rerank)
       over chunks and facts, optionally escalating to Phase-2 LLM synthesis
       (``force_phase2``, off by default). Produces ``items`` + ``answer``.
    2. **Graph walk** — ``gw.graph_walk()`` seeded from the entities/facts the
       query already extracted (reuses ``q_vec`` + ``matched_entities``, so no
       second LLM/embed call). Produces the depth-1 hoppable frontier
       (``seeds``/``nodes``/``edges``/``expandable``) + a ``cursor`` for
       ``/graph_hop``.

    When the graph is not built the walk fields come back empty
    (``mode="chunks_only"``) and only the flat ``items`` are returned.

    Concurrency: admitted through the shared ``_query_sema()`` (queue-and-wait
    past the limit). Phase 1/2 run on the async engine (network calls awaited);
    the CPU-bound graph walk is offloaded with ``asyncio.to_thread`` so the
    event loop stays free for other requests.
    """
    if not state.ready:
        raise HTTPException(503, "Server not ready")
    if state.engine is None:
        raise HTTPException(503, "Query engine not available")

    t0 = time.time()
    async with _query_sema():
        try:
            result = await state.engine.aquery(req.query, force_phase2=req.force_phase2)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"Query failed: {e}")

        base = {
            "answer": result.answer,
            "items": result.items[: req.top_k],
            "phase": result.phase,
            "entities_found": result.entities_found,
        }

        # Graph not built: flat vector-RAG only, graph fields empty.
        if not _graph_built():
            base.update(
                mode="chunks_only",
                graph={"components": [], "seeds": [], "expandable": []},
                recalled_chunks=[],
                graph_mermaids=[],
                cursor={"visited": {}, "lambda": req.lambda_},
                latency_ms=round((time.time() - t0) * 1000),
            )
            return base

        # Phase 2: walk the graph from the query's entities/facts. Reuse
        # Phase-1's embedding + entity match so the walk adds no second
        # LLM/embed call. The walk + node resolution is pure CPU + local-store
        # reads, so offload it to keep the loop free.
        walk = await asyncio.to_thread(_ask_graph_walk, req, result)
        base.update(walk)
        base["latency_ms"] = round((time.time() - t0) * 1000)
        return base


@app.post("/global_search")
async def global_search(req: GlobalSearchRequest):
    """GraphRAG-style global search over the current user's community summaries.

    Answers conceptual questions (e.g. ``我最近的任务是什么``) by map-reducing
    the LLM summaries of the resolved user's communities (GraphRAG global
    search shape: strict-JSON map points scored 0–100 → score-filter →
    importance-sorted, budget-capped reduce → grounded markdown with
    ``[Data: Communities (...)]`` citations).

    Identity precedence: request ``user`` → ``KL_CURRENT_USER`` env default,
    resolved via ``_resolve_entity_id``. Every miss — blank queries, unknown
    identities, missing community data, or unexpected SQLite/LLM failures —
    is grounded: HTTP 200 with a canned no-data answer and ZERO LLM calls —
    never 404/500, never a corpus-wide fallback ([!RED] answering "我的任务"
    for the wrong person is worse than no answer).

    Concurrency: admitted through the shared ``_query_sema()`` like /ask.
    """
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    t0 = time.time()

    def _no_data(reason: str, extra: dict | None = None) -> dict:
        """Grounded 200 no-data shape (zero LLM calls, never 404/fallback)."""
        body = {
            "answer": NO_DATA_ANSWER,
            "user": req.user,
            "entity_id": None,
            "reason": reason,
            "communities": [],
            "citations": [],
            "diagnostics": {},
            "latency_ms": round((time.time() - t0) * 1000),
        }
        if extra:
            body.update(extra)
        return body

    async with _query_sema():
        # One grounded-error boundary for the whole post-admission flow: any
        # validation/identity/prerequisite/search failure degrades to a
        # grounded 200 instead of escaping as 500.
        name: str | None = None
        entity_id: str | None = None
        try:
            # Validation first: a blank query can never be grounded — reject
            # with zero LLM calls before any identity/summary work.
            query = req.query.strip()
            if not query:
                return _no_data("empty_query")

            # Identity: request field first, then the KL_CURRENT_USER default.
            name = (req.user or "").strip() or CURRENT_USER.strip()
            if not name:
                return _no_data("no_identity")
            entity_id = _resolve_entity_id(name)
            if entity_id is None:
                return _no_data("identity_unresolved", {"user": name})

            # Community prerequisites are created by the improve pipeline, not
            # the base schema — degrade gracefully (like /community).
            entity_cols = {
                c[1]
                for c in state.sqlite_conn.execute(
                    "PRAGMA table_info(entities)"
                ).fetchall()
            }
            if "community_L0" not in entity_cols:
                return _no_data(
                    "no_communities",
                    {
                        "user": name,
                        "entity_id": entity_id,
                        "hint": (
                            "No community memberships yet — run `python -m "
                            "scripts.improve` (community detection + summaries)."
                        ),
                    },
                )
            has_summaries = state.sqlite_conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name='community_summaries'"
            ).fetchone()
            if not has_summaries:
                return _no_data(
                    "no_communities",
                    {
                        "user": name,
                        "entity_id": entity_id,
                        "hint": (
                            "No community summaries yet — run `python -m "
                            "scripts.improve` and optionally `python "
                            "scripts/embed_communities.py`."
                        ),
                    },
                )

            async def _acomplete(system_prompt: str, user_prompt: str) -> str:
                """litellm Anthropic-mode wrapper mirroring engine._aphase2."""
                resp = await litellm.acompletion(
                    model=provider_model(
                        cfg.services.llm_flash.provider,
                        cfg.services.llm_flash.model,
                    ),
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    api_base=cfg.services.llm_flash.base_url or "",
                    api_key=provider_api_key(cfg.services.llm_flash.provider),
                    max_tokens=max(
                        int(cfg.pipelines.query.global_search.map_max_tokens),
                        int(cfg.pipelines.query.global_search.reduce_max_tokens),
                    ),
                    temperature=0.3,
                    timeout=float(cfg.services.llm_flash.timeout),
                )
                return resp.choices[0].message.content

            # Cheap per-request construction; reuses the warm server connection
            # ([REMARK]: no second pool). SQLite summaries are authoritative —
            # qdrant_communities is not required here.
            search = GlobalSearch(conn=state.sqlite_conn, acomplete=_acomplete)
            result = await search.search(query, entity_id)
        except Exception as e:  # noqa: BLE001 - any failure → grounded 200
            extra: dict = {"diagnostics": {"error": str(e)}}
            if name:
                extra["user"] = name
            if entity_id:
                extra["entity_id"] = entity_id
            return _no_data("error", extra)

        # Diagnostics carry U1's own search latency next to the endpoint-wide
        # total ``latency_ms`` below (design snippet 5).
        diagnostics = {
            **result.diagnostics,
            "search_latency_ms": round(result.latency_ms),
        }
        response = {
            "answer": result.answer,
            "user": name,
            "entity_id": entity_id,
            "reason": result.reason,
            "communities": result.communities,
            "citations": result.citations,
            "diagnostics": diagnostics,
            "latency_ms": round((time.time() - t0) * 1000),
        }
        if result.reason == "no_communities":
            # Coverage gap ([A human] policy (a)): the entity resolved but
            # carries no memberships — same grounded no-data shape plus a
            # remediation hint; no 1-hop fallback.
            response["hint"] = (
                "No community memberships for this entity — run `python -m "
                "scripts.improve` (community detection + summaries)."
            )
        return response


def _connected_components(nodes: list[dict], edges: list[dict]) -> list[dict]:
    """Group resolved nodes + labeled edges into connected components.

    Uses union-find over the UNDIRECTED edge view: every node id is a vertex,
    each edge unions its from/to. Returns a list of components, each with its
    own nodes (resolved dicts) and edges (labeled dicts whose both endpoints
    are in that component). A node with no edges is its own single-node
    component with edges=[].

    Components are ordered by the best node score within each (strongest first).
    Within a component, preserve the incoming node order.
    """
    if not nodes:
        return []

    # Union-Find
    parent: dict[str, str] = {n["id"]: n["id"] for n in nodes}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]  # path compression
            x = parent[x]
        return x

    def union(x: str, y: str):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    # Union edges
    for e in edges:
        if e["from"] in parent and e["to"] in parent:
            union(e["from"], e["to"])

    # Group nodes by component root
    from collections import defaultdict

    comp_nodes: dict[str, list[dict]] = defaultdict(list)
    for n in nodes:
        comp_nodes[find(n["id"])].append(n)

    # Group edges by component (both endpoints must be in same component)
    comp_edges: dict[str, list[dict]] = defaultdict(list)
    for e in edges:
        if e["from"] in parent and e["to"] in parent:
            root = find(e["from"])
            comp_edges[root].append(e)

    # Build components, ordered by best node score (descending)
    components = []
    for root, c_nodes in comp_nodes.items():
        best_score = max(n["score"] for n in c_nodes)
        components.append(
            {
                "nodes": c_nodes,
                "edges": comp_edges.get(root, []),
                "_best_score": best_score,
            }
        )

    components.sort(key=lambda c: c["_best_score"], reverse=True)

    # Remove internal _best_score key
    for c in components:
        del c["_best_score"]

    return components


def _ask_graph_walk(req: AskRequest, result) -> dict:
    """Build /ask's depth-1 graph-walk view (CPU + local store; offload target).

    Reuses Phase-1's ``matched_entities`` / ``q_vec`` / ANN hits (no second
    LLM/embed call) to seed a depth-1 walk, then resolves + labels the frontier,
    groups into connected components, and builds per-component mermaid diagrams.
    Returns the graph fields to merge into the /ask response (``latency_ms`` is
    stamped by the caller so it covers the whole request).
    """
    ef_seeds, chunk_seeds = _seeds_for_query(
        req.query,
        req.seed_k,
        matched=result.matched_entities,
        q_vec=result.q_vec,
        fact_hits=result.fact_hits,
        chunk_hits=result.chunk_hits,
    )

    # Combine all seeds into a single graph_walk call (graph_walk dedups)
    all_seeds = ef_seeds + chunk_seeds
    nodes, edges, visited = gw.graph_walk(
        state.adjacency,
        all_seeds,
        radius=req.radius,
        max_fanout=req.max_fanout,
        max_nodes=req.max_nodes,
        lambda_=req.lambda_,
        importance_fn=_importance,
    )

    # Resolve nodes, label edges, compute expandable
    resolved = _resolve_nodes(nodes)
    labels = _label_map(resolved)
    labeled_edges = _labeled_edges(edges, labels)
    expandable = _labeled_ids(_expandable(nodes), labels)

    # Group into connected components
    components = _connected_components(resolved, labeled_edges)

    # Build per-component mermaid diagrams
    graph_mermaids = [
        gw.to_mermaid(comp["nodes"], comp["edges"]) for comp in components
    ]

    # Build recalled_chunks: top-level list from chunk_hits (the recalled/depth-1 chunks)
    recalled_chunks = []
    for hit in result.chunk_hits[: req.seed_k]:
        payload = hit.get("payload", {})
        chunk_id = payload.get("chunk_id")
        if not chunk_id:
            continue

        chunk_nid = gw.namespaced(chunk_id, "chunk")

        # Pull source_type/timestamp from payload if present, else look up
        source_type = payload.get("source_type")
        timestamp = payload.get("timestamp")

        if source_type is None or timestamp is None:
            row = state.sqlite_conn.execute(
                "SELECT source_type, timestamp FROM chunks WHERE id = ?",
                (chunk_id,),
            ).fetchone()
            if row:
                source_type = source_type or row[0]
                timestamp = timestamp or row[1]

        recalled_chunks.append(
            {
                "id": chunk_nid,
                "type": "chunk",
                "source_type": source_type,
                "timestamp": timestamp,
                "score": hit.get("score"),
                "readable": True,
            }
        )

    return {
        "mode": "graph",
        "graph": {
            "components": components,
            "seeds": _labeled_ids([s[0] for s in all_seeds], labels),
            "expandable": expandable,
        },
        "recalled_chunks": recalled_chunks,
        "graph_mermaids": graph_mermaids,
        "cursor": {"visited": visited, "lambda": req.lambda_},
    }


@app.post("/entity")
async def entity_lookup(req: EntityRequest):
    """Entity lookup by substring match (semaphore-gated; offloaded to a thread)."""
    async with _query_sema():
        return await asyncio.to_thread(_entity_lookup_impl, req)


def _entity_lookup_impl(req: EntityRequest):
    """Entity lookup by substring match."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    # Check if community columns exist (they're added by improve.py)
    cols = [
        c[1]
        for c in state.sqlite_conn.execute("PRAGMA table_info(entities)").fetchall()
    ]
    has_community = "community_L0" in cols
    if has_community:
        rows = state.sqlite_conn.execute(
            """SELECT id, name, entity_type, mention_count, first_seen, last_seen,
                      community_L0, community_L1, community_L2, community_L3
               FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT ?""",
            (f"%{req.name}%", req.limit),
        ).fetchall()
    else:
        rows = state.sqlite_conn.execute(
            """SELECT id, name, entity_type, mention_count, first_seen, last_seen
               FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT ?""",
            (f"%{req.name}%", req.limit),
        ).fetchall()

    results = []
    for r in rows:
        eid = r[0]
        # Get edge counts and details from adjacency index
        adj_entries = state.adjacency.get(eid, [])
        degree = len(adj_entries)

        # Top edges from adjacency: tuples are (edge_type, related_id, related_type, direction)
        edges_out = []
        for entry in adj_entries[:10]:
            edge_type, related_id, related_type, direction = entry
            edges_out.append(
                {
                    "type": edge_type,
                    "target_type": related_type,
                    "target_id": related_id,
                    "target_label": _label_for(related_id, related_type),
                    "direction": direction,
                }
            )

        # Facts ABOUT this entity — from adjacency incoming ABOUT edges
        fact_ids = []
        for entry in adj_entries:
            edge_type, related_id, related_type, direction = entry
            if edge_type == "ABOUT" and related_type == "fact" and direction == "in":
                fact_ids.append(related_id)
                if len(fact_ids) >= 5:
                    break

        about_facts = []
        if fact_ids:
            placeholders = ",".join("?" * len(fact_ids))
            about_facts = state.sqlite_conn.execute(
                f"""SELECT id, text, fact_type, timestamp, confidence
                    FROM facts WHERE id IN ({placeholders})
                    ORDER BY confidence DESC, timestamp DESC""",
                fact_ids,
            ).fetchall()

        results.append(
            {
                "id": eid,
                "name": r[1],
                "type": r[2],
                "mentions": r[3],
                "first_seen": r[4],
                "last_seen": r[5],
                "communities": {"L0": r[6], "L1": r[7], "L2": r[8], "L3": r[9]}
                if has_community
                else {},
                "degree": degree,
                "edges": edges_out[:5],
                "facts": [
                    {
                        "id": f[0],
                        "text": f[1],
                        "type": f[2],
                        "timestamp": f[3],
                        "confidence": f[4],
                    }
                    for f in about_facts
                ],
            }
        )

    return {"results": results, "count": len(results)}


@app.post("/expand")
async def expand_entity(req: ExpandRequest):
    """Show ENTITY_SIMILAR neighbors (semaphore-gated; offloaded to a thread)."""
    async with _query_sema():
        return await asyncio.to_thread(_expand_entity_impl, req)


def _expand_entity_impl(req: ExpandRequest):
    """Show ENTITY_SIMILAR neighbors for entity."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    row = state.sqlite_conn.execute(
        "SELECT name, entity_type FROM entities WHERE id = ?", (req.entity_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, f"Entity not found: {req.entity_id}")

    # Use the backend-agnostic adjacency index rather than reading an edge table.
    adj_entries = state.adjacency.get(req.entity_id, [])
    sim_neighbors = []
    for entry in adj_entries:
        edge_type, related_id, related_type, _direction = entry
        if edge_type == "ENTITY_SIMILAR" and related_type == "entity":
            sim_neighbors.append(related_id)

    results = []
    for nid in sim_neighbors:
        nrow = state.sqlite_conn.execute(
            "SELECT name, entity_type FROM entities WHERE id = ?", (nid,)
        ).fetchone()
        results.append(
            {
                "id": nid,
                "name": nrow[0] if nrow else "?",
                "type": nrow[1] if nrow else "?",
                "confidence": None,
                "source": "similarity",
            }
        )

    results.sort(key=lambda x: x.get("confidence") or 0, reverse=True)
    return {"entity": row[0], "type": row[1], "neighbors": results}


@app.post("/facts")
async def entity_facts(req: FactsRequest):
    """Facts ABOUT an entity (semaphore-gated; offloaded to a thread)."""
    async with _query_sema():
        return await asyncio.to_thread(_entity_facts_impl, req)


def _entity_facts_impl(req: FactsRequest):
    """Facts ABOUT an entity (id + text), most confident first.

    Closes the trace-back loop: an entity id from ``/entity`` maps to the exact
    facts, each with a full fact id usable with ``/context``.
    """
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    row = state.sqlite_conn.execute(
        "SELECT name, entity_type FROM entities WHERE id = ?", (req.entity_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, f"Entity not found: {req.entity_id}")

    # Use the backend-agnostic adjacency index to find ABOUT facts.
    adj_entries = state.adjacency.get(req.entity_id, [])
    fact_ids = []
    for entry in adj_entries:
        edge_type, related_id, related_type, direction = entry
        if edge_type == "ABOUT" and related_type == "fact" and direction == "in":
            fact_ids.append(related_id)
            if len(fact_ids) >= req.limit:
                break

    facts = []
    if fact_ids:
        placeholders = ",".join("?" * len(fact_ids))
        facts = state.sqlite_conn.execute(
            f"""SELECT id, text, fact_type, timestamp, confidence
                FROM facts WHERE id IN ({placeholders})
                ORDER BY confidence DESC, timestamp DESC LIMIT ?""",
            fact_ids + [req.limit],
        ).fetchall()

    return {
        "entity": row[0],
        "type": row[1],
        "entity_id": req.entity_id,
        "facts": [
            {
                "id": f[0],
                "text": f[1],
                "type": f[2],
                "timestamp": f[3],
                "confidence": f[4],
            }
            for f in facts
        ],
    }


@app.post("/community")
async def community_browse(req: CommunityRequest):
    """Browse communities (semaphore-gated; offloaded to a thread)."""
    async with _query_sema():
        return await asyncio.to_thread(_community_browse_impl, req)


def _community_browse_impl(req: CommunityRequest):
    """Browse communities with summaries."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    # community_summaries is created by the community summarizer / embed step,
    # not the base schema. Degrade gracefully instead of 500 when it's absent.
    has_summaries = state.sqlite_conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='community_summaries'"
    ).fetchone()
    if not has_summaries:
        hint = (
            "No community summaries yet — run community detection + summarization "
            "(scripts.improve, community_summarizer, embed_communities) or "
            "`kl ingest` without --no-improve, then embed summaries."
        )
        if req.community_id is not None:
            return {"error": hint}
        return {"communities": [], "note": hint}

    if req.community_id is not None:
        row = state.sqlite_conn.execute(
            """
            SELECT summary, tags, top_members, member_count
            FROM community_summaries
            WHERE level = ? AND community_id = ? AND node_type = ?
        """,
            (req.level, req.community_id, req.node_type),
        ).fetchone()

        if not row:
            return {
                "error": f"No summary for {req.level}/{req.node_type}/{req.community_id}"
            }

        return {
            "level": req.level,
            "community_id": req.community_id,
            "node_type": req.node_type,
            "member_count": row[3],
            "summary": row[0],
            "tags": json.loads(row[1]),
            "top_members": json.loads(row[2]),
        }

    rows = state.sqlite_conn.execute(
        """
        SELECT community_id, member_count, summary, tags
        FROM community_summaries
        WHERE level = ? AND node_type = ?
        ORDER BY member_count DESC LIMIT ?
    """,
        (req.level, req.node_type, req.top_k),
    ).fetchall()

    return {
        "communities": [
            {
                "community_id": r[0],
                "member_count": r[1],
                "summary": r[2],
                "tags": json.loads(r[3]),
            }
            for r in rows
        ]
    }


@app.post("/members")
async def community_members(req: MembersRequest):
    """List community members (semaphore-gated; offloaded to a thread)."""
    async with _query_sema():
        return await asyncio.to_thread(_community_members_impl, req)


def _community_members_impl(req: MembersRequest):
    """List community members."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    col = f"community_{req.level}"

    if req.node_type == "entity":
        rows = state.sqlite_conn.execute(
            f"""
            SELECT id, name, entity_type, mention_count
            FROM entities WHERE {col} = ?
            ORDER BY mention_count DESC LIMIT ?
        """,
            (req.community_id, req.limit),
        ).fetchall()
        return {
            "members": [
                {"id": r[0], "name": r[1], "type": r[2], "mentions": r[3]} for r in rows
            ]
        }
    else:
        rows = state.sqlite_conn.execute(
            f"""
            SELECT id, text, fact_type, timestamp
            FROM facts WHERE {col} = ?
            ORDER BY timestamp DESC LIMIT ?
        """,
            (req.community_id, req.limit),
        ).fetchall()
        return {
            "members": [
                {"id": r[0], "text": r[1], "type": r[2], "timestamp": r[3]}
                for r in rows
            ]
        }


@app.post("/context")
async def fact_context(req: ContextRequest):
    """Source messages + entities for a fact (semaphore-gated; offloaded)."""
    async with _query_sema():
        return await asyncio.to_thread(_fact_context_impl, req)


def _fact_context_impl(req: ContextRequest):
    """Show source messages and entities for a fact."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    fact_id = req.fact_id

    # Get fact (exact or prefix match)
    fact = state.sqlite_conn.execute(
        "SELECT id, text, fact_type, timestamp, confidence, source_chunk_id FROM facts WHERE id = ?",
        (fact_id,),
    ).fetchone()
    if not fact:
        fact = state.sqlite_conn.execute(
            "SELECT id, text, fact_type, timestamp, confidence, source_chunk_id FROM facts WHERE id LIKE ?",
            (f"{fact_id}%",),
        ).fetchone()
    if not fact:
        raise HTTPException(404, f"Fact not found: {fact_id}")

    fact_id_full = fact[0]
    source_chunk_id = fact[5]

    # Resolve the fact's source against the universal ``chunks`` table (works
    # for any source_type). Chat is just ``source_type == "message"``, so this is
    # the single source of truth regardless of source.
    chunk = state.sqlite_conn.execute(
        "SELECT id, content, source_type, timestamp, source_ref, metadata "
        "FROM chunks WHERE id = ?",
        (source_chunk_id,),
    ).fetchone()

    # Chat-specific detail (sender/conversation) + surrounding thread, only when
    # the source chunk is a chat message. Chat fields live in the chunk's
    # ``metadata`` JSON now that the per-message detail table is gone.
    chat_meta: dict = {}
    if chunk and chunk[2] == "message":
        try:
            chat_meta = json.loads(chunk[5]) if chunk[5] else {}
        except (TypeError, ValueError):
            chat_meta = {}
    msg = (
        (
            chunk[0],
            chat_meta.get("sender", ""),
            chunk[1],
            chunk[3],
            chat_meta.get("conversation_id", ""),
        )
        if chat_meta
        else None
    )

    # Related entities — use adjacency (fact→entity ABOUT edges)
    fact_adj = state.adjacency.get(fact_id_full, [])
    entity_ids = []
    for entry in fact_adj:
        edge_type, related_id, related_type, _direction = entry
        if edge_type == "ABOUT" and related_type == "entity":
            entity_ids.append(related_id)

    entities = []
    if entity_ids:
        placeholders = ",".join("?" * len(entity_ids))
        entities = state.sqlite_conn.execute(
            f"SELECT name, entity_type, id FROM entities WHERE id IN ({placeholders})",
            entity_ids,
        ).fetchall()

    # Surrounding context (chat only)
    surrounding = []
    if msg:
        surrounding = state.sqlite_conn.execute(
            """
            SELECT json_extract(metadata, '$.sender'), content, timestamp
            FROM chunks
            WHERE source_type = 'message'
              AND json_extract(metadata, '$.conversation_id') = ?
              AND ABS(timestamp - ?) < 300000
            ORDER BY timestamp LIMIT 7
        """,
            (msg[4], msg[3]),
        ).fetchall()

    return {
        "fact": {
            "id": fact[0],
            "text": fact[1],
            "type": fact[2],
            "timestamp": fact[3],
            "confidence": fact[4],
        },
        # Universal provenance: the source chunk, whatever its source_type.
        "source_chunk": {
            "id": chunk[0],
            "content": chunk[1],
            "source_type": chunk[2],
            "timestamp": chunk[3],
            "source_ref": chunk[4],
        }
        if chunk
        else None,
        # Chat-specific view of the same source (None for non-chat sources).
        "source_message": {
            "id": msg[0],
            "sender": msg[1],
            "content": msg[2],
            "timestamp": msg[3],
            "conversation_id": msg[4],
        }
        if msg
        else None,
        "entities": [{"name": e[0], "type": e[1], "id": e[2]} for e in entities],
        "surrounding": [
            {"sender": s[0], "content": s[1], "timestamp": s[2]} for s in surrounding
        ],
    }


@app.post("/timeline")
async def entity_timeline(req: TimelineRequest):
    """Chronological facts for an entity (semaphore-gated; offloaded)."""
    async with _query_sema():
        return await asyncio.to_thread(_entity_timeline_impl, req)


def _entity_timeline_impl(req: TimelineRequest):
    """Chronological facts for an entity."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    # Find entity. A zero-hit name search is a successful empty result, not a
    # missing resource (same convention as /entity), so return an empty 200
    # rather than 404. Payload shape mirrors the populated response with null
    # entity fields so clients can branch on ``entity is None``.
    entity_row = state.sqlite_conn.execute(
        "SELECT id, name FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT 1",
        (f"%{req.entity_name}%",),
    ).fetchone()
    if not entity_row:
        return {
            "entity": None,
            "entity_id": None,
            "degree": 0,
            "auto_filtered": False,
            "facts": [],
            "latency_ms": 0,
        }

    entity_id = entity_row[0]

    # Check degree from adjacency to decide strategy
    degree = len(state.adjacency.get(entity_id, []))

    # Build time filter — DEFAULT to last 90 days for high-degree entities without explicit filter
    time_filter = ""
    params = [entity_id]

    has_time_filter = req.from_date is not None or req.to_date is not None

    if req.from_date:
        try:
            ts = int(datetime.strptime(req.from_date, "%Y-%m-%d").timestamp() * 1000)  # noqa: DTZ007
            time_filter += " AND f.timestamp >= ?"
            params.append(ts)
        except ValueError:
            raise HTTPException(400, f"Invalid date: {req.from_date}")

    if req.to_date:
        try:
            ts = int(datetime.strptime(req.to_date, "%Y-%m-%d").timestamp() * 1000)  # noqa: DTZ007
            time_filter += " AND f.timestamp <= ?"
            params.append(ts)
        except ValueError:
            raise HTTPException(400, f"Invalid date: {req.to_date}")

    # For high-degree entities without time filter, default to last 90 days
    if not has_time_filter and degree > 200:
        ninety_days_ago = int((time.time() - 90 * 86400) * 1000)
        time_filter += " AND f.timestamp >= ?"
        params.append(ninety_days_ago)

    # params is now [entity_id, <optional time vals>...] — extract time vals only
    time_vals = params[1:]  # skip entity_id

    t0 = time.time()
    # Resolve fact IDs through the backend-agnostic adjacency index.
    adj_entries = state.adjacency.get(entity_id, [])
    fact_ids = [
        related_id
        for (edge_type, related_id, related_type, direction) in adj_entries
        if edge_type == "ABOUT" and related_type == "fact" and direction == "in"
    ]

    facts = []
    if fact_ids:
        # For large sets, batch query. Use time filter and LIMIT to keep it manageable.
        # SQLite handles up to 999 params; chunk if needed.
        batch_size = 500
        all_facts = []
        for i in range(0, len(fact_ids), batch_size):
            batch = fact_ids[i : i + batch_size]
            placeholders = ",".join("?" * len(batch))
            time_conds = ""
            if time_filter:
                time_conds = time_filter.replace("f.timestamp", "timestamp")
            query_params = batch + time_vals
            rows = state.sqlite_conn.execute(
                f"""SELECT id, text, fact_type, timestamp, confidence
                    FROM facts WHERE id IN ({placeholders})
                    AND timestamp > 0 {time_conds}
                    ORDER BY timestamp DESC""",
                query_params,
            ).fetchall()
            all_facts.extend(rows)
        # Sort all and limit
        all_facts.sort(key=lambda x: x[3] or 0, reverse=True)
        facts = all_facts[: req.limit]
    latency = (time.time() - t0) * 1000

    return {
        "entity": entity_row[1],
        "entity_id": entity_id,
        "degree": degree,
        "auto_filtered": not has_time_filter and degree > 200,
        "facts": [
            {
                "id": f[0],
                "text": f[1],
                "type": f[2],
                "timestamp": f[3],
                "confidence": f[4],
            }
            for f in facts
        ],
        "latency_ms": round(latency),
    }


# ── GraphRAG interactive retrieval ──────────────────────────────────────


def _graph_built() -> bool:
    """Live check: is the LLM-extracted graph populated?"""
    ent = state.sqlite_conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
    fac = state.sqlite_conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    return ent > 0 and fac > 0


def _importance(node_id: str) -> float:
    """Query-independent structural importance for the fan-out ranking.

    Entities use their PageRank prior; facts use their stored confidence. Used
    only to order/cap neighbors — never to rank against the query.
    """
    ntype = gw.node_type_of(node_id)
    bare = gw.strip_prefix(node_id)
    if ntype == "entity":
        return state.pagerank.get(bare, 0.0)
    if ntype == "fact":
        row = state.sqlite_conn.execute(
            "SELECT confidence FROM facts WHERE id = ?", (bare,)
        ).fetchone()
        return row[0] if row else 0.0
    return 0.0


def _seeds_for_query(
    query: str,
    seed_k: int,
    *,
    matched: list[dict] | None = None,
    q_vec: list[float] | None = None,
    fact_hits: list[dict] | None = None,
    chunk_hits: list[dict] | None = None,
) -> tuple[list[tuple], list[tuple]]:
    """Convert flat vector/LLM recall into graph seed nodes (chunk->node bridge).

    Returns two separate buckets so chunks never crowd out entity/fact seeds:

    - ``ef_seeds``: rewrite entities (sim × pagerank) + entities behind top
      message chunks (reverse MENTIONS, chunk-score × pagerank) + top fact
      hits (sim × confidence), deduped by id keeping the best relevance,
      capped at ``seed_k``.
    - ``chunk_seeds``: the top ``seed_k`` chunk hits as ``chunk`` nodes
      (``gw.namespaced(chunk_id, "chunk")`` with hit score).

    All of ``matched`` (entity dicts), ``q_vec`` (query embedding),
    ``fact_hits`` and ``chunk_hits`` (raw Qdrant ANN hits) may be passed in
    to **reuse** what Phase-1 already computed — this avoids re-running the
    expensive LLM entity match + query embedding, and the two Qdrant
    searches, a second time (``/ask`` always passes them from its query
    result). When omitted they are computed here. Passed-in hit lists are
    sliced to ``seed_k`` to match a fresh search.
    """
    engine = state.engine
    seed_best: dict[str, float] = {}

    def bump(node_id: str, rel: float):
        if rel > seed_best.get(node_id, 0.0):
            seed_best[node_id] = rel

    # Reuse Phase-1's embedding + entity match when provided; else compute.
    if q_vec is None or matched is None:
        norm = query
        try:
            from kl_graph.query.query_rewrite import normalize_query

            norm = normalize_query(query)
        except Exception:  # noqa: BLE001, S110
            pass
        if q_vec is None:
            q_vec = engine.embedder.embed_one(norm)
        if matched is None:
            # _match_entities is reentrant now: returns (matched, rewrite). The
            # seed builder only needs the matched entities; drop the rewrite.
            matched, _ = engine._match_entities(norm)

    # (a) rewrite entities -> sim x pagerank
    for ent in matched:
        pr = state.pagerank.get(ent["id"], 0.5)
        bump(gw.namespaced(ent["id"], "entity"), ent["sim"] * pr)

    # (b) top fact chunks as fact-seeds -> sim x confidence. Reuse Phase-1's
    # facts-collection hits when passed; else search.
    if fact_hits is None:
        fact_hits = engine.qdrant.search("facts", q_vec, limit=seed_k)
    for h in fact_hits[:seed_k]:
        p = h["payload"]
        fid = p.get("fact_id")
        if not fid:
            continue
        conf = p.get("confidence", 0.8)
        bump(gw.namespaced(fid, "fact"), h["score"] * conf)

    # (c) entities behind top chunks (reverse MENTIONS) -> score x pagerank.
    # Reuse Phase-1's chunks-collection hits when passed; else search.
    if chunk_hits is None:
        chunk_hits = engine.qdrant.search("chunks", q_vec, limit=seed_k)
    for h in chunk_hits[:seed_k]:
        mid = h["payload"].get("chunk_id")
        if not mid:
            continue
        rows = state.sqlite_conn.execute(
            """SELECT target_id FROM edges
               WHERE edge_type = 'MENTIONS' AND target_type = 'entity'
                 AND source_id = ?""",
            (mid,),
        ).fetchall()
        for (eid,) in rows:
            pr = state.pagerank.get(eid, 0.5)
            bump(gw.namespaced(eid, "entity"), h["score"] * pr)

    # dedup already done via seed_best; take top seed_k by relevance.
    ef_seeds = sorted(seed_best.items(), key=lambda kv: kv[1], reverse=True)[:seed_k]

    # (d) Chunk seeds — separate bucket, not competing with entity/fact pool.
    chunk_seeds: list[tuple[str, float]] = []
    seen_chunk_ids: set[str] = set()
    for h in chunk_hits[:seed_k]:
        cid = h["payload"].get("chunk_id")
        if not cid or cid in seen_chunk_ids:
            continue
        seen_chunk_ids.add(cid)
        chunk_seeds.append((gw.namespaced(cid, "chunk"), h["score"]))

    return ef_seeds, chunk_seeds


def _has_community_labels() -> bool:
    """Whether community detection has run (adds community_L1 columns).

    Freshly-built graphs (ingest only, no scripts/improve) lack these columns,
    so the graph endpoints must degrade gracefully instead of erroring.
    """
    cols = state.sqlite_conn.execute("PRAGMA table_info(entities)").fetchall()
    return any(c[1] == "community_L1" for c in cols)


def _resolve_nodes(nodes: list[dict]) -> list[dict]:
    """Attach intrinsic content + free community_L1 label to walk nodes.

    Entities carry name + pagerank; facts carry text + confidence; communities
    carry their level/summary/member_count. No source chunks/attachments —
    provenance is pulled on demand via /context.
    """
    resolved = []
    has_comm = _has_community_labels()
    for n in nodes:
        nid = n["id"]
        ntype = gw.node_type_of(nid)
        bare = gw.strip_prefix(nid)
        out = {"id": nid, "type": ntype, "score": n["score"], "hop": n["hop"]}
        if ntype == "entity":
            cols = "name, community_L1" if has_comm else "name"
            row = state.sqlite_conn.execute(
                f"SELECT {cols} FROM entities WHERE id = ?", (bare,)
            ).fetchone()
            if row:
                out["name"] = row[0]
                if has_comm:
                    out["community_L1"] = row[1]
                out["pagerank"] = state.pagerank.get(bare, 0.0)
        elif ntype == "fact":
            cols = "text, confidence, community_L1" if has_comm else "text, confidence"
            row = state.sqlite_conn.execute(
                f"SELECT {cols} FROM facts WHERE id = ?", (bare,)
            ).fetchone()
            if row:
                out["text"] = row[0]
                out["confidence"] = row[1]
                if has_comm:
                    out["community_L1"] = row[2]
        elif ntype == "chunk":
            row = state.sqlite_conn.execute(
                "SELECT source_type, timestamp, source_ref FROM chunks WHERE id = ?",
                (bare,),
            ).fetchone()
            if row:
                out["source_type"] = row[0]
                out["timestamp"] = row[1]
                # source_ref intentionally not exposed in the resolved node.
            else:
                out["source_type"] = None
                out["timestamp"] = None
            out["readable"] = True
        elif ntype == "community":
            # A landed-on community node: its own summary/level, so the agent can
            # read the cluster without a second /community call.
            row = state.sqlite_conn.execute(
                "SELECT level, node_type, summary, member_count "
                "FROM communities WHERE id = ?",
                (bare,),
            ).fetchone()
            if row:
                out["level"] = row[0]
                out["node_type"] = row[1]
                out["summary"] = row[2]
                out["member_count"] = row[3]
        resolved.append(out)
    return resolved


def _expandable(nodes: list[dict]) -> list[str]:
    """Node ids that still have un-expanded walkable neighbors -> /graph_hop.

    The neighbour-type set mirrors the walk's valid-node rule
    (:func:`kl_graph.query.graph_walk.graph_walk`): if a type is a legal hop
    target there, a node holding only that kind of neighbour must still be
    advertised as expandable, or the gate and the walk disagree. So ``chunk``
    counts (a chunk reached via ``STATES``/``MENTIONS`` can expand along
    ``TEMPORAL``/``REPLY_TO``), and ``community`` counts in both directions (a
    node with only a ``COMM_MEMBER`` neighbour expands into its community, and a
    community node expands into its members).
    """
    out = []
    for n in nodes:
        bare = gw.strip_prefix(n["id"])
        nbrs = state.adjacency.get(bare, [])
        if any(
            e[0] in gw.WALKABLE and e[2] in ("entity", "fact", "chunk", "community")
            for e in nbrs
        ):
            out.append(n["id"])
    return out


def _label_for(bare_id: str, node_type: str) -> str:
    """Human-readable label for a bare (un-prefixed) id of a known type.

    Resolves an entity id to its ``name``, a fact id to its ``text``, a
    community id to its summary (or ``<node_type> <level>``), and a chunk id
    to its ``source_ref`` (or ``<source_type> chunk``) so edge endpoints are
    traceable instead of opaque UUIDs. Falls back to the bare id.
    """
    if node_type == "entity":
        row = state.sqlite_conn.execute(
            "SELECT name FROM entities WHERE id = ?", (bare_id,)
        ).fetchone()
    elif node_type == "fact":
        row = state.sqlite_conn.execute(
            "SELECT text FROM facts WHERE id = ?", (bare_id,)
        ).fetchone()
    elif node_type == "community":
        crow = state.sqlite_conn.execute(
            "SELECT summary, node_type, level FROM communities WHERE id = ?",
            (bare_id,),
        ).fetchone()
        if not crow:
            return bare_id
        return crow[0] or f"{crow[1]} community {crow[2]}"
    elif node_type == "chunk":
        crow = state.sqlite_conn.execute(
            "SELECT source_ref, source_type FROM chunks WHERE id = ?",
            (bare_id,),
        ).fetchone()
        if not crow:
            return bare_id
        return crow[0] or (f"{crow[1]} chunk" if crow[1] else bare_id)
    else:
        row = None
    return row[0] if row and row[0] else bare_id


def _node_label(node_id: str) -> str:
    """Human-readable label for a namespaced id (entity name / fact text / chunk ref).

    Falls back to the bare id when the row is missing or the type is unknown.
    """
    ntype = gw.node_type_of(node_id)
    bare = gw.strip_prefix(node_id)
    if ntype == "entity":
        row = state.sqlite_conn.execute(
            "SELECT name FROM entities WHERE id = ?", (bare,)
        ).fetchone()
    elif ntype == "fact":
        row = state.sqlite_conn.execute(
            "SELECT text FROM facts WHERE id = ?", (bare,)
        ).fetchone()
    elif ntype == "chunk":
        crow = state.sqlite_conn.execute(
            "SELECT source_ref, source_type FROM chunks WHERE id = ?",
            (bare,),
        ).fetchone()
        if not crow:
            return bare
        return crow[0] or (f"{crow[1]} chunk" if crow[1] else bare)
    else:
        row = None
    return row[0] if row and row[0] else bare


def _label_map(resolved: list[dict]) -> dict[str, str]:
    """id -> label from already-resolved nodes (avoids re-querying SQLite)."""
    return {n["id"]: (n.get("name") or n.get("text") or n["id"]) for n in resolved}


def _labeled_ids(ids: list[str], known: dict[str, str]) -> list[dict]:
    """Turn bare id references into ``{id, label}`` pairs (Option A).

    Uses the ``known`` map first (resolved nodes) and only hits SQLite for ids
    not present there (e.g. a /graph_hop edge pointing at the expanded seed,
    which is excluded from the returned nodes).
    """
    return [{"id": i, "label": known.get(i) or _node_label(i)} for i in ids]


def _labeled_edges(edges: list[dict], known: dict[str, str]) -> list[dict]:
    """Inline ``from_label``/``to_label`` onto each edge (Option A)."""
    for e in edges:
        e["from_label"] = known.get(e["from"]) or _node_label(e["from"])
        e["to_label"] = known.get(e["to"]) or _node_label(e["to"])
    return edges


@app.post("/graph_hop")
async def graph_hop(req: GraphHopRequest):
    """Expand one node one hop deeper (semaphore-gated; offloaded to a thread)."""
    async with _query_sema():
        return await asyncio.to_thread(_graph_hop_impl, req)


def _graph_hop_impl(req: GraphHopRequest):
    """Expand one node one hop deeper from the echoed cursor. No LLM, no embed."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    t0 = time.time()
    cursor = req.cursor or {}
    visited = dict(cursor.get("visited", {}))
    lambda_ = cursor.get("lambda", 0.6)

    # The node being expanded is the single seed, at its best-known score.
    seed_score = visited.get(req.node_id, 1.0)
    seeds = [(req.node_id, seed_score)]

    nodes, edges, new_visited = gw.graph_walk(
        state.adjacency,
        seeds,
        radius=1,
        max_fanout=req.max_fanout,
        max_nodes=10_000,
        lambda_=lambda_,
        importance_fn=_importance,
        initial_best=visited,
    )
    # Return only the newly revealed frontier (exclude the expanded seed itself).
    new_nodes = [n for n in nodes if n["id"] != req.node_id]
    resolved = _resolve_nodes(new_nodes)
    labels = _label_map(resolved)
    labeled_edges = _labeled_edges(edges, labels)
    expandable = _labeled_ids(_expandable(new_nodes), labels)

    # Group into connected components
    components = _connected_components(resolved, labeled_edges)

    # Build per-component mermaid diagrams
    graph_mermaids = [
        gw.to_mermaid(comp["nodes"], comp["edges"]) for comp in components
    ]

    return {
        "mode": "graph",
        "node_id": req.node_id,
        "graph": {
            "components": components,
            "expandable": expandable,
        },
        "graph_mermaids": graph_mermaids,
        "cursor": {"visited": new_visited, "lambda": lambda_},
        "latency_ms": round((time.time() - t0) * 1000),
    }


@app.post("/chunk")
async def chunk_read(req: ChunkRequest):
    """Read chunk content by IDs (semaphore-gated; offloaded to a thread)."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")
    async with _query_sema():
        return await asyncio.to_thread(_chunk_impl, req)


def _chunk_impl(req: ChunkRequest):
    """Implementation of /chunk endpoint."""
    if not state.store:
        raise HTTPException(503, "KnowledgeStore not available")

    # Strip 'cnk:' prefix from each requested ID
    stripped_ids = [gw.strip_prefix(cid) for cid in req.chunk_ids]

    # Fetch all chunks in one call
    chunks = state.store.get_chunks_by_ids(stripped_ids)

    # Build a map from bare_id -> chunk for O(1) lookup
    chunk_map = {chunk.id: chunk for chunk in chunks}

    # Build response preserving request order (1:1 mapping)
    result = []
    for original_id, stripped_id in zip(req.chunk_ids, stripped_ids):
        chunk = chunk_map.get(stripped_id)
        if chunk:
            result.append(
                {
                    "id": original_id,
                    "found": True,
                    "content": chunk.content,
                    "source_type": chunk.source_type,
                    "timestamp": chunk.timestamp,
                    "source_ref": chunk.source_ref,
                    "metadata": chunk.metadata,
                }
            )
        else:
            result.append(
                {
                    "id": original_id,
                    "found": False,
                }
            )

    return {"chunks": result}


@app.get("/health")
async def health():
    """Quick health check."""
    return {"status": "ok" if state.ready else "starting"}


def _resolve_entity_id(name_or_id: str) -> str | None:
    """Resolve an entity name or ID to a canonical entity ID.

    Resolution order:
    1. Exact ID match
    2. Exact name match (ordered by mention_count DESC)
    3. Substring name match (ordered by mention_count DESC)

    Returns None when no matching entity is found.
    """
    # Exact ID match
    row = state.sqlite_conn.execute(
        "SELECT id FROM entities WHERE id = ?", (name_or_id,)
    ).fetchone()
    if row:
        return row[0]
    # Exact name match
    row = state.sqlite_conn.execute(
        "SELECT id FROM entities WHERE name = ? ORDER BY mention_count DESC LIMIT 1",
        (name_or_id,),
    ).fetchone()
    if row:
        return row[0]
    # Substring match (escape LIKE wildcards in user input)
    escaped = name_or_id.replace("%", "\\%").replace("_", "\\_")
    row = state.sqlite_conn.execute(
        "SELECT id FROM entities WHERE name LIKE ? ESCAPE '\\' ORDER BY mention_count DESC LIMIT 1",
        (f"%{escaped}%",),
    ).fetchone()
    return row[0] if row else None


@app.post("/path")
async def find_path(req: PathRequest):
    """Find shortest relation paths between two entities.

    Resolves entity names to IDs (exact ID → exact name → substring match),
    delegates path finding to the GraphDB backend, then resolves node labels
    for display.
    """
    if not state.ready:
        raise HTTPException(503, "Server not ready")
    if state.store is None:
        raise HTTPException(503, "KnowledgeStore not available")

    async with _query_sema():
        src_id = _resolve_entity_id(req.source)
        tgt_id = _resolve_entity_id(req.target)
        if not src_id:
            raise HTTPException(404, f"Entity not found: {req.source}")
        if not tgt_id:
            raise HTTPException(404, f"Entity not found: {req.target}")

        result = await asyncio.to_thread(
            state.store.find_paths,
            src_id,
            tgt_id,
            max_hops=req.max_hops,
            all_shortest=req.all_paths,
            edge_types=req.edge_types,
        )
        return _path_response(result)


def _path_response(result) -> dict:
    """Shape /path's PathResult into the response dict (CPU-only)."""
    # Resolve labels for display
    paths_out = []
    for p in result.paths:
        nodes_out = []
        for n in p.nodes:
            label = _label_for(n.id, n.node_type)
            nodes_out.append({"id": n.id, "type": n.node_type, "label": label})
        edges_out = []
        for e in p.edges:
            edges_out.append(
                {
                    "source_id": e.source_id,
                    "target_id": e.target_id,
                    "edge_type": e.edge_type,
                    "direction": e.direction,
                    "properties": e.properties,
                }
            )
        paths_out.append(
            {
                "nodes": nodes_out,
                "edges": edges_out,
                "hop_count": p.hop_count,
            }
        )

    return {
        "source": {
            "id": result.source.id,
            "label": _label_for(result.source.id, result.source.node_type),
        },
        "target": {
            "id": result.target.id,
            "label": _label_for(result.target.id, result.target.node_type),
        },
        "paths": paths_out,
        "path_count": len(paths_out),
        "exhausted": result.exhausted,
    }


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
