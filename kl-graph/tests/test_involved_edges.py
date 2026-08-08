"""Offline unit tests for multi-entity (Option A) fact→entity ABOUT edges.

Covers the ``docs/todo/multi-entity-fact-edges.md`` design: a fact fans out to
EVERY entity it touches with a uniform ``ABOUT`` edge (subject, object, and all
``involved_entities``), the fact-id is computed via a single shared helper so
``_build_facts`` and ``_create_edges`` cannot diverge, and the change is strictly
additive (pre-existing STATES/ABOUT emits still fire).

I/O-free: exercises the pure ``IngestionPipeline._fact_edges`` staticmethod and
the module-level ``_fact_id`` helper with synthetic dicts. No network, no LLM,
no Qdrant, no SQLite writes.  Run: python3 tests/test_involved_edges.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kl_graph.ingest.pipeline import IngestionPipeline, _fact_id, entity_id_from_name
from kl_graph.models.types import EdgeType, Entity, EntityType

# ─── helpers ──────────────────────────────────────────────────────────────


def _entity(name: str) -> Entity:
    """A minimal Entity node keyed by its deterministic id."""
    eid = entity_id_from_name(name)
    return Entity(id=eid, name=name, entity_type=EntityType.PERSON)


def _entities(*names: str) -> dict[str, Entity]:
    """``entity_id -> Entity`` map, mirroring ``pipeline.all_entities``."""
    return {entity_id_from_name(n): _entity(n) for n in names}


def _about_targets(edges) -> set[str]:
    """entity ids that receive an ABOUT edge in ``edges``."""
    return {
        e.target_id
        for e in edges
        if e.edge_type == EdgeType.ABOUT and e.target_type == "entity"
    }


def _edge_tuples(edges) -> list[tuple]:
    """Comparable (type, source, target_type, target) tuples for dup checks."""
    return [
        (e.edge_type, e.source_id, e.target_type, e.target_id) for e in edges
    ]


MSG_ID = "msg:conv/abc123"
FACT_TEXT = "V107/V108 vs V100 的 coding 测评任务是李娜和李强两人一起做的"


# ─── tests ──────────────────────────────────────────────────────────────────


def test_joint_claim_fans_out_to_all_entities():
    """subject 李娜 + involved [李娜, 李强] ⇒ ABOUT to BOTH people."""
    all_entities = _entities("李娜", "李强")
    raw_fact = {
        "subject_entity": "李娜",
        "object_entity": None,
        "relation_type": "WORKED_ON",
        "fact_text": FACT_TEXT,
        "involved_entities": ["李娜", "李强"],
    }
    edges = IngestionPipeline._fact_edges(MSG_ID, raw_fact, all_entities)

    targets = _about_targets(edges)
    assert entity_id_from_name("李娜") in targets, "subject 李娜 missing ABOUT edge"
    assert entity_id_from_name("李强") in targets, "participant 李强 missing ABOUT edge"
    # Every fact→entity edge is ABOUT (Option A: uniform fan-out).
    assert all(
        e.edge_type == EdgeType.ABOUT
        for e in edges
        if e.target_type == "entity"
    ), "fact→entity edge used a non-ABOUT type (Option A requires uniform ABOUT)"
    # The retired INVOLVES type must not reappear, not even as a raw string.
    assert not any(
        getattr(e.edge_type, "value", e.edge_type) == "INVOLVES" for e in edges
    ), "INVOLVES is removed (divergence B) and must never be emitted"
    print("ok  joint claim fans out to both 李娜 and 李强 via ABOUT")


def test_no_duplicate_edges_for_repeated_or_subject_equal_participants():
    """involved_entities repeating subject/object (and each other) ⇒ no dup edges."""
    all_entities = _entities("李娜", "李强")
    raw_fact = {
        "subject_entity": "李娜",
        "object_entity": "李强",
        "fact_text": FACT_TEXT,
        # subject + object repeated, plus a duplicate participant.
        "involved_entities": ["李娜", "李强", "李强", "李娜"],
    }
    edges = IngestionPipeline._fact_edges(MSG_ID, raw_fact, all_entities)

    tuples = _edge_tuples(edges)
    assert len(tuples) == len(set(tuples)), f"duplicate edges emitted: {tuples}"
    # Exactly: 1 STATES + ABOUT(李娜) + ABOUT(李强) = 3 edges, no more.
    about = _about_targets(edges)
    assert about == {
        entity_id_from_name("李娜"),
        entity_id_from_name("李强"),
    }
    assert len(edges) == 3, f"expected 3 edges (STATES + 2 ABOUT), got {len(edges)}"
    print("ok  repeated / subject-equal participants produce no duplicate edges")


def test_missing_involved_entities_degrades_gracefully():
    """Old-cache fact without involved_entities ⇒ only subject/object edges, no error."""
    all_entities = _entities("李娜")
    raw_fact = {
        "subject_entity": "李娜",
        "object_entity": None,
        "fact_text": FACT_TEXT,
        # NOTE: no "involved_entities" key at all (old cache shape).
    }
    edges = IngestionPipeline._fact_edges(MSG_ID, raw_fact, all_entities)

    about = _about_targets(edges)
    assert about == {entity_id_from_name("李娜")}, (
        "without involved_entities only the subject ABOUT edge should exist"
    )
    # STATES + subject ABOUT only.
    assert len(edges) == 2, f"expected 2 edges, got {len(edges)}"
    print("ok  missing involved_entities degrades gracefully (no error, no extra edges)")


def test_participant_not_in_entities_yields_no_edge():
    """A participant that never became an entity node ⇒ no dangling edge."""
    all_entities = _entities("李娜")  # 李强 deliberately absent
    raw_fact = {
        "subject_entity": "李娜",
        "fact_text": FACT_TEXT,
        "involved_entities": ["李娜", "李强"],
    }
    edges = IngestionPipeline._fact_edges(MSG_ID, raw_fact, all_entities)

    about = _about_targets(edges)
    assert entity_id_from_name("李强") not in about, (
        "no edge should be emitted for a participant absent from all_entities"
    )
    assert about == {entity_id_from_name("李娜")}
    print("ok  participant absent from all_entities yields no edge")


def test_fact_id_agreement_between_build_and_edges():
    """The id used by _fact_edges matches _fact_id(msg_id, fact_text) exactly.

    _build_facts derives the id via _fact_id(msg.id, fact_text); _create_edges
    delegates to _fact_edges which also calls _fact_id. Assert the STATES/ABOUT
    edges reference precisely that id, proving the two sites cannot diverge.
    """
    all_entities = _entities("李娜")
    raw_fact = {
        "subject_entity": "李娜",
        "fact_text": FACT_TEXT,
        "involved_entities": ["李娜"],
    }
    expected_id = _fact_id(MSG_ID, FACT_TEXT)
    edges = IngestionPipeline._fact_edges(MSG_ID, raw_fact, all_entities)

    assert edges, "expected at least the STATES + subject ABOUT edges"
    for e in edges:
        assert e.source_type == "fact"
        assert e.source_id == expected_id, (
            f"edge fact_id {e.source_id!r} != _fact_id() {expected_id!r} — "
            "the two id computations have diverged"
        )
    # And the helper uses the FULL fact_text (not the old [:100] slice): a fact
    # differing only past char 100 must get a different id.
    long_a = "x" * 100 + "AAAA"
    long_b = "x" * 100 + "BBBB"
    assert _fact_id(MSG_ID, long_a) != _fact_id(MSG_ID, long_b), (
        "full fact_text must be used so texts differing past char 100 differ in id"
    )
    print("ok  _fact_id agreement + full-text id (no [:100] collision)")


def test_regression_preexisting_edges_still_emitted():
    """[!RED] The fan-out must not remove/gate the pre-existing STATES + ABOUT."""
    all_entities = _entities("李娜", "李强")
    raw_fact = {
        "subject_entity": "李娜",
        "object_entity": "李强",
        "fact_text": FACT_TEXT,
        "involved_entities": ["李娜", "李强"],
    }
    edges = IngestionPipeline._fact_edges(MSG_ID, raw_fact, all_entities)

    fact_id = _fact_id(MSG_ID, FACT_TEXT)
    # Pre-existing STATES: fact → source chunk.
    assert any(
        e.edge_type == EdgeType.STATES
        and e.source_id == fact_id
        and e.target_type == "chunk"
        and e.target_id == MSG_ID
        for e in edges
    ), "pre-existing STATES edge (fact→chunk) missing"
    # Pre-existing subject ABOUT: fact → 李娜.
    assert any(
        e.edge_type == EdgeType.ABOUT
        and e.target_type == "entity"
        and e.target_id == entity_id_from_name("李娜")
        for e in edges
    ), "pre-existing subject ABOUT edge missing"
    print("ok  regression: pre-existing STATES + subject ABOUT still emitted")


def test_trivial_fact_text_yields_no_edges():
    """Guard parity with the original: <5-char / empty fact_text ⇒ no edges."""
    all_entities = _entities("李娜")
    assert IngestionPipeline._fact_edges(MSG_ID, {"fact_text": "hi"}, all_entities) == []
    assert IngestionPipeline._fact_edges(MSG_ID, {}, all_entities) == []
    assert IngestionPipeline._fact_edges(MSG_ID, "not a dict", all_entities) == []
    print("ok  trivial / malformed raw_fact yields no edges (guard parity)")


def test_at_prefixed_subject_recovered_not_dropped():
    """[fix-now regression] '@'-prefixed subject must still get exactly one ABOUT.

    Old/malformed cache can carry ``subject_entity='@李娜'`` while the entity
    node was created under the '@'-stripped name '李娜' (by ``_build_entities``).
    Before the fix, the subject ABOUT lookup used the unstripped '@李娜' (not in
    all_entities → no subject edge), and ``seen`` was seeded with the stripped
    '李娜' → the ``involved_entities=['李娜']`` entry was skipped too, so the
    person got NO edge at all. After the fix, subject/object/involved all
    normalize identically, so the person is emitted exactly once.
    """
    # Node exists under the '@'-STRIPPED name, as _build_entities creates it.
    all_entities = _entities("李娜")
    raw_fact = {
        "subject_entity": "@李娜",
        "object_entity": None,
        "fact_text": FACT_TEXT,
        "involved_entities": ["李娜"],
    }
    edges = IngestionPipeline._fact_edges(MSG_ID, raw_fact, all_entities)

    tianwenze = entity_id_from_name("李娜")
    about_edges = [
        e for e in edges
        if e.edge_type == EdgeType.ABOUT and e.target_type == "entity"
    ]
    assert _about_targets(edges) == {tianwenze}, (
        "'@'-prefixed subject must resolve to the '李娜' node (recovered, not dropped)"
    )
    assert len(about_edges) == 1, (
        f"expected exactly ONE ABOUT edge (no duplicate from involved_entities), "
        f"got {len(about_edges)}"
    )
    print("ok  '@'-prefixed subject recovered as exactly one ABOUT edge")


def test_clean_subject_still_single_about_no_regression():
    """No-regression companion: a clean 'subject_entity=李娜' with the same

    involved_entities=['李娜'] still yields exactly one ABOUT edge (the fix is a
    no-op for already-normalized input, since '.lstrip("@")' on a clean name
    changes nothing).
    """
    all_entities = _entities("李娜")
    raw_fact = {
        "subject_entity": "李娜",
        "object_entity": None,
        "fact_text": FACT_TEXT,
        "involved_entities": ["李娜"],
    }
    edges = IngestionPipeline._fact_edges(MSG_ID, raw_fact, all_entities)

    about_edges = [
        e for e in edges
        if e.edge_type == EdgeType.ABOUT and e.target_type == "entity"
    ]
    assert _about_targets(edges) == {entity_id_from_name("李娜")}
    assert len(about_edges) == 1, (
        f"clean subject must still yield exactly one ABOUT edge, got {len(about_edges)}"
    )
    print("ok  clean subject still yields exactly one ABOUT edge (no regression)")


def _run_all():
    tests = [
        test_joint_claim_fans_out_to_all_entities,
        test_no_duplicate_edges_for_repeated_or_subject_equal_participants,
        test_missing_involved_entities_degrades_gracefully,
        test_participant_not_in_entities_yields_no_edge,
        test_fact_id_agreement_between_build_and_edges,
        test_regression_preexisting_edges_still_emitted,
        test_trivial_fact_text_yields_no_edges,
        test_at_prefixed_subject_recovered_not_dropped,
        test_clean_subject_still_single_about_no_regression,
    ]
    for t in tests:
        t()
    print(f"\nAll {len(tests)} multi-entity-fact-edge tests passed.")


if __name__ == "__main__":
    _run_all()
