#!/usr/bin/env python3
"""MyContext vault — read the corpus a desktop app already collected.

The forge's other adapters pull from a platform. This one does not pull at all:
it projects an existing normalized corpus, the SQLite vault written by the
MyContext desktop app (`<userData>/vaults/<id>/core.sqlite`), into the shape
`ingest.pull` expects.

## Why this is an adapter and not an importer

`ingest.pull` already does everything that has to happen after reading: it
upserts the directory, registers people, derives `is_self` from the owner's id
set, links 1:1 peers, strips mention prefixes, scrubs credentials, and rebuilds
FTS. Writing a separate loader would duplicate all of it and — because the
duplicate would drift — eventually disagree with it. Implementing the source
protocol instead means the vault path and the JSONL path run the same code, so a
bug in one is a bug in both and gets found.

The consequence to keep in mind: this adapter is read-only in the strict sense.
It opens the vault with `mode=ro` and never writes to it. The app owns that file;
the forge owns its own corpus database.

## The one field this adapter must not guess: is_self

The vault's `messages.is_self` is nullable and **NULL means "not yet judged"**,
not "somebody else". The app writes NULL for every message collected before the
owner confirmed their identity, then backfills. MyContext' own schema comment
spells out why the distinction matters: marking the owner's messages as another
person's is unrecoverable, because nothing downstream can tell them apart again.

So rows with `is_self IS NULL` are **excluded and counted**, never coerced to 0.
`stats()` reports the count and `pull` promotes it into `complete: false`, which
is what stops "the owner had not confirmed their identity yet" from looking
exactly like "this person does not talk much".

Note that `insert_message` re-derives `is_self` from `senderId in openIds`
rather than trusting a flag we pass. That is a feature, not a redundancy: the
identity set comes from the vault's own `channel_self_identity` table, so the
two agree by construction, and the derivation stays the single implementation
for every source.

## Timestamps

The vault stores `sent_at` as unix milliseconds; the forge compares wall-clock
strings lexicographically. Converting requires a timezone, and reading the
running process's zone would make the same corpus measure differently on a
laptop that travelled — every latency and every active-hour bucket would shift.
So the offset is explicit (`timezoneOffset` in config, default +08:00, matching
the app's own `offsetMinutes` default) and applied here, at the boundary.
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
from pathlib import Path
from typing import Iterator

from . import BaseSource

#: Vault rows whose text is empty carry no style or decision signal, but they do
#: carry a timestamp — so they are skipped for analysis while still counted, to
#: keep "this window had only images" distinguishable from "this window failed".
_EMPTY_TEXT_TYPES = ("image", "file", "audio", "video")


def _offset_minutes(offset: str) -> int:
    """"+08:00" → 480. Rejects anything unparseable rather than defaulting to 0.

    Silently falling back to UTC would shift every timestamp by the operator's
    real offset — a wrong answer that looks like a working one, which is the
    failure shape this forge refuses everywhere else.
    """
    text = (offset or "").strip()
    if not text:
        raise SystemExit("the vault source needs a timezone offset like +08:00")
    sign = 1
    if text[0] in "+-":
        sign = -1 if text[0] == "-" else 1
        text = text[1:]
    parts = text.split(":") if ":" in text else [text[:2], text[2:]]
    try:
        hours = int(parts[0])
        minutes = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    except ValueError:
        raise SystemExit(
            f"cannot read timezone offset {offset!r}; expected a form like +08:00")
    return sign * (hours * 60 + minutes)


class VaultSource(BaseSource):
    KIND = "vault"
    PLATFORM_LABEL = "MyContext vault"
    ID_LABEL = "openDingTalkId"

    #: The vault is currently written by the app's DingTalk channel, so ids carry
    #: that shape and the share scanner can check for them. Truncating the pattern
    #: is not an option — these ids share long prefixes.
    ID_PATTERN = r"\bD[A-Za-z0-9]{24,}\b"

    #: A snapshot of somebody else's database. Reads and mentions are real (the
    #: vault has a dedicated `message_mentions` table, which beats inferring
    #: @-mentions from text); tailing and sending belong to the app, which owns
    #: the channel session and its own send authorization. Declaring them false
    #: is what makes the persona's send path refuse with a reason instead of
    #: reaching for a `dws` binary on PATH that would be authenticated as a
    #: different person.
    #:
    #: `recentReads` is the third state between those two. The app collects on a
    #: short fixed cycle, so this database is minutes-fresh rather than the
    #: hours-or-days a `forge pull` snapshot would be — good enough to read a
    #: conversation tail from, PROVIDED the lag is measured and reported. It is a
    #: separate flag from `tail` on purpose: `tail: true` promises "what you read
    #: is current", and this cannot promise that. Callers must decide what lag
    #: they tolerate, which is exactly the decision `persona.py fresh` makes
    #: before a send.
    CAPS = {"read": True, "mentions": True, "tail": False, "recentReads": True,
            "send": False, "directory": True}

    #: Rich cards the DingTalk client renders that nobody typed. Same list as the
    #: dws adapter's, for the same reason: the vault stores what that client
    #: produced, so unfiltered a document-permission card gets recalled as "how
    #: they reply".
    CLIENT_FURNITURE = (
        r"该群为保密群|无法获取消息记录",
        r"\[(文件|图片|视频|音频|链接|表情|位置|名片|分享|语音通话|视频通话)(消息)?\]",
        r"如需下载使用\s*dws|download-media",
        r"钉钉文档\s*\n\s*DingTalk\s*Docs|我申请开通文档|申请开通.{0,24}权限",
        r"创建者\s*[:：]\s*\S+\s*\n\s*!\[",
        r"是否向好友发送你的名片",
    )

    DEFAULT_UTC_OFFSET = "+08:00"

    #: The mention lookup is a local join, not a paged API, so there is no reason
    #: to clamp how far back it runs — and clamping it would quietly discard the
    #: structured @-mention evidence for every group ask older than the window.
    MENTION_LOOKBACK_DAYS = None

    def __init__(self, cfg: dict | None = None, path: str = "",
                 channel_id: str = "dingtalk",
                 conversation_ids: list | None = None,
                 conversationIds: list | None = None, **_ignored):
        cfg = cfg or {}
        if not path:
            raise SystemExit(
                "the vault source needs source.options.path — the app's "
                "core.sqlite (usually <userData>/vaults/<vaultId>/core.sqlite)")
        from .. import common as C
        self.path = C.expand(path)
        if not self.path.exists():
            raise SystemExit(f"vault database does not exist: {self.path}")
        self.channel_id = channel_id
        #: The distillation scope the user picked in the app: only these
        #: conversations become corpus. Empty/None means "every conversation the
        #: app did not flag as a bot channel", which is the historical behavior.
        #:
        #: Both spellings are accepted because the option travels through
        #: `open_source(**options)` as a literal JSON key: the app writes
        #: `conversationIds` (its own casing) and a hand-written config may use
        #: the snake_case that matches every other kwarg here. Accepting one and
        #: silently ignoring the other is the whole failure mode this option
        #: exists to fix — an unrecognized key lands in `**_ignored`, the pull
        #: succeeds, and the corpus quietly contains conversations the user
        #: excluded.
        picked = conversation_ids if conversation_ids is not None else conversationIds
        self.conversation_ids = [str(c) for c in (picked or []) if str(c)]
        self.utc_offset = cfg.get("timezoneOffset") or self.DEFAULT_UTC_OFFSET
        self.offset_minutes = _offset_minutes(self.utc_offset)

        # Read-only by URI, not by convention: the app may be running and holding
        # this file. A stray write from the forge would be a data-loss bug in
        # somebody else's database.
        self.conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        self.conn.row_factory = sqlite3.Row

        #: Rows the app has not judged yet. Counted, never coerced — see module
        #: docstring. Keyed by message id so repeated passes over the same window
        #: (the directory pass, then one per time slice) cannot inflate it.
        self._unjudged: set[str] = set()
        #: Rows read but with no usable text. Distinct from `_unjudged`: this one
        #: is normal (images, files), that one means the corpus is not ready.
        self._textless: set[str] = set()

    def _scope(self, column: str) -> tuple[str, list]:
        """`(sql_fragment, params)` restricting `column` to the picked scope.

        Returns `("", [])` when the user picked nothing, so the caller's query
        is byte-identical to the unscoped one. Built as a fragment rather than
        filtered in Python because the alternative — reading every row and
        dropping most — makes a six-month, few-conversation scope pay the full
        cost of a six-month, every-conversation read.

        ## ★ `column` must be an EXTERNAL id, never `conversations.id`

        The app has two identifiers per conversation: `id` is its own opaque
        primary key, `external_id` is the platform's `openConversationId`. The
        scope arrives from the app's config, which stores what the *user* picked
        through the platform's own listing — so it is always `external_id`
        (`cid…`), never the internal key.

        Filtering the internal key matched 0 of 39 real conversations, and
        because an empty `IN (…)` is not an error the pull simply returned
        everything: the scope silently did nothing, which is the exact failure
        this option was added to fix. Measured on the real vault: 32/39 match on
        `external_id`, 0/39 on `id`.
        """
        if not self.conversation_ids:
            return "", []
        holes = ",".join("?" for _ in self.conversation_ids)
        return f" AND {column} IN ({holes})", list(self.conversation_ids)

    # -- introspection -------------------------------------------------------

    def capabilities(self) -> dict:
        return {**self.static_capabilities(), "timezone": self.utc_offset,
                "notes": ("read-only projection of the MyContext vault; the "
                          "desktop app owns collection and sending")}

    def identity(self) -> dict:
        """The owner, from the vault's authoritative identity table.

        Unlike the JSONL adapter this never has to be told who the owner is — the
        app resolved it against the channel and recorded the confirmation. But an
        UNCONFIRMED row is refused rather than used: `confirmed_at IS NULL` means
        the user has not yet verified the match, and the app's own comment
        explains that a wrong identity poisons every derived conclusion
        irreversibly.
        """
        row = self.conn.execute(
            "SELECT user_id, open_ids_json, display_names_json, corp_id, confirmed_at "
            "FROM channel_self_identity WHERE channel_id=?",
            (self.channel_id,)).fetchone()
        if row is None:
            raise SystemExit(
                f"the vault has no confirmed identity for channel "
                f"{self.channel_id!r}. Confirm it in the app first — attributing "
                f"messages without it would produce a confident, wrong persona.")
        if row["confirmed_at"] is None:
            raise SystemExit(
                "the vault's identity row is not confirmed yet (confirmed_at is "
                "NULL). Confirm the identity in the app's status page; until then "
                "every message is marked unjudged and none can be attributed.")

        open_ids = []
        for entry in json.loads(row["open_ids_json"] or "[]"):
            value = entry.get("value") if isinstance(entry, dict) else entry
            if value:
                open_ids.append(str(value))
        if not open_ids:
            raise SystemExit(
                "the vault's identity row has no open ids, so no message can be "
                "attributed to the owner")

        names = [str(n) for n in json.loads(row["display_names_json"] or "[]") if n]
        return {"userId": str(row["user_id"] or open_ids[0]),
                # The tenant this member belongs to. Channel-neutral name on
                # purpose: DingTalk calls it corpId, Lark/Feishu calls it
                # tenant_key, Slack calls it team_id — the *concept* (which
                # organization) is what the profile slug needs, so the field is
                # named after the concept rather than one vendor's spelling.
                # Empty string when the channel has no tenant dimension.
                "orgId": str(row["corp_id"] or ""),
                "name": names[0] if names else "",
                "openIds": sorted(set(open_ids)),
                "excludedOpenIds": [],
                # Every display name is an @-mention candidate: the app records
                # both the organization name and any nicknames, and people
                # @-mention whichever one they see.
                "aliases": sorted(set(names))}

    # -- reads ---------------------------------------------------------------

    def _wall_clock(self, sent_at_ms: int) -> str:
        """unix ms → "YYYY-MM-DD HH:MM:SS" in the configured zone."""
        moment = dt.datetime(1970, 1, 1) + dt.timedelta(
            milliseconds=int(sent_at_ms), minutes=self.offset_minutes)
        return moment.strftime("%Y-%m-%d %H:%M:%S")

    def _to_ms(self, wall_clock: str) -> int:
        """Inverse of `_wall_clock`, so window bounds are compared in the vault's
        own unit rather than by formatting every row to filter it."""
        text = (wall_clock or "").strip().replace("T", " ")[:19]
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                parsed = dt.datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
        else:
            raise SystemExit(f"cannot read window bound {wall_clock!r}")
        epoch = parsed - dt.timedelta(minutes=self.offset_minutes)
        return int((epoch - dt.datetime(1970, 1, 1)).total_seconds() * 1000)

    def conversations(self) -> list[dict]:
        """The app's conversation directory.

        `peerOpenId` is deliberately left empty even for 1:1 threads: the app
        stores participants in `actors`, not on the conversation, and
        `store.link_direct_peers` derives the peer from who actually sent
        messages — which is strictly more reliable than any directory field
        (see its docstring on the placeholder-peer corruption).

        Bot channels are reported with their flag so the caller can see them, but
        they are NOT filtered here: the app's `is_bot_channel` marks alert rooms
        that would pollute expertise and routines, and dropping the conversation
        while keeping its messages would leave those messages without metadata.
        Filtering happens in `messages()`, where both are dropped together.

        The user's picked scope IS applied here, unlike the bot flag: a
        conversation outside the scope contributes no messages at all, so listing
        it would put a permanently empty thread in the directory — and the
        directory is what `people` and the relations layer are built from.
        """
        scope, params = self._scope("external_id")
        rows = self.conn.execute(
            "SELECT id, title, type, member_count, last_message_at "
            "FROM conversations WHERE channel_id=? AND is_bot_channel=0" + scope,
            (self.channel_id, *params)).fetchall()
        return [{
            "conversationId": row["id"],
            "title": row["title"] or "",
            "singleChat": row["type"] == "direct",
            "peerOpenId": "",
            "peerName": row["title"] or "" if row["type"] == "direct" else "",
            "memberCount": row["member_count"] or 0,
            "muted": False,
            "lastMsgAt": (self._wall_clock(row["last_message_at"])
                          if row["last_message_at"] else ""),
        } for row in rows]

    def messages(self, start: str, end: str, page_size: int = 0) -> Iterator[dict]:
        """Messages in [start, end), normalized.

        Bot channels are excluded by the join: the app flags alert rooms, and a
        high-frequency alert bot flattens the active-hour histogram and fills
        expertise with ops jargon. This mirrors the app's own distill guard.

        Agent-sent messages are passed through with their origin so the caller
        can exclude them; they must not be silently dropped, because "the agent
        replied here" is exactly what tells us this thread already got an answer.

        The user's picked scope is applied to the conversation, not the message:
        the point is "distill these threads", so a quoted message pulled in by
        the LEFT JOIN stays available as context even though it is never yielded
        as corpus of its own.
        """
        lo, hi = self._to_ms(start), self._to_ms(end)
        # `c.external_id`, not `m.conversation_id` — see `_scope`. The join is
        # already here, so scoping through it costs nothing.
        scope, params = self._scope("c.external_id")
        rows = self.conn.execute("""
            SELECT m.id, m.conversation_id, m.sender_external_id, m.sender_display_name,
                   m.content_text, m.sent_at, m.is_self, m.origin, m.thread_id,
                   c.title AS conv_title, c.type AS conv_type,
                   q.content_text AS quoted_text, q.sender_display_name AS quoted_sender,
                   EXISTS(SELECT 1 FROM message_mentions mm
                          WHERE mm.message_id = m.id AND mm.is_self = 1) AS mentions_self
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id AND c.is_bot_channel = 0
            LEFT JOIN messages q ON q.channel_id = m.channel_id
                                AND q.external_id = m.quoted_external_id
            WHERE m.channel_id = ? AND m.sent_at >= ? AND m.sent_at < ?""" + scope + """
            ORDER BY m.sent_at, m.id
        """, (self.channel_id, lo, hi, *params)).fetchall()

        for row in rows:
            # ★ NULL is "not judged yet", not "somebody else". Excluded and
            # counted; see the module docstring.
            if row["is_self"] is None:
                self._unjudged.add(row["id"])
                continue
            text = row["content_text"] or ""
            if not text.strip():
                self._textless.add(row["id"])
                continue
            yield {
                "messageId": row["id"],
                "conversationId": row["conversation_id"],
                "conversationTitle": row["conv_title"] or "",
                "singleChat": row["conv_type"] == "direct",
                "senderId": row["sender_external_id"] or "",
                "senderName": row["sender_display_name"] or "",
                "createdAt": self._wall_clock(row["sent_at"]),
                "msgType": "text",
                "text": text,
                "quotedText": row["quoted_text"] or "",
                "quotedSenderName": row["quoted_sender"] or "",
                "quotedSenderId": "",
                "threadId": row["thread_id"] or "",
                "mentionsSelf": bool(row["mentions_self"]),
                # Not part of the normalized shape the engine reads; carried so
                # the caller can record which rows this tooling itself sent.
                "_origin": row["origin"] or "human",
            }

    def recent_messages(self, conv_id: str, single: bool, peer_open_id: str = "",
                        limit: int = 30) -> dict:
        """This conversation's newest messages, plus how stale they might be.

        ## Why this is not `conversation_tail`

        `tail` means "ask the platform what is there right now". This asks the
        app's database, which its collector refreshes on a short cycle. The
        messages are usually seconds old and occasionally minutes old — good
        enough to read a thread from, NOT good enough to promise "nothing newer
        exists". So the lag ships with the answer and the caller decides.

        ## Where the lag number comes from

        `sync_cursors.watermark` is the app's own "fully persisted through this
        time" marker — it only advances once every page of a window is committed.
        That makes it the honest bound: anything after it may exist and simply not
        be here yet.

        The newest message's own timestamp is NOT used for this. A quiet
        conversation would then report a lag of hours and look broken, when in
        fact collection is current and nobody has spoken. Falling back to it when
        no cursor row exists is likewise wrong in the other direction, so that
        case reports `None` — unknown, which the caller must treat as unsafe
        rather than as zero.
        """
        addressed = peer_open_id if single else conv_id
        if single and not peer_open_id:
            # Kept symmetrical with the dws adapter, whose direct-chat read is
            # addressed by the peer's id rather than the conversation's. Returning
            # empty (not raising) lets the caller report "could not read" rather
            # than treating a missing argument as a platform failure.
            return {"messages": [], "lagSeconds": None, "through": ""}
        del addressed

        rows = self.conn.execute("""
            SELECT m.id, m.conversation_id, m.sender_external_id, m.sender_display_name,
                   m.content_text, m.sent_at, m.is_self, m.origin, m.thread_id,
                   c.title AS conv_title, c.type AS conv_type,
                   q.content_text AS quoted_text, q.sender_display_name AS quoted_sender,
                   EXISTS(SELECT 1 FROM message_mentions mm
                          WHERE mm.message_id = m.id AND mm.is_self = 1) AS mentions_self
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            LEFT JOIN messages q ON q.channel_id = m.channel_id
                                AND q.external_id = m.quoted_external_id
            WHERE m.channel_id = ? AND m.conversation_id = ?
            ORDER BY m.sent_at DESC, m.id DESC
            LIMIT ?
        """, (self.channel_id, conv_id, int(limit))).fetchall()

        messages = []
        for row in reversed(rows):          # oldest→newest, as every caller expects
            messages.append({
                "messageId": row["id"],
                "conversationId": row["conversation_id"],
                "conversationTitle": row["conv_title"] or "",
                "singleChat": row["conv_type"] == "direct",
                "senderId": row["sender_external_id"] or "",
                "senderName": row["sender_display_name"] or "",
                "createdAt": self._wall_clock(row["sent_at"]),
                "msgType": "text",
                "text": row["content_text"] or "",
                "quotedText": row["quoted_text"] or "",
                "quotedSenderName": row["quoted_sender"] or "",
                "quotedSenderId": "",
                "threadId": row["thread_id"] or "",
                "mentionsSelf": bool(row["mentions_self"]),
                # ★ Not the same thing as "the owner sent it": a message this
                # tooling sent is also `is_self`. A freshness check has to tell
                # them apart, or the agent's own reply reads as the owner having
                # already answered.
                "isOwner": row["is_self"] == 1,
                "isAgentSent": (row["origin"] or "human") == "agent",
            })

        return {"messages": messages, **self.collection_lag()}

    def collection_lag(self) -> dict:
        """How far behind the app's collector is: `{lagSeconds, through}`.

        `lagSeconds: None` means unknown, and there are two ways to get there:
        no cursor row yet (a vault that has never completed a collection window),
        or no cursor TABLE at all (an older schema, or a vault built by something
        other than the reference app). Both are reported the same way because the
        consequence is the same — and unknown must never be read as zero, which is
        indistinguishable from "perfectly current" at exactly the wrong moment.
        """
        try:
            row = self.conn.execute(
                "SELECT MAX(watermark) AS watermark FROM sync_cursors "
                "WHERE scope LIKE ? AND watermark > 0",
                (f"{self.channel_id}:%",)).fetchone()
        except sqlite3.Error:
            return {"lagSeconds": None, "through": ""}
        watermark = None if row is None else row["watermark"]
        if not watermark:
            return {"lagSeconds": None, "through": ""}
        now_ms = int(dt.datetime.now().timestamp() * 1000)
        return {
            "lagSeconds": max(0, int((now_ms - int(watermark)) / 1000)),
            "through": self._wall_clock(int(watermark)),
        }

    def mentions(self, start: str, end: str) -> list[str]:
        """Message ids that @-mention the owner, from the app's own table.

        This is why `CAPS["mentions"]` is true: the app resolved mentions from the
        platform's structured payload at collection time, so group asks aimed at
        the owner are identified by id rather than by matching a display name in
        text — which is the measurement the whole decision layer rests on.

        Scoped like `messages()`, and for a sharper reason: an id returned here
        that `messages()` never yielded is an ask with no message behind it. The
        decision layer would then count asks from conversations the user excluded
        while being unable to show any of them as precedent.
        """
        lo, hi = self._to_ms(start), self._to_ms(end)
        # Scoping is by the platform's id (see `_scope`), which lives on
        # `conversations` — so this query needs the join that `messages()`
        # already had. Added only when a scope is set, to keep the unscoped
        # plan identical to before.
        scope, params = self._scope("c.external_id")
        join = " JOIN conversations c ON c.id = m.conversation_id" if scope else ""
        rows = self.conn.execute("""
            SELECT mm.message_id FROM message_mentions mm
            JOIN messages m ON m.id = mm.message_id""" + join + """
            WHERE mm.is_self = 1 AND m.channel_id = ?
              AND m.sent_at >= ? AND m.sent_at < ?""" + scope + """
        """, (self.channel_id, lo, hi, *params)).fetchall()
        return [row["message_id"] for row in rows]

    def agent_sent_ids(self) -> set[str]:
        """Messages this tooling sent as the owner.

        The app records provenance on the row (`origin='agent'`), so unlike the
        dws adapter — which reconstructs this from a local append-only log — the
        answer is authoritative and survives a machine change. Without it the
        agent's own replies are re-ingested as the owner's authentic voice and
        the persona drifts into imitating itself.

        Deliberately NOT scoped to the picked conversations. This is an exclusion
        set, so a superset is the safe direction: an extra id here can only ever
        prevent an agent reply from being read as the owner's voice. Narrowing it
        to the scope would buy nothing and risks the one unrecoverable outcome.
        """
        rows = self.conn.execute(
            "SELECT id FROM messages WHERE channel_id=? AND origin='agent'",
            (self.channel_id,)).fetchall()
        return {row["id"] for row in rows}

    def stats(self) -> dict:
        """What the projection saw, including what it could not use.

        `unjudgedRows` is the number that matters when a build comes back empty:
        nonzero means the vault is populated but its identity was never
        confirmed, which points at the app's status page rather than at the
        window, the credentials, or this adapter. It is surfaced as
        `unusableRows` too, which is what `ingest.pull` reads to withhold
        `complete: true` — an unconfirmed corpus is not a complete read, and
        saying so is what keeps it from looking like a quiet person.
        """
        out = {
            "vault": str(self.path),
            "channelId": self.channel_id,
            "timezone": self.utc_offset,
            "textlessRows": len(self._textless),
            "unjudgedRows": len(self._unjudged),
        }
        # A scoped read is a THIN corpus by design, and thin is the same shape as
        # broken. Reporting the count here is what separates "the user picked 39
        # of 52 conversations" from "the join is dropping rows" without having to
        # re-run anything.
        if self.conversation_ids:
            out["scopedConversations"] = len(self.conversation_ids)
        if self._unjudged:
            out["unusableRows"] = len(self._unjudged)
            out["unusableReason"] = (
                "is_self is NULL, meaning the app collected them before the owner's "
                "identity was confirmed — see sourceStats.unjudgedHint")
            out["unjudgedHint"] = (
                "these vault rows have is_self = NULL, meaning the app collected "
                "them before the owner's identity was confirmed. They are excluded "
                "rather than attributed, because guessing wrong is unrecoverable. "
                "Confirm the identity in the app's status page and let it backfill, "
                "then rebuild.")
        return out
