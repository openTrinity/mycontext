"""Main ingestion pipeline orchestrator (v2: LLM extraction).

Two-phase design:
  Phase A: Chunking (load + persist + embed; no LLM)
    - Loads every source (chat + non-chat) into unified ``Chunk``s
    - Persists them to SQLite and embeds them into vector-store ``chunks``
    - At end-of-A dense + BM25 retrieval over all sources is usable

  Phase B: Extraction + graph build (LLM; replayable from cache)
    - Calls qwen3.7-plus for entity+fact extraction per chunk (cached)
    - Builds entities, facts, edges in SQLite; embeds entity/fact vectors

You can re-run Phase B with different configurations without
re-running its extraction (the expensive LLM calls are cached).
"""

from __future__ import annotations

import asyncio
import datetime
import hashlib
import itertools
import logging
import re
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from kl_graph.config import DATA_DIR, GRAPH_DB_PATH, LADYBUG_OPTS, _path, cfg

# Derived constants from OmegaConf config
CHAT_DIR = _path(cfg.application.dws_export_dir) / "chat"
EMBED_FLUSH_EVERY = int(cfg.pipelines.ingestion.embedding.flush_every)
ENTITY_DESCRIPTION_CONCURRENCY = int(
    cfg.pipelines.ingestion.entity_description.concurrency
)
ENTITY_DESCRIPTION_SUMMARIZE = bool(
    cfg.pipelines.ingestion.entity_description.summarize
)
GENERIC_SOURCES = tuple(cfg.pipelines.ingestion.generic_sources)
KEEP_EXTRACTION_CACHE = bool(cfg.pipelines.ingestion.keep_extraction_cache)
EXTRACTION_CACHE_MAX_ENTRIES = int(
    cfg.pipelines.ingestion.extraction.cache_max_entries
)
QDRANT_PATH = str(DATA_DIR / "qdrant_data")
SQLITE_PATH = DATA_DIR / "knowledge.db"
from kl_graph.ingest.checkpoint import IngestCheckpoint
from kl_graph.ingest.embedder import Embedder
from kl_graph.ingest.extraction_strategy import build_extraction_items
from kl_graph.ingest.llm_extractor import (
    ExtractionFailure,
    LLMExtractor,
    summarize_entity_descriptions,
)
from kl_graph.ingest.loaders import (
    load_all_messages,
    load_generic,
    load_mail,
    load_minutes,
    load_wiki,
)
from kl_graph.ingest.source_strategy import combine_plans, source_strategy_for
from kl_graph.models.types import (
    Chunk,
    ChunkUnit,
    Edge,
    EdgeType,
    Entity,
    EntityType,
    ExtractionItem,
    ExtractionProjection,
    Fact,
    FactType,
    Scope,
    SourceUnit,
    scope_id_from,
)
from kl_graph.storage.base import KnowledgeStore, create_store
from kl_graph.storage.sqlite_store import SQLiteStore
from kl_graph.storage.vector_store import VectorPoint, VectorStore, create_vector_store

logger = logging.getLogger(__name__)

# ─── Process Lock ────────────────────────────────────────────────────────

INGEST_LOCK_PATH = DATA_DIR / ".ingest.lock"

# Inline-lazy generalize gate (RAGFlow's numbers): an entity whose per-chunk
# descriptions number this many or fewer keeps its raw bullet list and costs no
# tokens; only hub entities above the gate trigger one LLM summarize call.
DESCRIPTION_GATE = 12
# Approximate token budget for the summarize input / the fallback bullet list.
DESCRIPTION_TOKEN_BUDGET = 512
# Chars-per-token ratio used when clipping an over-budget description; matches
# the heuristic in ``_estimate_tokens``.
_CHARS_PER_TOKEN = 4
# Shrink passes allowed after the initial character cut (see _clip_to_tokens).
_CLIP_PASSES = 4


def _estimate_tokens(text: str) -> int:
    """Approximate token count for ``text`` (``cl100k_base`` when available).

    Only used to bound the description summarize input, so an estimate suffices:
    falls back to the usual ~4-chars-per-token heuristic when tiktoken is absent.

    Args:
        text: Text to measure.

    Returns:
        Estimated number of tokens (never negative).
    """
    try:
        import tiktoken
    except Exception:  # noqa: BLE001 - tiktoken is optional
        return max(0, len(text or "") // 4)
    try:
        return len(tiktoken.get_encoding("cl100k_base").encode(text or ""))
    except Exception:  # noqa: BLE001 - offline / no BPE cache
        return max(0, len(text or "") // 4)


def _ordered_unique_descriptions(contributions: list[tuple[int, str]]) -> list[str]:
    """Chronological, deduplicated description texts.

    Ordering is by the source chunk's timestamp (first-seen), which is why the
    timestamp travels alongside each description; ``sorted`` is stable, so
    same-timestamp contributions keep their encounter order. Dedup skips a text
    that already appears **without** reordering (never alphabetical).

    Args:
        contributions: ``(source_chunk_timestamp, description)`` pairs.

    Returns:
        The unique description texts in chronological first-seen order.
    """
    seen: set[str] = set()
    ordered: list[str] = []
    for _, desc in sorted(contributions, key=lambda c: c[0]):
        text = (desc or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        ordered.append(text)
    return ordered


def _clip_to_tokens(text: str, token_budget: int) -> str:
    """Cut ``text`` down to at most roughly ``token_budget`` tokens.

    Only reached when a single description is itself over budget. Starts from a
    cheap character cut at the ~4-chars-per-token heuristic, then shrinks
    proportionally while the estimate is still over: with tiktoken a CJK run
    counts at more than one token per character, so the character cut alone can
    still bust the budget. Converges in a pass or two and only ever shortens, so
    the result is bounded in both characters and tokens.

    Args:
        text: Description text to bound.
        token_budget: Approximate token cap (non-positive yields ``""``).

    Returns:
        ``text`` unchanged when already within budget, else its clipped prefix.
    """
    if token_budget <= 0:
        return ""
    if _estimate_tokens(text) <= token_budget:
        return text
    clipped = text[: token_budget * _CHARS_PER_TOKEN].rstrip()
    for _ in range(_CLIP_PASSES):
        tokens = _estimate_tokens(clipped)
        if not clipped or tokens <= token_budget:
            break
        clipped = clipped[: max(1, len(clipped) * token_budget // tokens)].rstrip()
    return clipped


def _truncate_descriptions(
    descriptions: list[str], token_budget: int = DESCRIPTION_TOKEN_BUDGET
) -> list[str]:
    """Keep the leading descriptions that fit within ``token_budget``.

    Whole descriptions are kept or dropped (never cut mid-sentence). At least one
    is always returned so a single very long description still yields something —
    but a first description that alone busts the budget is clipped, because both
    consumers (the summarize input and the fallback bullet list) promise a bound.

    Args:
        descriptions: Ordered description texts.
        token_budget: Approximate token cap.

    Returns:
        The kept prefix of ``descriptions``, the first entry clipped if needed.
    """
    kept: list[str] = []
    used = 0
    for desc in descriptions:
        cost = _estimate_tokens(desc) + 2  # "- " bullet + newline
        if not kept and cost > token_budget:
            # Oversized sole contribution: bound it instead of returning it whole.
            return [_clip_to_tokens(desc, token_budget)]
        if kept and used + cost > token_budget:
            break
        kept.append(desc)
        used += cost
    return kept


def _as_bullets(descriptions: list[str]) -> str:
    """Render descriptions as newline-joined ``- <desc>`` bullets."""
    return "\n".join(f"- {d}" for d in descriptions)


async def build_entity_description(
    name: str,
    contributions: list[tuple[int, str]],
    *,
    gate: int = DESCRIPTION_GATE,
    token_budget: int = DESCRIPTION_TOKEN_BUDGET,
) -> str:
    """Accumulate one entity's per-chunk descriptions into its stored description.

    Bounded generalization, RAGFlow-style inline + lazy:

    - ``<= gate`` descriptions: keep the raw deduped chronological bullet list;
      the LLM is never called, so cheap entities cost nothing.
    - ``> gate`` descriptions: truncate to ``token_budget`` and fire ONE LLM
      summarize call collapsing them into a single paragraph. If the summarizer
      is unavailable or fails it returns ``None`` and we fall back to the
      truncated bullet list, so a graph build never blocks on the LLM.

    Async so the (few dozen) gated hub-entity summaries can be awaited
    concurrently by the caller instead of one serial blocking call each.

    Args:
        name: Entity name (passed to the summarizer so the paragraph names it).
        contributions: ``(source_chunk_timestamp, description)`` pairs.
        gate: Description count above which the summarize step fires.
        token_budget: Approximate token cap for the summarize input / fallback.

    Returns:
        The description to store (possibly an empty string).
    """
    descriptions = _ordered_unique_descriptions(contributions)
    if not descriptions:
        return ""
    if len(descriptions) <= gate:
        return _as_bullets(descriptions)

    bounded = _truncate_descriptions(descriptions, token_budget)
    # Best-effort LLM collapse; skip entirely when disabled so a flaky/slow
    # summarizer gateway can never stall a build (bullets remain a valid store).
    if not ENTITY_DESCRIPTION_SUMMARIZE:
        return _as_bullets(bounded)
    # Module-level lookup on purpose: tests monkeypatch this name to assert the
    # gate without touching a live LLM.
    summary = await summarize_entity_descriptions(name, bounded)
    if summary:
        return summary.strip()
    logger.warning(
        "description summarize unavailable for %r; keeping %d/%d bullets",
        name,
        len(bounded),
        len(descriptions),
    )
    return _as_bullets(bounded)


# ─── Normalization helpers ───────────────────────────────────────────────


def normalize_entity_name(name: str) -> str:
    """Normalize entity name for dedup (exact match)."""
    return name.strip().lower()


def entity_id_from_name(name: str) -> str:
    """Deterministic ID from normalized entity name."""
    norm = normalize_entity_name(name)
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"entity:{norm}"))


def _fact_id(msg_id: str, fact_text: str) -> str:
    """Deterministic fact ID from extraction identity + full fact text.

    Single source of truth for the fact-id formula. Both ``_build_facts`` and
    ``_create_edges`` MUST derive the id through this helper so the two
    computations cannot diverge (a divergence would silently orphan STATES/ABOUT
    edges from their fact). Uses the *full* ``fact_text`` (not a prefix slice) so
    two distinct facts from the same chunk whose leading text matches do not
    collide into one node; ``uuid5`` accepts arbitrary-length input.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"fact:{msg_id}:{fact_text}"))


# Fixed UTC+8 offset (China Standard Time): the DingTalk corpus is China time.
# A fixed-offset tz — never the machine's local zone — keeps the derived date
# byte-identical across replays and machines (determinism, global-search U0 R2).
_CHINA_TZ = datetime.timezone(datetime.timedelta(hours=8))

# Cheap idempotence guard: text that already starts with a ``[YYYY-MM-DD] ``
# date bracket (model-produced or imported payloads) is never re-prefixed.
_DATE_PREFIX_RE = re.compile(r"^\[\d{4}-\d{2}-\d{2}\] ")


def _dated_fact_text(text: str, ts: int) -> str:
    """Prefix a fact with its source chunk's date: ``[YYYY-MM-DD] <text>``.

    Temporal grounding (global-search U0): the ``facts.timestamp`` column holds
    the time but the fact TEXT does not, so retrieval/synthesis never sees when
    a fact happened. Applied at Phase-B build time only — the extraction cache
    keeps the raw LLM text, so ``--build-only`` replays re-prefix for free.
    The prefixed text feeds the stored text, the embedding, AND the
    content-derived fact id (rebuild-not-migrate by design).

    The format must stay fixed across rebuilds so cache replays are idempotent
    and text-based recall dedup behaves identically before/after.

    Args:
        text: raw LLM-extracted fact text (already stripped).
        ts: source chunk timestamp in unix milliseconds.

    Returns:
        ``[YYYY-MM-DD] <text>`` when ``ts`` is positive; ``text`` unchanged when
        ``ts`` is 0/missing or negative (never emit ``[1970-01-01]``). Pure and
        deterministic: same input ⇒ byte-identical output. Idempotent: text
        that already starts with a ``[YYYY-MM-DD] `` date bracket is returned
        unchanged, so applying the helper twice is always safe.
    """
    if ts <= 0:
        return text
    if _DATE_PREFIX_RE.match(text):
        return text
    date = datetime.datetime.fromtimestamp(ts / 1000, tz=_CHINA_TZ)
    return f"[{date:%Y-%m-%d}] {text}"


VALID_ENTITY_TYPES = {t.value for t in EntityType}
VALID_FACT_TYPES = {t.value for t in FactType}


def map_entity_type(raw_type: str) -> EntityType:
    """Map LLM output entity type to our enum."""
    raw = raw_type.strip().capitalize()
    if raw in VALID_ENTITY_TYPES:
        return EntityType(raw)
    # Common mappings
    mapping = {
        "Team": EntityType.ORGANIZATION,
        "Concept": EntityType.UNKNOWN,
        "Event": EntityType.UNKNOWN,
        "Tool": EntityType.SYSTEM,
        "Service": EntityType.SYSTEM,
        "Platform": EntityType.SYSTEM,
        "Product": EntityType.SYSTEM,
        "Company": EntityType.ORGANIZATION,
        "Department": EntityType.ORGANIZATION,
        "Group": EntityType.ORGANIZATION,
    }
    return mapping.get(raw, EntityType.UNKNOWN)


def map_fact_type(raw_type: str) -> FactType:
    """Map LLM output fact type to our enum."""
    raw = raw_type.strip().upper()
    if raw in VALID_FACT_TYPES:
        return FactType(raw)
    # Common mappings
    mapping = {
        "OPINION": FactType.GENERAL,
        "INFORMATION": FactType.GENERAL,
        "FACT": FactType.GENERAL,
        "TASK": FactType.DELEGATE,
        "ASSIGNMENT": FactType.DELEGATE,
        "UPDATE": FactType.STATUS,
        "PROGRESS": FactType.STATUS,
        "PLAN": FactType.DECISION,
    }
    return mapping.get(raw, FactType.GENERAL)


def _is_chat(chunk: Chunk) -> bool:
    """Is this chunk a DingTalk chat message?

    Chat is discriminated by ``source_type`` (there is no Message subclass), so
    the chat-only fields in ``metadata`` (conversation_id / sender / reply_to)
    are only read for chunks this returns True for.
    """
    return chunk.source_type == "message"


def _participants_of(chunk: Chunk) -> list[str]:
    """Author/participant names for any chunk, for Person-entity attribution.

    Chat chunks contribute their ``metadata["sender"]``; non-chat sources
    contribute the people recorded in their metadata (mail from/to/cc, calendar
    organizer/attendees, minutes speakers, report creator). Names are returned
    as plain strings; the caller normalizes + dedupes into Person entities and
    AUTHORED_BY edges. Everything is best-effort — missing/oddly-typed fields are
    skipped, never raised.
    """
    names: list[str] = []
    md = chunk.metadata or {}
    # C2: a chat session slice carries every distinct sender in ``senders``
    # (one AUTHORED_BY edge per participant). A single-message or non-chat
    # chunk falls back to the singular ``sender``.
    senders = md.get("senders")
    if isinstance(senders, (list, tuple)):
        names.extend(s for s in senders if isinstance(s, str) and s)
    sender = md.get("sender")
    if isinstance(sender, str) and sender:
        names.append(sender)

    def _add(val):
        if isinstance(val, str):
            names.append(val)
        elif isinstance(val, (list, tuple)):
            names.extend(v for v in val if isinstance(v, str))

    # Known participant-bearing metadata keys across sources.
    for key in ("from", "to", "cc", "organizer", "attendees", "speakers", "creator"):
        if key in md:
            _add(md[key])
    return names


# ─── Scope derivation (chunk → source container) ──────────────────────────

# Container kind per source, using the ``scope_type`` vocabulary in
# ``graph-design.md`` ("conversation", "document", "mail_thread", "meeting",
# "calendar_event"). Any other source falls back to its own ``source_type`` as
# the scope type — a documented default rather than an invented name (the
# vocabulary is open by design).
_SCOPE_TYPE_BY_SOURCE = {
    "message": "conversation",
    "wiki": "document",
    "minutes": "meeting",
    "mail": "mail_thread",
    "calendar": "calendar_event",
}

# Metadata keys, in priority order, that carry a non-chat chunk's source-native
# container id. These are exactly what the loaders already record: the generic
# loader keeps the DWS ``scope_id``, wiki keeps its document ``node_id``, minutes
# its ``meeting_id``, mail its thread ``conversation_id``.
_SCOPE_NATIVE_ID_KEYS = ("scope_id", "node_id", "meeting_id", "conversation_id")

# Metadata keys that carry a human-readable container title.
_SCOPE_TITLE_KEYS = ("conversation_title", "title", "subject")


def scope_of_chunk(chunk: Chunk) -> Scope | None:
    """Derive the source container (:class:`Scope`) one chunk belongs to.

    Chat chunks group by ``metadata["conversation_id"]``; every other source uses
    the container id its loader already carried in ``metadata`` (see
    ``_SCOPE_NATIVE_ID_KEYS``). Pure: no store access, so the derivation is unit
    testable without embeddings or an LLM.

    Args:
        chunk: Any retrieval unit (chat, wiki, mail, …).

    Returns:
        The chunk's Scope, or None when the source records no container — a
        chunk with no known scope simply gets no ``PART_OF`` edge rather than a
        synthetic one.
    """
    md = chunk.metadata or {}
    is_chat = _is_chat(chunk)
    if is_chat:
        native_id = md.get("conversation_id") or ""
    else:
        native_id = ""
        for key in _SCOPE_NATIVE_ID_KEYS:
            val = md.get(key)
            if isinstance(val, str) and val.strip():
                native_id = val.strip()
                break
    if not native_id:
        return None

    title = ""
    for key in _SCOPE_TITLE_KEYS:
        val = md.get(key)
        if isinstance(val, str) and val.strip():
            title = val.strip()
            break
    if not title and not is_chat:
        title = (chunk.source_ref or "").strip()

    source_type = chunk.source_type or "message"
    return Scope(
        id=scope_id_from(source_type, native_id),
        scope_type=_SCOPE_TYPE_BY_SOURCE.get(source_type, source_type),
        title=title,
        # The canonical id is an opaque UUID5, so keep the source-native identity
        # for traceback / re-derivation.
        metadata={"source_type": source_type, "native_id": native_id},
    )


def build_scopes_and_part_of(chunks: list[Chunk]) -> tuple[list[Scope], list[Edge]]:
    """Project chunks onto their Scopes + one ``PART_OF`` edge each (pure).

    Scopes are deduped by their deterministic id, so re-running over the same
    chunks yields the same rows/edges and the store's ``INSERT OR IGNORE``
    keeps it idempotent. Every ``PART_OF`` edge is emitted from the single
    ``chunk`` node type (chat included), so the graph has one content vocabulary.
    Every emitted edge targets a scope present in the returned list, so a caller
    that inserts the scopes first can never write a dangling edge.

    A chunk belongs to exactly one source container, so a repeated chunk id is
    skipped when it resolves to the same scope but raises when it resolves to a
    different one: two ``PART_OF`` edges out of one chunk would break the
    at-most-one-membership invariant, and that only happens on a loader/id bug
    worth surfacing rather than silently double-emitting.

    Args:
        chunks: All retrieval units (chat + non-chat).

    Returns:
        ``(scopes, part_of_edges)`` — deduped scopes, and at most one ``PART_OF``
        edge per chunk (none for a chunk whose source records no container).

    Raises:
        ValueError: A chunk id maps onto two different scopes.
    """
    scopes: dict[str, Scope] = {}
    edges: list[Edge] = []
    scope_by_chunk: dict[str, str] = {}
    for chunk in chunks:
        scope = scope_of_chunk(chunk)
        if scope is None:
            continue
        scopes.setdefault(scope.id, scope)
        prior = scope_by_chunk.get(chunk.id)
        if prior is not None:
            if prior != scope.id:
                raise ValueError(
                    f"chunk {chunk.id!r} maps to conflicting scopes "
                    f"{prior!r} and {scope.id!r}: a chunk can belong to at most "
                    "one source container (PART_OF)"
                )
            continue
        scope_by_chunk[chunk.id] = scope.id
        edges.append(
            Edge(
                source_type="chunk",
                source_id=chunk.id,
                target_type="scope",
                target_id=scope.id,
                edge_type=EdgeType.PART_OF,
            )
        )
    return list(scopes.values()), edges


def build_chat_edges(slices: list[Chunk]) -> list[Edge]:
    """Build TEMPORAL (C4) + REPLY_TO (C3) edges over chat session slices (pure).

    Both edges are chunk→chunk and depend on the session-slice structure, so they
    are extracted here (mirroring :func:`build_scopes_and_part_of`) to keep the
    session-break and quote-resolution logic unit-testable.

    - **TEMPORAL (C4)** chains consecutive slices *within one session* and stops
      at a session break: no edge spans a ``session_start`` boundary or a change
      of ``session_index``, so each session is its own temporal chain (the idle
      gap is precisely the signal that the next session is a separate episode).
    - **REPLY_TO (C3)** resolves each quoted ``openMessageId`` to the slice that
      *contains* it (via ``member_message_ids``) and emits a chunk→chunk edge.
      A quote whose message was not ingested is dropped — its text is already
      inlined into the rendered slice, so no meaning is lost — as is a self-edge
      (the quoted message landed in the same slice).

    Args:
        slices: Chat session-slice chunks (from :func:`slice_chat_sessions`).

    Returns:
        The TEMPORAL + REPLY_TO edges (unordered).
    """
    edges: list[Edge] = []

    # TEMPORAL: group by conversation, order by (session, slice, time), link
    # consecutive slices only within the same session.
    by_conv: dict[str, list[Chunk]] = {}
    for sl in slices:
        by_conv.setdefault(sl.metadata.get("conversation_id", ""), []).append(sl)
    for conv_slices in by_conv.values():
        conv_slices.sort(
            key=lambda m: (
                m.metadata.get("session_index", 0),
                m.metadata.get("slice_index", 0),
                m.timestamp,
            )
        )
        for cur, nxt in itertools.pairwise(conv_slices):
            if nxt.metadata.get("session_start"):
                continue
            if nxt.metadata.get("session_index") != cur.metadata.get("session_index"):
                continue
            edges.append(
                Edge(
                    source_type="chunk",
                    source_id=cur.id,
                    target_type="chunk",
                    target_id=nxt.id,
                    edge_type=EdgeType.TEMPORAL,
                )
            )

    # REPLY_TO: map every member message id to its containing slice, then
    # resolve each slice's quoted ids onto that map.
    slice_by_member: dict[str, str] = {}
    for sl in slices:
        for mid in sl.metadata.get("member_message_ids", []):
            slice_by_member.setdefault(mid, sl.id)
    for sl in slices:
        for quoted_id in sl.metadata.get("reply_to_message_ids", []):
            target_slice = slice_by_member.get(quoted_id)
            if not target_slice or target_slice == sl.id:
                continue
            edges.append(
                Edge(
                    source_type="chunk",
                    source_id=sl.id,
                    target_type="chunk",
                    target_id=target_slice,
                    edge_type=EdgeType.REPLY_TO,
                )
            )
    return edges


# ─── Pipeline ────────────────────────────────────────────────


class IngestionPipeline:
    """Orchestrates the full ingestion process: load → extract (LLM) → embed → store."""

    def __init__(
        self,
        sqlite_path: Path = SQLITE_PATH,
        qdrant_path: str = QDRANT_PATH,
        messages_dir: Path = CHAT_DIR,
        cache_db: Path | None = None,
        max_concurrent_llm: int = 50,
        *,
        cache_max_entries: int = EXTRACTION_CACHE_MAX_ENTRIES,
        store: KnowledgeStore | None = None,
        sqlite: SQLiteStore | None = None,  # backward-compat alias for store
        qdrant: VectorStore | None = None,
        embedder: Embedder | None = None,
        checkpoint: IngestCheckpoint | None = None,
        keep_cache: bool = KEEP_EXTRACTION_CACHE,
        source_id: str = "default",
        incremental_units: bool = False,
        batch_id: str | None = None,
        structural_cache=None,
    ):
        self.messages_dir = messages_dir
        self.sqlite_path = Path(sqlite_path)
        self.qdrant_path = qdrant_path
        # Keep expensive LLM results outside the disposable content database.
        # Deriving from sqlite_path preserves custom data-directory behavior.
        self.cache_db = (
            Path(cache_db)
            if cache_db is not None
            else self.sqlite_path.parent / "extraction_cache.db"
        )
        self.cache_max_entries = int(cache_max_entries)
        self.legacy_cache_db = (
            self.sqlite_path if self.cache_db != self.sqlite_path else None
        )
        self.keep_cache = keep_cache
        self.source_id = source_id
        self.incremental_units = incremental_units
        self.batch_id = batch_id or (
            checkpoint.batch_id if checkpoint is not None else None
        )
        self._workset_unit_count = 0
        self._workset_chunk_count = 0
        self._graph_build_ran = False
        self._sources_loaded = False
        # In-memory structural relationship cache (Optimization 1). When set,
        # improvement_targets uses cache lookups instead of graph-wide edge
        # scans. Structural deltas are applied inside the edge checkpoint after
        # persistence and before that checkpoint is marked complete.
        self.structural_cache = structural_cache

        # Accept injected store (new interface) or legacy sqlite param for
        # backward compatibility (e.g. kl-server injecting a SQLiteStore directly).
        if store is not None:
            injected_store: KnowledgeStore | None = store
        elif sqlite is not None:
            injected_store = sqlite
        else:
            injected_store = None

        # Injected stores (e.g. from a running kl-server that already holds the
        # single-writer vector store) are reused instead of opening new ones.
        self.store: KnowledgeStore | None = injected_store
        self.qdrant: VectorStore | None = qdrant
        self.embedder: Embedder | None = embedder
        self._owns_stores = injected_store is None and qdrant is None
        self.extractor: LLMExtractor | None = None
        self.max_concurrent_llm = max_concurrent_llm

        # Checkpoint for resumable ingestion. When None, all steps run
        # unconditionally (backward-compatible behavior).
        self.checkpoint: IngestCheckpoint | None = checkpoint

        # Accumulators
        self.messages: list[Chunk] = []
        self.messages_by_conv: dict[str, list[Chunk]] = {}
        self.extra_chunks: list[Chunk] = []  # non-chat source chunks
        self.all_entities: dict[str, Entity] = {}  # id → Entity
        self.all_facts: list[Fact] = []
        self.extraction_results: dict[str, dict] = {}  # extraction_item_id -> result
        self.extraction_items: list[ExtractionItem] = []
        self.extraction_failures: list[ExtractionFailure] = []
        self.extraction_projections: list[ExtractionProjection] = []
        self._projection_chunks_by_id: dict[str, Chunk] | None = None
        self.source_units: list[SourceUnit] = []
        self.chunk_units: list[ChunkUnit] = []
        self.units_discovered = 0
        self.units_skipped = 0

        # Process-level advisory lock to prevent concurrent ingestion runs.
        # Only acquired when the pipeline owns its stores (i.e. not injected
        # by kl-server, which manages its own lifecycle).
        self._lock = None
        if self._owns_stores:
            self._acquire_lock()

    def _acquire_lock(self):
        """Acquire an advisory lock to prevent concurrent pipeline runs.

        Uses ``filelock`` (cross-platform) with a zero timeout so it fails
        immediately if another process already holds the lock.
        """
        from filelock import FileLock, Timeout

        INGEST_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        self._lock = FileLock(str(INGEST_LOCK_PATH), timeout=0)
        try:
            self._lock.acquire()
        except Timeout:
            self._lock = None
            raise RuntimeError(
                "Another ingestion pipeline is already running. "
                "Only one instance may run at a time to prevent data corruption. "
                f"(lock file: {INGEST_LOCK_PATH})"
            ) from None

    def _release_lock(self):
        """Release the advisory process lock."""
        if self._lock is not None:
            self._lock.release()
            self._lock = None

    def all_chunks(self) -> list[Chunk]:
        """All retrieval units in one list: chat chunks + non-chat chunks.

        Every source is a :class:`Chunk`, so extraction / entity / fact / edge
        building can iterate this uniformly. Chat-only edges (AUTHORED_BY /
        TEMPORAL / REPLY_TO) still restrict themselves to the chat chunks.
        """
        return [*self.messages, *self.extra_chunks]

    def _validate_extraction_cache_capacity(self, required_entries: int) -> None:
        """Prevent rolling eviction from corrupting the active graph build."""
        if required_entries <= self.cache_max_entries:
            return
        raise RuntimeError(
            "Extraction workset contains "
            f"{required_entries:,} chunks, exceeding the rolling cache limit "
            f"of {self.cache_max_entries:,}. Increase "
            "pipelines.ingestion.extraction.cache_max_entries (or "
            "KL_EXTRACTION_CACHE_MAX_ENTRIES) before extraction so results "
            "needed by the following graph build are not evicted."
        )

    @property
    def workset_unit_count(self) -> int:
        return self._workset_unit_count

    @property
    def workset_chunk_count(self) -> int:
        return self._workset_chunk_count

    def complete_workset(self) -> None:
        """Clean the durable workset after every dependent phase succeeds."""

        if self.batch_id is None:
            return
        self._init_stores()
        self.store.complete_ingest_batch(self.batch_id)

    def improvement_targets(self):
        """Return entity/fact IDs affected by this batch's durable workset.

        Targets are recovered from committed graph state rather than timestamps,
        so this also works after a checkpoint resume where the build steps were
        skipped and their in-memory accumulators were reloaded globally.
        """

        from kl_graph.ingest.improvement import ImprovementTargets

        self._init_stores()
        self._load_workset()
        chunk_ids = {chunk.id for chunk in self.all_chunks()}
        if not chunk_ids:
            return ImprovementTargets()

        fact_ids: set[str] = set()
        ordered_chunks = sorted(chunk_ids)
        for start in range(0, len(ordered_chunks), 500):
            batch = ordered_chunks[start : start + 500]
            placeholders = ",".join("?" for _ in batch)
            rows = self.store.sql_conn.execute(
                "SELECT id FROM facts "
                f"WHERE source_chunk_id IN ({placeholders})",
                batch,
            ).fetchall()
            fact_ids.update(str(row[0]) for row in rows)

        entity_ids: set[str] = set()
        if self.structural_cache is not None:
            # Optimization 1: O(K) cache lookup instead of O(E) edge scans.
            entity_ids = self.structural_cache.entities_for_chunks(chunk_ids)
            if fact_ids:
                entity_ids |= self.structural_cache.entities_for_facts(fact_ids)
        else:
            for chunk_id, entity_id, _props in self.store.scan_edges_by_type(
                ["MENTIONS", "AUTHORED_BY"],
                source_type="chunk",
                target_type="entity",
            ):
                if chunk_id in chunk_ids:
                    entity_ids.add(entity_id)
            if fact_ids:
                for fact_id, entity_id, _props in self.store.scan_edges_by_type(
                    ["ABOUT"], source_type="fact", target_type="entity"
                ):
                    if fact_id in fact_ids:
                        entity_ids.add(entity_id)

        return ImprovementTargets(
            entity_ids=tuple(sorted(entity_ids)),
            fact_ids=tuple(sorted(fact_ids)),
        )

    # ─── Checkpoint reload helpers ─────────────────────────────────────────

    @contextmanager
    def step(self, name: str, *, on_skip=None, params: dict | None = None):
        """Checkpoint-guarded pipeline step (context manager).

        Wraps :meth:`IngestCheckpoint.step` with a None-safe fallback: when no
        checkpoint is configured, always yields a guard with ``skip=False`` and
        ``.done()`` is a no-op.

        Usage::

            with self.step("phase_b.build_entities",
                           on_skip=self._ensure_entities_loaded) as s:
                if s.skip:
                    return
                # ... do the work ...
                s.done(count=len(self.all_entities))

        Args:
            name: Step identifier (checkpoint key).
            on_skip: Callback invoked when the step is already done.
            params: Optional parameters for improve steps.
        """
        if self.checkpoint is not None:
            with self.checkpoint.step(name, on_skip=on_skip, params=params) as guard:
                yield guard
        else:
            from kl_graph.ingest.checkpoint import StepGuard

            yield StepGuard(None, name, skip=False)

    def _ensure_entities_loaded(self):
        """Ensure ``self.all_entities`` is populated (from build or from store).

        Called by downstream steps (create_edges, etc.) that need the entity
        dict. If build_entities was checkpointed (skipped), loads from store.
        """
        if self.all_entities:
            return
        self.all_entities = {e.id: e for e in self.store.iter_all_entities()}
        if self.all_entities:
            print(
                f"  [checkpoint] Reloaded {len(self.all_entities)} entities from store"
            )

    def _ensure_facts_loaded(self):
        """Ensure ``self.all_facts`` is populated (from build or from store)."""
        if self.all_facts:
            return
        self.all_facts = list(self.store.iter_all_facts())
        if self.all_facts:
            print(f"  [checkpoint] Reloaded {len(self.all_facts)} facts from store")

    def _ensure_extraction_loaded(self):
        """Ensure ``self.extraction_results`` is populated (from LLM or cache)."""
        if self.extraction_results:
            return
        self._load_extraction_cache()

    def _restore_extraction_checkpoint(self) -> None:
        """Restore extraction item counts and failures needed by run status."""
        self._init_stores()
        self._load_workset()
        self.extraction_items = build_extraction_items(self.all_chunks())
        if self.checkpoint is None:
            return
        metadata = self.checkpoint.step_metadata("phase_b.extraction")
        failures = metadata.get("failures", [])
        self.extraction_failures = [
            ExtractionFailure(**failure)
            for failure in failures
            if isinstance(failure, dict)
        ]

    def _maybe_clear_extraction_cache(self):
        """Clear the extraction cache table if configured and build succeeded.

        Called at the end of ``run_graph_build()`` after all steps succeed.
        Controlled by ``KL_KEEP_EXTRACTION_CACHE`` env var (default: keep).
        """
        if self.keep_cache:
            return
        if not self._graph_build_ran:
            return
        from kl_graph.ingest.extraction_cache import ExtractionCacheStore

        store = ExtractionCacheStore(
            self.cache_db,
            max_entries=self.cache_max_entries,
            # Clearing must never import the legacy cache just to delete it.
            legacy_db_path=None,
        )
        try:
            store.clear()
        finally:
            store.close()
        print(f"  Extraction cache cleared ({self.cache_db})")

    def _init_stores(self):
        """Initialize storage backends (skip any that were injected)."""
        if self.store is None:
            graph_backend = cfg.storage.graph.backend

            if graph_backend == "ladybug":
                self.store = create_store(
                    backend=graph_backend,
                    db_path=self.sqlite_path,
                    ladybug_path=GRAPH_DB_PATH,
                    **LADYBUG_OPTS,
                )
            else:
                self.store = create_store(
                    backend=graph_backend, db_path=self.sqlite_path
                )
        if self.qdrant is None:
            vector_backend = str(cfg.storage.vector.backend)
            self.qdrant = create_vector_store(
                vector_backend,
                data_dir=self.sqlite_path.parent,
                embedding_dim=int(cfg.services.embedding.dim),
                path=self.qdrant_path if vector_backend == "qdrant" else None,
            )
        if self.embedder is None:
            emb_cfg = cfg.pipelines.ingestion.embedding
            self.embedder = Embedder(
                batch_size=emb_cfg.batch_size,
                concurrency=emb_cfg.concurrency,
                max_retries=emb_cfg.max_retries,
                timeout=emb_cfg.timeout,
            )
        # The extractor is initialized lazily by run_extraction on its event-loop
        # thread. Store initialization also runs in worker threads, so creating or
        # closing the extraction-cache connection here would cross thread ownership.

    # ═══════════════════════════════════════════════════════════════════════
    # PHASE A: Chunking (load + persist + embed; no LLM)
    # ═══════════════════════════════════════════════════════════════════════

    def run_phase_a(self, progress_callback=None):
        """Phase A: load every source, persist chunks, embed them. No LLM.

        At the end of Phase A the SQLite ``chunks`` table + vector ``chunks``
        collection are populated for all sources, so dense + BM25 retrieval is
        immediately usable. Phase B then adds the graph layer on top.
        """
        t0 = time.time()
        print("=" * 60)
        print("PHASE A: CHUNKING (load + persist + embed, no LLM)")
        print("=" * 60)

        self._init_stores()

        print("\n[A.1] Loading chunks (chat + sources)...")
        self._load_phase_a_input()
        chunks = self.all_chunks()
        print(
            f"  {len(self.messages)} messages + {len(self.extra_chunks)} "
            f"source chunks = {len(chunks)} total"
        )
        if progress_callback:
            progress_callback("phase_a", 0.3)

        print("\n[A.2] Persisting chunks to SQLite...")
        self._persist_chunks()
        if progress_callback:
            progress_callback("phase_a", 0.5)

        print("\n[A.3] Embedding chunks into vector store...")
        self._embed_chunks()

        elapsed = time.time() - t0
        print(f"\n  Phase A complete in {elapsed:.1f}s ({elapsed / 60:.1f} min)")
        if self.embedder:
            self.embedder.print_usage_stats("Phase A (Chunk Embedding)")
        if progress_callback:
            progress_callback("phase_a", 1.0)

    # ═══════════════════════════════════════════════════════════════════════
    # PHASE B: Extraction + graph build (LLM; replayable from cache)
    # ═══════════════════════════════════════════════════════════════════════

    async def run_extraction(
        self, progress_callback=None
    ) -> tuple[ExtractionFailure, ...]:
        """Run LLM extraction on all chunks (chat + non-chat). Results cached.

        A Phase-B sub-step: loads chunks if Phase A didn't already, then fires
        cached, batched extraction over every chunk.

        Args:
            progress_callback: optional ``callable(done, total)`` invoked as
                batches complete, forwarded straight to
                :meth:`LLMExtractor.extract_all_flat`.
        """
        with self.step(
            "phase_b.extraction", on_skip=self._restore_extraction_checkpoint
        ) as ckpt:
            if ckpt.skip:
                return tuple(self.extraction_failures)

            t0 = time.time()
            print("=" * 60)
            print("PHASE B.1: LLM EXTRACTION")
            print("=" * 60)

            self._init_stores()
            # Load chat + non-chat sources into one chunk list (if not already).
            print("\n[B.1] Loading chunks (chat + sources)...")
            self._load_workset()
            chunks = self.all_chunks()
            self._prepare_extraction_items(chunks)
            print(
                f"  Loaded {len(self.messages)} chat slices + "
                f"{len(self.extra_chunks)} source chunks = {len(chunks)} total"
            )

            self._validate_extraction_cache_capacity(len(self.extraction_items))

            # C7: every chunk is extracted (no trivial-skip filter).
            print(f"  Extraction items: {len(self.extraction_items)}")

            # Initialize extractor
            if self.extractor is None:
                self.extractor = LLMExtractor(
                    cache_db=self.cache_db,
                    max_concurrent=self.max_concurrent_llm,
                    cache_max_entries=self.cache_max_entries,
                    legacy_cache_db=self.legacy_cache_db,
                )

            # Run flat parallel extraction over all chunks
            print(
                f"\n[B.2] Running LLM extraction (max_concurrent={self.max_concurrent_llm})..."
            )
            await self.extractor.extract_all_flat(
                self.extraction_items, progress_callback=progress_callback
            )
            self.extraction_failures = list(self.extractor.failures)

            elapsed = time.time() - t0
            print(f"\n  Extraction complete in {elapsed:.1f}s ({elapsed / 60:.1f} min)")
            self.extractor.print_stats()
            if self.extraction_failures:
                print(
                    f"  WARNING: {len(self.extraction_failures)} extraction item(s) "
                    "failed after in-step retries; graph output will be partial."
                )
            # Step-level summary
            st = self.extractor.stats
            print("\n  ┌─ Phase B.1 (LLM Extraction) Cost Summary ─┐")
            print(f"  │  LLM calls:          {st['llm_calls']:,}")
            print(f"  │  Prompt tokens:      {st['prompt_tokens']:,}")
            print(f"  │  Completion tokens:  {st['completion_tokens']:,}")
            print(f"  │  Total tokens:        {st['total_tokens']:,}")
            print(f"  │  Estimated cost:     ${st['estimated_cost_usd']:.4f}")
            print(f"  │  Time:               {elapsed:.1f}s ({elapsed / 60:.1f} min)")
            print("  └────────────────────────────────────────────┘")

            ckpt.done(
                count=len(self.extraction_items),
                failures=[failure.as_dict() for failure in self.extraction_failures],
            )
            return tuple(self.extraction_failures)

    async def run_graph_build(self, progress_callback=None):
        """Build the graph (entities/facts/edges) from cached extraction results.

        No LLM except the best-effort hub-entity description summarizer (awaited
        concurrently). Assumes chunks are already persisted + embedded by Phase A;
        this adds only the graph layer (entity/fact rows, their vectors, and edges).

        Args:
            progress_callback: optional ``callable(frac)`` where ``frac`` is a
                float in ``[0, 1]`` marking completion of each sub-step
                (load → entities → facts → embed → edges). Embedding is the
                heaviest step, so the fractions are weighted, not uniform.
        """

        def _report(frac: float):
            if progress_callback:
                progress_callback(frac)

        t0 = time.time()
        print("\n" + "=" * 60)
        print("PHASE B.2: GRAPH BUILDING")
        print("=" * 60)

        self._init_stores()
        self._graph_build_ran = True

        # B.3: Load chunks (needed to iterate for entity/fact/edge building)
        print("\n[B.3] Loading chunks (chat + sources)...")
        self._load_workset()
        print(
            f"  Messages: {len(self.messages)} + source chunks: {len(self.extra_chunks)}"
        )

        # B.4: Load cached extraction results
        print("\n[B.4] Loading cached extraction results...")
        self._ensure_extraction_loaded()
        print(f"  Cached results loaded: {len(self.extraction_results)}")
        # Warn if cache doesn't cover all extraction items (e.g., source data changed
        # since extraction ran, or --build-only used without re-extracting).
        n_items = len(self.extraction_items)
        n_covered = sum(
            1 for item in self.extraction_items
            if item.id in self.extraction_results
        )
        if n_covered < n_items:
            pct = n_covered / n_items * 100 if n_items else 100
            logger.warning(
                "Extraction cache covers %d/%d items (%.0f%%). "
                "Run extraction first (or omit --build-only) for full coverage.",
                n_covered,
                n_items,
                pct,
            )
            print(
                f"  WARNING: extraction cache covers only {n_covered}/{n_items} "
                f"items ({pct:.0f}%). Graph will be partial."
            )
        _report(0.10)

        # B.5: Build entities from extraction results (all chunks)
        print("\n[B.5] Building entities...")
        await self._build_entities()
        print(f"  Unique entities: {len(self.all_entities)}")
        _report(0.25)

        # B.6: Build facts from extraction results (all chunks)
        print("\n[B.6] Building facts...")
        self._build_facts()
        print(f"  Facts: {len(self.all_facts)}")
        await self._run_optional_cleanup()
        _report(0.35)

        # B.7: Embed the graph layer (entities + facts) — heaviest sub-step.
        print("\n[B.7] Embedding entities + facts...")
        self._embed_graph()
        _report(0.85)

        # B.8: Create edges
        print("\n[B.8] Creating edges...")
        self._create_edges()
        _report(1.0)

        elapsed = time.time() - t0
        self._print_summary(elapsed)
        self._maybe_clear_extraction_cache()

    async def run_phase_b(self):
        """Phase B: LLM extraction over all chunks + graph build.

        Assumes Phase A already persisted + embedded the chunks. Both sub-steps
        are self-sufficient (they load chunks if needed), so this also works as
        a standalone ``--phase-b`` run over an export whose chunks are cached.
        """
        await self.run_extraction()
        await self.run_graph_build()

    def run_similarity_and_communities(
        self,
        *,
        progress_callback=None,
        fact_sim_threshold: float = 0.85,
        entity_emb_threshold: float = 0.65,
        entity_hybrid_threshold: float = 0.45,
        entity_resolution: float = 2.0,
        fact_resolution: float = 1.5,
        fact_min_cluster_size: int = 5,
        run_disambiguation: bool = True,
        skip_llm_judge: bool = False,
        llm_max_budget: int = 500,
    ):
        """Steps 1.16–1.23: similarity edges, communities, disambiguation.

        Part of the full ingestion pipeline — runs after graph build completes.
        Also runnable standalone for parameter tuning without re-running
        extraction (``scripts/improve.py`` or ``--improve-only``).

        Requires all entities/facts/embeddings to exist in the stores.
        """
        from kl_graph.periodic.runner import run_periodic_improvement

        run_periodic_improvement(
            store=self.store,
            qdrant=self.qdrant,
            checkpoint=self.checkpoint,
            fact_sim_threshold=fact_sim_threshold,
            entity_emb_threshold=entity_emb_threshold,
            entity_hybrid_threshold=entity_hybrid_threshold,
            entity_resolution=entity_resolution,
            fact_resolution=fact_resolution,
            fact_min_cluster_size=fact_min_cluster_size,
            run_disambiguation=run_disambiguation,
            skip_llm_judge=skip_llm_judge,
            llm_max_budget=llm_max_budget,
        )

    def _load_delta(self) -> list[Chunk]:
        """Load all source chunks and filter to those not already in the DB.

        Calls _load_sources() to parse all source directories into chunks, then
        batch-checks which chunk IDs already exist in SQLite via
        store.existing_chunk_ids(). Returns only the new (not-yet-ingested) chunks.

        For crash-resume safety the store must be initialized before calling this.

        Returns:
            List of Chunk objects not yet present in the chunks table.
        """
        self._load_sources()
        all_chunks = self.all_chunks()
        if not all_chunks:
            return []
        existing_ids = self.store.existing_chunk_ids([c.id for c in all_chunks])
        return [c for c in all_chunks if c.id not in existing_ids]

    def _load_extraction_cache(self):
        """Load all cached extraction results from the SQLite cache table.

        Only validated successes are stored (the writer never persists a
        failure), so this replaces the old directory glob and inherently drops
        any error/transient entries. Keyed by chunk id (``_msg_id``).
        """
        from kl_graph.ingest.extraction_cache import ExtractionCacheStore

        if self.extractor is None:
            self.extractor = LLMExtractor(
                cache_db=self.cache_db,
                cache_max_entries=self.cache_max_entries,
                legacy_cache_db=self.legacy_cache_db,
            )
        chunks = self.all_chunks()
        self._prepare_extraction_items(chunks)
        if self.extraction_items:
            results = {
                item.id: result
                for item in self.extraction_items
                if (result := self.extractor.read_cached(item)) is not None
            }
        else:
            # Compatibility for callers replaying a legacy chunk cache without
            # loading source chunks. Real graph builds always take the exact,
            # fingerprinted extraction-item branch above.
            store = ExtractionCacheStore(
                self.cache_db,
                max_entries=self.cache_max_entries,
                legacy_db_path=self.legacy_cache_db,
            )
            try:
                results = store.all_results(self.extractor.model)
            finally:
                store.close()
        self.extraction_results.update(results)
        print(f"  Loaded {len(results)} cached results from {self.cache_db}")

    def _prepare_extraction_items(self, chunks: list[Chunk]) -> None:
        """Initialize one canonical item list, adapting direct legacy results once.

        Normal ingestion always builds source-aware items. Tests and old callers
        may inject a ``chunk_id -> result`` mapping directly; that legacy shape
        is converted here into one stored-chunk item per result, after which all
        consumers use the same extraction-item record path.
        """
        if getattr(self, "extraction_items", None):
            if not self.extraction_projections:
                self.extraction_projections = [
                    ExtractionProjection(
                        extraction_item_id=item.id,
                        chunk_id=item.target_chunk_id,
                        role="primary",
                    )
                    for item in self.extraction_items
                ]
            return
        legacy_chunk_ids = {
            chunk.id for chunk in chunks if chunk.id in self.extraction_results
        }
        if legacy_chunk_ids:
            self.extraction_items = [
                ExtractionItem(
                    id=chunk.id,
                    source_type=chunk.source_type,
                    content=getattr(chunk, "content", ""),
                    target_chunk_id=chunk.id,
                    timestamp=chunk.timestamp,
                    source_ref=getattr(chunk, "source_ref", None),
                    strategy_version="legacy-chunk-v1",
                    prompt_version="legacy",
                )
                for chunk in chunks
                if chunk.id in legacy_chunk_ids
            ]
            self.extraction_projections = [
                ExtractionProjection(
                    extraction_item_id=item.id,
                    chunk_id=item.target_chunk_id,
                    role="primary",
                )
                for item in self.extraction_items
            ]
            return
        self.extraction_items = build_extraction_items(chunks)
        self.extraction_projections = [
            ExtractionProjection(
                extraction_item_id=item.id,
                chunk_id=item.target_chunk_id,
                role="primary",
            )
            for item in self.extraction_items
        ]

    def _projections_for(
        self,
        item_id: str,
        *,
        project_mentions: bool = False,
        project_facts: bool = False,
    ) -> list[ExtractionProjection]:
        """Return ordered projections selected for one graph relation."""

        projections = [
            projection
            for projection in self.extraction_projections
            if projection.extraction_item_id == item_id
            and (not project_mentions or projection.project_mentions)
            and (not project_facts or projection.project_facts)
        ]
        return sorted(projections, key=lambda row: row.role != "primary")

    def _mention_projections_for(
        self, item_id: str, entity_name: str
    ) -> list[ExtractionProjection]:
        """Prefer projected chunks that contain the extracted entity evidence."""

        candidates = self._projections_for(item_id, project_mentions=True)
        if getattr(self, "_projection_chunks_by_id", None) is None:
            self._projection_chunks_by_id = {
                chunk.id: chunk for chunk in self.all_chunks()
            }
        chunks = self._projection_chunks_by_id
        needle = entity_name.strip().lstrip("@").casefold()
        matched = [
            projection
            for projection in candidates
            if needle
            and (chunk := chunks.get(projection.chunk_id)) is not None
            and needle in getattr(chunk, "content", "").casefold()
        ]
        if matched:
            return matched
        primary = [
            projection for projection in candidates if projection.role == "primary"
        ]
        return primary or candidates[:1]

    def _extraction_records(self):
        """Yield extraction items with their persistent target chunks/results."""
        all_chunks = self.all_chunks()
        self._prepare_extraction_items(all_chunks)
        chunks = {chunk.id: chunk for chunk in all_chunks}
        for item in self.extraction_items:
            result = self.extraction_results.get(item.id)
            chunk = chunks.get(item.target_chunk_id)
            if result is not None and chunk is not None:
                yield item, chunk, result

    async def _build_entities(self):
        """Build entities from extraction results. Exact name match → merge.

        The extraction loop runs over **all chunks** (chat + non-chat) so an
        entity named only in a wiki/mail/minutes chunk becomes a node. The
        sender loop stays chat-only (non-chat chunks have no chat sender).

        Each chunk's per-entity ``description`` is accumulated rather than
        replaced: contributions are collected with their source-chunk timestamp
        and folded into the stored description by
        :func:`build_entity_description` (deduped chronological ``- `` bullets,
        collapsed by one LLM summarize call only past the gate).
        """
        with self.step(
            "phase_b.build_entities", on_skip=self._ensure_entities_loaded
        ) as s:
            if s.skip:
                return
            # entity_id → [(source_chunk_timestamp, description)], first-seen order.
            descriptions: dict[str, list[tuple[int, str]]] = {}

            for item, msg, result in self._extraction_records():
                raw_entities = result.get("entities", [])
                for raw in raw_entities:
                    if not isinstance(raw, dict):
                        continue
                    name = raw.get("name", "").strip()
                    # Defense-in-depth (the extractor sanitizer is the primary
                    # scrub): strip a stray leading '@' so "@李强" and "李强"
                    # collapse to one node, and drop broadcast tokens that are not
                    # people. Redundant-but-guarded per AGENTS.md.
                    name = name.lstrip("@").strip()
                    if name in ("所有人", "全体成员", "全体"):
                        continue
                    if not name or len(name) < 2:
                        continue
                    # Skip garbage (URLs, overly long strings)
                    if len(name) > 50 or "mediaId=" in name or "http" in name:
                        continue

                    eid = entity_id_from_name(name)
                    etype = map_entity_type(raw.get("entity_type", "Unknown"))

                    # Collect this chunk's description contribution (empty is
                    # normal: a bare @-mention says nothing about the entity).
                    raw_desc = raw.get("description") or ""
                    if isinstance(raw_desc, str) and raw_desc.strip():
                        descriptions.setdefault(eid, []).append(
                            (msg.timestamp, raw_desc.strip())
                        )

                    if eid in self.all_entities:
                        # Update existing (exact name match)
                        existing = self.all_entities[eid]
                        existing.mention_count += 1
                        existing.last_seen = max(existing.last_seen, msg.timestamp)
                    else:
                        self.all_entities[eid] = Entity(
                            id=eid,
                            name=name,
                            entity_type=etype,
                            first_seen=msg.timestamp,
                            last_seen=msg.timestamp,
                            mention_count=1,
                        )

            # Also add authors/participants as Person entities. Chat contributes
            # the sender; non-chat sources contribute people from their metadata
            # (mail from/to, calendar attendees, minutes speakers, report creator).
            for msg in self.all_chunks():
                for pname in _participants_of(msg):
                    sender_name = pname.strip()
                    if (
                        not sender_name
                        or len(sender_name) < 2
                        or sender_name.startswith("[")
                    ):
                        continue
                    eid = entity_id_from_name(sender_name)
                    if eid in self.all_entities:
                        self.all_entities[eid].mention_count += 1
                        self.all_entities[eid].last_seen = max(
                            self.all_entities[eid].last_seen, msg.timestamp
                        )
                    else:
                        self.all_entities[eid] = Entity(
                            id=eid,
                            name=sender_name,
                            entity_type=EntityType.PERSON,
                            first_seen=msg.timestamp,
                            last_seen=msg.timestamp,
                            mention_count=1,
                        )

            # Fold each entity's accumulated per-chunk contributions into its stored
            # description. Entities with no contribution keep the "" default.
            # Hub entities (> DESCRIPTION_GATE) each fire one summarizer LLM call;
            # run them concurrently under a bounded semaphore instead of serially
            # (the old serial loop cost ~5 min on a full corpus). Cheap entities
            # resolve to bullets without a call, so this is free for them.
            async def _fold(eid: str, contribs: list[tuple[int, str]]) -> None:
                entity = self.all_entities.get(eid)
                if entity is None:
                    return
                entity.description = await build_entity_description(
                    entity.name, contribs
                )

            sem = asyncio.Semaphore(ENTITY_DESCRIPTION_CONCURRENCY)

            async def _bounded_fold(eid: str, contribs: list[tuple[int, str]]) -> None:
                async with sem:
                    await _fold(eid, contribs)

            await asyncio.gather(
                *(
                    _bounded_fold(eid, contribs)
                    for eid, contribs in descriptions.items()
                )
            )

            # Store in SQLite
            self.store.upsert_entities(list(self.all_entities.values()))
            s.done(count=len(self.all_entities))

    def _build_facts(self):
        """Build facts from extraction results (over all chunks).

        A fact's ``source_chunk_id`` holds the id of the **chunk** it was
        extracted from, and the deterministic fact id is derived from that chunk
        id + text, so facts from every source dedupe/replay the same way.

        U0 temporal grounding: each fact text is prefixed with the source
        chunk's date (``[YYYY-MM-DD]``, see :func:`_dated_fact_text`) before
        storage/embedding/id-derivation; the extraction cache stays raw.
        """
        with self.step("phase_b.build_facts", on_skip=self._ensure_facts_loaded) as s:
            if s.skip:
                return
            for item, msg, result in self._extraction_records():
                raw_facts = result.get("facts", [])
                for raw in raw_facts:
                    if not isinstance(raw, dict):
                        continue
                    fact_text = raw.get("fact_text", "").strip()
                    if not fact_text or len(fact_text) < 5:
                        continue

                    # U0 temporal grounding: prefix the source chunk's date so
                    # retrieval/synthesis sees when the fact happened. Applied
                    # BEFORE the id is computed so stored text, embedding, and
                    # the content-derived fact id all carry the date. Local
                    # rebind only — the raw cache text stays untouched.
                    fact_text = _dated_fact_text(fact_text, msg.timestamp)

                    fact_type = map_fact_type(raw.get("fact_type", "GENERAL"))

                    # Deterministic ID from source chunk + (date-prefixed) fact text
                    fact_id = _fact_id(item.id, fact_text)

                    # LLM-generated confidence in [0,1]; clamp defensively and fall
                    # back to 0.9 when the model omits it or emits a bad value.
                    try:
                        confidence = float(raw.get("confidence", 0.9))
                    except (TypeError, ValueError):
                        confidence = 0.9
                    confidence = min(1.0, max(0.0, confidence))

                    fact = Fact(
                        id=fact_id,
                        text=fact_text,
                        fact_type=fact_type,
                        timestamp=msg.timestamp,
                        confidence=confidence,  # LLM-generated, clamped to [0,1]
                        source_chunk_id=msg.id,
                        source_unit_id=item.source_unit_id,
                        extraction_item_id=item.id,
                    )
                    self.all_facts.append(fact)

            # Store in SQLite
            if self.all_facts:
                self.store.insert_facts(self.all_facts)
            s.done(count=len(self.all_facts))

    async def _run_optional_cleanup(self) -> None:
        """Run the optional budgeted LLM review before embedding and edges."""
        cleanup_cfg = cfg.pipelines.ingestion.cleanup
        if not cleanup_cfg.enabled:
            return
        from kl_graph.ingest.entity_cleanup import (
            apply_cleanup_decisions,
            rank_cleanup_candidates,
            review_cleanup_candidates,
        )

        mention_contexts: dict[str, list[str]] = {}
        type_votes: dict[str, set[str]] = {}
        for item, _chunk, result in self._extraction_records():
            for raw in result.get("entities", []):
                if not isinstance(raw, dict):
                    continue
                name = str(raw.get("name") or "").strip().lstrip("@").strip()
                if not name:
                    continue
                entity_id = entity_id_from_name(name)
                mention_contexts.setdefault(entity_id, []).append(item.content[:500])
                type_votes.setdefault(entity_id, set()).add(
                    str(raw.get("entity_type") or "Unknown")
                )
        candidates = rank_cleanup_candidates(
            list(self.all_entities.values()),
            self.all_facts,
            min_score=float(cleanup_cfg.min_suspicion_score),
            mention_contexts=mention_contexts,
            type_votes=type_votes,
        )
        decisions = await review_cleanup_candidates(
            candidates,
            budget=int(cleanup_cfg.max_entities),
            dry_run=bool(cleanup_cfg.dry_run),
        )
        apply_cleanup_decisions(
            self.all_entities, decisions, dry_run=bool(cleanup_cfg.dry_run)
        )
        if not cleanup_cfg.dry_run:
            changed = [
                self.all_entities[decision["entity_id"]]
                for decision in decisions
                if decision["action"] != "KEEP"
                and decision["entity_id"] in self.all_entities
            ]
            if changed:
                self.store.apply_entity_cleanup(changed)
            self.all_entities = {
                entity_id: entity
                for entity_id, entity in self.all_entities.items()
                if entity.quality_status == "active"
            }
        actions: dict[str, int] = {}
        for decision in decisions:
            actions[decision["action"]] = actions.get(decision["action"], 0) + 1
        mode = "dry-run" if cleanup_cfg.dry_run else "applied"
        print(
            f"  Entity cleanup {mode}: {len(decisions)}/{len(candidates)} reviewed; "
            f"actions={actions}"
        )

    def _embed_texts_reusing_duplicates(
        self, texts: list[str], label: str
    ) -> list[list[float]]:
        """Embed ``texts`` but send each byte-identical text to the API only once.

        Goal 2 of embedding-dedup: repeated boilerplate / forwarded messages /
        duplicated headers cost one embedding call, not N. The duplicate's
        *chunk* is never dropped — only the redundant API call is — so each chunk
        still gets its own point + payload; they merely share a vector. Order is
        preserved: the returned list aligns 1:1 with ``texts``.
        """
        unique_texts: list[str] = []
        index_of: dict[str, int] = {}
        positions: list[int] = []
        for t in texts:
            if t not in index_of:
                index_of[t] = len(unique_texts)
                unique_texts.append(t)
            positions.append(index_of[t])
        vectors = self.embedder.embed_batch_with_progress(unique_texts, label)
        return [vectors[p] for p in positions]

    def _flush_if_full(self, collection: str, points: list) -> int:
        """Upsert + clear ``points`` in place once it reaches the flush size.

        Incremental-flush protection (Goal 1): returns the number of points
        flushed (0 when below the threshold) so callers can keep a running
        stored count. Mutates ``points`` to empty on flush.
        """
        if len(points) >= EMBED_FLUSH_EVERY:
            return self._flush_points(collection, points)
        return 0

    def _flush_points(self, collection: str, points: list) -> int:
        """Upsert all ``points`` and clear the list; return how many were stored."""
        if not points:
            return 0
        n = len(points)
        self.qdrant.upsert(collection, points)
        points.clear()
        return n

    def _embed_chunks(self):
        """Embed all chunks into the vector store's ``chunks`` collection.

        Phase A step: after this, dense + BM25 retrieval over every source is
        usable, before any LLM extraction runs. Chat chunks carry extra
        payload (sender/conversation, read from ``metadata``) for chat-specific
        filters; non-chat chunks carry the generic fields. Point ids are
        contiguous across all chunks.
        """
        with self.step("phase_a.embed_chunks") as s:
            if s.skip:
                return
            chunks = self.all_chunks()
            if not chunks:
                print("  No chunks to embed.")
                s.done(count=0)
                return
            # Adapters map stable chunk IDs to any backend-specific physical ID.
            # Skip chunks a previous run already flushed (resume), so a crash at
            # N% resumes at N%.
            ids = [c.id for c in chunks]
            already = self.qdrant.existing_ids("chunks", ids)
            todo = [
                (chunk, stable_id)
                for chunk, stable_id in zip(chunks, ids)
                if stable_id not in already
            ]
            if already:
                print(f"  Skipping {len(already)} already-embedded chunks (resume)")
            if not todo:
                print("  All chunks already embedded.")
                s.done(count=len(already))
                return
            print(f"  Embedding {len(todo)} chunks (all sources)...")
            # Embed the full chunk text for every source. Chat chunks are session
            # slices whose rendered text already carries the per-message
            # sender/receiver headers; non-chat chunks are token-budgeted by their
            # loaders. Nothing is truncated here — an oversize chunk must be split
            # upstream (loader), never sliced away, so the embedding always reflects
            # the whole stored content. See AGENTS.md "never discard with [:xx]".
            texts = [c.content for c, _ in todo]
            # Goal 2: byte-identical texts embed ONCE; the vector is reused for every
            # chunk that shares it (each still gets its own point + payload, since
            # metadata may differ). Never skip a duplicate chunk — reuse its vector.
            embeddings = self._embed_texts_reusing_duplicates(texts, "  Chunks")
            points = []
            flushed = 0
            for (c, stable_id), emb in zip(todo, embeddings):
                payload = {
                    "chunk_id": c.id,
                    "source_type": c.source_type,
                    "source_ref": c.source_ref or "",
                    "content": c.content,
                    "timestamp": c.timestamp,
                }
                if _is_chat(c):
                    payload.update(
                        source_ref=c.source_ref or c.metadata.get("sender", ""),
                        conversation_id=c.metadata.get("conversation_id", ""),
                        sender=c.metadata.get("sender", ""),
                        sender_id=c.metadata.get("sender_id") or "",
                    )
                points.append(VectorPoint(id=stable_id, vector=emb, payload=payload))
                flushed += self._flush_if_full("chunks", points)
            flushed += self._flush_points("chunks", points)
            print(f"  Chunks: {flushed} vectors stored")
            s.done(count=flushed)

    def _embed_graph(self):
        """Embed entities and facts into their vector collections (Phase B)."""
        with self.step("phase_b.embed_graph") as s:
            if s.skip:
                return
            self._ensure_entities_loaded()
            self._ensure_facts_loaded()
            # Embed entities
            if self.all_entities:
                print("  Embedding entities...")
                entity_list = list(self.all_entities.values())
                entity_ids = [e.id for e in entity_list]
                already = self.qdrant.existing_ids("entities", entity_ids)
                todo = [
                    (entity, stable_id)
                    for entity, stable_id in zip(entity_list, entity_ids)
                    if stable_id not in already
                ]
                if already:
                    print(
                        f"  Skipping {len(already)} already-embedded entities (resume)"
                    )
                if todo:
                    entity_texts = [e.name for e, _ in todo]
                    entity_embeddings = self._embed_texts_reusing_duplicates(
                        entity_texts, "  Entities"
                    )
                    entity_points = []
                    flushed = 0
                    for (ent, stable_id), emb in zip(todo, entity_embeddings):
                        entity_points.append(
                            VectorPoint(
                                id=stable_id,
                                vector=emb,
                                payload={
                                    "entity_id": ent.id,
                                    "name": ent.name,
                                    "entity_type": ent.entity_type.value,
                                    "mention_count": ent.mention_count,
                                },
                            )
                        )
                        flushed += self._flush_if_full("entities", entity_points)
                    flushed += self._flush_points("entities", entity_points)
                    print(f"  Entities: {flushed} vectors stored")

            # Embed facts
            if self.all_facts:
                print("  Embedding facts...")
                fact_ids = [f.id for f in self.all_facts]
                already = self.qdrant.existing_ids("facts", fact_ids)
                todo = [
                    (fact, stable_id)
                    for fact, stable_id in zip(self.all_facts, fact_ids)
                    if stable_id not in already
                ]
                if already:
                    print(f"  Skipping {len(already)} already-embedded facts (resume)")
                if todo:
                    fact_texts = [f.text for f, _ in todo]
                    fact_embeddings = self._embed_texts_reusing_duplicates(
                        fact_texts, "  Facts"
                    )
                    fact_points = []
                    flushed = 0
                    for (fact, stable_id), emb in zip(todo, fact_embeddings):
                        fact_points.append(
                            VectorPoint(
                                id=stable_id,
                                vector=emb,
                                payload={
                                    "fact_id": fact.id,
                                    "text": fact.text,
                                    "fact_type": fact.fact_type.value,
                                    "timestamp": fact.timestamp,
                                    "confidence": fact.confidence,
                                    "source_chunk_id": fact.source_chunk_id,
                                    "source_unit_id": fact.source_unit_id,
                                    "extraction_item_id": fact.extraction_item_id,
                                },
                            )
                        )
                        flushed += self._flush_if_full("facts", fact_points)
                    flushed += self._flush_points("facts", fact_points)
                    print(f"  Facts: {flushed} vectors stored")
            s.done()

    def _load_workset(self) -> None:
        """Hydrate the exact Phase-A batch from durable SQLite state.

        This is the only source of chunks for resumed chunk-dependent phases.
        Re-running source deduplication here would lose the original batch because
        its units are already present in the canonical ``units`` table.
        """

        if self._sources_loaded:
            return
        if self.batch_id is None:
            self._load_sources()
            return
        if (
            self.checkpoint is not None
            and self.checkpoint.workset_schema < 1
            and self.checkpoint.is_done("phase_a.persist_chunks")
        ):
            raise RuntimeError(
                "Cannot resume a legacy checkpoint after Phase A: it has no durable "
                "chunk workset. Start an explicit fresh rebuild."
            )

        batch = self.store.get_ingest_batch(self.batch_id)
        if batch is None:
            raise RuntimeError(
                f"Checkpoint batch {self.batch_id!r} has no durable workset; "
                "run Phase A before any chunk-dependent phase"
            )
        if batch["state"] != "ready":
            raise RuntimeError(
                f"Ingestion batch {self.batch_id!r} is {batch['state']!r}; "
                "its workset is no longer available"
            )

        chunks = self.store.get_ingest_batch_chunks(self.batch_id)
        expected = int(batch["chunk_count"])
        if len(chunks) != expected:
            raise RuntimeError(
                f"Ingestion batch {self.batch_id!r} is corrupt: expected "
                f"{expected} chunks, loaded {len(chunks)}. The workset was "
                "likely damaged by an external crash or manual deletion. "
                "Use --fresh-db to start a clean rebuild (extraction cache "
                "is preserved in extraction_cache.db)."
            )
        self.messages = [c for c in chunks if c.source_type == "message"]
        self.extra_chunks = [c for c in chunks if c.source_type != "message"]
        items, projections = self.store.get_ingest_batch_extraction_plan(self.batch_id)
        self.extraction_items = items
        self.extraction_projections = projections
        if not items and chunks:
            # Compatibility for active worksets created before plan schema v1.
            # This is only safe for the old complete-target chunking policies.
            self.extraction_items = build_extraction_items(chunks)
            self.extraction_projections = [
                ExtractionProjection(
                    extraction_item_id=item.id,
                    chunk_id=item.target_chunk_id,
                    role="primary",
                )
                for item in self.extraction_items
            ]
        self._workset_unit_count = int(batch["unit_count"])
        self._workset_chunk_count = expected
        self.units_discovered = self._workset_unit_count
        self._sources_loaded = True
        print(
            f"  [checkpoint] Reloaded batch {self.batch_id}: "
            f"{self._workset_unit_count} units, {expected} chunks"
        )

    def _load_phase_a_input(self) -> None:
        """Load sources for a new batch or its committed workset on resume."""

        if self.batch_id is not None:
            batch = self.store.get_ingest_batch(self.batch_id)
            if batch is not None and batch["state"] == "ready":
                self._load_workset()
                return
        if self.checkpoint is not None and self.checkpoint.is_done(
            "phase_a.persist_chunks", params={"ingestion_plan_schema": 1}
        ):
            self._load_workset()
        else:
            self._load_sources()

    def _load_sources(self):
        """Parse every source dir into chunks (no I/O to stores).

        Chat is just one source among many: it loads into ``self.messages``
        while the rest load into ``self.extra_chunks`` — both are plain
        :class:`Chunk` lists. The split exists only for the chat-only edges
        (TEMPORAL / REPLY_TO), not for loading — every source is
        loaded here through the same call. Loaders no-op when a dir is absent,
        so a partial export still works. Kept separate from persistence so
        Phase A can extract over the chunks before Phase B embeds/stores them.
        """
        if self._sources_loaded:
            return
        plans = []
        # Chat first (it feeds the chat-only edges), then the rest. The loader
        # returns one rendered Chunk per message, grouped by conversation with
        # session-break markers; the session chunker collapses that into the
        # actual chat chunk unit — session slices (<=1024 tokens, headers intact,
        # provenance in metadata). C1/C6: a slice's deterministic id is what the
        # extraction cache and fact ids key on downstream.
        raw_messages = load_all_messages(self.messages_dir)
        chat_units = [
            SourceUnit(
                source_id=self.source_id,
                source_type="message",
                unit_id=message.id,
                content_hash=hashlib.sha256(message.content.encode()).hexdigest(),
                timestamp=message.timestamp,
                metadata=message.metadata,
            )
            for message in raw_messages
            if message.id
        ]
        self.units_discovered += len(chat_units)
        before = len(self.source_units)
        raw_messages = self._filter_unseen_chunks(raw_messages, chat_units)
        selected_chat_units = self.source_units[before:]
        chat_plan = source_strategy_for("message").plan(
            raw_messages, selected_chat_units, source_id=self.source_id
        )
        plans.append(chat_plan)
        self.messages = chat_plan.chunks
        if self.messages:
            print(f"  chat: {len(self.messages)} session slices")

        # Other sources live as sibling dirs under the export root. Derive the
        # root from the chat dir so a custom export_dir (per-ingest override)
        # still resolves the siblings correctly.
        export_root = self.messages_dir.parent
        sources: list[tuple[str, list[Chunk]]] = []
        # Structured sources with bespoke mappers.
        sources.append(("wiki", load_wiki(export_root / "wiki")))
        sources.append(("mail", load_mail(export_root / "mail")))
        sources.append(("minutes", load_minutes(export_root / "minutes")))
        # Everything else: one chunk per record via the generic flattener.
        for name in GENERIC_SOURCES:
            src_dir = export_root / name
            if src_dir.is_dir():
                sources.append((name, load_generic(src_dir, name)))
        self.extra_chunks = [c for _, chunks in sources for c in chunks]
        document_units: list[SourceUnit] = []
        chunks_by_unit: dict[tuple[str, str], list[Chunk]] = {}
        for chunk in self.extra_chunks:
            unit_id = str(chunk.metadata.get("unit_id") or chunk.id)
            chunks_by_unit.setdefault((chunk.source_type, unit_id), []).append(chunk)
        for (source_type, unit_id), chunks in chunks_by_unit.items():
            document_units.append(
                SourceUnit(
                    source_id=self.source_id,
                    source_type=source_type,
                    unit_id=unit_id,
                    content_hash=hashlib.sha256(
                        "\n".join(chunk.content for chunk in chunks).encode()
                    ).hexdigest(),
                    timestamp=min((chunk.timestamp for chunk in chunks), default=0),
                    metadata={"chunk_count": len(chunks)},
                )
            )
        self.units_discovered += len(document_units)
        before = len(self.source_units)
        self.extra_chunks = self._filter_unseen_chunks(
            self.extra_chunks, document_units
        )
        selected_document_units = self.source_units[before:]
        for source_type in dict.fromkeys(
            chunk.source_type for chunk in self.extra_chunks
        ):
            records = [
                chunk for chunk in self.extra_chunks if chunk.source_type == source_type
            ]
            units = [
                unit
                for unit in selected_document_units
                if unit.source_type == source_type
            ]
            plans.append(
                source_strategy_for(source_type).plan(
                    records, units, source_id=self.source_id
                )
            )
        combined = combine_plans(plans)
        self.messages = [
            chunk for chunk in combined.chunks if chunk.source_type == "message"
        ]
        self.extra_chunks = [
            chunk for chunk in combined.chunks if chunk.source_type != "message"
        ]
        self.chunk_units = combined.chunk_units
        self.extraction_items = combined.extraction_items
        self.extraction_projections = combined.projections
        self._workset_unit_count = len(self.source_units)
        self._workset_chunk_count = len(self.all_chunks())
        self._sources_loaded = True
        for name, chunks in sources:
            if chunks:
                print(f"  {name}: {len(chunks)} chunks")

    def _filter_unseen_chunks(
        self, chunks: list[Chunk], units: list[SourceUnit]
    ) -> list[Chunk]:
        """Keep only chunks belonging to unseen immutable units when requested."""
        if not self.incremental_units or not units or self.store is None:
            self.source_units.extend(units)
            return chunks
        keys = [(unit.source_type, unit.unit_id) for unit in units]
        existing_hashes = self.store.existing_unit_hashes(self.source_id, keys)
        existing = set(existing_hashes)
        for unit in units:
            key = (unit.source_type, unit.unit_id)
            if key in existing_hashes and existing_hashes[key] != unit.content_hash:
                logger.warning(
                    "Unit %s/%s/%s changed content; update handling is TODO, skipping",
                    self.source_id,
                    unit.source_type,
                    unit.unit_id,
                )
        selected = [
            unit for unit in units if (unit.source_type, unit.unit_id) not in existing
        ]
        selected_keys = {(unit.source_type, unit.unit_id) for unit in selected}
        self.units_skipped += len(units) - len(selected)
        self.source_units.extend(selected)
        if chunks and chunks[0].source_type == "message":
            return [chunk for chunk in chunks if ("message", chunk.id) in selected_keys]
        return [
            chunk
            for chunk in chunks
            if (
                chunk.source_type,
                str(chunk.metadata.get("unit_id") or chunk.id),
            )
            in selected_keys
        ]

    def _namespace_chunk_ids(self) -> None:
        """Prevent chunk collisions when several input sources share an index."""
        if self.source_id == "default":
            return
        for chunk in self.all_chunks():
            chunk.id = f"{self.source_id}:{chunk.id}"
            for key in ("conversation_id", "node_id", "meeting_id", "scope_id"):
                value = chunk.metadata.get(key)
                if value:
                    chunk.metadata[key] = f"{self.source_id}:{value}"

    def _build_chunk_unit_memberships(self) -> None:
        """Build ordered many-to-many lineage rows for the selected units."""
        selected = {
            (unit.source_type, unit.unit_id): unit for unit in self.source_units
        }
        next_chunk_ordinal: dict[tuple[str, str], int] = {}
        memberships: list[ChunkUnit] = []
        for chunk in self.all_chunks():
            if chunk.source_type == "message":
                unit_ids = list(chunk.metadata.get("member_message_ids") or [])
            else:
                unit_ids = [str(chunk.metadata.get("unit_id") or "")]
            for unit_ordinal, unit_id in enumerate(unit_ids):
                key = (chunk.source_type, unit_id)
                if not unit_id or key not in selected:
                    continue
                chunk_ordinal = next_chunk_ordinal.get(key, 0)
                next_chunk_ordinal[key] = chunk_ordinal + 1
                memberships.append(
                    ChunkUnit(
                        chunk_id=chunk.id,
                        source_id=self.source_id,
                        source_type=chunk.source_type,
                        unit_id=unit_id,
                        unit_ordinal_in_chunk=unit_ordinal,
                        chunk_ordinal_in_unit=chunk_ordinal,
                    )
                )
        self.chunk_units = memberships

    def _persist_chunks(self):
        """Write all chunks (chat + non-chat) + their Scopes to SQLite. No embedding.

        Every chunk lands in the unified ``chunks`` store; chat goes through the
        chat-named ``insert_messages`` entry point, which is the same path.
        Embedding is a separate step (:meth:`_embed_chunks`) so persistence and
        vectors can be reasoned about independently.

        Scope rows are persisted here, before :meth:`_create_edges` emits the
        ``PART_OF`` edges that point at them, so an edge can never reference a
        missing scope (the LadybugDB backend ``MATCH``es both endpoints).
        """
        with self.step(
            "phase_a.persist_chunks", params={"ingestion_plan_schema": 1}
        ) as s:
            if s.skip:
                return
            self._load_phase_a_input()
            chunks = self.all_chunks()
            self.store.insert_chunks_with_units(
                chunks,
                self.source_units,
                self.chunk_units,
                self.extraction_items,
                self.extraction_projections,
                batch_id=self.batch_id,
                batch_source_id=self.source_id if self.batch_id else None,
                source_hash=(
                    self.checkpoint.source_hash
                    if self.batch_id and self.checkpoint is not None
                    else None
                ),
            )
            if chunks:
                print(f"  Messages persisted: {self.store.count_messages()}")
            print(f"  Chunks (all sources): {self.store.count_chunks()}")
            self._persist_scopes()
            s.done(count=self.store.count_chunks())

    def _persist_scopes(self) -> list[Edge]:
        """Derive + persist one Scope per distinct source container.

        Idempotent: scope ids are deterministic and the store inserts with
        ``INSERT OR IGNORE`` / ``MERGE``, so a re-run over the same export is a
        no-op. Called from :meth:`_persist_chunks` (Phase A) and again from
        :meth:`_create_edges`, because Phase B can run standalone against chunks
        a previous Phase A process persisted.

        Returns:
            The ``PART_OF`` edges for the same chunks, so the caller building
            edges does not have to re-derive the projection.
        """
        scopes, part_of_edges = build_scopes_and_part_of(self.all_chunks())
        if not scopes:
            return []
        self.store.insert_scopes(scopes)
        print(f"  Scopes persisted: {len(scopes)}")
        return part_of_edges

    @staticmethod
    def _fact_edges(
        msg_id: str,
        raw_fact: dict,
        all_entities: dict[str, Entity],
        chunk_ts: int = 0,
        extraction_item_id: str | None = None,
        state_chunk_ids: list[str] | None = None,
    ) -> list[Edge]:
        """Build the STATES + ABOUT edges for one raw fact (pure, no I/O).

        Extracted from :meth:`_create_edges` so the per-fact edge logic is unit
        testable without a SQLite/Qdrant store. Behaviour is identical to the
        inline version it replaced, with one strictly-additive change: after the
        existing subject/object ``ABOUT`` emits, every additional entity in
        ``raw_fact['involved_entities']`` also gets an ``ABOUT`` edge (Option A:
        uniform ``ABOUT`` for every entity a fact touches). Deduped against the
        subject/object already emitted via a per-fact ``seen`` set. Old cache
        without the field degrades gracefully (``.get(..., []) or []``).

        Args:
            msg_id: id of the source chunk the fact was extracted from.
            raw_fact: one raw fact dict from the extraction cache.
            all_entities: ``entity_id -> Entity`` map; an edge is only emitted
                for an entity that actually became a node (no dangling edges).
            chunk_ts: source chunk unix-ms timestamp. The same U0 date prefix
                ``_build_facts`` applies is applied here so STATES/ABOUT edges
                reference exactly the fact ids ``_build_facts`` assigns. 0 (the
                default for pre-U0 callers) means no prefix, as before.

        Returns:
            The list of :class:`Edge` for this fact (possibly empty).
        """
        if not isinstance(raw_fact, dict):
            return []
        fact_text = raw_fact.get("fact_text", "").strip()
        if not fact_text or len(fact_text) < 5:
            return []

        # U0 temporal grounding: identical date prefix to ``_build_facts`` so
        # the edge fact ids cannot diverge from the fact node ids.
        fact_text = _dated_fact_text(fact_text, chunk_ts)

        fact_id = _fact_id(extraction_item_id or msg_id, fact_text)
        edges: list[Edge] = []

        # STATES: fact → source chunk
        for state_chunk_id in state_chunk_ids or [msg_id]:
            edges.append(
                Edge(
                    source_type="fact",
                    source_id=fact_id,
                    target_type="chunk",
                    target_id=state_chunk_id,
                    edge_type=EdgeType.STATES,
                )
            )

        # ABOUT: fact → subject entity. Normalize identically everywhere in this
        # helper (strip whitespace + leading '@') so the subject/object lookup,
        # the ``seen`` seeds, and the involved_entities fan-out key on the same
        # names. ``_build_entities`` creates nodes under the '@'-stripped name,
        # so a malformed/old-cache ``subject_entity='@李娜'`` must be stripped
        # here too or its ABOUT edge is dropped. ``.lstrip('@')`` on a clean name
        # (fresh cache) is a no-op, so this is behavior-preserving.
        subject = (raw_fact.get("subject_entity") or "").strip().lstrip("@").strip()
        if subject and len(subject) >= 2:
            subj_eid = entity_id_from_name(subject)
            if subj_eid in all_entities:
                edges.append(
                    Edge(
                        source_type="fact",
                        source_id=fact_id,
                        target_type="entity",
                        target_id=subj_eid,
                        edge_type=EdgeType.ABOUT,
                    )
                )

        # ABOUT: fact → object entity (normalized identically to subject).
        obj = (raw_fact.get("object_entity") or "").strip().lstrip("@").strip()
        if obj and len(obj) >= 2:
            obj_eid = entity_id_from_name(obj)
            if obj_eid in all_entities:
                edges.append(
                    Edge(
                        source_type="fact",
                        source_id=fact_id,
                        target_type="entity",
                        target_id=obj_eid,
                        edge_type=EdgeType.ABOUT,
                    )
                )

        # ABOUT: fact → every additional involved entity (n-ary fan-out,
        # Option A). involved_entities is the superset of participants for one
        # joint claim; emit the SAME ABOUT edge type as subject/object so
        # co-equal participants are treated identically. Dedupe against the
        # subject/object already emitted above (already normalized identically).
        seen = {subject, obj}
        for raw_name in raw_fact.get("involved_entities", []) or []:
            name = (raw_name or "").strip().lstrip("@").strip()
            if not name or len(name) < 2 or name in seen:
                continue
            seen.add(name)
            eid = entity_id_from_name(name)
            if eid in all_entities:
                edges.append(
                    Edge(
                        source_type="fact",
                        source_id=fact_id,
                        target_type="entity",
                        target_id=eid,
                        edge_type=EdgeType.ABOUT,
                    )
                )

        return edges

    def _create_edges(self):
        """Create all structural edges from extraction results."""
        with self.step("phase_b.create_edges") as s:
            if s.skip:
                return
            self._ensure_extraction_loaded()
            self._ensure_entities_loaded()
            self._ensure_facts_loaded()
            edges = []

            # PART_OF edges (chunk → source-container Scope). The Scope rows are
            # (re-)persisted first so no edge can point at a missing node when Phase B
            # runs standalone against chunks a previous process persisted.
            print("  Creating PART_OF edges...")
            edges.extend(self._persist_scopes())

            # MENTIONS edges (chunk → entity) from extraction results
            print("  Creating MENTIONS edges...")
            for item, msg, result in self._extraction_records():
                raw_entities = result.get("entities", [])
                for raw in raw_entities:
                    if not isinstance(raw, dict):
                        continue
                    name = raw.get("name", "").strip()
                    if not name or len(name) < 2 or len(name) > 50:
                        continue
                    eid = entity_id_from_name(name)
                    if eid in self.all_entities:
                        for projection in self._mention_projections_for(item.id, name):
                            edges.append(
                                Edge(
                                    source_type="chunk",
                                    source_id=projection.chunk_id,
                                    target_type="entity",
                                    target_id=eid,
                                    edge_type=EdgeType.MENTIONS,
                                )
                            )

            # AUTHORED_BY edges (chunk → author/participant Person entity)
            print("  Creating AUTHORED_BY edges...")
            for msg in self.all_chunks():
                seen_eids = set()
                for pname in _participants_of(msg):
                    sender_name = pname.strip()
                    if not sender_name or len(sender_name) < 2:
                        continue
                    eid = entity_id_from_name(sender_name)
                    if eid in seen_eids:
                        continue
                    seen_eids.add(eid)
                    if eid in self.all_entities:
                        edges.append(
                            Edge(
                                source_type="chunk",
                                source_id=msg.id,
                                target_type="entity",
                                target_id=eid,
                                edge_type=EdgeType.AUTHORED_BY,
                            )
                        )

            # TEMPORAL (C4) + REPLY_TO (C3): chat-only edges whose shape depends on
            # the session-slice structure. Extracted to a pure helper so the
            # session-break/quote-resolution logic is unit-testable (mirrors
            # ``build_scopes_and_part_of``).
            print("  Creating TEMPORAL + REPLY_TO edges...")
            edges.extend(build_chat_edges(self.messages))

            # STATES edges (fact → source chunk)
            # ABOUT edges (fact → entities mentioned in fact)
            print("  Creating STATES/ABOUT edges...")
            for item, msg, result in self._extraction_records():
                raw_facts = result.get("facts", [])
                for raw_fact in raw_facts:
                    edges.extend(
                        self._fact_edges(
                            msg.id,
                            raw_fact,
                            self.all_entities,
                            msg.timestamp,
                            item.id,
                            [
                                projection.chunk_id
                                for projection in self._projections_for(
                                    item.id, project_facts=True
                                )
                            ],
                        )
                    )

            # Deduplicate edges (same fact_text with different object_entity
            # generates duplicate STATES and ABOUT-subject edges)
            seen_keys: set[tuple] = set()
            unique_edges: list[Edge] = []
            for e in edges:
                key = (
                    e.source_type,
                    e.source_id,
                    e.target_type,
                    e.target_id,
                    e.edge_type,
                )
                if key not in seen_keys:
                    seen_keys.add(key)
                    unique_edges.append(e)
            if len(unique_edges) < len(edges):
                print(
                    f"  Deduplicated: {len(edges)} → {len(unique_edges)} edges ({len(edges) - len(unique_edges)} duplicates removed)"
                )
            edges = unique_edges

            # Bulk insert
            # TODO: Edge weight adjustment — currently INSERT OR IGNORE silently
            # drops duplicate edges. An edge (e.g. chunk→entity MENTIONS) appearing
            # in N chunks should carry a weight/count = N to reflect relationship
            # strength. This requires either:
            #   (a) ON CONFLICT DO UPDATE SET properties = json_set(properties,
            #       '$.weight', existing.weight + 1), or
            #   (b) collecting edge multiplicity in-memory before insertion and
            #       setting properties.weight = count upfront.
            # Option (b) is simpler and avoids per-edge JSON manipulation.
            print(f"  Inserting {len(edges)} edges...")
            batch_size = 10000
            for i in range(0, len(edges), batch_size):
                self.store.insert_edges(edges[i : i + batch_size])

            # Keep this inside the checkpoint boundary. If persistence succeeds
            # but cache application fails, the step remains incomplete and an
            # idempotent retry reconstructs and reapplies the same delta.
            if self.structural_cache is not None:
                self.structural_cache.apply_delta(edges)

            print(f"  Edge counts by type: {self.store.count_edges_by_type()}")
            s.done(count=self.store.count_edges())

    def _print_summary(self, elapsed: float):
        """Print build summary."""
        print("\n" + "=" * 60)
        print("GRAPH BUILD COMPLETE")
        print("=" * 60)
        print(f"  Time: {elapsed:.1f}s ({elapsed / 60:.1f} min)")
        print(f"  Messages: {self.store.count_messages()}")
        print(f"  Chunks (all sources): {self.store.count_chunks()}")
        print(f"  Chunk breakdown: {self.store.count_chunks_by_source()}")
        print(f"  Entities: {self.store.count_entities()}")
        print(f"  Facts: {self.store.count_facts()}")
        print(f"  Edges: {self.store.count_edges()}")
        print(f"  Edge breakdown: {self.store.count_edges_by_type()}")
        print(f"  Vector chunks: {self.qdrant.count('chunks')}")
        print(f"  Vector entities: {self.qdrant.count('entities')}")
        print(f"  Vector facts: {self.qdrant.count('facts')}")
        # Embedding token usage for graph build
        if self.embedder:
            self.embedder.print_usage_stats("Phase B.2 (Entity/Fact Embedding)")
        # Full-pipeline LLM cost summary
        if self.extractor and self.extractor.stats.get("llm_calls", 0) > 0:
            s = self.extractor.stats
            print("\n  ┌─ Full Pipeline LLM Cost Summary ────────────┐")
            print("  │  Phase B.1 (Extraction):")
            print(f"  │    LLM calls:          {s['llm_calls']:,}")
            print(f"  │    Prompt tokens:      {s['prompt_tokens']:,}")
            print(f"  │    Completion tokens:  {s['completion_tokens']:,}")
            print(f"  │    Total tokens:        {s['total_tokens']:,}")
            print(f"  │    Estimated cost:     ${s['estimated_cost_usd']:.4f}")
            print("  │  Phase B.2 (Graph Build): no LLM")
            print("  │  ────────────────────────────────────────")
            print(f"  │  Total estimated cost: ${s['estimated_cost_usd']:.4f}")
            print("  └────────────────────────────────────────────┘")
        print("=" * 60)

    # ═══════════════════════════════════════════════════════════════════════
    # Full pipeline (run both phases)
    # ═══════════════════════════════════════════════════════════════════════

    def _phase_a_complete(self) -> bool:
        """True iff every loadable chunk is already persisted **and** embedded.

        Parses the source folders (cheap, no store writes) to learn how many
        chunks Phase A would produce, then checks the SQLite ``chunks`` table
        and the vector ``chunks`` collection both cover them. A partial Phase A
        (persisted but not embedded, or fewer rows than sources) counts as *not*
        complete, so the canonical runner re-runs Phase A from the start.
        """
        # Once persistence commits, retries must use its durable batch workset.
        # Do not parse/filter the source directory merely to discover that the
        # embedding step is incomplete: that would poison the in-memory workset
        # with an empty post-dedup source load.
        if self.checkpoint and self.checkpoint.is_done(
            "phase_a.persist_chunks", params={"ingestion_plan_schema": 1}
        ):
            return self.checkpoint.is_done("phase_a.embed_chunks")

        self._init_stores()
        if self.batch_id is not None:
            batch = self.store.get_ingest_batch(self.batch_id)
            if batch is not None and batch["state"] == "ready":
                return False
        self._load_sources()
        expected = len(self.all_chunks())
        if expected == 0:
            return False
        persisted = self.store.count_chunks()
        embedded = self.qdrant.count("chunks")
        return persisted >= expected and embedded >= expected

    def close(self):
        # Always close the extractor's own cache connection — the extractor is
        # created by the pipeline (not injected), so its SQLite handle is ours
        # to close even when the graph/vector stores were injected by a caller.
        extractor = getattr(self, "extractor", None)
        if extractor is not None:
            extractor.close()
        # Never close injected stores — their owner (e.g. kl-server) manages them.
        if not self._owns_stores:
            return
        if self.store:
            self.store.close()
        if self.qdrant:
            self.qdrant.close()
        self._release_lock()
