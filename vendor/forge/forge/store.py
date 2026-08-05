#!/usr/bin/env python3
"""Local corpus store — the single source of truth for everything pulled from IM.

Everything is kept: every message from everyone, real sender names, real
conversation titles, real DingTalk ids, quoted text, mentions. The owner asked
for full local fidelity, and an agent cannot judge "should I reply to this"
without the other side's actual words and a real name to resolve.

The boundary is location, not content: this database lives at 600 inside a 700
data root and is never published or shared. `forge scan` enforces that what
*does* get published (the skill) carries no raw ids and no credentials.

Only exception to "keep everything": credentials are scrubbed on write
(common.scrub_secrets) — a secret in a local corpus is still a leaked secret.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from . import common as C
from .runtime import SCHEMA_VERSION, parse_ts

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  single_chat     INTEGER NOT NULL DEFAULT 0,
  peer_open_id    TEXT NOT NULL DEFAULT '',   -- single chats: the other person
  peer_name       TEXT NOT NULL DEFAULT '',
  member_count    INTEGER NOT NULL DEFAULT 0,
  muted           INTEGER NOT NULL DEFAULT 0,
  first_seen_at   TEXT NOT NULL DEFAULT '',
  last_msg_at     TEXT NOT NULL DEFAULT '',
  msg_count       INTEGER NOT NULL DEFAULT 0,
  self_msg_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS people (
  person_id     TEXT PRIMARY KEY,             -- openDingTalkId
  name          TEXT NOT NULL DEFAULT '',
  nick          TEXT NOT NULL DEFAULT '',
  alias         TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  user_id       TEXT NOT NULL DEFAULT '',
  msgs_from     INTEGER NOT NULL DEFAULT 0,
  msgs_to       INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT '',
  last_seen_at  TEXT NOT NULL DEFAULT '',
  tone_band     TEXT NOT NULL DEFAULT '',
  relationship  TEXT NOT NULL DEFAULT '',
  sensitive     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL DEFAULT '',
  sender_name     TEXT NOT NULL DEFAULT '',
  is_self         INTEGER NOT NULL DEFAULT 0,
  is_agent_sent   INTEGER NOT NULL DEFAULT 0,  -- sent by this tooling, not the owner
  occurred_at     TEXT NOT NULL DEFAULT '',
  epoch           REAL NOT NULL DEFAULT 0,
  msg_type        TEXT NOT NULL DEFAULT 'text',
  text            TEXT NOT NULL DEFAULT '',
  clean_text      TEXT NOT NULL DEFAULT '',    -- mention prefixes stripped
  codepoints      INTEGER NOT NULL DEFAULT 0,
  is_pasted       INTEGER NOT NULL DEFAULT 0,    -- machine output, not their prose
  quoted_text     TEXT NOT NULL DEFAULT '',
  quoted_sender   TEXT NOT NULL DEFAULT '',
  mentions_self   INTEGER NOT NULL DEFAULT 0,
  scene           TEXT NOT NULL DEFAULT 'unknown',
  thread_id       TEXT NOT NULL DEFAULT ''
);

-- (context -> my reply) pairs: the accuracy core for imitation.
CREATE TABLE IF NOT EXISTS turns (
  turn_key        TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  single_chat     INTEGER NOT NULL DEFAULT 0,
  peer_name       TEXT NOT NULL DEFAULT '',
  tone_band       TEXT NOT NULL DEFAULT '',
  scene           TEXT NOT NULL DEFAULT 'unknown',
  ask_kind        TEXT NOT NULL DEFAULT '',
  context_text    TEXT NOT NULL DEFAULT '',
  my_reply        TEXT NOT NULL DEFAULT '',
  latency_seconds REAL NOT NULL DEFAULT -1,
  occurred_at     TEXT NOT NULL DEFAULT ''
);

-- Incoming asks, whether or not the owner answered. This is what makes decision
-- mining possible: silence is data, and only visible here.
CREATE TABLE IF NOT EXISTS asks (
  ask_key         TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  single_chat     INTEGER NOT NULL DEFAULT 0,
  asker_name      TEXT NOT NULL DEFAULT '',
  asker_id        TEXT NOT NULL DEFAULT '',
  tone_band       TEXT NOT NULL DEFAULT '',
  ask_kind        TEXT NOT NULL DEFAULT '',
  addressed_self  INTEGER NOT NULL DEFAULT 0,
  risk_tags       TEXT NOT NULL DEFAULT '',
  ask_text        TEXT NOT NULL DEFAULT '',
  answered        INTEGER NOT NULL DEFAULT 0,
  reply_text      TEXT NOT NULL DEFAULT '',
  latency_seconds REAL NOT NULL DEFAULT -1,
  occurred_at     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_msg_conv   ON messages(conversation_id, epoch);
CREATE INDEX IF NOT EXISTS idx_msg_self   ON messages(is_self, epoch);
CREATE INDEX IF NOT EXISTS idx_msg_scene  ON messages(scene);
CREATE INDEX IF NOT EXISTS idx_turn_scene ON turns(scene, tone_band);
CREATE INDEX IF NOT EXISTS idx_turn_peer  ON turns(peer_name);
CREATE INDEX IF NOT EXISTS idx_ask_kind   ON asks(ask_kind, answered);
CREATE INDEX IF NOT EXISTS idx_ask_peer   ON asks(asker_name);
"""

FTS = """
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  clean_text, content='messages', content_rowid='rowid', tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  context_text, content='turns', content_rowid='rowid', tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS asks_fts USING fts5(
  ask_text, content='asks', content_rowid='rowid', tokenize='trigram');
"""


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Additive migrations for a corpus created by an earlier version.

    A 100k-message corpus takes an hour of paced API calls to rebuild, so schema
    changes must be applied in place rather than forcing a re-pull. Only additive
    changes belong here; anything destructive should be a new schemaVersion with
    an explicit rebuild.
    """
    applied: list[str] = []
    have = {r["name"] for r in conn.execute("PRAGMA table_info(messages)")}
    if "is_pasted" not in have:
        conn.execute("ALTER TABLE messages ADD COLUMN is_pasted INTEGER NOT NULL DEFAULT 0")
        applied.append("messages.is_pasted")
    if applied:
        set_meta(conn, "schemaVersion", str(SCHEMA_VERSION))
        conn.commit()
    return applied


def open_db(path: Path, create: bool = True, timeout_ms: int = 60000) -> sqlite3.Connection:
    if create:
        C.secure_mkdir(path.parent)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    # A build is one long write transaction and a pull may hold the lock for a
    # while. Waiting is almost always what the operator wants; failing instantly
    # is not.
    conn.execute(f"PRAGMA busy_timeout = {int(timeout_ms)}")
    conn.execute("PRAGMA temp_store = MEMORY")
    if create:
        conn.executescript(SCHEMA)
        conn.executescript(FTS)
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('schemaVersion',?)",
                     (str(SCHEMA_VERSION),))
        conn.commit()
        import os
        os.chmod(path, 0o600)
    else:
        migrate(conn)
    return conn


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, str(value)))


def get_meta(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def schema_ok(conn: sqlite3.Connection) -> bool:
    return get_meta(conn, "schemaVersion") == str(SCHEMA_VERSION)


# ---------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------

def upsert_conversation(conn: sqlite3.Connection, conv: dict) -> None:
    conn.execute("""
        INSERT INTO conversations(conversation_id,title,single_chat,peer_open_id,
            peer_name,member_count,muted,first_seen_at,last_msg_at)
        VALUES(:conversation_id,:title,:single_chat,:peer_open_id,:peer_name,
            :member_count,:muted,:last_msg_at,:last_msg_at)
        ON CONFLICT(conversation_id) DO UPDATE SET
            title=CASE WHEN excluded.title!='' THEN excluded.title ELSE conversations.title END,
            single_chat=excluded.single_chat,
            peer_open_id=CASE WHEN excluded.peer_open_id!='' THEN excluded.peer_open_id ELSE conversations.peer_open_id END,
            peer_name=CASE WHEN excluded.peer_name!='' THEN excluded.peer_name ELSE conversations.peer_name END,
            member_count=MAX(excluded.member_count, conversations.member_count),
            muted=excluded.muted,
            last_msg_at=MAX(excluded.last_msg_at, conversations.last_msg_at)
    """, {
        "conversation_id": conv["conversationId"],
        "title": conv.get("title", ""),
        "single_chat": int(bool(conv.get("singleChat"))),
        "peer_open_id": conv.get("peerOpenId", ""),
        "peer_name": conv.get("peerName", ""),
        "member_count": int(conv.get("memberCount") or 0),
        "muted": int(bool(conv.get("muted"))),
        "last_msg_at": conv.get("lastMsgAt", ""),
    })


def upsert_person(conn: sqlite3.Connection, person: dict) -> None:
    conn.execute("""
        INSERT INTO people(person_id,name,nick,alias,title,user_id,first_seen_at,last_seen_at)
        VALUES(:person_id,:name,:nick,:alias,:title,:user_id,:seen,:seen)
        ON CONFLICT(person_id) DO UPDATE SET
            name=CASE WHEN excluded.name!='' THEN excluded.name ELSE people.name END,
            nick=CASE WHEN excluded.nick!='' THEN excluded.nick ELSE people.nick END,
            alias=CASE WHEN excluded.alias!='' THEN excluded.alias ELSE people.alias END,
            title=CASE WHEN excluded.title!='' THEN excluded.title ELSE people.title END,
            user_id=CASE WHEN excluded.user_id!='' THEN excluded.user_id ELSE people.user_id END,
            last_seen_at=MAX(excluded.last_seen_at, people.last_seen_at)
    """, {
        "person_id": person["personId"],
        "name": person.get("name", ""), "nick": person.get("nick", ""),
        "alias": person.get("alias", ""), "title": person.get("title", ""),
        "user_id": person.get("userId", ""), "seen": person.get("seenAt", ""),
    })


def insert_message(conn: sqlite3.Connection, msg: dict, self_ids: set[str],
                   agent_sent: set[str], aliases: set[str]) -> bool:
    """Insert one normalized message. Returns True if newly inserted.

    Text is stored as-is apart from credential scrubbing. `clean_text` strips
    @mention prefixes so style analysis is not polluted by other people's names.
    """
    text = C.scrub_secrets(C.norm(msg.get("text", "")))
    clean = C.strip_mentions(text)
    mid = msg.get("messageId") or ""
    if not mid:
        return False
    is_self = int(bool(msg.get("senderId")) and msg["senderId"] in self_ids)
    cur = conn.execute("""
        INSERT OR IGNORE INTO messages(message_id,conversation_id,sender_id,sender_name,
            is_self,is_agent_sent,occurred_at,epoch,msg_type,text,clean_text,codepoints,
            is_pasted,quoted_text,quoted_sender,mentions_self,scene,thread_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        mid, msg.get("conversationId", ""), msg.get("senderId", ""),
        msg.get("senderName", ""), is_self, int(mid in agent_sent),
        msg.get("createdAt", ""), parse_ts(msg.get("createdAt", "")),
        msg.get("msgType", "text"), text, clean, C.cp_len(clean),
        int(C.is_pasted_output(clean)),
        C.scrub_secrets(C.norm(msg.get("quotedText", ""))),
        msg.get("quotedSenderName", ""),
        int(any(f"@{a}" in text for a in aliases if a)),
        "unknown", msg.get("threadId", ""),
    ))
    return cur.rowcount > 0


def rebuild_fts(conn: sqlite3.Connection) -> None:
    """Rebuild FTS from the content tables.

    These are external-content FTS5 tables, so the only correct way to resync is
    the built-in 'rebuild' command — DELETE/INSERT corrupts the index because the
    rows it references live in the content table, not in FTS.
    """
    for name in ("messages_fts", "turns_fts", "asks_fts"):
        conn.execute(f"INSERT INTO {name}({name}) VALUES('rebuild')")
    conn.commit()


def link_direct_peers(conn: sqlite3.Connection, self_ids: set[str]) -> int:
    """Set `peer_open_id` for single chats from who actually sent messages.

    In a two-party chat the peer is simply the sender who is not the owner —
    unambiguous, unlike the directory's `ownerOpenDingtalkId`, which DingTalk
    fills with the same placeholder for every 1:1 thread. Trusting that field
    collapsed all 57 direct chats onto one fabricated person, zeroing every real
    collaborator's reciprocity and inverting the tone bands.

    Any id that appears as the "peer" of several single chats is therefore
    rejected as a placeholder and cleared, so a future upstream change cannot
    reintroduce the same corruption silently.
    """
    if not self_ids:
        return 0

    # Clear placeholder peers: one id claiming to be the other party in more than
    # two distinct 1:1 threads is not a person.
    bogus = [r["peer_open_id"] for r in conn.execute("""
        SELECT peer_open_id, COUNT(*) n FROM conversations
        WHERE single_chat=1 AND peer_open_id!=''
        GROUP BY peer_open_id HAVING n > 2""")]
    if bogus:
        conn.executemany("UPDATE conversations SET peer_open_id='' WHERE peer_open_id=?",
                         [(b,) for b in bogus])
        conn.executemany("DELETE FROM people WHERE person_id=?", [(b,) for b in bogus])
        conn.commit()

    placeholders = ",".join("?" for _ in self_ids)
    rows = conn.execute(f"""
        SELECT c.conversation_id,
               (SELECT m.sender_id FROM messages m
                 WHERE m.conversation_id = c.conversation_id
                   AND m.sender_id != '' AND m.sender_id NOT IN ({placeholders})
                 GROUP BY m.sender_id ORDER BY COUNT(*) DESC LIMIT 1) AS peer,
               (SELECT m.sender_name FROM messages m
                 WHERE m.conversation_id = c.conversation_id
                   AND m.sender_id != '' AND m.sender_id NOT IN ({placeholders})
                 GROUP BY m.sender_id ORDER BY COUNT(*) DESC LIMIT 1) AS peer_name
        FROM conversations c
        WHERE c.single_chat = 1 AND c.peer_open_id = ''
    """, (*self_ids, *self_ids)).fetchall()

    updates = [(r["peer"], r["peer_name"] or "", r["conversation_id"])
               for r in rows if r["peer"]]
    if updates:
        conn.executemany(
            "UPDATE conversations SET peer_open_id=?, "
            "peer_name=CASE WHEN peer_name='' THEN ? ELSE peer_name END "
            "WHERE conversation_id=?", updates)
        conn.commit()
    return len(updates)


def backfill_pasted(conn: sqlite3.Connection) -> int:
    """Classify pasted machine output in a corpus written before the flag existed.

    Runs on build so an existing corpus does not need a re-pull.
    """
    rows = conn.execute(
        "SELECT message_id, clean_text FROM messages "
        "WHERE is_pasted=0 AND LENGTH(clean_text) >= 40").fetchall()
    updates = [(r["message_id"],) for r in rows if C.is_pasted_output(r["clean_text"])]
    for i in range(0, len(updates), 5000):
        conn.executemany("UPDATE messages SET is_pasted=1 WHERE message_id=?",
                         updates[i:i + 5000])
        conn.commit()
    return len(updates)


def refresh_counts(conn: sqlite3.Connection) -> None:
    conn.execute("""
        UPDATE conversations SET
          msg_count = (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conversations.conversation_id),
          self_msg_count = (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conversations.conversation_id AND m.is_self=1)
    """)
    conn.execute("""
        UPDATE people SET
          msgs_from = (SELECT COUNT(*) FROM messages m WHERE m.sender_id = people.person_id)
    """)
    # msgs_to: owner messages in conversations where this person is the peer or a
    # participant — for 1:1 that is exact; for groups it is participation volume.
    conn.execute("""
        UPDATE people SET msgs_to = (
          SELECT COUNT(*) FROM messages m
          JOIN conversations c ON c.conversation_id = m.conversation_id
          WHERE m.is_self=1 AND c.peer_open_id = people.person_id)
    """)
    conn.commit()


def verify(conn: sqlite3.Connection) -> dict:
    checks = []

    def ck(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "passed": bool(ok), "detail": detail})

    ck("schema version", schema_ok(conn), get_meta(conn, "schemaVersion"))
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    ck("integrity", integrity == "ok", integrity)
    orphans = conn.execute(
        "SELECT COUNT(*) c FROM messages m LEFT JOIN conversations c "
        "ON c.conversation_id=m.conversation_id WHERE c.conversation_id IS NULL"
    ).fetchone()["c"]
    ck("no orphan messages", orphans == 0, f"{orphans} orphans")
    leaked = conn.execute(
        "SELECT COUNT(*) c FROM messages WHERE text LIKE '%glpat-%' "
        "OR text LIKE '%-----BEGIN%'").fetchone()["c"]
    ck("no credentials in corpus", leaked == 0, f"{leaked} hits")
    self_n = conn.execute("SELECT COUNT(*) c FROM messages WHERE is_self=1").fetchone()["c"]
    ck("self corpus non-empty", self_n > 0, f"{self_n} self messages")
    return {"checks": checks, "ok": all(c["passed"] for c in checks)}


def stats(conn: sqlite3.Connection) -> dict:
    def one(sql: str, *p):
        row = conn.execute(sql, p).fetchone()
        return row[0] if row else 0
    return {
        "messages": one("SELECT COUNT(*) FROM messages"),
        "selfMessages": one("SELECT COUNT(*) FROM messages WHERE is_self=1"),
        "agentSent": one("SELECT COUNT(*) FROM messages WHERE is_agent_sent=1"),
        "conversations": one("SELECT COUNT(*) FROM conversations"),
        "people": one("SELECT COUNT(*) FROM people"),
        "turns": one("SELECT COUNT(*) FROM turns"),
        "asks": one("SELECT COUNT(*) FROM asks"),
        "asksAnswered": one("SELECT COUNT(*) FROM asks WHERE answered=1"),
        "earliest": one("SELECT MIN(occurred_at) FROM messages WHERE occurred_at!=''") or "",
        "latest": one("SELECT MAX(occurred_at) FROM messages WHERE occurred_at!=''") or "",
        "lastPullAt": get_meta(conn, "lastPullAt"),
        "pulledThrough": get_meta(conn, "pulledThrough"),
    }
