#!/usr/bin/env python3
"""Analysis: turn the raw corpus into measured features.

Three passes over the corpus, all deterministic (same corpus + same
signals.json ⇒ identical output):

  build_turns()   pair (context → my reply), classify scene / ask kind / latency
  build_asks()    every incoming ask, ANSWERED OR NOT — silence is the signal
                  that makes decision mining possible
  style()         quantified expression DNA, globally and per tone band / scene

Nothing here writes prose. compose.py turns these numbers into skill text.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections import defaultdict
from pathlib import Path

from . import common as C
from . import store
from .locale import NULL_PACK, LocalePack

SIGNALS_PATH = Path(__file__).resolve().parent / "signals.json"


def load_signals(data_root: Path | None = None) -> dict:
    """Load the language-independent rules.

    Everything lexical moved to `forge/locales/`; this file now holds only
    thresholds, windows and band ladders. The operator's own additions are a
    locale concern and are merged by `locale.load()`, so `data_root` is accepted
    for call-compatibility and no longer changes what is returned.
    """
    return json.loads(SIGNALS_PATH.read_text(encoding="utf-8"))


def _rx(pattern: str) -> re.Pattern:
    return re.compile(pattern, re.I)


class Rules:
    """Compiled rules — thresholds from signals.json, lexicon from a locale pack.

    Compiled once and reused across a six-figure corpus. The split is the point:
    every method here works with `NULL_PACK`, returning the honest "cannot tell"
    answer rather than a wrong one, so a corpus in a language nobody has written
    a pack for still gets a fully-measured structural persona.
    """

    def __init__(self, sig: dict, pack: LocalePack | None = None):
        self.raw = sig
        self.pack = pack or NULL_PACK
        # A locale change must invalidate derived numbers exactly like a signals
        # change does, so the pack identity is part of the version string.
        self.version = f"{sig['rulesVersion']}+{self.pack.stamp()}"
        self.signals_version = sig["rulesVersion"]

        s = sig["style"]
        self.buckets = {k: tuple(v) for k, v in s["lengthBuckets"].items()}
        self.thresholds = sig.get("thresholds", {})

        g = sig["responseGate"]
        self.min_reply = g["minReplyCodepoints"]
        self.ctx_back = g["contextTurnsBack"]
        self.reply_window = g["replyWindowSeconds"]
        self.silence_window = g["silenceWindowSeconds"]

        self.tone = sig["toneBands"]
        self.band_ladder = [b for b in self.tone.get("_ladder", ["A", "B", "C", "D"])
                            if b in self.tone]
        self.group_only_cap = self.tone.get("groupOnlyCap", "C")
        self.verification = sig["verification"]

        # -- lexical, all from the pack; empty under NULL_PACK ---------------
        self.style = self.pack.style
        self.scene = self.pack.scene
        self.ask_kinds = self.pack.ask_kinds
        self.risk = self.pack.risk_tags
        self.openers = self.pack.openers
        self.genuine_ask = self.pack.genuine_ask
        self.chitchat = self.pack.chitchat
        self.bot_name = self.pack.bot_name
        self.sensitive_title = self.pack.sensitive_title

    #: Marker keys folded into the per-1k style profile. Only those the active
    #: pack actually defines are counted, so a pack may omit one without the
    #: engine reporting a fabricated zero for it.
    STYLE_MARKERS = ("certaintyHigh", "certaintyLow", "transition",
                     "conclusionFirst", "analogy", "laughter", "casual",
                     "warmth", "rough", "hedge", "directive", "enumerate")

    def threshold(self, group: str, key: str, default=None):
        """A tunable, with the active locale pack allowed to override it.

        Pack first, then `signals.json`: a threshold measured in a unit that does
        not travel between languages (codepoints, most notably) has to be settable
        per language, or the shared default silently mismeasures every script it
        was not calibrated on.
        """
        override = self.pack.threshold(group, key)
        if override is not None:
            return override
        return (self.thresholds.get(group) or {}).get(key, default)

    def is_bot(self, sender_name: str) -> bool:
        """Service account / notification robot.

        Bots emit question-shaped text the owner never answers, which would drag
        every reply-rate down and can even land a robot on the auto-send
        candidate list. They are kept in the corpus but excluded from behavioral
        statistics. With no pack, nobody is classified as a bot — an
        unfiltered-but-honest queue beats one filtered by a guess.
        """
        if not sender_name or not self.bot_name:
            return False
        return bool(self.bot_name.search(sender_name))

    def is_sensitive_title(self, title: str) -> bool:
        if not title or not self.sensitive_title:
            return False
        return bool(self.sensitive_title.search(title))

    def is_genuine_ask(self, text: str) -> bool:
        """Does this incoming line actually ask for something?

        With no pack there is no way to tell, so every substantive incoming
        message is admitted. That inflates the denominator rather than inventing
        a signal, and `fidelity.md` says so outright.
        """
        if not self.genuine_ask:
            return True
        return bool(self.genuine_ask.search(text))

    def is_chitchat(self, text: str) -> bool:
        if not self.chitchat:
            return False
        return bool(self.chitchat.match((text or "").strip()))

    def scene_of(self, text: str, single_chat: bool) -> str:
        """Coarse situation label. Falls back to the channel shape, which is
        always knowable, when no scene lexicon is available."""
        for name, key in (("escalation", "escalation"), ("external", "external"),
                          ("formal_report", "formalReport"), ("product", "product")):
            rx = self.scene.get(key)
            if rx and rx.search(text):
                return name
        return "direct_chat" if single_chat else "group_chat"

    def ask_kind_of(self, text: str) -> str:
        for name, rx in self.ask_kinds:
            if rx.search(text):
                return name
        return "other_ask"

    def risk_tags_of(self, text: str) -> list[str]:
        return [name for name, rx in self.risk if rx.search(text)]

    def opener_of(self, text: str) -> str:
        for name, rx in self.openers:
            if rx.search(text):
                return name
        return "straight_into_content"

    def bucket_of(self, n: int) -> str:
        for name, (lo, hi) in self.buckets.items():
            if lo <= n < hi:
                return name
        return "long"


# ---------------------------------------------------------------------------
# scene tagging
# ---------------------------------------------------------------------------

def tag_scenes(conn: sqlite3.Connection, rules: Rules) -> int:
    """Classify untagged messages into a coarse scene.

    Batched: one statement per ~5k messages instead of per message, which is the
    difference between seconds and minutes on a 100k-message corpus.
    """
    rows = conn.execute(
        "SELECT m.message_id, m.clean_text, c.single_chat FROM messages m "
        "JOIN conversations c ON c.conversation_id=m.conversation_id "
        "WHERE m.scene='unknown'").fetchall()
    updates = [(rules.scene_of(r["clean_text"], bool(r["single_chat"])), r["message_id"])
               for r in rows]
    for i in range(0, len(updates), 5000):
        conn.executemany("UPDATE messages SET scene=? WHERE message_id=?",
                         updates[i:i + 5000])
        conn.commit()
    return len(updates)


# ---------------------------------------------------------------------------
# turns + asks
# ---------------------------------------------------------------------------

def _conversation_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT conversation_id, title, single_chat, peer_name, peer_open_id "
        "FROM conversations ORDER BY conversation_id").fetchall()


def _messages_of(conn: sqlite3.Connection, conv_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM messages WHERE conversation_id=? ORDER BY epoch, message_id",
        (conv_id,)).fetchall()


def build_turns_and_asks(conn: sqlite3.Connection, rules: Rules,
                         tone_by_person: dict[str, str],
                         self_aliases: set[str]) -> dict:
    """Rebuild the turns and asks tables from messages. Idempotent.

    Batched per conversation: accumulate rows and executemany, rather than one
    INSERT per turn across a six-figure corpus.
    """
    conn.execute("DELETE FROM turns")
    conn.execute("DELETE FROM asks")

    n_turns = n_asks = n_answered = 0
    for conv in _conversation_rows(conn):
        conv_id = conv["conversation_id"]
        single = bool(conv["single_chat"])
        title = conv["title"] or ""
        # A note-to-self chat has no counterparty; its "replies" answer nobody.
        if single and title in self_aliases:
            continue
        msgs = _messages_of(conn, conv_id)
        if not msgs:
            continue
        peer_default = title if single else ""

        turns: list[dict] = []
        asks: list[dict] = []
        for i, m in enumerate(msgs):
            if m["is_self"] and not m["is_agent_sent"]:
                turn = _make_turn(msgs, i, rules, conv, peer_default, tone_by_person,
                                  self_aliases)
                if turn:
                    turns.append(turn)
            elif not m["is_self"]:
                ask = _make_ask(msgs, i, rules, conv, tone_by_person, self_aliases)
                if ask:
                    asks.append(ask)
                    n_answered += int(ask["answered"])
        if turns:
            _insert_turns(conn, turns)
            n_turns += len(turns)
        if asks:
            _insert_asks(conn, asks)
            n_asks += len(asks)
        conn.commit()
    return {"turns": n_turns, "asks": n_asks, "asksAnswered": n_answered}


def _addressed_self(msg: sqlite3.Row, aliases: set[str], rules: Rules) -> bool:
    """In a group, is this message actually aimed at the owner?"""
    if msg["mentions_self"]:
        return True
    text = msg["text"] or ""
    if any(f"@{a}" in text for a in aliases if a):
        return True
    if msg["quoted_sender"] and msg["quoted_sender"] in aliases:
        return True
    return False


def _make_turn(msgs: list[sqlite3.Row], i: int, rules: Rules, conv: sqlite3.Row,
               peer_default: str, tone_by_person: dict[str, str],
               aliases: set[str]) -> dict | None:
    m = msgs[i]
    reply = m["clean_text"]
    if m["msg_type"] != "text" or C.cp_len(reply) < rules.min_reply:
        return None
    if C.is_placeholder(reply) or m["is_pasted"]:
        return None      # a pasted log is not a reply written in their voice

    ctx = msgs[max(0, i - rules.ctx_back):i]
    if not ctx:
        return None
    others = [c for c in ctx if not c["is_self"] and c["clean_text"]
              and not C.is_placeholder(c["clean_text"]) and not c["is_pasted"]
              and not rules.is_bot(c["sender_name"])]
    if not others:
        return None
    last_other = others[-1]

    single = bool(conv["single_chat"])
    if not single:
        # In a group, only pair when the owner was actually addressed — otherwise
        # the "context" is other people's crosstalk and teaches nothing.
        if not (_addressed_self(last_other, aliases, rules)
                or any(_addressed_self(c, aliases, rules) for c in others)):
            return None

    latency = (m["epoch"] - last_other["epoch"]) if (m["epoch"] and last_other["epoch"]) else -1
    if latency > rules.reply_window:
        return None          # too late to be a reply to that line

    # Context lines are published verbatim in the skill's "their real replies"
    # examples, so client furniture has to be excluded here too — not only from
    # the reply. Otherwise an attachment stub or a rich card is shown to the agent
    # as the situation the owner was responding to, which teaches nothing and
    # leaks a media id into the published file.
    lines = [f"[{'me' if c['is_self'] else (c['sender_name'] or 'other')}] {c['clean_text']}"
             for c in ctx
             if c["clean_text"] and not c["is_pasted"]
             and not C.is_placeholder(c["clean_text"])]
    if not lines:
        return None      # nothing a person actually wrote to reply to
    peer_name = last_other["sender_name"] or peer_default
    return {
        "turn_key": C.sha256_hex(f"turn:{m['message_id']}"),
        "conversation_id": conv["conversation_id"],
        "single_chat": int(single),
        "peer_name": peer_name,
        "tone_band": tone_by_person.get(last_other["sender_id"], ""),
        "scene": m["scene"] if m["scene"] != "unknown" else rules.scene_of(reply, single),
        "ask_kind": rules.ask_kind_of(last_other["clean_text"]),
        "context_text": "\n".join(lines),
        "my_reply": reply,
        "latency_seconds": latency,
        "occurred_at": m["occurred_at"],
    }


def _make_ask(msgs: list[sqlite3.Row], i: int, rules: Rules, conv: sqlite3.Row,
              tone_by_person: dict[str, str], aliases: set[str]) -> dict | None:
    """One incoming ask + whether the owner answered it.

    Answered = the owner spoke next in this conversation within the reply window.
    Unanswered = they did not, and enough time passed that silence was a choice
    (not merely the tail of the corpus).
    """
    m = msgs[i]
    text = m["clean_text"]
    if m["msg_type"] != "text" or C.cp_len(text) < rules.min_reply:
        return None
    if C.is_placeholder(text) or m["is_pasted"]:
        return None
    if rules.is_bot(m["sender_name"]):
        return None      # a robot's prompt is not a colleague asking something
    if not rules.is_genuine_ask(text):
        return None

    single = bool(conv["single_chat"])
    addressed = single or _addressed_self(m, aliases, rules)
    if not addressed:
        return None      # group crosstalk not aimed at the owner is not their call

    reply_text, latency = "", -1.0
    for nxt in msgs[i + 1:]:
        if nxt["is_self"] and not nxt["is_agent_sent"]:
            if nxt["epoch"] and m["epoch"] and (nxt["epoch"] - m["epoch"]) <= rules.reply_window:
                reply_text = nxt["clean_text"]
                latency = nxt["epoch"] - m["epoch"]
            break
        if nxt["epoch"] and m["epoch"] and (nxt["epoch"] - m["epoch"]) > rules.reply_window:
            break

    answered = bool(reply_text) and not rules.is_chitchat(reply_text)
    if not answered:
        # Only count silence when the corpus proves the owner had the chance:
        # some later activity exists in this conversation.
        last_epoch = msgs[-1]["epoch"] or 0
        if not (m["epoch"] and last_epoch - m["epoch"] >= rules.silence_window):
            return None

    return {
        "ask_key": C.sha256_hex(f"ask:{m['message_id']}"),
        "conversation_id": conv["conversation_id"],
        "single_chat": int(single),
        "asker_name": m["sender_name"] or conv["peer_name"] or "",
        "asker_id": m["sender_id"] or "",
        "tone_band": tone_by_person.get(m["sender_id"], ""),
        "ask_kind": rules.ask_kind_of(text),
        "addressed_self": int(addressed),
        "risk_tags": ",".join(rules.risk_tags_of(text)),
        "ask_text": text,
        "answered": int(answered),
        "reply_text": reply_text,
        "latency_seconds": latency,
        "occurred_at": m["occurred_at"],
    }


def _insert_turns(conn: sqlite3.Connection, rows: list[dict]) -> None:
    conn.executemany("""INSERT OR REPLACE INTO turns(turn_key,conversation_id,single_chat,
        peer_name,tone_band,scene,ask_kind,context_text,my_reply,latency_seconds,occurred_at)
        VALUES(:turn_key,:conversation_id,:single_chat,:peer_name,:tone_band,:scene,
        :ask_kind,:context_text,:my_reply,:latency_seconds,:occurred_at)""", rows)


def _insert_asks(conn: sqlite3.Connection, rows: list[dict]) -> None:
    conn.executemany("""INSERT OR REPLACE INTO asks(ask_key,conversation_id,single_chat,
        asker_name,asker_id,tone_band,ask_kind,addressed_self,risk_tags,ask_text,
        answered,reply_text,latency_seconds,occurred_at)
        VALUES(:ask_key,:conversation_id,:single_chat,:asker_name,:asker_id,:tone_band,
        :ask_kind,:addressed_self,:risk_tags,:ask_text,:answered,:reply_text,
        :latency_seconds,:occurred_at)""", rows)


# ---------------------------------------------------------------------------
# style
# ---------------------------------------------------------------------------

#: Sentence-joining punctuation, in both half- and full-width forms. Counted
#: structurally rather than lexically: whether someone joins two thoughts with a
#: comma or sends two messages is a habit of RHYTHM, not of vocabulary, so it is
#: measurable in any language and belongs in the engine rather than a locale pack.
#:
#: Worth measuring because it is invisible in the other numbers. A median length
#: of 8 characters already implies "short", but an imitator can satisfy that and
#: still write `A, B` where the person would have sent `A` then `B` — which reads
#: as subtly not-them to someone who knows them well.
_JOINING_PUNCT = ",，、;；"


def _block() -> dict:
    return {"n": 0, "cp": 0, "q": 0, "joined": 0, "counts": defaultdict(int),
            "buckets": defaultdict(int), "openers": defaultdict(int),
            "latencies": [], "lengths": [], "days": set()}


def _fold(b: dict, text: str, rules: Rules, latency: float = -1,
          day: str = "") -> None:
    b["n"] += 1
    cp = C.cp_len(text)
    b["cp"] += cp
    # Distinct days, per block, so `verification.minDistinctDays` can be applied
    # to a style or scene block exactly as it already is to a mined ask kind.
    # Without it a single busy afternoon in a rare situation — 50 messages, one
    # day — is indistinguishable from a habit, and gets narrated as one.
    if day:
        b["days"].add(day)
    b["lengths"].append(cp)
    b["buckets"][rules.bucket_of(cp)] += 1
    question = rules.style.get("question")
    if question and question.search(text):
        b["q"] += 1
    if any(ch in text for ch in _JOINING_PUNCT):
        b["joined"] += 1
    # Only markers the active pack defines are counted. Iterating a fixed list
    # regardless would report 0/1k for a marker nobody can detect, which reads
    # in the published skill as "they never do this" rather than "unmeasured".
    for key in rules.STYLE_MARKERS:
        rx = rules.style.get(key)
        if not rx:
            continue
        hits = len(rx.findall(text))
        if hits:
            b["counts"][key] += hits
    if rules.openers:
        b["openers"][rules.opener_of(text)] += 1
    if latency >= 0:
        b["latencies"].append(latency)


def _finish(b: dict) -> dict:
    n = b["n"] or 1
    cp = b["cp"] or 1
    lat = sorted(b["latencies"])
    lengths = sorted(b["lengths"])
    # Chat length is heavily right-skewed in every corpus we can reason about: a
    # handful of pasted plans and long write-ups drag the mean well above
    # anything the person routinely types. The median is the number to imitate;
    # the mean is reported alongside it only so the skew stays visible, and
    # compose.py warns when the gap is wide enough to mislead.
    median_cp = lengths[len(lengths) // 2] if lengths else 0
    out = {
        "messages": b["n"],
        "distinctDays": len(b["days"]),
        "medianCodepoints": median_cp,
        "avgCodepoints": round(b["cp"] / n, 1),
        "p90Codepoints": lengths[int(len(lengths) * 0.9)] if lengths else 0,
        "lengthMixPct": {k: C.pct(v, b["n"]) for k, v in sorted(b["buckets"].items())},
        "questionPct": C.pct(b["q"], b["n"]),
        "joinedClausePct": C.pct(b["joined"], b["n"]),
        "per1k": {k: round(v / cp * 1000, 2) for k, v in sorted(b["counts"].items())},
        "openerMixPct": {k: C.pct(v, b["n"])
                         for k, v in sorted(b["openers"].items(), key=lambda x: -x[1])},
    }
    if lat:
        out["replyLatencySeconds"] = {
            "median": round(lat[len(lat) // 2], 1),
            "p90": round(lat[int(len(lat) * 0.9)], 1),
        }
    hi = b["counts"].get("certaintyHigh", 0)
    lo = b["counts"].get("certaintyLow", 0)
    out["hedgeToAssertRatio"] = round(lo / hi, 2) if hi else (float(lo) if lo else 0.0)
    return out


def reply_bubbles(conn: sqlite3.Connection, rules: Rules,
                  tone_by_person: dict[str, str] | None = None) -> dict:
    """How many messages the owner sends per reply, overall and per tone band.

    Chat is not one-message-per-turn. Someone answering three questions often
    sends three short messages, and an imitation that always answers with exactly
    one is recognizable immediately — it reads like email in a chat window.

    This has to be MEASURED rather than asserted, and measured per recipient
    group, because the habit is personal and not even constant within one person:
    the same someone can split freely with a close colleague and answer a formal
    contact in one message. Whatever the spread turns out to be, it is a property
    of the corpus, not of this function — a skill that told the caller "reply once"
    (or "always split") would be publishing a guess as though it were the person's
    habit, and it would be wrong for whoever sits at the other end of the range.

    Deliberately STRUCTURAL: it reads only `is_self`, timestamps and the
    conversation, so it works identically with no locale pack at all — which is
    why `report.py` lists it among the layers a null-pack build still measures.

    `is_agent_sent` rows are excluded like everywhere else: counting the agent's
    own output would let a wrong cadence reinforce itself on the next rebuild.
    """
    gap = float(rules.threshold("burst", "bubbleGapSeconds", 180) or 180)
    tone_by_person = tone_by_person or {}

    runs: list[int] = []
    by_band: dict[str, list[int]] = {}

    for conv in _conversation_rows(conn):
        single = bool(conv["single_chat"])
        # A 1:1 has one counterparty, so the band is the conversation's. In a group
        # there is no single recipient whose register the cadence belongs to, so
        # group runs count toward the overall figure only.
        band = ""
        if single:
            band = tone_by_person.get(conv["peer_open_id"] or "", "")

        run = 0
        prev_epoch = 0.0
        for m in _messages_of(conn, conv["conversation_id"]):
            usable = (m["is_self"] and not m["is_agent_sent"]
                      and m["msg_type"] == "text" and m["clean_text"]
                      and not m["is_pasted"]
                      and not C.is_placeholder(m["clean_text"]))
            if not usable:
                if run:
                    runs.append(run)
                    if band:
                        by_band.setdefault(band, []).append(run)
                run = 0
                prev_epoch = 0.0
                continue
            epoch = m["epoch"] or 0.0
            if run and prev_epoch and epoch and (epoch - prev_epoch) > gap:
                # Same speaker, but long enough later to be a new reply rather
                # than another bubble of the same one.
                runs.append(run)
                if band:
                    by_band.setdefault(band, []).append(run)
                run = 0
            run += 1
            prev_epoch = epoch or prev_epoch
        if run:
            runs.append(run)
            if band:
                by_band.setdefault(band, []).append(run)

    return {"overall": _bubble_stats(runs),
            "byToneBand": {b: _bubble_stats(v) for b, v in sorted(by_band.items())},
            "gapSeconds": int(gap)}


def _bubble_stats(runs: list[int]) -> dict:
    if not runs:
        return {"samples": 0, "medianBubbles": 0, "meanBubbles": 0.0,
                "multiBubblePct": 0.0, "maxBubbles": 0}
    ordered = sorted(runs)
    return {
        "samples": len(runs),
        "medianBubbles": ordered[len(ordered) // 2],
        "meanBubbles": round(sum(runs) / len(runs), 2),
        # The share that matters for drafting: how often one reply is more than a
        # single message. Reported alongside the median because the median alone
        # hides it — a median of 1 is compatible both with "almost always one
        # message" and with "one message just over half the time", which call for
        # opposite drafting behavior.
        "multiBubblePct": C.pct(sum(1 for r in runs if r > 1), len(runs)),
        "maxBubbles": ordered[-1],
    }


def evidence_strength(block: dict, v: dict) -> dict:
    """Is a measured block strong enough to narrate as a habit?

    The same `verification` gate the decision layer already applies per ask kind,
    lifted to any block of measured style. Two independent tests, because either
    one alone passes something that is not a habit:

    - **minSupport** alone accepts 50 messages sent in one afternoon of an
      incident. That is a day, not a pattern.
    - **minDistinctDays** alone accepts one message on each of four days, whose
      median length and marker rates are noise.

    Returns the verdict plus the numbers behind it, so a renderer can say *why*
    something is thin rather than only that it is. `sufficient` is the only field
    a caller should branch on — the thresholds are policy and live in
    signals.json, so they are versioned into rulesVersion.
    """
    messages = block.get("messages", 0)
    days = block.get("distinctDays", 0)
    min_support = v.get("minSupport", 8)
    min_days = v.get("minDistinctDays", 4)
    return {
        "sufficient": messages >= min_support and days >= min_days,
        "messages": messages,
        "distinctDays": days,
        "minSupport": min_support,
        "minDistinctDays": min_days,
    }


def style(conn: sqlite3.Connection, rules: Rules,
          tone_by_person: dict[str, str] | None = None) -> dict:
    """Expression DNA: global, per tone band, per scene, plus top words.

    `coverage` records which of these layers the active locale pack could
    actually measure. Everything structural — length, latency, opener
    distribution shape — is always real; the marker counts and the vocabulary
    depend on the pack, and compose.py must be able to tell the difference so it
    never renders an unmeasured layer as a measured zero.
    """
    overall = _block()
    by_tone: dict[str, dict] = {}
    by_scene: dict[str, dict] = {}
    days: set[str] = set()

    for r in conn.execute("SELECT clean_text, scene, occurred_at FROM messages "
                          "WHERE is_self=1 AND is_agent_sent=0 AND msg_type='text' "
                          "AND is_pasted=0"):
        text = r["clean_text"]
        if not text or C.cp_len(text) < rules.min_reply or C.is_placeholder(text):
            continue
        day = (r["occurred_at"] or "")[:10]
        _fold(overall, text, rules, day=day)
        by_scene.setdefault(r["scene"], _block())
        _fold(by_scene[r["scene"]], text, rules, day=day)
        if day:
            days.add(day)

    for r in conn.execute("SELECT my_reply, tone_band, latency_seconds, occurred_at "
                          "FROM turns"):
        band = r["tone_band"] or "unresolved"
        by_tone.setdefault(band, _block())
        _fold(by_tone[band], r["my_reply"], rules, r["latency_seconds"],
              day=(r["occurred_at"] or "")[:10])

    pack = rules.pack
    v = rules.verification
    # Messages-per-reply, merged INTO the same blocks the rest of the style
    # numbers live in, so a consumer reads cadence next to length rather than
    # having to know a second place to look.
    bubbles = reply_bubbles(conn, rules, tone_by_person)
    finished_tone = {k: _finish(v_block) for k, v_block in sorted(by_tone.items())}
    for band, stats in (bubbles.get("byToneBand") or {}).items():
        if band in finished_tone:
            finished_tone[band]["bubbles"] = stats
    # Evidence verdict on every per-slice block. Attached to the measurement
    # rather than recomputed by each renderer, so `style.md`, `scenes.md` and
    # `forge report` cannot disagree about whether a slice is thin.
    for block in finished_tone.values():
        block["evidence"] = evidence_strength(block, v)
    finished_scene = {k: _finish(b) for k, b in sorted(by_scene.items())}
    for block in finished_scene.values():
        block["evidence"] = evidence_strength(block, v)

    result = {
        "rulesVersion": rules.version,
        "activeDays": len(days),
        "overall": {**_finish(overall), "bubbles": bubbles["overall"]},
        "byToneBand": finished_tone,
        "byScene": finished_scene,
        "vocabulary": vocabulary(conn, rules),
        "replyBubbles": bubbles,
        "coverage": {
            "locale": pack.describe(),
            "markers": bool(pack.style),
            "questionDetection": bool(pack.style.get("question")),
            "openerShapes": bool(pack.openers),
            "sceneLexicon": bool(pack.scene),
            "vocabulary": bool(pack.stopwords) or not pack.is_null,
        },
    }
    return result


# Character runs in a script written without word separators. Vocabulary mining
# slides n-grams over these; whitespace-delimited scripts are tokenized instead.
# Ranges are written as escapes rather than literal characters so the engine
# carries no text in any human language, a property `forge selftest` enforces.
_UNSEGMENTED_RUN_RE = re.compile(
    "["
    "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"   # Han
    "\u3040-\u309f\u30a0-\u30ff"                 # Kana
    "\u0e00-\u0e7f"                               # Thai
    "]{2,}")

# A word in a script that separates them. Keeps internal apostrophes and hyphens
# so "doesn't" and "end-to-end" survive as single terms.
_WORD_RE = re.compile(r"[^\W\d_](?:[\w'’./-]*[^\W_])?", re.UNICODE)

# Technical terms and tool names: ASCII identifiers, which appear as jargon in
# every language's work chat regardless of the surrounding script.
_ASCII_TERM_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{2,}")

#: Vocabulary is only mined from what the pack does not consider filler. With no
#: pack there are no stopwords, so grammatical glue would dominate the ranking —
#: which is why `style.coverage.vocabulary` reports the difference rather than
#: publishing a list of function words as somebody's catchphrases.
_MIN_WORD_LEN = 2


def vocabulary(conn: sqlite3.Connection, rules: Rules, top: int = 30) -> dict:
    """High-frequency expressions the owner actually uses.

    Counted by DISTINCT DAY rather than raw frequency, so one busy thread cannot
    manufacture a catchphrase.

    Two strategies, chosen by the locale pack's `wordBoundaries` flag, because
    "what is a phrase" is not the same question in every writing system:

    - **No word separators** (Han, Kana, Thai): slide 2/3/4-character n-grams
      over each run. This over-generates by construction — a four-character
      phrase also yields its three- and two-character fragments with identical
      day counts — so `_collapse_overlaps` keeps one representative per family.
    - **Word separators** (Latin, Cyrillic, …): count words and adjacent
      bigrams. A bigram is what carries a verbal habit in these languages; a
      single common word almost never does.

    ASCII technical terms are collected in both cases and filtered to plausible
    words, because base64 media ids and hex blobs are payloads, not jargon.
    """
    stop = rules.pack.stopwords
    segmented = rules.pack.word_boundaries

    term_days: dict[str, set[str]] = defaultdict(set)
    term_count: dict[str, int] = defaultdict(int)
    ascii_days: dict[str, set[str]] = defaultdict(set)

    for r in conn.execute("SELECT clean_text, occurred_at FROM messages "
                          "WHERE is_self=1 AND is_agent_sent=0 AND msg_type='text' "
                          "AND is_pasted=0"):
        text, day = r["clean_text"], (r["occurred_at"] or "")[:10]
        if C.is_placeholder(text):
            continue

        if segmented:
            words = [w.lower() for w in _WORD_RE.findall(text)
                     if len(w) >= _MIN_WORD_LEN]
            content = [w for w in words if w not in stop]
            for w in content:
                term_days[w].add(day)
                term_count[w] += 1
            # Bigrams over the ORIGINAL sequence, not the stopword-filtered one:
            # "take a look" and "get back to you" are exactly the habits worth
            # publishing, and dropping the function words first destroys them.
            for a, b in zip(words, words[1:]):
                if a in stop and b in stop:
                    continue          # pure function-word pair carries nothing
                gram = f"{a} {b}"
                term_days[gram].add(day)
                term_count[gram] += 1
        else:
            for run in _UNSEGMENTED_RUN_RE.findall(text):
                for n in (4, 3, 2):
                    for i in range(len(run) - n + 1):
                        g = run[i:i + n]
                        if g in stop:
                            continue
                        term_days[g].add(day)
                        term_count[g] += 1

        for tok in _ASCII_TERM_RE.findall(text):
            t = tok.lower()
            if t in stop or not _plausible_term(t):
                continue
            ascii_days[t].add(day)

    phrases = _collapse_overlaps(term_days, term_count, top, segmented=segmented)
    jargon = [{"term": w, "days": len(d), "count": len(d)}
              for w, d in sorted(ascii_days.items(), key=lambda x: -len(x[1]))[:top]]
    return {"phrases": phrases, "jargon": jargon,
            "strategy": "words+bigrams" if segmented else "sliding-ngram",
            "stopwordsApplied": len(stop)}


def _plausible_term(term: str) -> bool:
    """Filter out base64/hex payloads masquerading as vocabulary."""
    if len(term) > 24:
        return False
    digits = sum(c.isdigit() for c in term)
    if len(term) >= 12 and digits >= 2:
        return False          # long mixed alphanumerics are ids, not words
    vowels = sum(c in "aeiou" for c in term)
    if len(term) >= 8 and vowels / len(term) < 0.2:
        return False          # no vowels at length = not a word
    return True


def _prefer_longest(days_map: dict[str, set[str]],
                    keep_ratio: float = 0.85) -> dict[str, set[str]]:
    """Replace a gram with its longest extension that covers the same days.

    Sliding a window produces every prefix of a phrase as its own candidate, and
    a prefix necessarily appears on at least as many days as the whole phrase —
    so ranking by day count alone puts the fragment first and then discards the
    real phrase as redundant. That is how a vocabulary list ends up reporting
    truncations rather than words.

    A shorter gram is dropped when a longer gram *extends* it and occurs on
    essentially the same days: the short form is then just the long form seen
    through a narrower window. When the shorter gram is genuinely more widespread
    it survives, because it is doing work of its own.

    Extensions are looked up, never searched for. Comparing every candidate
    against every other is the obvious implementation and is quadratic — a
    six-figure corpus yields ~200k candidates, so that is tens of billions of
    comparisons and turns a seconds-long build into a stalled one.

    Instead the candidates are indexed once by their own prefix and suffix. An
    extension of `g` is a gram one character wider whose prefix or suffix is `g`,
    so each step is two dictionary lookups regardless of how large the vocabulary
    or the script's character inventory is.
    """
    if not days_map:
        return {}
    max_width = max(len(t) for t in days_map)
    # gram → the wider grams that extend it at either end.
    by_prefix: dict[str, list[str]] = defaultdict(list)
    by_suffix: dict[str, list[str]] = defaultdict(list)
    for cand in days_map:
        if len(cand) > 1:
            by_prefix[cand[:-1]].append(cand)   # cand extends its own prefix
            by_suffix[cand[1:]].append(cand)    # ...and its own suffix

    out: dict[str, set[str]] = {}
    for term, days in days_map.items():
        threshold = len(days) * keep_ratio
        best, best_days = term, days
        frontier = {term}
        while frontier:
            nxt: set[str] = set()
            for cur in frontier:
                if len(cur) >= max_width:
                    continue
                for cand in (*by_prefix.get(cur, ()), *by_suffix.get(cur, ())):
                    cand_days = days_map[cand]
                    if len(cand_days) < threshold:
                        continue
                    nxt.add(cand)
                    if len(cand) > len(best):
                        best, best_days = cand, cand_days
            frontier = nxt
        out.setdefault(best, set()).update(best_days)
    return out


def _collapse_overlaps(days_map: dict[str, set[str]], counts: dict[str, int],
                       top: int, segmented: bool = False) -> list[dict]:
    """Keep one representative per overlapping term family.

    **Sliding n-grams** over-generate badly, in two distinct ways. Every prefix of
    a phrase is emitted as its own candidate (handled by `_prefer_longest`), and a
    window shifted by one character yields grams that describe one phrase without
    any being a substring of another. Redundancy for the second case is therefore
    judged by *character overlap* with an already-kept term of similar rank: if a
    candidate shares nearly all its characters with something already listed and
    appears on no more days, it is the same habit and adds nothing.

    **Segmented words and bigrams** do not have that problem — "take a look" and
    "look at" are genuinely different habits even though they share a word — so
    there the only redundancy worth removing is a unigram that appears almost
    exclusively inside an already-kept bigram. Applying the character-overlap
    test to segmented text would be actively wrong: it would collapse "deploy"
    and "deployed" into one entry, and any two short words sharing letters.
    """
    if not segmented:
        days_map = _prefer_longest(days_map)
    ranked = sorted(days_map.items(), key=lambda x: (-len(x[1]), -len(x[0])))
    kept: list[tuple[str, set[str]]] = []
    for term, days in ranked:
        redundant = False
        for other, odays in kept:
            if len(days) > len(odays) * 1.15:
                continue           # genuinely more widespread; keep it
            if segmented:
                # Only drop a single word that is subsumed by a kept phrase.
                if " " not in term and term in other.split():
                    redundant = True
            elif term in other or other in term:
                redundant = True
            elif not segmented and len(set(term) & set(other)) >= max(
                    2, min(len(term), len(other)) - 1):
                redundant = True   # same characters, one window apart
            if redundant:
                break
        if not redundant:
            kept.append((term, days))
        if len(kept) >= top:
            break
    return [{"term": t, "days": len(d), "count": counts.get(t, len(d))}
            for t, d in kept]


def ask_kind_summary(conn: sqlite3.Connection) -> dict:
    """Reply-rate and shape per incoming ask kind — decision evidence."""
    out: dict[str, dict] = {}
    for r in conn.execute("""
            SELECT ask_kind,
                   COUNT(*) total,
                   SUM(answered) answered,
                   AVG(CASE WHEN answered=1 THEN latency_seconds END) avg_latency
            FROM asks GROUP BY ask_kind ORDER BY total DESC"""):
        out[r["ask_kind"]] = {
            "total": r["total"], "answered": r["answered"],
            "answerRatePct": C.pct(r["answered"], r["total"]),
            "avgLatencySeconds": round(r["avg_latency"] or 0, 1),
        }
    return out
