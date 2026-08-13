"""Regression tests for stable-identity report resolution in global search (Task 4).

These target the silent-corruption path: a retained ``community_summaries`` row
must never be served for a different current community after the integer cluster
labels are renumbered. No network / LLM (we call ``_read_all_summaries`` directly).
"""

from __future__ import annotations

import sqlite3

from kl_graph.query.global_search import GlobalSearch


def _mk_acomplete():
    async def _stub(system: str, user: str) -> str:
        return "0"

    return _stub


def _base_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE community_summaries (
            level INTEGER NOT NULL,
            community_id INTEGER NOT NULL,
            member_count INTEGER NOT NULL,
            entity_count INTEGER NOT NULL DEFAULT 0,
            fact_count INTEGER NOT NULL DEFAULT 0,
            title TEXT NOT NULL DEFAULT '',
            summary TEXT NOT NULL DEFAULT '',
            rating REAL NOT NULL DEFAULT 0.0,
            rating_explanation TEXT NOT NULL DEFAULT '',
            findings TEXT NOT NULL DEFAULT '[]',
            tags TEXT NOT NULL DEFAULT '[]',
            top_members TEXT NOT NULL DEFAULT '[]',
            community_uuid TEXT,
            summary_stale INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (level, community_id)
        )
        """
    )
    return conn


def _insert_summary(conn, level, cid, summary, uuid=None, stale=0):
    conn.execute(
        """
        INSERT INTO community_summaries
            (level, community_id, member_count, title, summary, tags,
             community_uuid, summary_stale)
        VALUES (?, ?, ?, ?, ?, '[]', ?, ?)
        """,
        (level, cid, 10, f"T{cid}", summary, uuid, stale),
    )
    conn.commit()


def _add_identity_map(conn, rows):
    conn.execute(
        """
        CREATE TABLE community_identity_map (
            run_id TEXT NOT NULL, level INTEGER NOT NULL,
            cluster_id INTEGER NOT NULL, community_uuid TEXT NOT NULL,
            PRIMARY KEY (run_id, level, cluster_id)
        )
        """
    )
    conn.executemany(
        "INSERT INTO community_identity_map (run_id, level, cluster_id, community_uuid) VALUES (?,?,?,?)",
        rows,
    )
    conn.commit()


def test_legacy_db_without_new_columns_still_reads() -> None:
    # Backward compat: a community_summaries with neither community_uuid nor
    # summary_stale must still be read (old full-pipeline DB).
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE community_summaries (
            level INTEGER, community_id INTEGER, member_count INTEGER,
            title TEXT, summary TEXT, tags TEXT,
            PRIMARY KEY (level, community_id)
        )
        """
    )
    conn.execute(
        "INSERT INTO community_summaries VALUES (0, 0, 10, 'T', 'hello', '[]')"
    )
    conn.commit()
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    out = search._read_all_summaries([0])
    assert (0, 0) in out
    assert out[(0, 0)]["summary"] == "hello"


def test_stale_row_is_skipped() -> None:
    conn = _base_conn()
    _insert_summary(conn, 0, 0, "fresh", uuid="u0", stale=0)
    _insert_summary(conn, 0, 1, "stale-one", uuid="u1", stale=1)
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    out = search._read_all_summaries([0])
    assert (0, 0) in out
    assert (0, 1) not in out  # stale skipped


def test_misattributed_row_is_omitted_after_renumber() -> None:
    # A retained summary at (0, 5) was bound to uuid "old". After reclustering,
    # cluster 5 now resolves to a DIFFERENT uuid "new". The old row must NOT be
    # served for the renumbered cluster.
    conn = _base_conn()
    _insert_summary(conn, 0, 5, "old community text", uuid="old")
    _add_identity_map(conn, [("run-2", 0, 5, "new")])
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    out = search._read_all_summaries([0])
    assert (0, 5) not in out  # misattribution guard omits it


def test_matching_uuid_is_served() -> None:
    # Same (level, cid), and the stored uuid MATCHES current resolution -> serve.
    conn = _base_conn()
    _insert_summary(conn, 0, 5, "correct text", uuid="u5")
    _add_identity_map(conn, [("run-2", 0, 5, "u5")])
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    out = search._read_all_summaries([0])
    assert (0, 5) in out
    assert out[(0, 5)]["summary"] == "correct text"


def test_no_identity_map_falls_back_to_serving() -> None:
    # Without an identity map (older DB), the guard is a no-op: rows are served
    # (relies on stale flag + empty filter only).
    conn = _base_conn()
    _insert_summary(conn, 0, 5, "text", uuid="whatever")
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    out = search._read_all_summaries([0])
    assert (0, 5) in out


def test_obsolete_label_absent_from_latest_run_is_excluded() -> None:
    # A summary whose (level,cid) is NOT present in the latest identity run must
    # be excluded entirely (obsolete/renumbered-away), even if its stored uuid
    # would otherwise look valid.
    conn = _base_conn()
    _insert_summary(conn, 0, 5, "obsolete", uuid="u5")
    # Latest run only knows about (0, 6); (0, 5) is gone.
    _add_identity_map(conn, [("run-2", 0, 6, "u6")])
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    out = search._read_all_summaries([0])
    assert (0, 5) not in out


def test_uuidless_report_excluded_when_map_present() -> None:
    # After additive migration, a legacy row with community_uuid=NULL must be
    # excluded once a current identity map exists (cannot prove attribution).
    conn = _base_conn()
    _insert_summary(conn, 0, 5, "legacy", uuid=None)
    _add_identity_map(conn, [("run-2", 0, 5, "u5")])
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    out = search._read_all_summaries([0])
    assert (0, 5) not in out


def test_latest_run_only_scopes_resolution() -> None:
    # An older run mapping must NOT keep an obsolete label alive; only the
    # latest run's mapping counts.
    conn = _base_conn()
    _insert_summary(conn, 0, 5, "text", uuid="old")
    # run-1 mapped (0,5)->old ; run-2 (latest) remaps only (0,5)->new.
    _add_identity_map(
        conn,
        [("run-1", 0, 5, "old"), ("run-2", 0, 5, "new")],
    )
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    out = search._read_all_summaries([0])
    assert (0, 5) not in out  # stored 'old' != latest 'new'


def test_parent_child_traversal_uses_projection_tokens() -> None:
    # Hierarchy descent must work: reports bound to stable UUIDs still descend
    # via the communities table (projection-token domain).
    from kl_graph.models.types import community_id_from

    conn = _base_conn()
    # Two summaries: parent (0,0), child (1,0), both with stable uuids.
    _insert_summary(conn, 0, 0, "parent", uuid="pu")
    _insert_summary(conn, 1, 0, "child", uuid="cu")
    # communities table uses community_id_from tokens (unchanged projection).
    conn.execute(
        """
        CREATE TABLE communities (
            id TEXT PRIMARY KEY, level TEXT, node_type TEXT,
            member_count INTEGER, parent_id TEXT, parent_level INTEGER
        )
        """
    )
    parent_tok = community_id_from("L0", 0)
    child_tok = community_id_from("L1", 0)
    conn.execute(
        "INSERT INTO communities (id, level, node_type, member_count, parent_id) "
        "VALUES (?, 'L0', 'mixed', 10, NULL)", (parent_tok,)
    )
    conn.execute(
        "INSERT INTO communities (id, level, node_type, member_count, parent_id) "
        "VALUES (?, 'L1', 'mixed', 5, ?)", (child_tok, parent_tok)
    )
    conn.commit()
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    all_summaries = search._read_all_summaries([0, 1])
    token_to_key, parent_to_children = search._build_parent_links(all_summaries)
    # The parent token links to the child token -> descent is possible.
    assert parent_tok in parent_to_children
    assert child_tok in parent_to_children[parent_tok]
    assert token_to_key[child_tok] == (1, 0)


def test_empty_summary_still_skipped() -> None:
    conn = _base_conn()
    _insert_summary(conn, 0, 0, "   ", uuid="u0")
    search = GlobalSearch(conn=conn, acomplete=_mk_acomplete())
    out = search._read_all_summaries([0])
    assert (0, 0) not in out
