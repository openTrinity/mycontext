#!/usr/bin/env python3
"""Locale packs — all language-specific knowledge, kept out of the engine.

The forge measures behavior; a locale pack tells it what the words mean. The
split matters because the two age differently: the measurement engine is the
same for every operator, while the lexicon is specific to a language, and
sometimes to an industry within it.

Three things live here:

  detect()     which pack fits this corpus, from a script histogram over the
               owner's own messages. Deterministic, offline, no model call.

  load()       a pack by id, or "auto" to detect; merges the operator's local
               additions from <dataRoot>, so one company's internal bot names
               never need to enter a distributed pack.

  NULL_PACK    a real pack with empty pattern sets. When no pack fits the
               corpus, the engine still runs and every lexical measurement
               honestly reports zero, rather than a number derived from
               patterns that do not apply to the language in front of it.

That last one is the reason this module exists in this shape. Without it, the
alternative to "we support your language" is either a crash or — far worse — a
persona confidently built from a pack that matches almost nothing, published
with no indication that its style layer is empty. `NULL_PACK` makes the
degradation explicit and reportable (see `forge report`), which is what makes
the forge safe to hand to someone whose language nobody has written a pack for.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

from . import common as C

LOCALES_DIR = Path(__file__).resolve().parent / "locales"

# Where an operator's own additions live, relative to their data root. Kept out
# of the pack because these terms are by nature single-tenant: an intranet bot's
# brand name is dead weight for every other user of the same language, and
# shipping it would leak one organization's vocabulary into a shared repo.
LOCAL_EXTRA_FILE = "locale-overrides.json"

# Unicode ranges per writing system. Deliberately coarse: the goal is "which
# pack fits", not language identification. Han vs Kana is worth telling apart
# (they need different vocabulary strategies); Portuguese vs Spanish is not,
# because both would be served by a Latin-script pack either way.
SCRIPT_RANGES: dict[str, tuple[tuple[int, int], ...]] = {
    "Latin": ((0x0041, 0x005A), (0x0061, 0x007A), (0x00C0, 0x024F)),
    "Han": ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF)),
    "Kana": ((0x3040, 0x309F), (0x30A0, 0x30FF)),
    "Hangul": ((0x1100, 0x11FF), (0xAC00, 0xD7AF)),
    "Cyrillic": ((0x0400, 0x04FF),),
    "Arabic": ((0x0600, 0x06FF), (0x0750, 0x077F)),
    "Hebrew": ((0x0590, 0x05FF),),
    "Devanagari": ((0x0900, 0x097F),),
    "Thai": ((0x0E00, 0x0E7F),),
    "Greek": ((0x0370, 0x03FF),),
}

# Scripts written without spaces between words. Vocabulary mining slides
# character n-grams for these and counts whitespace-delimited words for the
# rest; a pack may override with its own `wordBoundaries` flag.
NO_WORD_BOUNDARY_SCRIPTS = {"Han", "Kana", "Thai"}

# Scripts that essentially never appear incidentally inside another language's
# prose. This asymmetry is the crux of honest detection and is easy to get wrong.
#
# A Chinese, Japanese or Korean work chat is *full* of Latin: identifiers, tool
# names, ticket ids, borrowed jargon, pasted URLs. So a raw codepoint count can
# easily show more Latin than Han in a corpus that is unambiguously Chinese — and
# a naive "pick the largest share" rule then selects an English pack that measures
# almost none of it, while reporting high confidence.
#
# The reverse does not happen: English prose does not contain runs of Han. A
# substantial presence of a non-Latin script is therefore much stronger evidence
# about the corpus's language than an equal share of Latin is, and detection
# weights it accordingly instead of treating every script as interchangeable.
NON_INCIDENTAL_SCRIPTS = {"Han", "Kana", "Hangul", "Cyrillic", "Arabic", "Hebrew",
                          "Devanagari", "Thai", "Greek"}

# Share at which a non-incidental script decides the verdict even though Latin has
# the larger raw count. Set low on purpose, for a reason that is about writing
# systems rather than about tuning: a codepoint in a logographic script carries far
# more of a sentence than a Latin letter does. A two-character Chinese word is a
# five-to-eight-letter English one, so 15% of characters is very roughly a third of
# the actual content — and in practice, if someone's messages contain Han runs at
# all consistently, the Han is the prose and the Latin is the nouns inside it.
#
# The failure this prevents is asymmetric too, which justifies erring low: picking
# the CJK pack for a mostly-English corpus still measures the CJK sentences
# correctly and reports the rest as uncovered, whereas picking the English pack for
# a Chinese corpus measures essentially nothing while claiming confidence.
_NON_INCIDENTAL_DECIDES = 15.0

# Below this share, a corpus is not confidently in that script. Chosen so that a
# corpus of mostly code, ids and URLs — Latin by codepoint but not by language —
# does not silently select the English pack.
_MIN_CONFIDENCE = 0.60

# A genuinely bilingual corpus is common in technical work: an international team
# switching languages mid-thread. Where no script clears `_MIN_CONFIDENCE`,
# refusing to pick would hand that operator a null pack and a structural-only
# persona — a worse answer than the leading pack plus a clear statement of what it
# misses. So above this share the leading pack is chosen and the remainder is
# disclosed in fidelity.md.
_MIN_PLURALITY = 0.35

# ...provided it actually leads. If the top two scripts are within this margin
# there is no dominant language to pick, and declining is right.
_PLURALITY_MARGIN = 0.10

# Enough of the owner's own text to make the histogram meaningful. A handful of
# messages can be unrepresentative (one English standup in an otherwise Chinese
# corpus), so below this the result is reported as low-confidence.
_MIN_CHARS_FOR_CONFIDENCE = 2000


def _script_of(ch: str) -> str | None:
    cp = ord(ch)
    for name, ranges in SCRIPT_RANGES.items():
        for lo, hi in ranges:
            if lo <= cp <= hi:
                return name
    return None


def script_mix(texts) -> dict[str, float]:
    """Share of scripted characters per writing system, as percentages.

    Unscripted characters — digits, punctuation, emoji, whitespace — are
    excluded from the denominator. They carry no information about which
    language the person writes in, and including them would make every corpus
    look less confidently anything than it is.
    """
    counts: dict[str, int] = {}
    total = 0
    for text in texts:
        for ch in text or "":
            name = _script_of(ch)
            if name:
                counts[name] = counts.get(name, 0) + 1
                total += 1
    if not total:
        return {}
    return {k: round(v / total * 100, 1)
            for k, v in sorted(counts.items(), key=lambda x: -x[1])}


def available() -> list[str]:
    """Pack ids shipped with the forge."""
    if not LOCALES_DIR.is_dir():
        return []
    return sorted(p.stem for p in LOCALES_DIR.glob("*.json"))


def _packs_by_script() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for pid in available():
        try:
            raw = json.loads((LOCALES_DIR / f"{pid}.json").read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for script in raw.get("scripts", []):
            out.setdefault(script, []).append(pid)
    return out


def detect(conn: sqlite3.Connection, sample: int = 4000) -> dict:
    """Which pack fits this corpus, judged only on the OWNER's own messages.

    Their own text is the right sample: incoming messages include bot pushes,
    forwarded content and colleagues who write in another language, none of
    which should decide how the owner's style is measured.

    Returns a verdict that always includes the full script mix, because the part
    a pack does *not* cover is exactly what `fidelity.md` has to disclose. A
    bilingual operator gets a pack for the dominant script and an explicit note
    about the remainder, not a silent half-measurement.
    """
    rows = conn.execute(
        "SELECT clean_text FROM messages "
        "WHERE is_self=1 AND is_agent_sent=0 AND msg_type='text' AND is_pasted=0 "
        "LIMIT ?", (sample,)).fetchall()
    texts = [r["clean_text"] or "" for r in rows]
    mix = script_mix(texts)
    chars = sum(len(t) for t in texts)

    if not mix:
        return {"localeId": None, "confidence": 0.0, "scriptMix": {},
                "dominantScript": None, "sampleChars": chars,
                "reason": "no scripted text in the owner's own messages"}

    raw_top, raw_share = next(iter(mix.items()))
    # Weight the non-incidental scripts as described above: if one of them holds a
    # meaningful share, it identifies the language even when Latin outnumbers it.
    strong = [(k, v) for k, v in mix.items()
              if k in NON_INCIDENTAL_SCRIPTS and v >= _NON_INCIDENTAL_DECIDES]
    if strong and raw_top not in NON_INCIDENTAL_SCRIPTS:
        dominant, share = strong[0]
        weighted = True
    else:
        dominant, share = raw_top, raw_share
        weighted = False

    by_script = _packs_by_script()
    candidates = by_script.get(dominant, [])
    confidence = share / 100.0
    if weighted:
        # The share understates how much of the *language* this script carries,
        # since the Latin it is mixed with is largely identifiers rather than
        # prose. Treat a clear presence as decisive, but keep the real share in the
        # verdict so the report can still disclose the mix.
        confidence = max(confidence, _MIN_CONFIDENCE)
    if chars < _MIN_CHARS_FOR_CONFIDENCE:
        # Not wrong, just thin. Halving keeps a small corpus below the selection
        # threshold unless it is overwhelmingly one script.
        confidence *= 0.5

    if not candidates:
        return {"localeId": None, "confidence": round(confidence, 3),
                "scriptMix": mix, "dominantScript": dominant, "sampleChars": chars,
                "reason": f"no locale pack declares the {dominant} script; "
                          f"install or author one, or run with the null pack"}

    runner_up = list(mix.values())[1] if len(mix) > 1 else 0.0
    leads = (raw_share - runner_up) / 100.0 >= _PLURALITY_MARGIN
    if confidence >= _MIN_CONFIDENCE:
        mode = "weighted" if weighted else "dominant"
    elif confidence >= _MIN_PLURALITY and leads:
        # Bilingual corpus with a clear lead. Pick the leading pack and say
        # plainly what it misses: a partial measurement that discloses its own gap
        # beats a null pack that measures nothing.
        mode = "plurality"
    else:
        return {"localeId": None, "confidence": round(confidence, 3),
                "scriptMix": mix, "dominantScript": dominant, "sampleChars": chars,
                "reason": f"no script leads clearly ({raw_top} {raw_share}%"
                          + (f" vs {runner_up}%" if runner_up else "") + ")"
                          + ("" if chars >= _MIN_CHARS_FOR_CONFIDENCE
                             else f" and the sample is small ({chars} chars)")
                          + " — too mixed to pick a pack automatically; set "
                            "locale.id explicitly to override"}

    if weighted:
        reason = (f"{dominant} is {share}% of the owner's own text and carries the "
                  f"prose; the larger {raw_top} share ({raw_share}%) is mostly "
                  f"identifiers and borrowed terms inside it")
    else:
        reason = f"{dominant} is {share}% of the owner's own text"
    uncovered = {k: v for k, v in mix.items()
                 if k != dominant and v >= 5 and k in NON_INCIDENTAL_SCRIPTS}
    if mode == "plurality" or uncovered:
        if uncovered:
            reason += (" — mixed-language corpus, so this pack is the best "
                       "available fit rather than a complete one; not measured by "
                       "it: " + ", ".join(f"{k} {v}%" for k, v in uncovered.items()))
    return {"localeId": candidates[0], "confidence": round(confidence, 3),
            "scriptMix": mix, "dominantScript": dominant, "sampleChars": chars,
            "alternatives": candidates[1:], "selection": mode,
            "reason": reason}


class LocalePack:
    """Compiled lexical rules for one language.

    Every section is optional. `has(section)` is the engine's contract for
    asking whether a measurement is even possible, so that "we measured zero"
    and "we cannot measure this" stay distinguishable all the way through to the
    published skill. Conflating them is how a persona ends up publishing
    `never_settle` for every risk class and calling it evidence.
    """

    #: Sections the engine may ask about. Fixed, so a typo in a pack is caught
    #: rather than silently disabling a measurement.
    SECTIONS = ("style", "scene", "askKinds", "riskTags", "openerShapes",
                "replyShapes", "responseGate", "bots", "sensitiveTitle",
                "stopwords", "guidance")

    def __init__(self, raw: dict, source: str = "", local_additions: dict | None = None):
        self.raw = raw
        self.id = raw.get("id") or "null"
        self.version = str(raw.get("version") or "0")
        self.display_name = raw.get("displayName") or self.id
        self.source = source
        self.local_additions = local_additions or {}
        self.scripts = list(raw.get("scripts") or [])

        self.style = _compile_map(raw.get("style"))
        self.scene = _compile_map(raw.get("scene"))
        self.ask_kinds = _compile_pairs(raw.get("askKinds"))
        self.risk_tags = _compile_pairs(raw.get("riskTags"))
        self.openers = _compile_pairs(raw.get("openerShapes"))
        self.reply_shapes = _compile_map(raw.get("replyShapes"))

        gate = raw.get("responseGate") or {}
        self.genuine_ask = _compile_one(gate.get("genuineAsk"))
        self.chitchat = _compile_one(gate.get("chitchatReply"))

        self.bot_name = _compile_one((raw.get("bots") or {}).get("namePattern"))
        self.sensitive_title = _compile_one(raw.get("sensitiveTitlePattern"))

        self.stopwords = set((raw.get("stopwords") or "").split())
        self.guidance = {k: v for k, v in (raw.get("guidance") or {}).items()
                         if not k.startswith("_")}

        declared = raw.get("wordBoundaries")
        if declared is None:
            declared = not any(s in NO_WORD_BOUNDARY_SCRIPTS for s in self.scripts)
        self.word_boundaries = bool(declared)

        # Threshold overrides. A pack may override a `signals.json` threshold when
        # the shared default is calibrated in a unit that does not travel between
        # languages. `quoteMaxLength` is the motivating case: it counts
        # codepoints, and a codepoint carries far less meaning in an alphabetic
        # script than in a logographic one, so one global value silently discards
        # every escape hatch in half the world's languages.
        self.threshold_overrides = {
            k: raw[k] for k in ("quoteMaxLength",) if k in raw}

    def threshold(self, group: str, key: str):
        """This pack's override for a threshold, or None to use the shared value."""
        if key in self.threshold_overrides:
            return self.threshold_overrides[key]
        return None

    # -- capability queries -------------------------------------------------

    def has(self, section: str) -> bool:
        """Can this pack support the named measurement at all?"""
        return {
            "style": bool(self.style),
            "scene": bool(self.scene),
            "askKinds": bool(self.ask_kinds),
            "riskTags": bool(self.risk_tags),
            "openerShapes": bool(self.openers),
            "replyShapes": bool(self.reply_shapes),
            "responseGate": bool(self.genuine_ask),
            "bots": bool(self.bot_name),
            "sensitiveTitle": bool(self.sensitive_title),
            "stopwords": bool(self.stopwords),
            "guidance": bool(self.guidance),
        }.get(section, False)

    @property
    def is_null(self) -> bool:
        return not any(self.has(s) for s in self.SECTIONS)

    def missing(self) -> list[str]:
        """Sections this pack cannot measure — published in fidelity.md."""
        return [s for s in self.SECTIONS if not self.has(s)]

    def guide(self, key: str, default=None):
        return self.guidance.get(key, default)

    def stamp(self) -> str:
        """Identity string folded into rulesVersion.

        Local additions are part of it: two operators on the same pack whose
        override files differ have measured with different rules, and a derived
        number that does not say so is not reproducible.
        """
        base = f"{self.id}@{self.version}"
        n = sum(len(v) for v in self.local_additions.values()
                if isinstance(v, (list, dict)))
        return f"{base}+{n}local" if n else base

    def describe(self) -> dict:
        return {
            "id": self.id, "version": self.version,
            "displayName": self.display_name,
            "scripts": self.scripts,
            "wordBoundaries": self.word_boundaries,
            "source": self.source,
            "sections": {s: self.has(s) for s in self.SECTIONS},
            "missing": self.missing(),
            "localAdditions": {k: len(v) for k, v in self.local_additions.items()},
            "isNull": self.is_null,
        }


def _compile_one(pattern) -> re.Pattern | None:
    if not pattern:
        return None
    return re.compile(pattern, re.I)


def _compile_map(section) -> dict[str, re.Pattern]:
    if not section:
        return {}
    return {k: re.compile(v, re.I) for k, v in section.items()
            if isinstance(v, str) and not k.startswith("_")}


def _compile_pairs(section) -> list[tuple[str, re.Pattern]]:
    """Order-preserving: for ask kinds and risk tags, first match wins."""
    if not section:
        return []
    return [(k, re.compile(v, re.I)) for k, v in section.items()
            if isinstance(v, str) and not k.startswith("_")]


#: The honest fallback. Not an error state — a pack whose every answer to
#: `has()` is False, so the engine runs unchanged and the structural layer
#: (length, latency, silence, reciprocity, opener distribution) is still fully
#: measured. What it cannot know, it reports.
NULL_PACK = LocalePack({"id": "null", "version": "0",
                        "displayName": "no locale pack — structural measurements only"},
                       source="builtin")


def load(locale_id: str | None, data_root: Path | None = None,
         conn: sqlite3.Connection | None = None) -> tuple[LocalePack, dict]:
    """Load a pack. Returns (pack, verdict).

    `locale_id` may be a pack id, "auto" (detect from the corpus — requires
    `conn`), or "none"/None (use NULL_PACK explicitly). The verdict always
    explains which pack was chosen and why, because that reasoning is published
    in the skill's fidelity report rather than kept as an implementation detail.
    """
    verdict: dict = {"requested": locale_id or "none"}

    if locale_id in (None, "", "none", "null"):
        verdict.update(localeId=None, reason="null pack requested explicitly")
        return NULL_PACK, verdict

    if locale_id == "auto":
        if conn is None:
            verdict.update(localeId=None,
                           reason="auto-detection needs a corpus; none was open")
            return NULL_PACK, verdict
        detected = detect(conn)
        verdict.update(detected)
        if not detected["localeId"]:
            return NULL_PACK, verdict
        locale_id = detected["localeId"]

    path = LOCALES_DIR / f"{locale_id}.json"
    if not path.exists():
        verdict.update(localeId=None,
                       reason=f"no such locale pack: {locale_id!r}; "
                              f"available: {', '.join(available()) or 'none'}")
        return NULL_PACK, verdict

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        verdict.update(localeId=None, reason=f"locale pack {locale_id} unreadable: {e}")
        return NULL_PACK, verdict

    extra = _local_extra(data_root, locale_id)
    if extra:
        raw = _merge_local(raw, extra)
    pack = LocalePack(raw, source=str(path.name), local_additions=extra)
    verdict.setdefault("localeId", pack.id)
    verdict.setdefault("reason", f"locale pack {pack.id} loaded")
    return pack, verdict


def _local_extra(data_root: Path | None, locale_id: str) -> dict:
    """The operator's own additions, scoped to this pack.

    File shape — every key optional:

        {
          "zh-CN": {
            "botNames": ["<intranet bot>", "<newsletter account>"],
            "stopwords": ["<a word that floods your vocabulary list>"],
            "placeholders": ["<your bug-tracker's form label>"]
          }
        }

    A bare-topmost-keys file (no pack id) is accepted too and applies to
    whichever pack is in use, which is the common case for someone who only ever
    works in one language.
    """
    if not data_root:
        return {}
    raw = C.read_json(Path(data_root) / LOCAL_EXTRA_FILE, {}) or {}
    scoped = raw.get(locale_id)
    if isinstance(scoped, dict):
        base = scoped
    else:
        base = {k: v for k, v in raw.items() if not k.startswith("_")
                and not isinstance(v, dict)}
    return {k: v for k, v in base.items()
            if k in ("botNames", "stopwords", "placeholders") and v}


def _merge_local(raw: dict, extra: dict) -> dict:
    """Fold the operator's additions into a pack copy. Never mutates the file."""
    out = json.loads(json.dumps(raw))     # cheap deep copy; packs are small
    names = [re.escape(t) for t in extra.get("botNames", []) if t]
    if names:
        pattern = (out.get("bots") or {}).get("namePattern") or ""
        joined = "|".join(names)
        out.setdefault("bots", {})["namePattern"] = (
            f"({pattern[1:-1]}|{joined})" if pattern.startswith("(") and pattern.endswith(")")
            else f"({pattern}|{joined})" if pattern else f"({joined})")
    words = [w for w in extra.get("stopwords", []) if w]
    if words:
        out["stopwords"] = " ".join(
            list((out.get("stopwords") or "").split()) + words)
    return out


def extra_placeholders(data_root: Path | None, locale_id: str) -> list[str]:
    """Operator-supplied placeholder patterns.

    Read by `common.is_placeholder` so that one organization's form templates
    and bug-report boilerplate can be excluded from style analysis without those
    strings ever entering a distributed pack. This is the escape hatch that
    keeps single-tenant furniture out of the forge itself.
    """
    return list(_local_extra(data_root, locale_id).get("placeholders", []))
