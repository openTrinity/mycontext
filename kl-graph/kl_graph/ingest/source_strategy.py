"""Source processing plans: storage chunks, extraction items, and projection.

Two orthogonal axes drive a source-processing plan:

* **chunking** — how source records become persistent, retrievable chunks and
  how those chunks map back to source units (the recall unit): ``session`` slices,
  overlapping ``fixed_size`` windows, or ``none`` (records stored as-is).
* **extraction** — what the LLM extracts from: one item per chat ``message``
  (with read-only neighbor context) or one item per stored ``chunk``.

A :class:`ComposedStrategy` pairs one :class:`ChunkingPolicy` with one
:class:`ExtractionPolicy`. Any valid pairing is a config choice rather than a
new class; the legacy single-name strategies are thin shims over specific pairs
so their chunk ids and per-item ``strategy_version`` stamps stay byte-identical
(no forced LLM re-extraction).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import replace
from typing import Protocol

import kl_graph.config as config_module
from kl_graph.ingest.extraction_strategy import (
    CHAT_CONTEXT_WINDOW,
    PROMPT_VERSION,
    DocumentChunkExtractionStrategy,
    StoredChunkExtractionStrategy,
)
from kl_graph.ingest.session_chunker import (
    MESSAGE_JOIN,
    _iter_sessions,
    _strip_session_marker,
    slice_chat_sessions,
)
from kl_graph.models.types import (
    Chunk,
    ChunkUnit,
    ExtractionItem,
    ExtractionProjection,
    IngestionPlan,
    SourceUnit,
)

PLAN_SCHEMA_VERSION = 1
_ITEM_NAMESPACE = uuid.UUID("f1d35564-c1ce-49df-ae89-54eef7080642")


def _stable_item_id(*parts: str) -> str:
    name = json.dumps(parts, ensure_ascii=True, separators=(",", ":"))
    return str(uuid.uuid5(_ITEM_NAMESPACE, name))


def _namespace_chunks(chunks: list[Chunk], source_id: str) -> list[Chunk]:
    if source_id == "default":
        return chunks
    for chunk in chunks:
        chunk.id = f"{source_id}:{chunk.id}"
        for key in ("conversation_id", "node_id", "meeting_id", "scope_id"):
            value = chunk.metadata.get(key)
            if value:
                chunk.metadata[key] = f"{source_id}:{value}"
    return chunks


# ---------------------------------------------------------------------------
# Axis protocols
# ---------------------------------------------------------------------------


class ChunkingPolicy(Protocol):
    """Turn source records into stored chunks and their source-unit lineage."""

    version: str

    def build_stored_chunks(
        self, records: list[Chunk], units: list[SourceUnit]
    ) -> list[Chunk]: ...

    def build_chunk_units(
        self,
        chunks: list[Chunk],
        units: list[SourceUnit],
        *,
        source_id: str,
    ) -> list[ChunkUnit]: ...


class ExtractionPolicy(Protocol):
    """Project stored chunks into ephemeral LLM extraction items."""

    version: str

    def build_extraction_items(
        self,
        records: list[Chunk],
        chunks: list[Chunk],
        units: list[SourceUnit],
        *,
        source_id: str,
    ) -> list[ExtractionItem]: ...

    def build_projections(
        self,
        records: list[Chunk],
        chunks: list[Chunk],
        items: list[ExtractionItem],
        memberships: list[ChunkUnit],
        *,
        source_id: str,
    ) -> list[ExtractionProjection]: ...


# ---------------------------------------------------------------------------
# Chunking policies
# ---------------------------------------------------------------------------


class NoneChunking:
    """Store each source record as-is; membership is one chunk per unit."""

    version = "stored-source-v1"

    def build_stored_chunks(
        self, records: list[Chunk], units: list[SourceUnit]
    ) -> list[Chunk]:
        # Return copies, not the records themselves. ``ComposedStrategy.plan``
        # namespaces stored-chunk ids/metadata in place, while ``MessageExtraction``
        # reads the ORIGINAL records by their un-namespaced ids. Aliasing the two
        # would silently zero out message extraction under ``none`` chunking
        # (records would carry the namespaced id extraction cannot match), so we
        # deep-copy the mutable metadata dict here.
        return [replace(record, metadata=dict(record.metadata)) for record in records]

    def build_chunk_units(
        self,
        chunks: list[Chunk],
        units: list[SourceUnit],
        *,
        source_id: str,
    ) -> list[ChunkUnit]:
        selected = {(unit.source_type, unit.unit_id) for unit in units}
        ordinals: dict[tuple[str, str], int] = {}
        memberships: list[ChunkUnit] = []
        for chunk in chunks:
            unit_id = str(chunk.metadata.get("unit_id") or chunk.id)
            if source_id != "default" and unit_id.startswith(f"{source_id}:"):
                unit_id = unit_id[len(source_id) + 1 :]
            key = (chunk.source_type, unit_id)
            if key not in selected:
                continue
            ordinal = ordinals.get(key, 0)
            ordinals[key] = ordinal + 1
            memberships.append(
                ChunkUnit(
                    chunk_id=chunk.id,
                    source_id=source_id,
                    source_type=chunk.source_type,
                    unit_id=unit_id,
                    unit_ordinal_in_chunk=0,
                    chunk_ordinal_in_unit=ordinal,
                    start_offset=0,
                    end_offset=len(chunk.content),
                )
            )
        return memberships


class SessionChunking:
    """Store session slices; membership follows each slice's member ids."""

    version = "session-chat-v3"

    def build_stored_chunks(
        self, records: list[Chunk], units: list[SourceUnit]
    ) -> list[Chunk]:
        return slice_chat_sessions(records)

    def build_chunk_units(
        self,
        chunks: list[Chunk],
        units: list[SourceUnit],
        *,
        source_id: str,
    ) -> list[ChunkUnit]:
        selected = {unit.unit_id for unit in units if unit.source_type == "message"}
        ordinals: dict[str, int] = {}
        rows: list[ChunkUnit] = []
        for chunk in chunks:
            for member_ordinal, raw_unit_id in enumerate(
                chunk.metadata.get("member_message_ids") or []
            ):
                unit_id = str(raw_unit_id)
                if unit_id not in selected:
                    continue
                chunk_ordinal = ordinals.get(unit_id, 0)
                ordinals[unit_id] = chunk_ordinal + 1
                rows.append(
                    ChunkUnit(
                        chunk_id=chunk.id,
                        source_id=source_id,
                        source_type="message",
                        unit_id=unit_id,
                        unit_ordinal_in_chunk=member_ordinal,
                        chunk_ordinal_in_unit=chunk_ordinal,
                    )
                )
        return rows


class FixedSizeChunking:
    """Store overlapping fixed-size chat windows with exact unit lineage.

    Storage windows are character-budgeted and remain inside the loader's
    conversation/session boundaries. The ``version`` string is byte-identical
    to the historical ``fixed-size-chat-v1:{size}:{overlap}`` because chunk ids
    hash it (see :meth:`_chunk_session`); changing it would re-key every stored
    chunk.
    """

    def __init__(self, chunk_size_chars: int, overlap_chars: int):
        if chunk_size_chars <= 0:
            raise ValueError("fixed-size chunk_size_chars must be positive")
        if overlap_chars < 0:
            raise ValueError("fixed-size overlap_chars cannot be negative")
        if overlap_chars >= chunk_size_chars:
            raise ValueError(
                "fixed-size overlap_chars must be smaller than chunk_size_chars"
            )
        self.chunk_size_chars = chunk_size_chars
        self.overlap_chars = overlap_chars
        self.version = f"fixed-size-chat-v1:{chunk_size_chars}:{overlap_chars}"

    def build_stored_chunks(
        self, records: list[Chunk], units: list[SourceUnit]
    ) -> list[Chunk]:
        chunks: list[Chunk] = []
        session_index_by_conv: dict[str, int] = {}
        for session in _iter_sessions(records):
            conv_id = str(session[0].metadata.get("conversation_id") or "")
            session_index = session_index_by_conv.get(conv_id, 0)
            session_index_by_conv[conv_id] = session_index + 1
            chunks.extend(
                self._chunk_session(
                    session,
                    conversation_id=conv_id,
                    session_index=session_index,
                )
            )
        return chunks

    def _chunk_session(
        self,
        records: list[Chunk],
        *,
        conversation_id: str,
        session_index: int,
    ) -> list[Chunk]:
        """Slice one session and retain source-relative spans for every window."""
        parts: list[str] = []
        source_ranges: list[tuple[int, int, int, Chunk]] = []
        cursor = 0
        for index, record in enumerate(records):
            if index:
                parts.append(MESSAGE_JOIN)
                cursor += len(MESSAGE_JOIN)
            content = _strip_session_marker(record.content)
            if not content:
                raise ValueError(
                    f"fixed-size chat record {record.id!r} has no content"
                )
            source_base = len(record.content) - len(content)
            start = cursor
            parts.append(content)
            cursor += len(content)
            source_ranges.append((start, cursor, source_base, record))

        stream = "".join(parts)
        step = self.chunk_size_chars - self.overlap_chars
        first_meta = records[0].metadata
        chunks: list[Chunk] = []
        window_start = 0
        window_ordinal = 0
        while window_start < len(stream):
            window_end = min(window_start + self.chunk_size_chars, len(stream))
            lineage: list[dict[str, int | str]] = []
            members: list[Chunk] = []
            for unit_start, unit_end, source_base, record in source_ranges:
                overlap_start = max(window_start, unit_start)
                overlap_end = min(window_end, unit_end)
                if overlap_start >= overlap_end:
                    continue
                lineage.append(
                    {
                        "unit_id": record.id,
                        "start_offset": source_base + overlap_start - unit_start,
                        "end_offset": source_base + overlap_end - unit_start,
                    }
                )
                members.append(record)

            # A tiny budget can produce a separator-only window. It carries no
            # source evidence, so omit it from the ingestion plan.
            if lineage:
                metadata: dict = {
                    "conversation_id": conversation_id,
                    "session_index": session_index,
                    "slice_index": window_ordinal,
                    "member_message_ids": [record.id for record in members],
                    "senders": list(
                        dict.fromkeys(
                            str(record.metadata.get("sender") or "")
                            for record in members
                            if record.metadata.get("sender")
                        )
                    ),
                    "reply_to_message_ids": list(
                        dict.fromkeys(
                            str(record.metadata.get("reply_to") or "")
                            for record in members
                            if record.metadata.get("reply_to")
                        )
                    ),
                    "extraction_target_contents": [
                        str(
                            record.metadata.get("extraction_target_content")
                            or record.content
                        )
                        for record in members
                    ],
                    "quoted_contexts": [
                        str(record.metadata.get("quoted_context") or "")
                        for record in members
                    ],
                    "lineage_spans": lineage,
                    "window_start": window_start,
                    "window_end": window_end,
                }
                if not chunks:
                    metadata["session_start"] = True
                for key in ("conversation_title", "chat_kind"):
                    if first_meta.get(key):
                        metadata[key] = first_meta[key]
                span_identity = json.dumps(
                    lineage, sort_keys=True, separators=(",", ":")
                )
                chunk_id = _stable_item_id(
                    "fixed-size-chunk",
                    self.version,
                    conversation_id,
                    span_identity,
                )
                chunks.append(
                    Chunk(
                        id=chunk_id,
                        content=stream[window_start:window_end],
                        source_type="message",
                        timestamp=members[0].timestamp,
                        source_ref=members[0].source_ref,
                        metadata=metadata,
                    )
                )
            if window_end == len(stream):
                break
            window_start += step
            window_ordinal += 1
        return chunks

    def build_chunk_units(
        self,
        chunks: list[Chunk],
        units: list[SourceUnit],
        *,
        source_id: str,
    ) -> list[ChunkUnit]:
        selected = {unit.unit_id for unit in units if unit.source_type == "message"}
        ordinals: dict[str, int] = {}
        rows: list[ChunkUnit] = []
        for chunk in chunks:
            unit_ordinal = 0
            for span in chunk.metadata.get("lineage_spans") or []:
                unit_id = str(span["unit_id"])
                if unit_id not in selected:
                    continue
                chunk_ordinal = ordinals.get(unit_id, 0)
                ordinals[unit_id] = chunk_ordinal + 1
                rows.append(
                    ChunkUnit(
                        chunk_id=chunk.id,
                        source_id=source_id,
                        source_type="message",
                        unit_id=unit_id,
                        unit_ordinal_in_chunk=unit_ordinal,
                        chunk_ordinal_in_unit=chunk_ordinal,
                        start_offset=int(span["start_offset"]),
                        end_offset=int(span["end_offset"]),
                    )
                )
                unit_ordinal += 1
        return rows


# ---------------------------------------------------------------------------
# Extraction policies
# ---------------------------------------------------------------------------


class MessageExtraction:
    """Extract every complete source message once, with read-only context.

    ``version`` is a fixed constant (not derived from the composed strategy) so
    the per-item ``strategy_version`` stamp — the extraction-cache key — stays
    byte-identical to the historical ``session-chat-v3`` regardless of which
    chunking policy it is paired with.
    """

    version = "session-chat-v3"

    def __init__(self, context_window: int = CHAT_CONTEXT_WINDOW):
        self.context_window = context_window

    def build_extraction_items(
        self,
        records: list[Chunk],
        chunks: list[Chunk],
        units: list[SourceUnit],
        *,
        source_id: str,
    ) -> list[ExtractionItem]:
        selected = {unit.unit_id for unit in units if unit.source_type == "message"}
        items: list[ExtractionItem] = []
        for index, record in enumerate(records):
            if record.id not in selected:
                continue
            start = max(0, index - self.context_window)
            end = min(len(records), index + self.context_window + 1)
            neighbor_context = "\n\n".join(
                f"[CONTEXT {offset - index:+d}]\n{records[offset].content}"
                for offset in range(start, end)
                if offset != index
                and records[offset].metadata.get("conversation_id")
                == record.metadata.get("conversation_id")
            )
            quote_context = str(record.metadata.get("quoted_context") or "")
            context = "\n\n".join(
                value
                for value in (
                    (
                        "[QUOTED REPLY - READ ONLY; DO NOT RE-EXTRACT]\n"
                        f"{quote_context}"
                        if quote_context
                        else ""
                    ),
                    neighbor_context,
                )
                if value
            )
            target_content = str(
                record.metadata.get("extraction_target_content") or record.content
            )
            item_id = _stable_item_id(source_id, "message", record.id, "complete")
            metadata = dict(record.metadata)
            metadata.update(
                extraction_strategy="chat_message",
                source_unit_id=record.id,
            )
            items.append(
                ExtractionItem(
                    id=item_id,
                    source_type="message",
                    content=target_content,
                    context=context,
                    target_chunk_id="",  # filled from the primary projection below
                    source_unit_id=record.id,
                    timestamp=record.timestamp,
                    source_ref=record.source_ref,
                    strategy_version=self.version,
                    prompt_version=PROMPT_VERSION,
                    metadata=metadata,
                )
            )
        return items

    def build_projections(
        self,
        records: list[Chunk],
        chunks: list[Chunk],
        items: list[ExtractionItem],
        memberships: list[ChunkUnit],
        *,
        source_id: str,
    ) -> list[ExtractionProjection]:
        chunks_by_unit: dict[str, list[str]] = {}
        for row in memberships:
            chunks_by_unit.setdefault(row.unit_id, []).append(row.chunk_id)
        projections: list[ExtractionProjection] = []
        for item in items:
            chunk_ids = chunks_by_unit.get(str(item.source_unit_id), [])
            if not chunk_ids:
                continue
            item.target_chunk_id = chunk_ids[0]
            item.metadata["target_chunk_id"] = chunk_ids[0]
            projections.extend(
                ExtractionProjection(
                    extraction_item_id=item.id,
                    chunk_id=chunk_id,
                    role="primary" if ordinal == 0 else "supporting",
                )
                for ordinal, chunk_id in enumerate(chunk_ids)
            )
        return projections


class _ChunkExtraction:
    """Shared base: extract each stored chunk once, one primary projection each.

    A stored chunk can span several source units (a session slice, an
    overlapping window), so per-unit attribution is undefined for whole-chunk
    extraction — the underlying strategies leave ``source_unit_id`` ``None``.
    Subclasses bind one concrete :class:`ExtractionStrategy` (``_strategy``);
    which one is a **config choice** (the legacy name / the resolved pair), never
    a hard-coded source-type guess, so custom ``strategies`` overrides keep their
    historical context and per-item ``strategy_version`` fingerprints.
    """

    version: str
    _strategy: object  # ExtractionStrategy (build(chunk) -> list[ExtractionItem])

    def build_extraction_items(
        self,
        records: list[Chunk],
        chunks: list[Chunk],
        units: list[SourceUnit],
        *,
        source_id: str,
    ) -> list[ExtractionItem]:
        items: list[ExtractionItem] = []
        for chunk in chunks:
            for item in self._strategy.build(chunk):
                stable_id = _stable_item_id(
                    source_id, chunk.source_type, "stored-chunk", chunk.id
                )
                items.append(replace(item, id=stable_id))
        return items

    def build_projections(
        self,
        records: list[Chunk],
        chunks: list[Chunk],
        items: list[ExtractionItem],
        memberships: list[ChunkUnit],
        *,
        source_id: str,
    ) -> list[ExtractionProjection]:
        return [
            ExtractionProjection(
                extraction_item_id=item.id,
                chunk_id=item.target_chunk_id,
                role="primary",
            )
            for item in items
        ]


class StoredChunkExtraction(_ChunkExtraction):
    """Extract the stored chunk text verbatim (generic + chat session slices).

    Legacy ``stored_chunk``; the default fallback for unmapped sources and the
    ``*+chunk`` path for chat session slices. Stamps ``stored-chunk-v1:*``.
    """

    version = "chunk-extraction-stored-v1"

    def __init__(self) -> None:
        self._strategy = StoredChunkExtractionStrategy()


class DocumentChunkExtraction(_ChunkExtraction):
    """Extract a stored semantic document section with its title context.

    Legacy ``document_chunk``; keeps the title-context wrapper and the
    ``document-chunk-v1:*`` fingerprint.
    """

    version = "chunk-extraction-document-v1"

    def __init__(self) -> None:
        self._strategy = DocumentChunkExtractionStrategy()


# ---------------------------------------------------------------------------
# Composition
# ---------------------------------------------------------------------------


class ComposedStrategy:
    """Pair one chunking policy with one extraction policy into a plan."""

    def __init__(self, chunker: ChunkingPolicy, extractor: ExtractionPolicy):
        self.chunker = chunker
        self.extractor = extractor
        self.version = f"composed-v1:{chunker.version}+{extractor.version}"

    def plan(
        self,
        records: list[Chunk],
        units: list[SourceUnit],
        *,
        source_id: str,
    ) -> IngestionPlan:
        chunks = _namespace_chunks(
            self.chunker.build_stored_chunks(records, units), source_id
        )
        memberships = self.chunker.build_chunk_units(chunks, units, source_id=source_id)
        items = self.extractor.build_extraction_items(
            records, chunks, units, source_id=source_id
        )
        projections = self.extractor.build_projections(
            records, chunks, items, memberships, source_id=source_id
        )
        plan = IngestionPlan(
            chunks=chunks,
            extraction_items=items,
            chunk_units=memberships,
            projections=projections,
            strategy_version=self.version,
            schema_version=PLAN_SCHEMA_VERSION,
        )
        plan.validate()
        return plan


# ---------------------------------------------------------------------------
# Legacy compatibility shims
# ---------------------------------------------------------------------------


class SessionChatProcessingStrategy(ComposedStrategy):
    """Legacy name for session-slice storage + complete-message extraction."""

    def __init__(self, context_window: int = CHAT_CONTEXT_WINDOW):
        super().__init__(SessionChunking(), MessageExtraction(context_window))


class FixedSizeChatProcessingStrategy(ComposedStrategy):
    """Legacy name for fixed-size window storage + complete-message extraction.

    Retains ``chunk_size_chars`` / ``overlap_chars`` attributes read directly by
    callers and tests.
    """

    def __init__(
        self,
        chunk_size_chars: int,
        overlap_chars: int,
        context_window: int = CHAT_CONTEXT_WINDOW,
    ):
        chunker = FixedSizeChunking(chunk_size_chars, overlap_chars)
        super().__init__(chunker, MessageExtraction(context_window))
        self.chunk_size_chars = chunk_size_chars
        self.overlap_chars = overlap_chars


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------

# Legacy single-name strategies expressed as (chunking, extraction) pairs. The
# extraction token is internal and 3-valued — ``message`` | ``stored`` |
# ``document`` — so ``document_chunk`` and ``stored_chunk`` stay distinct (they
# bind different extraction classes with different fingerprints). These are the
# registry's preset arms; each is a fixed pair with no params. ``chat_message``
# is the preset alias of ``chat_processing(session, message)``.
_LEGACY_PAIRS: dict[str, tuple[str, str]] = {
    "chat_message": ("session", "message"),
    "fixed_size_chat": ("fixed_size", "message"),
    "document_chunk": ("none", "document"),
    "stored_chunk": ("none", "stored"),
}

# Source types that expose chat sessions. ``session`` / ``fixed_size`` chunking
# and ``message`` extraction only have meaning here; applying either to a
# document source would silently yield an empty extraction-item set, so
# ``source_strategy_for`` rejects both up front.
_CHAT_SOURCE_TYPE = "message"

# ``chat_processing`` extraction axis -> internal extraction token. The
# parametric chat family exposes only ``message`` | ``chunk`` (verbatim stored
# body); the title-context ``document`` extractor is reachable through the
# ``document_chunk`` preset, since documents do not route through this family.
_CHAT_EXTRACTION = {"message": "message", "chunk": "stored"}


def _resolve_pair(value: object) -> tuple[str, str]:
    """Map a strategies-map value to an internal (chunking, extraction) pair.

    Accepts a bare preset string (unknown names fall back to ``stored_chunk``,
    as the historical resolver did) or a name-tagged spec node (a validated
    ``StrategySpec`` or its DictConfig). ``chat_processing`` carries the two
    axes; every other ``name`` is a preset resolved through ``_LEGACY_PAIRS``.
    The returned extraction token is internal and 3-valued (see ``_LEGACY_PAIRS``).
    """
    if isinstance(value, str):
        return _LEGACY_PAIRS.get(value, _LEGACY_PAIRS["stored_chunk"])
    name = getattr(value, "name", None)
    if name == "chat_processing":
        chunking = str(value.chunking)
        extraction = str(value.extraction)
        return chunking, _CHAT_EXTRACTION.get(extraction, extraction)
    if isinstance(name, str) and name in _LEGACY_PAIRS:
        return _LEGACY_PAIRS[name]
    return _LEGACY_PAIRS["stored_chunk"]


def _make_chunker(chunking: str, extraction_config) -> ChunkingPolicy:
    if chunking == "session":
        return SessionChunking()
    if chunking == "fixed_size":
        fixed = extraction_config.fixed_size_chat
        return FixedSizeChunking(
            chunk_size_chars=int(fixed.chunk_size_chars),
            overlap_chars=int(fixed.overlap_chars),
        )
    if chunking == "none":
        return NoneChunking()
    raise ValueError(f"unknown chunking axis {chunking!r}")


def _make_extractor(extraction: str) -> ExtractionPolicy:
    if extraction == "message":
        return MessageExtraction()
    if extraction == "stored":
        return StoredChunkExtraction()
    if extraction == "document":
        return DocumentChunkExtraction()
    raise ValueError(f"unknown extraction axis {extraction!r}")


def source_strategy_for(source_type: str) -> ComposedStrategy:
    """Resolve the configured source-processing strategy for one source type."""
    extraction_config = config_module.cfg.pipelines.ingestion.extraction
    configured = dict(extraction_config.strategies)
    value = configured.get(source_type, configured.get("default", "stored_chunk"))
    chunking, extraction = _resolve_pair(value)

    # Chat chunkers slice conversation sessions; on a non-chat source they would
    # produce chunks that carry no ``message`` memberships, so extraction cannot
    # attribute them and the plan would be silently empty. Checked first: it is
    # the most fundamental mismatch (independent of the extraction axis) and gives
    # the clearest diagnostic.
    if chunking in ("session", "fixed_size") and source_type != _CHAT_SOURCE_TYPE:
        raise ValueError(
            f"invalid strategy: {chunking!r} chunking requires chat messages but "
            f"source_type={source_type!r} is not {_CHAT_SOURCE_TYPE!r}; use "
            "chunking=none for document sources"
        )
    # ``message`` extraction reads chat message units (it filters
    # ``source_type == 'message'``), so on a non-chat source every message item is
    # dropped and the plan is silently empty. ``none`` + ``message`` on a genuine
    # chat source is valid: ``NoneChunking`` stores each record and builds
    # memberships, so ``MessageExtraction`` can project onto them. (The earlier
    # "no stored chunks" rationale was wrong — ``none`` DOES create stored chunks.)
    if extraction == "message" and source_type != _CHAT_SOURCE_TYPE:
        raise ValueError(
            f"invalid strategy: message extraction requires chat messages but "
            f"source_type={source_type!r} is not {_CHAT_SOURCE_TYPE!r}; use "
            "extraction=chunk for document sources"
        )
    # Fail-fast on combinations that would silently corrupt or empty a plan.
    if chunking == "fixed_size" and extraction != "message":
        raise ValueError(
            "invalid strategy: fixed_size chunking with chunk extraction would "
            "double-extract overlapping windows; use extraction=message"
        )

    chunker = _make_chunker(chunking, extraction_config)
    extractor = _make_extractor(extraction)
    return ComposedStrategy(chunker, extractor)


def combine_plans(plans: list[IngestionPlan]) -> IngestionPlan:
    combined = IngestionPlan(
        chunks=[chunk for plan in plans for chunk in plan.chunks],
        extraction_items=[item for plan in plans for item in plan.extraction_items],
        chunk_units=[row for plan in plans for row in plan.chunk_units],
        projections=[row for plan in plans for row in plan.projections],
        strategy_version="+".join(plan.strategy_version for plan in plans),
        schema_version=PLAN_SCHEMA_VERSION,
    )
    combined.validate()
    return combined
