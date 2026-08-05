#!/usr/bin/env python3
"""Compose: measured features → complete, directly-usable skill files.

The rule this module exists to enforce: **a published skill contains no
placeholders and no "tune me later" holes.** Whatever the corpus could measure is
rendered as concrete guidance; whatever it could not is stated as an explicit
limit. A loading agent should never have to improvise the persona's own rules.

Owner edits are respected without breaking rebuildability. Every generated file
is split into marked blocks:

    <!-- forge:begin section -->   generated; overwritten on every publish
    <!-- forge:end section -->
    <!-- owner:begin section -->   yours; preserved verbatim across publishes
    <!-- owner:end section -->

So `forge publish` after a fresh `forge pull` updates the measured parts and
leaves hand-written corrections alone. That is what "all tuning goes through the
forge" means in practice: the forge owns the evidence, the owner owns the
exceptions, and neither silently overwrites the other.
"""

from __future__ import annotations

import re
from pathlib import Path

from . import common as C

OWNER_BLOCK_RE = re.compile(
    r"<!-- owner:begin (?P<name>[\w.-]+) -->(?P<body>.*?)<!-- owner:end \1 -->",
    re.S)


def extract_owner_blocks(text: str) -> dict[str, str]:
    return {m.group("name"): m.group("body") for m in OWNER_BLOCK_RE.finditer(text or "")}


def merge_owner_blocks(generated: str, existing: str) -> str:
    """Carry the owner's blocks from an installed file into the new render."""
    return apply_owner_blocks(generated, extract_owner_blocks(existing))


def apply_owner_blocks(generated: str, blocks: dict[str, str]) -> str:
    """Substitute known owner blocks into a freshly generated file.

    Blocks may come from the installed file or from the data-root backup, which
    is what lets a deleted skill be rebuilt with the owner's edits intact.
    """
    if not blocks:
        return generated

    def sub(m: re.Match) -> str:
        name = m.group("name")
        if name in blocks:
            return f"<!-- owner:begin {name} -->{blocks[name]}<!-- owner:end {name} -->"
        return m.group(0)

    return OWNER_BLOCK_RE.sub(sub, generated)


def owner_block(name: str, hint: str) -> str:
    return (f"<!-- owner:begin {name} -->\n"
            f"<!-- {hint}\n     Anything you write between these markers survives "
            f"every `forge publish`. -->\n"
            f"<!-- owner:end {name} -->")


# ---------------------------------------------------------------------------
# helpers for rendering measured numbers as instructions
# ---------------------------------------------------------------------------

def _band_label(band: str) -> str:
    return {"A": "A (closest)", "B": "B (trusted, frequent)", "C": "C (domain peer)",
            "D": "D (sparse)", "S": "S (unknown or sensitive)",
            "unresolved": "unresolved"}.get(band, band)


def _len_instruction(s: dict, t: dict | None = None) -> str:
    """Length guidance from the median, with the mean's skew made explicit."""
    t = t or {}
    very_short = t.get("veryShortCodepoints", 12)
    full = t.get("fullSentenceCodepoints", 25)
    skew = t.get("meanSkewRatio", 1.8)
    med = s.get("medianCodepoints") or 0
    mean = s.get("avgCodepoints") or 0
    p90 = s.get("p90Codepoints") or 0
    if not med:
        return "keep replies short"
    if med < very_short:
        base = (f"a typical message is **{med} characters** — one thought per "
                "message; several short bubbles beat one tidy paragraph")
    elif med < full:
        base = f"a typical message is **{med} characters**; expand only to explain a plan"
    else:
        base = f"a typical message is **{med} characters** — fuller sentences here"
    if mean and med and mean > med * skew:
        base += (f" (mean is {mean} because a few long write-ups pull it up; "
                 f"90% are under {p90} — write to the median, not the mean)")
    return base


def _top(mapping: dict, n: int = 4) -> list[tuple[str, float]]:
    return sorted(mapping.items(), key=lambda x: -x[1])[:n]


def _fmt_pct_map(mapping: dict, n: int = 4) -> str:
    return " · ".join(f"{k} {v}%" for k, v in _top(mapping, n)) or "—"


ASK_KIND_LABEL = {
    "decision_request": "asking you to decide / choose / approve",
    "approval_or_commit": "asking for a commitment, date, or amount",
    "help_request": "asking you to do or look at something",
    "status_chase": "chasing progress",
    "technical_question": "asking a technical question",
    "disagreement": "disagreeing or pushing back",
    "ack_or_fyi": "acknowledging / FYI",
    "other_ask": "other question",
}

RISK_LABEL = {
    "commitment": "promises and guarantees",
    "approval": "approvals and sign-off",
    "money": "budget, price, payment",
    "scheduling": "dates, deadlines, meeting times, leave",
    "personnel": "performance, hiring, HR matters",
    "external_position": "anything said outward (customers, legal, PR)",
    "org_decision": "ownership, org and reporting decisions",
    "destructive": "deletion, rollback, permission changes",
}

ACTION_LABEL = {
    "settle_ok": "answer it directly; you usually resolve these yourself",
    "answer": "answer it directly with the facts you have",
    "handoff": "point at the person who actually knows, rather than answering",
    "often_silent": "usually needs no reply at all — stay silent unless it is aimed squarely at you",
    "draft": "draft it and let the owner decide (too little history to lean on)",
    "draft_gated": "**draft only** — this is the owner's call to make, however "
                   "often they engage with it",
}


# ---------------------------------------------------------------------------
# file renderers
# ---------------------------------------------------------------------------

def render_style(name: str, style: dict, window: str, pack=None, rules=None) -> str:
    """Render the style reference.

    Every language-specific example in this file comes from the active locale
    pack's `guidance` block. When no pack is loaded, the lexical advice is
    OMITTED rather than defaulted: telling someone's agent not to write a phrase
    in a language the corpus is not in is noise, and worse, it implies the style
    layer was measured when it was not.
    """
    from .locale import NULL_PACK
    pack = pack or NULL_PACK
    t = (rules.thresholds.get("styleNarration", {}) if rules else {})
    o = style["overall"]
    coverage = style.get("coverage", {})
    lines = [
        f"# How {name} writes",
        "",
        f"Measured over {o['messages']:,} of their own messages across "
        f"{style['activeDays']} active days ({window}). Numbers are evidence, not "
        "targets to hit exactly — match the shape, not the decimal.",
        "",
    ]
    if pack.is_null:
        lines += [
            "> **No locale pack matched this corpus.** Everything below is "
            "structural — length, timing, and how replies are distributed. The "
            "word-level layer (markers, register, catchphrases) could not be "
            "measured at all. See `fidelity.md` for exactly what is missing, and "
            "do not infer that an absent number means the person never does that "
            "thing.",
            "",
        ]
    lines += [
        "## Baseline",
        "",
        f"- **Length**: {_len_instruction(o, t)}.",
        f"  Mix: {_fmt_pct_map(o.get('lengthMixPct', {}), 3)}.",
    ]
    if coverage.get("questionDetection", True):
        lines.append(
            f"- **Questions**: {o.get('questionPct')}% of messages end up asking "
            "something — they hand the ball back rather than closing a topic.")

    joined = o.get("joinedClausePct")
    if joined is not None:
        # The number an imitator most often gets wrong while satisfying every
        # other one: it is possible to hit the median length and still join two
        # thoughts with a comma where this person would have sent two messages.
        if joined < 25:
            lines.append(
                f"- **One thought per message**: only {joined}% of their messages "
                "contain a joining comma or semicolon. They do not write `A, B` — "
                "they send `A`, then `B`. Splitting is more like them than "
                "punctuating, and this is the habit that most often gives an "
                "imitation away.")
        else:
            lines.append(
                f"- **Clause joining**: {joined}% of their messages join clauses "
                "with a comma or semicolon — they are comfortable putting two "
                "thoughts in one message.")

    # One granularity up from clause joining: how many MESSAGES one reply is. An
    # imitation that always answers with exactly one bubble reads like email in a
    # chat window; one that always splits is just as wrong. Both are guesses unless
    # the number is measured, and it differs per person and per band.
    bub = (o.get("bubbles") or {})
    if bub.get("samples"):
        multi = bub.get("multiBubblePct", 0)
        lines.append(
            f"- **Messages per reply**: typically **{bub.get('medianBubbles')}**, "
            f"mean {bub.get('meanBubbles')} — **{multi}% of their replies are more "
            f"than one message** (longest run seen: {bub.get('maxBubbles')}). "
            + ("Splitting one reply across several messages is normal for them: "
               "when a burst raises several points, answer each one in its own "
               "short message rather than merging them into a paragraph."
               if multi >= 30 else
               "They usually answer in a single message; only split when the points "
               "are genuinely separate.")
            + f" Measured over {bub.get('samples')} replies.")
    hedge_m = pack.guide("hedgeMarkers")
    assert_m = pack.guide("assertMarkers")
    if hedge_m and assert_m:
        lines.append(
            f"- **Hedge vs assert**: {o.get('hedgeToAssertRatio')}:1 "
            f"(soft markers like {hedge_m} vs hard ones like {assert_m}). "
            "Soften the tone, never the position.")
    elif not pack.is_null:
        lines.append(f"- **Hedge vs assert**: {o.get('hedgeToAssertRatio')}:1. "
                     "Soften the tone, never the position.")

    per1k = o.get("per1k", {})
    if per1k:
        notable = [(k, v) for k, v in _top(per1k, 6)]
        lines.append("- **Markers per 1k characters**: "
                     + " · ".join(f"{k} {v}" for k, v in notable) + ".")

    openers = o.get("openerMixPct", {})
    if openers:
        straight = openers.get("straight_into_content", 0)
        manufactured = pack.guide("manufacturedOpeners")
        opener_note = (
            f"`straight_into_content` is {straight}% — **there is no template "
            "opener.** ")
        opener_note += (f"Do not manufacture {manufactured} in front of a reply; "
                        "state the thing." if manufactured
                        else "Do not manufacture a greeting or filler phrase in "
                             "front of a reply; state the thing.")
        lines += ["", "## How they open a reply", "", opener_note, "",
                  "| Opening shape | Share |", "|---|---|"]
        for shape, share in _top(openers, 8):
            lines.append(f"| `{shape}` | {share}% |")

    lines += ["", "## Shift by who they are talking to", "",
              "A row marked ⚠︎ is too thin to imitate — draft rather than send, "
              "and use the overall numbers above instead of the row.",
              "",
              "| Tone band | Replies | Days | Median len | Msgs/reply | Multi-msg | "
              "Questions | Joined clauses | Hedge:assert | Laughter/1k | Rough/1k |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for band, s in style.get("byToneBand", {}).items():
        p = s.get("per1k", {})
        jc = s.get("joinedClausePct")
        b = s.get("bubbles") or {}
        ev = s.get("evidence") or {}
        bub_med = b.get("medianBubbles", "—") if b.get("samples") else "—"
        bub_multi = f"{b.get('multiBubblePct')}%" if b.get("samples") else "—"
        mark = "" if ev.get("sufficient", True) else " ⚠︎"
        lines.append(
            f"| {_band_label(band)}{mark} | {s['messages']} | "
            f"{ev.get('distinctDays', '—')} | {s['medianCodepoints']} | "
            f"{bub_med} | {bub_multi} | "
            f"{s['questionPct']}% | {'—' if jc is None else f'{jc}%'} | "
            f"{s['hedgeToAssertRatio']}:1 | "
            f"{p.get('laughter', 0)} | {p.get('rough', 0)} |")

    bands = style.get("byToneBand", {})
    if bands:
        lines += ["", _band_reading(bands)]

    lines += ["", "## Shift by situation", "",
              "A row marked ⚠︎ is too thin to imitate — see `scenes.md` for what "
              "to do instead.",
              "",
              "| Scene | Messages | Days | Median len | Questions | Enumerated/1k |",
              "|---|---|---|---|---|---|"]
    for scene, s in sorted(style.get("byScene", {}).items(),
                           key=lambda x: -x[1]["messages"]):
        ev = s.get("evidence") or {}
        mark = "" if ev.get("sufficient", True) else " ⚠︎"
        lines.append(f"| {scene}{mark} | {s['messages']} | "
                     f"{ev.get('distinctDays', '—')} | {s['medianCodepoints']} | "
                     f"{s['questionPct']}% | {s.get('per1k', {}).get('enumerate', 0)} |")

    vocab = style.get("vocabulary", {})
    phrases = vocab.get("phrases", [])[:24]
    jargon = vocab.get("jargon", [])[:18]
    if phrases:
        lines += ["", "## Their words", "",
                  "Ranked by how many distinct days each appears on, so one busy "
                  "thread cannot fake a catchphrase.", "",
                  "- " + " · ".join(f"`{p['term']}`({p['days']}d)" for p in phrases)]
    if jargon:
        lines += ["", "Terms and tools they name directly:", "",
                  "- " + " · ".join(f"`{j['term']}`" for j in jargon)]

    never = pack.guide("neverWrite") or []
    if never:
        lines += ["", "## Never write", "",
                  "Corporate register they never use. These read instantly as not-them:",
                  ""]
        lines += [f"- {item}" for item in never]
    else:
        lines += ["", "## Never write", "",
                  "No register list is available for this corpus's language, so "
                  "this section is empty by design rather than by measurement. "
                  "The general rule still holds: write as this person writes, not "
                  "as an assistant. Never explain that you are an assistant, and "
                  "never apologize for a delay in a chat message.", ""]

    lines += [
        "",
        owner_block("style-extra",
                    "Add or correct anything about their writing here — "
                    "wrong catchphrase, a word they hate, a habit the numbers missed."),
        "",
    ]
    return "\n".join(lines)


def _band_reading(bands: dict) -> str:
    """One-line human reading of the band table, from the numbers themselves.

    Thin bands are excluded before anything is concluded. The reading names a
    shortest and a longest band and turns that into a rule of thumb ("the less
    familiar the recipient, the more complete the sentence") — and a band with
    four replies across two days can hold either extreme by chance, which would
    invert the advice.
    """
    known = {b: s for b, s in bands.items()
             if b in ("A", "B", "C", "D", "S")
             and (s.get("evidence") or {}).get("sufficient", True)}
    if len(known) < 2:
        return ("Only one tone band has enough data — treat everyone the same until "
                "more history accumulates.")
    lengths = {b: s["medianCodepoints"] for b, s in known.items()}
    closest = min(lengths, key=lambda b: lengths[b])
    farthest = max(lengths, key=lambda b: lengths[b])
    rough = {b: s.get("per1k", {}).get("rough", 0) for b, s in known.items()}
    rough_bands = [b for b, v in rough.items() if v > 0]
    parts = [
        f"**Reading**: shortest with band {closest} ({lengths[closest]} chars), "
        f"longest with band {farthest} ({lengths[farthest]} chars) — "
        "the less familiar the recipient, the more complete the sentence."]
    if rough_bands:
        parts.append(f"Rough language appears only with band(s) {', '.join(sorted(rough_bands))}; "
                     "never use it with anyone else.")
    return " ".join(parts)


def render_decisions(name: str, policy: dict, mined: dict) -> str:
    prop = {k: d for k, d in mined["replyPropensity"].items() if not k.startswith("_")}
    baseline_block = mined["replyPropensity"].get("_baseline", {})
    baseline = baseline_block.get("answerRatePct")
    classified = baseline_block.get("kindsClassified", True)
    risk = mined["riskBehavior"]
    hatches = mined["escapeHatches"]
    coverage = mined.get("coverage", {})

    lines = [
        f"# What {name} answers, and what they never settle alone",
        "",
        f"Derived from {mined['asksAnalyzed']:,} incoming asks in their own history, "
        "including the ones they chose not to answer. Read this **before** drafting: "
        "deciding whether to reply comes before deciding how to phrase it.",
        "",
    ]
    if not classified:
        lines += [
            "> **This build could not classify what was being asked.** No locale "
            "pack matched the corpus, so every ask falls into one bucket and the "
            "table below cannot distinguish a technical question from a request "
            "for approval. Consequence: **draft everything.** The hard stops in "
            "Step 2 still apply in full, and they apply more broadly than usual.",
            "",
        ]
    if baseline is not None:
        lines += [
            f"**Their baseline is {baseline}%** — that is how often they answer an "
            "ask of any kind. Judge each row against that number, not against 50%: "
            "a kind sitting well below the baseline is one they deliberately let go.",
            "",
        ]
    lines += [
        "## Step 1 — is this even theirs to answer?",
        "",
        "| What is being asked | Seen | They answered | vs baseline | Their default move |",
        "|---|---|---|---|---|",
    ]
    for kind, d in prop.items():
        label = ASK_KIND_LABEL.get(kind, kind)
        action = ACTION_LABEL.get(d["defaultAction"], d["defaultAction"])
        star = "" if d["evidenceSufficient"] else " ⚠︎thin"
        delta = d.get("vsBaselinePct")
        delta_s = f"{delta:+.0f} pts" if delta is not None else "—"
        lines.append(f"| {label}{star} | {d['total']} | {d['answerRatePct']}% | "
                     f"{delta_s} | {action} |")

    lines += [
        "",
        "⚠︎thin = too few examples to trust; draft and let the owner decide.",
        "",
        "## Step 2 — the hard stop",
        "",
        "**Never settle these on your own, regardless of who is asking or how "
        "friendly the thread is.** Draft the reply, or say the owner will follow "
        "up — never state a decision.",
        "",
        "| Risk class | Seen | They settled it themselves | Rule | Why |",
        "|---|---|---|---|---|",
    ]
    for tag, d in risk.items():
        label = RISK_LABEL.get(tag, tag)
        settled = d["shapePct"].get("settle", 0)
        rule = ("**never settle** — draft only" if d["policy"] == "never_settle"
                else "they sometimes settle these; still draft, and mirror their wording")
        seen = d["total"] if d["total"] else "—"
        settled_s = f"{settled}%" if d["total"] else "—"
        lines.append(f"| {label} | {seen} | {settled_s} | {rule} | "
                     f"{d.get('reason', '')} |")

    lines += [
        "",
        "A risk class with no history is treated as never-settle. Absence of "
        "evidence is not permission — and note the **Why** column: a class marked "
        "undetectable was never measured at all, so nothing about the owner's "
        "habits should be inferred from its row.",
        "",
    ]

    if not coverage.get("replyShapes", True):
        lines += [
            "> **No reply-shape lexicon for this language.** Whether a given reply "
            "settled a matter, handed it off, or postponed it could not be "
            "determined, so every risk class above defaults to never-settle and "
            "the escape hatches below are empty. Auto-send is not available in "
            "this build regardless of the configured scope.",
            "",
        ]

    any_hatch = any(hatches.get(k)
                    for k in ("handoff", "defer", "decline", "clarify"))
    lines += ["## Step 3 — their own escape hatches", ""]
    if any_hatch:
        lines += [
            "When the answer is not theirs to give, they do not go quiet and they "
            "do not invent one. They redirect or postpone, in these words:",
            "",
        ]
        for key, heading in (
                ("handoff", "**Redirecting to whoever actually knows:**"),
                ("defer", "**Postponing without dropping it:**"),
                ("decline", "**Declining / pushing back — note they give the "
                            "reason, not just the no:**"),
                ("clarify", "**Pinning down WHICH thing is meant, before "
                            "answering — use these when the corpus mentions the "
                            "subject but does not settle the question:**")):
            if hatches.get(key):
                lines += [heading, ""]
                lines += [f"- {_quote(h['line'])}" for h in hatches[key][:6]]
                lines.append("")
        lines += [
            "Reuse the **shape**, never the sentence: the names and facts in those "
            "lines belong to their moment. A redirect only works if the person it "
            "points at really is the right one for *this* question.",
            "",
        ]
    else:
        lines += [
            "None could be extracted from this corpus. Do not invent one: when the "
            "answer is not theirs to give, draft a reply for the owner rather than "
            "improvising a redirect in words they have never used.",
            "",
        ]

    lines += [
        "## Step 4 — pick the action",
        "",
        "```",
        "risk class hit (Step 2)                         → draft_only",
        "being asked to decide / approve / commit         → draft_only",
        "recipient unresolved, or tone band S             → draft_only",
        "ask kind marked often_silent, not aimed at you   → silent",
        "ask kind marked handoff                          → draft a redirect",
        "otherwise, and autonomy scope permits            → reply",
        "```",
        "",
        "When two rules disagree, take the more conservative one. Downgrade freely "
        "(reply → draft → silent); never upgrade.",
        "",
        "## Their reply rate by relationship",
        "",
    ]
    for tone, kinds in mined.get("byToneBand", {}).items():
        top = list(kinds.items())[:4]
        if top:
            detail = " · ".join(f"{ASK_KIND_LABEL.get(k, k)} {v['answerRatePct']}%"
                                for k, v in top)
            lines.append(f"- **{_band_label(tone)}**: {detail}")

    lines += [
        "",
        owner_block("decisions-extra",
                    "Add hard rules of your own: topics never to touch, people to "
                    "always hand to you, phrasings you refuse."),
        "",
    ]
    return "\n".join(lines)


def _quote(line: str) -> str:
    """Quote one of the owner's real lines.

    Plain double quotes rather than a script-specific bracket pair: the corner
    brackets that read naturally in CJK look like stray punctuation in Latin
    text, and the quoted content here can be in any language.
    """
    return f"“{line}”"


def render_scenes(name: str, style: dict, mined: dict, examples: dict,
                  rules=None) -> str:
    t = (rules.thresholds.get("scenes", {}) if rules else {})
    style_t = (rules.thresholds.get("styleNarration", {}) if rules else {})
    min_msgs = t.get("minMessagesToRender", 3)
    laughter_cut = t.get("laughterPer1kToMention", 0.5)
    n_examples = t.get("examplesPerScene", 4)
    lines = [
        f"# Situations — how {name} shifts",
        "",
        "Pick exactly one situation. If none fits, or the recipient is unresolved, "
        "use **Unknown or sensitive**.",
        "",
    ]
    scenes = style.get("byScene", {})
    order = ["direct_chat", "group_chat", "product", "formal_report",
             "escalation", "external"]
    titles = {
        "direct_chat": "One-to-one work chat",
        "group_chat": "Group chat",
        "product": "Product / technical discussion",
        "formal_report": "Report, plan, or retrospective",
        "escalation": "Something is broken or blocked",
        "external": "Anyone outside the team",
    }
    if not style.get("coverage", {}).get("sceneLexicon", True):
        lines += [
            "> **No scene lexicon for this corpus's language**, so topical "
            "situations (product / report / escalation / external) could not be "
            "detected. Only the channel-level split below is measured. Treat any "
            "thread that feels high-stakes as **Unknown or sensitive**.",
            "",
        ]
    for key in order:
        s = scenes.get(key)
        if not s or s["messages"] < min_msgs:
            continue
        share = C.pct(s["messages"], style["overall"]["messages"])
        ev = s.get("evidence") or {}
        # A scene can clear the render bar and still be far too thin to imitate.
        # Marked in the heading, because a reader who only skims headings is
        # exactly the reader who would otherwise treat 20 messages across 2 days
        # as this person's established manner with customers.
        thin = ev.get("sufficient") is False
        lines += [
            f"## {titles.get(key, key)}" + (" ⚠︎thin" if thin else ""),
            "",
        ]
        if thin:
            lines += [
                f"> **Thin evidence**: {ev.get('messages', 0):,} messages across "
                f"{ev.get('distinctDays', 0)} day(s); a habit needs at least "
                f"{ev.get('minSupport')} messages across "
                f"{ev.get('minDistinctDays')} days. The numbers below describe "
                f"what little was seen, not an established manner. **Draft in this "
                f"situation rather than sending**, and fall back to *Unknown or "
                f"sensitive* if the thread feels consequential.",
                "",
            ]
        lines += [
            f"- **Share of their messages**: {share}% ({s['messages']:,} over "
            f"{ev.get('distinctDays', 0)} day(s)).",
            f"- **Length**: {_len_instruction(s, style_t)}.",
            f"- **Questions**: {s['questionPct']}% · hedge:assert {s['hedgeToAssertRatio']}:1.",
        ]
        p = s.get("per1k", {})
        if p.get("enumerate"):
            lines.append(f"- **Structure**: they number their points here "
                         f"({p['enumerate']}/1k) — lead with the ask, then "
                         "one point per line.")
        if p.get("laughter", 0) > laughter_cut:
            lines.append(f"- **Register**: laughter shows up here ({p['laughter']}/1k); "
                         "banter is in range with people the ledger marks A or B.")
        if key == "external":
            lines.append("- **Extra**: no internal status, no numbers, no commitments. "
                         "Everything that reads like a position goes to the owner first.")
        ex = examples.get(key) or []
        if ex:
            lines += ["", "**Their real replies in this situation** — voice reference "
                      "only; the facts in them are stale:", ""]
            for e in ex[:n_examples]:
                ctx = (e.get("context") or "").replace("\n", " / ")[:90]
                lines.append(f"- given {_quote(ctx)} → {_quote(e['reply'])}")
        lines.append("")

    lines += [
        "## Unknown or sensitive",
        "",
        "The fallback: recipient unresolved, or a sensitive role (HR, finance, "
        "legal, exec), or any thread touching a Step-2 risk class in "
        "`decisions.md`.",
        "",
        "- Neutral and complete sentences, single message, no banter, no rough "
        "language, no laughter.",
        "- Facts only. Anything resembling a decision goes to the owner.",
        "- If you cannot identify who you are talking to, you are here.",
        "",
        owner_block("scenes-extra",
                    "Add a situation the corpus missed, or override how one is handled."),
        "",
    ]
    return "\n".join(lines)


def render_people(name: str, people: list[dict], policy: dict,
                  id_label: str = "user id") -> str:
    """Render the recipient table.

    `id_label` is whatever the active message source calls its own stable user
    identifier, so the published skill speaks the platform's vocabulary without
    the composer knowing which platform that is.
    """
    lines = [
        f"# Who {name} is talking to",
        "",
        "Resolve **one** recipient, apply their row, and move on. Never read this "
        "as a table, never compare two people, never mention a band to anyone. "
        "These are observed interaction habits, not statements about how much "
        "someone is liked.",
        "",
        "## Identify by id, not by name",
        "",
        f"Each row carries the recipient's `{id_label}`. **That, not the name, "
        "is who they are.** Display names are not unique in a real directory, and "
        "a 1:1 conversation title is usually an editable remark — so a renamed "
        "thread can show a trusted colleague's name while belonging to someone "
        "else entirely.",
        "",
        "```bash",
        "# the host gives you the peer id for every 1:1 message; resolve with it",
        "python3 scripts/persona.py who --person-id \"<peerId>\"",
        "```",
        "",
        "Matching on the name is acceptable only when you are drafting for the "
        "owner to read. Anything that leaves the machine — every send — must be "
        "keyed on the id, and `persona.py send` enforces that itself.",
        "",
        "## Bands",
        "",
        "| Band | Length & register | Humor | Rough language | May auto-answer |",
        "|---|---|---|---|---|",
    ]
    from .relations import BAND_GUIDANCE
    for band in ("A", "B", "C", "D", "S"):
        g = BAND_GUIDANCE[band]
        lines.append(f"| **{band}** | {g['compression']} | "
                     f"{'yes' if g['humor'] else 'no'} | "
                     f"{'yes' if g['rough'] else 'no'} | {g['autoAnswer']} |")
    lines += ["", "How many messages one reply is also shifts by band — the "
                  "measured figure per band is in `style.md` → *Shift by who they "
                  "are talking to* (`Msgs/reply`, `Multi-msg`). Read it from there "
                  "rather than assuming one message per reply."]

    lines += ["", "## People", "",
              f"| Name | {id_label} | Band | Auto-answer | Notes |",
              "|---|---|---|---|---|"]
    for p in people:
        note = p["note"] or ("sensitive role — always manual" if p["sensitive"] else "")
        if p["title"] and not note:
            note = p["title"]
        if p.get("ambiguousName"):
            flag = "⚠︎ this name appears more than once — match on the id"
            note = f"{flag}; {note}" if note else flag
        pid = p.get("personId") or ""
        lines.append(f"| {p['name']} | `{pid}` | {p['toneBand']} | "
                     f"{p['autoAnswer']} | {note} |")

    auto = policy.get("autoSendCandidates") or []
    lines += [
        "",
        "**Anyone not listed is band S**: unresolved recipient, most conservative "
        "handling, draft only.",
        "",
    ]
    if auto:
        # Candidates may be plain names (older features.json) or {name, personId}.
        labels = [a if isinstance(a, str) else a.get("name", "") for a in auto]
        lines += [
            "## Measured as consistently low-stakes",
            "",
            "History shows fast, low-risk exchanges with: "
            + " · ".join(f"**{n}**" for n in labels if n) + ".",
            "",
            "This is a *measurement*, not authorization. Auto-send stays off until "
            "the owner runs `forge autonomy --scope allowlist --allow <name>`, "
            "which resolves the name to an id — being listed here grants nothing.",
            "",
        ]
    lines += [
        owner_block("people-extra",
                    "Correct a band, mark someone sensitive, or add someone the "
                    "corpus does not cover. Your entries win over measured bands."),
        "",
    ]
    return "\n".join(lines)


def render_limits(name: str, meta: dict, style: dict, mined: dict) -> str:
    o = style["overall"]
    platform = meta.get("platform") or "work chat"
    coverage = style.get("coverage", {})
    locale = coverage.get("locale", {}) or {}
    lines = [
        "# What this persona does not know",
        "",
        "Stated plainly, because a persona that hides its blind spots gets trusted "
        "where it shouldn't be.",
        "",
        "## Where it comes from",
        "",
        f"- {platform} only: {o['messages']:,} messages written by {name}, "
        f"{style['activeDays']} active days, {meta['window']}.",
        f"- {mined['asksAnalyzed']:,} incoming asks analyzed, including unanswered ones.",
        f"- Rules version `{style['rulesVersion']}`, built {meta['builtAt']}.",
    ]
    if locale:
        if locale.get("isNull"):
            lines.append(
                "- **No locale pack matched this corpus.** Structural measurements "
                "only; every word-level layer is absent. See `fidelity.md`.")
        else:
            lines.append(
                f"- Locale pack `{locale.get('id')}` v{locale.get('version')}"
                + (f", which cannot measure: {', '.join(locale['missing'])}."
                   if locale.get("missing") else "."))
    lines += [
        "",
        "## What is missing",
        "",
        "- **Voice calls, meetings, in-person conversation, email, documents.** "
        "Much of how they actually decide happens there and leaves no trace here.",
        "- **Intent behind the words.** The corpus shows what was sent, never why, "
        "and never what they decided not to send.",
        "- **Current facts.** Project status, ownership, dates and numbers in past "
        "messages were true then. Never restate one as current.",
        "- **Anything after the window above.** Recent changes of mind are invisible "
        "until the next `forge refresh`.",
        "",
        "## Consequences for you",
        "",
        "- Never invent a fact to fill a gap. Say what is unknown, in their voice.",
        "- Never claim to know a state you were not told in this conversation.",
        "- A thin table row (⚠︎thin in `decisions.md`) means draft, not guess.",
        "- An **unmeasured** layer is not a measured zero. If `fidelity.md` says a "
        "layer is absent, treat every rule that depends on it as maximally "
        "conservative rather than as evidence of absence.",
        "- Style drifts. If the numbers feel wrong, the fix is `forge refresh`, "
        "not improvising a new persona at runtime.",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# machine-readable rules
# ---------------------------------------------------------------------------

def render_rules(features: dict, pack, rules, cfg: dict,
                 id_label: str = "user id") -> dict:
    """`references/rules.json` — the same policy as `decisions.md`, for a script.

    Why both. `decisions.md` is a table for a reader: it shows measured rates and
    lets a capable agent weigh them. That is exactly what makes it unsafe for a
    weaker one, which reads "other question · 92.2% · answer" and concludes it may
    answer anything. A rate is evidence, not permission, and the distinction is
    carried by prose the model has to be careful with.

    This file removes the need for care. Every decision that can be made
    mechanically — is this a real ask, which kind, which risk classes, what is the
    default action, how long may the reply be — becomes a lookup with one answer.
    The skill's own scripts consume it, so the model never has to re-derive a
    verdict from percentages.

    Compiled from `features.json` plus the active locale pack, adding no
    measurement of its own: a second source of truth for policy would drift from
    the first, and the drift would be invisible. `forge selftest` asserts the two
    agree.
    """
    style = features.get("style", {})
    overall = style.get("overall", {})
    mined = features.get("decisions", {})
    policy = features.get("policy", {})
    meta = features.get("meta", {})
    prop = {k: v for k, v in (mined.get("replyPropensity") or {}).items()
            if not k.startswith("_")}
    risk = mined.get("riskBehavior") or {}
    thresholds = getattr(rules, "thresholds", {}) or {}
    autonomy = cfg.get("autonomy") or {}

    from .relations import BAND_GUIDANCE

    def pat(rx) -> str:
        return rx.pattern if rx is not None else ""

    return {
        "_comment": "MACHINE-READABLE policy, consumed by scripts/persona.py. "
                    "Generated by the forge from the same features.json that "
                    "produced decisions.md — never edit it here, and never treat a "
                    "measured rate in decisions.md as permission that contradicts "
                    "this file. Regenerate with `forge publish`.",
        "rulesVersion": meta.get("rulesVersion", ""),
        "localeId": (meta.get("locale") or {}).get("id", "none"),
        "idLabel": id_label,

        # -- lexical patterns, so a script can classify without the forge -----
        "patterns": {
            "_comment": "From the active locale pack. Empty string means this "
                        "build cannot detect that thing at all — which is NOT the "
                        "same as detecting zero, and every consumer must degrade "
                        "to the most conservative action rather than assume absence.",
            "genuineAsk": pat(pack.genuine_ask),
            "chitchatReply": pat(pack.chitchat),
            "askKinds": {k: rx.pattern for k, rx in pack.ask_kinds},
            "riskTags": {k: rx.pattern for k, rx in pack.risk_tags},
            "replyShapes": {k: rx.pattern for k, rx in pack.reply_shapes.items()},
            "botNames": pat(pack.bot_name),
        },

        # -- the owner's real phrasings, so a script can offer one instead of
        #    inventing a generic equivalent. `clarify` is the one the reply path
        #    consumes: when `facts` finds the subject mentioned but the question
        #    unsettled, the honest move is to ask which thing is meant — in words
        #    this person actually uses. An EMPTY list means the corpus shows no
        #    such habit, and nothing should be improvised in its place.
        "escapeHatches": {
            k: [h["line"] for h in ((mined.get("escapeHatches") or {}).get(k) or [])]
            for k in ("handoff", "defer", "decline", "clarify")
        },

        # -- the decision layer, already resolved to one action per ask kind --
        "policy": {
            "_comment": "byAskKind is authoritative. `draft_gated` and `draft` both "
                        "mean DO NOT SEND; they differ only in why.",
            "byAskKind": {k: d.get("defaultAction", "draft") for k, d in prop.items()},
            "defaultAction": "draft",
            "_defaultActionNote": "Used for any ask kind not listed, including when "
                                  "classification was impossible.",
            "alwaysDraftKinds": list(
                (thresholds.get("propensity") or {}).get("alwaysDraftKinds", [])),
            "neverSettleRiskClasses": sorted(
                t for t, d in risk.items() if d.get("policy") == "never_settle"),
            "undetectableRiskClasses": sorted(
                policy.get("undetectableRiskClasses") or []),
            "thinAskKinds": sorted(
                k for k, d in prop.items() if not d.get("evidenceSufficient")),
            # Style slices too thin to imitate. Published for the same reason as
            # `thinAskKinds`: `check` runs inside the installed skill and cannot
            # import the forge, so "this situation has almost no evidence" has to
            # travel as data. A consumer that resolves a scene or band appearing
            # here must draft rather than send.
            "thinScenes": sorted(
                k for k, s in (style.get("byScene") or {}).items()
                if (s.get("evidence") or {}).get("sufficient") is False),
            "thinToneBands": sorted(
                k for k, s in (style.get("byToneBand") or {}).items()
                if (s.get("evidence") or {}).get("sufficient") is False),
            "baselineAnswerRatePct": policy.get("baselineAnswerRatePct"),
            "staleAfterMinutes": policy.get("staleAfterMinutes"),

            # Several consecutive messages from one person are ONE thing to answer.
            # Published so `brief` folds them the same way on every machine, and so
            # a change to the cutoff invalidates derived output like any other rule.
            "burst": {
                "_comment": "Fold consecutive same-sender incoming messages into one "
                            "unit before classifying. Folding may only make a verdict "
                            "stricter — never looser.",
                "gapSeconds": (thresholds.get("burst") or {}).get("gapSeconds", 300),
                "maxMessages": (thresholds.get("burst") or {}).get("maxMessages", 12),
            },

            # How stale a near-realtime store may be and still back a send. Same
            # reason as `burst` for publishing it: the check runs in the installed
            # skill, which cannot import the forge, and a change here has to
            # invalidate derived output rather than silently taking effect.
            "freshness": {
                "_comment": "Applies only when messages were read from a host "
                            "application's own store (`readFrom: hostStore`). A real "
                            "live read needs no allowance; a source with neither "
                            "degrades visibly instead.",
                "maxLagSeconds": (thresholds.get("freshness") or {}).get(
                    "maxLagSeconds", 150),
                "unknownLagIsStale": (thresholds.get("freshness") or {}).get(
                    "unknownLagIsStale", True),
            },
        },

        # -- what a compliant reply looks like, as numbers not adjectives -----
        "style": {
            "_comment": "Targets, not averages to hit exactly. `maxCodepoints` is a "
                        "hard send limit; the rest are shape.",
            "medianCodepoints": overall.get("medianCodepoints"),
            "p90Codepoints": overall.get("p90Codepoints"),
            "joinedClausePct": overall.get("joinedClausePct"),
            "questionPct": overall.get("questionPct"),
            # Cadence: how many MESSAGES one reply is. Published because a script
            # can act on a number, whereas "reply once" and "always split" are both
            # guesses — the real rate is personal and varies by band.
            "medianBubbles": (overall.get("bubbles") or {}).get("medianBubbles"),
            "multiBubblePct": (overall.get("bubbles") or {}).get("multiBubblePct"),
            "maxCodepoints": autonomy.get("maxCodepoints", 300),
            "neverWrite": list(pack.guide("neverWrite") or []),
            "manufacturedOpeners": pack.guide("manufacturedOpeners") or "",
            "hedgeMarkers": pack.guide("hedgeMarkers") or "",
        },

        # -- per-band permission, so a script can refuse without reading prose -
        "bands": {b: {"autoAnswer": g["autoAnswer"],
                      "humor": g["humor"], "rough": g["rough"],
                      "compression": g["compression"]}
                  for b, g in BAND_GUIDANCE.items()},
        "autonomy": {
            "scope": autonomy.get("scope", "draft_only"),
            "_scopeNote": "Scope widens WHO may receive an auto-sent reply. It "
                          "never widens WHAT may be said: the risk classes above "
                          "apply in every scope.",
        },
        "coverage": {
            "_comment": "False means this build cannot judge that layer. Every "
                        "false here must make the consumer MORE conservative.",
            **(mined.get("coverage") or {}),
        },
    }
