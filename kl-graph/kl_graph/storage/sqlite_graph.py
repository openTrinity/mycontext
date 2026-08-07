"""SQLite-backed graph path queries via BFS over the edges table."""

from __future__ import annotations

import json
import sqlite3
from collections import deque

from kl_graph.storage.graph_db import (
    GraphDB,
    Path,
    PathEdge,
    PathNode,
    PathResult,
)

# Default edge types to traverse for path queries (entity↔fact bipartite +
# entity↔entity similarity). These are broader than the graph_walk WALKABLE
# set because path queries should find *any* connection, not just the
# traversal-scored ones.
DEFAULT_PATH_EDGES = {"ABOUT", "ENTITY_SIMILAR", "FACT_SIMILAR"}


class SQLiteGraphDB(GraphDB):
    """Path queries via BFS over the SQLite edges table.

    This is the zero-dependency default. It shares the server's warm SQLite
    connection and uses the existing indexes (idx_edges_source, idx_edges_target).
    """

    def __init__(self, conn: sqlite3.Connection, **_: object) -> None:
        """Initialize with an open SQLite connection. Extra kwargs are ignored."""
        self.conn = conn

    def find_paths(
        self,
        source_id: str,
        target_id: str,
        *,
        max_hops: int = 4,
        all_shortest: bool = False,
        edge_types: list[str] | None = None,
        node_types: list[str] | None = None,
    ) -> PathResult:
        """Find shortest path(s) between source and target via BFS.

        Args:
            source_id: Bare entity/fact id of the start node.
            target_id: Bare entity/fact id of the end node.
            max_hops: Maximum path length (edges).
            all_shortest: If True, return all shortest paths; otherwise just one.
            edge_types: Edge types to traverse. None = DEFAULT_PATH_EDGES.
            node_types: Node types to traverse. None = ["entity", "fact"].

        Returns:
            PathResult with paths list (empty when no path found within max_hops).
        """
        if edge_types is None:
            edge_types = list(DEFAULT_PATH_EDGES)
        if node_types is None:
            node_types = ["entity", "fact"]

        paths = self._bfs_paths(
            source_id,
            target_id,
            max_hops=max_hops,
            all_shortest=all_shortest,
            edge_types=edge_types,
            node_types=node_types,
        )

        src_type = self._node_type(source_id)
        tgt_type = self._node_type(target_id)

        return PathResult(
            source=PathNode(id=source_id, node_type=src_type),
            target=PathNode(id=target_id, node_type=tgt_type),
            paths=paths,
            exhausted=len(paths) == 0,
        )

    def _bfs_paths(
        self,
        source_id: str,
        target_id: str,
        max_hops: int,
        all_shortest: bool,
        edge_types: list[str],
        node_types: list[str],
    ) -> list[Path]:
        """BFS shortest-path search over the edges table.

        Uses forward BFS. Returns all shortest paths when all_shortest=True,
        otherwise just the first found.
        """
        if source_id == target_id:
            node = PathNode(id=source_id, node_type=self._node_type(source_id))
            return [Path(nodes=[node], edges=[], hop_count=0)]

        # State: queue of (current_id, current_type, path_so_far)
        # path_so_far = list of (nbr_id, nbr_type, edge_type, direction, props)
        queue: deque[tuple[str, str, list[tuple]]] = deque()
        queue.append((source_id, self._node_type(source_id), []))
        visited: dict[str, int] = {source_id: 0}  # id -> shortest distance found
        found_paths: list[Path] = []
        found_distance: int | None = None

        edge_types_tuple = tuple(edge_types)

        while queue:
            current_id, current_type, trail = queue.popleft()
            current_distance = len(trail)

            # Stop early once we're beyond the found distance
            if found_distance is not None and current_distance >= found_distance:
                if not all_shortest:
                    break
                if current_distance > found_distance:
                    break

            if current_distance >= max_hops:
                continue

            nbrs = self._get_neighbors(current_id, current_type, edge_types_tuple, node_types)

            for nbr_id, nbr_type, etype, props, direction in nbrs:
                new_distance = current_distance + 1

                if nbr_id == target_id:
                    new_trail = trail + [(nbr_id, nbr_type, etype, direction, props)]
                    path = self._trail_to_path(source_id, new_trail)
                    found_paths.append(path)
                    found_distance = new_distance
                    if not all_shortest:
                        return found_paths
                    continue

                # Only enqueue if not already seen at a shorter distance.
                # For all_shortest we must allow re-visiting at the SAME distance
                # to discover alternate shortest paths through shared nodes.
                if nbr_id in visited:
                    threshold = visited[nbr_id]
                    if new_distance > threshold or (new_distance == threshold and not all_shortest):
                        continue
                visited[nbr_id] = new_distance
                queue.append((nbr_id, nbr_type, trail + [(nbr_id, nbr_type, etype, direction, props)]))

        return found_paths

    def _get_neighbors(
        self,
        node_id: str,
        node_type: str,
        edge_types: tuple[str, ...],
        node_types: list[str],
    ) -> list[tuple[str, str, str, dict, str]]:
        """Get all neighbors of a node (both directions).

        Returns list of (neighbor_id, neighbor_type, edge_type, properties, direction).
        """
        if not edge_types or not node_types:
            return []
        placeholders = ",".join("?" * len(edge_types))
        type_placeholders = ",".join("?" * len(node_types))
        results: list[tuple[str, str, str, dict, str]] = []

        # Outgoing edges (this node is source)
        rows = self.conn.execute(
            f"""
            SELECT target_id, target_type, edge_type, properties
            FROM edges
            WHERE source_id = ? AND source_type = ?
              AND edge_type IN ({placeholders})
              AND target_type IN ({type_placeholders})
            """,
            (node_id, node_type, *edge_types, *node_types),
        ).fetchall()
        for r in rows:
            props = json.loads(r[3]) if r[3] else {}
            results.append((r[0], r[1], r[2], props, "out"))

        # Incoming edges (this node is target)
        rows = self.conn.execute(
            f"""
            SELECT source_id, source_type, edge_type, properties
            FROM edges
            WHERE target_id = ? AND target_type = ?
              AND edge_type IN ({placeholders})
              AND source_type IN ({type_placeholders})
            """,
            (node_id, node_type, *edge_types, *node_types),
        ).fetchall()
        for r in rows:
            props = json.loads(r[3]) if r[3] else {}
            results.append((r[0], r[1], r[2], props, "in"))

        return results

    def _trail_to_path(self, source_id: str, trail: list[tuple]) -> Path:
        """Convert a BFS trail into a Path object."""
        src_type = self._node_type(source_id)
        nodes: list[PathNode] = [PathNode(id=source_id, node_type=src_type)]
        edges: list[PathEdge] = []

        prev_id = source_id
        for nbr_id, nbr_type, etype, direction, props in trail:
            nodes.append(PathNode(id=nbr_id, node_type=nbr_type))
            if direction == "out":
                edges.append(
                    PathEdge(
                        source_id=prev_id,
                        target_id=nbr_id,
                        edge_type=etype,
                        direction="out",
                        properties=props,
                    )
                )
            else:
                edges.append(
                    PathEdge(
                        source_id=nbr_id,
                        target_id=prev_id,
                        edge_type=etype,
                        direction="in",
                        properties=props,
                    )
                )
            prev_id = nbr_id

        return Path(nodes=nodes, edges=edges, hop_count=len(edges))

    def _node_type(self, node_id: str) -> str:
        """Determine whether an id belongs to entities or facts table."""
        row = self.conn.execute(
            "SELECT 1 FROM entities WHERE id = ?", (node_id,)
        ).fetchone()
        if row:
            return "entity"
        row = self.conn.execute(
            "SELECT 1 FROM facts WHERE id = ?", (node_id,)
        ).fetchone()
        if row:
            return "fact"
        return "unknown"

    def neighbors(
        self,
        node_id: str,
        node_type: str,
        *,
        edge_types: list[str] | None = None,
        direction: str = "both",
        limit: int = 50,
    ) -> list[tuple[str, str, str, dict]]:
        """Return immediate neighbors of a node.

        Args:
            node_id: The node's bare id.
            node_type: "entity" or "fact".
            edge_types: Edge types to include. None = DEFAULT_PATH_EDGES.
            direction: "out", "in", or "both".
            limit: Maximum number of neighbors to return.

        Returns:
            List of (neighbor_id, neighbor_type, edge_type, properties).
        """
        if edge_types is None:
            edge_types = list(DEFAULT_PATH_EDGES)
        placeholders = ",".join("?" * len(edge_types))
        results: list[tuple[str, str, str, dict]] = []

        if direction in ("out", "both"):
            rows = self.conn.execute(
                f"""
                SELECT target_id, target_type, edge_type, properties
                FROM edges
                WHERE source_id = ? AND source_type = ?
                  AND edge_type IN ({placeholders})
                LIMIT ?
                """,
                (node_id, node_type, *edge_types, limit),
            ).fetchall()
            for r in rows:
                props = json.loads(r[3]) if r[3] else {}
                results.append((r[0], r[1], r[2], props))

        if direction in ("in", "both"):
            rows = self.conn.execute(
                f"""
                SELECT source_id, source_type, edge_type, properties
                FROM edges
                WHERE target_id = ? AND target_type = ?
                  AND edge_type IN ({placeholders})
                LIMIT ?
                """,
                (node_id, node_type, *edge_types, limit),
            ).fetchall()
            for r in rows:
                props = json.loads(r[3]) if r[3] else {}
                results.append((r[0], r[1], r[2], props))

        return results[:limit]

    def close(self) -> None:
        """No-op: the server manages the SQLite connection lifecycle."""
