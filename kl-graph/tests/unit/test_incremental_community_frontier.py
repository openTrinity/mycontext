"""Dependency-light test of incremental frontier membership updates."""

from __future__ import annotations

import sqlite3
import sys
from types import SimpleNamespace
from unittest.mock import patch

from kl_graph.ingest.strategies.community import DynamicFrontierLeiden
from kl_graph.storage.sqlite_store import SQLiteStore


class _GlobalGraph:
    def __init__(self, existing_index: int, new_index: int) -> None:
        self.existing_index = existing_index
        self.new_index = new_index

    def neighbors(self, index: int) -> list[int]:
        if index == self.existing_index:
            return [self.new_index]
        if index == self.new_index:
            return [self.existing_index]
        return []

    def induced_subgraph(self, indices: list[int]):
        assert indices == sorted((self.existing_index, self.new_index))
        return _FrontierGraph()


class _FrontierGraph:
    pass


def test_new_node_inherits_frontier_community_without_touching_isolate(tmp_path) -> None:
    store = SQLiteStore(tmp_path / "graph.db")
    try:
        store.sql_conn.execute(
            "ALTER TABLE entities ADD COLUMN community_L0 INTEGER"
        )
    except sqlite3.OperationalError:
        pass
    store.sql_conn.executemany(
        "INSERT INTO entities "
        "(id, name, entity_type, first_seen, last_seen, mention_count, description) "
        "VALUES (?, ?, 'Unknown', 0, 0, 1, '')",
        [
            ("existing", "Existing"),
            ("new", "New"),
            ("isolated", "Isolated"),
        ],
    )
    store.sql_conn.execute(
        "UPDATE entities SET community_L0 = 7 WHERE id = 'existing'"
    )
    store.sql_conn.execute(
        "UPDATE entities SET community_L0 = 99 WHERE id = 'isolated'"
    )
    store.sql_conn.commit()

    def _find_partition(graph, _partition_type, **kwargs):
        assert isinstance(graph, _FrontierGraph)
        assert kwargs["initial_membership"] == [0, 2]
        return SimpleNamespace(membership=[0, 0])

    fake_leiden = SimpleNamespace(
        RBConfigurationVertexPartition=object(),
        find_partition=_find_partition,
    )
    strategy = DynamicFrontierLeiden()

    def _build_graph(_store, _node_type, _all_ids, id_to_idx):
        return _GlobalGraph(id_to_idx["existing"], id_to_idx["new"])

    with (
        patch.object(strategy, "_build_graph", side_effect=_build_graph),
        patch.dict(sys.modules, {"leidenalg": fake_leiden}),
    ):
        strategy.assign_communities(
            store,
            ["new"],
            [],
            entity_resolutions={"L0": 0.3},
            fact_resolutions={},
        )

    rows = store.sql_conn.execute(
        "SELECT id, community_L0 FROM entities"
    ).fetchall()
    assignments = {row[0]: row[1] for row in rows}
    assert assignments == {"existing": 7, "new": 7, "isolated": 99}
    store.close()
