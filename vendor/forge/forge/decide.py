#!/usr/bin/env python3
"""Decision mining — what the owner replies to, and what they never settle alone.

The gap this closes: mimicking vocabulary and per-person tone still leaves the
agent guessing at the first question that actually matters — *should I answer
this at all?* That is a behavior with evidence in the corpus, so it is measured
here rather than left to the loading agent's judgment.

Four measured layers, each with a distinct source of truth:

  reply propensity   answered vs silent, by ask kind × tone band × channel.
                     Silence is only counted where the corpus proves the owner
                     had the chance to answer and didn't (see analyze._make_ask).

  risk behavior      for every risk class (money, approval, scheduling, …):
                     did they answer, and did they SETTLE it or hand it off?
                     A class they historically defer is a class the agent must
                     never settle.

  handoff & defer    the real phrasings they use to redirect ("you'd have to
                     ask X") or
                     postpone. The agent needs their actual escape hatches, not
                     a generic "I'll get back to you".

  autonomy tiers     per-person: how much of their traffic is low-risk, how fast
                     they reply, how consistently. Feeds the auto-send allowlist
                     with evidence instead of a hand-typed name list.

Everything is a measurement plus a policy derived from it by a fixed threshold.
Thresholds live in signals.json → verification, so the policy is reproducible
and the owner can tighten it in one place.
"""

from __future__ import annotations

import re
import sqlite3
from collections import defaultdict

from . import common as C
from .analyze import Rules


# Reply-shape detection. The four shapes are the decision layer's core
# vocabulary, and every one of them is language-specific, so the patterns live in
# the locale pack (`replyShapes`) rather than here. This module owns only the
# ORDER they are tested in, which is a policy statement and the same in every
# language: settling is what needs a gate, so a reply that both defers and
# settles counts as settling.
#: Most consequential first. `clarify` is LAST on purpose: narrowing a question
#: down while also agreeing to something is an agreement, and settling is what
#: needs a gate. Placing it last also means it can only ever pick up replies no
#: other shape claimed, so adding it cannot reclassify an existing settle.
_SHAPE_ORDER = ("decline", "settle", "handoff", "defer", "clarify")


def _shape(reply: str, rules: Rules) -> str:
    """One label per reply, most-consequential first.

    With no locale pack there is no way to tell a settle from a handoff, so every
    answered ask is simply `answer`. That is the honest outcome: it leaves the
    reply-rate layer fully measured while the risk policy falls back to
    never-settle everywhere, which is where an unknown language should land.
    """
    if not reply:
        return "silent"
    shapes = rules.pack.reply_shapes
    if not shapes:
        return "answer"
    for name in _SHAPE_ORDER:
        rx = shapes.get(name)
        if rx and rx.search(reply):
            return name
    return "answer"


def _quotable(reply: str, shape: str, rules: Rules) -> bool:
    """Is this reply a clean, reusable example of its escape hatch?

    Three tests, each removing a different kind of unusable line: multi-line text
    is a forwarded log rather than a sentence; a long line carries
    situation-specific facts that make the shape unreusable; and a marker buried
    mid-sentence means the sentence's actual move was something else.
    """
    line = (reply or "").strip()
    max_len = rules.threshold("escapeHatches", "quoteMaxLength", 40)
    if not line or "\n" in line or len(line) > max_len:
        return False
    if C.is_pasted_output(line) or C.is_placeholder(line):
        return False
    rx = rules.pack.reply_shapes.get(shape)
    if not rx:
        return False
    m = rx.search(line)
    if not m:
        return False
    if m.start() > rules.threshold("escapeHatches", "markerMustStartWithin", 3):
        return False        # the marker must open the sentence
    if shape == "defer":
        subject = rules.pack.reply_shapes.get("deferSubject")
        if subject and not subject.search(line):
            return False    # a bare time word is not a postponement
    return True


def mine(conn: sqlite3.Connection, rules: Rules) -> dict:
    asks = conn.execute("SELECT * FROM asks").fetchall()
    v = rules.verification

    #: Every bucket carries FOUR tallies of the same asks, and keeping them apart
    #: is what makes the decision layer both current and honest:
    #:
    #: · `n` / per-shape `n_*`  — raw counts. The evidence bar (`minSupport`)
    #:   reads these, so old-but-real evidence cannot vanish from it.
    #: · `total` / per-shape    — recency-weighted. The published rates and
    #:                            therefore `defaultAction` read these, so an ask
    #:                            kind the owner stopped handling stops reading as
    #:                            one they answer.
    #: · `recent*`              — plain, unweighted counts over the last
    #:                            `recency.recentWindowDays`. Published NEXT TO the
    #:                            full-window rate rather than replacing it, so a
    #:                            reader sees the trend instead of an average that
    #:                            hides it.
    by_kind: dict[str, dict] = defaultdict(lambda: defaultdict(float))
    by_kind_tone: dict[tuple[str, str], dict] = defaultdict(lambda: defaultdict(float))
    by_risk: dict[str, dict] = defaultdict(lambda: defaultdict(float))
    by_channel: dict[str, dict] = defaultdict(lambda: defaultdict(float))
    by_person: dict[str, dict] = defaultdict(lambda: defaultdict(float))
    person_latency: dict[str, list[tuple[float, float]]] = defaultdict(list)
    person_names: dict[str, str] = {}
    handoff_lines: list[tuple[str, float]] = []
    defer_lines: list[tuple[str, float]] = []
    decline_lines: list[tuple[str, float]] = []
    clarify_lines: list[tuple[str, float]] = []

    for a in asks:
        kind = a["ask_kind"]
        tone = a["tone_band"] or "unresolved"
        channel = "direct" if a["single_chat"] else "group"
        shape = _shape(a["reply_text"], rules) if a["answered"] else "silent"
        risks = [t for t in (a["risk_tags"] or "").split(",") if t]
        day = (a["occurred_at"] or "")[:10]
        weight = rules.recency.weight(day)
        recent = rules.recency.is_recent(day)
        answered = int(a["answered"])
        # Keyed on the sender's id, not their name: two colleagues sharing a
        # display name would otherwise merge into one fabricated candidate whose
        # combined stats belong to neither of them.
        person = a["asker_id"] or f"name:{a['asker_name'] or 'unknown'}"
        person_names[person] = a["asker_name"] or ""

        for bucket, key in ((by_kind, kind), (by_channel, channel),
                            (by_person, person)):
            slot = bucket[key]
            slot["total"] += weight
            slot[shape] += weight
            slot["answered"] += answered * weight
            slot["n"] += 1
            slot[f"n_{shape}"] += 1
            slot["n_answered"] += answered
            if recent:
                slot["recentTotal"] += 1
                slot["recentAnswered"] += answered
        for slot in (by_kind_tone[(kind, tone)],):
            slot["total"] += weight
            slot["answered"] += answered * weight
            slot["n"] += 1

        for tag in risks or ["_none"]:
            slot = by_risk[tag]
            slot["total"] += weight
            slot[shape] += weight
            slot["answered"] += answered * weight
            slot["n"] += 1
            slot[f"n_{shape}"] += 1
            slot["n_answered"] += answered
            if recent:
                slot["recentTotal"] += 1
                slot["recentAnswered"] += answered

        if a["answered"] and a["latency_seconds"] >= 0:
            person_latency[person].append((a["latency_seconds"], weight))

        if a["answered"] and a["reply_text"]:
            reply = a["reply_text"]
            if (shape in ("handoff", "defer", "decline", "clarify")
                    and _quotable(reply, shape, rules)):
                {"handoff": handoff_lines, "defer": defer_lines,
                 "decline": decline_lines,
                 "clarify": clarify_lines}[shape].append((reply, weight))

    v_pack = rules.pack
    return {
        "rulesVersion": rules.version,
        "asksAnalyzed": len(asks),
        "recency": rules.recency.describe(),
        "replyPropensity": _propensity(by_kind, v, rules),
        "byToneBand": _tone_table(by_kind_tone),
        "byChannel": _table(by_channel),
        "riskBehavior": _risk_policy(by_risk, v, rules),
        "escapeHatches": {
            "handoff": _top_lines(handoff_lines, rules),
            "defer": _top_lines(defer_lines, rules),
            "decline": _top_lines(decline_lines, rules, prefer_longer=True),
            # How they ask WHICH THING is meant, before answering. Mined so the
            # persona can narrow a question down in the owner's own words instead
            # of inventing a generic "could you clarify?" — and reported empty
            # when the corpus shows no such habit, because a fabricated one would
            # make the agent chattier than the person it imitates.
            "clarify": _top_lines(clarify_lines, rules),
        },
        "autonomyCandidates": _autonomy(by_person, person_latency, person_names, v, rules),
        "replyWindow": reply_window(conn, rules),
        "coverage": {
            "askKinds": v_pack.has("askKinds"),
            "riskTags": v_pack.has("riskTags"),
            "replyShapes": v_pack.has("replyShapes"),
            "responseGate": v_pack.has("responseGate"),
        },
        "policy": None,   # filled by derive_policy() once tone bands are known
    }


#: Shapes that appear as a share of a bucket. Named once because both the
#: weighted and the raw pass over a bucket have to agree on the set.
_SHARE_SHAPES = ("answer", "settle", "handoff", "defer", "decline", "silent")


def _rate_block(d: dict) -> dict:
    """One bucket rendered as rates.

    Three groups of numbers, and the difference between them is the whole point
    of the v6 decay work:

    - `answerRatePct` / `shapePct` are **recency-weighted**. These drive policy,
      so a habit the owner has moved on from stops driving it.
    - `asks` (and `evidenceAsks` in the propensity table) is the **raw count**.
      That is what the `minSupport` evidence bar reads — weighting it would report
      "not enough evidence" for behavior that is real but old, which is a
      different statement and belongs to `fidelity.md`.
    - `recentAnswerRatePct` is a **plain rate over the recent window only**, and
      `answerRateDriftPoints` is the gap between it and the full-window rate.
      Published side by side rather than folded together: one number cannot say
      "they used to answer these and no longer do", and that sentence is the one
      an agent needs before replying on someone's behalf.

    `total` stays the weighted mass and keeps its name for compatibility with
    every existing consumer; `weightedTotal` is its explicit alias so a reader of
    the JSON does not have to infer which kind of total they are holding.
    """
    total = d.get("total", 0.0)
    raw = int(d.get("n", 0))
    recent_total = int(d.get("recentTotal", 0))
    recent_answered = int(d.get("recentAnswered", 0))
    full_rate = C.pct(d.get("answered", 0), total)
    block = {
        "total": round(total, 2),
        "weightedTotal": round(total, 2),
        "asks": raw,
        "answerRatePct": full_rate,
        "shapePct": {k: C.pct(v, total) for k, v in sorted(
            ((k, d.get(k, 0.0)) for k in _SHARE_SHAPES),
            key=lambda x: -x[1]) if v},
    }
    if recent_total:
        recent_rate = C.pct(recent_answered, recent_total)
        block["recentAsks"] = recent_total
        block["recentAnswerRatePct"] = recent_rate
        block["answerRateDriftPoints"] = round(recent_rate - full_rate, 1)
    return block


def _table(bucket: dict) -> dict:
    return {k: _rate_block(v) for k, v in
            sorted(bucket.items(), key=lambda x: -x[1]["total"])}


def _tone_table(bucket: dict) -> dict:
    out: dict[str, dict] = {}
    for (kind, tone), d in bucket.items():
        out.setdefault(tone, {})[kind] = {
            "total": round(d["total"], 2), "asks": int(d.get("n", 0)),
            "answerRatePct": C.pct(d["answered"], d["total"])}
    return {t: dict(sorted(v.items(), key=lambda x: -x[1]["total"]))
            for t, v in sorted(out.items())}


def _propensity(by_kind: dict, v: dict, rules: Rules) -> dict:
    """Per ask kind: measured reply rate + the resulting default action.

    Rates are judged **relative to this person's own baseline**, not against
    absolute cutoffs. Someone who answers most things and markedly fewer
    disagreements is telling you something about disagreements; a fixed "below
    35% means often silent" rule would see both as "answers everything" and
    publish a decision layer that never says no.

    When the locale pack cannot classify asks, every ask lands in one bucket at
    exactly the baseline. `often_silent` is then meaningless — there is nothing to
    be low relative to — so the whole table degrades to `draft`, which is the
    correct answer when you cannot tell what is being asked.

    ## ★ Rates are decayed; the evidence bar is not

    `rate` and `baseline` come from the recency-weighted tallies, so an ask kind
    the owner handled all spring and dropped in June no longer reads as one they
    answer — which is the whole point, because `defaultAction: answer` is an agent
    replying on their behalf.

    But `enough` reads the RAW count. Weighting it too would mean a real,
    well-evidenced-but-old pattern silently falls under `minSupport` and gets
    published as `draft` with the reason "too little evidence" — which is false:
    there is plenty of evidence, it is simply old. Those two states need different
    sentences, and conflating them is exactly what `fidelity.md` exists to stop.

    ## ★ A stale kind is demoted, never promoted, by drift

    When the recent window disagrees with the full window by more than
    `recency.driftPoints`, a kind that would have been `answer`/`settle_ok`
    becomes `draft` — an agent should not answer unattended on something whose
    behavior is visibly in flux. The reverse never fires: a kind the owner has
    *started* answering more does not get auto-promoted to `answer` on the
    strength of a short window, because promoting is the direction that can send a
    wrong message.
    """
    t = rules.thresholds.get("propensity", {})
    can_classify = rules.pack.has("askKinds")
    drift_points = rules.recency.drift_points

    totals = sum(d["total"] for d in by_kind.values())
    answered = sum(d.get("answered", 0) for d in by_kind.values())
    baseline = (answered / totals * 100) if totals else 0.0
    raw_totals = sum(int(d.get("n", 0)) for d in by_kind.values())

    out: dict[str, dict] = {}
    for kind, d in sorted(by_kind.items(), key=lambda x: -x[1]["total"]):
        block = _rate_block(d)
        rate = block["answerRatePct"]
        settle_share = block["shapePct"].get("settle", 0)
        handoff_share = block["shapePct"].get("handoff", 0)
        # ★ RAW count, not the weighted mass — see the docstring.
        enough = int(d.get("n", 0)) >= v["minSupport"]
        # Relative to baseline: "notably lower" = at least this many points
        # below, or under this fraction of it, whichever is the looser test.
        notably_low = (rate <= baseline - t.get("notablyLowPoints", 15)
                       or rate < baseline * t.get("notablyLowRatio", 0.67))

        if not can_classify:
            default = "draft"           # cannot tell what is being asked
        elif not enough:
            default = "draft"           # too little evidence to lean on
        elif notably_low:
            default = "often_silent"    # they answer these markedly less often
        elif handoff_share >= t.get("handoffSharePct", 20):
            default = "handoff"
        elif settle_share >= t.get("settleSharePct", 25):
            default = "settle_ok"
        else:
            default = "answer"

        # Behavior visibly in flux → hand it back to the owner. One-directional:
        # only ever demotes to `draft`, never promotes on a short window.
        drift = block.get("answerRateDriftPoints")
        stale = (drift is not None and drift_points > 0
                 and abs(drift) >= drift_points)
        if stale and default in ("answer", "settle_ok"):
            default = "draft"

        # Some kinds ARE the risk gate: being asked to decide, approve, or commit
        # is never the persona's call, no matter how reliably the owner answers
        # them in person. Their high reply rate says "they engage", not "an agent
        # may answer for them" — so the published default is always draft.
        if kind in t.get("alwaysDraftKinds", []):
            default = "draft_gated"

        out[kind] = {**block, "evidenceSufficient": enough,
                     "vsBaselinePct": round(rate - baseline, 1),
                     "recentlyDrifted": stale,
                     "defaultAction": default}
    out["_baseline"] = {"answerRatePct": round(baseline, 1),
                        "asks": raw_totals,
                        "weightedAsks": round(totals, 2),
                        "kindsClassified": can_classify}
    return out


def _risk_policy(by_risk: dict, v: dict, rules: Rules) -> dict:
    """Per risk class: did the owner settle these themselves, or route them away?

    A class is `never_settle` unless the corpus shows them settling it often
    enough to be a pattern. The default is restrictive on purpose: being wrong
    about a commitment costs more than a missed reply.

    `reason` distinguishes the two ways a class becomes never-settle — measured
    deferral versus an absent lexicon — because they warrant different sentences
    in the published skill even though the rule is identical. Telling an agent
    "they historically route money questions away" when the truth is "this build
    cannot detect money questions at all" is exactly the kind of confident
    fabrication the fidelity report exists to prevent.

    ## ★ Decay may only TIGHTEN a risk policy, never loosen one

    The settle share is read from both the weighted and the raw tallies, and a
    class is `sometimes_settles` only if BOTH clear the bar. Decay must not become
    a path to permission: without this, a class the owner settled a handful of
    times last week and routed away a hundred times last quarter would have its
    weighted settle share cross 40% and flip to `sometimes_settles` — decay would
    have manufactured an authorization out of a quiet week. The asymmetry matches
    the rule this module already states: being wrong about a commitment costs more
    than a missed reply, so evidence is required in both lenses to relax a gate and
    in either lens to hold it.
    """
    t = rules.thresholds.get("risk", {})
    detectable = rules.pack.has("riskTags")
    shapes_known = rules.pack.has("replyShapes")
    settles_at = t.get("sometimesSettlesPct", 40)

    out: dict[str, dict] = {}
    for tag, d in sorted(by_risk.items(), key=lambda x: -x[1]["total"]):
        if tag == "_none":
            continue
        block = _rate_block(d)
        settle = block["shapePct"].get("settle", 0)
        raw = int(d.get("n", 0))
        # The same share computed on raw counts. Both must clear `settles_at`
        # before a gate is relaxed — see the docstring on the asymmetry.
        raw_settle = C.pct(int(d.get("n_settle", 0)), raw) if raw else 0.0
        # ★ RAW count for the evidence bar, exactly as in `_propensity`.
        enough = raw >= v["minSupport"]
        if not shapes_known:
            policy, reason = "never_settle", "no reply-shape lexicon for this locale"
        elif not enough:
            policy, reason = "never_settle", "too few examples to establish a pattern"
        elif settle >= settles_at and raw_settle >= settles_at:
            policy, reason = "sometimes_settles", "observed settling these themselves"
        elif settle >= settles_at:
            # Recent behavior alone says they settle these; the full history does
            # not. Hold the gate and say which lens disagreed, so the owner can
            # widen it deliberately rather than have decay do it for them.
            policy, reason = ("never_settle",
                              "recently settled these, but not across the full "
                              "history — gate held")
        else:
            policy, reason = "never_settle", "observed routing these away"
        out[tag] = {**block, "evidenceSufficient": enough,
                    "settleSharePctRaw": raw_settle,
                    "policy": policy, "reason": reason}

    if not detectable:
        # No risk lexicon means no class was ever tagged, so the table above is
        # empty. Publish every class the composer knows about as never-settle,
        # explicitly labelled undetectable, rather than an empty risk section
        # that would read as "no risks apply here".
        for tag in _ALL_RISK_TAGS:
            out.setdefault(tag, {
                "total": 0, "asks": 0, "answerRatePct": 0.0, "shapePct": {},
                "evidenceSufficient": False, "policy": "never_settle",
                "reason": "this locale pack cannot detect this class — "
                          "treated as sensitive by default"})
    return out


#: The risk classes the published skill always discusses. Kept here (not in a
#: pack) because they are a policy taxonomy, not vocabulary: every pack must map
#: onto these keys, and a build with no pack must still publish the full list as
#: never-settle rather than implying no risks exist.
_ALL_RISK_TAGS = ("commitment", "approval", "money", "scheduling", "personnel",
                  "external_position", "org_decision", "destructive")


def _top_lines(lines, rules: Rules, prefer_longer: bool = False) -> list[dict]:
    """Most-repeated real phrasings, deduped by normalized form.

    `prefer_longer` is for declines: in most corpora the single most frequent
    decline is a bare "no", which teaches nothing, while a repeated line that
    gives the reason alongside the refusal shows the pattern that actually
    matters. So rank by repetition *and* informativeness there, capping the
    weight of repetition so frequency alone cannot bury the useful line.

    Ranking is by recency-weighted repetition: an escape hatch is a phrase the
    persona will literally say, so a turn of phrase the owner has stopped using
    should not stay at the top of the list. `count` remains the raw repetition —
    that is the evidence for the line being a habit at all, and it is what a
    reader checks the ordering against.

    Accepts either `(line, weight)` pairs or bare strings. Bare strings mean "no
    dating available for these", which is a real state (a caller testing the
    shape logic, or a source with no usable timestamps) and must degrade to plain
    repetition rather than crash — weight 1.0 everywhere reproduces exactly the
    pre-decay ranking.
    """
    t = rules.thresholds.get("escapeHatches", {})
    k = t.get("maxPerKind", 12)
    counts: dict[str, int] = defaultdict(int)
    mass: dict[str, float] = defaultdict(float)
    for entry in lines:
        line, weight = entry if isinstance(entry, tuple) else (entry, 1.0)
        key = line.strip()
        counts[key] += 1
        mass[key] += weight
    if prefer_longer:
        cap = t.get("declineRepetitionCap", 3)
        informative = t.get("declineInformativeLength", 6)
        ranked = sorted(
            counts.items(),
            key=lambda x: (-(min(mass[x[0]], cap)
                             + (2 if len(x[0]) >= informative else 0)),
                           -len(x[0])))
    else:
        ranked = sorted(counts.items(), key=lambda x: (-mass[x[0]], len(x[0])))
    return [{"line": line, "count": n, "recentWeight": round(mass[line], 2)}
            for line, n in ranked[:k]]


def _autonomy(by_person: dict, latency: dict, names: dict, v: dict,
              rules: Rules) -> list[dict]:
    """People whose traffic is consistently low-stakes and quickly answered.

    Keyed on the platform's own stable user id, so same-named colleagues stay
    distinct. Presented as *candidates* with their numbers; turning one on is
    still an explicit owner action (`forge autonomy --allow <name>`), which
    resolves the name to an id with a human present. The forge measures; the
    owner authorizes.

    ## ★ Both lenses must agree before someone is nominated

    Same asymmetry as `_risk_policy`, and for a stronger reason: this list feeds
    the AUTO-SEND allowlist. Every bar is checked against the weighted numbers
    *and* against the raw ones, and `minSupport` reads the raw count. Weighted
    numbers alone would let a colleague the owner answered promptly for two weeks
    and ignored for five months become a candidate — decay turning a quiet period
    into permission to send unattended. Raw numbers alone would keep nominating
    someone the owner stopped dealing with entirely.
    """
    t = rules.thresholds.get("autonomy", {})
    min_rate = t.get("minAnswerRatePct", 70)
    max_latency = t.get("maxMedianLatencySeconds", 1800)
    max_settle = t.get("maxSettleSharePct", 50)
    # Without reply-shape detection there is no way to know how much of someone's
    # traffic the owner settles outright, so nobody can clear the bar. Refusing to
    # nominate is the only safe answer: an auto-send candidate list built without
    # the risk half of the evidence is worse than no list.
    shapes_known = rules.pack.has("replyShapes")

    out = []
    for person, d in by_person.items():
        raw = int(d.get("n", 0))
        # ★ RAW count for the evidence bar, as everywhere else in this module.
        if raw < v["minSupport"] or not names.get(person):
            continue
        block = _rate_block(d)
        pairs = latency.get(person, [])
        # Weighted median latency: how fast they answer this person NOW.
        median = round(_weighted_median(pairs), 1) if pairs else None
        raw_lat = sorted(value for value, _ in pairs)
        raw_median = (round(raw_lat[len(raw_lat) // 2], 1) if raw_lat else None)
        risky = block["shapePct"].get("settle", 0)
        raw_rate = C.pct(int(d.get("n_answered", 0)), raw)
        raw_settle = C.pct(int(d.get("n_settle", 0)), raw)
        eligible = (shapes_known
                    # answer rate: high in both lenses
                    and block["answerRatePct"] >= min_rate
                    and raw_rate >= min_rate
                    # latency: fast in both lenses
                    and median is not None and median <= max_latency
                    and raw_median is not None and raw_median <= max_latency
                    # settle share: low in both lenses
                    and risky < max_settle
                    and raw_settle < max_settle)
        out.append({
            "person": names.get(person, ""), "personId": person, "asks": raw,
            "weightedAsks": round(d.get("total", 0.0), 2),
            "answerRatePct": block["answerRatePct"],
            "answerRatePctRaw": raw_rate,
            "medianLatencySeconds": median,
            "medianLatencySecondsRaw": raw_median,
            "shapePct": block["shapePct"],
            "autoSendCandidate": eligible,
        })
    # Ordered by weighted volume so the people they deal with NOW come first, but
    # the displayed `asks` stays raw so the number is checkable.
    out.sort(key=lambda x: -x["weightedAsks"])
    return out[:t.get("maxCandidates", 30)]


def _weighted_median(pairs: list[tuple[float, float]]) -> float:
    """Median of `(value, weight)` pairs. Mirrors `analyze._weighted_percentile`
    at q=0.5; kept local so `decide` does not import a private helper."""
    if not pairs:
        return 0.0
    ordered = sorted(pairs)
    total = sum(w for _, w in ordered)
    if total <= 0:
        return ordered[len(ordered) // 2][0]
    target = total / 2
    seen = 0.0
    for value, weight in ordered:
        seen += weight
        if seen >= target:
            return value
    return ordered[-1][0]


def reply_window(conn: sqlite3.Connection, rules: Rules) -> dict:
    """How long after an incoming ask does this person still bother replying?

    Feeds the pre-send staleness cutoff. Hardcoding it is wrong in a way that is
    easy to miss: reply latency in chat is heavily front-loaded, and *where* it
    falls off differs enough between people that any fixed default keeps items
    queued for hours after that particular person had, in practice, already
    decided not to answer — or retires them while a slower correspondent was
    still going to reply.

    So the cutoff is derived from the owner's own answered-ask latencies: a high
    percentile with headroom, floored so a very fast replier does not get an
    aggressive queue, and capped so a slow one does not get an unbounded one.
    Every constant is in `signals.json → thresholds.replyWindow`.
    """
    t = rules.thresholds.get("replyWindow", {})
    lat = [r[0] / 60.0 for r in conn.execute(
        "SELECT latency_seconds FROM asks "
        "WHERE answered=1 AND latency_seconds >= 0 ORDER BY latency_seconds")]
    if not lat:
        return {"samples": 0,
                "staleAfterMinutes": t.get("noDataMinutes", 240),
                "basis": "no answered asks yet — configured default"}

    def pct(p: float) -> float:
        return lat[min(len(lat) - 1, int(len(lat) * p))]

    basis_p = t.get("basisPercentile", 0.99)
    high, longest = pct(basis_p), lat[-1]
    step = t.get("roundToMinutes", 15)
    raw = max(high * t.get("percentileMultiplier", 2),
              longest * t.get("longestMultiplier", 1.1))
    cutoff = max(t.get("minMinutes", 30),
                 min(t.get("maxMinutes", 720), int(round(raw / step)) * step))
    return {
        "samples": len(lat),
        "medianMinutes": round(pct(0.5), 1),
        "p90Minutes": round(pct(0.9), 1),
        "p99Minutes": round(high, 1),
        "longestReplyMinutes": round(longest, 1),
        "staleAfterMinutes": cutoff,
        "basis": f"p{int(basis_p * 100)} {high:.0f}min, longest ever {longest:.0f}min",
    }


def derive_policy(mined: dict, style: dict) -> dict:
    """Condense the measurements into the compact policy the skill publishes.

    This is the object compose.py renders into `decisions.md`; keeping it as data
    means the skill's decision layer is rebuilt from evidence on every refresh
    rather than hand-maintained.
    """
    prop = {k: d for k, d in mined["replyPropensity"].items() if not k.startswith("_")}
    risk = mined["riskBehavior"]

    never_settle = sorted(t for t, d in risk.items() if d["policy"] == "never_settle")
    gated = sorted(t for t, d in risk.items() if d["policy"] == "sometimes_settles")

    answer_kinds = sorted(k for k, d in prop.items()
                          if d["defaultAction"] in ("answer", "settle_ok"))
    handoff_kinds = sorted(k for k, d in prop.items() if d["defaultAction"] == "handoff")
    quiet_kinds = sorted(k for k, d in prop.items() if d["defaultAction"] == "often_silent")
    draft_kinds = sorted(k for k, d in prop.items()
                         if d["defaultAction"] in ("draft", "draft_gated"))
    thin_kinds = sorted(k for k, d in prop.items() if not d["evidenceSufficient"])
    # Kinds whose recent behavior disagrees with the full history by more than
    # `recency.driftPoints`. Published as its own list rather than folded into
    # `draftOnly`: a reader (and the rubric) needs to be able to tell "this was
    # never theirs to answer" from "this changed recently", because only the second
    # one is a prompt to go look at what happened.
    drifted = sorted(
        (
            {
                "askKind": k,
                "fullWindowPct": d.get("answerRatePct"),
                "recentPct": d.get("recentAnswerRatePct"),
                "driftPoints": d.get("answerRateDriftPoints"),
            }
            for k, d in prop.items() if d.get("recentlyDrifted")
        ),
        key=lambda x: -abs(x["driftPoints"] or 0))

    overall = style.get("overall", {})
    return {
        "answerDirectly": answer_kinds,
        "handoffPreferred": handoff_kinds,
        "oftenNoReply": quiet_kinds,
        "draftOnly": draft_kinds,
        "insufficientEvidence": thin_kinds,
        "recentlyDrifted": drifted,
        "recency": mined.get("recency", {}),
        "neverSettleAlone": never_settle,
        "gatedButObserved": gated,
        "undetectableRiskClasses": sorted(
            t for t, d in risk.items()
            if "cannot detect" in (d.get("reason") or "")),
        "coverage": mined.get("coverage", {}),
        "baselineAnswerRatePct": mined["replyPropensity"].get(
            "_baseline", {}).get("answerRatePct"),
        "typicalReplyCodepoints": overall.get("medianCodepoints"),
        "hedgeToAssertRatio": overall.get("hedgeToAssertRatio"),
        "staleAfterMinutes": mined.get("replyWindow", {}).get("staleAfterMinutes"),
        "autoSendCandidates": [{"name": p["person"], "personId": p["personId"]}
                               for p in mined["autonomyCandidates"]
                               if p["autoSendCandidate"]],
    }
