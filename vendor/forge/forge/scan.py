#!/usr/bin/env python3
"""Share-safety scan.

Two distinct questions, deliberately not conflated:

  --scope repo    Is this repo safe to share? It must contain the forge and
                  nothing about any person. Any corpus, config, ledger, or filled
                  persona file present here is a finding.

  --scope skill   Is a published skill safe to hand to another agent? Real names
                  and tone bands are expected — that is the skill's job. What must
                  NOT be there: credentials, raw DingTalk ids, absolute paths into
                  someone's home, and message text attributed to a third party.

The local corpus itself is intentionally not scanned for names or ids: keeping
them is the design. Its protection is location and permissions, checked here.
"""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path

from . import common as C

REPO = Path(__file__).resolve().parent.parent

CREDENTIAL = {
    "credential": re.compile(
        r"(glpat-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|"
        r"AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|"
        r"-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{20,}|"
        r"(access|refresh)[_-]?token\"?\s*[:=]\s*\"?[A-Za-z0-9._-]{16,})", re.I),
    "cookie": re.compile(r"(Set-Cookie:|session=[A-Za-z0-9]{12,})", re.I),
}

SKILL_FORBIDDEN = {
    # Conversation and message ids are pure plumbing: nothing in a persona needs
    # them, and they pin the skill to one tenant's threads. A person's
    # openDingTalkId is handled separately below.
    "raw_conversation_id": re.compile(r"\b(cid[A-Za-z0-9+/=]{12,}|msg[A-Za-z0-9+/=]{12,})\b"),
    "home_path": re.compile(r"/Users/[a-z0-9._-]+/|/home/[a-z0-9._-]+/", re.I),
}

# A person's platform id is *required* in references/people.md: the autonomy gate
# is keyed on it, display names are not unique in a real directory, and a 1:1
# chat title is usually an editable remark — so a name-only table lets an agent
# resolve a band for one person and message another. Truncating is not an option
# either: ids from the same tenant often share long prefixes, so a short stub
# reintroduces the very collisions it was meant to remove.
#
# Publishing it is therefore a deliberate, bounded decision: allowed in the one
# file that needs it, flagged anywhere else. The PATTERN comes from the active
# message source (`MessageSource.ID_PATTERN`), because a regex for one vendor's
# id format silently passes every other vendor's ids — a scanner that reports
# "safe" for a platform it cannot recognize is worse than no scanner.
PERSON_ID_ALLOWED_IN = {"references/people.md"}


def _person_id_patterns(source_kind: str | None = None) -> list[tuple[str, re.Pattern]]:
    """Id patterns to enforce: the named source's, or every known source's.

    Scanning against all of them by default is deliberate. A skill directory does
    not record which adapter produced it, and checking only one platform's format
    would let a DingTalk id through a scan configured for Slack.
    """
    from .sources import available, get_source_class
    kinds = [source_kind] if source_kind else available()
    out = []
    for kind in kinds:
        try:
            cls = get_source_class(kind)
        except SystemExit:
            continue
        if cls.ID_PATTERN:
            out.append((kind, re.compile(cls.ID_PATTERN)))
    return out


# Engine files must contain no lexical patterns from any human language. This is
# the rule that keeps the locale split from eroding: before the packs existed,
# every one of these files carried Chinese regexes, which meant the forge silently
# measured nothing for anyone else. `locales/` and `sources/` are exempt by
# design — a locale pack IS lexicon, and a platform adapter owns its client's
# furniture.
ENGINE_DIR_EXEMPT = ("forge/locales/", "forge/sources/")
_SCRIPT_TEXT_RE = re.compile(
    "["
    "㐀-䶿一-鿿豈-﫿"   # Han
    "぀-ゟ゠-ヿ"                 # Kana
    "가-힯"                              # Hangul
    "؀-ۿ"                              # Arabic
    "฀-๿"                              # Thai
    "]")

# Escaped forms (\uXXXX) are how the engine is allowed to name a codepoint range
# or a single marker without carrying readable text, so a line using them is not
# a finding. The distinction matters: `"不用"` is a documented constant,
# while the same characters typed literally are a lexical rule in hiding.
_UNICODE_ESCAPE_RE = re.compile(r"\\u[0-9a-fA-F]{4}")

# In the repo scope these files are personal data by their very existence.
REPO_FORBIDDEN_NAMES = {
    "persona-config.json", "persona.db", "features.json",
    "relationship-ledger.json", "relationship-overrides.json",
    "owner-blocks.json",
    "agent-sent.jsonl", "action-audit.jsonl",
    "dws-calls.jsonl", "hmac.key",
    "style.md", "decisions.md", "people.md", "scenes.md", "limits.md",
}

SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".mypy_cache"}
TEXT_EXT = {".py", ".md", ".json", ".yaml", ".yml", ".txt", ".sh", ".sql", ""}


def scan(scope: str, path: Path | None = None,
         source_kind: str | None = None) -> dict:
    root = path or (REPO if scope == "repo" else None)
    if root is None:
        raise SystemExit("--path is required for this scope")

    findings: list[dict] = []
    files = 0
    id_patterns = _person_id_patterns(source_kind)
    id_check_reported = False

    for f in sorted(root.rglob("*")):
        if any(part in SKIP_DIRS for part in f.parts):
            continue
        if not f.is_file():
            continue
        rel = f.relative_to(root).as_posix()

        if scope == "repo" and f.name in REPO_FORBIDDEN_NAMES:
            # templates/ legitimately holds the *shape* of these files.
            if not rel.startswith(("templates/", "tests/")):
                findings.append({"severity": "critical", "kind": "personal_data_in_repo",
                                 "path": rel})
        if scope == "data":
            mode = stat.S_IMODE(f.stat().st_mode)
            if mode & 0o077:
                findings.append({"severity": "high", "kind": "loose_permissions",
                                 "path": rel, "detail": oct(mode)})
        if f.suffix not in TEXT_EXT:
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        files += 1
        # The scanner's own patterns are not findings.
        if f.name == "scan.py":
            continue
        # Nor are the self-test's fixtures: that suite is REQUIRED to contain
        # sample text in several languages, which is the point of running the
        # corpus checks per locale.
        if scope == "repo" and f.name != "selftest.py":
            findings += _lexical_findings(rel, text)

        if scope == "skill" and not id_patterns and not id_check_reported:
            # Say so rather than reporting a scan whose id check never ran.
            id_check_reported = True
            findings.append({
                "severity": "info", "kind": "id_check_unavailable", "path": rel,
                "detail": "no message source declares an id pattern, so a person "
                          "id outside people.md cannot be detected in this scan"})

        for line_no, line in enumerate(text.splitlines(), 1):
            for kind, rx in CREDENTIAL.items():
                if rx.search(line):
                    findings.append({"severity": "critical", "kind": kind,
                                     "path": rel, "line": line_no})
            if scope == "skill":
                # `.config-path` is a deliberate local pointer, and the runtime's
                # own code names platform fields; neither is a leak.
                if rel.endswith(".config-path") or rel.endswith(".py"):
                    continue
                for kind, rx in SKILL_FORBIDDEN.items():
                    if rx.search(line):
                        findings.append({"severity": "high", "kind": kind,
                                         "path": rel, "line": line_no})
                # A person's id belongs in people.md and nowhere else.
                if rel not in PERSON_ID_ALLOWED_IN:
                    for kind, rx in id_patterns:
                        if rx.search(line):
                            findings.append({
                                "severity": "high",
                                "kind": "person_id_outside_people_md",
                                "path": rel, "line": line_no,
                                "detail": f"{kind} user ids are only published in "
                                          f"references/people.md"})

    if scope == "data" and root.exists():
        mode = stat.S_IMODE(root.stat().st_mode)
        if mode & 0o077:
            findings.append({"severity": "high", "kind": "loose_permissions",
                             "path": ".", "detail": oct(mode)})

    blocking = [f for f in findings if f["severity"] in ("critical", "high")]
    return {
        "scope": scope, "root": str(root), "filesScanned": files,
        "idPatternsChecked": [k for k, _ in id_patterns],
        "findings": findings, "safe": not blocking,
    }


#: Shortest phrase worth comparing. Below this, collisions are pure chance: any
#: fixture that says something ordinary will match a large corpus somewhere.
_FIXTURE_PHRASE_MIN = 5

#: Above this length a shared phrase stops being plausible as coincidence. A
#: seven-character run in a logographic script is a sentence fragment, not a
#: common expression, so finding the same one in a fixture and in real history is
#: evidence the fixture was written while looking at that history.
_FIXTURE_PHRASE_DISTINCTIVE = 7

#: A phrase appearing in many real messages is common usage, not a copied line.
#: The signature of derivation is the opposite: an unusual phrase, once or twice.
_FIXTURE_COMMON_ENOUGH = 5


def corpus_derived_fixtures(repo_root: Path, db_path: Path,
                            limit: int = 40) -> list[dict]:
    """Test fixtures that look copied from a real corpus rather than invented.

    The forge ships no personal data, and its test fixtures are meant to be
    fictional. But a fixture is written by someone looking at real output, so a
    distinctive phrase can be carried across without anyone deciding to do it —
    and once it is in the repo it is indistinguishable from an invented one by
    reading alone.

    So this is checked against the actual corpus rather than trusted: any
    sufficiently long phrase appearing in both is reported. Run explicitly
    (`forge scan --scope fixtures`) because it needs the operator's own database,
    which the shareable scopes must never touch.
    """
    import sqlite3
    findings: list[dict] = []
    if not db_path.exists():
        return [{"severity": "info", "kind": "no_corpus", "path": str(db_path),
                 "detail": "no corpus on this machine, so fixtures cannot be "
                           "compared against one"}]
    target = repo_root / "forge" / "selftest.py"
    if not target.exists():
        return findings
    text = target.read_text(encoding="utf-8")
    phrases = {p for p in re.findall(
        r"[㐀-䶿一-鿿]{%d,}" % _FIXTURE_PHRASE_MIN, text)}
    phrases |= {p.strip() for p in re.findall(
        r"(?:[A-Za-z']+[ ]){%d,}" % _FIXTURE_PHRASE_MIN, text)}
    if not phrases:
        return findings
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        for phrase in sorted(phrases)[:500]:
            row = conn.execute(
                "SELECT COUNT(*) FROM messages WHERE clean_text LIKE ?",
                (f"%{phrase}%",)).fetchone()
            if not (row and row[0]):
                continue
            count = row[0]
            # Two signals, and neither is conclusive alone. A long phrase is
            # unlikely to coincide; a phrase used often in the corpus is common
            # usage rather than a copied line. Severity reflects that: `high`
            # where both point the same way, `info` where a human should judge.
            distinctive = len(phrase) >= _FIXTURE_PHRASE_DISTINCTIVE
            rare = count < _FIXTURE_COMMON_ENOUGH
            if distinctive and rare:
                findings.append({
                    "severity": "high", "kind": "fixture_from_real_corpus",
                    "path": "forge/selftest.py", "phrase": phrase,
                    "realMessages": count,
                    "detail": f"{phrase!r} appears in {count} real message(s) and is "
                              f"too specific to be coincidence. A fixture must be "
                              f"invented — rewrite it around the structure under "
                              f"test, not around a remembered line."})
            else:
                findings.append({
                    "severity": "info", "kind": "fixture_phrase_also_in_corpus",
                    "path": "forge/selftest.py", "phrase": phrase,
                    "realMessages": count,
                    "detail": f"{phrase!r} appears in {count} real message(s). "
                              + ("Common usage, most likely coincidence."
                                 if not rare else
                                 "Short enough to collide by chance.")
                              + " Worth a glance, not a failure."})
            if len(findings) >= limit:
                break
    except sqlite3.Error as e:
        findings.append({"severity": "info", "kind": "corpus_unreadable",
                         "path": str(db_path), "detail": str(e)[:120]})
    finally:
        conn.close()
    return findings


def _lexical_findings(rel: str, text: str) -> list[dict]:
    """Engine files must carry no readable text in any human language.

    Checked mechanically on the codepoints, because every softer formulation of
    this rule is one somebody can talk themselves past. A range or a single marker
    written as escapes is fine — that is the documented way to name a codepoint
    without embedding a language — so a line containing one is skipped.
    """
    if not rel.startswith("forge/") or not rel.endswith((".py", ".json")):
        return []
    if any(rel.startswith(d) for d in ENGINE_DIR_EXEMPT):
        return []
    out = []
    for line_no, line in enumerate(text.splitlines(), 1):
        if _UNICODE_ESCAPE_RE.search(line):
            continue
        hit = _SCRIPT_TEXT_RE.search(line)
        if hit:
            out.append({
                "severity": "high", "kind": "lexical_pattern_in_engine",
                "path": rel, "line": line_no,
                "detail": "engine files must be language-independent. Lexical "
                          "patterns belong in forge/locales/<id>.json, platform "
                          "furniture in forge/sources/, and one organization's own "
                          "terms in the operator's locale-overrides.json."})
    return out
