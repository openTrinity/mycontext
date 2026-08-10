#!/usr/bin/env python3
"""Relationship layer — tone bands and per-person reply permission.

Bands come from measured interaction volume and mutual initiation, not from any
claim about real feelings. Two hard rules that no measurement can override:

  - a sensitive title (HR / finance / legal / exec) forces band S, however
    friendly the traffic looks
  - a name in the owner's overrides file wins over any computed band, and an
    override may only tighten (S is always accepted; loosening to A requires the
    owner to say so explicitly with `trust: true`)
"""

from __future__ import annotations

import sqlite3

from . import common as C
from .analyze import Rules

BAND_GUIDANCE = {
    "A": {"compression": "terse, several short bubbles fine",
          "humor": True, "rough": True, "autoAnswer": "low-risk allowed"},
    "B": {"compression": "short, mostly single bubble",
          "humor": True, "rough": False, "autoAnswer": "clear work answers only"},
    "C": {"compression": "moderate, slightly more formal",
          "humor": False, "rough": False, "autoAnswer": "draft only"},
    "D": {"compression": "complete sentences, more courtesy",
          "humor": False, "rough": False, "autoAnswer": "draft only"},
    "S": {"compression": "formal, single bubble, no banter",
          "humor": False, "rough": False, "autoAnswer": "manual only"},
}


def _weighted_volumes(conn: sqlite3.Connection, rules: Rules) -> tuple[dict, dict]:
    """Per-person recency-weighted message volume, `(from_them, to_them)`.

    Aggregated per `(person, day)` in SQL and weighted in Python, because the
    weight is a function of the day and SQLite has no way to express the decay
    curve. One row per person-day keeps this small even on a six-figure corpus.

    ## Why bands need decay at all

    A band is measured interaction volume, and volume only accumulates: a
    colleague who changed teams six months ago keeps the volume that made them
    "closest collaborator" forever, and band A carries `autoAnswer: low-risk
    allowed`. So the staleness is not cosmetic — it is standing permission,
    granted on the strength of a relationship that is no longer active.

    ## ★ Decay can only move someone DOWN the ladder here

    Weighting reduces volume, and less volume means a lower rung, and the lower
    rungs are the more courteous, draft-only ones (`BAND_GUIDANCE`). So this
    direction is safe by construction: decay may withdraw familiarity, never
    grant it. `S` is untouched — it is forced by title or override and is not a
    rung on this ladder.
    """
    window, params = rules.window_clause("occurred_at")
    from_them: dict[str, float] = {}
    for r in conn.execute(
            "SELECT sender_id AS person, substr(occurred_at,1,10) AS day, "
            "COUNT(*) AS n FROM messages "
            "WHERE is_self=0 AND sender_id != ''" + window +
            " GROUP BY sender_id, day", params):
        person = r["person"]
        from_them[person] = (from_them.get(person, 0.0)
                             + r["n"] * rules.recency.weight(r["day"]))

    to_them: dict[str, float] = {}
    for r in conn.execute(
            "SELECT c.peer_open_id AS person, substr(m.occurred_at,1,10) AS day, "
            "COUNT(*) AS n FROM messages m "
            "JOIN conversations c ON c.conversation_id = m.conversation_id "
            "WHERE m.is_self=1 AND c.peer_open_id != ''"
            + window.replace("occurred_at", "m.occurred_at") +
            " GROUP BY c.peer_open_id, day", params):
        person = r["person"]
        to_them[person] = (to_them.get(person, 0.0)
                           + r["n"] * rules.recency.weight(r["day"]))
    return from_them, to_them


def compute_bands(conn: sqlite3.Connection, rules: Rules,
                  overrides: dict | None = None) -> dict:
    """Assign a tone band to every person seen in the corpus.

    Reciprocity (how much the owner writes *to* someone) is only measurable in a
    1:1 thread. For someone known only from group chats, volume is still evidence
    of familiarity but reciprocity is unknown — so those people are banded on
    volume alone and capped at the configured `groupOnlyCap`, never promoted on
    group traffic. Being in a busy group with someone is not the same as being
    close to them.

    The ladder itself is read from `signals.json → toneBands._ladder`, so a
    deployment can add or rename bands as data. `S` stays reserved in code: it is
    not a rung on the volume ladder but the forced-conservative band for
    sensitive roles and unresolved recipients, and no amount of measured
    friendliness may move someone off it.

    Volume is recency-weighted (see `_weighted_volumes`) so a relationship that
    has gone quiet loses the familiarity it earned, while the raw counts stay in
    the ledger as the checkable evidence behind the band.
    """
    overrides = overrides or {}
    tone_cfg = rules.tone
    ladder = [b for b in rules.band_ladder if b in BAND_GUIDANCE]
    if not ladder:
        ladder = ["A", "B", "C", "D"]
    lowest = ladder[-1]
    group_cap = rules.group_only_cap if rules.group_only_cap in ladder else lowest
    weighted_from, weighted_to = _weighted_volumes(conn, rules)
    people = conn.execute("""
        SELECT p.person_id, p.name, p.nick, p.title,
               p.msgs_from,
               (SELECT COUNT(*) FROM messages m
                  JOIN conversations c ON c.conversation_id=m.conversation_id
                 WHERE m.is_self=1 AND c.peer_open_id=p.person_id) AS msgs_to,
               (SELECT COUNT(*) FROM conversations c
                 WHERE c.peer_open_id=p.person_id AND c.single_chat=1) AS direct_threads,
               (SELECT COUNT(DISTINCT substr(m.occurred_at,1,10)) FROM messages m
                 WHERE m.sender_id=p.person_id) AS active_days,
               (SELECT MAX(m.occurred_at) FROM messages m
                 WHERE m.sender_id=p.person_id) AS last_seen
        FROM people p ORDER BY p.msgs_from DESC""").fetchall()

    out: list[dict] = []
    for p in people:
        name = p["name"] or p["nick"] or ""
        if not name:
            continue
        if rules.is_bot(name):
            continue      # a notification account has no tone to match
        # Raw counts stay reported as the evidence; the LADDER reads the weighted
        # ones, so a quiet relationship slides down rather than holding its rung.
        from_n, to_n = p["msgs_from"] or 0, p["msgs_to"] or 0
        person_id = p["person_id"]
        from_w = weighted_from.get(person_id, 0.0)
        to_w = weighted_to.get(person_id, 0.0)
        total = from_w + to_w
        has_direct = bool(p["direct_threads"])
        self_share = (to_w / total) if total else 0.0
        title = p["title"] or ""
        sensitive = rules.is_sensitive_title(title)
        # A title the active locale pack cannot classify is not a title that has
        # been cleared. Without this, a corpus with no matching pack silently
        # promotes every manager, HR partner and finance lead to an ordinary
        # band — and `everyone` scope would then auto-send to them. Absence of a
        # lexicon is absence of evidence, and the conservative reading is the only
        # safe one when the subject is who may receive an unattended reply.
        unclassifiable_title = bool(title) and not rules.pack.has("sensitiveTitle")
        if unclassifiable_title:
            sensitive = True

        band = lowest
        for candidate in ladder:
            spec = tone_cfg[candidate]
            if total < spec["minTotal"]:
                continue
            if has_direct and self_share < spec["minSelfShare"]:
                continue
            band = candidate
            break
        if not has_direct and _rank(band) < _rank(group_cap):
            band = group_cap   # group-only familiarity is not confirmed closeness
        elif has_direct and band == lowest and total >= tone_cfg[group_cap]["minTotal"]:
            # A 1:1 thread exists and there is real volume, but the owner rarely
            # writes back. That is a known colleague they seldom answer — treat as
            # the capped band rather than a stranger, since the lowest band's
            # guidance would understate how often they appear.
            band = group_cap
        if sensitive:
            band = "S"

        ov = overrides.get(name) or {}
        source = "measured"
        if ov.get("band"):
            requested = str(ov["band"]).upper()
            if requested in BAND_GUIDANCE:
                tighter = _rank(requested) >= _rank(band)
                if tighter or ov.get("trust") is True:
                    band = requested
                    source = "owner-override"
        if ov.get("sensitive") is True:
            band, sensitive, source = "S", True, "owner-override"

        out.append({
            "personId": p["person_id"], "name": name, "nick": p["nick"] or "",
            "title": p["title"] or "", "toneBand": band, "sensitive": sensitive,
            "sensitiveReason": ("owner-override" if source == "owner-override" and sensitive
                                else "unreadable title — no lexicon for this locale"
                                if unclassifiable_title
                                else "title matches a sensitive role" if sensitive
                                else ""),
            "messagesFrom": from_n, "messagesToThem": to_n,
            # The weighted volumes the band was actually decided on. Published
            # next to the raw counts so a band that dropped because a
            # relationship went quiet is explainable — otherwise the ledger would
            # show 800 messages and band C with nothing connecting the two.
            "weightedFrom": round(from_w, 2), "weightedToThem": round(to_w, 2),
            "hasDirectThread": has_direct,
            "activeDays": p["active_days"] or 0, "lastSeen": p["last_seen"] or "",
            "source": source, "guidance": BAND_GUIDANCE[band],
            "note": ov.get("note", ""),
        })
    return {"rulesVersion": rules.version, "people": out,
            "counts": _band_counts(out)}


def _rank(band: str) -> int:
    """Higher = more conservative. Used to check an override only tightens."""
    return {"A": 0, "B": 1, "C": 2, "D": 3, "S": 4}.get(band, 4)


def _band_counts(people: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for p in people:
        counts[p["toneBand"]] = counts.get(p["toneBand"], 0) + 1
    return dict(sorted(counts.items()))


def apply_bands(conn: sqlite3.Connection, ledger: dict) -> dict[str, str]:
    """Persist bands onto people rows; return personId → band for turn tagging."""
    mapping: dict[str, str] = {}
    for p in ledger["people"]:
        conn.execute(
            "UPDATE people SET tone_band=?, sensitive=?, relationship=? WHERE person_id=?",
            (p["toneBand"], int(p["sensitive"]), p["guidance"]["autoAnswer"], p["personId"]))
        mapping[p["personId"]] = p["toneBand"]
    conn.commit()
    return mapping


def retag_turns(conn: sqlite3.Connection) -> int:
    """Refresh tone bands on turns/asks after bands change (people join by name)."""
    n = conn.execute("""
        UPDATE turns SET tone_band = COALESCE(
          (SELECT p.tone_band FROM people p WHERE p.name=turns.peer_name
             OR p.nick=turns.peer_name LIMIT 1), '')""").rowcount
    conn.execute("""
        UPDATE asks SET tone_band = COALESCE(
          (SELECT p.tone_band FROM people p WHERE p.person_id=asks.asker_id LIMIT 1), '')""")
    conn.commit()
    return n


def summary_for_skill(ledger: dict, rules=None, max_people: int | None = None) -> list[dict]:
    """The publishable slice: identity + band + guidance.

    No counts and no rankings — volume is evidence for the forge, not something a
    persona should reason with ("I message you the most" is not a fact any agent
    should surface).

    The platform's stable user id IS published, because the autonomy gate is keyed
    on it. A table that only carried names would let an agent resolve a band for
    one person and send to someone else who shares the name — and display names
    collide in real directories, while a 1:1 chat title is usually an editable
    remark that anyone can change. The id is an opaque per-tenant handle, not
    personal data.
    """
    t = (rules.thresholds.get("people", {}) if rules else {})
    min_msgs = t.get("minMessagesToPublish", 5)
    limit = max_people if max_people is not None else t.get("maxPeoplePublished", 60)
    people = [p for p in ledger["people"]
              if p["messagesFrom"] + p["messagesToThem"] >= min_msgs]
    people.sort(key=lambda p: (_rank(p["toneBand"]),
                               -(p["messagesFrom"] + p["messagesToThem"])))
    chosen = people[:limit]
    # Flag names that are ambiguous *within the published table*, so the skill can
    # tell an agent when a name alone is not enough to act on.
    name_counts: dict[str, int] = {}
    for p in chosen:
        name_counts[p["name"]] = name_counts.get(p["name"], 0) + 1
    return [{
        "name": p["name"], "personId": p["personId"],
        "toneBand": p["toneBand"],
        "sensitive": p["sensitive"], "title": p["title"],
        "autoAnswer": p["guidance"]["autoAnswer"],
        "ambiguousName": name_counts[p["name"]] > 1,
        "note": p["note"],
    } for p in chosen]
