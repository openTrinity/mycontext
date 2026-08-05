"""LLM-based entity and fact extraction with result caching.

Uses qwen3.7-plus via litellm (Anthropic mode) for structured extraction.
All raw LLM results are cached as JSON so different graph-build configurations
can reuse them without re-running the expensive extraction.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Optional

import litellm

# Disable litellm's aiohttp transport to avoid ASCII encoding errors on
# response headers with non-ASCII characters (e.g. from Chinese API gateways).
litellm.disable_aiohttp_transport = True

from pydantic import BaseModel, Field

from kl_graph.config import LLM_BASE_URL, LLM_MODEL
from kl_graph.models.types import Chunk, Message


def _sender_of(chunk: Chunk) -> str:
    """Best-effort author label for any chunk.

    Chat messages carry a real ``sender``; other sources fall back to
    ``source_ref`` (file/doc id, author) or the source type, so the extractor
    and cache metadata work uniformly across sources.
    """
    sender = getattr(chunk, "sender", None)
    if sender:
        return sender
    return chunk.source_ref or chunk.source_type


# ─── Pydantic Models for Structured Output ──────────────────────────────


class ExtractedEntity(BaseModel):
    """An entity mentioned in the message."""

    name: str = Field(
        description="Canonical name. Use full proper nouns, never pronouns."
    )
    entity_type: str = Field(
        description="One of: Person, System, Project, Team, Concept, Event"
    )


class ExtractedFact(BaseModel):
    """A discrete factual claim stated or implied by the message."""

    subject_entity: str = Field(description="Name of the entity this fact is about")
    object_entity: Optional[str] = Field(
        default=None, description="Related entity (if binary relation)"
    )
    relation_type: str = Field(
        description="SCREAMING_SNAKE_CASE relation, e.g. DECIDED_TO, RESPONSIBLE_FOR"
    )
    fact_text: str = Field(
        description="Natural language statement preserving all specifics"
    )
    fact_type: str = Field(
        description="One of: DECISION, DELEGATE, STATUS, CAUSAL, OPINION, GENERAL"
    )
    confidence: float = Field(
        default=0.9,
        description=(
            "How strongly the message supports this fact, as a continuous value "
            "in [0,1]. Use the full range: values near 1.0 mean the fact is "
            "explicitly and unambiguously stated, values around the middle mean "
            "it is implied but not stated verbatim, and values near 0.0 mean it "
            "is only weakly or speculatively implied."
        ),
    )
    valid_at: Optional[str] = Field(
        default=None, description="ISO 8601 when fact became true"
    )
    invalid_at: Optional[str] = Field(
        default=None, description="ISO 8601 when fact ceased to be true"
    )


class ExtractionResult(BaseModel):
    """Combined entity and fact extraction from a single message."""

    entities: list[ExtractedEntity] = Field(default_factory=list)
    facts: list[ExtractedFact] = Field(default_factory=list)


# ─── Prompts ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an information extraction assistant for a Chinese workplace chat system (DingTalk/钉钉).

Given a message (with context from surrounding messages), extract:
1. ENTITIES: People, systems, projects, teams, concepts mentioned
2. FACTS: Discrete factual claims made in the message

ENTITY RULES:
- Use full proper nouns, never pronouns or generic descriptions
- "张伟" not "他", "Qwen" not "the model"
- Do NOT extract abstract concepts (e.g., "性能", "问题") unless they refer to a specific named thing
- Persons: use the most complete form of their name you can determine
- If someone has a 花名 (alias), extract both the real name and alias as the same entity using the most complete form, e.g. "张伟(小张)" → name: "张伟"
- Systems/Projects: use their known product name (InkFlow, Qwen, sandbox)
- Do NOT extract generic words, verbs, or adjectives as entities

FACT RULES:
- Each fact is a single, atomic claim
- Preserve ALL specific details (numbers, dates, versions, decisions)
- Include temporal bounds (valid_at/invalid_at) if the message indicates when something started/ended
- relation_type in SCREAMING_SNAKE_CASE (DECIDED_TO, RESPONSIBLE_FOR, DEPLOYED, BLOCKED_BY, WORKS_ON, etc.)
- fact_text should be a complete natural language sentence in Chinese
- Do NOT infer facts not directly stated or strongly implied by the message
- subject_entity and object_entity must be entity names from the entities list
- confidence is a continuous value in [0,1] reflecting how strongly the message supports the fact: use the full range, with values near 1.0 when explicitly and unambiguously stated, mid-range values when clearly implied, and values near 0.0 when weakly or speculatively implied

If the message is trivial (greetings, emoji, simple acknowledgments), return empty lists.

Output valid JSON matching the schema."""

USER_PROMPT_TEMPLATE = """<CONTEXT MESSAGES>
{context}
</CONTEXT MESSAGES>

<TARGET MESSAGE (extract from this one)>
Sender: {sender}
Time: {time}
Content: {content}
</TARGET MESSAGE>

Extract entities and facts from the TARGET MESSAGE only. Use the context for disambiguation.

Output JSON with this EXACT schema:
{{
  "entities": [
    {{"name": "entity name", "entity_type": "Person|System|Project|Team|Concept|Event"}}
  ],
  "facts": [
    {{
      "subject_entity": "entity name",
      "object_entity": "related entity or null",
      "relation_type": "SCREAMING_SNAKE_CASE",
      "fact_text": "complete natural language claim in Chinese",
      "fact_type": "DECISION|DELEGATE|STATUS|CAUSAL|OPINION|GENERAL",
      "confidence": 0.9,
      "valid_at": "ISO 8601 or null",
      "invalid_at": "ISO 8601 or null"
    }}
  ]
}}

If nothing meaningful to extract, return {{"entities": [], "facts": []}}"""


# ─── Batch prompt for multiple messages at once ──────────────────────────

BATCH_USER_PROMPT_TEMPLATE = """<MESSAGES>
{messages_block}
</MESSAGES>

For EACH message above, extract entities and facts. Output JSON array with one entry per message, in order:

{{
  "results": [
    {{
      "msg_index": 0,
      "entities": [{{"name": "...", "entity_type": "Person|System|Project|Team|Concept|Event"}}],
      "facts": [{{
        "subject_entity": "entity name",
        "object_entity": "related entity or null",
        "relation_type": "SCREAMING_SNAKE_CASE",
        "fact_text": "complete claim in Chinese",
        "fact_type": "DECISION|DELEGATE|STATUS|CAUSAL|OPINION|GENERAL",
        "confidence": 0.9,
        "valid_at": null,
        "invalid_at": null
      }}]
    }}
  ]
}}

Rules:
- Process each message independently
- For trivial messages (greetings, acknowledgments), use empty lists
- Return exactly {n_messages} entries in the results array, one per message"""


# ─── Skip patterns for trivial messages ──────────────────────────────────

SKIP_PATTERNS = [
    re.compile(r"^\[图片消息\]"),
    re.compile(r"^\[语音消息\]"),
    re.compile(r"^\[视频消息\]"),
    re.compile(r"^\[文件\]"),
    re.compile(
        r"^(好的?|ok|OK|Ok|收到|嗯+|嗯嗯|哈哈+|666|👍|💪|🙏|对的?|是的|行|可以|没问题|了解|明白|知道了|谢谢|thx|thanks)$",
        re.IGNORECASE,
    ),
    re.compile(r"^.{0,3}$"),  # 3 chars or less
]


def needs_extraction(msg: Chunk) -> bool:
    """Returns False for trivial chunks that won't yield useful entities/facts."""
    content = msg.content.strip()
    # Skip media-only messages
    if (
        "[图片消息](mediaId=" in content
        and len(content.replace("[图片消息]", "").strip()) < 10
    ):
        return False
    for pattern in SKIP_PATTERNS:
        if pattern.match(content):
            return False
    return True


# ─── LLM Extractor ──────────────────────────────────────────────────────


class LLMExtractor:
    """Async LLM-based entity+fact extraction with disk caching."""

    CONTEXT_WINDOW = 3  # messages before and after target

    def __init__(
        self,
        cache_dir: Path,
        base_url: str = LLM_BASE_URL,
        model: str = LLM_MODEL,
        api_key: Optional[str] = None,
        max_concurrent: int = 50,
    ):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # litellm in Anthropic mode: provider-prefixed model + Anthropic base.
        self.model = f"anthropic/{model}"
        self.base_url = base_url
        self.api_key = api_key or os.environ.get("ANTHROPIC_AUTH_TOKEN", "not-set")
        self.semaphore = asyncio.Semaphore(max_concurrent)

        # Stats
        self.stats = {
            "total": 0,
            "skipped_trivial": 0,
            "cache_hits": 0,
            "llm_calls": 0,
            "llm_errors": 0,
            "empty_results": 0,
            # LLM token/cost tracking
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "estimated_cost_usd": 0.0,
        }

    def _track_usage(self, resp) -> None:
        """Extract token usage and estimated cost from a litellm response."""
        try:
            usage = getattr(resp, "usage", None)
            if usage:
                pt = getattr(usage, "prompt_tokens", 0) or 0
                ct = getattr(usage, "completion_tokens", 0) or 0
                tt = getattr(usage, "total_tokens", 0) or (pt + ct)
                self.stats["prompt_tokens"] += pt
                self.stats["completion_tokens"] += ct
                self.stats["total_tokens"] += tt
        except Exception:
            pass
        # litellm stores cost in hidden params; fall back to 0
        try:
            cost = litellm.completion_cost(resp)
            if cost is not None:
                self.stats["estimated_cost_usd"] += cost
        except Exception:
            pass

    def _cache_key(self, msg: Message) -> str:
        """Deterministic cache key from message ID."""
        return hashlib.md5(msg.id.encode()).hexdigest()

    def _cache_path(self, msg: Message) -> Path:
        """Path to cached extraction result."""
        key = self._cache_key(msg)
        # Shard into subdirectories to avoid too many files in one dir
        return self.cache_dir / key[:2] / f"{key}.json"

    def _read_cache(self, msg: Message) -> Optional[dict]:
        """Read cached result if exists."""
        path = self._cache_path(msg)
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                return None
        return None

    def _write_cache(self, msg: Message, result: dict):
        """Write extraction result to cache."""
        path = self._cache_path(msg)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

    def _format_context(self, messages: list[Message], target_idx: int) -> str:
        """Format context window around target message."""
        start = max(0, target_idx - self.CONTEXT_WINDOW)
        end = min(len(messages), target_idx + self.CONTEXT_WINDOW + 1)

        lines = []
        for i in range(start, end):
            if i == target_idx:
                continue  # skip target, it goes in the main section
            msg = messages[i]
            lines.append(f"[{msg.sender}]: {msg.content[:300]}")

        return "\n".join(lines) if lines else "(no context)"

    def _format_time(self, timestamp: int) -> str:
        """Format unix ms timestamp to readable string."""
        if timestamp <= 0:
            return "unknown"
        from datetime import datetime

        dt = datetime.fromtimestamp(timestamp / 1000)
        return dt.strftime("%Y-%m-%d %H:%M:%S")

    def _strip_code_blocks(self, text: str) -> str:
        """Strip markdown code blocks from LLM output."""
        text = text.strip()
        # Remove ```json ... ``` wrapping
        if text.startswith("```"):
            # Find the end of the first line (```json or ```)
            first_newline = text.find("\n")
            if first_newline != -1:
                text = text[first_newline + 1 :]
            # Remove trailing ```
            if text.rstrip().endswith("```"):
                text = text.rstrip()[:-3].rstrip()
        return text

    async def _call_llm(self, msg: Message, context: str) -> dict:
        """Make one LLM call for extraction."""
        user_content = USER_PROMPT_TEMPLATE.format(
            context=context,
            sender=msg.sender,
            time=self._format_time(msg.timestamp),
            content=msg.content[:1000],  # cap at 1000 chars
        )

        async with self.semaphore:
            content = ""
            try:
                resp = await litellm.acompletion(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_content},
                    ],
                    api_base=self.base_url,
                    api_key=self.api_key,
                    response_format={"type": "json_object"},
                    temperature=0.1,
                    max_tokens=8192,
                )
                content = resp.choices[0].message.content
                # Track token usage and cost
                self._track_usage(resp)

                # Strip markdown code blocks if present
                cleaned = self._strip_code_blocks(content)
                # Parse JSON response
                result = json.loads(cleaned)

                # Normalize: ensure entities and facts keys exist
                if "entities" not in result:
                    result["entities"] = []
                if "facts" not in result:
                    result["facts"] = []

                self.stats["llm_calls"] += 1
                return result

            except json.JSONDecodeError as e:
                # LLM returned invalid JSON - save raw for debugging
                self.stats["llm_errors"] += 1
                return {
                    "entities": [],
                    "facts": [],
                    "_error": f"JSON parse: {str(e)}",
                    "_raw": content,
                }
            except Exception as e:
                self.stats["llm_errors"] += 1
                return {"entities": [], "facts": [], "_error": str(e)}

    async def extract_one(
        self,
        msg: Message,
        conversation_messages: list[Message],
        target_idx: int,
    ) -> dict:
        """Extract entities and facts from one message, with caching.

        Returns raw dict (not parsed into Pydantic models) for maximum flexibility.
        The raw result is cached to disk.
        """
        self.stats["total"] += 1

        # Skip trivial messages
        if not needs_extraction(msg):
            self.stats["skipped_trivial"] += 1
            empty = {"entities": [], "facts": [], "_skipped": True}
            self._write_cache(msg, empty)
            return empty

        # Check cache
        cached = self._read_cache(msg)
        if cached is not None:
            self.stats["cache_hits"] += 1
            return cached

        # Build context and call LLM
        context = self._format_context(conversation_messages, target_idx)
        result = await self._call_llm(msg, context)

        # Annotate with metadata for traceability
        result["_msg_id"] = msg.id
        result["_msg_sender"] = msg.sender
        result["_msg_timestamp"] = msg.timestamp
        result["_msg_content_preview"] = msg.content[:200]

        if not result["entities"] and not result["facts"]:
            self.stats["empty_results"] += 1

        # Cache the result
        self._write_cache(msg, result)
        return result

    async def _call_llm_batch(self, messages: list[Message]) -> list[dict]:
        """Make one LLM call to extract from multiple messages at once."""
        # Format messages block
        lines = []
        for i, msg in enumerate(messages):
            lines.append(
                f"[Message {i}] Sender: {_sender_of(msg)} | Time: {self._format_time(msg.timestamp)}"
            )
            lines.append(f"Content: {msg.content[:500]}")
            lines.append("")

        messages_block = "\n".join(lines)
        user_content = BATCH_USER_PROMPT_TEMPLATE.format(
            messages_block=messages_block,
            n_messages=len(messages),
        )

        async with self.semaphore:
            content = ""
            try:
                resp = await litellm.acompletion(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_content},
                    ],
                    api_base=self.base_url,
                    api_key=self.api_key,
                    response_format={"type": "json_object"},
                    temperature=0.1,
                    max_tokens=16384,
                )
                content = resp.choices[0].message.content
                # Track token usage and cost
                self._track_usage(resp)

                cleaned = self._strip_code_blocks(content)
                result = json.loads(cleaned)

                self.stats["llm_calls"] += 1

                # Parse the batch response
                if "results" in result and isinstance(result["results"], list):
                    return result["results"]
                # Fallback: maybe it returned a single result
                if "entities" in result:
                    return [result]
                return [{"entities": [], "facts": []} for _ in messages]

            except json.JSONDecodeError as e:
                self.stats["llm_errors"] += 1
                # Try to salvage: maybe partial JSON
                return [
                    {"entities": [], "facts": [], "_error": f"batch JSON: {str(e)}"}
                    for _ in messages
                ]
            except Exception as e:
                self.stats["llm_errors"] += 1
                return [
                    {"entities": [], "facts": [], "_error": str(e)} for _ in messages
                ]

    async def extract_all_flat(
        self,
        all_messages: list[Chunk],
        progress_callback=None,
    ) -> None:
        """Extract from all chunks using flat parallelism.

        Instead of processing conversation-by-conversation, this fires
        all batch calls concurrently (limited by the semaphore).
        Results are written directly to cache. Works for any :class:`Chunk`
        (chat messages or non-chat sources); the conversation-context window is
        not used on this path.

        Args:
            all_messages: All chunks (any order)
            progress_callback: optional callable(done, total)
        """
        # Separate into messages needing extraction and trivial ones
        to_extract = []
        for msg in all_messages:
            self.stats["total"] += 1
            if not needs_extraction(msg):
                self.stats["skipped_trivial"] += 1
                result = {
                    "entities": [],
                    "facts": [],
                    "_skipped": True,
                    "_msg_id": msg.id,
                    "_msg_sender": _sender_of(msg),
                    "_msg_timestamp": msg.timestamp,
                    "_msg_content_preview": msg.content[:200],
                }
                self._write_cache(msg, result)
            else:
                cached = self._read_cache(msg)
                if cached is not None:
                    self.stats["cache_hits"] += 1
                else:
                    to_extract.append(msg)

        BATCH_SIZE = 30
        print(f"  Messages to extract via LLM: {len(to_extract)}")
        print(
            f"  Batches of {BATCH_SIZE}: "
            f"{(len(to_extract) + BATCH_SIZE - 1) // BATCH_SIZE} LLM calls"
        )

        # Create all batch tasks. Each is wrapped so the progress callback fires
        # as every batch completes (not once per gather-chunk), giving smooth
        # sub-phase progress even for datasets smaller than one gather chunk.
        done_count = 0
        total_batches = (len(to_extract) + BATCH_SIZE - 1) // BATCH_SIZE

        async def _run_batch(batch_msgs):
            nonlocal done_count
            await self._process_batch(batch_msgs)
            done_count += 1
            if progress_callback:
                progress_callback(done_count, total_batches)

        batch_tasks = []
        for i in range(0, len(to_extract), BATCH_SIZE):
            batch_msgs = to_extract[i : i + BATCH_SIZE]
            batch_tasks.append(_run_batch(batch_msgs))

        # Process in chunks of 100 batches to avoid memory issues with gather
        GATHER_SIZE = 100
        for chunk_start in range(0, len(batch_tasks), GATHER_SIZE):
            chunk = batch_tasks[chunk_start : chunk_start + GATHER_SIZE]
            await asyncio.gather(*chunk)
            print(
                f"  Progress: {done_count}/{total_batches} batches "
                f"({done_count * BATCH_SIZE}/{len(to_extract)} msgs)"
            )

    @staticmethod
    def _result_for_slot(
        i: int, batch_results: list[dict], by_index: dict[int, dict]
    ) -> dict:
        """Pick the LLM result for the message labeled ``[Message i]``.

        If the response echoed ``msg_index`` for any entry we trust those indices
        exclusively: slot ``i`` is whatever entry claimed index ``i``, else an
        empty result. This keeps entities/facts attached to the right message
        even if the model reorders entries, and a dropped message leaves an
        empty slot rather than shifting a neighbour into it.

        Only when the response carried *no* usable ``msg_index`` at all do we
        fall back to positional order, which is valid because the batch list
        order is preserved between request and response.
        """
        if by_index:
            return by_index.get(i, {"entities": [], "facts": []})
        if i < len(batch_results):
            return batch_results[i]
        return {"entities": [], "facts": []}

    @staticmethod
    def _index_by_msg_index(batch_results: list[dict]) -> dict[int, dict]:
        """Map valid, unique echoed ``msg_index`` values to their result entry."""
        by_index: dict[int, dict] = {}
        for entry in batch_results:
            if not isinstance(entry, dict):
                continue
            idx = entry.get("msg_index")
            # bool subclasses int; reject it as a spurious index.
            if isinstance(idx, bool) or not isinstance(idx, int):
                continue
            by_index.setdefault(idx, entry)
        return by_index

    async def _process_batch(self, messages: list[Chunk]) -> None:
        """Process a single batch: call LLM and cache results."""
        batch_results = await self._call_llm_batch(messages)
        by_index = self._index_by_msg_index(batch_results)

        for i, msg in enumerate(messages):
            result = self._result_for_slot(i, batch_results, by_index)

            # Annotate with metadata
            result["_msg_id"] = msg.id
            result["_msg_sender"] = _sender_of(msg)
            result["_msg_timestamp"] = msg.timestamp
            result["_msg_content_preview"] = msg.content[:200]

            if not result.get("entities") and not result.get("facts"):
                self.stats["empty_results"] += 1

            self._write_cache(msg, result)

    def print_stats(self):
        """Print extraction statistics."""
        s = self.stats
        print(f"  Total messages processed: {s['total']}")
        print(f"  Skipped (trivial): {s['skipped_trivial']}")
        print(f"  Cache hits: {s['cache_hits']}")
        print(f"  LLM calls made: {s['llm_calls']}")
        print(f"  LLM errors: {s['llm_errors']}")
        print(f"  Empty results: {s['empty_results']}")
        effective = s["total"] - s["skipped_trivial"]
        if effective > 0:
            hit_rate = s["cache_hits"] / effective * 100
            print(f"  Cache hit rate: {hit_rate:.1f}%")
        # Token/cost summary
        print(f"  ── LLM Token Usage ──")
        print(f"  Prompt tokens:     {s['prompt_tokens']:,}")
        print(f"  Completion tokens: {s['completion_tokens']:,}")
        print(f"  Total tokens:       {s['total_tokens']:,}")
        if s["llm_calls"] > 0:
            avg_pt = s["prompt_tokens"] / s["llm_calls"]
            avg_ct = s["completion_tokens"] / s["llm_calls"]
            print(f"  Avg tokens/call:   {avg_pt:.0f} in + {avg_ct:.0f} out")
        print(f"  Estimated cost:    ${s['estimated_cost_usd']:.4f}")
