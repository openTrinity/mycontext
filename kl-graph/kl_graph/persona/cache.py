"""Independent SQLite cache for derived persona features and profiles."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from kl_graph.persona.config import PersonaSettings


class PersonaStore:
    """Own the rebuildable persona database without mutating the graph."""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self._create_tables()

    def _create_tables(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ego_features (
                entity_id TEXT NOT NULL,
                context_id TEXT NOT NULL DEFAULT '',
                entity_type TEXT NOT NULL,
                features TEXT NOT NULL,
                features_at_render TEXT,
                last_updated INTEGER NOT NULL,
                msg_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (entity_id, context_id, entity_type)
            );

            CREATE TABLE IF NOT EXISTS ego_profiles (
                entity_id TEXT NOT NULL,
                profile_type TEXT NOT NULL,
                content TEXT NOT NULL,
                render_timestamp INTEGER NOT NULL,
                render_version INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (entity_id, profile_type)
            );

            CREATE TABLE IF NOT EXISTS ego_archetypes (
                archetype_id INTEGER PRIMARY KEY,
                style_spec TEXT NOT NULL DEFAULT '',
                centroid TEXT NOT NULL DEFAULT '[]',
                member_entity_ids TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                version INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS persona_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_ego_features_type
                ON ego_features(entity_type);
            CREATE INDEX IF NOT EXISTS idx_ego_profiles_type
                ON ego_profiles(profile_type);
            """
        )
        self.conn.commit()

    def bind_owner(self, settings: PersonaSettings) -> None:
        """Prevent one cache from silently mixing multiple owners' features."""

        identity = json.dumps(
            {
                "owner_name": settings.owner_name,
                "owner_sender_id": settings.owner_sender_id,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        row = self.conn.execute(
            "SELECT value FROM persona_meta WHERE key='owner_identity'"
        ).fetchone()
        if row and row["value"] != identity:
            raise ValueError(
                "persona.db belongs to a different owner; remove it or select "
                "a different persona database"
            )
        self.conn.execute(
            "INSERT OR IGNORE INTO persona_meta(key, value) VALUES ('owner_identity', ?)",
            (identity,),
        )
        self.conn.commit()

    def upsert_features(
        self,
        entity_id: str,
        entity_type: str,
        features: dict[str, Any],
        msg_count: int,
        context_id: str = "",
    ) -> None:
        now_ms = int(time.time() * 1000)
        self.conn.execute(
            """
            INSERT INTO ego_features
                (entity_id, context_id, entity_type, features, last_updated, msg_count)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity_id, context_id, entity_type) DO UPDATE SET
                features=excluded.features,
                last_updated=excluded.last_updated,
                msg_count=excluded.msg_count
            """,
            (
                entity_id,
                context_id,
                entity_type,
                json.dumps(features, ensure_ascii=False, sort_keys=True),
                now_ms,
                msg_count,
            ),
        )
        self.conn.commit()

    def get_features(
        self, entity_id: str, entity_type: str, context_id: str = ""
    ) -> dict[str, Any] | None:
        row = self.conn.execute(
            """SELECT features FROM ego_features
               WHERE entity_id=? AND context_id=? AND entity_type=?""",
            (entity_id, context_id, entity_type),
        ).fetchone()
        return json.loads(row["features"]) if row else None

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "PersonaStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
