"""SQLite-backed cache for Phase-A LLM extraction results.

Replaces the md5-sharded one-JSON-file-per-chunk cache with a single
``extraction_cache`` table (living inside ``data/knowledge.db`` in production,
a tmp file under test). Keyed by ``md5(chunk_id)`` — the exact digest the
extractor used for its file paths — so the same chunk resolves to the same row.

Design invariant (see ``docs/todo/archive/extraction-cache-hardening-2026-08-05.md``): the cache
holds only end-to-end-validated successful extractions. Failed/transient
outcomes are never written; hard stops raise loudly upstream. There is no
``status`` column — every row is valid by construction.

The store opens its OWN WAL connection to the given db file so its lifecycle
is decoupled from ``SQLiteStore``; ``CREATE TABLE IF NOT EXISTS`` touches only
its own table, so ``--extract-only`` runs work before graph tables exist. WAL
+ a 30s busy timeout + single-statement UPSERTs make it safe for the two
writer processes this project runs (CLI ingest + server background ingest).

Example:
    >>> store = ExtractionCacheStore(Path("data/knowledge.db"))
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


class ExtractionCacheStore:
    """Synchronous SQLite store for validated LLM extraction results.

    All rows are successful extractions (the writer never persists a failure).
    Reads are model-scoped: a row produced by a different model id is treated
    as a miss so a model swap re-extracts cleanly rather than serving stale
    output.

    Args:
        db_path: Path to the SQLite database file (production:
            ``config.SQLITE_PATH``; tests: a tmp file). Parent dirs are created.
    """

    def __init__(self, db_path: Path):
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        # timeout doubles as the busy timeout so a concurrent writer waits
        # rather than raising "database is locked".
        self.conn = sqlite3.connect(str(db_path), timeout=30.0, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self._create_table()

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
                updated_at INTEGER NOT NULL
            );
            """
        )
        self.conn.commit()

    # ─── Key derivation ───────────────────────────────────────────────────

    @staticmethod
    def cache_key(chunk_id: str) -> str:
        """Deterministic md5 key for a chunk id.

        MUST match ``LLMExtractor._cache_key`` so both keying schemes agree.

        Args:
            chunk_id: The chunk's ``id`` (``Chunk.id`` / ``_msg_id``).

        Returns:
            The md5 hex digest of the utf-8-encoded chunk id.
        """
        return hashlib.md5(chunk_id.encode()).hexdigest()

    # ─── Reads ────────────────────────────────────────────────────────────

    def get(self, chunk_id: str, model: str) -> dict | None:
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
            (self.cache_key(chunk_id),),
        ).fetchone()
        if row is None or row["model"] != model:
            return None
        return self._parse_payload(row["payload"])

    def get_many(self, chunk_ids: list[str], model: str) -> dict[str, dict]:
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
        keys = [self.cache_key(cid) for cid in chunk_ids]
        for start in range(0, len(keys), _IN_CHUNK):
            batch = keys[start:start + _IN_CHUNK]
            placeholders = ",".join("?" for _ in batch)
            rows = self.conn.execute(
                f"SELECT chunk_id, payload, model FROM extraction_cache "  # noqa: S608 - placeholders only
                f"WHERE cache_key IN ({placeholders})",
                batch,
            ).fetchall()
            for row in rows:
                if row["model"] != model:
                    continue
                parsed = self._parse_payload(row["payload"])
                if parsed is not None:
                    results[row["chunk_id"]] = parsed
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
        cursor = self.conn.execute(
            "SELECT chunk_id, payload FROM extraction_cache WHERE model = ?",
            (model,),
        )
        for row in cursor:
            parsed = self._parse_payload(row["payload"])
            if parsed is not None:
                results[row["chunk_id"]] = parsed
        return results

    @staticmethod
    def _parse_payload(payload: str) -> dict | None:
        """Parse a stored payload, treating any decode failure as a miss."""
        try:
            data = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            return None
        return data if isinstance(data, dict) else None

    # ─── Writes ───────────────────────────────────────────────────────────

    def put(self, payload: dict, chunk_id: str, model: str) -> None:
        """Upsert one validated extraction result.

        Stores the FULL result dict (including ``_msg_*`` metadata the extractor
        annotates) as JSON — never sliced. On conflict the payload/model are
        refreshed and ``updated_at`` bumped; ``created_at`` is preserved.

        Args:
            payload: The full extraction result dict.
            chunk_id: The originating chunk id.
            model: The model id that produced the result.
        """
        self.put_many([(payload, chunk_id)], model)

    def put_many(self, items: list[tuple[dict, str]], model: str) -> None:
        """Upsert a batch of validated results in one transaction.

        Args:
            items: ``(payload_dict, chunk_id)`` pairs.
            model: The model id that produced every result in the batch.
        """
        if not items:
            return
        now = int(time.time())
        rows = [
            (
                self.cache_key(chunk_id),
                chunk_id,
                json.dumps(payload, ensure_ascii=False),
                model,
                now,
                now,
            )
            for payload, chunk_id in items
        ]
        self.conn.executemany(
            """INSERT INTO extraction_cache
                 (cache_key, chunk_id, payload, model, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(cache_key) DO UPDATE SET
                 chunk_id = excluded.chunk_id,
                 payload = excluded.payload,
                 model = excluded.model,
                 updated_at = MAX(excluded.updated_at, extraction_cache.updated_at + 1)""",
            rows,
        )
        self.conn.commit()

    # ─── Maintenance ──────────────────────────────────────────────────────

    def clear(self) -> None:
        """Delete every cached row (``keep_cache=False``)."""
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
        self.conn.close()

    # ─── Context manager ──────────────────────────────────────────────────

    def __enter__(self) -> ExtractionCacheStore:
        return self

    def __exit__(self, *exc) -> None:
        self.close()
