"""Source-aware conversion from stored chunks to ephemeral extraction items."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from kl_graph.config import cfg
from kl_graph.ingest.session_chunker import split_messages
from kl_graph.models.types import Chunk, ExtractionItem

CHAT_CONTEXT_WINDOW = 3
PROMPT_LANGUAGE = str(cfg.pipelines.ingestion.extraction.prompt_language)
PROMPT_VERSION = f"{PROMPT_LANGUAGE}-source-aware-v4"


class ExtractionStrategy(Protocol):
    """Build LLM work items whose results target persistent chunks."""

    def build(self, chunk: Chunk) -> list[ExtractionItem]: ...


@dataclass(frozen=True)
class ChatMessageExtractionStrategy:
    context_window: int = CHAT_CONTEXT_WINDOW
    version: str = "chat-message-v2"

    def build(self, chunk: Chunk) -> list[ExtractionItem]:
        parts = split_messages(chunk.content, chunk.source_type)
        if not parts:
            parts = [chunk.content]
        member_ids = list((chunk.metadata or {}).get("member_message_ids") or [])
        target_contents = list(
            (chunk.metadata or {}).get("extraction_target_contents") or []
        )
        quote_contexts = list((chunk.metadata or {}).get("quoted_contexts") or [])
        items: list[ExtractionItem] = []
        for index, content in enumerate(parts):
            source_unit_id = (
                str(member_ids[index]) if index < len(member_ids) else None
            )
            stable_part = source_unit_id or str(index)
            start = max(0, index - self.context_window)
            end = min(len(parts), index + self.context_window + 1)
            neighbor_context = "\n\n".join(
                f"[CONTEXT {offset - index:+d}]\n{parts[offset]}"
                for offset in range(start, end)
                if offset != index
            )
            target_content = (
                str(target_contents[index])
                if index < len(target_contents) and target_contents[index]
                else content
            )
            quote_context = (
                str(quote_contexts[index])
                if index < len(quote_contexts) and quote_contexts[index]
                else ""
            )
            context = "\n\n".join(
                part
                for part in (
                    (
                        "[QUOTED REPLY - READ ONLY; DO NOT RE-EXTRACT]\n"
                        f"{quote_context}"
                        if quote_context
                        else ""
                    ),
                    neighbor_context,
                )
                if part
            )
            metadata = dict(chunk.metadata or {})
            metadata.update(
                extraction_strategy="chat_message",
                target_chunk_id=chunk.id,
                source_unit_id=source_unit_id,
                member_index=index,
            )
            items.append(
                ExtractionItem(
                    id=f"{chunk.id}::message::{stable_part}",
                    source_type=chunk.source_type,
                    content=target_content,
                    context=context,
                    target_chunk_id=chunk.id,
                    source_unit_id=source_unit_id,
                    timestamp=chunk.timestamp,
                    source_ref=chunk.source_ref,
                    strategy_version=self.version,
                    prompt_version=PROMPT_VERSION,
                    metadata=metadata,
                )
            )
        return items


@dataclass(frozen=True)
class DocumentChunkExtractionStrategy:
    version: str = "document-chunk-v1"

    def build(self, chunk: Chunk) -> list[ExtractionItem]:
        metadata = dict(chunk.metadata or {})
        title = next(
            (
                str(metadata[key]).strip()
                for key in ("title", "subject", "conversation_title")
                if metadata.get(key)
            ),
            "",
        )
        context = f"Document title: {title}" if title else ""
        metadata.update(
            extraction_strategy="document_chunk", target_chunk_id=chunk.id
        )
        return [
            ExtractionItem(
                id=f"{chunk.id}::document",
                source_type=chunk.source_type,
                content=chunk.content,
                context=context,
                target_chunk_id=chunk.id,
                timestamp=chunk.timestamp,
                source_ref=chunk.source_ref,
                strategy_version=f"{self.version}:{chunk.source_type}",
                prompt_version=PROMPT_VERSION,
                metadata=metadata,
            )
        ]


@dataclass(frozen=True)
class StoredChunkExtractionStrategy:
    version: str = "stored-chunk-v1"

    def build(self, chunk: Chunk) -> list[ExtractionItem]:
        metadata = dict(chunk.metadata or {})
        metadata.update(extraction_strategy="stored_chunk", target_chunk_id=chunk.id)
        return [
            ExtractionItem(
                id=f"{chunk.id}::chunk",
                source_type=chunk.source_type,
                content=chunk.content,
                context="",
                target_chunk_id=chunk.id,
                timestamp=chunk.timestamp,
                source_ref=chunk.source_ref,
                strategy_version=f"{self.version}:{chunk.source_type}",
                prompt_version=PROMPT_VERSION,
                metadata=metadata,
            )
        ]


_STRATEGIES: dict[str, ExtractionStrategy] = {
    "chat_message": ChatMessageExtractionStrategy(),
    "document_chunk": DocumentChunkExtractionStrategy(),
    "stored_chunk": StoredChunkExtractionStrategy(),
}


def strategy_for(source_type: str) -> ExtractionStrategy:
    configured = dict(cfg.pipelines.ingestion.extraction.strategies)
    strategy_name = configured.get(source_type, configured.get("default", "stored_chunk"))
    return _STRATEGIES.get(strategy_name, _STRATEGIES["stored_chunk"])


def build_extraction_items(chunks: list[Chunk]) -> list[ExtractionItem]:
    items: list[ExtractionItem] = []
    for chunk in chunks:
        items.extend(strategy_for(chunk.source_type).build(chunk))
    return items
