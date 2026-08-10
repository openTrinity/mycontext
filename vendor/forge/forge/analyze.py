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

import datetime as dt
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


def _day_index(day: str) -> int | None:
    """"YYYY-MM-DD" → days since the epoch. None when unparseable.

    An ordinal rather than a date object because every caller only ever
    subtracts two of them, and this runs once per message on a six-figure
    corpus.
    """
    text = (day or "")[:10]
    if len(text) != 10:
        return None
    try:
        return dt.date(int(text[:4]), int(text[5:7]), int(text[8:10])).toordinal()
    except ValueError:
        return None


class Recency:
    """Time decay: how much a day's evidence still counts.

    ## Why this exists

    An IM corpus only grows, and every count in this module was a plain count —
    so a habit from the corpus's first month kept equal say with this week's,
    forever. Three concrete consequences, all silent:

    - the vocabulary list keeps a finished project's jargon at the top;
    - a tone band keeps someone who changed teams at "closest collaborator";
    - worst, an ask kind the owner stopped handling months ago keeps an answer
      rate high enough that its `defaultAction` stays `answer` — which is an
      agent replying on their behalf about something they no longer own.

    ## ★ The anchor is the corpus, never the clock

    `weight()` measures distance from the LATEST DAY IN THE CORPUS. Using
    `now()` instead would break the determinism the whole engine rests on
    (`analyze` module docstring: same corpus + same signals ⇒ identical output):
    the same corpus would measure differently tomorrow, and a corpus that
    stopped being collected would decay toward the floor without a single
    message changing.

    ## What decay must NOT touch

    Only *aggregate* counts are weighted. The `verification` gate
    (`minSupport` / `minDistinctDays`) keeps reading raw counts — see
    `evidence_strength`. Weighting those would let old evidence disappear from
    the bar it has to clear, reporting "there is no evidence for this" when the
    truth is "the evidence is real but old". Those are different sentences, and
    telling them apart is the entire job of `fidelity.md`.
    """

    def __init__(self, cfg: dict | None, anchor_day: str = ""):
        cfg = cfg or {}
        self.half_life = float(cfg.get("halfLifeDays", 0) or 0)
        self.floor = float(cfg.get("floorWeight", 0.0) or 0.0)
        self.recent_window = int(cfg.get("recentWindowDays", 0) or 0)
        self.drift_points = float(cfg.get("driftPoints", 0) or 0)
        self.anchor_day = (anchor_day or "")[:10]
        self._anchor = _day_index(self.anchor_day)
        #: Decay is off when there is no half-life configured, or no anchor to
        #: measure from (an empty corpus). Off means `weight()` returns 1.0
        #: everywhere, which reproduces pre-v6 numbers exactly — that is the
        #: documented escape hatch for `halfLifeDays: 0`.
        self.enabled = self.half_life > 0 and self._anchor is not None
        #: Memoized per day string: a build folds every message, and there are
        #: at most a few hundred distinct days behind a six-figure corpus.
        self._cache: dict[str, float] = {}

    def weight(self, day: str) -> float:
        """How much a message from `day` counts. 1.0 at the anchor, never 0.

        A day *after* the anchor cannot happen (the anchor is the maximum) but
        is clamped to 1.0 rather than amplified, so a stray future timestamp
        from a misconfigured client cannot outvote real traffic.

        An unparseable or missing day gets the full weight. That is the
        conservative direction here: dropping it toward the floor would quietly
        discount real messages for a formatting reason, and the rest of the
        engine already treats a missing timestamp as its own reported problem
        rather than as evidence about the owner.
        """
        if not self.enabled:
            return 1.0
        cached = self._cache.get(day)
        if cached is not None:
            return cached
        index = _day_index(day)
        if index is None:
            weight = 1.0
        else:
            age = self._anchor - index
            if age <= 0:
                weight = 1.0
            else:
                weight = max(self.floor, 0.5 ** (age / self.half_life))
        self._cache[day] = weight
        return weight

    def is_recent(self, day: str) -> bool:
        """Is this day inside the unweighted recent window?

        Separate from `weight()` and deliberately a hard edge: the recent lens
        exists to be a plain, easily-explained rate over a named window ("the
        last 60 days"), so that a reader can check it. A second decayed number
        would be two views of the same smoothing rather than an independent one.
        """
        if self.recent_window <= 0 or self._anchor is None:
            return False
        index = _day_index(day)
        if index is None:
            return False
        return (self._anchor - index) <= self.recent_window

    def describe(self) -> dict:
        """What was applied, for `fidelity.md` and the features payload.

        Published rather than kept internal because a decayed count is not
        comparable to an undecayed one, and a reader with no way to tell which
        they are holding would compare across builds and see a change that never
        happened.
        """
        return {
            "enabled": self.enabled,
            "halfLifeDays": self.half_life if self.enabled else 0,
            "floorWeight": self.floor if self.enabled else 1.0,
            "anchorDay": self.anchor_day,
            "recentWindowDays": self.recent_window,
            "driftPoints": self.drift_points,
        }


def corpus_anchor_day(conn: sqlite3.Connection) -> str:
    """The latest day present in the corpus — the anchor every weight is measured
    from. Empty string on an empty corpus, which disables decay."""
    row = conn.execute(
        "SELECT MAX(occurred_at) AS latest FROM messages WHERE occurred_at != ''"
    ).fetchone()
    return ((row["latest"] if row else "") or "")[:10]


class Rules:
    """Compiled rules — thresholds from signals.json, lexicon from a locale pack.

    Compiled once and reused across a six-figure corpus. The split is the point:
    every method here works with `NULL_PACK`, returning the honest "cannot tell"
    answer rather than a wrong one, so a corpus in a language nobody has written
    a pack for still gets a fully-measured structural persona.
    """

    def __init__(self, sig: dict, pack: LocalePack | None = None,
                 anchor_day: str = ""):
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
        # Time decay. `anchor_day` comes from the corpus (see `corpus_anchor_day`),
        # never from the clock — a caller that omits it gets decay DISABLED rather
        # than a wrong anchor, and `Recency.describe()` is published into
        # `features` and `fidelity.md` so "off" is visible instead of assumed.
        self.recency = Recency(sig.get("recency"), anchor_day)
        #: Measurement window lower bound, `"YYYY-MM-DD"`, or `""` for "all of it".
        #: Set by `build` from `--window-days`; see `window_clause`.
        self.window_start = ""

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

    def window_clause(self, column: str) -> tuple[str, list]:
        """`(sql_fragment, params)` restricting `column` to the measurement window.

        Returns `("", [])` when no window is set, so every query is byte-identical
        to the unwindowed one — the same shape as `VaultSource._scope`, and for the
        same reason: filtering in Python would make a narrow window pay the full
        cost of a wide read.

        ## Why a window at all, when `pull` already has `--since`

        `pull`'s window governs what enters the CORPUS; this one governs what the
        BUILD measures, and the two are not interchangeable. Once a corpus holds
        six months (because the user picked a wide range once, or because
        `resolveSince` re-scanned earlier history), every later build measures all
        six months no matter what the user asks for — so "re-distill just the last
        30 days" was impossible without deleting the corpus, which throws away data
        that cannot be re-collected.

        Windowing the measurement instead is non-destructive: the corpus keeps
        everything, and the window is one flag away from being widened again.

        ★ Independent from `Recency`. Decay makes old evidence count *less*; a
        window makes it count *not at all*, and says so in `limits.md`. Conflating
        them would leave no way to ask either question on its own.
        """
        if not self.window_start:
            return "", []
        return f" AND {column} >= ?", [self.window_start]

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


def _messages_of(conn: sqlite3.Connection, conv_id: str,
                 rules: Rules | None = None) -> list[sqlite3.Row]:
    """One conversation's messages, oldest first, inside the measurement window.

    `rules` is optional so a caller that has no window (and every existing test)
    keeps the unwindowed behavior. When a window IS set the cut happens here, in
    the one function every pairing pass goes through — so turns, asks and reply
    cadence are windowed by construction rather than by three separate filters
    that could disagree.

    A consequence worth naming: the context lines a turn is paired against are
    windowed too, so a reply on the window's first day may lose the incoming line
    it answered and simply not become a turn. That is the honest outcome — the
    alternative is measuring against context the window says is out of scope —
    and it is why the window is expressed in days rather than as an exact instant.
    """
    clause, params = rules.window_clause("occurred_at") if rules else ("", [])
    return conn.execute(
        f"SELECT * FROM messages WHERE conversation_id=?{clause} "
        "ORDER BY epoch, message_id",
        (conv_id, *params)).fetchall()


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
        msgs = _messages_of(conn, conv_id, rules)
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
    #: Two parallel tallies, and the distinction is load-bearing.
    #:
    #: · `n` / `days` are RAW counts — they answer "is there enough evidence to
    #:   call this a habit at all", which `evidence_strength` decides, and old
    #:   evidence must not vanish from that bar (see `Recency`).
    #: · `w` and every weighted accumulator answer "what does this person do
    #:   NOW", so a message from a year ago should not shape them as much as
    #:   this week's.
    #:
    #: Mixing the two is the failure this split exists to prevent: weighting the
    #: evidence bar reports "no evidence" for behavior that is real but old,
    #: while leaving the shares unweighted publishes a former habit as current.
    return {"n": 0, "w": 0.0, "cp": 0.0, "q": 0.0, "joined": 0.0,
            "counts": defaultdict(float),
            "buckets": defaultdict(float), "openers": defaultdict(float),
            "latencies": [], "lengths": [], "days": set()}


def _fold(b: dict, text: str, rules: Rules, latency: float = -1,
          day: str = "") -> None:
    weight = rules.recency.weight(day)
    b["n"] += 1
    b["w"] += weight
    cp = C.cp_len(text)
    b["cp"] += cp * weight
    # Distinct days, per block, so `verification.minDistinctDays` can be applied
    # to a style or scene block exactly as it already is to a mined ask kind.
    # Without it a single busy afternoon in a rare situation — 50 messages, one
    # day — is indistinguishable from a habit, and gets narrated as one.
    #
    # ★ Deliberately NOT weighted, like `n`: this is the evidence bar, not a share.
    if day:
        b["days"].add(day)
    # Lengths and latencies carry their weight so the percentiles below can be
    # weighted ones. Keeping the raw value alongside is what makes that possible
    # without a second pass over the corpus.
    b["lengths"].append((cp, weight))
    b["buckets"][rules.bucket_of(cp)] += weight
    question = rules.style.get("question")
    if question and question.search(text):
        b["q"] += weight
    if any(ch in text for ch in _JOINING_PUNCT):
        b["joined"] += weight
    # Only markers the active pack defines are counted. Iterating a fixed list
    # regardless would report 0/1k for a marker nobody can detect, which reads
    # in the published skill as "they never do this" rather than "unmeasured".
    for key in rules.STYLE_MARKERS:
        rx = rules.style.get(key)
        if not rx:
            continue
        hits = len(rx.findall(text))
        if hits:
            b["counts"][key] += hits * weight
    if rules.openers:
        b["openers"][rules.opener_of(text)] += weight
    if latency >= 0:
        b["latencies"].append((latency, weight))


def _weighted_percentile(pairs: list[tuple[float, float]], q: float) -> float:
    """The q-th percentile of `(value, weight)` pairs.

    A weighted percentile rather than a weighted mean because every number this
    feeds is one an imitator has to reproduce — median length, p90 latency — and
    a mean of a right-skewed chat distribution is not reproducible behavior (see
    `_finish`). Walking the cumulative weight keeps the "half the mass is below
    this" meaning intact while letting recent messages carry more of that mass.

    Falls back to the unweighted position when the total weight is zero, which
    can only happen if every weight floored to 0 — impossible with the shipped
    `floorWeight`, but the fallback keeps a hand-edited `signals.json` from
    producing a division by zero instead of a number.
    """
    if not pairs:
        return 0.0
    ordered = sorted(pairs)
    total = sum(w for _, w in ordered)
    if total <= 0:
        return ordered[min(len(ordered) - 1, int(len(ordered) * q))][0]
    target = total * q
    seen = 0.0
    for value, weight in ordered:
        seen += weight
        if seen >= target:
            return value
    return ordered[-1][0]


def _finish(b: dict) -> dict:
    # Weighted denominators for every share; raw `n` stays reported separately as
    # the evidence count. `w or 1` guards the empty block, exactly as `n or 1` did.
    w = b["w"] or 1.0
    cp = b["cp"] or 1.0
    lengths = b["lengths"]
    # Chat length is heavily right-skewed in every corpus we can reason about: a
    # handful of pasted plans and long write-ups drag the mean well above
    # anything the person routinely types. The median is the number to imitate;
    # the mean is reported alongside it only so the skew stays visible, and
    # compose.py warns when the gap is wide enough to mislead.
    median_cp = int(_weighted_percentile(lengths, 0.5))
    out = {
        "messages": b["n"],
        "distinctDays": len(b["days"]),
        "medianCodepoints": median_cp,
        "avgCodepoints": round(b["cp"] / w, 1),
        "p90Codepoints": int(_weighted_percentile(lengths, 0.9)),
        "lengthMixPct": {k: C.pct(v, b["w"]) for k, v in sorted(b["buckets"].items())},
        "questionPct": C.pct(b["q"], b["w"]),
        "joinedClausePct": C.pct(b["joined"], b["w"]),
        "per1k": {k: round(v / cp * 1000, 2) for k, v in sorted(b["counts"].items())},
        "openerMixPct": {k: C.pct(v, b["w"])
                         for k, v in sorted(b["openers"].items(), key=lambda x: -x[1])},
    }
    if b["latencies"]:
        out["replyLatencySeconds"] = {
            "median": round(_weighted_percentile(b["latencies"], 0.5), 1),
            "p90": round(_weighted_percentile(b["latencies"], 0.9), 1),
        }
    hi = b["counts"].get("certaintyHigh", 0)
    lo = b["counts"].get("certaintyLow", 0)
    out["hedgeToAssertRatio"] = round(lo / hi, 2) if hi else (round(lo, 2) if lo else 0.0)
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

    Runs carry their day's recency weight, so a cadence the owner has since
    changed fades out of the published median instead of averaging with the
    current one forever. `samples` stays the raw run count — that is the evidence
    figure, and `_bubble_stats` reports both.
    """
    gap = float(rules.threshold("burst", "bubbleGapSeconds", 180) or 180)
    tone_by_person = tone_by_person or {}

    #: `(run_length, weight)` pairs. The weight is the run's LAST day: a run is
    #: one reply, and when it straddles midnight the moment it finished is the
    #: moment it happened.
    runs: list[tuple[int, float]] = []
    by_band: dict[str, list[tuple[int, float]]] = {}

    for conv in _conversation_rows(conn):
        single = bool(conv["single_chat"])
        # A 1:1 has one counterparty, so the band is the conversation's. In a group
        # there is no single recipient whose register the cadence belongs to, so
        # group runs count toward the overall figure only.
        band = ""
        if single:
            band = tone_by_person.get(conv["peer_open_id"] or "", "")

        run = 0
        run_day = ""
        prev_epoch = 0.0

        def flush(length: int, day: str) -> None:
            if not length:
                return
            weight = rules.recency.weight(day)
            runs.append((length, weight))
            if band:
                by_band.setdefault(band, []).append((length, weight))

        for m in _messages_of(conn, conv["conversation_id"], rules):
            usable = (m["is_self"] and not m["is_agent_sent"]
                      and m["msg_type"] == "text" and m["clean_text"]
                      and not m["is_pasted"]
                      and not C.is_placeholder(m["clean_text"]))
            if not usable:
                flush(run, run_day)
                run = 0
                run_day = ""
                prev_epoch = 0.0
                continue
            epoch = m["epoch"] or 0.0
            if run and prev_epoch and epoch and (epoch - prev_epoch) > gap:
                # Same speaker, but long enough later to be a new reply rather
                # than another bubble of the same one.
                flush(run, run_day)
                run = 0
                run_day = ""
            run += 1
            run_day = (m["occurred_at"] or "")[:10] or run_day
            prev_epoch = epoch or prev_epoch
        flush(run, run_day)

    return {"overall": _bubble_stats(runs),
            "byToneBand": {b: _bubble_stats(v) for b, v in sorted(by_band.items())},
            "gapSeconds": int(gap)}


def _bubble_stats(runs: list[tuple[int, float]]) -> dict:
    if not runs:
        return {"samples": 0, "medianBubbles": 0, "meanBubbles": 0.0,
                "multiBubblePct": 0.0, "maxBubbles": 0}
    total_w = sum(w for _, w in runs) or 1.0
    return {
        # Raw count: the evidence figure, unaffected by decay.
        "samples": len(runs),
        "medianBubbles": int(_weighted_percentile(
            [(float(r), w) for r, w in runs], 0.5)),
        "meanBubbles": round(sum(r * w for r, w in runs) / total_w, 2),
        # The share that matters for drafting: how often one reply is more than a
        # single message. Reported alongside the median because the median alone
        # hides it — a median of 1 is compatible both with "almost always one
        # message" and with "one message just over half the time", which call for
        # opposite drafting behavior.
        "multiBubblePct": C.pct(sum(w for r, w in runs if r > 1), total_w),
        # The extreme is raw on purpose: "the most bubbles they have ever sent in
        # one reply" is a fact about the corpus, and decaying it would report a
        # smaller maximum than actually occurred.
        "maxBubbles": max(r for r, _ in runs),
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

    window, params = rules.window_clause("occurred_at")
    for r in conn.execute("SELECT clean_text, scene, occurred_at FROM messages "
                          "WHERE is_self=1 AND is_agent_sent=0 AND msg_type='text' "
                          "AND is_pasted=0" + window, params):
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
        # What decay was applied. Published because a decayed number is not
        # comparable to an undecayed one: a reader who cannot tell which they hold
        # would compare across builds and see a behavior change that never happened.
        "recency": rules.recency.describe(),
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

    ## ★ Ranked by decayed day MASS, not by raw day count

    Distinct days stop one busy thread from manufacturing a catchphrase, but they
    do nothing about age: a finished project's jargon appeared on more days than
    this quarter's does, so it outranks it forever and the published catchphrase
    list slowly becomes an archive. Ranking sums each day's `Recency.weight()`
    instead of counting days, so a term has to still be in use to stay near the
    top.

    `days` is reported unchanged next to the mass. That is the raw evidence
    ("this really did appear on 40 days") and it is what makes the ranking
    auditable; `lastSeen` is published alongside so a reader can tell a current
    phrase from a fading one rather than having to trust the order.
    """
    stop = rules.pack.stopwords
    segmented = rules.pack.word_boundaries

    term_days: dict[str, set[str]] = defaultdict(set)
    term_count: dict[str, int] = defaultdict(int)
    ascii_days: dict[str, set[str]] = defaultdict(set)

    window, params = rules.window_clause("occurred_at")
    for r in conn.execute("SELECT clean_text, occurred_at FROM messages "
                          "WHERE is_self=1 AND is_agent_sent=0 AND msg_type='text' "
                          "AND is_pasted=0" + window, params):
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

    # Decayed weight of a term's day set. Memoized per day inside `Recency`, so
    # this stays one dictionary lookup per day even across ~200k candidate grams.
    def mass(days: set[str]) -> float:
        return sum(rules.recency.weight(d) for d in days)

    phrases = _collapse_overlaps(term_days, term_count, top, segmented=segmented,
                                 mass=mass)
    jargon = [{"term": w, "days": len(d), "recentWeight": round(mass(d), 2),
               "lastSeen": max(d) if d else "", "count": len(d)}
              for w, d in sorted(ascii_days.items(), key=lambda x: -mass(x[1]))[:top]]
    return {"phrases": phrases, "jargon": jargon,
            "strategy": "words+bigrams" if segmented else "sliding-ngram",
            "ranking": "decayed-day-mass" if rules.recency.enabled else "distinct-days",
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
                       top: int, segmented: bool = False,
                       mass=None) -> list[dict]:
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

    `mass` (a `set[str] -> float` over day sets) supplies the recency-decayed
    weight used for BOTH the ranking and the "is it more widespread than what we
    already kept" test. Both, not just the ranking: mixing a decayed order with a
    raw-count redundancy test would let a stale term evict the current one that
    outranked it. Defaults to the plain day count, which reproduces pre-v6
    behavior exactly.
    """
    if mass is None:
        def mass(days: set[str]) -> float:
            return float(len(days))
    if not segmented:
        days_map = _prefer_longest(days_map)
    ranked = sorted(days_map.items(), key=lambda x: (-mass(x[1]), -len(x[0])))
    kept: list[tuple[str, set[str]]] = []
    for term, days in ranked:
        redundant = False
        for other, odays in kept:
            if mass(days) > mass(odays) * 1.15:
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
    return [{"term": t, "days": len(d), "recentWeight": round(mass(d), 2),
             "lastSeen": max(d) if d else "", "count": counts.get(t, len(d))}
            for t, d in kept]


def ask_kind_summary(conn: sqlite3.Connection) -> dict:
    """Reply-rate and shape per incoming ask kind — decision evidence.

    ★ Deliberately RAW (undecayed), unlike `decide.mine`'s propensity table.
    This is the "what is actually in the corpus" view, and it is what makes the
    decayed numbers auditable: with only weighted figures published there would be
    no way to check the weighting, and a reader comparing two builds could not
    tell a behavior change from a decay artifact.
    """
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
