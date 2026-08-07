"""LLM query rewrite: turn a raw query into structured retrieval intent.

Ported from RAGFlow's ``minirag_query2kwd`` (rag/graphrag/query_analyze_prompt.py
+ rag/graphrag/search.py::query_rewrite). One LLM call maps the user's question
onto:

- ``entities_from_query`` — concrete entity mentions extracted from the query,
  used to drive **vector** entity matching (replacing brittle substring search).
- ``entity_type_keywords`` — which :class:`EntityType` categories the answer is
  about (Person / System / Project / ...).
- ``fact_type_keywords`` — which :class:`FactType` the answer wants (DECISION /
  DELEGATE / STATUS / CAUSAL / GENERAL). This is kl-graph's answer-shape axis and
  has no RAGFlow equivalent (RAGFlow has a single entity-type pool).

Both type axes are chosen **from a corpus-derived pool** injected into the prompt,
so the model picks real, in-domain categories rather than guessing.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from kl_graph.utils.litellm_config import litellm
from kl_graph.models.types import EntityType, FactType

logger = logging.getLogger(__name__)

# Number of example entity names / fact snippets shown per type in the pool.
_POOL_SAMPLES_PER_TYPE = 10
# Max entities the LLM is allowed to extract from a single query.
_MAX_QUERY_ENTITIES = 10

_RE_ENG_ZH = re.compile(r"([A-Za-z0-9]+)([\u4e00-\u9fa5])")
_RE_ZH_ENG = re.compile(r"([\u4e00-\u9fa5])([A-Za-z0-9]+)")
_RE_WS = re.compile(r"\s+")


def normalize_query(txt: str) -> str:
    """Canonicalize raw query text before embedding / LLM rewrite.

    Collapses cosmetic variations so that the same meaning yields the same text
    (and thus the same embedding). Ported from RAGFlow's non-LLM query cleanup
    (``FulltextQueryer.question`` / ``add_space_between_eng_zh``). Applies:

    1. Full-width -> half-width (ASCII range), so Chinese-IME punctuation/letters
       (full-width parens, alnum, etc.) match their ASCII counterparts.
    2. Case folding (lowercase).
    3. A space inserted at every English<->Chinese boundary, so glued tokens like
       "部署平台security" split into "部署平台 security".
    4. Whitespace runs collapsed to a single space.

    Traditional->simplified conversion (RAGFlow's ``tradi2simp``) is
    intentionally omitted to avoid an OpenCC-style dependency.

    Args:
        txt: Raw query string.

    Returns:
        The normalized query, or the stripped original if normalization would
        yield an empty string.
    """
    original = txt.strip()

    # 1. Full-width -> half-width.
    chars = []
    for ch in txt:
        code = ord(ch)
        if code == 0x3000:  # ideographic space
            chars.append(" ")
        elif 0xFF01 <= code <= 0xFF5E:  # full-width ASCII punctuation/alnum
            chars.append(chr(code - 0xFEE0))
        else:
            chars.append(ch)
    txt = "".join(chars)

    # 2. Case folding.
    txt = txt.lower()

    # 3. Insert spaces at English<->Chinese boundaries.
    txt = _RE_ENG_ZH.sub(r"\1 \2", txt)
    txt = _RE_ZH_ENG.sub(r"\1 \2", txt)

    # 4. Collapse whitespace.
    txt = _RE_WS.sub(" ", txt).strip()

    return txt or original


@dataclass
class QueryRewrite:
    """Structured query intent produced by the LLM rewrite step."""

    entities_from_query: list[str] = field(default_factory=list)
    entity_type_keywords: list[str] = field(default_factory=list)
    fact_type_keywords: list[str] = field(default_factory=list)


SYSTEM_PROMPT = """---Role---

You are a retrieval-intent analysis assistant. Given a user query from a Chinese
workplace group-chat setting, identify three kinds of information to drive
knowledge-graph retrieval.

---Goal---

1. entities_from_query: concrete entities extracted from the query (people,
   systems, projects, organizations, etc.). Must come from the query itself —
   do not invent any. At most {max_entities}, most relevant first.
2. entity_type_keywords: the entity types the answer most likely concerns. Must
   be chosen from the "Entity type pool". At most 3, most likely first.
3. fact_type_keywords: the fact type (answer shape) the user wants. Must be
   chosen from the "Fact type pool". At most 3, most likely first.

Fact type meanings:
- DECISION: a decision, a call made, a conclusion ("decided to use plan X")
- DELEGATE: division of work, assignment, ownership ("X owns this part")
- STATUS: progress, state, completion ("X is live / still under test")
- CAUSAL: cause, reason, impact ("because X, therefore Y")
- GENERAL: a general statement

---Instructions---

- Output JSON only. Do not output any explanation.
- The JSON must contain three keys: entities_from_query, entity_type_keywords,
  and fact_type_keywords, each a string array.

######################
-Examples-
######################
查询: "张伟最近在数据同步上做了什么决策？"
实体类型池: {{"PERSON": ["张伟", "李娜"], "SYSTEM": ["部署平台", "网关"], "PROJECT": ["权限重构"]}}
事实类型池: {{"DECISION": ["决定采用方案A"], "STATUS": ["功能已上线"]}}
输出:
{{
  "entities_from_query": ["张伟", "数据同步"],
  "entity_type_keywords": ["PERSON", "SYSTEM"],
  "fact_type_keywords": ["DECISION"]
}}
######################
查询: "审批系统现在上线了吗？"
实体类型池: {{"PERSON": ["王强"], "SYSTEM": ["审批系统", "部署平台"], "PROJECT": ["大促"]}}
事实类型池: {{"DECISION": ["决定用方案A"], "STATUS": ["已灰度上线"]}}
输出:
{{
  "entities_from_query": ["审批系统"],
  "entity_type_keywords": ["SYSTEM"],
  "fact_type_keywords": ["STATUS"]
}}
######################
"""


USER_PROMPT_TEMPLATE = """Query: {query}
Entity type pool: {entity_pool}
Fact type pool: {fact_pool}
Max Number of Entities: {max_entities}

"""


def build_type_pool(store) -> dict[str, dict[str, list[str]]]:
    """Build a corpus-derived type pool to inject into the rewrite prompt.

    Args:
        store: A :class:`KnowledgeStore` (SQLite or ladybug). Its content tables
            are read through the backend-agnostic ``sql_conn`` property; a raw
            ``sqlite3.Connection`` or legacy store exposing ``.conn`` also works.

    Returns:
        ``{"entity_pool": {EntityType: [top names]},
           "fact_pool": {FactType: [sample fact texts]}}``. Entity names are the
        most-mentioned per type; fact snippets are arbitrary short samples.
    """
    # Every KnowledgeStore exposes the shared content connection via ``sql_conn``
    # (on ladybug the ``edges`` table is empty, but entities/facts live in
    # SQLite). Fall back to ``.conn`` (raw SQLiteStore) or a bare connection.
    conn = getattr(store, "sql_conn", None) or getattr(store, "conn", None) or store

    entity_pool: dict[str, list[str]] = {}
    for etype in EntityType:
        rows = conn.execute(
            """SELECT name FROM entities WHERE entity_type = ?
               ORDER BY mention_count DESC LIMIT ?""",
            (etype.value, _POOL_SAMPLES_PER_TYPE),
        ).fetchall()
        names = [r[0] for r in rows]
        if names:
            entity_pool[etype.name] = names

    fact_pool: dict[str, list[str]] = {}
    for ftype in FactType:
        rows = conn.execute(
            """SELECT text FROM facts WHERE fact_type = ? LIMIT ?""",
            (ftype.value, _POOL_SAMPLES_PER_TYPE),
        ).fetchall()
        texts = [r[0][:40] for r in rows if r[0]]
        if texts:
            fact_pool[ftype.name] = texts

    return {"entity_pool": entity_pool, "fact_pool": fact_pool}


def _parse_rewrite_json(raw: str) -> dict:
    """Tolerantly parse the LLM's JSON output.

    Tries a direct ``json.loads`` first, then falls back to extracting the first
    ``{...}`` block. Raises ``ValueError`` if nothing parseable is found (the
    caller then degrades to substring entity matching).
    """
    raw = raw.strip()
    # Strip a common ```json ... ``` code fence if present.
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    # Fall back to the first balanced-looking {...} slice.
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError(f"Unparseable rewrite output: {raw[:200]!r}")


def _rewrite_messages(model: str, question: str, type_pool: dict) -> list[dict]:
    """Build the (system, user) messages for the rewrite call (sync + async)."""
    system_prompt = SYSTEM_PROMPT.format(max_entities=_MAX_QUERY_ENTITIES)
    user_content = USER_PROMPT_TEMPLATE.format(
        query=question,
        entity_pool=json.dumps(type_pool.get("entity_pool", {}), ensure_ascii=False),
        fact_pool=json.dumps(type_pool.get("fact_pool", {}), ensure_ascii=False),
        max_entities=_MAX_QUERY_ENTITIES,
    )
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]


def _rewrite_from_content(content: str) -> QueryRewrite:
    """Parse a rewrite LLM response body into a :class:`QueryRewrite`."""
    data = _parse_rewrite_json(content or "")
    return QueryRewrite(
        entities_from_query=[str(e) for e in data.get("entities_from_query", [])][
            :_MAX_QUERY_ENTITIES
        ],
        entity_type_keywords=[str(t) for t in data.get("entity_type_keywords", [])][:3],
        fact_type_keywords=[str(t) for t in data.get("fact_type_keywords", [])][:3],
    )


def rewrite_query(
    model: str, question: str, type_pool: dict, *, api_base: str, api_key: str
) -> QueryRewrite:
    """Run the LLM query-rewrite step.

    Args:
        model: litellm model name (e.g. ``anthropic/qwen3.7-plus``).
        question: The raw user query.
        type_pool: Output of :func:`build_type_pool`.
        api_base: Endpoint base URL (Anthropic /messages compatible).
        api_key: API key for the endpoint.

    Returns:
        A :class:`QueryRewrite`. On any LLM/parse failure this raises, and the
        caller is expected to fall back to substring entity matching.
    """
    resp = litellm.completion(
        model=model,
        messages=_rewrite_messages(model, question, type_pool),
        api_base=api_base,
        api_key=api_key,
        response_format={"type": "json_object"},
        temperature=0.0,
    )
    return _rewrite_from_content(resp.choices[0].message.content)


async def arewrite_query(
    model: str, question: str, type_pool: dict, *, api_base: str, api_key: str
) -> QueryRewrite:
    """Async twin of :func:`rewrite_query` (``litellm.acompletion``).

    Same contract and failure semantics as the sync version; used by the async
    query engine so the rewrite LLM call ``await``s instead of blocking the
    event loop.
    """
    resp = await litellm.acompletion(
        model=model,
        messages=_rewrite_messages(model, question, type_pool),
        api_base=api_base,
        api_key=api_key,
        response_format={"type": "json_object"},
        temperature=0.0,
    )
    return _rewrite_from_content(resp.choices[0].message.content)
