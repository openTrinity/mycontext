#!/usr/bin/env python3
"""JSONL import — a normalized export from any platform, read offline.

This is the forge's supported on-ramp for platforms with no adapter. Export your
history however you can (an official data export, a Slack/Teams/Feishu API
script, an email scrape), convert it to the normalized shape documented in
`forge/sources/__init__.py`, and the entire measurement engine works unchanged.

It matters for two reasons beyond convenience:

1. **It proves the seam is real.** A single-adapter abstraction is a claim, not a
   fact. This one exercises the same `ingest.pull` path the network adapter uses,
   so a platform assumption leaking back into the engine breaks a test rather
   than surfacing months later on someone else's machine.
2. **It is fully offline.** No credentials, no network, no throttling — which
   makes it what the self-test suite runs against.

What it deliberately does NOT do is send, tail a live conversation, or resolve
@-mentions from a server. A file is a snapshot. `capabilities()` says so, and the
persona's send path refuses on that basis rather than failing obscurely.

## Layout

Point `source.options.path` at either:

  - one `.jsonl` file: one normalized message object per line, OR
  - a directory: every `*.jsonl` inside it, read in sorted filename order.

Malformed lines are counted and skipped, never fatal: a 200k-line export with
three bad rows should still import, and the count is reported so the gap is
visible instead of silent.

## Identity

The owner cannot be inferred from a file — every id in it looks alike. Supply it
in config:

    "source": {
      "kind": "jsonl",
      "options": {
        "path": "~/exports/slack",
        "identity": {
          "userId": "U0123456",
          "name": "Real Name",
          "openIds": ["U0123456"],
          "aliases": ["Real Name", "realname"]
        }
      }
    }

`openIds` is what attributes a message to the owner; `aliases` is what detects an
@-mention in text. Getting these wrong is the one failure mode that produces a
confident, wrong persona — a corpus where the owner's own messages are attributed
to somebody else — so the adapter refuses to run without them rather than
guessing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

from . import BaseSource


class JsonlSource(BaseSource):
    KIND = "jsonl"
    PLATFORM_LABEL = "imported chat export"
    ID_LABEL = "user id"

    #: A generic export has no single id format, so the share scanner is told
    #: there is nothing platform-specific to look for. It still checks
    #: credentials, home paths and conversation-id shapes, and `forge report`
    #: discloses the reduced coverage rather than implying a clean bill of health.
    ID_PATTERN = None

    #: A file is a snapshot: no live reads, no sending. Mentions are still
    #: detected, just from the message text and the owner's aliases rather than
    #: from a server-side endpoint.
    CAPS = {"read": True, "mentions": False, "tail": False, "send": False,
            "directory": False}

    def __init__(self, cfg: dict | None = None, path: str = "",
                 identity: dict | None = None, **_ignored):
        cfg = cfg or {}
        if not path:
            raise SystemExit(
                "the jsonl source needs source.options.path — a .jsonl file or a "
                "directory of them")
        from .. import common as C
        self.path = C.expand(path)
        if not self.path.exists():
            raise SystemExit(f"jsonl source path does not exist: {self.path}")
        self.identity_cfg = identity or {}
        # Keyed by (file, line number) rather than counted, because the records
        # are scanned more than once per pull (once to rebuild the directory, once
        # per time window) and a running counter would multiply the same three bad
        # rows into an alarming number that means nothing.
        self._malformed: set[tuple[str, int]] = set()
        #: Rows read successfully whose `createdAt` could not be understood. Keyed
        #: for the same reason as `_malformed`, and reported separately because the
        #: two point at different mistakes: a broken line vs a wrong field or unit.
        self._undated: set[tuple[str, str]] = set()
        #: Rows deliberately outside the requested window — the normal, healthy
        #: reason to skip something. Counted so it can be told apart from the
        #: pathological reasons above.
        self._out_of_window = 0
        self._seen_conversations: dict[str, dict] = {}

    def capabilities(self) -> dict:
        return {**self.static_capabilities(), "timezone": None,
                "notes": "offline snapshot: no live reads and no sending"}

    def identity(self) -> dict:
        ident = self.identity_cfg
        open_ids = [str(i) for i in (ident.get("openIds") or []) if i]
        user_id = str(ident.get("userId") or "")
        if not open_ids and user_id:
            open_ids = [user_id]
        if not open_ids:
            raise SystemExit(
                "the jsonl source cannot guess who the owner is. Set "
                "source.options.identity.openIds (and ideally aliases) in the "
                "config — every message in an export looks alike, and attributing "
                "them to the wrong person yields a confident, wrong persona.")
        name = ident.get("name") or ""
        aliases = [str(a) for a in (ident.get("aliases") or []) if a] or (
            [name] if name else [])
        return {"userId": user_id or open_ids[0],
                # See vault.py for why this is named after the concept rather
                # than one vendor's field. The operator may supply it; absent
                # it the slug falls back to userId alone (documented in common).
                "orgId": str(ident.get("orgId") or ident.get("corpId") or ""),
                "name": name,
                "openIds": sorted(set(open_ids)),
                "excludedOpenIds": [str(i) for i in
                                    (ident.get("excludedOpenIds") or [])],
                "aliases": sorted(set(aliases))}

    # -- reads ---------------------------------------------------------------

    def _files(self) -> list[Path]:
        if self.path.is_dir():
            return sorted(self.path.glob("*.jsonl"))
        return [self.path]

    def _records(self) -> Iterator[dict]:
        for f in self._files():
            with open(f, "r", encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, 1):
                    line = line.strip()
                    if not line or line.startswith("//"):
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        self._malformed.add((f.name, lineno))
                        continue
                    if isinstance(rec, dict) and rec.get("messageId"):
                        # Stamped onto the record so a later complaint can name the
                        # line the operator has to go fix. Carried on the dict
                        # rather than in a side table keyed by id(), because CPython
                        # recycles ids once a record is collected — and `_normalize`
                        # copies only known keys, so this never reaches the corpus.
                        rec["_sourceLine"] = f"{f.name}:{lineno}"
                        yield rec
                    else:
                        self._malformed.add((f.name, lineno))

    @staticmethod
    def _where(rec: dict) -> str:
        return str(rec.get("_sourceLine") or "?")

    def conversations(self) -> list[dict]:
        """The directory, reconstructed from the messages themselves.

        An export rarely ships a separate conversation inventory, and one derived
        from the messages is guaranteed consistent with them — no thread can
        appear in the corpus without metadata.
        """
        convs: dict[str, dict] = {}
        for rec in self._records():
            cid = str(rec.get("conversationId") or "")
            if not cid:
                continue
            entry = convs.setdefault(cid, {
                "conversationId": cid,
                "title": str(rec.get("conversationTitle") or ""),
                "singleChat": bool(rec.get("singleChat")),
                "peerOpenId": "", "peerName": "",
                "memberCount": 0, "muted": False, "lastMsgAt": "",
            })
            if not entry["title"] and rec.get("conversationTitle"):
                entry["title"] = str(rec["conversationTitle"])
            at = _norm_ts(rec.get("createdAt"))
            if at > entry["lastMsgAt"]:
                entry["lastMsgAt"] = at
        for entry in convs.values():
            if entry["singleChat"] and entry["title"]:
                entry["peerName"] = entry["title"]
        self._seen_conversations = convs
        return list(convs.values())

    def messages(self, start: str, end: str, page_size: int = 0) -> Iterator[dict]:
        """Records within [start, end), normalized and time-ordered.

        The window is applied here rather than ignored so that `--since auto`
        incremental runs behave identically to the network adapters: re-importing
        the same file after new lines are appended adds only what is new.

        A row whose timestamp cannot be read is counted as UNDATED and reported by
        `stats()`, never merely skipped. An export using the wrong key or unit for
        its timestamps would otherwise import as zero messages while every health
        signal — malformedLines, complete, failedSlices — stayed clean, which is
        exactly the "failure looks identical to no data" shape this forge exists to
        avoid. It is the same class of bug as the unread-conversations poller.
        """
        lo, hi = _norm_ts(start), _norm_ts(end)
        batch = []
        for rec in self._records():
            at = _norm_ts(rec.get("createdAt"))
            if not at:
                self._undated.add((self._where(rec), str(rec.get("messageId") or "")))
                continue
            if at < lo or at >= hi:
                self._out_of_window += 1
                continue
            batch.append(_normalize(rec, at))
        batch.sort(key=lambda m: (m["createdAt"], m["messageId"]))
        yield from batch

    def stats(self) -> dict:
        """What the import saw, including what it could not use.

        `undatedLines` is the number that matters when an import comes back empty:
        a nonzero value means the file was read fine and its timestamps were not,
        which points at the exporter rather than at the window or the credentials.
        """
        out = {"files": len(self._files()),
               "malformedLines": len(self._malformed),
               "malformedAt": [f"{name}:{n}" for name, n
                               in sorted(self._malformed)[:10]],
               "undatedLines": len(self._undated),
               "undatedAt": [w for w, _ in sorted(self._undated)[:10]],
               "outOfWindow": self._out_of_window}
        if self._undated:
            # `unusableRows` + `unusableReason` are what `ingest.pull` reads to
            # decide `complete` and to say WHY. Stating the reason here keeps the
            # diagnosis with the source that knows it, rather than in a caller
            # that would have to guess which failure mode applied.
            out["unusableRows"] = len(self._undated)
            out["unusableReason"] = (
                "no readable `createdAt` timestamp — see sourceStats.undatedAt "
                "and undatedHint")
            out["undatedHint"] = (
                "these rows have no readable `createdAt`. The field must be a string "
                "like \"2026-07-30 09:15:00\" or ISO 8601 — a unix epoch number is "
                "rejected rather than guessed at, because its unit (s/ms/µs) cannot "
                "be inferred and a wrong guess silently corrupts every latency "
                "measurement. Convert it in your exporter.")
        return out


def _norm_ts(value: object) -> str:
    """Accept ISO 8601 or "YYYY-MM-DD HH:MM:SS"; return the latter, or "".

    Comparisons throughout the forge are lexicographic on this format, so
    normalizing at the boundary is what keeps a mixed-format export sortable.
    Any trailing offset is dropped rather than converted: the corpus is stored in
    the operator's local wall-clock time, and silently shifting some rows by an
    offset while leaving others alone would corrupt every latency measurement.

    Anything that is not a recognizable wall-clock string yields "" — including a
    unix epoch number, which is the single most common thing to find in an export.
    Stringifying one would produce "1735689600000", which sorts *after* every real
    timestamp and so falls outside every window forever. Returning "" instead lets
    the caller count the row as unparseable and say so.
    """
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, (int, float)):
        # A number here is an epoch, and guessing its unit (s / ms / µs) would be
        # a silent factor-of-1000 error in every latency measurement. Convert it
        # in the exporter, where the unit is known.
        return ""
    if not isinstance(value, str):
        return ""
    s = value.strip().replace("T", " ")
    if not s:
        return ""
    for cut in ("+", "Z"):
        idx = s.find(cut, 10)
        if idx > 0:
            s = s[:idx]
    s = s[:19]
    # "YYYY-MM-DD" is the shortest thing that can be compared correctly against a
    # window bound; anything shorter or differently shaped is not a timestamp.
    if len(s) < 10 or s[4] != "-" or s[7] != "-" or not s[:4].isdigit():
        return ""
    return s


def _normalize(rec: dict, at: str) -> dict:
    return {
        "messageId": str(rec.get("messageId") or ""),
        "conversationId": str(rec.get("conversationId") or ""),
        "conversationTitle": str(rec.get("conversationTitle") or ""),
        "singleChat": bool(rec.get("singleChat")),
        "senderId": str(rec.get("senderId") or ""),
        "senderName": str(rec.get("senderName") or ""),
        "createdAt": at,
        "msgType": str(rec.get("msgType") or "text"),
        "text": str(rec.get("text") or ""),
        "quotedText": str(rec.get("quotedText") or ""),
        "quotedSenderName": str(rec.get("quotedSenderName") or ""),
        "quotedSenderId": str(rec.get("quotedSenderId") or ""),
        "threadId": str(rec.get("threadId") or ""),
        "mentionsSelf": bool(rec.get("mentionsSelf")),
    }
