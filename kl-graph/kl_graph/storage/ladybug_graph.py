"""LadybugDB-backed graph path queries via native Cypher.

EXPERIMENTAL — LadybugDB is a Kuzu fork (v0.19.0, MIT license).
Uses variable-length path patterns with TRAIL semantics for shortest-path
queries (no shortestPath() function available in this Cypher dialect).
"""

from __future__ import annotations

import logging
import json
from collections.abc import Iterator
from pathlib import Path as FsPath
from typing import Any

from kl_graph.storage.graph_db import (
    GraphDB,
    Path,
    PathEdge,
    PathNode,
    PathResult,
)

logger = logging.getLogger(__name__)

# Edge types we traverse for path queries (matches SQLite backend)
DEFAULT_PATH_EDGES = ("ABOUT", "ENTITY_SIMILAR", "FACT_SIMILAR")

# Full edge type → (source_label, target_label) combinations.
# REL TABLE GROUP covers all permutations so any source/target label pair is insertable.
# Schema: ABOUT, ENTITY_SIMILAR, FACT_SIMILAR, MENTIONS, AUTHORED_BY, STATES,
# TEMPORAL, REPLY_TO, PART_OF, COMM_MEMBER
_REL_GROUP_DEFS: dict[str, list[tuple[str, str]]] = {
    "ABOUT": [
        ("Entity", "Fact"),
        ("Fact", "Entity"),
        ("Entity", "Entity"),
        ("Fact", "Fact"),
    ],
    "ENTITY_SIMILAR": [
        ("Entity", "Entity"),
    ],
    "FACT_SIMILAR": [
        ("Fact", "Fact"),
    ],
    "MENTIONS": [
        ("Chunk", "Entity"),
        ("Chunk", "Fact"),
    ],
    "AUTHORED_BY": [
        ("Chunk", "Entity"),
    ],
    "STATES": [
        ("Fact", "Chunk"),
    ],
    "TEMPORAL": [
        ("Chunk", "Chunk"),
    ],
    "REPLY_TO": [
        ("Chunk", "Chunk"),
    ],
    # Chunk → Scope membership. ``Chunk`` is the only content label — chat
    # chunks are ``Chunk`` nodes with ``source_type="message"``, not a separate
    # label.
    "PART_OF": [
        ("Chunk", "Scope"),
    ],
    # Community membership, the derived projection of the authoritative
    # ``community_L0..L3`` columns. One rel group for every level; the level
    # lives in the rel's ``level`` property (see ``_REL_GROUP_EXTRA_PROPS``) so
    # L0–L3 coexist on one edge type instead of four.
    "COMM_MEMBER": [
        ("Entity", "Community"),
        ("Fact", "Community"),
    ],
}

# Per-rel-group extra properties beyond the shared ``confidence`` column.
_REL_GROUP_EXTRA_PROPS: dict[str, str] = {
    "COMM_MEMBER": "level STRING",
}


def _type_to_label(node_type: str) -> str:
    """Convert a lower-case node_type string to a LadybugDB node label.

    Args:
        node_type: "entity", "fact", "chunk", "scope", or "community".

    Returns:
        Capitalised label ("Entity", "Fact", "Chunk", "Scope", "Community") for
        Cypher queries.
    """
    match node_type.lower():
        case "entity":
            return "Entity"
        case "fact":
            return "Fact"
        case "chunk":
            return "Chunk"
        case "scope":
            return "Scope"
        case "community":
            return "Community"
        case _:
            return "Entity"


def _label_to_type(label: str) -> str:
    """Convert a LadybugDB node label back to a lower-case node_type string.

    Args:
        label: Node label as returned by Cypher ``label(n)``.

    Returns:
        "entity" / "fact" / "scope" / "community", defaulting to "chunk" — the
        only content label, so an unlabeled/unknown content node reads as a chunk.
    """
    match label:
        case "Entity":
            return "entity"
        case "Fact":
            return "fact"
        case "Scope":
            return "scope"
        case "Community":
            return "community"
        case _:
            return "chunk"


def _merge_edge_props(props_json: str | None, confidence: float | None) -> dict:
    """Rebuild an edge-properties dict from the stored JSON + typed confidence.

    The full properties dict is persisted as a ``properties`` JSON string on
    every rel (see ``insert_edges``); ``confidence`` is also a typed column for
    path/neighbor reads. Prefer the JSON payload, but always surface a
    ``confidence`` key (falling back to the typed column) so callers that read
    ``props["confidence"]`` keep working even for edges written before the JSON
    column existed.
    """
    out: dict = {}
    if props_json:
        try:
            parsed = json.loads(props_json)
            if isinstance(parsed, dict):
                out = parsed
        except (TypeError, ValueError):
            out = {}
    if "confidence" not in out and confidence is not None:
        out["confidence"] = confidence
    return out


class LadybugGraphDB(GraphDB):
    """Path queries via LadybugDB's Cypher variable-length patterns.

    LadybugDB is an embedded C++ graph DB (Kuzu fork, MIT license) that
    supports Cypher with TRAIL path semantics for cycle-free traversal.
    It does NOT support shortestPath()/allShortestPaths() functions —
    instead we use ORDER BY length(p) LIMIT N on variable-length patterns.
    """

    def __init__(
        self,
        db_path: str,
        *,
        read_only: bool = False,
        buffer_pool_size: int = 0,
        max_num_threads: int = 0,
        **_: object,
    ):
        try:
            import ladybug
        except ImportError as exc:
            raise ImportError(
                "LadybugDB not installed. Install with: pip install ladybug\n"
                "Or use the SQLite backend: KL_GRAPH_BACKEND=sqlite"
            ) from exc
        self.db_path = db_path
        # LadybugDB creates the DB file itself — just ensure parent dir exists.
        FsPath(db_path).parent.mkdir(parents=True, exist_ok=True)
        db_opts: dict[str, object] = {}
        if buffer_pool_size:
            db_opts["buffer_pool_size"] = buffer_pool_size
        if max_num_threads:
            db_opts["max_num_threads"] = max_num_threads
        if read_only:
            db_opts["read_only"] = True
        self._db = self._open_database(ladybug, db_path, db_opts)
        self._conn = ladybug.Connection(self._db)
        self._ensure_schema()

    @staticmethod
    def _open_database(ladybug, db_path: str, db_opts: dict[str, object]):
        """Open the ladybug DB, recovering from an orphaned write-ahead log.

        A hard-killed or crashed build can leave a ``<db>.wal`` whose database id
        no longer matches a freshly (re)created ``<db>`` file. ladybug then
        refuses to open with a ``RuntimeError`` mentioning the temporary/WAL
        file, which would brick every subsequent build until someone deletes it
        by hand. Since the project rebuilds rather than migrates, an orphaned WAL
        carries no committed state we need: delete it and retry once.
        """
        try:
            return ladybug.Database(db_path, **db_opts)
        except RuntimeError as exc:
            msg = str(exc).lower()
            wal = FsPath(f"{db_path}.wal")
            stale_wal = (
                wal.exists()
                and ("does not match" in msg or ".wal" in msg
                     or "left behind" in msg or "temporary file" in msg
                     or "wal file" in msg or "checksum" in msg
                     or "corrupted" in msg)
            )
            if not stale_wal:
                raise
            logger.warning(
                "ladybug refused to open due to an orphaned WAL (%s); removing "
                "%s and retrying (rebuild-not-migrate, no committed state lost)",
                exc, wal,
            )
            wal.unlink()
            return ladybug.Database(db_path, **db_opts)

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    def _ensure_schema(self) -> None:
        """Create node tables and REL TABLE GROUPs for all edge types."""
        self._conn.execute("""
            CREATE NODE TABLE IF NOT EXISTS Entity(
                id STRING PRIMARY KEY,
                name STRING,
                entity_type STRING,
                mention_count INT64,
                description STRING
            )
        """)
        # A graph created before ``description`` existed keeps its old shape
        # (CREATE ... IF NOT EXISTS is a no-op), so add the column explicitly.
        # Rebuild remains the documented path; this only keeps an existing graph
        # writable instead of failing every entity upsert. Both spellings are
        # tried because ALTER ... ADD IF NOT EXISTS is dialect-dependent; when the
        # column is already present every variant fails harmlessly.
        for alter in (
            "ALTER TABLE Entity ADD IF NOT EXISTS description STRING",
            "ALTER TABLE Entity ADD description STRING",
        ):
            try:
                self._conn.execute(alter)
                break
            except Exception:  # noqa: BLE001, S112
                continue
        self._conn.execute("""
            CREATE NODE TABLE IF NOT EXISTS Fact(
                id STRING PRIMARY KEY,
                text STRING,
                fact_type STRING,
                confidence DOUBLE,
                timestamp INT64
            )
        """)
        # Light chunk node: the trace key plus the few properties a traversal
        # filters on. The ``content`` blob and its FTS index stay in SQLite and
        # are hydrated by id on demand. ``Chunk`` is the single content label —
        # a chat message is a Chunk with ``source_type="message"``.
        self._conn.execute("""
            CREATE NODE TABLE IF NOT EXISTS Chunk(
                id STRING PRIMARY KEY,
                source_type STRING,
                timestamp INT64,
                source_ref STRING
            )
        """)
        self._conn.execute("""
            CREATE NODE TABLE IF NOT EXISTS Scope(
                id STRING PRIMARY KEY,
                scope_type STRING,
                title STRING
            )
        """)
        # Reified community: the ``COMM_MEMBER`` endpoint. ``tags`` stays in
        # SQLite (list-valued); the graph keeps only what a traversal filters or
        # labels on.
        self._conn.execute("""
            CREATE NODE TABLE IF NOT EXISTS Community(
                id STRING PRIMARY KEY,
                level STRING,
                node_type STRING,
                summary STRING,
                member_count INT64
            )
        """)
        # Use REL TABLE GROUP so one edge type name covers multiple
        # source→target label combinations. Every rel group carries a
        # ``properties`` STRING holding the full edge-properties dict as JSON so
        # nothing is lost on the ladybug backend (graph-design.md: an edge
        # stores ``properties``). ``confidence`` (and any declared extra column,
        # e.g. COMM_MEMBER.level) is kept as a typed column too, because path
        # finding and ``get_neighbors`` read ``r.confidence`` directly.
        for rel_name, combos in _REL_GROUP_DEFS.items():
            from_to_clauses = ", ".join(f"FROM {src} TO {tgt}" for src, tgt in combos)
            extra = _REL_GROUP_EXTRA_PROPS.get(rel_name)
            props = "confidence DOUBLE DEFAULT 0.0, properties STRING DEFAULT ''" + (
                f", {extra}" if extra else ""
            )
            try:
                self._conn.execute(
                    f"CREATE REL TABLE GROUP IF NOT EXISTS {rel_name}"
                    f"({from_to_clauses}, {props})"
                )
            except Exception:  # noqa: BLE001, S110
                # May fail if schema already exists with different shape
                pass
            # A rel group created before ``properties`` existed keeps its old
            # shape (CREATE IF NOT EXISTS is a no-op), so add it explicitly.
            # Best-effort like the Entity.description backfill; harmless when the
            # column already exists. Rebuild remains the documented path.
            for alter in (
                f"ALTER TABLE {rel_name} ADD IF NOT EXISTS properties STRING",
                f"ALTER TABLE {rel_name} ADD properties STRING",
            ):
                try:
                    self._conn.execute(alter)
                    break
                except Exception:  # noqa: BLE001, S112
                    continue

    # ------------------------------------------------------------------
    # Path queries
    # ------------------------------------------------------------------

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
        """Find shortest path(s) using variable-length TRAIL pattern.

        Since LadybugDB doesn't support shortestPath(), we use:
            MATCH p = (a)-[*TRAIL 1..N]-(b) ... ORDER BY length(p) LIMIT K
        """
        if edge_types is None:
            edge_types = list(DEFAULT_PATH_EDGES)
        if not edge_types:
            return PathResult(
                source=PathNode(id=source_id, node_type=self._node_label(source_id)),
                target=PathNode(id=target_id, node_type=self._node_label(target_id)),
                paths=[],
                exhausted=True,
            )

        # Build edge type filter for pattern: [:ABOUT|ENTITY_SIMILAR|FACT_SIMILAR*TRAIL 1..N]
        rel_filter = ":" + "|".join(edge_types)

        # Use TRAIL to prevent repeated edges (ensures termination)
        # For "shortest", ORDER BY length + LIMIT 1
        # For "all shortest", fetch more and filter to min length in Python
        if all_shortest:
            # Fetch enough paths to cover all shortest — cap at 50 to bound work
            limit = 50
        else:
            limit = 1

        cypher = (
            f"MATCH p = (a {{id: $src}})-[{rel_filter}*TRAIL 1..{max_hops}]-(b {{id: $tgt}}) "
            f"RETURN nodes(p) AS ns, rels(p) AS rs, length(p) AS len "
            f"ORDER BY len LIMIT {limit}"
        )

        try:
            result = self._conn.execute(
                cypher, parameters={"src": source_id, "tgt": target_id}
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("LadybugDB path query failed: %s", exc)
            return PathResult(
                source=PathNode(id=source_id, node_type=self._node_label(source_id)),
                target=PathNode(id=target_id, node_type=self._node_label(target_id)),
                paths=[],
                exhausted=True,
            )

        paths = self._parse_paths(result, all_shortest=all_shortest)

        src_type = self._node_label(source_id)
        tgt_type = self._node_label(target_id)
        return PathResult(
            source=PathNode(id=source_id, node_type=src_type),
            target=PathNode(id=target_id, node_type=tgt_type),
            paths=paths,
            exhausted=len(paths) == 0,
        )

    def _parse_paths(self, result, *, all_shortest: bool) -> list[Path]:
        """Parse query result into Path objects.

        When all_shortest=True, filters to only paths with minimum length.
        """
        paths: list[Path] = []
        min_len: int | None = None

        while result.has_next():
            row = result.get_next()
            nodes_raw = row[0]  # list of node dicts
            rels_raw = row[1]  # list of rel dicts
            path_len = row[2]  # length(p)

            # For all_shortest: only keep paths at minimum length
            if all_shortest:
                if min_len is None:
                    min_len = path_len
                elif path_len > min_len:
                    break  # results are ordered by len, so we can stop

            nodes: list[PathNode] = []
            for n in nodes_raw:
                nid = n.get("id", "")
                nlabel = n.get("_LABEL", "")
                ntype = "entity" if nlabel == "Entity" else "fact"
                nodes.append(PathNode(id=nid, node_type=ntype))

            edges: list[PathEdge] = []
            for i, r in enumerate(rels_raw):
                src_id = nodes[i].id if i < len(nodes) else ""
                tgt_id = nodes[i + 1].id if i + 1 < len(nodes) else ""
                # _LABEL is the edge type name (ABOUT, ENTITY_SIMILAR, FACT_SIMILAR)
                etype = r.get("_LABEL", "UNKNOWN")
                edges.append(
                    PathEdge(
                        source_id=src_id,
                        target_id=tgt_id,
                        edge_type=etype,
                        direction="out",
                        properties={"confidence": r.get("confidence", 0.0)},
                    )
                )

            paths.append(Path(nodes=nodes, edges=edges, hop_count=len(edges)))

        return paths

    # ------------------------------------------------------------------
    # Neighbors
    # ------------------------------------------------------------------

    def neighbors(
        self,
        node_id: str,
        node_type: str,
        *,
        edge_types: list[str] | None = None,
        direction: str = "both",
        limit: int = 50,
    ) -> list[tuple[str, str, str, dict]]:
        """Return immediate neighbors of a node."""
        dir_pattern = {
            "out": "(a)-[r]->(b)",
            "in": "(a)<-[r]-(b)",
            "both": "(a)-[r]-(b)",
        }.get(direction, "(a)-[r]-(b)")

        cypher = (
            f"MATCH {dir_pattern} "
            f"WHERE a.id = $id "
            f"RETURN b.id AS bid, label(b) AS btype, r "
            f"LIMIT {limit}"
        )

        try:
            result = self._conn.execute(cypher, parameters={"id": node_id})
        except Exception as exc:  # noqa: BLE001
            logger.warning("LadybugDB neighbors query failed: %s", exc)
            return []

        neighbors: list[tuple[str, str, str, dict]] = []
        while result.has_next():
            row = result.get_next()
            bid = row[0]
            btype = "entity" if row[1] == "Entity" else "fact"
            rel_dict = row[2]  # full relationship dict with _LABEL, confidence, etc.
            etype = rel_dict.get("_LABEL", "UNKNOWN")
            conf = rel_dict.get("confidence", 0.0)

            # Apply edge type filter in Python (simpler than building dynamic Cypher)
            if edge_types and etype not in edge_types:
                continue
            neighbors.append((bid, btype, etype, {"confidence": conf}))

        return neighbors

    # ------------------------------------------------------------------
    # Raw query
    # ------------------------------------------------------------------

    def query(self, cypher: str, params: dict | None = None) -> list[dict[str, Any]]:
        """Execute raw Cypher query against LadybugDB."""
        result = self._conn.execute(cypher, parameters=params or {})
        col_names = result.get_column_names()
        rows: list[dict[str, Any]] = []
        while result.has_next():
            rows.append(dict(zip(col_names, result.get_next())))
        return rows

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _node_label(self, node_id: str) -> str:
        """Look up whether a node is Entity, Fact, Chunk, Scope or Community."""
        try:
            result = self._conn.execute(
                "MATCH (n {id: $id}) RETURN label(n) AS lbl",
                parameters={"id": node_id},
            )
            if result.has_next():
                lbl = result.get_next()[0]
                if lbl == "Entity":
                    return "entity"
                if lbl == "Fact":
                    return "fact"
                if lbl == "Chunk":
                    return "chunk"
                if lbl == "Scope":
                    return "scope"
                if lbl == "Community":
                    return "community"
        except Exception:  # noqa: BLE001, S110
            pass
        return "unknown"

    # ------------------------------------------------------------------
    # Node upserts (dual-write support for LadybugStore)
    # ------------------------------------------------------------------

    def upsert_entity_node(
        self,
        entity_id: str,
        name: str,
        entity_type: str,
        mention_count: int,
        description: str = "",
    ) -> None:
        """Upsert an Entity node stub for Cypher traversal.

        Args:
            entity_id: Unique entity id.
            name: Entity name.
            entity_type: Entity type string.
            mention_count: Current mention count.
            description: Accumulated short description (in-graph property: small
                by construction, like ``name``).
        """
        try:
            self._conn.execute(
                "MERGE (n:Entity {id: $id}) SET n.name = $name, n.entity_type = $et, "
                "n.mention_count = $mc, n.description = $description",
                parameters={
                    "id": entity_id,
                    "name": name,
                    "et": entity_type,
                    "mc": mention_count,
                    "description": description or "",
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("upsert_entity_node failed for %s: %s", entity_id, exc)

    def get_entity_node(self, entity_id: str) -> dict | None:
        """Read one Entity node's in-graph properties.

        Args:
            entity_id: Unique entity id.

        Returns:
            Dict with ``id``/``name``/``entity_type``/``mention_count``/
            ``description``, or None if the node is absent (or the read failed).
        """
        try:
            result = self._conn.execute(
                "MATCH (n:Entity {id: $id}) RETURN n.id, n.name, n.entity_type, "
                "n.mention_count, n.description",
                parameters={"id": entity_id},
            )
            if result.has_next():
                row = result.get_next()
                return {
                    "id": row[0],
                    "name": row[1],
                    "entity_type": row[2],
                    "mention_count": row[3] or 0,
                    "description": row[4] or "",
                }
        except Exception as exc:  # noqa: BLE001
            logger.warning("get_entity_node failed for %s: %s", entity_id, exc)
        return None

    def upsert_fact_node(
        self, fact_id: str, text: str, fact_type: str, confidence: float, timestamp: int
    ) -> None:
        """Upsert a Fact node stub for Cypher traversal.

        Args:
            fact_id: Unique fact id.
            text: Fact text.
            fact_type: Fact type string.
            confidence: Confidence score.
            timestamp: Creation timestamp.
        """
        try:
            self._conn.execute(
                "MERGE (n:Fact {id: $id}) SET n.text = $text, n.fact_type = $ft, n.confidence = $conf, n.timestamp = $ts",
                parameters={
                    "id": fact_id,
                    "text": text,
                    "ft": fact_type,
                    "conf": confidence,
                    "ts": timestamp,
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("upsert_fact_node failed for %s: %s", fact_id, exc)

    def upsert_chunk_node(
        self,
        chunk_id: str,
        source_type: str = "",
        timestamp: int = 0,
        source_ref: str = "",
    ) -> None:
        """Upsert a light Chunk node (no ``content`` blob) for edge connectivity.

        Only the properties a traversal filters on live in the graph; the full
        text and its FTS index stay in SQLite and are hydrated by id. ``Chunk``
        is the single content label, so this covers every source — chat included
        (``source_type="message"``).

        Args:
            chunk_id: Unique chunk id.
            source_type: Source discriminator ("message", "wiki", "mail", ...).
            timestamp: Unix-ms creation time.
            source_ref: Producer reference (file, url, sender).
        """
        try:
            self._conn.execute(
                "MERGE (n:Chunk {id: $id}) SET n.source_type = $st, "
                "n.timestamp = $ts, n.source_ref = $ref",
                parameters={
                    "id": chunk_id,
                    "st": source_type or "",
                    "ts": int(timestamp or 0),
                    "ref": source_ref or "",
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("upsert_chunk_node failed for %s: %s", chunk_id, exc)

    def upsert_scope_node(
        self, scope_id: str, scope_type: str = "", title: str = ""
    ) -> None:
        """Upsert a Scope node (the container chunks point at via ``PART_OF``).

        Args:
            scope_id: Deterministic scope id.
            scope_type: Scope kind ("conversation", "document", ...).
            title: Human-readable scope title.
        """
        try:
            self._conn.execute(
                "MERGE (n:Scope {id: $id}) SET n.scope_type = $st, n.title = $title",
                parameters={
                    "id": scope_id,
                    "st": scope_type or "",
                    "title": title or "",
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("upsert_scope_node failed for %s: %s", scope_id, exc)

    def upsert_community_node(
        self,
        community_id: str,
        level: str = "",
        node_type: str = "",
        summary: str = "",
        member_count: int = 0,
    ) -> None:
        """Upsert a Community node (the ``COMM_MEMBER`` target).

        ``tags`` is deliberately omitted: it is list-valued and lives in SQLite.

        Args:
            community_id: Deterministic community id.
            level: Resolution level ("L0".."L3").
            node_type: Which graph was clustered ("entity" / "fact").
            summary: LLM-written community summary (may be empty).
            member_count: Number of members at this level.
        """
        try:
            self._conn.execute(
                "MERGE (n:Community {id: $id}) SET n.level = $level, "
                "n.node_type = $nt, n.summary = $summary, n.member_count = $mc",
                parameters={
                    "id": community_id,
                    "level": level or "",
                    "nt": node_type or "",
                    "summary": summary or "",
                    "mc": int(member_count or 0),
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "upsert_community_node failed for %s: %s", community_id, exc
            )

    # ------------------------------------------------------------------
    # Edge CRUD
    # ------------------------------------------------------------------

    def insert_edges(
        self,
        source_type: str,
        source_id: str,
        target_type: str,
        target_id: str,
        edge_type: str,
        properties: dict | None = None,
    ) -> None:
        """Insert a single edge into LadybugDB.

        Args:
            source_type: Source node type ("entity", "fact", "chunk").
            source_id: Source node id.
            target_type: Target node type.
            target_id: Target node id.
            edge_type: Edge type (e.g. "ABOUT", "MENTIONS").
            properties: Optional edge properties dict.
        """
        src_label = _type_to_label(source_type)
        tgt_label = _type_to_label(target_type)
        confidence = 0.0
        if properties:
            confidence = float(
                properties.get("confidence", properties.get("hybrid_score", 0.0))
            )
        params: dict[str, Any] = {
            "src": source_id,
            "tgt": target_id,
            "conf": confidence,
            # Full properties dict as JSON so nothing is lost on the ladybug
            # backend (weights/flags like hybrid_score, score, source that the
            # periodic stages read back). Empty string when there are none.
            "props": json.dumps(properties, ensure_ascii=False) if properties else "",
        }
        prop_clauses = ["confidence: $conf", "properties: $props"]
        # Edge types with a declared extra column (COMM_MEMBER.level) carry it
        # through from the SQLite-side ``properties`` dict so the graph rel and
        # the SQLite row agree on which level a membership belongs to.
        for extra in _REL_GROUP_EXTRA_PROPS.get(edge_type, "").split(","):
            key = extra.strip().split(" ")[0]
            if not key:
                continue
            prop_clauses.append(f"{key}: ${key}")
            params[key] = (properties or {}).get(key, "")
        prop_map = ", ".join(prop_clauses)
        try:
            self._conn.execute(
                f"MATCH (a:{src_label} {{id: $src}}), (b:{tgt_label} {{id: $tgt}}) "
                f"CREATE (a)-[:{edge_type} {{{prop_map}}}]->(b)",
                parameters=params,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "insert_edges failed for %s -[%s]-> %s: %s",
                source_id,
                edge_type,
                target_id,
                exc,
            )

    def delete_edges(
        self,
        *,
        source_id: str | None = None,
        target_id: str | None = None,
        edge_type: str | None = None,
        where_properties: dict | None = None,
    ) -> int:
        """Delete edges from LadybugDB matching filters. At least one filter required.

        Args:
            source_id: Filter by source node id.
            target_id: Filter by target node id.
            edge_type: Filter by relationship type name.
            where_properties: Filter on the stored ``properties`` JSON, matched
                key-by-key against the persisted dict (e.g.
                ``{"source": "disambiguation"}``). Applied in Python since the
                dict is a JSON string column.

        Returns:
            Approximate number of edges deleted (based on Cypher execution).
        """
        if (
            source_id is None
            and target_id is None
            and edge_type is None
            and where_properties is None
        ):
            raise ValueError("At least one filter must be specified for delete_edges()")

        rel_pattern = f"[r:{edge_type}]" if edge_type else "[r]"
        where_parts: list[str] = []
        params: dict = {}
        if source_id is not None:
            where_parts.append("a.id = $src_id")
            params["src_id"] = source_id
        if target_id is not None:
            where_parts.append("b.id = $tgt_id")
            params["tgt_id"] = target_id

        # A property filter can't be expressed against a JSON string column in
        # Cypher, so resolve the matching (src,tgt) pairs in Python first, then
        # delete them by endpoint id. Without this the ladybug backend could not
        # honour disambiguation's delete-by-source, silently keeping stale edges.
        if where_properties is not None:
            pairs = [
                (aid, bid)
                for aid, bid, props in self.scan_edges_typed(
                    [edge_type] if edge_type else list(_REL_GROUP_DEFS)
                )
                if all(props.get(k) == v for k, v in where_properties.items())
            ]
            deleted = 0
            for aid, bid in pairs:
                deleted += self.delete_edges(
                    source_id=aid, target_id=bid, edge_type=edge_type
                )
            return deleted

        where_clause = " AND ".join(where_parts)
        where_str = f" WHERE {where_clause}" if where_clause else ""

        cypher = f"MATCH (a)-{rel_pattern}->(b){where_str} DELETE r"
        try:
            self._conn.execute(cypher, parameters=params)
            # LadybugDB doesn't expose rowcount; approximate from a count query would be expensive
            return 0
        except Exception as exc:  # noqa: BLE001
            logger.warning("delete_edges failed: %s", exc)
            return 0

    def count_edges(self) -> int:
        """Return total number of edges in LadybugDB.

        Returns:
            Total edge count.
        """
        try:
            result = self._conn.execute("MATCH ()-[r]->() RETURN count(r) AS cnt")
            if result.has_next():
                return int(result.get_next()[0])
        except Exception as exc:  # noqa: BLE001
            logger.warning("count_edges failed: %s", exc)
        return 0

    def count_edges_by_type(self) -> dict[str, int]:
        """Return edge counts grouped by type.

        Returns:
            Dict mapping edge type to count.
        """
        counts: dict[str, int] = {}
        for rel_name in _REL_GROUP_DEFS:
            try:
                result = self._conn.execute(
                    f"MATCH ()-[r:{rel_name}]->() RETURN count(r) AS cnt"
                )
                if result.has_next():
                    cnt = int(result.get_next()[0])
                    if cnt > 0:
                        counts[rel_name] = cnt
            except Exception:  # noqa: BLE001, S110
                pass
        return counts

    def get_neighbors(
        self,
        node_id: str,
        node_type: str,
        *,
        edge_types: list[str] | None = None,
        direction: str = "both",
        limit: int = 50,
    ) -> list[tuple[str, str, str, dict]]:
        """Return immediate neighbors of a node with edge type info.

        Args:
            node_id: The node's id.
            node_type: Node type ("entity", "fact", "chunk").
            edge_types: Edge types to include. None = all types.
            direction: "out", "in", or "both".
            limit: Maximum neighbors to return.

        Returns:
            List of (neighbor_id, neighbor_type, edge_type, properties).
        """
        node_label = _type_to_label(node_type)
        # Build relationship pattern — push edge_types into Cypher to avoid
        # scanning all edges and filtering in Python (significant for dense nodes).
        if edge_types:
            rel_filter = ":" + "|".join(edge_types)
        else:
            rel_filter = ""
        dir_pattern = {
            "out": f"(a)-[r{rel_filter}]->(b)",
            "in": f"(a)<-[r{rel_filter}]-(b)",
            "both": f"(a)-[r{rel_filter}]-(b)",
        }.get(direction, f"(a)-[r{rel_filter}]-(b)")

        cypher = (
            f"MATCH {dir_pattern} "
            f"WHERE a.id = $id AND label(a) = '{node_label}' "
            f"RETURN b.id AS bid, label(b) AS btype, label(r) AS etype, "
            f"r.confidence AS conf, r.properties AS props "
            f"LIMIT {limit}"
        )

        try:
            result = self._conn.execute(cypher, parameters={"id": node_id})
        except Exception as exc:  # noqa: BLE001
            logger.warning("LadybugDB get_neighbors failed: %s", exc)
            return []

        neighbors: list[tuple[str, str, str, dict]] = []
        while result.has_next():
            row = result.get_next()
            bid, btype_raw, etype, conf, props = (
                row[0], row[1], row[2], row[3], row[4],
            )
            if btype_raw is None:
                continue
            btype = _label_to_type(btype_raw)
            neighbors.append(
                (bid, btype, etype or "UNKNOWN", _merge_edge_props(props, conf))
            )

        return neighbors

    def scan_edges(self) -> Iterator[tuple[str, str, str, str, str]]:
        """Scan all edges for adjacency index build.

        Yields:
            Tuples of (source_type, source_id, target_type, target_id, edge_type).
        """
        try:
            result = self._conn.execute(
                "MATCH (a)-[r]->(b) RETURN label(a) AS albl, a.id AS aid, "
                "label(b) AS blbl, b.id AS bid, label(r) AS etype"
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("LadybugDB scan_edges failed: %s", exc)
            return
        while result.has_next():
            row = result.get_next()
            albl, aid, blbl, bid, etype = row[0], row[1], row[2], row[3], row[4]
            if not (albl and aid and blbl and bid and etype):
                continue
            src_type = _label_to_type(albl)
            tgt_type = _label_to_type(blbl)
            yield (src_type, aid, tgt_type, bid, etype)

    def scan_edges_typed(
        self,
        edge_types: list[str],
        *,
        source_type: str | None = None,
        target_type: str | None = None,
    ) -> Iterator[tuple[str, str, dict]]:
        """Stream ``(source_id, target_id, properties)`` for the given edge types.

        Backend-agnostic edge-read primitive for the periodic stages: they need
        the endpoint ids plus the full properties dict (weights/flags) to build
        projection graphs, and must not touch the SQLite ``edges`` table (empty
        on this backend). One rel type per query keeps the Cypher label-bound.

        Args:
            edge_types: Edge type names to scan (e.g. ``["MENTIONS",
                "AUTHORED_BY"]``).
            source_type: If set, restrict to this source node type.
            target_type: If set, restrict to this target node type.

        Yields:
            ``(source_id, target_id, properties_dict)`` per matching edge.
        """
        src_lbl = _type_to_label(source_type) if source_type else None
        tgt_lbl = _type_to_label(target_type) if target_type else None
        for etype in edge_types:
            conds = []
            if src_lbl:
                conds.append(f"label(a) = '{src_lbl}'")
            if tgt_lbl:
                conds.append(f"label(b) = '{tgt_lbl}'")
            where = f" WHERE {' AND '.join(conds)}" if conds else ""
            cypher = (
                f"MATCH (a)-[r:{etype}]->(b){where} "
                f"RETURN a.id AS aid, b.id AS bid, r.confidence AS conf, "
                f"r.properties AS props"
            )
            try:
                result = self._conn.execute(cypher)
            except Exception as exc:  # noqa: BLE001
                logger.warning("LadybugDB scan_edges_typed(%s) failed: %s", etype, exc)
                continue
            while result.has_next():
                aid, bid, conf, props = result.get_next()
                if not (aid and bid):
                    continue
                yield (aid, bid, _merge_edge_props(props, conf))

    def scan_edges_for_nodes(
        self,
        edge_types: list[str],
        node_ids: set[str],
        *,
        source_type: str | None = None,
        target_type: str | None = None,
    ) -> Iterator[tuple[str, str, dict]]:
        """Stream ``(source_id, target_id, properties)`` for edges touching ``node_ids``.

        Delegates to :meth:`scan_edges_typed` and filters in Python, since
        Kuzu's Cypher dialect does not reliably support ``IN``-list filtering
        on node properties. This is O(E) per edge type on the LadybugDB
        backend, but the frontier optimization still wins by not loading all
        node IDs and using the StructuralCache for co-mention computation.

        TODO: optimize with a Cypher ``WHERE a.id IN $ids OR b.id IN $ids``
        parameterised query when Kuzu adds list-parameter binding support.
        """
        for src, tgt, props in self.scan_edges_typed(
            edge_types, source_type=source_type, target_type=target_type
        ):
            if src in node_ids or tgt in node_ids:
                yield (src, tgt, props)

    def close(self) -> None:
        """Close connection and database."""
        if hasattr(self, "_conn") and self._conn and not self._conn.is_closed:
            self._conn.close()
        if hasattr(self, "_db") and self._db and not self._db.is_closed:
            self._db.close()
