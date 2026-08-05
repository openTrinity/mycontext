#!/usr/bin/env python3
"""{{NAME}} persona runtime — recall, resolve, verify, send.

Self-contained: standard library plus `imruntime.py` (copied in beside this
file). It does not import the forge, so the skill keeps working if the forge repo
is gone.

    persona.py brief   --conversation-id <cid> --single true --peer-open-id <id>
                       [--message-id <id>] [--window 12]      <-- START HERE
    persona.py facts   --query "<keyword>" [--name X] [--k 12]
    persona.py check   --text "<draft>"
    persona.py context --conversation-id <cid> --single true --peer-open-id <id>
    persona.py recall  --context "<what they just said>" [--k 6] [--tone A] [--name X]
    persona.py lines   --query "<keywords>" [--k 8]
    persona.py who     --name "<exact name>"
    persona.py thread  --conversation-id <cid> [--limit 30]
    persona.py fresh   --conversation-id <cid> --single true --peer-open-id <id> \
                       --last-seen <messageId>
    persona.py send    --conversation-id <cid> --single true --peer-open-id <id> \
                       --text "<reply>" [--dry-run]
    persona.py status

`context` is live and `thread` is the corpus; both label which they are. Read
`context` before deciding — a message's meaning comes from the lines before it,
and the corpus is only as current as the last pull.

Every subcommand prints JSON. `send` enforces the autonomy scope, records to the
agent-sent ledger, and logs the outcome.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import imruntime as R  # noqa: E402

CONFIG_POINTER = HERE.parent / "references" / ".config-path"
RULES_PATH = HERE.parent / "references" / "rules.json"


def load_rules() -> dict:
    """The machine-readable policy the forge compiled for this build.

    Read from `references/`, a sibling of this directory, so the skill stays
    self-contained — no import of the forge, and it keeps working if the forge
    repo is gone.

    A missing or unreadable file is a fail-closed condition, not a reason to
    improvise: every gate in this script keys off these patterns, so without them
    the honest state is "cannot judge", which downstream must turn into
    draft-only rather than into an unchecked send.
    """
    try:
        rules = json.loads(RULES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return {"_unavailable": f"{type(e).__name__}: {e}",
                "patterns": {}, "policy": {}, "style": {}, "bands": {},
                "coverage": {}}
    return rules


def _threshold(group: str, key: str, fallback):
    """One published threshold from `rules.json` → `policy.<group>.<key>`.

    Falls back only when the file is unreadable or predates the key — the value
    itself is a rule, and `forge publish` is what changes it. Hardcoding it here
    instead would let this script and the forge disagree about the same cutoff,
    with neither side reporting a conflict.
    """
    value = ((load_rules().get("policy") or {}).get(group) or {}).get(key)
    return fallback if value is None else value


def _rx(pattern: str):
    """Compile a pattern from rules.json, tolerating a bad one.

    An operator-supplied locale override could contain an invalid regex. Dropping
    it makes that layer unmeasurable — which the callers already handle — whereas
    raising would take the whole skill down.
    """
    if not pattern:
        return None
    try:
        return re.compile(pattern, re.I)
    except re.error:
        return None


def out(obj: dict, code: int = 0) -> int:
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    return code


def load_config() -> dict:
    if not CONFIG_POINTER.exists():
        raise SystemExit("persona not linked to a data root; re-run `forge publish`")
    path = Path(CONFIG_POINTER.read_text(encoding="utf-8").strip()).expanduser()
    if not path.exists():
        raise SystemExit(f"data root config not found at {path}; this machine does "
                         "not own the corpus")
    return json.loads(path.read_text(encoding="utf-8"))


def corpus(cfg: dict) -> R.Corpus:
    return R.Corpus(cfg["database"]["path"])


def client(cfg: dict) -> R.DwsClient:
    data_root = Path(cfg["dataRoot"]).expanduser()
    return R.DwsClient(binary=cfg.get("dws", {}).get("binary", "dws"),
                       log=data_root / "dws-calls.jsonl")


# ---------------------------------------------------------------------------
# classification + gates, from rules.json rather than from judgment
# ---------------------------------------------------------------------------

def classify(text: str, rules: dict) -> dict:
    """What is this message, mechanically.

    The same three questions the forge asked of every message when it built the
    corpus, asked again at reply time with the same patterns — so a reply-time
    decision cannot disagree with the statistics it is based on.

    Every "cannot tell" is reported as `null`, never as a negative. An absent
    pattern means this build has no way to detect that thing, which has to make
    the caller more conservative; a `false` would say the opposite.
    """
    pats = rules.get("patterns") or {}
    text = text or ""

    genuine_rx = _rx(pats.get("genuineAsk", ""))
    chit_rx = _rx(pats.get("chitchatReply", ""))
    genuine = bool(genuine_rx.search(text)) if genuine_rx else None
    chitchat = bool(chit_rx.match(text.strip())) if chit_rx else None

    ask_kind = None
    for name, pattern in (pats.get("askKinds") or {}).items():
        rx = _rx(pattern)
        if rx and rx.search(text):
            ask_kind = name
            break
    if ask_kind is None and (pats.get("askKinds") or {}):
        ask_kind = "other_ask"

    risks = sorted(name for name, pattern in (pats.get("riskTags") or {}).items()
                   if (_rx(pattern) or _NEVER).search(text))

    return {
        "text": text,
        "genuineAsk": genuine,
        "chitchat": chitchat,
        "askKind": ask_kind,
        "riskTags": risks,
        "riskDetectable": bool(pats.get("riskTags")),
        "askKindDetectable": bool(pats.get("askKinds")),
    }


class _Never:
    """A pattern object that never matches — lets `classify` stay branch-free
    when a locale pack omits a section."""

    @staticmethod
    def search(_text):
        return None


_NEVER = _Never()


def decide_action(cls: dict, person: dict | None, rules: dict) -> dict:
    """reply / draft / handoff / silent — the whole Step-4 gate, in code.

    This is the function that makes the skill usable by a model that cannot be
    trusted to weigh a table of percentages. `decisions.md` shows the evidence;
    this returns the verdict, with every rule that fired listed in `because`, so
    the caller executes rather than deliberates.

    Order matters and is fixed: the most conservative rule wins, and no later
    rule may upgrade an earlier one. Downgrades are free.
    """
    policy = rules.get("policy") or {}
    by_kind = policy.get("byAskKind") or {}
    never_settle = set(policy.get("neverSettleRiskClasses") or [])
    always_draft = set(policy.get("alwaysDraftKinds") or [])
    thin = set(policy.get("thinAskKinds") or [])
    bands = rules.get("bands") or {}
    scope = (rules.get("autonomy") or {}).get("scope", "draft_only")
    coverage = rules.get("coverage") or {}

    because: list[str] = []
    action = by_kind.get(cls.get("askKind") or "", policy.get("defaultAction", "draft"))
    if cls.get("askKind") in by_kind:
        because.append(f"measured default for `{cls['askKind']}` is {action}")
    else:
        because.append("ask kind not in the measured table — defaulting to draft")

    def downgrade(to: str, why: str) -> None:
        nonlocal action
        rank = {"reply": 0, "answer": 0, "settle_ok": 0, "handoff": 1,
                "draft": 2, "draft_gated": 2, "silent": 3}
        if rank.get(to, 2) > rank.get(action, 2):
            action = to
        because.append(why)

    if rules.get("_unavailable"):
        downgrade("draft", f"rules.json unusable ({rules['_unavailable']}) — "
                           "nothing can be verified, so draft only")
    if not cls.get("askKindDetectable"):
        downgrade("draft", "this build cannot classify what is being asked")
    if not coverage.get("replyShapes", True):
        downgrade("draft", "this build cannot tell a settle from a handoff")
    if cls.get("askKind") in always_draft:
        downgrade("draft", f"`{cls['askKind']}` is always the owner's call")
    if cls.get("askKind") in thin:
        downgrade("draft", f"`{cls['askKind']}` has too few examples to lean on")
    for tag in cls.get("riskTags") or []:
        # Every detected risk class draws a downgrade. `never_settle` is the
        # measured majority; a class the owner *sometimes* settles is still not
        # one an agent may settle for them, so the reason differs and the action
        # does not.
        why = ("never settled by the owner alone" if tag in never_settle
               else "sometimes settled by the owner, never by an agent")
        downgrade("draft", f"risk class `{tag}` — {why}")
    if not cls.get("riskDetectable"):
        downgrade("draft", "no risk lexicon in this build, so risk cannot be ruled out")
    if cls.get("chitchat") is True and cls.get("genuineAsk") is not True:
        downgrade("silent", "pure acknowledgement, not an ask")

    if person is None or not person.get("resolved"):
        downgrade("draft", "recipient not resolved by id")
    else:
        band = person.get("toneBand") or "S"
        if person.get("sensitive"):
            downgrade("draft", "sensitive recipient")
        if band == "S":
            downgrade("draft", "tone band S — most conservative handling")
        elif (bands.get(band) or {}).get("autoAnswer") == "manual only":
            downgrade("draft", f"band {band} is manual-only")

    if action in ("answer", "settle_ok", "reply"):
        if scope == "draft_only":
            downgrade("draft", "autonomy scope is draft_only — sending is disabled")

    verdict = {"answer": "reply", "settle_ok": "reply", "reply": "reply",
               "handoff": "handoff", "draft": "draft", "draft_gated": "draft",
               "silent": "silent"}.get(action, "draft")
    return {
        "verdict": verdict,
        "mayAutoSend": verdict == "reply" and scope in ("allowlist", "everyone"),
        "because": because,
        "scope": scope,
    }


def check_draft(text: str, rules: dict, cls: dict | None = None) -> dict:
    """Mechanical review of a draft, before anyone tries to send it.

    Catches the failures a weaker model makes even with good instructions in
    front of it: a paragraph where this person sends two lines, a comma joining
    two thoughts they would have split, a stock opener, corporate register they
    never use, and — the one that actually matters — a sentence that states a
    decision on a gated risk class.
    """
    style = rules.get("style") or {}
    problems: list[dict] = []
    text = (text or "").strip()
    n = len(text)

    if not text:
        return {"result": "block", "problems": [
            {"severity": "block", "kind": "empty", "detail": "empty draft"}]}

    hard_max = style.get("maxCodepoints") or 300
    if n > hard_max:
        problems.append({"severity": "block", "kind": "too_long",
                         "detail": f"{n} characters, over the {hard_max} send limit"})
    p90 = style.get("p90Codepoints")
    if p90 and n > p90 * 1.5:
        problems.append({"severity": "warn", "kind": "longer_than_usual",
                         "detail": f"{n} characters; 90% of their messages are "
                                   f"under {p90}. Consider splitting."})

    joined_pct = style.get("joinedClausePct")
    if joined_pct is not None and joined_pct < 25:
        if any(ch in text for ch in ",，、;；"):
            problems.append({
                "severity": "warn", "kind": "joined_clauses",
                "detail": f"only {joined_pct}% of their messages join clauses with a "
                          f"comma. They would send two short messages instead of "
                          f"one joined sentence."})

    openers = (style.get("manufacturedOpeners") or "")
    for opener in [o.strip() for o in openers.split("/") if o.strip()]:
        if text.startswith(opener):
            problems.append({"severity": "warn", "kind": "manufactured_opener",
                             "detail": f"starts with {opener!r}, a filler opener they "
                                       f"do not use"})
            break

    for phrase in style.get("neverWrite") or []:
        for token in [w.strip() for w in phrase.split("·")]:
            if len(token) >= 2 and token in text:
                problems.append({"severity": "warn", "kind": "never_write",
                                 "detail": f"contains {token!r}, register they never use"})
                break

    # The gate that matters most: a draft that states a decision on a risk class.
    # Checked on the DRAFT, not only on the incoming message — an innocuous
    # question can still be answered with a commitment.
    draft_cls = classify(text, rules)
    if draft_cls["riskTags"]:
        problems.append({
            "severity": "block", "kind": "risk_in_draft",
            "detail": f"the draft itself touches {', '.join(draft_cls['riskTags'])} — "
                      f"never state a decision on these. Draft it for the owner."})

    blocked = [p for p in problems if p["severity"] == "block"]
    return {
        "result": "block" if blocked else ("warn" if problems else "pass"),
        "codepoints": n,
        "problems": problems,
        "guidance": ("Fix every `block` before sending. A `warn` is a habit "
                     "mismatch — worth fixing, not fatal."
                     if problems else "Matches the measured shape."),
    }


# ---------------------------------------------------------------------------
# read commands
# ---------------------------------------------------------------------------

def cmd_recall(cfg: dict, a) -> int:
    with corpus(cfg) as c:
        turns = c.similar_turns(a.context, k=a.k, tone=a.tone, scene=a.scene,
                                person=a.name)
    return out({
        "turns": turns,
        "use": "Voice reference only. Reuse the shape and register; never reuse "
               "the facts — they belong to the moment those replies were sent.",
    })


def cmd_lines(cfg: dict, a) -> int:
    with corpus(cfg) as c:
        lines = c.my_lines(a.query, k=a.k, scene=a.scene, person=a.name)
    matched = bool(lines) and lines[0].get("matchedQuery")
    result = {"lines": lines, "matchedQuery": matched}
    if a.query and not matched:
        # Say so explicitly. These are recent lines shown for context, NOT
        # evidence that the searched words were ever used.
        result["note"] = (f"nothing matched '{a.query}'"
                          + (f" for {a.name}" if a.name else "")
                          + " — the lines below are recent context only, not "
                            "evidence that those words were used. Do not quote them "
                            "as proof of a phrasing.")
    return out(result)


def cmd_who(cfg: dict, a) -> int:
    with corpus(cfg) as c:
        person = c.person_by_id(a.person_id) if a.person_id else c.person(a.name)
    if not person:
        return out({
            "name": a.name, "resolved": False, "toneBand": "S",
            "autoAnswer": "manual only",
            "guidance": "Unresolved recipient: formal, complete sentences, single "
                        "message, no banter, draft only.",
        })
    band = person.get("tone_band") or "S"
    result = {
        "name": person.get("name"), "personId": person.get("person_id"),
        "resolved": True, "toneBand": band,
        "sensitive": bool(person.get("sensitive")),
        "title": person.get("title") or "",
        "autoAnswer": person.get("relationship") or "manual only",
        "guidance": "Apply this band from references/people.md. Never mention the "
                    "band, never compare recipients.",
    }
    if person.get("ambiguous"):
        # Several people share this name. Report it instead of pretending the
        # first match is the answer — the caller may be about to message someone
        # other than who they think.
        result.update({
            "ambiguous": True,
            "candidateCount": person["candidateCount"],
            "guidance": f"⚠︎ {person['candidateCount']} people share the name "
                        f"'{a.name}'. This is the one you talk to most, but do NOT "
                        "auto-send on a name alone — identify them by the "
                        "conversation's peerOpenId and pass --person-id.",
        })
    return out(result)


def cmd_thread(cfg: dict, a) -> int:
    """Conversation history from the LOCAL CORPUS, with its cutoff stated.

    The cutoff is not a detail: the corpus is only as current as the last
    `forge pull`, so this can be hours or days behind the live conversation.
    Returning it silently is how an agent reasons confidently about a thread
    while looking at yesterday's version of it — so the cutoff and an explicit
    pointer to `context` ship with every response.
    """
    with corpus(cfg) as c:
        msgs = c.conversation_history(a.conversation_id, a.limit)
        through = c.meta("pulledThrough")
        last_pull = c.meta("lastPullAt")
    return out({
        "source": "corpus",
        "corpusThrough": through,
        "lastPullAt": last_pull,
        "messages": msgs,
        "warning": f"corpus only — nothing after {through or 'unknown'} is here. "
                   f"For what the other person just said, use `context`.",
    })


def cmd_context(cfg: dict, a) -> int:
    """What is being said in this conversation RIGHT NOW.

    This exists because a message's meaning is set by the few messages before it,
    and the corpus can be hours behind. Answering a bare "sounds good" without
    knowing what it agrees with produces a reply that matches the person's
    register and misses their situation entirely — which reads as stranger to the
    recipient than a plainly wrong answer would.

    Live where the platform supports it, the host application's own near-realtime
    store where there is one, corpus where there is neither — and always labelled
    with which, because "current" and "all I have" must never look alike.
    """
    live: list[dict] = []
    live_error = ""
    read: dict = {}
    if a.single and not a.peer_open_id:
        live_error = ("a 1:1 needs --peer-open-id; the conversation id is not a "
                      "valid address for a direct chat")
    else:
        try:
            read = _tail_with_lag(cfg, a)
            live = read["messages"]
        except R.DwsError as e:
            live_error = e.detail[:200]
        except Exception as e:                       # unsupported by this source
            live_error = str(e)[:200]

    if live:
        self_ids = set()
        try:
            with corpus(cfg) as c:
                self_ids = set(c.meta("selfOpenIds").split(",")) - {""}
        except FileNotFoundError:
            pass
        msgs = [{
            "at": m.get("createdAt", ""),
            "sender": m.get("senderName", ""),
            # A host store already knows this; only fall back to id matching when
            # it does not, so an agent-sent reply is not miscredited to the owner.
            "isOwner": (bool(m["isOwner"]) if "isOwner" in m
                        else bool(self_ids) and m.get("senderId") in self_ids),
            "text": m.get("text", ""),
            "messageId": m.get("messageId", ""),
        } for m in live]
        source = read.get("source", "live")
        payload = {
            "source": source,
            "messages": msgs,
            "latest": msgs[-1] if msgs else None,
            "note": "oldest→newest. Read this BEFORE deciding: the last few lines "
                    "are what the newest message is responding to.",
        }
        if source == "hostStore":
            # Not a live read. Say how far behind it is so the caller can judge,
            # rather than letting "close enough" read as "current".
            payload["lagSeconds"] = read.get("lagSeconds")
            payload["collectedThrough"] = read.get("through", "")
            payload["note"] += (" This came from the host application's store, "
                                "which is refreshed on a cycle — see lagSeconds. "
                                "Anything newer than collectedThrough is not here.")
        return out(payload)

    # No live read available. Fall back to the corpus, but say so loudly — the
    # caller must be able to tell "this is current" from "this is all I have".
    with corpus(cfg) as c:
        msgs = c.conversation_history(a.conversation_id, a.limit)
        through = c.meta("pulledThrough")
    return out({
        "source": "corpus",
        "degraded": "no live read available for this conversation",
        "reason": live_error or "this message source cannot read a live tail",
        "corpusThrough": through,
        "messages": msgs,
        "warning": f"NOT current — nothing after {through or 'unknown'} is here. "
                   f"Treat any recent-sounding reference as unverified, and do not "
                   f"assume the newest message you see is actually the newest.",
    })


def _parse_at(value: str) -> float:
    """Best-effort epoch for a context timestamp; 0.0 when unreadable.

    Used only to measure the gap between consecutive messages. An unreadable
    timestamp must not silently join two messages that are hours apart, so callers
    treat 0.0 as "cannot tell" and fall back to adjacency alone.
    """
    try:
        return float(R.parse_ts(value or ""))
    except Exception:
        return 0.0


def _incoming_burst(messages: list[dict], target: dict, rules: dict) -> list[dict]:
    """The consecutive run of incoming messages that `target` belongs to.

    Chat splits one thought across several bubbles. Judging only the last bubble is
    how "sign off on the contract amount / today please / thanks" gets classified as
    "thanks" — the risk words sit in a bubble the gate never read, and a reply that
    should be draft-only becomes auto-sendable. The error is asymmetric: folding can
    only ADD text to classify, so it can only ever make a verdict stricter, while
    reading the last bubble alone fails in exactly one direction — toward sending.

    The engine already treats a run this way when it BUILDS the corpus
    (`analyze._make_turn` joins several context lines into one `context_text`), so
    this restores the same unit at reply time.

    Walks backward from `target` while the sender is unchanged, nobody is the
    owner, and the gap stays under `policy.burst.gapSeconds`. Returns oldest→newest
    and always contains at least `target`.
    """
    burst_cfg = ((rules.get("policy") or {}).get("burst") or {})
    gap = float(burst_cfg.get("gapSeconds", 300) or 300)
    cap = int(burst_cfg.get("maxMessages", 12) or 12)

    try:
        idx = messages.index(target)
    except ValueError:
        return [target]

    run = [target]
    sender = target.get("sender") or ""
    prev_at = _parse_at(target.get("at", ""))
    for cand in reversed(messages[:idx]):
        if cand.get("isOwner"):
            break                       # the owner spoke: the run ends here
        if (cand.get("sender") or "") != sender:
            break                       # someone else spoke: not one person's run
        if not (cand.get("text") or "").strip():
            break
        cand_at = _parse_at(cand.get("at", ""))
        # Both timestamps readable and too far apart → a separate topic, not one
        # thought. An unreadable timestamp on either side means "cannot tell", and
        # the conservative reading there is to fold (more text, stricter verdict).
        if prev_at and cand_at and (prev_at - cand_at) > gap:
            break
        run.append(cand)
        prev_at = cand_at or prev_at
        if len(run) >= cap:
            break
    run.reverse()
    return run


def _fold_classification(burst: list[dict], rules: dict) -> dict:
    """Classify a burst as one unit, resolving conflicts conservatively.

    Risk classes are the UNION over the run: a risk named in any bubble is a risk
    in the thing being answered, wherever it was typed.

    The ask kind cannot be unioned — one action has to be chosen — so a kind in
    `alwaysDraftKinds` wins if any bubble carries one, and otherwise the last
    bubble's kind stands (which is what a single-message brief already produced).
    This mirrors `decisions.md` Step 4: when two rules disagree, take the more
    conservative one, and never upgrade.
    """
    joined = "\n".join((m.get("text") or "") for m in burst if (m.get("text") or "").strip())
    cls = classify(joined, rules)
    if len(burst) == 1:
        return cls

    always_draft = set(((rules.get("policy") or {}).get("alwaysDraftKinds")) or [])
    per_message = [classify(m.get("text") or "", rules) for m in burst]

    risks = sorted({t for c in per_message for t in (c.get("riskTags") or [])}
                   | set(cls.get("riskTags") or []))

    ask_kind = per_message[-1].get("askKind")
    gated = next((c.get("askKind") for c in per_message
                  if c.get("askKind") in always_draft), None)
    if gated:
        ask_kind = gated

    # A run of bubbles is a genuine ask if ANY of them is one — the question is
    # often not in the bubble that happens to be last.
    genuine = cls.get("genuineAsk")
    if any(c.get("genuineAsk") for c in per_message):
        genuine = True
    # ...and it is only chitchat if EVERY bubble is, or one "thanks" at the end
    # would discount a run that opened with a real question.
    chitchat = all(c.get("chitchat") for c in per_message) if per_message else cls.get("chitchat")

    return {**cls, "text": joined, "askKind": ask_kind, "riskTags": risks,
            "genuineAsk": genuine, "chitchat": chitchat}


def _bubbles_note(style: dict) -> str:
    """Turn the measured cadence into an instruction, or say it is unmeasured.

    Written here rather than in SKILL.md because the advice INVERTS on the number:
    a person who splits 45% of the time and one who splits 5% of the time need
    opposite guidance, and a fixed sentence in the prose would be wrong for one of
    them. When the figure is missing, say so instead of defaulting to either.
    """
    multi = style.get("multiBubblePct")
    med = style.get("medianBubbles")
    if multi is None or med is None:
        return ("cadence not measured in this build — answer in one message unless "
                "the points are clearly separate, and do not imitate a split you "
                "have no evidence for")
    if multi >= 30:
        return (f"{multi}% of their replies are more than one message. When the run "
                f"above raises several points, answer each in its own short message "
                f"— merging them into one paragraph is the giveaway.")
    return (f"only {multi}% of their replies are more than one message: they "
            f"normally answer in one. Split only when the points are genuinely "
            f"separate.")


def _clarify_note(rules: dict) -> str:
    """State what was measured, not one sentence covering both outcomes.

    The two cases need opposite instructions, so a single note that says "asking
    which one is a real move they make — and if the list is empty they do not do
    this" leads with the wrong half for whoever has an empty list. A weaker model
    reads the first clause and asks back in words the person never used.
    """
    if _clarify_option(rules):
        return ("When the corpus mentions the subject but does not settle the "
                "question, asking which thing is meant is a move this person "
                "really makes — `clarifyOption` holds their own words for it. "
                "Prefer it over a vague answer.")
    return ("No clarifying phrasings were mined from this corpus: there is no "
            "evidence this person asks back rather than answering or staying "
            "quiet. Do not improvise one — leave it for the owner.")


def cmd_brief(cfg: dict, a) -> int:
    """Everything needed to answer one message, decided, in one call.

    This command exists because orchestration is what a weaker model gets wrong.
    Given five reference files and a list of helper commands, it will skip the
    live context, forget to scope a lookup to the recipient, read a measured
    reply-rate as permission, and never think to check whether a fact is in the
    corpus at all. None of those are failures of language ability; they are
    failures of sequencing, and sequencing is what a script is for.

    So every mechanical step runs here — read the live window, find what the
    newest message is responding to, classify it, resolve the recipient by id,
    apply the gates, pull person-scoped precedents, extract fact leads — and the
    result is a verdict plus the exact next command. What is left for the model is
    the part that actually needs a model: reading the situation and writing one
    sentence in this person's voice.
    """
    rules = load_rules()
    ctx = _context_payload(cfg, a)
    messages = ctx.get("messages") or []

    target = None
    #: Was a specific message asked for and not found? That is a caller error
    #: (usually an id from a different namespace than the corpus keys on), and it
    #: must travel in the payload rather than being absorbed.
    #:
    #: ★ Falling back silently is the failure this flag exists to prevent. The old
    #: code dropped straight to "newest incoming message", so a wrong id produced a
    #: brief about a DIFFERENT message — same shape, same `verdict`, no error
    #: anywhere. A caller that mixes up two id namespaces (an external platform id
    #: vs. the local one the corpus is keyed on) gets a confident answer about the
    #: wrong thing, and nothing in the output says so.
    #:
    #: The fallback itself stays: `brief` with no `--message-id` is a legitimate
    #: call, and answering the newest incoming message is the right default. What
    #: changes is that an id that was given and missed is no longer indistinguishable
    #: from an id that was never given.
    target_missing = False
    if a.message_id:
        target = next((m for m in messages if m.get("messageId") == a.message_id), None)
        target_missing = target is None
    if target is None:
        target = next((m for m in reversed(messages) if not m.get("isOwner")), None)
    target_text = (target or {}).get("text", "")

    # Several bubbles from one person in a row are ONE thing to answer, and every
    # mechanical judgment below runs on the whole run rather than on the last
    # bubble. Folding can only ever add text, so it can only ever make the verdict
    # stricter.
    burst = _incoming_burst(messages, target, rules) if target is not None else []
    burst_text = "\n".join((m.get("text") or "") for m in burst
                           if (m.get("text") or "").strip()) or target_text

    # What the run is answering — searched from the FIRST bubble of the run, not
    # from the last. Looking back from the last one just finds another bubble of the
    # same run, which answers "what was said just before" instead of "what is this
    # replying to" and wastes the field that most often decides the reply.
    responding_to = None
    if target is not None:
        first = burst[0] if burst else target
        try:
            idx = messages.index(first)
        except ValueError:
            idx = messages.index(target)
        for prev in reversed(messages[:idx]):
            if (prev.get("text") or "").strip():
                responding_to = prev
                break

    cls = _fold_classification(burst, rules) if burst else classify(target_text, rules)

    person = None
    if a.peer_open_id:
        with corpus(cfg) as c:
            row = c.person_by_id(a.peer_open_id)
        person = _person_payload(row, a.peer_open_id)

    gate = decide_action(cls, person, rules)

    # Precedents are ALWAYS scoped to this person. Register does not transfer
    # between recipients, and an unscoped lookup returns lines written to someone
    # else while looking like an answer about this one.
    precedents = []
    scoped_name = (person or {}).get("name") or ""
    if burst_text:
        with corpus(cfg) as c:
            turns = c.similar_turns(burst_text, k=a.k,
                                    person=scoped_name or None)
        precedents = [{"given": t.get("context", ""), "theyReplied": t.get("reply", ""),
                       "at": t.get("occurredAt", "")} for t in turns]

    leads = _fact_leads(cfg, burst_text, scoped_name)

    style = rules.get("style") or {}
    next_steps = _next_steps(gate["verdict"], leads, a, style)

    return out({
        "rulesVersion": rules.get("rulesVersion", ""),
        "answering": {"messageId": (target or {}).get("messageId", ""),
                      "sender": (target or {}).get("sender", ""),
                      "text": burst_text,
                      "lastText": target_text,
                      "at": (target or {}).get("at", ""),
                      "messageCount": len(burst),
                      # Only present when it went wrong, so a consumer that never
                      # checks it is not reading a `false` as reassurance.
                      **({"requestedMessageId": a.message_id,
                          "requestedMessageFound": False} if target_missing else {})},
        **({"_targetWarning":
            f"--message-id {a.message_id!r} is not in the window this brief read, "
            f"so everything below describes a DIFFERENT message (the newest "
            f"incoming one). Usually the id belongs to another namespace than the "
            f"one this corpus is keyed on. Treat this brief as unusable and "
            f"re-run with an id from `conversation[].messageId`."}
           if target_missing else {}),
        "_answeringNote": ("`text` is the FULL run of consecutive messages from this "
                           "person — that is the thing being answered, and what the "
                           "classification and verdict below were computed from. "
                           "`lastText` is only the final message; answering that "
                           "alone is how a reply misses the actual question."
                           if len(burst) > 1 else
                           "One message. `text` and `lastText` are the same."),
        "burst": ({"count": len(burst),
                   "messages": [{"sender": m.get("sender", ""),
                                 "text": m.get("text", ""),
                                 "at": m.get("at", "")} for m in burst],
                   "note": "Sent as separate messages. Together they are the "
                           "context; individually they may raise SEVERAL points, "
                           "and every point that needs an answer needs one. How "
                           "many messages to answer with is a measured habit — see "
                           "`styleTargets.medianBubbles` and `multiBubblePct`. Do "
                           "not assume one reply means one message."}
                  if len(burst) > 1 else None),
        "respondingTo": ({"sender": responding_to.get("sender"),
                          "text": responding_to.get("text"),
                          "at": responding_to.get("at")}
                         if responding_to else None),
        "_respondingToNote": "What the run above is answering — looked up from before "
                             "the run started, not from its last message. A short "
                             "reply means almost nothing without it.",
        "context": {k: ctx[k] for k in
                    ("source", "degraded", "reason", "corpusThrough", "warning")
                    if k in ctx},
        "conversation": ctx.get("messages", [])[-a.window:],
        "classification": cls,
        "recipient": person or {"resolved": False,
                                "guidance": "no --peer-open-id given; an unresolved "
                                            "recipient is draft-only"},
        "verdict": gate["verdict"],
        "mayAutoSend": gate["mayAutoSend"],
        "because": gate["because"],
        "precedents": precedents,
        "_precedentsNote": (f"scoped to {scoped_name}" if scoped_name else
                            "NOT scoped to a person — treat register with suspicion"),
        "styleTargets": {
            "medianCodepoints": style.get("medianCodepoints"),
            "p90Codepoints": style.get("p90Codepoints"),
            "maxCodepoints": style.get("maxCodepoints"),
            "joinedClausePct": style.get("joinedClausePct"),
            # Cadence, measured — not a rule. `medianBubbles` is the usual number
            # of messages one reply is; `multiBubblePct` is how often it is more
            # than one, which is the figure that decides whether splitting a reply
            # across bubbles reads like them or like an impostor.
            "medianBubbles": style.get("medianBubbles"),
            "multiBubblePct": style.get("multiBubblePct"),
            "_bubblesNote": _bubbles_note(style),
            "avoidOpeners": style.get("manufacturedOpeners"),
            "neverWrite": style.get("neverWrite"),
            "hedgeWith": style.get("hedgeMarkers"),
        },
        "factLeads": leads,
        "_factLeadsNote": "Any lead with hits>0 has corpus evidence — run `facts` "
                          "before asserting anything about it. A lead with hits=0 is "
                          "not in the corpus: say you do not know rather than "
                          "answering from general knowledge.",
        # The third exit, surfaced here so it does not depend on the caller
        # thinking to run `facts` first. Present only when the corpus actually
        # shows this habit; absent means there is no evidence for it.
        "clarifyOption": _clarify_option(rules),
        "_clarifyNote": _clarify_note(rules),
        "nextSteps": next_steps,
    })


def _context_payload(cfg: dict, a) -> dict:
    """The recent window, labelled with how current it actually is.

    This is what `brief` embeds, so the label matters as much as the messages:
    the agent decides whether to answer based on what it thinks was just said.
    """
    live, live_error, read = [], "", {}
    if a.single and not a.peer_open_id:
        live_error = "a 1:1 needs --peer-open-id"
    else:
        try:
            read = _tail_with_lag(cfg, a)
            live = read["messages"]
        except R.DwsError as e:
            live_error = e.detail[:200]
        except Exception as e:
            live_error = str(e)[:200]

    if live:
        self_ids = set()
        try:
            with corpus(cfg) as c:
                self_ids = set(c.meta("selfOpenIds").split(",")) - {""}
        except FileNotFoundError:
            pass
        payload = {"source": read.get("source", "live"), "messages": [{
            "at": m.get("createdAt", ""), "sender": m.get("senderName", ""),
            "isOwner": (bool(m["isOwner"]) if "isOwner" in m
                        else bool(self_ids) and m.get("senderId") in self_ids),
            "text": m.get("text", ""), "messageId": m.get("messageId", ""),
        } for m in live]}
        if payload["source"] == "hostStore":
            payload["lagSeconds"] = read.get("lagSeconds")
            payload["collectedThrough"] = read.get("through", "")
        return payload

    with corpus(cfg) as c:
        rows = c.conversation_history(a.conversation_id, a.window or 20)
        through = c.meta("pulledThrough")
    return {
        "source": "corpus",
        "degraded": "no live read available",
        "reason": live_error or "this message source cannot read a live tail",
        "corpusThrough": through,
        "warning": f"NOT current — nothing after {through or 'unknown'} is here. Do "
                   f"not assume the last message shown is the newest one.",
        "messages": [{"at": r.get("occurred_at", ""),
                      "sender": r.get("sender_name", ""),
                      "isOwner": bool(r.get("is_self")),
                      "text": r.get("text", ""), "messageId": ""} for r in rows],
    }


def _person_payload(row: dict | None, peer_id: str) -> dict:
    if not row:
        return {"resolved": False, "personId": peer_id, "toneBand": "S",
                "sensitive": True,
                "guidance": "not in the corpus — treated as band S, draft only"}
    return {"resolved": True, "name": row.get("name", ""),
            "personId": row.get("person_id", peer_id),
            "toneBand": row.get("tone_band") or "S",
            "sensitive": bool(row.get("sensitive")),
            "title": row.get("title") or "",
            "autoAnswer": row.get("relationship") or "manual only"}


#: Shortest term worth checking at all.
_LEAD_MIN_LEN = 2

#: A fact lead has to be something a claim can be ABOUT. An interjection, a
#: laugh or a bare acknowledgement appears all over a corpus and supports nothing,
#: so listing it wastes the one mechanism that tells the model "this is
#: checkable" — and worse, its `hits > 0` invites a lookup that returns noise.
#:
#: Detected structurally rather than by vocabulary, so it needs no locale pack: a
#: term that repeats a single character (a doubled syllable, a drawn-out laugh) is
#: a vocal noise in every language that has them.
def _is_interjection(term: str) -> bool:
    if len(term) < 2:
        return True
    distinct = len(set(term))
    if distinct == 1:
        return True             # one character repeated
    if len(term) >= 2 and distinct * 2 <= len(term):
        return True             # a doubled syllable pattern
    return False


def _fact_leads(cfg: dict, text: str, person: str = "") -> list[dict]:
    """Terms in the incoming message that the corpus may have evidence about.

    Cheap on purpose — a count, not the lines. It exists so the model is told
    *that* a claim is checkable, since the failure being prevented is not a bad
    answer but a confident one about something never verified.
    """
    if not text:
        return []
    terms = R.search_terms(text, max_terms=8)

    # Collapse grams that cover overlapping spans of the SAME message. The search
    # expands a query into sliding windows for recall, which is right for finding
    # messages and wrong for reporting leads: several windows over one phrase are
    # one topic, and none of them contains another, so a containment test misses it.
    # Listing them all claims that several topics need checking and that most are
    # absent — and a weak model reads every `hits: 0` as "not in the corpus".
    #
    # Overlap is decided by POSITION in the original text, which is exact, rather
    # than by shared characters, which is a guess. Longest window wins its span.
    low = text.lower()
    spans: list[tuple[int, int]] = []
    kept: list[str] = []
    for term in sorted(terms, key=len, reverse=True):
        at = low.find(term.lower())
        if at < 0:
            # An ASCII identifier the tokenizer normalized; no span to compare.
            if term not in kept:
                kept.append(term)
            continue
        here = (at, at + len(term))
        if any(here[0] < s[1] and s[0] < here[1] for s in spans):
            continue
        spans.append(here)
        kept.append(term)

    seen, leads = set(), []
    try:
        with corpus(cfg) as c:
            for term in kept:
                if len(term) < _LEAD_MIN_LEN or term.lower() in seen:
                    continue
                if _is_interjection(term):
                    continue
                seen.add(term.lower())
                res = c.search_all(term, k=3, person=person or None)
                leads.append({"term": term, "hits": res["totalHits"],
                              "verdict": res["verdict"]})
    except FileNotFoundError:
        return []
    leads.sort(key=lambda x: -x["hits"])
    return leads[:6]


def _next_steps(verdict: str, leads: list[dict], a, style: dict) -> list[str]:
    """The exact commands to run next. Removes one more chance to improvise."""
    S = "python3 $S/scripts/persona.py"
    single = "true" if a.single else "false"
    base = (f'--conversation-id "{a.conversation_id}" --single {single} '
            f'--peer-open-id "{a.peer_open_id}"')
    if verdict == "silent":
        # Nothing to run: the host that dispatched this message owns the queue and
        # records the outcome itself. Naming a command here would send the caller
        # after a script this bundle no longer ships.
        return ["No reply needed — nothing to run."]
    steps = []
    checkable = [l["term"] for l in leads if l["hits"] > 0][:3]
    if checkable:
        steps.append("Verify before asserting anything about: "
                     + ", ".join(f'{S} facts --query "{t}"' for t in checkable))
    unknown = [l["term"] for l in leads if l["hits"] == 0][:3]
    if unknown:
        steps.append("NOT in the corpus — do not answer from general knowledge: "
                     + ", ".join(unknown))
    med = style.get("medianCodepoints") or 0
    steps.append(f"Draft it. Aim near {med} characters; split rather than joining "
                 f"clauses with a comma.")
    steps.append(f'{S} check --text "<your draft>"   # fix every `block`')
    if verdict == "draft":
        steps.append("STOP after check — this one is draft-only. Report the draft "
                     "and the reason from `because`; do not send.")
    else:
        steps.append(f'{S} fresh {base} --last-seen "{a.message_id}"')
        steps.append(f'{S} send {base} --text "<your draft>"')
    return steps


def _clarify_option(rules: dict) -> list[str]:
    """The owner's own ways of asking WHICH thing is meant.

    Read from `rules.json` rather than composed here, because these are mined
    lines, not phrasings anyone invented. An empty list is meaningful: it says the
    corpus shows no such habit, and the caller must not substitute a generic
    "could you clarify?" — that would make the agent visibly chattier than the
    person it imitates.
    """
    return [ln for ln in ((rules.get("escapeHatches") or {}).get("clarify") or [])
            if ln]


def cmd_facts(cfg: dict, a) -> int:
    """Is this in the corpus at all? Evidence, or an explicit no.

    Adds the third exit that the raw corpus lookup cannot know about. `search_all`
    can tell that a subject is mentioned while the asked-about part is missing
    (`partial`), and that state has an honest response beyond "do not assert it":
    ask which thing is meant. The wording comes from the owner's mined `clarify`
    lines, so the question sounds like them — and when none were mined, the option
    is simply absent rather than filled with a generic equivalent.
    """
    with corpus(cfg) as c:
        result = c.search_all(a.query, k=a.k, person=a.name or None)

    needs_narrowing = bool(result.get("partial")) or result.get("verdict") == "none"
    if needs_narrowing:
        options = _clarify_option(load_rules())
        if options:
            missing = ", ".join(result.get("notFound") or []) or a.query
            result["clarifyOption"] = options[:6]
            result["guidance"] = (
                f"{result['guidance']} You do not have to choose between guessing "
                f"and going quiet: if answering requires knowing {missing}, ask "
                f"which one is meant, using one of `clarifyOption` — those are "
                f"their own words for exactly this.")
        else:
            result["clarifyOption"] = []
            result["_clarifyNote"] = (
                "No clarifying phrasings were mined from this corpus, so there is "
                "no evidence this person asks back. Do not invent one — leave it "
                "for the owner.")
    return out(result)


def cmd_check(cfg: dict, a) -> int:
    """Mechanical review of a draft before sending."""
    return out(check_draft(a.text, load_rules()))


def cmd_status(cfg: dict, a) -> int:
    try:
        with corpus(cfg) as c:
            counts = c.counts()
            built = c.meta("lastBuildAt")
            through = c.meta("pulledThrough")
    except FileNotFoundError as e:
        return out({"ok": False, "error": str(e)}, 1)
    return out({
        "ok": True, "slug": cfg["profileSlug"],
        "autonomyScope": cfg.get("autonomy", {}).get("scope", "draft_only"),
        "corpus": counts, "lastBuildAt": built, "pulledThrough": through,
    })


# ---------------------------------------------------------------------------
# freshness + send
# ---------------------------------------------------------------------------

def _host_store(cfg: dict):
    """The embedding application's own database, if this profile reads from one.

    Returns None when the source is not a near-realtime store — the caller then
    falls back to the corpus and says so, exactly as before.
    """
    caps = cfg.get("_sourceCapabilities") or {}
    if not caps.get("recentReads"):
        return None
    path = ((cfg.get("source") or {}).get("options") or {}).get("path") or ""
    if not path:
        return None
    try:
        return R.HostStore(path, cfg.get("hostStoreSchema"),
                           _offset_minutes(cfg.get("timezoneOffset") or "+08:00"))
    except (FileNotFoundError, OSError):
        return None


def _offset_minutes(offset: str) -> int:
    """"+08:00" → 480. Falls back to +08:00 rather than to UTC on a bad value:
    this only shifts displayed wall-clock strings, and silently using UTC would
    shift every timestamp by the operator's real offset."""
    text = (offset or "").strip()
    if not text:
        return 480
    sign = -1 if text.startswith("-") else 1
    text = text.lstrip("+-")
    parts = text.split(":") if ":" in text else [text[:2], text[2:]]
    try:
        return sign * (int(parts[0]) * 60 + (int(parts[1]) if len(parts) > 1 and parts[1] else 0))
    except ValueError:
        return 480


def _tail(cfg: dict, a) -> list[dict]:
    """Most recent messages of the target conversation, oldest→newest.

    A 1:1 must be addressed by the peer's own user id — the conversation id is
    rejected by a direct-chat read.

    Three sources, in order of how current they are:

      1. the platform's own live read, where it has one;
      2. a near-realtime store the host application maintains (`recentReads`);
      3. nothing — raise, so the caller degrades visibly rather than passing
         corpus history off as current.

    (2) is not a live read and must never be treated as one, which is why
    `_tail_with_lag` exists for callers that need to reason about the lag. This
    function keeps the old signature for the callers that only want messages.
    """
    return _tail_with_lag(cfg, a)["messages"]


def _tail_with_lag(cfg: dict, a) -> dict:
    """`_tail` plus the freshness of what it returned.

    `lagSeconds` is `0` for a real live read, an integer for a near-realtime
    store, and `None` when unknown. Unknown is not zero: a caller about to send
    must treat it as unsafe (see `cmd_fresh`).
    """
    if a.single and not a.peer_open_id:
        return {"messages": [], "lagSeconds": None, "source": "none"}
    caps = cfg.get("_sourceCapabilities") or {}

    if caps.get("tail", True):
        msgs = client(cfg).conversation_tail(a.conversation_id, a.single,
                                             a.since or "", a.peer_open_id,
                                             limit=a.limit or 20)
        return {"messages": msgs, "lagSeconds": 0, "source": "live"}

    store = _host_store(cfg)
    if store is not None:
        with store as h:
            got = h.recent_messages(a.conversation_id, a.limit or 20)
        return {"messages": got["messages"], "lagSeconds": got["lagSeconds"],
                "through": got.get("through", ""), "source": "hostStore"}

    raise RuntimeError(
        f"the {caps.get('kind', 'configured')} message source cannot read a "
        f"live conversation tail")


def cmd_fresh(cfg: dict, a) -> int:
    """Is the message still the latest, and still unanswered?

    Called immediately before a send. Anything unclear counts as stale: the cost
    of a skipped send is a draft the owner reads, the cost of a wrong one is a
    message that cannot be taken back.
    """
    read = _tail_with_lag(cfg, a)
    msgs = read["messages"]
    if not msgs:
        return out({"stale": True, "reason": "could not read the conversation; "
                                             "never send on an unverified thread"})

    # ★ A near-realtime store may be behind. That is a third way to be stale,
    # alongside "the owner already replied" and "a newer message arrived" — and
    # the only one of the three that is invisible in the data itself: the newest
    # row really is the newest row we HAVE, while something newer may exist and
    # simply not be collected yet.
    #
    # Unknown lag counts as stale (`unknownLagIsStale`). Treating it as zero is
    # indistinguishable from "perfectly current" at exactly the moment it matters.
    lag_stale = False
    lag_reason = ""
    lag = read.get("lagSeconds")
    if read.get("source") == "hostStore":
        max_lag = _threshold("freshness", "maxLagSeconds", 150)
        if lag is None:
            lag_stale = _threshold("freshness", "unknownLagIsStale", True) is not False
            lag_reason = ("the local store cannot say how far behind it is; an "
                          "unverifiable read is not a safe basis for sending")
        elif lag > max_lag:
            lag_stale = True
            lag_reason = (f"the local store is {lag}s behind (limit {max_lag}s) — "
                          f"newer messages may exist that are not here yet")

    self_ids = set()
    try:
        with corpus(cfg) as c:
            self_ids = set(c.meta("selfOpenIds").split(",")) - {""}
    except FileNotFoundError:
        pass

    latest = msgs[-1]
    # `isOwner` when the read came from a host store that knows it; otherwise fall
    # back to matching the id set. An agent-sent message must NOT count as the
    # owner having replied — that would suppress every follow-up after the first
    # automated reply.
    if "isOwner" in latest:
        owner_spoke_last = bool(latest.get("isOwner")) and not latest.get("isAgentSent")
    else:
        owner_spoke_last = bool(self_ids) and latest.get("senderId") in self_ids
    target_found = any(m.get("messageId") == a.last_seen for m in msgs) if a.last_seen else False
    target_is_latest = (not a.last_seen) or latest.get("messageId") == a.last_seen

    if a.last_seen and not target_found:
        # The message being answered is not in the recent window at all — either
        # it was recalled or it is older than this read. Either way, do not send.
        return out({"stale": True, "reason": "the message being answered is no "
                                             "longer in the recent history",
                    "verdict": "cancel the send"})

    target_ts = next((R.parse_ts(m["createdAt"]) for m in msgs
                      if m.get("messageId") == a.last_seen), None)
    newer = ([m for m in msgs if R.parse_ts(m["createdAt"]) > target_ts]
             if target_ts is not None else [])

    stale = owner_spoke_last or not target_is_latest or lag_stale
    result = {
        "stale": stale,
        "ownerAlreadyReplied": owner_spoke_last,
        "targetIsLatest": target_is_latest,
        "newerMessages": len(newer),
        "newerPreview": [{"sender": m.get("senderName"), "text": m.get("text", "")[:120]}
                         for m in newer[:3]],
        "latest": {"sender": latest.get("senderName"), "text": latest.get("text", "")[:200]},
        "readFrom": read.get("source", "live"),
        "lagSeconds": read.get("lagSeconds"),
        "verdict": "cancel the send" if stale else "safe to proceed",
    }
    if lag_stale:
        result["lagReason"] = lag_reason
    return out(result)


def cmd_send(cfg: dict, a) -> int:
    data_root = Path(cfg["dataRoot"]).expanduser()
    audit_path = data_root / "action-audit.jsonl"
    auto = cfg.get("autonomy", {})
    scope = auto.get("scope", "draft_only")
    # The allowlist is keyed on openDingTalkId, not on a display name. A name is
    # a local label: one display name can map to several accounts, and a
    # conversation title is an editable remark — so renaming a stranger's thread
    # to a trusted colleague's name would otherwise walk straight through the
    # gate. `allowlistNames` is kept only for the audit trail and error text.
    allow_ids = set(auto.get("allowlist", []))
    labels = auto.get("allowlistNames", {})
    peer_id = a.peer_open_id or ""
    recipient = a.recipient or labels.get(peer_id, "")

    def blocked(reason: str, **extra) -> int:
        R.audit(audit_path, {"event": "send_blocked", "reason": reason,
                             "scope": scope, "recipient": recipient,
                             "peerOpenId": peer_id,
                             "conversationId": a.conversation_id,
                             "textLength": len(a.text)})
        return out({"sent": False, "blocked": True, "reason": reason, "scope": scope,
                    "guidance": "Report the draft and this reason. A blocked send "
                                "is a correct outcome.", **extra}, 3)

    if not a.text.strip():
        return blocked("empty text")

    # Content review, on the DRAFT — before any scope or recipient check.
    #
    # Order matters for the reason a caller is given. A draft that states an
    # approval is wrong in EVERY scope, so reporting "sending is disabled" first
    # would teach the caller that the fix is to widen the scope. It is not: the fix
    # is to not state the approval.
    #
    # Run here rather than trusted to the caller, because a caller forgetting to
    # run `check` is precisely the failure this exists to stop.
    rules = load_rules()
    review = check_draft(a.text, rules)
    if review["result"] == "block":
        return blocked(
            "the draft did not pass content review: "
            + "; ".join(pr["detail"] for pr in review["problems"]
                        if pr["severity"] == "block"),
            review=review)

    if scope == "draft_only":
        return blocked("autonomy scope is draft_only — sending is disabled; "
                       "change it with `forge autonomy --scope ...`")
    if scope not in ("allowlist", "everyone"):
        return blocked(f"unknown autonomy scope '{scope}'; falling back to draft_only")

    if scope == "allowlist":
        if not a.single:
            return blocked("allowlist scope only auto-sends in 1:1 chats — a group "
                           "has no single identity to check against the allowlist")
        if not peer_id:
            return blocked("allowlist scope requires --peer-open-id: the allowlist "
                           "is keyed on identity, and a name cannot be trusted")
        if peer_id not in allow_ids:
            who = f"'{recipient}' " if recipient else ""
            return blocked(
                f"{who}({peer_id[:12]}…) is not in the autonomy allowlist",
                hint="authorize with `forge autonomy --allow \"<name>\"` on the "
                     "machine that owns the corpus; it resolves the name to an id")
        # Defence in depth: if the caller passed a name too, it must agree with
        # the name recorded for that id. A mismatch means the agent is reasoning
        # about a different person than it is about to message.
        known = labels.get(peer_id)
        if a.recipient and known and a.recipient != known:
            return blocked(
                f"recipient name '{a.recipient}' does not match the allowlisted "
                f"name for this id ('{known}') — refusing to send on a mismatch")

    if scope == "everyone":
        # "Everyone" means every recipient the corpus can identify — not literally
        # anyone. Without these three checks the widest scope would auto-send to a
        # stranger the owner has never messaged, to an HR/finance/legal contact, or
        # into a group, none of which this scope ever promised.
        if not a.single:
            return blocked(
                "even in `everyone` scope, groups are not auto-answered: a group has "
                "no single recipient whose relationship can be resolved, and a "
                "mis-sent group message is visible to everyone in it",
                hint="draft it for the owner instead")
        if not peer_id:
            return blocked("send needs --peer-open-id to identify the recipient")
        person = None
        try:
            with corpus(cfg) as c:
                person = c.person_by_id(peer_id)
        except FileNotFoundError:
            return blocked("cannot verify the recipient without the local corpus; "
                           "refusing to auto-send to an unverified identity")
        if not person:
            return blocked(
                f"recipient ({peer_id[:12]}…) is not in the corpus — an unresolved "
                "recipient is treated as band S (manual only) in every scope",
                hint="the owner has no message history with them, so there is no "
                     "measured way to sound like themselves to this person")
        if person.get("sensitive") or (person.get("tone_band") or "S") == "S":
            return blocked(
                f"'{person.get('name') or peer_id[:12]}' is band S / a sensitive role "
                "(HR, finance, legal, exec) — never auto-answered, in any scope",
                hint="draft it for the owner")
        recipient = recipient or person.get("name") or ""

    max_cp = auto.get("maxCodepoints", 300)
    if len(a.text) > max_cp:
        return blocked(f"reply is {len(a.text)} characters, over the {max_cp} limit")

    target = ({"open-dingtalk-id": a.peer_open_id} if a.single
              else {"group": a.conversation_id})
    if a.single and not a.peer_open_id:
        return blocked("single chat send needs --peer-open-id")

    if a.dry_run:
        return out({"dryRun": True, "wouldSend": True, "target": target,
                    "scope": scope, "textLength": len(a.text),
                    "contentReview": review["result"]})

    cl = client(cfg)
    # The runtime re-checks scope, allowlist, length, channel AND the draft's risk
    # classes independently. The checks above give better error messages and catch
    # mismatches this layer cannot see; the redundancy is deliberate, because
    # anything that imports the runtime directly must still hit a gate.
    send_cfg = dict(cfg)
    send_cfg["riskPatterns"] = (rules.get("patterns") or {}).get("riskTags")
    result = cl.send(target, a.text, cfg=send_cfg, recipient=recipient,
                     audit_path=audit_path)
    if not result.ok:
        R.audit(audit_path, {"event": "send_failed", "error": result.error[:200],
                             "conversationId": a.conversation_id})
        return out({"sent": False, "error": result.error}, 1)

    mid = _extract_message_id(result.data)
    ledger = data_root / "agent-sent.jsonl"
    R.audit(ledger, {"messageId": mid or "", "conversationId": a.conversation_id,
                     "sentBy": "persona-agent"})
    R.audit(audit_path, {"event": "sent", "messageId": mid or "",
                         "conversationId": a.conversation_id,
                         "recipient": recipient, "scope": scope,
                         "textLength": len(a.text)})
    return out({"sent": True, "messageId": mid, "ledgerRecorded": True})


def _extract_message_id(payload: dict) -> str | None:
    for path in (("result", "openMessageId"), ("result", "messageId"),
                 ("openMessageId",), ("result", "processQueryKey")):
        node = payload
        for key in path:
            if isinstance(node, dict) and key in node:
                node = node[key]
            else:
                node = None
                break
        if isinstance(node, str) and node:
            return node
    return None


# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="persona runtime")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--k", type=int, default=6)
        p.add_argument("--tone")
        p.add_argument("--scene")
        p.add_argument("--name")

    p = sub.add_parser("recall"); p.add_argument("--context", required=True); common(p)
    p = sub.add_parser("lines"); p.add_argument("--query"); common(p)
    p = sub.add_parser("who")
    p.add_argument("--name", default="")
    p.add_argument("--person-id", default="",
                   help="openDingTalkId — exact, and immune to renamed chats")
    p = sub.add_parser("thread")
    p.add_argument("--conversation-id", required=True)
    p.add_argument("--limit", type=int, default=30)
    sub.add_parser("status")

    p = sub.add_parser("facts")
    p.add_argument("--query", required=True)
    p.add_argument("--k", type=int, default=12)
    p.add_argument("--name", default="", help="scope to one person's threads")

    p = sub.add_parser("check")
    p.add_argument("--text", required=True)

    p = sub.add_parser("brief")
    p.add_argument("--conversation-id", required=True)
    p.add_argument("--single", type=lambda v: str(v).lower() in ("1", "true", "yes"),
                   default=False)
    p.add_argument("--peer-open-id", default="")
    p.add_argument("--message-id", default="",
                   help="the message being answered; defaults to the newest one "
                        "that is not the owner's")
    p.add_argument("--window", type=int, default=12,
                   help="how many recent messages to read as context")
    p.add_argument("--k", type=int, default=5, help="precedents to return")
    p.add_argument("--since")
    p.add_argument("--limit", type=int, default=20)

    # `context` needs the live-read arguments, so it is grouped with fresh/send
    # rather than with the corpus readers.
    for name in ("context", "fresh", "send"):
        p = sub.add_parser(name)
        p.add_argument("--conversation-id", required=True)
        p.add_argument("--single", type=lambda v: str(v).lower() in ("1", "true", "yes"),
                       default=False)
        p.add_argument("--peer-open-id", default="")
        p.add_argument("--since")
        p.add_argument("--limit", type=int, default=20)
        if name == "context":
            pass
        elif name == "fresh":
            p.add_argument("--last-seen", default="")
        else:
            p.add_argument("--text", required=True)
            p.add_argument("--recipient", default="",
                           help="exact recipient name, checked against the allowlist")
            p.add_argument("--dry-run", action="store_true")

    a = ap.parse_args()
    # The data root is what makes recall possible; a skill copied to a machine
    # without it must degrade to the Markdown, not crash with a traceback.
    try:
        cfg = load_config()
    except (SystemExit, FileNotFoundError, json.JSONDecodeError) as e:
        return out({"error": str(e),
                    "degraded": "markdown-only",
                    "guidance": "This machine has no local corpus, so recall / who / "
                                "send are unavailable. The persona is still fully "
                                "usable from references/*.md — read decisions.md "
                                "first, then people.md, scenes.md, style.md."}, 1)
    handlers = {"recall": cmd_recall, "lines": cmd_lines, "who": cmd_who,
                "thread": cmd_thread, "context": cmd_context, "status": cmd_status,
                "brief": cmd_brief, "facts": cmd_facts, "check": cmd_check,
                "fresh": cmd_fresh, "send": cmd_send}
    try:
        return handlers[a.cmd](cfg, a)
    except FileNotFoundError as e:
        return out({"error": str(e), "degraded": "markdown-only",
                    "hint": "run `forge pull` then `forge publish` on the machine "
                            "that owns the corpus; or use references/*.md directly"}, 1)
    except R.DwsError as e:
        return out({"error": str(e), "transient": e.transient}, 1)


if __name__ == "__main__":
    raise SystemExit(main())
