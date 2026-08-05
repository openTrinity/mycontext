#!/usr/bin/env python3
"""kl — Knowledge graph CLI (thin HTTP client).

All heavy operations (Qdrant, embeddings) are delegated to kl-server.
This CLI only does: HTTP request -> format output.

Usage:
    kl status              Show server status
    kl start               Start kl-server (retrieval only)
    kl start embedding     Start vLLM embedding server (requires GPU)
    kl stop                Stop all servers
    kl stop embedding      Stop only embedding server
    kl stats               Detailed graph statistics

    kl search <query>      Vector similarity search
    kl entity <name>       Entity lookup (substring)
    kl expand <entity_id>  Show SIMILAR_TO neighbors
    kl community           Browse communities with summaries
    kl members <id>        List community members
    kl context <fact_id>   Fact provenance (source messages)
    kl timeline <entity>   Chronological facts for an entity
    kl graph <query>       Interactive GraphRAG walk (seeds + hop-1 subgraph)
    kl hop <node_id>       Expand one graph node one hop deeper
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import click
import httpx

# Server config
KL_SERVER_PORT = int(os.environ.get("KL_SERVER_PORT", 8200))
KL_SERVER_URL = f"http://127.0.0.1:{KL_SERVER_PORT}"
REQUEST_TIMEOUT = float(os.environ.get("KL_CLI_TIMEOUT", "120"))  # seconds
# Dominated by the LLM: Phase-1 query rewrite (~15-20s) and, when it
# escalates, Phase-2 synthesis (30-90s). 60s was too tight for Phase-2 on
# slower endpoints; 120s gives headroom. Override per-session with
# KL_CLI_TIMEOUT=N if needed.

# Embedding server config
EMBEDDING_PORT_DEFAULT = int(os.environ.get("KL_EMBED_PORT", 8100))
EMBED_MODEL_DEFAULT = "/data/models/Qwen/Qwen3-Embedding-8B"


# ── Helpers ─────────────────────────────────────────────────────────────────


def _server_request(method: str, endpoint: str, **kwargs) -> dict:
    """Make request to kl-server. Raises click.ClickException on failure."""
    url = f"{KL_SERVER_URL}{endpoint}"
    try:
        if method == "GET":
            r = httpx.get(url, timeout=REQUEST_TIMEOUT)
        else:
            r = httpx.post(url, json=kwargs.get("json", {}), timeout=REQUEST_TIMEOUT)

        if r.status_code == 503:
            raise click.ClickException(
                "kl-server is starting up, try again in a moment"
            )
        elif r.status_code == 404:
            data = r.json()
            raise click.ClickException(data.get("detail", "Not found"))
        elif r.status_code == 502:
            data = r.json()
            raise click.ClickException(
                f"Embedding server not available: {data.get('detail', '')}\nRun: kl start"
            )
        elif r.status_code >= 400:
            try:
                data = r.json()
                raise click.ClickException(
                    data.get("detail", f"Server error {r.status_code}")
                )
            except Exception:
                raise click.ClickException(f"Server error {r.status_code}")

        return r.json()

    except httpx.ConnectError:
        raise click.ClickException(
            "kl-server not running. Start it with: kl start"
        )
    except httpx.TimeoutException:
        raise click.ClickException(f"Request timed out ({REQUEST_TIMEOUT}s)")


def _ts_to_str(ts: int) -> str:
    """Convert millisecond timestamp to readable string."""
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")
    except (ValueError, OSError):
        return str(ts)


def _truncate(text: str, max_len: int = 80) -> str:
    """Truncate text with ellipsis."""
    if not text:
        return ""
    text = text.replace("\n", " ").strip()
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "…"


def _check_server_running() -> bool:
    """Quick check if kl-server is reachable.

    Returns True only on HTTP 200. ConnectError and TimeoutException both
    return False — the caller (status) already prints a clear "not running"
    message, so we don't need to distinguish the cause here.
    """
    try:
        r = httpx.get(f"{KL_SERVER_URL}/health", timeout=5)
        return r.status_code == 200
    except httpx.ConnectError:
        return False  # server not started
    except httpx.TimeoutException:
        return False  # server running but slow (e.g. Qdrant warmup)
    except Exception:
        return False


def _check_embedding_server(port: int = EMBEDDING_PORT_DEFAULT) -> bool:
    """Check if a local embedding server is running on the given port.

    Skipped entirely when KL_EMBED_BASE_URL is set — a remote endpoint means
    no local server is expected, so probing port 8100 wastes ~2s waiting for
    a ConnectTimeout.
    """
    if os.environ.get("KL_EMBED_BASE_URL"):
        return False  # remote embedding configured, skip local check
    try:
        r = httpx.get(f"http://localhost:{port}/health", timeout=3)
        return r.status_code == 200
    except httpx.ConnectError:
        return False  # not running — common case, returns instantly
    except httpx.TimeoutException:
        return False  # slow to respond
    except Exception:
        return False


def _detect_gpus() -> list[dict]:
    """Detect available CUDA GPUs via nvidia-smi. Returns list of GPU info dicts."""
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return []
        gpus = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                gpus.append(
                    {
                        "index": int(parts[0]),
                        "name": parts[1],
                        "memory_mb": int(parts[2]),
                    }
                )
        return gpus
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
        return []


def _build_vllm_command(
    model: str,
    port: int,
    dp: int,
    tp: int,
    gpu_util: float,
    served_model_name: str,
) -> list[str]:
    """Construct vLLM serve command for embedding model."""
    cmd = [
        "vllm",
        "serve",
        model,
        "--convert",
        "embed",
        "--port",
        str(port),
        "--gpu-memory-utilization",
        str(gpu_util),
        "--served-model-name",
        served_model_name,
    ]
    if dp > 1:
        cmd.extend(["--data-parallel-size", str(dp)])
    if tp > 1:
        cmd.extend(["--tensor-parallel-size", str(tp)])
    return cmd


def _stop_service(name: str, port: int):
    """Stop a service by finding PIDs on the given port."""
    pids = []

    if sys.platform == "win32":
        # Windows: use netstat to find PIDs listening on the port
        try:
            result = subprocess.run(
                ["netstat", "-ano"], capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
            for line in result.stdout.splitlines():
                # Match LISTENING lines for our port
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.split()
                    if parts:
                        pid = parts[-1]
                        if pid.isdigit() and pid not in pids:
                            pids.append(pid)
        except FileNotFoundError:
            click.echo(f"Cannot find PIDs for {name} (netstat not available)")
            return
    else:
        # Unix: try lsof first
        try:
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"], capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
            pids = [p for p in result.stdout.strip().split("\n") if p]
        except FileNotFoundError:
            pass

        # Fallback to ss if lsof unavailable
        if not pids:
            try:
                result = subprocess.run(
                    ["ss", "-tlnp", f"sport = :{port}"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                for match in re.finditer(r"pid=(\d+)", result.stdout):
                    pids.append(match.group(1))
            except FileNotFoundError:
                click.echo(
                    f"Cannot find PIDs for {name} (neither lsof nor ss available)"
                )
                return

    if pids:
        for pid in pids:
            try:
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/F", "/PID", pid],
                        capture_output=True,
                    )
                else:
                    os.kill(int(pid), signal.SIGTERM)
            except (ProcessLookupError, ValueError, OSError):
                pass
        click.echo(f"Stopped {name} (PIDs: {', '.join(pids)})")
    else:
        click.echo(f"{name}: not running")


# ── CLI Group ───────────────────────────────────────────────────────────────


@click.group()
def cli():
    """kl — Knowledge graph CLI for spatio-temporal retrieval."""
    pass


# ── Lifecycle Commands ──────────────────────────────────────────────────────


@cli.command()
def status():
    """Show server status and DB stats."""
    # kl-server
    if _check_server_running():
        data = _server_request("GET", "/status")
        click.echo(
            f"kl-server: running (port {KL_SERVER_PORT}, started in {data['startup_time_s']}s)"
        )
        click.echo(f"  Adjacency index: {data['adjacency_entities']} entities")
        sq = data["sqlite"]
        click.echo(
            f"  SQLite: {sq['messages']:,} msgs, {sq['entities']:,} entities, "
            f"{sq['facts']:,} facts, {sq['edges']:,} edges"
        )
        qd = data["qdrant"]
        for coll, count in qd.items():
            click.echo(f"  Qdrant/{coll}: {count:,} vectors")
        ing = data.get("ingest") or {}
        if ing.get("state") and ing["state"] != "idle":
            pct = ing.get("percent", 0.0) * 100
            line = f"  Ingest: {ing['state']} {pct:.0f}%"
            if ing.get("phase"):
                line += f" ({ing['phase']})"
            if ing.get("detail"):
                line += f" — {ing['detail']}"
            click.echo(line)
            if ing.get("error"):
                click.echo(f"    error: {ing['error']}")
    else:
        click.echo(f"kl-server: not running (port {KL_SERVER_PORT})")

    # Embedding server
    if _check_embedding_server():
        click.echo(f"Embedding server: running (port {EMBEDDING_PORT_DEFAULT})")
    else:
        click.echo(f"Embedding server: not running (port {EMBEDDING_PORT_DEFAULT})")
        gpus = _detect_gpus()
        if gpus:
            click.echo(
                f"  GPUs available: {len(gpus)} (run 'kl start embedding' to launch)"
            )
        else:
            click.echo(
                "  No GPUs detected (set KL_EMBED_BASE_URL for remote embedding)"
            )


@cli.command()
@click.option(
    "--export-dir",
    "-d",
    default=None,
    help="Export dir to ingest (overrides KL_DWS_EXPORT_DIR)",
)
@click.option(
    "--concurrency",
    "-c",
    type=int,
    default=50,
    help="Max concurrent extraction LLM calls (default 50)",
)
@click.option(
    "--no-improve",
    is_flag=True,
    help="Skip community detection / PageRank after graph build",
)
@click.option("--json-output", "--json", "json_out", is_flag=True, help="JSON output")
def ingest(export_dir, concurrency, no_improve, json_out):
    """Start a background ingest on the running server (Phase A then Phase B).

    Non-blocking: the server keeps serving while it chunks+embeds (Phase A) then
    extracts+builds the graph (Phase B), hot-swapping the new graph in when done.
    Watch progress with 'kl status'.
    """
    body = {"concurrency": concurrency, "run_improve": not no_improve}
    if export_dir:
        body["export_dir"] = export_dir
    data = _server_request("POST", "/ingest", json=body)
    if json_out:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return
    click.echo("Ingest started in the background. Watch progress with 'kl status'.")
    ing = data.get("ingest") or {}
    if ing:
        click.echo(f"  state: {ing.get('state')}  phase: {ing.get('phase')}")


@cli.group(invoke_without_command=True)
@click.pass_context
def start(ctx):
    """Start kl-server. Use 'kl start embedding' for the embedding server."""
    if ctx.invoked_subcommand is not None:
        return  # Subcommand will handle it
    # Start kl-server (retrieval) only
    project_root = Path(__file__).parent
    if _check_server_running():
        click.echo(f"kl-server already running on port {KL_SERVER_PORT}")
    else:
        click.echo(f"Starting kl-server (port {KL_SERVER_PORT})...")
        log_file = project_root / "data" / "kl_server.log"
        log_file.parent.mkdir(parents=True, exist_ok=True)

        # Platform-aware venv python path and process detach
        if sys.platform == "win32":
            python_bin = project_root / ".venv" / "Scripts" / "python.exe"
            popen_kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        else:
            python_bin = project_root / ".venv" / "bin" / "python"
            popen_kwargs = {"preexec_fn": os.setsid}

        proc = subprocess.Popen(
            [str(python_bin), str(project_root / "kl_server.py")],
            stdout=open(log_file, "a"),
            stderr=subprocess.STDOUT,
            cwd=str(project_root),
            **popen_kwargs,
        )
        click.echo(f"kl-server starting (PID {proc.pid}, log: {log_file})")
        click.echo("Use 'kl status' to check when ready (~2min for Qdrant warmup).")


@start.command("embedding")
@click.option(
    "--model",
    type=str,
    default=None,
    help=f"Model path [env: KL_LOCAL_EMBED_MODEL_PATH, default: {EMBED_MODEL_DEFAULT}]",
)
@click.option(
    "--dp",
    type=int,
    default=1,
    help="Data-parallel size (replicate model across N GPUs for throughput)",
)
@click.option(
    "--tp",
    type=int,
    default=1,
    help="Tensor-parallel size (shard model across N GPUs for large models)",
)
@click.option(
    "--port",
    type=int,
    default=EMBEDDING_PORT_DEFAULT,
    help=f"Port for embedding server [default: {EMBEDDING_PORT_DEFAULT}]",
)
@click.option(
    "--gpu-util",
    type=float,
    default=0.4,
    help="GPU memory utilization fraction [default: 0.4]",
)
@click.option(
    "--served-model-name",
    type=str,
    default=None,
    help="Model name exposed via API [default: model dir basename]",
)
def start_embedding(model, dp, tp, port, gpu_util, served_model_name):
    """Start the vLLM embedding server (requires GPU)."""
    # Resolve model path
    if model is None:
        model = os.environ.get("KL_LOCAL_EMBED_MODEL_PATH", EMBED_MODEL_DEFAULT)

    # Resolve served model name
    if served_model_name is None:
        served_model_name = os.environ.get("KL_EMBED_MODEL", Path(model).name)

    # GPU detection
    gpus = _detect_gpus()
    if not gpus:
        raise click.ClickException(
            "No CUDA GPUs detected (nvidia-smi failed or returned empty).\n"
            "The embedding server requires at least one GPU.\n"
            "If using a remote embedding service, set KL_EMBED_BASE_URL instead."
        )

    gpu_count = len(gpus)
    total_gpus_needed = dp * tp
    if total_gpus_needed > gpu_count:
        raise click.ClickException(
            f"Requested dp={dp} x tp={tp} = {total_gpus_needed} GPUs, "
            f"but only {gpu_count} available."
        )

    # Check if already running
    if _check_embedding_server(port):
        click.echo(f"Embedding server already running on port {port}")
        return

    # Build and launch command
    cmd = _build_vllm_command(model, port, dp, tp, gpu_util, served_model_name)

    click.echo(f"Starting embedding server (vLLM, port {port})...")
    click.echo(f"  Model: {model}")
    click.echo(f"  GPUs: {gpu_count} detected, using dp={dp} tp={tp}")
    click.echo(f"  Command: {' '.join(cmd)}")

    project_root = Path(__file__).parent
    log_file = project_root / "data" / "embedding_server.log"
    log_file.parent.mkdir(parents=True, exist_ok=True)

    try:
        if sys.platform == "win32":
            popen_kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        else:
            popen_kwargs = {"preexec_fn": os.setsid}

        proc = subprocess.Popen(
            cmd,
            stdout=open(log_file, "a"),
            stderr=subprocess.STDOUT,
            **popen_kwargs,
        )
    except FileNotFoundError:
        raise click.ClickException(
            "vllm command not found. Install vLLM or ensure it is on PATH."
        )

    click.echo(f"  PID: {proc.pid}, log: {log_file}")
    click.echo("Use 'kl status' to check when ready.")


@cli.group(invoke_without_command=True)
@click.pass_context
def stop(ctx):
    """Stop servers. Use 'kl stop embedding' to stop only the embedding server."""
    if ctx.invoked_subcommand is not None:
        return
    # Stop both (default behavior)
    _stop_service("kl-server", KL_SERVER_PORT)
    _stop_service("embedding server", EMBEDDING_PORT_DEFAULT)


@stop.command("embedding")
def stop_embedding():
    """Stop only the embedding server."""
    _stop_service("embedding server", EMBEDDING_PORT_DEFAULT)


@cli.command()
def stats():
    """Show detailed graph statistics."""
    data = _server_request("GET", "/status")
    sq = data["sqlite"]
    click.echo("=== GRAPH STATISTICS ===\n")
    click.echo(f"Messages:  {sq['messages']:,}")
    click.echo(f"Entities:  {sq['entities']:,}")
    click.echo(f"Facts:     {sq['facts']:,}")
    click.echo(f"Edges:     {sq['edges']:,}")
    click.echo(f"Adjacency: {data['adjacency_entities']} entities indexed")
    click.echo(f"\nQdrant vectors:")
    for coll, count in data["qdrant"].items():
        click.echo(f"  {coll}: {count:,}")


# ── Query Commands ──────────────────────────────────────────────────────────


@cli.command()
@click.argument("query")
@click.option(
    "--collection",
    "-c",
    type=click.Choice(["chunks", "messages", "facts", "entities", "communities"]),
    default="facts",
    help="Collection to search (messages = alias for chunks)",
)
@click.option("--top-k", "-k", type=int, default=10, help="Number of results")
@click.option(
    "--json-output",
    "--json",
    "json_out",
    is_flag=True,
    help="Force JSON output (this is the default)",
)
@click.option("--pretty", is_flag=True, help="Human-readable output (default: JSON)")
def search(query: str, collection: str, top_k: int, json_out: bool, pretty: bool):
    """Vector similarity search over one collection.

    Pure cosine ANN against a single Qdrant collection (facts by default,
    or messages/entities/communities). Output is JSON by default; use --pretty
    for a human view. For a synthesized answer over everything, use 'ask'.
    """
    data = _server_request(
        "POST",
        "/search",
        json={
            "query": query,
            "collection": collection,
            "top_k": top_k,
        },
    )

    # JSON is the default; --pretty opts into the human view, but an explicit
    # --json always wins (so it's safe for scripts to force it).
    if json_out or not pretty:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return

    results = data.get("results", [])
    latency = data.get("latency_ms", 0)
    embed_ms = data.get("embed_ms", 0)
    search_ms = data.get("search_ms", 0)
    click.echo(
        f"[{collection}] {len(results)} results "
        f"({latency}ms, embed={embed_ms}ms search={search_ms}ms)\n"
    )

    for i, r in enumerate(results, 1):
        score = r.get("score", 0.0)
        payload = r.get("payload", {})
        if collection == "facts":
            fact_id = payload.get("fact_id", r["id"])
            text = _truncate(payload.get("text", ""), 100)
            fact_type = payload.get("fact_type", "")
            click.echo(f"  {i}. [{score:.3f}] ({fact_type}) {text}")
            click.echo(f"     id: {fact_id}")
        elif collection in ("chunks", "messages"):
            sender = payload.get("sender", "")
            content = _truncate(payload.get("content", ""), 100)
            ts = _ts_to_str(payload.get("timestamp", 0))
            stype = payload.get("source_type", "")
            label = f"{sender} ({ts})" if sender else f"{stype} ({ts})"
            click.echo(f"  {i}. [{score:.3f}] {label}: {content}")
            click.echo(f"     id: {payload.get('chunk_id', r['id'])}")
        elif collection == "entities":
            name = payload.get("name", "")
            etype = payload.get("entity_type", "")
            click.echo(f"  {i}. [{score:.3f}] {name} ({etype})")
            click.echo(f"     id: {payload.get('entity_id', r['id'])}")
        elif collection == "communities":
            level = payload.get("level", "")
            node_type = payload.get("node_type", "")
            cid = payload.get("community_id", "")
            member_count = payload.get("member_count", 0)
            summary = _truncate(payload.get("summary", ""), 120)
            click.echo(
                f"  {i}. [{score:.3f}] [{level}] {node_type} #{cid} "
                f"({member_count} members)"
            )
            click.echo(f"     {summary}")
            click.echo(f"     -> kl community -l {level} --id {cid} -t {node_type}")


@cli.command()
@click.argument("query")
@click.option("--top-k", "-k", type=int, default=10, help="Number of items")
@click.option(
    "--phase2",
    is_flag=True,
    help="Force LLM synthesis (Phase 2), set to False by default",
)
@click.option("--seed-k", type=int, default=6, help="Number of graph seeds")
@click.option("--radius", "-r", type=int, default=1, help="Graph hops to expand")
@click.option("--max-nodes", type=int, default=50, help="Total graph node cap")
@click.option(
    "--json-output",
    "--json",
    "json_out",
    is_flag=True,
    help="Force JSON output (this is the default)",
)
@click.option("--pretty", is_flag=True, help="Human-readable output (default: JSON)")
def ask(
    query: str,
    top_k: int,
    phase2: bool,
    seed_k: int,
    radius: int,
    max_nodes: int,
    json_out: bool,
    pretty: bool,
):
    """Hybrid retrieval + interactive graph walk (one call).

    Runs the query engine (dense + sparse + RRF, optional Phase-2 synthesis via
    --phase2) and, when the graph is built, walks the depth-1 frontier from the
    entities/facts the query extracted — returning ``items`` plus a hoppable
    ``seeds``/``nodes``/``edges``/``expandable`` graph view (feed an expandable
    id + the ``cursor`` to ``kl hop`` to go deeper). Output is JSON by default;
    --pretty for a human view.
    """
    data = _server_request(
        "POST",
        "/ask",
        json={
            "query": query,
            "top_k": top_k,
            "force_phase2": phase2,
            "seed_k": seed_k,
            "radius": radius,
            "max_nodes": max_nodes,
        },
    )

    # JSON is the default; --pretty opts into the human view, but an explicit
    # --json always wins (so it's safe for scripts to force it).
    if json_out or not pretty:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return

    items = data.get("items", [])
    latency = data.get("latency_ms", 0)
    phase = data.get("phase", 1)
    click.echo(f"[phase {phase}] {len(items)} items ({latency}ms)\n")

    if data.get("answer"):
        click.echo(f"Answer:\n  {data['answer']}\n")

    for i, r in enumerate(items, 1):
        score = r.get("score", 0.0)
        rtype = r.get("type", "?")
        content = _truncate(r.get("content", ""), 100)
        if rtype == "fact":
            click.echo(
                f"  {i}. [{score:.3f}] (fact/{r.get('fact_type', '')}) {content}"
            )
        elif rtype == "message":
            ts = _ts_to_str(r.get("timestamp", 0))
            click.echo(
                f"  {i}. [{score:.3f}] (msg) {r.get('sender', '')} ({ts}): {content}"
            )
        else:
            click.echo(f"  {i}. [{score:.3f}] ({rtype}) {content}")
        click.echo(f"     id: {r.get('id', '')}")

    ents = data.get("entities_found", [])
    if ents:
        click.echo(f"\n  entities: {', '.join(ents)}")

    # Depth-1 hoppable graph view (Phase 2 walk over query-extracted nodes).
    gnodes = data.get("nodes", [])
    gedges = data.get("edges", [])
    seeds = data.get("seeds", [])
    expandable_ids = {e["id"] for e in data.get("expandable", [])}
    if gnodes:
        click.echo("\n  graph (depth-1 hoppable view):")
        for s in seeds:
            mark = " *" if s["id"] in expandable_ids else ""
            click.echo(f"    seed {_truncate(s['label'], 40)}{mark}  [{s['id']}]")
        for e in gedges:
            frm = _truncate(e.get("from_label", e.get("from", "")), 40)
            to = _truncate(e.get("to_label", e.get("to", "")), 40)
            hop_mark = " *" if e.get("to") in expandable_ids else ""
            click.echo(f"      {frm} --{e.get('type', '')}--> {to}{hop_mark}")
        if expandable_ids:
            click.echo("    (* = has further hops; pass the id + cursor to 'kl hop')")


@cli.command()
@click.option(
    "--node-id", "-n", required=True, help="Namespaced id to expand (ent:.. | fact:..)"
)
@click.option(
    "--cursor",
    "-c",
    required=True,
    help="Opaque cursor JSON echoed from a prior 'ask'/'hop' response",
)
@click.option("--max-fanout", type=int, default=10, help="Max neighbors to expand")
@click.option(
    "--json-output",
    "--json",
    "json_out",
    is_flag=True,
    help="Force JSON output (this is the default)",
)
@click.option("--pretty", is_flag=True, help="Human-readable output (default: JSON)")
def hop(node_id: str, cursor: str, max_fanout: int, json_out: bool, pretty: bool):
    """Expand one node one hop deeper (no LLM, no embed).

    Continues an interactive graph walk started by ``ask``: pass an expandable
    node id plus the ``cursor`` from the previous response. Returns only the
    newly revealed frontier (``nodes``/``edges``) and an updated ``cursor`` to
    hop again. Merge the frontier into the graph you already hold (the server is
    stateless between hops). Output is JSON by default; --pretty for a human view.
    """
    try:
        cursor_obj = json.loads(cursor)
    except json.JSONDecodeError as e:
        raise click.BadParameter(f"--cursor must be valid JSON: {e}")

    data = _server_request(
        "POST",
        "/graph_hop",
        json={"node_id": node_id, "cursor": cursor_obj, "max_fanout": max_fanout},
    )

    # JSON is the default; --pretty opts into the human view, --json always wins.
    if json_out or not pretty:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])
    expandable_ids = {e["id"] for e in data.get("expandable", [])}
    latency = data.get("latency_ms", 0)
    click.echo(
        f"hop from {node_id}: {len(nodes)} new nodes, {len(edges)} edges ({latency}ms)\n"
    )
    if not nodes:
        click.echo("  (no new nodes — neighbors already visited or below threshold)")
        return

    for n in nodes:
        mark = " *" if n["id"] in expandable_ids else ""
        label = _truncate(n.get("name") or n.get("text") or n["id"], 50)
        click.echo(
            f"  [{n.get('score', 0.0):.3f}] ({n.get('type', '?')}/hop{n.get('hop', '?')}) "
            f"{label}{mark}  [{n['id']}]"
        )
    for e in edges:
        frm = _truncate(e.get("from_label", e.get("from", "")), 40)
        to = _truncate(e.get("to_label", e.get("to", "")), 40)
        click.echo(f"      {frm} --{e.get('type', '')}--> {to}")
    if expandable_ids:
        click.echo("    (* = has further hops; pass its id + the new cursor to 'hop')")


@cli.command()
@click.argument("name")
@click.option("--json-output", "--json", "json_out", is_flag=True, help="JSON output")
def entity(name: str, json_out: bool):
    """Look up entity by name (substring match)."""
    data = _server_request("POST", "/entity", json={"name": name})
    results = data["results"]

    if not results:
        click.echo(f"No entities matching '{name}'")
        return

    if json_out:
        click.echo(json.dumps(results, ensure_ascii=False, indent=2))
        return

    click.echo(f"Found {len(results)} entities matching '{name}':\n")
    for r in results:
        click.echo(
            f"  {r['name']} ({r['type']}, {r['mentions']} mentions, degree={r['degree']})"
        )
        click.echo(f"    id: {r['id']}")
        click.echo(
            f"    seen: {_ts_to_str(r['first_seen'])} -> {_ts_to_str(r['last_seen'])}"
        )
        comms = r["communities"]
        click.echo(
            f"    communities: L0={comms['L0']} L1={comms['L1']} L2={comms['L2']} L3={comms['L3']}"
        )

        if r["edges_out"] or r["edges_in"]:
            click.echo("    edges:")
            for e in r["edges_out"][:3]:
                label = _truncate(e.get("target_label", ""), 40)
                click.echo(
                    f"      ->{e['type']} {e['target_type']}: {label}"
                )
                click.echo(f"        {e['target_type']}_id: {e['target_id']}")
            for e in r["edges_in"][:3]:
                conf = e["properties"].get(
                    "confidence", e["properties"].get("hybrid_score", "?")
                )
                label = _truncate(e.get("source_label", ""), 40)
                click.echo(
                    f"      <-SIMILAR_TO {e['source_type']}: {label} (conf={conf})"
                )
                click.echo(f"        {e['source_type']}_id: {e['source_id']}")

        facts = r.get("facts", [])
        if facts:
            click.echo("    facts:")
            for f in facts:
                click.echo(
                    f"      [{f['type']}] {_truncate(f['text'], 80)}"
                )
                click.echo(f"        fact_id: {f['id']}")
        click.echo()


@cli.command()
@click.argument("entity_id")
@click.option("--limit", "-n", type=int, default=20, help="Max facts to show")
@click.option("--json-output", "--json", "json_out", is_flag=True, help="JSON output")
def facts(entity_id: str, limit: int, json_out: bool):
    """List facts ABOUT an entity (id + text).

    Takes an entity id (from ``kl entity``) and returns the facts linked to it,
    each with a full fact id you can pass to ``kl context`` to see the source.
    """
    data = _server_request(
        "POST", "/facts", json={"entity_id": entity_id, "limit": limit}
    )

    if json_out:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return

    facts_list = data.get("facts", [])
    click.echo(
        f"Facts about {data['entity']} ({data['type']}) -- {len(facts_list)} facts:\n"
    )
    if not facts_list:
        click.echo("  (no facts linked to this entity)")
        return
    for f in facts_list:
        conf = f.get("confidence", 0.0)
        click.echo(
            f"  [{conf:.2f}] ({f['type']}) {f['text']}"
        )
        click.echo(f"    {_ts_to_str(f['timestamp'])} -- fact_id: {f['id']}")


@cli.command()
@click.argument("entity_id")
@click.option("--json-output", "--json", "json_out", is_flag=True, help="JSON output")
def expand(entity_id: str, json_out: bool):
    """Show SIMILAR_TO neighbors for entity disambiguation."""
    data = _server_request("POST", "/expand", json={"entity_id": entity_id})

    if json_out:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return

    click.echo(f"Entity: {data['entity']} ({data['type']})")
    click.echo(f"SIMILAR_TO neighbors ({len(data['neighbors'])}):\n")

    for n in data["neighbors"]:
        conf = n.get("confidence", "?")
        click.echo(f"  {n['name']} ({n['type']}) -- conf={conf}, source={n['source']}")
        click.echo(f"    id: {n['id']}")


@cli.command()
@click.option(
    "--level", "-l", type=click.Choice(["L0", "L1", "L2", "L3"]), default="L1"
)
@click.option(
    "--type", "-t", "node_type", type=click.Choice(["entity", "fact"]), default="entity"
)
@click.option(
    "--id",
    "community_id",
    type=int,
    default=None,
    help="Show specific community detail",
)
@click.option(
    "--top-k", "-k", type=int, default=20, help="Number of communities to show"
)
@click.option("--json-output", "--json", "json_out", is_flag=True, help="JSON output")
def community(
    level: str, node_type: str, community_id: Optional[int], top_k: int, json_out: bool
):
    """Browse communities with summaries."""
    data = _server_request(
        "POST",
        "/community",
        json={
            "level": level,
            "node_type": node_type,
            "community_id": community_id,
            "top_k": top_k,
        },
    )

    if json_out:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return

    if community_id is not None:
        if "error" in data:
            click.echo(data["error"])
            return
        click.echo(
            f"[{data['level']}] {data['node_type']} community {data['community_id']} ({data['member_count']} members)"
        )
        click.echo(f"  Summary: {data['summary']}")
        click.echo(f"  Tags: {', '.join(data['tags'])}")
        click.echo(
            f"  Top members: {', '.join(str(m)[:40] for m in data['top_members'][:10])}"
        )
    else:
        communities = data.get("communities", [])
        click.echo(f"[{level}] {node_type} communities (top {top_k} by size):\n")
        for c in communities:
            click.echo(
                f"  #{c['community_id']} ({c['member_count']} members): {_truncate(c['summary'], 80)}"
            )
            click.echo(f"    tags: {', '.join(c['tags'])}")


@cli.command()
@click.argument("community_id", type=int)
@click.option(
    "--level", "-l", type=click.Choice(["L0", "L1", "L2", "L3"]), default="L1"
)
@click.option(
    "--type", "-t", "node_type", type=click.Choice(["entity", "fact"]), default="entity"
)
@click.option("--limit", "-n", type=int, default=30, help="Max members to show")
@click.option("--json-output", "--json", "json_out", is_flag=True, help="JSON output")
def members(community_id: int, level: str, node_type: str, limit: int, json_out: bool):
    """List members of a community."""
    data = _server_request(
        "POST",
        "/members",
        json={
            "community_id": community_id,
            "level": level,
            "node_type": node_type,
            "limit": limit,
        },
    )

    members_list = data.get("members", [])

    if json_out:
        click.echo(json.dumps(members_list, ensure_ascii=False, indent=2))
        return

    if node_type == "entity":
        click.echo(
            f"[{level}] Entity community {community_id} -- {len(members_list)} members:\n"
        )
        for m in members_list:
            click.echo(
                f"  {m['name']} ({m['type']}, {m['mentions']} mentions) -- id:{m['id']}"
            )
    else:
        click.echo(
            f"[{level}] Fact community {community_id} -- {len(members_list)} members:\n"
        )
        for m in members_list:
            click.echo(f"  [{m['type']}] {_truncate(m['text'], 90)}")
            click.echo(f"    {_ts_to_str(m['timestamp'])} -- id:{m['id']}")


@cli.command()
@click.argument("fact_id")
@click.option("--json-output", "--json", "json_out", is_flag=True, help="JSON output")
def context(fact_id: str, json_out: bool):
    """Show source messages and entities for a fact."""
    data = _server_request("POST", "/context", json={"fact_id": fact_id})

    if json_out:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return

    fact = data["fact"]
    click.echo(f"Fact: {fact['text']}")
    click.echo(f"  Type: {fact['type']}, Confidence: {fact['confidence']:.2f}")
    click.echo(f"  Time: {_ts_to_str(fact['timestamp'])}")
    click.echo(f"  ID: {fact['id']}")

    msg = data.get("source_message")
    if msg:
        click.echo(f"\nSource message:")
        click.echo(
            f"  {msg['sender']} ({_ts_to_str(msg['timestamp'])}): {_truncate(msg['content'], 120)}"
        )
        click.echo(f"  conv: {msg['conversation_id']}")

        surrounding = data.get("surrounding", [])
        if len(surrounding) > 1:
            click.echo(f"\n  Surrounding context ({len(surrounding)} msgs +/-5min):")
            for s in surrounding:
                marker = " >> " if s["timestamp"] == msg["timestamp"] else "    "
                click.echo(f"  {marker}{s['sender']}: {_truncate(s['content'], 80)}")
    else:
        # Non-chat source (wiki/mail/minutes/...): show the generic chunk.
        chunk = data.get("source_chunk")
        if chunk:
            click.echo(f"\nSource ({chunk['source_type']}):")
            click.echo(
                f"  ({_ts_to_str(chunk['timestamp'])}): {_truncate(chunk['content'], 200)}"
            )
            if chunk.get("source_ref"):
                click.echo(f"  ref: {chunk['source_ref']}")

    entities = data.get("entities", [])
    if entities:
        click.echo(f"\nRelated entities:")
        for e in entities:
            click.echo(f"  {e['name']} ({e['type']}) -- id:{e['id']}")


@cli.command()
@click.argument("entity_name")
@click.option(
    "--from", "from_date", type=str, default=None, help="Start date (YYYY-MM-DD)"
)
@click.option("--to", "to_date", type=str, default=None, help="End date (YYYY-MM-DD)")
@click.option("--limit", "-n", type=int, default=30, help="Max facts to show")
@click.option("--json-output", "--json", "json_out", is_flag=True, help="JSON output")
def timeline(
    entity_name: str,
    from_date: Optional[str],
    to_date: Optional[str],
    limit: int,
    json_out: bool,
):
    """Show chronological facts for an entity."""
    data = _server_request(
        "POST",
        "/timeline",
        json={
            "entity_name": entity_name,
            "from_date": from_date,
            "to_date": to_date,
            "limit": limit,
        },
    )

    if json_out:
        click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        return

    facts = data["facts"]
    entity = data["entity"]
    degree = data.get("degree", 0)
    auto_filtered = data.get("auto_filtered", False)

    header = f"Timeline for: {entity} ({len(facts)} facts, degree={degree})"
    if auto_filtered:
        header += " [auto-filtered to last 90 days]"
    click.echo(header + "\n")

    last_date = ""
    for f in facts:
        date_str = _ts_to_str(f["timestamp"])
        day = date_str[:10] if date_str else ""
        if day != last_date:
            click.echo(f"\n  --- {day} ---")
            last_date = day
        time_part = date_str[11:] if len(date_str) > 11 else ""
        click.echo(f"  {time_part} [{f['type']}] {_truncate(f['text'], 90)}")
        click.echo(f"         id:{f['id']}")


# ── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cli()
