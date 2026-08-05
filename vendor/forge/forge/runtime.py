#!/usr/bin/env python3
"""im-persona runtime — self-contained DWS client + local corpus reader.

This ONE file is copied verbatim into every published skill (as
`scripts/imruntime.py`) and is also used by the forge itself. Standard library
only; no imports from the forge package. That is deliberate: the published skill
must keep working if the forge repo is deleted, and there must be exactly one
implementation of "call DWS reliably" so a fix lands everywhere at once.

Contents
  DwsError / DwsResult   — an outcome that is never silently an empty list
  DwsClient              — argv-array calls, retry with backoff, honest errors
  Corpus                 — read-only SQLite queries over the local corpus
  audit()                — append-only action log
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 3

# ---------------------------------------------------------------------------
# DWS client
# ---------------------------------------------------------------------------

# Transient failure signatures worth retrying. Anything else is a real error and
# is surfaced — the old router treated every failure as "no candidates", which is
# exactly how an agent goes quiet without anyone noticing.
_TRANSIENT_RE = re.compile(
    r"(timeout|timed out|deadline|temporar|connection reset|connection refused|"
    r"EOF|502|503|504|429|rate.?limit|too many requests|try again|"
    r"i/o timeout|broken pipe|tls|network)", re.I)

# A directory nick can carry a marker meaning "retired account, do not use".
# Detecting it matters more than it looks: such an account belongs to the owner
# historically, so counting it as self would attribute a former colleague's
# messages — or the owner's own long-abandoned alias — to the live persona.
#
# The literal marker is written as escapes rather than as characters so that the
# engine stays free of any one language's text (enforced by `forge selftest`);
# the tenant-specific equivalents belong in the operator's locale overrides.
_DEPRECATION_MARK = "\u4e0d\u7528"   # zh, "not in use"
_DEPRECATED_NICK = re.compile(
    "|".join([_DEPRECATION_MARK, r"\bdeprecated\b", r"\bdo ?not ?use\b",
              r"\bretired\b", r"\bold\b\s*$", r"\bdisabled\b"]), re.I)
# Same marker in either bracket style, stripped when collecting name aliases.
_DEPRECATION_WRAPPED = re.compile(
    r"[（(]\s*(?:" + _DEPRECATION_MARK + r"|deprecated|do ?not ?use|retired)\s*[)）]",
    re.I)


def _strip_deprecation(text: str) -> str:
    return _DEPRECATION_WRAPPED.sub("", text or "").strip()


class DwsError(RuntimeError):
    def __init__(self, command: list[str], detail: str, transient: bool = False):
        self.command = command
        self.detail = detail
        self.transient = transient
        super().__init__(f"dws {' '.join(command[:3])}: {detail[:300]}")


@dataclass
class DwsResult:
    ok: bool
    data: dict = field(default_factory=dict)
    error: str = ""
    transient: bool = False
    attempts: int = 1
    command: list[str] = field(default_factory=list)

    @property
    def result(self) -> Any:
        return self.data.get("result")


class DwsClient:
    """Reliability wrapper around the `dws` CLI.

    Guarantees:
      - argv arrays only (never a shell string)
      - `--format json` appended when absent
      - transient failures retried with exponential backoff + jitter-free sleeps
      - a failed call returns ok=False WITH the error text; callers must branch
        on `.ok` rather than on an empty payload
    """

    def __init__(self, binary: str = "dws", timeout: int = 60, retries: int = 3,
                 backoff: float = 2.0, log: Path | None = None,
                 min_interval: float = 0.35):
        self.binary = self._resolve(binary)
        self.timeout = timeout
        self.retries = max(1, retries)
        self.backoff = backoff
        self.log = log
        # Paced calls: the message API throttles a fast burst, and a throttled
        # call costs a full timeout — far more than the pause that avoids it.
        # After a transient failure the pace backs off and recovers slowly.
        self.min_interval = min_interval
        self._pace = min_interval
        self._last_call = 0.0
        self.calls = 0
        self.failures = 0
        self.throttled = 0

    @staticmethod
    def _resolve(binary: str) -> str:
        """Locate the dws binary, or fail loudly.

        An explicit path in the config is honored exactly: if the operator
        configured `/opt/dws` and it is missing, that is a configuration error,
        not an invitation to silently use whatever `dws` happens to be on PATH.
        Falling back there would report a healthy poller while reading a
        different (or wrong-tenant) CLI.
        """
        if "/" in binary:
            p = Path(os.path.expanduser(binary))
            if p.is_file():
                return str(p)
            raise DwsError([binary], f"configured dws binary '{binary}' does not exist")
        found = shutil.which(binary)
        if found:
            return found
        for cand in ("~/.local/bin/dws", "/usr/local/bin/dws", "/opt/homebrew/bin/dws"):
            cp = Path(os.path.expanduser(cand))
            if cp.is_file():
                return str(cp)
        raise DwsError([binary], f"dws binary '{binary}' not found on PATH")

    def _env(self) -> dict:
        env = dict(os.environ)
        for var in list(env):
            if var.startswith(("DWS_CONNECTOR", "MCP_CONNECTOR")):
                env.pop(var, None)
        return env

    def call(self, args: Iterable[str], timeout: int | None = None,
             retries: int | None = None) -> DwsResult:
        argv = [str(a) for a in args]
        if "--format" not in argv:
            argv += ["--format", "json"]
        attempts = retries if retries is not None else self.retries
        tmo = timeout or self.timeout
        last_err = "unknown"
        last_transient = False

        for attempt in range(1, attempts + 1):
            self.calls += 1
            self._wait_turn()
            try:
                proc = subprocess.run([self.binary, *argv], capture_output=True,
                                      text=True, timeout=tmo, env=self._env())
                rc, out, err = proc.returncode, proc.stdout, proc.stderr
            except subprocess.TimeoutExpired:
                rc, out, err = 1, "", f"timeout after {tmo}s"
            except OSError as e:
                rc, out, err = 1, "", str(e)

            payload: dict = {}
            if out.strip():
                try:
                    payload = json.loads(out)
                except json.JSONDecodeError:
                    payload = {}

            # A dws "error" envelope can arrive with rc==0, so check both.
            envelope_err = ""
            if isinstance(payload, dict):
                if isinstance(payload.get("error"), dict):
                    e = payload["error"]
                    envelope_err = f"{e.get('reason', '')}: {e.get('message', '')}".strip(": ")
                elif payload.get("success") is False:
                    envelope_err = payload.get("errorMsg") or "success=false"

            if rc == 0 and payload and not envelope_err:
                self._record(argv, True, attempt, "")
                # Recover the pace gradually after a throttle, rather than
                # snapping back and getting throttled again.
                self._pace = max(self.min_interval, self._pace * 0.8)
                return DwsResult(True, payload, attempts=attempt, command=argv)

            last_err = (envelope_err or err or out or f"rc={rc}").strip()
            last_transient = bool(_TRANSIENT_RE.search(last_err))
            if last_transient:
                self.throttled += 1
                self._pace = min(8.0, max(self._pace * 2, 1.0))
            if attempt < attempts and last_transient:
                time.sleep(min(30.0, self.backoff ** attempt))
                continue
            # One diagnostic retry with --verbose turns an opaque failure into an
            # actionable one. Skipped for transient errors: those are throttling
            # or network, where the extra call only adds load.
            if attempt == attempts and not last_transient and "--verbose" not in argv:
                try:
                    p2 = subprocess.run([self.binary, *argv, "--verbose"],
                                        capture_output=True, text=True,
                                        timeout=tmo, env=self._env())
                    if p2.stderr.strip():
                        last_err = f"{last_err} | {p2.stderr.strip()[:400]}"
                except (subprocess.TimeoutExpired, OSError):
                    pass
            break

        self.failures += 1
        self._record(argv, False, attempts, last_err)
        return DwsResult(False, {}, error=last_err, transient=last_transient,
                         attempts=attempts, command=argv)

    def must(self, args: Iterable[str], **kw) -> dict:
        r = self.call(args, **kw)
        if not r.ok:
            raise DwsError(r.command, r.error, r.transient)
        return r.data

    def _wait_turn(self) -> None:
        gap = time.time() - self._last_call
        if gap < self._pace:
            time.sleep(self._pace - gap)
        self._last_call = time.time()

    def _record(self, argv: list[str], ok: bool, attempts: int, err: str) -> None:
        if not self.log:
            return
        try:
            self.log.parent.mkdir(parents=True, exist_ok=True)
            with open(self.log, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "cmd": " ".join(argv[:4]), "ok": ok, "attempts": attempts,
                    "error": err[:200], "at": now_str(),
                }, ensure_ascii=False) + "\n")
            os.chmod(self.log, 0o600)
        except OSError:
            pass

    # -- identity ----------------------------------------------------------

    def self_identity(self) -> dict:
        """{'userId','orgId','name','openIds':[...],'excludedOpenIds':[...],'aliases':[...]}

        userId comes from get-self and is authoritative. openDingTalkIds come
        from a contact search on the resolved name; a nick carrying a deprecation
        tag (see _DEPRECATED_NICK) marks a retired alias account that must NOT
        count as self.
        """
        data = self.must(["contact", "user", "get-self"])
        emp = (data.get("result") or [{}])[0].get("orgEmployeeModel", {})
        user_id = str(emp.get("userId") or "")
        name = emp.get("orgUserName") or ""
        if not user_id:
            raise DwsError(["contact", "user", "get-self"], "no userId in response")

        open_ids: list[str] = []
        excluded: list[str] = []
        aliases = {name} if name else set()
        if name:
            r = self.call(["contact", "user", "search", "--query", name])
            for hit in (r.result or []) if r.ok else []:
                oid = hit.get("openDingTalkId")
                nick = str(hit.get("nick") or "")
                same = str(hit.get("userId")) == user_id or hit.get("name") == name
                if same:
                    for form in (hit.get("name"), hit.get("nick"), hit.get("flowerName")):
                        if form:
                            aliases.add(_strip_deprecation(str(form)))
                if not oid:
                    continue
                if _DEPRECATED_NICK.search(nick):
                    excluded.append(oid)
                elif same:
                    open_ids.append(oid)
        return {
            "userId": user_id, "name": name,
            # Tenant the member belongs to. Channel-neutral name on purpose:
            # DingTalk calls it corpId, Lark/Feishu tenant_key, Slack team_id —
            # the profile slug needs the *concept* (which organization), so the
            # field is named after it rather than one vendor's spelling.
            "orgId": str(emp.get("corpId") or ""),
            "openIds": sorted(set(open_ids)),
            "excludedOpenIds": sorted(set(excluded)),
            "aliases": sorted(a for a in aliases if a),
        }

    # -- reads -------------------------------------------------------------

    def conversations(self, limit: int = 1000, exclude_muted: bool = False) -> list[dict]:
        """Every conversation with metadata (title, singleChat, lastMsgCreateAt).

        This is the reliable inventory. `list-unread-conversations` is NOT — the
        unread flag clears as soon as the owner reads on any device, so it
        returns [] almost always and is useless as a poll source.
        """
        out: list[dict] = []
        cursor: int | None = None
        for _ in range(20):
            args = ["chat", "list-all-conversations", "--limit", str(limit)]
            if exclude_muted:
                args.append("--exclude-muted")
            if cursor:
                args += ["--cursor", str(cursor)]
            r = self.call(args)
            if not r.ok:
                if out:
                    break
                raise DwsError(r.command, r.error, r.transient)
            res = r.result or {}
            out.extend(res.get("conversations") or [])
            if not res.get("hasMore") or not res.get("nextCursor"):
                break
            cursor = res["nextCursor"]
        return out

    def list_all_messages(self, start: str, end: str, page_size: int = 100,
                          max_pages: int = 100000) -> Iterable[dict]:
        """Yield normalized messages in [start, end) across all conversations.

        Pages via cursor. Raises on first-page failure (nothing was read);
        stops early on a later-page failure so partial data is still usable —
        the caller records the highest complete timestamp as its checkpoint.
        """
        cursor = "0"
        pages = 0
        while pages < max_pages:
            r = self.call(["chat", "message", "list-all", "--start", start,
                           "--end", end, "--limit", str(page_size),
                           "--cursor", str(cursor)])
            if not r.ok:
                if pages == 0:
                    raise DwsError(r.command, r.error, r.transient)
                return
            res = r.result or {}
            for conv in res.get("conversationMessagesList") or []:
                meta = {
                    "openConversationId": conv.get("openConversationId") or "",
                    "title": conv.get("title") or "",
                    "singleChat": bool(conv.get("singleChat")),
                }
                # list-all returns newest-first within a conversation
                for msg in reversed(conv.get("messages") or []):
                    yield normalize_message(msg, meta)
            pages += 1
            nxt = res.get("nextCursor")
            if not res.get("hasMore") or not nxt or nxt == cursor:
                return
            cursor = nxt

    def mentions(self, start_iso: str, end_iso: str, limit: int = 50) -> list[dict]:
        """@-me messages in an ISO-8601 window (separate API, separate paging)."""
        out: list[dict] = []
        cursor = "0"
        for _ in range(200):
            r = self.call(["chat", "message", "list-mentions", "--start", start_iso,
                           "--end", end_iso, "--limit", str(limit), "--cursor", cursor])
            if not r.ok:
                break
            res = r.result or {}
            items = res.get("messages") or res.get("list") or []
            if isinstance(res, list):
                items = res
            for m in items:
                out.append(normalize_message(m, {
                    "openConversationId": m.get("openConversationId") or "",
                    "title": m.get("conversationTitle") or m.get("title") or "",
                    "singleChat": bool(m.get("singleChat")),
                }))
            nxt = res.get("nextCursor") if isinstance(res, dict) else None
            if not (isinstance(res, dict) and res.get("hasMore")) or not nxt or nxt == cursor:
                break
            cursor = nxt
        return out

    def conversation_tail(self, conv_id: str, single: bool, since: str,
                          peer_open_id: str = "", limit: int = 30) -> list[dict]:
        """The MOST RECENT messages of one conversation, oldest→newest.

        `--direction newer` from a timestamp returns the oldest page of that
        window, so asking for 20 messages since yesterday yields yesterday's
        first 20 — useless for "has anything newer arrived?". `older` from the
        present walks backwards from now, which is what a freshness check needs.

        Single chats must be addressed by the peer's openDingTalkId; passing a
        conversation id to `list --user` returns a business error, which is what
        made the previous poller fail on every direct chat.
        """
        args = ["chat", "message", "list", "--direction", "older",
                "--time", time.strftime("%Y-%m-%d %H:%M:%S",
                                        time.localtime(time.time() + 60)),
                "--limit", str(limit)]
        if single:
            if not peer_open_id:
                return []
            args += ["--open-dingtalk-id", peer_open_id]
        else:
            args += ["--group", conv_id]
        r = self.call(args)
        if not r.ok:
            return []
        msgs = (r.result or {}).get("messages") or []
        meta = {"openConversationId": conv_id, "title": "", "singleChat": single}
        out = [normalize_message(m, meta) for m in msgs]
        out.sort(key=lambda m: m["createdAt"])
        if since:
            cutoff = parse_ts(since)
            if cutoff:
                out = [m for m in out if parse_ts(m["createdAt"]) >= cutoff] or out
        return out

    # -- write -------------------------------------------------------------

    def send(self, target: dict, text: str, cfg: dict | None = None,
             recipient: str = "", audit_path: Path | None = None) -> DwsResult:
        """Send as the owner — enforcing the autonomy scope in the process.

        The gate lives HERE, at the lowest layer that can actually reach DingTalk,
        not only in the caller. Previously `persona.py` held every check while this
        method was bare, so anything that did `import imruntime` could message the
        owner's colleagues with no scope check, no allowlist, and — worse — no
        entry in the agent-sent ledger, which means the next distillation would
        learn the agent's own words as the owner's authentic style.

        Passing `cfg` is what unlocks sending. Calling without it is refused
        outright, so a new call site cannot accidentally inherit send rights.

        The gate also inspects the OUTGOING TEXT, not only the recipient, and does
        so BEFORE the scope and allowlist checks. Checking who may receive a reply
        while never checking what it says leaves the worst case wide open: an
        innocuous question answered with a commitment, a price, or an approval. A
        capable model rarely drafts that; a weaker one does, and the whole point of
        this layer is that it does not depend on the caller's judgment.
        `cfg["riskPatterns"]` supplies the patterns (persona.py reads them from the
        published rules.json) and their ABSENCE — missing OR empty — is
        fail-closed: unverifiable text is not auto-sent.
        """
        if cfg is None:
            return DwsResult(False, error=(
                "refusing to send without an autonomy config: the scope, allowlist "
                "and ledger are not optional. Use persona.py send, or pass cfg="))

        auto = (cfg.get("autonomy") or {})
        scope = auto.get("scope", "draft_only")
        allow_ids = set(auto.get("allowlist") or [])
        max_cp = auto.get("maxCodepoints", 300)
        single = bool(target.get("open-dingtalk-id") or target.get("user"))
        peer_id = str(target.get("open-dingtalk-id") or "")

        def refuse(reason: str) -> DwsResult:
            if audit_path:
                audit(audit_path, {"event": "send_blocked_at_runtime",
                                   "reason": reason, "scope": scope,
                                   "recipient": recipient, "peerOpenId": peer_id,
                                   "textLength": len(text or "")})
            return DwsResult(False, error=reason)

        if not (text or "").strip():
            return refuse("empty text")

        # Content gate FIRST, before any recipient or scope check. `riskPatterns`
        # maps a risk class to a regex; a hit means the draft itself states
        # something in a class the owner never delegates.
        #
        # The order is deliberate. A draft that says "approved, I guarantee Friday"
        # is wrong for every recipient in every scope, so leading with "sending is
        # disabled" would name the scope as the thing standing in the way and imply
        # that widening it is the fix. The content is the thing standing in the way.
        #
        # An EMPTY mapping is as unverifiable as a missing one: a locale pack with
        # no risk patterns can detect nothing, so every draft would pass a check
        # that never ran. Absence of evidence is not permission here either.
        risk_patterns = cfg.get("riskPatterns")
        if not risk_patterns:
            return refuse(
                "cannot verify the draft's content: no risk patterns available "
                "(references/rules.json missing or unreadable, or this locale pack "
                "detects no risk classes). Refusing to auto-send unverifiable text "
                "— draft it for the owner instead")
        hit = []
        for name, pattern in risk_patterns.items():
            try:
                if re.search(pattern, text, re.I):
                    hit.append(name)
            except re.error:
                continue
        if hit:
            return refuse(
                f"the reply itself touches {', '.join(sorted(hit))} — these are "
                f"never settled by an agent, whatever the recipient's band or the "
                f"autonomy scope. Draft it for the owner")

        if scope == "draft_only":
            return refuse("autonomy scope is draft_only — sending is disabled")
        if scope not in ("allowlist", "everyone"):
            return refuse(f"unknown autonomy scope '{scope}'; treating as draft_only")
        if len(text) > max_cp:
            return refuse(f"reply is {len(text)} characters, over the {max_cp} limit")

        if not single:
            return refuse("groups are never auto-answered: no single recipient whose "
                          "relationship can be resolved, and a mis-send is visible "
                          "to everyone in the group")
        if scope == "allowlist":
            if not peer_id:
                return refuse("allowlist scope needs the recipient's openDingTalkId; "
                              "a display name is not an identity")
            if peer_id not in allow_ids:
                return refuse(f"({peer_id[:12]}…) is not in the autonomy allowlist")

        args = ["chat", "message", "send"]

        for key in ("group", "user", "open-dingtalk-id"):
            if target.get(key):
                args += [f"--{key}", str(target[key])]
                break
        else:
            return refuse("no send target given")
        args += ["--text", text, "--yes"]
        return self.call(args, retries=1)   # never silently double-send


def normalize_message(msg: dict, conv: dict) -> dict:
    """DWS message → the one shape everything downstream uses."""
    quoted = msg.get("quotedMessage") or {}
    return {
        "messageId": msg.get("openMessageId") or msg.get("messageId") or "",
        "conversationId": conv.get("openConversationId") or msg.get("openConversationId") or "",
        "conversationTitle": conv.get("title") or "",
        "singleChat": bool(conv.get("singleChat")),
        "senderId": msg.get("senderOpenDingTalkId") or "",
        "senderName": msg.get("sender") or "",
        "createdAt": msg.get("createTime") or "",
        "msgType": (msg.get("msgtype") or ("text" if msg.get("content") else "other")),
        "text": msg.get("content") or "",
        "quotedText": quoted.get("content") or "",
        "quotedSenderName": quoted.get("sender") or "",
        "quotedSenderId": quoted.get("senderOpenDingTalkId") or "",
        "threadId": msg.get("openConvThreadId") or "",
    }


def now_str() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def parse_ts(text: str) -> float:
    """DWS timestamps: 'YYYY-MM-DD HH:MM:SS' or ISO-8601. 0.0 if unparseable."""
    if not text:
        return 0.0
    t = text.strip().replace("T", " ")
    t = re.sub(r"([+-]\d{2}:?\d{2}|Z)$", "", t).strip()
    t = t.split(".")[0]
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return time.mktime(time.strptime(t, fmt))
        except ValueError:
            continue
    return 0.0


# ---------------------------------------------------------------------------
# Host store (read-only) — a near-realtime database maintained by someone else
# ---------------------------------------------------------------------------


class HostStore:
    """Read a conversation's newest messages from an embedding application's own
    database, and say how far behind that database is.

    ## Why this exists next to `Corpus`

    `Corpus` is the forge's own store: its freshness is "whenever `forge pull` last
    ran", which can be days. This one is a database that something else keeps
    close to current on a short cycle, so it can answer "what was just said" —
    but only if the reader can see how stale it might be. Both are read-only and
    both are local; the difference is who refreshes them and how often, and that
    difference is exactly what the caller has to reason about.

    ## Why the lag is not optional

    A pre-send freshness check that reads messages without knowing the lag has to
    assume the best, and assuming the best is how an agent answers a question the
    other person already withdrew. So every read returns `lagSeconds`, and `None`
    (unknown) is a distinct answer that callers must treat as unsafe rather than
    as zero.

    Schema is passed in rather than hardcoded: this class knows the SHAPE of the
    question, not one application's column names. The defaults match the reference
    host, and a different one supplies its own mapping in config.
    """

    #: Column and table names of the reference host. Overridable via config so a
    #: differently-shaped host does not need a code change.
    DEFAULTS = {
        "messagesTable": "messages",
        "conversationsTable": "conversations",
        "cursorsTable": "sync_cursors",
        "channelColumn": "channel_id",
        "channel": "dingtalk",
    }

    def __init__(self, db_path: str | Path, schema: dict | None = None,
                 utc_offset_minutes: int = 480):
        self.path = Path(os.path.expanduser(str(db_path)))
        if not self.path.exists():
            raise FileNotFoundError(f"host store not found: {self.path}")
        self.schema = {**self.DEFAULTS, **(schema or {})}
        self.offset_minutes = utc_offset_minutes
        # Read-only by URI: the application owns this file and may be writing it.
        self.conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        self.conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _wall_clock(self, ms: int) -> str:
        moment = (dt.datetime(1970, 1, 1)
                  + dt.timedelta(milliseconds=int(ms), minutes=self.offset_minutes))
        return moment.strftime("%Y-%m-%d %H:%M:%S")

    def collection_lag(self) -> dict:
        """`{lagSeconds, through}` from the host's own "persisted through" marker.

        Not from the newest message's timestamp: a quiet conversation would then
        report hours of lag and look broken when collection is perfectly current.
        No marker at all yields `None` — unknown, never zero.
        """
        s = self.schema
        try:
            row = self.conn.execute(
                f"SELECT MAX(watermark) AS watermark FROM {s['cursorsTable']} "
                f"WHERE watermark > 0").fetchone()
        except sqlite3.Error:
            return {"lagSeconds": None, "through": ""}
        watermark = None if row is None else row["watermark"]
        if not watermark:
            return {"lagSeconds": None, "through": ""}
        now_ms = int(time.time() * 1000)
        return {"lagSeconds": max(0, int((now_ms - int(watermark)) / 1000)),
                "through": self._wall_clock(int(watermark))}

    def recent_messages(self, conv_id: str, limit: int = 30) -> dict:
        """Newest messages of one conversation, oldest→newest, plus the lag.

        `isOwner` and `isAgentSent` are separate flags on purpose: a reply this
        tooling already sent is also the owner's id, and a freshness check that
        conflates them reads the agent's own message as "the owner already
        answered" — which silently suppresses every follow-up.
        """
        s = self.schema
        rows = self.conn.execute(
            f"SELECT m.id, m.sender_external_id, m.sender_display_name, m.content_text,"
            f"       m.sent_at, m.is_self, m.origin"
            f"  FROM {s['messagesTable']} m"
            f" WHERE m.{s['channelColumn']} = ? AND m.conversation_id = ?"
            f" ORDER BY m.sent_at DESC, m.id DESC LIMIT ?",
            (s["channel"], conv_id, int(limit))).fetchall()
        messages = [{
            "messageId": r["id"],
            "senderId": r["sender_external_id"] or "",
            "senderName": r["sender_display_name"] or "",
            "createdAt": self._wall_clock(r["sent_at"]),
            "text": r["content_text"] or "",
            "isOwner": r["is_self"] == 1,
            "isAgentSent": (r["origin"] or "human") == "agent",
        } for r in reversed(rows)]
        return {"messages": messages, **self.collection_lag()}


# ---------------------------------------------------------------------------
# Corpus (read-only)
# ---------------------------------------------------------------------------

class Corpus:
    """Read-only access to the local corpus. Used by the forge and, at runtime,
    by the published skill to recall how the owner really replied before."""

    def __init__(self, db_path: str | Path):
        self.path = Path(os.path.expanduser(str(db_path)))
        if not self.path.exists():
            raise FileNotFoundError(f"corpus not found: {self.path}")
        self.conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        self.conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def meta(self, key: str, default: str = "") -> str:
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    # -- recall ------------------------------------------------------------

    def similar_turns(self, context: str, k: int = 6, tone: str | None = None,
                      scene: str | None = None, person: str | None = None) -> list[dict]:
        """Given what the counterparty just said, return past turns whose context
        was similar, with the owner's real reply. The core accuracy primitive."""
        terms = search_terms(context)
        rows: list[sqlite3.Row] = []
        if terms:
            expr = " OR ".join('"' + t.replace('"', '""') + '"' for t in terms)
            sql = ("SELECT t.*, bm25(turns_fts) AS rank FROM turns_fts f "
                   "JOIN turns t ON t.rowid=f.rowid WHERE turns_fts MATCH ?")
            params: list = [expr]
            if tone:
                sql += " AND t.tone_band=?"
                params.append(tone)
            if scene:
                sql += " AND t.scene=?"
                params.append(scene)
            if person:
                sql += " AND t.peer_name=?"
                params.append(person)
            sql += " ORDER BY rank LIMIT ?"
            params.append(k)
            try:
                rows = self.conn.execute(sql, params).fetchall()
            except sqlite3.OperationalError:
                rows = []
        if not rows:
            sql = "SELECT * FROM turns WHERE 1=1"
            params = []
            if person:
                sql += " AND peer_name=?"
                params.append(person)
            if tone:
                sql += " AND tone_band=?"
                params.append(tone)
            sql += " ORDER BY occurred_at DESC LIMIT ?"
            params.append(k)
            rows = self.conn.execute(sql, params).fetchall()
        return [{
            "context": r["context_text"], "reply": r["my_reply"],
            "scene": r["scene"], "toneBand": r["tone_band"],
            "peer": r["peer_name"], "occurredAt": r["occurred_at"],
            "askKind": r["ask_kind"],
        } for r in rows]

    def my_lines(self, query: str | None = None, k: int = 8, scene: str | None = None,
                 person: str | None = None) -> list[dict]:
        """The owner's own messages, optionally keyword- and person-filtered.

        Every filter applies to BOTH the FTS branch and the fallback. That is not
        a detail: a `person`-scoped query whose keywords miss used to fall through
        to a global query and return lines the owner wrote to *someone else*,
        while still looking like an answer about that person. Reading those as
        "how they talk to X" produces a reply in the wrong register — measured
        a term of address can be constant with one colleague and absent with
        another, so leaking it across is immediately wrong.

        `person` is matched against the conversation's peer name and title, and
        also against the resolved person record, so a nickname still works.
        """
        person_clause = (
            " AND {alias}conversation_id IN ("
            "  SELECT conversation_id FROM conversations"
            "   WHERE peer_name=? OR title=?"
            "      OR peer_open_id IN (SELECT person_id FROM people"
            "                           WHERE name=? OR nick=? OR alias=?))")
        person_params = [person] * 5 if person else []

        rows: list[sqlite3.Row] = []
        matched = False
        terms = search_terms(query or "", max_terms=6)
        if terms:
            fts_terms = [t for t in terms if len(t) >= 3]
            like_terms = [t for t in terms if len(t) < 3]
            if fts_terms:
                expr = " OR ".join('"' + t.replace('"', '""') + '"' for t in fts_terms)
                sql = ("SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid=f.rowid "
                       "WHERE messages_fts MATCH ? AND m.is_self=1 AND m.is_pasted=0")
                params: list = [expr]
            else:
                # Only short CJK words: trigram FTS cannot index them, so match
                # directly. Slower, but correct — and the alternative was silently
                # returning unrelated recent lines.
                sql = ("SELECT * FROM messages WHERE is_self=1 AND is_pasted=0 AND ("
                       + " OR ".join("clean_text LIKE ?" for _ in like_terms) + ")")
                params = [f"%{t}%" for t in like_terms]
            if person:
                sql += person_clause.format(alias="m." if fts_terms else "")
                params += person_params
            if scene:
                sql += (" AND m.scene=?" if fts_terms else " AND scene=?")
                params.append(scene)
            sql += (" ORDER BY m.occurred_at DESC LIMIT ?" if fts_terms
                    else " ORDER BY occurred_at DESC LIMIT ?")
            params.append(k)
            try:
                rows = self.conn.execute(sql, params).fetchall()
                matched = bool(rows)
            except sqlite3.OperationalError:
                rows = []
        if not rows:
            sql = "SELECT * FROM messages WHERE is_self=1 AND is_pasted=0"
            params = []
            if person:
                sql += person_clause.format(alias="")
                params += person_params
            if scene:
                sql += " AND scene=?"
                params.append(scene)
            sql += " ORDER BY occurred_at DESC LIMIT ?"
            params.append(k)
            rows = self.conn.execute(sql, params).fetchall()
        return [{"text": r["text"], "occurredAt": r["occurred_at"],
                 "scene": r["scene"],
                 # Whether this line actually matched the query, or is just recent
                 # context shown because nothing matched. Without this, an empty
                 # search for a term returns unrelated recent lines that read
                 # as evidence the term was used.
                 "matchedQuery": matched} for r in rows]

    def search_all(self, query: str, k: int = 12, person: str | None = None
                   ) -> dict:
        """Every message matching `query`, from ANYONE — a fact-check primitive.

        Distinct from `my_lines`, which only returns the owner's own text. That is
        the right scope for "how do they phrase things" and the wrong one for "is
        this true": most facts about a project, a person or a decision were stated
        by somebody else, and a search that cannot see those lines reports "no
        evidence" for things the corpus knows perfectly well.

        The verdict is the point. A caller that gets `evidence` may ground a reply
        in what it found; a caller that gets `none` has learned something real —
        the corpus does not contain this — and must say so rather than produce a
        plausible answer. Without an explicit `none`, "I could not find it" and "I
        did not look" are indistinguishable, and a model under pressure to be
        helpful will fill the gap.
        """
        terms = search_terms(query or "", max_terms=6)
        if not terms:
            return {"query": query, "terms": [], "verdict": "none", "hits": [],
                    "totalHits": 0,
                    "guidance": "no searchable terms in that query"}

        fts_terms = [t for t in terms if len(t) >= 3]
        like_terms = [t for t in terms if len(t) < 3]
        rows: list[sqlite3.Row] = []
        if fts_terms:
            expr = " OR ".join('"' + t.replace('"', '""') + '"' for t in fts_terms)
            sql = ("SELECT m.*, c.title AS conv_title FROM messages_fts f "
                   "JOIN messages m ON m.rowid=f.rowid "
                   "LEFT JOIN conversations c ON c.conversation_id=m.conversation_id "
                   "WHERE messages_fts MATCH ? AND m.is_pasted=0")
            params: list = [expr]
        else:
            # Short words in a script trigram FTS cannot index. Matching directly
            # is slower but correct; falling through to "recent messages" would
            # dress up a miss as an answer.
            sql = ("SELECT m.*, c.title AS conv_title FROM messages m "
                   "LEFT JOIN conversations c ON c.conversation_id=m.conversation_id "
                   "WHERE m.is_pasted=0 AND ("
                   + " OR ".join("m.clean_text LIKE ?" for _ in like_terms) + ")")
            params = [f"%{t}%" for t in like_terms]

        if person:
            sql += (" AND m.conversation_id IN (SELECT conversation_id FROM "
                    "conversations WHERE peer_name=? OR title=? OR peer_open_id IN "
                    "(SELECT person_id FROM people WHERE name=? OR nick=? OR alias=?))")
            params += [person] * 5

        sql += " ORDER BY m.occurred_at DESC LIMIT ?"
        params.append(max(1, k))
        try:
            rows = self.conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError:
            rows = []

        # Two filters, both load-bearing for the honesty of the verdict.
        #
        # A hit must contain a term the caller actually asked about. The query is
        # expanded into several grams and OR-ed for recall, so without this a
        # single junk gram — or an ASCII fragment that happens to sit inside a
        # base64 media id — turns a genuine miss into "evidence found", which is
        # the one outcome this method must never fake.
        #
        # And a hit must be something a person wrote. Attachment stubs and rich
        # cards match keywords readily and support no factual claim at all.
        # Score by how many DISTINCT query terms a message contains, and require
        # more than one when the query produced several. Terms are OR-ed at the
        # index for recall, so a single incidental gram — `zzz` inside a base64
        # blob, one character pair inside an unrelated broadcast — would otherwise
        # be enough to report "evidence" for a query the corpus never saw.
        wanted = [t.lower() for t in terms]
        min_terms = 2 if len(wanted) > 2 else 1
        hits = []
        for r in rows:
            text = r["clean_text"] or ""
            if _looks_generated(text):
                continue
            low = text.lower()
            matched = [w for w in wanted if w in low]
            if len(matched) < min_terms:
                continue
            hits.append({
                "matchedTerms": matched,
                "at": r["occurred_at"],
                "bySelf": bool(r["is_self"]),
                "sender": ("self" if r["is_self"] else (r["sender_name"] or "")),
                "conversation": r["conv_title"] or "",
                "text": text[:300],
            })
        found = bool(hits)
        # Which of the query's own terms were actually corroborated. A query is
        # expanded into several terms, and a hit on one of them is not evidence
        # for the whole question: "OKR" appearing somewhere does not establish
        # anything about a quarterly OKR score. Saying which part matched is what
        # keeps a caller from reading partial support as a full answer.
        corroborated = sorted({m for h in hits for m in h["matchedTerms"]})
        # Compared against the ORIGINAL query, not against the expanded terms.
        # `search_terms` drops what it cannot index, so a term that never reached
        # the index would otherwise be silently counted as corroborated — and
        # "OKR exists somewhere" would read as support for a question about a
        # quarterly OKR score.
        # Split on the script boundary as well as on whitespace: a mixed query
        # such as a Han phrase wrapped around an ASCII acronym is several claims,
        # and treating it as one token would let a hit on the acronym alone stand
        # in for the whole thing.
        asked = [w for w in re.findall(
            rf"[{_UNSEGMENTED}]{{2,}}|[A-Za-z][A-Za-z0-9_.-]{{1,}}", query or "") if w]
        unmatched = [w for w in asked
                     if not any(w.lower() in c or c in w.lower()
                                for c in corroborated)]
        partial = bool(unmatched) and bool(corroborated)
        return {
            "query": query,
            "terms": terms,
            "scopedTo": person or "",
            "verdict": "evidence" if found else "none",
            "corroborated": corroborated,
            "notFound": unmatched,
            "partial": partial,
            "totalHits": len(hits),
            "hits": hits,
            "guidance": (
                (f"PARTIAL: only {', '.join(corroborated)} is corroborated; "
                 f"{', '.join(unmatched)} was not found. Do not treat this as "
                 f"support for the whole question — the lines below are about "
                 f"something adjacent."
                 if partial else
                 "Grounded: these lines are in the corpus. Quote the FACT, never the "
                 "old wording, and check the date — a true statement from months ago "
                 "may not be true now.")
                if found else
                "NOT IN THE CORPUS. Do not answer from general knowledge and do not "
                "invent a plausible value. Say you do not know, in their voice, or "
                "leave it for the owner."),
        }

    def person(self, name: str) -> dict | None:
        """Look up one person by display name. Ambiguity is reported, not guessed.

        Names are not identities: in a real corpus one display name routinely maps
        to several accounts, and several people share a given name. Returning the first
        would silently pick one, so a caller that needs certainty must key on
        `person_id` (see `person_by_id`). The `ambiguous` flag lets a caller
        refuse rather than act on a coin flip.
        """
        rows = self.conn.execute(
            "SELECT * FROM people WHERE name=? OR nick=? OR alias=? "
            "ORDER BY msgs_from DESC", (name, name, name)).fetchall()
        if not rows:
            return None
        best = dict(rows[0])
        if len(rows) > 1:
            best["ambiguous"] = True
            best["candidateCount"] = len(rows)
        return best

    def person_by_id(self, person_id: str) -> dict | None:
        """Resolve by openDingTalkId — the only identifier that cannot be edited
        by renaming a conversation, and therefore the only one an autonomy gate
        may trust."""
        row = self.conn.execute(
            "SELECT * FROM people WHERE person_id=?", (person_id,)).fetchone()
        return dict(row) if row else None

    def conversation_history(self, conv_id: str, limit: int = 40) -> list[dict]:
        rows = self.conn.execute(
            "SELECT sender_name, is_self, text, occurred_at FROM messages "
            "WHERE conversation_id=? ORDER BY occurred_at DESC LIMIT ?",
            (conv_id, limit)).fetchall()
        return [dict(r) for r in reversed(rows)]

    def counts(self) -> dict:
        out = {}
        for table in ("messages", "conversations", "people", "turns"):
            try:
                out[table] = self.conn.execute(f"SELECT COUNT(*) c FROM {table}").fetchone()["c"]
            except sqlite3.OperationalError:
                out[table] = 0
        return out


# Scripts written without spaces between words. Escapes, not literal
# characters, so this file carries no text in any human language.
_UNSEGMENTED = "\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff"


#: Message text that no person typed: attachment stubs, media ids, download
#: hints, bare links. `common.is_placeholder` does this job in the forge, but the
#: published skill cannot import it, and a fact search that returns a media id as
#: evidence is worse than one that returns nothing.
_GENERATED_RE = re.compile(
    r"(fileId\s*[:：=]|mediaId\s*[:：=]|\bmediaId=|download-media|"
    r"^\s*https?://\S+\s*$|\burl\s*[:：]\s*https?://)", re.I | re.M)


def _looks_generated(text: str) -> bool:
    return bool(text) and bool(_GENERATED_RE.search(text))


def search_terms(text: str, max_terms: int = 12) -> list[str]:
    """Trigram-FTS-friendly search terms.

    Chinese has no spaces, so whitespace splitting yields one long token trigram
    FTS can never match. Keep ASCII identifiers and slide 3/4-grams over CJK runs.
    """
    if not text:
        return []
    terms: list[str] = [t for t in re.findall(r"[A-Za-z0-9_./-]{3,}", text)]
    # Trigram FTS needs >=3 characters, so a two-character word — the most
    # common shape in Chinese and Japanese — produced NO terms at all and the
    # query silently fell through to "most recent lines". Runs of 2 are kept as
    # LIKE candidates instead of being dropped.
    short_cjk: list[str] = []
    for run in re.findall(rf"[{_UNSEGMENTED}]{{2,}}", text):
        if len(run) < 3:
            short_cjk.append(run)
            continue
        for n in (4, 3):
            for i in range(len(run) - n + 1):
                terms.append(run[i:i + n])
    seen: set[str] = set()
    out: list[str] = []
    for t in sorted(terms, key=lambda s: -len(s)):
        if t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
        if len(out) >= max_terms:
            break
    if not out:
        # Nothing trigram-searchable: hand back the short words so the caller can
        # still match them with LIKE rather than pretending there was no query.
        return short_cjk[:max_terms]
    return out


def audit(path: str | Path, record: dict) -> None:
    p = Path(os.path.expanduser(str(path)))
    p.parent.mkdir(parents=True, exist_ok=True)
    rec = {"at": now_str(), **record}
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    os.chmod(p, 0o600)
