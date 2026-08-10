"""GraphRAG-style local search: assemble seed-aware context for /ask synthesis.

Pure, store-API-only module — no FastAPI, no asyncio, no LLM calls.
Works for both the server (via asyncio.to_thread) and standalone scripts.

Core contract: given the recall outputs already produced by Phase 1,
build a richer local context (relationships, community reports, text units)
and return it alongside token accounting so the caller can feed it into
synthesis or display it directly.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from kl_graph.ingest.chunker import num_tokens_from_string

logger = logging.getLogger(__name__)

# ── Budget constants ─────────────────────────────────────────────────────────

# Total token budget for the assembled local context (Chinese-adjusted).
MAX_CONTEXT_TOKENS: int = 16_000

# Proportion of budget allocated to community summaries (0-1).
COMMUNITY_PROP: float = 0.15

# Proportion of budget allocated to text-unit (chunk) content (0-1).
TEXT_UNIT_PROP: float = 0.50

# Remaining proportion implicitly goes to relationship context / tables (~0.35).

# Maximum seed entities selected from recall.
TOP_K_ENTITIES: int = 10

# Maximum relationships returned per seed entity.
TOP_K_RELATIONSHIPS: int = 10

# Edge types considered "in-network" for seeding relationships.
IN_NETWORK_EDGE_TYPES: tuple[str, ...] = (
    "ABOUT",
    "MENTIONS",
    "AUTHORED_BY",
    "STATES",
)

# Edge types considered walkable for one-hop external links.
ALL_WALKABLE_TYPES: tuple[str, ...] = IN_NETWORK_EDGE_TYPES + (
    "ENTITY_SIMILAR",
    "FACT_SIMILAR",
    "ENTAILS",
    "CONTRADICTS",
    "COMM_MEMBER",
    "TEMPORAL",
)

# ── Data types ────────────────────────────────────────────────────────────────


@dataclass
class CommunityContextItem:
    """One community report included in the local context."""

    community_id: int
    level: int
    title: str
    summary: str
    rating: float
    tags: list[str]
    matched_seeds: list[str]  # seed ids that belong to this community
    member_count: int = 0
    rating_explanation: str = ""

    def to_dict(self) -> dict:
        return {
            "community_id": self.community_id,
            "level": self.level,
            "title": self.title,
            "summary": self.summary,
            "rating": self.rating,
            "tags": self.tags,
            "matched_seeds": self.matched_seeds,
            "member_count": self.member_count,
            "rating_explanation": self.rating_explanation,
        }


@dataclass
class RelationshipItem:
    """One relationship edge in the local context."""

    source_id: str
    target_id: str
    source_type: str
    target_type: str
    edge_type: str
    score: float
    label: str = ""

    def to_dict(self) -> dict:
        return {
            "source_id": self.source_id,
            "target_id": self.target_id,
            "source_type": self.source_type,
            "target_type": self.target_type,
            "edge_type": self.edge_type,
            "score": self.score,
            "label": self.label,
        }


@dataclass
class ChunkContextItem:
    """One recalled chunk included in the local context."""

    chunk_id: str
    content: str
    source_type: str
    seed_match_count: int  # how many seed entities mention/state this chunk
    recall_score: float
    timestamp: int = 0

    def to_dict(self) -> dict:
        return {
            "chunk_id": self.chunk_id,
            "content": self.content,
            "source_type": self.source_type,
            "seed_match_count": self.seed_match_count,
            "recall_score": self.recall_score,
            "timestamp": self.timestamp,
        }


@dataclass
class LocalContext:
    """Assembled local context from recall outputs."""

    # Community summaries ranked by seed-match count, then rating.
    community_context: list[CommunityContextItem] = field(default_factory=list)

    # Relationship edges (in-network first, then one-hop ranked).
    relationships: list[RelationshipItem] = field(default_factory=list)

    # Text units (chunks) ranked by seed connectivity then recall score.
    text_units: list[ChunkContextItem] = field(default_factory=list)

    # Seed entity ids used for this context.
    seed_ids: list[str] = field(default_factory=list)

    # Token accounting.
    total_tokens: int = 0
    community_tokens: int = 0
    relationship_tokens: int = 0
    text_unit_tokens: int = 0

    # Assembled context text (fed to Phase-2 synthesis).
    context_text: str = ""

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict for /ask response field."""
        return {
            "community_context": [c.to_dict() for c in self.community_context],
            "relationships": [r.to_dict() for r in self.relationships],
            "text_units": [t.to_dict() for t in self.text_units],
            "seed_ids": self.seed_ids,
            "token_counts": {
                "total": self.total_tokens,
                "community": self.community_tokens,
                "relationships": self.relationship_tokens,
                "text_units": self.text_unit_tokens,
            },
        }


# ── Helper: _extract_community_assignments ─────────────────────────────────────


def _enumerate_community_levels(store: object) -> list[int]:
    """Dynamically discover which community_L{i} columns exist.

    Uses the same logic as enumerate_community_level_columns from
    community_summarizer, but implemented inline to keep this module
    store-API-only without depending on the periodic package.
    """
    cols: set[int] = set()
    for table in ("entities", "facts"):
        try:
            rows = store.sql_conn.execute(
                f"PRAGMA table_info({table})"
            ).fetchall()
            for row in rows:
                col_name = row[1]
                if col_name.startswith("community_L"):
                    try:
                        level = int(col_name[len("community_L"):])
                        cols.add(level)
                    except ValueError:
                        pass
        except Exception:  # noqa: BLE001
            pass
    return sorted(cols)


# ── Helper: _edge_score ───────────────────────────────────────────────────────


def _edge_score(props: dict) -> float:
    """Extract a numeric relevance score from edge properties.

    Priority: hybrid_score (ENTITY_SIMILAR) > score (FACT_SIMILAR) >
    confidence (ABOUT / MENTIONS) > 0.5 default.
    """
    return (
        props.get("hybrid_score")
        or props.get("score")
        or props.get("confidence")
        or 0.5
    )


# ── Seed selection ────────────────────────────────────────────────────────────


def _select_seeds(
    store: object,
    matched_entities: list[dict],
    chunk_hits: list[dict],
    fact_hits: list[dict],
    top_k: int = TOP_K_ENTITIES,
) -> list[dict]:
    """Select seed entities from recall outputs.

    1. Take the top-K matched entities (by similarity score).
    2. If under K, extend with entities discovered behind dense chunk
       and fact hits (via MENTIONS / ABOUT edges through the store API).

    Args:
        store: KnowledgeStore (backend-agnostic; store-API only).
        matched_entities: [{id, name, type, sim}, ...] from Phase-1 recall.
        chunk_hits: Raw Qdrant ANN hits for chunks collection.
        fact_hits: Raw Qdrant ANN hits for facts collection.
        top_k: Maximum seeds to return.

    Returns:
        List of entity dicts, deduped by id, keeping the best sim.
    """
    seed_best: dict[str, dict] = {}

    def bump(ent: dict) -> None:
        eid = ent["id"]
        sim = ent.get("sim", 0.0)
        if eid not in seed_best or sim > seed_best[eid].get("sim", 0.0):
            seed_best[eid] = ent

    # (a) Directly matched entities
    for ent in matched_entities:
        bump(ent)

    # (b) If under K, extend with entities from fact hits.
    # Facts are ABOUT entities — follow ABOUT edges to find them.
    if len(seed_best) < top_k:
        for hit in fact_hits[:top_k * 2]:
            payload = hit.get("payload", {})
            fid = payload.get("fact_id")
            if not fid:
                continue
            try:
                # ABOUT edges: fact -> entity
                neighbors = store.get_neighbors(
                    "fact", fid, edge_type="ABOUT", direction="outgoing"
                )
                for row in neighbors:
                    tgt_id = row.get("target_id", "")
                    if tgt_id and tgt_id not in seed_best:
                        bump({
                            "id": tgt_id,
                            "name": row.get("target_name", ""),
                            "type": row.get("target_type", ""),
                            "sim": hit.get("score", 0.0) * 0.8,
                        })
            except Exception:  # noqa: BLE001
                pass
            if len(seed_best) >= top_k:
                break

    # (c) If still under K, extend with entities behind chunk hits.
    # Chunks MENTION entities — follow MENTIONS edges to find them.
    if len(seed_best) < top_k:
        for hit in chunk_hits[:top_k * 2]:
            payload = hit.get("payload", {})
            cid = payload.get("chunk_id")
            if not cid:
                continue
            try:
                # MENTIONS edges: chunk -> entity
                neighbors = store.get_neighbors(
                    "chunk", cid, edge_type="MENTIONS", direction="outgoing"
                )
                for row in neighbors:
                    tgt_id = row.get("target_id", "")
                    if tgt_id and tgt_id not in seed_best:
                        bump({
                            "id": tgt_id,
                            "name": row.get("target_name", ""),
                            "type": row.get("target_type", ""),
                            "sim": hit.get("score", 0.0) * 0.7,
                        })
            except Exception:  # noqa: BLE001
                pass
            if len(seed_best) >= top_k:
                break

    # Sort by similarity and cap.
    seeds = sorted(seed_best.values(), key=lambda e: e.get("sim", 0.0), reverse=True)
    return seeds[:top_k]


# ── Relationship context ─────────────────────────────────────────────────────


def _gather_relationships(
    store: object,
    seeds: list[dict],
    top_k_per_seed: int = TOP_K_RELATIONSHIPS,
) -> list[RelationshipItem]:
    """Gather relationship context for seed entities via the store API.

    Two-pass strategy (GraphRAG parity):
    1. In-network edges: ABOUT/MENTIONS/AUTHORED_BY/STATES among seeds.
    2. One-hop external edges: all walkable types, ranked by stored
       edge score (hybrid_score / score / confidence) then degree.

    Args:
        store: KnowledgeStore (SQLite or ladybug).
        seeds: Selected seed entity dicts.
        top_k_per_seed: Max relationships per seed.

    Returns:
        Ordered list of RelationshipItem.
    """
    seed_ids = {s["id"] for s in seeds}
    relationships: list[RelationshipItem] = []
    seen_edges: set[tuple[str, str, str]] = set()

    # Helper to deduplicate edges
    def _edge_key(src: str, tgt: str, etype: str) -> tuple[str, str, str]:
        return (min(src, tgt), max(src, tgt), etype)

    # Helper to create RelationshipItem
    def _make_item(
        src_id: str, tgt_id: str, src_type: str, tgt_type: str,
        etype: str, props: dict, label: str = "",
    ) -> RelationshipItem:
        return RelationshipItem(
            source_id=src_id,
            target_id=tgt_id,
            source_type=src_type,
            target_type=tgt_type,
            edge_type=etype,
            score=_edge_score(props),
            label=label,
        )

    # Pass 1: In-network edges among seeds
    for etype in IN_NETWORK_EDGE_TYPES:
        try:
            for src_id, tgt_id, props in store.scan_edges_by_type(
                [etype], source_type="entity", target_type="entity"
            ):
                if src_id in seed_ids and tgt_id in seed_ids:
                    key = _edge_key(src_id, tgt_id, etype)
                    if key not in seen_edges:
                        seen_edges.add(key)
                        relationships.append(
                            _make_item(src_id, tgt_id, "entity", "entity", etype, props)
                        )
        except Exception:  # noqa: BLE001
            pass

    # For fact-entity ABOUT edges among seeds
    try:
        for src_id, tgt_id, props in store.scan_edges_by_type(
            ["ABOUT"], source_type="fact", target_type="entity"
        ):
            # A fact is a seed if any seed entity is about it
            # (We treat seed entities as the seeds; facts connected to them
            # are one-hop.)
            if tgt_id in seed_ids:
                key = _edge_key(src_id, tgt_id, "ABOUT")
                if key not in seen_edges:
                    seen_edges.add(key)
                    relationships.append(
                        _make_item(src_id, tgt_id, "fact", "entity", "ABOUT", props)
                    )
    except Exception:  # noqa: BLE001
        pass

    # Pass 2: One-hop external edges from each seed.
    # Gather ALL candidates first (no per-seed early cap).
    external: list[RelationshipItem] = []
    external_other_ids: set[str] = set()  # track for degree lookup
    for seed in seeds:
        try:
            neighbors = store.get_neighbors(
                "entity", seed["id"], direction="both"
            )
            for row in neighbors:
                src_id = row.get("source_id", "")
                tgt_id = row.get("target_id", "")
                src_type = row.get("source_type", "")
                tgt_type = row.get("target_type", "")
                etype = row.get("edge_type", "")

                # Determine the "other" endpoint
                if src_id == seed["id"]:
                    other_id = tgt_id
                    other_type = tgt_type
                else:
                    other_id = src_id
                    other_type = src_type

                # Skip if other endpoint is also a seed (already covered)
                if other_id in seed_ids:
                    continue

                # Only include walkable edge types
                if etype not in ALL_WALKABLE_TYPES:
                    continue

                key = _edge_key(seed["id"], other_id, etype)
                if key in seen_edges:
                    continue
                seen_edges.add(key)

                props = {}
                raw_props = row.get("properties", "{}")
                if isinstance(raw_props, str):
                    try:
                        props = json.loads(raw_props) if raw_props else {}
                    except (json.JSONDecodeError, TypeError):
                        props = {}
                elif isinstance(raw_props, dict):
                    props = raw_props

                label = ""
                try:
                    if other_type == "entity":
                        erow = store.sql_conn.execute(
                            "SELECT name FROM entities WHERE id = ?",
                            (other_id,),
                        ).fetchone()
                        if erow:
                            label = erow[0]
                    elif other_type == "fact":
                        frow = store.sql_conn.execute(
                            "SELECT text FROM facts WHERE id = ?",
                            (other_id,),
                        ).fetchone()
                        if frow:
                            label = frow[0][:80]
                except Exception:  # noqa: BLE001
                    pass

                external.append(
                    _make_item(
                        seed["id"], other_id,
                        "entity", other_type, etype, props, label,
                    )
                )
                external_other_ids.add(other_id)
        except Exception:  # noqa: BLE001
            pass

    # Compute degree for tie-break (number of neighbors for each external node)
    degree_cache: dict[str, int] = {}
    for nid in external_other_ids:
        try:
            nbrs = store.get_neighbors("entity", nid, direction="both")
            degree_cache[nid] = len(nbrs)
        except Exception:  # noqa: BLE001
            degree_cache[nid] = 0

    # Combine in-network + external candidates and rank globally.
    # In-network items have no degree (they're among seeds), so use 0.
    all_candidates = relationships + external
    all_candidates.sort(
        key=lambda r: (-r.score, -degree_cache.get(r.target_id, 0))
    )

    # Apply overall cap once: top_k_relationships × |seeds| (GraphRAG policy)
    overall_cap = top_k_per_seed * max(len(seeds), 1)
    return all_candidates[:overall_cap]


# ── Community context ────────────────────────────────────────────────────────


def _gather_community_context(
    store: object,
    seeds: list[dict],
    max_tokens: int,
) -> list[CommunityContextItem]:
    """Gather community report summaries for seed entities.

    For each seed entity, reads its community_L{i} columns (dynamically
    enumerated), collects unique (level, community_id) pairs, fetches
    summaries via get_community_summary, ranks by (seed-match count,
    report rating), and token-packs within the budget.

    [!RED] Degrades gracefully to empty list when community_summaries
    table is empty or doesn't exist — never errors, never bills LLM.

    Args:
        store: KnowledgeStore.
        seeds: Selected seed entity dicts.
        max_tokens: Token budget for community context.

    Returns:
        Ranked list of CommunityContextItem.
    """
    if not seeds:
        return []

    # Dynamically discover community level columns
    levels = _enumerate_community_levels(store)
    if not levels:
        return []

    # Collect community assignments from seed entities
    # {community_id: {level: [seed_ids]}}
    community_seeds: dict[tuple[int, int], list[str]] = {}  # (level, cid) -> [seed_ids]

    for seed in seeds:
        eid = seed["id"]
        for level in levels:
            col = f"community_L{level}"
            try:
                row = store.sql_conn.execute(
                    f"SELECT {col} FROM entities WHERE id = ?", (eid,)
                ).fetchone()
                if row and row[0] is not None:
                    cid = int(row[0])
                    community_seeds.setdefault((level, cid), []).append(eid)
            except Exception:  # noqa: BLE001
                pass

    if not community_seeds:
        return []

    # Fetch summaries and rank by (match_count, rating)
    items: list[CommunityContextItem] = []
    for (level, cid), seed_list in community_seeds.items():
        try:
            summary = store.get_community_summary(level, cid)
        except Exception:  # noqa: BLE001
            summary = None

        if summary is None:
            continue

        summary_tags = summary.get("tags", [])
        if isinstance(summary_tags, str):
            try:
                summary_tags = json.loads(summary_tags)
            except (json.JSONDecodeError, TypeError):
                summary_tags = []

        items.append(
            CommunityContextItem(
                community_id=cid,
                level=level,
                title=summary.get("title", ""),
                summary=summary.get("summary", ""),
                rating=summary.get("rating", 0.0),
                tags=list(summary_tags),
                matched_seeds=seed_list,
                member_count=summary.get("member_count", 0),
                rating_explanation=summary.get("rating_explanation", ""),
            )
        )

    # Rank by (match count desc, rating desc)
    items.sort(key=lambda c: (len(c.matched_seeds), c.rating), reverse=True)

    # Token-pack within budget (whole items only — never mid-content slice)
    packed: list[CommunityContextItem] = []
    used_tokens = 0
    for item in items:
        # Estimate tokens for this item's rendered text
        text = _render_community_item(item)
        tokens = num_tokens_from_string(text)
        if used_tokens + tokens > max_tokens:
            break
        packed.append(item)
        used_tokens += tokens

    return packed


def _render_community_item(item: CommunityContextItem) -> str:
    """Render a community context item to text for token counting."""
    parts = [
        f"[L{item.level}] {item.title} (rating: {item.rating:.1f})",
        item.summary,
    ]
    if item.tags:
        parts.append(f"tags: {', '.join(item.tags)}")
    if item.matched_seeds:
        parts.append(f"matched seeds: {len(item.matched_seeds)}")
    return "\n".join(parts)


# ── Text-unit context ────────────────────────────────────────────────────────


def _gather_text_units(
    store: object,
    seeds: list[dict],
    chunk_hits: list[dict],
    max_tokens: int,
) -> list[ChunkContextItem]:
    """Gather recalled chunks ranked by seed connectivity.

    Chunks are ranked by (seed_match_count desc, recall_score desc),
    then token-packed within budget (whole items only).

    Args:
        store: KnowledgeStore.
        seeds: Selected seed entity dicts.
        chunk_hits: Raw Qdrant ANN hits for chunks.
        max_tokens: Token budget for text units.

    Returns:
        Ranked list of ChunkContextItem.
    """
    if not seeds or not chunk_hits:
        return []

    seed_ids = {s["id"] for s in seeds}

    # Map chunk_id -> its recall score from chunk_hits
    chunk_scores: dict[str, float] = {}
    chunk_payloads: dict[str, dict] = {}
    for hit in chunk_hits:
        payload = hit.get("payload", {})
        cid = payload.get("chunk_id")
        if cid:
            chunk_scores[cid] = hit.get("score", 0.0)
            chunk_payloads[cid] = payload

    # For each chunk, count how many seed entities it MENTIONS or STATES
    # (via the edges table: MENTIONS = chunk→entity, STATES = fact→chunk)
    chunk_seed_counts: dict[str, int] = {}
    chunk_content: dict[str, str] = {}
    chunk_source_types: dict[str, str] = {}
    chunk_timestamps: dict[str, int] = {}

    for cid in chunk_scores:
        count = 0
        try:
            # MENTIONS: chunk → entity (via store API)
            neighbors = store.get_neighbors(
                "chunk", cid, edge_type="MENTIONS", direction="outgoing"
            )
            for row in neighbors:
                eid = row.get("target_id", "")
                if eid in seed_ids:
                    count += 1

            # Also check about edges from facts that are about seeds
            # (STATES: fact → chunk, then ABOUT: fact → entity)
            fact_neighbors = store.get_neighbors(
                "chunk", cid, edge_type="STATES", direction="incoming"
            )
            for frow in fact_neighbors:
                fid = frow.get("source_id", "")
                if not fid:
                    continue
                about_neighbors = store.get_neighbors(
                    "fact", fid, edge_type="ABOUT", direction="outgoing"
                )
                for arow in about_neighbors:
                    eid = arow.get("target_id", "")
                    if eid in seed_ids:
                        count += 1
        except Exception:  # noqa: BLE001
            pass

        chunk_seed_counts[cid] = count

        # Get chunk content from payload or store
        payload = chunk_payloads.get(cid, {})
        content = payload.get("content", "")
        if not content:
            try:
                row = store.sql_conn.execute(
                    "SELECT content, source_type, timestamp FROM chunks WHERE id = ?",
                    (cid,),
                ).fetchone()
                if row:
                    content = row[0] or ""
                    chunk_source_types[cid] = row[1] or "unknown"
                    chunk_timestamps[cid] = int(row[2] or 0)
                else:
                    chunk_source_types[cid] = payload.get("source_type", "unknown")
                    chunk_timestamps[cid] = int(payload.get("timestamp", 0))
            except Exception:  # noqa: BLE001
                chunk_source_types[cid] = payload.get("source_type", "unknown")
                chunk_timestamps[cid] = int(payload.get("timestamp", 0))
        else:
            chunk_source_types[cid] = payload.get("source_type", "unknown")
            chunk_timestamps[cid] = int(payload.get("timestamp", 0))

        chunk_content[cid] = content

    # Rank by (seed_match_count desc, recall_score desc)
    ranked_cids = sorted(
        chunk_scores.keys(),
        key=lambda c: (chunk_seed_counts.get(c, 0), chunk_scores[c]),
        reverse=True,
    )

    # Token-pack within budget (whole items only)
    packed: list[ChunkContextItem] = []
    used_tokens = 0
    for cid in ranked_cids:
        content = chunk_content.get(cid, "")
        tokens = num_tokens_from_string(content) if content else 1
        if used_tokens + tokens > max_tokens:
            break
        packed.append(
            ChunkContextItem(
                chunk_id=cid,
                content=content,
                source_type=chunk_source_types.get(cid, "unknown"),
                seed_match_count=chunk_seed_counts.get(cid, 0),
                recall_score=chunk_scores[cid],
                timestamp=chunk_timestamps.get(cid, 0),
            )
        )
        used_tokens += tokens

    return packed


# ── Context text assembly ───────────────────────────────────────────────────


def _assemble_context_text(
    community_context: list[CommunityContextItem],
    relationships: list[RelationshipItem],
    text_units: list[ChunkContextItem],
    max_context_tokens: int,
) -> tuple[str, int, int, int]:
    """Assemble the final context text for Phase-2 synthesis.

    All tokens are measured via ``num_tokens_from_string`` — including
    section headers and entry wrappers — so the returned token counts
    faithfully represent the actual assembled text. Items are added in
    priority order (community → relationships → text units) and the
    function stops adding items as soon as ``max_context_tokens`` is
    reached, guaranteeing the total never exceeds the budget.

    Returns (context_text, community_tokens, relationship_tokens, text_unit_tokens).
    """
    parts: list[str] = []
    comm_tokens = 0
    rel_tokens = 0
    tu_tokens = 0
    total_used = 0  # running total across all sections

    def _budget_remaining() -> int:
        return max_context_tokens - total_used

    # Community reports
    if community_context:
        header = "=== 社区报告 ==="
        header_tokens = num_tokens_from_string(header)
        if header_tokens <= _budget_remaining():
            parts.append(header)
            total_used += header_tokens
            comm_tokens += header_tokens
        for item in community_context:
            entry = (
                f"[L{item.level}] {item.title} (评分: {item.rating:.1f})\n"
                f"{item.summary}"
            )
            if item.tags:
                entry += f"\n标签: {', '.join(item.tags)}"
            if item.matched_seeds:
                entry += f"\n匹配种子数: {len(item.matched_seeds)}"
            entry_tokens = num_tokens_from_string(entry)
            if total_used + entry_tokens > max_context_tokens:
                break
            parts.append(entry)
            comm_tokens += entry_tokens
            total_used += entry_tokens

    # Relationships (packed within budget)
    if relationships:
        header = "\n=== 关联关系 ==="
        header_tokens = num_tokens_from_string(header)
        if total_used + header_tokens <= max_context_tokens:
            parts.append(header)
            total_used += header_tokens
            rel_tokens += header_tokens
        for rel in relationships:
            entry = (
                f"{rel.source_id} --{rel.edge_type}--> "
                f"{rel.target_id}"
                + (f" ({rel.label})" if rel.label else "")
            )
            entry_tokens = num_tokens_from_string(entry)
            if total_used + entry_tokens > max_context_tokens:
                break
            parts.append(entry)
            rel_tokens += entry_tokens
            total_used += entry_tokens

    # Text units (chunks)
    if text_units:
        header = "\n=== 相关消息 ==="
        header_tokens = num_tokens_from_string(header)
        if total_used + header_tokens <= max_context_tokens:
            parts.append(header)
            total_used += header_tokens
            tu_tokens += header_tokens
        for tu in text_units:
            ts_str = ""
            if tu.timestamp:
                try:
                    from datetime import datetime
                    ts_str = datetime.fromtimestamp(
                        tu.timestamp / 1000  # noqa: DTZ003
                    ).strftime("%m-%d %H:%M")
                except Exception:  # noqa: BLE001
                    pass
            entry = f"[{ts_str or '?'}] [{tu.source_type}] {tu.content}"
            entry_tokens = num_tokens_from_string(entry)
            if total_used + entry_tokens > max_context_tokens:
                break
            parts.append(entry)
            tu_tokens += entry_tokens
            total_used += entry_tokens

    context_text = "\n".join(parts)
    return context_text, comm_tokens, rel_tokens, tu_tokens


# ── Main entry point ─────────────────────────────────────────────────────────


def build_local_context(
    store: object,
    matched_entities: list[dict],
    chunk_hits: list[dict],
    fact_hits: list[dict],
    *,
    max_context_tokens: int = MAX_CONTEXT_TOKENS,
    community_prop: float = COMMUNITY_PROP,
    text_unit_prop: float = TEXT_UNIT_PROP,
    top_k_entities: int = TOP_K_ENTITIES,
    top_k_relationships: int = TOP_K_RELATIONSHIPS,
    communities_enabled: bool = True,
) -> LocalContext:
    """Build GraphRAG-style local context from recall outputs.

    Pure function: given the recall results from Phase 1, assembles a
    richer local context including community reports, relationships,
    and text units. No LLM calls, no embedding calls.

    Args:
        store: KnowledgeStore (SQLite or ladybug — store-API only).
        matched_entities: [{id, name, type, sim}, ...] from Phase-1 recall.
        chunk_hits: Raw Qdrant ANN hits for chunks collection.
        fact_hits: Raw Qdrant ANN hits for facts collection.
        max_context_tokens: Total token budget.
        community_prop: Proportion for community summaries.
        text_unit_prop: Proportion for text units.
        top_k_entities: Max seed entities.
        top_k_relationships: Max relationships per seed.

    Returns:
        LocalContext with community_context, relationships, text_units,
        and assembled context_text.
    """
    budgets = {
        "community": (
            int(max_context_tokens * community_prop) if communities_enabled else 0
        ),
        "text_units": int(max_context_tokens * text_unit_prop),
        # Relationships get the remainder implicitly
    }

    # Step 1: Seed selection
    seeds = _select_seeds(store, matched_entities, chunk_hits, fact_hits, top_k_entities)
    seed_ids = [s["id"] for s in seeds]

    # Step 2: Community context (handles empty summaries gracefully)
    community_context = []
    if communities_enabled:
        try:
            community_context = _gather_community_context(
                store, seeds, budgets["community"]
            )
        except Exception as e:  # noqa: BLE001
            logger.debug(f"Community context gathering failed: {e}")

    # Step 3: Relationship context
    try:
        relationships = _gather_relationships(store, seeds, top_k_relationships)
        if not communities_enabled:
            relationships = [
                rel for rel in relationships if rel.edge_type != "COMM_MEMBER"
            ]
    except Exception as e:  # noqa: BLE001
        logger.debug(f"Relationship gathering failed: {e}")
        relationships = []

    # Step 4: Text-unit context
    try:
        text_units = _gather_text_units(
            store, seeds, chunk_hits, budgets["text_units"]
        )
    except Exception as e:  # noqa: BLE001
        logger.debug(f"Text unit gathering failed: {e}")
        text_units = []

    # Step 5: Assemble context text (with global token budget enforcement)
    context_text, comm_tokens, rel_tokens, tu_tokens = _assemble_context_text(
        community_context, relationships, text_units, max_context_tokens
    )

    return LocalContext(
        community_context=community_context,
        relationships=relationships,
        text_units=text_units,
        seed_ids=seed_ids,
        total_tokens=comm_tokens + rel_tokens + tu_tokens,
        community_tokens=comm_tokens,
        relationship_tokens=rel_tokens,
        text_unit_tokens=tu_tokens,
        context_text=context_text,
    )
