"""LLM-based community summarization over mixed (entity + fact) communities.

Generates GraphRAG-style reports for each community at each resolution level,
enabling agents to navigate the hierarchy without reading all members.

Each report includes:
  - title: short specific community name
  - summary: executive summary of structure and theme
  - rating (0-10) + rating_explanation: impact/importance severity
  - findings: 5-10 key insights with {summary, explanation}
  - tags: 3-5 keywords for quick matching

Model: qwen3.7-plus via litellm (Anthropic mode)
Concurrency: semaphore-bounded async calls (one per community)
Token budget: 8000 input / 2000 output (GraphRAG parity)
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from collections import defaultdict
from dataclasses import dataclass

from kl_graph.config import DATA_DIR, cfg
from kl_graph.ingest.chunker import num_tokens_from_string
from kl_graph.models.types import community_id_from
from kl_graph.storage.sqlite_store import SQLiteStore
from kl_graph.utils.litellm_config import litellm, provider_api_key, provider_model

SQLITE_PATH = DATA_DIR / "knowledge.db"

# Token budgets [A human 2026-08-09: raised 8000 → 8192]
MAX_INPUT_LENGTH = 8192
MAX_REPORT_LENGTH = 2000

# Tokenization is not additive across a concatenation boundary: the skeleton
# is measured with members_text="", then the packed members are appended, and
# the join can tokenize into marginally more tokens than the two parts sum to.
# Reserve a few tokens so the final hard assertion never trips by 1-2 tokens.
TOKENIZATION_MARGIN = 8

#: Fallback when the config key is absent (mirrors the historical hardcoded value).
_DEFAULT_SUMMARY_CONCURRENCY_FALLBACK = 8


def _default_summary_concurrency() -> int:
    """Resolve the default community-summarization LLM concurrency from config.

    Reads ``cfg.pipelines.ingestion.community_summarization.max_concurrent``
    (env-overridable via ``KL_COMMUNITY_SUMMARY_CONCURRENCY``), falling back to
    :data:`_DEFAULT_SUMMARY_CONCURRENCY_FALLBACK` if the key is missing so older
    configs keep working.
    """
    try:
        value = int(
            cfg.pipelines.ingestion.community_summarization.max_concurrent
        )
    except Exception:  # noqa: BLE001
        return _DEFAULT_SUMMARY_CONCURRENCY_FALLBACK
    return value if value > 0 else _DEFAULT_SUMMARY_CONCURRENCY_FALLBACK


@dataclass
class CommunityReport:
    """Report for one community at one level."""

    level: int  # 0, 1, 2, 3, ...
    community_id: int
    member_count: int
    entity_count: int
    fact_count: int
    title: str
    summary: str
    rating: float
    rating_explanation: str
    findings: list[dict]  # [{summary, explanation}, ...]
    tags: list[str]
    top_members: list[str]  # top-N member names/texts used for generation


def enumerate_community_level_columns(sqlite: SQLiteStore) -> list[int]:
    """Find all community_Li columns present in entities/facts tables.

    Returns sorted list of level integers (e.g., [0, 1, 2, 3]).
    """
    cols: set[int] = set()
    for table in ("entities", "facts"):
        rows = sqlite.sql_conn.execute(
            f"PRAGMA table_info({table})"
        ).fetchall()
        for row in rows:
            col_name = row[1]
            if col_name.startswith("community_L"):
                try:
                    level = int(col_name[len("community_L") :])
                    cols.add(level)
                except ValueError:
                    pass
    return sorted(cols)


def _precompute_entity_degrees(sqlite: SQLiteStore) -> dict[str, int]:
    """Pre-compute entity degree from MENTIONS edges (backend-agnostic)."""
    degrees: dict[str, int] = defaultdict(int)
    for _chunk_id, entity_id, _props in sqlite.scan_edges_by_type(
        ["MENTIONS"], source_type="chunk", target_type="entity"
    ):
        degrees[entity_id] += 1
    return dict(degrees)


def _precompute_fact_degrees(sqlite: SQLiteStore) -> dict[str, int]:
    """Pre-compute fact degree from ABOUT edges (backend-agnostic)."""
    degrees: dict[str, int] = defaultdict(int)
    for fact_id, _entity_id, _props in sqlite.scan_edges_by_type(
        ["ABOUT"], source_type="fact", target_type="entity"
    ):
        degrees[fact_id] += 1
    return dict(degrees)


def _get_mixed_communities(
    sqlite: SQLiteStore,
    level: int,
    entity_degrees: dict[str, int],
    fact_degrees: dict[str, int],
) -> dict[int, dict]:
    """Get all entities + facts grouped by community at a given level.

    Returns: {
        community_id: {
            "entities": [(entity_id, name, description, degree), ...],
            "facts": [(fact_id, text, confidence, degree), ...],
        }
    }
    """
    col = f"community_L{level}"
    result: dict[int, dict] = defaultdict(lambda: {"entities": [], "facts": []})

    # Entities
    rows = sqlite.sql_conn.execute(f"""
        SELECT id, name, description, {col} FROM entities WHERE {col} IS NOT NULL
    """).fetchall()
    for eid, name, desc, cid in rows:
        degree = entity_degrees.get(eid, 0)
        result[cid]["entities"].append((eid, name, desc or "", degree))

    # Facts
    rows = sqlite.sql_conn.execute(f"""
        SELECT id, text, confidence, {col} FROM facts WHERE {col} IS NOT NULL
    """).fetchall()
    for fid, text, conf, cid in rows:
        degree = fact_degrees.get(fid, 0)
        result[cid]["facts"].append((fid, text, conf or 0.0, degree))

    return result


SYSTEM_PROMPT = """你是一位知识图谱分析师。给定一个社区的所有成员（实体和事实），生成一份结构化的社区报告。

规则：
- 使用中文撰写
- title: 简短具体的社区名称（包含代表性实体名称）
- summary: 社区结构和主题的执行摘要（2-3句）
- rating: 0-10的浮点数，表示影响/重要性程度
- rating_explanation: 一句话解释评分理由
- findings: 5-10个关键发现，每个包含summary和explanation
- tags: 3-5个关键词（可中英文混合，小写）
- 对于标记为"待验证"的事实，在报告中应有所保留而非断言

输出JSON格式：
{
  "title": "...",
  "summary": "...",
  "rating": 7.5,
  "rating_explanation": "...",
  "findings": [
    {"summary": "...", "explanation": "..."},
    ...
  ],
  "tags": ["tag1", "tag2", ...]
}"""


COMMUNITY_PROMPT_TEMPLATE = """分析以下社区的成员，生成结构化报告。

社区层级: L{level}
社区ID: {community_id}
成员数: {member_count} (实体: {entity_count}, 事实: {fact_count})

成员列表（按重要性排序）:
{members_text}

请生成符合要求的JSON报告。"""


def _render_member_context(
    entities: list[tuple[str, str, str, int]],
    facts: list[tuple[str, str, float, int]],
) -> str:
    """Render full ranked member context for prompt assembly.

    Entities ranked by MENTIONS degree, facts by ABOUT degree (confidence tie-break).
    Returns concatenated text for token packing.
    """
    parts: list[str] = []

    # Sort entities by degree (desc)
    sorted_entities = sorted(entities, key=lambda x: x[3], reverse=True)
    for eid, name, desc, degree in sorted_entities:
        parts.append(f"[实体] {name} | {desc} | 提及度: {degree}")

    # Sort facts by degree (desc), then confidence (desc)
    sorted_facts = sorted(facts, key=lambda x: (x[3], x[2]), reverse=True)
    for fid, text, conf, degree in sorted_facts:
        conf_marker = "待验证" if conf < 0.7 else "已验证"
        parts.append(f"[事实] {text} | {conf_marker} | 关联度: {degree}")

    return "\n".join(parts)


def _token_pack(text: str, max_tokens: int) -> str:
    """Pack text to fit within max_tokens by dropping whole lines from the end.

    Never slices mid-line (AGENTS.md: no [:xx] on stored/embedded/indexed paths).
    Lines are dropped lowest-ranked (end of list) first.
    """
    if num_tokens_from_string(text) <= max_tokens:
        return text

    lines = text.split("\n")
    # Drop lines from the end until we fit
    while lines and num_tokens_from_string("\n".join(lines)) > max_tokens:
        lines.pop()

    return "\n".join(lines)


def _build_ranked_context(
    entities: list[tuple[str, str, str, int]],
    facts: list[tuple[str, str, float, int]],
    max_tokens: int,
) -> tuple[str, list[str]]:
    """Build token-packed member context using combined degree ranking.

    Merges entities and facts into ONE deterministic priority order ranked
    by degree (descending). Confidence only tie-breaks among facts.
    Drops whole lowest-ranked items from the combined tail to fit max_tokens.

    Args:
        entities: [(entity_id, name, description, degree), ...]
        facts: [(fact_id, text, confidence, degree), ...]
        max_tokens: Token budget for the packed output.

    Returns:
        (packed_text, selected_entries) where selected_entries are
        whole member strings suitable for storage in top_members (no slicing).
    """
    # Build combined ranked list: (sort_key, rendered_line, storage_entry)
    # sort_key = (-degree, type_order, -confidence_if_fact, id)
    # type_order: 0 = entity, 1 = fact (entities first at same degree)
    ranked: list[tuple[tuple, str, str]] = []

    for eid, name, desc, degree in entities:
        rendered = f"[实体] {name} | {desc} | 提及度: {degree}"
        ranked.append(((-degree, 0, 0.0, eid), rendered, name))

    for fid, text, conf, degree in facts:
        conf_marker = "待验证" if conf < 0.7 else "已验证"
        rendered = f"[事实] {text} | {conf_marker} | 关联度: {degree}"
        ranked.append(((-degree, 1, -conf, fid), rendered, text))

    # Sort: most-important first
    ranked.sort(key=lambda x: x[0])

    # Pack lines and entries together by appending — no [:xx] on stored path
    # Each item that fits the budget is appended; items that don't fit are skipped.
    # This ensures selected_entries is built incrementally (not sliced from a larger list).
    kept_lines: list[str] = []
    kept_entries: list[str] = []

    for _sort_key, rendered, entry in ranked:
        # Check if adding this line would exceed the budget
        candidate_lines = kept_lines + [rendered]
        candidate_text = "\n".join(candidate_lines)
        if num_tokens_from_string(candidate_text) > max_tokens:
            break
        kept_lines.append(rendered)
        kept_entries.append(entry)

    return "\n".join(kept_lines), kept_entries


def _validate_report_response(parsed: dict) -> None:
    """Validate parsed report response strictly. Raises ValueError on any issue.

    Requirements:
    - title: non-empty string
    - summary: non-empty string
    - rating: finite non-bool number in [0, 10]
    - rating_explanation: non-empty string
    - findings: 5-10 items, each with string summary and explanation
    - tags: 3-5 non-empty strings
    """
    required = {"title", "summary", "rating", "rating_explanation", "findings", "tags"}
    if not isinstance(parsed, dict):
        raise ValueError("Response must be a JSON object")
    missing = required - set(parsed.keys())
    if missing:
        raise ValueError(f"Missing required fields: {missing}")

    # title: non-empty string
    if not isinstance(parsed["title"], str) or not parsed["title"].strip():
        raise ValueError("title must be a non-empty string")

    # summary: non-empty string
    if not isinstance(parsed["summary"], str) or not parsed["summary"].strip():
        raise ValueError("summary must be a non-empty string")

    # rating: finite non-bool number in [0, 10]
    rating = parsed["rating"]
    if isinstance(rating, bool) or not isinstance(rating, (int, float)):
        raise ValueError("rating must be a number (not bool)")
    if math.isnan(rating) or math.isinf(rating):
        raise ValueError("rating must be finite")
    if not (0 <= rating <= 10):
        raise ValueError(f"rating must be in [0, 10], got {rating}")

    # rating_explanation: non-empty string
    if not isinstance(parsed["rating_explanation"], str) or not parsed["rating_explanation"].strip():
        raise ValueError("rating_explanation must be a non-empty string")

    # findings: 5-10 items, each with string summary and explanation
    findings = parsed["findings"]
    if not isinstance(findings, list):
        raise ValueError("findings must be a list")
    if not (5 <= len(findings) <= 10):
        raise ValueError(f"findings must have 5-10 items, got {len(findings)}")
    for i, f in enumerate(findings):
        if not isinstance(f, dict):
            raise ValueError(f"finding[{i}] must be a dict")
        if "summary" not in f or "explanation" not in f:
            raise ValueError(f"finding[{i}] must have summary and explanation")
        if not isinstance(f["summary"], str) or not f["summary"].strip():
            raise ValueError(f"finding[{i}].summary must be a non-empty string")
        if not isinstance(f["explanation"], str) or not f["explanation"].strip():
            raise ValueError(f"finding[{i}].explanation must be a non-empty string")

    # tags: 3-5 non-empty strings
    tags = parsed["tags"]
    if not isinstance(tags, list):
        raise ValueError("tags must be a list")
    if not (3 <= len(tags) <= 5):
        raise ValueError(f"tags must have 3-5 items, got {len(tags)}")
    for i, t in enumerate(tags):
        if not isinstance(t, str) or not t.strip():
            raise ValueError(f"tag[{i}] must be a non-empty string")


async def _summarize_community(
    api_key: str | None,
    level: int,
    community_id: int,
    entities: list[tuple[str, str, str, int]],
    facts: list[tuple[str, str, float, int]],
    semaphore: asyncio.Semaphore,
    stats: dict | None = None,
    max_retries: int = 2,
) -> tuple[dict, list[str]] | None:
    """Summarize one community with one LLM call.

    Returns (parsed_report, selected_entries) or None if malformed after retries.
    """
    # Compute fixed overhead (system prompt + template without members)
    overhead_template = COMMUNITY_PROMPT_TEMPLATE.format(
        level=level,
        community_id=community_id,
        member_count=len(entities) + len(facts),
        entity_count=len(entities),
        fact_count=len(facts),
        members_text="",
    )
    fixed_overhead = num_tokens_from_string(SYSTEM_PROMPT) + num_tokens_from_string(overhead_template)
    member_budget = MAX_INPUT_LENGTH - fixed_overhead - TOKENIZATION_MARGIN

    # Build ranked context using combined degree ranking within member budget
    packed_context, selected_entries = _build_ranked_context(entities, facts, member_budget)

    prompt = COMMUNITY_PROMPT_TEMPLATE.format(
        level=level,
        community_id=community_id,
        member_count=len(entities) + len(facts),
        entity_count=len(entities),
        fact_count=len(facts),
        members_text=packed_context,
    )

    # Assert final messages fit MAX_INPUT_LENGTH
    total_tokens = num_tokens_from_string(SYSTEM_PROMPT) + num_tokens_from_string(prompt)
    assert total_tokens <= MAX_INPUT_LENGTH, (
        f"Message exceeds MAX_INPUT_LENGTH: {total_tokens} > {MAX_INPUT_LENGTH}"
    )

    for attempt in range(max_retries):
        try:
            async with semaphore:
                response = await litellm.acompletion(
                    model=provider_model(
                        cfg.services.llm_flash.provider,
                        cfg.services.llm_flash.model,
                    ),
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt},
                    ],
                    api_base=cfg.services.llm_flash.base_url or "",
                    api_key=api_key,
                    temperature=0.3,
                    max_tokens=MAX_REPORT_LENGTH,
                    response_format={"type": "json_object"},
                    timeout=float(cfg.services.llm_flash.timeout),
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
                except Exception:  # noqa: BLE001, S110
                    pass
                try:
                    cost = litellm.completion_cost(response)
                    if cost is not None:
                        stats["estimated_cost_usd"] += cost
                except Exception:  # noqa: BLE001, S110
                    pass

            # Parse JSON — might be wrapped in markdown
            if text.startswith("```"):
                text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

            parsed = json.loads(text)
            _validate_report_response(parsed)
            return parsed, selected_entries

        except Exception as e:  # noqa: BLE001
            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)
            else:
                print(
                    f"  Warning: community L{level}:{community_id} failed after "
                    f"{max_retries} attempts: {e}"
                )
                return None


async def generate_community_reports(
    sqlite: SQLiteStore,
    levels: list[int] | None = None,
    min_members: int = 10,
    max_concurrent: int | None = None,
) -> tuple[list[CommunityReport], dict]:
    """Generate LLM reports for all communities at specified levels.

    Args:
        sqlite: SQLite store with community assignments
        levels: Which levels to summarize (None = all present)
        min_members: Minimum mixed member count to summarize
        max_concurrent: Max concurrent LLM calls. When ``None``, falls back to
            ``cfg.pipelines.ingestion.community_summarization.max_concurrent``.

    Returns:
        (reports, llm_stats) tuple
    """
    if max_concurrent is None:
        max_concurrent = _default_summary_concurrency()
    api_key = provider_api_key(cfg.services.llm_flash.provider)
    semaphore = asyncio.Semaphore(max_concurrent)

    # Enumerate present level columns
    if levels is None:
        levels = enumerate_community_level_columns(sqlite)

    if not levels:
        print("  No community_L* columns found; skipping summarization.")
        return [], {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "estimated_cost_usd": 0.0}

    # Pre-compute degrees (one pass each)
    print("  Pre-computing degrees...")
    entity_degrees = _precompute_entity_degrees(sqlite)
    fact_degrees = _precompute_fact_degrees(sqlite)

    # Native authority [A human 2026-08-09]: the projection materializes one
    # Community row per genuine Leiden cluster. Column-derived groups whose id
    # has no Community row are repeated-final-fill copies (identical member
    # sets to their origin cluster) and must not be summarized.
    native_ids = {
        r[0] for r in sqlite.sql_conn.execute("SELECT id FROM communities").fetchall()
    }

    # Collect all communities to summarize
    all_communities: list[dict] = []

    for level in levels:
        communities = _get_mixed_communities(sqlite, level, entity_degrees, fact_degrees)
        for cid, members in communities.items():
            if community_id_from(f"L{level}", cid) not in native_ids:
                continue
            n_entities = len(members["entities"])
            n_facts = len(members["facts"])
            total = n_entities + n_facts
            if total < min_members:
                continue
            all_communities.append({
                "level": level,
                "community_id": cid,
                "entities": members["entities"],
                "facts": members["facts"],
                "entity_count": n_entities,
                "fact_count": n_facts,
                "member_count": total,
            })

    print(f"  Communities to summarize: {len(all_communities)}")

    # LLM usage tracking
    llm_stats = {
        "llm_calls": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "estimated_cost_usd": 0.0,
    }

    # Process with semaphore-bounded concurrency
    reports: list[CommunityReport] = []
    t0 = time.time()

    async def _process_community(comm: dict) -> CommunityReport | None:
        # One bad community (packing assertion, unexpected LLM shape, ...) must
        # skip, never kill the whole run — mirrors the retry/skip policy for
        # malformed responses.
        try:
            summarize_result = await _summarize_community(
                api_key,
                comm["level"],
                comm["community_id"],
                comm["entities"],
                comm["facts"],
                semaphore,
                stats=llm_stats,
            )
        except Exception as e:  # noqa: BLE001
            print(
                f"  Warning: community L{comm['level']}:{comm['community_id']} "
                f"skipped: {e}"
            )
            return None
        if summarize_result is None:
            return None
        result, selected_entries = summarize_result

        return CommunityReport(
            level=comm["level"],
            community_id=comm["community_id"],
            member_count=comm["member_count"],
            entity_count=comm["entity_count"],
            fact_count=comm["fact_count"],
            title=result["title"],
            summary=result["summary"],
            rating=result["rating"],
            rating_explanation=result["rating_explanation"],
            findings=result["findings"],
            tags=result["tags"],
            top_members=selected_entries,
        )

    tasks = [_process_community(comm) for comm in all_communities]
    results = await asyncio.gather(*tasks)

    # Filter out None (failed) results
    reports = [r for r in results if r is not None]

    elapsed = time.time() - t0
    print(f"  Generated {len(reports)}/{len(all_communities)} reports in {elapsed:.1f}s")
    print(f"  LLM calls: {llm_stats['llm_calls']}")
    print("  ── LLM Token Usage ──")
    print(f"  Prompt tokens:     {llm_stats['prompt_tokens']:,}")
    print(f"  Completion tokens: {llm_stats['completion_tokens']:,}")
    print(f"  Total tokens:      {llm_stats['total_tokens']:,}")
    if llm_stats["llm_calls"] > 0:
        avg_pt = llm_stats["prompt_tokens"] / llm_stats["llm_calls"]
        avg_ct = llm_stats["completion_tokens"] / llm_stats["llm_calls"]
        print(f"  Avg tokens/call:   {avg_pt:.0f} in + {avg_ct:.0f} out")
    print(f"  Estimated cost:    ${llm_stats['estimated_cost_usd']:.4f}")

    return reports, llm_stats


def store_community_reports(sqlite: SQLiteStore, reports: list[CommunityReport]) -> int:
    """Store community reports in SQLite.

    Creates/replaces the community_summaries table with new schema.
    Returns count of rows stored.
    """
    sqlite.sql_conn.execute("DROP TABLE IF EXISTS community_summaries")
    sqlite.sql_conn.execute("""
        CREATE TABLE community_summaries (
            level INTEGER NOT NULL,
            community_id INTEGER NOT NULL,
            member_count INTEGER NOT NULL,
            entity_count INTEGER NOT NULL,
            fact_count INTEGER NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            rating REAL NOT NULL,
            rating_explanation TEXT NOT NULL,
            findings TEXT NOT NULL,
            tags TEXT NOT NULL,
            top_members TEXT NOT NULL,
            PRIMARY KEY (level, community_id)
        )
    """)
    sqlite.sql_conn.commit()

    rows = []
    for r in reports:
        rows.append((
            r.level,
            r.community_id,
            r.member_count,
            r.entity_count,
            r.fact_count,
            r.title,
            r.summary,
            r.rating,
            r.rating_explanation,
            json.dumps(r.findings, ensure_ascii=False),
            json.dumps(r.tags, ensure_ascii=False),
            json.dumps(r.top_members, ensure_ascii=False),
        ))

    sqlite.sql_conn.executemany(
        """INSERT OR REPLACE INTO community_summaries
           (level, community_id, member_count, entity_count, fact_count,
            title, summary, rating, rating_explanation, findings, tags, top_members)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    sqlite.sql_conn.commit()
    print(f"  Stored {len(rows)} community reports")

    # Print stats per level
    levels_seen = sorted(set(r.level for r in reports))
    for level in levels_seen:
        n_reports = sum(1 for r in reports if r.level == level)
        print(f"    L{level}: {n_reports} reports")

    return len(rows)


def run_community_summarization(
    sqlite: SQLiteStore,
    *,
    levels: list[int] | None = None,
    min_members: int = 10,
    max_concurrent: int | None = None,
) -> int:
    """Main entry point for community summarization (sync wrapper).

    Matches the pinned call contract from runner.py:
    run_community_summarization(store, levels=None, min_members=10) -> int

    Args:
        sqlite: SQLite store with community assignments
        levels: Which levels to summarize (None = all present)
        min_members: Minimum mixed member count to summarize
        max_concurrent: Max concurrent LLM calls. When ``None``, falls back to
            ``cfg.pipelines.ingestion.community_summarization.max_concurrent``.

    Returns:
        Count of reports stored
    """
    t0 = time.time()
    print("\n" + "=" * 60)
    print("COMMUNITY SUMMARIZATION")
    print("=" * 60)

    reports, llm_stats = asyncio.run(
        generate_community_reports(
            sqlite,
            levels=levels,
            min_members=min_members,
            max_concurrent=max_concurrent,
        )
    )
    n_stored = store_community_reports(sqlite, reports)

    elapsed = time.time() - t0
    print("\n  ┌─ Community Summarization Cost Summary ──────┐")
    print(f"  │  LLM calls:          {llm_stats['llm_calls']:,}")
    print(f"  │  Prompt tokens:      {llm_stats['prompt_tokens']:,}")
    print(f"  │  Completion tokens:  {llm_stats['completion_tokens']:,}")
    print(f"  │  Total tokens:       {llm_stats['total_tokens']:,}")
    print(f"  │  Estimated cost:     ${llm_stats['estimated_cost_usd']:.4f}")
    print(f"  │  Time:               {elapsed:.1f}s ({elapsed / 60:.1f} min)")
    print("  └────────────────────────────────────────────┘")

    return n_stored
