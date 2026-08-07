"""Global search: GraphRAG-style map-reduce over community summaries.

Answers *conceptual* questions (e.g. "我最近的任务是什么") that no single
vector hit can recall: select the current user's entity-community summaries,
map them in token-budgeted batches into importance-scored key points (strict
JSON), then reduce the survivors into one grounded markdown answer with
``[Data: Communities (...)]`` citations.

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
import random
import re
import sqlite3
import time
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, field
from itertools import groupby
from typing import Any

from kl_graph.config import cfg

logger = logging.getLogger(__name__)

# Derived constants from OmegaConf config
GLOBAL_SEARCH_LEVELS = cfg.pipelines.query.global_search.levels
GLOBAL_SEARCH_MAP_BUDGET = int(cfg.pipelines.query.global_search.map_budget)
GLOBAL_SEARCH_MAP_CONCURRENCY = int(cfg.pipelines.query.global_search.map_concurrency)
GLOBAL_SEARCH_MAP_MAX_TOKENS = int(cfg.pipelines.query.global_search.map_max_tokens)
GLOBAL_SEARCH_MAX_COMMUNITIES = int(cfg.pipelines.query.global_search.max_communities)
GLOBAL_SEARCH_REDUCE_BUDGET = int(cfg.pipelines.query.global_search.reduce_budget)
GLOBAL_SEARCH_REDUCE_MAX_TOKENS = int(cfg.pipelines.query.global_search.reduce_max_tokens)
GLOBAL_SEARCH_SHUFFLE_SEED = int(cfg.pipelines.query.global_search.shuffle_seed)

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


def parse_levels(spec: str) -> list[str]:
    """Parse a comma-separated levels spec, preserving order, deduped.

    Args:
        spec: e.g. ``"L0,L1,L2,L3"``.

    Returns:
        Ordered unique level names (``["L0", "L1", "L2", "L3"]``).
    """
    levels: list[str] = []
    seen: set[str] = set()
    for part in spec.split(","):
        level = part.strip()
        if level and level not in seen:
            seen.add(level)
            levels.append(level)
    return levels


def community_ref(level: str, community_id: int) -> str:
    """Canonical citation id for a community, e.g. ``"L1-12"``."""
    return f"{level}-{community_id}"


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


def normalize_point_citation(description: str, community_ids: Sequence[str]) -> str:
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
    """GraphRAG-style global search over the user's community summaries.

    Example:
        search = GlobalSearch(conn, acomplete=my_litellm_wrapper)
        result = await search.search("我最近的任务是什么", user_entity_id)

    The map step runs its batches concurrently under a bounded semaphore; the
    reduce step is a single LLM call by design (that call IS the aggregation).
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
            conn: SQLite connection holding ``entities`` and
                ``community_summaries``. Mutually exclusive with
                ``conn_provider``.
            conn_provider: Zero-arg callable returning such a connection
                (lets a server hand out per-thread handles).
            acomplete: Async completion callable
                ``acomplete(system: str, user: str) -> str``; the server wraps
                ``litellm.acompletion`` here. Required.
            levels: Community levels to consider (default
                ``GLOBAL_SEARCH_LEVELS``).
            max_communities: Max summaries selected per query.
            map_budget: Prompt-input budget (estimated tokens) per map batch;
                also caps total selected material.
            reduce_budget: Prompt-input budget (estimated tokens) for the
                reduce call.
            map_max_tokens: Advertised map output limit.
            reduce_max_tokens: Advertised reduce output limit.
            map_concurrency: Max concurrent map calls.
            shuffle_seed: Fixed seed for reproducible selection inside
                equal-member-count groups.

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
        self.levels = list(levels) if levels is not None else parse_levels(GLOBAL_SEARCH_LEVELS)
        self.max_communities = (
            max_communities if max_communities is not None else GLOBAL_SEARCH_MAX_COMMUNITIES
        )
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
        self.shuffle_seed = shuffle_seed if shuffle_seed is not None else GLOBAL_SEARCH_SHUFFLE_SEED

    # ── connection handling ────────────────────────────────────────────────

    def _sqlite(self) -> sqlite3.Connection:
        """Resolve the injected connection (or provider) for this call."""
        if self._conn is not None:
            return self._conn
        assert self._conn_provider is not None
        return self._conn_provider()

    # ── selection ──────────────────────────────────────────────────────────

    def select_communities(self, user_entity_id: str) -> list[dict[str, Any]]:
        """Select the user's entity-community summaries, deterministically.

        Reads the authoritative ``community_L*`` columns of the entity, joins
        ``community_summaries`` (``node_type='entity'``), excludes empty
        summaries, dedups ``(level, community_id)``, sorts by ``member_count``
        DESC with a fixed-seed shuffle only inside equal-member-count groups,
        then caps by ``max_communities`` and the (safety-margined) map prompt
        budget — dropping whole lowest-priority rows, never slicing summary
        text. The cap is HARD: a single row larger than the whole budget is
        dropped, not admitted as an exception (the system-prompt + question
        overhead is reserved later, at batch packing, where the query is
        known).

        Args:
            user_entity_id: Canonical entity id of the current user.

        Returns:
            Selected summary dicts with ``level``, ``community_id``,
            ``member_count``, ``summary`` (full text), ``tags`` keys, in
            priority order. Empty when there is no evidence.
        """
        conn = self._sqlite()

        # Community columns are added lazily by scripts.improve; tolerate a
        # database that never ran it (same detection pattern as kl_server).
        cols = {c[1] for c in conn.execute("PRAGMA table_info(entities)").fetchall()}
        levels = [lv for lv in self.levels if f"community_{lv}" in cols]
        if not levels:
            return []

        # The summaries table may also be absent on a never-improved DB.
        has_table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'community_summaries'"
        ).fetchone()
        if not has_table:
            return []

        row = conn.execute(
            "SELECT {} FROM entities WHERE id = ?".format(
                ", ".join(f"community_{lv}" for lv in levels)
            ),
            (user_entity_id,),
        ).fetchone()
        if row is None:
            return []

        # Unique (level, community_id) membership pairs, in level order.
        pairs: list[tuple[str, int]] = []
        seen: set[tuple[str, int]] = set()
        for level, cid in zip(levels, tuple(row)):
            if cid is None:
                continue
            try:
                cid_int = int(cid)
            except (TypeError, ValueError):
                continue
            if (level, cid_int) not in seen:
                seen.add((level, cid_int))
                pairs.append((level, cid_int))

        summaries: list[dict[str, Any]] = []
        for level, cid in pairs:
            r = conn.execute(
                "SELECT level, community_id, member_count, summary, tags "
                "FROM community_summaries "
                "WHERE node_type = 'entity' AND level = ? AND community_id = ?",
                (level, cid),
            ).fetchone()
            if r is None:
                continue
            summary_text = r[3] if r[3] is not None else ""
            if not summary_text.strip():  # exclude empty summaries
                continue
            summaries.append(
                {
                    "level": level,
                    "community_id": cid,
                    "member_count": int(r[2] or 0),
                    "summary": summary_text,  # FULL text — never sliced
                    "tags": r[4] if r[4] is not None else "[]",
                }
            )

        # member_count DESC; seeded shuffle only inside equal-count groups so
        # repeated queries select identically (success-metric determinism).
        summaries.sort(key=lambda s: -int(s["member_count"]))
        rng = random.Random(self.shuffle_seed)
        ordered: list[dict[str, Any]] = []
        for _, group in groupby(summaries, key=lambda s: int(s["member_count"])):
            members = list(group)
            rng.shuffle(members)
            ordered.extend(members)
        ordered = ordered[: self.max_communities]

        # Total prompt-char budget: keep highest-priority whole rows only —
        # HARD cap, so a first row larger than the whole budget is dropped
        # rather than admitted as an exception ([!RED R3]).
        budget = effective_budget(self.map_budget)
        kept: list[dict[str, Any]] = []
        used = 0
        for s in ordered:
            cost = estimate_tokens(self._render_row(s) + "\n\n")
            if used + cost > budget:
                break
            kept.append(s)
            used += cost
        return kept

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
        return max(0, effective_budget(self.map_budget) - overhead)

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
        ref = community_ref(str(summary["level"]), int(summary["community_id"]))
        return (
            f"[{ref}] level={summary['level']} | community_id={summary['community_id']} "
            f"| members={summary['member_count']} | tags={summary['tags']}\n"
            f"{summary['summary']}"
        )

    def _pack_batches(
        self, summaries: list[dict[str, Any]], query: str
    ) -> list[list[dict[str, Any]]]:
        """Pack selected summaries into map batches under the HARD budget.

        The budget is the (safety-margined) map budget minus the reserved
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
                f"{normalize_point_citation(p['description'], p['community_ids'])}"
            )
            cost = estimate_tokens(block + "\n\n")
            if used + cost > budget:
                break
            blocks.append(block)
            used += cost
        return blocks

    # ── orchestration ──────────────────────────────────────────────────────

    async def search(self, query: str, user_entity_id: str) -> GlobalSearchResult:
        """Run select -> map -> reduce for one conceptual question.

        Args:
            query: The user's question (any language; answered in kind).
            user_entity_id: Canonical entity id of the current user (identity
                resolution happens upstream, in the server).

        Returns:
            GlobalSearchResult; ``NO_DATA_ANSWER`` with zero LLM calls when
            nothing is selected, and with zero reduce calls when no map point
            survives the score-0 filter OR no evidence block fits the
            overhead-adjusted reduce budget ([!RED R3] hard cap).
        """
        started = time.perf_counter()
        diagnostics = _new_diagnostics()

        def _latency_ms() -> float:
            return (time.perf_counter() - started) * 1000.0

        selected = self.select_communities(user_entity_id)
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
