"""FalkorDB-backed graph path queries via GraphBLAS-accelerated Cypher.

EXPERIMENTAL — untested against real FalkorDB instances. Cypher dialect,
result parsing, and sync logic may need adjustment for production use.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from kl_graph.storage.graph_db import (
    GraphDB,
    Path,
    PathEdge,
    PathNode,
    PathResult,
)


class FalkorGraphDB(GraphDB):
    """Path queries via FalkorDB's GraphBLAS Cypher engine.

    FalkorDB uses sparse linear algebra (GraphBLAS) for graph traversal,
    making it extremely fast for path-finding workloads. Runs as a
    subprocess via falkordblite (pip install falkordblite).

    License: SSPL-1.0 (source-available, not OSI). Suitable for internal
    tools and OSS. For commercial apps, use LadybugDB (MIT) instead.
    """

    def __init__(
        self,
        graph_name: str = "kl_graph",
        host: str = "localhost",
        port: int = 6379,
        sync_from: sqlite3.Connection | None = None,
    ):
        try:
            from falkordb import FalkorDB as FalkorClient
        except ImportError:
            try:
                # falkordblite bundles its own embedded instance
                import falkordblite
                self.db = falkordblite.FalkorDB()
                self.graph = self.db.select_graph(graph_name)
                self._lite = True
            except ImportError:
                raise ImportError(
                    "FalkorDB not installed. Install with: pip install falkordblite\n"
                    "Or use the SQLite backend: KL_GRAPH_BACKEND=sqlite"
                )
        else:
            self.db = FalkorClient(host=host, port=port)
            self.graph = self.db.select_graph(graph_name)
            self._lite = False

        self._ensure_schema()
        if sync_from is not None:
            self.sync(sync_from)

    def _ensure_schema(self):
        """Create indexes for efficient lookups."""
        try:
            self.graph.query("CREATE INDEX FOR (e:Entity) ON (e.id)")
        except Exception:  # noqa: BLE001, S110
            pass
        try:
            self.graph.query("CREATE INDEX FOR (f:Fact) ON (f.id)")
        except Exception:  # noqa: BLE001, S110
            pass

    def sync(self, sqlite_conn: sqlite3.Connection):
        """Bulk-sync entities, facts, and edges from SQLite into FalkorDB.

        Uses Cypher MERGE for idempotent upsert. Batches operations for perf.
        """
        # Entities. ``description`` is read via COALESCE so the sync also works
        # against a DB written before the column existed.
        rows = sqlite_conn.execute(
            "SELECT id, name, entity_type, mention_count, "
            "COALESCE(description, '') FROM entities"
        ).fetchall()
        for eid, name, etype, mentions, description in rows:
            self.graph.query(
                "MERGE (e:Entity {id: $id}) "
                "SET e.name = $name, e.entity_type = $etype, e.mention_count = $mentions, "
                "e.description = $description",
                {
                    "id": eid,
                    "name": name or "",
                    "etype": etype or "",
                    "mentions": mentions or 0,
                    "description": description or "",
                },
            )

        # Facts
        rows = sqlite_conn.execute(
            "SELECT id, text, fact_type, confidence, timestamp FROM facts"
        ).fetchall()
        for fid, text, ftype, conf, ts in rows:
            self.graph.query(
                "MERGE (f:Fact {id: $id}) "
                "SET f.text = $text, f.fact_type = $ftype, f.confidence = $conf, f.timestamp = $ts",
                {"id": fid, "text": text or "", "ftype": ftype or "", "conf": conf or 0.8, "ts": ts or 0}
            )

        # Edges
        rows = sqlite_conn.execute("""
            SELECT source_type, source_id, target_type, target_id, edge_type, properties
            FROM edges
            WHERE edge_type IN ('ABOUT', 'ENTITY_SIMILAR', 'FACT_SIMILAR')
        """).fetchall()
        for stype, sid, ttype, tid, etype, props in rows:
            confidence = 0.0
            if props:
                p = json.loads(props)
                confidence = p.get("confidence", p.get("hybrid_score", 0.0))
            src_label = "Entity" if stype == "entity" else "Fact"
            tgt_label = "Entity" if ttype == "entity" else "Fact"
            try:
                self.graph.query(
                    f"MATCH (a:{src_label} {{id: $sid}}), (b:{tgt_label} {{id: $tid}}) "
                    f"MERGE (a)-[r:{etype}]->(b) SET r.confidence = $conf",
                    {"sid": sid, "tid": tid, "conf": confidence}
                )
            except Exception:  # noqa: BLE001, S110
                pass

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
        # FalkorDB supports shortestPath natively with Cypher
        rel_filter = ""
        if edge_types:
            rel_filter = ":" + "|".join(edge_types)

        if all_shortest:
            cypher = (
                f"MATCH (a {{id: $src}}), (b {{id: $tgt}}), "
                f"p = allShortestPaths((a)-[{rel_filter}*1..{max_hops}]-(b)) "
                f"RETURN [n IN nodes(p) | [n.id, labels(n)[0]]] AS nodes, "
                f"[r IN relationships(p) | [type(r), r.confidence]] AS rels"
            )
        else:
            cypher = (
                f"MATCH (a {{id: $src}}), (b {{id: $tgt}}), "
                f"p = shortestPath((a)-[{rel_filter}*1..{max_hops}]-(b)) "
                f"RETURN [n IN nodes(p) | [n.id, labels(n)[0]]] AS nodes, "
                f"[r IN relationships(p) | [type(r), r.confidence]] AS rels"
            )

        result = self.graph.query(cypher, {"src": source_id, "tgt": target_id})
        paths = self._parse_result(result)

        return PathResult(
            source=PathNode(id=source_id, node_type="entity"),
            target=PathNode(id=target_id, node_type="entity"),
            paths=paths,
            exhausted=len(paths) == 0,
        )

    def _parse_result(self, result) -> list[Path]:
        """Parse FalkorDB query result into Path objects."""
        paths = []
        for row in result.result_set:
            nodes_raw = row[0]  # [[id, label], ...]
            rels_raw = row[1]   # [[type, confidence], ...]
            nodes = []
            for nid, nlabel in nodes_raw:
                ntype = "entity" if nlabel == "Entity" else "fact"
                nodes.append(PathNode(id=nid, node_type=ntype))
            edges = []
            for i, (rtype, rconf) in enumerate(rels_raw):
                edges.append(PathEdge(
                    source_id=nodes[i].id if i < len(nodes) else "",
                    target_id=nodes[i + 1].id if i + 1 < len(nodes) else "",
                    edge_type=rtype,
                    direction="out",
                    properties={"confidence": rconf or 0.0},
                ))
            paths.append(Path(nodes=nodes, edges=edges, hop_count=len(edges)))
        return paths

    def neighbors(
        self,
        node_id: str,
        node_type: str,
        *,
        edge_types: list[str] | None = None,
        direction: str = "both",
        limit: int = 50,
    ) -> list[tuple[str, str, str, dict]]:
        dir_pattern = {
            "out": "(a)-[r]->(b)",
            "in": "(a)<-[r]-(b)",
            "both": "(a)-[r]-(b)",
        }.get(direction, "(a)-[r]-(b)")

        cypher = (
            f"MATCH {dir_pattern} WHERE a.id = $id "
            f"RETURN b.id, labels(b)[0], type(r), r.confidence LIMIT {limit}"
        )
        result = self.graph.query(cypher, {"id": node_id})
        neighbors = []
        for row in result.result_set:
            bid, blabel, rtype, rconf = row
            btype = "entity" if blabel == "Entity" else "fact"
            if edge_types and rtype not in edge_types:
                continue
            neighbors.append((bid, btype, rtype, {"confidence": rconf or 0.0}))
        return neighbors

    def query(self, cypher: str, params: dict | None = None) -> list[dict[str, Any]]:
        """Execute raw Cypher query against FalkorDB."""
        result = self.graph.query(cypher, params or {})
        if not result.result_set:
            return []
        headers = result.header
        return [dict(zip(headers, row)) for row in result.result_set]

    def insert_scopes(self, scopes: list) -> None:
        """Not implemented: FalkorDB has no Scope node table yet.

        Scope storage + ``PART_OF`` are implemented for the SQLite and LadybugDB
        backends. This stub exists so the gap fails loudly (rather than silently
        dropping scopes) if the experimental FalkorDB backend is wired into the
        ``KnowledgeStore`` path.

        Args:
            scopes: Scope instances that would be stored.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError("FalkorDB backend does not implement Scope storage")

    def get_scope(self, scope_id: str):
        """Not implemented: FalkorDB has no Scope node table yet.

        Args:
            scope_id: The scope id that would be looked up.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError("FalkorDB backend does not implement Scope storage")

    def insert_communities(self, communities: list) -> None:
        """Not implemented: FalkorDB has no Community node table yet.

        Reified communities + ``COMM_MEMBER`` are implemented for the SQLite and
        LadybugDB backends. This stub exists so the gap fails loudly (rather than
        silently dropping communities) if the experimental FalkorDB backend is
        wired into the ``KnowledgeStore`` path.

        Args:
            communities: Community instances that would be stored.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError(
            "FalkorDB backend does not implement Community storage"
        )

    def get_community(self, community_id: str):
        """Not implemented: FalkorDB has no Community node table yet.

        Args:
            community_id: The community id that would be looked up.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError(
            "FalkorDB backend does not implement Community storage"
        )

    def scan_edges_by_type(
        self,
        edge_types: list[str],
        *,
        source_type: str | None = None,
        target_type: str | None = None,
    ):
        """Not implemented: FalkorDB is not wired as a ``KnowledgeStore`` backend.

        The backend-agnostic edge-read primitive the periodic-improvement stages
        depend on is implemented for the SQLite and LadybugDB stores. This stub
        exists so the gap fails loudly rather than silently returning no edges if
        the experimental FalkorDB backend is ever wired into the
        ``KnowledgeStore`` path.

        Args:
            edge_types: Edge type names that would be scanned.
            source_type: Optional source node-type filter.
            target_type: Optional target node-type filter.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError(
            "FalkorDB backend does not implement scan_edges_by_type"
        )

    def close(self):
        if hasattr(self, "db") and self.db:
            try:
                self.db.close()
            except Exception:  # noqa: BLE001, S110
                pass
