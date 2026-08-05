#!/usr/bin/env python3
"""Shared helpers for im-persona-forge. Standard library only.

Design note — this forge stores the FULL local corpus (every message, every
sender, real names, real conversation titles, real DingTalk ids) under a 700
data root on the owner's own machine. Local fidelity is the point: an agent that
has to reason about "what did they actually say to me and who are they" cannot
work from hashes. What is *published* into a skill is a separate decision made
by compose.py, and the share-scan (`forge scan`) is what guards the boundary.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Any

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

# Credentials must never be stored, even locally: a leaked secret in a local
# corpus is still a leaked secret, and it is never style signal.
SECRET_RE = re.compile(
    r"(glpat-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|"
    r"sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|"
    r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY|"
    r"(access|refresh)[_-]?token[\"'\s:=]+[A-Za-z0-9._-]{16,})",
    re.I,
)

SECRET_MASK = "[secret-redacted]"


def scrub_secrets(text: str) -> str:
    return SECRET_RE.sub(SECRET_MASK, text) if text else text


# ---------------------------------------------------------------------------
# canonical json + hashing
# ---------------------------------------------------------------------------

def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_hash(obj: Any) -> str:
    return sha256_hex(canonical_json(obj))


def slug_from_self_id(raw_self_id: str, org_id: str = "") -> str:
    """Opaque, non-enumerable profile slug — derived from ids, never from the
    display name, so the skill directory name leaks nothing.

    ## Why the org id is part of it

    A member id alone is *not* stable for a person: on DingTalk it is the
    in-organization staff number, so the same human gets a different one in each
    organization, and two different humans in two organizations can share one.
    Both failure directions were observed on real data: one person's corpus was
    about to be split across two profiles, and two different people collided onto
    a single slug because their staff numbers happened to match across two orgs.

    Hashing `orgId + userId` matches the isolation key the app uses for its own
    identity row (channel + org + member), so a profile directory maps 1:1 onto
    exactly one identity.

    `org_id` defaults to empty for channels with no tenant dimension, and for
    the jsonl adapter where the operator may not know it. That keeps the old
    single-argument behaviour reachable rather than inventing a tenant.

    NOTE: changing this input changes every existing slug. Callers that already
    published a profile must pass `--slug` explicitly to keep their directory.
    """
    material = f"{org_id}:{raw_self_id}" if org_id else raw_self_id
    return f"user-{sha256_hex(material)[:10]}"


# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

def expand(path: str | Path) -> Path:
    return Path(os.path.expanduser(str(path))).resolve()


def tildify(path: Path | str) -> str:
    """Render an absolute path with the home prefix as `~`.

    Must not be a string replace: `expand()` resolves symlinks, so on a machine
    where home sits behind one (macOS `/tmp`, a symlinked `/home`, an NFS mount)
    the resolved path no longer starts with the unresolved home string. Replacing
    the substring wherever it appears then mangles the middle of the path — the
    config records something like `/private~/...`, and every later mkdir fails on
    a directory nobody asked for.
    """
    p = expand(path)
    home = expand("~")
    try:
        rel = p.relative_to(home)
    except ValueError:
        return str(p)
    return "~" if str(rel) == "." else f"~/{rel}"


def assert_safe_data_root(path: Path) -> None:
    home = expand("~")
    if path == Path("/") or path == home or len(path.parts) < 3:
        raise ValueError(f"unsafe dataRoot: {path}")


def secure_mkdir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def secure_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def write_json(path: Path, obj: Any) -> None:
    secure_write(path, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def read_json_line(line: str) -> dict | None:
    try:
        obj = json.loads(line)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    os.chmod(path, 0o600)


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def load_config(path: Path) -> dict:
    cfg = read_json(path)
    if cfg is None:
        raise SystemExit(f"config not readable: {path}")
    cfg["_path"] = str(path)
    return cfg


def ensure_config_defaults(cfg: dict, defaults: dict) -> list[str]:
    """Add keys a newer forge version introduced, without touching set values.

    A config written by an earlier version silently lacks new options, so they
    only exist as code defaults and the owner cannot see or tune them. This fills
    the gaps and reports what it added; existing values always win.
    """
    added: list[str] = []

    def walk(target: dict, src: dict, prefix: str = "") -> None:
        for key, value in src.items():
            path = f"{prefix}{key}"
            if key not in target:
                target[key] = value
                added.append(path)
            elif isinstance(value, dict) and isinstance(target[key], dict):
                walk(target[key], value, f"{path}.")

    walk(cfg, defaults)
    return added


def save_config(cfg: dict) -> None:
    path = Path(cfg["_path"])
    out = {k: v for k, v in cfg.items() if k != "_path"}
    write_json(path, out)


def find_config(explicit: str | None) -> Path:
    """Locate persona-config.json: explicit flag, env, then the single data root
    under ~/.claude/user-context/ (the common case)."""
    if explicit:
        return expand(explicit)
    env = os.environ.get("IM_PERSONA_CONFIG")
    if env:
        return expand(env)
    base = expand("~/.claude/user-context")
    if base.is_dir():
        hits = sorted(base.glob("*/persona-config.json"))
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise SystemExit(
                "multiple personas found; pass --config explicitly:\n  "
                + "\n  ".join(str(h) for h in hits))
    raise SystemExit("no persona config found; run `forge init` first")


# ---------------------------------------------------------------------------
# text
# ---------------------------------------------------------------------------

def norm(text: str) -> str:
    return unicodedata.normalize("NFKC", text or "").strip()


def cp_len(text: str) -> int:
    return len(text or "")


# An "@Name(Name) " prefix carries no style signal; strip for style analysis but
# keep the raw text in the store so mention detection still works.
MENTION_PREFIX_RE = re.compile(r"^(?:@[^\s@]+(?:\([^)]*\))?\s*)+")


def strip_mentions(text: str) -> str:
    return MENTION_PREFIX_RE.sub("", text or "").strip()


# Text a person did not write. Three separate concerns, deliberately kept apart:
#
#   1. THIS list — structurally universal. A bare URL, a lone markdown link, an
#      attachment stub: these are not prose in any language or on any platform.
#   2. The platform adapter's own list (see forge/sources/*.py CLIENT_FURNITURE) —
#      rich cards and download hints a specific IM client renders as message text.
#      Left unfiltered, a document-permission card gets recalled as "how they
#      reply", which is how a persona learns to answer a colleague with a wall of
#      URLs.
#   3. The operator's own list, from `<dataRoot>/locale-overrides.json`
#      → `placeholders`. One organization's bug-report template or form labels
#      belong there, never compiled into a redistributable forge.
#
# Keeping (2) and (3) out of here is what lets the same forge serve a different
# company on a different IM platform without carrying either one's furniture.
PLACEHOLDER_RE = re.compile(
    r"(fileId\s*[:：=]|mediaId\s*[:：=]|"
    # A shared link rendered as "title url: <link>". Nothing in it was typed by
    # the person, so it is not a reply that shows their voice.
    r"\burl\s*[:：]\s*https?://|"
    r"^\s*https?://\S+\s*$|"
    # A message that is nothing but one markdown link — no words of their own.
    r"^\s*\[https?://[^\]]+\]\(https?://[^)]+\)\s*$)",
    re.I | re.S,
)

#: Extra placeholder patterns contributed at runtime — the platform adapter's
#: client furniture plus the operator's own templates. Registered rather than
#: hardcoded so that `is_placeholder` stays one function with one contract while
#: what counts as furniture varies per deployment.
_EXTRA_PLACEHOLDERS: list[re.Pattern] = []


def register_placeholders(patterns) -> int:
    """Add patterns to the placeholder filter. Idempotent per pattern string.

    Called by the active message source (for its client's rich-card furniture)
    and from the operator's locale overrides. Returns the number now registered.
    """
    known = {p.pattern for p in _EXTRA_PLACEHOLDERS}
    for pattern in patterns or []:
        if not pattern or pattern in known:
            continue
        try:
            _EXTRA_PLACEHOLDERS.append(re.compile(pattern, re.I | re.S))
            known.add(pattern)
        except re.error:
            continue      # a bad operator-supplied regex must not break the build
    return len(_EXTRA_PLACEHOLDERS)


def clear_placeholders() -> None:
    """Drop all registered extras — used by tests to isolate runs."""
    _EXTRA_PLACEHOLDERS.clear()


def is_placeholder(text: str) -> bool:
    if not text:
        return True
    if PLACEHOLDER_RE.search(text):
        return True
    return any(rx.search(text) for rx in _EXTRA_PLACEHOLDERS)


# Pasted machine output: stack traces, console logs, JSON blobs, diffs, SQL.
# These are things the owner *transmitted*, not things they *wrote* — counting
# them as their prose inflates average length and invents vocabulary that is
# really a library's log format. Detected structurally rather than by length, so
# a genuinely long human message still counts.
_PASTE_MARKERS = (
    re.compile(r"^\s*(Traceback \(most recent call last\)|"
               r"[\w./-]+\.(js|ts|tsx|py|go|java|rs):\d+|"
               r"at [\w.$]+\([^)]*:\d+:\d+\)|"
               r"\d{2}:\d{2}:\d{2}[.,]\d+\s*[›>|])", re.M),
    # JSON object/array, whole message or as a leading block. Real messages do
    # not begin with a brace followed by a quoted key.
    re.compile(r'^\s*[{\[]\s*$|^\s*[{\[]\s*"[\w-]+"\s*:', re.M),
    re.compile(r"(^|\n)\s*(diff --git |@@ -\d|\+\+\+ b/|--- a/)"),
    re.compile(r"(^|\n)\s*(SELECT .* FROM |CREATE TABLE |INSERT INTO )", re.I),
    re.compile(r"\b(sessionId|session_id|requestId|traceId|stack|stderr|stdout)\b\s*[:=]\s*['\"{]"),
    re.compile(r"(^|\n)\s*(npm ERR!|ERROR in |WARN |\[error\]|\[warn\])", re.I),
    # Multi-line arrow/pipeline diagrams and tool-output dumps. Each alternative
    # consumes the whole line so consecutive arrow lines actually chain.
    re.compile(r"(\n[ \t]*(→|->|=>|├|└|│)[^\n]*){2,}"),
    # A UUID plus structure is machine output, not something a person types.
    re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),
)

# Above this length, dense non-prose punctuation is a reliable paste signal.
_PASTE_MIN_LEN = 160


def is_pasted_output(text: str) -> bool:
    """True if the text looks like pasted machine output rather than writing."""
    if not text or len(text) < 40:
        return False
    for rx in _PASTE_MARKERS:
        if rx.search(text):
            return True
    if len(text) >= _PASTE_MIN_LEN:
        # Long, and mostly code punctuation / newlines rather than sentences.
        symbols = sum(text.count(ch) for ch in "{}[]<>=|;`\\\n")
        if symbols / len(text) > 0.06:
            return True
    return False


def pct(part: int, whole: int, nd: int = 1) -> float:
    return round(part / whole * 100, nd) if whole else 0.0
