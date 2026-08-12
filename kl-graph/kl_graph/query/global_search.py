"""Global search: GraphRAG-style map-reduce over community summaries.

Answers *conceptual* questions (e.g. "我最近的任务是什么") that no single
vector hit can recall: rate-then-descend selection over the community
hierarchy (level-0 roots first, LLM rates each report's relevance to the
query, children of kept communities queued via parent links), then map-reduce
the selected reports in token-budgeted batches into importance-scored key
points (strict JSON), and reduce the survivors into one grounded markdown
answer with ``[Data: Communities (...)]`` citations.

Standalone by design (see docs/todo/global-search.md, unit U1): no FastAPI,
no Qdrant, and no ``kl_graph.query.engine`` imports. Dependencies are
injected — a SQLite connection (or a zero-arg provider returning one) and an
async completion callable ``acomplete(system, user) -> str`` compatible with
a ``litellm.acompletion`` wrapper the server supplies — so the service unit-
tests against a temp database and a stub callable.

Token budgeting ([!RED R3]): kl-graph has no tokenizer, so budgets are
enforced with a conservative char-based estimate (~1 token per 1.5 chars for
CJK-heavy text) plus an explicit safety margin. Budgets are HARD caps on
TRANSIENT PROMPT MATERIAL: the fixed system prompt and the question are
reserved as overhead, only WHOLE rows/blocks that fit the remainder are
admitted, and an oversized row/block is dropped whole — never sliced, never
sent alone over budget. ``community_summaries.summary`` text is always read
full from SQLite and never mutated.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import sqlite3
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from kl_graph.config import cfg
from kl_graph.models.types import community_id_from

logger = logging.getLogger(__name__)

# Derived constants from OmegaConf config
GLOBAL_SEARCH_MAP_BUDGET = int(cfg.pipelines.query.global_search.map_budget)
GLOBAL_SEARCH_MAP_CONCURRENCY = int(cfg.pipelines.query.global_search.map_concurrency)
GLOBAL_SEARCH_MAP_MAX_TOKENS = int(cfg.pipelines.query.global_search.map_max_tokens)
GLOBAL_SEARCH_REDUCE_BUDGET = int(cfg.pipelines.query.global_search.reduce_budget)
GLOBAL_SEARCH_REDUCE_MAX_TOKENS = int(cfg.pipelines.query.global_search.reduce_max_tokens)
GLOBAL_SEARCH_SHUFFLE_SEED = int(cfg.pipelines.query.global_search.shuffle_seed)

# GraphRAG-style global search constants (new for hierarchical communities)
RATE_THRESHOLD = 1  # Keep communities with rating >= threshold (0-10 scale)
RATE_NUM_REPEATS = 1  # Future: majority vote over multiple ratings
RATE_CONCURRENCY = 8  # Max concurrent rating calls
MAX_RATINGS_PER_QUERY = 200  # Hard cap on total rating calls per query
MAX_DATA_TOKENS = 8000  # Token budget per map batch (GraphRAG default)

# Canned grounded refusal (GraphRAG's NO_DATA_ANSWER), returned WITHOUT any
# LLM call when there is no community evidence to aggregate.
NO_DATA_ANSWER = (
    "I am sorry but I am unable to answer this question given the provided "
    "data. 抱歉，当前知识库中没有足够的社区摘要数据来回答这个问题。"
)

# Reason codes for GlobalSearchResult.reason.
REASON_OK = "ok"
REASON_NO_COMMUNITIES = "no_communities"
REASON_NO_POINTS = "no_points"
REASON_ERROR = "error"

# Conservative char->token ratio for CJK-heavy text ([!RED R3]): kl-graph has
# no tokenizer, so token counts are estimated as ceil(len(text) / 1.5). This
# matches common CJK tokenization (~1-2 chars per token) closely enough for
# budgeting when combined with the safety margin below.
CHARS_PER_TOKEN = 1.5

# Explicit safety margin shaved off every configured token budget before it is
# enforced, so estimator error cannot overflow the real context window.
BUDGET_SAFETY_FACTOR = 0.85

# Per-point citation clamp: at most this many community ids, then "+more".
CITATION_LIMIT = 5
MORE_MARKER = "+more"

# Strict-JSON map system prompt (design doc, U1 step 3). ``{max_length}`` is
# filled with the map output token limit; braces in the JSON example are
# doubled for str.format.
MAP_SYSTEM_PROMPT = """You are an analyst answering questions about a workplace knowledge graph. Below are community summaries (level | id | members | tags | summary). Produce a list of key points relevant to the user's question.
Each point: "description" (cite supporting communities as [Data: Communities (ids)], max 5 ids + "+more") and integer "score" 0-100 (0 = "I don't know" / irrelevant). Do not include claims the summaries do not support. Respond ONLY with JSON: {{"points": [{{"description": "...", "score": 85, "community_ids": ["..."]}}]}}, at most {max_length} words."""

# Reduce system prompt: analyst reports arrive ranked by importance; merge
# them, keep [Data: ...] references, answer in the query's language.
REDUCE_SYSTEM_PROMPT = """You are an analyst answering a user's question using the analyst reports below, which are ranked by importance (higher importance score first). Merge them into one coherent markdown answer.
1. Do not mention the individual analysts or their reports.
2. Use ONLY information present in the reports; do not add claims they do not support.
3. Keep the per-claim [Data: Communities (...)] references attached to the claims they support.
4. Answer in the same language as the user's question.
5. If the reports do not contain enough information to answer, say what is missing instead of guessing.
Answer in at most {max_length} words."""

# Rate system prompt: GraphRAG-style relevance rating for community reports.
# LLM rates 0-10 how relevant a community report is to the user's question.
# Chinese to match the pipeline's convention (semantics identical to GraphRAG's RATE_QUERY).
RATE_SYSTEM_PROMPT = """你是知识图谱搜索系统的相关性评分员。给定用户问题和社区报告，请评估该报告与回答问题的相关程度。
评分标准：0（完全不相关）到 10（直接回答问题）。
只回复一个 0 到 10 之间的整数。"""


def estimate_tokens(text: str) -> int:
    """Conservative char-based token estimate ([!RED R3]).

    kl-graph has no tokenizer; for CJK-heavy text ~1 token per 1.5 characters
    is a usable approximation, and the budget safety margin
    (:data:`BUDGET_SAFETY_FACTOR`) absorbs the estimation error. Only used to
    cap TRANSIENT prompt material — never stored content.

    Args:
        text: Any prompt fragment.

    Returns:
        Estimated token count (0 for empty input).
    """
    if not text:
        return 0
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def effective_budget(tokens: int) -> int:
    """Apply the explicit safety margin to a configured token budget."""
    return max(1, math.floor(tokens * BUDGET_SAFETY_FACTOR))


def community_ref(level: int, community_id: int) -> str:
    """Canonical citation id for a community, e.g. ``"L1-12"``.

    Args:
        level: Integer level (0, 1, 2, ...).
        community_id: Cluster id at that level.

    Returns:
        Formatted reference string.
    """
    return f"L{level}-{community_id}"


def clamp_citations(community_ids: Sequence[str]) -> list[str]:
    """Clamp a citation list to :data:`CITATION_LIMIT` ids plus ``"+more"``.

    Args:
        community_ids: Cited community ids in priority order.

    Returns:
        At most 5 leading ids, with ``"+more"`` appended when truncated.
    """
    ids = list(community_ids)
    if len(ids) <= CITATION_LIMIT:
        return ids
    return [*[str(c) for c in ids[:CITATION_LIMIT]], MORE_MARKER]


# Model-authored citation brackets in point descriptions. The bracket text is
# NEVER trusted: before evidence reaches the reduce prompt it is rewritten
# from the validated ``community_ids`` field, so a map point cannot smuggle
# more than five ids past the clamp.
_DATA_CITATION_RE = re.compile(r"\[Data:\s*Communities\s*\([^\]]*\)\]")


def canonical_citation(community_ids: Sequence[str]) -> str:
    """Canonical ``[Data: Communities (...)]`` bracket, clamped 5 + '+more'."""
    return "[Data: Communities ({})]".format(", ".join(clamp_citations(community_ids)))


def normalize_point_citations(description: str, community_ids: Sequence[str]) -> str:
    """Rewrite a point's citation from its VALIDATED ids, clamped.

    Any model-authored ``[Data: Communities (...)]`` bracket in the
    description is replaced by the canonical bracket derived from
    ``community_ids`` (five ids plus ``+more``); a description without a
    bracket gets one appended. With no validated ids there is nothing
    canonical to write, so the description is returned untouched.

    Args:
        description: Model-authored point description.
        community_ids: Validated community ids for the point.

    Returns:
        Description whose citation is canonical and clamped.
    """
    if not community_ids:
        return description
    canonical = canonical_citation(community_ids)
    if _DATA_CITATION_RE.search(description):
        return _DATA_CITATION_RE.sub(lambda _m: canonical, description)
    return f"{description} {canonical}"


def _new_diagnostics() -> dict[str, Any]:
    """Fresh diagnostics dict with the documented key set."""
    return {
        "rating_calls": 0,
        "ratings_kept": 0,
        "rating_budget_hit": False,
        "summaries_selected": 0,
        "map_calls": 0,
        "map_batches_ok": 0,
        "map_batches_parse_failed": 0,
        "map_batches_error": 0,
        "points_total": 0,
        "points_kept": 0,
        "reduce_called": False,
        "llm_errors": [],
    }


def parse_rate_response(raw: str) -> int | None:
    """Parse an integer rating (0-10) from the LLM response.

    Args:
        raw: Raw LLM response text.

    Returns:
        Integer rating 0-10, or None if parsing fails.
    """
    text = raw.strip()
    # Try to extract an integer from the response
    match = re.search(r"\b(\d+)\b", text)
    if match:
        rating = int(match.group(1))
        if 0 <= rating <= 10:
            return rating
    return None


@dataclass
class GlobalSearchResult:
    """Outcome of one global search.

    Attributes:
        answer: Final markdown answer, or :data:`NO_DATA_ANSWER`.
        reason: One of ``"ok"``, ``"no_communities"``, ``"no_points"``,
            ``"error"``.
        communities: Selected community metadata dicts with ``level``,
            ``community_id``, ``member_count`` keys.
        citations: Community ids actually cited (``"L1-12"`` style), deduped
            in first-seen (importance) order.
        diagnostics: Counts + ``llm_errors``; see :func:`_new_diagnostics`.
        latency_ms: Wall-clock latency of the whole search.
    """

    answer: str
    reason: str
    communities: list[dict[str, Any]] = field(default_factory=list)
    citations: list[str] = field(default_factory=list)
    diagnostics: dict[str, Any] = field(default_factory=_new_diagnostics)
    latency_ms: float = 0.0


class GlobalSearch:
    """GraphRAG-style global search over community summaries.

    Example:
        search = GlobalSearch(conn, acomplete=my_litellm_wrapper)
        result = await search.search("我最近的任务是什么", user_entity_id="")

    Rate-then-descend selection starts from level-0 roots, LLM-rates each
    report's relevance to the query, keeps ratings ≥ threshold, descends into
    children of kept communities via parent links, and continues through all
    existing hierarchy levels. Selected reports are packed into token-budgeted
    batches for the map step, then reduced into a single grounded answer.
    """

    def __init__(
        self,
        conn: sqlite3.Connection | None = None,
        *,
        conn_provider: Callable[[], sqlite3.Connection] | None = None,
        acomplete: Callable[[str, str], Awaitable[str]] | None = None,
        levels: Iterable[str] | None = None,
        max_communities: int | None = None,
        map_budget: int | None = None,
        reduce_budget: int | None = None,
        map_max_tokens: int | None = None,
        reduce_max_tokens: int | None = None,
        map_concurrency: int | None = None,
        shuffle_seed: int | None = None,
    ) -> None:
        """Wire dependencies; every knob defaults to ``kl_graph.config``.

        Args:
            conn: SQLite connection holding ``communities`` and
                ``community_summaries``. Mutually exclusive with
                ``conn_provider``.
            conn_provider: Zero-arg callable returning such a connection
                (lets a server hand out per-thread handles).
            acomplete: Async completion callable
                ``acomplete(system: str, user: str) -> str``; the server wraps
                ``litellm.acompletion`` here. Required.
            levels: Ignored (kept for signature stability). Levels are now
                enumerated dynamically from community_summaries.
            max_communities: Ignored (kept for signature stability). Replaced
                by token-budgeted batching.
            map_budget: Prompt-input budget (estimated tokens) per map batch.
            reduce_budget: Prompt-input budget (estimated tokens) for the
                reduce call.
            map_max_tokens: Advertised map output limit.
            reduce_max_tokens: Advertised reduce output limit.
            map_concurrency: Max concurrent map calls.
            shuffle_seed: Ignored (kept for signature stability). Selection
                is now query-driven by relevance rating.

        Raises:
            ValueError: If neither or both connection sources are given, or
                ``acomplete`` is missing.
        """
        if (conn is None) == (conn_provider is None):
            raise ValueError("provide exactly one of conn / conn_provider")
        if acomplete is None:
            raise ValueError("acomplete is required")
        self._conn = conn
        self._conn_provider = conn_provider
        self._acomplete = acomplete
        # levels, max_communities, shuffle_seed are accepted but ignored
        self.map_budget = map_budget if map_budget is not None else GLOBAL_SEARCH_MAP_BUDGET
        self.reduce_budget = reduce_budget if reduce_budget is not None else GLOBAL_SEARCH_REDUCE_BUDGET
        self.map_max_tokens = (
            map_max_tokens if map_max_tokens is not None else GLOBAL_SEARCH_MAP_MAX_TOKENS
        )
        self.reduce_max_tokens = (
            reduce_max_tokens if reduce_max_tokens is not None else GLOBAL_SEARCH_REDUCE_MAX_TOKENS
        )
        self.map_concurrency = (
            map_concurrency if map_concurrency is not None else GLOBAL_SEARCH_MAP_CONCURRENCY
        )

    # ── connection handling ────────────────────────────────────────────────

    def _sqlite(self) -> sqlite3.Connection:
        """Resolve the injected connection (or provider) for this call."""
        if self._conn is not None:
            return self._conn
        assert self._conn_provider is not None
        return self._conn_provider()

    # ── rate-then-descend selection ────────────────────────────────────────

    def _enumerate_levels(self) -> list[int]:
        """Find all levels present in community_summaries, sorted ascending.

        Returns:
            Sorted list of integer levels (e.g., [0, 1, 2, 3]), or empty
            list if table missing or empty.
        """
        conn = self._sqlite()
        has_table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'community_summaries'"
        ).fetchone()
        if not has_table:
            return []
        rows = conn.execute(
            "SELECT DISTINCT level FROM community_summaries ORDER BY level"
        ).fetchall()
        return [r[0] for r in rows]

    def _table_columns(self, table: str) -> set[str]:
        """Return the column names of ``table`` (empty set if it does not exist)."""
        conn = self._sqlite()
        try:
            return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        except sqlite3.OperationalError:
            return set()

    def _current_uuid_resolution(self) -> tuple[dict[tuple[int, int], str], bool]:
        """Return ``((level, cluster_id) -> community_uuid), map_present``.

        Resolves ONLY the single latest identity run (the max ``rowid`` in
        ``community_identity_map`` identifies it), so a ``(level, cluster_id)``
        that is absent from the current partition has NO entry — callers can
        then exclude a summary bound to an obsolete label. Returns
        ``({}, False)`` when the identity map is absent (older DBs), signalling
        the guard should degrade to legacy behavior.
        """
        conn = self._sqlite()
        has_map = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_identity_map'"
        ).fetchone()
        if not has_map:
            return {}, False
        latest = conn.execute(
            "SELECT run_id FROM community_identity_map ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        if not latest:
            return {}, True
        latest_run = latest[0]
        rows = conn.execute(
            "SELECT level, cluster_id, community_uuid FROM community_identity_map "
            "WHERE run_id = ?",
            (latest_run,),
        ).fetchall()
        return {(int(r[0]), int(r[1])): r[2] for r in rows}, True

    def _read_all_summaries(self, levels: list[int]) -> dict[tuple[int, int], dict[str, Any]]:
        """Read valid summaries into a lookup dict keyed by (level, community_id).

        Reports are resolved through the stable ``community_uuid`` (Task 1/2):

        * Rows flagged ``summary_stale`` are skipped (awaiting regeneration).
        * When the identity map is present, a row whose stored
          ``community_uuid`` no longer matches the current resolution of its
          ``(level, community_id)`` is skipped — this is the misattribution
          guard that prevents a retained summary from being served for a
          renumbered cluster. Safe omission is always preferred over serving a
          possibly-wrong report.
        * Empty summaries are skipped (unchanged behavior).

        Backward compatible: if ``community_uuid`` / ``summary_stale`` columns
        or the identity map are absent (a DB from the current full pipeline),
        the guards degrade to the legacy behavior.

        Args:
            levels: List of integer levels to read.

        Returns:
            Dict mapping (level_int, community_id_int) → summary dict with keys:
            level, community_id, member_count, title, summary, tags,
            community_uuid.
        """
        conn = self._sqlite()
        cols = self._table_columns("community_summaries")
        has_uuid = "community_uuid" in cols
        has_stale = "summary_stale" in cols
        current_resolution, map_present = self._current_uuid_resolution()

        select_cols = "level, community_id, member_count, title, summary, tags"
        select_cols += ", community_uuid" if has_uuid else ", NULL AS community_uuid"
        select_cols += ", summary_stale" if has_stale else ", 0 AS summary_stale"

        all_summaries: dict[tuple[int, int], dict[str, Any]] = {}
        for level in levels:
            rows = conn.execute(
                f"SELECT {select_cols} FROM community_summaries WHERE level = ?",
                (level,),
            ).fetchall()
            for r in rows:
                level_i, cid_i = int(r[0]), int(r[1])
                stored_uuid = r[6]
                stale = int(r[7] or 0)
                if stale:
                    continue  # deferred / awaiting regeneration
                summary_text = r[4] if r[4] is not None else ""
                if not summary_text.strip():
                    continue  # Skip empty summaries
                # Stable-identity guards, active ONLY when a current identity
                # map exists (backward compatible: legacy DBs with no map fall
                # through to legacy serving). Safe OMISSION is always preferred
                # over serving a possibly-misattributed report (Q10: exclude).
                if map_present:
                    current_uuid = current_resolution.get((level_i, cid_i))
                    if current_uuid is None:
                        # This label is not in the current partition at all
                        # (obsolete/renumbered-away) -> exclude entirely.
                        continue
                    if stored_uuid is None:
                        # Report predates identity binding; without a stored
                        # UUID we cannot prove it belongs to the current
                        # community -> exclude rather than risk misattribution.
                        logger.debug(
                            "global search: omitting UUID-less report L%d-%d "
                            "while identity map is present", level_i, cid_i,
                        )
                        continue
                    if current_uuid != stored_uuid:
                        logger.debug(
                            "global search: omitting misattributed summary L%d-%d "
                            "(stored uuid %s != current %s)",
                            level_i, cid_i, stored_uuid, current_uuid,
                        )
                        continue
                tags_str = r[5] if r[5] is not None else "[]"
                try:
                    tags_list = json.loads(tags_str) if isinstance(tags_str, str) else tags_str
                except (json.JSONDecodeError, TypeError):
                    tags_list = []
                all_summaries[(level_i, cid_i)] = {
                    "level": level_i,
                    "community_id": cid_i,
                    "member_count": int(r[2] or 0),
                    "title": r[3] if r[3] is not None else "",
                    "summary": summary_text,
                    "tags": tags_list,
                    "community_uuid": stored_uuid,
                }
        return all_summaries

    def _build_parent_links(
        self, all_summaries: dict[tuple[int, int], dict[str, Any]]
    ) -> tuple[dict[str, tuple[int, int]], dict[str, list[str]]]:
        """Build parent-child link mappings from the communities table.

        Hierarchy traversal uses the ``communities`` table, whose ``id`` /
        ``parent_id`` are ``community_id_from(level, cluster_id)`` tokens written
        by the (unchanged) community projection. Task 4 must NOT alter that
        projection, so traversal is performed in that same token domain: each
        current summary's ``(level, cluster_id)`` maps to its
        ``community_id_from`` token, which is exactly what the table stores.

        This is orthogonal to the misattribution guard in
        :meth:`_read_all_summaries`, which uses the *stable stored*
        ``community_uuid`` to decide whether a row may be served at all. By the
        time we build links here, ``all_summaries`` already contains only
        correctly-attributed rows, so descending in the projection token domain
        is safe and — unlike joining stable UUIDs against projection tokens —
        actually matches the table.

        Args:
            all_summaries: Dict of (level, community_id) → summary dict.

        Returns:
            Tuple of:
            - token_to_key: dict mapping projection token → (level, community_id)
            - parent_to_children: dict mapping parent token → list of child tokens
        """
        conn = self._sqlite()
        # Internal traversal token = community_id_from(level, cid), the SAME
        # domain the communities table uses. Consistent for every summary.
        token_to_key: dict[str, tuple[int, int]] = {}
        for (level, cid) in all_summaries:
            token = community_id_from(f"L{level}", cid)
            token_to_key[token] = (level, cid)

        has_communities = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'communities'"
        ).fetchone()
        if not has_communities:
            # No communities table — can't descend, treat all as roots.
            return token_to_key, {}

        parent_to_children: dict[str, list[str]] = defaultdict(list)
        try:
            rows = conn.execute(
                "SELECT id, parent_id FROM communities WHERE parent_id IS NOT NULL"
            ).fetchall()
            for child_token, parent_token in rows:
                if parent_token and child_token in token_to_key:
                    parent_to_children[parent_token].append(child_token)
        except sqlite3.OperationalError:
            # parent_id column might not exist in old DBs — gracefully degrade
            logger.debug("communities table missing parent_id column, no descent possible")

        return token_to_key, dict(parent_to_children)

    async def _rate_community(
        self,
        summary: dict[str, Any],
        query: str,
        diagnostics: dict[str, Any],
        sem: asyncio.Semaphore,
    ) -> int:
        """Rate one community report's relevance to the query (0-10).

        Args:
            summary: Summary dict with title, summary keys.
            query: User's question.
            diagnostics: Mutable diagnostics dict to update.
            sem: Concurrency semaphore.

        Returns:
            Integer rating 0-10, or 0 on parse/LLM failure.
        """
        async with sem:
            title = summary.get("title", "")
            text = summary.get("summary", "")
            user_msg = f"问题：{query}\n\n社区报告：\n标题：{title}\n{text}"
            diagnostics["rating_calls"] += 1
            try:
                resp = await self._acomplete(RATE_SYSTEM_PROMPT, user_msg)
            except Exception as exc:  # noqa: BLE001
                diagnostics["llm_errors"].append(f"rating: {exc}")
                logger.warning("global search rating failed: %s", exc)
                return 0
        rating = parse_rate_response(resp)
        if rating is None:
            logger.debug("global search rating parse failed: %r", resp)
            return 0
        return rating

    async def _select_communities(
        self, query: str, diagnostics: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Rate-then-descend selection over the community hierarchy.

        Starts from level-0 roots (or all summaries if no parent links available),
        LLM-rates each report's relevance, keeps ratings ≥ threshold, descends
        into children of kept communities via parent links, and continues through
        all existing hierarchy levels until budget exhausted.

        Args:
            query: User's question.
            diagnostics: Mutable diagnostics dict to update.

        Returns:
            List of selected summary dicts in selection order (roots first,
            then children of kept communities, etc.).
        """
        levels = self._enumerate_levels()
        if not levels:
            return []

        all_summaries = self._read_all_summaries(levels)
        if not all_summaries:
            return []

        token_to_key, parent_to_children = self._build_parent_links(all_summaries)

        # Determine roots: level-0 communities, or all if no parent links
        if levels and levels[0] == 0:
            roots = [key for key in all_summaries if key[0] == 0]
        else:
            # No level 0 — use all summaries as candidates (flat selection)
            roots = list(all_summaries.keys())

        selected: list[dict[str, Any]] = []
        rating_sem = asyncio.Semaphore(RATE_CONCURRENCY)
        rating_count = 0

        # Queue-based descent: start with roots, rate them, queue children of kept
        queue = roots
        while queue and rating_count < MAX_RATINGS_PER_QUERY:
            # Rate all in current queue (bounded by semaphore and budget)
            batch_size = min(len(queue), MAX_RATINGS_PER_QUERY - rating_count)
            batch = queue[:batch_size]
            queue = queue[batch_size:]

            # Concurrent rating
            rating_tasks = [
                self._rate_community(all_summaries[key], query, diagnostics, rating_sem)
                for key in batch
            ]
            ratings = await asyncio.gather(*rating_tasks)
            rating_count += len(batch)

            # Keep those >= threshold, add to selected, queue their children
            kept_tokens: list[str] = []
            for key, rating in zip(batch, ratings):
                if rating >= RATE_THRESHOLD:
                    diagnostics["ratings_kept"] += 1
                    selected.append(all_summaries[key])
                    # Find this community's projection token and queue children
                    for token, mapped_key in token_to_key.items():
                        if mapped_key == key:
                            kept_tokens.append(token)
                            break

            # Add children of kept communities to next queue
            for parent_token in kept_tokens:
                children = parent_to_children.get(parent_token, [])
                for child_token in children:
                    child_key = token_to_key.get(child_token)
                    if child_key and child_key in all_summaries:
                        queue.append(child_key)

        if rating_count >= MAX_RATINGS_PER_QUERY and queue:
            diagnostics["rating_budget_hit"] = True
            logger.info(
                "global search: rating budget hit (%d/%d), %d candidates unprocessed",
                rating_count,
                MAX_RATINGS_PER_QUERY,
                len(queue),
            )

        return selected

    # ── budget accounting ([!RED R3]) ─────────────────────────────────────

    def _map_material_budget(self, query: str) -> int:
        """Map tokens left for rows after reserving fixed prompt overhead.

        The system prompt and the question framing are transient prompt
        material too, so their estimated cost is reserved before any row is
        admitted.
        """
        overhead = estimate_tokens(
            MAP_SYSTEM_PROMPT.format(max_length=self.map_max_tokens)
            + f"Question: {query}\n\n"
        )
        return max(0, effective_budget(MAX_DATA_TOKENS) - overhead)

    def _reduce_material_budget(self, query: str) -> int:
        """Reduce tokens left for evidence after reserving fixed overhead."""
        overhead = estimate_tokens(
            REDUCE_SYSTEM_PROMPT.format(max_length=self.reduce_max_tokens)
            + f"Question: {query}\n\n"
        )
        return max(0, effective_budget(self.reduce_budget) - overhead)

    # ── map step ───────────────────────────────────────────────────────────

    @staticmethod
    def _render_row(summary: dict[str, Any]) -> str:
        """Render one selected summary as a map-prompt row (full text)."""
        ref = community_ref(int(summary["level"]), int(summary["community_id"]))
        tags_str = summary.get("tags", [])
        if isinstance(tags_str, list):
            tags_str = json.dumps(tags_str, ensure_ascii=False)
        return (
            f"[{ref}] level=L{summary['level']} | community_id={summary['community_id']} "
            f"| members={summary['member_count']} | tags={tags_str}\n"
            f"{summary['summary']}"
        )

    def _pack_batches(
        self, summaries: list[dict[str, Any]], query: str
    ) -> list[list[dict[str, Any]]]:
        """Pack selected summaries into map batches under the HARD budget.

        The budget is the (safety-margined) MAX_DATA_TOKENS minus the reserved
        system-prompt + question overhead ([!RED R3]); only WHOLE rows that
        fit the remainder are admitted. A row larger than the entire material
        budget is dropped whole — never sent alone over budget, never sliced.
        """
        budget = self._map_material_budget(query)
        batches: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        used = 0
        for s in summaries:
            cost = estimate_tokens(self._render_row(s) + "\n\n")
            if cost > budget:
                continue  # oversized row dropped whole (hard cap, [!RED R3])
            if current and used + cost > budget:
                batches.append(current)
                current, used = [], 0
            current.append(s)
            used += cost
        if current:
            batches.append(current)
        return batches

    def _parse_points(self, raw: str) -> list[dict[str, Any]] | None:
        """Parse one strict-JSON map response ([!RED R4] parse half).

        Returns:
            Valid points (non-empty description, int score in [0, 100];
            out-of-range / wrong-type scores are dropped per point), or
            ``None`` when the payload is malformed JSON or a bad schema — the
            caller counts that as a parse-discard, distinct from transport
            errors.
        """
        text = raw.strip()
        fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
        if fence:
            text = fence.group(1).strip()
        try:
            payload = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        points = payload.get("points")
        if not isinstance(points, list):
            return None
        parsed: list[dict[str, Any]] = []
        for p in points:
            if not isinstance(p, dict):
                continue
            description = p.get("description")
            score = p.get("score")
            if not isinstance(description, str) or not description.strip():
                continue
            # bool is an int subclass — reject it explicitly.
            if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= 100:
                continue
            ids = p.get("community_ids")
            if not isinstance(ids, list):
                ids = []
            parsed.append(
                {
                    "description": description.strip(),
                    "score": score,
                    "community_ids": [str(c) for c in ids if isinstance(c, (str, int))],
                }
            )
        return parsed

    async def _map_batch(
        self,
        batch: list[dict[str, Any]],
        query: str,
        diagnostics: dict[str, Any],
        sem: asyncio.Semaphore,
    ) -> list[dict[str, Any]]:
        """One map LLM call; never raises ([!RED R4]).

        Transport/auth/quota exceptions bump ``map_batches_error`` and record
        the message in ``llm_errors`` (visible); malformed JSON / bad schema
        bumps ``map_batches_parse_failed`` instead. Both discard the batch.
        """
        async with sem:
            rows_text = "\n\n".join(self._render_row(s) for s in batch)
            system = MAP_SYSTEM_PROMPT.format(max_length=self.map_max_tokens)
            user = f"Question: {query}\n\n{rows_text}"
            try:
                resp = await self._acomplete(system, user)
            except Exception as exc:  # noqa: BLE001 — per-batch failures are non-fatal
                diagnostics["map_batches_error"] += 1
                diagnostics["llm_errors"].append(f"map: {exc}")
                logger.warning("global search map batch failed: %s", exc)
                return []
        points = self._parse_points(resp)
        if points is None:
            diagnostics["map_batches_parse_failed"] += 1
            return []
        diagnostics["map_batches_ok"] += 1
        return points

    # ── reduce step ────────────────────────────────────────────────────────

    def _serialize_evidence(self, points: list[dict[str, Any]], query: str) -> list[str]:
        """Serialize score-filtered points as analyst blocks under the HARD budget.

        Points arrive stable-sorted by score DESC; blocks are appended in that
        order while they fit the (safety-margined) reduce budget minus the
        reserved system-prompt + question overhead ([!RED R3]), so the cap
        drops the LOWEST-priority blocks whole. Each block's citation is
        normalized from the point's validated ``community_ids`` before
        serialization — the model-authored bracket is never trusted. When
        even the top block does not fit, nothing is admitted and the caller
        takes the no-data path without a reduce call.
        """
        budget = self._reduce_material_budget(query)
        blocks: list[str] = []
        used = 0
        for i, p in enumerate(points, 1):
            block = (
                f"----Analyst {i}----\n"
                f"Importance Score: {p['score']}\n"
                f"{normalize_point_citations(p['description'], p['community_ids'])}"
            )
            cost = estimate_tokens(block + "\n\n")
            if used + cost > budget:
                break
            blocks.append(block)
            used += cost
        return blocks

    # ── orchestration ──────────────────────────────────────────────────────

    async def search(
        self, query: str, user_entity_id: str = ""
    ) -> GlobalSearchResult:
        """Run rate-then-descend → map → reduce for one conceptual question.

        Args:
            query: The user's question (any language; answered in kind).
            user_entity_id: Ignored (kept for signature stability). Identity
                resolution is deleted; selection is now query-driven.

        Returns:
            GlobalSearchResult; ``NO_DATA_ANSWER`` with zero LLM calls when
            no summaries exist, and with zero reduce calls when no map point
            survives the score-0 filter OR no evidence block fits the
            overhead-adjusted reduce budget ([!RED R3] hard cap).
        """
        started = time.perf_counter()
        diagnostics = _new_diagnostics()

        def _latency_ms() -> float:
            return (time.perf_counter() - started) * 1000.0

        # Rate-then-descend selection
        selected = await self._select_communities(query, diagnostics)
        diagnostics["summaries_selected"] = len(selected)
        if not selected:
            return GlobalSearchResult(
                answer=NO_DATA_ANSWER,
                reason=REASON_NO_COMMUNITIES,
                diagnostics=diagnostics,
                latency_ms=_latency_ms(),
            )

        community_meta = [
            {
                "level": s["level"],
                "community_id": s["community_id"],
                "member_count": s["member_count"],
            }
            for s in selected
        ]

        # MAP: one concurrent call per budget-packed batch.
        batches = self._pack_batches(selected, query)
        diagnostics["map_calls"] = len(batches)
        sem = asyncio.Semaphore(max(1, self.map_concurrency))
        batch_points = await asyncio.gather(
            *(self._map_batch(b, query, diagnostics, sem) for b in batches)
        )
        points = [p for batch in batch_points for p in batch]
        diagnostics["points_total"] = len(points)

        # REDUCE prep: drop score-0 points, stable-sort by score DESC.
        kept = [p for p in points if int(p["score"]) > 0]
        kept.sort(key=lambda p: -int(p["score"]))
        diagnostics["points_kept"] = len(kept)
        if not kept:
            return GlobalSearchResult(
                answer=NO_DATA_ANSWER,
                reason=REASON_NO_POINTS,
                communities=community_meta,
                diagnostics=diagnostics,
                latency_ms=_latency_ms(),
            )

        evidence = self._serialize_evidence(kept, query)
        if not evidence:
            # Hard cap ([!RED R3]): even the top block does not fit the
            # overhead-adjusted reduce budget — grounded no-data WITHOUT a
            # reduce call rather than an over-budget prompt.
            return GlobalSearchResult(
                answer=NO_DATA_ANSWER,
                reason=REASON_NO_POINTS,
                communities=community_meta,
                diagnostics=diagnostics,
                latency_ms=_latency_ms(),
            )
        system = REDUCE_SYSTEM_PROMPT.format(max_length=self.reduce_max_tokens)
        user = f"Question: {query}\n\n" + "\n\n".join(evidence)
        try:
            raw_answer = await self._acomplete(system, user)
        except Exception as exc:  # noqa: BLE001 — surfaced, never fabricated
            diagnostics["llm_errors"].append(f"reduce: {exc}")
            logger.warning("global search reduce failed: %s", exc)
            return GlobalSearchResult(
                answer=NO_DATA_ANSWER,
                reason=REASON_ERROR,
                communities=community_meta,
                diagnostics=diagnostics,
                latency_ms=_latency_ms(),
            )
        diagnostics["reduce_called"] = True

        # Citations: clamped per point, deduped in importance order.
        citations: list[str] = []
        seen: set[str] = set()
        for p in kept:
            for cid in clamp_citations(p["community_ids"]):
                if cid == MORE_MARKER or cid in seen:
                    continue
                seen.add(cid)
                citations.append(cid)

        answer = (raw_answer or "").strip() or NO_DATA_ANSWER
        return GlobalSearchResult(
            answer=answer,
            reason=REASON_OK,
            communities=community_meta,
            citations=citations,
            diagnostics=diagnostics,
            latency_ms=_latency_ms(),
        )
