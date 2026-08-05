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

    by_kind: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    by_kind_tone: dict[tuple[str, str], dict] = defaultdict(lambda: defaultdict(int))
    by_risk: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    by_channel: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    by_person: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    person_latency: dict[str, list[float]] = defaultdict(list)
    person_names: dict[str, str] = {}
    handoff_lines: list[str] = []
    defer_lines: list[str] = []
    decline_lines: list[str] = []
    clarify_lines: list[str] = []

    for a in asks:
        kind = a["ask_kind"]
        tone = a["tone_band"] or "unresolved"
        channel = "direct" if a["single_chat"] else "group"
        shape = _shape(a["reply_text"], rules) if a["answered"] else "silent"
        risks = [t for t in (a["risk_tags"] or "").split(",") if t]
        # Keyed on the sender's id, not their name: two colleagues sharing a
        # display name would otherwise merge into one fabricated candidate whose
        # combined stats belong to neither of them.
        person = a["asker_id"] or f"name:{a['asker_name'] or 'unknown'}"
        person_names[person] = a["asker_name"] or ""

        for bucket, key in ((by_kind, kind), (by_channel, channel),
                            (by_person, person)):
            bucket[key]["total"] += 1
            bucket[key][shape] += 1
            bucket[key]["answered"] += int(a["answered"])
        by_kind_tone[(kind, tone)]["total"] += 1
        by_kind_tone[(kind, tone)]["answered"] += int(a["answered"])

        for tag in risks or ["_none"]:
            by_risk[tag]["total"] += 1
            by_risk[tag][shape] += 1
            by_risk[tag]["answered"] += int(a["answered"])

        if a["answered"] and a["latency_seconds"] >= 0:
            person_latency[person].append(a["latency_seconds"])

        if a["answered"] and a["reply_text"]:
            reply = a["reply_text"]
            if (shape in ("handoff", "defer", "decline", "clarify")
                    and _quotable(reply, shape, rules)):
                {"handoff": handoff_lines, "defer": defer_lines,
                 "decline": decline_lines,
                 "clarify": clarify_lines}[shape].append(reply)

    v_pack = rules.pack
    return {
        "rulesVersion": rules.version,
        "asksAnalyzed": len(asks),
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


def _rate_block(d: dict) -> dict:
    total = d["total"]
    return {
        "total": total,
        "answerRatePct": C.pct(d.get("answered", 0), total),
        "shapePct": {k: C.pct(v, total) for k, v in sorted(
            ((k, v) for k, v in d.items()
             if k in ("answer", "settle", "handoff", "defer", "decline", "silent")),
            key=lambda x: -x[1]) if v},
    }


def _table(bucket: dict) -> dict:
    return {k: _rate_block(v) for k, v in
            sorted(bucket.items(), key=lambda x: -x[1]["total"])}


def _tone_table(bucket: dict) -> dict:
    out: dict[str, dict] = {}
    for (kind, tone), d in bucket.items():
        out.setdefault(tone, {})[kind] = {
            "total": d["total"], "answerRatePct": C.pct(d["answered"], d["total"])}
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
    """
    t = rules.thresholds.get("propensity", {})
    can_classify = rules.pack.has("askKinds")

    totals = sum(d["total"] for d in by_kind.values())
    answered = sum(d.get("answered", 0) for d in by_kind.values())
    baseline = (answered / totals * 100) if totals else 0.0

    out: dict[str, dict] = {}
    for kind, d in sorted(by_kind.items(), key=lambda x: -x[1]["total"]):
        block = _rate_block(d)
        rate = block["answerRatePct"]
        settle_share = block["shapePct"].get("settle", 0)
        handoff_share = block["shapePct"].get("handoff", 0)
        enough = d["total"] >= v["minSupport"]
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

        # Some kinds ARE the risk gate: being asked to decide, approve, or commit
        # is never the persona's call, no matter how reliably the owner answers
        # them in person. Their high reply rate says "they engage", not "an agent
        # may answer for them" — so the published default is always draft.
        if kind in t.get("alwaysDraftKinds", []):
            default = "draft_gated"

        out[kind] = {**block, "evidenceSufficient": enough,
                     "vsBaselinePct": round(rate - baseline, 1),
                     "defaultAction": default}
    out["_baseline"] = {"answerRatePct": round(baseline, 1), "asks": totals,
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
    """
    t = rules.thresholds.get("risk", {})
    detectable = rules.pack.has("riskTags")
    shapes_known = rules.pack.has("replyShapes")

    out: dict[str, dict] = {}
    for tag, d in sorted(by_risk.items(), key=lambda x: -x[1]["total"]):
        if tag == "_none":
            continue
        block = _rate_block(d)
        settle = block["shapePct"].get("settle", 0)
        enough = d["total"] >= v["minSupport"]
        if not shapes_known:
            policy, reason = "never_settle", "no reply-shape lexicon for this locale"
        elif not enough:
            policy, reason = "never_settle", "too few examples to establish a pattern"
        elif settle >= t.get("sometimesSettlesPct", 40):
            policy, reason = "sometimes_settles", "observed settling these themselves"
        else:
            policy, reason = "never_settle", "observed routing these away"
        out[tag] = {**block, "evidenceSufficient": enough,
                    "policy": policy, "reason": reason}

    if not detectable:
        # No risk lexicon means no class was ever tagged, so the table above is
        # empty. Publish every class the composer knows about as never-settle,
        # explicitly labelled undetectable, rather than an empty risk section
        # that would read as "no risks apply here".
        for tag in _ALL_RISK_TAGS:
            out.setdefault(tag, {
                "total": 0, "answerRatePct": 0.0, "shapePct": {},
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


def _top_lines(lines: list[str], rules: Rules, prefer_longer: bool = False) -> list[dict]:
    """Most-repeated real phrasings, deduped by normalized form.

    `prefer_longer` is for declines: in most corpora the single most frequent
    decline is a bare "no", which teaches nothing, while a repeated line that
    gives the reason alongside the refusal shows the pattern that actually
    matters. So rank by repetition *and* informativeness there, capping the
    weight of repetition so frequency alone cannot bury the useful line.
    """
    t = rules.thresholds.get("escapeHatches", {})
    k = t.get("maxPerKind", 12)
    counts: dict[str, int] = defaultdict(int)
    for line in lines:
        counts[line.strip()] += 1
    if prefer_longer:
        cap = t.get("declineRepetitionCap", 3)
        informative = t.get("declineInformativeLength", 6)
        ranked = sorted(counts.items(),
                        key=lambda x: (-(min(x[1], cap) + (2 if len(x[0]) >= informative else 0)),
                                       -len(x[0])))
    else:
        ranked = sorted(counts.items(), key=lambda x: (-x[1], len(x[0])))
    return [{"line": line, "count": n} for line, n in ranked[:k]]


def _autonomy(by_person: dict, latency: dict, names: dict, v: dict,
              rules: Rules) -> list[dict]:
    """People whose traffic is consistently low-stakes and quickly answered.

    Keyed on the platform's own stable user id, so same-named colleagues stay
    distinct. Presented as *candidates* with their numbers; turning one on is
    still an explicit owner action (`forge autonomy --allow <name>`), which
    resolves the name to an id with a human present. The forge measures; the
    owner authorizes.
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
        total = d["total"]
        if total < v["minSupport"] or not names.get(person):
            continue
        block = _rate_block(d)
        lat = sorted(latency.get(person, []))
        median = round(lat[len(lat) // 2], 1) if lat else None
        risky = block["shapePct"].get("settle", 0)
        eligible = (shapes_known
                    and block["answerRatePct"] >= min_rate
                    and median is not None and median <= max_latency
                    and risky < max_settle)
        out.append({
            "person": names.get(person, ""), "personId": person, "asks": total,
            "answerRatePct": block["answerRatePct"],
            "medianLatencySeconds": median,
            "shapePct": block["shapePct"],
            "autoSendCandidate": eligible,
        })
    out.sort(key=lambda x: -x["asks"])
    return out[:t.get("maxCandidates", 30)]


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

    overall = style.get("overall", {})
    return {
        "answerDirectly": answer_kinds,
        "handoffPreferred": handoff_kinds,
        "oftenNoReply": quiet_kinds,
        "draftOnly": draft_kinds,
        "insufficientEvidence": thin_kinds,
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
