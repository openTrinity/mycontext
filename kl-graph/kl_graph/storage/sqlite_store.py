"""SQLite storage backend for messages, entities, facts, and edges."""

from __future__ import annotations

import json
import dataclasses
import sqlite3
from pathlib import Path
from typing import Optional

from kl_graph.models.types import Chunk, Edge, EdgeType, Entity, EntityType, Fact, FactType, Message


class SQLiteStore:
    """Synchronous SQLite storage for the knowledge graph."""

    def __init__(self, db_path: Path, conn: Optional[sqlite3.Connection] = None):
        self.db_path = db_path
        if conn is not None:
            # Wrap an already-open connection (the server injects its warm,
            # WAL-tuned connection so we don't open a second one).
            self.conn = conn
            self.conn.row_factory = sqlite3.Row
            self._create_tables()
            return
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA cache_size=-64000")  # 64MB cache
        self._create_tables()

    def _create_tables(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT 'message',
                timestamp INTEGER NOT NULL DEFAULT 0,
                source_ref TEXT,
                embedding_id TEXT,
                metadata TEXT
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                sender TEXT NOT NULL,
                sender_id TEXT,
                content TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                reply_to TEXT,
                embedding_id TEXT
            );

            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                entity_type TEXT DEFAULT 'Unknown',
                first_seen INTEGER DEFAULT 0,
                last_seen INTEGER DEFAULT 0,
                mention_count INTEGER DEFAULT 1,
                embedding_id TEXT
            );

            CREATE TABLE IF NOT EXISTS facts (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                fact_type TEXT DEFAULT 'GENERAL',
                timestamp INTEGER DEFAULT 0,
                confidence REAL DEFAULT 0.8,
                source_message_id TEXT NOT NULL,
                embedding_id TEXT,
                FOREIGN KEY (source_message_id) REFERENCES messages(id)
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

            CREATE INDEX IF NOT EXISTS idx_chunks_source_type ON chunks(source_type, timestamp);
            CREATE INDEX IF NOT EXISTS idx_chunks_ts ON chunks(timestamp);
            CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_type, source_id, edge_type);
            CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_type, target_id, edge_type);
            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
            CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
            CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
            CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(fact_type, timestamp);
            CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_message_id);
            CREATE INDEX IF NOT EXISTS idx_facts_confidence ON facts(confidence);
        """)
        self.conn.commit()

    def close(self):
        self.conn.close()

    # ─── Chunks (unified retrieval-unit store) ──────────────────

    def insert_chunks(self, chunks: list[Chunk]):
        """Bulk insert generic chunks into the mixed ``chunks`` table.

        This is the source-agnostic store: every embedded retrieval unit
        (chat message, meeting-transcript paragraph, mail body, wiki section,
        …) lands here, discriminated by ``source_type`` for fast filtering.
        Source-specific structured fields (e.g. a message's conversation/sender)
        stay in their own detail table; open-ended extras live in ``metadata``.
        """
        self.conn.executemany(
            """INSERT OR IGNORE INTO chunks
               (id, content, source_type, timestamp, source_ref, embedding_id, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [(c.id, c.content, c.source_type, c.timestamp, c.source_ref,
              c.embedding_id, json.dumps(c.metadata, ensure_ascii=False) if c.metadata else None)
             for c in chunks]
        )
        self.conn.commit()

    def get_chunk(self, chunk_id: str) -> Optional[Chunk]:
        row = self.conn.execute(
            "SELECT * FROM chunks WHERE id = ?", (chunk_id,)
        ).fetchone()
        if not row:
            return None
        return self._row_to_chunk(row)

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

    # ─── Messages ───────────────────────────────────────────────

    def insert_messages(self, messages: list[Message]):
        """Bulk insert messages (detail table + the unified ``chunks`` row).

        A message is a :class:`Chunk` subtype: its generic retrieval fields go
        into ``chunks`` (so cross-source search / FTS see it), while its
        chat-specific columns (conversation, sender, reply_to) stay in the
        ``messages`` detail table.
        """
        self.insert_chunks(messages)
        self.conn.executemany(
            """INSERT OR IGNORE INTO messages
               (id, conversation_id, sender, sender_id, content, timestamp, reply_to, embedding_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [(m.id, m.conversation_id, m.sender, m.sender_id,
              m.content, m.timestamp, m.reply_to, m.embedding_id)
             for m in messages]
        )
        self.conn.commit()

    def get_message(self, msg_id: str) -> Optional[Message]:
        row = self.conn.execute(
            "SELECT * FROM messages WHERE id = ?", (msg_id,)
        ).fetchone()
        if not row:
            return None
        return Message(**dict(row))

    def get_messages_by_conversation(self, conv_id: str, limit: int = 100) -> list[Message]:
        rows = self.conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp LIMIT ?",
            (conv_id, limit)
        ).fetchall()
        return [Message(**dict(r)) for r in rows]

    def get_messages_for_entity(self, entity_id: str, limit: int = 50) -> list[Message]:
        """Get messages that mention an entity via edges."""
        rows = self.conn.execute(
            """SELECT m.* FROM messages m
               JOIN edges e ON e.source_type = 'message' AND e.source_id = m.id
               WHERE e.target_type = 'entity' AND e.target_id = ?
                 AND e.edge_type = 'MENTIONS'
               ORDER BY m.timestamp DESC LIMIT ?""",
            (entity_id, limit)
        ).fetchall()
        return [Message(**dict(r)) for r in rows]

    def count_messages(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]

    # ─── Entities ───────────────────────────────────────────────

    def upsert_entity(self, entity: Entity):
        """Insert or update entity (increment mention_count, update last_seen)."""
        self.conn.execute(
            """INSERT INTO entities (id, name, entity_type, first_seen, last_seen, mention_count, embedding_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 last_seen = MAX(entities.last_seen, excluded.last_seen),
                 mention_count = entities.mention_count + 1""",
            (entity.id, entity.name, entity.entity_type.value,
             entity.first_seen, entity.last_seen, entity.mention_count, entity.embedding_id)
        )

    def upsert_entities_bulk(self, entities: list[Entity]):
        """Bulk upsert entities."""
        self.conn.executemany(
            """INSERT INTO entities (id, name, entity_type, first_seen, last_seen, mention_count, embedding_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 last_seen = MAX(entities.last_seen, excluded.last_seen),
                 mention_count = entities.mention_count + 1""",
            [(e.id, e.name, e.entity_type.value,
              e.first_seen, e.last_seen, e.mention_count, e.embedding_id)
             for e in entities]
        )
        self.conn.commit()

    def get_entity_by_name(self, name: str) -> Optional[Entity]:
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
            (f"%{query}%", limit)
        ).fetchall()
        return [self._row_to_entity(r) for r in rows]

    def get_all_entity_names(self) -> dict[str, str]:
        """Return {name: id} for all entities."""
        rows = self.conn.execute("SELECT id, name FROM entities").fetchall()
        return {r["name"]: r["id"] for r in rows}

    def count_entities(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM entities").fetchone()[0]

    def _row_to_entity(self, row) -> Entity:
        d = dict(row)
        d["entity_type"] = EntityType(d["entity_type"])
        # Ignore extra columns added by periodic improvement (community_L*,
        # community_id, topic_cluster_id, ...) that aren't Entity fields.
        fields = {f.name for f in dataclasses.fields(Entity)}
        return Entity(**{k: v for k, v in d.items() if k in fields})

    # ─── Facts ──────────────────────────────────────────────────

    def insert_facts(self, facts: list[Fact]):
        """Bulk insert facts."""
        self.conn.executemany(
            """INSERT OR IGNORE INTO facts
               (id, text, fact_type, timestamp, confidence, source_message_id, embedding_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [(f.id, f.text, f.fact_type.value, f.timestamp,
              f.confidence, f.source_message_id, f.embedding_id)
             for f in facts]
        )
        self.conn.commit()

    def get_facts_for_entity(self, entity_id: str, limit: int = 20) -> list[Fact]:
        """Get facts about an entity via ABOUT/INVOLVES edges."""
        rows = self.conn.execute(
            """SELECT f.* FROM facts f
               JOIN edges e ON e.source_type = 'fact' AND e.source_id = f.id
               WHERE e.target_type = 'entity' AND e.target_id = ?
                 AND e.edge_type IN ('ABOUT', 'INVOLVES')
               ORDER BY f.timestamp DESC LIMIT ?""",
            (entity_id, limit)
        ).fetchall()
        return [self._row_to_fact(r) for r in rows]

    def get_fact(self, fact_id: str) -> Optional[Fact]:
        row = self.conn.execute(
            "SELECT * FROM facts WHERE id = ?", (fact_id,)
        ).fetchone()
        if not row:
            return None
        return self._row_to_fact(row)

    def count_facts(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]

    def _row_to_fact(self, row) -> Fact:
        d = dict(row)
        d["fact_type"] = FactType(d["fact_type"])
        # Ignore extra columns added by periodic improvement (community_L*,
        # community_id, topic_cluster_id, ...) that aren't Fact fields.
        fields = {f.name for f in dataclasses.fields(Fact)}
        return Fact(**{k: v for k, v in d.items() if k in fields})

    # ─── Edges ──────────────────────────────────────────────────

    def insert_edges(self, edges: list[Edge]):
        """Bulk insert edges (ignore duplicates)."""
        self.conn.executemany(
            """INSERT OR IGNORE INTO edges
               (source_type, source_id, target_type, target_id, edge_type, properties)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [(e.source_type, e.source_id, e.target_type, e.target_id,
              e.edge_type.value, json.dumps(e.properties) if e.properties else None)
             for e in edges]
        )
        self.conn.commit()

    def get_neighbors(self, node_type: str, node_id: str,
                      edge_type: Optional[EdgeType] = None,
                      direction: str = "outgoing") -> list[dict]:
        """Get neighboring nodes via edges.

        direction: 'outgoing' (source=this), 'incoming' (target=this), 'both'
        """
        results = []
        if direction in ("outgoing", "both"):
            q = "SELECT * FROM edges WHERE source_type = ? AND source_id = ?"
            params = [node_type, node_id]
            if edge_type:
                q += " AND edge_type = ?"
                params.append(edge_type.value)
            rows = self.conn.execute(q, params).fetchall()
            results.extend([dict(r) for r in rows])

        if direction in ("incoming", "both"):
            q = "SELECT * FROM edges WHERE target_type = ? AND target_id = ?"
            params = [node_type, node_id]
            if edge_type:
                q += " AND edge_type = ?"
                params.append(edge_type.value)
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
