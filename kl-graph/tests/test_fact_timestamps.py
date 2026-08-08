"""Offline unit tests for U0 temporal grounding: date prefix on fact text.

``facts.timestamp`` exists but the fact TEXT carries no time, so retrieval and
synthesis cannot see when a fact happened. U0 prefixes every LLM-extracted fact
text with the source chunk's date — ``[YYYY-MM-DD] <text>`` — at Phase-B build
time only (the extraction cache keeps raw LLM output). The prefixed text feeds
the stored text, the embedding, AND the content-derived fact id.

These tests hit the pure ``_dated_fact_text`` helper and the ``_fact_id`` /
``_fact_edges`` agreement directly: no LLM, no network, no stores.
"""

from __future__ import annotations

import datetime

from kl_graph.ingest.pipeline import (
    IngestionPipeline,
    _dated_fact_text,
    _fact_id,
    entity_id_from_name,
)
from kl_graph.models.types import Entity, EntityType

# Fixed UTC+8 — the DingTalk corpus is China time (same fixed offset the
# pipeline uses; determinism must not depend on the machine's local zone).
CHINA_TZ = datetime.timezone(datetime.timedelta(hours=8))

MSG_ID = "chunk-u0-test"
FACT_TEXT = "张伟负责数据同步评审"


def _china_ts(year: int, month: int, day: int, hour: int = 10) -> int:
    """Unix ms for a wall-clock time in China time (the corpus timezone)."""
    return int(
        datetime.datetime(year, month, day, hour, 30, tzinfo=CHINA_TZ).timestamp()
        * 1000
    )


def test_date_prefix_format_cjk():
    """Fixed ``[YYYY-MM-DD] `` prefix on CJK fact text (design-doc example)."""
    ts = _china_ts(2026, 7, 15)
    assert _dated_fact_text(FACT_TEXT, ts) == "[2026-07-15] 张伟负责数据同步评审"


def test_date_prefix_format_ascii():
    ts = _china_ts(2026, 1, 2)
    assert _dated_fact_text("Alice approved the PR.", ts) == (
        "[2026-01-02] Alice approved the PR."
    )


def test_date_uses_fixed_china_timezone_not_local_or_utc():
    """23:30 UTC on 2026-07-15 is 07:30 China time on 2026-07-16: the prefix
    must follow the fixed +08:00 offset regardless of host timezone."""
    utc_ts = int(
        datetime.datetime(
            2026, 7, 15, 23, 30, tzinfo=datetime.timezone.utc
        ).timestamp()
        * 1000
    )
    assert _dated_fact_text(FACT_TEXT, utc_ts) == "[2026-07-16] " + FACT_TEXT


def test_zero_timestamp_returns_text_unprefixed():
    """ts=0/missing ⇒ raw text back; never emit ``[1970-01-01]``."""
    assert _dated_fact_text(FACT_TEXT, 0) == FACT_TEXT
    assert "[1970-01-01]" not in _dated_fact_text(FACT_TEXT, 0)
    assert not _dated_fact_text(FACT_TEXT, 0).startswith("[")


def test_negative_timestamp_returns_text_unprefixed():
    """ts<0 is an invalid/missing-like timestamp ⇒ raw text back; never emit
    ``[1970-01-01]`` for sentinel negatives such as -1 or -28800000."""
    assert _dated_fact_text(FACT_TEXT, -1) == FACT_TEXT
    assert _dated_fact_text(FACT_TEXT, -28800000) == FACT_TEXT
    assert "[1970-01-01]" not in _dated_fact_text(FACT_TEXT, -1)
    assert not _dated_fact_text(FACT_TEXT, -1).startswith("[")


def test_determinism_text_and_fact_id():
    """Same (text, ts) ⇒ byte-identical prefixed text and identical ``_fact_id``
    across repeated calls (replay/machine independence, [!RED] R2)."""
    ts = _china_ts(2026, 7, 15)
    texts = {_dated_fact_text(FACT_TEXT, ts) for _ in range(5)}
    assert len(texts) == 1, f"non-deterministic prefix output: {texts}"
    ids = {_fact_id(MSG_ID, _dated_fact_text(FACT_TEXT, ts)) for _ in range(5)}
    assert len(ids) == 1, f"non-deterministic fact id: {ids}"


def test_prefix_changes_fact_id_rebuild_consequence():
    """[!RED] R1 documented: ids are content-derived, so the prefix changes
    every fact id relative to the unprefixed text (accepted rebuild-not-migrate;
    full Phase-B rebuild + re-embed + ``improve`` re-run required)."""
    ts = _china_ts(2026, 7, 15)
    assert _fact_id(MSG_ID, _dated_fact_text(FACT_TEXT, ts)) != _fact_id(
        MSG_ID, FACT_TEXT
    )


def test_replay_from_raw_cache_is_stable():
    """``--build-only`` replay semantics: every replay reads the RAW cache text
    and applies the helper once, so repeated builds produce the same fact text
    and id (zero LLM cost, byte-identical facts)."""
    ts = _china_ts(2026, 7, 15)
    first_build = _dated_fact_text(FACT_TEXT, ts)
    replay_build = _dated_fact_text(FACT_TEXT, ts)  # replay re-reads raw cache
    assert first_build == replay_build
    assert _fact_id(MSG_ID, first_build) == _fact_id(MSG_ID, replay_build)


def test_already_prefixed_input_is_idempotent():
    """Idempotence guard: text that already starts with a ``[YYYY-MM-DD] ``
    date bracket is returned unchanged, so applying the helper twice never
    double-prefixes (defence against model-produced/imported payloads that
    already carry a date)."""
    ts = _china_ts(2026, 7, 15)
    prefixed = _dated_fact_text(FACT_TEXT, ts)
    assert _dated_fact_text(prefixed, ts) == prefixed
    # The guard keys on the leading date-bracket shape, not the date value.
    foreign = "[2020-01-01] " + FACT_TEXT
    assert _dated_fact_text(foreign, ts) == foreign


def test_fact_edges_use_prefixed_fact_id():
    """Edge/fact-id invariant under U0: with the chunk timestamp, every
    STATES/ABOUT edge source_id matches ``_fact_id`` over the DATE-PREFIXED
    text — edges cannot orphan from the facts ``_build_facts`` creates."""
    ts = _china_ts(2026, 7, 15)
    subj_eid = entity_id_from_name("张伟")
    all_entities = {
        subj_eid: Entity(id=subj_eid, name="张伟", entity_type=EntityType.PERSON)
    }
    raw_fact = {"fact_text": FACT_TEXT, "subject_entity": "张伟"}
    edges = IngestionPipeline._fact_edges(MSG_ID, raw_fact, all_entities, ts)
    assert edges
    expected_id = _fact_id(MSG_ID, _dated_fact_text(FACT_TEXT, ts))
    assert all(e.source_id == expected_id for e in edges)


def test_fact_edges_default_ts_keeps_unprefixed_id():
    """Backward-compatible default: callers that pass no timestamp keep the
    old unprefixed id formula."""
    edges = IngestionPipeline._fact_edges(MSG_ID, {"fact_text": FACT_TEXT}, {})
    assert edges
    assert all(e.source_id == _fact_id(MSG_ID, FACT_TEXT) for e in edges)


class _FakeStore:
    """Bare-minimum store for driving the fact-building paths offline."""

    def __init__(self, entities=()) -> None:
        self._entities = list(entities)
        self.facts: list = []
        self.edges: list = []

    def iter_all_entities(self):
        return iter(self._entities)

    def insert_facts(self, facts) -> None:
        self.facts.extend(facts)

    def insert_edges(self, edges) -> None:
        self.edges.extend(edges)


def test_unit_incremental_fact_build_uses_dated_text():
    """The canonical unit-incremental builder dates stored text and fact IDs."""
    from kl_graph.models.types import Chunk

    ts = _china_ts(2026, 7, 15)
    chunk = Chunk(id=MSG_ID, content=FACT_TEXT, timestamp=ts)
    subj_eid = entity_id_from_name("张伟")
    subj = Entity(id=subj_eid, name="张伟", entity_type=EntityType.PERSON)
    result = {"facts": [{"fact_text": FACT_TEXT, "subject_entity": "张伟"}]}

    # Batch path: real _build_facts on a bare pipeline instance.
    batch_store = _FakeStore(entities=[subj])
    pipe = IngestionPipeline.__new__(IngestionPipeline)
    pipe.checkpoint = None
    pipe.messages = [chunk]
    pipe.extra_chunks = []
    pipe.extraction_results = {chunk.id: result}
    pipe.all_facts = []
    pipe.store = batch_store
    pipe._build_facts()

    assert len(pipe.all_facts) == 1
    fact = pipe.all_facts[0]
    assert fact.text == _dated_fact_text(FACT_TEXT, ts)
    assert fact.id == _fact_id(MSG_ID, fact.text)
