"""LLM-based entity and fact extraction with result caching.

Uses qwen3.7-plus via litellm (Anthropic mode) for structured extraction.
All raw LLM results are cached as JSON so different graph-build configurations
can reuse them without re-running the expensive extraction.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from pathlib import Path

from pydantic import BaseModel, Field

from kl_graph.config import cfg, DATA_DIR
from kl_graph.utils.litellm_config import litellm, provider_api_key, provider_model

# Derived constants from OmegaConf config
LLM_PROVIDER = cfg.services.llm_flash.provider
LLM_BASE_URL = cfg.services.llm_flash.base_url or ""
LLM_BATCH_SIZE = int(cfg.pipelines.ingestion.extraction.batch_size)
LLM_BATCH_TIMEOUT = int(cfg.pipelines.ingestion.extraction.batch_timeout)
LLM_MAX_RETRIES = int(cfg.services.llm_flash.max_retries)
LLM_MODEL = cfg.services.llm_flash.model
LLM_TIMEOUT = float(cfg.services.llm_flash.timeout)
EXTRACTION_CACHE_PATH = DATA_DIR / "extraction_cache.db"
EXTRACTION_CACHE_MAX_ENTRIES = int(
    cfg.pipelines.ingestion.extraction.cache_max_entries
)
from kl_graph.ingest.extraction_cache import ExtractionCacheStore
from kl_graph.models.types import Chunk

logger = logging.getLogger(__name__)


def _sender_of(chunk: Chunk) -> str:
    """Best-effort author label for any chunk.

    Chat chunks carry a real ``metadata["sender"]``; other sources fall back to
    ``source_ref`` (file/doc id, author) or the source type, so the extractor
    and cache metadata work uniformly across sources.
    """
    sender = (chunk.metadata or {}).get("sender")
    if isinstance(sender, str) and sender:
        return sender
    return chunk.source_ref or chunk.source_type


# ─── @-mention / entity-name sanitizer ───────────────────────────────────

# Broadcast/group addressing tokens that are never a person entity.
_BROADCAST_TOKENS = frozenset(
    {"所有人", "全体成员", "全体", "all", "here", "everyone", "channel"}
)

# Trailing punctuation to strip off a name (CJK + ASCII).
_TRAILING_PUNCT = "，。！？：、,.!?:；;"

# Media/file-id discriminators. DingTalk media/file references are long,
# base64-ish opaque tokens (e.g. ``lQLPKGS2kqdzkgtaVLCpORJ...``, ``lADPxxxx...``).
# We must drop those WITHOUT deleting ordinary long ASCII names/handles like
# ``Engineering_Team`` or ``ChristopherLee``. Two signals, either of which marks
# a token as a media id:
#   1. Known DingTalk prefix: starts with ``lQ``/``lA`` then a long ASCII run.
#      (Real tokens are long; the 18+ tail keeps the prefix from matching short
#      real words that merely start with those two letters.)
#   2. Random-blob signature: long (>=20 chars), NO separators (``_``/``-``/
#      space), AND mixes upper+lower+digit -- the base64-random look. Ordinary
#      handles are shorter, use separators, or lack the upper+lower+digit mix
#      (e.g. ``ChristopherLee`` has no digit; ``Engineering_Team`` has ``_``).
_MEDIA_PREFIX_RE = re.compile(r"^(lQ|lA)[A-Za-z0-9_-]{18,}$")
_MEDIA_BLOB_RE = re.compile(r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9]{20,}$")

# Any CJK (Han) character -- used to distinguish real names from opaque ids.
_HAS_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _is_media_id(token: str) -> bool:
    """True if ``token`` looks like a DingTalk media/file id (not a real name).

    Pure. Only fires on CJK-free tokens (real names here contain CJK or are
    short handles). See the ``_MEDIA_*`` regex comments for the rationale; the
    intent is to drop opaque base64-ish blobs while keeping ordinary handles
    such as ``Engineering_Team``/``ChristopherLee``.
    """
    if _HAS_CJK_RE.search(token):
        return False
    return bool(_MEDIA_PREFIX_RE.match(token) or _MEDIA_BLOB_RE.match(token))


def _clean_mention(name: str) -> str | None:
    """Normalize an entity/mention surface, or drop it entirely.

    Pure and side-effect-free (no I/O, no state) so it is trivially unit-tested.
    It only cleans the *string*; it never touches id computation.

    Rules (see docs/todo/extract-at-mentions.md):

    - Strip a leading ``@`` and surrounding whitespace; strip trailing
      punctuation (``，。！？：、,.!?:；;``).
    - Return ``None`` (drop) for broadcast denylist tokens
      (``所有人``/``全体成员``/``全体``/``all``/``here``/``everyone``/``channel``).
    - Return ``None`` (drop) for media/file-id shapes (see :func:`_is_media_id`):
      opaque DingTalk media tokens are dropped, but ordinary long ASCII
      names/handles (``Engineering_Team``, ``ChristopherLee``) are kept.
    - Otherwise return the cleaned name unchanged.

    Args:
        name: The raw entity name / mention surface as emitted by the LLM.

    Returns:
        The cleaned canonical name, or ``None`` if the token should be dropped.
    """
    if not isinstance(name, str):
        return None
    cleaned = name.strip()
    # Strip a leading '@' (and any whitespace that followed it).
    if cleaned.startswith("@"):
        cleaned = cleaned[1:].strip()
    # Strip trailing punctuation.
    cleaned = cleaned.rstrip(_TRAILING_PUNCT).strip()
    if not cleaned:
        return None
    # Drop broadcast/group addressing tokens (case-insensitive for ASCII ones).
    if cleaned in _BROADCAST_TOKENS or cleaned.lower() in _BROADCAST_TOKENS:
        return None
    # Drop media/file-id shaped tokens (opaque base64-ish blobs, no CJK).
    if _is_media_id(cleaned):
        return None
    return cleaned


def _expand_compact_result(raw: dict) -> dict:
    """Expand compact Chinese-key LLM output to canonical English-key format.

    The LLM outputs a compact schema with 2-char Chinese keys and omitted nulls
    to save tokens. This function maps them back to the full keys that the rest
    of the pipeline expects. Already-expanded results (old cache, full keys) pass
    through unchanged — the mapping only triggers on Chinese keys.

    Key mapping:
        实体 → entities, 事实 → facts, 序号 → msg_index,
        名称 → name, 类型 → entity_type, 描述 → description,
        主体 → subject_entity, 客体 → object_entity,
        关系 → relation_type (legacy, passed through if present),
        内容 → fact_text, 事类 → fact_type,
        置信 → confidence, 生效 → valid_at, 失效 → invalid_at
    """
    if not isinstance(raw, dict):
        return raw

    # Top-level key mapping
    TOP_MAP = {"实体": "entities", "事实": "facts", "序号": "msg_index"}
    ENTITY_MAP = {"名称": "name", "类型": "entity_type", "描述": "description"}
    FACT_MAP = {
        "主体": "subject_entity",
        "客体": "object_entity",
        "内容": "fact_text",
        "事类": "fact_type",
        "置信": "confidence",
        "生效": "valid_at",
        "失效": "invalid_at",
    }

    def _remap(d: dict, mapping: dict) -> dict:
        """Remap keys in a dict using a mapping; pass through unknown keys."""
        return {mapping.get(k, k): v for k, v in d.items()}

    # Detect if this is compact format (has Chinese top-level keys)
    is_compact = any(k in raw for k in TOP_MAP)
    if not is_compact:
        return raw  # already in full-key format (old cache)

    result = _remap(raw, TOP_MAP)

    # Expand entity dicts
    entities = result.get("entities")
    if isinstance(entities, list):
        expanded_entities = []
        for ent in entities:
            if isinstance(ent, dict):
                expanded = _remap(ent, ENTITY_MAP)
                # Fill defaults for omitted nullable fields
                expanded.setdefault("description", "")
                expanded_entities.append(expanded)
            else:
                expanded_entities.append(ent)
        result["entities"] = expanded_entities

    # Expand fact dicts
    facts = result.get("facts")
    if isinstance(facts, list):
        expanded_facts = []
        for fact in facts:
            if isinstance(fact, dict):
                expanded = _remap(fact, FACT_MAP)
                # Fill defaults for omitted nullable fields
                expanded.setdefault("object_entity", None)
                expanded.setdefault("confidence", 0.9)
                expanded.setdefault("valid_at", None)
                expanded.setdefault("invalid_at", None)
                expanded_facts.append(expanded)
            else:
                expanded_facts.append(fact)
        result["facts"] = expanded_facts

    return result


def _normalize_result(result: dict) -> dict:
    """Scrub entity names and reconstruct involved_entities for each fact.

    Mutates and returns ``result`` in place. Applied before caching so the
    extraction cache is always clean regardless of which write path produced it.
    Defensive: tolerates missing/None/malformed fields (mirrors the ``.get()``
    style already used in this module).

    - ``entities``: each entry whose ``name`` is dropped by :func:`_clean_mention`
      is removed from the list; survivors get the cleaned name.
    - ``facts[].involved_entities``: reconstructed from the message's entity
      names list (not from LLM output). Every entity extracted from this message
      is considered involved in every fact from the same message. This is broader
      than per-fact annotation but ensures full ABOUT edge coverage.
    """
    if not isinstance(result, dict):
        return result

    # entities[].name — drop dropped names, keep cleaned survivors.
    entities = result.get("entities")
    kept_entities = None
    if isinstance(entities, list):
        kept_entities = []
        for ent in entities:
            if not isinstance(ent, dict):
                continue
            cleaned = _clean_mention(ent.get("name", ""))
            if cleaned is None:
                continue
            ent["name"] = cleaned
            kept_entities.append(ent)
        result["entities"] = kept_entities

    # Reconstruct involved_entities for each fact from the full entity names list.
    # This replaces the old per-fact involved_entities field the LLM used to emit.
    facts = result.get("facts")
    if isinstance(facts, list) and kept_entities is not None:
        all_entity_names = [
            e["name"] for e in kept_entities if isinstance(e, dict) and e.get("name")
        ]
        for fact in facts:
            if not isinstance(fact, dict):
                continue
            fact["involved_entities"] = list(all_entity_names)

    return result


# ─── Pydantic Models for Structured Output ──────────────────────────────


class ExtractedEntity(BaseModel):
    """An entity mentioned in the message."""

    name: str = Field(
        description="Canonical name. Use full proper nouns, never pronouns."
    )
    entity_type: str = Field(
        description="One of: Person, System, Project, Team, Concept, Event"
    )
    description: str = Field(
        default="",
        description=(
            "ONE short (at most one sentence) description of this entity AS USED "
            "IN THIS CHUNK, grounded in the message text. Empty string if the "
            "message says nothing meaningful about the entity."
        ),
    )


class ExtractedFact(BaseModel):
    """A discrete factual claim stated or implied by the message."""

    subject_entity: str = Field(description="Name of the entity this fact is about")
    object_entity: str | None = Field(
        default=None, description="Related entity (if binary relation)"
    )
    involved_entities: list[str] = Field(
        default_factory=list,
        description=(
            "Canonical names of EVERY entity this fact touches: the subject, the "
            "object, and every additional person/system/project mentioned in the "
            "same message — INCLUDING everyone that appears as an @-mention, even "
            "if they are only the audience. Deduplicated. Every name here must also "
            "appear in the entities list."
        ),
    )
    relation_type: str = Field(
        default="",
        description="DEPRECATED — no longer extracted. Kept for old cache compat."
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
    valid_at: str | None = Field(
        default=None, description="ISO 8601 when fact became true"
    )
    invalid_at: str | None = Field(
        default=None, description="ISO 8601 when fact ceased to be true"
    )


class ExtractionResult(BaseModel):
    """Combined entity and fact extraction from a single message."""

    entities: list[ExtractedEntity] = Field(default_factory=list)
    facts: list[ExtractedFact] = Field(default_factory=list)


# ─── Prompts ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT_EN = """You are a knowledge extraction assistant.

Given a message (with surrounding context), extract entities and facts.

ENTITY RULES:
- Use full proper nouns, never pronouns or generic descriptions
- Do NOT extract abstract concepts (e.g., "性能", "问题") unless they refer to a specific named thing
- Persons: use the most complete form of their name; for alias forms like "张三(花名)" → 名称: "张三"
- Systems/Projects: use their known product name
- Do NOT extract generic words, verbs, or adjectives as entities

ENTITY DESCRIPTION:
- ONE short sentence describing the entity AS USED IN THIS MESSAGE — its role or what the message says about it
- Ground strictly in this message. Do NOT invent background knowledge.
- Write in the same language as the message.
- Omit 描述 entirely when the message says nothing meaningful about the entity (e.g. a bare @-mention).

FACT RULES:
- Each fact is a single, atomic claim
- Preserve ALL specific details (numbers, dates, versions, decisions)
- Include temporal bounds (生效/失效) if the message indicates when something started/ended
- 内容 should be a complete sentence, faithful to the original message language
- Do NOT infer facts not directly stated or strongly implied by the message
- 主体 and 客体 must be entity names from the entities list
- 置信 is [0,1]: 1.0 when explicitly stated, mid-range when implied, near 0.0 when weakly speculative

@-MENTION RULES:
- "@X" where X is a person name → Person entity; strip leading "@" and trailing punctuation
- Chinese names are usually 2-4 chars; English names take the full word (e.g. "@John this is broken" → "John")
- "@张三这个问题" → person is "张三", rest is content
- If there is a clear separator after @ (space, closing paren, punctuation), respect it
- REJECT broadcast tokens: @所有人, @全体成员, @全体, @all, @here, @everyone, @channel
- REJECT media references: "@" followed by 12+ random chars (no CJK, looks opaque)
- For alias forms "@真名(花名)" or "@A(B)": use A as canonical name; if only a nickname is given, emit as-is
- EVERY accepted @-mention MUST appear in the entities list as a Person

If the message is trivial (greetings, emoji, simple acknowledgments), return empty lists.

Example output:
{"实体":[{"名称":"张三","类型":"Person","描述":"负责排查线上问题"},{"名称":"SystemA","类型":"System"}],"事实":[{"主体":"张三","客体":"SystemA","内容":"张三负责SystemA的线上问题排查","事类":"STATUS","置信":0.9}]}

类型: Person, System, Project, Team, Concept, Event
事类: DECISION, DELEGATE, STATUS, CAUSAL, OPINION, GENERAL"""

SYSTEM_PROMPT_CN = """你是一个知识抽取助手。

给定一条消息（附带上下文），抽取实体和事实。

实体规则：
- 使用完整专有名词，不用代词或泛指
- 不要抽取抽象概念（如"性能"、"问题"），除非指代具体命名事物
- 人名使用最完整形式；花名形式如"张三(花名)"→名称用"张三"
- 系统/项目使用产品名
- 不要将动词、形容词或泛词作为实体

实体描述：
- 基于本条消息的一句话描述其角色/职责
- 严格基于本消息，不要引入背景知识
- 如果消息对该实体无有意义描述（如仅@提及），则省略描述字段

事实规则：
- 每条事实是单一原子性声明
- 保留所有具体细节（数字、日期、版本、决策）
- 如消息指出时间范围，填写生效/失效
- 内容字段写完整语句，忠实于原消息语言
- 不要推断消息未直接陈述或强烈暗示的事实
- 主体和客体必须是实体列表中的名称
- 置信度[0,1]：1.0=明确陈述，0.5=隐含暗示，接近0.0=弱推测

@提及规则：
- "@X"中X是人名则作为Person实体，去掉@和尾随标点
- 中文名一般2-4字；英文名取完整词（如"@John this is broken"→"John"）；"@张三这个问题"→人名是"张三"，后面是内容
- 如果@后有明确分隔（空格、括号闭合、标点），以分隔为准
- 拒绝广播词：@所有人, @全体成员, @全体, @all, @here, @everyone, @channel
- 拒绝媒体引用：@后跟12+随机字符的token（无中文、看起来随机）
- "@真名(花名)"形式：用真名作为名称；只有花名则照用
- 所有被接受的@提及必须出现在实体列表中

若消息无实质内容（问候、表情、简单确认），返回空列表。

示例输出：
{"实体":[{"名称":"张三","类型":"Person","描述":"负责排查线上问题"},{"名称":"SystemA","类型":"System"}],"事实":[{"主体":"张三","客体":"SystemA","内容":"张三负责SystemA的线上问题排查","事类":"STATUS","置信":0.9}]}

类型取值：Person, System, Project, Team, Concept, Event
事类取值：DECISION, DELEGATE, STATUS, CAUSAL, OPINION, GENERAL"""

SYSTEM_PROMPT = SYSTEM_PROMPT_CN

USER_PROMPT_TEMPLATE = """<CONTEXT MESSAGES>
{context}
</CONTEXT MESSAGES>

<TARGET MESSAGE (extract from this one)>
{content}
</TARGET MESSAGE>

抽取TARGET MESSAGE中的实体和事实，用上下文辅助消歧。输出JSON。"""


# ─── Batch prompt for multiple messages at once ──────────────────────────

BATCH_USER_PROMPT_TEMPLATE = """<MESSAGES>
{messages_block}
</MESSAGES>

对每条消息分别抽取实体和事实，输出JSON：

{{
  "results": [
    {{
      "序号": 0,
      "实体": [{{"名称": "...", "类型": "Person", "描述": "一句话描述"}}],
      "事实": [{{
        "主体": "...",
        "客体": "...",
        "内容": "完整陈述",
        "事类": "STATUS",
        "置信": 0.9
      }}]
    }}
  ]
}}

每条消息独立处理，返回恰好{n_messages}个结果。"""


# ─── Entity description generalization (inline + lazy) ───────────────────

SUMMARIZE_DESCRIPTIONS_PROMPT = """You are given several descriptions of the SAME entity, collected from different messages.

Concatenate them into ONE single comprehensive description:
- Write a single paragraph, third person, mentioning the entity name explicitly.
- Resolve contradictions: prefer the information supported by more descriptions,
  and when they genuinely conflict, say so briefly instead of picking silently.
- Keep every distinct, specific detail (roles, systems, projects, decisions).
- Do NOT add information that is absent from the descriptions.
- Write in the language the descriptions are written in (usually Chinese).
- Output the paragraph as plain text only: no bullets, no preamble, no JSON.

Entity: {name}

Descriptions:
{descriptions}"""


# After this many consecutive summarizer failures the circuit opens and further
# calls short-circuit to None for the rest of the run (see
# summarize_entity_descriptions). Resets on any success.
_SUMMARIZE_BREAKER_THRESHOLD = 3
_summarize_breaker: dict[str, int] = {"consecutive_failures": 0}
# Guards read/mutation of ``_summarize_breaker`` when many hub-entity summaries
# run concurrently (``_build_entities`` gathers them). Created lazily and rebound
# if the running loop changes, so repeated ``asyncio.run(...)`` calls in tests —
# each spinning up a fresh loop — never reuse a lock bound to a dead loop.
_summarize_breaker_lock: asyncio.Lock | None = None
_summarize_breaker_lock_loop: asyncio.AbstractEventLoop | None = None


def _breaker_lock() -> asyncio.Lock:
    """Return an ``asyncio.Lock`` bound to the currently running loop.

    The lock is cached at module scope for the lifetime of one event loop and
    transparently recreated when a different loop is running (the multi-
    ``asyncio.run`` test case), avoiding cross-loop binding errors.
    """
    global _summarize_breaker_lock, _summarize_breaker_lock_loop
    loop = asyncio.get_running_loop()
    if _summarize_breaker_lock is None or _summarize_breaker_lock_loop is not loop:
        _summarize_breaker_lock = asyncio.Lock()
        _summarize_breaker_lock_loop = loop
    return _summarize_breaker_lock


async def summarize_entity_descriptions(
    name: str,
    descriptions: list[str],
    *,
    base_url: str = LLM_BASE_URL,
    model: str = LLM_MODEL,
    provider: str = LLM_PROVIDER,
    api_key: str | None = None,
) -> str | None:
    """Collapse many per-chunk entity descriptions into one paragraph via the LLM.

    The inline-lazy generalize step for hub entities: called only once an
    entity's bullet list grows past the gate (see
    ``pipeline.DESCRIPTION_GATE``), so cheap entities never cost a token.

    Optional by construction — it returns ``None`` instead of raising when no
    LLM is configured or the call fails, so a graph build never blocks on the
    summarizer (the caller falls back to the truncated bullet list). This is also
    the seam unit tests monkeypatch, so they never hit a live LLM.

    Args:
        name: Entity name, included in the prompt so the paragraph names it.
        descriptions: The per-chunk descriptions, already deduped + ordered.
        base_url: Anthropic-compatible base URL (defaults to config).
        model: Model name without its provider prefix (defaults to config).
        provider: LiteLLM provider name (defaults to config).
        api_key: Explicit key; otherwise LiteLLM resolves the provider's key.

    Returns:
        The generalized paragraph, or ``None`` if unavailable/failed.
    """
    if not descriptions:
        return None
    if not base_url:
        logger.debug("no LLM base url configured; skipping description summarize")
        return None
    # Circuit breaker: once the summarizer LLM has failed this many times in a
    # row (e.g. the gateway is down/unreachable), stop calling it for the rest of
    # the build. Otherwise every one of the (few dozen) gated hub entities pays a
    # full LLM_TIMEOUT before failing soft — turning an unreachable endpoint into
    # tens of minutes of dead waiting. Callers keep their truncated bullet list.
    # The lock keeps the counter race-free when hub summaries run concurrently;
    # the LLM call itself stays OUTSIDE the lock so calls are not serialized.
    lock = _breaker_lock()
    async with lock:
        if _summarize_breaker["consecutive_failures"] >= _SUMMARIZE_BREAKER_THRESHOLD:
            logger.debug(
                "description summarize circuit open (%d consecutive failures); "
                "skipping %r",
                _summarize_breaker["consecutive_failures"], name,
            )
            return None
    prompt = SUMMARIZE_DESCRIPTIONS_PROMPT.format(
        name=name,
        descriptions="\n".join(f"- {d}" for d in descriptions),
    )
    try:
        # asyncio.wait_for cleanly cancels a wedged async httpx read (non-blocking
        # selects), so no daemon-thread hard-timeout is needed. The bound mirrors
        # the old sync guard (LLM_TIMEOUT + grace); litellm's own timeout applies
        # underneath.
        resp = await asyncio.wait_for(
            litellm.acompletion(
                model=provider_model(provider, model),
                messages=[{"role": "user", "content": prompt}],
                api_base=base_url,
                api_key=provider_api_key(provider, api_key),
                temperature=0.1,
                max_tokens=1024,
                timeout=LLM_TIMEOUT,
            ),
            timeout=LLM_TIMEOUT + _WAIT_FOR_GRACE,
        )
        text = (resp.choices[0].message.content or "").strip()
        async with lock:
            _summarize_breaker["consecutive_failures"] = 0  # success resets
    except Exception as exc:  # noqa: BLE001 - summarizing is best-effort
        async with lock:
            _summarize_breaker["consecutive_failures"] += 1
        logger.warning("description summarize failed for %r: %s", name, exc)
        return None
    return text or None


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
    """Returns False for trivial chunks that won't yield useful entities/facts.

    C7 (session chunking): this trivial-skip filter is **no longer called** by
    the pipeline — every chunk (session slice or non-chat) is extracted, since a
    trivial line now folds into its session slice. The function is retained
    (uncalled) so the filter can be re-enabled cheaply if it proves necessary.
    """
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


# Keys that mark a parsed JSON object as a recognized extraction result. The
# canonical English keys, their compact CN aliases, and ``msg_index``/``序号``
# (a bare index echo with no entities/facts is still a recognized, empty slot).
_RECOGNIZED_RESULT_KEYS = frozenset(
    {"entities", "facts", "实体", "事实", "msg_index", "序号"}
)


def _is_failure_result(result: dict) -> bool:
    """True if a result dict carries a failure marker (``_error`` key present).

    A validated success — including a legitimately empty
    ``{"entities": [], "facts": []}`` — never has an ``_error`` key at all.
    Presence (not truthiness) is the predicate: a failure whose message is the
    empty string (e.g. ``Exception()`` → ``""``) must still be excluded from the
    cache. This is the single predicate the cache-write path uses: no ``_error``
    key == cacheable.
    """
    return "_error" in result


def _is_recognized_result_shape(raw: dict) -> bool:
    """True if a parsed JSON object looks like an extraction result.

    Requires at least one recognized extraction key (canonical or compact). An
    arbitrary object like ``{"unexpected": "shape"}`` is NOT a successful empty
    extraction — it is a structurally unrecognized outcome that must be marked
    retry-eligible instead of cached as an empty result.
    """
    return any(k in raw for k in _RECOGNIZED_RESULT_KEYS)


def _validated_result_or_none(raw: dict) -> dict | None:
    """Expand + structurally validate one parsed result object.

    Returns the expanded canonical-key result on success, or ``None`` when the
    object is structurally unrecognized or its ``entities``/``facts`` are not
    lists after expansion (so the caller marks it a retry-eligible failure).
    """
    if not _is_recognized_result_shape(raw):
        return None
    result = _expand_compact_result(raw)
    result.setdefault("entities", [])
    result.setdefault("facts", [])
    if not isinstance(result["entities"], list) or not isinstance(
        result["facts"], list
    ):
        return None
    return result


def _failure_result(error: str, *, transient: bool) -> dict:
    """Build a non-cacheable, retry-eligible failure outcome.

    ``transient=True`` marks it retryable so a later run re-extracts the chunk
    instead of the cache being poisoned with an empty extraction. The
    ``entities``/``facts`` keys are present (empty) so downstream code that
    reads them before the ``_error`` check does not KeyError.
    """
    return {"entities": [], "facts": [], "_error": error, "_transient": transient}


class _RetryableResponseError(Exception):
    """A response-level problem worth retrying next run (never cached).

    Raised by response validation for empty/null content, truncation, or
    malformed JSON — the caller turns it into a ``_transient`` failure result.
    """


class _HardStopResponseError(Exception):
    """A deterministic response-level failure (e.g. content filter).

    Treated like a permanent LLM exception: logged once and re-raised loudly so
    the ingest aborts rather than caching or silently continuing.
    """


# litellm re-raises provider errors as typed exceptions. Classify by type first
# (survives message/version drift), then status code, then message substrings
# (kept so a caller passing a plain Exception — e.g. tests — still classifies).
_TRANSIENT_EXC = (
    litellm.Timeout,
    litellm.RateLimitError,
    litellm.APIConnectionError,
    litellm.InternalServerError,
    litellm.ServiceUnavailableError,
)
# ContextWindowExceededError / ContentPolicyViolationError subclass
# BadRequestError; all are permanent, so ordering among them is immaterial.
_PERMANENT_EXC = (
    litellm.ContextWindowExceededError,
    litellm.ContentPolicyViolationError,
    litellm.AuthenticationError,
    litellm.PermissionDeniedError,
    litellm.NotFoundError,
    litellm.BadRequestError,
)


def _is_transient_llm_error(exc: Exception) -> bool:
    """True for LLM errors worth retrying (rate limit / timeout / 5xx / conn).

    A large extraction run on a shared gateway routinely sees 429s and Cloudflare
    5xx blips — transient, retry them. A genuine ``insufficient_quota``, an auth
    failure, a context-length overflow, or any other 4xx bad-request is a hard
    stop: it must not be retried and (per the design) is re-raised loudly by the
    caller rather than cached.

    Classification order: the ``insufficient_quota`` override (litellm maps quota
    exhaustion to ``RateLimitError``, which would otherwise read transient) →
    litellm typed exceptions → ``status_code`` → message substrings (so a plain
    ``Exception`` still classifies).
    """
    msg = str(exc).lower()
    # Override: quota exhaustion is a permanent 429 litellm maps to RateLimitError.
    if "insufficient_quota" in msg:
        return False
    # Typed classification (authoritative when litellm raised a typed error).
    if isinstance(exc, _PERMANENT_EXC):
        return False
    if isinstance(exc, _TRANSIENT_EXC):
        return True
    # Status-code fallback for exceptions we didn't enumerate.
    status = getattr(exc, "status_code", None)
    if status in (408, 429) or (isinstance(status, int) and status >= 500):
        return True
    if isinstance(status, int) and 400 <= status < 500:
        return False
    # Message-substring last resort (plain Exceptions, non-litellm callers).
    if any(phrase in msg for phrase in (
        "context_length_exceeded", "max_tokens", "maximum context length",
        "token limit", "content_filter", "invalid_api_key", "authentication",
    )):
        return False
    return (
        "rate limit" in msg or "timeout" in msg or " 429" in msg
        or "5xx" in msg or "overloaded" in msg or "cloudflare" in msg
        or "connection error" in msg
    )


# Extra seconds added to LLM_TIMEOUT before the async summarizer's
# ``asyncio.wait_for`` bound gives up, so litellm's own request timeout normally
# fires first and this outer bound is only a backstop for a socket that ignores
# it. Module-level so tests can shrink it.
_WAIT_FOR_GRACE = 15.0


# ─── LLM Extractor ──────────────────────────────────────────────────────


class LLMExtractor:
    """Async LLM-based entity+fact extraction with a SQLite result cache."""

    CONTEXT_WINDOW = 3  # messages before and after target

    def __init__(
        self,
        cache_db: Path = EXTRACTION_CACHE_PATH,
        base_url: str = LLM_BASE_URL,
        model: str = LLM_MODEL,
        provider: str = LLM_PROVIDER,
        api_key: str | None = None,
        max_concurrent: int = 50,
        cache_max_entries: int = EXTRACTION_CACHE_MAX_ENTRIES,
        legacy_cache_db: Path | None = None,
    ):
        if max_concurrent <= 0:
            raise ValueError("max_concurrent must be greater than zero")
        self.cache_db = Path(cache_db)
        self.cache_max_entries = int(cache_max_entries)
        self.legacy_cache_db = (
            Path(legacy_cache_db) if legacy_cache_db is not None else None
        )
        # Lazily opened on first cache access so constructing an extractor is
        # cheap and does not touch the filesystem/db until extraction runs.
        self._cache: ExtractionCacheStore | None = None
        self.model = provider_model(provider, model)
        self.base_url = base_url
        self.api_key = provider_api_key(provider, api_key)
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
        except Exception:  # noqa: BLE001, S110
            pass
        # litellm stores cost in hidden params; fall back to 0
        try:
            cost = litellm.completion_cost(resp)
            if cost is not None:
                self.stats["estimated_cost_usd"] += cost
        except Exception:  # noqa: BLE001, S110
            pass

    def _store(self) -> ExtractionCacheStore:
        """Open (once) and return the SQLite extraction-cache store."""
        if self._cache is None:
            self._cache = ExtractionCacheStore(
                self.cache_db,
                max_entries=self.cache_max_entries,
                legacy_db_path=self.legacy_cache_db,
            )
        return self._cache

    def close(self) -> None:
        """Close the cache store if it was opened."""
        if self._cache is not None:
            self._cache.close()
            self._cache = None

    def _cache_key(self, msg: Chunk) -> str:
        """Deterministic cache key from chunk ID (kept for reference parity)."""
        return hashlib.md5(msg.id.encode()).hexdigest()

    def _read_cache(self, msg: Chunk) -> dict | None:
        """Read the cached result for a chunk, or None on a miss.

        Delegates to the SQLite store, which returns None for a missing row, a
        row from a different model, or an unparsable payload (self-healing).
        """
        return self._store().get(msg.id, self.model)

    def _write_cache(self, msg: Chunk, result: dict):
        """Persist a result IFF it is a validated success (no ``_error`` marker).

        Success-only writes are the cache-poisoning guard: a failed, truncated,
        malformed, or dropped outcome carries ``_error`` and is never stored, so
        a later run re-extracts the chunk instead of replaying an empty result.
        A genuinely empty success (``{"entities": [], "facts": []}`` with no
        ``_error``) IS cached. Hard stops never reach here — they raise upstream.
        """
        if _is_failure_result(result):
            return
        self._store().put(result, msg.id, self.model)

    def _format_context(self, messages: list[Chunk], target_idx: int) -> str:
        """Format context window around target message."""
        start = max(0, target_idx - self.CONTEXT_WINDOW)
        end = min(len(messages), target_idx + self.CONTEXT_WINDOW + 1)

        lines = []
        for i in range(start, end):
            if i == target_idx:
                continue  # skip target, it goes in the main section
            msg = messages[i]
            lines.append(f"[{_sender_of(msg)}]: {msg.content[:300]}")

        return "\n".join(lines) if lines else "(no context)"

    def _format_time(self, timestamp: int) -> str:
        """Format unix ms timestamp to readable string."""
        if timestamp <= 0:
            return "unknown"
        from datetime import datetime

        dt = datetime.fromtimestamp(timestamp / 1000)  # noqa: DTZ006
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

    def _content_from_response(self, resp) -> str:
        """Validate an LLM response and return its raw text content.

        Runs the response-level checks BEFORE any parse so a bad outcome can
        never be cached:

        - empty ``choices`` or null content → ``_RetryableResponseError``
          (server misbehaviour, retry next run);
        - truncation — ``finish_reason == "length"`` OR a provider-specific
          ``stop_reason`` of ``max_tokens``/``length`` — →
          ``_RetryableResponseError`` (the JSON is necessarily incomplete);
        - ``finish_reason == "content_filter"`` → ``_HardStopResponseError``
          (a moderation refusal is deterministic — raise loudly, don't cache).

        Args:
            resp: The litellm response object.

        Returns:
            The first choice's message content string.

        Raises:
            _RetryableResponseError: retry-eligible response problem.
            _HardStopResponseError: permanent response problem (content filter).
        """
        choices = getattr(resp, "choices", None)
        if not choices:
            raise _RetryableResponseError("empty choices")
        choice = choices[0]
        content = getattr(getattr(choice, "message", None), "content", None)
        finish = getattr(choice, "finish_reason", None)
        # Defensive double-read: OpenAI dialect uses finish_reason=="length";
        # an Anthropic-mode gateway may surface stop_reason=="max_tokens".
        stop_reason = getattr(choice, "stop_reason", None)
        if finish == "content_filter":
            raise _HardStopResponseError("content_filter")
        if finish == "length" or stop_reason in ("max_tokens", "length"):
            raise _RetryableResponseError(
                f"truncated response (finish_reason={finish!r}, "
                f"stop_reason={stop_reason!r})"
            )
        if content is None:
            raise _RetryableResponseError("null content")
        return content

    def _parse_result_object(self, content: str) -> dict:
        """Parse response text into a top-level JSON object.

        Shared by ``_call_llm`` and ``_call_llm_batch`` (spec A2): strips code
        fences, parses, and requires a top-level object. Batch-specific
        ``results`` handling stays in the batch method.

        Args:
            content: The raw response text.

        Returns:
            The parsed top-level ``dict``.

        Raises:
            _RetryableResponseError: malformed JSON or a non-object top level
                (retry next run rather than caching a bad outcome).
        """
        try:
            parsed = json.loads(self._strip_code_blocks(content))
        except json.JSONDecodeError as e:
            raise _RetryableResponseError(f"JSON parse: {e!s}") from e
        if not isinstance(parsed, dict):
            raise _RetryableResponseError("top-level JSON is not an object")
        return parsed

    async def _call_llm(self, msg: Chunk, context: str) -> dict:
        """Make one LLM call for extraction.

        Returns a validated result dict on success, or a ``_transient`` failure
        result for a retry-eligible problem (transient LLM error, empty/null
        content, truncation, or malformed JSON) so the caller never caches it.
        A permanent hard stop (auth, quota, context-length, content filter, bad
        request) is logged and RE-RAISED loudly to abort the run.
        """
        user_content = USER_PROMPT_TEMPLATE.format(
            context=context,
            content=msg.content,  # full content, no truncation
        )

        async with self.semaphore:
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
                    timeout=240,  # per-request timeout (seconds)
                    num_retries=LLM_MAX_RETRIES,  # litellm's own retry/backoff
                )
            except _HardStopResponseError:
                raise
            except Exception as e:  # noqa: BLE001 - classify then re-raise or mark
                if not _is_transient_llm_error(e):
                    self.stats["llm_errors"] += 1
                    logger.error(
                        "HARD-STOP LLM error on chunk %s: %s: %s",
                        msg.id[:20], type(e).__name__, str(e)[:300],
                    )
                    raise
                self.stats["llm_errors"] += 1
                return _failure_result(str(e), transient=True)

            self._track_usage(resp)
            try:
                content = self._content_from_response(resp)
            except _HardStopResponseError as e:
                self.stats["llm_errors"] += 1
                logger.error("HARD-STOP response on chunk %s: %s", msg.id[:20], e)
                raise
            except _RetryableResponseError as e:
                self.stats["llm_errors"] += 1
                return _failure_result(str(e), transient=True)

            try:
                result_obj = self._parse_result_object(content)
            except _RetryableResponseError as e:
                self.stats["llm_errors"] += 1
                return _failure_result(str(e), transient=True)

            validated = _validated_result_or_none(result_obj)
            if validated is None:
                self.stats["llm_errors"] += 1
                return _failure_result("unrecognized result shape", transient=True)
            self.stats["llm_calls"] += 1
            return validated

    async def extract_one(
        self,
        msg: Chunk,
        conversation_messages: list[Chunk],
        target_idx: int,
    ) -> dict:
        """Extract entities and facts from one message, with caching.

        Returns raw dict (not parsed into Pydantic models) for maximum flexibility.
        The validated result is cached in the SQLite extraction cache.
        """
        self.stats["total"] += 1

        # C7: no trivial-skip filter — every chunk (chat session slice or
        # non-chat) is extracted. A trivial line folds into its session slice,
        # so per-message skipping is moot; add the guard back if it proves
        # necessary. Check cache
        cached = self._read_cache(msg)
        if cached is not None:
            self.stats["cache_hits"] += 1
            return cached

        # Build context and call LLM
        context = self._format_context(conversation_messages, target_idx)
        result = await self._call_llm(msg, context)

        # Scrub entity names + fact involved_entities before caching.
        _normalize_result(result)

        # Annotate with metadata for traceability
        result["_msg_id"] = msg.id
        result["_msg_sender"] = _sender_of(msg)
        result["_msg_timestamp"] = msg.timestamp
        result["_msg_content_preview"] = msg.content[:200]

        if not result["entities"] and not result["facts"]:
            self.stats["empty_results"] += 1

        # Cache the result
        self._write_cache(msg, result)
        return result

    async def _call_llm_batch(self, messages: list[Chunk]) -> list[dict]:
        """Make one LLM call to extract from multiple messages at once."""
        # Format messages block
        lines = []
        for i, msg in enumerate(messages):
            lines.append(f"[Message {i}]")
            lines.append(f"{msg.content}")
            lines.append("")

        messages_block = "\n".join(lines)
        user_content = BATCH_USER_PROMPT_TEMPLATE.format(
            messages_block=messages_block,
            n_messages=len(messages),
        )

        async with self.semaphore:
            first_id = messages[0].id[:20] if messages else "?"
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
                    timeout=LLM_BATCH_TIMEOUT,  # per-request timeout (seconds)
                    num_retries=LLM_MAX_RETRIES,  # litellm's own retry/backoff
                )
            except _HardStopResponseError:
                raise
            except asyncio.TimeoutError:
                self.stats["llm_errors"] += 1
                logger.error(
                    "Batch TIMEOUT after %ds (%d msgs, first=%s)",
                    LLM_BATCH_TIMEOUT, len(messages), first_id,
                )
                return self._batch_failure(messages, "timeout", transient=True)
            except Exception as e:  # noqa: BLE001 - classify then re-raise or mark
                self.stats["llm_errors"] += 1
                if not _is_transient_llm_error(e):
                    logger.error(
                        "HARD-STOP batch LLM error (%d msgs, first=%s): %s: %s",
                        len(messages), first_id, type(e).__name__, str(e)[:300],
                    )
                    raise
                logger.error(
                    "Batch LLM error (%d msgs, first=%s, transient): %s: %s",
                    len(messages), first_id, type(e).__name__, str(e)[:300],
                )
                return self._batch_failure(messages, str(e), transient=True)

            self._track_usage(resp)
            try:
                content = self._content_from_response(resp)
            except _HardStopResponseError as e:
                self.stats["llm_errors"] += 1
                logger.error(
                    "HARD-STOP batch response (%d msgs, first=%s): %s",
                    len(messages), first_id, e,
                )
                raise
            except _RetryableResponseError as e:
                self.stats["llm_errors"] += 1
                logger.error(
                    "Batch response problem (%d msgs, first=%s): %s",
                    len(messages), first_id, e,
                )
                return self._batch_failure(messages, str(e), transient=True)

            try:
                result = self._parse_result_object(content)
            except _RetryableResponseError as e:
                self.stats["llm_errors"] += 1
                logger.error(
                    "Batch response parse problem (%d msgs, first=%s): %s | "
                    "resp[:200]=%s",
                    len(messages), first_id, e, content[:200],
                )
                return self._batch_failure(messages, str(e), transient=True)

            self.stats["llm_calls"] += 1

            # Preferred shape: {"results": [ {...}, ... ]}. Convert EACH entry in
            # place — never drop one — so positional length is preserved and a bad
            # entry cannot shift a valid neighbour onto the wrong chunk
            # (_result_for_slot's positional fallback relies on 1:1 length). A
            # non-dict or structurally-unrecognized entry becomes a marked,
            # retry-eligible failure for THAT slot only.
            if isinstance(result.get("results"), list):
                return [self._result_entry_or_failure(r) for r in result["results"]]
            # Single-result fallback: the model answered with one bare result.
            single = _validated_result_or_none(result)
            if single is not None:
                return [single]
            # Unrecognized shape: do NOT silently cache empties (the old bug).
            return self._batch_failure(
                messages, "unrecognized response shape", transient=True
            )

    @staticmethod
    def _result_entry_or_failure(raw) -> dict:
        """Validate one batch ``results`` entry, preserving its slot position.

        A dict that passes structural validation is expanded; a non-dict entry
        or a structurally-unrecognized dict becomes a marked, retry-eligible
        failure IN PLACE (never dropped), so a malformed entry cannot shift a
        valid neighbour's result onto the wrong chunk.
        """
        if not isinstance(raw, dict):
            return _failure_result("non-dict result entry", transient=True)
        validated = _validated_result_or_none(raw)
        if validated is None:
            return _failure_result("unrecognized result shape", transient=True)
        return validated

    async def extract_all_flat(
        self,
        all_messages: list[Chunk],
        progress_callback=None,
    ) -> None:
        """Extract from all chunks using flat parallelism.

        Instead of processing conversation-by-conversation, this fires
        all batch calls concurrently (limited by the semaphore).
        Results are written directly to the SQLite extraction cache. Works for
        any :class:`Chunk` (chat messages or non-chat sources); the
        conversation-context window is not used on this path.

        Args:
            all_messages: All chunks (any order)
            progress_callback: optional callable(done, total)
        """
        # Separate into messages needing extraction and trivial ones
        to_extract = []
        for msg in all_messages:
            self.stats["total"] += 1
            # C7: no trivial-skip — every chunk is a candidate; the SQLite cache
            # still short-circuits already-extracted slices.
            cached = self._read_cache(msg)
            if cached is not None:
                self.stats["cache_hits"] += 1
            else:
                to_extract.append(msg)

        BATCH_SIZE = LLM_BATCH_SIZE
        print(f"  Messages to extract via LLM: {len(to_extract)}")
        print(
            f"  Batches of {BATCH_SIZE}: "
            f"{(len(to_extract) + BATCH_SIZE - 1) // BATCH_SIZE} LLM calls"
        )
        print(f"  Timeout per batch: {LLM_BATCH_TIMEOUT}s | Max retries: {LLM_MAX_RETRIES}")

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
    def _missing_slot() -> dict:
        """Marker for a batch slot the model dropped (retry-eligible, uncached).

        Returned instead of a bare empty result so a message the LLM omitted is
        NOT persisted as a valid empty extraction; the next run re-extracts it.
        """
        return _failure_result("missing from batch response", transient=True)

    @staticmethod
    def _batch_failure(
        messages: list[Chunk], error: str, *, transient: bool
    ) -> list[dict]:
        """One marked failure per message — the whole batch failed to produce
        usable results (LLM error, bad/empty/truncated response, bad shape)."""
        return [_failure_result(error, transient=transient) for _ in messages]

    @staticmethod
    def _result_for_slot(
        i: int, batch_results: list[dict], by_index: dict[int, dict]
    ) -> dict:
        """Pick the LLM result for the message labeled ``[Message i]``.

        If the response echoed ``msg_index`` for any entry we trust those indices
        exclusively: slot ``i`` is whatever entry claimed index ``i``, else a
        marked missing-slot failure. This keeps entities/facts attached to the
        right message even if the model reorders entries, and a dropped message
        leaves an uncached failure slot rather than shifting a neighbour into it
        or being cached as a valid empty extraction.

        Only when the response carried *no* usable ``msg_index`` at all do we
        fall back to positional order, which is valid because the batch list
        order is preserved between request and response.
        """
        if by_index:
            return by_index.get(i) or LLMExtractor._missing_slot()
        if i < len(batch_results):
            return batch_results[i]
        return LLMExtractor._missing_slot()

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
        """Process a single batch: call LLM and cache results.

        The per-batch timeout is applied INSIDE _call_llm_batch (around the
        actual LLM call, not the semaphore wait), so queued batches waiting
        for a concurrency slot don't spuriously time out.
        """
        batch_results = await self._call_llm_batch(messages)
        by_index = self._index_by_msg_index(batch_results)

        for i, msg in enumerate(messages):
            try:
                result = self._result_for_slot(i, batch_results, by_index)
                if not isinstance(result, dict):
                    # Defensive: a non-dict slipped through slot resolution.
                    result = _failure_result(
                        "non-dict result entry", transient=True
                    )

                # Scrub entity names + fact involved_entities before caching.
                _normalize_result(result)

                # Annotate with metadata
                result["_msg_id"] = msg.id
                result["_msg_sender"] = _sender_of(msg)
                result["_msg_timestamp"] = msg.timestamp
                result["_msg_content_preview"] = msg.content[:200]
            except Exception as e:  # noqa: BLE001 - one bad slot must not abort the batch
                logger.error(
                    "Skipping malformed batch slot %d (chunk %s): %s: %s",
                    i, msg.id[:20], type(e).__name__, str(e)[:200],
                )
                self.stats["llm_errors"] += 1
                continue

            if _is_failure_result(result):
                # Retry-eligible failure (dropped slot, malformed entry): don't
                # cache; the next run re-extracts this chunk.
                continue
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
        print("  ── LLM Token Usage ──")
        print(f"  Prompt tokens:     {s['prompt_tokens']:,}")
        print(f"  Completion tokens: {s['completion_tokens']:,}")
        print(f"  Total tokens:       {s['total_tokens']:,}")
        if s["llm_calls"] > 0:
            avg_pt = s["prompt_tokens"] / s["llm_calls"]
            avg_ct = s["completion_tokens"] / s["llm_calls"]
            print(f"  Avg tokens/call:   {avg_pt:.0f} in + {avg_ct:.0f} out")
        print(f"  Estimated cost:    ${s['estimated_cost_usd']:.4f}")
