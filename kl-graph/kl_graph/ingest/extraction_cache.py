"""SQLite-backed cache for Phase-A LLM extraction results.

Replaces the md5-sharded one-JSON-file-per-chunk cache with a separate,
bounded ``data/extraction_cache.db`` SQLite database. Keeping it separate from
``knowledge.db`` preserves expensive LLM results across graph/content database
rebuilds. Source-aware rows include a model/prompt/strategy/schema fingerprint;
legacy chunk-only keys remain readable for compatibility.

Design invariant (see ``docs/todo/archive/extraction-cache-hardening-2026-08-05.md``): the cache
holds only end-to-end-validated successful extractions. Failed/transient
outcomes are never written; hard stops raise loudly upstream. There is no
``status`` column — every row is valid by construction.

The store opens its own WAL connection and evicts least-recently-used rows when
the configured entry limit is exceeded.  Cache hits are touched in batches to
avoid turning a warm replay into one SQLite commit per chunk.  A one-time,
non-destructive migration imports the former ``knowledge.db.extraction_cache``
table when present.

Example:
    >>> store = ExtractionCacheStore(Path("data/extraction_cache.db"))
    >>> store.put({"entities": [], "facts": [], "_msg_id": "c1"}, "c1", "qwen")
    >>> store.get("c1", "qwen")
    {'entities': [], 'facts': [], '_msg_id': 'c1'}
    >>> store.close()
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# SQLite host-parameter ceiling on old builds is 999; chunk IN(...) lists well
# under it so we stay portable regardless of the linked SQLite version.
_IN_CHUNK = 500
_TOUCH_BATCH = 256
DEFAULT_MAX_ENTRIES = 100_000


class ExtractionCacheStore:
    """Synchronous SQLite store for validated LLM extraction results.

    All rows are successful extractions (the writer never persists a failure).
    Reads are model-scoped: a row produced by a different model id is treated
    as a miss so a model swap re-extracts cleanly rather than serving stale
    output.

    Args:
        db_path: Path to the dedicated SQLite cache database. Parent dirs are
            created automatically.
        max_entries: Hard row-count limit. Least-recently-used rows are evicted
            after writes so the cache cannot grow without bound.
        legacy_db_path: Optional former content database. Its extraction-cache
            rows are imported once without modifying the legacy database.
    """

    def __init__(
        self,
        db_path: Path,
        max_entries: int = DEFAULT_MAX_ENTRIES,
        legacy_db_path: Path | None = None,
    ):
        if max_entries <= 0:
            raise ValueError("max_entries must be greater than zero")
        self.db_path = Path(db_path)
        self.max_entries = int(max_entries)
        self._pending_touches: dict[str, int] = {}
        self._last_access_tick = time.time_ns()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # timeout doubles as the busy timeout so a concurrent writer waits
        # rather than raising "database is locked".
        self.conn = sqlite3.connect(
            str(self.db_path), timeout=30.0, check_same_thread=False
        )
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self._create_table()
        if legacy_db_path is not None:
            self._migrate_legacy_cache(Path(legacy_db_path))
        if self._evict_if_needed():
            self.conn.commit()

    def _create_table(self) -> None:
        """Create the ``extraction_cache`` table if it does not exist."""
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS extraction_cache (
                cache_key  TEXT PRIMARY KEY,
                chunk_id   TEXT NOT NULL,
                payload    TEXT NOT NULL,
                model      TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_accessed INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS cache_metadata (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        columns = {
            row["name"]
            for row in self.conn.execute(
                "PRAGMA table_info(extraction_cache)"
            ).fetchall()
        }
        if "last_accessed" not in columns:
            self.conn.execute(
                "ALTER TABLE extraction_cache "
                "ADD COLUMN last_accessed INTEGER NOT NULL DEFAULT 0"
            )
            self.conn.execute(
                "UPDATE extraction_cache SET last_accessed = updated_at "
                "WHERE last_accessed = 0"
            )
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_extraction_cache_lru "
            "ON extraction_cache(last_accessed, updated_at, cache_key)"
        )
        self.conn.commit()

    def _migrate_legacy_cache(self, legacy_db_path: Path) -> None:
        """Import the old ``knowledge.db`` cache once, without deleting it."""
        try:
            if legacy_db_path.resolve() == self.db_path.resolve():
                return
        except OSError:
            if legacy_db_path == self.db_path:
                return

        marker = "legacy-migration:" + hashlib.sha256(
            str(legacy_db_path.resolve()).encode()
        ).hexdigest()
        already_done = self.conn.execute(
            "SELECT 1 FROM cache_metadata WHERE key = ?", (marker,)
        ).fetchone()
        if already_done is not None:
            return

        if not legacy_db_path.exists():
            self._mark_migration_complete(marker)
            return

        legacy: sqlite3.Connection | None = None
        try:
            legacy = sqlite3.connect(str(legacy_db_path), timeout=30.0)
            legacy.row_factory = sqlite3.Row
            table = legacy.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type = 'table' AND name = 'extraction_cache'"
            ).fetchone()
            if table is None:
                self._mark_migration_complete(marker)
                return

            columns = {
                row["name"]
                for row in legacy.execute(
                    "PRAGMA table_info(extraction_cache)"
                ).fetchall()
            }
            access_column = (
                "last_accessed" if "last_accessed" in columns else "updated_at"
            )
            cursor = legacy.execute(
                "SELECT cache_key, chunk_id, payload, model, created_at, "
                f"updated_at, {access_column} AS last_accessed "
                "FROM extraction_cache"
            )
            before = self.count()
            while rows := cursor.fetchmany(1_000):
                self.conn.executemany(
                    """INSERT OR IGNORE INTO extraction_cache
                         (cache_key, chunk_id, payload, model, created_at,
                          updated_at, last_accessed)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    [
                        (
                            row["cache_key"],
                            row["chunk_id"],
                            row["payload"],
                            row["model"],
                            row["created_at"],
                            row["updated_at"],
                            row["last_accessed"],
                        )
                        for row in rows
                    ],
                )
            self._evict_if_needed()
            self.conn.execute(
                "INSERT OR REPLACE INTO cache_metadata(key, value) VALUES (?, ?)",
                (marker, str(int(time.time()))),
            )
            self.conn.commit()
            imported = self.count() - before
            if imported:
                logger.info(
                    "Imported %d extraction-cache rows from %s into %s",
                    imported,
                    legacy_db_path,
                    self.db_path,
                )
        except sqlite3.Error as exc:
            self.conn.rollback()
            logger.warning(
                "Could not migrate legacy extraction cache from %s: %s",
                legacy_db_path,
                exc,
            )
        finally:
            if legacy is not None:
                legacy.close()

    def _mark_migration_complete(self, marker: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO cache_metadata(key, value) VALUES (?, ?)",
            (marker, str(int(time.time()))),
        )
        self.conn.commit()

    # ─── Key derivation ───────────────────────────────────────────────────

    @staticmethod
    def cache_key(chunk_id: str, fingerprint: str | None = None) -> str:
        """Deterministic md5 key for an item id and contract fingerprint.

        MUST match ``LLMExtractor._cache_key`` so both keying schemes agree.

        Args:
            chunk_id: The chunk's ``id`` (``Chunk.id`` / ``_msg_id``).

        Returns:
            The md5 hex digest of the utf-8-encoded chunk id.
        """
        identity = chunk_id if fingerprint is None else f"{chunk_id}\0{fingerprint}"
        return hashlib.md5(identity.encode()).hexdigest()

    # ─── Reads ────────────────────────────────────────────────────────────

    def get(
        self, chunk_id: str, model: str, fingerprint: str | None = None
    ) -> dict | None:
        """Return the cached result for a chunk, or None on any miss.

        A miss is: no row, a row produced by a different ``model``, or a row
        whose payload no longer parses as JSON (self-healing — a corrupt row
        is re-extracted rather than crashing the run).

        Args:
            chunk_id: The chunk id to look up.
            model: The current model id; a row from another model is a miss.

        Returns:
            The stored extraction result dict, or None.
        """
        row = self.conn.execute(
            "SELECT payload, model FROM extraction_cache WHERE cache_key = ?",
            (self.cache_key(chunk_id, fingerprint),),
        ).fetchone()
        if row is None or row["model"] != model:
            return None
        parsed = self._parse_payload(row["payload"])
        if parsed is not None:
            self._queue_touch(self.cache_key(chunk_id, fingerprint))
        return parsed

    def get_many(
        self,
        chunk_ids: list[str],
        model: str,
        fingerprints: dict[str, str] | None = None,
    ) -> dict[str, dict]:
        """Return cached results for the given chunk ids, keyed by chunk_id.

        Only ``model``-matching rows with parsable payloads are included;
        anything else is simply absent (a miss). Queried in batches to stay
        under the SQLite host-parameter limit.

        Args:
            chunk_ids: Chunk ids to look up.
            model: The current model id; rows from another model are skipped.

        Returns:
            Mapping of chunk_id → extraction result dict for hits only.
        """
        results: dict[str, dict] = {}
        fingerprints = fingerprints or {}
        key_to_id = {
            self.cache_key(cid, fingerprints.get(cid)): cid for cid in chunk_ids
        }
        keys = list(key_to_id)
        for start in range(0, len(keys), _IN_CHUNK):
            batch = keys[start:start + _IN_CHUNK]
            placeholders = ",".join("?" for _ in batch)
            rows = self.conn.execute(
                f"SELECT cache_key, payload, model FROM extraction_cache "  # noqa: S608 - placeholders only
                f"WHERE cache_key IN ({placeholders})",
                batch,
            ).fetchall()
            for row in rows:
                if row["model"] != model:
                    continue
                parsed = self._parse_payload(row["payload"])
                if parsed is not None:
                    results[key_to_id[row["cache_key"]]] = parsed
                    self._queue_touch(row["cache_key"])
        return results

    def all_results(self, model: str) -> dict[str, dict]:
        """Return every cached result for ``model``, keyed by chunk_id.

        Used for the Phase-B full replay (replaces the directory glob). Rows
        from other models or with unparsable payloads are skipped.

        Args:
            model: The current model id.

        Returns:
            Mapping of chunk_id → extraction result dict.
        """
        results: dict[str, dict] = {}
        rows = self.conn.execute(
            "SELECT cache_key, chunk_id, payload FROM extraction_cache WHERE model = ?",
            (model,),
        ).fetchall()
        for row in rows:
            parsed = self._parse_payload(row["payload"])
            if parsed is not None:
                results[row["chunk_id"]] = parsed
                self._queue_touch(row["cache_key"])
        return results

    @staticmethod
    def _parse_payload(payload: str) -> dict | None:
        """Parse a stored payload, treating any decode failure as a miss."""
        try:
            data = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            return None
        return data if isinstance(data, dict) else None

    def _next_access_tick(self) -> int:
        """Return a process-local strictly increasing access timestamp."""
        self._last_access_tick = max(time.time_ns(), self._last_access_tick + 1)
        return self._last_access_tick

    def _queue_touch(self, cache_key: str) -> None:
        """Record an LRU touch, flushing periodically to limit write overhead."""
        self._pending_touches[cache_key] = self._next_access_tick()
        if len(self._pending_touches) >= _TOUCH_BATCH:
            self._flush_touches()

    def _flush_touches(self, *, commit: bool = True) -> None:
        if not self._pending_touches:
            return
        touches = list(self._pending_touches.items())
        self.conn.executemany(
            "UPDATE extraction_cache SET last_accessed = ? WHERE cache_key = ?",
            [(accessed, cache_key) for cache_key, accessed in touches],
        )
        self._pending_touches.clear()
        if commit:
            self.conn.commit()

    # ─── Writes ───────────────────────────────────────────────────────────

    def put(
        self,
        payload: dict,
        chunk_id: str,
        model: str,
        fingerprint: str | None = None,
    ) -> None:
        """Upsert one validated extraction result.

        Stores the FULL result dict (including ``_msg_*`` metadata the extractor
        annotates) as JSON — never sliced. On conflict the payload/model are
        refreshed and ``updated_at`` bumped; ``created_at`` is preserved.

        Args:
            payload: The full extraction result dict.
            chunk_id: The originating chunk id.
            model: The model id that produced the result.
        """
        self.put_many([(payload, chunk_id, fingerprint)], model)

    def put_many(
        self,
        items: list[tuple[dict, str] | tuple[dict, str, str | None]],
        model: str,
    ) -> None:
        """Upsert a batch of validated results in one transaction.

        Args:
            items: ``(payload_dict, chunk_id)`` pairs.
            model: The model id that produced every result in the batch.
        """
        if not items:
            return
        now = int(time.time())
        first_access = self._next_access_tick()
        normalized = [
            (item[0], item[1], item[2] if len(item) == 3 else None)
            for item in items
        ]
        rows = [
            (
                self.cache_key(chunk_id, fingerprint),
                chunk_id,
                json.dumps(payload, ensure_ascii=False),
                model,
                now,
                now,
                first_access + index,
            )
            for index, (payload, chunk_id, fingerprint) in enumerate(normalized)
        ]
        self._last_access_tick = first_access + len(items) - 1
        self._flush_touches(commit=False)
        self.conn.executemany(
            """INSERT INTO extraction_cache
                 (cache_key, chunk_id, payload, model, created_at, updated_at,
                  last_accessed)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(cache_key) DO UPDATE SET
                 chunk_id = excluded.chunk_id,
                 payload = excluded.payload,
                 model = excluded.model,
                 updated_at = MAX(excluded.updated_at, extraction_cache.updated_at + 1),
                 last_accessed = excluded.last_accessed""",
            rows,
        )
        self._evict_if_needed()
        self.conn.commit()

    def _evict_if_needed(self) -> int:
        """Evict least-recently-used rows until ``max_entries`` is satisfied."""
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM extraction_cache"
        ).fetchone()
        overflow = int(row["n"]) - self.max_entries
        if overflow <= 0:
            return 0
        self.conn.execute(
            """DELETE FROM extraction_cache
               WHERE cache_key IN (
                   SELECT cache_key FROM extraction_cache
                   ORDER BY last_accessed ASC, updated_at ASC, cache_key ASC
                   LIMIT ?
               )""",
            (overflow,),
        )
        logger.debug(
            "Evicted %d LRU extraction-cache rows (limit=%d)",
            overflow,
            self.max_entries,
        )
        return overflow

    # ─── Maintenance ──────────────────────────────────────────────────────

    def clear(self) -> None:
        """Delete every cached row (``keep_cache=False``)."""
        self._pending_touches.clear()
        self.conn.execute("DELETE FROM extraction_cache")
        self.conn.commit()

    def count(self) -> int:
        """Return the number of cached rows."""
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM extraction_cache"
        ).fetchone()
        return int(row["n"])

    def close(self) -> None:
        """Close the underlying connection."""
        self._flush_touches()
        self.conn.close()

    # ─── Context manager ──────────────────────────────────────────────────

    def __enter__(self) -> ExtractionCacheStore:
        return self

    def __exit__(self, *exc) -> None:
        self.close()
