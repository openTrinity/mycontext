#!/usr/bin/env python3
"""kl-server — Persistent retrieval server for the knowledge graph.

Keeps Qdrant stores and SQLite open in memory to eliminate cold-start overhead.
The kl CLI becomes a thin HTTP client calling this server.

Start: .venv/bin/python kl_server.py
Port: 8200 (configurable via KL_SERVER_PORT env var)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# Ensure Unicode-safe stdout/stderr on all platforms.  On Windows the console
# defaults to GBK / cp1252, which crashes print()/logging on emoji or non-ASCII.
# reconfigure() is a no-op on systems already using UTF-8 (macOS, Linux).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# Project setup
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

from kl_graph.config import (
    QDRANT_EXACT_SEARCH,
    QDRANT_PATH,
    SQLITE_PATH,
)
from kl_graph.query.pagerank import compute_entity_pagerank
from kl_graph.query import graph_walk as gw

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("kl-server")

# Community Qdrant is a separate lightweight store
COMMUNITY_QDRANT_PATH = str(Path(QDRANT_PATH).parent / "qdrant_communities")

PORT = int(os.environ.get("KL_SERVER_PORT", 8200))


# ── Global state (initialized in lifespan) ─────────────────────────────────

class ServerState:
    """Holds pre-warmed connections."""
    sqlite_conn: sqlite3.Connection | None = None
    qdrant_main: object | None = None  # QdrantClient
    qdrant_communities: object | None = None  # QdrantClient
    adjacency: dict | None = None  # entity_id/fact_id -> list of (edge_type, neighbor_id, neighbor_type, dir)
    pagerank: dict | None = None  # entity_id -> importance score (facts-only projection)
    engine: object | None = None  # QueryEngine (hybrid search + seed extraction)
    startup_time: float = 0
    ready: bool = False
    # Background ingestion job (Phase A + B). Only one runs at a time.
    ingest_task: object | None = None  # asyncio.Task
    ingest_progress: dict | None = None  # {state, phase, percent, detail, error}

state = ServerState()


def _build_adjacency(conn: sqlite3.Connection) -> dict:
    """Build in-memory adjacency index from edges table.

    Key: entity_id or fact_id (namespacing is applied by the walk layer)
    Value: list of (edge_type, related_id, related_type, direction)

    Stores entity-keyed edges (for ego subgraph traversal and SIMILAR_TO
    expansion) plus fact-keyed ABOUT/INVOLVES edges so an interactive walk
    sitting *on a fact* can reach its entities. ~125K edges -> ~10MB in memory.
    """
    logger.info("Building in-memory adjacency index...")
    t0 = time.time()
    adj: dict[str, list] = {}

    # Entity as source (outgoing)
    cursor = conn.execute("""
        SELECT source_id, edge_type, target_id, target_type
        FROM edges WHERE source_type = 'entity'
    """)
    out_count = 0
    for row in cursor:
        src, etype, tgt, ttype = row
        if src not in adj:
            adj[src] = []
        adj[src].append((etype, tgt, ttype, "out"))
        out_count += 1

    # Entity as target (incoming) — for ABOUT edges (fact -> entity)
    cursor = conn.execute("""
        SELECT target_id, edge_type, source_id, source_type
        FROM edges WHERE target_type = 'entity'
    """)
    in_count = 0
    for row in cursor:
        tgt, etype, src, stype = row
        if tgt not in adj:
            adj[tgt] = []
        adj[tgt].append((etype, src, stype, "in"))
        in_count += 1

    # Fact-keyed walkable edges (fact -> entity via ABOUT/INVOLVES). These rows
    # are already indexed under the entity key above; index them under the fact
    # key too so a walk on a fact node finds its entities. STATES (fact->message)
    # and fact<->fact SIMILAR_TO are not walked, so they are intentionally left
    # out (provenance comes from /context, not the adjacency index).
    cursor = conn.execute("""
        SELECT source_id, edge_type, target_id, target_type
        FROM edges
        WHERE source_type = 'fact' AND edge_type IN ('ABOUT', 'INVOLVES')
    """)
    fact_count = 0
    for row in cursor:
        src, etype, tgt, ttype = row
        if src not in adj:
            adj[src] = []
        adj[src].append((etype, tgt, ttype, "out"))
        fact_count += 1

    elapsed = time.time() - t0
    logger.info(
        f"Adjacency index: {len(adj)} keys, "
        f"{out_count + in_count} entity-edges + {fact_count} fact-edges, {elapsed:.1f}s"
    )
    return adj


def _compute_pagerank(
    conn: sqlite3.Connection,
    damping: float = 0.85,
    max_iter: int = 100,
    tol: float = 1e-6,
) -> dict[str, float]:
    """Facts-only entity PageRank prior (see kl_graph.query.pagerank)."""
    return compute_entity_pagerank(conn, damping=damping, max_iter=max_iter, tol=tol)


def _shared_stores():
    """Wrap the server's warm SQLite conn + Qdrant client as store objects.

    Reuses the single open Qdrant client (single-writer lock) and SQLite
    connection so a background ingest can write without opening a second
    handle or restarting the server.
    """
    from kl_graph.storage.qdrant_store import QdrantStore
    from kl_graph.storage.sqlite_store import SQLiteStore

    shared_sqlite = SQLiteStore(Path(SQLITE_PATH), conn=state.sqlite_conn)
    shared_qdrant = QdrantStore.__new__(QdrantStore)
    shared_qdrant.path = QDRANT_PATH
    shared_qdrant.client = state.qdrant_main
    return shared_sqlite, shared_qdrant


def _hot_swap_graph():
    """Rebuild the in-memory graph indexes from the updated DB and swap them in.

    Called after a background ingest commits new entities/facts/edges. Python
    reference assignment is atomic, so in-flight queries keep using the old
    index until the new one is fully built — no locking, no restart.
    """
    logger.info("Hot-swapping graph indexes after ingest...")
    new_adjacency = _build_adjacency(state.sqlite_conn)
    new_pagerank = _compute_pagerank(state.sqlite_conn)
    state.adjacency = new_adjacency
    state.pagerank = new_pagerank
    # The query engine reads pagerank by reference; refresh its handle too.
    if state.engine is not None and hasattr(state.engine, "pagerank"):
        state.engine.pagerank = new_pagerank
    # Re-open the community store if this ingest created it.
    if state.qdrant_communities is None and Path(COMMUNITY_QDRANT_PATH).exists():
        try:
            from qdrant_client import QdrantClient
            state.qdrant_communities = QdrantClient(path=COMMUNITY_QDRANT_PATH)
        except Exception as e:
            logger.warning(f"Could not open community store after ingest: {e}")
    logger.info(f"Hot-swap done: {len(new_adjacency)} adjacency keys")


def _set_progress(state_str: str, phase: str, percent: float, detail: str = "", error: str = ""):
    """Update the background-ingest progress record read by /status."""
    state.ingest_progress = {
        "state": state_str,          # idle | running | done | error
        "phase": phase,              # phase_a | phase_b | improve | ""
        "percent": round(percent, 3),
        "detail": detail,
        "error": error,
        "updated_at": time.time(),
    }


async def _run_ingest_job(req: IngestRequest):
    """Background ingest: Phase A (chunk+embed) then Phase B (extract+graph).

    Runs inside the server process so it reuses the single Qdrant writer. The
    server keeps serving throughout; on completion the graph indexes are
    hot-swapped in. Overall progress is surfaced via /status.
    """
    try:
        from kl_graph.ingest.pipeline import (
            EXTRACTION_CACHE_DIR,
            CHAT_DIR,
            IngestionPipeline,
        )

        _set_progress("running", "phase_a", 0.0, "starting")
        sqlite, qdrant = _shared_stores()

        # export_dir override -> point at that export's chat dir for this run
        # (sibling sources are derived from its parent by the pipeline).
        messages_dir = CHAT_DIR
        if req.export_dir:
            messages_dir = Path(req.export_dir) / "chat"

        pipeline = IngestionPipeline(
            messages_dir=messages_dir,
            cache_dir=EXTRACTION_CACHE_DIR,
            max_concurrent_llm=req.concurrency,
            sqlite=sqlite,
            qdrant=qdrant,
        )

        # Phase A (blocking CPU/IO) off the event loop so queries stay responsive.
        # Smart resume: skip Phase A when every chunk is already persisted +
        # embedded (Phase B alone is fine here because the chunks already exist).
        def _phase_a():
            if pipeline._phase_a_complete():
                _set_progress("running", "phase_a", 0.4,
                              "phase A already complete — resuming at phase B")
                return
            pipeline.run_phase_a(
                progress_callback=lambda ph, pct: _set_progress(
                    "running", ph, pct * 0.4, "chunking + embedding"
                )
            )
        await asyncio.to_thread(_phase_a)
        _set_progress("running", "phase_b", 0.4, "extraction + graph build")

        # Phase B: extraction is async; graph build is blocking. Both stream
        # fine-grained progress so /status advances continuously instead of
        # jumping 0.4 → 0.7 → 0.85.
        def _extract_progress(done: int, total: int):
            frac = (done / total) if total else 1.0
            _set_progress(
                "running", "phase_b", 0.4 + 0.3 * frac,
                f"extracting: {done}/{total} batches",
            )

        await pipeline.run_extraction(progress_callback=_extract_progress)
        _set_progress("running", "phase_b", 0.7, "building graph")

        def _graph_progress(frac: float):
            _set_progress(
                "running", "phase_b", 0.7 + 0.15 * frac, "building graph",
            )

        await asyncio.to_thread(
            pipeline.run_graph_build, progress_callback=_graph_progress
        )
        _set_progress("running", "improve", 0.85, "communities + pagerank")

        # Re-run periodic improvement (communities, similarity) over the new graph.
        if req.run_improve:
            def _improve():
                from kl_graph.periodic.runner import run_periodic_improvement
                run_periodic_improvement(sqlite=sqlite, qdrant=qdrant)
            try:
                await asyncio.to_thread(_improve)
            except TypeError:
                # runner doesn't accept injected stores yet; skip gracefully.
                logger.warning("Periodic improvement skipped (no injected-store support).")

        # Hot-swap the in-memory indexes so the graph endpoints see new data.
        _set_progress("running", "improve", 0.95, "hot-swapping indexes")
        await asyncio.to_thread(_hot_swap_graph)

        _set_progress("done", "", 1.0, "ingest complete")
        logger.info("Background ingest complete.")
    except Exception as e:
        logger.exception("Background ingest failed")
        _set_progress("error", "", 0.0, "", str(e))
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
    state.sqlite_conn = sqlite3.connect(str(SQLITE_PATH), check_same_thread=False)
    state.sqlite_conn.execute("PRAGMA journal_mode=WAL")
    state.sqlite_conn.execute("PRAGMA synchronous=NORMAL")
    state.sqlite_conn.execute("PRAGMA cache_size=-64000")  # 64MB
    state.sqlite_conn.execute("PRAGMA mmap_size=100000000")  # 100MB mmap
    # Ensure the schema exists so the server can start against a brand-new DB
    # (before any ingest). SQLiteStore(conn=...) runs idempotent CREATE IF NOT
    # EXISTS on our warm connection; it does not open a second handle.
    from kl_graph.storage.sqlite_store import SQLiteStore
    SQLiteStore(Path(SQLITE_PATH), conn=state.sqlite_conn)
    # Warm the cache
    state.sqlite_conn.execute("SELECT COUNT(*) FROM edges").fetchone()
    state.sqlite_conn.execute("SELECT COUNT(*) FROM facts").fetchone()
    logger.info("SQLite: ready")

    # 2. Build adjacency index
    state.adjacency = _build_adjacency(state.sqlite_conn)

    # 2b. Facts-only entity PageRank prior (SIMILAR_TO excluded)
    state.pagerank = _compute_pagerank(state.sqlite_conn)

    # 3. Qdrant main store (slow — mmaps 300MB)
    logger.info(f"Opening Qdrant main: {QDRANT_PATH}")
    from qdrant_client import QdrantClient
    from qdrant_client.models import SearchParams
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
    except Exception as e:
        logger.warning(f"Could not ensure Qdrant collections: {e}")
    # Warm by doing a dummy operation
    try:
        state.qdrant_main.get_collection("facts")
    except Exception:
        pass
    logger.info("Qdrant main: ready")

    # 4. Qdrant communities (fast — separate small store)
    if Path(COMMUNITY_QDRANT_PATH).exists():
        logger.info(f"Opening Qdrant communities: {COMMUNITY_QDRANT_PATH}")
        state.qdrant_communities = QdrantClient(path=COMMUNITY_QDRANT_PATH)
        logger.info("Qdrant communities: ready")
    else:
        logger.warning(f"Community store not found: {COMMUNITY_QDRANT_PATH}")

    # 5. Hybrid query engine — shares the warm SQLite conn + Qdrant client +
    # pagerank so /search delegates to the full engine (dense+sparse+RRF+rerank
    # +optional Phase-2) and the graph endpoints reuse it for seed extraction.
    logger.info("Initializing query engine (shared stores)...")
    try:
        from kl_graph.query.engine import QueryEngine
        from kl_graph.storage.sqlite_store import SQLiteStore

        shared_sqlite = SQLiteStore(Path(SQLITE_PATH), conn=state.sqlite_conn)
        state.engine = QueryEngine(
            sqlite=shared_sqlite,
            qdrant=_main_store,
            pagerank=state.pagerank,
        )
        logger.info("Query engine: ready")
    except Exception as e:
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
    if state.sqlite_conn:
        state.sqlite_conn.close()


app = FastAPI(title="kl-server", lifespan=lifespan)


# ── Request/Response models ─────────────────────────────────────────────────

class EmbedSearchRequest(BaseModel):
    query: str
    collection: str = "facts"  # facts | chunks (alias: messages) | entities | communities
    top_k: int = 10
    min_timestamp: Optional[int] = None
    max_timestamp: Optional[int] = None

class IngestRequest(BaseModel):
    export_dir: Optional[str] = None  # KL_DWS_EXPORT_DIR override; None = config default
    concurrency: int = 50             # max concurrent extraction LLM calls
    run_improve: bool = True          # re-run community detection / PageRank after graph build

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
        fields = {"lambda_": "lambda"}

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
    community_id: Optional[int] = None
    top_k: int = 20

class MembersRequest(BaseModel):
    community_id: int
    level: str = "L1"
    node_type: str = "entity"
    limit: int = 30

class ContextRequest(BaseModel):
    fact_id: str

class TimelineRequest(BaseModel):
    entity_name: str
    from_date: Optional[str] = None  # YYYY-MM-DD
    to_date: Optional[str] = None
    limit: int = 30

class GraphHopRequest(BaseModel):
    node_id: str  # "ent:.." | "fact:.."
    cursor: dict  # echoed from the previous response
    max_fanout: int = 10


# ── Embedding helper ─────────────────────────────────────────────────────────

# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/status")
async def get_status():
    """Server health + DB stats."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    stats = {}
    # SQLite counts
    stats["messages"] = state.sqlite_conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    stats["entities"] = state.sqlite_conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]
    stats["facts"] = state.sqlite_conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    stats["edges"] = state.sqlite_conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]

    # Qdrant counts
    qdrant_stats = {}
    for coll in ["chunks", "entities", "facts"]:
        try:
            info = state.qdrant_main.get_collection(coll)
            qdrant_stats[coll] = info.points_count
        except Exception:
            qdrant_stats[coll] = 0

    if state.qdrant_communities:
        try:
            info = state.qdrant_communities.get_collection("communities")
            qdrant_stats["communities"] = info.points_count
        except Exception:
            qdrant_stats["communities"] = 0

    return {
        "status": "ready",
        "startup_time_s": round(state.startup_time, 1),
        "adjacency_entities": len(state.adjacency) if state.adjacency else 0,
        "sqlite": stats,
        "qdrant": qdrant_stats,
        "ingest": state.ingest_progress or {"state": "idle", "percent": 0.0},
    }


@app.post("/ingest")
async def ingest(req: IngestRequest):
    """Start a background ingest (Phase A chunk+embed, then Phase B extract+graph).

    Non-blocking: returns immediately with the job state. The server keeps
    serving queries throughout; new graph data is hot-swapped in on completion.
    Poll ``/status`` (``ingest.percent``) for progress. Only one ingest runs at
    a time.
    """
    if not state.ready:
        raise HTTPException(503, "Server not ready")
    if state.ingest_task is not None and not state.ingest_task.done():
        raise HTTPException(409, "An ingest is already running")

    _set_progress("running", "phase_a", 0.0, "queued")
    state.ingest_task = asyncio.create_task(_run_ingest_job(req))
    return {"status": "started", "ingest": state.ingest_progress}


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
    try:
        vec = state.engine.embedder.embed_one(req.query)
    except Exception as e:
        raise HTTPException(502, f"Embedding error: {e}")
    t_embed = time.time() - t0

    from qdrant_client.models import (
        FieldCondition,
        Filter,
        Range,
        SearchParams,
    )

    if req.collection == "communities":
        if not state.qdrant_communities:
            raise HTTPException(404, "Community store not available")
        response = state.qdrant_communities.query_points(
            collection_name="communities",
            query=vec,
            limit=req.top_k,
            search_params=SearchParams(exact=QDRANT_EXACT_SEARCH, hnsw_ef=128),
        )
    else:
        # `messages` is a backward-compat alias for the unified `chunks` store.
        collection = "chunks" if req.collection == "messages" else req.collection
        conditions = []
        if req.min_timestamp is not None:
            conditions.append(FieldCondition(key="timestamp", range=Range(gte=req.min_timestamp)))
        if req.max_timestamp is not None:
            conditions.append(FieldCondition(key="timestamp", range=Range(lte=req.max_timestamp)))
        filter_obj = Filter(must=conditions) if conditions else None

        response = state.qdrant_main.query_points(
            collection_name=collection,
            query=vec,
            limit=req.top_k,
            query_filter=filter_obj,
            search_params=SearchParams(exact=QDRANT_EXACT_SEARCH, hnsw_ef=128),
        )

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
        results.append({
            "id": str(domain_id) if domain_id is not None else str(r.id),
            "point_id": str(r.id),
            "score": r.score,
            "payload": payload,
        })
    t_total = time.time() - t0
    return {
        "collection": req.collection,
        "results": results,
        "latency_ms": round(t_total * 1000),
        "embed_ms": round(t_embed * 1000),
        "search_ms": round((t_total - t_embed) * 1000),
    }


@app.post("/ask")
async def ask(req: AskRequest):
    """Hybrid question-answering + interactive graph walk in one call.

    Two phases sharing a single query embedding + entity match (one LLM call):

    1. **Query** — ``engine.query()``: dense + sparse + RRF (+ optional rerank)
       over chunks and facts, optionally escalating to Phase-2 LLM synthesis
       (``force_phase2``, off by default). Produces ``items`` + ``answer``.
    2. **Graph walk** — ``gw.graph_walk()`` seeded from the entities/facts the
       query already extracted (reuses ``q_vec`` + ``matched_entities``, so no
       second LLM/embed call). Produces the depth-1 hoppable frontier
       (``seeds``/``nodes``/``edges``/``expandable``) + a ``cursor`` for
       ``/graph_hop``.

    When the graph is not built the walk fields come back empty
    (``mode="chunks_only"``) and only the flat ``items`` are returned.
    """
    if not state.ready:
        raise HTTPException(503, "Server not ready")
    if state.engine is None:
        raise HTTPException(503, "Query engine not available")

    t0 = time.time()
    try:
        result = state.engine.query(req.query, force_phase2=req.force_phase2)
    except Exception as e:
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
            seeds=[],
            nodes=[],
            edges=[],
            expandable=[],
            cursor={"visited": {}, "lambda": req.lambda_},
            latency_ms=round((time.time() - t0) * 1000),
        )
        return base

    # Phase 2: walk the graph from the query's entities/facts. Reuse Phase-1's
    # embedding + entity match so the walk adds no second LLM/embed call.
    seeds = _seeds_for_query(
        req.query,
        req.seed_k,
        matched=result.matched_entities,
        q_vec=result.q_vec,
        fact_hits=result.fact_hits,
        chunk_hits=result.chunk_hits,
    )
    nodes, edges, visited = gw.graph_walk(
        state.adjacency,
        seeds,
        radius=req.radius,
        max_fanout=req.max_fanout,
        max_nodes=req.max_nodes,
        lambda_=req.lambda_,
        importance_fn=_importance,
    )
    resolved = _resolve_nodes(nodes)
    labels = _label_map(resolved)
    base.update(
        mode="graph",
        seeds=_labeled_ids([s[0] for s in seeds], labels),
        nodes=resolved,
        edges=_labeled_edges(edges, labels),
        expandable=_labeled_ids(_expandable(nodes), labels),
        cursor={"visited": visited, "lambda": req.lambda_},
        latency_ms=round((time.time() - t0) * 1000),
    )
    return base


@app.post("/entity")
async def entity_lookup(req: EntityRequest):
    """Entity lookup by substring match."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    rows = state.sqlite_conn.execute(
        """SELECT id, name, entity_type, mention_count, first_seen, last_seen,
                  community_L0, community_L1, community_L2, community_L3
           FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT ?""",
        (f"%{req.name}%", req.limit)
    ).fetchall()

    results = []
    for r in rows:
        eid = r[0]
        # Get edge counts from adjacency
        degree = len(state.adjacency.get(eid, []))

        # Get top edges (first 5)
        edges_out = state.sqlite_conn.execute("""
            SELECT edge_type, target_type, target_id, properties FROM edges
            WHERE source_id = ? AND source_type = 'entity' LIMIT 5
        """, (eid,)).fetchall()

        edges_in = state.sqlite_conn.execute("""
            SELECT edge_type, source_type, source_id, properties FROM edges
            WHERE target_id = ? AND target_type = 'entity' AND edge_type = 'SIMILAR_TO' LIMIT 5
        """, (eid,)).fetchall()

        # Facts ABOUT this entity (traceable: id + text), most confident first.
        about_facts = state.sqlite_conn.execute("""
            SELECT f.id, f.text, f.fact_type, f.timestamp, f.confidence
            FROM facts f
            JOIN edges e ON e.source_id = f.id AND e.source_type = 'fact'
                AND e.target_id = ? AND e.target_type = 'entity'
                AND e.edge_type = 'ABOUT'
            ORDER BY f.confidence DESC, f.timestamp DESC LIMIT 5
        """, (eid,)).fetchall()

        results.append({
            "id": eid,
            "name": r[1],
            "type": r[2],
            "mentions": r[3],
            "first_seen": r[4],
            "last_seen": r[5],
            "communities": {"L0": r[6], "L1": r[7], "L2": r[8], "L3": r[9]},
            "degree": degree,
            "edges_out": [{"type": e[0], "target_type": e[1], "target_id": e[2],
                           "target_label": _label_for(e[2], e[1])} for e in edges_out],
            "edges_in": [{"type": e[0], "source_type": e[1], "source_id": e[2],
                          "source_label": _label_for(e[2], e[1]),
                          "properties": json.loads(e[3]) if e[3] else {}} for e in edges_in],
            "facts": [{"id": f[0], "text": f[1], "type": f[2],
                       "timestamp": f[3], "confidence": f[4]} for f in about_facts],
        })

    return {"results": results, "count": len(results)}


@app.post("/expand")
async def expand_entity(req: ExpandRequest):
    """Show SIMILAR_TO neighbors for entity."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    row = state.sqlite_conn.execute(
        "SELECT name, entity_type FROM entities WHERE id = ?", (req.entity_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, f"Entity not found: {req.entity_id}")

    neighbors = state.sqlite_conn.execute("""
        SELECT
            CASE WHEN source_id = ? THEN target_id ELSE source_id END as neighbor_id,
            properties
        FROM edges
        WHERE edge_type = 'SIMILAR_TO'
          AND source_type = 'entity' AND target_type = 'entity'
          AND (source_id = ? OR target_id = ?)
    """, (req.entity_id, req.entity_id, req.entity_id)).fetchall()

    results = []
    for n in neighbors:
        nrow = state.sqlite_conn.execute(
            "SELECT name, entity_type FROM entities WHERE id = ?", (n[0],)
        ).fetchone()
        props = json.loads(n[1]) if n[1] else {}
        results.append({
            "id": n[0],
            "name": nrow[0] if nrow else "?",
            "type": nrow[1] if nrow else "?",
            "confidence": props.get("confidence", props.get("hybrid_score")),
            "source": props.get("source", "similarity"),
        })

    results.sort(key=lambda x: x.get("confidence") or 0, reverse=True)
    return {"entity": row[0], "type": row[1], "neighbors": results}


@app.post("/facts")
async def entity_facts(req: FactsRequest):
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

    facts = state.sqlite_conn.execute("""
        SELECT f.id, f.text, f.fact_type, f.timestamp, f.confidence
        FROM facts f
        JOIN edges e ON e.source_id = f.id AND e.source_type = 'fact'
            AND e.target_id = ? AND e.target_type = 'entity'
            AND e.edge_type = 'ABOUT'
        ORDER BY f.confidence DESC, f.timestamp DESC LIMIT ?
    """, (req.entity_id, req.limit)).fetchall()

    return {
        "entity": row[0],
        "type": row[1],
        "entity_id": req.entity_id,
        "facts": [{"id": f[0], "text": f[1], "type": f[2],
                   "timestamp": f[3], "confidence": f[4]} for f in facts],
    }


@app.post("/community")
async def community_browse(req: CommunityRequest):
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
        row = state.sqlite_conn.execute("""
            SELECT summary, tags, top_members, member_count
            FROM community_summaries
            WHERE level = ? AND community_id = ? AND node_type = ?
        """, (req.level, req.community_id, req.node_type)).fetchone()

        if not row:
            return {"error": f"No summary for {req.level}/{req.node_type}/{req.community_id}"}

        return {
            "level": req.level,
            "community_id": req.community_id,
            "node_type": req.node_type,
            "member_count": row[3],
            "summary": row[0],
            "tags": json.loads(row[1]),
            "top_members": json.loads(row[2]),
        }

    rows = state.sqlite_conn.execute("""
        SELECT community_id, member_count, summary, tags
        FROM community_summaries
        WHERE level = ? AND node_type = ?
        ORDER BY member_count DESC LIMIT ?
    """, (req.level, req.node_type, req.top_k)).fetchall()

    return {
        "communities": [{
            "community_id": r[0],
            "member_count": r[1],
            "summary": r[2],
            "tags": json.loads(r[3]),
        } for r in rows]
    }


@app.post("/members")
async def community_members(req: MembersRequest):
    """List community members."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    col = f"community_{req.level}"

    if req.node_type == "entity":
        rows = state.sqlite_conn.execute(f"""
            SELECT id, name, entity_type, mention_count
            FROM entities WHERE {col} = ?
            ORDER BY mention_count DESC LIMIT ?
        """, (req.community_id, req.limit)).fetchall()
        return {
            "members": [{"id": r[0], "name": r[1], "type": r[2], "mentions": r[3]} for r in rows]
        }
    else:
        rows = state.sqlite_conn.execute(f"""
            SELECT id, text, fact_type, timestamp
            FROM facts WHERE {col} = ?
            ORDER BY timestamp DESC LIMIT ?
        """, (req.community_id, req.limit)).fetchall()
        return {
            "members": [{"id": r[0], "text": r[1], "type": r[2], "timestamp": r[3]} for r in rows]
        }


@app.post("/context")
async def fact_context(req: ContextRequest):
    """Show source messages and entities for a fact."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    fact_id = req.fact_id

    # Get fact (exact or prefix match)
    fact = state.sqlite_conn.execute(
        "SELECT id, text, fact_type, timestamp, confidence, source_message_id FROM facts WHERE id = ?",
        (fact_id,)
    ).fetchone()
    if not fact:
        fact = state.sqlite_conn.execute(
            "SELECT id, text, fact_type, timestamp, confidence, source_message_id FROM facts WHERE id LIKE ?",
            (f"{fact_id}%",)
        ).fetchone()
    if not fact:
        raise HTTPException(404, f"Fact not found: {fact_id}")

    fact_id_full = fact[0]
    source_chunk_id = fact[5]

    # Resolve the fact's source against the universal ``chunks`` table (works
    # for any source_type). Chat messages also live in ``chunks`` (dual-write),
    # so this is the source of truth regardless of source.
    chunk = state.sqlite_conn.execute(
        "SELECT id, content, source_type, timestamp, source_ref FROM chunks WHERE id = ?",
        (source_chunk_id,)
    ).fetchone()

    # Chat-specific detail (sender/conversation) + surrounding thread, only when
    # the source chunk is a chat message.
    msg = state.sqlite_conn.execute(
        "SELECT id, sender, content, timestamp, conversation_id FROM messages WHERE id = ?",
        (source_chunk_id,)
    ).fetchone()

    # Related entities
    entities = state.sqlite_conn.execute("""
        SELECT e.name, e.entity_type, e.id FROM entities e
        JOIN edges ed ON ed.target_id = e.id AND ed.target_type = 'entity'
        WHERE ed.source_id = ? AND ed.source_type = 'fact' AND ed.edge_type = 'ABOUT'
    """, (fact_id_full,)).fetchall()

    # Surrounding context (chat only)
    surrounding = []
    if msg:
        surrounding = state.sqlite_conn.execute("""
            SELECT sender, content, timestamp FROM messages
            WHERE conversation_id = ? AND ABS(timestamp - ?) < 300000
            ORDER BY timestamp LIMIT 7
        """, (msg[4], msg[3])).fetchall()

    return {
        "fact": {
            "id": fact[0], "text": fact[1], "type": fact[2],
            "timestamp": fact[3], "confidence": fact[4],
        },
        # Universal provenance: the source chunk, whatever its source_type.
        "source_chunk": {
            "id": chunk[0], "content": chunk[1], "source_type": chunk[2],
            "timestamp": chunk[3], "source_ref": chunk[4],
        } if chunk else None,
        # Chat-specific view of the same source (None for non-chat sources).
        "source_message": {
            "id": msg[0], "sender": msg[1], "content": msg[2],
            "timestamp": msg[3], "conversation_id": msg[4],
        } if msg else None,
        "entities": [{"name": e[0], "type": e[1], "id": e[2]} for e in entities],
        "surrounding": [{"sender": s[0], "content": s[1], "timestamp": s[2]} for s in surrounding],
    }


@app.post("/timeline")
async def entity_timeline(req: TimelineRequest):
    """Chronological facts for an entity."""
    if not state.ready:
        raise HTTPException(503, "Server not ready")

    # Find entity
    entity_row = state.sqlite_conn.execute(
        "SELECT id, name FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT 1",
        (f"%{req.entity_name}%",)
    ).fetchone()
    if not entity_row:
        raise HTTPException(404, f"Entity not found: {req.entity_name}")

    entity_id = entity_row[0]

    # Check degree from adjacency to decide strategy
    degree = len(state.adjacency.get(entity_id, []))

    # Build time filter — DEFAULT to last 90 days for high-degree entities without explicit filter
    time_filter = ""
    params = [entity_id]

    has_time_filter = req.from_date is not None or req.to_date is not None

    if req.from_date:
        try:
            ts = int(datetime.strptime(req.from_date, "%Y-%m-%d").timestamp() * 1000)
            time_filter += " AND f.timestamp >= ?"
            params.append(ts)
        except ValueError:
            raise HTTPException(400, f"Invalid date: {req.from_date}")

    if req.to_date:
        try:
            ts = int(datetime.strptime(req.to_date, "%Y-%m-%d").timestamp() * 1000)
            time_filter += " AND f.timestamp <= ?"
            params.append(ts)
        except ValueError:
            raise HTTPException(400, f"Invalid date: {req.to_date}")

    # For high-degree entities without time filter, default to last 90 days
    if not has_time_filter and degree > 200:
        ninety_days_ago = int((time.time() - 90 * 86400) * 1000)
        time_filter += " AND f.timestamp >= ?"
        params.append(ninety_days_ago)

    params.append(req.limit)

    t0 = time.time()
    facts = state.sqlite_conn.execute(f"""
        SELECT f.id, f.text, f.fact_type, f.timestamp, f.confidence
        FROM facts f
        JOIN edges e ON e.source_id = f.id AND e.source_type = 'fact'
            AND e.target_id = ? AND e.target_type = 'entity'
            AND e.edge_type = 'ABOUT'
        WHERE f.timestamp > 0 {time_filter}
        ORDER BY f.timestamp DESC
        LIMIT ?
    """, params).fetchall()
    latency = (time.time() - t0) * 1000

    return {
        "entity": entity_row[1],
        "entity_id": entity_id,
        "degree": degree,
        "auto_filtered": not has_time_filter and degree > 200,
        "facts": [{
            "id": f[0], "text": f[1], "type": f[2],
            "timestamp": f[3], "confidence": f[4],
        } for f in facts],
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
) -> list[tuple]:
    """Convert flat vector/LLM recall into graph seed nodes (chunk->node bridge).

    Seeds = rewrite entities (sim x pagerank) + entities behind top message
    chunks (reverse MENTIONS, chunk-score x pagerank) + top fact chunks as
    fact-seeds (sim x confidence), deduped by id keeping the best relevance,
    top ``seed_k``.

    All of ``matched`` (entity dicts), ``q_vec`` (query embedding), ``fact_hits``
    and ``chunk_hits`` (raw Qdrant ANN hits) may be passed in to **reuse** what
    Phase-1 already computed — this avoids re-running the expensive LLM entity
    match + query embedding, and the two Qdrant searches, a second time (``/ask``
    always passes them from its query result). When omitted they are computed
    here. Passed-in hit lists are sliced to ``seed_k`` to match a fresh search.
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
        except Exception:
            pass
        if q_vec is None:
            q_vec = engine.embedder.embed_one(norm)
        if matched is None:
            matched = engine._match_entities(norm, q_vec)

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
    seeds = sorted(seed_best.items(), key=lambda kv: kv[1], reverse=True)[:seed_k]
    return seeds


def _has_community_labels() -> bool:
    """Whether community detection has run (adds community_L1 columns).

    Freshly-built graphs (ingest only, no scripts/improve) lack these columns,
    so the graph endpoints must degrade gracefully instead of erroring.
    """
    cols = state.sqlite_conn.execute("PRAGMA table_info(entities)").fetchall()
    return any(c[1] == "community_L1" for c in cols)


def _resolve_nodes(nodes: list[dict]) -> list[dict]:
    """Attach intrinsic content + free community_L1 label to walk nodes.

    Entities carry name + pagerank; facts carry text + confidence. No source
    chunks/attachments — provenance is pulled on demand via /context.
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
        resolved.append(out)
    return resolved


def _expandable(nodes: list[dict]) -> list[str]:
    """Node ids that still have un-expanded walkable neighbors -> /graph_hop."""
    out = []
    for n in nodes:
        bare = gw.strip_prefix(n["id"])
        nbrs = state.adjacency.get(bare, [])
        if any(e[0] in gw.WALKABLE and e[2] in ("entity", "fact") for e in nbrs):
            out.append(n["id"])
    return out


def _label_for(bare_id: str, node_type: str) -> str:
    """Human-readable label for a bare (un-prefixed) id of a known type.

    Resolves an entity id to its ``name`` and a fact id to its ``text`` so edge
    endpoints are traceable instead of opaque UUIDs. Falls back to the bare id.
    """
    if node_type == "entity":
        row = state.sqlite_conn.execute(
            "SELECT name FROM entities WHERE id = ?", (bare_id,)
        ).fetchone()
    elif node_type == "fact":
        row = state.sqlite_conn.execute(
            "SELECT text FROM facts WHERE id = ?", (bare_id,)
        ).fetchone()
    else:
        row = None
    return row[0] if row and row[0] else bare_id


def _node_label(node_id: str) -> str:
    """Human-readable label for a namespaced id (entity name / fact text).

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
    return {
        "mode": "graph",
        "node_id": req.node_id,
        "nodes": resolved,
        "edges": _labeled_edges(edges, labels),
        "expandable": _labeled_ids(_expandable(new_nodes), labels),
        "cursor": {"visited": new_visited, "lambda": lambda_},
        "latency_ms": round((time.time() - t0) * 1000),
    }


@app.get("/health")
async def health():
    """Quick health check."""
    return {"status": "ok" if state.ready else "starting"}


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
