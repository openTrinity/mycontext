"""LLM-based community summarization.

Generates short summaries for each community at each resolution level,
enabling agents to navigate the hierarchy without reading all members.

Each summary includes:
  - 1-2 sentence description of the community's theme/scope
  - 3-5 keyword tags for quick matching

Model: qwen3.7-plus via litellm (Anthropic mode)
Batching: 10 communities per call to minimize API overhead
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections import defaultdict
from dataclasses import dataclass

import litellm

from kl_graph.config import LLM_BASE_URL, LLM_MODEL, SQLITE_PATH
from kl_graph.periodic.community_detection import RESOLUTIONS
from kl_graph.storage.sqlite_store import SQLiteStore


@dataclass
class CommunitySummary:
    """Summary for one community at one level."""
    level: str           # L0, L1, L2, L3
    community_id: int
    node_type: str       # "entity" or "fact"
    member_count: int
    summary: str         # 1-2 sentence description
    tags: list[str]      # 3-5 keyword tags
    top_members: list[str]  # top-N member names/texts used for generation


SYSTEM_PROMPT = """You are a knowledge graph analyst. Given a list of community members (entities or facts from a workplace chat knowledge graph), write a brief summary describing the community's theme.

RULES:
- Write 1-2 sentences in Chinese describing what this group is about
- Extract 3-5 short keyword tags (can be Chinese or English, lowercase)
- Be specific: "InkFlow团队的部署基础设施和CLI工具开发" is better than "技术开发"
- If members are entities (people/systems/projects), describe the team/project/domain they represent
- If members are facts, describe the topic/theme they discuss
- Tags should be specific enough to distinguish this community from others

Output JSON: {"summary": "...", "tags": ["tag1", "tag2", ...]}"""


BATCH_PROMPT_TEMPLATE = """Summarize each of the following {count} communities.

{communities_text}

Output JSON array with exactly {count} elements:
[{{"id": 0, "summary": "...", "tags": ["...", ...]}}, ...]

Each summary should be 1-2 sentences in Chinese. Each tags list should have 3-5 items."""


def _precompute_entity_degrees(sqlite: SQLiteStore) -> dict[str, int]:
    """Pre-compute entity degree from MENTIONS edges (fast, single pass)."""
    rows = sqlite.conn.execute("""
        SELECT target_id, COUNT(*) as cnt FROM edges
        WHERE edge_type = 'MENTIONS' AND target_type = 'entity'
        GROUP BY target_id
    """).fetchall()
    return {r[0]: r[1] for r in rows}


def _precompute_fact_degrees(sqlite: SQLiteStore) -> dict[str, int]:
    """Pre-compute fact degree from ABOUT edges (fast, single pass)."""
    rows = sqlite.conn.execute("""
        SELECT source_id, COUNT(*) as cnt FROM edges
        WHERE edge_type = 'ABOUT' AND source_type = 'fact'
        GROUP BY source_id
    """).fetchall()
    return {r[0]: r[1] for r in rows}


def _get_all_entity_communities(
    sqlite: SQLiteStore,
    level: str,
) -> dict[int, list[tuple[str, str]]]:
    """Get all entities grouped by community at a given level.

    Returns: {community_id: [(entity_id, name), ...]}
    """
    col = f"community_{level}"
    rows = sqlite.conn.execute(f"""
        SELECT id, name, {col} FROM entities WHERE {col} IS NOT NULL
    """).fetchall()
    result = defaultdict(list)
    for eid, name, cid in rows:
        result[cid].append((eid, name))
    return result


def _get_all_fact_communities(
    sqlite: SQLiteStore,
    level: str,
) -> dict[int, list[tuple[str, str]]]:
    """Get all facts grouped by community at a given level.

    Returns: {community_id: [(fact_id, text), ...]}
    """
    col = f"community_{level}"
    rows = sqlite.conn.execute(f"""
        SELECT id, text, {col} FROM facts WHERE {col} IS NOT NULL
    """).fetchall()
    result = defaultdict(list)
    for fid, text, cid in rows:
        result[cid].append((fid, text))
    return result


def _get_community_ids(
    sqlite: SQLiteStore,
    level: str,
    node_type: str,
) -> list[tuple[int, int]]:
    """Get all (community_id, member_count) pairs for a given level+type."""
    col = f"community_{level}"
    table = "entities" if node_type == "entity" else "facts"
    rows = sqlite.conn.execute(f"""
        SELECT {col}, COUNT(*) as cnt
        FROM {table}
        WHERE {col} IS NOT NULL
        GROUP BY {col}
        ORDER BY cnt DESC
    """).fetchall()
    return [(r[0], r[1]) for r in rows]


async def _summarize_batch(
    api_key: str,
    communities: list[dict],
    semaphore: asyncio.Semaphore,
    stats: dict | None = None,
    max_retries: int = 3,
) -> list[dict]:
    """Summarize a batch of communities in one LLM call."""
    # Format communities for prompt
    parts = []
    for i, comm in enumerate(communities):
        members_str = ", ".join(comm["top_members"][:10])
        parts.append(
            f"Community {i} ({comm['node_type']}, {comm['member_count']} members, "
            f"level {comm['level']}):\n  Members: {members_str}"
        )
    communities_text = "\n\n".join(parts)

    prompt = BATCH_PROMPT_TEMPLATE.format(
        count=len(communities),
        communities_text=communities_text,
    )

    for attempt in range(max_retries):
        try:
            async with semaphore:
                response = await litellm.acompletion(
                    model=f"anthropic/{LLM_MODEL}",
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                    ],
                    api_base=LLM_BASE_URL,
                    api_key=api_key,
                    temperature=0.3,
                    max_tokens=2000,
                    response_format={"type": "json_object"},
                )
            text = response.choices[0].message.content.strip()

            # Track token usage and cost
            if stats is not None:
                stats["llm_calls"] += 1
                try:
                    usage = getattr(response, "usage", None)
                    if usage:
                        pt = getattr(usage, "prompt_tokens", 0) or 0
                        ct = getattr(usage, "completion_tokens", 0) or 0
                        tt = getattr(usage, "total_tokens", 0) or (pt + ct)
                        stats["prompt_tokens"] += pt
                        stats["completion_tokens"] += ct
                        stats["total_tokens"] += tt
                except Exception:
                    pass
                try:
                    cost = litellm.completion_cost(response)
                    if cost is not None:
                        stats["estimated_cost_usd"] += cost
                except Exception:
                    pass

            # Parse JSON — might be wrapped in markdown
            if text.startswith("```"):
                text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

            # Handle both array and object responses
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                # Sometimes wraps in {"communities": [...]} or similar
                for key in ("communities", "results", "summaries"):
                    if key in parsed and isinstance(parsed[key], list):
                        parsed = parsed[key]
                        break
                else:
                    # Single community response for batch of 1
                    parsed = [parsed]

            results = []
            for i, comm in enumerate(communities):
                if i < len(parsed):
                    item = parsed[i]
                    summary = item.get("summary", "")
                    tags = item.get("tags", [])
                    if isinstance(tags, str):
                        tags = [t.strip() for t in tags.split(",")]
                    results.append({"summary": summary, "tags": tags[:5]})
                else:
                    results.append({"summary": "", "tags": []})

            return results

        except Exception as e:
            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)
            else:
                print(f"  Warning: batch summarization failed after {max_retries} attempts: {e}")
                return [{"summary": "", "tags": []} for _ in communities]


async def generate_community_summaries(
    sqlite: SQLiteStore,
    concurrency: int = 20,
    batch_size: int = 10,
    min_members: int = 3,
) -> list[CommunitySummary]:
    """Generate LLM summaries for all communities at all levels.

    Args:
        sqlite: SQLite store with community assignments
        concurrency: Max concurrent LLM calls
        batch_size: Communities per LLM call
        min_members: Minimum community size to summarize

    Returns:
        List of CommunitySummary objects
    """
    api_key = os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
    semaphore = asyncio.Semaphore(concurrency)

    # Pre-compute degrees (one pass each)
    print("  Pre-computing degrees...")
    entity_degrees = _precompute_entity_degrees(sqlite)
    fact_degrees = _precompute_fact_degrees(sqlite)

    # Collect all communities to summarize
    all_communities = []

    for level in RESOLUTIONS:
        # Entities
        entity_comms = _get_all_entity_communities(sqlite, level)
        for cid, members in entity_comms.items():
            if len(members) < min_members:
                continue
            # Sort by pre-computed degree, take top 10
            sorted_members = sorted(members, key=lambda x: entity_degrees.get(x[0], 0), reverse=True)
            top_names = [name for _, name in sorted_members[:10]]
            all_communities.append({
                "level": level,
                "community_id": cid,
                "node_type": "entity",
                "member_count": len(members),
                "top_members": top_names,
            })

        # Facts
        fact_comms = _get_all_fact_communities(sqlite, level)
        for cid, members in fact_comms.items():
            if len(members) < min_members:
                continue
            sorted_members = sorted(members, key=lambda x: fact_degrees.get(x[0], 0), reverse=True)
            top_texts = [text[:100] for _, text in sorted_members[:10]]
            all_communities.append({
                "level": level,
                "community_id": cid,
                "node_type": "fact",
                "member_count": len(members),
                "top_members": top_texts,
            })

    print(f"  Communities to summarize: {len(all_communities)}")
    print(f"  Batches: {(len(all_communities) + batch_size - 1) // batch_size}")

    # LLM usage tracking
    llm_stats = {
        "llm_calls": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "estimated_cost_usd": 0.0,
    }

    # Process in batches
    summaries = []

    t0 = time.time()
    # Process batches with progress tracking using semaphore-bounded gather
    batch_count = (len(all_communities) + batch_size - 1) // batch_size
    done_count = 0

    async def _process_batch(batch_idx):
        nonlocal done_count
        start = batch_idx * batch_size
        batch = all_communities[start:start + batch_size]
        result = await _summarize_batch(api_key, batch, semaphore, stats=llm_stats)
        done_count += 1
        if done_count % 20 == 0 or done_count == batch_count:
            print(f"  Progress: {done_count}/{batch_count} batches "
                  f"({time.time() - t0:.0f}s)", flush=True)
        return batch_idx, result

    tasks = [_process_batch(i) for i in range(batch_count)]
    batch_results_list = await asyncio.gather(*tasks)

    # Reassemble in order
    batch_results_list = sorted(batch_results_list, key=lambda x: x[0])
    for batch_idx, batch_results in batch_results_list:
        start = batch_idx * batch_size
        for j, result in enumerate(batch_results):
            comm = all_communities[start + j]
            summaries.append(CommunitySummary(
                level=comm["level"],
                community_id=comm["community_id"],
                node_type=comm["node_type"],
                member_count=comm["member_count"],
                summary=result["summary"],
                tags=result["tags"],
                top_members=comm["top_members"],
            ))

    elapsed = time.time() - t0
    n_with_summary = sum(1 for s in summaries if s.summary)
    print(f"  Generated {n_with_summary}/{len(summaries)} summaries in {elapsed:.1f}s")
    print(f"  LLM calls: {llm_stats['llm_calls']}")
    print(f"  ── LLM Token Usage ──")
    print(f"  Prompt tokens:     {llm_stats['prompt_tokens']:,}")
    print(f"  Completion tokens: {llm_stats['completion_tokens']:,}")
    print(f"  Total tokens:       {llm_stats['total_tokens']:,}")
    if llm_stats["llm_calls"] > 0:
        avg_pt = llm_stats["prompt_tokens"] / llm_stats["llm_calls"]
        avg_ct = llm_stats["completion_tokens"] / llm_stats["llm_calls"]
        print(f"  Avg tokens/call:   {avg_pt:.0f} in + {avg_ct:.0f} out")
    print(f"  Estimated cost:    ${llm_stats['estimated_cost_usd']:.4f}")

    return summaries, llm_stats


def store_community_summaries(sqlite: SQLiteStore, summaries: list[CommunitySummary]):
    """Store community summaries in SQLite.

    Creates/replaces the community_summaries table.
    """
    sqlite.conn.execute("""
        CREATE TABLE IF NOT EXISTS community_summaries (
            level TEXT NOT NULL,
            community_id INTEGER NOT NULL,
            node_type TEXT NOT NULL,
            member_count INTEGER NOT NULL,
            summary TEXT NOT NULL,
            tags TEXT NOT NULL,
            top_members TEXT NOT NULL,
            PRIMARY KEY (level, community_id, node_type)
        )
    """)
    sqlite.conn.execute("DELETE FROM community_summaries")
    sqlite.conn.commit()

    rows = []
    for s in summaries:
        if s.summary:  # Only store non-empty summaries
            rows.append((
                s.level,
                s.community_id,
                s.node_type,
                s.member_count,
                s.summary,
                json.dumps(s.tags, ensure_ascii=False),
                json.dumps(s.top_members[:10], ensure_ascii=False),
            ))

    sqlite.conn.executemany(
        """INSERT OR REPLACE INTO community_summaries
           (level, community_id, node_type, member_count, summary, tags, top_members)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    sqlite.conn.commit()
    print(f"  Stored {len(rows)} community summaries")

    # Print stats per level
    for level in RESOLUTIONS:
        n_entity = sum(1 for s in summaries if s.level == level and s.node_type == "entity" and s.summary)
        n_fact = sum(1 for s in summaries if s.level == level and s.node_type == "fact" and s.summary)
        print(f"    {level}: {n_entity} entity, {n_fact} fact summaries")


async def run_community_summarization(
    sqlite_path=SQLITE_PATH,
    concurrency: int = 10,
    batch_size: int = 10,
    min_members: int = 3,
):
    """Main entry point for community summarization."""
    t0 = time.time()
    print("\n" + "=" * 60)
    print("COMMUNITY SUMMARIZATION")
    print("=" * 60)

    sqlite = SQLiteStore(sqlite_path)
    try:
        summaries, llm_stats = await generate_community_summaries(
            sqlite,
            concurrency=concurrency,
            batch_size=batch_size,
            min_members=min_members,
        )
        store_community_summaries(sqlite, summaries)

        elapsed = time.time() - t0
        print(f"\n  ┌─ Community Summarization Cost Summary ──────┐")
        print(f"  │  LLM calls:          {llm_stats['llm_calls']:,}")
        print(f"  │  Prompt tokens:      {llm_stats['prompt_tokens']:,}")
        print(f"  │  Completion tokens:  {llm_stats['completion_tokens']:,}")
        print(f"  │  Total tokens:        {llm_stats['total_tokens']:,}")
        print(f"  │  Estimated cost:     ${llm_stats['estimated_cost_usd']:.4f}")
        print(f"  │  Time:               {elapsed:.1f}s ({elapsed/60:.1f} min)")
        print(f"  └────────────────────────────────────────────┘")
    finally:
        sqlite.close()


# CLI entry
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Generate community summaries")
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--min-members", type=int, default=3)
    args = parser.parse_args()

    asyncio.run(run_community_summarization(
        concurrency=args.concurrency,
        batch_size=args.batch_size,
        min_members=args.min_members,
    ))
