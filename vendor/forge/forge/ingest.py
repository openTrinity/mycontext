#!/usr/bin/env python3
"""Ingest: pull IM history into the local corpus. Incremental and resumable.

Platform-agnostic: everything here works against a `MessageSource`
(`forge/sources/`), so the same incremental, resumable, checkpointed pull serves
the DingTalk adapter and a plain JSONL export alike.

Two things the original pipeline got wrong and this fixes:

1. **It re-pulled everything, every time.** Now the corpus records
   `pulledThrough`; `--since auto` resumes from there (minus an overlap window,
   because a message can be written to the server slightly after its timestamp).

2. **A mid-pull failure lost the whole window.** Now each day-slice commits
   independently and advances the checkpoint only on success, so an interrupted
   pull resumes where it stopped instead of starting over.
"""

from __future__ import annotations

import datetime as dt
import sqlite3
from pathlib import Path

from . import common as C
from . import store
from .runtime import DwsError, parse_ts
from .sources import Unsupported

# Overlap re-pulled on an incremental run: cheap (dedup is by message id) and it
# closes the gap where a message lands just after the checkpoint moment.
OVERLAP_MINUTES = 30


def _day_slices(start: dt.datetime, end: dt.datetime, days: int = 7):
    """Yield [a, b) windows. Smaller windows = smaller loss on failure and
    smoother progress; 7 days keeps the call count sane over a 6-month backfill."""
    cur = start
    step = dt.timedelta(days=days)
    while cur < end:
        nxt = min(cur + step, end)
        yield cur, nxt
        cur = nxt


def _fmt(d: dt.datetime) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S")


def resolve_window(conn: sqlite3.Connection, cfg: dict, since: str | None,
                   until: str | None) -> tuple[dt.datetime, dt.datetime, str]:
    """Return (start, end, mode). `since=auto` resumes from the checkpoint."""
    now = dt.datetime.now()
    end = dt.datetime.fromisoformat(until) if until else now
    if since and since != "auto":
        return dt.datetime.fromisoformat(since), end, "explicit"
    through = store.get_meta(conn, "pulledThrough")
    if since == "auto" and through:
        base = dt.datetime.fromtimestamp(parse_ts(through))
        return base - dt.timedelta(minutes=OVERLAP_MINUTES), end, "incremental"
    return dt.datetime.fromisoformat(cfg["analysisStart"]), end, "full"


def sync_directory(conn: sqlite3.Connection, source, ident: dict) -> dict:
    """Refresh the conversation + people directory (names, titles, peers).

    Done before messages so a message's conversation always has a title. The
    adapter is responsible for normalizing its platform's directory shape,
    including any per-platform caveat about which fields can be trusted.
    """
    n_conv = 0
    for c in source.conversations():
        cid = c.get("conversationId") or ""
        if not cid:
            continue
        store.upsert_conversation(conn, {
            "conversationId": cid,
            "title": c.get("title") or "",
            "singleChat": bool(c.get("singleChat")),
            "peerOpenId": c.get("peerOpenId") or "",
            "peerName": c.get("peerName") or "",
            "memberCount": c.get("memberCount") or 0,
            "muted": bool(c.get("muted")),
            "lastMsgAt": (c.get("lastMsgAt") or "").replace("T", " ")[:19],
        })
        n_conv += 1
    conn.commit()
    return {"conversations": n_conv}


def _self_chat_conv_ids(conn: sqlite3.Connection, aliases: set[str]) -> set[str]:
    """Conversations that are the owner talking to themselves (a note-to-self
    chat). Their 'replies' are not replies to anyone and would skew every stat."""
    out = set()
    for row in conn.execute("SELECT conversation_id, title, single_chat FROM conversations"):
        if row["single_chat"] and row["title"] and row["title"] in aliases:
            out.add(row["conversation_id"])
    return out


def pull(cfg: dict, source, since: str | None = "auto",
         until: str | None = None, dry_run: bool = False,
         progress=None) -> dict:
    """Pull messages into the corpus. Idempotent: re-running adds only what is new."""
    data_root = C.expand(cfg["dataRoot"])
    C.assert_safe_data_root(data_root)
    db_path = C.expand(cfg["database"]["path"])
    conn = store.open_db(db_path)
    caps = source.capabilities()
    try:
        ident = source.identity()
        if not ident["openIds"]:
            return {"error": "could not resolve the owner's identity set; "
                             "refusing to attribute messages by name"}
        start, end, mode = resolve_window(conn, cfg, since, until)
        slices = list(_day_slices(start, end))

        if dry_run:
            return {"dryRun": True, "mode": mode, "source": caps["kind"],
                    "capabilities": caps,
                    "window": {"start": _fmt(start), "end": _fmt(end)},
                    "slices": len(slices), "identity": {
                        "userId": ident["userId"], "name": ident["name"],
                        "openIds": len(ident["openIds"]),
                        "excludedAliases": len(ident.get("excludedOpenIds") or [])},
                    "note": "no message read, no writes performed"}

        store.set_meta(conn, "selfUserId", ident["userId"])
        store.set_meta(conn, "selfName", ident["name"])
        store.set_meta(conn, "selfOpenIds", ",".join(ident["openIds"]))
        store.set_meta(conn, "selfAliases", ",".join(ident["aliases"]))
        store.set_meta(conn, "sourceKind", caps["kind"])
        conn.commit()

        # Every adapter can produce a directory: those without a server-side one
        # reconstruct it from the messages, which is guaranteed consistent with
        # the corpus it produces.
        dir_stats = sync_directory(conn, source, ident)
        dir_stats["serverSide"] = bool(caps.get("directory"))

        self_ids = set(ident["openIds"])
        aliases = set(ident["aliases"])
        # A source that records provenance on the row itself is authoritative and
        # survives a machine change, so it wins over the local append-only log.
        # Both exist for the same reason: an agent reply re-ingested as the
        # owner's authentic voice makes the persona imitate itself.
        agent_sent = (source.agent_sent_ids() if hasattr(source, "agent_sent_ids")
                      else _agent_sent_ids(data_root))

        inserted = seen = 0
        failed_slices: list[str] = []
        gaps: list[str] = []
        contiguous = True     # no slice has failed yet, so the checkpoint may advance
        for a, b in slices:
            try:
                batch = 0
                for msg in source.messages(
                        _fmt(a), _fmt(b),
                        page_size=cfg.get("dws", {}).get("pageSize", 100)):
                    seen += 1
                    if msg.get("conversationId"):
                        store.upsert_conversation(conn, {
                            "conversationId": msg["conversationId"],
                            "title": msg.get("conversationTitle", ""),
                            "singleChat": msg.get("singleChat", False),
                            "lastMsgAt": msg.get("createdAt", ""),
                        })
                    if msg.get("senderId") and msg["senderId"] not in self_ids:
                        store.upsert_person(conn, {
                            "personId": msg["senderId"],
                            "name": msg.get("senderName", ""),
                            "seenAt": msg.get("createdAt", ""),
                        })
                    if store.insert_message(conn, msg, self_ids, agent_sent, aliases):
                        inserted += 1
                    batch += 1
                conn.commit()
                # The checkpoint may only advance across an unbroken run of
                # successful slices. Once one window has failed, later successes
                # must NOT move it past the gap — otherwise `--since auto` would
                # skip the missing window forever.
                if contiguous:
                    store.set_meta(conn, "pulledThrough", _fmt(b))
                    conn.commit()
                if progress:
                    progress(f"{_fmt(a)[:10]}..{_fmt(b)[:10]}  +{batch}"
                             + ("" if contiguous else "  (after a gap)"))
            except DwsError as e:
                conn.commit()
                label = f"{_fmt(a)}..{_fmt(b)}"
                failed_slices.append(f"{label}: {e.detail[:120]}")
                contiguous = False
                if progress:
                    progress(f"{label}  FAILED ({'transient' if e.transient else 'hard'})")
                if e.transient:
                    # Throttling or a network blip: skip this window and keep
                    # going. The checkpoint stays behind it, so a later
                    # `pull --since auto` re-pulls the gap.
                    gaps.append(label)
                    continue
                break

        # @-me mentions: a group message can address the owner without the bulk
        # read making that obvious. How far back to look is the adapter's call
        # (`MENTION_LOOKBACK_DAYS`): a paged network endpoint is only worth
        # querying for the recent window that decides what to answer now, and
        # older mentions remain detectable from the message text — but a source
        # whose lookup is a local query has no reason to clamp, and clamping it
        # would silently drop the structured evidence the decision layer rests on.
        mention_hits = 0
        if caps.get("mentions"):
            lookback = getattr(source, "MENTION_LOOKBACK_DAYS", 30)
            mention_start = start if lookback is None else max(
                start, dt.datetime.now() - dt.timedelta(days=lookback))
            mention_hits = _mark_mentions(conn, source, mention_start, end)

        store.set_meta(conn, "lastPullAt", _fmt(dt.datetime.now()))
        # Link 1:1 peers from message senders before counting, so reciprocity
        # (msgs_to) is populated and tone banding sees real interaction.
        linked = store.link_direct_peers(conn, self_ids)
        store.refresh_counts(conn)
        store.rebuild_fts(conn)
        conn.commit()

        result = {
            "mode": mode, "source": caps["kind"],
            "window": {"start": _fmt(start), "end": _fmt(end)},
            "slices": len(slices), "messagesSeen": seen, "inserted": inserted,
            "mentionsMarked": mention_hits,
            "mentionEndpoint": bool(caps.get("mentions")),
            "directory": dir_stats,
            "directPeersLinked": linked,
            "failedSlices": failed_slices,
            "gapsToRetry": gaps,
            "complete": not failed_slices,
            "stats": store.stats(conn),
            "selfChats": len(_self_chat_conv_ids(conn, aliases)),
            "note": ("some windows were throttled; re-run `pull --since auto` to "
                     "fill the gaps" if gaps else ""),
        }
        if hasattr(source, "stats"):
            result["sourceStats"] = source.stats()

        # A source that read its input but could not use it is NOT a complete pull.
        # Reporting `complete: true` next to `inserted: 0` is the failure mode this
        # forge is built to refuse: it makes a broken export indistinguishable from
        # an empty one, so nobody goes looking. Promote the source's own complaint
        # into the top-level verdict.
        #
        # The REASON comes from the source, because the fix differs per source and a
        # wrong reason sends the operator to the wrong place: a JSONL export with
        # unreadable timestamps is fixed in the exporter, whereas a vault whose rows
        # are unjudged is fixed by confirming an identity in the app. Naming only
        # the timestamp case here would have misdiagnosed every other one.
        stats = result.get("sourceStats") or {}
        unusable = int(stats.get("unusableRows", 0) or stats.get("undatedLines", 0))
        if unusable:
            result["complete"] = False
            result["unusableRows"] = unusable
            reason = stats.get("unusableReason") or (
                "had no usable timestamp — see sourceStats.undatedAt and undatedHint")
            result["note"] = "; ".join(filter(None, [
                result["note"],
                f"{unusable} row(s) were read but NOT imported: {reason}"]))
        if hasattr(source, "client"):
            result["throttled"] = source.client.throttled
        return result
    finally:
        conn.close()


def _mark_mentions(conn: sqlite3.Connection, source,
                   start: dt.datetime, end: dt.datetime) -> int:
    """Flag messages that @-mention the owner, using the platform's endpoint."""
    marked = 0
    cur = start
    while cur < end:
        nxt = min(cur + dt.timedelta(days=14), end)
        try:
            ids = source.mentions(_fmt(cur), _fmt(nxt))
        except (DwsError, Unsupported):
            ids = []
        for mid in ids:
            if not mid:
                continue
            c = conn.execute("UPDATE messages SET mentions_self=1 WHERE message_id=?",
                             (mid,))
            marked += c.rowcount
        cur = nxt
    conn.commit()
    return marked


def _agent_sent_ids(data_root: Path) -> set[str]:
    """Message ids this tooling sent on the owner's behalf.

    DWS `message send` posts under the owner's identity, so without this the
    agent's own replies would be re-ingested as the owner's authentic style and
    the persona would slowly drift into imitating itself.
    """
    ids: set[str] = set()
    path = data_root / "agent-sent.jsonl"
    if not path.exists():
        return ids
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = C.read_json_line(line)
        if rec and rec.get("messageId"):
            ids.add(rec["messageId"])
    return ids
