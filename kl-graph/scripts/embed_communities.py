#!/usr/bin/env python3
"""Embed community summaries into Qdrant for vector search.

Reads all community_summaries from SQLite, embeds them via vLLM,
and upserts into the 'communities' Qdrant collection.

Usage:
    python scripts/embed_communities.py
"""  # noqa: EXE001

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# Parse --config/-c early so load_config() runs before other kl_graph imports
_pre_parser = argparse.ArgumentParser(add_help=False)
_pre_parser.add_argument("-c", "--config", metavar="PATH", default=None)
_pre_args, _ = _pre_parser.parse_known_args()
if _pre_args.config:
    from kl_graph.config import load_config
    load_config(_pre_args.config)

from qdrant_client.models import PointStruct

from kl_graph.config import cfg, DATA_DIR
from kl_graph.ingest.embedder import Embedder
from kl_graph.storage.sqlite_store import SQLiteStore

# Derived paths / constants from OmegaConf config
SQLITE_PATH = DATA_DIR / "knowledge.db"
QDRANT_PATH = str(DATA_DIR / "qdrant_data")
EMBEDDING_DIM = int(cfg.services.embedding.dim)


def main():
    t0 = time.time()
    print("=== Embedding Community Summaries ===\n")

    # Load summaries from SQLite
    sqlite = SQLiteStore(SQLITE_PATH)
    rows = sqlite.conn.execute("""
        SELECT level, community_id, node_type, member_count, summary, tags, top_members
        FROM community_summaries
        WHERE summary != ''
        ORDER BY level, node_type, community_id
    """).fetchall()
    sqlite.close()

    print(f"  Communities to embed: {len(rows)}")

    # Prepare texts for embedding: summary + tags
    texts = []
    metadata = []
    for row in rows:
        level, community_id, node_type, member_count, summary, tags_json, top_members_json = row
        tags = json.loads(tags_json)

        # Embed: summary + tags for semantic matching
        embed_text = f"{summary} {' '.join(tags)}"
        texts.append(embed_text)
        metadata.append({
            "level": level,
            "community_id": community_id,
            "node_type": node_type,
            "member_count": member_count,
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
    for i, (vec, meta) in enumerate(zip(vectors, metadata)):
        # Deterministic ID from level + node_type + community_id
        point_id = str(uuid.uuid5(
            uuid.NAMESPACE_DNS,
            f"community:{meta['level']}:{meta['node_type']}:{meta['community_id']}"
        ))
        points.append(PointStruct(
            id=point_id,
            vector=vec,
            payload=meta,
        ))

    # Upsert into Qdrant — use a SEPARATE small Qdrant path for communities only.
    # This avoids the cold-start penalty of mmap-ing the 300MB main store.
    COMMUNITY_QDRANT_PATH = str(Path(QDRANT_PATH).parent / "qdrant_communities")
    print(f"  Upserting {len(points)} vectors to {COMMUNITY_QDRANT_PATH}...")

    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams

    client = QdrantClient(path=COMMUNITY_QDRANT_PATH)

    # Recreate collection (small store, fast)
    existing = {c.name for c in client.get_collections().collections}
    if "communities" in existing:
        client.delete_collection("communities")
    client.create_collection(
        collection_name="communities",
        vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
    )
    print("  Created 'communities' collection")

    # Upsert in batches of 256
    batch_size = 256
    for i in range(0, len(points), batch_size):
        batch = points[i:i + batch_size]
        client.upsert(collection_name="communities", points=batch)
        print(f"  Upserted {min(i + batch_size, len(points))}/{len(points)}")

    n = client.get_collection("communities").points_count
    client.close()

    elapsed = time.time() - t0
    print(f"\n  Done: {n} community vectors in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
