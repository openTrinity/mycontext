"""Source processing plans: storage chunks, extraction items, and projection."""

from __future__ import annotations

import json
import uuid
from dataclasses import replace

from kl_graph.config import cfg
from kl_graph.ingest.extraction_strategy import (
    CHAT_CONTEXT_WINDOW,
    PROMPT_VERSION,
    strategy_for,
)
from kl_graph.ingest.session_chunker import slice_chat_sessions
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


class SourceProcessingStrategy:
    """Composable source policy with independently overridable plan stages.

    A fixed-size implementation normally overrides ``build_stored_chunks``,
    ``build_chunk_units``, and ``build_projections``. It may keep complete-unit
    extraction by inheriting ``build_extraction_items`` or override that method
    when its extraction policy also changes.
    """

    version = "stored-source-v1"

    def plan(
        self,
        records: list[Chunk],
        units: list[SourceUnit],
        *,
        source_id: str,
    ) -> IngestionPlan:
        chunks = _namespace_chunks(self.build_stored_chunks(records, units), source_id)
        memberships = self.build_chunk_units(chunks, units, source_id=source_id)
        items = self.build_extraction_items(records, chunks, units, source_id=source_id)
        projections = self.build_projections(
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

    def build_stored_chunks(
        self, records: list[Chunk], units: list[SourceUnit]
    ) -> list[Chunk]:
        return records

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
            for item in strategy_for(chunk.source_type).build(chunk):
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


class SessionChatProcessingStrategy(SourceProcessingStrategy):
    """Store session slices but extract every complete source message once."""

    version = "session-chat-v3"

    def __init__(self, context_window: int = CHAT_CONTEXT_WINDOW):
        self.context_window = context_window

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


_SOURCE_STRATEGIES: dict[str, SourceProcessingStrategy] = {
    "chat_message": SessionChatProcessingStrategy(),
    "document_chunk": SourceProcessingStrategy(),
    "stored_chunk": SourceProcessingStrategy(),
}


def source_strategy_for(source_type: str) -> SourceProcessingStrategy:
    configured = dict(cfg.pipelines.ingestion.extraction.strategies)
    name = configured.get(source_type, configured.get("default", "stored_chunk"))
    return _SOURCE_STRATEGIES.get(name, _SOURCE_STRATEGIES["stored_chunk"])


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
