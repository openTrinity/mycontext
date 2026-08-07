"""Pattern-based fact extraction (no LLM)."""

from __future__ import annotations

import re
import uuid

from kl_graph.models.types import Chunk, Entity, Fact, FactType

# Fact extraction patterns grouped by type
FACT_PATTERNS: dict[FactType, list[re.Pattern]] = {
    FactType.DECISION: [
        re.compile(r"决定.{2,}"),
        re.compile(r"确定.{2,}(方案|计划|方向)"),
        re.compile(r"采用.{2,}"),
        re.compile(r"最终.{2,}"),
        re.compile(r"定了.{2,}"),
        re.compile(r"方案是.{2,}"),
        re.compile(r"结论.{0,2}(是|：).{2,}"),
    ],
    FactType.DELEGATE: [
        re.compile(r".{1,8}负责.{2,}"),
        re.compile(r"你来.{2,}"),
        re.compile(r"交给.{1,6}"),
        re.compile(r".{1,8}跟进.{2,}"),
        re.compile(r".{1,8}(owner|负责人)"),
        re.compile(r"分工.{2,}"),
    ],
    FactType.STATUS: [
        re.compile(r".{2,}完成了"),
        re.compile(r".{2,}(上线|发布)了?"),
        re.compile(r".{2,}(delay|postpone|延期)"),
        re.compile(r"进度.{2,}"),
        re.compile(r".{2,}(搞定|done|完工)"),
        re.compile(r"(目前|现在).{2,}(状态|进展|情况)"),
        re.compile(r".{2,}(blocked|卡住|阻塞)"),
    ],
    FactType.CAUSAL: [
        re.compile(r"因为.{2,}所以.{2,}"),
        re.compile(r".{2,}导致.{2,}"),
        re.compile(r".{2,}影响.{2,}"),
        re.compile(r"(原因|问题)(是|在于).{2,}"),
    ],
}

# Minimum content length to consider for fact extraction
MIN_FACT_LENGTH = 8
# Maximum fact text length (truncate very long messages)
MAX_FACT_TEXT = 200


class FactExtractor:
    """Pattern-based fact extraction from messages."""

    def __init__(self):
        self.patterns = FACT_PATTERNS

    def extract(
        self, message: Chunk, entities: list[Entity]
    ) -> list[Fact]:
        """Extract facts from a message using pattern matching.

        Args:
            message: The source message
            entities: Entities already extracted from this message

        Returns:
            List of extracted Fact objects (usually 0 or 1 per message)
        """
        content = message.content.strip()

        # Skip very short messages
        if len(content) < MIN_FACT_LENGTH:
            return []

        # Skip image/media messages
        if content.startswith("[图片消息]") or content.startswith("[语音消息]"):  # noqa: PIE810
            return []
        if "[图片消息](mediaId=" in content and len(content.replace("[图片消息]", "").strip()) < 10:
            return []

        # Skip pure emoji/reaction messages
        if len(content) < 5:
            return []

        facts = []
        for fact_type, patterns in self.patterns.items():
            for pattern in patterns:
                if pattern.search(content):
                    fact_text = content[:MAX_FACT_TEXT]
                    fact = Fact(
                        id=str(uuid.uuid5(uuid.NAMESPACE_DNS, f"fact:{message.id}:{fact_type.value}")),
                        text=fact_text,
                        fact_type=fact_type,
                        timestamp=message.timestamp,
                        confidence=0.8,  # pattern-extracted, not LLM-confirmed
                        source_chunk_id=message.id,
                    )
                    facts.append(fact)
                    break  # one fact type per pattern group per message
            if facts:
                break  # one fact per message for MVP (avoid over-extraction)

        return facts

    def extract_batch(
        self, messages: list[Chunk], entities_per_msg: dict[str, list[Entity]]
    ) -> list[Fact]:
        """Extract facts from multiple messages.

        Args:
            messages: List of messages to process
            entities_per_msg: {message_id: [entities]} mapping

        Returns:
            All extracted facts
        """
        all_facts = []
        for msg in messages:
            entities = entities_per_msg.get(msg.id, [])
            facts = self.extract(msg, entities)
            all_facts.extend(facts)
        return all_facts
