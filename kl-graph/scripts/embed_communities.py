#!/usr/bin/env python3
"""Embed community summaries into the configured vector store.

Reads all community_summaries from SQLite, embeds them via vLLM,
and upserts into the ``communities`` collection.

Usage:
    python scripts/embed_communities.py
"""  # noqa: EXE001

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# Parse --config/-c early so load_config() runs before other kl_graph imports
_pre_parser = argparse.ArgumentParser(add_help=False)
_pre_parser.add_argument("-c", "--config", metavar="PATH", default=None)
_pre_args, _ = _pre_parser.parse_known_args()
if _pre_args.config:
    from kl_graph.config import load_config
    load_config(_pre_args.config)

from kl_graph.config import DATA_DIR, cfg
from kl_graph.ingest.embedder import Embedder
from kl_graph.storage.sqlite_store import SQLiteStore
from kl_graph.storage.vector_store import (
    VectorPoint,
    create_vector_store,
    vector_store_path,
)

# Derived paths / constants from OmegaConf config
SQLITE_PATH = DATA_DIR / "knowledge.db"
EMBEDDING_DIM = int(cfg.services.embedding.dim)


def main():
    if not bool(cfg.pipelines.experimental.communities.enabled):
        raise SystemExit(
            "Community features are experimental and disabled; set "
            "KL_COMMUNITIES_ENABLED=1 to embed them."
        )

    t0 = time.time()
    print("=== Embedding Community Summaries ===\n")

    # Load summaries from SQLite (current schema: no node_type column)
    sqlite = SQLiteStore(SQLITE_PATH)
    rows = sqlite.conn.execute("""
        SELECT level, community_id, member_count, title, summary, tags, top_members
        FROM community_summaries
        WHERE summary != ''
        ORDER BY level, community_id
    """).fetchall()
    sqlite.close()

    print(f"  Communities to embed: {len(rows)}")

    # Prepare texts for embedding: title + summary + tags
    texts = []
    metadata = []
    for row in rows:
        level, community_id, member_count, title, summary, tags_json, top_members_json = row
        tags = json.loads(tags_json)

        # Embed: title + summary + tags for semantic matching
        embed_text = f"{title} {summary} {' '.join(tags)}"
        texts.append(embed_text)
        metadata.append({
            "level": level,
            "community_id": community_id,
            "member_count": member_count,
            "title": title,
            "summary": summary,
            "tags": tags_json,
            "top_members": top_members_json,
        })

    # Embed all
    print(f"  Embedding {len(texts)} summaries...")
    emb_cfg = cfg.pipelines.ingestion.embedding
    embedder = Embedder(
        batch_size=emb_cfg.batch_size,
        concurrency=emb_cfg.concurrency,
        max_retries=emb_cfg.max_retries,
        timeout=emb_cfg.timeout,
    )
    vectors = embedder.embed_batch_with_progress(texts, desc="communities")

    # Build points
    points = []
    for vec, meta in zip(vectors, metadata):
        stable_id = f"community:{meta['level']}:{meta['community_id']}"
        points.append(VectorPoint(id=stable_id, vector=vec, payload=meta))

    # Keep communities in a separate lightweight vector-store namespace.
    backend = str(cfg.storage.vector.backend)
    community_path = vector_store_path(backend, DATA_DIR, namespace="communities")
    print(f"  Upserting {len(points)} vectors to {community_path}...")
    store = create_vector_store(
        backend,
        data_dir=DATA_DIR,
        embedding_dim=EMBEDDING_DIM,
        namespace="communities",
        collections=["communities"],
    )
    try:
        previous_ids = {point.id for point in store.scroll_all("communities")}
        store.upsert("communities", points)
        current_ids = {point.id for point in points}
        store.delete("communities", list(previous_ids - current_ids))
        n = store.count("communities")
    finally:
        store.close()

    elapsed = time.time() - t0
    print(f"\n  Done: {n} community vectors in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
