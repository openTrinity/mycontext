"""Tests for community reification + the COMM_MEMBER projection (divergence E).

Covers:
- ``community_id_from`` is deterministic and namespaced by (node_type, level).
- ``insert_communities`` / ``get_community`` round-trip through SQLite.
- ``project_community_membership_edges`` derives one COMM_MEMBER edge per
  (node, level) assignment from the authoritative ``community_L0..L3`` columns,
  carries the level in ``properties``, and is idempotent (delete-and-rebuild).
- Summary reconciliation is best-effort: a malformed ``community_summaries``
  identity is skipped, never fatal to the projection.
- Zero assignments means zero membership edges (the rebuild replaces, never
  merges), with or without the ``community_L*`` columns present.
- The readers landed with the emission: ``COMM_MEMBER`` is in ``WALKABLE`` and
  ``community`` is a valid walk target, and ``kl_server._build_adjacency`` keys
  both ends of a COMM_MEMBER edge.
- LadybugDB can create the ``Community`` node table + ``COMM_MEMBER`` rel group
  (skipped when ladybug is absent).

Run: .venv/bin/python -m pytest tests/test_community_membership.py -q
"""

from __future__ import annotations

import json
import pathlib
import sqlite3
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from kl_graph.models.types import Community, EdgeType, community_id_from
from kl_graph.periodic.community_detection import (
    _summary_lookup,
    project_community_membership_edges,
)
from kl_graph.query import graph_walk as gw
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

# LadybugDB (Kuzu fork) has Cypher dialect incompatibilities: MERGE not supported,
# variable-length path queries produce empty results. These tests document the
# intended behavior but currently fail due to upstream dialect gaps.
xfail_ladybug_dialect = pytest.mark.xfail(
    reason="LadybugDB Cypher dialect incompatibility (MERGE, path queries)",
    strict=False,
)


def _store() -> SQLiteStore:
    """In-memory store on the real ``_create_tables`` schema."""
    conn = sqlite3.connect(":memory:")
    return SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]


def _seed_assignments(store: SQLiteStore) -> None:
    """Two entities + two facts with L0/L1 community assignments.

    Mimics what ``store_multi_resolution_communities`` leaves behind: the level
    columns added by ALTER TABLE, populated per level, with L2/L3 absent so the
    projection must tolerate partially-populated levels.
    """
    conn = store.conn
    for table in ("entities", "facts"):
        for level in ("L0", "L1"):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN community_{level} INTEGER")
    conn.executemany(
        "INSERT INTO entities (id, name, community_L0, community_L1) VALUES (?, ?, ?, ?)",
        [("e1", "Alice", 0, 3), ("e2", "Bob", 0, 4)],
    )
    conn.executemany(
        "INSERT INTO facts (id, text, source_chunk_id, community_L0, community_L1) "
        "VALUES (?, ?, ?, ?, ?)",
        [("f1", "a claim", "c1", 0, 3), ("f2", "another", "c1", 1, None)],
    )
    conn.commit()


# ── (a) deterministic + namespaced ids ───────────────────────────────────────


def test_community_id_from_is_deterministic() -> None:
    """The same triple always hashes to the same id."""
    assert community_id_from("entity", "L0", 3) == community_id_from("entity", "L0", 3)


def test_community_id_from_is_namespaced_by_node_type_and_level() -> None:
    """Entity/fact and L0/L1 clusters numbered alike are distinct communities."""
    ids = {
        community_id_from("entity", "L0", 3),
        community_id_from("fact", "L0", 3),
        community_id_from("entity", "L1", 3),
        community_id_from("entity", "L0", 4),
    }
    assert len(ids) == 4, ids


def test_community_id_from_normalizes_cluster_id_spelling() -> None:
    """int 3 and str "3" name the same cluster, so they map to one id."""
    assert community_id_from("entity", "L0", 3) == community_id_from(
        "entity", "L0", "3"
    )


# ── (b) communities table round-trip ─────────────────────────────────────────


def test_communities_table_schema() -> None:
    """The real store schema owns a ``communities`` table with the spec columns."""
    store = _store()
    cols = {r[1] for r in store.conn.execute("PRAGMA table_info(communities)")}
    assert cols == {"id", "level", "node_type", "summary", "tags", "member_count", "summary_stale"}
    store.close()


def test_insert_and_get_community_round_trip() -> None:
    """insert_communities/get_community preserve every field incl. tags."""
    store = _store()
    cid = community_id_from("entity", "L1", 7)
    store.insert_communities(
        [
            Community(
                id=cid,
                level="L1",
                node_type="entity",
                summary="sandbox security",
                tags=["security", "部署平台"],
                member_count=12,
            )
        ]
    )
    got = store.get_community(cid)
    assert got is not None
    assert got.level == "L1"
    assert got.node_type == "entity"
    assert got.summary == "sandbox security"
    assert got.tags == ["security", "部署平台"]
    assert got.member_count == 12
    assert store.get_community("missing") is None
    store.close()


def test_insert_communities_replaces_on_reclustering() -> None:
    """A second run with a new member_count overwrites the row (not ignored)."""
    store = _store()
    cid = community_id_from("fact", "L0", 1)
    store.insert_communities(
        [Community(id=cid, level="L0", node_type="fact", member_count=2)]
    )
    store.insert_communities(
        [Community(id=cid, level="L0", node_type="fact", member_count=9)]
    )
    got = store.get_community(cid)
    assert got is not None and got.member_count == 9
    store.close()


# ── (c) the COMM_MEMBER projection ───────────────────────────────────────────


def _comm_member_rows(store: SQLiteStore) -> list[tuple]:
    rows = store.conn.execute(
        "SELECT source_type, source_id, target_type, target_id, properties "
        "FROM edges WHERE edge_type = 'COMM_MEMBER' ORDER BY source_id, properties"
    ).fetchall()
    return [tuple(r) for r in rows]


def test_projection_emits_one_edge_per_node_level_assignment() -> None:
    """Every non-NULL (node, level) cell becomes exactly one COMM_MEMBER edge."""
    store = _store()
    _seed_assignments(store)
    n_communities, n_edges = project_community_membership_edges(store)

    # e1/e2/f1 have L0+L1; f2 has L0 only (its L1 is NULL) => 7 assignments.
    assert n_edges == 7
    rows = _comm_member_rows(store)
    assert len(rows) == 7
    for source_type, source_id, target_type, target_id, props in rows:
        assert source_type in ("entity", "fact")
        assert target_type == "community"
        level = json.loads(props)["level"]
        assert level in ("L0", "L1")
        assert target_id == community_id_from(
            source_type,
            level,
            store.conn.execute(
                f"SELECT community_{level} FROM "
                f"{'entities' if source_type == 'entity' else 'facts'} WHERE id = ?",
                (source_id,),
            ).fetchone()[0],
        )

    # Distinct communities: entity L0#0, entity L1#3, entity L1#4,
    # fact L0#0, fact L0#1, fact L1#3.
    assert n_communities == 6
    store.close()


def test_projection_upserts_community_rows_with_member_counts() -> None:
    """Community rows carry the level, node_type and the member count."""
    store = _store()
    _seed_assignments(store)
    project_community_membership_edges(store)

    ent_l0 = store.get_community(community_id_from("entity", "L0", 0))
    assert ent_l0 is not None
    assert ent_l0.level == "L0"
    assert ent_l0.node_type == "entity"
    assert ent_l0.member_count == 2  # e1 + e2

    fact_l0_1 = store.get_community(community_id_from("fact", "L0", 1))
    assert fact_l0_1 is not None and fact_l0_1.member_count == 1
    store.close()


def test_projection_reconciles_summary_and_tags_best_effort() -> None:
    """An existing community_summaries row enriches the projected Community."""
    store = _store()
    _seed_assignments(store)
    store.store_community_summaries(
        [
            {
                "level": "L1",
                "community_id": 3,
                "node_type": "entity",
                "member_count": 1,
                "summary": "sandbox work",
                "tags": json.dumps(["sandbox"]),
                "top_members": "[]",
            }
        ]
    )
    project_community_membership_edges(store)
    got = store.get_community(community_id_from("entity", "L1", 3))
    assert got is not None
    assert got.summary == "sandbox work"
    assert got.tags == ["sandbox"]
    store.close()


def test_projection_survives_malformed_summary_identity() -> None:
    """A summary row with a non-integer community_id is skipped, not fatal.

    Summaries are best-effort enrichment; the assignment columns are the
    authoritative membership source. A garbled identity must therefore not abort
    the Community upsert or the COMM_MEMBER rebuild.
    """
    store = _store()
    _seed_assignments(store)
    # SQLite columns are dynamically typed, so a bad writer/migration can land a
    # text community_id in an INTEGER column.
    store.conn.executemany(
        "INSERT INTO community_summaries "
        "(level, community_id, node_type, member_count, summary, tags, top_members) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            ("L1", "not-an-int", "entity", 1, "garbled", "[]", "[]"),
            ("L1", 3, "entity", 1, "sandbox work", json.dumps(["sandbox"]), "[]"),
        ],
    )
    store.conn.commit()

    n_communities, n_edges = project_community_membership_edges(store)

    # The projection still ran to completion off the columns.
    assert (n_communities, n_edges) == (6, 7)
    assert len(_comm_member_rows(store)) == 7
    # The well-formed sibling row still enriched its community.
    good = store.get_community(community_id_from("entity", "L1", 3))
    assert good is not None
    assert good.summary == "sandbox work"
    assert good.tags == ["sandbox"]
    # Nothing anywhere picked up the garbled row's summary.
    assert "garbled" not in {
        r[0] for r in store.conn.execute("SELECT summary FROM communities")
    }
    store.close()


def test_summary_lookup_skips_unusable_identities() -> None:
    """_summary_lookup drops rows whose (node_type, level, id) key can't be built."""

    class _FakeConn:
        """Returns rows a real DB could hold after a bad writer/migration."""

        def execute(self, sql: str):
            """Ignore the SQL and act as its own cursor."""
            assert "community_summaries" in sql
            return self

        def fetchall(self):
            """Two unusable identities, one text-but-numeric id, one bad tags blob."""
            return [
                ("entity", "L0", None, "null id", "[]"),  # TypeError on int(None)
                ("entity", "L0", "oops", "text id", "[]"),  # ValueError
                ("fact", "L1", "7", "numeric text id", '["ok"]'),  # usable
                ("fact", "L2", 2, "bad tags", "{not json"),  # tags fall back to []
            ]

    class _FakeStore:
        """Minimal stand-in exposing only the ``sql_conn`` the helper reads."""

        sql_conn = _FakeConn()

    got = _summary_lookup(_FakeStore())
    assert got == {
        ("fact", "L1", 7): ("numeric text id", ["ok"]),
        ("fact", "L2", 2): ("bad tags", []),
    }


def test_projection_is_idempotent_delete_and_rebuild() -> None:
    """Running twice yields the identical edge set (no duplicates, no growth)."""
    store = _store()
    _seed_assignments(store)
    project_community_membership_edges(store)
    first = _comm_member_rows(store)
    project_community_membership_edges(store)
    assert _comm_member_rows(store) == first
    store.close()


def test_projection_rebuild_drops_stale_memberships_only() -> None:
    """Re-clustering removes stale COMM_MEMBER rows and leaves other types alone."""
    from kl_graph.models.types import Edge

    store = _store()
    _seed_assignments(store)
    store.insert_edges(
        [
            Edge(
                source_type="fact",
                source_id="f1",
                target_type="entity",
                target_id="e1",
                edge_type=EdgeType.ABOUT,
            )
        ]
    )
    project_community_membership_edges(store)
    assert len(_comm_member_rows(store)) == 7

    # Re-cluster: e2 moves out of every level, f2 loses its L0 membership.
    store.conn.execute(
        "UPDATE entities SET community_L0 = NULL, community_L1 = NULL WHERE id = 'e2'"
    )
    store.conn.execute("UPDATE facts SET community_L0 = NULL WHERE id = 'f2'")
    store.conn.commit()
    project_community_membership_edges(store)

    rows = _comm_member_rows(store)
    assert len(rows) == 4  # e1 (L0,L1) + f1 (L0,L1)
    assert not any(r[1] in ("e2", "f2") for r in rows), rows
    # The unrelated ABOUT edge survived the scoped rebuild.
    assert store.count_edges_by_type().get("ABOUT") == 1
    store.close()


def test_projection_on_graph_without_community_columns_is_a_noop() -> None:
    """A freshly-ingested DB (no community_L* columns) projects nothing."""
    store = _store()
    assert project_community_membership_edges(store) == (0, 0)
    assert _comm_member_rows(store) == []
    store.close()


def _stale_comm_member_edge():
    """One leftover COMM_MEMBER edge from an earlier clustering run."""
    from kl_graph.models.types import Edge

    return Edge(
        source_type="entity",
        source_id="e1",
        target_type="community",
        target_id=community_id_from("entity", "L1", 99),
        edge_type=EdgeType.COMM_MEMBER,
        properties={"level": "L1"},
    )


def test_projection_with_columns_but_no_assignments_clears_the_projection() -> None:
    """All-NULL community_L* columns project (0, 0) and drop stale memberships.

    "No-op" means *no new projection*, not *leave the old one alone*: COMM_MEMBER
    is derived state, so zero assignments must mean zero membership edges (the
    rebuild is a replace, never a merge).
    """
    store = _store()
    _seed_assignments(store)
    store.conn.execute("UPDATE entities SET community_L0 = NULL, community_L1 = NULL")
    store.conn.execute("UPDATE facts SET community_L0 = NULL, community_L1 = NULL")
    store.conn.commit()
    store.insert_edges([_stale_comm_member_edge()])
    assert len(_comm_member_rows(store)) == 1

    assert project_community_membership_edges(store) == (0, 0)
    assert _comm_member_rows(store) == []
    store.close()


def test_projection_without_community_columns_still_clears_stale_edges() -> None:
    """Even with no community_L* columns at all, the rebuild removes stale rows."""
    store = _store()
    store.insert_edges([_stale_comm_member_edge()])
    assert len(_comm_member_rows(store)) == 1

    assert project_community_membership_edges(store) == (0, 0)
    assert _comm_member_rows(store) == []
    store.close()


# ── (d) readers: graph_walk ──────────────────────────────────────────────────


def test_comm_member_is_walkable() -> None:
    """COMM_MEMBER entered WALKABLE together with the edge emission."""
    assert EdgeType.COMM_MEMBER.value in gw.WALKABLE
    assert gw.WALKABLE == {e.value for e in EdgeType}


def test_community_is_a_valid_walk_target_and_source() -> None:
    """A walk leaves an entity onto its community and lands back on a member."""
    adj = {
        "e1": [("COMM_MEMBER", "c1", "community", "out")],
        "c1": [
            ("COMM_MEMBER", "e1", "entity", "in"),
            ("COMM_MEMBER", "f1", "fact", "in"),
        ],
        "f1": [("COMM_MEMBER", "c1", "community", "out")],
    }
    nodes, edges, _ = gw.graph_walk(
        adj, [("ent:e1", 1.0)], radius=2, lambda_=0.5, mini_threshold=0.0
    )
    ids = {n["id"] for n in nodes}
    assert "comm:c1" in ids, ("entity should hop onto its community", ids)
    assert "fact:f1" in ids, ("community should fan out to its members", ids)
    assert {e["type"] for e in edges} == {"COMM_MEMBER"}
    assert gw.node_type_of("comm:c1") == "community"
    assert gw.namespaced("c1", "community") == "comm:c1"


def test_community_fanout_is_capped_by_max_fanout() -> None:
    """max_fanout still bounds a large community→members expansion."""
    adj = {
        "e1": [("COMM_MEMBER", "c1", "community", "out")],
        "c1": [("COMM_MEMBER", f"m{i}", "fact", "in") for i in range(50)],
    }
    nodes, _, _ = gw.graph_walk(
        adj,
        [("ent:e1", 1.0)],
        radius=2,
        max_fanout=3,
        lambda_=0.5,
        mini_threshold=0.0,
    )
    members = [n for n in nodes if n["id"].startswith("fact:")]
    assert len(members) == 3, members


# ── (d) readers: kl_server adjacency ────────────────────────────────────────


def test_build_adjacency_indexes_community_endpoints_both_directions() -> None:
    """_build_adjacency keys the node AND the community for a COMM_MEMBER edge."""
    import kl_server

    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE edges (source_type TEXT, source_id TEXT, target_type TEXT, "
        "target_id TEXT, edge_type TEXT)"
    )
    conn.executemany(
        "INSERT INTO edges VALUES (?, ?, ?, ?, ?)",
        [
            ("entity", "E1", "community", "C1", "COMM_MEMBER"),
            ("fact", "F1", "community", "C1", "COMM_MEMBER"),
        ],
    )
    conn.commit()
    store = SQLiteStore(db_path=None, conn=conn)  # type: ignore[arg-type]

    adj = kl_server._build_adjacency(store)

    assert ("COMM_MEMBER", "C1", "community", "out") in adj["E1"]
    assert ("COMM_MEMBER", "C1", "community", "out") in adj["F1"]
    # The community is keyed and reaches both members (community -> members).
    assert "C1" in adj, sorted(adj)
    assert {(e[1], e[2]) for e in adj["C1"]} == {("E1", "entity"), ("F1", "fact")}
    # No endpoint is double-indexed by the entity + community branches.
    assert len(adj["E1"]) == 1, adj["E1"]

    # A walk over the built index reaches the community and the sibling fact.
    nodes, _, _ = gw.graph_walk(
        adj, [("ent:E1", 1.0)], radius=2, lambda_=0.5, mini_threshold=0.0
    )
    ids = {n["id"] for n in nodes}
    assert {"comm:C1", "fact:F1"} <= ids, ids
    conn.close()


# ── (e) LadybugDB Community node + COMM_MEMBER rel group ────────────────────


@skip_no_ladybug
@xfail_ladybug_dialect
def test_ladybug_community_node_and_comm_member_rel(tmp_path: pathlib.Path) -> None:
    """The Community node table + COMM_MEMBER rel group are creatable/writable."""
    from kl_graph.models.types import Edge, Entity
    from kl_graph.storage.base import create_store

    store = create_store(
        "ladybug",
        db_path=tmp_path / "test.db",
        ladybug_path=str(tmp_path / "graph.ladybug"),
    )
    cid = community_id_from("entity", "L1", 3)
    store.insert_communities(
        [Community(id=cid, level="L1", node_type="entity", summary="s", member_count=1)]
    )
    store.upsert_entities([Entity(id="e1", name="Alice")])
    store.insert_edges(
        [
            Edge(
                source_type="entity",
                source_id="e1",
                target_type="community",
                target_id=cid,
                edge_type=EdgeType.COMM_MEMBER,
                properties={"level": "L1"},
            )
        ]
    )
    # SQLite row (incl. tags) + graph node both exist.
    fetched = store.get_community(cid)
    assert fetched is not None and fetched.level == "L1"
    rows = store._graph.query("MATCH (c:Community) RETURN c.id AS id, c.level AS level")
    assert rows == [{"id": cid, "level": "L1"}]
    # The rel landed with its level property.
    rels = store._graph.query(
        "MATCH (:Entity)-[r:COMM_MEMBER]->(c:Community) RETURN r.level AS level"
    )
    assert [r["level"] for r in rels] == ["L1"]
    assert store.count_edges_by_type().get("COMM_MEMBER") == 1
    store.close()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
