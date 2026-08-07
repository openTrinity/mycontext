"""Tests for Scope nodes, PART_OF edges, and the additive LadybugDB Chunk label.

Covers conformance divergence C (Scope + ``PART_OF``) and divergence F (``Chunk``
is the only content node label — the ``Message`` concept is gone):

- ``scope_id_from`` is deterministic, namespaced by source, and unambiguous when
  a component contains the ``:`` that used to join the hash payload.
- ``SQLiteStore.insert_scopes`` / ``get_scope`` round-trip (incl. JSON metadata).
- The pure scope-derivation + edge-build helper emits exactly one ``PART_OF``
  per chunk, pointing at the right scope, with no dangling target, and raises on
  a chunk id claimed by two scopes.
- ``EdgeType.PART_OF`` exists.
- The LadybugDB schema creates the ``Scope``/``Chunk`` node tables and the
  ``PART_OF`` rel group, and no ``Message`` label remains (skipped when
  ``ladybug`` is absent).

Run: ``.venv/bin/python -m pytest tests/test_scopes_and_chunks.py -q``
"""

from __future__ import annotations

import pathlib

import pytest

from kl_graph.ingest.pipeline import build_scopes_and_part_of, scope_of_chunk
from kl_graph.models.types import (
    Chunk,
    EdgeType,
    Scope,
    scope_id_from,
)
from kl_graph.storage.sqlite_store import SQLiteStore

try:
    import ladybug  # noqa: F401

    has_ladybug = True
except ImportError:
    has_ladybug = False

skip_no_ladybug = pytest.mark.skipif(
    not has_ladybug,
    reason="ladybug not installed — install with: pip install ladybug",
)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _msg(mid: str, conv: str, *, title: str = "") -> Chunk:
    """A chat chunk: ``source_type="message"``, chat fields in ``metadata``."""
    metadata: dict = {"conversation_id": conv, "sender": "alice"}
    if title:
        metadata["conversation_title"] = title
    return Chunk(
        id=mid,
        content=f"content {mid}",
        source_type="message",
        timestamp=1,
        metadata=metadata,
    )


# ── (d) Enum member ───────────────────────────────────────────────────────────


def test_part_of_edge_type_exists() -> None:
    """PART_OF is a structural edge type in the enum."""
    assert hasattr(EdgeType, "PART_OF")
    assert EdgeType.PART_OF.value == "PART_OF"


# ── (a) Deterministic scope ids ───────────────────────────────────────────────


def test_scope_id_from_is_deterministic() -> None:
    """Same (source_type, native_id) always yields the same id."""
    a = scope_id_from("message", "conv-1")
    b = scope_id_from("message", "conv-1")
    assert a == b


def test_scope_id_from_differs_per_native_id() -> None:
    """Different containers in the same source get different ids."""
    assert scope_id_from("message", "conv-1") != scope_id_from("message", "conv-2")


def test_scope_id_from_is_namespaced_by_source() -> None:
    """The same native id in two sources cannot collide into one scope."""
    assert scope_id_from("message", "x1") != scope_id_from("wiki", "x1")


def test_scope_id_from_unambiguous_for_colon_containing_components() -> None:
    """A ``:`` inside either component cannot shift the (source, native) split.

    Boundary case for the id encoding: chunk/container ids like ``wiki:n1`` are
    real, and a plain ``:``-joined hash payload made ``("a:b", "c")`` and
    ``("a", "b:c")`` collide, silently merging two distinct containers.
    """
    assert scope_id_from("a:b", "c") != scope_id_from("a", "b:c")
    assert scope_id_from("wiki", "n1:0") != scope_id_from("wiki:n1", "0")
    # Escaping must not cost determinism.
    assert scope_id_from("a:b", "c") == scope_id_from("a:b", "c")
    assert scope_id_from("wiki", 'n"1') == scope_id_from("wiki", 'n"1')


# ── (b) SQLite round-trip ─────────────────────────────────────────────────────


def test_insert_scopes_get_scope_round_trip(tmp_path: pathlib.Path) -> None:
    """A stored scope comes back with all fields, metadata included."""
    store = SQLiteStore(tmp_path / "scopes.db")
    sid = scope_id_from("message", "conv-1")
    store.insert_scopes([
        Scope(
            id=sid,
            scope_type="conversation",
            title="数据同步群",
            metadata={"source_type": "message", "native_id": "conv-1"},
        )
    ])
    fetched = store.get_scope(sid)
    assert fetched is not None
    assert fetched.id == sid
    assert fetched.scope_type == "conversation"
    assert fetched.title == "数据同步群"
    assert fetched.metadata == {"source_type": "message", "native_id": "conv-1"}
    store.close()


def test_get_scope_missing_returns_none(tmp_path: pathlib.Path) -> None:
    """An unknown scope id reads back as None (no exception)."""
    store = SQLiteStore(tmp_path / "scopes.db")
    assert store.get_scope("nope") is None
    store.close()


def test_insert_scopes_is_idempotent(tmp_path: pathlib.Path) -> None:
    """Re-inserting the same deterministic scope id does not duplicate rows."""
    store = SQLiteStore(tmp_path / "scopes.db")
    scope = Scope(id=scope_id_from("wiki", "node-9"), scope_type="document")
    store.insert_scopes([scope])
    store.insert_scopes([scope])
    count = store.conn.execute("SELECT COUNT(*) FROM scopes").fetchone()[0]
    assert count == 1
    store.close()


# ── (c) PART_OF emission ──────────────────────────────────────────────────────


def test_part_of_one_edge_per_chunk_two_conversations() -> None:
    """Two conversations → two scopes, exactly one PART_OF per chunk."""
    chunks = [
        _msg("m1", "conv-a", title="A群"),
        _msg("m2", "conv-a"),
        _msg("m3", "conv-b"),
    ]
    scopes, edges = build_scopes_and_part_of(chunks)

    assert len(scopes) == 2, [s.id for s in scopes]
    assert len(edges) == len(chunks)

    # Exactly one PART_OF per chunk id.
    per_chunk: dict[str, list[str]] = {}
    for e in edges:
        assert e.edge_type is EdgeType.PART_OF
        assert e.target_type == "scope"
        assert e.source_type == "chunk"
        per_chunk.setdefault(e.source_id, []).append(e.target_id)
    assert {k: len(v) for k, v in per_chunk.items()} == {"m1": 1, "m2": 1, "m3": 1}

    # Right scope: same conversation → same scope id, different → different.
    conv_a = scope_id_from("message", "conv-a")
    conv_b = scope_id_from("message", "conv-b")
    assert per_chunk["m1"] == [conv_a]
    assert per_chunk["m2"] == [conv_a]
    assert per_chunk["m3"] == [conv_b]

    # No dangling target: every edge target is a returned scope.
    scope_ids = {s.id for s in scopes}
    assert {t for targets in per_chunk.values() for t in targets} <= scope_ids


def test_part_of_scope_carries_title_and_native_identity() -> None:
    """The derived chat Scope keeps its title and the source-native identity."""
    scopes, _ = build_scopes_and_part_of([_msg("m1", "conv-a", title="A群")])
    scope = scopes[0]
    assert scope.scope_type == "conversation"
    assert scope.title == "A群"
    assert scope.metadata == {"source_type": "message", "native_id": "conv-a"}


def test_part_of_non_chat_chunks_use_chunk_source_type() -> None:
    """Non-chat chunks group by their loader-recorded container id."""
    chunks = [
        Chunk(
            id="wiki:n1:0",
            content="a",
            source_type="wiki",
            metadata={"node_id": "n1", "title": "设计文档"},
        ),
        Chunk(
            id="wiki:n1:1",
            content="b",
            source_type="wiki",
            metadata={"node_id": "n1", "title": "设计文档"},
        ),
        Chunk(
            id="minutes:mtg-7:summary",
            content="c",
            source_type="minutes",
            metadata={"meeting_id": "mtg-7", "title": "周会"},
        ),
    ]
    scopes, edges = build_scopes_and_part_of(chunks)

    assert len(scopes) == 2
    assert len(edges) == 3
    assert {e.source_type for e in edges} == {"chunk"}
    by_source = {e.source_id: e.target_id for e in edges}
    assert by_source["wiki:n1:0"] == by_source["wiki:n1:1"] == scope_id_from("wiki", "n1")
    assert by_source["minutes:mtg-7:summary"] == scope_id_from("minutes", "mtg-7")
    assert {s.scope_type for s in scopes} == {"document", "meeting"}


def test_scope_type_follows_design_vocabulary() -> None:
    """Derived scope_type uses graph-design.md's vocabulary, source_type otherwise."""
    cases = {
        "mail": ("conversation_id", "mail_thread"),
        "minutes": ("meeting_id", "meeting"),
        "wiki": ("node_id", "document"),
        # Open vocabulary: an unmapped source falls back to its own source_type.
        "work": ("scope_id", "work"),
    }
    for source_type, (key, expected) in cases.items():
        chunk = Chunk(
            id=f"{source_type}:1",
            content="x",
            source_type=source_type,
            metadata={key: "native-1"},
        )
        scope = scope_of_chunk(chunk)
        assert scope is not None, source_type
        assert scope.scope_type == expected, (source_type, scope.scope_type)
        assert scope.id == scope_id_from(source_type, "native-1")


def test_part_of_skipped_when_no_container_known() -> None:
    """A chunk whose source records no container gets no synthetic scope/edge."""
    chunks = [Chunk(id="c1", content="x", source_type="work", metadata={})]
    scopes, edges = build_scopes_and_part_of(chunks)
    assert scopes == []
    assert edges == []
    assert scope_of_chunk(chunks[0]) is None


def test_part_of_build_is_idempotent_across_calls() -> None:
    """Re-deriving over the same chunks yields identical scopes + edges."""
    chunks = [_msg("m1", "conv-a"), _msg("m2", "conv-b")]
    s1, e1 = build_scopes_and_part_of(chunks)
    s2, e2 = build_scopes_and_part_of(chunks)
    assert [s.id for s in s1] == [s.id for s in s2]
    assert [(e.source_id, e.target_id) for e in e1] == [
        (e.source_id, e.target_id) for e in e2
    ]


def test_part_of_deduped_for_repeated_chunk() -> None:
    """A chunk appearing twice still gets a single PART_OF edge."""
    msg = _msg("m1", "conv-a")
    _, edges = build_scopes_and_part_of([msg, msg])
    assert len(edges) == 1


def test_part_of_same_chunk_id_same_scope_dedups_without_error() -> None:
    """Two distinct objects sharing an id and a scope collapse to one edge."""
    scopes, edges = build_scopes_and_part_of(
        [_msg("m1", "conv-a"), _msg("m1", "conv-a")]
    )
    assert len(scopes) == 1
    assert len(edges) == 1
    assert edges[0].source_id == "m1"
    assert edges[0].target_id == scope_id_from("message", "conv-a")


def test_part_of_conflicting_scopes_for_one_chunk_raises() -> None:
    """One chunk id in two containers is a data error, not two PART_OF edges.

    At most one scope membership per chunk, so the conflict fails loud (naming
    both scopes) instead of emitting a second edge that later readers would
    have to arbitrate.
    """
    conv_a = scope_id_from("message", "conv-a")
    conv_b = scope_id_from("message", "conv-b")
    with pytest.raises(ValueError) as excinfo:
        build_scopes_and_part_of([_msg("m1", "conv-a"), _msg("m1", "conv-b")])
    msg = str(excinfo.value)
    assert "m1" in msg
    assert conv_a in msg
    assert conv_b in msg


# ── Rel-group / node-label schema (label helper needs no ladybug) ─────────────


def test_ladybug_rel_group_defs_include_part_of() -> None:
    """PART_OF is chunk→scope only: ``Chunk`` is the one content label."""
    from kl_graph.storage.ladybug_graph import _REL_GROUP_DEFS

    assert _REL_GROUP_DEFS["PART_OF"] == [("Chunk", "Scope")]
    # No rel group anywhere still declares a Message endpoint.
    for rel, combos in _REL_GROUP_DEFS.items():
        for src, tgt in combos:
            assert "Message" not in (src, tgt), (rel, src, tgt)


def test_ladybug_type_to_label_resolves_scope_and_chunk() -> None:
    """The node-type helper maps scope/chunk; ``message`` is no longer a label."""
    from kl_graph.storage.ladybug_graph import _label_to_type, _type_to_label

    assert _type_to_label("scope") == "Scope"
    assert _type_to_label("chunk") == "Chunk"
    assert _label_to_type("Scope") == "scope"
    assert _label_to_type("Chunk") == "chunk"
    # The retired Message label reads back as the generic content type.
    assert _label_to_type("Message") == "chunk"


# ── (e) LadybugDB native schema ───────────────────────────────────────────────


@skip_no_ladybug
def test_ladybug_scope_and_chunk_tables_creatable(tmp_path: pathlib.Path) -> None:
    """Schema init creates Scope + Chunk node tables; a chat chunk is a Chunk.

    Asserted by writing one node of each label through the schema rather than by
    introspecting the catalog, so the check does not depend on the ``show_tables``
    dialect. A missing node table makes the ``MATCH`` return nothing.
    """
    from kl_graph.storage.ladybug_graph import LadybugGraphDB

    graph = LadybugGraphDB(db_path=str(tmp_path / "graph.ladybug"))
    graph.upsert_scope_node("s1", "conversation", "T")
    graph.upsert_chunk_node("c1", "wiki", 7, "http://example/doc")
    # A chat message is an ordinary Chunk with source_type="message".
    graph.upsert_chunk_node("m1", "message", 8, "alice")

    assert graph.query("MATCH (s:Scope {id: 's1'}) RETURN s.title AS t") == [{"t": "T"}]
    assert graph.query("MATCH (c:Chunk {id: 'c1'}) RETURN c.source_type AS st") == [
        {"st": "wiki"}
    ]
    assert graph.query("MATCH (c:Chunk {id: 'm1'}) RETURN c.source_type AS st") == [
        {"st": "message"}
    ]
    assert graph._node_label("s1") == "scope"
    assert graph._node_label("c1") == "chunk"
    assert graph._node_label("m1") == "chunk"
    graph.close()


@skip_no_ladybug
def test_ladybug_part_of_edge_insertable(tmp_path: pathlib.Path) -> None:
    """A chunk→scope PART_OF edge is insertable and traversable."""
    from kl_graph.storage.ladybug_graph import LadybugGraphDB

    graph = LadybugGraphDB(db_path=str(tmp_path / "graph.ladybug"))
    sid = scope_id_from("wiki", "n1")
    graph.upsert_scope_node(sid, "document", "设计文档")
    graph.upsert_chunk_node("wiki:n1:0", "wiki", 0, "http://example/doc")
    graph.insert_edges("chunk", "wiki:n1:0", "scope", sid, "PART_OF")

    nbrs = graph.get_neighbors(
        "wiki:n1:0", "chunk", edge_types=["PART_OF"], direction="out"
    )
    assert [(nid, ntype, etype) for nid, ntype, etype, _ in nbrs] == [
        (sid, "scope", "PART_OF")
    ]
    graph.close()


@skip_no_ladybug
def test_ladybug_store_insert_scopes_dual_writes(tmp_path: pathlib.Path) -> None:
    """LadybugStore.insert_scopes writes the SQLite row AND the graph node."""
    from kl_graph.storage.base import create_store

    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    sid = scope_id_from("message", "conv-a")
    store.insert_scopes([Scope(id=sid, scope_type="conversation", title="A群")])
    fetched = store.get_scope(sid)
    assert fetched is not None
    assert fetched.title == "A群"
    rows = store._graph.query(
        "MATCH (s:Scope {id: $id}) RETURN s.scope_type AS st", {"id": sid}
    )
    assert rows and rows[0]["st"] == "conversation"
    store.close()
