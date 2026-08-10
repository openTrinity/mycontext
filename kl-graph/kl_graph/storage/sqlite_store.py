"""SQLite storage backend for chunks, entities, facts, and edges."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
from collections import deque
from collections.abc import Iterator
from pathlib import Path as FsPath

from kl_graph.models.types import (
    Chunk,
    ChunkUnit,
    Community,
    Edge,
    Entity,
    EntityType,
    Fact,
    FactType,
    Scope,
    SourceUnit,
)
from kl_graph.storage.base import KnowledgeStore
from kl_graph.storage.graph_db import Path, PathEdge, PathNode, PathResult

logger = logging.getLogger(__name__)

# Default edge types to traverse for BFS path queries (entity↔fact bipartite +
# entity↔entity similarity). Mirrors sqlite_graph.DEFAULT_PATH_EDGES.
DEFAULT_PATH_EDGES = {"ABOUT", "ENTITY_SIMILAR", "FACT_SIMILAR"}

# Entity keyword index (FTS5 over name + description). The Qdrant entity vector
# stays name-only, so accumulated descriptions become searchable here instead of
# forcing a re-embed — the same dense-name / sparse-description split RAGFlow
# uses. Chinese is pre-segmented with jieba (mirrors kl_graph/query/fts.py)
# because FTS5's unicode61 tokenizer treats an unsegmented CJK run as one token.
_ENTITIES_FTS = "entities_fts"

# Characters FTS5 parses as MATCH operators; stripped from user queries.
_FTS_SPECIAL = re.compile(r'["*():^~\-]+')
# A usable token needs at least one word character (Unicode-aware, so CJK counts).
_HAS_WORD = re.compile(r"\w", re.UNICODE)


def _segment(text: str) -> str:
    """jieba word-segmentation → space-joined tokens for FTS5.

    Imported lazily (and degrading to the raw text) so the store still works
    where jieba is unavailable; ASCII terms remain matchable either way.

    Args:
        text: Raw text to segment.

    Returns:
        Space-joined tokens, or the stripped raw text if jieba is missing.
    """
    try:
        import jieba
    except Exception:  # noqa: BLE001 - jieba is optional for this index
        return (text or "").strip()
    return " ".join(jieba.cut(text or ""))


class SQLiteStore(KnowledgeStore):
    """Synchronous SQLite storage for the knowledge graph.

    All data (nodes, edges, content, graph traversal) lives in a single SQLite
    database. BFS path-finding (previously in sqlite_graph.py) is absorbed into
    this class. The ``sql_conn`` property returns ``self.conn`` directly.
    """

    @property
    def sql_conn(self) -> sqlite3.Connection:
        """Escape hatch: returns this thread's connection directly."""
        return self.conn

    @property
    def conn(self) -> sqlite3.Connection:
        """Return the SQLite connection bound to the calling thread.

        A single ``sqlite3.Connection`` is not safe to use concurrently from
        multiple threads (the server offloads queries with
        ``asyncio.to_thread``). For a reproducible file path each thread lazily
        opens its own WAL-tuned connection (WAL allows many concurrent readers,
        removing the cross-thread cursor race). For a non-reopenable database
        (``:memory:`` or an injected connection with no usable path, as in
        tests) we fall back to sharing the injected connection.
        """
        existing = getattr(self._local, "conn", None)
        if existing is not None:
            return existing
        if self._reopenable:
            conn = self._open_connection()
            self._local.conn = conn
            self._connections.append(conn)
            return conn
        # Non-reopenable (:memory: / no path): share the injected connection.
        return self._shared_conn

    def _open_connection(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA cache_size=-64000")  # 64MB cache
        conn.execute("PRAGMA mmap_size=100000000")  # 100MB mmap
        return conn

    @staticmethod
    def _is_reopenable(db_path: FsPath | None) -> bool:
        if db_path is None:
            return False
        return str(db_path) not in (":memory:", "", "None")

    def __init__(self, db_path: FsPath, conn: sqlite3.Connection | None = None):
        self.db_path = db_path
        # Per-thread connection storage: each thread gets its own handle so the
        # server's asyncio.to_thread workers never share one cursor.
        self._local = threading.local()
        self._connections: list[sqlite3.Connection] = []
        self._reopenable = self._is_reopenable(db_path)
        self._shared_conn: sqlite3.Connection | None = None
        if conn is not None:
            # The server injects its warm, WAL-tuned connection. Bind it to the
            # calling (main) thread; for a reopenable path other threads open
            # their own lazily, otherwise they share this one.
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
            self._shared_conn = conn
            self._connections.append(conn)
            self._create_tables()
            return
        # No injected connection: open one for this thread and init schema.
        self._create_tables()

    def _create_tables(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                content_hash TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL DEFAULT 'message',
                timestamp INTEGER NOT NULL DEFAULT 0,
                source_ref TEXT,
                embedding_id TEXT,
                metadata TEXT
            );

            CREATE TABLE IF NOT EXISTS scopes (
                id TEXT PRIMARY KEY,
                scope_type TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                metadata TEXT
            );

            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                entity_type TEXT DEFAULT 'Unknown',
                first_seen INTEGER DEFAULT 0,
                last_seen INTEGER DEFAULT 0,
                mention_count INTEGER DEFAULT 1,
                embedding_id TEXT,
                description TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS facts (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                fact_type TEXT DEFAULT 'GENERAL',
                timestamp INTEGER DEFAULT 0,
                confidence REAL DEFAULT 0.8,
                source_chunk_id TEXT NOT NULL,
                embedding_id TEXT,
                FOREIGN KEY (source_chunk_id) REFERENCES chunks(id)
            );

            CREATE TABLE IF NOT EXISTS edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                target_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                edge_type TEXT NOT NULL,
                properties TEXT,
                UNIQUE(source_type, source_id, target_type, target_id, edge_type)
            );

            CREATE TABLE IF NOT EXISTS community_summaries (
                level INTEGER NOT NULL,
                community_id INTEGER NOT NULL,
                member_count INTEGER NOT NULL,
                entity_count INTEGER NOT NULL,
                fact_count INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                rating REAL NOT NULL DEFAULT 0.0,
                rating_explanation TEXT NOT NULL DEFAULT '',
                findings TEXT NOT NULL DEFAULT '[]',
                tags TEXT NOT NULL DEFAULT '[]',
                top_members TEXT NOT NULL DEFAULT '[]',
                PRIMARY KEY (level, community_id)
            );

            CREATE TABLE IF NOT EXISTS communities (
                id TEXT PRIMARY KEY,
                level TEXT NOT NULL DEFAULT '',
                node_type TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                member_count INTEGER NOT NULL DEFAULT 0,
                parent_id TEXT,
                parent_level INTEGER
            );

            CREATE TABLE IF NOT EXISTS ingest_meta (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS sources (
                source_id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS units (
                source_id TEXT NOT NULL,
                source_type TEXT NOT NULL,
                unit_id TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                timestamp INTEGER,
                metadata TEXT,
                processed_at INTEGER NOT NULL,
                PRIMARY KEY (source_id, source_type, unit_id),
                FOREIGN KEY (source_id) REFERENCES sources(source_id)
            );

            CREATE TABLE IF NOT EXISTS chunk_units (
                chunk_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                source_type TEXT NOT NULL,
                unit_id TEXT NOT NULL,
                unit_ordinal_in_chunk INTEGER NOT NULL,
                chunk_ordinal_in_unit INTEGER NOT NULL,
                start_offset INTEGER,
                end_offset INTEGER,
                PRIMARY KEY (chunk_id, source_id, source_type, unit_id),
                FOREIGN KEY (chunk_id) REFERENCES chunks(id),
                FOREIGN KEY (source_id, source_type, unit_id)
                    REFERENCES units(source_id, source_type, unit_id),
                UNIQUE (chunk_id, unit_ordinal_in_chunk),
                UNIQUE (source_id, source_type, unit_id, chunk_ordinal_in_unit)
            );

            CREATE TABLE IF NOT EXISTS ingest_batches (
                batch_id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                state TEXT NOT NULL,
                unit_count INTEGER NOT NULL DEFAULT 0,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ingest_batch_chunks (
                batch_id TEXT NOT NULL,
                chunk_id TEXT NOT NULL,
                chunk_ordinal INTEGER NOT NULL,
                PRIMARY KEY (batch_id, chunk_id),
                UNIQUE (batch_id, chunk_ordinal),
                FOREIGN KEY (batch_id) REFERENCES ingest_batches(batch_id),
                FOREIGN KEY (chunk_id) REFERENCES chunks(id)
            );

            CREATE TABLE IF NOT EXISTS ingest_runs (
                run_id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                input_dir TEXT NOT NULL,
                state TEXT NOT NULL,
                phase TEXT,
                percent REAL NOT NULL DEFAULT 0,
                detail TEXT NOT NULL DEFAULT '',
                units_discovered INTEGER NOT NULL DEFAULT 0,
                units_skipped INTEGER NOT NULL DEFAULT 0,
                units_processed INTEGER NOT NULL DEFAULT 0,
                chunks_created INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                started_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_source_type ON chunks(source_type, timestamp);
            CREATE INDEX IF NOT EXISTS idx_chunks_ts ON chunks(timestamp);
            CREATE INDEX IF NOT EXISTS idx_scopes_type ON scopes(scope_type);
            CREATE INDEX IF NOT EXISTS idx_communities_level ON communities(node_type, level);
            CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_type, source_id, edge_type);
            CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_type, target_id, edge_type);
            CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
            CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(fact_type, timestamp);
            CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_chunk_id);
            CREATE INDEX IF NOT EXISTS idx_facts_confidence ON facts(confidence);
            CREATE INDEX IF NOT EXISTS idx_units_source ON units(source_id, source_type);
            CREATE INDEX IF NOT EXISTS idx_chunk_units_unit
                ON chunk_units(source_id, source_type, unit_id);
            CREATE INDEX IF NOT EXISTS idx_ingest_runs_updated ON ingest_runs(updated_at);
        """)
        self._ensure_entity_columns()
        self._ensure_chunk_columns()
        self._ensure_ingest_run_columns()
        self._ensure_community_columns()
        self._ensure_entities_fts()
        self.conn.commit()

    def _ensure_entity_columns(self) -> None:
        """Add entity columns missing from a pre-existing database.

        ``CREATE TABLE IF NOT EXISTS`` is a no-op on an older DB, so a newly
        introduced column (``description``) has to be added explicitly. Rebuild
        is the documented path for schema changes; this only keeps an already-open
        DB readable/writable instead of raising on every query.
        """
        cols = {
            r[1] for r in self.conn.execute("PRAGMA table_info(entities)").fetchall()
        }
        if "description" not in cols:
            self.conn.execute(
                "ALTER TABLE entities ADD COLUMN description TEXT NOT NULL DEFAULT ''"
            )

    def _ensure_community_columns(self) -> None:
        """Add community columns missing from a pre-existing database.

        Adds ``summary_stale`` column (for incremental ingestion summary invalidation)
        and ``parent_id`` / ``parent_level`` columns (for hierarchical rate-then-descend
        selection) using the same ALTER TABLE pattern as ``_ensure_entity_columns``.
        """
        cols = {
            r[1] for r in self.conn.execute("PRAGMA table_info(communities)").fetchall()
        }
        if "summary_stale" not in cols:
            try:
                self.conn.execute(
                    "ALTER TABLE communities ADD COLUMN summary_stale INTEGER DEFAULT 0"
                )
            except Exception as exc:  # noqa: BLE001 - column may already exist in concurrent opens
                logger.debug("summary_stale column already exists (skipping): %s", exc)
        if "parent_id" not in cols:
            try:
                self.conn.execute(
                    "ALTER TABLE communities ADD COLUMN parent_id TEXT"
                )
            except Exception as exc:  # noqa: BLE001 - column may already exist in concurrent opens
                logger.debug("parent_id column already exists (skipping): %s", exc)
        if "parent_level" not in cols:
            try:
                self.conn.execute(
                    "ALTER TABLE communities ADD COLUMN parent_level INTEGER"
                )
            except Exception as exc:  # noqa: BLE001 - column may already exist in concurrent opens
                logger.debug("parent_level column already exists (skipping): %s", exc)

    def _ensure_entities_fts(self) -> None:
        """Create the ``entities_fts`` FTS5 index, if this build supports FTS5.

        Keyword search over the accumulated entity ``description`` lives here so
        the Qdrant entity vector can stay name-only. Absence of FTS5 is not fatal:
        :meth:`search_entities` falls back to a ``LIKE`` scan.
        """
        self._has_entities_fts = False
        try:
            self.conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS {_ENTITIES_FTS} USING fts5("
                f"entity_id UNINDEXED, name_seg, description_seg, "
                f"tokenize='unicode61')"
            )
        except sqlite3.OperationalError as e:
            logger.warning("entity FTS5 unavailable, falling back to LIKE: %s", e)
            return
        self._has_entities_fts = True
        self._backfill_entities_fts()

    def _backfill_entities_fts(self) -> None:
        """Index ``entities`` rows that have no ``entities_fts`` entry yet.

        ``CREATE VIRTUAL TABLE IF NOT EXISTS`` is a no-op on a database that
        already holds entities, and only :meth:`upsert_entities` writes the index,
        so rows ingested before this index existed (or added through the
        defensive ``ALTER``/raw-SQL paths) would stay invisible to
        :meth:`search_entities` until they were rewritten. Backfilling at open
        time makes opening the store sufficient.

        Idempotent by construction: only entities missing from the index are
        selected, and :meth:`_index_entities_fts` deletes before inserting, so
        repeated opens neither duplicate rows nor re-segment indexed ones. Only
        the two indexed columns are read (never ``entity_type``), so a legacy row
        with an unknown type can't break store construction. The ``IS NOT NULL``
        guard keeps one orphaned index row (unjoinable anyway) from making
        ``NOT IN`` null out and skip every entity. Caller commits.
        """
        if not self._has_entities_fts:
            return
        rows = self.conn.execute(
            f"""SELECT id, name, COALESCE(description, '') AS description
                FROM entities
                WHERE id NOT IN (
                    SELECT entity_id FROM {_ENTITIES_FTS} WHERE entity_id IS NOT NULL
                )"""
        ).fetchall()
        if not rows:
            return
        self._index_entities_fts(
            [
                Entity(id=r["id"], name=r["name"] or "", description=r["description"])
                for r in rows
            ]
        )
        logger.info("backfilled %d entities into %s", len(rows), _ENTITIES_FTS)

    def close(self) -> None:
        # Close every per-thread connection opened through this store.
        for conn in self._connections:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - best-effort cleanup
                pass
        self._connections.clear()
        self._local = threading.local()

    # ─── Ingest metadata (key-value store for watermarks/run counts) ──────

    def get_meta(self, key: str) -> str | None:
        """Retrieve a value from the ingest_meta key-value table.

        Args:
            key: The metadata key to look up.

        Returns:
            The stored value as string, or None if not found.
        """
        row = self.conn.execute(
            "SELECT value FROM ingest_meta WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            return None
        return row[0]

    def set_meta(self, key: str, value: str) -> None:
        """Insert or update a value in the ingest_meta key-value table.

        Args:
            key: The metadata key to set.
            value: The value to store (always stored as TEXT).
        """
        self.conn.execute(
            "INSERT OR REPLACE INTO ingest_meta (key, value, updated_at) "
            "VALUES (?, ?, strftime('%s', 'now'))",
            (key, value),
        )
        self.conn.commit()

    def existing_chunk_ids(self, ids: list[str]) -> set[str]:
        """Batch-check which chunk IDs already exist in the chunks table.

        Processes IDs in batches of 500 to stay within the SQLite variable limit (999).

        Args:
            ids: List of chunk IDs to check for existence.

        Returns:
            Set of IDs that already exist in the chunks table.
        """
        if not ids:
            return set()
        found: set[str] = set()
        batch_size = 500
        for i in range(0, len(ids), batch_size):
            batch = ids[i : i + batch_size]
            placeholders = ",".join("?" * len(batch))
            rows = self.conn.execute(
                f"SELECT id FROM chunks WHERE id IN ({placeholders})", batch
            ).fetchall()
            for row in rows:
                found.add(row[0])
        return found

    # ─── Chunks (unified retrieval-unit store) ──────────────────

    def insert_chunks(self, chunks: list[Chunk]) -> None:
        """Bulk insert generic chunks into the mixed ``chunks`` table.

        This is the source-agnostic store: every embedded retrieval unit
        (chat message, meeting-transcript paragraph, mail body, wiki section,
        …) lands here, discriminated by ``source_type`` for fast filtering.
        Source-specific structured fields (e.g. a chat chunk's
        conversation/sender) live in ``metadata``.
        """
        self.conn.executemany(
            """INSERT OR IGNORE INTO chunks
               (id, content, content_hash, source_type, timestamp, source_ref,
                embedding_id, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    c.id,
                    c.content,
                    hashlib.sha256(c.content.encode()).hexdigest(),
                    c.source_type,
                    c.timestamp,
                    c.source_ref,
                    c.embedding_id,
                    json.dumps(c.metadata, ensure_ascii=False) if c.metadata else None,
                )
                for c in chunks
            ],
        )
        self.conn.commit()

    def _ensure_chunk_columns(self) -> None:
        """Add lineage-era columns to databases created by older versions."""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(chunks)").fetchall()}
        if "content_hash" not in cols:
            self.conn.execute(
                "ALTER TABLE chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''"
            )

    def _ensure_ingest_run_columns(self) -> None:
        cols = {
            r[1] for r in self.conn.execute("PRAGMA table_info(ingest_runs)").fetchall()
        }
        if "percent" not in cols:
            self.conn.execute(
                "ALTER TABLE ingest_runs ADD COLUMN percent REAL NOT NULL DEFAULT 0"
            )
        if "detail" not in cols:
            self.conn.execute(
                "ALTER TABLE ingest_runs ADD COLUMN detail TEXT NOT NULL DEFAULT ''"
            )

    def insert_chunks_with_units(
        self,
        chunks: list[Chunk],
        units: list[SourceUnit],
        memberships: list[ChunkUnit],
        *,
        batch_id: str | None = None,
        batch_source_id: str | None = None,
        source_hash: str | None = None,
    ) -> None:
        """Commit chunks, unit lineage, and the batch workset atomically."""
        now = int(time.time())
        with self.conn:
            if batch_id is not None:
                if not batch_source_id or not source_hash:
                    raise ValueError(
                        "batch_source_id and source_hash are required with batch_id"
                    )
                self.conn.execute(
                    """INSERT INTO ingest_batches
                       (batch_id, source_id, source_hash, state, created_at, updated_at)
                       VALUES (?, ?, ?, 'preparing', ?, ?)
                       ON CONFLICT(batch_id) DO NOTHING""",
                    (batch_id, batch_source_id, source_hash, now, now),
                )
                row = self.conn.execute(
                    """SELECT source_id, source_hash, state, unit_count
                       FROM ingest_batches WHERE batch_id=?""",
                    (batch_id,),
                ).fetchone()
                if row is None or row[0] != batch_source_id or row[1] != source_hash:
                    raise ValueError(f"batch_id {batch_id!r} belongs to another source")
                if row[2] == "complete":
                    raise RuntimeError(f"ingestion batch {batch_id!r} is already complete")
                batch_unit_count = len(units) if units else int(row[3])
            self.conn.executemany(
                """INSERT INTO sources(source_id, created_at) VALUES (?, ?)
                   ON CONFLICT(source_id) DO NOTHING""",
                [
                    (source_id, now)
                    for source_id in sorted({u.source_id for u in units})
                ],
            )
            self.conn.executemany(
                """INSERT INTO chunks
                   (id, content, content_hash, source_type, timestamp, source_ref,
                    embedding_id, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO NOTHING""",
                [
                    (
                        c.id,
                        c.content,
                        hashlib.sha256(c.content.encode()).hexdigest(),
                        c.source_type,
                        c.timestamp,
                        c.source_ref,
                        c.embedding_id,
                        json.dumps(c.metadata, ensure_ascii=False)
                        if c.metadata
                        else None,
                    )
                    for c in chunks
                ],
            )
            self.conn.executemany(
                """INSERT INTO units
                   (source_id, source_type, unit_id, content_hash, timestamp,
                    metadata, processed_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(source_id, source_type, unit_id) DO NOTHING""",
                [
                    (
                        u.source_id,
                        u.source_type,
                        u.unit_id,
                        u.content_hash,
                        u.timestamp,
                        json.dumps(u.metadata, ensure_ascii=False)
                        if u.metadata
                        else None,
                        now,
                    )
                    for u in units
                ],
            )
            self.conn.executemany(
                """INSERT INTO chunk_units
                   (chunk_id, source_id, source_type, unit_id,
                    unit_ordinal_in_chunk, chunk_ordinal_in_unit,
                    start_offset, end_offset)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(chunk_id, source_id, source_type, unit_id) DO NOTHING""",
                [
                    (
                        m.chunk_id,
                        m.source_id,
                        m.source_type,
                        m.unit_id,
                        m.unit_ordinal_in_chunk,
                        m.chunk_ordinal_in_unit,
                        m.start_offset,
                        m.end_offset,
                    )
                    for m in memberships
                ],
            )
            if batch_id is not None:
                self.conn.executemany(
                    """INSERT INTO ingest_batch_chunks
                       (batch_id, chunk_id, chunk_ordinal) VALUES (?, ?, ?)
                       ON CONFLICT(batch_id, chunk_id) DO UPDATE SET
                         chunk_ordinal=excluded.chunk_ordinal""",
                    [(batch_id, chunk.id, i) for i, chunk in enumerate(chunks)],
                )
                self.conn.execute(
                    """UPDATE ingest_batches
                       SET state='ready', unit_count=?, chunk_count=?, updated_at=?
                       WHERE batch_id=?""",
                    (batch_unit_count, len(chunks), now, batch_id),
                )

    def get_ingest_batch(self, batch_id: str) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM ingest_batches WHERE batch_id=?", (batch_id,)
        ).fetchone()
        return dict(row) if row is not None else None

    def get_ingest_batch_chunks(self, batch_id: str) -> list[Chunk]:
        rows = self.conn.execute(
            """SELECT c.* FROM ingest_batch_chunks b
               JOIN chunks c ON c.id = b.chunk_id
               WHERE b.batch_id=? ORDER BY b.chunk_ordinal""",
            (batch_id,),
        ).fetchall()
        return [self._row_to_chunk(row) for row in rows]

    def complete_ingest_batch(self, batch_id: str) -> None:
        """Keep a summary row while deleting the completed batch's workset."""

        now = int(time.time())
        with self.conn:
            row = self.conn.execute(
                "SELECT state FROM ingest_batches WHERE batch_id=?", (batch_id,)
            ).fetchone()
            if row is None:
                raise RuntimeError(f"unknown ingestion batch {batch_id!r}")
            self.conn.execute(
                "DELETE FROM ingest_batch_chunks WHERE batch_id=?", (batch_id,)
            )
            self.conn.execute(
                "UPDATE ingest_batches SET state='complete', updated_at=? WHERE batch_id=?",
                (now, batch_id),
            )

    def existing_unit_ids(
        self, source_id: str, keys: list[tuple[str, str]]
    ) -> set[tuple[str, str]]:
        """Return unit keys already committed for ``source_id``."""
        return set(self.existing_unit_hashes(source_id, keys))

    def existing_unit_hashes(
        self, source_id: str, keys: list[tuple[str, str]]
    ) -> dict[tuple[str, str], str]:
        """Return stored content hashes for existing unit keys."""
        if not keys:
            return {}
        found: dict[tuple[str, str], str] = {}
        for source_type, unit_id in keys:
            row = self.conn.execute(
                """SELECT content_hash FROM units
                   WHERE source_id = ? AND source_type = ? AND unit_id = ?""",
                (source_id, source_type, unit_id),
            ).fetchone()
            if row:
                found[(source_type, unit_id)] = str(row[0])
        return found

    def get_chunk(self, chunk_id: str) -> Chunk | None:
        row = self.conn.execute(
            "SELECT * FROM chunks WHERE id = ?", (chunk_id,)
        ).fetchone()
        if not row:
            return None
        return self._row_to_chunk(row)

    def get_chunks_by_ids(self, chunk_ids: list[str]) -> list[Chunk]:
        """Retrieve multiple chunks by id in a batched IN query.

        Processes ids in groups of 500 to stay within the SQLite variable
        limit (999). Unknown ids are silently skipped.

        Args:
            chunk_ids: The unique chunk identifiers to look up.

        Returns:
            List of found Chunk instances (may be shorter than the input).
        """
        if not chunk_ids:
            return []
        results: list[Chunk] = []
        batch_size = 500
        for i in range(0, len(chunk_ids), batch_size):
            batch = chunk_ids[i : i + batch_size]
            placeholders = ",".join("?" * len(batch))
            rows = self.conn.execute(
                f"SELECT * FROM chunks WHERE id IN ({placeholders})", batch
            ).fetchall()
            for row in rows:
                results.append(self._row_to_chunk(row))
        return results

    def count_chunks(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]

    def count_chunks_by_source(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT source_type, COUNT(*) AS cnt FROM chunks GROUP BY source_type"
        ).fetchall()
        return {r["source_type"]: r["cnt"] for r in rows}

    def _row_to_chunk(self, row) -> Chunk:
        d = dict(row)
        meta = d.get("metadata")
        return Chunk(
            id=d["id"],
            content=d["content"],
            source_type=d["source_type"],
            timestamp=d["timestamp"],
            embedding_id=d.get("embedding_id"),
            source_ref=d.get("source_ref"),
            metadata=json.loads(meta) if meta else {},
        )

    # ─── Scopes (source containers: conversation, document, thread, …) ──

    def insert_scopes(self, scopes: list[Scope]) -> None:
        """Bulk insert source-container scopes; duplicates (by id) are ignored.

        Scope ids are deterministic (:func:`~kl_graph.models.types.scope_id_from`),
        so a re-ingest of the same export re-derives the same rows and this stays
        idempotent. ``metadata`` is stored as JSON text, mirroring
        :meth:`insert_chunks`.

        Args:
            scopes: Scope instances to store.
        """
        if not scopes:
            return
        self.conn.executemany(
            """INSERT OR IGNORE INTO scopes (id, scope_type, title, metadata)
               VALUES (?, ?, ?, ?)""",
            [
                (
                    s.id,
                    s.scope_type,
                    s.title,
                    json.dumps(s.metadata, ensure_ascii=False) if s.metadata else None,
                )
                for s in scopes
            ],
        )
        self.conn.commit()

    def get_scope(self, scope_id: str) -> Scope | None:
        """Retrieve one scope by id.

        Args:
            scope_id: The deterministic scope identifier.

        Returns:
            The Scope if found, else None.
        """
        row = self.conn.execute(
            "SELECT * FROM scopes WHERE id = ?", (scope_id,)
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        meta = d.get("metadata")
        return Scope(
            id=d["id"],
            scope_type=d["scope_type"] or "",
            title=d["title"] or "",
            metadata=json.loads(meta) if meta else {},
        )

    # ─── Chat chunks (source_type == "message") ──────────────────

    def insert_messages(self, chunks: list[Chunk]) -> None:
        """Insert chat chunks. Thin wrapper over :meth:`insert_chunks`.

        There is no per-message detail table any more: a chat message *is* a
        :class:`Chunk` with ``source_type="message"``, and its chat-only fields
        (conversation/sender/reply_to) ride along in ``metadata``. Kept as a
        named entry point so chat callers still read intelligibly.
        """
        self.insert_chunks(chunks)

    def get_message(self, msg_id: str) -> Chunk | None:
        """Hydrate one chat chunk by id from the unified ``chunks`` table."""
        return self.get_chunk(msg_id)

    def get_messages_by_conversation(
        self, conv_id: str, limit: int = 100
    ) -> list[Chunk]:
        """Chat chunks of one conversation, oldest first.

        ``conversation_id`` lives in the chunk's ``metadata`` JSON now that the
        detail table is gone, so it is matched with ``json_extract``.
        """
        rows = self.conn.execute(
            """SELECT * FROM chunks
               WHERE json_extract(metadata, '$.conversation_id') = ?
               ORDER BY timestamp LIMIT ?""",
            (conv_id, limit),
        ).fetchall()
        return [self._row_to_chunk(r) for r in rows]

    def get_messages_for_entity(self, entity_id: str, limit: int = 50) -> list[Chunk]:
        """Get chunks that mention an entity via edges."""
        rows = self.conn.execute(
            """SELECT c.* FROM chunks c
               JOIN edges e ON e.source_type = 'chunk' AND e.source_id = c.id
               WHERE e.target_type = 'entity' AND e.target_id = ?
                 AND e.edge_type = 'MENTIONS'
               ORDER BY c.timestamp DESC LIMIT ?""",
            (entity_id, limit),
        ).fetchall()
        return [self._row_to_chunk(r) for r in rows]

    def count_messages(self) -> int:
        """Number of chat chunks (``source_type == "message"``)."""
        return self.conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE source_type = 'message'"
        ).fetchone()[0]

    # ─── Entities ───────────────────────────────────────────────

    def upsert_entity(self, entity: Entity) -> None:
        """Insert or update entity (increment mention_count, update last_seen)."""
        self.upsert_entities([entity])

    def upsert_entities_bulk(self, entities: list[Entity]) -> None:
        """Bulk upsert entities. Kept for backward compatibility — delegates to upsert_entities."""
        self.upsert_entities(entities)

    def upsert_entities(self, entities: list[Entity]) -> None:
        """Bulk upsert entities. On conflict updates last_seen and increments mention_count.

        ``description`` is written as given: the pipeline accumulates the
        per-chunk contributions in memory and hands over the final text, so the
        row is overwritten with the newer (longer / generalized) description
        rather than merged in SQL.

        Args:
            entities: Entities to upsert.
        """
        self.conn.executemany(
            """INSERT INTO entities (id, name, entity_type, first_seen, last_seen, mention_count, embedding_id, description)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 last_seen = MAX(entities.last_seen, excluded.last_seen),
                 mention_count = entities.mention_count + 1,
                 description = excluded.description""",
            [
                (
                    e.id,
                    e.name,
                    e.entity_type.value,
                    e.first_seen,
                    e.last_seen,
                    e.mention_count,
                    e.embedding_id,
                    e.description or "",
                )
                for e in entities
            ],
        )
        self._index_entities_fts(entities)
        self.conn.commit()

    def _index_entities_fts(self, entities: list[Entity]) -> None:
        """Refresh the ``entities_fts`` rows for ``entities`` (delete + reinsert).

        FTS5 has no upsert, and the description grows on every merge, so each
        entity's row is replaced. Caller commits.

        Args:
            entities: Entities whose keyword index entries should be rewritten.
        """
        if not getattr(self, "_has_entities_fts", False) or not entities:
            return
        ids = [(e.id,) for e in entities]
        self.conn.executemany(f"DELETE FROM {_ENTITIES_FTS} WHERE entity_id = ?", ids)
        self.conn.executemany(
            f"INSERT INTO {_ENTITIES_FTS}(entity_id, name_seg, description_seg) "
            f"VALUES (?, ?, ?)",
            [(e.id, _segment(e.name), _segment(e.description or "")) for e in entities],
        )

    def get_entity_by_name(self, name: str) -> Entity | None:
        row = self.conn.execute(
            "SELECT * FROM entities WHERE name = ?", (name,)
        ).fetchone()
        if not row:
            return None
        return self._row_to_entity(row)

    def search_entities_by_name(self, query: str, limit: int = 10) -> list[Entity]:
        """Substring match on entity names."""
        rows = self.conn.execute(
            "SELECT * FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT ?",
            (f"%{query}%", limit),
        ).fetchall()
        return [self._row_to_entity(r) for r in rows]

    def search_entities(self, query: str, limit: int = 10) -> list[Entity]:
        """Keyword search over entity ``name`` **and** ``description``.

        BM25-ranked via the ``entities_fts`` FTS5 index (jieba-pre-segmented, so
        Chinese terms match), which is what makes accumulated descriptions
        retrievable without touching the name-only Qdrant entity vector. Falls
        back to a ``LIKE`` scan over both columns when FTS5 is unavailable or the
        query has no usable tokens.

        Args:
            query: Free-text keyword query.
            limit: Maximum results (default 10).

        Returns:
            Matching entities, best keyword match first (or most-mentioned first
            on the LIKE fallback).
        """
        if getattr(self, "_has_entities_fts", False):
            tokens = [
                t
                for t in _FTS_SPECIAL.sub(" ", _segment(query)).split()
                if _HAS_WORD.search(t)
            ]
            if tokens:
                match_expr = " OR ".join(
                    '"' + t.replace('"', '""') + '"' for t in tokens
                )
                try:
                    rows = self.conn.execute(
                        f"""SELECT e.*, bm25({_ENTITIES_FTS}) AS _score
                            FROM {_ENTITIES_FTS}
                            JOIN entities e ON e.id = {_ENTITIES_FTS}.entity_id
                            WHERE {_ENTITIES_FTS} MATCH ?
                            ORDER BY _score LIMIT ?""",
                        (match_expr, limit),
                    ).fetchall()
                except sqlite3.OperationalError as e:
                    logger.warning("entity FTS query failed, using LIKE: %s", e)
                else:
                    # An empty MATCH is not an answer: FTS matches whole tokens,
                    # so a substring query ("Legacy" against the token
                    # "LegacyName") finds nothing here while LIKE would find it.
                    # Only a non-empty BM25 result short-circuits the fallback.
                    if rows:
                        return [self._row_to_entity(r) for r in rows]

        rows = self.conn.execute(
            """SELECT * FROM entities
               WHERE name LIKE ? OR description LIKE ?
               ORDER BY mention_count DESC LIMIT ?""",
            (f"%{query}%", f"%{query}%", limit),
        ).fetchall()
        return [self._row_to_entity(r) for r in rows]

    def get_all_entity_names(self) -> dict[str, str]:
        """Return {name: id} for all entities."""
        rows = self.conn.execute("SELECT id, name FROM entities").fetchall()
        return {r["name"]: r["id"] for r in rows}

    def count_entities(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]

    def iter_all_entities(self) -> Iterator[Entity]:
        """Iterate over all stored entities.

        Used for checkpoint-resume reload: populates the in-memory entity dict
        when the build_entities step is skipped.
        """
        cursor = self.conn.execute("SELECT * FROM entities")
        while True:
            row = cursor.fetchone()
            if row is None:
                break
            yield self._row_to_entity(row)

    def _row_to_entity(self, row) -> Entity:
        d = dict(row)
        d["entity_type"] = EntityType(d["entity_type"])
        # A pre-existing row (or one written by a raw-SQL path) can carry NULL
        # description; the dataclass contract is str.
        if d.get("description") is None:
            d["description"] = ""
        # Ignore extra columns added by periodic improvement (community_L*,
        # community_id, topic_cluster_id, ...) and query-time extras (bm25 score)
        # that aren't Entity fields.
        fields = {f.name for f in dataclasses.fields(Entity)}
        return Entity(**{k: v for k, v in d.items() if k in fields})

    # ─── Facts ──────────────────────────────────────────────────

    def insert_facts(self, facts: list[Fact]) -> None:
        """Bulk insert facts."""
        self.conn.executemany(
            """INSERT OR IGNORE INTO facts
               (id, text, fact_type, timestamp, confidence, source_chunk_id, embedding_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    f.id,
                    f.text,
                    f.fact_type.value,
                    f.timestamp,
                    f.confidence,
                    f.source_chunk_id,
                    f.embedding_id,
                )
                for f in facts
            ],
        )
        self.conn.commit()

    def get_facts_for_entity(self, entity_id: str, limit: int = 20) -> list[Fact]:
        """Get facts about an entity via ABOUT edges."""
        rows = self.conn.execute(
            """SELECT f.* FROM facts f
               JOIN edges e ON e.source_type = 'fact' AND e.source_id = f.id
               WHERE e.target_type = 'entity' AND e.target_id = ?
                 AND e.edge_type = 'ABOUT'
               ORDER BY f.timestamp DESC LIMIT ?""",
            (entity_id, limit),
        ).fetchall()
        return [self._row_to_fact(r) for r in rows]

    def get_fact(self, fact_id: str) -> Fact | None:
        row = self.conn.execute(
            "SELECT * FROM facts WHERE id = ?", (fact_id,)
        ).fetchone()
        if not row:
            return None
        return self._row_to_fact(row)

    def count_facts(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]

    def iter_all_facts(self) -> Iterator[Fact]:
        """Iterate over all stored facts.

        Used for checkpoint-resume reload: populates the in-memory facts list
        when the build_facts step is skipped.
        """
        cursor = self.conn.execute("SELECT * FROM facts")
        while True:
            row = cursor.fetchone()
            if row is None:
                break
            yield self._row_to_fact(row)

    def _row_to_fact(self, row) -> Fact:
        d = dict(row)
        d["fact_type"] = FactType(d["fact_type"])
        # Ignore extra columns added by periodic improvement (community_L*,
        # community_id, topic_cluster_id, ...) that aren't Fact fields.
        fields = {f.name for f in dataclasses.fields(Fact)}
        return Fact(**{k: v for k, v in d.items() if k in fields})

    # ─── Edges ──────────────────────────────────────────────────

    def insert_edges(self, edges: list[Edge]) -> None:
        """Bulk insert edges (ignore duplicates)."""
        self.conn.executemany(
            """INSERT OR IGNORE INTO edges
               (source_type, source_id, target_type, target_id, edge_type, properties)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [
                (
                    e.source_type,
                    e.source_id,
                    e.target_type,
                    e.target_id,
                    e.edge_type.value,
                    json.dumps(e.properties) if e.properties else None,
                )
                for e in edges
            ],
        )
        self.conn.commit()

    def delete_edges(
        self,
        *,
        source_id: str | None = None,
        target_id: str | None = None,
        edge_type: str | None = None,
        where_properties: dict | None = None,
    ) -> int:
        """Delete edges matching filters. At least one filter must be non-None.

        Args:
            source_id: Filter by source_id.
            target_id: Filter by target_id.
            edge_type: Filter by edge_type string.
            where_properties: Filter by properties JSON content.

        Returns:
            Number of deleted rows.
        """
        if (
            source_id is None
            and target_id is None
            and edge_type is None
            and where_properties is None
        ):
            raise ValueError("At least one filter must be specified for delete_edges()")

        conditions: list[str] = []
        params: list = []

        if source_id is not None:
            conditions.append("source_id = ?")
            params.append(source_id)
        if target_id is not None:
            conditions.append("target_id = ?")
            params.append(target_id)
        if edge_type is not None:
            conditions.append("edge_type = ?")
            params.append(edge_type)
        if where_properties is not None:
            _ALLOWED_PROP_KEYS = {"confidence", "hybrid_score", "source"}
            for key, value in where_properties.items():
                if not set(key).issubset(set("abcdefghijklmnopqrstuvwxyz_0123456789")):
                    raise ValueError(
                        f"Unsafe property key in where_properties: {key!r}"
                    )
                if key not in _ALLOWED_PROP_KEYS:
                    raise ValueError(
                        f"Unknown property key {key!r}. Allowed: {_ALLOWED_PROP_KEYS}"
                    )
                conditions.append(f"json_extract(properties, '$.{key}') = ?")
                params.append(value)

        where_clause = " AND ".join(conditions)
        cursor = self.conn.execute(f"DELETE FROM edges WHERE {where_clause}", params)
        self.conn.commit()
        return cursor.rowcount

    def get_neighbors(
        self,
        node_type: str,
        node_id: str,
        edge_type: str | None = None,
        direction: str = "both",
    ) -> list[dict]:
        """Get neighboring nodes via edges.

        direction: 'outgoing' or 'out' (source=this), 'incoming' or 'in' (target=this), 'both'
        """
        results = []
        # normalise direction aliases
        is_out = direction in ("outgoing", "out", "both")
        is_in = direction in ("incoming", "in", "both")

        if is_out:
            q = "SELECT * FROM edges WHERE source_type = ? AND source_id = ?"
            params: list = [node_type, node_id]
            if edge_type:
                q += " AND edge_type = ?"
                params.append(
                    edge_type if isinstance(edge_type, str) else edge_type.value
                )
            rows = self.conn.execute(q, params).fetchall()
            results.extend([dict(r) for r in rows])

        if is_in:
            q = "SELECT * FROM edges WHERE target_type = ? AND target_id = ?"
            params = [node_type, node_id]
            if edge_type:
                q += " AND edge_type = ?"
                params.append(
                    edge_type if isinstance(edge_type, str) else edge_type.value
                )
            rows = self.conn.execute(q, params).fetchall()
            results.extend([dict(r) for r in rows])

        return results

    def count_edges(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]

    def count_edges_by_type(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT edge_type, COUNT(*) as cnt FROM edges GROUP BY edge_type"
        ).fetchall()
        return {r["edge_type"]: r["cnt"] for r in rows}

    def find_paths(
        self,
        source_id: str,
        target_id: str,
        *,
        max_hops: int = 4,
        all_shortest: bool = False,
        edge_types: list[str] | None = None,
    ) -> PathResult:
        """BFS shortest-path search over the edges table. Absorbs logic from sqlite_graph.py.

        Args:
            source_id: Start node id.
            target_id: End node id.
            max_hops: Max path length (default 4).
            all_shortest: Return all shortest paths if True.
            edge_types: Restrict to these edge types.

        Returns:
            PathResult.
        """
        if edge_types is None:
            edge_types = list(DEFAULT_PATH_EDGES)
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
        """BFS shortest-path search over the edges table."""
        if source_id == target_id:
            node = PathNode(id=source_id, node_type=self._node_type(source_id))
            return [Path(nodes=[node], edges=[], hop_count=0)]

        queue: deque[tuple[str, str, list[tuple]]] = deque()
        queue.append((source_id, self._node_type(source_id), []))
        visited: dict[str, int] = {source_id: 0}
        found_paths: list[Path] = []
        found_distance: int | None = None

        edge_types_tuple = tuple(edge_types)

        while queue:
            current_id, current_type, trail = queue.popleft()
            current_distance = len(trail)

            if found_distance is not None and current_distance >= found_distance:
                if not all_shortest:
                    break
                if current_distance > found_distance:
                    break

            if current_distance >= max_hops:
                continue

            nbrs = self._get_path_neighbors(
                current_id, current_type, edge_types_tuple, node_types
            )

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

                if nbr_id in visited:
                    threshold = visited[nbr_id]
                    if new_distance > threshold or (
                        new_distance == threshold and not all_shortest
                    ):
                        continue
                visited[nbr_id] = new_distance
                queue.append(
                    (
                        nbr_id,
                        nbr_type,
                        trail + [(nbr_id, nbr_type, etype, direction, props)],
                    )
                )

        return found_paths

    def _get_path_neighbors(
        self,
        node_id: str,
        node_type: str,
        edge_types: tuple[str, ...],
        node_types: list[str],
    ) -> list[tuple[str, str, str, dict, str]]:
        """Get all neighbors of a node for BFS (both directions)."""
        if not edge_types or not node_types:
            return []
        placeholders = ",".join("?" * len(edge_types))
        type_placeholders = ",".join("?" * len(node_types))
        results: list[tuple[str, str, str, dict, str]] = []

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

    def neighbors_typed(
        self,
        node_id: str,
        node_type: str,
        *,
        edge_types: list[str] | None = None,
        direction: str = "both",
        limit: int = 50,
    ) -> list[tuple[str, str, str, dict]]:
        """Typed neighbor lookup absorbing the GraphDB.neighbors interface.

        Args:
            node_id: Node to find neighbors of.
            node_type: Type of the query node.
            edge_types: Filter to these types if set.
            direction: "out", "in", or "both".
            limit: Max results.

        Returns:
            List of (neighbor_id, neighbor_type, edge_type, properties) tuples.
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

    def scan_entity_edges(self) -> Iterator[tuple[str, str, str, str, str]]:
        """Streaming scan of all edges for adjacency index build.

        Returns:
            Iterator of (source_type, source_id, target_type, target_id, edge_type).
        """
        cursor = self.conn.execute(
            "SELECT source_type, source_id, target_type, target_id, edge_type FROM edges"
        )
        for row in cursor:
            yield (row[0], row[1], row[2], row[3], row[4])

    def scan_edges_by_type(
        self,
        edge_types: list[str],
        *,
        source_type: str | None = None,
        target_type: str | None = None,
    ) -> Iterator[tuple[str, str, dict]]:
        """Stream ``(source_id, target_id, properties)`` for edges of given type(s).

        Reads the SQLite ``edges`` table (authoritative for edges on this
        backend), decoding the ``properties`` JSON into a dict. See the ABC for
        the backend-agnostic contract.
        """
        if not edge_types:
            return
        placeholders = ",".join("?" for _ in edge_types)
        conds = [f"edge_type IN ({placeholders})"]
        params: list = list(edge_types)
        if source_type is not None:
            conds.append("source_type = ?")
            params.append(source_type)
        if target_type is not None:
            conds.append("target_type = ?")
            params.append(target_type)
        where = " AND ".join(conds)
        cursor = self.conn.execute(
            f"SELECT source_id, target_id, properties FROM edges WHERE {where}",
            params,
        )
        for row in cursor:
            props: dict = {}
            if row[2]:
                try:
                    parsed = json.loads(row[2])
                    if isinstance(parsed, dict):
                        props = parsed
                except (TypeError, ValueError):
                    props = {}
            yield (row[0], row[1], props)

    def scan_edges_for_nodes(
        self,
        edge_types: list[str],
        node_ids: set[str],
        *,
        source_type: str | None = None,
        target_type: str | None = None,
    ) -> Iterator[tuple[str, str, dict]]:
        """Stream ``(source_id, target_id, properties)`` for edges touching ``node_ids``.

        Frontier-scoped scan: pushes the endpoint filter into the SQL WHERE
        clause (``source_id IN (...) OR target_id IN (...)``) so only edges
        touching the frontier are loaded — O(frontier) rather than O(E).
        Batch size accounts for each ID being bound twice, keeping the complete
        statement within SQLite's portable 999-variable limit.

        See :meth:`scan_edges_by_type` for the property-decoding contract.
        """
        if not edge_types or not node_ids:
            return
        etype_ph = ",".join("?" for _ in edge_types)
        conds: list[str] = [f"edge_type IN ({etype_ph})"]
        params: list = list(edge_types)
        if source_type is not None:
            conds.append("source_type = ?")
            params.append(source_type)
        if target_type is not None:
            conds.append("target_type = ?")
            params.append(target_type)
        where = " AND ".join(conds)
        node_list = sorted(node_ids)
        batch_size = max(1, (999 - len(params)) // 2)
        seen: set[tuple[str, str, str]] = set()
        for i in range(0, len(node_list), batch_size):
            batch = node_list[i : i + batch_size]
            node_ph = ",".join("?" for _ in batch)
            cursor = self.conn.execute(
                f"SELECT source_id, target_id, edge_type, properties FROM edges "
                f"WHERE {where} AND (source_id IN ({node_ph}) OR target_id IN ({node_ph}))",
                params + batch + batch,
            )
            for row in cursor:
                key = (row[0], row[1], row[2])
                if key in seen:
                    continue
                seen.add(key)
                props: dict = {}
                if row[3]:
                    try:
                        parsed = json.loads(row[3])
                        if isinstance(parsed, dict):
                            props = parsed
                    except (TypeError, ValueError):
                        props = {}
                yield (row[0], row[1], props)

    # ─── Communities (reified clusters; assignments stay in the columns) ──

    def insert_communities(self, communities: list[Community]) -> None:
        """Upsert reified community rows (``INSERT OR REPLACE`` by id).

        Replaces rather than ignores: a re-clustering run recomputes
        ``member_count`` (and later ``summary``/``tags``) for the same
        deterministic id, and the fresh values must win. Community ids come from
        :func:`~kl_graph.models.types.community_id_from`, so the rows are the
        derived projection of the authoritative ``community_L0..L3`` columns.

        Args:
            communities: Community instances to store.
        """
        if not communities:
            return
        self.conn.executemany(
            """INSERT OR REPLACE INTO communities
               (id, level, node_type, summary, tags, member_count, parent_id, parent_level)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    c.id,
                    c.level,
                    c.node_type,
                    c.summary,
                    json.dumps(c.tags, ensure_ascii=False),
                    int(c.member_count),
                    c.parent_id,
                    c.parent_level,
                )
                for c in communities
            ],
        )
        self.conn.commit()

    def get_community(self, community_id: str) -> Community | None:
        """Retrieve one reified community by its deterministic id.

        Args:
            community_id: Id from :func:`~kl_graph.models.types.community_id_from`.

        Returns:
            The Community if found, else None.
        """
        row = self.conn.execute(
            "SELECT * FROM communities WHERE id = ?", (community_id,)
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        tags = d.get("tags")
        return Community(
            id=d["id"],
            level=d["level"] or "",
            node_type=d["node_type"] or "",
            summary=d["summary"] or "",
            tags=json.loads(tags) if tags else [],
            member_count=d["member_count"] or 0,
            parent_id=d.get("parent_id"),
            parent_level=d.get("parent_level"),
        )

    def get_community_summary(
        self, level: int, community_id: int
    ) -> dict | None:
        """Retrieve one community summary by its composite key.

        Args:
            level: Resolution level (e.g. 0, 1, 2, 3).
            community_id: Community number.

        Returns:
            Summary dict or None.
        """
        row = self.conn.execute(
            "SELECT * FROM community_summaries WHERE level = ? AND community_id = ?",
            (level, community_id),
        ).fetchone()
        return dict(row) if row else None

    def list_community_summaries(self, level: int) -> list[dict]:
        """List all summaries at a given level."""
        rows = self.conn.execute(
            "SELECT * FROM community_summaries WHERE level = ?",
            (level,),
        ).fetchall()
        return [dict(r) for r in rows]

    def store_community_summaries(self, summaries: list[dict]) -> None:
        """Bulk upsert community summaries."""
        self.conn.executemany(
            "INSERT OR REPLACE INTO community_summaries "
            "(level, community_id, member_count, entity_count, fact_count, "
            "title, summary, rating, rating_explanation, findings, tags, top_members) "
            "VALUES (:level, :community_id, :member_count, :entity_count, :fact_count, "
            ":title, :summary, :rating, :rating_explanation, :findings, :tags, :top_members)",
            [
                {
                    "level": s.get("level", 0),
                    "community_id": s.get("community_id", 0),
                    "member_count": s.get("member_count", 0),
                    "entity_count": s.get("entity_count", 0),
                    "fact_count": s.get("fact_count", 0),
                    "title": s.get("title", ""),
                    "summary": s.get("summary", ""),
                    "rating": s.get("rating", 0.0),
                    "rating_explanation": s.get("rating_explanation", ""),
                    "findings": s.get("findings", "[]"),
                    "tags": s.get("tags", "[]"),
                    "top_members": s.get("top_members", "[]"),
                }
                for s in summaries
            ],
        )
        self.conn.commit()
