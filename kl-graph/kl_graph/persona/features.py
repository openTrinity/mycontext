"""Deterministic Layer A persona features; no LLM calls."""

from __future__ import annotations

import dataclasses
import math
import re
from dataclasses import dataclass, field

from kl_graph.persona.cache import PersonaStore
from kl_graph.persona.corpus import PersonaCorpusReader, PersonaMessage, StanceFact

_ASCII_WORD = re.compile(r"[A-Za-z0-9_]+")
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_EMOJI = re.compile(
    "[\U0001f1e0-\U0001f1ff\U0001f300-\U0001f6ff\U00002702-\U000027b0]+"
)
_PUNCTUATION = re.compile(r"[,，。.!！?？;；:：、…~～()（）\[\]【】《》‘’“”—-]")
_HEDGES = ("可能", "也许", "应该", "大概", "感觉", "我觉得", "或许", "似乎", "好像")
_DIRECTIVES = ("你去", "帮我", "记得", "确认", "看一下", "检查", "安排", "去做", "处理")
_GREETINGS = re.compile(r"^(早|早上好|晚上好|hi|hey|哈|嗨|你好|大家好)", re.I)
_CLOSINGS = re.compile(r"^(好的?|ok|okay|收到|了解|明白|好|嗯嗯?|哦|好吧|好滴)\s*[!！。]?\s*$", re.I)

_FUNCTION_MARKERS = {
    "first_person_ratio": ("我", "我们", "咱", "咱们"),
    "second_person_ratio": ("你", "您", "你们", "您们"),
    "auxiliary_ratio": ("会", "能", "可以", "要", "得", "应该", "必须", "可能", "愿意"),
    "conjunction_ratio": ("但是", "不过", "然后", "所以", "因为", "虽然", "而且", "或者", "并且"),
    "negation_ratio": ("不", "没", "别", "没有", "非", "无", "莫", "勿"),
}


def _tokens(text: str) -> list[str]:
    return _ASCII_WORD.findall(text) + _CJK.findall(text)


def _mean(values: list[float], default: float = 0.0) -> float:
    return sum(values) / len(values) if values else default


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return math.sqrt(_mean([(value - mean) ** 2 for value in values]))


def _marker_rate(texts: list[str], markers: tuple[str, ...]) -> float:
    return _mean([float(sum(text.count(marker) for marker in markers)) for text in texts])


@dataclass
class RegisterVector:
    """Twenty-one dimensions describing ego's register with an interlocutor."""

    formality_score: float = 0.0
    avg_msg_length: float = 0.0
    msg_length_variance: float = 0.0
    code_switch_ratio: float = 0.0
    emoji_freq: float = 0.0
    question_ratio: float = 0.0
    ellipsis_ratio: float = 0.0
    exclamation_ratio: float = 0.0
    punctuation_density: float = 0.0
    hedging_freq: float = 0.0
    directive_freq: float = 0.0
    greeting_freq: float = 0.0
    closing_freq: float = 0.0
    first_person_ratio: float = 0.0
    second_person_ratio: float = 0.0
    auxiliary_ratio: float = 0.0
    conjunction_ratio: float = 0.0
    negation_ratio: float = 0.0
    response_latency: float = 0.0
    initiative_ratio: float = 0.0
    turn_length_ratio: float = 0.0

    def to_dict(self) -> dict[str, float]:
        return dataclasses.asdict(self)

    def values(self) -> list[float]:
        return list(self.to_dict().values())


@dataclass
class TopicFeatures:
    evidence_count: int = 0
    stance_fact_ids: list[str] = field(default_factory=list)
    opinion_recency: int = 0
    opinion_strength: float = 0.0

    def to_dict(self) -> dict[str, object]:
        return dataclasses.asdict(self)


def _response_latency(
    ego_messages: list[PersonaMessage], other_messages: list[PersonaMessage]
) -> float:
    by_conversation: dict[str, list[PersonaMessage]] = {}
    for message in [*ego_messages, *other_messages]:
        by_conversation.setdefault(message.conversation_id, []).append(message)
    owner_keys = {message.key for message in ego_messages}
    latencies: list[float] = []
    for conversation in by_conversation.values():
        ordered = sorted((m for m in conversation if m.timestamp > 0), key=lambda m: m.timestamp)
        for index, message in enumerate(ordered):
            if message.key in owner_keys:
                continue
            reply = next((m for m in ordered[index + 1 :] if m.key in owner_keys), None)
            if reply is not None:
                latencies.append((reply.timestamp - message.timestamp) / 1000.0)
    return _mean(latencies)


def _initiative_ratio(
    ego_messages: list[PersonaMessage], other_messages: list[PersonaMessage]
) -> float:
    owner_keys = {message.key for message in ego_messages}
    conversations: dict[str, list[PersonaMessage]] = {}
    for message in [*ego_messages, *other_messages]:
        conversations.setdefault(message.conversation_id, []).append(message)
    known = [
        min(messages, key=lambda message: message.timestamp)
        for messages in conversations.values()
        if messages and all(message.timestamp > 0 for message in messages)
    ]
    return _mean([1.0 if message.key in owner_keys else 0.0 for message in known])


def compute_register_vector(
    ego_messages: list[PersonaMessage], other_messages: list[PersonaMessage]
) -> RegisterVector:
    texts = [message.text for message in ego_messages if message.text]
    if not texts:
        return RegisterVector()
    lengths = [float(len(text)) for text in texts]
    token_lists = [_tokens(text) for text in texts]
    token_count = sum(len(tokens) for tokens in token_lists)
    ascii_count = sum(
        1 for tokens in token_lists for token in tokens if _ASCII_WORD.fullmatch(token)
    )
    punctuation_count = sum(len(_PUNCTUATION.findall(text)) for text in texts)
    char_count = sum(len(text) for text in texts)
    function_rates = {
        name: (
            sum(sum(text.count(marker) for marker in markers) for text in texts) / token_count
            if token_count
            else 0.0
        )
        for name, markers in _FUNCTION_MARKERS.items()
    }
    formality_parts = []
    for text, tokens in zip(texts, token_lists, strict=True):
        average_token_length = _mean([float(len(token)) for token in tokens], 1.0)
        emoji_penalty = min(len(_EMOJI.findall(text)) / max(len(tokens), 1), 1.0)
        formality_parts.append(max(0.0, min(1.0, average_token_length / 4.0 - 0.1 * emoji_penalty)))
    other_lengths = [float(len(message.text)) for message in other_messages if message.text]
    return RegisterVector(
        formality_score=_mean(formality_parts),
        avg_msg_length=_mean(lengths),
        msg_length_variance=_std(lengths),
        code_switch_ratio=ascii_count / token_count if token_count else 0.0,
        emoji_freq=_mean([float(len(_EMOJI.findall(text))) for text in texts]),
        question_ratio=_mean([1.0 if "?" in text or "？" in text else 0.0 for text in texts]),
        ellipsis_ratio=_mean([1.0 if text.rstrip().endswith(("...", "……", "…")) else 0.0 for text in texts]),
        exclamation_ratio=_mean([1.0 if "!" in text or "！" in text else 0.0 for text in texts]),
        punctuation_density=punctuation_count / char_count if char_count else 0.0,
        hedging_freq=_marker_rate(texts, _HEDGES),
        directive_freq=_marker_rate(texts, _DIRECTIVES),
        greeting_freq=_mean([1.0 if _GREETINGS.match(text.strip()) else 0.0 for text in texts]),
        closing_freq=_mean([1.0 if _CLOSINGS.match(text.strip()) else 0.0 for text in texts]),
        response_latency=_response_latency(ego_messages, other_messages),
        initiative_ratio=_initiative_ratio(ego_messages, other_messages),
        turn_length_ratio=_mean(lengths) / _mean(other_lengths) if other_lengths else 1.0,
        **function_rates,
    )


def compute_topic_features(facts: list[StanceFact]) -> TopicFeatures:
    ordered = sorted(facts, key=lambda fact: fact.timestamp, reverse=True)
    confidences = [fact.confidence for fact in ordered]
    return TopicFeatures(
        # NOTE (refactor requested): counting distinct source_unit_id as
        # "evidence" assumes per-message attribution. source_unit_id is a
        # best-effort, non-interface signal that is NULL under whole-chunk
        # extraction, so chunk-extracted facts collapse to a single {None}
        # bucket here. Rebuild this metric from raw ego messages instead of fact
        # lineage; do not depend on source_unit_id as an interface.
        evidence_count=len({fact.source_unit_id for fact in ordered}),
        stance_fact_ids=[fact.fact_id for fact in ordered[:10]],
        opinion_recency=max((fact.timestamp for fact in ordered), default=0),
        opinion_strength=_mean(confidences),
    )


def build_all_features(
    reader: PersonaCorpusReader,
    persona_db: PersonaStore,
    *,
    min_messages: int,
) -> dict[str, int]:
    """Build and persist all deterministic person and topic features."""

    persona_db.bind_owner(reader.settings)
    people = 0
    for corpus in reader.interlocutor_corpora():
        if len(corpus.ego_messages) < min_messages:
            continue
        vector = compute_register_vector(corpus.ego_messages, corpus.interlocutor_messages)
        persona_db.upsert_features(
            corpus.entity_id,
            "person",
            vector.to_dict(),
            len(corpus.ego_messages),
        )
        people += 1

    by_topic: dict[str, list[StanceFact]] = {}
    for fact in reader.stance_facts():
        by_topic.setdefault(fact.topic_entity_id, []).append(fact)
    for topic_id, facts in by_topic.items():
        features = compute_topic_features(facts)
        persona_db.upsert_features(
            topic_id,
            "topic",
            features.to_dict(),
            features.evidence_count,
        )
    return {"interlocutors": people, "topics": len(by_topic)}
