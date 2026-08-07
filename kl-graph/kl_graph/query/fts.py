"""Sparse (BM25) keyword retrieval via SQLite FTS5 + jieba.

kl-graph's vector search is dense-only (semantic), which can miss exact rare
tokens — error codes, IDs, unusual names — that a lexical channel nails. This
module adds RAGFlow Path 1's missing sparse channel using infrastructure already
present: SQLite (FTS5, built in) + jieba (already a dependency).

Approach ("pre-segmentation"): jieba splits Chinese into words in Python, we
store the space-joined tokens in an FTS5 virtual table, and FTS5's default
tokenizer indexes them and scores with its built-in ``bm25()``. No compiled
extension, no external search engine.

The index is a **mirror** of ``messages.content`` / ``facts.text`` held in
``*_fts`` virtual tables. It is rebuilt from scratch (see :func:`build_fts_index`)
so it always reflects current data; callers typically build it once at engine
init, like the PageRank prior.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import time

logger = logging.getLogger(__name__)

# FTS mirror tables (separate from the real messages/facts tables).
_MESSAGES_FTS = "messages_fts"
_FACTS_FTS = "facts_fts"

# Strip characters that are FTS5 MATCH operators/syntax so a user query can't
# inject query-language tokens (", *, (), ^, :, -, OR/AND/NOT, etc.).
_FTS_SPECIAL = re.compile(r'["*():^~\-]+')

# A usable FTS token must contain at least one word character (Unicode-aware, so
# CJK counts). Drops punctuation-only tokens like "?", "，", "？" that jieba emits
# and that FTS5 would otherwise parse as MATCH operators.
_HAS_WORD = re.compile(r"\w", re.UNICODE)


def _segment(text: str) -> str:
    """jieba word-segmentation -> space-joined tokens for FTS5.

    Imported lazily so the module loads even where jieba is absent (the sparse
    channel is then simply disabled by the caller).
    """
    import jieba

    return " ".join(jieba.cut(text or ""))


def build_fts_index(conn: sqlite3.Connection) -> bool:
    """(Re)build the jieba-segmented FTS5 mirror of messages and facts.

    Drops any existing mirror tables and repopulates them from the current
    ``messages`` / ``facts`` rows. Safe to call repeatedly. Does not touch the
    source tables or their schema.

    Args:
        conn: Open SQLite connection (the same one the engine queries).

    Returns:
        True if the index was built; False if unavailable (no FTS5 support or
        jieba missing), in which case the sparse channel should be skipped.
    """
    t0 = time.time()
    try:
        # Fail fast if this SQLite build lacks FTS5.
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)")
        conn.execute("DROP TABLE IF EXISTS _fts_probe")
    except sqlite3.OperationalError as e:
        logger.warning(f"FTS5 unavailable, sparse channel disabled: {e}")
        return False

    try:
        _segment("探测")  # ensure jieba imports before we build anything
    except Exception as e:  # noqa: BLE001
        logger.warning(f"jieba unavailable, sparse channel disabled: {e}")
        return False

    conn.execute(f"DROP TABLE IF EXISTS {_MESSAGES_FTS}")
    conn.execute(f"DROP TABLE IF EXISTS {_FACTS_FTS}")
    conn.execute(
        f"CREATE VIRTUAL TABLE {_MESSAGES_FTS} USING fts5("
        f"id UNINDEXED, content_seg, tokenize='unicode61')"
    )
    conn.execute(
        f"CREATE VIRTUAL TABLE {_FACTS_FTS} USING fts5("
        f"id UNINDEXED, text_seg, tokenize='unicode61')"
    )

    msg_rows = conn.execute("SELECT id, content FROM chunks").fetchall()
    conn.executemany(
        f"INSERT INTO {_MESSAGES_FTS}(id, content_seg) VALUES (?, ?)",
        [(r[0], _segment(r[1])) for r in msg_rows],
    )
    fact_rows = conn.execute("SELECT id, text FROM facts").fetchall()
    conn.executemany(
        f"INSERT INTO {_FACTS_FTS}(id, text_seg) VALUES (?, ?)",
        [(r[0], _segment(r[1])) for r in fact_rows],
    )
    conn.commit()

    logger.info(
        f"FTS index built: {len(msg_rows)} chunks, {len(fact_rows)} facts, "
        f"{time.time() - t0:.1f}s"
    )
    return True


def _search(
    conn: sqlite3.Connection, table: str, query: str, limit: int
) -> list[tuple[str, float]]:
    """Run a BM25 query against one FTS mirror table.

    Returns ``[(id, score), ...]`` with score descending (higher = better).
    FTS5's ``bm25()`` returns negative values where more-negative is better, so
    we negate to align with the vector channels' higher-is-better convention.
    """
    q_seg = _segment(query)
    # Keep only tokens with a word char, then wrap each as an FTS5 string literal
    # (double-quoted, internal quotes doubled) so no leftover punctuation or
    # keyword can be interpreted as MATCH syntax.
    tokens = [
        t for t in _FTS_SPECIAL.sub(" ", q_seg).split() if _HAS_WORD.search(t)
    ]
    if not tokens:
        return []
    match_expr = " OR ".join('"' + t.replace('"', '""') + '"' for t in tokens)
    try:
        rows = conn.execute(
            f"SELECT id, bm25({table}) AS score FROM {table} "
            f"WHERE {table} MATCH ? ORDER BY score LIMIT ?",
            (match_expr, limit),
        ).fetchall()
    except sqlite3.OperationalError as e:
        logger.warning(f"FTS query failed on {table}: {e}")
        return []
    return [(r[0], -float(r[1])) for r in rows]


def search_messages(
    conn: sqlite3.Connection, query: str, limit: int = 20
) -> list[tuple[str, float]]:
    """BM25 keyword search over messages. Returns ``[(msg_id, score), ...]``."""
    return _search(conn, _MESSAGES_FTS, query, limit)


def search_facts(
    conn: sqlite3.Connection, query: str, limit: int = 20
) -> list[tuple[str, float]]:
    """BM25 keyword search over facts. Returns ``[(fact_id, score), ...]``."""
    return _search(conn, _FACTS_FTS, query, limit)
