"""Guard the graph-design edge-type vocabulary (conformance divergences A + D).

Asserts the in-place rename landed with **no backward-compat aliases**:

- ``SENT_BY`` → ``AUTHORED_BY``
- ``SIMILAR_TO`` → split into ``ENTITY_SIMILAR`` (entity→entity) and
  ``FACT_SIMILAR`` (fact→fact)
- ``BELONGS_TO`` → ``COMM_MEMBER``
- ``SUPERSEDES`` → ``ENTAILS``
- ``CONFLICTS`` → ``CONTRADICTS``

``INVOLVES`` and ``IN_CONV`` are now **removed** (divergence B): ``INVOLVES``
was superseded by the uniform ``ABOUT`` fan-out and ``IN_CONV`` by
``PART_OF`` + Scope, and neither was ever emitted.

Run: ``.venv/bin/python -m pytest tests/test_edge_vocabulary.py -q``
"""

from __future__ import annotations

from kl_graph.models.types import EdgeType
from kl_graph.query import graph_walk as gw

# The five legacy names that must be fully gone (no aliases, no dual-window).
LEGACY_NAMES = ("SENT_BY", "SIMILAR_TO", "BELONGS_TO", "SUPERSEDES", "CONFLICTS")

# Their replacements, which must all exist.
RENAMED_NAMES = (
    "AUTHORED_BY",
    "ENTITY_SIMILAR",
    "FACT_SIMILAR",
    "COMM_MEMBER",
    "ENTAILS",
    "CONTRADICTS",
)


def test_legacy_edge_type_members_are_gone() -> None:
    """No legacy member survives as an attribute or as a value."""
    member_names = {e.name for e in EdgeType}
    member_values = {e.value for e in EdgeType}
    for legacy in LEGACY_NAMES:
        assert legacy not in member_names, f"EdgeType.{legacy} still exists"
        assert legacy not in member_values, f"EdgeType value {legacy!r} still exists"
        assert not hasattr(EdgeType, legacy), f"EdgeType.{legacy} still attribute-accessible"


def test_renamed_edge_type_members_exist() -> None:
    """Every replacement member exists and its value matches its name."""
    for name in RENAMED_NAMES:
        assert hasattr(EdgeType, name), f"EdgeType.{name} missing"
        assert EdgeType[name].value == name, f"EdgeType.{name} value mismatch"


def test_similar_to_split_into_two_members() -> None:
    """The generic SIMILAR_TO is replaced by two type-specific members."""
    assert EdgeType.ENTITY_SIMILAR.value == "ENTITY_SIMILAR"
    assert EdgeType.FACT_SIMILAR.value == "FACT_SIMILAR"
    assert EdgeType.ENTITY_SIMILAR is not EdgeType.FACT_SIMILAR


def test_involves_and_in_conv_are_gone() -> None:
    """Divergence B: both dead types are removed from the vocabulary."""
    member_names = {e.name for e in EdgeType}
    member_values = {e.value for e in EdgeType}
    for dead in ("INVOLVES", "IN_CONV"):
        assert dead not in member_names, f"EdgeType.{dead} still exists"
        assert dead not in member_values, f"EdgeType value {dead!r} still exists"
        assert not hasattr(EdgeType, dead), f"EdgeType.{dead} still attribute-accessible"


def test_dead_types_gone_from_traversal_and_schema() -> None:
    """The dead types leave no trace in the walk set or backend traversal sets."""
    from kl_graph.storage.ladybug_graph import (
        _REL_GROUP_DEFS,
    )
    from kl_graph.storage.ladybug_graph import (
        DEFAULT_PATH_EDGES as LADYBUG_PATH_EDGES,
    )
    from kl_graph.storage.sqlite_graph import DEFAULT_PATH_EDGES as SQLITE_PATH_EDGES

    for dead in ("INVOLVES", "IN_CONV"):
        assert dead not in gw.WALKABLE, f"WALKABLE still contains {dead}"
        assert dead not in gw._NON_NODE_EDGE_TYPES, f"{dead} still a non-node type"
        assert dead not in _REL_GROUP_DEFS, f"{dead} still a LadybugDB rel group"
        assert dead not in LADYBUG_PATH_EDGES, f"{dead} still traversed by LadybugDB"
        assert dead not in SQLITE_PATH_EDGES, f"{dead} still traversed by SQLite"


def test_walkable_uses_renamed_names_only() -> None:
    """graph_walk.WALKABLE carries the new vocabulary and zero legacy names."""
    for legacy in LEGACY_NAMES:
        assert legacy not in gw.WALKABLE, f"WALKABLE still contains {legacy}"

    # Both similarity types connect valid nodes, so both are walkable.
    assert "ENTITY_SIMILAR" in gw.WALKABLE
    assert "FACT_SIMILAR" in gw.WALKABLE
    assert "AUTHORED_BY" in gw.WALKABLE
    assert "ENTAILS" in gw.WALKABLE
    assert "CONTRADICTS" in gw.WALKABLE


def test_non_node_edge_types_use_renamed_community_name() -> None:
    """COMM_MEMBER (formerly BELONGS_TO) is the community-membership name.

    It is now walkable: divergence E reified Community as a node and materialized
    membership edges, so no enum member targets a non-node and the exclusion set
    is empty. The rename assertion is what this test guards — the legacy name must
    appear nowhere.
    """
    assert EdgeType.COMM_MEMBER.value in gw.WALKABLE
    assert gw._NON_NODE_EDGE_TYPES == set()
    assert "BELONGS_TO" not in gw._NON_NODE_EDGE_TYPES
    assert "BELONGS_TO" not in gw.WALKABLE


def test_ladybug_rel_groups_are_type_correct() -> None:
    """The split is encoded at the schema level with correct endpoint labels.

    Spec §A: ``ENTITY_SIMILAR`` is entity→entity and ``FACT_SIMILAR`` is
    fact→fact, so the mixed permutations of the old shared ``SIMILAR_TO`` group
    must be gone.
    """
    from kl_graph.storage.ladybug_graph import _REL_GROUP_DEFS

    assert "SIMILAR_TO" not in _REL_GROUP_DEFS
    assert "SENT_BY" not in _REL_GROUP_DEFS
    assert _REL_GROUP_DEFS["ENTITY_SIMILAR"] == [("Entity", "Entity")]
    assert _REL_GROUP_DEFS["FACT_SIMILAR"] == [("Fact", "Fact")]
    # Divergence F: ``Chunk`` is the only content label, so the authored-by
    # source endpoint is a Chunk (a chat message is a chunk).
    assert _REL_GROUP_DEFS["AUTHORED_BY"] == [("Chunk", "Entity")]
